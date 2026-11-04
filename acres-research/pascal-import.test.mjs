import assert from 'node:assert/strict';
import test from 'node:test';
import {pascalSceneToPlan} from './pascal-import.mjs';
import {sniffDrawing} from './architecture-drawings.mjs';

const node = (id, type, extra = {}) => ({object: 'node', id, type, name: id, parentId: null, visible: true, ...extra});
const scene = {nodes: {
  site_1: node('site_1', 'site', {metadata: {acresId: 'site'}}),
  building_1: node('building_1', 'building', {name: 'Unit 4B', parentId: 'site_1', metadata: {acresId: 'building'}}),
  level_1: node('level_1', 'level', {name: 'Level 1', parentId: 'building_1', metadata: {acresId: 'level-1'}, level: 0, baseElevation: 0, height: 2.8}),
  slab_1: node('slab_1', 'slab', {parentId: 'level_1', metadata: {acresId: 'level-1:slab'}, thickness: 0.25, polygon: [[0, 0], [10, 0], [10, -8], [0, -8]]}),
  wall_s: node('wall_s', 'wall', {name: 'wall-south', parentId: 'level_1', metadata: {acresId: 'wall-south', material: 'generic'}, start: [0, 0], end: [10, 0], thickness: 0.18, height: 2.8, children: ['door_1', 'win_1']}),
  wall_n: node('wall_n', 'wall', {name: 'wall-north', parentId: 'level_1', metadata: {acresId: 'wall-north'}, start: [10, -8], end: [0, -8], thickness: 0.18, height: 2.8}),
  wall_w: node('wall_w', 'wall', {parentId: 'level_1', start: [0, -8], end: [0, 0], thickness: 0.18, height: 2.8}),
  wall_e: node('wall_e', 'wall', {parentId: 'level_1', start: [10, 0], end: [10, -8], thickness: 0.18, height: 2.8}),
  door_1: node('door_1', 'door', {name: 'opening-entry', parentId: 'wall_s', wallId: 'wall_s', metadata: {acresId: 'opening-entry', swing: 'left'}, position: [5, 1.05, 0], width: 0.9, height: 2.1}),
  win_1: node('win_1', 'window', {parentId: 'wall_s', wallId: 'wall_s', position: [2, 1.55, 0], width: 2.4, height: 1.3}),
  zone_1: node('zone_1', 'zone', {name: 'Living', parentId: 'level_1', metadata: {acresId: 'room-living'}, polygon: [[0, 0], [10, 0], [10, -8], [0, -8]], boundaryWallIds: ['wall_s', 'wall_n', 'wall_w', 'wall_e']}),
  item_1: node('item_1', 'item', {parentId: 'level_1'}),
}, rootNodeIds: ['site_1']};

test('a Pascal scene converts back to plan v1 with identities and ground flipped to plan north', () => {
  const {plan, warnings} = pascalSceneToPlan(scene);
  assert.equal(plan.schema, 'acres.architecture.plan/1');
  assert.equal(plan.name, 'Unit 4B');
  assert.deepEqual(plan.levels, [{id: 'level-1', name: 'Level 1', elevation: 0, height: 2.8, slabThickness: 0.25}]);
  const south = plan.walls.find(w => w.id === 'wall-south');
  assert.deepEqual(south.start, [0, 0]); assert.deepEqual(south.end, [10, 0]);
  const north = plan.walls.find(w => w.id === 'wall-north');
  assert.deepEqual(north.start, [10, 8], 'ground -z becomes plan +y (north)');
  assert.ok(plan.walls.every(w => w.id.startsWith('wall-')), 'editor-created walls get pascal ids when no acresId rides along');
  const door = plan.openings.find(o => o.id === 'opening-entry');
  assert.equal(door.wallId, 'wall-south');
  assert.equal(door.offset, 4.55); assert.equal(door.sill, 0); assert.equal(door.swing, 'left');
  const win = plan.openings.find(o => o.kind === 'window');
  assert.equal(win.offset, 0.8); assert.equal(win.sill, 0.9);
  assert.deepEqual(plan.rooms.map(r => r.id), ['room-living']);
  assert.deepEqual(plan.rooms[0].polygon, [[0, 0], [10, 0], [10, 8], [0, 8]]);
  assert.deepEqual(south.roomIds, ['room-living']);
  assert.ok(warnings.some(w => /item/.test(w)), 'dropped kinds are reported');
});

test('net zone rings from an Acres-exported file snap out to the wall centrelines', () => {
  const net = JSON.parse(JSON.stringify(scene));
  // Inside-wall-faces ring: inset 0.09 (half the 0.18 wall) from every centreline.
  net.nodes.zone_1.polygon = [[0.09, -0.09], [9.91, -0.09], [9.91, -7.91], [0.09, -7.91]];
  const {plan} = pascalSceneToPlan(net);
  assert.deepEqual(plan.rooms[0].polygon, [[0, 0], [10, 0], [10, 8], [0, 8]]);
});

test('unimportable scenes fail closed instead of producing a partial plan silently', () => {
  assert.throws(() => pascalSceneToPlan(null), /JSON object/);
  assert.throws(() => pascalSceneToPlan({nodes: {}}), /1 to/);
  assert.throws(() => pascalSceneToPlan({nodes: {a: node('a', 'site')}}), /no levels/);
  const {warnings} = pascalSceneToPlan({nodes: {l: node('l', 'level', {height: 3}), w: node('w', 'wall', {parentId: 'l', start: [0, 0], end: [4, 0]})}});
  assert.ok(warnings.some(w => /no room zones/.test(w)));
});

test('drawing sniffing recognizes Pascal scene JSON by its bytes', () => {
  assert.equal(sniffDrawing(Buffer.from('{"nodes":{"a":{}}}')), 'pascal-scene');
  assert.equal(sniffDrawing(Buffer.from('  {"other":1}')), null);
  assert.equal(sniffDrawing(Buffer.from('<svg xmlns="x"></svg>')), 'svg');
});
