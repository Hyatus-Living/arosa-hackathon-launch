import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createResearchTools} from './tools.mjs';
import {createEntitlementTools} from './entitlements.mjs';
import {fieldsFromResult} from './project-state.mjs';
import {aggregate} from './research.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {collectSources} from '../app-starter/public/core-model.js';
import {property} from '../app-starter/tests/fixtures/project-state.mjs';

async function computed() {
  const tools=createResearchTools({});
  tools.record({title:'Synthetic parcel record',url:'https://example.com/synthetic-parcel',kind:'property',text:JSON.stringify(property)});
  const entitlement=createEntitlementTools({enabled:true,getProperty:()=>property,record:tools.record});
  const out=await entitlement.handlers.acres_entitlement_scenarios({});
  return {tools,entitlement,out};
}
const citation=source=>({title:source.title,url:source.url,kind:source.kind,retrievedAt:source.fetchedAt});
const saved=(f,entitlements=f.out,subject=property)=>fieldsFromResult({property:subject,entitlements,sources:f.tools.sources},'run').entitlements;

test('the real entitlement producer citation reaches field provenance with or without a new parcel record',async()=>{
  const f=await computed(),source=f.tools.sources.find(source=>source.id===f.out.sourceId);
  assert.equal(source.kind,'entitlement_scenarios');
  assert.deepEqual(saved(f).provenance.sources,[citation(source)]);
  assert.deepEqual(saved(f,f.out,null).provenance.sources,[citation(source)]);
});

test('own, aggregate and scenario references deduplicate and missing producer IDs retain legacy evidence',async()=>{
  const f=await computed(),extra=f.tools.record({title:'Scenario evidence fixture',url:'https://example.com/scenario-evidence',kind:'zoning',text:'Synthetic scenario evidence.'});
  f.tools.record({title:'Unrelated entitlement capture',url:'https://example.com/unrelated-capture',kind:'entitlement_scenarios',text:'Another calculation.'});
  const scenarios=[{id:'array-source',sourceIds:[extra.id]},{id:'single-source',sourceId:extra.id}];
  const field=saved(f,{...f.out,sourceIds:[extra.id],scenarios});
  assert.deepEqual(field.provenance.sources,f.tools.sources.filter(source=>[f.out.sourceId,extra.id].includes(source.id)).map(citation));
  for(const sourceId of [null,999]) {
    const legacy={...f.out,sourceId};
    assert.deepEqual(saved(f,legacy).provenance.sources,[citation(f.tools.sources[0])]);
    assert.deepEqual(saved(f,legacy,null).provenance.sources,[],'A missing ID does not guess from source kind');
  }
});

test('actual saved-project HTTP, Core evidence and reopened storage retain the captured entitlement source',async t=>{
  const f=await computed(),alternative=await f.entitlement.handlers.acres_entitlement_scenarios({landmark:true},{capture:false});
  assert.notEqual(alternative.sourceId,f.out.sourceId);assert.equal(f.entitlement.entitlements.sourceId,f.out.sourceId);
  const dir=mkdtempSync(join(tmpdir(),'acres-entitlement-evidence-')),path=join(dir,'chat.sqlite'),store=new ChatStore(path),owner='a'.repeat(24),conversation=store.createConversation(owner);
  t.after(()=>rmSync(dir,{recursive:true}));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const expected=[citation(f.tools.sources.find(source=>source.id===f.out.sourceId))];
  try {
    const out=aggregate([{status:'completed',tools:{property},aux:{entitlementTools:f.entitlement}}],property.bbl),run=store.createRun(owner,conversation.id,'Save entitlement scenarios');store.begin(run);
    store.finish(run,'completed',{...out,answer:'Computed scenarios.',sources:f.tools.sources});
    const response=await fetch(`http://127.0.0.1:${server.address().port}/projects/${conversation.projectId}/state`,{headers:{authorization:'Bearer test','x-acres-account':owner}}),project=await response.json();
    assert.equal(response.status,200);assert.deepEqual(project.fields.entitlements.provenance.sources,expected);
    assert.deepEqual(project.fields.entitlements.value,f.out);
    const source=collectSources(project).find(source=>source.kind==='entitlement_scenarios');
    assert.deepEqual(source.fields,['entitlements']);assert.equal(source.retrievedAt,expected[0].retrievedAt);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
  const reopened=new ChatStore(path);
  try {assert.deepEqual(reopened.projectView(owner,conversation.projectId).fields.entitlements.provenance.sources,expected);}
  finally {reopened.close();}
});
