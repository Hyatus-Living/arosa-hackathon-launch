import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {KnowledgeStore} from './knowledge.mjs';
import {extractRunSignals,evaluateRun,runDreamCycle,reviewDreamItem} from './dream.mjs';
import {searchCapabilities} from './capabilities.mjs';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'acres-dream-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  const knowledge=new KnowledgeStore(join(dir,'knowledge.sqlite'));
  t.after(()=>{
    knowledge.close();
    store.close();
    rmSync(dir,{recursive:true,force:true});
  });
  return {store,knowledge,dir};
}

test('extractRunSignals and evaluateRun detect steers, zero-hit search reformulations, citation repairs, and official URLs',async()=>{
  const run={
    id:'run-1',
    owner:'alice',
    conversation:'conv-1',
    status:'completed',
    input:'Underwrite 120 Broadway with UAP',
    result:{
      answer:'Analysis complete [1].',
      property:{bbl:'1000477501',borough:'MN',jurisdiction:'nyc'},
      sources:[
        {id:1,title:'NYC Zoning Resolution 23-22',url:'https://zr.planning.nyc.gov/article-ii/chapter-3/23-22'},
      ],
    },
  };
  const events=[
    {seq:1,event:'tool.call',tool:'acres_fanout_search',arguments:{query:'afforable bonus uap'},ok:true,sourceCount:0,providerHits:{knowledge:0}},
    {seq:2,event:'tool.call',tool:'acres_fanout_search',arguments:{query:'universal affordability preference ZR 23-22'},ok:true,sourceCount:2,providerHits:{knowledge:2}},
    {seq:3,event:'run.steered',text:'Always include a 5.5% exit cap sensitivity row in rental pro formas'},
    {seq:4,event:'turn.repair',reason:'Invalid [99] citation'},
  ];
  const messages=[
    {id:'m1',runId:'run-1',role:'user',text:'Underwrite 120 Broadway with UAP'},
    {id:'m2',runId:'run-1',role:'user',steer:true,text:'Always include a 5.5% exit cap sensitivity row in rental pro formas'},
    {id:'m3',runId:'run-1',role:'assistant',text:'Analysis complete [1].'},
  ];

  const signals=extractRunSignals({run,events,messages,projectState:{}});
  assert.equal(signals.zeroHitReformulations.length,1);
  assert.equal(signals.zeroHitReformulations[0].fromQuery,'afforable bonus uap');
  assert.equal(signals.zeroHitReformulations[0].toQuery,'universal affordability preference ZR 23-22');
  assert.equal(signals.citationRepaired,true);
  assert.equal(signals.steers.length,1);
  assert.equal(signals.officialUrls.length,1);

  const ev=await evaluateRun({run,events,messages,projectState:{}});
  assert.equal(ev.citationFidelity,0.85,'one cited claim, discounted for the citation repair');
  assert.equal(ev.toolEfficiency,0.9);
  assert.equal(ev.domainCompleteness,0.75);
  assert.ok(ev.overall>0.7);
  assert.equal(ev.candidateMemories.some(m=>m.rule.includes('5.5% exit cap')),true);
  assert.equal(ev.candidateExpansions.length,1);
  assert.equal(ev.candidateSources.length,1);
});

test('runDreamCycle consolidates traces into workspace_memories, learned_expansions, and staged_sources',async t=>{
  const {store,knowledge}=setup(t);
  const source={
    id:'zr-23-22',
    title:'NYC ZR 23-22 Universal Affordability Preference',
    url:'https://zr.planning.nyc.gov/article-ii/chapter-3',
    jurisdiction:'US-NY-NYC',
    topics:['zoning'],
    authority:'statute',
    kind:'zoning-text',
  };
  const text='# Section 23-22\n\nUniversal Affordability Preference (UAP) permits an additional 20 percent residential floor area bonus.';
  knowledge.register(source);
  knowledge.publish(source,Buffer.from(text),text,source,[],'none',new Date().toISOString());

  const conv=store.createConversation('alice');
  const run=store.createRun('alice',conv.id,'Analyze UAP at 120 Broadway');
  store.begin(run);
  store.event(run.id,'tool.call',{tool:'acres_fanout_search',arguments:{query:'skylineinclusion'},ok:true,sourceCount:0,providerHits:{knowledge:0}});
  store.event(run.id,'tool.call',{tool:'acres_fanout_search',arguments:{query:'Universal Affordability Preference'},ok:true,sourceCount:1,providerHits:{knowledge:1}});
  store.event(run.id,'run.steered',{text:'Always include a 5.5% exit cap rate in rental underwriting'});
  store.addMessage(conv.id,run.id,'user','Always include a 5.5% exit cap rate in rental underwriting',{steer:true},'alice');
  store.finish(run,'completed',{
    answer:'UAP grants a 20% bonus [1].',
    property:{bbl:'1000477501',address:'120 BROADWAY',borough:'MN'},
    sources:[{id:1,title:'NYC ZAP Portal',url:'https://zap.planning.nyc.gov/projects/123',text:'Project record',kind:'zoning'}],
  });

  // Before dreaming, query 'skylineinclusion' has 0 lexical hits
  const beforeHits=await knowledge.search({query:'skylineinclusion',city:'US-NY-NYC',limit:5});
  assert.equal(beforeHits.results.length,0);

  const cycle=await runDreamCycle({store,knowledge});
  assert.equal(cycle.runsEvaluated,1);
  assert.ok(cycle.memoriesConsolidated>=1);
  assert.equal(cycle.expansionsLearned,1);
  assert.equal(cycle.sourcesStaged,1);

  // Subsequent dream cycle does not re-evaluate already-scored runs
  const secondCycle=await runDreamCycle({store,knowledge});
  assert.equal(secondCycle.runsEvaluated,0);

  // After approval, the memory is returned for future runs in this account/conversation
  assert.deepEqual(store.memoriesForRun('alice',conv.id),[]);
  for(const m of store.listMemories())reviewDreamItem({store,knowledge,kind:'memory',id:m.id,decision:'approve',by:'test'});
  const memories=store.memoriesForRun('alice',conv.id);
  assert.equal(memories.some(m=>m.includes('5.5% exit cap')),true);

  // An approved global expansion lets 'skylineinclusion' retrieve the UAP section from KnowledgeStore
  for(const e of knowledge.listExpansions())reviewDreamItem({store,knowledge,kind:'expansion',id:e.id,decision:'approve',by:'test',scope:'global'});
  const afterHits=await knowledge.search({query:'skylineinclusion',city:'US-NY-NYC',limit:5});
  assert.ok(afterHits.results.length>=1);
  assert.equal(afterHits.results[0].sourceId,'zr-23-22');

  // Learned expansion also works in searchCapabilities
  const lotcombo=knowledge.addExpansion('lotcombo','acres_assemble_site merge lots',run.id);
  reviewDreamItem({store,knowledge,kind:'expansion',id:lotcombo.id,decision:'approve',by:'test'});
  const capRes=searchCapabilities({query:'lotcombo'},null,knowledge.expansionsMap());
  assert.equal(capRes.results.some(tool=>tool.name==='acres_assemble_site'),true);

  // Official source was staged in KnowledgeStore
  const staged=knowledge.stagedSources();
  assert.equal(staged.length,1);
  assert.equal(staged[0].url,'https://zap.planning.nyc.gov/projects/123');
});

test('probe 7 & 10: dream normalizes runtime tool.started/tool.completed events and attributes steers to their actual author',async t=>{
  const {store,knowledge}=setup(t);
  const conv=store.createConversation('alice');
  store.grantMember('alice',conv.id,'account','bob','participant','bob@witharosa.ai');

  const run=store.createRun('alice',conv.id,'Underwrite 120 Broadway');
  store.begin(run);
  // Emit real runtime telemetry format: tool.started + tool.completed
  store.event(run.id,'tool.started',{name:'acres_fanout_search',arguments:{query:'uap bonus typo'}});
  store.event(run.id,'tool.completed',{name:'acres_fanout_search',success:false,sourceCount:0});
  store.event(run.id,'tool.started',{name:'acres_fanout_search',arguments:{query:'universal affordability preference'}});
  store.event(run.id,'tool.completed',{name:'acres_fanout_search',success:true,sourceCount:2});
  store.event(run.id,'run.steered',{text:'Always include a 6.0% exit cap stress test'});
  store.addMessage(conv.id,run.id,'user','Always include a 6.0% exit cap stress test',{steer:true},'bob');
  store.finish(run,'completed',{
    answer:'Completed with 6.0% cap stress test [1].',
    property:{bbl:'1000477501',borough:'MN',jurisdiction:'nyc'},
    sources:[{id:1,title:'NYC ZR',url:'https://zr.planning.nyc.gov/article-ii/chapter-3',text:'ZR 23-22',kind:'zoning'}],
  });

  const events=store.runEvents(run.id);
  const messages=store.conversation('alice',conv.id).messages;
  const signals=extractRunSignals({run:store.run('alice',run.id),events,messages,projectState:{}});
  assert.equal(signals.toolCalls.length,2,'tool.started/tool.completed pairs must be normalized into toolCalls');
  assert.equal(signals.failedTools.length,1,'failed tool.completed must be counted');
  assert.equal(signals.zeroHitReformulations.length,1);
  assert.equal(signals.preferenceCandidates[0].author,'bob');

  const ev=await evaluateRun({run:store.run('alice',run.id),events,messages,projectState:{}});
  assert.ok(ev.toolEfficiency<1,'failed runtime tool calls must penalize toolEfficiency');
  assert.equal(ev.candidateMemories[0].principal,'bob');

  await runDreamCycle({store,knowledge});
  for(const m of store.listMemories({principal:'bob'}))reviewDreamItem({store,knowledge,kind:'memory',id:m.id,decision:'approve',by:'test'});
  const bobMemories=store.memoriesForRun('bob',null);
  assert.ok(bobMemories.some(m=>m.includes('6.0% exit cap')),'steer by bob must consolidate into bob account memories');
});

test('staged official sources cited across >= 2 runs with >= 200 chars of text become promotion candidates and enter the searchable corpus on approval',async t=>{
  const {store,knowledge}=setup(t);
  const conv=store.createConversation('alice');
  const officialUrl='https://www.nyc.gov/assets/planning/download/pdf/zoning/zoning-maps/special-lower-manhattan-guide.pdf';
  const officialText='# Special Lower Manhattan District Guide\n\n'+'Under Section 91-22, floor area bonuses in Lower Manhattan require certified public plaza maintenance agreements and transit easement volume dedication across eligible C5-5 parcels. '.repeat(2);

  for(let i=1;i<=2;i++){
    const run=store.createRun('alice',conv.id,`Run ${i} on Lower Manhattan transit easement`);
    store.begin(run);
    store.finish(run,'completed',{
      answer:`Lower Manhattan transit easement rules apply [1].`,
      property:{bbl:'1000477501',borough:'MN',jurisdiction:'nyc'},
      sources:[{id:1,title:'Special Lower Manhattan District Guide',url:officialUrl,text:officialText,kind:'zoning'}],
    });
  }

  const cycle=await runDreamCycle({store,knowledge});
  assert.equal(cycle.runsEvaluated,2);
  assert.equal(cycle.sourcesPromoted,0);
  assert.equal(cycle.promotionCandidates,1);
  reviewDreamItem({store,knowledge,kind:'source',id:officialUrl,decision:'approve',by:'test'});

  const promoted=knowledge.stagedSources('promoted');
  assert.equal(promoted.length,1);
  assert.equal(promoted[0].url,officialUrl);
  assert.equal(promoted[0].times_cited,2);

  const searchHits=await knowledge.search({query:'91-22 transit easement volume dedication',city:'US-NY-NYC',limit:5});
  assert.ok(searchHits.results.some(r=>r.url===officialUrl),'promoted staged source must be searchable in KnowledgeStore');
});


test('ChatStore mirrors run events to traces/<runId>.jsonl and dream extracts pagination hotspots, latency, and statutory citation gaps',async t=>{
  const {store}=setup(t);
  const conv=store.createConversation('alice');
  const run=store.createRun('alice',conv.id,'Analyze flood resilience at 120 Broadway');
  store.begin(run);
  store.event(run.id,'tool.started',{tool:'acres_fetch_url',arguments:{url:'https://zr.planning.nyc.gov/article-vi/chapter-4',offset:0}});
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url:'https://zr.planning.nyc.gov/article-vi/chapter-4',offset:0},durationMs:420,success:true,result:{sourceId:1,method:'knowledge-cache'}});
  store.event(run.id,'tool.started',{tool:'acres_fetch_url',arguments:{url:'https://zr.planning.nyc.gov/article-vi/chapter-4',offset:24000}});
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url:'https://zr.planning.nyc.gov/article-vi/chapter-4',offset:24000},durationMs:380,success:true,result:{sourceId:2,method:'cloudflare'}});
  store.event(run.id,'tool.started',{tool:'acres_fetch_url',arguments:{url:'https://zr.planning.nyc.gov/article-vi/chapter-4',offset:48000}});
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url:'https://zr.planning.nyc.gov/article-vi/chapter-4',offset:48000},durationMs:15,success:true,result:{paginationBlocked:true}});
  store.event(run.id,'message.delta',{id:'m1',delta:'Streaming chunk'});
  store.event(run.id,'turn.repair',{reason:'Source [1] does not mention 64-32.',sourceCount:2,validSourceIds:[1,2],failedDraft:'Draft citing [1] for 64-32.'});
  store.finish(run,'completed',{
    answer:'Flood resilience rules apply [1].',
    property:{bbl:'1000477501',borough:'MN',jurisdiction:'nyc'},
    sources:[
      {id:1,title:'ZR 64-00',url:'https://zr.planning.nyc.gov/article-vi/chapter-4',text:'Section 64-00',kind:'zoning'},
      {id:2,title:'ZR 64-00 page 2',url:'https://zr.planning.nyc.gov/article-vi/chapter-4',text:'Section 64-32',kind:'zoning'},
    ],
  });

  const exported=store.exportTrace(run.id);
  assert.ok(exported.traceFile.endsWith(`${run.id}.jsonl`));
  const ev=await evaluateRun({run:exported.run,events:exported.events,messages:[],projectState:{}});
  assert.equal(ev.signals.urlPaginationHotspots.length,1);
  assert.equal(ev.signals.urlPaginationHotspots[0].fetchCount,3);
  assert.equal(ev.signals.urlPaginationHotspots[0].offsetCalls,2);
  assert.equal(ev.signals.urlPaginationHotspots[0].paginationBlockedCount,1);
  assert.equal(ev.signals.uncitedFetchedUrls.length,1);
  assert.equal(ev.signals.statutoryCitationGaps[0].missingToken,'64-32');
  assert.equal(ev.signals.toolLatencyMs.totalMs,815);
  assert.ok(ev.candidateMemories.some(m=>m.category==='tool-efficiency'));
});

test('dream separates charged fetches from free re-reads of a page held in the run',async t=>{
  const {store}=setup(t);
  const conv=store.createConversation('alice');
  const run=store.createRun('alice',conv.id,'What does the parking chapter require?');
  store.begin(run);
  const url='https://library.example.gov/code/chapter-5';
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url},success:true,result:{sourceId:1,method:'cloudflare'}});
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url,find:'parking'},success:true,result:{sourceId:2,method:'cloudflare',cacheHit:true}});
  store.finish(run,'completed',{answer:'Parking rules apply [1][2].',sources:[]});
  const exported=store.exportTrace(run.id);
  const ev=await evaluateRun({run:exported.run,events:exported.events,messages:[],projectState:{}});
  const hotspot=ev.signals.urlPaginationHotspots.find(u=>u.url===url);
  assert.equal(hotspot.fetchCount,2);
  assert.equal(hotspot.fetchCharges,1);
  assert.equal(ev.signals.toolCalls[1].cacheHit,true);
});

test('dream counts only calls that spent budget: refusals and failed free re-reads are not charges',async t=>{
  const {store}=setup(t);
  const conv=store.createConversation('alice');
  const run=store.createRun('alice',conv.id,'What does the parking chapter require?');
  store.begin(run);
  const url='https://library.example.gov/code/chapter-5';
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url},success:true,result:{sourceId:1,method:'cloudflare'}});
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url,offset:24000},success:false,result:{error:'The research tool budget is exhausted.',retryable:false,charged:false}});
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url,offset:900000},success:false,result:{error:'Character offset is past the end of the fetched document.',retryable:false,charged:false}});
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url:`${url}#b`},success:false,result:{error:'Fetch failed.',retryable:true,charged:true}});
  store.event(run.id,'tool.completed',{tool:'acres_fetch_url',arguments:{url,find:'parking'},success:true,result:{sourceId:2,method:'knowledge-cache'}});
  store.finish(run,'completed',{answer:'Parking rules apply [1][2].',sources:[]});
  const exported=store.exportTrace(run.id);
  const ev=await evaluateRun({run:exported.run,events:exported.events,messages:[],projectState:{}});
  const hotspot=ev.signals.urlPaginationHotspots.find(u=>u.url===url);
  assert.equal(hotspot.fetchCount,5);
  assert.equal(hotspot.fetchCharges,2);
});

test('non-NYC research runs stage municipal and codifier sources under their actual jurisdiction instead of US-NY-NYC',async t=>{
  const {store,knowledge}=setup(t);
  const conv=store.createConversation('alice');
  const run=store.createRun('alice',conv.id,'What are the short-term rental rules in West Palm Beach, FL?');
  store.begin(run);
  store.finish(run,'completed',{
    answer:'West Palm Beach regulates short-term rentals under Code of Ordinances Chapter 94 [1] and city portal rules [2].',
    property:null,
    sources:[
      {id:1,title:'West Palm Beach Code of Ordinances',url:'https://library.municode.com/fl/west_palm_beach/codes/code_of_ordinances',text:'Chapter 94 Zoning and Land Development Regulations for West Palm Beach.'.repeat(4),kind:'zoning'},
      {id:2,title:'West Palm Beach Zoning Portal',url:'https://www.wpb.org/government/development-services/zoning',text:'Official West Palm Beach rental certificate of use requirements.'.repeat(4),kind:'zoning'},
    ],
  });

  await runDreamCycle({store,knowledge});
  const staged=knowledge.stagedSources();
  assert.equal(staged.length,2);
  for(const row of staged){
    assert.equal(row.jurisdiction,'US-FL-WESTPALMBEACH',`expected US-FL-WESTPALMBEACH for ${row.url}`);
  }
});


test('dream reads budget exhaustion per category from refusals, not from a call count, and counts compute tools and dataset fetches',()=>{
  const done=(tool,args={},result={sourceId:1},success=true)=>({event:'tool.completed',tool,arguments:args,success,result});
  const exhausted=extractRunSignals({run:{id:'r1',status:'completed',result:{answer:'Done [1].',sources:[]}},events:[
    done('acres_fetch_url',{url:'https://data.cityofnewyork.us/resource/ic3t-wcy2.json?$where=bbl=1'}),
    done('acres_fetch_url',{url:'https://maps.example.gov/arcgis/rest/services/Parcels/FeatureServer/0/query?where=1'}),
    done('acres_fetch_url',{url:'https://library.example.gov/code/chapter-5'}),
    done('acres_execute_capability',{name:'acres_zoning_envelope',arguments:{}}),
    done('acres_pro_forma',{}),
    done('acres_unit_mix',{},{error:'Program is missing.'},false),
    done('acres_fanout_search',{},{error:'The research tool budget is exhausted for fetch and search calls. 3 records calls remain.',retryable:false,charged:false},false),
    done('acres_nyc_public_records',{},{error:'The research tool budget is exhausted for records calls.',charged:false},false),
  ]});
  assert.equal(exhausted.budgetExhausted,true);
  assert.deepEqual(exhausted.exhaustedCategories,['fetch','specialist']);
  assert.deepEqual(exhausted.computeToolsRun,['acres_pro_forma','acres_zoning_envelope']);
  assert.equal(exhausted.datasetFetchCalls,2);

  const busy=extractRunSignals({run:{id:'r2',status:'completed',result:{answer:'Done [1].',sources:[]}},events:Array.from({length:24},(_,i)=>done('acres_fetch_url',{url:`https://library.example.gov/code/chapter-${i}`}))});
  assert.equal(busy.budgetExhausted,false,'a long run that never ran out did not exhaust its budget');
  assert.deepEqual(busy.exhaustedCategories,[]);
  assert.equal(busy.datasetFetchCalls,0);
});

test('dream counts a budget pool that reached zero as exhausted even when no call was refused, and reads the bare refusal per budget model',()=>{
  const done=(tool,result,success=true)=>({event:'tool.completed',tool,arguments:{},success,result});
  const signals=events=>extractRunSignals({run:{id:'r',status:'completed',result:{answer:'Done [1].',sources:[]}},events});
  const pools=(fetch,specialist,compute)=>({sourceId:1,remainingToolCalls:fetch+specialist+compute,budget:{fetch,specialist,compute,reserve:3,reserveLocked:true}});

  const spent=signals([done('acres_fetch_url',pools(1,9,12)),done('acres_nyc_public_records',pools(1,0,12)),done('acres_fetch_url',pools(0,0,12))]);
  assert.equal(spent.splitBudget,true);
  assert.equal(spent.budgetExhausted,false,'compute calls remained and nothing was refused');
  assert.deepEqual(spent.exhaustedCategories,['fetch','specialist']);

  const covered=signals([done('acres_fetch_url',{sourceId:1,remainingToolCalls:19,budget:{fetch:0,specialist:6,compute:10,reserve:3,reserveLocked:false}})]);
  assert.equal(covered.budgetExhausted,false);
  assert.deepEqual(covered.exhaustedCategories,[],'an unlocked reserve still covers a pool at zero');

  const allOut=signals([done('acres_fetch_url',pools(0,1,0)),done('acres_zoning_envelope',{error:'The research tool budget is exhausted. Summarize the evidence and remaining gaps.'},false)]);
  assert.deepEqual(allOut.exhaustedCategories,['compute','fetch','specialist'],'the bare refusal under the split budget means every pool is empty');

  const shared=signals([done('acres_fetch_url',{sourceId:1,remainingToolCalls:1}),done('acres_zoning_envelope',{sourceId:2,remainingToolCalls:0})]);
  assert.equal(shared.splitBudget,false);
  assert.equal(shared.budgetExhausted,true,'a single-pool trace that reached zero ran out');
  assert.deepEqual(shared.exhaustedCategories,[],'a single-pool trace is not split by pool');

  const refusedShared=signals([done('acres_fetch_url',{sourceId:1,remainingToolCalls:3}),done('acres_zoning_envelope',{error:'The research tool budget is exhausted. Summarize the evidence and remaining gaps.'},false)]);
  assert.equal(refusedShared.budgetExhausted,true);
  assert.deepEqual(refusedShared.exhaustedCategories,[]);

  const left=signals([done('acres_fetch_url',pools(4,5,6)),done('acres_fetch_url',{sourceId:2,remainingToolCalls:14,budget:{fetch:3,specialist:5,compute:6,reserve:3}})]);
  assert.equal(left.budgetExhausted,false);
});

test('dream maps every deployed refusal wording to its pool',()=>{
  const done=(tool,result,success=true)=>({event:'tool.completed',tool,arguments:{},success,result});
  const signals=events=>extractRunSignals({run:{id:'r',status:'completed',result:{answer:'Done [1].',sources:[]}},events});
  const twoPool=(fetch,specialist)=>({sourceId:1,remainingToolCalls:fetch+specialist,budget:{fetch,specialist,reserve:3,reserveLocked:true}});

  const records=signals([done('acres_fetch_url',twoPool(5,1)),done('acres_zoning_envelope',{error:'The research tool budget is exhausted for records and specialist compute calls. 5 fetch and search calls remain. Write the answer from the evidence gathered and name the remaining gaps.',charged:false},false)]);
  assert.equal(records.splitBudget,true);
  assert.equal(records.budgetExhausted,true);
  assert.deepEqual(records.exhaustedCategories,['specialist'],'the two-pool budget charged compute to records, and fetch calls remained');

  const bareTwoPool=signals([done('acres_fetch_url',twoPool(0,1)),done('acres_nyc_public_records',twoPool(0,0)),done('acres_fetch_url',{error:'The research tool budget is exhausted. Summarize the evidence and remaining gaps.'},false)]);
  assert.deepEqual(bareTwoPool.exhaustedCategories,['fetch','specialist'],'a trace without a compute pool never reports one');

  const compute=signals([done('acres_pro_forma',{error:'The research tool budget is exhausted for specialist compute calls. 4 fetch and search and 2 records calls remain.',charged:false},false)]);
  assert.equal(compute.splitBudget,true);
  assert.deepEqual(compute.exhaustedCategories,['compute']);
});

test('dream counts a Socrata resource as a dataset read only with a data extension or a query',()=>{
  const done=url=>({event:'tool.completed',tool:'acres_fetch_url',arguments:{url},success:true,result:{sourceId:1}});
  const signals=extractRunSignals({run:{id:'r',status:'completed',result:{answer:'Done [1].',sources:[]}},events:[
    done('https://data.cityofnewyork.us/resource/64uk-42ks.json'),
    done('https://data.example.gov/resource/abcd-1234?$limit=5'),
    done('https://www.example.gov/resource/news-2024'),
    done('https://www.example.gov/resource/news-2024/annual-report'),
  ]});
  assert.equal(signals.datasetFetchCalls,2);
});
