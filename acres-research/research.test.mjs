import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchTools,publicUrl,savedPageIndex} from './tools.mjs';
import {createConfiguredZoningTools,research,SAVED_SOURCE_LIMIT} from './research.mjs';
import {installOfflinePublicWeb} from './testing/public-web.mjs';
import {describe,fieldsFromResult} from './project-state.mjs';
const testSecrets={COMPOSIO_API_KEY:'test-project-key-not-real-0000'},testSessions={exa:'exa',public:'public'};

test('curated zoning stays unavailable without an explicit host opt-in',()=>{
  for(const flag of [undefined,false,'true',1]) {
    const tools=createConfiguredZoningTools({ENABLE_CURATED_ZONING:flag},()=>{throw new Error('must not read a parcel');});
    assert.deepEqual(tools.definitions,[]);
    assert.equal(tools.handlers.acres_zoning_envelope,undefined);
  }
  const enabled=createConfiguredZoningTools({ENABLE_CURATED_ZONING:true},()=>null);
  assert.equal(enabled.definitions[0].name,'acres_zoning_envelope');
  assert.equal(typeof enabled.handlers.acres_zoning_envelope,'function');
});

test('address aliases are candidates, duplicate BBLs collapse, and confidence does not confirm a parcel',async()=>{
  const original=global.fetch;
  global.fetch=async url=>{if(!String(url).includes('geosearch'))assert.equal(new URL(url).searchParams.get('address'),'120 BROADWAY');return {ok:true,json:async()=>String(url).includes('geosearch')?{features:['1000477501','1000477501','1002830050'].map(bbl=>({properties:{label:'NYC address',name:'120 BROADWAY',borough:'Manhattan',confidence:1,addendum:{pad:{bbl,version:'26c'}}}}))}:[]};};
  try {
    const tools=createResearchTools(testSecrets);
    const result=await tools.execute('acres_find_property',{address:'120 bway downtown Manhattan',borough:'Manhattan'});
    assert.equal(result.confirmed,false);assert.equal(result.candidates.length,2);assert.equal(tools.property,null);
    assert.equal(tools.sources.at(-1).kind,'address');
  } finally {global.fetch=original;}
});

test('multiple parcel matches remain unconfirmed and invalid BBLs do not reach a provider',async()=>{
  const original=global.fetch;let calls=0;
  global.fetch=async()=>{calls++;return {ok:true,json:async()=>[{bbl:'1000010001'},{bbl:'3000010001'}]};};
  try {
    const tools=createResearchTools(testSecrets);
    assert.equal((await tools.execute('acres_find_property',{address:'100 MAIN STREET'})).confirmed,false);
    await assert.rejects(tools.execute('acres_find_property',{bbl:"1' OR 1=1"}),/valid ten-digit/);
    assert.equal(calls,1);assert.equal(tools.property,null);
  } finally {global.fetch=original;}
});

test('tool discovery excludes private account tools and execution requires prior discovery',async()=>{
  const original=global.fetch;let executions=0;
  global.fetch=async(url,options)=>{
    if (String(url).endsWith('/search')) return {ok:true,json:async()=>({tool_schemas:{EXA_SEARCH:{description:'Search',input_schema:{}},GMAIL_FETCH_EMAILS:{description:'Private mail',input_schema:{}},COMPOSIO_SEARCH_FETCH_URL_CONTENT:{description:'Fetch public page',input_schema:{}}}})};
    if (String(url).includes('/tools/')) {
      const privateTool=String(url).includes('GMAIL');
      return {ok:true,json:async()=>({tags:['readOnlyHint'],no_auth:!privateTool,instant:{supported:false}})};
    }
    executions++;
    const body=JSON.parse(options.body);assert.equal(body.tool_slug,'COMPOSIO_SEARCH_FETCH_URL_CONTENT');
    return {ok:true,json:async()=>({result_type:'completed',data:{results:[{url:'https://www.nycourts.gov/opinion',title:'Court opinion',text:'Actual opinion text'},{url:'https://example.com/lead',description:'A search excerpt'}]}})};
  };
  try {
    const tools=createResearchTools(testSecrets,()=>{},null,testSessions);
    const catalog=await tools.execute('acres_discover_tools',{query:'Find public court opinions'});
    assert.deepEqual(catalog.tools.map(t=>t.slug).sort(),['COMPOSIO_SEARCH_FETCH_URL_CONTENT','EXA_SEARCH']);
    await assert.rejects(tools.execute('acres_execute_tool',{slug:'GMAIL_FETCH_EMAILS',arguments:{}}),/Discover/);
    const result=await tools.execute('acres_execute_tool',{slug:'COMPOSIO_SEARCH_FETCH_URL_CONTENT',arguments:{url:'https://www.nycourts.gov/opinion'}});
    assert.equal(executions,1);assert.equal(tools.sources.length,1);assert.equal(tools.sources[0].id,1);assert.equal(tools.sources[0].verified,true);
    assert.equal(result.data.results[0].sourceId,1);assert.equal(result.data.results[1].description,'A search excerpt');
    assert.equal(result.data.results[1].sourceId,undefined);assert.equal(result.sources.length,1);
    await assert.rejects(tools.execute('acres_execute_tool',{slug:'COMPOSIO_SEARCH_FETCH_URL_CONTENT',arguments:{url:'http://169.254.169.254/'}}),/HTTPS/);
    await assert.rejects(tools.execute('acres_execute_tool',{slug:'COMPOSIO_SEARCH_FETCH_URL_CONTENT',arguments:{url:'https://www.nycourts.gov/',actions:[{type:'click'}]}}),/Browser actions/);
    assert.equal(executions,1);
  } finally {global.fetch=original;}
});

test('Instant funding errors are explicit and cannot silently become a successful result',async()=>{
  const original=global.fetch;
  global.fetch=async(url)=>({ok:!String(url).endsWith('/execute'),status:402,json:async()=>String(url).endsWith('/search')?{tool_schemas:{FIRECRAWL_SCRAPE:{description:'Scrape',input_schema:{}}}}:String(url).includes('/tools/')?{tags:['readOnlyHint'],no_auth:false,instant:{supported:true}}:{error:{message:'Wallet balance is exhausted'}}});
  try {
    const tools=createResearchTools(testSecrets,()=>{},null,testSessions);
    await tools.execute('acres_discover_tools',{query:'Scrape a page'});
    await assert.rejects(tools.execute('acres_execute_tool',{slug:'FIRECRAWL_SCRAPE',arguments:{url:'https://www.nyc.gov/'}}),/no remaining credits/);
    assert.equal(tools.sources.length,0);
  } finally {global.fetch=original;}
});

test('source links reject local addresses and credentials',()=>{
  for(const url of ['http://www.nyc.gov','https://127.0.0.1','https://metadata.google.internal','https://user:pass@example.com','file:///etc/passwd']) assert.equal(publicUrl(url),false);
  assert.equal(publicUrl('https://www.nycourts.gov/opinion'),true);
});

test('comparison lookups do not change the subject and an unverified BBL cannot be selected',async()=>{
  const original=global.fetch;
  global.fetch=async url=>({ok:true,json:async()=>[{bbl:new URL(url).searchParams.get('bbl'),address:'NYC address'}]});
  try {
    const tools=createResearchTools(testSecrets);
    await assert.rejects(tools.execute('acres_set_subject',{bbl:'1000477501'}),/Retrieve/);
    await tools.execute('acres_find_property',{bbl:'1000477501'});
    await tools.execute('acres_set_subject',{bbl:'1000477501'});
    await tools.execute('acres_find_property',{bbl:'1001237501'});
    assert.equal(tools.property.bbl,'1000477501');
  } finally {global.fetch=original;}
});

test('wallet authorization happens before tool network calls; response costs reach settlement',async()=>{
  const original=global.fetch;let calls=0;const charges=[];
  global.fetch=async url=>{calls++;return {ok:true,json:async()=>String(url).endsWith('/search')?{tool_schemas:{EXA_SEARCH:{description:'Search',input_schema:{}}}}:String(url).includes('/tools/')?{tags:['readOnlyHint'],no_auth:true,instant:{supported:false}}:{data:{results:[]},instant_charge:{usd:'0.01'}}};};
  let allow=true;
  const meter={async authorize(provider,operation){if(!allow)throw new Error('Not enough credits');return {invoke:fn=>fn(),settle:async result=>charges.push({provider,operation,result}),pending:async()=>{}};}};
  try {
    const tools=createResearchTools(testSecrets,()=>{},meter,testSessions);
    await tools.execute('acres_discover_tools',{query:'search'});
    const before=calls;allow=false;
    await assert.rejects(tools.execute('acres_execute_tool',{slug:'EXA_SEARCH',arguments:{query:'zoning'}}),/credits/);
    assert.equal(calls,before);allow=true;
    await tools.execute('acres_execute_tool',{slug:'EXA_SEARCH',arguments:{query:'zoning'}});
    assert.equal(charges.at(-1).provider,'exa');assert.equal(charges.at(-1).result.instant_charge.usd,'0.01');
  } finally {global.fetch=original;}
});


const marketPage={title:'Queens rental market report',url:'https://www.example.org/queens-rents',kind:'research',fetchedAt:'2026-10-20T12:00:00.000Z',publishedDate:'2026-10-01',offset:0,
  text:'Median asking rent for a two bedroom apartment in Long Island City was $5,100 per month in September 2026.',fields:['market']};
// The saved market shape: rows keep a sourceKey and the market keeps the evidence snapshot it cites.
const savedMarketState=()=>{
  const {fields:_fields,offset:_offset,...page}=marketPage;
  const snapshot={...page,verified:true};
  const market={submarket:'Long Island City',rents:[{bedrooms:2,rentPerMonth:5100,source:marketPage.title,url:marketPage.url,retrievedAt:'2026-10-20',sourceId:1,sourceKey:'rent-2br'}],evidenceSources:{'rent-2br':snapshot}};
  return {market,state:{market:{...fieldsFromResult({market,sources:[{id:1,...snapshot}]},'earlier-run').market,stale:null,updated:Date.parse('2026-10-20T12:00:00Z')}}};
};
const withoutNetwork=async(body)=>{
  const original=global.fetch,calls={count:0},restore=installOfflinePublicWeb();
  global.fetch=async()=>{calls.count++;throw new Error('A saved source must not be fetched again.');};
  try{return await body(calls);}finally{restore();global.fetch=original;}
};
const ageDays=fetchedAt=>Math.floor((Date.now()-Date.parse(fetchedAt))/86400000);

test('the returned source list keeps cited pages and uncited saved-field evidence, with stable IDs',()=>withoutNetwork(async calls=>{
  const {market,state}=savedMarketState();
  const pages=Array.from({length:5},(_,i)=>({title:`Municipal research ${i+1}`,url:`https://www.example.org/research-${i+1}`,kind:'research',fetchedAt:marketPage.fetchedAt,offset:0,fields:['market'],text:'Municipal records describe parcel research and ownership history. Asking rent is $6 per square foot per month.'}));
  const read=[];let saved;
  const out=await research({message:'Compare these saved research sources.',project:describe(state),priorState:{market},savedSources:()=>[marketPage,...pages]},{},()=>{},()=>{},()=>{},async({execute,validateAnswer})=>{
    for(const page of pages)read.push(await execute('acres_fetch_url',{url:page.url}));
    saved=await execute('acres_market_inputs',{submarket:'Study area',rents:[{bedrooms:2,rentPerSqftPerMonth:6,source:pages[4].title,url:pages[4].url,retrievedAt:'2026-10-20'}]});
    const answer=`Municipal records describe parcel research and ownership history [${read[0].sourceId}, ${read[2].sourceId}].`;
    validateAnswer(answer);return answer;
  });
  assert.deepEqual(out.sources.map(s=>s.url).sort(),[pages[4].url,pages[0].url,pages[2].url].sort());
  assert.deepEqual(out.sources.map(s=>s.id).sort((a,b)=>a-b),[saved.rents[0].sourceId,read[0].sourceId,read[2].sourceId].sort((a,b)=>a-b));
  assert.equal(fieldsFromResult(out,'run').market.provenance.sources[0].url,pages[4].url);
  assert.equal(calls.count,0);
}));

test('a follow-up run cites a source saved with the market inputs without fetching it again',()=>withoutNetwork(async calls=>{
  const {market,state}=savedMarketState();
  let fetchLeft,read;
  const out=await research({message:'What rent should the two bedrooms assume?',project:describe(state),priorState:{market},savedSources:()=>[marketPage]},{},()=>{},()=>{},()=>{},
    async({project,execute,validateAnswer})=>{
      const listed=project.savedSources.find(source=>source.url===marketPage.url);
      assert.deepEqual(listed,{title:marketPage.title,url:marketPage.url,retrievedAt:marketPage.fetchedAt,fields:['market']});
      read=await execute('acres_fetch_url',{url:listed.url});
      const answer=`Median asking rent for a two bedroom apartment in Long Island City was $5,100 per month in September 2026 [${read.sourceId}].`;
      validateAnswer(answer);fetchLeft=read.budget.fetch;return answer;
    });
  assert.equal(read.cacheHit,true);assert.equal(read.method,'saved-source');assert.equal(read.text,marketPage.text);
  assert.equal(read.ageDays,ageDays(marketPage.fetchedAt));assert.match(read.note,/live:true/);
  assert.equal(read.totalCharacters,null);assert.equal(read.nextOffset,null);assert.equal(read.truncated,false);
  assert.equal(fetchLeft,createResearchTools({},()=>{},null,null,{}).budget.fetch);
  // The market's own restored evidence and the saved read are one citation.
  assert.equal(out.sources.length,1);assert.equal(read.sourceId,out.sources[0].id);
  const [cited]=out.sources;
  assert.equal(cited.text,marketPage.text);assert.equal(cited.verified,true);assert.equal(cited.fetchedAt,marketPage.fetchedAt);assert.equal(cited.publishedDate,marketPage.publishedDate);
  assert.equal(calls.count,0);
}));

test('saved sources cost nothing until read: an uncited follow-up passes, the list is capped and new evidence keeps the full budget',()=>withoutNetwork(async()=>{
  const {state}=savedMarketState();
  const saved=Array.from({length:80},(_,i)=>({...marketPage,url:`https://www.example.org/report-${i}`,title:`Report ${i}`,text:'x'.repeat(24000)}));
  let listed;
  const out=await research({message:'Rename the site to Corner Lot.',project:describe(state),savedSources:()=>saved},{},()=>{},()=>{},()=>{},
    async({project,validateAnswer})=>{
      listed=project.savedSources;
      assert.ok(listed.every(source=>!('text' in source)));
      const answer='Floor area ratio is the building floor area divided by the lot area.';
      validateAnswer(answer);return answer;
    });
  assert.equal(listed.length,SAVED_SOURCE_LIMIT);assert.deepEqual(listed.map(s=>s.url),saved.slice(0,SAVED_SOURCE_LIMIT).map(s=>s.url));
  assert.equal(out.answer,'Floor area ratio is the building floor area divided by the lot area.');
  assert.deepEqual(out.sources,[]);
  const tools=createResearchTools({},()=>{},null,null,{savedPages:savedPageIndex(saved)});
  const fresh=Array.from({length:80},(_,i)=>tools.record({title:`New page ${i}`,url:`https://www.example.org/new-${i}`,text:'y'.repeat(24000)}));
  assert.ok(fresh.every(Boolean));assert.equal(tools.sources.length,80);
}));

test('lanes mode never reads the saved sources',async()=>{
  let read=false;
  await research({message:'Rename the site.',savedSources:()=>{read=true;return [];}},{RESEARCH_MODE:'lanes'},()=>{},()=>{},()=>{},async()=>'Done.').catch(()=>{});
  assert.equal(read,false);
});

test('a saved source keeps its page, offset, publication date and complete JSON when read again',()=>withoutNetwork(async()=>{
  const pdfPage={title:'Zoning report (offset 24000)',url:'https://www.example.org/report.pdf#page=3',kind:'research',fetchedAt:'2026-10-18T09:00:00.000Z',publishedDate:'2025-06-01',offset:24000,totalCharacters:24016,pdf:{page:3,pageCount:12},text:'Page three text.',fields:['entitlements']};
  const records={title:'NYC records',url:'https://data.cityofnewyork.us/resource/abcd-1234.json?bbl=1',kind:'official_record',fetchedAt:'2026-10-18T09:05:00.000Z',publishedDate:null,offset:0,completeJson:true,text:JSON.stringify(Array.from({length:600},(_,i)=>({row:i,note:'z'.repeat(40)}))),fields:['publicRecords']};
  const older={...records,fetchedAt:'2026-10-01T09:05:00.000Z',text:'[]'};
  const tools=createResearchTools({},()=>{},null,null,{savedPages:savedPageIndex([older,pdfPage,records])});
  const page=await tools.execute('acres_fetch_url',{url:pdfPage.url,offset:24000});
  assert.equal(page.cacheHit,true);assert.deepEqual(page.pdf,pdfPage.pdf);assert.equal(page.offset,24000);assert.equal(page.totalCharacters,24016);assert.equal(page.nextOffset,null);
  const json=await tools.execute('acres_fetch_url',{url:records.url});
  assert.equal(json.truncated,true);assert.equal(json.totalCharacters,records.text.length);assert.equal(json.nextOffset,24000);
  // The rest of a saved complete record pages from the saved text under the same citation.
  const rest=await tools.execute('acres_fetch_url',{url:records.url,offset:json.nextOffset});
  assert.equal(rest.cacheHit,true);assert.equal(rest.sourceId,json.sourceId);assert.equal(json.text+rest.text,records.text.slice(0,48000));
  const [pdfSource,jsonSource]=tools.sources;
  assert.equal(pdfSource.publishedDate,'2025-06-01');assert.equal(pdfSource.offset,24000);assert.deepEqual(pdfSource.pdf,pdfPage.pdf);assert.equal(pdfSource.fetchedAt,pdfPage.fetchedAt);
  assert.equal(jsonSource.completeJson,true);assert.equal(jsonSource.text,records.text);assert.equal(jsonSource.fetchedAt,records.fetchedAt);
  assert.equal(tools.budget.fetch,createResearchTools({},()=>{},null,null,{}).budget.fetch);
}));

test('a saved excerpt reports the length and next offset of its document, and live:true reads the current page',async()=>{
  const original=global.fetch,restore=installOfflinePublicWeb();let hits=0;
  const longText='A'.repeat(24000)+'B'.repeat(6500);
  global.fetch=async()=>{hits++;return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(`<html><head><title>Long Report</title></head><body><main><p>${longText}</p></main></body></html>`);})()};};
  try{
    const url='https://www.nyc.gov/long-report.html';
    const first=createResearchTools({},()=>{});
    const live=await first.execute('acres_fetch_url',{url});
    const recorded=first.sources.find(s=>s.id===live.sourceId);
    assert.equal(recorded.totalCharacters,live.totalCharacters,'the document length is recorded with the excerpt');
    const saved={...recorded,fields:['market']};
    const later=createResearchTools({},()=>{},null,null,{savedPages:savedPageIndex([saved])});
    const again=await later.execute('acres_fetch_url',{url});
    assert.equal(hits,1);assert.equal(again.method,'saved-source');
    for(const key of ['totalCharacters','nextOffset','truncated','text'])assert.deepEqual(again[key],live[key],key);
    // An excerpt saved without its document length still points past its last character.
    const {totalCharacters:_total,...legacy}=saved;
    const old=await createResearchTools({},()=>{},null,null,{savedPages:savedPageIndex([legacy])}).execute('acres_fetch_url',{url});
    assert.equal(old.totalCharacters,null);assert.equal(old.nextOffset,24000);assert.equal(old.truncated,true);
    const refreshed=await later.execute('acres_fetch_url',{url,live:true});
    assert.equal(hits,2);assert.notEqual(refreshed.method,'saved-source');
    const after=await later.execute('acres_fetch_url',{url});
    assert.notEqual(after.method,'saved-source','once read live, the run keeps reading the current page');
  }finally{restore();global.fetch=original;}
});
