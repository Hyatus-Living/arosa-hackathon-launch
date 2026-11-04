import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {renderNearbyPipeline,nearbyPipelineQuery} from '../public/nearby-pipeline.js';
import {renderInspector} from '../public/listing-inspector.js';
import {renderParcel} from '../public/core-view.js';
import {reportModel,renderReport} from '../public/report-view.js';

function dom(t){
  const original={document:globalThis.document,window:globalThis.window};
  const {document,window}=parseHTML('<html><body></body></html>');
  Object.assign(globalThis,{document,window});
  t.after(()=>Object.assign(globalThis,original));
}

const tenure=(rental,condo)=>({condo:{projects:condo?1:0,units:condo},rental:{projects:rental?1:0,units:rental},mixed:{projects:0,units:0},unknown:{projects:1,units:30}});
const read={
  available:true,radiusMiles:0.5,zip:'11211',months:36,since:'2023-10-21',retrievedAt:'2026-10-21T08:40:00.000Z',
  sourceUrl:'https://data.cityofnewyork.us/d/w9ak-ipjd',projectCount:9,
  nearby:{projects:9,newBuildings:7,alterations:2,units:330,floorArea:1250000,
    byStage:{approved:{projects:7,units:280,floorArea:1000000},in_review:{projects:1,units:40,floorArea:200000},disapproved:{projects:1,units:10,floorArea:50000}},
    approved:{projects:7,units:280,floorArea:1000000},tenure:tenure(240,60),condoShareOfStatedUnits:0.2,statedShareOfUnits:0.909},
  sameZip:{projects:31,units:1900,approved:{projects:25,units:1500,floorArea:4000000}},
  onSubjectLot:[{jobNumber:'B00123456',newBuilding:true,stage:'approved',status:'Permit Entire',units:12}],
  projects:Array.from({length:9},(_,i)=>({
    bbl:`30023000${10+i}`,address:`${100+i} North 6 Street`,jobNumber:`B0099${i}`,newBuilding:i!==3,stage:'approved',status:'Permit Entire',
    units:200-i*20,floorArea:150000,filingDate:'2025-02-01',distanceMiles:0.1+i/100,tenure:i===0?'rental':'unknown',
    tenureBasis:i===0?['HPD counts 60 rental units']:[],link:`https://data.cityofnewyork.us/resource/w9ak-ipjd.json?x=${i}`,
  })),
};

test('the nearby pipeline reads in plain words with units, floor area, tenure and a link to each filing',t=>{
  dom(t);
  const view=renderNearbyPipeline(read);
  const text=view.textContent;
  assert.equal(view.querySelector('h3').textContent,'Nearby development');
  // Only approved or permitted projects headline; the other stages are named, never added in.
  assert.match(text,/Within half a mile, filed or acted on since Oct 2023: 7 approved or permitted projects with 280 proposed units and 1\.0 million SF of floor area\./);
  assert.match(text,/Not counted above: In DOB review, 1 project with 40 units; Has objections, 1 project with 10 units\./);
  assert.doesNotMatch(text,/330 proposed units/);
  assert.match(text,/240 rental and 60 condo units, 20% condo\. The other 30 units have no tenure on record yet\./);
  assert.match(text,/In ZIP 11211: 25 approved or permitted projects with 1,500 proposed units, and 400 units at other stages\./);
  assert.match(text,/On this lot: new building job B00123456, approved or permitted, 12 units\./);
  assert.equal(view.querySelectorAll('.nearby-pipeline-projects li').length,8);
  assert.match(text,/Showing the 8 largest of 9 projects\./);
  const job=view.querySelector('.nearby-pipeline-projects a');
  assert.equal(job.href,read.projects[0].link);
  assert.equal(job.target,'_blank');
  assert.equal(job.rel,'noopener noreferrer');
  assert.match(text,/Rental/);
  assert.match(text,/Major alteration/);
  assert.doesNotMatch(text,/—/,'no em dashes in visible copy');
});

test('the section says when nothing is filed, when no tenure is on record and when it cannot be shown',t=>{
  dom(t);
  const empty=renderNearbyPipeline({...read,projects:[],projectCount:0,onSubjectLot:[],sameZip:null,nearby:{...read.nearby,projects:0,units:0,floorArea:0,tenure:tenure(0,0),condoShareOfStatedUnits:null}});
  assert.match(empty.textContent,/No new building or major alteration filed or acted on within half a mile since Oct 2023\./);
  const unstated=renderNearbyPipeline({...read,nearby:{...read.nearby,tenure:tenure(0,0),condoShareOfStatedUnits:null}});
  assert.match(unstated.textContent,/No HPD or condo declaration record says yet whether these homes will be rentals or condos\./);
  assert.match(renderNearbyPipeline({available:false,reason:'unsynced'}).textContent,/not available yet/);
  assert.match(renderNearbyPipeline({available:false,reason:'no_location'}).textContent,/no map location/);
  assert.match(renderNearbyPipeline(null).textContent,/Loading DOB filings nearby/);
});

test('the query carries the location, ZIP and lot, and needs coordinates',()=>{
  assert.equal(nearbyPipelineQuery({latitude:'40.71',longitude:'-73.96',zip:'11211',bbl:'3023000010'}),'lat=40.71&lng=-73.96&zip=11211&bbl=3023000010');
  assert.equal(nearbyPipelineQuery({latitude:null,longitude:'-73.96'}),null);
  assert.equal(nearbyPipelineQuery({}),null);
});

test('the listing shows the nearby pipeline from its detail response, and older responses show nothing',t=>{
  dom(t);
  const row={id:'nearby',address:'1 Test Street',bbl:'3023000001',borough:'BK',maxUapZfa:6800,flashcardValuation:{},similarComps:[]};
  const options={canStart:()=>true,onUnderwrite(){},onAsk(){},onClose(){}};
  assert.match(renderInspector({...row,nearbyPipeline:read},options).querySelector('.nearby-pipeline').textContent,/280 proposed units/);
  assert.equal(renderInspector(row,options).querySelector('.nearby-pipeline'),null);
});

test('the site page shows the nearby pipeline once the parcel is located',t=>{
  dom(t);
  const state={id:'p1',version:1,title:'Site',fields:{}};
  assert.equal(renderParcel(state,{}).querySelector('.nearby-pipeline'),null);
  assert.match(renderParcel(state,{nearbyPipeline:null}).querySelector('.nearby-pipeline').textContent,/Loading/);
  assert.match(renderParcel(state,{nearbyPipeline:read}).querySelector('.nearby-pipeline').textContent,/Within half a mile/);
});

test('the report lists nearby development beside the news in its site chapter with a link to each DOB job',t=>{
  dom(t);
  const project={id:'p1',title:'Site',fields:{property:{value:{bbl:'3023000001',address:'1 TEST STREET',borough:'BK',zipcode:'11211'}}}};
  const report=renderReport(reportModel({project,nearby:read}));
  const market=report.querySelector('#report-site');
  assert.match(market.textContent,/Nearby development/);
  assert.match(market.textContent,/Within half a mile, filed or acted on since Oct 2023: 7 approved or permitted projects with 280 proposed units/);
  assert.match(market.textContent,/Not counted above: In DOB review, 1 project with 40 units/);
  assert.equal(market.querySelectorAll('table[aria-label="Nearby development"] tbody tr').length,8);
  assert.equal(market.querySelector('table[aria-label="Nearby development"] a').href,read.projects[0].link);
  assert.doesNotMatch(renderReport(reportModel({project,nearby:{available:false}})).textContent,/Nearby development/,'an unavailable pipeline leaves the block out');
});

test('the web server proxies the nearby pipeline with its query',()=>{
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(server,/app\.get\('\/api\/nearby-pipeline',\(req,res\)=>proxy\(req,res,`\/nearby-pipeline\$\{querySuffix\(req\)\}`\)\);/);
  const core=readFileSync(new URL('../public/core.js',import.meta.url),'utf8');
  assert.match(core,/api\.get\(`\/nearby-pipeline\?\$\{query\}`\)/);
  const report=readFileSync(new URL('../public/report-view.js',import.meta.url),'utf8');
  assert.match(report,/chatRequest\(`\/nearby-pipeline\?\$\{nearbyQuery\}`\)/);
});
