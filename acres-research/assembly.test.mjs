import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assembleSite, createAssemblyTools, toLocalFeet} from './assembly.mjs';

const lat0 = 40.708, lon0 = -74.01;
const fx = ft => lon0 + (ft * 0.3048) / (111320 * Math.cos((lat0 * Math.PI) / 180));
const fz = ft => lat0 - (ft * 0.3048) / 111320;
const ring = (x0, z0, x1, z1) => [[fx(x0), fz(z0)], [fx(x1), fz(z0)], [fx(x1), fz(z1)], [fx(x0), fz(z1)], [fx(x0), fz(z0)]];
const rows = {
  '1000010001': {bbl: '1000010001', address: '1 TEST ST', borough: 'MN', zonedist1: 'C6-9', lotarea: '5000', bldgarea: '9000', builtfar: '1.8'},
  '1000010002': {bbl: '1000010002', address: '3 TEST ST', borough: 'MN', zonedist1: 'C6-9', lotarea: '5000', bldgarea: '0', builtfar: '0'},
};
const findParcel = async bbl => ({rows: rows[bbl] ? [rows[bbl]] : []});
const part = polygon => ({polygon, holes: []});
const fetchGeometry = async () => new Map([['1000010001', [part(ring(0, 0, 50, 100))]], ['1000010002', [part(ring(50, 0, 100, 100))]]]);

test('parcels project into one local feet frame and assemble with PLUTO context', async () => {
  let request;
  const out = await assembleSite(
    {bbls: ['1000010001', '1000010002'], treatAsOneZoningLot: true},
    {findParcel, fetchGeometry, run: async req => { request = req; return {parts: [{polygon: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], holes: [], areaSqft: 10000}], totalAreaSqft: 10000, singlePolygon: true, toleranceFeet: 0.8, pairs: [{a: '1000010001', b: '1000010002', distanceFeet: 0, sharedBoundaryFeet: 100.4, touches: true}]}; }},
  );
  const first = request.parcels[0].polygons[0].polygon;
  assert.ok(Math.abs(Math.min(...first.map(p => p[0]))) < 0.2);
  assert.ok(Math.abs(Math.max(...first.map(p => p[0])) - 50) < 0.2);
  assert.ok(Math.abs(Math.max(...first.map(p => p[1])) - 100) < 0.2);
  assert.equal(out.assembled.totalAreaSqft, 10000);
  assert.equal(out.assembled.plutoLotAreaTotalSqft, 10000);
  assert.equal(out.assembled.areaDeltaSqft, 0);
  assert.equal(out.assembled.singlePolygon, true);
  assert.deepEqual(out.zoningDistricts, ['C6-9']);
  assert.equal(out.treatAsOneZoningLot, true);
  assert.match(out.note, /does not create a zoning lot/);
});

test('validation, missing data and gating fail plainly', async () => {
  const deps = {findParcel, fetchGeometry, run: async () => ({parts: [], totalAreaSqft: 0, singlePolygon: false, pairs: []})};
  await assert.rejects(assembleSite({bbls: ['1000010001']}, deps), /two to eight/);
  await assert.rejects(assembleSite({bbls: ['1000010001', '1000010001']}, deps), /may appear once/);
  await assert.rejects(assembleSite({bbls: ['1000010001', '9999999999']}, deps), /not one|No PLUTO/);
  await assert.rejects(assembleSite({bbls: ['1000010001', '1000010002']}, {...deps, fetchGeometry: async () => new Map()}), /no lot polygon/);
  assert.deepEqual(createAssemblyTools({findParcel, available: false}).definitions, []);
  const tools = createAssemblyTools({findParcel, available: true, run: deps.run});
  assert.equal(tools.definitions[0].name, 'acres_assemble_site');
});

test('toLocalFeet translates the north-west extent to the origin', () => {
  const local = toLocalFeet(new Map([['1000010001', [part(ring(30, 40, 80, 140))]]]));
  const points = local.get('1000010001')[0].polygon;
  assert.equal(Math.min(...points.map(p => p[0])), 0);
  assert.equal(Math.min(...points.map(p => p[1])), 0);
});

test('the research host installer ships the assembly module and sidecar consumers', () => {
  const installer = readFileSync(new URL('../infra/acres-deploy-research', import.meta.url), 'utf8');
  assert.match(installer, /\bassembly\.mjs\b/);
  assert.match(installer, /\bplanning\.mjs\b/);
});

test('independent parcel reads overlap at a bounded four and geometry waits for all exact matches',async()=>{
  const bbls=Array.from({length:8},(_,i)=>`100001000${i+1}`),releases=[];let active=0,maximum=0,started=0,geometry=false;
  const read=bbl=>new Promise(resolve=>{started++;active++;maximum=Math.max(maximum,active);releases.push(()=>{active--;resolve({rows:[{bbl,lotarea:1000}]});});});
  const pending=assembleSite({bbls},{findParcel:read,fetchGeometry:async()=>{geometry=true;throw new Error('geometry reached after reads');},run:async()=>{throw new Error('unreachable');}});
  assert.equal(started,4);assert.equal(geometry,false);releases.splice(0).forEach(fn=>fn());
  await new Promise(resolve=>setImmediate(resolve));assert.equal(started,8);assert.equal(geometry,false);releases.splice(0).forEach(fn=>fn());
  await assert.rejects(pending,/geometry reached/);assert.equal(maximum,4);assert.equal(active,0);
});

test('cancellation drains in-flight parcel reads and starts no next batch or geometry',async()=>{
  const {withExecutionSignal}=await import('./execution-context.mjs');
  const controller=new AbortController(),releases=[];let started=0,geometry=false;
  const bbls=Array.from({length:8},(_,i)=>`100001000${i+1}`);
  const pending=withExecutionSignal(controller.signal,()=>assembleSite({bbls},{findParcel:bbl=>new Promise(resolve=>{started++;releases.push(()=>resolve({rows:[{bbl}]}));}),fetchGeometry:async()=>{geometry=true;},run:async()=>{}}));
  controller.abort(new Error('controlled stop'));releases.forEach(fn=>fn());await assert.rejects(pending,/controlled stop/);
  assert.equal(started,4);assert.equal(geometry,false);
});

test('a parcel PLUTO shows a building on without its area has an unknown built floor area, not zero', async () => {
  const gapRows = {'1000010001': {...rows['1000010001'], bldgarea: '0', builtfar: '0', numbldgs: '1'}, '1000010002': rows['1000010002']};
  const out = await assembleSite({bbls: ['1000010001', '1000010002']}, {findParcel: async bbl => ({rows: [gapRows[bbl]]}), fetchGeometry, run: async () => ({parts: [{polygon: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], holes: [], areaSqft: 10000}], totalAreaSqft: 10000, singlePolygon: true, pairs: []})});
  assert.deepEqual(out.parcels.map(p => [p.builtFloorAreaSqft, p.builtFar]), [[null, null], [0, 0]]);
});
