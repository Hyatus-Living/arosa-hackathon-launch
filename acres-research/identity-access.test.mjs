import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,Writable} from 'node:stream';
import {ChatStore,conversationTitle} from './store.mjs';
import {createResearchServer} from './service.mjs';

const owner='a'.repeat(24),member='b'.repeat(24),outsider='c'.repeat(24);
function setup(t,architecture){
  const dir=mkdtempSync(join(tmpdir(),'arosa-identity-access-')),store=new ChatStore(join(dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'unit-test-only'},store,maps:null,execute:async()=>({answer:'Test',sources:[],ui:[]}),
    architecture:architecture?{stateDir:dir,worker:null,...architecture}:null});
  t.after(async()=>{await server.drain({graceMs:0});await new Promise(resolve=>setImmediate(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  // Invoke the production handler in memory: no listening server, network, or provider calls.
  const request=(path,{account=owner,email,method='GET',body}={})=>new Promise((resolve,reject)=>{
    const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);
    Object.assign(req,{url:path,method,headers:{authorization:'Bearer unit-test-only','x-acres-account':account,'content-type':'application/json',...(email?{'x-acres-email':email}:{})}});
    const chunks=[],res=new Writable({write(chunk,encoding,done){chunks.push(Buffer.from(chunk));done();}});
    res.setHeader=()=>{};res.writeHead=status=>{res.statusCode=status;res.headersSent=true;return res;};
    res.on('error',reject);res.on('finish',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));
    server.emit('request',req,res);
  });
  return {store,request};
}

test('conversation and team invitations cannot rewrite or prepopulate another account identity',async t=>{
  const {store:s,request}=setup(t);
  s.touchPerson(member,'member@example.com');
  const conversation=s.createConversation(owner),team=s.createTeam(owner,'Project team');
  for(const path of [`/conversations/${conversation.id}/members`,`/teams/${team.id}/members`]){
    const reply=await request(path,{method:'POST',body:{account:member,email:'redirect@example.com',role:'viewer'}});
    assert.equal(reply.status,200);assert.equal(s.personRow(member).email,'member@example.com');
    assert.equal((await request(path,{method:'POST',body:{account:outsider,email:'unverified@example.com',role:'viewer'}})).status,200);
    assert.equal(s.personRow(outsider),undefined);
  }
  assert.equal(s.access(member,conversation.id),'viewer');assert.ok(s.isTeamMember(member,team.id));
  assert.equal((await request(`/teams/${team.id}/members`,{method:'POST',body:{email:'member@example.com'}})).status,200);
  // Only the authenticated caller's header may synchronize their directory identity.
  const own=await request('/people/me',{account:member,email:'verified@example.com',method:'POST',body:{name:'Member',email:'spoofed@example.com'}});
  assert.equal(own.data.email,'verified@example.com');assert.equal(own.data.name,'Member');
  await request('/people/me',{account:outsider,method:'POST',body:{email:'unverified@example.com'}});
  assert.equal(s.personRow(outsider),undefined);
  s.grantMember(owner,conversation.id,'account',member,'participant','another@example.com');
  s.addTeamMember(owner,team.id,member,'another@example.com');
  assert.equal(s.personRow(member).email,'verified@example.com');
});

test('directory search admits configured admins and Arosa staff using only verified identity',async t=>{
  const {store:s,request}=setup(t),previous=process.env.AROSA_ADMIN_EMAILS;
  process.env.AROSA_ADMIN_EMAILS='admin@example.com';
  t.after(()=>{if(previous===undefined)delete process.env.AROSA_ADMIN_EMAILS;else process.env.AROSA_ADMIN_EMAILS=previous;});
  s.touchPerson(member,'member@example.com');
  for(const email of [undefined,'visitor@example.com','staff@witharosa.ai.evil.test'])assert.deepEqual((await request('/people?q=member',{email})).data,{people:[]});
  for(const email of ['admin@example.com','staff@witharosa.ai'])assert.equal((await request('/people?q=member',{email})).data.people[0].account,member);
});

test('only a team owner or active member may share a conversation with that team',t=>{
  const {store:s}=setup(t),team=s.createTeam(outsider,'Private team'),conversation=s.createConversation(owner);
  s.touchPerson(outsider,'private@example.com');
  assert.throws(()=>s.grantMember(owner,conversation.id,'team',team.id,'viewer'),e=>e.status===404);
  assert.deepEqual(s.listGrants(conversation.id),[]);
  assert.equal(s.conversation(owner,conversation.id).members.length,1);
  s.addTeamMember(outsider,team.id,owner);
  s.grantMember(owner,conversation.id,'team',team.id,'viewer');assert.equal(s.access(outsider,conversation.id),'viewer');
  s.removeGrant(owner,conversation.id,'team',team.id);s.removeTeamMember(outsider,team.id,owner);
  assert.throws(()=>s.grantMember(owner,conversation.id,'team',team.id,'viewer'),e=>e.status===404);
  const teamOwnersConversation=s.createConversation(outsider);
  assert.equal(s.grantMember(outsider,teamOwnersConversation.id,'team',team.id,'viewer').principal,team.id);
});

test('attached conversations cannot preserve or delegate project access after the owner revokes it',t=>{
  const {store:s}=setup(t);
  for(const source of ['direct','team','link']){
    const original=s.createConversation(owner),id=original.projectId;
    s.project.write(id,{property:{value:{address:'Private site',bbl:'1000477501'},provenance:{tool:'user'}}});
    let team;
    if(source==='team'){team=s.createTeam(owner,'Shared');s.addTeamMember(owner,team.id,member);s.grantMember(owner,original.id,'team',team.id,'viewer');}
    else if(source==='link'){const link=s.createLink(owner,original.id);s.claimLink(member,link.token);}
    else s.grantMember(owner,original.id,'account',member,'viewer');
    const attached=s.createConversation(member,{projectId:id});
    s.grantMember(member,attached.id,'account',outsider,'participant');
    assert.equal(s.projectAccess(outsider,id),null);assert.equal(s.projectState(outsider,attached.id),null);
    assert.equal(s.projectAccess(member,id),'viewer');
    const queued=s.createRun(member,attached.id,'Private follow-up');
    if(source==='team')s.removeTeamMember(owner,team.id,member);else s.removeGrant(owner,original.id,'account',member);
    assert.equal(s.projectAccess(member,id),null);assert.equal(s.canReadProject(member,id),false);assert.equal(s.projectView(member,id),null);
    assert.equal(s.projectPage(member).projects.some(p=>p.id===id),false);
    assert.equal(s.projectState(member,attached.id),null);assert.equal(s.conversation(member,attached.id).property,null);
    assert.equal(s.list(member).find(c=>c.id===attached.id).site,null);assert.equal(s.activeSiteRuns(member).some(run=>run.projectId===id),false);
    assert.throws(()=>s.createRun(member,attached.id,'After removal'),e=>e.status===404);
    assert.throws(()=>s.begin(queued),e=>e.status===404);
    assert.equal(s.access(member,attached.id),'owner');assert.equal(s.projectAccess(owner,id),'owner');
    s.grantMember(owner,original.id,'account',member,'participant');assert.equal(s.projectAccess(member,id),'participant');
    assert.equal(s.projectState(member,attached.id).property.value.address,'Private site');
  }
});

test('all direct architecture operations and scheme renders enforce the rollout before processing',async t=>{
  const {store:s,request}=setup(t,{emails:'@allowed.example.com'}),conversation=s.createConversation(owner),id=conversation.projectId;
  s.touchPerson(owner,'blocked@example.com');
  const root=`/projects/${id}/architecture`;
  for(const [suffix,method] of [['','GET'],['/plan','PUT'],['/jobs','POST'],['/jobs/missing/cancel','POST'],['/drawings','GET'],['/drawings','POST'],['/drawings/missing','GET'],['/revisions/1','GET'],['/artifacts/missing','GET'],['/schemes/draft','GET'],['/schemes/draft','POST'],['/import-ifc','POST'],['/validate-scan','POST'],['/visual-segment','POST'],['/visual-illustrate','POST']]){
    assert.equal((await request(root+suffix,{method,body:method==='GET'?undefined:{}})).status,404,`${method} ${suffix}`);
  }
  assert.equal((await request(`/projects/${id}/schemes/as-of-right/render`,{method:'POST',body:{}})).status,404);
  assert.equal((await request(root,{email:'owner@allowed.example.com'})).status,200);
  assert.equal((await request(root+'/drawings',{email:'owner@allowed.example.com'})).status,200);
  s.grantMember(owner,conversation.id,'account',member,'viewer');
  s.touchPerson(member,'member@allowed.example.com');
  assert.equal((await request(root,{account:member})).status,200);
  // A separate allowed account still requires project membership.
  assert.equal((await request(root,{account:outsider,email:'owner@allowed.example.com'})).status,404);
});

 test('conversation titles remove balanced nesting in linear time and preserve incomplete phrases',{timeout:1000},()=>{
  assert.equal(conversationTitle('Research (500 units (estimated)) this site. More details.'),'Research this site');
  assert.equal(conversationTitle('Research (unfinished (figures) site'),'Research (unfinished site');
  assert.equal(conversationTitle('Research ) a site'),'Research ) a site');
  assert.equal(conversationTitle('Research'+ ' '.repeat(2000)+'('.repeat(500)+')'.repeat(500)),'Research');
});
