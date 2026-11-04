import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'acres-history-metadata-')),s=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{s.db.close();rmSync(dir,{recursive:true,force:true});});return s;
}
function traceContent(s){
  const rows=[],query=s.query.bind(s),one=s.one.bind(s);
  const collect=result=>{for(const row of result)if('payload' in row||'text' in row||'input' in row)rows.push(row);};
  s.query=(sql,...args)=>{const result=query(sql,...args);collect(result);return result;};
  s.one=(sql,...args)=>{const result=one(sql,...args);if(result)collect([result]);return result;};
  return rows;
}
async function http(t,s){
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'local-history-test'},store:s,maps:null,execute:async()=>({answer:'',sources:[],ui:[]})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return (account,path)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{authorization:'Bearer local-history-test','x-acres-account':account}});
}
test('HTTP sidebar metadata does not load the saved research bodies of listed conversations',async t=>{
  const s=fixture(t),owner='a'.repeat(24);s.setMyName(owner,'alice@example.com','Alice');
  for(let i=0;i<5;i++){
    const c=s.createConversation(owner);s.addMessage(c.id,null,'user','Research saved site '+i,{},owner);
    for(let j=0;j<20;j++)s.addMessage(c.id,null,'assistant','Long research body',{ui:[{html:'x'.repeat(16000)}]});
  }
  const request=await http(t,s),content=traceContent(s),response=await request(owner,'/conversations');
  assert.equal(response.status,200);const list=(await response.json()).conversations;
  assert.equal(list.length,5);assert.ok(list.every(c=>c.lastAuthor.name==='Alice'));
  assert.equal(content.length,0,'listing metadata must not materialize message text, payloads or run inputs');
});
test('message search returns matching sidebar metadata without materializing research bodies',t=>{
  const s=fixture(t),c=s.createConversation('alice');
  s.addMessage(c.id,null,'user','Find the overlooked courtyard',{},'alice');
  s.addMessage(c.id,null,'assistant','Stored answer',{sources:[{title:'Local source',url:'https://example.com/local'}]});
  const content=traceContent(s),list=s.list('alice','overlooked courtyard');
  assert.equal(list.length,1);assert.equal(list[0].id,c.id);assert.equal(content.length,0);
});
test('an unreadable old answer cannot break listing or searching unrelated conversation metadata',async t=>{
  const s=fixture(t),owner='a'.repeat(24),c=s.createConversation(owner);
  s.addMessage(c.id,null,'user','Find a preserved site',{},owner);
  const id=s.addMessage(c.id,null,'assistant','Historical answer');s.write('UPDATE messages SET payload=? WHERE id=?','{incomplete',id);
  const request=await http(t,s);
  for(const path of ['/conversations','/conversations?q=preserved']){
    const response=await request(owner,path);assert.equal(response.status,200);assert.equal((await response.json()).conversations[0].id,c.id);
  }
  assert.equal(s.one('SELECT payload FROM messages WHERE id=?',id).payload,'{incomplete','listing must leave original data untouched');
});
test('latest author retains explicit authors, legacy run fallback, name changes and unknown-author skipping',t=>{
  const s=fixture(t),c=s.createConversation('alice');s.setMyName('alice','alice@example.com','Alice');s.setMyName('bob','bob@example.com','Bob');
  const run=s.createRun('alice',c.id,'Legacy input');
  s.addMessage(c.id,run.id,'user','Legacy user message',{},null);
  assert.deepEqual(s.list('alice')[0].lastAuthor,{account:'alice',name:'Alice'});
  s.addMessage(c.id,run.id,'user','Explicit Bob message',{},'bob');
  s.addMessage(c.id,null,'assistant','Latest answer');s.addMessage(c.id,null,'user','Unknown author');
  s.addMessage(c.id,run.id,'user','Empty author must not fall back',{},'');
  assert.deepEqual(s.list('alice')[0].lastAuthor,{account:'bob',name:'Bob'});
  s.setMyName('bob','bob@example.com','Renamed Bob');assert.equal(s.list('alice')[0].lastAuthor.name,'Renamed Bob');
  const empty=s.createConversation('alice');assert.equal(s.list('alice').find(c=>c.id===empty.id).lastAuthor,null);
});
test('direct and team grants preserve roles, membership counts and immediate revocation during history search',t=>{
  const s=fixture(t),c=s.createConversation('alice');s.addMessage(c.id,null,'user','Shared courtyard',{},'alice');
  s.grantMember('alice',c.id,'account','bob','viewer');
  const team=s.createTeam('alice','Local research');s.addTeamMember('alice',team.id,'bob','bob@example.com');s.grantMember('alice',c.id,'team',team.id,'participant');
  let item=s.list('bob','courtyard')[0];assert.equal(item.access,'participant');assert.equal(item.memberCount,1);assert.equal(item.owner.account,'alice');
  s.removeTeamMember('alice',team.id,'bob');assert.equal(s.list('bob')[0].access,'viewer');
  s.removeGrant('alice',c.id,'account','bob');assert.deepEqual(s.list('bob','courtyard'),[]);
  assert.deepEqual(s.list('outsider','courtyard'),[]);assert.equal(s.list('alice').length,1);
});
test('literal wildcard and backslash search, duplicate matches, titles, ordering and the existing cap are retained',t=>{
  const s=fixture(t),ids=[];
  for(let i=0;i<103;i++){
    const c=s.createConversation('alice');ids.push(c.id);s.write('UPDATE conversations SET title=?,updated=? WHERE id=?',i===3?'Title 25%_\\':'Site '+i,i,c.id);
    if(i===2){s.addMessage(c.id,null,'user','Message 25%_\\',{},'alice');s.addMessage(c.id,null,'assistant','Message 25%_\\');}
    if(i===1)s.addMessage(c.id,null,'user','Message 250XX',{},'alice');
  }
  const list=s.list('alice');assert.equal(list.length,100);assert.equal(list[0].id,ids[102]);assert.equal(list.at(-1).id,ids[3]);
  assert.deepEqual(s.list('alice','25%_\\').map(c=>c.id),[ids[3],ids[2]]);
  assert.equal(s.list('alice','title 25').length,1);
});
test('opening a conversation still returns complete saved messages and run attribution',t=>{
  const s=fixture(t),c=s.createConversation('alice'),run=s.createRun('alice',c.id,'Original question');s.begin(run);
  s.finish(run,'completed',{answer:'Saved detailed answer',sources:[{title:'Evidence',url:'https://example.com/evidence'}],ui:[{html:'<p>Saved view</p>'}]});
  const before=s.conversation('alice',c.id);s.list('alice');const after=s.conversation('alice',c.id);
  assert.deepEqual(after,before);assert.equal(after.messages[1].text,'Saved detailed answer');assert.equal(after.messages[1].ui[0].html,'<p>Saved view</p>');assert.equal(after.runs[0].authorName,s.displayName('alice'));
});
test('listed conversations name the site they are attached to, and only a site',t=>{
  const s=fixture(t),onSite=s.createConversation('alice',{bbl:'3012340056'}),plain=s.createConversation('alice');
  s.write('UPDATE projects SET title=? WHERE id=?','125 Shepherd Ave',onSite.projectId);
  const content=traceContent(s),list=new Map(s.list('alice').map(c=>[c.id,c]));
  assert.deepEqual(list.get(onSite.id).site,{id:onSite.projectId,title:'125 Shepherd Ave'});
  assert.equal(list.get(plain.id).site,null,'a conversation without a parcel has no site');
  assert.equal(content.length,0);
});
test('a conversation on a parcel\'s other project names the site the saved sites list keeps',t=>{
  // Conversations started apart can each resolve the same parcel into their own project.
  const s=fixture(t),kept=s.createConversation('alice',{bbl:'3012340056'}),twin=s.createConversation('alice');
  assert.notEqual(kept.projectId,twin.projectId);
  s.write('UPDATE projects SET bbl=?,title=? WHERE id=?','3012340056','Twin',twin.projectId);
  s.write('UPDATE projects SET title=? WHERE id=?','125 Shepherd Ave',kept.projectId);
  s.write("INSERT INTO project_fields(project,key,value,provenance,updated) VALUES (?,'zoning','\"R6\"','{}',1)",kept.projectId);
  const shown=s.projectPage('alice',{sitesOnly:true}).projects.map(p=>p.id);
  assert.deepEqual(shown,[kept.projectId],'the saved sites list keeps one project for the parcel');
  const list=new Map(s.list('alice').map(c=>[c.id,c]));
  assert.deepEqual(list.get(twin.id).site,{id:kept.projectId,title:'125 Shepherd Ave'});
  assert.deepEqual(list.get(kept.id).site,{id:kept.projectId,title:'125 Shepherd Ave'});
  assert.equal(s.list('bob').length,0,'another account sees neither');
});
