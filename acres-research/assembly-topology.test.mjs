import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleSite,fetchLotGeometry,toLocalFeet,snapTaxLotOutline,taxLotOutline} from './assembly.mjs';
import {buildUnderwritingDeck} from './deliverable.mjs';
const A='1000010001',B='1000010002',lat=40.708,lon=-74.01;
const point=(x,z)=>[lon+x*.3048/(111320*Math.cos(lat*Math.PI/180)),lat-z*.3048/111320];
const ring=(x,z,w,h)=>[point(x,z),point(x+w,z),point(x+w,z+h),point(x,z+h),point(x,z)];
const flat=(x,z,w,h)=>[[x,z],[x+w,z],[x+w,z+h],[x,z+h],[x,z]];
const feature=(bbl,coordinates,type='Polygon')=>({properties:{BBL:bbl},geometry:{type,coordinates}});
const shell=ring(0,0,100,100),hole=ring(20,20,20,20),neighbour=ring(100,0,50,100);
const source=[feature(A,[shell,hole]),feature(B,[neighbour])];
const merged={polygon:flat(0,0,150,100),holes:[flat(20,20,20,20)],areaSqft:14600};
async function assemble(parts=[merged],features=source){
  let request;
  const result=await assembleSite({bbls:[A,B]}, {
    findParcel:async bbl=>({rows:[{bbl,lotarea:bbl===A?10000:5000}]}),
    fetchGeometry:bbls=>fetchLotGeometry(bbls,async()=>({features})),
    run:async packet=>{request=packet;return {parts,totalAreaSqft:parts.reduce((sum,p)=>sum+p.areaSqft,0),singlePolygon:parts.length===1,pairs:[]};},
  });return {result,request};
}

test('MapPLUTO retains a parcel shell and its hole as one polygon',async()=>{
  const map=await fetchLotGeometry([A],async()=>({features:[source[0]]}));
  assert.deepEqual(map.get(A),[{polygon:shell,holes:[hole]}]);
});
test('MultiPolygon retains each hole under its own exterior',async()=>{
  const second=ring(200,0,50,50),secondHole=ring(210,10,10,10);
  const map=await fetchLotGeometry([A],async()=>({features:[feature(A,[[shell,hole],[second,secondHole]],'MultiPolygon')]}));
  assert.deepEqual(map.get(A),[{polygon:shell,holes:[hole]},{polygon:second,holes:[secondHole]}]);
});
test('shell and hole project into the same local feet frame',()=>{
  const input=new Map([[A,[{polygon:shell,holes:[hole]}]],[B,[{polygon:neighbour,holes:[]}]]]);
  const local=toLocalFeet(input);
  assert.deepEqual(local.get(A)[0],{polygon:flat(0,0,100,100),holes:[flat(20,20,20,20)]});
  assert.deepEqual(local.get(B)[0],{polygon:flat(100,0,50,100),holes:[]});
});
test('a tax lot snaps to the frontage edge by default and to a corrected front edge on request',async()=>{
  // An L-shaped lot in local feet (x east, z south): a 100 ft north edge, a 50 ft south edge.
  const polygon=[[0,0],[100,0],[100,50],[50,50],[50,100],[0,100],[0,0]];
  const parts=[{polygon,holes:[]}];
  const area=poly=>Math.abs(poly.reduce((sum,p,i)=>sum+p[0]*poly[(i+1)%poly.length][1]-poly[(i+1)%poly.length][0]*p[1],0))/2;
  const snapped=snapTaxLotOutline(parts,{frontageFeet:100});
  assert.equal(snapped.frontEdgeIndex,0);
  assert.deepEqual(snapped.polygon,polygon.slice(0,-1),'the north frontage is already the frame front');
  assert.deepEqual([snapped.widthFeet,snapped.depthFeet],[100,100]);
  assert.deepEqual(snapped.edges.map(e=>e.compass),['north','east','south','east','south','west']);
  assert.equal(area(snapped.polygon),7500);
  // Correcting the front to the south edge turns the lot around; area and shape are preserved.
  const corrected=snapTaxLotOutline(parts,{frontEdge:'south'});
  assert.equal(corrected.frontEdgeIndex,4);
  assert.deepEqual(corrected.polygon,[[50,100],[-50,100],[-50,50],[0,50],[0,0],[50,0]]);
  assert.equal(area(corrected.polygon),7500);
  assert.equal(snapTaxLotOutline(parts,{frontEdge:4}).frontEdgeIndex,4);
  assert.throws(()=>snapTaxLotOutline(parts,{frontEdge:9}),/not an edge of this lot/);
  assert.throws(()=>snapTaxLotOutline([parts[0],parts[0]],{}),/exactly one MapPLUTO polygon part/);
  // Through MapPLUTO geometry: the same shell as the topology fixture, frontage-matched.
  const outline=await taxLotOutline(A,{frontageFeet:100,request:async()=>({features:[feature(A,[shell])]})});
  assert.equal(outline.widthFeet,100);
  assert.equal(outline.polygon.length,4);
  assert.equal(await taxLotOutline(A,{request:async()=>({features:[]})}),null,'no geometry, no outline');
});
test('the assembly engine receives polygon topology and the result retains parcel and union holes',async()=>{
  const {result,request}=await assemble();
  assert.deepEqual(request.parcels[0].polygons[0].holes,[flat(20,20,20,20)]);
  assert.deepEqual(result.parcels[0].polygons[0].holes,[flat(20,20,20,20)]);
  assert.deepEqual(result.assembled.parts[0].holes,[flat(20,20,20,20)]);
});
test('a hole-bearing assembly does not expose its exterior as a complete model outline',async()=>{
  const {result}=await assemble();assert.equal(result.assembled.polygon,null);
  assert.equal(result.assembled.singlePolygon,true);assert.equal(result.assembled.hasHoles,true);
});
test('a disconnected assembly does not expose only its largest part as the model outline',async()=>{
  const {result}=await assemble([{polygon:flat(0,0,100,100),holes:[],areaSqft:10000},{polygon:flat(200,0,50,100),holes:[],areaSqft:5000}]);
  assert.equal(result.assembled.polygon,null);assert.equal(result.assembled.partsCount,2);assert.equal(result.assembled.hasHoles,false);
});
test('a single hole-free assembly still exposes its complete outline',async()=>{
  const polygon=flat(0,0,150,100),{result}=await assemble([{polygon,holes:[],areaSqft:15000}]);
  assert.deepEqual(result.assembled.polygon,polygon);assert.equal(result.assembled.hasHoles,false);
});
test('a malformed source hole is rejected instead of being dropped from an otherwise valid shell',async()=>{
  await assert.rejects(fetchLotGeometry([A],async()=>({features:[feature(A,[shell,[[0,0],[1,0],[1,1]]])]})),/invalid.*(polygon|ring)/i);
});
test('a non-finite coordinate in a source hole cannot become filled parcel area',async()=>{
  const bad=hole.map(p=>[...p]);bad[1][0]=NaN;
  await assert.rejects(fetchLotGeometry([A],async()=>({features:[feature(A,[shell,bad])]})),/invalid.*(polygon|ring)/i);
});
test('topology projection leaves provider geometry unchanged',async()=>{
  const before=JSON.stringify(source);await assemble();assert.equal(JSON.stringify(source),before);
});
test('the report uses the assembly net area rather than the exterior or PLUTO total',async()=>{
  const {result}=await assemble();
  const deck=buildUnderwritingDeck({projectState:{assembly:{value:result,stale:null,updated:1,provenance:{sources:[]}}}});
  assert.equal(deck.slides[1].assembly.combinedLotAreaSqft,14600);assert.equal(result.assembled.areaDeltaSqft,-400);
});
