import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createResearchTools} from './tools.mjs';
import {createZoningTools} from './zoning.mjs';
import {aggregate,research} from './research.mjs';
import {fieldsFromResult} from './project-state.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {collectSources} from '../app-starter/public/core-model.js';
import {property} from '../app-starter/tests/fixtures/project-state.mjs';

async function computed() {
  const tools=createResearchTools({});
  tools.record({title:'Synthetic parcel record',url:'https://example.com/synthetic-parcel',kind:'property',text:JSON.stringify(property)});
  const zoning=createZoningTools({getProperty:()=>property,record:tools.record});
  const result=await zoning.handlers.acres_zoning_envelope({});
  return {tools,zoning,result,pair:{status:'completed',tools:{property},aux:{zoningTools:zoning}}};
}
const citation=source=>({title:source.title,url:source.url,kind:source.kind,retrievedAt:source.fetchedAt});

test('aggregate keeps the envelope and evidence ID paired with the eligible parcel capture',()=>{
  const pair=(envelope,id,{bbl=property.bbl,capturedBbl=bbl,status='completed'}={})=>({status,tools:{property:{bbl}},aux:{zoningTools:{envelope,envelopeSourceId:id,envelopeBbl:capturedBbl}}});
  const selected={district:'R7A',metrics:{heightFeet:80}},other={district:'R6',metrics:{heightFeet:65}};
  const out=aggregate([pair(other,1,{status:'failed'}),pair(other,3,{capturedBbl:'1000000001'}),pair(other,2,{bbl:'1000000001'}),pair(selected,4)],property.bbl);
  assert.deepEqual(out.envelope,selected);assert.equal(out.envelopeSourceId,4);
  const missing=aggregate([pair(selected,null),pair(other,5)],property.bbl);
  assert.deepEqual(missing.envelope,selected);assert.equal(missing.envelopeSourceId,null,'No source is borrowed from another capture');
  const generic=aggregate([pair(selected,6,{capturedBbl:null})],property.bbl);
  assert.equal(generic.envelopeSourceId,6,'An explicitly computed district/lot capture remains supported');
});

test('a noncapturing zoning calculation cannot replace the saved envelope evidence',async()=>{
  const f=await computed(),before=structuredClone(f.zoning.envelope);
  const alternative=await f.zoning.handlers.acres_zoning_envelope({district:'R6A',lot:[[0,0],[50,0],[50,100],[0,100]]},{capture:false});
  assert.notEqual(alternative.sourceId,f.result.sourceId);
  const out=aggregate([f.pair],property.bbl);
  assert.deepEqual(out.envelope,before);assert.equal(out.envelopeSourceId,f.result.sourceId);
  assert.equal(Object.hasOwn(out.envelope,'sourceId'),false,'Citation metadata does not enter geometry');
});

test('field provenance keeps the selected zoning citation and parcel sources without unrelated captures',async()=>{
  const f=await computed();
  const unrelated=f.tools.record({title:'Unrelated zoning calculation',url:'https://example.com/other-envelope',kind:'zoning_envelope',text:'A different synthetic calculation.'});
  const result={property,envelope:f.zoning.envelope,envelopeSourceId:f.result.sourceId,sources:f.tools.sources};
  const expected=f.tools.sources.filter(source=>source.id!==unrelated.id).map(citation);
  assert.deepEqual(fieldsFromResult(result,'run').envelope.provenance.sources,expected);
  assert.deepEqual(fieldsFromResult({...result,property:null},'run').envelope.provenance.sources,[citation(f.tools.sources.find(source=>source.id===f.result.sourceId))]);
  for(const id of [null,999]) assert.deepEqual(fieldsFromResult({...result,envelopeSourceId:id},'run').envelope.provenance.sources,[citation(f.tools.sources[0])],'Legacy/missing IDs keep parcel evidence without guessing a zoning citation');
});

test('actual saved-project HTTP and reopened storage retain the envelope citation for Core evidence collection',async t=>{
  const f=await computed(),dir=mkdtempSync(join(tmpdir(),'acres-envelope-evidence-')),path=join(dir,'chat.sqlite'),store=new ChatStore(path),owner='a'.repeat(24),conversation=store.createConversation(owner);
  t.after(()=>rmSync(dir,{recursive:true}));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let expected;
  try {
    const out=aggregate([f.pair],property.bbl),run=store.createRun(owner,conversation.id,'Save envelope');store.begin(run);
    store.finish(run,'completed',{...out,answer:'Computed envelope.',sources:f.tools.sources});
    const response=await fetch(`http://127.0.0.1:${server.address().port}/projects/${conversation.projectId}/state`,{headers:{authorization:'Bearer test','x-acres-account':owner}}),saved=await response.json();
    assert.equal(response.status,200);expected=f.tools.sources.map(citation);
    assert.deepEqual(saved.fields.envelope.provenance.sources,expected);
    assert.deepEqual(saved.fields.envelope.value,f.zoning.envelope);
    const evidence=collectSources(saved).find(source=>source.kind==='zoning_envelope');
    assert.deepEqual(evidence.fields,['envelope']);assert.equal(evidence.retrievedAt,expected[1].retrievedAt);
    assert.equal(store.run(owner,run.id).result.envelopeSourceId,f.result.sourceId);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
  const reopened=new ChatStore(path);
  try {assert.deepEqual(reopened.projectView(owner,conversation.projectId).fields.envelope.provenance.sources,expected);}
  finally {reopened.close();}
});

for(const mode of ['lead','lanes']) test(`${mode} research returns the exact envelope source recorded by its zoning tool`,async()=>{
  const agent=async({label,execute})=>{
    if(label==='research'||label==='lane_zoning') {
      const result=await execute('acres_zoning_envelope',{district:'R7A',lot:[[0,0],[50,0],[50,100],[0,100]]});
      return `Computed envelope [${result.sourceId}].`;
    }
    if(label==='judge') return 'Computed envelope [1].';
    return 'No additional findings.';
  };
  const out=await research({message:'Check this NYC zoning envelope',propertyBbl:property.bbl,priorState:{property}},{ENABLE_CURATED_ZONING:true,...(mode==='lanes'?{RESEARCH_MODE:'lanes'}:{})},()=>{},()=>{},()=>{},agent);
  const source=out.sources.find(source=>source.kind==='zoning_envelope');
  assert.ok(out.envelope);assert.ok(source);assert.equal(out.envelopeSourceId,source.id);
  assert.equal(fieldsFromResult(out,'run').envelope.provenance.sources[0].url,source.url);
});

test('a lead run that reaches its deadline still carries the envelope its tools computed',async()=>{
  const agent=async({execute})=>{
    await execute('acres_zoning_envelope',{district:'R7A',lot:[[0,0],[50,0],[50,100],[0,100]]});
    throw Object.assign(new Error('Research timed out. Try a narrower question.'),{name:'AbortError',deadline:true});
  };
  const error=await research({message:'Check this NYC zoning envelope',propertyBbl:property.bbl,priorState:{property}},{ENABLE_CURATED_ZONING:true},()=>{},()=>{},()=>{},agent).then(()=>null,e=>e);
  assert.match(error.message,/timed out/);
  assert.ok(error.partialResult.envelope,'the computed envelope is kept');
  assert.equal(fieldsFromResult(error.partialResult,'run').envelope.provenance.sources[0].url,error.partialResult.sources.find(s=>s.id===error.partialResult.envelopeSourceId).url);
  const stopped=await research({message:'Check this NYC zoning envelope',propertyBbl:property.bbl,priorState:{property}},{ENABLE_CURATED_ZONING:true},()=>{},()=>{},()=>{},async()=>{throw Object.assign(new Error('Stopped.'),{name:'AbortError'});}).then(()=>null,e=>e);
  assert.equal(stopped.partialResult,undefined,'a run the user stopped saves nothing');
});

test('a lead answer whose only failing citation is a word-only judgment completes with that sentence uncited',async()=>{
  const agent=async({execute})=>{
    const result=await execute('acres_zoning_envelope',{district:'R7A',lot:[[0,0],[50,0],[50,100],[0,100]]});
    return `Computed envelope [${result.sourceId}]. Neighborhood sentiment and lender appetite remain uncertain [${result.sourceId}].`;
  };
  const out=await research({message:'Check this NYC zoning envelope',propertyBbl:property.bbl,priorState:{property}},{ENABLE_CURATED_ZONING:true},()=>{},()=>{},()=>{},agent);
  assert.match(out.answer,/Computed envelope \[\d+\]\. Neighborhood sentiment and lender appetite remain uncertain\.$/);
  assert.deepEqual(out.citationsDropped,['Neighborhood sentiment and lender appetite remain uncertain.']);
});

test('a lead answer with one sentence its source does not confirm completes without that sentence',async()=>{
  const agent=async({execute})=>{
    const result=await execute('acres_zoning_envelope',{district:'R7A',lot:[[0,0],[50,0],[50,100],[0,100]]});
    return `Computed envelope [${result.sourceId}]. The landlord filed 37 harassment complaints with the agency [${result.sourceId}].`;
  };
  const out=await research({message:'Check this NYC zoning envelope',propertyBbl:property.bbl,priorState:{property}},{ENABLE_CURATED_ZONING:true},()=>{},()=>{},()=>{},agent);
  assert.match(out.answer,/^Computed envelope \[\d+\]\.\n\nOne statement was left out because the cited source did not confirm it\.$/);
  assert.deepEqual(out.citationsRemoved,['The landlord filed 37 harassment complaints with the agency.']);
  assert.ok(out.envelope,'the run saves its results');
});

test('a lead research run gets twenty minutes, with or without parallel lanes',async()=>{
  for(const secrets of [{},{RESEARCH_PARALLEL_ENABLED:true}]){
    let deadline;
    await research({message:'Check this NYC zoning envelope',propertyBbl:property.bbl,priorState:{property}},{ENABLE_CURATED_ZONING:true,...secrets},()=>{},()=>{},()=>{},async({deadlineMs})=>{deadline=deadlineMs;return 'No sources were needed.';}).catch(()=>{});
    assert.equal(deadline,20*60000);
  }
});
