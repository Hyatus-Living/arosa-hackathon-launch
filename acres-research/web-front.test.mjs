import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFront} from '../infra/arosa-web-front.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const listen=(server,port=0)=>new Promise(resolve=>server.listen(port,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);});
const freePort=async()=>{const s=net.createServer(),port=await listen(s);await close(s);return port;};
// A color: answers with its name, holds /slow until released and streams /events until closed.
function color(name){
  const release=deferred(),bodies=[];
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);
    req.on('end',async()=>{
      bodies.push(body);
      if(req.url==='/slow')await release.promise;
      if(req.url==='/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${name}\n\n`);return;}
      res.writeHead(200,{'content-type':'text/plain','set-cookie':['a=1','b=2']});res.end(`${name}:${req.method}:${body}`);
    });
  });
  return {server,release,bodies};
}
async function fixture(t,{retryMs=30000}={}){
  const dir=mkdtempSync(join(tmpdir(),'web-front-')),targetFile=join(dir,'web-target');
  const blue=color('blue'),green=color('green');
  const bluePort=await listen(blue.server),greenPort=await listen(green.server);
  writeFileSync(targetFile,`${bluePort}\n`);
  const front=createFront({targetFile,retryMs,log:()=>{}}),frontPort=await listen(front.server);
  t.after(async()=>{blue.release.resolve();green.release.resolve();await Promise.all([close(front.server),close(blue.server),close(green.server)]);rmSync(dir,{recursive:true,force:true});});
  const point=port=>{writeFileSync(targetFile,`${port}\n`);front.reload();};
  return {front,blue,green,bluePort,greenPort,targetFile,point,url:path=>`http://127.0.0.1:${frontPort}${path}`};
}
const until=async check=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,10));assert.ok(check());};

test('a switch sends new requests to the next color while the old one finishes its own',async t=>{
  const f=await fixture(t);
  const first=await fetch(f.url('/a'));
  assert.equal(await first.text(),'blue:GET:');assert.deepEqual(first.headers.getSetCookie(),['a=1','b=2']);
  const slow=fetch(f.url('/slow')).then(r=>r.text());
  await until(()=>f.front.status().inflight[f.bluePort]?.requests===1);
  f.point(f.greenPort);
  assert.equal(f.front.status().target,f.greenPort);
  assert.equal(await (await fetch(f.url('/b'),{method:'POST',body:'x'})).text(),'green:POST:x');
  assert.equal(f.front.status().inflight[f.bluePort].requests,1,'the old color still has its slow request');
  f.blue.release.resolve();
  assert.equal(await slow,'blue:GET:');
  await until(()=>f.front.status().inflight[f.bluePort].requests===0);
});

test('event streams are counted apart from plain requests and end when their color stops',async t=>{
  const f=await fixture(t);
  const response=await fetch(f.url('/events')),reader=response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/data: blue/);
  assert.deepEqual(f.front.status().inflight[f.bluePort],{requests:0,streams:1});
  f.blue.server.closeAllConnections();
  await assert.rejects(async()=>{while(!(await reader.read()).done);},'a cut upstream cuts the client stream so it reconnects');
  await until(()=>f.front.status().inflight[f.bluePort].streams===0);
});

test('a refused connection is retried until the color listens, sending the body once',async t=>{
  const f=await fixture(t),port=await freePort();
  f.point(port);
  const pending=fetch(f.url('/c'),{method:'POST',body:'once'}).then(r=>r.text());
  await new Promise(r=>setTimeout(r,600));
  const late=color('late');await listen(late.server,port);t.after(()=>close(late.server));
  assert.equal(await pending,'late:POST:once');assert.deepEqual(late.bodies,['once']);
});

test('a color that stays down gets a plain 502 after the retry window',async t=>{
  const f=await fixture(t,{retryMs:300});
  f.point(await freePort());
  const response=await fetch(f.url('/d'));
  assert.equal(response.status,502);assert.equal(await response.text(),'Arosa is restarting. Try again in a moment.');
  await until(()=>Object.values(f.front.status().inflight).every(c=>c.requests===0));
});

test('an invalid target file keeps the current target',async t=>{
  const f=await fixture(t);
  writeFileSync(f.targetFile,'not a port\n');f.front.reload();
  assert.equal(f.front.status().target,f.bluePort);
});

test('a client that hangs up releases its upstream request',async t=>{
  const f=await fixture(t),controller=new AbortController();
  const slow=fetch(f.url('/slow'),{signal:controller.signal}).catch(error=>error.name);
  await until(()=>f.front.status().inflight[f.bluePort]?.requests===1);
  controller.abort();assert.equal(await slow,'AbortError');
  await until(()=>f.front.status().inflight[f.bluePort].requests===0);
});
