import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {researchRuntimeOptions,architectureOptions} from './service.mjs';

test('runtime defaults retain the deployed listener and colocated storage',()=>{
  assert.deepEqual(researchRuntimeOptions({}),{statePath:'/home/openclaw/.openclaw/acres-state/chat.sqlite',stateDir:'/home/openclaw/.openclaw/acres-state',host:'10.42.0.2',port:18800});
  const env={ACRES_STATE_DIR:'/local/state',RESEARCH_HOST:'127.0.0.1',RESEARCH_PORT:'18801',ACRES_ARCHITECTURE_ENABLED:'true'};
  assert.deepEqual(researchRuntimeOptions(env),{statePath:'/local/state/chat.sqlite',stateDir:'/local/state',host:'127.0.0.1',port:18801});
  assert.equal(architectureOptions({},env).stateDir,'/local/state');
  assert.equal(researchRuntimeOptions({...env,RESEARCH_STATE_PATH:'/other/chat.sqlite'}).stateDir,'/other');
  for(const port of ['bad','-1','65536','1.5'])assert.throws(()=>researchRuntimeOptions({RESEARCH_PORT:port}),/RESEARCH_PORT/);
});

function launch(cleanups,script,{cwd,env},ready) {
  const child=spawn(process.execPath,[script],{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',data=>{stderr+=data;});
  cleanups.push(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGINT');await ended;}
  });
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`Startup timed out: ${stderr}`));},10000);
    let output='';
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Exited ${code}: ${stderr}`));});
    child.stdout.on('data',data=>{
      output+=data;
      const result=ready(output);
      if(result){clearTimeout(timer);resolve(result);}
    });
  });
}

test('local research and web gateway start without provider credentials and preserve authentication',{timeout:20000},async t=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const dir=mkdtempSync(join(tmpdir(),'arosa-local-runtime-'));
  const cleanups=[];
  const token=randomUUID(),secretsPath=join(dir,'secrets.json'),stateDir=join(dir,'state');
  writeFileSync(secretsPath,JSON.stringify({RESEARCH_TOKEN:token}),{mode:0o600});
  t.after(async()=>{for(const cleanup of cleanups.reverse())await cleanup();rmSync(dir,{recursive:true,force:true});});
  const researchUrl=await launch(cleanups,'acres-research/service.mjs',{cwd:root,env:{ACRES_SECRETS_JSON:secretsPath,ACRES_STATE_DIR:stateDir,RESEARCH_STATE_PATH:'',RESEARCH_HOST:'127.0.0.1',RESEARCH_PORT:'0',ACRES_ARCHITECTURE_ENABLED:'false',ACRES_DEAL_STORE_ENABLED:'false',LISTEN_FDS:'',LISTEN_PID:''}},output=>{
    const line=output.split('\n').find(line=>line.startsWith('{"event":"research_listening"'));
    return line?`http://127.0.0.1:${JSON.parse(line).address.port}`:null;
  });
  assert.equal((await (await fetch(`${researchUrl}/healthz`)).json()).ok,true);
  assert.ok(existsSync(join(stateDir,'chat.sqlite')));
  assert.ok(existsSync(join(stateDir,'composio.sqlite')));
  assert.equal((await fetch(`${researchUrl}/conversations`)).status,401);
  const headers={authorization:`Bearer ${token}`};
  const expected=await (await fetch(`${researchUrl}/public-stats`,{headers})).json();
  const webUrl=await launch(cleanups,'server.js',{cwd:join(root,'app-starter'),env:{HOST:'127.0.0.1',PORT:'0',ACRES_RESEARCH_ORIGIN:`${researchUrl}/`,RESEARCH_TOKEN:token,BILLING_ENABLED:'false'}},output=>output.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]);
  assert.equal((await (await fetch(`${webUrl}/healthz`)).json()).ok,true);
  assert.deepEqual(await (await fetch(`${webUrl}/api/public/stats`)).json(),expected);
  assert.equal((await fetch(`${webUrl}/api/session`)).status,401);
});
