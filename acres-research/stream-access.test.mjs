import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {createResearchServer} from './service.mjs';
const owner='a'.repeat(24),viewer='b'.repeat(24),outsider='c'.repeat(24);
const flush=()=>new Promise(setImmediate),decode=value=>new TextDecoder().decode(value);

async function setup(t,{teamOnly=false,role='viewer'}={}){
  const dir=mkdtempSync(join(tmpdir(),'acres-stream-access-')),store=new ChatStore(join(dir,'chat.sqlite')),controllers=[];
  let publish,release,started,manager;const ready=new Promise(resolve=>started=resolve);
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'local-stream-fixture'},store,execute:async(_input,_secrets,_progress,emit)=>{publish=emit;started();return await new Promise(resolve=>release=resolve);}});
  t.after(async()=>{for(const controller of controllers)controller.abort();release?.({answer:'Fixture complete',sources:[],ui:[]});await flush();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,headers=account=>({authorization:'Bearer local-stream-fixture','x-acres-account':account,'content-type':'application/json'}),conversation=store.createConversation(owner);
  let team;
  if(teamOnly){team=store.createTeam(owner,'Stream fixture team');store.addTeamMember(owner,team.id,viewer);store.grantMember(owner,conversation.id,'team',team.id,role);}
  else store.grantMember(owner,conversation.id,'account',viewer,role);
  const response=await fetch(base+'/conversations/'+conversation.id+'/runs',{method:'POST',headers:headers(owner),body:JSON.stringify({message:'Controlled stream fixture'})});assert.equal(response.status,202);const run=await response.json();await ready;
  const runCursor=store.runEvents(run.id).at(-1).seq,originalOn=RunManager.prototype.on;
  t.mock.method(RunManager.prototype,'on',function(name,listener){if(name===run.id)manager=this;return originalOn.call(this,name,listener);});
  return {store,conversation,run,team,get manager(){return manager;},
    request:path=>fetch(base+path,{headers:headers(viewer)}),
    async open(kind,account=viewer,after=kind==='run'?runCursor:0){
      const controller=new AbortController();controllers.push(controller);
      const path=kind==='run'?'/runs/'+run.id:'/projects/'+conversation.projectId;
      const response=await fetch(base+path+'/events?after='+after,{headers:headers(account),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(4000)])});assert.equal(response.status,200);
      const reader=response.body.getReader();let buffer='';while(!buffer.includes('\n\n')){const chunk=await reader.read();assert.equal(chunk.done,false);buffer+=decode(chunk.value);}assert.match(buffer,/^: connected/);
      return {reader,buffer,controller};
    },
    project(probe){const event=store.appendProjectEvent(conversation.projectId,'state.updated',{probe});store.projectFeed.emit(conversation.projectId,event);return event;},
    delta:delta=>publish('message.delta',{delta}),
    async finish(){release({answer:'Fixture complete',sources:[],ui:[]});await flush();},
  };
}
async function closed(stream){assert.doesNotMatch(stream.buffer,/(^|\n)data:/);stream.buffer='';const next=await stream.reader.read();assert.equal(next.done,true,'A revoked stream delivered more bytes: '+decode(next.value));}
async function contains(stream,needle){let text=stream.buffer;stream.buffer='';for(let i=0;i<50&&!text.includes(needle);i++){const next=await stream.reader.read();assert.equal(next.done,false,'Stream ended before '+needle);text+=decode(next.value);}assert.ok(text.includes(needle),needle);return text;}

test('revoked direct project access closes delivery while the owner stream keeps receiving',{timeout:5000},async t=>{
  const f=await setup(t),denied=await f.open('project'),allowed=await f.open('project',owner);
  f.store.removeGrant(owner,f.conversation.id,'account',viewer);assert.equal(f.store.projectAccess(viewer,f.conversation.projectId),null);
  f.project('private-project-update');await closed(denied);await contains(allowed,'private-project-update');
  assert.equal(f.store.projectFeed.listenerCount(f.conversation.projectId),1);assert.equal((await f.request('/projects/'+f.conversation.projectId+'/events')).status,404);
});
test('revoked direct run access closes only that delivery and preserves research plus audit cleanup',{timeout:5000},async t=>{
  const f=await setup(t),denied=await f.open('run'),allowed=await f.open('run',owner);
  f.store.removeGrant(owner,f.conversation.id,'account',viewer);f.delta('private-run-update');await closed(denied);await contains(allowed,'private-run-update');
  assert.equal(f.store.runRow(f.run.id).status,'running');assert.equal(f.manager.active.has(f.run.id),true);assert.equal(f.manager.listenerCount(f.run.id),1);
  assert.equal(f.store.runEvents(f.run.id).filter(event=>event.event==='delivery.closed').length,1);
  assert.equal((await f.request('/runs/'+f.run.id+'/events')).status,404);
  await f.finish();await contains(allowed,'run.completed');assert.equal(f.manager.listenerCount(f.run.id),0);assert.equal(f.store.runEvents(f.run.id).filter(event=>event.event==='delivery.closed').length,2);
});
test('removing team membership stops both open delivery paths',{timeout:5000},async t=>{
  const f=await setup(t,{teamOnly:true}),project=await f.open('project'),run=await f.open('run');
  f.store.removeTeamMember(owner,f.team.id,viewer);f.project('team-private-project');f.delta('team-private-run');await closed(project);await closed(run);
  assert.equal(f.store.projectFeed.listenerCount(f.conversation.projectId),0);assert.equal(f.manager.listenerCount(f.run.id),0);
});
test('archiving the granting team stops both open delivery paths',{timeout:5000},async t=>{
  const f=await setup(t,{teamOnly:true}),project=await f.open('project'),run=await f.open('run');
  f.store.archiveTeam(owner,f.team.id);f.project('archived-private-project');f.delta('archived-private-run');await closed(project);await closed(run);
});
test('readable downgrades and alternate grants remain live until the final read path is removed',{timeout:5000},async t=>{
  const f=await setup(t,{role:'participant'}),project=await f.open('project'),run=await f.open('run');
  const team=f.store.createTeam(owner,'Alternate read grant');f.store.addTeamMember(owner,team.id,viewer);f.store.grantMember(owner,f.conversation.id,'team',team.id,'viewer');
  f.store.setGrantRole(owner,f.conversation.id,'account',viewer,'viewer');f.project('still-readable-project');f.delta('still-readable-run');await contains(project,'still-readable-project');await contains(run,'still-readable-run');
  f.store.removeGrant(owner,f.conversation.id,'account',viewer);f.project('team-readable-project');f.delta('team-readable-run');await contains(project,'team-readable-project');await contains(run,'team-readable-run');
  f.store.removeTeamMember(owner,team.id,viewer);f.project('finally-private-project');f.delta('finally-private-run');await closed(project);await closed(run);
});
test('attached-conversation ownership preserves project read scope without restoring original-run access',{timeout:5000},async t=>{
  const f=await setup(t);f.store.createConversation(viewer,{projectId:f.conversation.projectId});const project=await f.open('project'),run=await f.open('run');
  f.store.removeGrant(owner,f.conversation.id,'account',viewer);assert.equal(f.store.projectAccess(viewer,f.conversation.projectId),'viewer');assert.equal(f.store.access(viewer,f.conversation.id),null);
  f.project('project-scope-retained');f.delta('original-run-private');await contains(project,'project-scope-retained');await closed(run);
});
test('a revoked run stream cannot read or replay a gapped cache before the new live event',{timeout:5000},async t=>{
  const f=await setup(t),run=await f.open('run');f.store.event(f.run.id,'tool.progress',{probe:'missed-private-event'});
  f.store.removeGrant(owner,f.conversation.id,'account',viewer);const reads=t.mock.method(f.store,'runEventPage');f.delta('new-private-event');await closed(run);assert.equal(reads.mock.calls.length,0);
});
test('project backlog is checked again if access disappears after history retrieval',{timeout:5000},async t=>{
  const f=await setup(t);f.project('cached-private-project');const original=f.store.projectEventPage;
  t.mock.method(f.store,'projectEventPage',function(...args){const result=original.apply(this,args);this.removeGrant(owner,f.conversation.id,'account',viewer);return result;});
  const project=await f.open('project');await closed(project);assert.equal(f.store.projectFeed.listenerCount(f.conversation.projectId),0);
});
test('run backlog is checked again and denied replay does not advance the delivered cursor',{timeout:5000},async t=>{
  const f=await setup(t);await f.finish();const original=f.store.runEventPage;
  t.mock.method(f.store,'runEventPage',function(...args){const result=original.apply(this,args);this.removeGrant(owner,f.conversation.id,'account',viewer);return result;});
  const run=await f.open('run',viewer,0);await closed(run);const audit=f.store.runEvents(f.run.id).filter(event=>event.event==='delivery.closed');assert.equal(audit.length,1);assert.equal(audit[0].cursor,0);assert.equal(f.manager.listenerCount(f.run.id),0);
});
test('idle revoked project and run connections close at their existing keepalive cadence',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=await setup(t),project=await f.open('project'),run=await f.open('run');
  f.store.removeGrant(owner,f.conversation.id,'account',viewer);t.mock.timers.tick(15000);await closed(project);await closed(run);
  assert.equal(f.store.projectFeed.listenerCount(f.conversation.projectId),0);assert.equal(f.manager.listenerCount(f.run.id),0);
});
test('the point project-read predicate matches existing role visibility across grant and ownership paths',{timeout:5000},async t=>{
  const f=await setup(t),check=()=>{for(const account of [owner,viewer,outsider])assert.equal(f.store.canReadProject(account,f.conversation.projectId),Boolean(f.store.projectAccess(account,f.conversation.projectId)));};
  check();f.store.setGrantRole(owner,f.conversation.id,'account',viewer,'participant');check();f.store.removeGrant(owner,f.conversation.id,'account',viewer);check();
  const team=f.store.createTeam(owner,'Predicate fixture');f.store.addTeamMember(owner,team.id,viewer);f.store.grantMember(owner,f.conversation.id,'team',team.id,'viewer');check();f.store.archiveTeam(owner,team.id);check();
  f.store.grantMember(owner,f.conversation.id,'account',viewer,'viewer');f.store.createConversation(viewer,{projectId:f.conversation.projectId});f.store.removeGrant(owner,f.conversation.id,'account',viewer);check();
  assert.equal(f.store.canReadProject(null,f.conversation.projectId),false);assert.equal(f.store.canReadProject(viewer,null),false);assert.equal(f.store.canReadProject(viewer,'00000000-0000-0000-0000-000000000000'),false);
});
