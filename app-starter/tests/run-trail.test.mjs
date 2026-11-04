import test from 'node:test';
import assert from 'node:assert/strict';
import {stepFinding,stepSources,thoughtHeadline,sourcesFound,timeLine} from '../public/run-trail.js';

const done=(tool,result,args={})=>({tool,arguments:args,success:true,result});
const viaGateway=(name,result,args={})=>({tool:'acres_execute_capability',arguments:{name,arguments:args},success:true,result});

test('finished steps report their figures in plain words',()=>{
  assert.equal(stepFinding(done('acres_find_property',{rows:[{address:'25-21 94 STREET',zonedist1:'R3X',lotarea:'4445'}]})),'25-21 94 Street, R3X, 4,445 sq ft lot');
  assert.equal(stepFinding(done('acres_zoning_envelope',{headlineReconciliation:{operativeFigure:{valueSqft:14515}},envelope:{district:'C6-2'}})),'Up to 14,515 sq ft of zoning floor area in C6-2');
  assert.equal(stepFinding(done('acres_entitlement_scenarios',{scenarios:[{addedFloorAreaSqft:1111},{addedFloorAreaSqft:3000}]})),'2 ways to build more, the largest adds 3,000 sq ft');
  assert.equal(stepFinding(viaGateway('acres_market_comps',{totalComps:41},{zipCode:'11225'})),'41 comparable listings and sales near 11225');
  assert.equal(stepFinding(viaGateway('acres_unit_mix',{units:9,averageUnitSqft:935})),'9 units averaging 935 sq ft');
  assert.equal(stepFinding(viaGateway('acres_pro_forma',{name:'Standard rental — 2 units',returns:{value:1589981,profit:-1580735}})),'Standard rental, 2 units: worth $1.59M built, a loss of $1.58M');
  assert.equal(stepFinding(viaGateway('acres_compare_programs',{decision:{call:'below_price',maxLandPrice:2100000}})),'The land is worth less than the asking price; land is worth up to $2.10M');
  assert.equal(stepFinding(viaGateway('acres_compare_programs',{decision:{call:'no_land_value',maxLandPrice:-587728}})),'The program leaves no land value at the target return');
  assert.equal(stepFinding(done('acres_nyc_public_records',{bbl:'1',dobBisFilings:[{}],dobNowFilings:[],acrisDocuments:[{},{}]})),'1 building filing and 2 property records');
  assert.equal(stepFinding({...done('acres_zoning_envelope',{}),success:false}),null,'a failed step reports nothing');
  assert.equal(stepFinding(done('acres_read_context',{text:'x'})),null,'housekeeping has no finding');
});

test('steps that read sources name them, and the trail counts each source once',()=>{
  const page=done('acres_fetch_url',{title:'ZR 23-21 Floor Area Regulations — R1 to R5',url:'https://zr.planning.nyc.gov/a'});
  assert.deepEqual(stepSources(page),[{title:'ZR 23-21 Floor Area Regulations, R1 to R5',url:'https://zr.planning.nyc.gov/a'}]);
  assert.deepEqual(stepSources(done('acres_search_knowledge',{results:[{title:'ZR 12-10 definitions',url:'u'},{title:'MIH areas'}]})).map(s=>s.title),['ZR 12-10 definitions','MIH areas']);
  assert.deepEqual(stepSources(done('acres_read_context',{})),[]);
  assert.deepEqual(stepSources(done('acres_fetch_url',{title:'https://data.cityofnewyork.us/resource/bzxi-2tsw.json?$where=boroid',url:'https://data.cityofnewyork.us/resource/bzxi-2tsw.json'})).map(s=>s.title),['data.cityofnewyork.us'],'an untitled page reads as its site');
  assert.equal(sourcesFound([{sources:stepSources(page)},{sources:stepSources(page)},{}]).length,1);
});

test('reasoning summaries become one plain headline',()=>{
  assert.equal(thoughtHeadline(['**Performing quick calculation**']),'Performing quick calculation');
  assert.equal(thoughtHeadline(['**Reading the lot**\n\nThe lot is 25 by 100.','**Checking 485-x eligibility**\n\nThe project has 12 units.']),'Checking 485-x eligibility');
  assert.equal(thoughtHeadline([]),null);
  assert.equal(thoughtHeadline([{type:'summary_text',text:'Sizing the rear yard'}]),'Sizing the rear yard');
});

test('the time line says what is left from measured runs, and only elapsed time without them',()=>{
  assert.equal(timeLine(20000),'Under a minute so far');
  assert.equal(timeLine(3*60000,null),'3 min so far');
  assert.equal(timeLine(3*60000,7*60000),'About 4 min left, 3 min so far');
  assert.equal(timeLine(6.5*60000,7*60000),'Finishing up, 7 min so far');
  assert.equal(timeLine(12*60000,7*60000),'Taking longer than usual, 12 min so far; these usually take about 7 min');
});
