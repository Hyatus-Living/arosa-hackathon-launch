import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleSite,fetchLotGeometry} from './assembly.mjs';

const A='1000010001',B='1000010002',OTHER='1000010099',bbls=[A,B];
const lat=40.708,lon=-74.01;
const point=(x,z)=>[lon+x*.3048/(111320*Math.cos(lat*Math.PI/180)),lat-z*.3048/111320];
const ring=(x,z,w=50,h=100)=>[point(x,z),point(x+w,z),point(x+w,z+h),point(x,z+h),point(x,z)];
const row=bbl=>({bbl,address:`Lot ${bbl}`,lotarea:'5000',bldgarea:'0',builtfar:'0',zonedist1:'C6-9'});
const feature=(bbl,rings=[ring(0,0)])=>({properties:{BBL:bbl},geometry:{type:'Polygon',coordinates:rings}});
const part=polygon=>({polygon,holes:[]});
const geometry=()=>new Map([[A,[part(ring(0,0))]],[B,[part(ring(50,0))]]]);
const assembled={parts:[{polygon:[[0,0],[100,0],[100,100],[0,100],[0,0]],holes:[],areaSqft:10000}],totalAreaSqft:10000,singlePolygon:true,pairs:[]};
function setup(overrides={}){
  const c={geometryCalls:0,requests:[]};
  c.deps={findParcel:async bbl=>({rows:[row(bbl)]}),fetchGeometry:async()=>{c.geometryCalls++;return geometry();},run:async request=>{c.requests.push(request);return assembled;},...overrides};
  return c;
}

test('a missing exact parcel match fails before geometry or assembly instead of borrowing another row',async()=>{
  const c=setup({findParcel:async()=>({rows:[row(OTHER)]})});
  await assert.rejects(assembleSite({bbls},c.deps),/No PLUTO parcel matched BBL 1000010001/);
  assert.equal(c.geometryCalls,0);assert.equal(c.requests.length,0);
});

test('an exact row after unrelated candidates supplies the selected parcel metadata in requested order',async()=>{
  const c=setup({findParcel:async bbl=>({rows:[row(OTHER),row(bbl)]})});
  const result=await assembleSite({bbls:[B,A]},c.deps);
  assert.deepEqual(result.parcels.map(p=>p.bbl),[B,A]);
  assert.deepEqual(result.parcels.map(p=>p.address),[`Lot ${B}`,`Lot ${A}`]);
  assert.deepEqual(c.requests[0].parcels.map(p=>p.bbl),[B,A]);
});

test('a fractional parcel identifier cannot be truncated into the selected BBL',async()=>{
  const c=setup({findParcel:async bbl=>({rows:[row(`${bbl}.5`)]})});
  await assert.rejects(assembleSite({bbls},c.deps),/No PLUTO parcel matched/);
  assert.equal(c.geometryCalls,0);assert.equal(c.requests.length,0);
});

test('conflicting exact parcel records are reported as ambiguous before assembly',async()=>{
  const c=setup({findParcel:async bbl=>({rows:[row(bbl),{...row(bbl),address:'Different source record',lotarea:'9000'}]})});
  await assert.rejects(assembleSite({bbls},c.deps),/ambiguous|multiple PLUTO/i);
  assert.equal(c.geometryCalls,0);assert.equal(c.requests.length,0);
});

test('numeric and zero-decimal provider identifiers retain the same exact BBL identity',async()=>{
  const c=setup({findParcel:async bbl=>({rows:[row(bbl===A?Number(A):` ${B}.000 `)]})});
  const result=await assembleSite({bbls},c.deps);
  assert.deepEqual(result.parcels.map(p=>p.bbl),bbls);
  const map=await fetchLotGeometry(bbls,async()=>({features:[feature(Number(A)),feature(` ${B}.000 `)]}));
  assert.deepEqual([...map.keys()],bbls);
});

test('MapPLUTO geometry retains only the BBLs requested by the batch',async()=>{
  let query;
  const map=await fetchLotGeometry(bbls,async url=>{query=new URL(url);return {features:[feature(OTHER),feature(A),feature(B,[ring(50,0)])]};});
  assert.equal(query.searchParams.get('where'),`BBL IN (${A},${B})`);
  assert.deepEqual([...map.keys()],bbls);
});

test('fractional geometry identifiers do not impersonate a selected parcel',async()=>{
  const map=await fetchLotGeometry(bbls,async()=>({features:[feature(`${A}.75`),feature(B)]}));
  assert.equal(map.has(A),false);assert.equal(map.has(B),true);
});

test('non-scalar geometry identifiers are not coerced into valid parcel identities',async()=>{
  const map=await fetchLotGeometry(bbls,async()=>({features:[[A],{id:A},null,true,'',`0x${Number(A).toString(16)}`].map(value=>feature(value))}));
  assert.equal(map.size,0);
});

test('several geometry features for the same selected BBL retain all of its parts',async()=>{
  const first=ring(0,0,20,20),second=ring(30,0,20,20);
  const map=await fetchLotGeometry(bbls,async()=>({features:[feature(A,[first]),feature(A,[second]),feature(B)]}));
  assert.equal(map.get(A).length,2);assert.deepEqual(map.get(A),[part(first),part(second)]);
});

test('unrequested dependency geometry cannot shift the selected assembly origin',async()=>{
  const extra=geometry();extra.set(OTHER,[part(ring(-10000,-10000))]);
  const c=setup({fetchGeometry:async()=>extra});
  await assembleSite({bbls},c.deps);
  const points=c.requests[0].parcels.flatMap(p=>p.polygons.flatMap(part=>part.polygon));
  assert.equal(Math.min(...points.map(p=>p[0])),0);assert.equal(Math.min(...points.map(p=>p[1])),0);
  assert.equal(Math.max(...points.map(p=>p[0])),100);assert.equal(Math.max(...points.map(p=>p[1])),100);
  assert.equal(extra.size,3,'the provider geometry map is not mutated');
});

test('missing geometry for any selected parcel prevents a partial assembly',async()=>{
  const c=setup({fetchGeometry:async()=>new Map([[A,[part(ring(0,0))]],[OTHER,[part(ring(50,0))]]])});
  await assert.rejects(assembleSite({bbls},c.deps),/no lot polygon for BBL 1000010002/);
  assert.equal(c.requests.length,0);
});

test('the geometry query rejects malformed BBLs before issuing a provider request',async()=>{
  let requests=0;
  await assert.rejects(fetchLotGeometry([A,`${B} OR 1=1`],async()=>{requests++;return {features:[]};}),/valid.*BBL/i);
  assert.equal(requests,0);
});
