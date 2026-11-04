import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHTML} from 'linkedom';
import {withPlanNotes,addPlanNote} from '../public/plan-notes.js';
import {upsertConversationItem} from '../public/conversation-view.js';
import {ChatStore} from '../../acres-research/store.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function production(start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a,`production function ${start}`);
  return source.slice(a,b);
}
const controller=[
  production('const drafts = new Map(','\nsetFeedbackContext('),
  production('function clearActiveRun() {','\nfunction isOwner() {'),
  production('function handleAccessRemoved(id) {','\nfunction stopSharedPolling() {'),
  production('function applyConversation(result) {','\nfunction toolName('),
  production('async function send(text,','\nasync function steerRun() {'),
].join('\n');
const flush=()=>new Promise(setImmediate);
const failure=(message,status)=>Object.assign(new Error(message),{status});
const conversation=(id='c1')=>({id,projectId:'p1',messages:[],runs:[],draft:'Question',access:'owner',members:[],owner:{account:'alice'}});

function setup({id='c1',busy=false,notes=[]}={}){
  const {document}=parseHTML('<html><body><textarea id="prompt"></textarea><p id="access-note" hidden></p></body></html>');
  const c={document,console,Date,Event,Map,Set,crypto:{randomUUID:()=> 'r1'},session:{namespace:'alice'},cached:{},
    state:{...conversation(id),id},generation:1,conversationLoad:0,archive:[],me:{account:'alice'},
    busy,activeRun:busy?'older':null,eventStream:null,activity:[],liveMessages:new Map(),liveUi:[],connectionInterrupted:false,
    submitPending:false,planAttachmentPending:false,pendingSubmission:null,animateMessages:new Set(),
    planNotes:{projectId:'p1',notes},route:{view:'site',projectId:'p1'},toasts:[],posts:[],gets:[],streams:[],saved:0,
    listingsMode:()=>false,draftConversationId:()=>'d1',rotateDraftConversationId(){},
    withPlanNotes,upsertConversationItem,scrollState:{reset(){}},$:selector=>document.querySelector(selector),
    isViewer:()=>false,renderHistory(){},renderPlanNotes(){},rememberProjectChat(){},checkPendingSite(){},
    refreshHistory:async()=>{},stopSharedPolling(){},updateInput(){},pollPendingSite(){},noteRunEnded(){},toolName:()=> 'Research',
    window:{dispatchEvent(){}},openConversation:async()=>{},jobs:{started:async()=>{}},
  };
  c.render=()=>{c.$('#prompt').value=c.state.draft||'';};c.scheduleRender=c.render;
  c.$('#prompt').focus=()=>{};c.render();
  c.save=()=>{c.saved++;};c.historyView={close(){},refresh(){}};c.toast=text=>c.toasts.push(text);
  c.postChat=(path,body)=>new Promise((answer,reject)=>c.posts.push({path,body,answer,reject}));
  c.chatRequest=path=>new Promise((answer,reject)=>c.gets.push({path,answer,reject}));
  c.streamRun=(id,onEvent,onDisconnect)=>{
    const stream={id,onEvent,onDisconnect,closed:false,close(){this.closed=true;}};
    c.streams.push(stream);return stream;
  };
  if(busy){c.state.runs=[{id:'older',status:'running',input:'Earlier question',owner:'alice'}];c.eventStream=c.streamRun('older',()=>{},()=>{});}
  vm.createContext(c);vm.runInContext(controller,c);
  c.type=text=>{c.state.draft=text;c.$('#prompt').value=text;};
  c.ack=async(values={})=>{
    const post=c.posts.at(-1);assert.match(post.path,/\/runs$/);
    const run={id:post.body.id,conversation:c.state.id,owner:'alice',input:post.body.message,status:'queued',created:123,...values};
    post.answer(run);await flush();return run;
  };
  c.failRefresh=async(status=503)=>{c.gets.at(-1).reject(failure('Conversation refresh unavailable',status));await flush();};
  return c;
}

test('accepted research starts its saved event stream and retains the question before a slow refresh',async()=>{
  const c=setup(),sending=c.send('Question');await c.ack();
  const observed={active:c.activeRun,busy:c.busy,streams:c.streams.map(s=>s.id),message:c.state.messages.find(m=>m.runId==='r1'),run:c.state.runs.find(r=>r.id==='r1')};
  await c.failRefresh();await sending;
  assert.equal(observed.active,'r1');assert.equal(observed.busy,true);assert.deepEqual(observed.streams,['r1']);
  assert.equal(observed.message?.text,'Question');assert.equal(observed.run?.input,'Question');
});

test('an acknowledged request is not restored as an unsent draft when its result refresh fails',async()=>{
  const c=setup(),sending=c.send('Question');await c.ack();await c.failRefresh();const result=await sending;
  assert.equal(result.started,true);assert.equal(result.conversationId,'c1');assert.equal(c.state.draft,'');
  assert.equal(c.pendingSubmission,null);assert.equal(c.submitPending,false);assert.equal(c.posts.length,1);
  assert.equal(c.state.messages.filter(m=>m.runId==='r1').length,1);
  assert.match(c.toasts.at(-1),/request.*saved/i);assert.match(c.toasts.at(-1),/reopen/i);
});

test('an accepted queued question survives refresh failure without replacing the current live run',async()=>{
  const c=setup({busy:true}),stream=c.eventStream,sending=c.send('Next question');await c.ack();await c.failRefresh();await sending;
  assert.equal(c.state.runs.find(r=>r.id==='r1')?.input,'Next question');assert.equal(c.state.draft,'');
  assert.equal(c.activeRun,'older');assert.equal(c.eventStream,stream);assert.equal(stream.closed,false);assert.equal(c.streams.length,1);
});

test('later composer text remains a new draft while the accepted question remains in the conversation',async()=>{
  const c=setup(),sending=c.send('Question');c.type('My next question');await c.ack();await c.failRefresh();await sending;
  assert.equal(c.state.draft,'My next question');assert.equal(c.$('#prompt').value,'My next question');
  assert.equal(c.state.messages.find(m=>m.runId==='r1')?.text,'Question');
});

test('a successful conversation refresh replaces the interim record without duplicating the user question',async()=>{
  const c=setup(),sending=c.send('Question');await c.ack();c.type('Next draft');
  c.gets.at(-1).answer({...conversation(),messages:[{id:'server-message',role:'user',runId:'r1',text:'Question',author:'alice'}],runs:[{id:'r1',status:'running',input:'Question',owner:'alice'}]});await sending;
  assert.equal(c.state.messages.length,1);assert.equal(c.state.messages[0].id,'server-message');assert.equal(c.state.draft,'Next draft');
  assert.equal(c.activeRun,'r1');assert.equal(c.toasts.length,0);
});

test('a confirmed queued run keeps its question visible until the server materializes its user message',async()=>{
  const c=setup(),sending=c.send('Question'),run=await c.ack();
  c.gets.at(-1).answer({...conversation(),messages:[],runs:[run]});await sending;
  assert.equal(c.state.messages.find(m=>m.runId==='r1')?.text,'Question');assert.equal(c.activeRun,'r1');assert.equal(c.streams.length,1);
  c.applyConversation({...conversation(),messages:[{id:'persisted-question',role:'user',runId:'r1',text:'Question'}],runs:[{...run,status:'running'}]});
  assert.equal(c.state.messages.length,1);assert.equal(c.state.messages[0].id,'persisted-question');
});

test('a rejected submission restores the question and does not create a local accepted run',async()=>{
  const c=setup(),sending=c.send('Question');c.posts[0].reject(failure('Research request rejected',429));const result=await sending;
  assert.equal(result.started,false);assert.equal(c.state.draft,'Question');assert.equal(c.state.runs.length,0);
  assert.equal(c.state.messages.length,0);assert.equal(c.streams.length,0);assert.equal(c.submitPending,false);assert.match(c.toasts.at(-1),/rejected/);
});

test('submission rejection does not replace a later draft',async()=>{
  const c=setup(),sending=c.send('Question');c.type('Later text');c.posts[0].reject(failure('Rejected',429));await sending;
  assert.equal(c.state.draft,'Later text');assert.equal(c.$('#prompt').value,'Later text');
});

test('a response after navigating away cannot start a stream or add accepted records to another conversation',async()=>{
  const c=setup(),sending=c.send('Question');c.generation++;c.state={...conversation('c2'),draft:'Other draft'};await c.ack({conversation:'c1'});const result=await sending;
  assert.equal(result.started,true);assert.equal(c.state.id,'c2');assert.equal(c.state.draft,'Other draft');assert.equal(c.streams.length,0);
  assert.equal(c.state.messages.length,0);assert.equal(c.state.runs.length,0);assert.equal(c.gets.length,0);
});

test('a failed refresh after navigating away does not restore the old question into the current conversation',async()=>{
  const c=setup(),sending=c.send('Question');await c.ack();c.generation++;c.state={...conversation('c2'),draft:'Other draft'};
  await c.failRefresh();const result=await sending;
  assert.equal(result.started,true);assert.equal(c.state.id,'c2');assert.equal(c.state.draft,'Other draft');assert.equal(c.toasts.length,0);
});

test('a newly created conversation retains its accepted request when the initial refresh fails',async()=>{
  const c=setup({id:null}),sending=c.send('Question');assert.equal(c.posts[0].path,'/conversations');assert.equal(c.posts[0].body.clientDraftId,'d1','the create carries the browser draft identity');
  c.posts[0].answer(conversation('created'));await flush();await c.ack({conversation:'created'});await c.failRefresh();const result=await sending;
  assert.equal(result.conversationId,'created');assert.equal(result.started,true);assert.equal(c.state.id,'created');assert.equal(c.state.draft,'');
  assert.equal(c.state.runs.find(r=>r.id==='r1')?.conversation,'created');assert.equal(c.posts.length,2);
});

test('accepted plan context stays attached to its question and consumes only the submitted notes',async()=>{
  const oldNote={kind:'revision',revision:3},later={kind:'revision',revision:4};
  const c=setup({notes:[oldNote]}),sending=c.send('Check the plan');c.planNotes={...c.planNotes,notes:addPlanNote(c.planNotes.notes,later)};await c.ack();await c.failRefresh();await sending;
  assert.equal(c.state.messages.find(m=>m.runId==='r1')?.text,c.posts[0].body.message);
  assert.match(c.posts[0].body.message,/revision 3/);assert.equal(c.planNotes.notes.length,1);assert.equal(c.planNotes.notes[0],later);
});

test('access removed after acceptance clears the conversation instead of displaying inaccessible local records',async()=>{
  const c=setup(),sending=c.send('Question');await c.ack();await c.failRefresh(403);const result=await sending;
  assert.equal(result.started,true);assert.equal(c.state.id,null);assert.equal(c.state.messages.length,0);
  assert.equal(c.activeRun,null);assert.equal(c.streams[0]?.closed,true);assert.match(c.$('#access-note').textContent,/no longer have access/);
});

test('the actual local store acknowledgment survives a failed read without a second run submission',async(t)=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-submit-ack-')),store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const saved=store.createConversation('alice'),c=setup({id:saved.id});c.state.projectId=saved.projectId;
  const sending=c.send('Research 120 Broadway'),post=c.posts[0],run=store.createRun('alice',saved.id,post.body.message,post.body.id);
  post.answer(run);await flush();await c.failRefresh();const result=await sending;
  assert.equal(result.started,true);assert.equal(c.state.draft,'');assert.equal(c.posts.length,1);
  assert.equal(store.conversation('alice',saved.id).runs.length,1);assert.equal(c.state.runs.find(r=>r.id===run.id)?.input,run.input);
});

test('a live run keeps waiting through a research restart and gives up only when its stream does',async()=>{
  const c=setup();c.watchRun('r1');const stream=c.streams.at(-1);
  stream.onDisconnect({final:false});
  assert.equal(c.gets.at(-1).path,'/runs/r1/status');
  c.gets.at(-1).reject(failure('The research connection was interrupted.',502));await flush();
  stream.onDisconnect({final:false});
  c.gets.at(-1).reject(failure('The research connection was interrupted.',502));await flush();
  assert.equal(c.busy,true);assert.equal(stream.closed,false);assert.deepEqual(c.toasts,[]);
  assert.equal(c.activity.filter(a=>/Reconnecting/.test(a.text)).length,1);
  stream.onDisconnect({final:true});
  assert.equal(c.busy,false);assert.equal(stream.closed,true);assert.match(c.toasts.at(-1),/Reload to reconnect/);
});

test('a run the API refuses to show stops waiting at once',async()=>{
  const c=setup();c.watchRun('r1');const stream=c.streams.at(-1);
  stream.onDisconnect({final:false});
  c.gets.at(-1).reject(failure('Request not found.',404));await flush();
  assert.equal(c.busy,false);assert.equal(stream.closed,true);assert.equal(c.toasts.at(-1),'Request not found.');
});

test('unsent text stays with its conversation across switches and a sent question does not come back',async()=>{
  const c=setup(),other={id:'c2',messages:[],runs:[],access:'owner',members:[],owner:{account:'alice'}};
  c.type('Draft for c1');c.applyConversation(other);
  assert.equal(c.state.draft,'');assert.equal(c.$('#prompt').value,'','the other thread opens empty');
  c.type('Draft for c2');c.applyConversation({...conversation(),id:'c1'});
  assert.equal(c.state.draft,'Draft for c1');assert.equal(c.$('#prompt').value,'Draft for c1');
  const sending=c.send('Draft for c1');await c.ack();await c.failRefresh();await sending;
  c.applyConversation(other);assert.equal(c.state.draft,'Draft for c2','its own draft is still waiting');
  c.applyConversation({...conversation(),id:'c1'});assert.equal(c.state.draft,'','the sent question is not resurrected as a draft');
});

test('a finished run whose conversation reload hits a research restart retries until it loads',async()=>{
  const c=setup(),delays=[];let calls=0,finished=0;
  c.setTimeout=(fn,ms)=>{delays.push(ms);fn();};
  c.afterRunFinished=()=>{finished++;};
  c.openConversation=async()=>{if(++calls<3)throw failure('The research connection was interrupted.',502);};
  c.watchRun('r1');const stream=c.streams.at(-1);
  stream.onEvent({seq:9,event:'run.completed',result:{}});
  for(let i=0;i<6;i++)await flush();
  assert.equal(calls,3);assert.deepEqual(delays,[3000,3000]);assert.equal(finished,1);assert.deepEqual(c.toasts,[]);
});
