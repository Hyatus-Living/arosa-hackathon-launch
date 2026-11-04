import test,{after} from 'node:test';
import {installOfflinePublicWeb} from './testing/public-web.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createResearchTools,BUDGET,FREE_REREADS,budgetCategory,COMPUTE_TOOL_NAMES,SIZING_TOOL_NAMES} from './tools.mjs';
import {CAPABILITIES,capability} from './capabilities.mjs';
import {research} from './research.mjs';
import {KnowledgeStore} from './knowledge.mjs';
import {LedgerStore} from './ledger.mjs';
import {createZoningTools} from './zoning.mjs';
import {createEntitlementTools} from './entitlements.mjs';
import {MarketStore} from './market-store.mjs';
import {THREE_OPTIONS_METHOD_URL,dealValuationBrief} from './schemes.mjs';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {createResearchServer} from './service.mjs';
import {validateCitations} from './lanes.mjs';

const htmlFor=n=>'<html><body><main><p>'+`Evidence page ${n}. `.repeat(20)+'</p></main></body></html>';
after(installOfflinePublicWeb());
function stubFetch(){
  const original=global.fetch;
  global.fetch=async(url)=>{
    const n=String(url).match(/page(\d+)/)?.[1]||'0';
    return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(htmlFor(n));})()};
  };
  return ()=>{global.fetch=original;};
}
const newShared=()=>({sources:[],retrievedParcels:new Map(),seenKnowledge:new Set()});

test('fetch, records and the locked synthesis reserve still sum to the old ceiling; compute is capped on its own',()=>{
  assert.equal(BUDGET.fetch+BUDGET.specialist+BUDGET.reserve,24);
  assert.equal(BUDGET.reserve,3);
  assert.equal(BUDGET.compute,12);
});

test('a run never makes more tool calls than the summed budget, across every category and lanes',async()=>{
  const restore=stubFetch();
  try{
    const ceiling=BUDGET.fetch+BUDGET.specialist+BUDGET.compute+BUDGET.reserve;
    assert.equal(ceiling,36);
    const shared=newShared();
    const lead=createResearchTools({},()=>{},null,null,shared);
    const lane=createResearchTools({},()=>{},null,null,shared);
    for(let i=0;i<BUDGET.fetch;i++)await lane.execute('acres_fetch_url',{url:`https://www.nyc.gov/page${i}`});
    for(let i=0;i<BUDGET.specialist;i++)lead.consumeCall('acres_nyc_public_records');
    for(let i=0;i<BUDGET.compute;i++)lane.consumeCall('acres_pro_forma');
    lead.unlockReserve();
    for(let i=0;i<BUDGET.reserve;i++)lead.consumeCall('acres_development_ledger');
    assert.equal(shared.calls,ceiling);
    assert.equal(lead.budget.remainingToolCalls,0);
    for(const name of ['acres_fetch_url','acres_nyc_public_records','acres_pro_forma'])assert.throws(()=>lane.consumeCall(name),/research tool budget is exhausted/);
    assert.equal(shared.calls,ceiling);
  }finally{restore();}
});

test('the compute cap is derived from the registry cost tags, and only option sizing tools are named as sizing calls',()=>{
  const tools=CAPABILITIES.filter(c=>c.kind==='tool');
  for(const entry of tools)
    assert.equal(budgetCategory(entry.name)==='compute',['compute','engine'].includes(entry.cost),`${entry.name} is tagged ${entry.cost} but charged ${budgetCategory(entry.name)}`);
  assert.deepEqual([...COMPUTE_TOOL_NAMES].sort(),tools.filter(c=>['compute','engine'].includes(c.cost)).map(c=>c.name).sort());
  // Only in-process tools may size an option, and the sizing list is the registry's own flag.
  for(const entry of tools.filter(c=>c.sizes))assert.equal(entry.cost,'compute',entry.name);
  assert.deepEqual([...SIZING_TOOL_NAMES].sort(),['acres_compare_programs','acres_entitlement_scenarios','acres_pro_forma','acres_unit_mix','acres_zoning_envelope']);
  // The floor-plan audit is in-process arithmetic but needs plan figures someone supplies: compute cap, never a sizing call.
  assert.equal(budgetCategory('acres_audit_floorplan'),'compute');
  assert.equal(SIZING_TOOL_NAMES.has('acres_audit_floorplan'),false);
  // Massing and test fits draw a design concept: compute cap, never a sizing call.
  for(const name of ['acres_model_concept','acres_plan_concept']){
    assert.equal(capability(name).cost,'engine',name);
    assert.equal(budgetCategory(name),'compute',name);
  }
  // Records, live listings, the local site assembly subprocess and plan saves are records calls, as before.
  for(const name of ['acres_assemble_site','acres_market_comps','acres_search_deal_store','acres_market_inputs','acres_nearby_places','acres_save_plan']){
    assert.ok(!['compute','engine'].includes(capability(name).cost),name);
    assert.equal(budgetCategory(name),'specialist',name);
  }
});

test('a design-heavy run of four massing concepts with a test fit each leaves every records call',()=>{
  const tools=createResearchTools({},()=>{},null,null,newShared());
  for(let i=0;i<4;i++){tools.consumeCall('acres_model_concept');tools.consumeCall('acres_plan_concept');}
  assert.equal(tools.budget.specialist,BUDGET.specialist);
  assert.equal(tools.budget.compute,BUDGET.compute-8);
});

test('every sizing call runs locally in well under a second with the network disabled',async()=>{
  const original=global.fetch;
  global.fetch=async url=>{throw new Error(`sizing tools must not reach the network (${url})`);};
  const timings={};
  const timed=async(name,run)=>{const started=performance.now();const out=await run();timings[name]=performance.now()-started;return out;};
  const retrievedAt='2026-10-12';
  const market={submarket:'Test submarket',
    rents:[0,1,2,3].map(bedrooms=>({bedrooms,rentPerSqftPerMonth:8-bedrooms*0.5,source:'User',retrievedAt})),
    salePrices:[0,1,2,3].map(bedrooms=>({bedrooms,pricePerSqft:1400+bedrooms*100,source:'User',retrievedAt})),
    commercialRents:[{use:'retail',rentPerSqftPerYear:150,source:'User',retrievedAt}]};
  const program={grossBuildingSqft:100000,units:[{bedrooms:0,count:20,netSqft:450},{bedrooms:1,count:40,netSqft:650},{bedrooms:2,count:30,netSqft:950},{bedrooms:3,count:10,netSqft:1250}],commercial:[{use:'retail',netSqft:5000}]};
  const terms={landPrice:20_000_000,hardCostPerSqft:450,softCostPerSqft:100,financing:{loanToCost:0.6,interestRate:0.08,termMonths:30},
    operating:{residentialVacancyRate:0.05,residentialOpexPerUnitPerYear:12000,commercialVacancyRate:0.1,commercialOpexPerSqftPerYear:5},capRate:0.05};
  const out={};
  const gateway=(execute,name,args)=>timed(name,()=>execute('acres_execute_capability',{name,arguments:args}));
  const agent=async({execute,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    out.envelope=await timed('acres_zoning_envelope',()=>execute('acres_zoning_envelope',{streets:[{side:'front',widthFeet:100}]}));
    out.scenarios=await timed('acres_entitlement_scenarios',()=>execute('acres_entitlement_scenarios',{}));
    out.mix=await gateway(execute,'acres_unit_mix',{productType:'rental',residentialGrossSqft:50000,efficiency:0.85});
    await execute('acres_execute_capability',{name:'acres_market_inputs',arguments:market});
    out.proForma=await gateway(execute,'acres_pro_forma',{name:'As-of-right rental',productType:'rental',program,...terms});
    out.comparison=await gateway(execute,'acres_compare_programs',{shared:{program,...terms,sellingCostRate:0.06},variants:[{label:'Rental',productType:'rental'},{label:'Condo',productType:'condo'}]});
    out.keep=await gateway(execute,'acres_keep_building',{purchasePrice:3_000_000,building:{grossSqft:5000,residentialUnits:6},income:{rentPerSqftPerMonth:{value:4,source:'User',retrievedAt}},
      operating:{annualTaxes:40000,taxBasis:'User'},valuation:{capRate:0.05,afterRenovationValuePerSqft:{value:1100,source:'User',retrievedAt}},renovation:{costPerSqft:200,rentPerSqftPerMonth:{value:5,source:'User',retrievedAt}}});
    out.audit=await gateway(execute,'acres_audit_floorplan',{productType:'rental',grossFloorAreaSqft:50000,netRentableOrSellableSqft:36500,corridorCirculationSqft:6500,elevatorStairCoreSqft:4000,capRate:0.05});
    return 'Which property do you mean?';
  };
  try{
    const priorState={property:{bbl:'1000470001',zonedist1:'R9A',lotarea:'10000',lotfront:'100',lotdepth:'100',bldgarea:'5000',yearbuilt:'1960'}};
    await research({message:'How much more can this site build?',priorState},{ENABLE_CURATED_ZONING:true},()=>{},()=>{},()=>{},agent);
  }finally{global.fetch=original;}
  for(const [name,result] of Object.entries(out))assert.equal(typeof result.budget?.compute,'number',`${name} returned no budget: ${JSON.stringify(result).slice(0,300)}`);
  const computeTagged=CAPABILITIES.filter(c=>c.kind==='tool'&&c.cost==='compute').map(c=>c.name);
  assert.deepEqual(Object.keys(timings).sort(),computeTagged.sort(),'every tool tagged compute must be exercised here');
  assert.ok(out.envelope.envelope);
  assert.ok(out.scenarios.scenarios.length>0);
  assert.equal(typeof out.proForma.returns.value,'number');
  assert.equal(out.comparison.variants.length,2);
  assert.ok(out.keep.strategies.every(s=>s.priced&&typeof s.maxPrice==='number'),'keeping the building prices all three ways offline');
  assert.equal(out.audit.budget.compute,BUDGET.compute-computeTagged.length);
  for(const [name,ms] of Object.entries(timings))assert.ok(ms<1000,`${name} took ${Math.round(ms)} ms`);
});

test('when records run out, the refusal names only the sizing calls the agent can run',async()=>{
  const tools=createResearchTools({},()=>{},null,null,newShared());
  tools.offer(CAPABILITIES.filter(c=>c.kind==='tool').map(c=>c.name));
  for(let i=0;i<BUDGET.specialist;i++)tools.consumeCall('acres_nyc_public_records');
  let message='';
  try{tools.consumeCall('acres_development_ledger');}catch(error){message=error.message;}
  assert.match(message,/exhausted for records calls/);
  assert.match(message,new RegExp(`${BUDGET.compute} compute`));
  for(const name of SIZING_TOOL_NAMES)assert.ok(message.includes(name),`${name} missing from: ${message}`);
  for(const name of ['acres_save_plan','acres_plan_concept','acres_model_concept','acres_audit_floorplan'])assert.equal(message.includes(name),false,name);
  assert.match(message,/size the options/);
  // A lane, or a host without curated zoning, offers fewer tools; the refusal names only those.
  const lane=createResearchTools({},()=>{},null,null,newShared());
  lane.offer(['acres_fetch_url','acres_unit_mix','acres_pro_forma','acres_save_plan']);
  for(let i=0;i<BUDGET.specialist;i++)lane.consumeCall('acres_nyc_public_records');
  try{lane.consumeCall('acres_development_ledger');}catch(error){message=error.message;}
  assert.match(message,/acres_unit_mix, acres_pro_forma\./);
  for(const name of ['acres_zoning_envelope','acres_entitlement_scenarios','acres_compare_programs','acres_save_plan'])assert.equal(message.includes(name),false,name);
  // With no sizing call offered, the refusal only says to write the answer.
  const bare=createResearchTools({},()=>{},null,null,newShared());
  bare.offer(['acres_fetch_url']);
  for(let i=0;i<BUDGET.specialist;i++)bare.consumeCall('acres_nyc_public_records');
  try{bare.consumeCall('acres_development_ledger');}catch(error){message=error.message;}
  assert.doesNotMatch(message,/size the options/);
  assert.match(message,/Write the answer/);
  // A tool set that was never offered (the lanes judge offers only evidence tools) names nothing either.
  const unoffered=createResearchTools({},()=>{},null,null,newShared());
  for(let i=0;i<BUDGET.specialist;i++)unoffered.consumeCall('acres_nyc_public_records');
  try{unoffered.consumeCall('acres_development_ledger');}catch(error){message=error.message;}
  for(const name of SIZING_TOOL_NAMES)assert.equal(message.includes(name),false,name);
});

test('a lead run without curated zoning never steers to the zoning tools it was not given',async()=>{
  let message='';
  const agent=async({execute,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    const market={submarket:'Test submarket',rents:[{bedrooms:1,rentPerSqftPerMonth:7,source:'User',retrievedAt:'2026-10-12'}]};
    for(let i=0;i<=BUDGET.specialist;i++){
      try{await execute('acres_execute_capability',{name:'acres_market_inputs',arguments:market});}catch(error){message=error.message;}
    }
    return 'Which property do you mean?';
  };
  await research({message:'What are rents nearby?'},{},()=>{},()=>{},()=>{},agent);
  assert.match(message,/exhausted for records calls/);
  assert.ok(message.includes('acres_unit_mix'),message);
  for(const name of ['acres_zoning_envelope','acres_entitlement_scenarios'])assert.equal(message.includes(name),false,name);
});

test('fetch category caps independently and leaves records and specialist calls available',async()=>{
  const restore=stubFetch();
  try{
    const tools=createResearchTools({},()=>{},null,null,newShared());
    let last;
    for(let i=0;i<BUDGET.fetch;i++)last=await tools.execute('acres_fetch_url',{url:`https://www.nyc.gov/page${i}`});
    assert.equal(last.budget.fetch,0);
    assert.equal(last.budget.specialist,BUDGET.specialist);
    assert.equal(last.remainingToolCalls,BUDGET.specialist+BUDGET.compute);
    await assert.rejects(tools.execute('acres_fetch_url',{url:'https://www.nyc.gov/page99'}),/research tool budget is exhausted for fetch and search/);
    assert.equal(tools.budget.exhausted,true);
    const remaining=tools.consumeCall('acres_nyc_public_records');
    assert.equal(remaining.specialist,BUDGET.specialist-1);
  }finally{restore();}
});

test('the last two fetch calls carry a structured wrap-up steer instead of a refusal',async()=>{
  const restore=stubFetch();
  try{
    const tools=createResearchTools({},()=>{},null,null,newShared());
    tools.offer(CAPABILITIES.filter(c=>c.kind==='tool').map(c=>c.name));
    const results=[];
    for(let i=0;i<BUDGET.fetch;i++)results.push(await tools.execute('acres_fetch_url',{url:`https://www.nyc.gov/page${i}`}));
    assert.equal(results[BUDGET.fetch-3].wrapUp,undefined);
    const steer=results[BUDGET.fetch-2].wrapUp;
    assert.equal(steer.fetchRemaining,1);
    assert.equal(steer.specialistRemaining,BUDGET.specialist);
    assert.equal(steer.computeRemaining,BUDGET.compute);
    assert.match(steer.steer,/size each option/i);
    assert.ok(steer.steer.includes(`(${[...SIZING_TOOL_NAMES].join(', ')})`),steer.steer);
    for(const name of ['acres_audit_floorplan','acres_model_concept','acres_plan_concept','acres_save_plan'])assert.equal(steer.steer.includes(name),false,name);
    assert.equal(results[BUDGET.fetch-1].wrapUp.fetchRemaining,0);
    // An agent offered no sizing tool (the lanes judge) is steered to records and the answer only.
    const judge=createResearchTools({},()=>{},null,null,newShared());
    judge.offer(['acres_fetch_url','acres_search_knowledge']);
    let last;
    for(let i=0;i<BUDGET.fetch-1;i++)last=await judge.execute('acres_fetch_url',{url:`https://www.nyc.gov/judge${i}`});
    assert.doesNotMatch(last.wrapUp.steer,/compute|size each option/);
    assert.match(last.wrapUp.steer,/records calls only where a record would change the decision/);
  }finally{restore();}
});

test('the synthesis reserve is locked until unlocked, then shared run-wide across lanes',async()=>{
  const restore=stubFetch();
  try{
    const shared=newShared();
    const lead=createResearchTools({},()=>{},null,null,shared);
    const lane=createResearchTools({},()=>{},null,null,shared);
    for(let i=0;i<BUDGET.specialist;i++)lead.consumeCall('acres_nyc_public_records');
    for(let i=0;i<BUDGET.fetch;i++)await lane.execute('acres_fetch_url',{url:`https://www.nyc.gov/page${i}`});
    assert.throws(()=>lead.consumeCall('acres_development_ledger'),/research tool budget is exhausted/);
    lead.unlockReserve();
    const out=await lane.execute('acres_fetch_url',{url:'https://www.nyc.gov/page50'});
    assert.equal(out.budget.reserve,BUDGET.reserve-1);
    lead.consumeCall('acres_nyc_public_records');lead.consumeCall('acres_development_ledger');
    assert.throws(()=>lane.consumeCall('acres_development_ledger'),/research tool budget is exhausted/);
    assert.equal(shared.calls,BUDGET.fetch+BUDGET.specialist+BUDGET.reserve);
  }finally{restore();}
});

test('pure-compute specialist tools charge their own cap after the fetch and records budgets are exhausted',async()=>{
  const restore=stubFetch();
  try{
    assert.equal(budgetCategory('acres_zoning_envelope'),'compute');
    assert.equal(budgetCategory('acres_entitlement_scenarios'),'compute');
    assert.equal(budgetCategory('acres_pro_forma'),'compute');
    assert.equal(budgetCategory('acres_nyc_public_records'),'specialist');
    assert.equal(budgetCategory('acres_fetch_url'),'fetch');
    const tools=createResearchTools({},()=>{},null,null,newShared());
    for(let i=0;i<BUDGET.fetch;i++)await tools.execute('acres_fetch_url',{url:`https://www.nyc.gov/page${i}`});
    for(let i=0;i<BUDGET.specialist;i++)tools.consumeCall('acres_nyc_public_records');
    assert.throws(()=>tools.consumeCall('acres_development_ledger'),/exhausted for records/);
    assert.equal(tools.consumeCall('acres_entitlement_scenarios').compute,BUDGET.compute-1);
    assert.equal(tools.consumeCall('acres_pro_forma').compute,BUDGET.compute-2);
    assert.equal(tools.budget.fetch,0);
    assert.equal(tools.budget.specialist,0);
    for(let i=2;i<BUDGET.compute;i++)tools.consumeCall('acres_unit_mix');
    assert.throws(()=>tools.consumeCall('acres_unit_mix'),/^Error: The research tool budget is exhausted\. Summarize/);
  }finally{restore();}
});

test('entitlement scenarios and the pro forma still run through the lead gateway once fetching is exhausted',async()=>{
  const restore=stubFetch();
  const retrievedAt='2026-10-12';
  const market={submarket:'Financial District, Manhattan',
    rents:[0,1,2,3].map(bedrooms=>({bedrooms,rentPerSqftPerMonth:8-bedrooms*0.5,source:'User',retrievedAt})),
    commercialRents:[{use:'retail',rentPerSqftPerYear:150,source:'User',retrievedAt}]};
  const proForma={name:'As-of-right rental',productType:'rental',
    program:{grossBuildingSqft:100000,units:[{bedrooms:0,count:20,netSqft:450},{bedrooms:1,count:40,netSqft:650},{bedrooms:2,count:30,netSqft:950},{bedrooms:3,count:10,netSqft:1250}],commercial:[{use:'retail',netSqft:5000}]},
    landPrice:20_000_000,hardCostPerSqft:450,softCostPerSqft:100,financing:{loanToCost:0.6,interestRate:0.08,termMonths:30},
    operating:{residentialVacancyRate:0.05,residentialOpexPerUnitPerYear:12000,commercialVacancyRate:0.1,commercialOpexPerSqftPerYear:5},capRate:0.05};
  const seen={};
  const agent=async({execute,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    for(let i=0;i<BUDGET.fetch;i++)await execute('acres_fetch_url',{url:`https://www.nyc.gov/page${i}`});
    await assert.rejects(execute('acres_fetch_url',{url:'https://www.nyc.gov/page40'}),/exhausted for fetch and search/);
    seen.scenarios=await execute('acres_execute_capability',{name:'acres_entitlement_scenarios',arguments:{conversion:{nonResidentialSqft:40000}}});
    seen.market=await execute('acres_execute_capability',{name:'acres_market_inputs',arguments:market});
    seen.proForma=await execute('acres_execute_capability',{name:'acres_pro_forma',arguments:proForma});
    return 'Which property do you mean?';
  };
  try{
    const priorState={property:{zonedist1:'R9A',lotarea:'10000',bldgarea:'5000',yearbuilt:'1960'}};
    await research({message:'How much more can this site build?',priorState},{ENABLE_CURATED_ZONING:true},()=>{},()=>{},()=>{},agent);
    assert.ok(seen.scenarios.scenarios.length>0);
    assert.equal(seen.scenarios.budget.fetch,0);
    assert.equal(seen.scenarios.budget.compute,BUDGET.compute-1);
    assert.equal(seen.market.budget.specialist,BUDGET.specialist-1);
    assert.equal(seen.market.budget.compute,BUDGET.compute-1);
    assert.equal(typeof seen.proForma.returns.value,'number');
    assert.equal(seen.proForma.budget.compute,BUDGET.compute-2);
    assert.equal(seen.proForma.budget.specialist,BUDGET.specialist-1);
  }finally{restore();}
});

test('knowledge-cache hits do not consume the fetch budget',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-budget-cache-'));
  const dbPath=join(dir,'knowledge.sqlite');
  const prior=process.env.ACRES_KNOWLEDGE_DB;
  const original=global.fetch;
  try{
    process.env.ACRES_KNOWLEDGE_DB=dbPath;
    const store=new KnowledgeStore(dbPath);
    const src={id:'cached-doc',url:'https://www.nyc.gov/cached-doc',title:'Cached doc',jurisdiction:'US-NY-NYC',topics:['development_capacity'],authority:'statute',kind:'zoning_text'};
    store.register(src);
    const text='Cached operative text. '.repeat(30);
    store.publish(src,Buffer.from(text),text,{...src,publishedAt:'2026-01-01'},[],'none','2026-01-02T00:00:00.000Z');
    store.close();
    global.fetch=async url=>{throw new Error(`network must not be used for a cached page: ${url}`);};
    const tools=createResearchTools({},()=>{},null,null,newShared());
    let out;
    for(let i=0;i<BUDGET.fetch+3;i++)out=await tools.execute('acres_fetch_url',{url:'https://www.nyc.gov/cached-doc'});
    assert.equal(out.method,'knowledge-cache');
    assert.equal(out.budget.fetch,BUDGET.fetch);
    assert.equal(out.cacheHit,true);
  }finally{
    global.fetch=original;
    if(prior===undefined)delete process.env.ACRES_KNOWLEDGE_DB;else process.env.ACRES_KNOWLEDGE_DB=prior;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('re-reading a page already fetched in the run spends the fetch budget once and marks the repeat a cache hit',async()=>{
  const original=global.fetch;
  let networkReads=0;
  global.fetch=async()=>{
    networkReads++;
    const html='<html><body><main><p>'+'Opening text. '.repeat(40)+'</p><p>Section 12-10 Definitions. '+'Defined terms. '.repeat(40)+'</p><p>'+'Floor area means the sum of the gross areas. '.repeat(5)+'</p></main></body></html>';
    return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(html);})()};
  };
  try{
    const tools=createResearchTools({},()=>{},null,null,newShared());
    const url='https://www.nyc.gov/page-repeat-chapter';
    const first=await tools.execute('acres_fetch_url',{url,find:'12-10'});
    const second=await tools.execute('acres_fetch_url',{url,find:'floor area'});
    assert.equal(networkReads,1);
    assert.equal(first.budget.fetch,BUDGET.fetch-1);
    assert.equal(first.cacheHit,undefined);
    assert.equal(second.budget.fetch,BUDGET.fetch-1);
    assert.equal(second.cacheHit,true);
    assert.match(second.text,/Floor area means/);
  }finally{global.fetch=original;}
});

function countingFetch(){
  const original=global.fetch;
  const counter={reads:0,restore(){global.fetch=original;}};
  global.fetch=async url=>{
    counter.reads++;
    const html='<html><body><main><p>'+`Code text for ${url}. `.repeat(4000)+'</p></main></body></html>';
    return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(html);})()};
  };
  return counter;
}

test('a held page cannot be paged for free once the fetch budget is spent',async()=>{
  const net=countingFetch();
  try{
    const tools=createResearchTools({},()=>{},null,null,newShared());
    const url='https://library.example.gov/code/long-chapter';
    await tools.execute('acres_fetch_url',{url});
    for(let i=1;i<BUDGET.fetch;i++)await tools.execute('acres_fetch_url',{url:`https://library.example.gov/code/other-${i}`});
    assert.equal(tools.budget.fetch,0);
    await assert.rejects(tools.execute('acres_fetch_url',{url,offset:24000}),e=>/research tool budget is exhausted/.test(e.message)&&e.charged===false);
    assert.equal(net.reads,BUDGET.fetch);
  }finally{net.restore();}
});

test('a re-read that fails keeps its free slot and reports that it spent nothing',async()=>{
  const net=countingFetch();
  try{
    const tools=createResearchTools({},()=>{},null,null,newShared());
    const url='https://library.example.gov/code/long-chapter';
    await tools.execute('acres_fetch_url',{url});
    for(let i=0;i<=FREE_REREADS;i++){
      await assert.rejects(tools.execute('acres_fetch_url',{url,offset:10_000_000}),e=>/past the end/.test(e.message)&&e.charged===false);
    }
    assert.equal(tools.budget.fetch,BUDGET.fetch-1);
    const reread=await tools.execute('acres_fetch_url',{url,find:'Code text'});
    assert.equal(reread.cacheHit,true);
    assert.equal(reread.budget.fetch,BUDGET.fetch-1);
    await assert.rejects(tools.execute('acres_fetch_url',{url:'https://library.example.gov/code/fresh',offset:10_000_000}),e=>/past the end/.test(e.message)&&e.charged===true);
    assert.equal(tools.budget.fetch,BUDGET.fetch-2);
  }finally{net.restore();}
});

test('fragment variants of a held page are free re-reads of that page',async()=>{
  const net=countingFetch();
  try{
    const tools=createResearchTools({},()=>{},null,null,newShared());
    const base='https://library.example.gov/code/long-chapter';
    const first=await tools.execute('acres_fetch_url',{url:`${base}#part-a`});
    const second=await tools.execute('acres_fetch_url',{url:`${base}#part-b`});
    const bare=await tools.execute('acres_fetch_url',{url:base});
    assert.equal(net.reads,1);
    assert.equal(first.cacheHit,undefined);
    assert.equal(second.cacheHit,true);
    assert.equal(bare.cacheHit,true);
    assert.equal(bare.budget.fetch,BUDGET.fetch-1);
  }finally{net.restore();}
});

test('free re-reads of held pages stop at the per-run cap, then each re-read is charged',async()=>{
  const net=countingFetch();
  try{
    const tools=createResearchTools({},()=>{},null,null,newShared());
    const url='https://library.example.gov/code/long-chapter';
    await tools.execute('acres_fetch_url',{url});
    for(let i=1;i<=FREE_REREADS;i++){
      const page=await tools.execute('acres_fetch_url',{url,offset:i*1000});
      assert.equal(page.cacheHit,true);
      assert.equal(page.budget.fetch,BUDGET.fetch-1);
    }
    const charged=await tools.execute('acres_fetch_url',{url,offset:(FREE_REREADS+1)*1000});
    assert.equal(charged.cacheHit,undefined);
    assert.equal(charged.budget.fetch,BUDGET.fetch-2);
    assert.equal(net.reads,1);
  }finally{net.restore();}
});

test('a section URL served from a cached chapter returns that section alone, cited to the section URL',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-section-cache-'));
  const dbPath=join(dir,'knowledge.sqlite');
  const prior=process.env.ACRES_KNOWLEDGE_DB;
  const original=global.fetch;
  try{
    process.env.ACRES_KNOWLEDGE_DB=dbPath;
    const store=new KnowledgeStore(dbPath);
    const src={id:'zr-chapter',url:'https://zoningresolution.planning.nyc.gov/article-ii/chapter-7',title:'Chapter 7',jurisdiction:'US-NY-NYC',topics:['development_capacity'],authority:'official_agency',kind:'zoning_text'};
    store.register(src);
    const section=(n,title,body)=>`\n ${n}\n\n ${title} \n\n Last Amended12/5/2024\n\n${body}\n`;
    const text=[
      section('27-111','Definitions','A term defined with reference to paragraph (a) of Section 27-131 (Mandatory Inclusionary Housing). '+'Definition text. '.repeat(1500)),
      section('27-13','Applicability',''),
      section('27-131','Mandatory Inclusionary Housing','Operative rule for the requested section.'),
      section('27-132','Plans approved earlier','Text of the following section. '.repeat(800)),
    ].join('');
    store.publish(src,Buffer.from(text),text,{...src},[],'none','2026-01-02T00:00:00.000Z');
    store.close();
    global.fetch=async url=>{throw new Error(`network must not be used for a cached page: ${url}`);};
    const tools=createResearchTools({},()=>{},null,null,newShared());
    const url='https://zr.planning.nyc.gov/article-ii/chapter-7/27-131';
    const out=await tools.execute('acres_fetch_url',{url});
    assert.equal(out.method,'knowledge-cache');
    assert.equal(out.url,url);
    assert.equal(out.title,'ZR 27-131 Mandatory Inclusionary Housing');
    assert.match(out.text,/^27-131\n/);
    assert.match(out.text,/Operative rule for the requested section\./);
    assert.doesNotMatch(out.text,/27-132|Definition text/);
    assert.ok(out.text.length<500,`section text is ${out.text.length} characters`);
    assert.equal(out.truncated,false);
    assert.equal(out.sectionIndex,undefined);
    const hashed=await tools.execute('acres_fetch_url',{url:'https://zr.planning.nyc.gov/article-ii/chapter-7#27-131'});
    assert.equal(hashed.text,out.text);
    const chapter=await tools.execute('acres_fetch_url',{url:'https://zr.planning.nyc.gov/article-ii/chapter-7'});
    assert.equal(chapter.url,src.url);
    assert.equal(chapter.totalCharacters,text.length);
  }finally{
    global.fetch=original;
    if(prior===undefined)delete process.env.ACRES_KNOWLEDGE_DB;else process.env.ACRES_KNOWLEDGE_DB=prior;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('lead drops Composio discovery tools when the account has no Composio session',async()=>{
  const seen=[];
  const agent=async({dynamicTools,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    seen.push(dynamicTools.map(d=>d.name));
    return 'Which property do you mean?';
  };
  await research({message:'Which property?'},{},()=>{},()=>{},()=>{},agent);
  await research({message:'Which property?',composio:{exa:'exa',public:'public'}},{},()=>{},()=>{},()=>{},agent);
  assert.equal(seen[0].includes('acres_discover_tools'),false);
  assert.equal(seen[0].includes('acres_execute_tool'),false);
  assert.equal(seen[0].includes('acres_fetch_url'),true);
  assert.equal(seen[1].includes('acres_discover_tools'),true);
  assert.equal(seen[1].includes('acres_execute_tool'),true);
});

test('specialist results expose per-category budget and a reporting mandate for tabular records',async()=>{
  let mixResult;
  const agent=async({execute,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    mixResult=await execute('acres_execute_capability',{name:'acres_unit_mix',arguments:{productType:'rental',residentialGrossSqft:50000,efficiency:0.85}});
    return 'Which property do you mean?';
  };
  await research({message:'Which property?'},{},()=>{},()=>{},()=>{},agent);
  assert.equal(mixResult.budget.compute,BUDGET.compute-1);
  assert.equal(mixResult.budget.specialist,BUDGET.specialist);
  assert.equal(typeof mixResult.remainingToolCalls,'number');
  assert.match(mixResult.reportingMandate,/report|dismiss/i);
  assert.match(mixResult.reportingMandate,/byBedrooms/);
});

test('research wires the deliverable check, reserve unlock and run outcome fields into the result',async()=>{
  const restore=stubFetch();
  const seen={};
  const agent=async({execute,onControl,checkDeliverables,unlockReserve,onOutcome})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    seen.checkDeliverables=checkDeliverables;
    for(let i=0;i<BUDGET.fetch;i++)await execute('acres_fetch_url',{url:`https://www.nyc.gov/page${i}`});
    await assert.rejects(execute('acres_fetch_url',{url:'https://www.nyc.gov/page40'}),/exhausted/);
    unlockReserve();
    const extra=await execute('acres_fetch_url',{url:'https://www.nyc.gov/page41'});
    onOutcome({effort:'high',repaired:false,repairFailed:false,check:{status:'incomplete',missing:['x']}});
    return `Short answer [${extra.sourceId}].`;
  };
  try{
    const out=await research({message:'What can I build?'},{},()=>{},()=>{},()=>{},agent);
    assert.equal(seen.checkDeliverables,true);
    assert.equal(out.effort,'high');
    assert.equal(out.budgetExhausted,true);
    assert.equal(out.repairFailed,false);
    const off=await research({message:'What can I build?'},{ENABLE_DELIVERABLE_CHECK:false},()=>{},()=>{},()=>{},async({onControl,checkDeliverables})=>{
      onControl({steer:async()=>{},interrupt:async()=>{}});seen.off=checkDeliverables;return 'Which property do you mean?';
    });
    assert.equal(seen.off,false);
    assert.equal(off.budgetExhausted,false);
  }finally{restore();}
});

test('research builds the development ledger so capability search and execution reach it',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'harness-ledger-'));
  const saved=process.env.ACRES_LEDGER_DB;
  process.env.ACRES_LEDGER_DB=join(dir,'ledger.sqlite');
  const seen={};
  const agent=async({execute,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    seen.search=await execute('acres_search_capabilities',{query:'land sales price per zfa on the block'});
    seen.read=await execute('acres_execute_capability',{name:'acres_development_ledger',arguments:{bbl:'1000150001',zip:'10013'}});
    return 'Which property do you mean?';
  };
  try{
    await research({message:'Which property?'},{},()=>{},()=>{},()=>{},agent);
    assert.ok(seen.search.results.some(r=>r.name==='acres_development_ledger'));
    assert.equal(seen.read.bbl,'1000150001');
    assert.equal(seen.read.landSales.retrievedAt,null);
    assert.match(seen.read.proseReportingMandate,/not been synced/);
  }finally{
    if(saved===undefined)delete process.env.ACRES_LEDGER_DB;else process.env.ACRES_LEDGER_DB=saved;
    rmSync(dir,{recursive:true,force:true});
  }
});

const subjectBbl='1000477501';
const subjectRow=(extra={})=>({bbl:subjectBbl,address:'1 EXAMPLE STREET',borough:'MN',block:'47',lot:'7501',zonedist1:'R9A',lotarea:'10000',lotfront:'100',lotdepth:'100',bldgarea:'5000',yearbuilt:'1960',zipcode:'10004',...extra});
function seedFiledCapacity(file,count){
  const store=new LedgerStore(file);
  for(let i=0;i<count;i++)store.upsertDobFiling({bbl:subjectBbl,source:'dob_bis',job_number:String(121000009+i),job_type:i?'A1':'NB',status:'APPROVED',zip:'10004',proposed_zoning_sqft:72000-i,proposed_dwelling_units:80-i,proposed_stories:20,initial_cost:30000000,
    filing_date:'2025-05-01',latest_action_date:`2025-08-${String(1+(i%28)).padStart(2,'0')}`,query_url:'https://data.cityofnewyork.us/resource/ic3t-wcy2.json',fetched_at:'2026-10-16T06:00:00.000Z'});
  for(const dataset of ['dob_bis','dob_now'])store.recordRun({run_id:'r1',dataset,dataset_id:dataset,since:'2026-01-01',until:'2026-10-16',rows_fetched:count,inserted:count,updated:0,unchanged:0,trimmed:0,status:'ok',started_at:'2026-10-16T05:00:00.000Z',finished_at:'2026-10-16T06:00:00.000Z'});
  store.close();
}
// Runs one research turn whose scripted agent finds the parcel and selects it `selections` times.
// `before` runs tool calls between finding and selecting the parcel, as a refining agent would.
async function selectSubject({row=subjectRow(),secrets={ENABLE_CURATED_ZONING:true},ledgerFile,filings=0,selections=1,request={},before=async()=>{}}={}){
  const dir=mkdtempSync(join(tmpdir(),'harness-subject-'));
  const saved=process.env.ACRES_LEDGER_DB,original=global.fetch;
  process.env.ACRES_LEDGER_DB=ledgerFile??join(dir,'ledger.sqlite');
  if(filings)seedFiledCapacity(process.env.ACRES_LEDGER_DB,filings);
  // PLUTO answers with the row; every other NYC Open Data dataset holds no record for the lot.
  global.fetch=async url=>({ok:true,status:200,json:async()=>String(url).includes('64uk-42ks')?[row]:[]});
  const calls=[];
  const agent=async({execute,onControl,getSources})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    calls.push(await execute('acres_find_property',{bbl:subjectBbl}));
    await before(async(name,args)=>{const result=await execute(name,args);calls.push(result);return result;});
    for(let i=0;i<selections;i++)calls.push(await execute('acres_set_subject',{bbl:subjectBbl}));
    return 'Sources: '+[...new Set([...calls.flatMap(call=>Object.values(call.sourceIds??{})),getSources()[0]?.id].filter(id=>id!=null))].map(id=>'['+id+']').join(', ')+'.';
  };
  try{
    const out=await research({message:'What can this site build?',...request},secrets,()=>{},()=>{},()=>{},agent);
    return {out,calls};
  }finally{
    global.fetch=original;
    if(saved===undefined)delete process.env.ACRES_LEDGER_DB;else process.env.ACRES_LEDGER_DB=saved;
    rmSync(dir,{recursive:true,force:true});
  }
}

test('a split lot without apportionment keeps a qualified headline and states its single-district figures as bounds',async()=>{
  const {calls}=await selectSubject({row:subjectRow({zonedist1:'R6A',zonedist2:'C6-4',splitzone:'Y',lotarea:'20000',lotfront:'100',lotdepth:'200',residfar:'3',commfar:'6.5',bldgarea:'0'})});
  const subject=calls[1];
  assert.equal(subject.zoningHeadline.operativeFigure.valueSqft,null);
  assert.match(subject.zoningHeadline.operativeFigure.reason,/split between zoning districts and no per-district apportionment/);
  assert.match(subject.splitLotNote,/whole lot as R6A/);
  assert.deepEqual(subject.envelopeSummary.splitLot,{wholeLotBound:true,modeledDistrict:'R6A',apportioned:false});
  assert.match(subject.briefGuidance,/^Lead with zoningHeadline: no single zoning floor area is computed for this split lot/);
  assert.doesNotMatch(subject.briefGuidance,/Start the answer from these computed figures/);
});

test('selecting the subject returns the envelope, the as-of-right and UAP baseline and the filed capacity without spending fetch budget',async()=>{
  const {out,calls}=await selectSubject({filings:1});
  const subject=calls[1];
  assert.equal(subject.budget.fetch,BUDGET.fetch);
  assert.equal(subject.budget.compute,BUDGET.compute);
  assert.equal(typeof subject.envelopeSummary.modeledGrossFloorAreaSqft,'number');
  assert.equal(subject.baseline.asOfRight.maxFloorAreaSqft,75200);
  assert.equal(subject.baseline.uap.totalFloorAreaSqft,90200);
  assert.equal(subject.filedCapacity.maxEverFiledZoningSqft,72000);
  assert.equal(subject.filedCapacity.maxEverFiledDwellingUnits,80);
  assert.deepEqual(Object.keys(subject.sourceIds).sort(),['baseline','envelope','filedCapacity']);
  for(const id of Object.values(subject.sourceIds))assert.ok(out.sources.some(s=>s.id===id));
  // No PLUTO FAR on this R9A lot: the headline is the envelope maximum, and the approved new building is context.
  assert.equal(subject.zoningHeadline.operativeFigure.valueSqft,75200);
  assert.equal(subject.zoningHeadline.operativeFigure.maximumBasis,'curated_far_x_lot_outline');
  assert.match(subject.zoningHeadline.rows.find(r=>r.jobNumber==='121000009').reason,/^Context, not the headline: the ledger records no zoning lot span/);
  assert.deepEqual(subject.zoningHeadline.rows.find(r=>r.bandsSqft).bandsSqft,{'100':5000,'95':4750,'90':4500,'85':4250});
  assert.match(subject.briefGuidance,/the operative zoning floor area, the envelope, the as-of-right and UAP floor area, the filed capacity/);
  // The same result does not also ask for the envelope and entitlement runs the brief replaced.
  assert.doesNotMatch(subject.researchGuidance,/run acres_zoning_envelope/);
  assert.match(subject.researchGuidance,/acres_fanout_search/);
  // Trace statistic: the first tool result carrying a computed max floor area is the selection itself.
  assert.equal(calls.findIndex(c=>JSON.stringify(c).includes('maxFloorAreaSqft')),1);
  // The brief is a starting point, not project state: refining tools still own the saved envelope.
  assert.equal(out.envelope,null);
  assert.equal(out.entitlements,undefined);
});

test('the subject brief keeps a saved project envelope and entitlements instead of replacing them, and cites them',async()=>{
  // A saved street width refinement is still the subject's own as-of-right envelope.
  const priorState=await savedFigures({streets:[{side:'front',widthFeet:100}]});
  const {out,calls}=await selectSubject({request:{propertyBbl:subjectBbl,priorState}});
  const subject=calls[1];
  assert.equal(subject.envelopeFrom,'saved project');
  assert.equal(subject.envelopeSummary.streetAssumption,'front: wide');
  assert.equal(subject.envelopeSummary.modeledGrossFloorAreaSqft,priorState.envelope.summary.modeledGrossFloorAreaSqft);
  assert.equal(subject.baselineFrom,'saved project');
  assert.deepEqual(subject.baseline.asOfRight,priorState.entitlements.baseline);
  // Saved figures are recorded in this run, so the instruction to cite them can be followed.
  for(const part of ['envelope','baseline'])assert.ok(out.sources.find(s=>s.id===subject.sourceIds[part])?.text.includes(String(part==='envelope'?priorState.envelope.summary.modeledGrossFloorAreaSqft:75200)));
  // The run reports no new envelope or entitlements, so the saved project fields are not rewritten.
  assert.equal(out.envelope,null);
  assert.equal(out.entitlements,undefined);
});

test('a saved hypothetical for another district never briefs the subject',async()=>{
  // A district-only envelope (no parcel capacity) and entitlements sized for another district or lot.
  const hypothetical={summary:{district:'R10',modeledGrossFloorAreaSqft:95000}};
  for(const priorState of [
    {property:subjectRow(),envelope:hypothetical,entitlements:{district:'R10',lotAreaSqft:10000,baseline:{maxFloorAreaSqft:100000},scenarios:[]}},
    {property:subjectRow(),envelope:{...hypothetical,capacity:{lotAreaSqft:10000}},entitlements:{district:'R9A',lotAreaSqft:20000,baseline:{maxFloorAreaSqft:150400},scenarios:[]}},
  ]){
    const subject=(await selectSubject({request:{propertyBbl:subjectBbl,priorState}})).calls[1];
    assert.equal(subject.envelopeFrom,undefined);
    assert.equal(subject.envelopeSummary.district,'R9A');
    assert.equal(subject.baselineFrom,undefined);
    assert.equal(subject.baseline.asOfRight.maxFloorAreaSqft,75200);
  }
});

// Project figures as a run saves them: the captured envelope and entitlements for the subject parcel.
async function savedFigures(envelopeArgs={},entitlementArgs={},property=subjectRow()){
  const zoning=createZoningTools({getProperty:()=>property});
  await zoning.handlers.acres_zoning_envelope(envelopeArgs);
  const sizing=createEntitlementTools({getProperty:()=>property,enabled:true});
  await sizing.handlers.acres_entitlement_scenarios(entitlementArgs);
  return JSON.parse(JSON.stringify({property,envelope:zoning.envelope,entitlements:sizing.entitlements}));
}

test('a saved or same run scheme with other inputs than the subject never briefs it',async()=>{
  const fresh=(await selectSubject()).calls[1];
  const asSaved=(await selectSubject({request:{propertyBbl:subjectBbl,priorState:await savedFigures()}})).calls[1];
  assert.equal(asSaved.envelopeFrom,'saved project');
  assert.equal(asSaved.baselineFrom,'saved project');
  // A FAR override, an assemblage lot, the affordable bonus, partial affordable floor area or another built area.
  const schemes=[
    [{maxFar:12},{affordableFloorAreaSqft:5000}],
    [{lot:[[0,0],[200,0],[200,100],[0,100]]},{lotAreaSqft:20000}],
    [{affordable:true},{existingFloorAreaSqft:30000}],
  ];
  for(const [envelopeArgs,entitlementArgs] of schemes){
    const saved=(await selectSubject({request:{propertyBbl:subjectBbl,priorState:await savedFigures(envelopeArgs,entitlementArgs)}})).calls[1];
    const sameRun=(await selectSubject({request:{propertyBbl:subjectBbl,priorState:{property:subjectRow()}},before:async execute=>{
      await execute('acres_zoning_envelope',envelopeArgs);
      await execute('acres_entitlement_scenarios',entitlementArgs);
    }})).calls.at(-1);
    for(const subject of [saved,sameRun]){
      assert.equal(subject.envelopeFrom,undefined,JSON.stringify(envelopeArgs));
      assert.deepEqual(subject.envelopeSummary,fresh.envelopeSummary);
      assert.equal(subject.baselineFrom,undefined,JSON.stringify(entitlementArgs));
      assert.deepEqual(subject.baseline,fresh.baseline);
    }
  }
});

test('a saved or same run scheme with another use, form or lot shape never briefs the subject',async()=>{
  // Equal lot area but another outline, the residential equivalent in a commercial district, the
  // eligible site form, and a residential scheme under the Lower Manhattan cap.
  const cases=[
    [subjectRow(),{lot:[[0,0],[50,0],[50,200],[0,200]]}],
    [subjectRow({zonedist1:'C6-2'}),{use:'residential'}],
    [subjectRow({zonedist1:'R6'}),{form:'eligible'}],
    [subjectRow({zonedist1:'C5-5',spdist1:'LM'}),{use:'residential'}],
  ];
  for(const [row,envelopeArgs] of cases){
    const fresh=(await selectSubject({row})).calls[1];
    assert.equal(typeof fresh.envelopeSummary.modeledGrossFloorAreaSqft,'number');
    // The parcel's own default, saved or computed earlier, still briefs as itself.
    const asSaved=(await selectSubject({row,request:{propertyBbl:subjectBbl,priorState:await savedFigures({},{},row)}})).calls[1];
    assert.equal(asSaved.envelopeFrom,'saved project',row.zonedist1);
    const saved=(await selectSubject({row,request:{propertyBbl:subjectBbl,priorState:await savedFigures(envelopeArgs,{},row)}})).calls[1];
    const sameRun=(await selectSubject({row,request:{propertyBbl:subjectBbl,priorState:{property:row}},before:async execute=>{await execute('acres_zoning_envelope',envelopeArgs);}})).calls.at(-1);
    for(const subject of [saved,sameRun]){
      assert.equal(subject.envelopeFrom,undefined,`${row.zonedist1} ${JSON.stringify(envelopeArgs)}`);
      assert.deepEqual(subject.envelopeSummary,fresh.envelopeSummary);
    }
  }
});

test('a saved envelope without its lot is recomputed instead of failing the selection',async()=>{
  const priorState=await savedFigures();
  delete priorState.envelope.lot;
  const fresh=(await selectSubject()).calls[1];
  const subject=(await selectSubject({request:{propertyBbl:subjectBbl,priorState}})).calls[1];
  assert.equal(subject.envelopeFrom,undefined);
  assert.deepEqual(subject.envelopeSummary,fresh.envelopeSummary);
});

test('without a PLUTO lot area the brief keeps the lot area sized earlier and says it is unconfirmed',async()=>{
  const row=subjectRow({lotarea:'0'});
  const sameRun=(await selectSubject({row,request:{propertyBbl:subjectBbl,priorState:{property:row}},before:async execute=>{await execute('acres_entitlement_scenarios',{lotAreaSqft:10000});}})).calls.at(-1);
  const saved=(await selectSubject({row,request:{propertyBbl:subjectBbl,priorState:await savedFigures({},{lotAreaSqft:10000},row)}})).calls[1];
  for(const subject of [sameRun,saved]){
    assert.ok(subject.baselineFrom);
    assert.equal(subject.baseline.asOfRight.maxFloorAreaSqft,75200);
    assert.match(subject.baselineNote,/PLUTO has no lot area for this parcel, so these figures use the 10000 sq ft lot area sized earlier/);
  }
  // Sizing that also changed the built area is a scheme even then.
  const scheme=(await selectSubject({row,request:{propertyBbl:subjectBbl,priorState:await savedFigures({},{lotAreaSqft:10000,existingFloorAreaSqft:30000},row)}})).calls[1];
  assert.equal(scheme.baseline,undefined);
  const none=(await selectSubject({row})).calls[1];
  assert.equal(none.baseline,undefined);
  assert.match(none.baselineNote,/PLUTO has no lot area for this parcel, so the as-of-right baseline cannot be confirmed/);
});

test('a standing building without a PLUTO building area briefs an unknown baseline, matching the capacity',async()=>{
  const subject=(await selectSubject({row:subjectRow({bldgarea:'0',numbldgs:'2'})})).calls[1];
  assert.equal(subject.baseline.asOfRight.maxFloorAreaSqft,75200);
  assert.equal(subject.baseline.asOfRight.existingFloorAreaSqft,null);
  assert.equal(subject.baseline.asOfRight.remainingFloorAreaSqft,null);
});

test('a disapproved 90,000 sq ft filing never tops the brief: the gated operative figure leads and raw maxima read as max ever filed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'harness-disapproved-'));
  try{
    const ledgerFile=join(dir,'ledger.sqlite'),store=new LedgerStore(ledgerFile);
    const filing=(job,job_type,status,zfa,filed)=>store.upsertDobFiling({bbl:subjectBbl,source:'dob_bis',job_number:job,job_type,status,zip:'10004',proposed_zoning_sqft:zfa,proposed_dwelling_units:job_type==='NB'?90:null,proposed_stories:12,initial_cost:null,
      filing_date:filed,latest_action_date:filed,query_url:'https://data.cityofnewyork.us/resource/ic3t-wcy2.json',fetched_at:'2026-10-16T06:00:00.000Z'});
    filing('121000101','NB','PLAN EXAM - DISAPPROVED',90000,'2025-03-01');
    filing('121000102','A1','PERMIT ISSUED - ENTIRE JOB/WORK',3000,'2025-06-01');
    filing('121000103','NB','WITHDRAWN',200000,'2025-09-01');
    for(const dataset of ['dob_bis','dob_now'])store.recordRun({run_id:'r1',dataset,dataset_id:dataset,since:'2026-01-01',until:'2026-10-16',rows_fetched:3,inserted:3,updated:0,unchanged:0,trimmed:0,status:'ok',started_at:'2026-10-16T05:00:00.000Z',finished_at:'2026-10-16T06:00:00.000Z'});
    store.close();
    const subject=(await selectSubject({ledgerFile,row:subjectRow({bldgarea:'20000'})})).calls[1];
    const head=subject.zoningHeadline;
    assert.equal(head.operativeFigure.valueSqft,75200);
    assert.notEqual(head.operativeFigure.valueSqft,90000);
    assert.equal(head.rows.find(r=>r.label==='DOB filed proposed ZFA (governing NB/A1)').operative,false);
    assert.equal(subject.filedCapacity.maxProposedZoningSqft,undefined);
    assert.equal(subject.filedCapacity.maxEverFiledZoningSqft,90000);
    assert.match(subject.filedCapacity.basis,/whatever the approval; they are never the lot's capacity/);
    const keys=Object.keys(subject);
    assert.ok(keys.indexOf('zoningHeadline')<keys.indexOf('filedCapacity'),'the operative figure comes before the filed maxima');
    assert.match(subject.briefGuidance,/^Start the answer from these computed figures and cite them with their sourceIds: the operative zoning floor area/);
    assert.match(subject.briefGuidance,/maxEverFiled figures are context, never the lot's capacity/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a synced ledger with no filing for the parcel claims no filed capacity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'harness-nofilings-'));
  try{
    const ledgerFile=join(dir,'ledger.sqlite');
    seedFiledCapacity(ledgerFile,0);
    const subject=(await selectSubject({ledgerFile})).calls[1];
    assert.equal(subject.filedCapacity,undefined);
    assert.match(subject.filedCapacityNote,/no DOB filing/);
    assert.deepEqual(Object.keys(subject.sourceIds).sort(),['baseline','envelope']);
    assert.doesNotMatch(subject.briefGuidance,/filed capacity/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('figures refined earlier in the run are the starting point instead of a fresh default',async()=>{
  const priorState={property:subjectRow({zonedist1:'R6'}),envelope:{summary:{district:'R6',modeledGrossFloorAreaSqft:1},capacity:{}},entitlements:{district:'R6',lotAreaSqft:10000,baseline:{maxFloorAreaSqft:1},scenarios:[]}};
  const {out,calls}=await selectSubject({row:subjectRow({zonedist1:'R6'}),request:{propertyBbl:subjectBbl,priorState},before:async execute=>{
    await execute('acres_zoning_envelope',{streets:[{side:'front',widthFeet:100}]});
    await execute('acres_entitlement_scenarios',{});
  }});
  const [,refined,sized,subject]=calls;
  assert.equal(refined.envelopeSummary.streetAssumption,'front: wide');
  // The brief points at this run's envelope rather than repeating it or computing a narrow-street default.
  assert.equal(subject.envelopeSummary,undefined);
  assert.match(subject.envelopeFrom,/earlier acres_zoning_envelope result in this run/);
  assert.equal(subject.sourceIds.envelope,refined.sourceId);
  assert.match(subject.baselineFrom,/earlier acres_entitlement_scenarios result in this run/);
  assert.deepEqual(subject.baseline.asOfRight,sized.baseline);
  assert.equal(subject.sourceIds.baseline,sized.sourceId);
  assert.match(subject.briefGuidance,/computed earlier in this run/);
  // The refined envelope stays the one saved to the project.
  assert.equal(out.envelope.summary.streetAssumption,'front: wide');
});

test('an uncurated district is briefed with the PLUTO capacity it can cite',async()=>{
  const {out,calls}=await selectSubject({row:subjectRow({zonedist1:'C4-6',residfar:'3.4',commfar:'3.4',facilfar:'6.5'})});
  const subject=calls[1];
  assert.equal(subject.envelopeSummary,undefined);
  assert.equal(subject.capacity.byUse.communityFacility.maxFloorAreaSqft,65000);
  // The 85 to 100 percent existing ZFA band stays inline; only the prose note is left to the source.
  assert.equal(subject.capacity.zfaVsGfaGuidance.sensitivityBand.assumedZfaAt85PercentGfaSqft,4250);
  assert.equal(subject.capacity.zfaVsGfaGuidance.sensitivityBand.residualByUseAt85PercentZfa.residential,29750);
  assert.equal(subject.capacity.zfaVsGfaGuidance.note,undefined);
  // The community facility FAR is a conditional row; the residential or commercial maximum headlines.
  assert.equal(subject.zoningHeadline.operativeFigure.valueSqft,34000);
  assert.equal(subject.zoningHeadline.rows.find(r=>r.conditional).valueSqft,65000);
  assert.ok(subject.envelopeNote.length<200);
  assert.ok(out.sources.some(s=>s.id===subject.sourceIds.envelope));
  assert.match(subject.briefGuidance,/PLUTO floor area capacity/);
  assert.equal(calls.findIndex(c=>JSON.stringify(c).includes('maxFloorAreaSqft')),1);
  // Without any PLUTO maximum there is nothing to claim.
  const bare=(await selectSubject({row:subjectRow({zonedist1:'PARK'})})).calls[1];
  assert.equal(bare.capacity,undefined);
  assert.equal(bare.briefGuidance,undefined);
  assert.match(bare.researchGuidance,/run acres_zoning_envelope/);
});

test('a second selection of the same subject in one run does not repeat the brief',async()=>{
  const {calls}=await selectSubject({selections:2,filings:1});
  assert.ok(calls[1].envelopeSummary);
  assert.equal(calls[2].envelopeSummary,undefined);
  assert.equal(calls[2].filedCapacity,undefined);
  assert.match(calls[2].subjectBrief,/earlier acres_set_subject result/);
  assert.equal(calls[2].baseline,undefined);
  assert.ok(JSON.stringify(calls[2]).length<JSON.stringify(calls[1]).length-JSON.stringify(calls[1].envelopeSummary).length);
});

test('filed capacity is inline as maxima, a count and the latest filings, with the full list in the recorded source',async()=>{
  const {out,calls}=await selectSubject({filings:60});
  const filed=calls[1].filedCapacity;
  assert.equal(filed.filingCount,60);
  assert.equal(filed.latestFilings.length,3);
  assert.equal(filed.filings,undefined);
  assert.equal(filed.maxEverFiledZoningSqft,72000);
  const source=out.sources.find(s=>s.id===calls[1].sourceIds.filedCapacity);
  assert.ok(source);
  // The note that the subject's public records are being read adds a fixed sentence; the digest itself rides on a later result.
  assert.ok(JSON.stringify(calls[1]).length<12300);
});

test('an unsynced or unreadable ledger leaves the selection working with a reason instead of filed capacity',async()=>{
  const unsynced=(await selectSubject()).calls[1];
  assert.equal(unsynced.filedCapacity,undefined);
  assert.match(unsynced.ledgerUnsynced,/not been synced/);
  assert.deepEqual(Object.keys(unsynced.sourceIds).sort(),['baseline','envelope']);
  const unreadable=(await selectSubject({ledgerFile:'/dev/null/nope/ledger.sqlite'})).calls[1];
  assert.equal(unreadable.property.bbl,subjectBbl);
  assert.ok(unreadable.envelopeSummary);
  assert.match(unreadable.filedCapacityNote,/could not be read.*never report it as zero/);
});

test('the subject brief claims only the figures it computed',async()=>{
  const off=(await selectSubject({secrets:{}})).calls[1];
  assert.deepEqual(off.sourceIds,{});
  assert.equal(off.envelopeSummary,undefined);
  assert.equal(off.baseline,undefined);
  assert.equal(off.briefGuidance,undefined);
  assert.match(off.researchGuidance,/run acres_zoning_envelope/);
  const uncurated=(await selectSubject({row:subjectRow({zonedist1:'M1-1'})})).calls[1];
  assert.equal(uncurated.baseline,undefined);
  assert.match(uncurated.baselineNote,/M1-1 has no curated floor area ratio/);
  assert.doesNotMatch(uncurated.briefGuidance??'',/as-of-right/);
  const noDistrict=(await selectSubject({row:subjectRow({zonedist1:''})})).calls[1];
  assert.match(noDistrict.baselineNote,/no zoning district/);
});

// A deal store holding one for-sale listing on the subject lot and five development-site sales near it.
function seedDealStore(dir){
  const ledgerFile=join(dir,'ledger.sqlite'),ledger=new LedgerStore(ledgerFile);
  const day=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10),now=new Date().toISOString();
  // Six Manhattan sales a tenth of a mile apart north of the Manhattan subject.
  for(let i=0;i<6;i++){
    const bbl=`10000000${String(i).padStart(2,'0')}`,latitude=40.704+(i+1)*0.00145,longitude=-74.012;
    ledger.upsertDevelopmentSiteSale({doc_id:`S${i}`,bbl,recorded_at:day(30),price:[150,250,200,300,100,200][i]*5000,filing_job:`J${i}`,filing_type:'New Building',filed_at:day(20),zip:'10004',latitude,longitude,query_url:'https://data.cityofnewyork.us',fetched_at:now,
      pluto_json:JSON.stringify({bbl,lotarea:'2500',lotfront:'25',lotdepth:'100',lottype:'5',residfar:'2',affresfar:'0',zonedist1:'R6B',borough:'MN',zipcode:'10004',latitude,longitude})});
  }
  ledger.close();
  const marketFile=join(dir,'market.sqlite'),market=new MarketStore(marketFile);
  const row={propertyId:'subject',listingType:'for_sale',address:'1 Example Street',city:'New York',state:'NY',zipCode:'10004',latitude:40.704,longitude:-74.012,assetClass:'multifamily_small',isDevelopmentCandidate:true,listPrice:3_000_000,pricePerSqft:600,listDate:day(10),sqft:5000,lotSqft:10000,url:'https://www.example.com/listing/subject'};
  market.ingestListings([row],10);
  market.write(`UPDATE market_listings SET bbl=?,zoning_district='R7A',pluto_lot_area=10000,pluto_bldg_area=5000,resid_far=4,max_uap_zfa=50100,max_standard_zfa=40000,unused_uap_zfa=45100,comm_far=0 WHERE id=?`,subjectBbl,MarketStore.listingKey(row));
  market.close();
  return {ledgerFile,marketFile};
}

test('a collaborator\'s run briefs the options the site page shows, at the owner\'s costs and saved land price, cited and uncharged',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'harness-deal-')),owner='a'.repeat(24),collaborator='b'.repeat(24),original=global.fetch;
  const env=Object.fromEntries(['ACRES_MARKET_DB','ACRES_LEDGER_DB','ACRES_DEAL_STORE_ENABLED'].map(key=>[key,process.env[key]]));
  const {ledgerFile,marketFile}=seedDealStore(dir);
  Object.assign(process.env,{ACRES_MARKET_DB:marketFile,ACRES_LEDGER_DB:ledgerFile,ACRES_DEAL_STORE_ENABLED:'true'});
  global.fetch=async()=>({ok:true,status:200,json:async()=>[subjectRow()]});
  const chat=new ChatStore(join(dir,'chat.sqlite'));
  let server=null;
  t.after(async()=>{
    global.fetch=original;
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    chat.close();
    for(const [key,value] of Object.entries(env))if(value===undefined)delete process.env[key];else process.env[key]=value;
    rmSync(dir,{recursive:true,force:true});
  });
  // The collaborator saved much higher hard costs than the owner, whose costs the site page uses.
  const market=new MarketStore(marketFile);
  market.updateUserDealSettings(collaborator,{rentalHardCostPerGrossSqft:650,condoHardCostPerGrossSqft:650});
  market.close();
  const conversation=chat.createConversation(owner),projectId=conversation.projectId;
  chat.grantMember(owner,conversation.id,'account',collaborator,'participant','collaborator@example.com');
  chat.project.write(projectId,{property:{value:{bbl:subjectBbl,address:'1 EXAMPLE STREET',borough:'MN',zipcode:'10004'},provenance:{tool:'acres_set_subject',sources:[]}}});
  chat.updateProjectState(owner,projectId,{version:chat.projectView(owner,projectId).version,fields:{assumptions:{landPrice:1_000_000}}});

  let brief,out;
  const manager=new RunManager(chat,{ENABLE_CURATED_ZONING:true},async(input,secrets,progress,emit,onControl)=>{
    out=await research(input,secrets,progress,emit,onControl,async({execute})=>{
      await execute('acres_find_property',{bbl:subjectBbl});
      brief=await execute('acres_set_subject',{bbl:subjectBbl});
      return 'Site options: ['+brief.sourceIds.dealValuation+'].';
    });
    return out;
  });
  const id=crypto.randomUUID(),finished=new Promise(resolve=>manager.on(id,event=>{if(/^run\.(completed|failed)$/.test(event.event))resolve();}));
  manager.enqueue(collaborator,conversation.id,'Which option should we build?',id);await finished;await manager.drain();
  global.fetch=original;
  assert.equal(chat.run(collaborator,id).status,'completed');

  server=createResearchServer({secrets:{RESEARCH_TOKEN:'fixture'},store:chat,maps:null,marketStoreFactory:()=>new MarketStore(marketFile)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const page=await (await fetch(`http://127.0.0.1:${server.address().port}/projects/${projectId}/schemes`,{headers:{authorization:'Bearer fixture','x-acres-account':collaborator,'x-acres-email':'collaborator@example.com'}})).json();
  const deal=brief.dealValuation,option=s=>[s.id,s.best,s.program?.exit??null,s.program?.zfa??null,s.program?.units??null,s.returns?.landValue??null];
  assert.deepEqual(deal.options.map(o=>[o.id,o.best,o.exit,o.zfa,o.units,o.landValue]),page.schemes.map(option));
  assert.deepEqual([deal.ask,deal.askFrom],[page.basis.ask,page.basis.askFrom]);
  assert.deepEqual([deal.ask,deal.askFrom],[1_000_000,'assumptions']);
  assert.deepEqual(deal.nearbyLand,{value:page.basis.nearbyLand.value,perBuildableSqft:page.basis.nearbyLand.perBuildableSqft,sales:6,radiusMiles:page.basis.nearbyLand.radiusMiles,months:page.basis.nearbyLand.months,asOf:page.basis.nearbyLand.asOf});
  assert.deepEqual([deal.tier.dealVerdict,deal.tier.priceVerdict,deal.tier.basis],[page.basis.dealVerdict,page.basis.priceVerdict,page.basis.dealTierBasis.basis]);
  assert.ok(deal.options.some(o=>o.best&&o.landValue>0));
  // The collaborator's own costs would have valued the land differently, so the match is the owner's.
  const reader=new MarketStore(marketFile,{readOnly:true});
  const own=reader.lotValuation({bbl:subjectBbl,property:subjectRow(),account:collaborator,landPrice:1_000_000});
  reader.close();
  assert.notDeepEqual(own.valuation.candidates.map(c=>c.returns.landValue).sort(),page.schemes.map(s=>s.returns?.landValue).filter(v=>v!=null).sort());

  // Cited at the page that explains the options; the brief reads the local store and spends no budget.
  const source=out.sources.find(s=>s.id===brief.sourceIds.dealValuation);
  assert.deepEqual([source.kind,source.url],['deal_store',THREE_OPTIONS_METHOD_URL]);
  const lead=deal.options.find(o=>o.best);
  assert.doesNotThrow(()=>validateCitations(`The leading option is ${lead.summary}, paying ${lead.landValue} for the land [${source.id}].`,out.sources));
  assert.equal(brief.budget.fetch,BUDGET.fetch);
  assert.equal(brief.budget.compute,BUDGET.compute);
  // The options lead only answers about value or what to build, never every answer on the subject.
  assert.doesNotMatch(brief.briefGuidance.match(/Start the answer from these computed figures[^:]*:([^.]*)/)?.[1]??'',/deal/);
  assert.match(brief.briefGuidance,/When the question turns on value, price or what to build, dealValuation holds the site page's options/);

  // Without deal store access the brief carries no valuation.
  delete process.env.ACRES_DEAL_STORE_ENABLED;
  const closed=(await selectSubject({ledgerFile})).calls[1];
  assert.equal(closed.dealValuation,undefined);
  assert.equal(closed.sourceIds.dealValuation,undefined);
});

test('an option that is not the kind its label names keeps the note that says why in the brief',()=>{
  const candidate=(id,landValue,extra={})=>({id,key:'standard',exit:'rental',zfa:40000,storeys:8,units:40,taxProgram:null,affordableZfa:0,leads:false,returns:{landValue},...extra});
  // Two rentals on standard floor area and no bonus building: the alternative falls back to the second rental.
  const lot={source:'parcel',ask:null,askFrom:null,nearbyLand:null,valuation:{candidates:[candidate('c1',2_000_000,{leads:true}),candidate('c2',1_000_000,{zfa:30000})]}};
  const [asOfRight,maxBonus,alternative]=dealValuationBrief(lot).options;
  assert.equal(asOfRight.note,undefined);
  assert.match(alternative.note,/No other kind of building fits this lot, so this is the As of right building priced another way/);
  assert.equal(maxBonus.landValue,null);
  assert.equal(maxBonus.note,undefined,'an empty option says why once, in its summary');
  assert.match(maxBonus.summary,/No affordability bonus/);
});

 test('a find miss refunds its fetch slot and returns the section index without another network read',async()=>{
 const original=global.fetch; let reads=0;
 global.fetch=async()=>{reads++;return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from('<main><h2>23-10 General Provisions</h2><p>'+'Evidence text. '.repeat(80)+'</p></main>');})()};};
 try{const tools=createResearchTools({},()=>{},null,null,newShared());
 const miss=await tools.execute('acres_fetch_url',{url:'https://www.nyc.gov/find-miss',find:'absent phrase'});
 assert.equal(miss.findMatched,false);assert.equal(miss.fetchBudgetRefunded,true);assert.equal(miss.budget.fetch,BUDGET.fetch);assert.ok(miss.sectionIndex.some(s=>JSON.stringify(s).includes('23-10')));
 const found=await tools.execute('acres_fetch_url',{url:'https://www.nyc.gov/find-miss',find:'23-10'});assert.equal(found.findMatched,true);assert.equal(reads,1);
 }finally{global.fetch=original;}
 });
