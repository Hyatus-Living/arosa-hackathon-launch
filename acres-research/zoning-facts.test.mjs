import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore} from './knowledge.mjs';
import {migrateZoningFacts,syncZoningFacts,searchZoningFacts,createZoningFactsHandlers} from './zoning-facts.mjs';
import {createResearchTools} from './tools.mjs';

const entries=JSON.parse(readFileSync(new URL('./zoning-facts.json',import.meta.url),'utf8'));
const rules=JSON.parse(readFileSync(new URL('./zoning-rules.json',import.meta.url),'utf8'));
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'acres-zoning-facts-')),path=join(dir,'knowledge.sqlite'),store=new KnowledgeStore(path);
  migrateZoningFacts(store);syncZoningFacts(store,entries);
  return {store,path,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const ids=result=>result.results.map(r=>r.id);

test('migration and sync are idempotent, write nothing when unchanged and retire only removed managed facts',()=>{
  const f=fixture();try {
    f.store.register({id:'existing',url:'https://example.com/',jurisdiction:'US-NY-NYC'});
    let writes=0;const write=f.store.write.bind(f.store);f.store.write=(...args)=>{writes++;return write(...args);};
    migrateZoningFacts(f.store);assert.equal(syncZoningFacts(f.store,entries).changed,false);
    searchZoningFacts(f.store,{query:'rear yard'});assert.equal(writes,0);
    assert.equal(f.store.one('SELECT count(*) n FROM zoning_facts').n,entries.length);
    assert.equal(f.store.one('SELECT count(*) n FROM zoning_facts_fts').n,entries.length);
    for(const table of ['versions','chunks','vectors'])assert.equal(f.store.one(`SELECT count(*) n FROM ${table}`).n,0);
    assert.equal(syncZoningFacts(f.store,entries.filter(e=>e.id!=='nyc-rear-yard')).changed,true);
    assert.equal(f.store.one("SELECT enabled FROM zoning_facts WHERE id='nyc-rear-yard'").enabled,0);
    assert.ok(!ids(searchZoningFacts(f.store,{query:'rear yard depth'})).includes('nyc-rear-yard'));
    syncZoningFacts(f.store,entries);assert.equal(f.store.one("SELECT enabled FROM zoning_facts WHERE id='nyc-rear-yard'").enabled,1);
    const reopened=new KnowledgeStore(f.path);try{migrateZoningFacts(reopened);assert.equal(syncZoningFacts(reopened,entries).changed,false);}finally{reopened.close();}
  }finally{f.close();}
});

test('the manifest rejects uncited facts, verified guidelines and unsafe citations',()=>{
  const f=fixture();try {
    const fact=entries.find(e=>e.id==='nyc-rear-yard'),guideline=entries.find(e=>e.kind==='guideline');
    assert.throws(()=>syncZoningFacts(f.store,[{...fact,citations:[]}]),/citations/);
    assert.throws(()=>syncZoningFacts(f.store,[{...guideline,status:'verified'}]),/Guidelines/);
    assert.throws(()=>syncZoningFacts(f.store,[{...fact,citations:[{label:'x',url:'http://zr.planning.nyc.gov/'}]}]),/HTTPS/);
    assert.throws(()=>syncZoningFacts(f.store,[fact,fact]),/Duplicate/);
    assert.equal(f.store.one("SELECT enabled FROM zoning_facts WHERE id='nyc-rear-yard'").enabled,1);
  }finally{f.close();}
});

test('natural questions reach the corrected facts',()=>{
  const f=fixture();try {
    const cases=[
      ['How deep must the rear yard be on a residential lot?','nyc-rear-yard'],
      ['Can I build apartments in an M1 manufacturing district?','nyc-manufacturing-residential'],
      ['Is there a faster review for a small rezoning?','nyc-elurp'],
      ['How long is the 485-x tax benefit for a 60 unit rental?','nyc-485x-rental-options'],
      ['Is the Upper West Side in the Manhattan Core?','nyc-manhattan-core'],
      ['How many apartments can I build? dwelling unit factor','nyc-dwelling-unit-factor'],
      ['Can a landmark transfer exceed 20 percent?','nyc-landmark-transfer-above-cap'],
      ['Does a public plaza bonus add residential floor area?','nyc-public-plaza-bonus'],
    ];
    for(const [query,id] of cases)assert.ok(ids(searchZoningFacts(f.store,{query})).includes(id),`${query} -> ${id}`);
    const rearYard=searchZoningFacts(f.store,{query:'rear yard'}).results[0];
    assert.equal(rearYard.data.rearYardFt.atOrBelow75Ft,20);
    assert.match(rearYard.misconceptions[0],/30 ft/);
    assert.match(searchZoningFacts(f.store,{query:'rear yard'}).note,/read the cited section/);
  }finally{f.close();}
});

test('district, topic and kind filters are exact and jurisdiction scope never crosses cities',()=>{
  const f=fixture();try {
    assert.equal(searchZoningFacts(f.store,{query:'FAR height',district:'r8a'}).results[0].id,'nyc-district-r8a');
    assert.ok(searchZoningFacts(f.store,{query:'review',topic:'land-use-review',limit:10}).results.every(r=>r.topic==='land-use-review'));
    assert.ok(searchZoningFacts(f.store,{query:'site',kind:'guideline',limit:10}).results.every(r=>r.kind==='guideline'));
    assert.deepEqual(searchZoningFacts(f.store,{query:'rear yard',city:'US-TX-AUSTIN'}).results,[]);
    assert.throws(()=>searchZoningFacts(f.store,{query:'x',topic:'parking'}),/Topic/);
  }finally{f.close();}
});

test('district FAR facts agree with the envelope rules file',()=>{
  for(const entry of entries.filter(e=>e.id.startsWith('nyc-district-'))) {
    const district=rules.districts[entry.districts[0]];
    assert.ok(district,`${entry.districts[0]} is in zoning-rules.json`);
    assert.equal(entry.data.standardFar,district.farResidential,entry.id);
    assert.equal(entry.data.qualifyingFar,district.farResidentialAffordable,entry.id);
  }
});

test('the research tool set exposes the zoning facts search through its handler',()=>{
  assert.ok(createResearchTools({}).definitions.some(d=>d.name==='acres_search_zoning_facts'));
  const f=fixture();try {
    const handler=createZoningFactsHandlers({open:()=>new KnowledgeStore(f.path),entries,getCity:()=>'US-NY-NYC'});
    const result=handler.acres_search_zoning_facts({query:'What does MIH Option 1 require?'});
    assert.ok(ids(result).includes('nyc-mih-options'));
    assert.ok(result.results.every(r=>r.citations.length||r.kind==='guideline'));
  }finally{f.close();}
});
