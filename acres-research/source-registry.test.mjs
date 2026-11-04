import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore} from './knowledge.mjs';
import {migrateRegistry,syncRegistry,searchRegistry,createRegistryHandlers} from './source-registry.mjs';
import {createResearchTools} from './tools.mjs';

const entries=JSON.parse(readFileSync(new URL('./source-registry.json',import.meta.url),'utf8'));
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'acres-registry-')),path=join(dir,'knowledge.sqlite'),store=new KnowledgeStore(path);
  migrateRegistry(store);syncRegistry(store,entries);
  return {store,path,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('unchanged manifest lookups acquire no writer transaction and removals retire only prior managed entries',()=>{
  const f=fixture();try {
    let writes=0,transactions=0;const write=f.store.write.bind(f.store),exec=f.store.db.exec.bind(f.store.db);
    f.store.write=(...args)=>{writes++;return write(...args);};
    f.store.db.exec=sql=>{if(/BEGIN/i.test(sql))transactions++;return exec(sql);};
    migrateRegistry(f.store);assert.equal(syncRegistry(f.store,entries).changed,false);
    searchRegistry(f.store,{query:'PLUTO'});assert.equal(writes,0);assert.equal(transactions,0);
    const retained=entries.filter(entry=>entry.id!=='nyc-pluto');
    assert.equal(syncRegistry(f.store,retained).changed,true);assert.equal(transactions,1);
    assert.equal(f.store.one("SELECT enabled FROM source_registry WHERE id='nyc-pluto'").enabled,0);
    assert.equal(f.store.one("SELECT count(*) n FROM source_registry_fts WHERE id='nyc-pluto'").n,0);
    syncRegistry(f.store,entries);assert.equal(f.store.one("SELECT enabled FROM source_registry WHERE id='nyc-pluto'").enabled,1);
    const reopened=new KnowledgeStore(f.path);try{migrateRegistry(reopened);assert.equal(syncRegistry(reopened,entries).changed,false);}finally{reopened.close();}
  }finally{f.close();}
});

test('additive migration and seed sync are idempotent and never ingest source content',()=>{
  const f=fixture();try {
    f.store.register({id:'existing',url:'https://example.com/',jurisdiction:'US-NY-NYC'});
    migrateRegistry(f.store);syncRegistry(f.store,entries);
    assert.equal(f.store.one('SELECT count(*) AS n FROM source_registry').n,entries.length);
    assert.equal(f.store.one('SELECT count(*) AS n FROM source_registry_fts').n,entries.length);
    assert.equal(f.store.one('SELECT count(*) AS n FROM sources').n,1);
    for(const table of ['versions','chunks','vectors','retrievals'])assert.equal(f.store.one(`SELECT count(*) AS n FROM ${table}`).n,0);
  }finally{f.close();}
});

test('natural questions find parcel, DOB/ACRIS public records, MLS comps, and legal sources with usable retrieval plans',()=>{
  const f=fixture();try {
    const result=searchRegistry(f.store,{query:'What zoning and floor area rules apply to this address?'});
    assert.ok(result.results.some(r=>r.id==='nyc-pluto'));
    assert.ok(result.results.some(r=>r.id==='nyc-zoning-resolution'));
    const pluto=result.results.find(r=>r.id==='nyc-pluto');
    assert.equal(pluto.templates[0].tool,'acres_find_property');
    assert.ok(pluto.identifiers.includes('bbl'));
    assert.equal(pluto.citationId,undefined);
    const zr=result.results.find(r=>r.id==='nyc-zoning-resolution');
    assert.ok(zr.accessPoints.length>1);assert.ok(zr.accessPoints.every(point=>point.url&&!('staticHtml' in point)));
    assert.match(result.note,/not evidence/);

    const dob=searchRegistry(f.store,{query:'previous plan submittal disapproved job filings certificate of occupancy'});
    assert.ok(dob.results.some(r=>r.id==='nyc-dob-job-filings'));
    assert.equal(dob.results.find(r=>r.id==='nyc-dob-job-filings').templates[0].tool,'acres_nyc_public_records');

    const acris=searchRegistry(f.store,{query:'ACRIS air rights ZLDA deed easement HPD violations'});
    assert.ok(acris.results.some(r=>r.id==='nyc-acris-records'));

    const comps=searchRegistry(f.store,{query:'MLS sold rental comparables absorption velocity days on market',city:'US-FL-MIAMI'});
    assert.ok(comps.results.some(r=>r.id==='us-homeharvest-mls-comps'));
    assert.equal(comps.results.find(r=>r.id==='us-homeharvest-mls-comps').templates[0].tool,'acres_market_comps');
  }finally{f.close();}
});

test('city scope is applied before results and includes appropriate state sources',()=>{
  const f=fixture();try {
    syncRegistry(f.store,[{...entries[0],id:'ny-state',jurisdiction:'US-NY'}]);
    assert.equal(searchRegistry(f.store,{query:'zoning',city:'US-CA-LA'}).results.length,0);
    assert.ok(searchRegistry(f.store,{query:'zoning'}).results.some(r=>r.id==='ny-state'));
    assert.equal(searchRegistry(f.store,{query:'zoning',city:'US-NY'}).results.length,1);
  }finally{f.close();}
});

test('category filter, stemming and query quoting work without SQL or FTS injection',()=>{
  const f=fixture();try {
    assert.equal(searchRegistry(f.store,{query:'variances',category:'variances'}).results[0].id,'nyc-bsa-decisions');
    assert.equal(searchRegistry(f.store,{query:'" OR * : ) -- zoning',category:'addresses'}).results.length,0);
    assert.throws(()=>searchRegistry(f.store,{query:'x',city:"US'); DROP TABLE sources;--"}),/jurisdiction/);
    assert.throws(()=>searchRegistry(f.store,{query:'x',limit:11}),/limit/);
    for(const limit of [0,-1,1.5,'5',null])assert.throws(()=>searchRegistry(f.store,{query:'zoning',limit}),/limit/);
    for(const category of ['',{},[],1,'x'.repeat(101)])assert.throws(()=>searchRegistry(f.store,{query:'zoning',category}),/category/);
    assert.throws(()=>searchRegistry(f.store,{query:'zoning',city:null}),/jurisdiction/);
    assert.throws(()=>searchRegistry(f.store,{query:'x'.repeat(2001)}),/query/);
    assert.throws(()=>searchRegistry(f.store,{query:''}),/query/);
    assert.equal(searchRegistry(f.store,{query:'unmatcheduniqueterm'}).results.length,0);
    assert.deepEqual(searchRegistry(f.store,{query:'the and'}).results,[]);
  }finally{f.close();}
});

test('metadata updates replace FTS terms and disabled sources are excluded',()=>{
  const f=fixture();try {
    const unique={...entries[0],id:'update-test',keywords:['uniqueprior'],name:'Test source'};
    syncRegistry(f.store,[unique]);
    assert.equal(searchRegistry(f.store,{query:'uniqueprior'}).results.length,1);
    syncRegistry(f.store,[{...unique,keywords:['uniquenew']}]);
    assert.equal(searchRegistry(f.store,{query:'uniqueprior'}).results.length,0);
    assert.equal(searchRegistry(f.store,{query:'uniquenew'}).results.length,1);
    syncRegistry(f.store,[{...unique,enabled:false}]);
    assert.equal(searchRegistry(f.store,{query:'uniqueprior'}).results.length,0);
    assert.ok(f.store.one('SELECT id FROM source_registry WHERE id=?',unique.id));
  }finally{f.close();}
});

test('verification scope and age remain explicit; unverified does not imply working',()=>{
  const f=fixture();try {
    const bsa=searchRegistry(f.store,{query:'BSA',limit:1},Date.parse('2027-02-01')).results[0];
    assert.equal(bsa.status,'partial');assert.equal(bsa.reviewDue,true);
    assert.ok(bsa.limitations.some(t=>t.includes('error banner')));
    syncRegistry(f.store,[{...entries[0],id:'unknown',status:'unverified',lastVerifiedAt:null,verification:[]}]);
    assert.equal(searchRegistry(f.store,{query:'PLUTO'}).results.find(r=>r.id==='unknown').reviewDue,true);
  }finally{f.close();}
});

test('invalid metadata fails before changing existing records',()=>{
  const f=fixture();try {
    assert.throws(()=>syncRegistry(f.store,[{...entries[0],name:'Changed'}, {...entries[1],method:'shell'}]),/metadata/);
    assert.equal(f.store.one('SELECT name FROM source_registry WHERE id=?','nyc-pluto').name,entries[0].name);
    assert.throws(()=>syncRegistry(f.store,[entries[0],entries[0]]),/Duplicate/);
    assert.throws(()=>syncRegistry(f.store,[{...entries[0],accessPoints:[{url:'https://user:secret@example.com/'}]}]),/credentials/);
    assert.throws(()=>syncRegistry(f.store,[{...entries[0],accessPoints:[{url:'https://example.com/',staticHtml:'yes'}]}]),/staticHtml must be boolean/);
    for(const invalid of [null,{...entries[0],enabled:'false'},{...entries[0],keywords:[{}]},{...entries[0],jurisdiction:null}])assert.throws(()=>syncRegistry(f.store,[invalid]),/registry/i);
    assert.throws(()=>syncRegistry(f.store,{}),/array/);
  }finally{f.close();}
});

test('tool exposes discovery without fetching, credentials or citation fabrication',async()=>{
  const f=fixture(),prior=process.env.ACRES_KNOWLEDGE_DB;
  process.env.ACRES_KNOWLEDGE_DB=f.path;
  try {
    const tools=createResearchTools({});
    assert.ok(tools.definitions.some(d=>d.name==='acres_search_source_registry'));
    const result=await tools.execute('acres_search_source_registry',{query:'PLUTO'});
    assert.ok(result.results.some(r=>r.id==='nyc-pluto'));
    assert.equal(tools.sources.length,0);
    await assert.rejects(tools.execute('shell',{command:'id'}),/unavailable/);
    await assert.rejects(tools.execute('acres_execute_tool',{slug:'GMAIL_SEND_EMAIL',arguments:{}}),/Discover this tool/);
    const handler=createRegistryHandlers({open:()=>new KnowledgeStore(f.path),entries});
    assert.equal(handler.acres_search_source_registry({query:'BSA',limit:1}).results[0].id,'nyc-bsa-decisions');
  }finally{if(prior===undefined)delete process.env.ACRES_KNOWLEDGE_DB;else process.env.ACRES_KNOWLEDGE_DB=prior;f.close();}
});
