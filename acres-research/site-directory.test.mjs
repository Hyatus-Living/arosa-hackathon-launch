import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
const alice='a'.repeat(24),bob='b'.repeat(24);
function setup(t){const dir=mkdtempSync(join(tmpdir(),'acres-sites-only-')),s=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
function draft(s,owner=alice,title='Saved draft',at=1000){const c=s.createConversation(owner);s.updateProjectState(owner,c.projectId,{version:0,fields:{assumptions:{landPrice:1000000}}});s.write('UPDATE projects SET title=?,updated=? WHERE id=?',title,at,c.projectId);return c;}
function pages(s,owner,options={}){const all=[];let cursor=null;for(let i=0;i<10;i++){const p=s.projectPage(owner,{...options,cursor});all.push(p);if(!p.nextCursor)return all;cursor=p.nextCursor;}throw new Error('Fixture exceeded ten pages.');}

test('Sites exclude empty and answered chat-only projects while chat and project access stay available',t=>{
 const s=setup(t),empty=s.createConversation(alice),chat=s.createConversation(alice),saved=draft(s);
 const run=s.createRun(alice,chat.id,'How do I use the map?');s.begin(run);s.finish(run,'completed',{answer:'Choose an area on the map.',sources:[]});
 assert.deepEqual(s.projectPage(alice,{sitesOnly:true}).projects.map(x=>x.id),[saved.projectId]);
 assert.equal(s.projectPage(alice).projects.length,3);assert.equal(s.list(alice).length,3);assert.ok(s.projectView(alice,empty.projectId));assert.ok(s.projectView(alice,chat.projectId));
});

test('addressed research and user-owned drafts without parcel IDs both belong in Sites',t=>{
 const s=setup(t),address=s.createConversation(alice),saved=draft(s);
 s.project.write(address.projectId,{property:{value:{address:'10 Site St'},provenance:{tool:'acres_set_subject',sources:[]}}},1000);
 assert.deepEqual(new Set(s.projectPage(alice,{sitesOnly:true}).projects.map(x=>x.id)),new Set([address.projectId,saved.projectId]));
 assert.ok(s.projectPage(alice,{sitesOnly:true}).projects.every(x=>x.bbl===null));
});

test('legacy parcel identities remain discoverable before their field state is migrated',t=>{
 const s=setup(t),legacy=s.createConversation(alice),blank=s.createConversation(alice);
 s.write('UPDATE projects SET bbl=?,site_key=?,title=? WHERE id=?','1000477501','1000477501','Legacy parcel',legacy.projectId);
 assert.deepEqual(s.projectPage(alice,{sitesOnly:true,q:'1000477501'}).projects.map(x=>x.id),[legacy.projectId]);
 assert.ok(!s.projectPage(alice,{sitesOnly:true}).projects.some(x=>x.id===blank.projectId));
});

test('site filtering runs before page limits and preserves literal search on every continuation',t=>{
 const s=setup(t),saved=Array.from({length:105},(_,i)=>draft(s,alice,`Target 100%_ ${i}`));
 for(let i=0;i<125;i++){const c=s.createConversation(alice);s.write('UPDATE projects SET title=?,updated=? WHERE id=?',`Target 100%_ chat ${i}`,2000,c.projectId);}
 const result=pages(s,alice,{sitesOnly:true,q:'100%_'});assert.deepEqual(result.map(x=>x.projects.length),[100,5]);assert.deepEqual(new Set(result.flatMap(x=>x.projects.map(p=>p.id))),new Set(saved.map(c=>c.projectId)));
 assert.equal(pages(s,alice).flatMap(x=>x.projects).length,230);assert.deepEqual(s.projectPage(alice,{sitesOnly:true,q:"' OR 1=1 --"}).projects,[]);
});

test('site filtering retains direct and team roles and reevaluates revoked access',t=>{
 const s=setup(t),direct=draft(s,bob,'Shared direct'),teamSite=draft(s,bob,'Shared team'),privateSite=draft(s,bob,'Private'),chat=s.createConversation(bob),team=s.createTeam(bob,'Research');
 s.grantMember(bob,direct.id,'account',alice,'participant');s.grantMember(bob,chat.id,'account',alice,'viewer');s.addTeamMember(bob,team.id,alice);s.grantMember(bob,teamSite.id,'team',team.id,'viewer');
 assert.deepEqual(new Map(s.projectPage(alice,{sitesOnly:true}).projects.map(x=>[x.id,x.access])),new Map([[direct.projectId,'participant'],[teamSite.projectId,'viewer']]));
 s.removeGrant(bob,direct.id,'account',alice);s.removeTeamMember(bob,team.id,alice);assert.deepEqual(s.projectPage(alice,{sitesOnly:true}).projects,[]);assert.equal(s.projectPage(alice).projects[0].id,chat.projectId);assert.equal(s.projectView(alice,privateSite.projectId),null);
});

test('a chat placeholder becomes a site when its first saved field is produced',t=>{
 const s=setup(t),c=s.createConversation(alice);assert.deepEqual(s.projectPage(alice,{sitesOnly:true}).projects,[]);
 s.updateProjectState(alice,c.projectId,{version:0,fields:{assumptions:{landPrice:500000}}});
 assert.deepEqual(s.projectPage(alice,{sitesOnly:true}).projects.map(x=>x.id),[c.projectId]);assert.equal(s.list(alice)[0].id,c.id);
});

test('authenticated HTTP exposes strict optional site filtering without changing the project default',async t=>{
 const s=setup(t),chat=s.createConversation(alice),saved=draft(s),server=createResearchServer({secrets:{RESEARCH_TOKEN:'site-directory-proof'},store:s,execute:async()=>{throw new Error('Listing must not run research.');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer site-directory-proof','x-acres-account':alice};
 for(const suffix of ['', '?sitesOnly=false']){const r=await fetch(base+'/projects'+suffix,{headers});assert.equal(r.status,200);assert.deepEqual(new Set((await r.json()).projects.map(x=>x.id)),new Set([chat.projectId,saved.projectId]));}
 const r=await fetch(base+'/projects?sitesOnly=true',{headers});assert.equal(r.status,200);assert.deepEqual((await r.json()).projects.map(x=>x.id),[saved.projectId]);
 for(const value of ['','yes','1','TRUE','null'])assert.equal((await fetch(base+'/projects?sitesOnly='+value,{headers})).status,400);
 s.project.write(saved.projectId,{architecture:{value:{planId:'saved'},provenance:{tool:'user'}}});
 const model=s.createModel(alice,'123 Main Street','New model');
 assert.deepEqual((await (await fetch(base+'/projects?modelsOnly=true',{headers})).json()).projects.map(p=>p.id),[model.id]);
 assert.deepEqual((await (await fetch(base+'/projects?legacyModelsOnly=true',{headers})).json()).projects.map(p=>p.id),[saved.projectId]);
 for(const value of ['','yes','1','TRUE','null'])assert.equal((await fetch(base+'/projects?legacyModelsOnly='+value,{headers})).status,400);
 for(const pair of ['modelsOnly=true&legacyModelsOnly=true','sitesOnly=true&legacyModelsOnly=true'])assert.equal((await fetch(base+'/projects?'+pair,{headers})).status,400);
});
