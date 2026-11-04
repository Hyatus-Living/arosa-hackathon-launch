import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
const alice='a'.repeat(24),bob='b'.repeat(24);
function setup(t){const dir=mkdtempSync(join(tmpdir(),'acres-scoped-projects-')),path=join(dir,'chat.sqlite'),box={s:new ChatStore(path),path};t.after(()=>{box.s?.close();rmSync(dir,{recursive:true,force:true});});return box;}
function site(s,owner,title='Literal 100%_ site',at=1000){const c=s.createConversation(owner);s.updateProjectState(owner,c.projectId,{version:0,fields:{assumptions:{landPrice:1000000}}});s.write('UPDATE projects SET title=?,updated=? WHERE id=?',title,at,c.projectId);return c;}
function collect(s,options={}){const rows=[];let cursor=null;for(let i=0;i<5;i++){const p=s.projectPage(alice,{...options,cursor});rows.push(...p.projects);if(!p.nextCursor)return rows;cursor=p.nextCursor;}throw new Error('Fixture exceeds five pages.');}

test('project pages select caller-scoped candidates without scanning global projects or memberships',t=>{
 const {s}=setup(t);site(s,alice);for(let i=0;i<128;i++)site(s,bob,`Private ${i}`);const shared=site(s,bob),team=s.createTeam(bob,'Reader team');s.addTeamMember(bob,team.id,alice);s.grantMember(bob,shared.id,'team',team.id,'viewer');
 const query=s.query.bind(s);let captured;s.query=(sql,...params)=>{if(sql.includes('AS conversations FROM projects p'))captured={sql,params};return query(sql,...params);};s.projectPage(alice,{sitesOnly:true});
 const plan=s.query('EXPLAIN QUERY PLAN '+captured.sql,...captured.params);
 assert.ok(!plan.some(p=>/SCAN (?:p|c|cm|tm|projects|conversations|conversation_members|team_members)\b/.test(p.detail)),JSON.stringify(plan));
 assert.ok(plan.some(p=>/SEARCH projects USING .*project_owner/.test(p.detail)));assert.ok(plan.some(p=>/SEARCH cm USING .*principal/.test(p.detail)));assert.ok(plan.some(p=>/SEARCH tm USING .*account/.test(p.detail)));
});

test('scoped pages match the existing per-project access oracle across roles, duplicates, search and modes',t=>{
 const {s}=setup(t);for(let i=0;i<105;i++)site(s,alice,i%2?'Ordinary site':'Literal 100%_ site',2000);s.createConversation(alice);
 s.project.create(alice,'1000477501','Bare owned parcel',2000,'1000477501');
 const peers=Array.from({length:8},()=>site(s,bob)),team=s.createTeam(bob,'Research');s.addTeamMember(bob,team.id,alice);
 s.grantMember(bob,peers[0].id,'account',alice,'participant');s.grantMember(bob,peers[1].id,'team',team.id,'viewer');s.grantMember(bob,peers[1].id,'account',alice,'participant');
 s.grantMember(bob,peers[2].id,'account',alice,'viewer');s.createConversation(alice,{projectId:peers[2].projectId});s.removeGrant(bob,peers[2].id,'account',alice);
 s.grantMember(bob,peers[3].id,'account',alice,'viewer');s.removeGrant(bob,peers[3].id,'account',alice);
 for(const sitesOnly of [false,true])for(const q of ['', '100%_',"' OR 1=1 --"]){
  const expected=s.query('SELECT * FROM projects ORDER BY updated DESC,id DESC').filter(p=>s.canReadProject(alice,p.id)).filter(p=>!sitesOnly||p.bbl||s.one('SELECT 1 FROM project_fields WHERE project=? LIMIT 1',p.id)).filter(p=>!q||[p.title,p.site_key,p.bbl].some(v=>String(v||'').includes(q)));
  assert.deepEqual(collect(s,{sitesOnly,q}).map(p=>[p.id,p.access]),expected.map(p=>[p.id,s.projectAccess(alice,p.id)]));
 }
});

test('later scoped pages reevaluate direct revocation and archived teams while preserving owned-conversation read access',t=>{
 const {s}=setup(t);for(let i=0;i<100;i++)site(s,alice,'Owned',2000);const direct=site(s,bob),group=site(s,bob),attached=site(s,bob),team=s.createTeam(bob,'Shared');
 s.grantMember(bob,direct.id,'account',alice,'participant');s.addTeamMember(bob,team.id,alice);s.grantMember(bob,group.id,'team',team.id,'viewer');s.grantMember(bob,attached.id,'account',alice,'viewer');s.createConversation(alice,{projectId:attached.projectId});s.removeGrant(bob,attached.id,'account',alice);
 const first=s.projectPage(alice,{sitesOnly:true});assert.equal(first.projects.length,100);assert.ok(first.nextCursor);s.removeGrant(bob,direct.id,'account',alice);s.archiveTeam(bob,team.id);
 const last=s.projectPage(alice,{sitesOnly:true,cursor:first.nextCursor});assert.deepEqual(last.projects.map(p=>[p.id,p.access]),[[attached.projectId,'viewer']]);assert.equal(last.nextCursor,null);
});

test('existing databases gain active-principal indexes idempotently without rewriting project or sharing data',t=>{
 const box=setup(t),s=box.s,c=site(s,bob);s.grantMember(bob,c.id,'account',alice,'viewer');
 s.db.exec('DROP INDEX IF EXISTS conversation_member_active_principal; DROP INDEX IF EXISTS team_member_active_account; DROP INDEX IF EXISTS conversation_owner_project');
 const snapshot=store=>JSON.stringify(['projects','project_fields','conversations','conversation_members','team_members'].map(table=>store.query(`SELECT * FROM ${table} ORDER BY 1,2`))),before=snapshot(s);s.close();box.s=null;box.s=new ChatStore(box.path);
 assert.equal(snapshot(box.s),before);assert.deepEqual(box.s.query('PRAGMA index_info(conversation_member_active_principal)').map(r=>r.name),['principal_type','principal','conversation']);assert.deepEqual(box.s.query('PRAGMA index_info(team_member_active_account)').map(r=>r.name),['account','team']);assert.deepEqual(box.s.query('PRAGMA index_info(conversation_owner_project)').map(r=>r.name),['owner','project']);
 const indexes=box.s.query("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name");box.s.close();box.s=null;box.s=new ChatStore(box.path);assert.deepEqual(box.s.query("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name"),indexes);assert.equal(snapshot(box.s),before);
});
