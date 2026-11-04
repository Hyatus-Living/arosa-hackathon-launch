import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createMarketTools} from './market.mjs';
import {aggregate,research} from './research.mjs';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {priceFixture} from './testing/comparable-price.mjs';
import {COST_KEYS,FILTER_SCHEMA_ID,defaultFilterValues,listingSearchValues} from './listing-filter-schema.mjs';

function fixture(t) {
  const f=priceFixture(t),records=[];
  const tools=createMarketTools({marketStore:f.store,dealStoreAccess:{read:true,sync:false},record:row=>{records.push(row);return {id:records.length};}});
  return {...f,records,tools,search:args=>tools.handlers.acres_search_deal_store({syncIfEmpty:false,...args})};
}

test('each populated and empty search records its complete effective criteria and cost assumptions',async t=>{
  const f=fixture(t),first=await f.search({borough:'BK',hardCostPerGrossSqft:500,softCostPctOfHard:0}),empty=await f.search({borough:'QN',hardCostPerGrossSqft:800});
  assert.equal(first.dealCount,1);assert.equal(empty.dealCount,0);assert.equal(f.records.length,2);assert.equal(empty.sourceId,2);
  assert.equal(f.tools.dealSearches.length,2);
  for(const [i,row] of f.tools.dealSearches.entries()) {
    assert.equal(row.sourceId,i+1);assert.equal(row.filters.minUnusedZfa,500);assert.equal(row.filters.sortBy,'uap_price_per_buildable_zfa');assert.equal(row.filters.listingType,'for_sale');assert.equal(row.filters.limit,15);
    assert.deepEqual(JSON.parse(f.records[i].text).searchContext.filters,row.filters);
    assert.equal(row.returnedCount,i===0?1:0);assert.ok(Number.isFinite(Date.parse(row.searchedAt)));
    assert.ok(COST_KEYS.every(key=>Number.isFinite(row.filters[key])));
  }
  assert.equal(f.tools.dealSearches[0].filters.softCostPctOfHard,0);assert.equal(f.tools.dealSearches[1].filters.hardCostPerGrossSqft,800);
});

test('a chat search without listing-page costs values deals at the run account\'s saved costs, and another account at house costs',async t=>{
  const f=priceFixture(t),A='a'.repeat(24),B='b'.repeat(24);
  f.store.updateUserDealSettings(A,{rentalHardCostPerGrossSqft:610,condoHardCostPerGrossSqft:720,softCostPctOfHard:0.3});
  const search=account=>createMarketTools({marketStore:f.store,dealStoreAccess:{read:true,sync:false,account},record:()=>({id:1})}).handlers.acres_search_deal_store({syncIfEmpty:false,borough:'BK'});
  const house=f.store.getAdminConfig().dealSettings,saved=f.store.getUserDealSettings(A).dealSettings;
  const a=await search(A),b=await search(B),explicit=await createMarketTools({marketStore:f.store,dealStoreAccess:{read:true,sync:false,account:A},record:()=>({id:1})}).handlers.acres_search_deal_store({syncIfEmpty:false,borough:'BK',softCostPctOfHard:0.1});
  assert.deepEqual([a.searchContext.filters.hardCostPerGrossSqft,a.searchContext.filters.softCostPctOfHard],[610,0.3]);
  assert.equal(a.searchContext.costSource,'saved costs');
  for(const key of COST_KEYS)assert.equal(b.searchContext.filters[key],house[key],key);
  assert.equal(b.searchContext.costSource,'house costs');
  // The deals themselves are valued at the saved costs, exactly as Browse values them for that account.
  const browse=f.store.searchDealsPage({borough:'BK',minUnusedZfa:500,customSettings:saved}).deals[0];
  assert.deepEqual(a.deals[0].flashcardValuation.slidingScalePricePerBsf,browse.flashcardValuation.slidingScalePricePerBsf);
  assert.equal(a.deals[0].flashcardValuation.valueDriver.baseCondoHardCostPerGrossSqft,720);
  assert.notDeepEqual(a.deals[0].flashcardValuation.slidingScalePricePerBsf,b.deals[0].flashcardValuation.slidingScalePricePerBsf);
  // A cost named in the call overrides the saved one; the rest stay saved.
  assert.deepEqual([explicit.searchContext.filters.softCostPctOfHard,explicit.searchContext.filters.hardCostPerGrossSqft],[0.1,610]);
});

test('search evidence is frozen when later queries and returned objects change',async t=>{
  const f=fixture(t),args={borough:'BK',styles:['multi_family'],hardCostPerGrossSqft:500};const answer=await f.search(args);
  args.styles.push('land');answer.searchContext.filters.styles.push('land');answer.searchContext.filters.hardCostPerGrossSqft=900;
  const read=f.tools.dealSearches;read[0].filters.borough='QN';
  await f.search({borough:'QN'});
  assert.equal(f.tools.dealSearches[0].filters.borough,'BK');assert.equal(f.tools.dealSearches[0].filters.hardCostPerGrossSqft,500);assert.deepEqual(f.tools.dealSearches[0].filters.styles,['multi_family']);
});

test('aggregation retains completed searches in source order even if their lane later fails',()=>{
  const pair=(sourceId,status='completed')=>({status,tools:{property:{bbl:'3000010001'}},aux:{marketTools:{dealSearches:[{sourceId,returnedCount:0,filters:{borough:'QN'}}]}}});
  assert.deepEqual(aggregate([pair(3),pair(1),pair(2,'failed')],'1000010001').dealSearches.map(x=>x.sourceId),[1,2,3]);
  assert.deepEqual(aggregate([]).dealSearches,[]);
});

test('a lead answer retains a completed query and citation from a lane that later fails',async t=>{
  const f=fixture(t),previous=process.env.ACRES_MARKET_DB;process.env.ACRES_MARKET_DB=f.path;
  t.after(()=>{if(previous===undefined)delete process.env.ACRES_MARKET_DB;else process.env.ACRES_MARKET_DB=previous;});
  let failedSource;
  const result=await research({message:'Compare NYC listing searches.',dealStore:{read:true,sync:false}}, {},()=>{},()=>{},()=>{},async({dynamicTools,execute})=>{
    if(dynamicTools.some(tool=>tool.name==='acres_spawn_lanes')) {
      const first=await execute('acres_search_deal_store',{borough:'BK',syncIfEmpty:false});
      const lanes=await execute('acres_spawn_lanes',{lanes:[{title:'Other area',charter:'Compare Queens listings.',tools:['acres_search_deal_store']}]});assert.equal(lanes.lanes[0].status,'failed');
      return `Brooklyn returned matches [${first.sourceId}]. Queens returned none [${failedSource}].`;
    }
    const empty=await execute('acres_search_deal_store',{borough:'QN',syncIfEmpty:false});failedSource=empty.sourceId;throw new Error('Draft failed after the completed search');
  });
  assert.equal(result.sources.length,2);assert.equal(result.dealSearches.length,2);assert.equal(result.dealSearches[1].sourceId,failedSource);assert.equal(result.dealSearches[1].returnedCount,0);
});

test('real research publishes evidence for an empty search and permits its own citation',async t=>{
  const f=fixture(t),previous=process.env.ACRES_MARKET_DB;process.env.ACRES_MARKET_DB=f.path;
  t.after(()=>{if(previous===undefined)delete process.env.ACRES_MARKET_DB;else process.env.ACRES_MARKET_DB=previous;});
  const result=await research({message:'Compare NYC listings.',dealStore:{read:true,sync:false}}, {},()=>{},()=>{},()=>{},async({execute})=>{
    const a=await execute('acres_search_deal_store',{borough:'BK',hardCostPerGrossSqft:500,syncIfEmpty:false}),b=await execute('acres_search_deal_store',{borough:'QN',hardCostPerGrossSqft:800,syncIfEmpty:false});
    return `Brooklyn matches [${a.sourceId}]. Queens has no returned matches [${b.sourceId}].`;
  });
  assert.equal(result.sources.length,2);assert.equal(result.dealSearches.length,2);assert.match(result.answer,/\[2\]/);assert.equal(result.dealSearches[1].returnedCount,0);assert.equal(result.dealSearches[1].filters.hardCostPerGrossSqft,800);
});

test('saved search evidence survives the normal run and conversation restart without changing controls',async t=>{
  const f=fixture(t),path=join(f.dir,'chat.sqlite'),owner='a'.repeat(24),store=new ChatStore(path);
  const query=await f.search({borough:'QN',hardCostPerGrossSqft:800}),saved=f.tools.dealSearches;
  const manager=new RunManager(store,{},async()=>({answer:'No matching listings [1].',sources:[{id:1,title:'Search evidence',url:'https://example.com',text:f.records[0].text}],ui:[],dealSearches:saved,filterContext:true}));
  const conversation=store.createConversation(owner),id=crypto.randomUUID(),finished=new Promise(resolve=>manager.on(id,event=>{if(/^run\.(completed|failed)$/.test(event.event))resolve();}));
  manager.enqueue(owner,conversation.id,'Compare Queens listings',id);await finished;
  assert.equal(store.run(owner,id).status,'completed');store.close();
  const reopened=new ChatStore(path);t.after(()=>reopened.close());const answer=reopened.conversation(owner,conversation.id).messages.find(m=>m.role==='assistant');
  assert.deepEqual(answer.dealSearches,saved);assert.equal(answer.filterContext,true);assert.equal(answer.filterUpdate,undefined);assert.equal(query.dealCount,0);
});

test('a run carries its owner to the deal store, so a chat search without a listing page uses the saved costs',async t=>{
  const f=fixture(t),path=join(f.dir,'chat.sqlite'),owner='c'.repeat(24),store=new ChatStore(path),env={db:process.env.ACRES_MARKET_DB,on:process.env.ACRES_DEAL_STORE_ENABLED};
  process.env.ACRES_MARKET_DB=f.path;process.env.ACRES_DEAL_STORE_ENABLED='true';
  t.after(()=>{store.close();for(const [key,value] of [['ACRES_MARKET_DB',env.db],['ACRES_DEAL_STORE_ENABLED',env.on]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
  f.store.updateUserDealSettings(owner,{rentalHardCostPerGrossSqft:640});
  let searched;
  const manager=new RunManager(store,{},(input,secrets,progress,emit,onControl)=>research(input,secrets,progress,emit,onControl,async({execute})=>{
    searched=await execute('acres_search_deal_store',{borough:'BK',syncIfEmpty:false});return `Brooklyn matches [${searched.sourceId}].`;
  }));
  const conversation=store.createConversation(owner),id=crypto.randomUUID(),finished=new Promise(resolve=>manager.on(id,event=>{if(/^run\.(completed|failed)$/.test(event.event))resolve();}));
  manager.enqueue(owner,conversation.id,'Find Brooklyn deals',id);await finished;
  assert.equal(store.run(owner,id).status,'completed');
  assert.deepEqual([searched.searchContext.costSource,searched.searchContext.filters.hardCostPerGrossSqft],['saved costs',640]);
});

test('a chat search from the listings page values deals at the page\'s rental and condo hard costs, and its receipt keeps the condo cost',async t=>{
  const f=priceFixture(t),page={hardCostPerGrossSqft:380,softCostPctOfHard:0.22,carryAndFinancingPct:0.1,zfaToGrossFactor:1.15};
  const listingContext={schema:FILTER_SCHEMA_ID,revision:1,values:{...defaultFilterValues(),...page,minPrice:null,followMap:false},baselineCosts:page,condoHardCostPerGrossSqft:700};
  const tools=createMarketTools({marketStore:f.store,dealStoreAccess:{read:true,sync:false},record:()=>({id:1}),listingContext});
  const chat=await tools.handlers.acres_search_deal_store({minUnusedZfa:0,sortBy:'best_deal',syncIfEmpty:false});
  const driver=chat.deals[0].flashcardValuation.valueDriver;
  assert.deepEqual([driver.baseRentalHardCostPerGrossSqft,driver.baseCondoHardCostPerGrossSqft],[380,700]);
  // The page sends both figures; chat analysis of the same page rates every deal the same.
  const shown=f.store.searchDealsPage({minUnusedZfa:0,includeSimilarComps:false,limit:50,sortBy:'best_deal',customSettings:{...page,rentalHardCostPerGrossSqft:380,condoHardCostPerGrossSqft:700}}).deals;
  assert.deepEqual(chat.deals.map(d=>[d.id,d.flashcardValuation.dealVerdict]),shown.map(d=>[d.id,d.flashcardValuation.dealVerdict]));
  assert.equal(tools.dealSearches[0].filters.condoHardCostPerGrossSqft,700);
  assert.equal(listingSearchValues(tools.dealSearches[0].filters).condoHardCostPerGrossSqft,700,'Use these filters brings the condo cost back');
});

test('a hard cost named in chat prices both exits over saved split costs, and a named condo cost prices the condo exit',async t=>{
  const f=priceFixture(t),A='a'.repeat(24);
  f.store.updateUserDealSettings(A,{rentalHardCostPerGrossSqft:380,condoHardCostPerGrossSqft:520});
  const tools=()=>createMarketTools({marketStore:f.store,dealStoreAccess:{read:true,sync:false,account:A},record:()=>({id:1})});
  assert.ok(tools().definitions.find(d=>d.name==='acres_search_deal_store').inputSchema.properties.condoHardCostPerGrossSqft,'the tool takes a condo hard cost');
  const search=args=>tools().handlers.acres_search_deal_store({syncIfEmpty:false,borough:'BK',...args});
  const driver=out=>{const d=out.deals[0].flashcardValuation.valueDriver;return [d.baseRentalHardCostPerGrossSqft,d.baseCondoHardCostPerGrossSqft];};
  assert.deepEqual(driver(await search({})),[380,520]);
  const named=await search({hardCostPerGrossSqft:1200});
  assert.deepEqual(driver(named),[1200,1200]);
  assert.equal(named.searchContext.filters.condoHardCostPerGrossSqft,1200);
  assert.deepEqual(driver(await search({hardCostPerGrossSqft:1200,condoHardCostPerGrossSqft:900})),[1200,900]);
  assert.deepEqual(driver(await search({condoHardCostPerGrossSqft:900})),[380,900]);
});

test('a chat search from the listings page rates deals at the account\'s saved thresholds and efficiency, as Browse does',async t=>{
  const f=priceFixture(t),A='a'.repeat(24);f.add('second',{listPrice:1_500_000});
  f.store.updateUserDealSettings(A,{goodDealCondoMargin:0.25,greatDealCondoMargin:0.35,zfaToNetEfficiency:0.8});
  const saved=f.store.getUserDealSettings(A).dealSettings;
  // The page at the saved costs: no override, the saved figures as its baseline.
  const listingContext={schema:FILTER_SCHEMA_ID,revision:1,values:{...defaultFilterValues(),minPrice:null,followMap:false},baselineCosts:Object.fromEntries(COST_KEYS.map(key=>[key,saved[key]])),condoHardCostPerGrossSqft:saved.condoHardCostPerGrossSqft};
  const chat=await createMarketTools({marketStore:f.store,dealStoreAccess:{read:true,sync:false,account:A},record:()=>({id:1}),listingContext}).handlers.acres_search_deal_store({minUnusedZfa:0,syncIfEmpty:false});
  const browse=f.store.searchDealsPage({minUnusedZfa:0,includeSimilarComps:false,limit:50,sortBy:'best_deal',customSettings:{...saved}}).deals;
  const read=d=>[d.id,d.flashcardValuation.dealVerdict,d.flashcardValuation.slidingScalePricePerBsf.greatDealMaxBsf];
  assert.deepEqual(chat.deals.map(read),browse.map(read));
  // The saved margins bind, not the house ones. House hard costs escalate daily from their survey
  // date, so any baked dollar threshold rots; compare same-day figures instead.
  const house=f.store.getAdminConfig().dealSettings;
  const houseGreat=f.store.searchDealsPage({minUnusedZfa:0,includeSimilarComps:false,limit:50,sortBy:'best_deal',customSettings:{...house}}).deals.find(deal=>deal.id===chat.deals[0].id).flashcardValuation.slidingScalePricePerBsf.greatDealMaxBsf;
  assert.ok(read(chat.deals[0])[2]>0&&read(chat.deals[0])[2]<houseGreat,`Great at $${read(chat.deals[0])[2]}/BSF or less at the saved margins, under the house $${houseGreat}`);
});

test('the listings page\'s rental hard cost wins over a saved split rental figure in chat, as on the page',async t=>{
  const f=priceFixture(t),A='a'.repeat(24);
  f.store.updateUserDealSettings(A,{rentalHardCostPerGrossSqft:610,condoHardCostPerGrossSqft:720});
  const saved=f.store.getUserDealSettings(A).dealSettings;
  const listingContext={schema:FILTER_SCHEMA_ID,revision:1,values:{...defaultFilterValues(),hardCostPerGrossSqft:700,minPrice:null,followMap:false},baselineCosts:Object.fromEntries(COST_KEYS.map(key=>[key,saved[key]])),condoHardCostPerGrossSqft:720};
  const chat=await createMarketTools({marketStore:f.store,dealStoreAccess:{read:true,sync:false,account:A},record:()=>({id:1}),listingContext}).handlers.acres_search_deal_store({minUnusedZfa:0,syncIfEmpty:false});
  const driver=chat.deals[0].flashcardValuation.valueDriver;
  assert.deepEqual([driver.baseRentalHardCostPerGrossSqft,driver.baseCondoHardCostPerGrossSqft],[700,720]);
});
