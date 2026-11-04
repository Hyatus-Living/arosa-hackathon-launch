import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import express from 'express';
import {isModelInputRequest,mountModelInputProxy} from '../model-intake-proxy.mjs';

async function setup(t) {
  const app=express(),calls=[],normal=express.json({limit:'60kb'});
  app.use((req,res,next)=>isModelInputRequest(req)?next():normal(req,res,next));
  app.use((req,res,next)=>req.get('authorization')==='test'?next():res.status(401).json({error:'Sign in'}));
  mountModelInputProxy(app,(req,res,path,body)=>{calls.push({path,body});res.json({ok:true});});
  app.post('/api/conversations',(req,res)=>res.json({ok:true}));
  app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const post=(path,body,auth='test')=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body});
  return {calls,post};
}

test('the production proxy forwards IFC and scan uploads above the normal API limit intact',async t=>{
  const f=await setup(t),data=Buffer.alloc(128*1024,1).toString('base64');
  for(const operation of ['import-ifc','validate-scan','visual-segment','visual-illustrate']){
    const input={name:'scan.ply',data,plan:{schema:'test'},units:'m',tolerance:.025};
    assert.equal((await f.post(`/api/projects/model-1/architecture/${operation}`,JSON.stringify(input))).status,200);
    assert.deepEqual(f.calls.at(-1),{path:`/projects/model-1/architecture/${operation}`,body:input});
  }
});

test('model uploads authenticate before parsing file bodies',async t=>{
  const f=await setup(t);
  assert.equal((await f.post('/api/projects/model-1/architecture/import-ifc','invalid JSON'.repeat(10000),'')).status,401);
  assert.equal(f.calls.length,0);
});

test('large-body exceptions are limited to modeling operations and retain an upper bound',async t=>{
  const f=await setup(t),body=JSON.stringify({data:'x'.repeat(70*1024)});
  assert.equal((await f.post('/api/conversations',body)).status,413);
  assert.equal((await f.post('/api/projects/model-1/architecture/other',body)).status,413);
  assert.equal((await f.post('/api/projects/model-1/architecture/import-ifc',JSON.stringify({data:'x'.repeat(36*1024*1024)}))).status,413);
  assert.equal(f.calls.length,0);
});

test('the deployed server mounts model routes after authentication and includes the module in its image',()=>{
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.ok(server.indexOf('mountModelInputProxy(app,proxy)')>server.indexOf("app.use('/api',authenticate)"));
  assert.match(server,/isModelInputRequest\(req\)\?next\(\)/);
  const dockerfile=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8');
  assert.ok(dockerfile.includes('app-starter/model-intake-proxy.mjs'));
});
