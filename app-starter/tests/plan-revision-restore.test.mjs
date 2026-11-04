import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseHTML} from 'linkedom';
import * as intake from '../public/plan-intake.js';
import {architectureView} from '../public/core-model.js';
import {ChatStore} from '../../acres-research/store.mjs';
import {createResearchServer} from '../../acres-research/service.mjs';

const {document}=parseHTML('<!doctype html><html><body></body></html>');
globalThis.document=document;
const {renderArchitecture}=await import('../public/core-view.js');
const alice='a'.repeat(24);
const fixture=JSON.parse(readFileSync(new URL('./fixtures/sample-floorplan.json',import.meta.url),'utf8'));
const buildPlan=async(doc,{outDir})=>{
  const ifc=`ISO-10303-21;\n/* r${doc.revision} */\nEND-ISO-10303-21;\n`;
  writeFileSync(join(outDir,'model.ifc'),ifc);
  return {hasIfc:true,ifcSha256:createHash('sha256').update(ifc).digest('hex')};
};
// The drawn document, without the revision bookkeeping every save stamps on it.
const documentHash=({id,revision,parentRevision,...doc})=>createHash('sha256').update(JSON.stringify(doc)).digest('hex');
const words=node=>node.nodeType===3?node.textContent.trim():[...node.childNodes].map(words).filter(Boolean).join(' ');

test('three saved revisions: the first opens read only and comes back as revision 4 with the same document',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-revision-restore-')),store=new ChatStore(join(dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({answer:'x',sources:[]}),
    architecture:{stateDir:join(dir,'state'),buildPlan,worker:null,pipelineVersion:'test'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.architectureJobs?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  const projectId=store.createConversation(alice).projectId;
  const fetch=(url,init={})=>globalThis.fetch(`http://127.0.0.1:${server.address().port}${url.replace(/^\/api/,'')}`,{...init,headers:{...init.headers,authorization:'Bearer test','x-acres-account':alice}});
  let plan={...intake.planFromFixture(fixture,{ref:'floor.json'}),revision:null};
  const firstDocument=[];
  for(const name of ['First layout','Second layout','Third layout']){
    const saved=await intake.savePlan({fetch,projectId,plan:{...plan,name}});
    assert.equal(saved.status,'saved');plan=saved.plan;firstDocument.push(plan);
  }
  assert.equal(plan.revision,3);
  const summary=await (await fetch(`/api/projects/${projectId}/architecture`)).json();
  const first=await (await fetch(`/api/projects/${projectId}/architecture/revisions/1`)).json();
  assert.equal(first.plan.name,'First layout');assert.equal(first.current,false);
  const architecture={status:'ready',summary,view:architectureView(projectId,summary),
    viewing:{revision:1,status:'ready',view:architectureView(projectId,{current:first,revisions:summary.revisions})}};
  const section=renderArchitecture({},{canSend:true,architecture});
  assert.deepEqual([...section.querySelectorAll('.core-revision-name')].map(n=>n.textContent.replace(/, saved .*/,'')),['Revision 3 (current)','Revision 2','Revision 1']);
  assert.deepEqual([...section.querySelectorAll('[data-revision-open]')].map(b=>b.dataset.revisionOpen),['2','1']);
  const panel=section.querySelector('.core-revision-view');
  assert.match(words(panel),/^Revision 1, read only Back to revision 3 Plan First layout/);
  assert.equal(panel.querySelector('[data-revision-restore]').dataset.revisionRestore,'1');
  const viewer=renderArchitecture({},{canSend:false,architecture});
  assert.ok([...viewer.querySelectorAll('[data-revision-restore]')].every(b=>b.disabled),'viewers can look but not restore');
  const restored=await intake.restoreRevision({fetch,projectId,revision:1,current:3});
  assert.equal(restored.status,'saved');assert.equal(restored.plan.revision,4);assert.equal(restored.plan.parentRevision,3);
  const fourth=await (await fetch(`/api/projects/${projectId}/architecture/revisions/4`)).json();
  assert.equal(documentHash(fourth.plan),documentHash(first.plan),'revision 4 holds revision 1\'s document');
  assert.notEqual(documentHash(fourth.plan),documentHash(firstDocument[2]));
  assert.deepEqual((await (await fetch(`/api/projects/${projectId}/architecture`)).json()).revisions.map(r=>r.revision),[4,3,2,1],'nothing in between is lost');
  assert.equal((await intake.restoreRevision({fetch,projectId,revision:2,current:3})).status,'conflict','a restore from a stale page never replaces a newer revision');
});
