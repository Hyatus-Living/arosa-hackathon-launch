import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,chunkText,topics,lexicalQuery,extractStatutoryTokens,parseJurisdictionParts,extractSectionSummary} from './knowledge.mjs';
import {readFileSync} from 'node:fs';
import {refreshKnowledge,extractText,fetchSource,validateSource} from './knowledge-refresh.mjs';
import {createKnowledgeHandlers} from './knowledge-tools.mjs';
import {createResearchTools} from './tools.mjs';
import {classifierProvider,embeddingProvider,jevRouterProvider} from './knowledge-providers.mjs';

const source=(id='nyc',jurisdiction='US-NY-NYC')=>({id,url:`https://www.nyc.gov/${id}`,title:id,jurisdiction,topics:['short_term_rentals'],authority:'official_agency',kind:'guidance'});
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'acres-knowledge-test-')),path=join(dir,'knowledge.sqlite'),store=new KnowledgeStore(path);return {store,path,close(){store.close();rmSync(dir,{recursive:true,force:true});}};};
const embedding={space:'test:1',async embed(texts){return texts.map(t=>/rental|airbnb|guest/i.test(t)?[1,0]:[0,1]);}};
const classifier={async classify(){return {topics:['registration'],topicScores:{registration:0.9},classifier:'test'};}};
const page=text=>new Response(`<html><head><title>Rules</title></head><body><nav>unwanted menu</nav><main><h1>Rental guidance</h1><p>${text.repeat(6)}</p></main></body></html>`,{headers:{'content-type':'text/html',etag:'v1'}});
function publish(store,s,text,metadata={},now='2026-01-01T00:00:00.000Z') {
  store.register(s);return store.publish(s,Buffer.from(text),text,{...s,...metadata},chunkText(text).map(()=>[1,0]),embedding.space,now);
}

test('search, cached URL reads and version pages retain failed-refresh and historical provenance',async()=>{
  const f=fixture(),prior=process.env.ACRES_KNOWLEDGE_DB;process.env.ACRES_KNOWLEDGE_DB=f.path;
  try {
    const s=source(),now=new Date().toISOString(),version=publish(f.store,s,'Rental registration requirements. '.repeat(20),{effectiveFrom:'2020-01-01'},now);
    f.store.failed(s.id,now,'HTTP 503');
    const search=await f.store.search({query:'rental registration',recordRetrieval:false});
    assert.equal(search.results[0].stale,true);assert.equal(search.results[0].refreshFailed,true);
    const tools=createResearchTools({}),cached=await tools.execute('acres_fetch_url',{url:s.url});
    assert.equal(cached.method,'knowledge-cache');assert.equal(cached.knowledge.stale,true);assert.equal(cached.knowledge.lastChecked,now);
    const citation=tools.sources.find(row=>row.id===cached.sourceId);assert.equal(citation.knowledge.refreshFailed,true);
    const page=await tools.execute('acres_get_knowledge_source',{versionId:version.versionId});
    assert.equal(page.stale,true);assert.equal(page.refreshFailed,true);assert.equal(page.superseded,false);
    f.store.checked(s.id,new Date(Date.now()+1000).toISOString());
    const fresh=await tools.execute('acres_get_knowledge_source',{versionId:version.versionId});
    assert.equal(fresh.stale,false);assert.notEqual(fresh.citationId,page.citationId);
    assert.equal(tools.sources.find(row=>row.id===page.citationId).knowledge.stale,true);
    publish(f.store,s,'Updated rental registration requirements. '.repeat(20),{effectiveFrom:'2020-01-01'},now);
    const historical=await tools.execute('acres_get_knowledge_source',{versionId:version.versionId});
    assert.equal(historical.superseded,true);
    f.store.checked(s.id,'2020-01-01T00:00:00Z');assert.equal(f.store.findByUrl(s.url).stale,true);
  }finally{if(prior===undefined)delete process.env.ACRES_KNOWLEDGE_DB;else process.env.ACRES_KNOWLEDGE_DB=prior;f.close();}
});

test('hybrid retrieval prefilters city but includes state authority, and records exact version evidence',async()=>{
  const f=fixture();try {
    publish(f.store,source(),'Hosts must register short term rentals.');
    publish(f.store,source('state','US-NY'),'State law regulates rental occupancy.');
    publish(f.store,source('miami','US-FL-MIA'),'Short term rental registration in Miami.');
    const result=await f.store.search({query:'Airbnb',city:'US-NY-NYC'},embedding);
    assert.equal(result.mode,'hybrid');assert.equal(result.candidateChunks,2);
    assert.deepEqual(new Set(result.results.map(r=>r.sourceId)),new Set(['nyc','state']));
    const trace=f.store.one('SELECT trace FROM retrievals WHERE id=?',result.traceId);
    assert.equal(JSON.parse(trace.trace).results.length,2);assert.ok(result.results.every(r=>r.versionId&&r.chunkId));
  }finally{f.close();}
});
test('historical retrieval honors effective ranges and excludes unknown dates',async()=>{
  const f=fixture();try {
    publish(f.store,source('old'),'Old rental provision.',{effectiveFrom:'2020-01-01',effectiveTo:'2025-01-01'});
    publish(f.store,source('new'),'New rental provision.',{effectiveFrom:'2025-01-01'});
    publish(f.store,source('unknown'),'Rental advice with unknown legal date.');
    const r=await f.store.search({query:'rental',asOf:'2024-01-01'},embedding);
    assert.deepEqual(r.results.map(r=>r.sourceId),['old']);assert.match(r.note,/incomplete/);
  }finally{f.close();}
});
test('a future effective version cannot replace the law applicable today',async()=>{
  const f=fixture();try {
    const s=source('law');
    const current=publish(f.store,s,'Current rental rule.',{effectiveFrom:'2020-01-01',effectiveTo:'2099-01-01'},'2026-01-01T00:00:00.000Z');
    publish(f.store,s,'Future rental rule.',{effectiveFrom:'2099-01-01'},'2026-02-01T00:00:00.000Z');
    const r=await f.store.search({query:'rental'},embedding);assert.equal(r.results.length,1);assert.equal(r.results[0].versionId,current.versionId);
    await assert.rejects(f.store.search({query:'rental',asOf:'2025-02-30'},embedding),/as-of/);
  }finally{f.close();}
});
test('changed documents keep originals, unchanged runs do not call AI, and errors preserve last good version',async()=>{
  const f=fixture();let ai=0;const counted={...embedding,async embed(texts){ai++;return embedding.embed(texts);}};
  try {
    const s=source(),opts={store:f.store,sources:[s],embedder:counted,classifier,fetcher:async()=>page('Hosts must register rentals and follow occupancy rules. ')};
    const first=await refreshKnowledge(opts),version=f.store.source('nyc').current_version;
    assert.equal(first.changed,1);assert.equal(ai,1);
    const same=await refreshKnowledge({...opts,classifier:{classify(){throw new Error('Must not classify unchanged content');}}});
    assert.equal(same.unchanged,1);assert.equal(ai,1);
    const cosmetic=await refreshKnowledge({...opts,fetcher:async()=>{const r=page('Hosts must register rentals and follow occupancy rules. ');return new Response((await r.text())+'<!-- dynamic timestamp -->',{headers:{'content-type':'text/html'}});},classifier:{classify(){throw new Error('Must not classify cosmetic HTML changes');}}});
    assert.equal(cosmetic.unchanged,1);assert.equal(ai,1);
    const second=await refreshKnowledge({...opts,fetcher:async()=>page('Updated rental guidance includes owner obligations. ')});
    assert.equal(second.changed,1);assert.notEqual(f.store.source('nyc').current_version,version);
    assert.equal(f.store.one('SELECT count(*) AS n FROM versions').n,2);
    const current=f.store.source('nyc'),failed=await refreshKnowledge({...opts,fetcher:async()=>new Response('failure',{status:503})});
    assert.equal(failed.failed,1);assert.equal(f.store.source('nyc').current_version,current.current_version);
    assert.equal(f.store.source('nyc').last_success,current.last_success);
    assert.equal((await f.store.search({query:'rental'},embedding)).results[0].stale,true);
  }finally{f.close();}
});
test('update leases reject concurrent runs and refresh requests are bounded and deduplicated',async()=>{
  const f=fixture();try {
    f.store.register(source());assert.equal(f.store.acquire('one'),true);assert.equal(f.store.acquire('two'),false);
    await assert.rejects(refreshKnowledge({store:f.store,sources:[source()],embedder:embedding,classifier}),/already running/);
    f.store.release('one');assert.equal(f.store.requestRefresh('nyc').status,'queued');assert.equal(f.store.requestRefresh('nyc').status,'queued');
    assert.equal(f.store.one('SELECT count(*) AS n FROM refresh_requests').n,1);
    assert.throws(()=>f.store.requestRefresh('https://localhost'),/existing/);
  }finally{f.close();}
});
test('retired sources stop appearing in search while their evidence remains stored',async()=>{
  const f=fixture();try {
    const retired=publish(f.store,source('retired'),'Old short term rental source.');
    await refreshKnowledge({store:f.store,sources:[source('active')],embedder:embedding,classifier,fetcher:async()=>page('Current short term rental registration guidance. ')});
    const r=await f.store.search({query:'rental'},embedding);
    assert.ok(r.results.every(row=>row.sourceId==='active'));
    assert.ok(f.store.one('SELECT id FROM versions WHERE id=?',retired.versionId));
    assert.throws(()=>f.store.requestRefresh('retired'),/existing/);
  }finally{f.close();}
});
test('source redirects cannot reach private hosts and a 304 needs a known version',async()=>{
  let calls=0;
  await assert.rejects(fetchSource(source(),null,async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://169.254.169.254/'}});}),/approved/);
  assert.equal(calls,1);
  await assert.rejects(fetchSource(source(),null,async()=>new Response(null,{status:304})),/stored version/);
});
test('HTML extraction removes navigation and rejects access blocks',()=>{
  const result=extractText(Buffer.from('<html><title>Rules</title><body><nav>Ignore this</nav><main><p>Actual rule.</p><script>Hidden()</script></main></body></html>'),'text/html');
  assert.match(result.text,/Actual rule/);assert.doesNotMatch(result.text,/Ignore|Hidden/);assert.equal(result.publishedAt,null);
  assert.throws(()=>extractText(Buffer.from('<title>Access denied</title>'),'text/html'),/blocking page/);
});
test('knowledge tools return citation IDs and prohibit arbitrary version reads',async()=>{
  const f=fixture();try {
    const version=publish(f.store,source(),'Hosts must register short term rentals.');
    const records=[],tools=createKnowledgeHandlers({open:()=>new KnowledgeStore(f.path),embedder:embedding,record:s=>{records.push(s);return {id:records.length};}});
    await assert.rejects(tools.acres_get_knowledge_source({versionId:version.versionId}),/Search/);
    const result=await tools.acres_search_knowledge({query:'Airbnb'});assert.equal(result.results[0].citationId,1);
    const full=await tools.acres_get_knowledge_source({versionId:version.versionId});assert.match(full.text,/register/);assert.ok(full.citationId);
    assert.equal((await tools.acres_refresh_knowledge({source:'nyc'})).status,'queued');
  }finally{f.close();}
});
test('provider failures are explicit lexical degradation and malformed embeddings cannot be published',async()=>{
  const f=fixture();try {
    publish(f.store,source(),'Hosts must register short term rentals.');
    const r=await f.store.search({query:'rental'},{space:'bad',async embed(){throw new Error('secret credential');}});
    assert.equal(r.mode,'lexical');assert.match(r.embeddingError,/unavailable/);assert.doesNotMatch(JSON.stringify(r),/secret credential/);
  }finally{f.close();}
});
test('long stored versions are fully pageable with distinct retained citation excerpts',async()=>{
  const f=fixture(),prior=process.env.ACRES_KNOWLEDGE_DB;
  process.env.ACRES_KNOWLEDGE_DB=f.path;
  try {
    const text='Rental registration.\n'+'A'.repeat(24000)+'\nLATER-PAGE-RULE\n'+'B'.repeat(26000);
    const version=publish(f.store,source(),text),tools=createResearchTools({});
    await assert.rejects(tools.execute('acres_get_knowledge_source',{versionId:version.versionId,offset:24000}),/Search/);
    await tools.execute('acres_search_knowledge',{query:'rental'});
    let offset=0,reconstructed='',firstId,laterId;
    do {
      const page=await tools.execute('acres_get_knowledge_source',{versionId:version.versionId,offset});
      assert.equal(page.offset,offset);assert.equal(page.totalCharacters,text.length);assert.ok(page.text.length<=24000);
      assert.equal(page.truncated,page.nextOffset!==null);reconstructed+=page.text;
      if(offset===0)firstId=page.citationId;
      if(offset===24000){laterId=page.citationId;assert.match(tools.sources.find(s=>s.id===laterId).text,/LATER-PAGE-RULE/);}
      offset=page.nextOffset;
    }while(offset!==null);
    assert.equal(reconstructed,text);assert.notEqual(firstId,laterId);
    const again=await tools.execute('acres_get_knowledge_source',{versionId:version.versionId,offset:24000});assert.equal(again.citationId,laterId);
    for(const offset of [-1,0.5,'24000',null,Number.MAX_SAFE_INTEGER+1,text.length])await assert.rejects(tools.execute('acres_get_knowledge_source',{versionId:version.versionId,offset}),/offset/);
  }finally{if(prior===undefined)delete process.env.ACRES_KNOWLEDGE_DB;else process.env.ACRES_KNOWLEDGE_DB=prior;f.close();}
});
test('Jev adapter uses the documented noul contract',async()=>{
  const original=global.fetch;try {
    global.fetch=async(_url,options)=>{const body=JSON.parse(options.body);return new Response(JSON.stringify({answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'noul',noul:k==='short_term_rentals'?0.99:0.1}]))}));};
    assert.deepEqual((await classifierProvider({TYPESAFE_API_KEY:'test'}).classify('Title','Text')).topics,['short_term_rentals']);
    global.fetch=async()=>new Response(JSON.stringify({data:[{index:0,embedding:[]}]}));
    await assert.rejects(embeddingProvider({OPENROUTER_API_KEY:'test'}).embed(['a']),/Invalid/);
  }finally{global.fetch=original;}
});

test('the shipped knowledge corpus validates and covers entitlements', () => {
  const sources = JSON.parse(readFileSync(new URL('./knowledge-sources.json', import.meta.url), 'utf8'));
  assert.ok(sources.length >= 16);
  for (const source of sources) {
    validateSource(source);
    for (const topic of source.topics) assert.ok(Object.hasOwn(topics, topic), `${source.id} uses unknown topic ${topic}`);
  }
  const ids = new Set(sources.map(s => s.id));
  for (const id of ['zr-72-21-variance-findings', 'zr-74-79-landmark-transfers', 'zr-23-22-far-uap', 'nyc-bsa-applications', 'nyc-ceqr-land-use-chapter']) assert.ok(ids.has(id), `missing ${id}`);
  assert.throws(() => validateSource({url: 'https://example.com/zoning'}), /outside the approved/);
  assert.throws(() => validateSource({url: 'http://zoningresolution.planning.nyc.gov/x'}), /outside the approved/);
});

test('section-aware chunking carries headings across splits and lexicalQuery preserves statutory citations and learned expansions', async () => {
  const body = `ZR 23-692 Height Limitations for Narrow Buildings\n\n${'First paragraph about sliver buildings. '.repeat(60)}\n\n${'Second paragraph with subdivision rules. '.repeat(60)}`;
  const chunks = chunkText(body, 2500);
  assert.ok(chunks.length >= 2);
  assert.match(chunks[1], /^\[ZR 23-692 Height Limitations for Narrow Buildings\]/);

  assert.deepEqual(extractStatutoryTokens('Compare ZR 74-79 and 23-22 with 485-x'), ['74-79', '23-22', '485-x']);
  const q = lexicalQuery('UAP bonus under ZR 23-22', new Map([['customterm', 'special transit area']]));
  assert.match(q, /"23-22"/);
  assert.match(q, /"universal"/);

  const f = fixture();
  try {
    const sliver = f.store.addExpansion('sliver rule', '23-692 narrow building height limitation', {sourceRun: 'run-1', confidence: 0.9});
    assert.equal(f.store.expansionsMap().size, 0);
    f.store.reviewExpansion(sliver.id, {decision: 'approved', by: 'test'});
    assert.equal(f.store.expansionsMap().get('sliver rule'), '23-692 narrow building height limitation');
    publish(f.store, source('sliver-doc'), 'Section 23-692 regulates narrow building height limitation in residence districts.');
    const hit = await f.store.search({query: 'sliver rule'}, null);
    assert.equal(hit.results.length, 1);
    assert.equal(hit.results[0].sourceId, 'sliver-doc');

    f.store.stageOfficialSource({url: 'https://www.nyc.gov/assets/planning/uap.pdf', title: 'UAP Guide', sampleRun: 'run-1'});
    const staged = f.store.stageOfficialSource({url: 'https://www.nyc.gov/assets/planning/uap.pdf', title: 'UAP Guide', sampleRun: 'run-2'});
    assert.equal(staged.times_cited, 2);
    assert.equal(f.store.stagedSources(2).length, 1);
  } finally {
    f.close();
  }
});

test('promoting an approved source works inside a caller transaction, as the dream cycle does', () => {
  const f = fixture();
  try {
    const url = 'https://www.nyc.gov/assets/planning/uap-guide.pdf';
    const text = 'Universal Affordability Preference guidance for residence districts. '.repeat(5);
    f.store.stageOfficialSource({url, title: 'UAP Guide', sampleRun: 'run-1', text});
    f.store.reviewStagedSource(url, {decision: 'approved', by: 'test'});
    f.store.db.exec("UPDATE staged_sources SET status='staged' WHERE url='" + url + "'");
    f.store.db.exec('SAVEPOINT dream_knowledge');
    const promoted = f.store.promoteStagedSource(url);
    f.store.db.exec('RELEASE dream_knowledge');
    assert.equal(promoted.status, 'promoted');
    assert.equal(f.store.db.isTransaction, false);
    assert.equal(f.store.one('SELECT status FROM staged_sources WHERE url=?', url).status, 'promoted');
  } finally {
    f.close();
  }
});

test('smart source selection infers non-NYC jurisdiction from query and rejects generic-only boilerplate matches', async () => {
  const f = fixture();
  try {
    publish(f.store, source('nyc-str', 'US-NY-NYC'), 'NYC short term rental registration rules for commercial and residential buildings.');
    publish(f.store, source('wpb-str', 'US-FL-WESTPALMBEACH'), 'West Palm Beach short term rental registration rules for hosts.');

    // Omitting `city` on a West Palm Beach query must auto-scope to US-FL-WESTPALMBEACH and exclude US-NY-NYC
    const wpbHits = await f.store.search({query: 'West Palm Beach short term rental rules'}, embedding);
    assert.equal(wpbHits.city, 'US-FL-WESTPALMBEACH');
    assert.deepEqual(wpbHits.results.map(r => r.sourceId), ['wpb-str']);

    // Query with 3 distinctive subject words ("sanitation", "waste", "carting") must not return a source
    // that only shares generic words ("nyc", "commercial", "rules")
    const unrelated = await f.store.search({query: 'NYC Department of Sanitation commercial waste carting rules'}, null);
    assert.equal(unrelated.results.length, 0);

    // Nationwide official/codifier hosts pass validateSource
    validateSource({url: 'https://library.municode.com/fl/west_palm_beach/codes/code_of_ordinances'});
    validateSource({url: 'https://www.wpb.org/government/development-services/zoning'});
  } finally {
    f.close();
  }
});

test('enriched source index catalog stores country, state, city, and sectionSummary and supports Jev router filtering', async () => {
  const f = fixture();
  const originalFetch = global.fetch;
  try {
    assert.deepEqual(parseJurisdictionParts('US-FL-WESTPALMBEACH'), {
      country: 'US',
      state: 'FL',
      city: 'West Palm Beach',
      jurisdiction: 'US-FL-WESTPALMBEACH',
    });

    const zrText = [
      '23-22 Floor Area Ratio for Residences',
      '23-221 Maximum floor area ratio for residences in R6 through R12 districts',
      'Universal Affordability Preference (UAP) bonus floor area rules and qualifying residential buildings.',
    ].join('\n');
    assert.match(extractSectionSummary(zrText), /23-22 Floor Area Ratio/);

    publish(f.store, source('zr-23-22', 'US-NY-NYC'), zrText);
    publish(f.store, source('nyc-str', 'US-NY-NYC'), 'NYC short term rental registration rules for hosts.');

    const catalog = f.store.indexCatalog({query: 'UAP floor area bonus ZR 23-22'});
    const zrEntry = catalog.find(c => c.id === 'zr-23-22');
    assert.equal(zrEntry.country, 'US');
    assert.equal(zrEntry.state, 'NY');
    assert.equal(zrEntry.city, 'New York City');
    assert.equal(zrEntry.jurisdiction, 'US-NY-NYC');
    assert.match(zrEntry.sectionSummary, /23-22 Floor Area Ratio/);

    // 1. Test jevRouterProvider parsing + direct pull / selection thresholds
    global.fetch = async (url, opts) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'jev-latest');
      assert.ok(Array.isArray(body.state.indexedSources));
      return {
        ok: true,
        json: async () => ({
          data: {
            _has_direct_indexed_match: 0.96,
            _needs_web_fanout: 0.08,
            'zr-23-22': 0.97,
            'nyc-str': 0.03,
          },
        }),
      };
    };

    const router = jevRouterProvider({TYPESAFE_API_KEY: 'test-typesafe-key'});
    const route = await router.route({query: 'UAP floor area bonus ZR 23-22', city: 'US-NY-NYC', catalog});
    assert.deepEqual(route.selectedSourceIds, ['zr-23-22']);
    assert.deepEqual(route.directPullSourceIds, ['zr-23-22']);
    assert.equal(route.hasDirectIndexedMatch, 0.96);
    assert.equal(route.needsWebFanout, 0.08);

    const routedSearch = await f.store.search({query: 'UAP floor area bonus ZR 23-22'}, null, router);
    assert.equal(routedSearch.results.length, 1);
    assert.equal(routedSearch.results[0].sourceId, 'zr-23-22');
    assert.deepEqual(routedSearch.jevRoute.directPullSourceIds, ['zr-23-22']);

    // 2. When Jev determines 0 indexed sources match, store.search short-circuits without scanning chunks or calling embedder
    let embedderCalled = false;
    const spyEmbedder = {
      space: 'test:1',
      async embed() {
        embedderCalled = true;
        return [[1, 0]];
      },
    };
    const emptyRouter = {
      async route() {
        return {
          hasDirectIndexedMatch: 0.02,
          needsWebFanout: 0.98,
          selectedSourceIds: [],
          directPullSourceIds: [],
          sourceScores: {},
        };
      },
    };
    const filteredOut = await f.store.search({query: 'Miami parking minimum ordinance'}, spyEmbedder, emptyRouter);
    assert.equal(filteredOut.mode, 'jev-filtered');
    assert.equal(filteredOut.results.length, 0);
    assert.equal(filteredOut.candidateChunks, 0);
    assert.equal(embedderCalled, false);
  } finally {
    global.fetch = originalFetch;
    f.close();
  }
});

test('registered Zoning Resolution chapters make every section under them a cache hit', () => {
  const sources = JSON.parse(readFileSync(new URL('./knowledge-sources.json', import.meta.url), 'utf8'));
  const f = fixture();
  try {
    for (const s of sources) publish(f.store, s, `${s.title}. Stored text for ${s.id}.`);
    const expected = {
      'https://zr.planning.nyc.gov/article-ii/chapter-3/23-21': 'zr-23-00-residential-bulk-chapter',
      'https://zr.planning.nyc.gov/article-ii/chapter-3/23-342': 'zr-23-00-residential-bulk-chapter',
      'https://zr.planning.nyc.gov/article-ii/chapter-3': 'zr-23-00-residential-bulk-chapter',
      'https://zr.planning.nyc.gov/article-ii/chapter-3#23-21': 'zr-23-00-residential-bulk-chapter',
      'https://zr.planning.nyc.gov/article-ix/chapter-1': 'zr-91-00-lower-manhattan-chapter',
      'https://zr.planning.nyc.gov/article-ix/chapter-1/91-22': 'zr-91-00-lower-manhattan-chapter',
      'https://zr.planning.nyc.gov/article-iii/chapter-2': 'zr-32-00-commercial-use-chapter',
      'https://zr.planning.nyc.gov/article-iii/chapter-3': 'zr-33-00-commercial-bulk-chapter',
      'https://zr.planning.nyc.gov/article-iii/chapter-5': 'zr-35-00-mixed-building-bulk-chapter',
      'https://zr.planning.nyc.gov/article-ii/chapter-2': 'zr-22-00-residence-use-chapter',
      'https://zr.planning.nyc.gov/article-ii/chapter-5': 'zr-25-00-residential-parking-chapter',
      'https://zr.planning.nyc.gov/article-ii/chapter-7': 'zr-27-00-affordable-housing-chapter',
      'https://zr.planning.nyc.gov/article-ii/chapter-7/27-131': 'zr-27-00-affordable-housing-chapter',
      'https://zr.planning.nyc.gov/article-ii/chapter-7/27-132': 'zr-27-00-affordable-housing-chapter',
      'https://zr.planning.nyc.gov/article-i/chapter-3': 'zr-13-00-manhattan-core-parking-chapter',
      'https://zr.planning.nyc.gov/article-iv/chapter-3': 'zr-43-00-manufacturing-bulk-chapter',
      'https://zr.planning.nyc.gov/article-vii/chapter-5/75-421': 'zr-75-00-cpc-authorizations-chapter',
      // A registered section keeps priority over its parent chapter.
      'https://zr.planning.nyc.gov/article-ii/chapter-3/23-22': 'zr-23-22-far-uap',
      'https://zr.planning.nyc.gov/article-vii/chapter-5/75-422': 'zr-75-422-landmark-tdr-certification',
    };
    for (const [url, sourceId] of Object.entries(expected)) {
      assert.equal(f.store.findByUrl(url)?.sourceId, sourceId, url);
    }
  } finally {
    f.close();
  }
});
