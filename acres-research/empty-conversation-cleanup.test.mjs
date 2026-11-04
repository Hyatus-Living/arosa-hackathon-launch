import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ChatStore} from './store.mjs';
import {Drawings} from './architecture-drawings.mjs';
import {createResearchServer} from './service.mjs';

const source=readFileSync(new URL('../app-starter/public/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function discardEmptyConversation('),end=source.indexOf('\n// The address entry',start);
assert.ok(start>=0&&end>start);
function controller(){
  const c={state:{id:'old',draft:'Question'},archive:[{id:'old'},{id:'other'}],deletes:[],toasts:[],opened:[],refreshed:0,renders:0,resets:0};
  c.deleteChat=path=>new Promise((answer,reject)=>c.deletes.push({path,answer,reject}));
  c.toast=message=>c.toasts.push(message);c.renderHistory=()=>c.renders++;
  c.startBlankChat=()=>{c.state={id:null};c.resets++;};
  c.refreshHistory=async()=>{c.refreshed++;};c.openConversation=async id=>{c.opened.push(id);};
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);return c;
}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'acres-empty-')),store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return{dir,store};
}
function snapshot(store,id){
  const c=store.conversation('owner',id);return JSON.stringify({conversation:c,project:c&&store.projectView('owner',c.projectId)});
}

test('automatic cleanup waits for a conditional server acknowledgement before removing local research',async()=>{
  const c=controller(),pending=c.discardEmptyConversation('old');
  assert.equal(c.state.id,'old');assert.equal(c.archive.length,2);assert.equal(c.renders,0);
  assert.equal(c.deletes[0].path,'/conversations/old?empty=1');c.deletes[0].answer({deleted:true});
  await pending;assert.equal(c.state.id,null);assert.deepEqual(c.archive.map(r=>r.id),['other']);assert.equal(c.resets,1);
});

test('a refused cleanup retains the conversation and reloads its saved status instead of treating it as empty',async()=>{
  const c=controller(),pending=c.discardEmptyConversation('old');
  c.deletes[0].reject(Object.assign(new Error('Saved work was kept.'),{status:409}));await pending;
  assert.equal(c.state.id,'old');assert.equal(c.archive.length,2);assert.equal(c.resets,0);
  assert.equal(c.refreshed,1);assert.deepEqual(c.opened,['old']);assert.match(c.toasts[0],/kept/);
});

test('a network failure during cleanup keeps local state without claiming deletion',async()=>{
  const c=controller(),pending=c.discardEmptyConversation('old');c.deletes[0].reject(new Error('Network response lost.'));await pending;
  assert.equal(c.state.id,'old');assert.equal(c.archive.length,2);assert.equal(c.resets,0);assert.equal(c.refreshed,0);assert.deepEqual(c.opened,[]);assert.match(c.toasts[0],/Network/);
});

test('cleanup responses cannot clear or reopen a different conversation selected while waiting',async()=>{
  for(const refused of [false,true]){
    const c=controller(),pending=c.discardEmptyConversation('old');c.state={id:'other',draft:'Keep this draft'};
    if(refused)c.deletes[0].reject(Object.assign(new Error('Saved work was kept.'),{status:409}));else c.deletes[0].answer({deleted:true});
    await pending;assert.equal(c.state.id,'other');assert.equal(c.state.draft,'Keep this draft');assert.equal(c.resets,0);assert.deepEqual(c.opened,[]);
    assert.equal(c.archive.some(r=>r.id==='old'),refused);
  }
});

test('conditional cleanup preserves queued, running and every terminal run after an unacknowledged start',t=>{
  const {store:s}=fixture(t);
  for(const status of ['queued','running','completed','failed','interrupted']){
    const c=s.createConversation('owner'),run=s.createRun('owner',c.id,'Keep the saved request');s.write('UPDATE runs SET status=? WHERE id=?',status,run.id);
    const before=snapshot(s,c.id);assert.throws(()=>s.deleteConversation('owner',c.id,{onlyEmpty:true}),e=>e.status===409);
    assert.equal(snapshot(s,c.id),before);s.write('UPDATE conversations SET title=title WHERE id=?',c.id);
  }
});

test('legacy messages, sharing, saved project fields and drawing bytes are not empty cleanup targets',t=>{
  const {dir,store:s}=fixture(t);
  for(const kind of ['message','grant','link','field','drawing']){
    const c=s.createConversation('owner');let drawing;
    if(kind==='message')s.write('INSERT INTO messages(id,conversation,role,text,payload,created) VALUES(?,?,?,?,?,?)',randomUUID(),c.id,'assistant','Legacy research','{}',1);
    if(kind==='grant')s.grantMember('owner',c.id,'account','teammate','viewer');
    if(kind==='link')s.createLink('owner',c.id);
    if(kind==='field')s.project.write(c.projectId,{instructions:{value:{property:'Keep these notes'},provenance:{tool:'user'}}});
    if(kind==='drawing')drawing=new Drawings(s,{stateDir:dir}).add('owner',c.projectId,{bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0"/></svg>'),name:'Reference.svg',by:'user'});
    const before=snapshot(s,c.id);assert.throws(()=>s.deleteConversation('owner',c.id,{onlyEmpty:true}),e=>e.status===409);assert.equal(snapshot(s,c.id),before);
    if(drawing)assert.ok(new Drawings(s,{stateDir:dir}).open('owner',c.projectId,drawing.id).read().length>0);
  }
});

test('truly empty conversations can be discarded while an existing shared project keeps its state',t=>{
  const {store:s}=fixture(t),fresh=s.createConversation('owner');
  assert.equal(s.deleteConversation('owner',fresh.id,{onlyEmpty:true}),true);assert.equal(s.conversation('owner',fresh.id),null);assert.equal(s.projectView('owner',fresh.projectId),null);
  const existing=s.createConversation('owner');s.project.write(existing.projectId,{instructions:{value:{property:'Keep project work'},provenance:{tool:'user'}}});
  const empty=s.createConversation('owner',{projectId:existing.projectId}),before=s.projectView('owner',existing.projectId);
  assert.equal(s.deleteConversation('owner',empty.id,{onlyEmpty:true}),true);assert.deepEqual(s.projectView('owner',existing.projectId),before);assert.ok(s.conversation('owner',existing.id));
});

async function api(t){
  const f=fixture(t),server=createResearchServer({secrets:{RESEARCH_TOKEN:'controlled-local-test'},store:f.store,maps:null,execute:async()=>({answer:'',sources:[],ui:[]})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const request=(account,path)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'DELETE',headers:{authorization:'Bearer controlled-local-test','x-acres-account':account}});
  return{...f,request};
}

test('the HTTP empty-only contract preserves completed research while explicit owner deletion retains its existing meaning',async t=>{
  const {store:s,request}=await api(t),owner='a'.repeat(24),c=s.createConversation(owner),run=s.createRun(owner,c.id,'Research');s.begin(run);s.finish(run,'completed',{answer:'Keep this answer',sources:[]});
  const response=await request(owner,`/conversations/${c.id}?empty=1`);assert.equal(response.status,409);assert.equal(s.conversation(owner,c.id).messages.length,2);
  assert.equal((await request(owner,`/conversations/${c.id}`)).status,200);assert.equal(s.conversation(owner,c.id),null);
});

test('conditional cleanup preserves owner checks, missing-record behavior and refuses a malformed safety flag',async t=>{
  const {store:s,request}=await api(t),owner='a'.repeat(24),viewer='b'.repeat(24),outsider='c'.repeat(24),c=s.createConversation(owner);
  s.grantMember(owner,c.id,'account',viewer,'viewer');
  assert.equal((await request(viewer,`/conversations/${c.id}?empty=1`)).status,403);
  assert.equal((await request(outsider,`/conversations/${c.id}?empty=1`)).status,404);
  assert.equal((await request(owner,`/conversations/${randomUUID()}?empty=1`)).status,404);
  const empty=s.createConversation(owner);assert.equal((await request(owner,`/conversations/${empty.id}?empty=true`)).status,400);assert.ok(s.conversation(owner,empty.id));
});

test('empty verification and deletion hold the same SQLite writer lock against a concurrent message insertion',t=>{
  const {dir,store:s}=fixture(t),c=s.createConversation('owner'),other=new DatabaseSync(join(dir,'chat.sqlite'));other.exec('PRAGMA busy_timeout=0');
  t.after(()=>other.close());const one=s.one.bind(s);let attempted=false;
  s.one=(sql,...args)=>{
    if(sql==='SELECT 1 FROM runs WHERE conversation=? LIMIT 1'&&!attempted){
      attempted=true;assert.throws(()=>other.prepare('INSERT INTO messages(id,conversation,role,text,payload,created) VALUES(?,?,?,?,?,?)').run(randomUUID(),c.id,'assistant','Racing work','{}',1),/locked/);
    }
    return one(sql,...args);
  };
  assert.equal(s.deleteConversation('owner',c.id,{onlyEmpty:true}),true);assert.equal(attempted,true);assert.equal(s.conversation('owner',c.id),null);
});
