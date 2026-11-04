// The web app's stable origin (127.0.0.1:18810, the Cloudflare tunnel's target). It forwards each
// request to the live blue or green container, whose port is the only content of the target file,
// and rereads that file on SIGHUP. arosa-web-switch starts the next color, points the file at it,
// reloads this front and stops the old color once it has no request in flight; requests already
// sent to the old color finish there.
import http from 'node:http';
import {readFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Connection headers apply to one hop; each upstream request uses its own connection.
const hop=new Set(['connection','keep-alive','proxy-connection','transfer-encoding','te','trailer','upgrade']);
const forwardable=headers=>Object.fromEntries(Object.entries(headers).filter(([name])=>!hop.has(name)));

export function createFront({targetFile,retryMs=30000,log=event=>console.log(JSON.stringify(event))}) {
  let target=null;
  // Per color port: plain requests in flight and open event streams, which clients reopen themselves.
  const inflight=new Map();
  const count=port=>{if(!inflight.has(port))inflight.set(port,{requests:0,streams:0});return inflight.get(port);};
  const reload=()=>{
    const port=Number(readFileSync(targetFile,'utf8').trim());
    if(!Number.isInteger(port)||port<1024||port>65535){log({event:'front_target_invalid',file:targetFile});return target;}
    if(port!==target)log({event:'front_target',port,previous:target});
    target=port;return target;
  };
  reload();
  const server=http.createServer((req,res)=>{
    const started=Date.now();let current=null;
    res.once('close',()=>{if(!res.writableFinished)current?.upstream.destroy();current?.finish();});
    // A color that is restarting refuses connections for a moment; retry until it is back. The
    // request body stays unread until a connection succeeds, so a retry resends nothing twice.
    const attempt=()=>{
      const port=target,counts=count(port);let stream=false,done=false;
      counts.requests++;
      const finish=()=>{if(done)return;done=true;if(stream)counts.streams--;else counts.requests--;};
      const upstream=http.request({host:'127.0.0.1',port,method:req.method,path:req.url,headers:forwardable(req.headers),agent:false},response=>{
        if(String(response.headers['content-type']).includes('text/event-stream')){stream=true;counts.requests--;counts.streams++;}
        res.writeHead(response.statusCode,forwardable(response.headers));
        response.pipe(res);
        // A color stopped mid-response cuts the client's response too, so an event stream reconnects.
        response.once('close',()=>{finish();if(!response.complete)res.destroy();});
      });
      current={upstream,finish};
      upstream.once('socket',socket=>socket.once('connect',()=>req.pipe(upstream)));
      upstream.once('error',error=>{
        finish();
        if(error.code==='ECONNREFUSED'&&!res.headersSent&&!res.destroyed&&Date.now()-started<retryMs){setTimeout(attempt,250);return;}
        if(res.destroyed)return;
        log({event:'front_upstream_failed',port,code:error.code});
        if(!res.headersSent){res.writeHead(502,{'content-type':'text/plain; charset=utf-8'});res.end('Arosa is restarting. Try again in a moment.');}
        else res.destroy();
      });
    };
    attempt();
  });
  // Longer than the tunnel's idle pool timeout, so the front never closes a connection the tunnel is about to reuse.
  server.keepAliveTimeout=100000;
  const status=()=>({target,inflight:Object.fromEntries(inflight)});
  return {server,reload,status};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const front=createFront({targetFile:process.env.AROSA_WEB_TARGET||'/etc/arosa-acres/web-target'});
  front.server.listen(18810,'127.0.0.1');
  // Local status for arosa-web-switch, on a socket only root reaches.
  const admin=process.env.AROSA_WEB_FRONT_ADMIN||'/run/arosa-web-front/admin.sock';
  rmSync(admin,{force:true});
  http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(front.status()));}).listen(admin);
  process.on('SIGHUP',()=>front.reload());
  // A restart of the front itself: stop listening, give plain requests up to 30 seconds, then exit.
  process.once('SIGTERM',()=>{
    front.server.close();front.server.closeIdleConnections();
    const deadline=Date.now()+30000;
    const check=()=>{const busy=[...Object.values(front.status().inflight)].some(c=>c.requests>0);if(!busy||Date.now()>deadline)process.exit(0);setTimeout(check,200);};
    check();
  });
}
