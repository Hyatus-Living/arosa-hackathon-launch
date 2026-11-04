import test,{after} from 'node:test';
import {installOfflinePublicWeb} from './testing/public-web.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {research,aggregate} from './research.mjs';
import {LANES,validateCitations,withoutUnsupportedCitations,parallelEnabled,judgePacket} from './lanes.mjs';
import {CORE_PRINCIPLES,baseInstructions,laneInstructions,judgeInstructions} from './instructions.mjs';
import {createResearchTools,BUDGET,FREE_REREADS} from './tools.mjs';
import {createMarketTools} from './market.mjs';
import {createParcelOperations,addressIdentity} from './parcels.mjs';

const htmlFor=n=>'<html><body><main><p>'+`Evidence page ${n}. `.repeat(20)+'</p></main></body></html>';
after(installOfflinePublicWeb());
function stubFetch(){
  const original=global.fetch;
  global.fetch=async(url)=>{
    const n=String(url).match(/page(\d)/)?.[1]||'0';
    return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(htmlFor(n));})()};
  };
  return ()=>{global.fetch=original;};
}

test('legacy lanes mode: parallel lanes share one citation pool and the judge writes the final answer',async()=>{
  const restore=stubFetch();const calls=[],events=[];
  const agent=async({label,execute,onControl,dynamicTools,getSources})=>{
    calls.push(label);onControl({steer:async()=>{},interrupt:async()=>{}});
    if(label.startsWith('lane_')){
      assert.ok(dynamicTools.some(d=>d.name==='acres_fanout_search'),label);
      const n=label==='lane_zoning'?1:label==='lane_cases'?2:3;
      const fetched=await execute('acres_fetch_url',{url:`https://www.nyc.gov/page${n}`});
      return `FINDINGS lane evidence [${fetched.sourceId}]\nGAPS none`;
    }
    assert.equal(label,'judge');
    assert.deepEqual(getSources().map(s=>s.id),[1,2,3], 'the judge can use the entire shared pool');
    return 'Verified final answer [1].';
  };
  try{
    const out=await research({message:'What can I build?'},{RESEARCH_MODE:'lanes'},()=>{},(e,d)=>events.push({e,d}),()=>{},agent);
    assert.deepEqual(calls.slice(0,3).sort(),['lane_cases','lane_comps','lane_zoning']);
    assert.equal(calls[3],'judge');
    assert.equal(out.sources.length,1);
    assert.deepEqual(out.sources.map(s=>s.id),[1]);
    assert.match(out.answer,/Verified final/);
    assert.deepEqual(out.lanes.map(l=>l.status),['completed','completed','completed']);
    assert.ok(events.some(x=>x.e==='judge.completed'));
  }finally{restore();}
});

test('one failed lane degrades to a partial judge answer instead of failing the run',async()=>{
  const restore=stubFetch();
  const agent=async({label,execute,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    if(label==='lane_cases')throw new Error('lane timeout');
    if(label.startsWith('lane_')){
      const fetched=await execute('acres_fetch_url',{url:'https://www.nyc.gov/page1'});
      return `evidence [${fetched.sourceId}]`;
    }
    return 'Partial but verified [1]. Case coverage is missing.';
  };
  try{
    const out=await research({message:'Q?'},{RESEARCH_MODE:'lanes'},()=>{},()=>{},()=>{},agent);
    assert.equal(out.lanes.find(l=>l.id==='cases').status,'failed');
    assert.match(out.answer,/Partial/);
  }finally{restore();}
});

test('judge citations are validated against the shared pool and lanes cannot call tools outside their charter',async()=>{
  const restore=stubFetch();
  const agent=async({label,execute,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    if(label==='lane_cases'){
      await assert.rejects(execute('acres_model_concept',{name:'x',levels:[]}),/unavailable in this lane/);
      const fetched=await execute('acres_fetch_url',{url:'https://www.nyc.gov/page2'});
      return `evidence [${fetched.sourceId}]`;
    }
    if(label.startsWith('lane_')){
      const fetched=await execute('acres_fetch_url',{url:'https://www.nyc.gov/page1'});
      return `evidence [${fetched.sourceId}]`;
    }
    return 'Fabricated [99].';
  };
  try{
    await assert.rejects(research({message:'Q?'},{RESEARCH_MODE:'lanes'},()=>{},()=>{},()=>{},agent),/invalid source reference/);
  }finally{restore();}
  assert.throws(()=>validateCitations('x [2]',[{id:1}]),/invalid source/);
  assert.equal(parallelEnabled({}),false);
  assert.match(judgePacket({question:'q',lanes:[{id:'zoning',status:'completed',text:'t'}],sources:[]}),/EVIDENCE/);
  assert.equal(LANES.length,3);
});

test('every tier shares the same core principles and none is tuned to a single case',()=>{
  const surfaces=[baseInstructions(),...LANES.map(laneInstructions),judgeInstructions()];
  for(const text of surfaces){
    assert.ok(text.includes(CORE_PRINCIPLES),'each instruction surface embeds the shared core principles verbatim');
    assert.doesNotMatch(text,/120 Broadway|Equitable|54-52/i,'instructions must not encode one property, case or test answer');
  }
  assert.match(CORE_PRINCIPLES,/could change the conclusion/);
  assert.match(CORE_PRINCIPLES,/weakest load-bearing assumption/);
  assert.match(CORE_PRINCIPLES,/Reconcile competing measurements/);
  assert.match(laneInstructions(LANES[0]),/DECISION-CHANGERS/);
  assert.match(judgeInstructions(),/Challenge completeness/);
  assert.ok(LANES.find(l=>l.id==='comps').tools.includes('acres_plan_concept'),'the comps lane can reach the planning tool');
});

test('lead mode is the default: one agent call, same citation rules, no forced lanes',async()=>{
  const restore=stubFetch();let calls=0;
  const agent=async({execute,onControl})=>{
    calls++;onControl({steer:async()=>{},interrupt:async()=>{}});
    const fetched=await execute('acres_fetch_url',{url:'https://www.nyc.gov/page1'});
    return `Legacy answer [${fetched.sourceId}].`;
  };
  try{
    const out=await research({message:'Q?'},{},()=>{},()=>{},()=>{},agent);
    assert.equal(calls,1);assert.match(out.answer,/Legacy/);assert.equal(out.lanes,undefined);
  }finally{restore();}
});

test('the historical RESEARCH_PARALLEL_ENABLED flag no longer forces the lanes pipeline',async()=>{
  const restore=stubFetch();const calls=[];
  const agent=async({label,execute,onControl})=>{
    calls.push(label);onControl({steer:async()=>{},interrupt:async()=>{}});
    const fetched=await execute('acres_fetch_url',{url:'https://www.nyc.gov/page1'});
    return `Lead answer [${fetched.sourceId}].`;
  };
  try{
    const out=await research({message:'What is the lot area?'},{RESEARCH_PARALLEL_ENABLED:true},()=>{},()=>{},()=>{},agent);
    assert.deepEqual(calls,['research']);
    assert.equal(out.lanes,undefined);
  }finally{restore();}
});

test('the NYC specialist tools are direct only when the run is about New York City',async()=>{
  const restore=stubFetch();
  const nycCore=['acres_nyc_public_records','acres_development_ledger','acres_zoning_envelope','acres_entitlement_scenarios'];
  const offered=async(input)=>{
    let names=null,how=null;
    const agent=async({execute,onControl,dynamicTools})=>{
      onControl({steer:async()=>{},interrupt:async()=>{}});
      names=dynamicTools.map(d=>d.name);
      how=(await execute('acres_search_capabilities',{query:'zoning envelope bulk far'})).results.find(r=>r.name==='acres_zoning_envelope')?.how;
      const fetched=await execute('acres_fetch_url',{url:'https://www.nyc.gov/page1'});
      return `Answer [${fetched.sourceId}].`;
    };
    await research(input,{ENABLE_CURATED_ZONING:true},()=>{},()=>{},()=>{},agent);
    return {names,how};
  };
  try{
    const elsewhere=await offered({message:'What can be built at 100 Main Street, Austin, TX?'});
    for(const name of nycCore)assert.ok(!elsewhere.names.includes(name),`${name} is not sent on every turn of a run elsewhere`);
    assert.match(elsewhere.how,/acres_execute_capability/,'it stays reachable through the gateway');
    const followUp=await offered({message:'And the parking requirement?',priorState:{property:{bbl:'1010297501'}}});
    for(const name of nycCore)assert.ok(followUp.names.includes(name),`${name} is direct on a follow-up about an NYC subject`);
    assert.equal(followUp.how,'Call it directly by name.');
  }finally{restore();}
});

test('the lead agent can search capabilities, load a skill, and spawn self-chartered lanes, then synthesize',async()=>{
  const restore=stubFetch();const calls=[],events=[];let citedId;
  const agent=async({label,execute,onControl,dynamicTools})=>{
    calls.push(label);onControl({steer:async()=>{},interrupt:async()=>{}});
    if(label==='research'){
      assert.ok(dynamicTools.some(d=>d.name==='acres_search_capabilities'),'lead gets capability search');
      assert.ok(dynamicTools.some(d=>d.name==='acres_spawn_lanes'),'lead gets the spawn tool');
      for(const name of ['acres_nyc_public_records','acres_development_ledger','acres_zoning_envelope','acres_entitlement_scenarios'])assert.ok(dynamicTools.some(d=>d.name===name),`${name} is offered directly, with no discovery step first`);
      assert.ok(!dynamicTools.some(d=>d.name==='acres_pro_forma'),'other specialist tools stay behind the gateway');
      const found=await execute('acres_search_capabilities',{query:'entitlement how much more can this site build'});
      assert.ok(found.results.some(r=>r.name==='acres_entitlement_scenarios'));
      const loaded=await execute('acres_load_skill',{name:'case-law'});
      assert.match(loaded.text,/court opinions/i);
      const fork=await execute('acres_spawn_lanes',{reason:'Text and contrary authority could each change the answer.',lanes:[
        {title:'Operative text',charter:'Retrieve the controlling text in full.',tags:['evidence','zoning']},
        {title:'Contrary authority',charter:'Try to falsify the leading reading.',tags:['legal','evidence']},
      ]});
      assert.deepEqual(fork.lanes.map(l=>l.status),['completed','completed']);
      assert.equal(fork.sources.length,2);citedId=fork.sources[0].id;
      await assert.rejects(execute('acres_spawn_lanes',{lanes:[{title:'Again',charter:'No.'}]}),/already spawned/);
      return `Lead synthesis from verified lane evidence [${fork.sources[0].id}].`;
    }
    assert.ok(label.startsWith('lane_'),label);
    assert.ok(!dynamicTools.some(d=>d.name==='acres_spawn_lanes'),'lanes cannot spawn lanes');
    await assert.rejects(execute('acres_spawn_lanes',{lanes:[{title:'Nested',charter:'No.'}]}),/unavailable in this lane/);
    const n=label.includes('operative')?1:2;
    const fetched=await execute('acres_fetch_url',{url:`https://www.nyc.gov/page${n}`});
    return `FINDINGS lane evidence [${fetched.sourceId}]\nDECISION-CHANGERS none\nGAPS none`;
  };
  try{
    const out=await research({message:'Can this site build more?'},{ENABLE_CURATED_ZONING:true},()=>{},(e,d)=>events.push({e,d}),()=>{},agent);
    assert.deepEqual(calls,['research','lane_operative-text','lane_contrary-authority']);
    assert.match(out.answer,/Lead synthesis/);
    assert.deepEqual(out.lanes.map(l=>l.id).sort(),['contrary-authority','operative-text']);
    assert.ok(out.lanes.every(l=>l.spawned===true));
    assert.deepEqual(out.sources.map(s=>s.id),[citedId]);
    assert.ok(events.some(x=>x.e==='lane.completed'&&x.d.spawned===true));
    assert.ok(!events.some(x=>x.e==='judge.started'),'no judge in lead mode: the lead synthesizes');
  }finally{restore();}
});

test('a simple lead question that never spawns produces no lane or judge events',async()=>{
  const restore=stubFetch();const events=[];
  const agent=async({execute,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    const fetched=await execute('acres_fetch_url',{url:'https://www.nyc.gov/page1'});
    return `Short answer [${fetched.sourceId}].`;
  };
  try{
    await research({message:'What is the zoning district?'},{},()=>{},(e,d)=>events.push({e,d}),()=>{},agent);
    assert.ok(!events.some(x=>x.e.startsWith('lane.')||x.e.startsWith('judge.')));
  }finally{restore();}
});

test('probe 1: tool call budget is shared across the parent run and all spawned child lanes',async()=>{
  const restore=stubFetch();
  const shared={sources:[],retrievedParcels:new Map(),seenKnowledge:new Set(),calls:0,maxCalls:24};
  const root=createResearchTools({},()=>{},null,null,shared);
  const laneA=createResearchTools({},()=>{},null,null,shared);
  for(let i=0;i<BUDGET.fetch;i++){
    await root.execute('acres_fetch_url',{url:`https://www.nyc.gov/page${i+1}`});
  }
  await assert.rejects(laneA.execute('acres_fetch_url',{url:'https://www.nyc.gov/page99'}),/research tool budget is exhausted/);
  restore();
});

test('a page the lead fetched is a free re-read for a spawned lane sharing the run',async()=>{
  const original=global.fetch;
  let networkReads=0;
  global.fetch=async()=>{networkReads++;return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(htmlFor(1));})()};};
  try{
    const shared={sources:[],retrievedParcels:new Map(),seenKnowledge:new Set(),calls:0,subjectBbl:null};
    const lead=createResearchTools({},()=>{},null,null,shared);
    const lane=createResearchTools({},()=>{},null,null,shared);
    const url='https://www.nyc.gov/shared-chapter';
    const first=await lead.execute('acres_fetch_url',{url});
    const reread=await lane.execute('acres_fetch_url',{url,find:'Evidence page'});
    assert.equal(networkReads,1);
    assert.equal(first.budget.fetch,BUDGET.fetch-1);
    assert.equal(reread.cacheHit,true);
    assert.equal(reread.budget.fetch,BUDGET.fetch-1);
    for(let i=1;i<FREE_REREADS;i++)assert.equal((await lead.execute('acres_fetch_url',{url,offset:i})).cacheHit,true);
    const pastCap=await lane.execute('acres_fetch_url',{url,offset:FREE_REREADS});
    assert.equal(pastCap.cacheHit,undefined);
    assert.equal(pastCap.budget.fetch,BUDGET.fetch-2);
    assert.equal(networkReads,1);
  }finally{global.fetch=original;}
});

test('probe 2 & 3: validateCitations rejects rhetorical question-mark bypasses and unsupported statutory claims',()=>{
  const sources=[{id:1,title:'NYC PLUTO',url:'https://data.cityofnewyork.us/pluto',text:'BBL 1000477501 lot area 10000 sqft district C5-5.',verified:true}];
  assert.throws(
    ()=>validateCitations('Under ZR 23-22 you can build 500,000 sqft (or maybe 600,000 sqft?) as of right with a 20% bonus.',sources),
    /did not include source references/
  );
  assert.deepEqual(validateCitations('Which parcel BBL or street address would you like me to analyze?',[]),[]);
  assert.throws(
    ()=>validateCitations('Under ZR 99-99 the site qualifies for a 500% FAR bonus [1].',sources),
    /does not support/
  );
  assert.deepEqual(
    validateCitations('Parcel BBL 1000477501 has a lot area of 10000 sqft in district C5-5 [1].',sources),
    [1]
  );
});

test('probe 4 & 8: unverified market URLs do not mint citable sources and aggregate preserves computed programs despite cross-lane market differences',async()=>{
  const shared={sources:[],retrievedParcels:new Map(),seenKnowledge:new Set(),calls:0,maxCalls:24};
  const rootTools=createResearchTools({},()=>{},null,null,shared);
  const rootMarket=createMarketTools({emit:()=>{},record:rootTools.record});
  await rootMarket.handlers.acres_market_inputs({
    submarket:'FiDi',
    rents:[0,1,2,3].map(b=>({bedrooms:b,rentPerSqftPerMonth:5,source:'Unfetched URL',retrievedAt:'2026-10-13',url:'https://unfetched.example.com/market'})),
  });
  assert.equal(rootTools.sources.length,0,'unfetched market URL must not mint a citable source');
  assert.equal(rootMarket.market.rents[0].sourceId,null);

  const laneTools=createResearchTools({},()=>{},null,null,shared);
  const laneMarket=createMarketTools({emit:()=>{},record:laneTools.record});
  await laneMarket.handlers.acres_market_inputs({
    submarket:'FiDi',
    rents:[0,1,2,3].map(b=>({bedrooms:b,rentPerSqftPerMonth:10,source:'Lane Market',retrievedAt:'2026-10-13'})),
  });
  await laneMarket.handlers.acres_unit_mix({
    productType:'rental',
    residentialGrossSqft:50000,
    efficiency:0.85,
  });

  const failedTools=createResearchTools({},()=>{},null,null,shared);
  const merged=aggregate([
    {tools:rootTools,aux:{marketTools:{market:rootMarket.market,program:null}},status:'completed'},
    {tools:laneTools,aux:{marketTools:{market:null,program:laneMarket.program}},status:'completed'},
    {tools:failedTools,aux:{conceptTools:{concepts:[{id:'bad',name:'Failed Concept'}]}},status:'failed'},
  ],'1000477501');

  assert.equal(merged.concepts.length,0,'failed lane artifacts must be excluded');
  assert.equal(merged.program.byBedrooms[0].rentPerSqftPerMonth,10,'aggregation must preserve the inputs used by the computed program');
  assert.deepEqual(merged.program,laneMarket.program);
});

test('acres_fetch_url supports character-offset paging without re-fetching and assertPublicDns blocks DNS rebinding to private IPs',async()=>{
  const {isPrivateAddress,assertPublicDns}=await import('./public-url.mjs');
  assert.equal(isPrivateAddress('127.0.0.1'),true);
  assert.equal(isPrivateAddress('169.254.169.254'),true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'),true);
  assert.equal(isPrivateAddress('93.184.216.34'),false);
  await assert.rejects(
    assertPublicDns('rebinding.example.com',async()=>[{address:'169.254.169.254',family:4}]),
    /private or reserved IP/i
  );

  let networkHits=0;
  const original=global.fetch;
  const longText='A'.repeat(24000)+'B'.repeat(6500);
  const longHtml=`<html><head><title>Long Statute</title></head><body><main><p>${longText}</p></main></body></html>`;
  global.fetch=async()=>{
    networkHits++;
    return {
      ok:true,
      status:200,
      headers:{get:k=>k==='content-type'?'text/html':null},
      body:(async function*(){yield Buffer.from(longHtml);})(),
    };
  };
  try{
    const tools=createResearchTools({},()=>{});
    const page1=await tools.execute('acres_fetch_url',{url:'https://www.nyc.gov/long-statute.html'});
    assert.equal(networkHits,1);
    assert.equal(page1.offset,0);
    assert.equal(page1.totalCharacters,30500);
    assert.equal(page1.truncated,true);
    assert.equal(page1.nextOffset,24000);
    assert.equal(page1.text.length,24000);

    const page2=await tools.execute('acres_fetch_url',{url:'https://www.nyc.gov/long-statute.html',offset:24000});
    assert.equal(networkHits,1,'second page must read from in-run fetchedPages cache without re-fetching');
    assert.equal(page2.offset,24000);
    assert.equal(page2.truncated,false);
    assert.equal(page2.nextOffset,null);
    assert.equal(page2.text.length,6500);
    assert.ok(page2.text.startsWith('B'));

    const jumped=await tools.execute('acres_fetch_url',{url:'https://www.nyc.gov/long-statute.html',find:'BBBB'});
    assert.equal(networkHits,1,'find jump must reuse in-run fetchedPages cache');
    assert.equal(jumped.matchedIndex,24000);
    assert.ok(jumped.offset > 23000 && jumped.offset <= 24000);
    assert.match(jumped.text,/BBBB/);
  }finally{
    global.fetch=original;
  }
});

test('sanitizeAnswerFormatting converts table-cell em-dashes to None while replacing prose em-dashes cleanly',async()=>{
  const {sanitizeAnswerFormatting}=await import('./codex.mjs');
  const raw='| Mechanism | Added ZFA | Notes |\n| --- | --- | --- |\n| As-of-right | — | — [1] |\n\nProse sentence — with parenthetical.';
  const formatted=sanitizeAnswerFormatting(raw);
  assert.match(formatted,/\| As-of-right \| None \| None \[1\] \|/);
  assert.doesNotMatch(formatted,/\| ,  \|/);
  assert.match(formatted,/Prose sentence, with parenthetical\./);
});

test('acres_fetch_url on planning.nyc.gov extracts sectionIndex and blocks blind offset >= 48000 paging without find',async()=>{
  const original=global.fetch;
  const chapterBody='23-22 Maximum Floor Area Ratio\n\n'+'A'.repeat(25000)+'\n23-692 Height Limitation for Narrow Buildings\n\n'+'B'.repeat(30000);
  const longHtml=`<html><head><title>ZR Chapter</title></head><body><main>${chapterBody}</main></body></html>`;
  global.fetch=async()=>{
    return {
      ok:true,
      status:200,
      headers:{get:k=>k==='content-type'?'text/html':null},
      body:(async function*(){yield Buffer.from(longHtml);})(),
    };
  };
  // An empty saved-knowledge store, so a host that has cached the real chapter still fetches the mock.
  const knowledgeDb=process.env.ACRES_KNOWLEDGE_DB;
  process.env.ACRES_KNOWLEDGE_DB=join(mkdtempSync(join(tmpdir(),'acres-zr-fetch-')),'knowledge.sqlite');
  try{
    const tools=createResearchTools({},()=>{});
    const page1=await tools.execute('acres_fetch_url',{url:'https://zr.planning.nyc.gov/article-ii/chapter-3'});
    assert.ok(Array.isArray(page1.sectionIndex));
    assert.ok(page1.sectionIndex.some(s=>s.includes('23-692')));
    await assert.rejects(
      tools.execute('acres_fetch_url',{url:'https://zr.planning.nyc.gov/article-ii/chapter-3',offset:48000}),
      /Sequential offset paging past 48,000 characters on NYC Zoning Resolution chapters is disabled/
    );
    const jumped=await tools.execute('acres_fetch_url',{url:'https://zr.planning.nyc.gov/article-ii/chapter-3',offset:48000,find:'23-692'});
    assert.match(jumped.text,/23-692 Height Limitation/);
  }finally{
    global.fetch=original;
    if(knowledgeDb===undefined)delete process.env.ACRES_KNOWLEDGE_DB;else process.env.ACRES_KNOWLEDGE_DB=knowledgeDb;
  }
});

function geoParcelOps(features,row){
  const calls=[];
  const ops=createParcelOperations({
    request:async url=>{
      calls.push(url.href);
      if(url.host.startsWith('geosearch'))return {features};
      return url.searchParams.get('bbl')===row.bbl?[row]:[];
    },
    record:()=>({id:1}),
  });
  return {ops,calls};
}
const geoFeature=(name,borough,bbl)=>({properties:{label:`${name}, ${borough}, New York, NY, USA`,name,borough,confidence:0.9,addendum:{pad:{bbl,version:'26c'}}}});
const plutoRow={bbl:'1012340021',borough:'MN',block:1234,lot:21,address:'250 WEST 85 STREET',zonedist1:'R8B',lotarea:2500,bldgarea:9000,builtfar:3.6,residfar:4,commfar:0,facilfar:4,lotfront:25,lotdepth:100};

test('one borough and house number consistent GeoSearch candidate resolves its parcel in the same call',async()=>{
  const {ops,calls}=geoParcelOps([geoFeature('250 West 85th Street','Manhattan','1012340021'),geoFeature('250 West 85th Street','Brooklyn','3012340021')],plutoRow);
  const result=await ops.findProperty({address:'250 W 85th St',borough:'Manhattan'});
  assert.equal(result.confirmed,true);
  assert.deepEqual(result.rows,[plutoRow]);
  assert.ok(result.parcelDiagnostics);
  assert.equal(result.candidates.length,1);
  assert.ok(calls.some(href=>href.includes('bbl=1012340021')));
});

test('two same-borough GeoSearch candidates still return candidates unconfirmed',async()=>{
  const {ops}=geoParcelOps([geoFeature('250 West 85th Street','Manhattan','1012340021'),geoFeature('250 West 85th Street','Manhattan','1012340022')],plutoRow);
  const result=await ops.findProperty({address:'250 W 85th St',borough:'Manhattan'});
  assert.equal(result.confirmed,false);
  assert.equal(result.candidates.length,2);
  assert.equal(result.rows,undefined);
});

test('a single GeoSearch candidate with a different house number or no requested borough stays unconfirmed',async()=>{
  const other=await geoParcelOps([geoFeature('252 West 85th Street','Manhattan','1012340021')],plutoRow).ops.findProperty({address:'250 W 85th St',borough:'Manhattan'});
  assert.equal(other.confirmed,false);
  assert.equal(other.candidates.length,1);
  const noBorough=await geoParcelOps([geoFeature('250 West 85th Street','Manhattan','1012340021')],plutoRow).ops.findProperty({address:'250 W 85th St'});
  assert.equal(noBorough.confirmed,false);
});

test('a single GeoSearch candidate on a different street or a fractional lot stays unconfirmed without a parcel lookup',async()=>{
  for(const [name,address] of [['45 HUDSON AVENUE','45 Hudson St'],['539 1/2 COURT STREET','539 Court St']]) {
    const {ops,calls}=geoParcelOps([geoFeature(name,'Brooklyn','3000060001')],{...plutoRow,bbl:'3000060001'});
    const result=await ops.findProperty({address,borough:'Brooklyn'});
    assert.equal(result.confirmed,false);
    assert.equal(result.candidates.length,1);
    assert.equal(result.rows,undefined);
    assert.ok(!calls.some(href=>href.includes('bbl=3000060001')));
  }
});

test('the borough named in the address enables the same-call parcel resolution',async()=>{
  const result=await geoParcelOps([geoFeature('250 WEST 85 STREET','Manhattan','1012340021')],plutoRow).ops.findProperty({address:'250 W. 85th St, Manhattan'});
  assert.equal(result.confirmed,true);
  assert.deepEqual(result.rows,[plutoRow]);
});

test('a supplied lot area that disagrees with the single candidate parcel leaves it unconfirmed',async()=>{
  const features=[geoFeature('250 West 85th Street','Manhattan','1012340021')];
  const mismatch=await geoParcelOps(features,plutoRow).ops.findProperty({address:'250 W 85th St',borough:'Manhattan',lotAreaSqft:10000});
  assert.equal(mismatch.confirmed,false);
  assert.equal(mismatch.candidates.length,1);
  assert.equal(mismatch.rows,undefined);
  const agrees=await geoParcelOps(features,plutoRow).ops.findProperty({address:'250 W 85th St',borough:'Manhattan',lotAreaSqft:2503});
  assert.equal(agrees.confirmed,true);
  assert.deepEqual(agrees.rows,[plutoRow]);
});

test('address identity reads a leading St as Saint and a trailing St as Street',()=>{
  assert.equal(addressIdentity('12 St Marks Pl'),addressIdentity('12 SAINT MARKS PLACE'));
  assert.equal(addressIdentity('300 St Nicholas Ave'),'300 SAINT NICHOLAS AVENUE');
  assert.equal(addressIdentity('250 W 85th St'),'250 WEST 85 STREET');
  assert.notEqual(addressIdentity('12 St Marks Pl'),addressIdentity('12 MARKS STREET'));
});

test('a parcel lookup that misses or fails after one consistent candidate returns the candidates unconfirmed',async()=>{
  const miss=await geoParcelOps([geoFeature('250 West 85th Street','Manhattan','1012340099')],plutoRow).ops.findProperty({address:'250 W 85th St',borough:'Manhattan'});
  assert.equal(miss.confirmed,false);
  assert.equal(miss.candidates.length,1);
  const failing=createParcelOperations({request:async url=>{
    if(url.host.startsWith('geosearch'))return {features:[geoFeature('250 West 85th Street','Manhattan','1012340021')]};
    if(url.searchParams.get('bbl'))throw new Error('Provider timed out.');
    return [];
  }});
  const failed=await failing.findProperty({address:'250 W 85th St',borough:'Manhattan'});
  assert.equal(failed.confirmed,false);
  assert.equal(failed.candidates.length,1);
});


test('a sentence that asserts an event needs a cited source that records that event',()=>{
  const code=(claim,sources)=>{try{validateCitations(claim,sources);return 'accepted';}catch(error){return error.code;}};
  const mortgage=[{id:1,title:'County recorder mortgage index',url:'https://recorder.example.gov/index?format=application/json',text:'Mortgage recorded 2018 against the parcel. Mortgagor: Lakeview Partners LLC. Lender: Prairie Savings Bank. Amount $1,450,000. Indeed, recorded in book 77.'}];
  // Shared names, years and topic words do not make a mortgage index say the loan defaulted or the parcel
  // was sold; "indeed" is not a deed.
  assert.equal(code('Lakeview Partners LLC defaulted on the 2018 mortgage against the parcel [1].',mortgage),'UNSUPPORTED_EVENT');
  assert.equal(code('Prairie Savings Bank foreclosed on the Lakeview Partners parcel in 2018 [1].',mortgage),'UNSUPPORTED_EVENT');
  assert.equal(code('Lakeview Partners LLC sold the parcel after the 2018 mortgage [1].',mortgage),'UNSUPPORTED_EVENT');
  assert.equal(code('Lakeview Partners LLC owns the parcel until its ground lease expires 2031 under the 2018 mortgage [1].',mortgage),'UNSUPPORTED_EVENT');
  assert.equal(code('In May 2023 Prairie Savings Bank foreclosed on the Lakeview Partners parcel under the 2018 mortgage [1].',mortgage),'UNSUPPORTED_EVENT');
  assert.equal(code('Lakeview Partners LLC defaulted 12 times on the 2018 Prairie Savings Bank mortgage [1].',mortgage),'UNSUPPORTED_EVENT');
  assert.equal(code('Phase I found that Lakeview Partners LLC defaulted on the 2018 mortgage against the parcel [1].',mortgage),'UNSUPPORTED_EVENT');
  // A URL's "application" is not a filing.
  const exemption2018=[{id:1,title:'Property tax exemption detail',url:'https://data.example.gov/exemptions?format=application/json',text:'Exemption: 25 year abatement for Lakeview Partners LLC, start year 2012, final year 2036.'}];
  assert.equal(code('Lakeview Partners LLC filed a challenge to the 25 year abatement in 2012 [1].',exemption2018),'UNSUPPORTED_EVENT');
  assert.equal(code('Lakeview Partners LLC owns the parcel until its ground lease expires in 2031 under the 2018 mortgage [1].',mortgage),'UNSUPPORTED_EVENT');
  // The record's own facts, and a sentence that denies, conditions or only names the event, pass.
  assert.equal(code('Lakeview Partners LLC gave Prairie Savings Bank a mortgage of $1,450,000 recorded in 2018 [1].',mortgage),'accepted');
  assert.equal(code('The 2018 mortgage index for the Lakeview Partners parcel shows no default or foreclosure [1].',mortgage),'accepted');
  assert.equal(code('Lakeview Partners LLC didn’t default on the 2018 Prairie Savings Bank mortgage [1].',mortgage),'accepted');
  assert.equal(code('The 2018 mortgage index for the parcel cannot by itself establish that Lakeview Partners defaulted [1].',mortgage),'accepted');
  // A recorder index records a filing with its own word.
  const pendens=[{id:1,title:'County recorder index',url:'https://recorder.example.gov/doc',text:'Doc type LIS PENDENS, document date 2020-03-14, recorded 2020-03-20. Party 1: Prairie Savings Bank. Party 2: Lakeview Partners LLC. Re: 2018 mortgage.'}];
  assert.equal(code('Prairie Savings Bank foreclosed on Lakeview Partners LLC over the 2018 mortgage [1].',pendens),'accepted');
  assert.equal(code('A lis pendens was filed against Lakeview Partners LLC by Prairie Savings Bank in 2020 [1].',pendens),'accepted');
  // The words records use for an event support it: adopted for approved, a DM job for a demolition,
  // a final year for an expiry, a comparable sale record for sold.
  const council=[{id:1,title:'City Council land use',url:'https://council.example.gov/lu',text:'On June 4, 2024 the City Council adopted the Riverside rezoning text amendment.'}];
  assert.equal(code('The City Council approved the Riverside rezoning text amendment in June 2024 [1].',council),'accepted');
  const vote=[{id:1,title:'City Council votes',url:'https://council.example.gov/votes',text:'The City Council voted 47 to 1 to pass the Riverside rezoning text amendment.'}];
  assert.equal(code('The Riverside rezoning text amendment was approved by the City Council [1].',vote),'accepted');
  const market=[{id:1,title:'Quarterly condo market report',url:'https://reports.example/q2',text:'Riverside condos: median $1,450 per square foot in Q2 2024, with 82 closed units.'}];
  assert.equal(code('Riverside condos sold for a median $1,450 per square foot in Q2 2024 [1].',market),'accepted');
  const job=[{id:1,title:'Building department job filings',url:'https://data.example.gov/jobs.json',text:'job_type: DM, job_status: SIGNED OFF, job_description: REMOVE 2 STORY FRAME GARAGE, latest_action_date: 2019-03-14, owner: Lakeview Partners LLC'}];
  assert.equal(code('Lakeview Partners LLC demolished the 2 story frame garage in 2019 [1].',job),'accepted');
  const exemption=[{id:1,title:'Property tax exemption detail',url:'https://data.example.gov/exemptions.json',text:'Exemption: 25 year abatement for Lakeview Partners LLC, start year 2012, final year 2036.'}];
  assert.equal(code('The 25 year abatement for Lakeview Partners LLC expires in 2036 [1].',exemption),'accepted');
  const comps=[{id:1,title:'Comparable land trades',url:'https://store.example/comps',text:'Comparable 1: Harbor Road lot, price $3,900,000, 2023-08-02, buildable 26,000 sq ft, $150 per buildable foot.'}];
  assert.equal(code('The Harbor Road comparable lot sold for $150 per buildable foot in 2023 [1].',comps),'accepted');
  // A participle that names a kind of thing, a negation or modal anywhere in the clause, advice, and the
  // analyst's own act assert no event.
  const schedule=[{id:1,title:'Zoning schedule on the plans',url:'https://plans.example.gov/schedule',text:'Zoning lot area 6,796 sq ft. Residential FAR 3.00. Zoning floor area 20,388 sq ft. Height limit 75 feet.'}];
  for(const claim of [
    'The baseline is 20,388 sq ft of zoning floor area at 3.00 FAR, subject to the approved zoning lot [1].',
    'The DOB-approved zoning schedule shows 20,388 sq ft of zoning floor area [1].',
    'The filed ZFA of 20,388 sq ft matches the residential FAR of 3.00 [1].',
    'The schedule does not list expiration dates for the 6,796 sq ft zoning lot [1].',
    'The schedule does not show any recorded zoning violation on the 6,796 sq ft zoning lot [1].',
    'A building above the 75 feet height limit would trigger a violation of the zoning schedule [1].',
    'A building above 75 feet is a zoning violation under the zoning schedule height limit [1].',
    'Obtain the approved plans to confirm the 20,388 sq ft of zoning floor area [1].',
    'I rejected the zoning schedule figure of 20,388 sq ft because it predates the 3.00 FAR [1].',
  ])assert.equal(code(claim,schedule),'accepted',claim);
});

test('after a failed repair, a sentence asserting an unrecorded event is left out and every other sentence keeps its place',()=>{
  const sources=[{id:1,title:'County recorder mortgage index',url:'https://recorder.example.gov/index',text:'Mortgage recorded 2018 against the parcel. Mortgagor: Lakeview Partners LLC. Lender: Prairie Savings Bank. Amount $1,450,000.'},
    {id:2,title:'Zoning schedule on the plans',url:'https://plans.example.gov/schedule',text:'Zoning lot area 6,796 sq ft. Residential FAR 3.00. Zoning floor area 20,388 sq ft.'}];
  const answer=['| Measure | Figure |','| --- | --- |','| Standard baseline | 20,388 sq ft at 3.00 FAR, subject to the approved zoning lot. [2] |','','Lakeview Partners LLC gave Prairie Savings Bank a mortgage recorded in 2018 [1]. Prairie Savings Bank foreclosed on Lakeview Partners LLC [1]. Lakeview Partners LLC defaulted on the 2018 mortgage [1].'].join('\n');
  const out=withoutUnsupportedCitations(answer,sources);
  assert.deepEqual(out.removed,['Prairie Savings Bank foreclosed on Lakeview Partners LLC.','Lakeview Partners LLC defaulted on the 2018 mortgage.']);
  assert.deepEqual(out.dropped,[]);
  assert.equal(out.answer,['| Measure | Figure |','| --- | --- |','| Standard baseline | 20,388 sq ft at 3.00 FAR, subject to the approved zoning lot. [2] |','','Lakeview Partners LLC gave Prairie Savings Bank a mortgage recorded in 2018 [1].','','2 statements were left out because the cited source did not confirm them.'].join('\n'));
});

test('a violation is an event only where the sentence reports one occurring',()=>{
  const code=(claim,sources)=>{try{validateCitations(claim,sources);return 'accepted';}catch(error){return error.code;}};
  const schedule=[{id:1,title:'Zoning schedule on the plans',url:'https://plans.example.gov/schedule',text:'Zoning lot area 6,796 sq ft. Residential FAR 3.00. Zoning floor area 20,388 sq ft. Height limit 75 feet.'}];
  assert.equal(code('The 6,796 sq ft zoning lot has 3 open violations under the zoning schedule [1].',schedule),'UNSUPPORTED_EVENT');
  assert.equal(code('A violation was issued on the 6,796 sq ft zoning lot for the 75 feet height limit [1].',schedule),'UNSUPPORTED_EVENT');
  assert.equal(code('The 6,796 sq ft zoning lot has no open violations under the zoning schedule [1].',schedule),'accepted');
  const record=[{id:1,title:'Building violations',url:'https://data.example.gov/violations.json',text:'Violation type: ECB, issue date 2022-05-02, status OPEN, lot 6,796 sq ft zoning lot.'}];
  assert.equal(code('The 6,796 sq ft zoning lot has 1 open ECB violation issued in 2022 [1].',record),'accepted');
});
