import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {createResearchServer} from './service.mjs';

function setup(t){const dir=mkdtempSync(join(tmpdir(),'acres-sharing-'));const store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
function named(s,account,email,name){s.touchPerson(account,email);if(name)s.setMyName(account,email,name);}
function complete(s,sender,conversation,text){const r=s.createRun(sender,conversation,text);const h=s.begin(r);s.finish(r,'completed',{answer:'Answer',sources:[],property:{bbl:'1000477501'}});return {run:r,history:h};}
const statusOf=fn=>{try{fn();return null;}catch(e){return e.status??e.message;}};

test('access matrix: direct and team grants, highest role, immediate removal, list and attribution',t=>{
  const s=setup(t);
  named(s,'alice','alice@witharosa.ai','Alice A');named(s,'bob','bob@witharosa.ai');named(s,'carol','carol@witharosa.ai','Carol');named(s,'dave','dave@witharosa.ai');
  const c=s.createConversation('alice');
  assert.equal(c.access,'owner');assert.deepEqual(c.members.map(m=>m.account),['alice']);
  const first=complete(s,'alice',c.id,'Research 120 Broadway');
  assert.deepEqual(first.history,[]);
  // outsider
  assert.equal(s.access('eve',c.id),null);assert.equal(s.conversation('eve',c.id),null);assert.deepEqual(s.list('eve'),[]);
  assert.equal(statusOf(()=>s.createRun('eve',c.id,'x')),404);
  assert.equal(s.run('eve',first.run.id),null);assert.equal(s.events('eve',first.run.id),null);assert.equal(s.projectState('eve',c.id),null);
  // viewer (direct): reads, cannot send
  s.grantMember('alice',c.id,'account','bob','viewer','bob@witharosa.ai');
  assert.equal(s.access('bob',c.id),'viewer');
  assert.equal(s.conversation('bob',c.id).access,'viewer');
  assert.equal(statusOf(()=>s.createRun('bob',c.id,'send?')),403);
  assert.equal(s.projectState('bob',c.id).property.value.bbl,'1000477501');
  assert.ok(s.run('bob',first.run.id));assert.ok(s.events('bob',first.run.id).length);
  // participant (direct): sends as themselves
  s.grantMember('alice',c.id,'account','carol','participant','carol@witharosa.ai');
  const second=complete(s,'carol',c.id,'What about FAR?');
  assert.equal(second.run.owner,'carol');
  assert.deepEqual(second.history[0],{role:'user',text:'[Alice A] Research 120 Broadway'});
  const view=s.conversation('bob',c.id);
  const users=view.messages.filter(m=>m.role==='user'),assistants=view.messages.filter(m=>m.role==='assistant');
  assert.deepEqual(users.map(m=>[m.author,m.authorName]),[['alice','Alice A'],['carol','Carol']]);
  assert.ok(assistants.every(m=>m.author===null&&m.authorName===null));
  assert.equal(view.runs.find(r=>r.id===second.run.id).owner,'carol');
  assert.equal(view.runs.find(r=>r.id===second.run.id).authorName,'Carol');
  // only owner manages grants
  assert.equal(statusOf(()=>s.grantMember('carol',c.id,'account','eve','viewer')),403);
  assert.equal(statusOf(()=>s.grantMember('eve',c.id,'account','eve','viewer')),404);
  // team grant + highest role wins (direct viewer + team participant = participant)
  const team=s.createTeam('alice','Dev Team');
  s.addTeamMember('alice',team.id,'dave','dave@witharosa.ai');
  s.grantMember('alice',c.id,'account','dave','viewer','dave@witharosa.ai');
  s.grantMember('alice',c.id,'team',team.id,'participant');
  assert.equal(s.access('dave',c.id),'participant');
  assert.equal(view.members.find(m=>m.account==='carol')?.via,'direct');
  const item=s.list('bob','Broadway')[0];
  assert.equal(item.access,'viewer');assert.deepEqual(item.owner,{account:'alice',name:'Alice A'});
  assert.equal(item.memberCount,3);assert.deepEqual(item.lastAuthor,{account:'carol',name:'Carol'});
  assert.equal(s.list('dave','Broadway').length,1);
  // removing the team member drops dave to his direct viewer grant on the next read
  s.removeTeamMember('alice',team.id,'dave');
  assert.equal(s.access('dave',c.id),'viewer');
  s.removeGrant('alice',c.id,'account','dave');
  assert.equal(s.access('dave',c.id),null);
  // new team membership also takes effect immediately
  s.addTeamMember('alice',team.id,'dave','dave@witharosa.ai');
  assert.equal(s.access('dave',c.id),'participant');
  // direct removal is immediate; re-add reactivates with the new role
  s.removeGrant('alice',c.id,'account','bob');
  assert.equal(s.conversation('bob',c.id),null);
  s.grantMember('alice',c.id,'account','bob','participant','bob@witharosa.ai');
  assert.equal(s.access('bob',c.id),'participant');
  s.setGrantRole('alice',c.id,'account','bob','viewer');
  assert.equal(s.access('bob',c.id),'viewer');
  // archiving the team removes team access
  s.archiveTeam('alice',team.id);
  assert.equal(s.access('dave',c.id),null);
  // display-name fallback and people search
  assert.equal(s.displayName('bob'),'bob');assert.equal(s.displayName('nobody-known'),'A teammate');
  assert.deepEqual(s.searchPeople('CARO').map(p=>p.account),['carol']);
  s.setMyName('bob','bob@witharosa.ai','Bob B');assert.equal(s.personPayload('bob').name,'Bob B');
  s.setMyName('bob','bob@witharosa.ai','');assert.equal(s.personPayload('bob').name,'bob');
});

test('single-author history carries no author prefix',t=>{
  const s=setup(t);named(s,'alice','alice@witharosa.ai','Alice A');
  const c=s.createConversation('alice');
  complete(s,'alice',c.id,'First question');
  const r=s.createRun('alice',c.id,'Second question');
  assert.deepEqual(s.begin(r)[0],{role:'user',text:'First question'});
  assert.equal(s.harnessAuthorName(r),null);
});

test('share links claim a viewer grant, never downgrade, and revocation stops new claims',t=>{
  const s=setup(t);const c=s.createConversation('alice');complete(s,'alice',c.id,'Hello');
  s.grantMember('alice',c.id,'account','carol','participant','carol@witharosa.ai');
  s.grantMember('alice',c.id,'account','bob','viewer','bob@witharosa.ai');
  assert.equal(statusOf(()=>s.createLink('bob',c.id)),403);
  assert.equal(statusOf(()=>s.createLink('eve',c.id)),404);
  const link=s.createLink('alice',c.id);
  assert.equal(link.role,'viewer');assert.equal(link.path,'/shared/'+link.token);assert.ok(link.token.length>=40);
  assert.deepEqual(s.claimLink('dave',link.token),{conversationId:c.id,access:'viewer'});
  assert.equal(s.access('dave',c.id),'viewer');
  assert.deepEqual(s.claimLink('carol',link.token),{conversationId:c.id,access:'participant'});
  assert.deepEqual(s.claimLink('alice',link.token),{conversationId:c.id,access:'owner'});
  assert.equal(s.listLinks('alice',c.id).length,1);assert.equal(s.listLinks('alice',c.id)[0].revoked,false);
  s.revokeLink('alice',c.id,link.token);
  assert.equal(s.claimLink('eve',link.token),null);
  assert.equal(s.access('dave',c.id),'viewer');
  const expired=s.createLink('alice',c.id,Date.now()-1000);
  assert.equal(s.claimLink('eve',expired.token),null);
  assert.equal(s.claimLink('eve','no-such-token'),null);
  // a removed member can re-claim viewer through a fresh link
  s.removeGrant('alice',c.id,'account','dave');assert.equal(s.access('dave',c.id),null);
  const fresh=s.createLink('alice',c.id);
  assert.equal(s.claimLink('dave',fresh.token).access,'viewer');
});

test('migration from version 1 adds the sharing tables and backfills authors from runs',t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-sharing-migrate-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'chat.sqlite'),conv=randomUUID(),r1=randomUUID(),r2=randomUUID(),now=Date.now();
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,title TEXT NOT NULL,property TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation TEXT NOT NULL REFERENCES conversations(id),status TEXT NOT NULL,input TEXT NOT NULL,result TEXT,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation TEXT NOT NULL REFERENCES conversations(id),run TEXT REFERENCES runs(id),role TEXT NOT NULL,text TEXT NOT NULL,payload TEXT,created INTEGER NOT NULL);
    CREATE TABLE events(run TEXT NOT NULL REFERENCES runs(id),seq INTEGER NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(run,seq));
    PRAGMA user_version=1;`);
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run(conv,'alice','Legacy',null,now,now);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)').run(r1,'alice',conv,'completed','First',null,null,now,now);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)').run(r2,'bob',conv,'completed','Second',null,null,now,now);
  db.prepare('INSERT INTO messages(id,conversation,run,role,text,payload,created) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),conv,r1,'user','First','{}',now);
  db.prepare('INSERT INTO messages(id,conversation,run,role,text,payload,created) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),conv,r1,'assistant','Reply','{}',now);
  db.prepare('INSERT INTO messages(id,conversation,run,role,text,payload,created) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),conv,r2,'user','Second','{}',now);
  db.close();
  const s=new ChatStore(path);
  try{
    assert.equal(s.one('PRAGMA user_version').user_version,2);
    const tables=s.query(`SELECT name FROM sqlite_master WHERE type='table'`).map(r=>r.name);
    for(const name of ['people','teams','team_members','conversation_members','share_links'])assert.ok(tables.includes(name),name);
    const messages=s.conversation('alice',conv).messages;
    assert.deepEqual(messages.map(m=>[m.role,m.author]),[['user','alice'],['assistant',null],['user','bob']]);
    assert.equal(messages[0].authorName,'A teammate');
  } finally {s.close();}
  const again=new ChatStore(path);
  try{assert.equal(again.one('PRAGMA user_version').user_version,2);assert.equal(again.conversation('alice',conv).messages[2].author,'bob');} finally {again.close();}
});

test('run control: sender and conversation owner only; steer authorship and harness author name',async t=>{
  const s=setup(t);
  named(s,'alice','alice@witharosa.ai','Alice');named(s,'bob','bob@witharosa.ai','Bob');named(s,'carol','carol@witharosa.ai');named(s,'eve','eve@witharosa.ai');
  const c=s.createConversation('alice');complete(s,'alice',c.id,'First from Alice');
  s.grantMember('alice',c.id,'account','bob','participant','bob@witharosa.ai');
  s.grantMember('alice',c.id,'account','carol','viewer','carol@witharosa.ai');
  s.grantMember('alice',c.id,'account','eve','participant','eve@witharosa.ai');
  const inputs=[],steers=[];let finish,ready;const controlReady=new Promise(r=>{ready=r;});
  const m=new RunManager(s,{},async(input,_secrets,_progress,_emit,onControl)=>{inputs.push(input);onControl({steer:async text=>steers.push(text),interrupt:async()=>finish()});ready();await new Promise(r=>{finish=r;});return {answer:'Done',sources:[]};});
  const run=m.enqueue('bob',c.id,'Follow up from Bob');
  await controlReady;
  assert.equal(inputs[0].authorName,'Bob');
  assert.deepEqual(inputs[0].history[0],{role:'user',text:'[Alice] First from Alice'});
  assert.equal(await m.control('dave-outsider',run.id,'interrupt'),null);
  await assert.rejects(m.control('carol',run.id,'interrupt'),e=>e.status===403);
  await assert.rejects(m.control('eve',run.id,'steer','mine now'),e=>e.status===403);
  await m.control('alice',run.id,'steer','Owner steering');
  assert.deepEqual(steers,['[Alice] Owner steering']);
  const steerMessage=s.conversation('alice',c.id).messages.find(msg=>msg.text==='Owner steering');
  assert.equal(steerMessage.author,'alice');
  await m.control('bob',run.id,'steer','Sender steering');
  const done=new Promise(r=>m.once(run.id,e=>{if(e.event==='run.interrupted')r();}));
  await m.control('alice',run.id,'interrupt');await done;
  assert.equal(s.run('alice',run.id).status,'interrupted');
  assert.equal(s.run('bob',run.id).owner,'bob');
});

test('HTTP sharing: roles, teams, links, people and run control status codes',{timeout:10000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-sharing-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({answer:'Verified answer',sources:[],ui:[]}),maps:null});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const A='a'.repeat(24),B='b'.repeat(24),C='c'.repeat(24),D='d'.repeat(24),E='e'.repeat(24),F='f'.repeat(24);
  const emails={[A]:'alice@witharosa.ai',[B]:'bob@witharosa.ai',[C]:'carol@witharosa.ai',[D]:'dave@witharosa.ai',[E]:'eve@witharosa.ai',[F]:'frank@witharosa.ai'};
  const request=async(path,{method='GET',body,account=A}={})=>{
    const res=await fetch(base+path,{method,headers:{authorization:'Bearer test','x-acres-account':account,'x-acres-email':emails[account],'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const text=await res.text();let data=null;try{data=JSON.parse(text);}catch{}
    return {status:res.status,data,text};
  };
  assert.deepEqual((await request('/people/me',{method:'POST',body:{name:'Alice A'}})).data,{account:A,email:'alice@witharosa.ai',name:'Alice A'});
  assert.equal((await request('/people/me',{method:'POST',body:{name:'Bob B'},account:B})).status,200);
  const conv=(await request('/conversations',{method:'POST',body:{}})).data;
  assert.equal(conv.access,'owner');
  assert.equal((await request('/conversations/'+conv.id,{account:D})).status,404);
  assert.equal((await request(`/conversations/${conv.id}/members`,{method:'POST',body:{account:B,email:emails[B],role:'participant'}})).status,200);
  assert.equal((await request(`/conversations/${conv.id}/members`,{method:'POST',body:{account:C,email:emails[C],role:'viewer'}})).status,200);
  assert.equal((await request(`/conversations/${conv.id}/members`,{method:'POST',body:{account:D,email:emails[D],role:'viewer'},account:B})).status,403);
  assert.equal((await request(`/conversations/${conv.id}/members`,{method:'POST',body:{account:D,email:emails[D],role:'viewer'},account:D})).status,404);
  assert.equal((await request('/conversations/'+conv.id,{account:B})).data.access,'participant');
  assert.equal((await request('/conversations/'+conv.id,{account:C})).data.access,'viewer');
  assert.equal((await request(`/conversations/${conv.id}/members`,{account:A})).data.members.length,2);
  assert.equal((await request(`/conversations/${conv.id}/members`,{account:C})).status,403);
  assert.equal((await request(`/conversations/${conv.id}/runs`,{method:'POST',body:{message:'viewer sends'},account:C})).status,403);
  assert.equal((await request(`/conversations/${conv.id}/runs`,{method:'POST',body:{message:'outsider sends'},account:D})).status,404);
  const runRes=await request(`/conversations/${conv.id}/runs`,{method:'POST',body:{message:'120 Broadway'},account:B});
  assert.equal(runRes.status,202);assert.equal(runRes.data.owner,B);
  for(let i=0;i<100&&store.run(A,runRes.data.id)?.status!=='completed';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(store.run(A,runRes.data.id).status,'completed');
  assert.equal((await request('/runs/'+runRes.data.id,{account:C})).status,200);
  assert.equal((await request('/runs/'+runRes.data.id,{account:D})).status,404);
  assert.match((await request('/runs/'+runRes.data.id+'/events?after=1',{account:C})).text,/run\.completed/);
  assert.equal((await request('/runs/'+runRes.data.id+'/interrupt',{method:'POST',body:{},account:C})).status,403);
  assert.equal((await request('/runs/'+runRes.data.id+'/interrupt',{method:'POST',body:{},account:D})).status,404);
  assert.equal((await request('/runs/'+runRes.data.id+'/interrupt',{method:'POST',body:{},account:A})).status,200);
  // teams
  const team=(await request('/teams',{method:'POST',body:{name:'Dev Team'}})).data;
  assert.equal(team.role,'owner');
  assert.equal((await request(`/teams/${team.id}/members`,{method:'POST',body:{account:D,email:emails[D]}})).status,200);
  assert.equal((await request('/teams/'+team.id,{account:D})).status,200);
  assert.equal((await request('/teams/'+team.id,{account:F})).status,404);
  assert.equal((await request('/teams/'+team.id,{method:'PATCH',body:{name:'Nope'},account:D})).status,403);
  assert.equal((await request(`/conversations/${conv.id}/members`,{method:'POST',body:{teamId:team.id,role:'viewer'}})).status,200);
  assert.equal((await request('/conversations/'+conv.id,{account:D})).data.access,'viewer');
  assert.equal((await request(`/teams/${team.id}/members/${D}`,{method:'DELETE',account:D})).status,403);
  assert.equal((await request(`/teams/${team.id}/members/${D}`,{method:'DELETE',account:A})).status,200);
  assert.equal((await request('/conversations/'+conv.id,{account:D})).status,404);
  assert.equal((await request(`/teams/${team.id}/members/${A}`,{method:'DELETE',account:A})).status,400);
  // links
  assert.equal((await request(`/conversations/${conv.id}/links`,{method:'POST',body:{},account:B})).status,403);
  const linkRes=await request(`/conversations/${conv.id}/links`,{method:'POST',body:{}});
  assert.equal(linkRes.status,201);
  const claim=await request('/shared/'+linkRes.data.token,{account:E});
  assert.equal(claim.status,200);assert.deepEqual(claim.data,{conversationId:conv.id,access:'viewer'});
  assert.equal((await request('/conversations/'+conv.id,{account:E})).status,200);
  assert.equal((await request(`/conversations/${conv.id}/links/${linkRes.data.token}`,{method:'DELETE'})).status,200);
  assert.equal((await request('/shared/'+linkRes.data.token,{account:F})).status,404);
  assert.equal((await request('/conversations/'+conv.id,{account:E})).status,200);
  // list + people directory (email header touched eve and frank too)
  const list=(await request('/conversations?q=Broadway',{account:B})).data.conversations;
  assert.equal(list.length,1);assert.equal(list[0].access,'participant');assert.equal(list[0].owner.name,'Alice A');
  assert.equal(list[0].memberCount,3);assert.deepEqual(list[0].lastAuthor,{account:B,name:'Bob B'});
  assert.deepEqual((await request('/people?q=bob',{account:A})).data.people.map(p=>p.account),[B]);
  assert.deepEqual((await request('/people/me',{method:'POST',body:{},account:E})).data,{account:E,email:'eve@witharosa.ai',name:'eve'});
  const byEmail=await request(`/teams/${team.id}/members`,{method:'POST',body:{email:emails[C]}});
  assert.equal(byEmail.status,200);assert.ok(byEmail.data.members.some(m=>m.account===C));
  // delete: owner only
  assert.equal((await request('/conversations/'+conv.id,{method:'DELETE',account:B})).status,403);
  assert.equal((await request('/conversations/'+conv.id,{method:'DELETE',account:A})).status,200);
  assert.equal((await request('/conversations/'+conv.id,{account:A})).status,404);
});
