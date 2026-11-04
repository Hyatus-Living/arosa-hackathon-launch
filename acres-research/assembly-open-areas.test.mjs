import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {assembleSite,fetchLotGeometry,openAreaRules,spawnAssembler} from './assembly.mjs';
import {planningCommand} from './planning.mjs';

const A='1000010001',B='1000010002',lat=40.708,lon=-74.01;
const point=(x,z)=>[lon+x*.3048/(111320*Math.cos(lat*Math.PI/180)),lat-z*.3048/111320];
const ring=(x,z,w,h)=>[point(x,z),point(x+w,z),point(x+w,z+h),point(x,z+h),point(x,z)];
const feature=(bbl,coordinates)=>({properties:{BBL:bbl},geometry:{type:'Polygon',coordinates}});
// A 100 x 150 ft lot with a 20 x 20 ft courtyard beside a 50 x 150 ft lot, fronting a street to the south.
const courtyard=[feature(A,[ring(0,0,100,150),ring(40,60,20,20)]),feature(B,[ring(100,0,50,150)])];
const skip=existsSync(planningCommand().python)?false:'planning/.venv is not installed';

function site(args,{zoning={[A]:['R7A'],[B]:['R7A']},run}={}){
  let request;
  const result=assembleSite({bbls:[A,B],...args},{
    findParcel:async bbl=>({rows:[{bbl,lotarea:bbl===A?15000:7500,zonedist1:zoning[bbl][0],zonedist2:zoning[bbl][1]}]}),
    fetchGeometry:bbls=>fetchLotGeometry(bbls,async()=>({features:courtyard})),
    run:async packet=>{request=packet;return run?run(packet):{parts:[],totalAreaSqft:0,singlePolygon:true,pairs:[],...(packet.openAreas?{openAreas:{bands:[]}}:{})};},
  });
  return result.then(out=>({result:out,request}));
}

test('residential open-area rules come from the curated rear yard, equivalent and inner court figures',()=>{
  const rule=openAreaRules('R7A');
  assert.equal(rule.use,'residential');assert.equal(rule.rearYardEquivalentMinLotDepthFeet,110);
  assert.deepEqual(rule.bands.map(b=>[b.fromFeet,b.toFeet,b.rearYardFeet,b.rearYardEquivalentFeet,b.court.minAreaSqft,b.court.minDimensionFeet]),[[0,75,20,40,800,20],[75,null,30,60,1200,30]]);
  const low=openAreaRules('R4');
  assert.deepEqual(low.bands.map(b=>[b.rearYardFeet,b.frontYardFeet,b.sideYardFeet]),[[20,10,0]]);
  const commercial=openAreaRules('C6-2A','commercial');
  assert.deepEqual(commercial.bands.map(b=>[b.fromFeet,b.toFeet,b.rearYardFeet,b.rearYardEquivalentFeet,b.court]),[[0,23,0,0,null],[23,null,20,0,null]]);
  assert.equal(openAreaRules('C6-2A').use,'commercial');assert.equal(openAreaRules('C6-2A','residential').bands[1].rearYardFeet,30);
  // C4-4 takes R7-2's residential bulk (ZR 34-112); a district with no curated or listed equivalent is refused.
  assert.deepEqual(openAreaRules('C4-4','residential').bands.map(b=>[b.fromFeet,b.toFeet,b.rearYardFeet]),[[0,75,20],[75,null,30]]);
  assert.throws(()=>openAreaRules('C8-2'),/No curated bulk rules for C8-2/);
});

test('street sides send the district open-area rules to the assembly engine and return its open areas',async()=>{
  const {result,request}=await site({streets:['south']});
  assert.deepEqual(request.openAreas.streets,['south']);
  assert.deepEqual(request.openAreas.bands,openAreaRules('R7A').bands);
  assert.equal(result.openAreas.district,'R7A');assert.ok(result.openAreas.checks.some(c=>/ZR 23-352/.test(c)));
  assert.ok(result.openAreas.sections.includes('ZR 23-342'));
  const {result:plain,request:bare}=await site({});
  assert.equal(bare.openAreas,undefined);assert.equal(plain.openAreas,undefined);
});

test('open areas need valid street sides and one district',async()=>{
  await assert.rejects(site({streets:['front']}),/streets lists the sides/);
  await assert.rejects(site({streets:['south','south']}),/streets lists the sides/);
  await assert.rejects(site({streets:['south']},{zoning:{[A]:['R7A'],[B]:['R6']}}),/zoned R7A, R6; give district/);
  const {request}=await site({streets:['south'],district:'R6'},{zoning:{[A]:['R7A'],[B]:['R6']}});
  assert.deepEqual(request.openAreas.bands,openAreaRules('R6').bands);
});

test('a courtyard assemblage footprint excludes the courtyard and the required rear yard',{skip},async()=>{
  const {result}=await site({streets:['south']},{run:packet=>spawnAssembler(packet)});
  const [low,high]=result.openAreas.bands;
  assert.equal(result.assembled.hasHoles,true);
  // 22,500 sq ft less the 400 sq ft courtyard, a 150 x 20 ft rear yard and 20 ft yards on the courtyard's two rear lot lines.
  assert.ok(Math.abs(low.footprintAreaSqft-18300)<=2,`${low.footprintAreaSqft}`);
  assert.ok(Math.abs(low.rearYardAreaSqft-3800)<=2,`${low.rearYardAreaSqft}`);
  assert.equal(low.footprint[0].holes.length,1);
  assert.equal(low.courts.length,1);assert.equal(low.courts[0].meetsMinimum,true);
  assert.ok(Math.abs(high.footprintAreaSqft-16400)<=2,`${high.footprintAreaSqft}`);
});
