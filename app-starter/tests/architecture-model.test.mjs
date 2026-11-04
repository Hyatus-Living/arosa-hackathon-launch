import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PropertyBinding} from 'three';
import {
  architectureReducer, cameraStops, dragLook, entrance, groundHeight, initialArchitectureState, nodeName, pickRoom,
  pointInPolygon, resolveMove, roomAt, selectionIndex, sliceSegments, stepWalker, storeyLifts, storyFrame, unitCards, unitCheck,
  EXPLODE_GAP, STORY_CUT, levelTop,
} from '../frontend/architecture-model.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/architecture/${name}`, import.meta.url), 'utf8'));
const plan = fixture('sample-plan.json');
const manifest = fixture('sample-manifest.json');

// Triangles of an axis-aligned box, nine numbers per triangle, in world metres (y up).
function boxTriangles([x0, y0, z0], [x1, y1, z1]) {
  const c = (i, j, k) => [[x0, x1][i], [y0, y1][j], [z0, z1][k]];
  const quads = [
    [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0)], [c(0, 0, 1), c(0, 1, 1), c(1, 1, 1), c(1, 0, 1)],
    [c(0, 0, 0), c(0, 1, 0), c(0, 1, 1), c(0, 0, 1)], [c(1, 0, 0), c(1, 0, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1)], [c(0, 0, 0), c(0, 0, 1), c(1, 0, 1), c(1, 0, 0)],
  ];
  return quads.flatMap(([a, b, cc, d]) => [...a, ...b, ...cc, ...a, ...cc, ...d]);
}

test('node names are sanitized exactly like the glTF loader does', () => {
  for (const name of ['Wall.001', 'Room A/1', 'door:entry [main]', 'floor-living']) {
    assert.equal(nodeName(name), PropertyBinding.sanitizeNodeName(name));
  }
});

test('the manifest maps rooms to their nodes and picks resolve through ancestors', () => {
  const index = selectionIndex(manifest);
  assert.deepEqual(index.rooms.get('kitchen'), ['floor-kitchen']);
  assert.equal(index.objects.get('wall-south').kind, 'wall');
  assert.equal(index.walls.size, 8);
  assert.equal(index.floors.size, 5);
  // A pick on an unnamed child mesh resolves to the nearest named ancestor in the manifest.
  assert.equal(pickRoom(index, ['', 'floor-bedroom-a', 'apartment']).roomId, 'bedroom-a');
  assert.deepEqual(pickRoom(index, ['wall-north', 'apartment']), {objectName: 'wall-north', roomId: null, levelId: 'level-1'});
  assert.equal(pickRoom(index, ['apartment']), null);
});

test('slicing a box at a height yields its outline and nothing above it', () => {
  const box = boxTriangles([0, 0, 0], [2, 1, 1]);
  const segments = sliceSegments(box, 0.5);
  const length = segments.reduce((sum, [ax, az, bx, bz]) => sum + Math.hypot(bx - ax, bz - az), 0);
  assert.ok(Math.abs(length - 6) < 1e-9, `outline length ${length}`);
  assert.equal(sliceSegments(box, 2).length, 0);
});

test('movement is blocked by walls, slides along them and passes through gaps', () => {
  // A wall along x at z = 0 from x = -5 to 5, with a 0.9 m gap from x = 1 to 1.9.
  const segments = [[-5, 0, 1, 0], [1.9, 0, 5, 0], [1, -0.1, 1, 0.1], [1.9, -0.1, 1.9, 0.1]];
  const blocked = resolveMove({x: 0, z: 1}, {x: 0, z: -2}, segments, 0.25);
  assert.ok(blocked.z >= 0.25 - 1e-9, `went through the wall to z ${blocked.z}`);
  const slid = resolveMove({x: -2, z: 0.3}, {x: 1, z: -1}, segments, 0.25);
  assert.ok(slid.x > -1.1 && slid.z >= 0.25 - 1e-9, 'did not slide along the wall');
  const through = resolveMove({x: 1.45, z: 1}, {x: 0, z: -2}, segments, 0.25);
  assert.ok(through.z < -0.9, 'did not pass the gap');
  const tunnel = resolveMove({x: -3, z: 0.5}, {x: 0, z: -40}, segments, 0.25);
  assert.ok(tunnel.z > 0, 'a long step tunneled through the wall');
});

test('ground height comes from the highest walkable floor below the step limit', () => {
  const floors = [...boxTriangles([0, -0.2, -4], [4, 0, 0]), ...boxTriangles([0, 2.6, -4], [4, 2.8, 0])];
  assert.equal(groundHeight(floors, 2, -2, 0.35), 0);
  assert.equal(groundHeight(floors, 2, -2, 3.1), 2.8);
  assert.equal(groundHeight(floors, 6, -2, 0.35), null);
});

test('the walker stands on the site outside the lowest level but never steps off an upper floor', () => {
  const floors = [...boxTriangles([0, -0.2, -4], [4, 0, 0]), ...boxTriangles([0, 2.6, -4], [4, 2.8, 0])];
  const world = {segments: [], floors, baseElevation: 0, radius: 0.25, stepUp: 0.35};
  const outside = stepWalker({x: 3.9, z: -2, feet: 0}, {x: 1, z: 0}, world);
  assert.deepEqual(outside, {x: 4.9, z: -2, feet: 0});
  const upstairs = stepWalker({x: 3.9, z: -2, feet: 2.8}, {x: 1, z: 0}, world);
  assert.deepEqual(upstairs, {x: 3.9, z: -2, feet: 2.8});
});

test('the entrance is the door between outdoors and a room', () => {
  const door = entrance(plan, 'level-1');
  assert.equal(door.opening.id, 'entry');
  assert.equal(door.roomId, 'living');
  assert.ok(door.outside[1] < 0, 'the outside point is south of the apartment');
  assert.equal(roomAt(plan, 'level-1', door.inside), 'living');
});

test('camera stops cover the overview, the entrance and every room at eye height', () => {
  const stops = cameraStops(plan, {eyeHeight: 1.7});
  assert.deepEqual(stops.map(s => s.id), ['overview', 'entrance', ...plan.rooms.map(r => `room:${r.id}`)]);
  assert.equal(stops[0].walk, null);
  const [ex, ey, ez] = stops[1].walk.position;
  assert.equal(ey, 1.7);
  assert.equal(roomAt(plan, 'level-1', [ex, -ez]), null, 'the walk starts outside');
  for (const room of plan.rooms) {
    const stop = stops.find(s => s.id === `room:${room.id}`);
    const [x, , z] = stop.walk.position;
    assert.ok(pointInPolygon([x, -z], room.polygon), `${room.id} stop is outside its room`);
    assert.equal(stop.roomId, room.id);
    assert.ok(stop.orbit.position[1] > stop.orbit.target[1], `${room.id} orbit is not above its target`);
  }
});

test('walk dragging looks the way the pointer moves', () => {
  // Three.js yaw is counter-clockwise from above, so looking right decreases it;
  // pitch is rotation.x, so looking up increases it.
  assert.ok(dragLook({yaw: 0, pitch: 0}, 100, 0, 0.005).yaw < 0, 'drag right must look right');
  assert.ok(dragLook({yaw: 0, pitch: 0}, -100, 0, 0.005).yaw > 0, 'drag left must look left');
  assert.ok(dragLook({yaw: 0, pitch: 0}, 0, -100, 0.005).pitch > 0, 'drag up must look up');
  assert.ok(dragLook({yaw: 0, pitch: 0}, 0, 100, 0.005).pitch < 0, 'drag down must look down');
  assert.equal(dragLook({yaw: 0, pitch: 1.1}, 0, -1000, 0.005).pitch, 1.2, 'pitch stays clamped');
  assert.equal(dragLook({yaw: 0, pitch: -1.1}, 0, 1000, 0.005).pitch, -1.2);
});

test('mode state keeps plan and 3D selection in sync and enforces the fallback', () => {
  const context = {plan, manifest};
  const reduce = architectureReducer(context);
  let state = initialArchitectureState(context, {webgl: true});
  assert.equal(state.mode, 'plan');
  state = reduce(state, {type: 'mode', mode: 'walk'});
  assert.equal(state.mode, 'walk');
  assert.deepEqual([state.pose.stopId, state.pose.mode], ['room:living', 'walk'], 'walk opens in the largest living space, not at the door');
  const seq = state.pose.seq;
  state = reduce(reduce(state, {type: 'mode', mode: 'plan'}), {type: 'mode', mode: 'walk'});
  assert.equal(state.pose.seq, seq, 'returning to walk mode moved the walker');
  state = reduce(state, {type: 'select-object', name: 'floor-bathroom'});
  assert.deepEqual([state.roomId, state.objectName], ['bathroom', 'floor-bathroom']);
  state = reduce(state, {type: 'select-room', roomId: 'kitchen'});
  assert.deepEqual([state.roomId, state.objectName], ['kitchen', null]);
  state = reduce(state, {type: 'stop', stopId: 'room:bedroom-b'});
  assert.deepEqual([state.roomId, state.pose.stopId, state.pose.mode], ['bedroom-b', 'room:bedroom-b', 'walk']);
  state = reduce(state, {type: 'eye-height', value: 3});
  assert.equal(state.eyeHeight, 2);
  state = reduce(state, {type: 'mode', mode: 'dollhouse'});
  state = reduce(state, {type: 'reset'});
  assert.deepEqual([state.roomId, state.pose.stopId, state.pose.mode], [null, 'overview', 'dollhouse']);
  state = reduce(state, {type: 'unavailable', reason: 'model'});
  assert.deepEqual([state.mode, state.unavailable], ['plan', 'model']);
  assert.equal(reduce(state, {type: 'mode', mode: 'walk'}).mode, 'plan');
  const noGpu = initialArchitectureState(context, {webgl: false});
  assert.equal(noGpu.unavailable, 'webgl');
  assert.equal(reduce(noGpu, {type: 'mode', mode: 'dollhouse'}).mode, 'plan');
});

test('a plan without an outside door walks from its first room, and an empty one from the middle', () => {
  const doorless = {...plan, openings: plan.openings.filter(o => o.kind !== 'door')};
  const reduce = architectureReducer({plan: doorless, manifest});
  let state = reduce(initialArchitectureState({plan: doorless}, {webgl: true}), {type: 'mode', mode: 'walk'});
  const first = `room:${plan.rooms[0].id}`;
  assert.deepEqual([state.mode, state.pose.stopId], ['walk', first]);
  state = reduce(reduce(state, {type: 'stop', stopId: `room:${plan.rooms[1].id}`}), {type: 'reset'});
  assert.deepEqual([state.pose.stopId, state.pose.mode], [first, 'walk']);
  assert.equal(state.pose.reset, true);
  state = reduce(state, {type: 'stop', stopId: `room:${plan.rooms[1].id}`});
  assert.equal(state.pose.reset, undefined);
  const empty = {...doorless, rooms: []};
  const stops = cameraStops(empty, {eyeHeight: 1.7});
  assert.deepEqual(stops.map(s => s.id), ['overview']);
  assert.equal(stops[0].walk.position[1], 1.7);
  const walking = architectureReducer({plan: empty, manifest})(initialArchitectureState({plan: empty}, {webgl: true}), {type: 'mode', mode: 'walk'});
  assert.deepEqual([walking.mode, walking.pose.stopId], ['walk', 'overview']);
  const view = readFileSync(new URL('../frontend/walkthrough.jsx', import.meta.url), 'utf8');
  assert.match(view, /!stop\?\.walk\) return;/, 'the walk camera ignores a stop without a walk pose');
});

test('changing the level clears a selection from another level', () => {
  const twoLevels = {
    ...plan,
    levels: [...plan.levels, {id: 'level-2', name: 'Upper floor', elevation: 2.8, height: 2.8}],
    rooms: [...plan.rooms, {id: 'loft', levelId: 'level-2', name: 'Loft', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]]}],
  };
  const context = {plan: twoLevels, manifest};
  const reduce = architectureReducer(context);
  let state = reduce(initialArchitectureState(context, {webgl: true}), {type: 'select-room', roomId: 'loft'});
  assert.equal(state.levelId, 'level-2');
  state = reduce(state, {type: 'level', levelId: 'level-1'});
  assert.equal(state.roomId, null);
});

test('the unit check marks rooms of whole apartments, spaces too small for a unit and shared space, per level', () => {
  const square = x => [[x, 0], [x + 3, 0], [x + 3, 3], [x, 3]];
  const checked = {
    levels: [{id: 'l1'}, {id: 'l2'}],
    rooms: [
      {id: 'a', levelId: 'l1', name: 'Unit 1 living and kitchen', unitId: 'unit-1', polygon: square(0)},
      {id: 'b', levelId: 'l1', name: 'Unit 1 bedroom', unitId: 'unit-1', polygon: square(3)},
      {id: 'c', levelId: 'l1', name: 'Unit 2 living and sleeping', unitId: 'unit-2', polygon: square(6)},
      {id: 'd', levelId: 'l1', name: 'Space too small for a unit', polygon: square(9)},
      {id: 'e', levelId: 'l1', name: 'Corridor', polygon: square(12)},
      {id: 'f', levelId: 'l2', name: 'Space too small for a unit', polygon: square(0)},
    ],
  };
  const one = unitCheck(checked, 'l1');
  assert.deepEqual([...one.rooms], [['a', 'whole'], ['b', 'whole'], ['c', 'whole'], ['d', 'short'], ['e', 'shared']]);
  assert.equal(one.whole, 2);
  assert.equal(one.short, 1);
  assert.deepEqual({whole: unitCheck(checked, 'l2').whole, short: unitCheck(checked, 'l2').short}, {whole: 0, short: 1});
});

test('unit cards sum each apartment and place it at its area-weighted centre', () => {
  const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const cards = unitCards({levels: [{id: 'l1'}], rooms: [
    {id: 'a', levelId: 'l1', name: 'Unit 4 living and kitchen', unitId: 'u4', beds: 1, polygon: square(0, 0, 4)},
    {id: 'b', levelId: 'l1', name: 'Unit 4 bedroom', unitId: 'u4', beds: 1, polygon: square(4, 0, 2)},
    {id: 'c', levelId: 'l1', name: 'Stair hall', polygon: square(10, 0, 3)},
  ]}, 'l1');
  assert.equal(cards.length, 1);
  assert.deepEqual({name: cards[0].name, beds: cards[0].beds, area: cards[0].area}, {name: 'Unit 4', beds: 1, area: 20});
  assert.deepEqual(cards[0].at, [(2 * 16 + 5 * 4) / 20, (2 * 16 + 1 * 4) / 20]);
});

test('storeys lift apart in elevation order, and a typical floor tops out at its last storey', () => {
  const storeys = [{id: 'b', elevation: 3.2}, {id: 'a', elevation: -3}, {id: 'c', elevation: 6.4}];
  assert.deepEqual([...storeyLifts(storeys)], [['a', 0], ['b', EXPLODE_GAP], ['c', 2 * EXPLODE_GAP]]);
  assert.deepEqual([...storeyLifts(storeys, 'b', 20)], [['a', 0], ['b', EXPLODE_GAP], ['c', 2 * EXPLODE_GAP + 20]]);
  assert.equal(levelTop({elevation: 3.2, storeys: [{elevation: 3.2}, {elevation: 6.4}]}), 6.4);
  assert.equal(levelTop({elevation: 0}), 0);
});

test('the story cuts the plan at 1.2 m seen from above, then lifts past the roof into a three-quarter view', () => {
  const box = {center: [10, 8, -10], span: 30, floor: 3.2, top: 22};
  const start = storyFrame(0, box), plan = storyFrame(0.4, box), end = storyFrame(1, box);
  assert.ok(start.cut > 3.2 && start.cut < 3.3);
  assert.ok(Math.abs(plan.cut - (3.2 + STORY_CUT)) < 1e-9);
  assert.ok(Math.abs(plan.position[0] - 10) < 0.1 && Math.abs(plan.position[2] + 10) < 0.1 && plan.position[1] > 30);
  assert.equal(end.cut, 23);
  assert.ok(end.position[2] > -10 && end.position[1] - end.target[1] < 45 * 0.6);
  assert.deepEqual(storyFrame(2, box), end);
});
