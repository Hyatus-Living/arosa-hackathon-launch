import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {createMcpDomain} from './mcp-domain.mjs';
import {EvidenceStore} from './mcp-store.mjs';
const alice='a'.repeat(24),bob='b'.repeat(24);
function setup(t){const dir=mkdtempSync(join(tmpdir(),'acres-project-pages-')),store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
function seed(store,owner,count,{updated=1000,title=i=>`Saved site ${i}`}={}){return Array.from({length:count},(_,index)=>{const conversation=store.createConversation(owner);store.write('UPDATE projects SET title=?,updated=? WHERE id=?',title(index),updated,conversation.projectId);return conversation;});}
function collect(store,account,options={}){const pages=[];let cursor=null;for(let i=0;i<10;i++){const page=store.projectPage(account,{...options,cursor});pages.push(page);if(page.nextCursor===null)return pages;cursor=page.nextCursor;}throw new Error('The site fixture must finish within ten pages.');}

test('all saved sites traverse bounded pages with deterministic tied-time order and no duplicates',t=>{
  const store=setup(t),owned=seed(store,alice,205);seed(store,bob,100);
  const pages=collect(store,alice),ids=pages.flatMap(page=>page.projects.map(project=>project.id));
  assert.deepEqual(pages.map(page=>page.projects.length),[100,100,5]);assert.equal(new Set(ids).size,205);
  assert.deepEqual(ids,owned.map(c=>c.projectId).sort().reverse());assert.equal(pages.at(-1).nextCursor,null);
  assert.equal(store.projectPage(bob).nextCursor,null);assert.equal(store.listProjects(alice).length,100);
});
test('literal search and its query remain applied on every later page',t=>{
  const store=setup(t);seed(store,alice,105,{title:i=>`Literal 100%_ site ${i}`});seed(store,alice,10,{title:i=>`Literal 100xx site ${i}`});
  const pages=collect(store,alice,{q:'100%_'}),rows=pages.flatMap(page=>page.projects);
  assert.equal(rows.length,105);assert.ok(rows.every(row=>row.title.includes('100%_')));
  assert.deepEqual(store.projectPage(alice,{q:"' OR 1=1 --"}).projects,[]);
});
test('each continuation reevaluates direct and team access without leaking private or revoked sites',t=>{
  const store=setup(t);seed(store,alice,100,{updated:2000});const shared=seed(store,bob,5);
  store.grantMember(bob,shared[0].id,'account',alice,'viewer');store.grantMember(bob,shared[1].id,'account',alice,'participant');
  const team=store.createTeam(bob,'Fixture team');store.addTeamMember(bob,team.id,alice);store.grantMember(bob,shared[2].id,'team',team.id,'viewer');
  const first=store.projectPage(alice);assert.ok(first.nextCursor);
  store.removeGrant(bob,shared[0].id,'account',alice);store.removeTeamMember(bob,team.id,alice);
  const last=store.projectPage(alice,{cursor:first.nextCursor});
  assert.deepEqual(last.projects.map(row=>[row.id,row.access]),[[shared[1].projectId,'participant']]);assert.equal(last.nextCursor,null);
});
test('a position cursor is never an access grant to another accounts sites',t=>{
  const store=setup(t);seed(store,alice,105,{updated:2000});const own=seed(store,bob,3);
  const cursor=store.projectPage(alice).nextCursor,page=store.projectPage(bob,{cursor});
  assert.deepEqual(new Set(page.projects.map(row=>row.id)),new Set(own.map(c=>c.projectId)));assert.ok(page.projects.every(row=>row.owner.account===bob));
});
test('malformed continuation positions fail with a client error',t=>{
  const store=setup(t);
  for(const cursor of ['', 'not-a-cursor',-1,'-1:00000000-0000-0000-0000-000000000000','9999999999999999:00000000-0000-0000-0000-000000000000',"1000:' OR 1=1 --"]){assert.throws(()=>store.projectPage(alice,{cursor}),error=>error.status===400);}
});
test('the actual authenticated HTTP list reaches every site and rejects malformed cursors',async t=>{
  const store=setup(t);seed(store,alice,205);
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'local-pagination-fixture'},store,execute:async()=>{throw new Error('Listing must not run research.');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer local-pagination-fixture','x-acres-account':alice};
  const ids=[];let cursor=null;for(let i=0;i<5;i++){const response=await fetch(base+'/projects'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{headers});assert.equal(response.status,200);const page=await response.json();assert.ok(page.projects.length<=100);assert.ok(Object.hasOwn(page,'nextCursor'));ids.push(...page.projects.map(row=>row.id));if(page.nextCursor===null)break;cursor=page.nextCursor;}
  assert.equal(ids.length,205);assert.equal(new Set(ids).size,205);
  assert.equal((await fetch(base+'/projects?cursor=invalid',{headers})).status,400);
  assert.equal((await (await fetch(base+'/projects?limit=100000',{headers})).json()).projects.length,100);
  assert.deepEqual((await (await fetch(base+'/projects',{headers:{...headers,'x-acres-account':bob}})).json()).projects,[]);
});
test('a newer insertion does not repeat or displace the remaining older pages',t=>{
  const store=setup(t),original=seed(store,alice,205),first=store.projectPage(alice);const fresh=seed(store,alice,1,{updated:2000})[0];
  const second=store.projectPage(alice,{cursor:first.nextCursor}),third=store.projectPage(alice,{cursor:second.nextCursor});
  const ids=[...first.projects,...second.projects,...third.projects].map(row=>row.id);
  assert.equal(new Set(ids).size,205);assert.deepEqual(new Set(ids),new Set(original.map(c=>c.projectId)));
  assert.equal(store.projectPage(alice).projects[0].id,fresh.projectId);
});
test('the read-only MCP domain exposes continuations and preserves filters and input scope',async t=>{
  const store=setup(t);seed(store,alice,105,{title:i=>`MCP site ${i}`});
  const dir=mkdtempSync(join(tmpdir(),'acres-project-page-admission-')),evidence=new EvidenceStore(join(dir,'evidence.sqlite'));
  t.after(()=>{evidence.close();rmSync(dir,{recursive:true,force:true});});
  const domain=createMcpDomain({evidence,listProjects:(account,args)=>store.projectPage(account,args)}),context={accountId:alice,workspaceId:'fixture'};
  const first=await domain.call('list_projects',{q:'MCP'},context),last=await domain.call('list_projects',{q:'MCP',cursor:first.nextCursor},context);
  assert.equal(first.projects.length,100);assert.equal(last.projects.length,5);assert.equal(last.nextCursor,null);
  assert.equal(new Set([...first.projects,...last.projects].map(row=>row.projectId)).size,105);
  await assert.rejects(domain.call('list_projects',{cursor:'invalid'},context),error=>error.code==='INVALID_INPUT');
  await assert.rejects(domain.call('list_projects',{accountId:bob},context),error=>error.code==='INVALID_INPUT');
});
test('one saved site per parcel: the twin with the most underwriting stays, then the newest',t=>{
  const store=setup(t),[full,bare,newerBare,other]=seed(store,alice,4);
  const field=(project,key)=>store.write("INSERT INTO project_fields VALUES(?,?,?,'{}',NULL,1)",project,key,key==='proFormas'?'[]':'{}');
  for(const [c,updated] of [[full,1000],[bare,3000],[newerBare,4000]])store.write("UPDATE projects SET bbl='1000150001',updated=? WHERE id=?",updated,c.projectId);
  for(const key of ['property','envelope','proFormas'])field(full.projectId,key);
  field(bare.projectId,'property');field(newerBare.projectId,'property');
  const ids=store.projectPage(alice).projects.map(p=>p.id);
  assert.ok(ids.includes(full.projectId)&&ids.includes(other.projectId));
  assert.ok(!ids.includes(bare.projectId)&&!ids.includes(newerBare.projectId),'the bare twins are hidden');
  store.write("DELETE FROM project_fields WHERE project=? AND key<>'property'",full.projectId);
  assert.ok(store.projectPage(alice).projects.some(p=>p.id===newerBare.projectId),'on equal progress the newest twin stays');
});
test('each saved site carries its progress, read with the site page rule',t=>{
  const store=setup(t),[site]=seed(store,alice,1);
  const field=(key,value)=>store.write("INSERT INTO project_fields VALUES(?,?,?,'{}',NULL,1)",site.projectId,key,JSON.stringify(value));
  field('property',{bbl:'1000150001'});field('envelope',{});field('assumptions',{landPrice:2500000});
  assert.deepEqual(store.projectPage(alice).projects[0].progress,{done:2,next:3,stale:false,underwritten:1,landPrice:2500000,profit:null,call:null});
});
