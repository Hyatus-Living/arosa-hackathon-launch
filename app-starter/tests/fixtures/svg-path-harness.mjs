import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Parsing runs away from the test runner so a regression can be stopped even if
// it blocks its event loop. The parse deadline begins after module startup.
export async function runSvg(svg,{action='extract',deadlineMs=1000}={}){
  const worker=fork(fileURLToPath(new URL('./svg-path-worker.mjs',import.meta.url)),[],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
  const closed=new Promise(resolve=>worker.once('close',(exitCode,signal)=>resolve({exitCode,signal})));
  let timer,ready=false,settled=false,stderr='';worker.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(0,8192);});
  const result=await new Promise(resolve=>{
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve({...value,ready});};
    timer=setTimeout(()=>finish({status:'startup-timeout'}),5000);
    worker.on('message',message=>{if(message.phase==='ready'){ready=true;clearTimeout(timer);timer=setTimeout(()=>finish({status:'timeout'}),deadlineMs);worker.send({svg,action});}else if(message.phase==='error')finish({status:'error',message:message.message});else finish({status:'complete',value:message.value});});
    worker.once('error',error=>finish({status:'error',message:error.message}));
    worker.once('exit',(exitCode,signal)=>finish({status:'exit',exitCode,signal,stderr}));
  });
  if(result.status==='timeout'||result.status==='startup-timeout')worker.kill('SIGKILL');
  const shutdown=setTimeout(()=>worker.kill('SIGKILL'),1000),exit=await closed;clearTimeout(shutdown);
  return {...result,...exit,workerStopped:worker.exitCode!==null||worker.signalCode!==null};
}
