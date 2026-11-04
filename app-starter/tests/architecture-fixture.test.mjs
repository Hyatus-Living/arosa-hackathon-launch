// The walkthrough fixture against the viewer's model logic: the GLB's node names match the
// manifest, and a walker using collision derived from that GLB can enter from outside, reach every
// room through its doors and is stopped by walls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {cameraStops, collisionWorld, doorSides, roomAt, selectionIndex, stepWalker, worldTriangles} from '../frontend/architecture-model.mjs';

const read = name => readFileSync(new URL(`./fixtures/architecture/${name}`, import.meta.url));
const plan = JSON.parse(read('sample-plan.json'));
const manifest = JSON.parse(read('sample-manifest.json'));
const glb = read('sample.glb');
const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
gltf.scene.updateMatrixWorld(true);
const meshes = new Map();
gltf.scene.traverse(o => { if (o.isMesh) meshes.set(o.name, o); });
const triangles = names => names.flatMap(name => {
  const mesh = meshes.get(name);
  return worldTriangles(mesh.geometry.attributes.position.array, mesh.geometry.index?.array ?? null, mesh.matrixWorld.elements);
});
const index = selectionIndex(manifest);
const world = collisionWorld({walls: triangles([...index.walls]), floors: triangles([...index.floors]), elevation: 0});

test('the sample has five rooms, five doors and four windows on one 2.8 m storey', () => {
  assert.equal(plan.rooms.length, 5);
  assert.equal(plan.openings.filter(o => o.kind === 'door').length, 5);
  assert.equal(plan.openings.filter(o => o.kind === 'window').length, 4);
  assert.deepEqual(plan.levels.map(l => l.height), [2.8]);
});

test('every manifest object is a named node in the GLB and every room has a floor', () => {
  for (const object of manifest.objects) assert.ok(meshes.has(object.glbNodeName), `${object.glbNodeName} is missing from the GLB`);
  for (const room of plan.rooms) assert.ok(index.rooms.get(room.id)?.length, `${room.id} has no nodes`);
});

// Walk in small steps toward a point, as the viewer does each frame, and report where it ends.
function walkTo(walker, [x, y]) {
  for (let i = 0; i < 2000; i++) {
    const dx = x - walker.x, dz = -y - walker.z, d = Math.hypot(dx, dz);
    if (d < 0.02) break;
    const step = Math.min(d, 1.4 / 60);
    walker = stepWalker(walker, {x: (dx / d) * step, z: (dz / d) * step}, world);
  }
  return walker;
}
const near = (walker, [x, y]) => Math.hypot(walker.x - x, walker.z + y) < 0.05;

test('from the entrance a walker reaches every room through its doors', () => {
  const stops = cameraStops(plan, {eyeHeight: 1.6});
  const start = stops.find(s => s.id === 'entrance').walk.position;
  const doors = Object.fromEntries(plan.openings.filter(o => o.kind === 'door').map(o => [o.id, doorSides(plan, o)]));
  // Each route crosses doors from the room it is in; door points are 0.6 m either side of the wall.
  const through = (id, sign) => { const d = doors[id]; return [[d.center[0] + d.normal[0] * 0.6 * sign, d.center[1] + d.normal[1] * 0.6 * sign], [d.center[0] - d.normal[0] * 0.6 * sign, d.center[1] - d.normal[1] * 0.6 * sign]]; };
  const side = (id, roomId) => (doors[id].sides[0] === roomId ? 1 : -1);
  const centre = id => { const p = plan.rooms.find(r => r.id === id).polygon; return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length]; };
  let walker = {x: start[0], z: start[2], feet: 0};
  assert.equal(roomAt(plan, 'level-1', [walker.x, -walker.z]), null);
  const visited = [];
  const go = point => { walker = walkTo(walker, point); assert.ok(near(walker, point), `stuck at ${walker.x.toFixed(2)}, ${(-walker.z).toFixed(2)} on the way to ${point}`); assert.ok(Math.abs(walker.feet) < 1e-6, `left the floor at ${walker.feet}`); };
  // Rooms are convex here, so straight lines between door points inside one room stay in it.
  const route = (from, to) => {
    const queue = [[from, []]], seen = new Set([from]);
    while (queue.length) {
      const [room, doorsSoFar] = queue.shift();
      if (room === to) return doorsSoFar;
      for (const [id, d] of Object.entries(doors)) {
        if (!d.sides.includes(room)) continue;
        const next = d.sides[0] === room ? d.sides[1] : d.sides[0];
        if (next === null || seen.has(next)) continue;
        seen.add(next);
        queue.push([next, [...doorsSoFar, [id, room]]]);
      }
    }
    throw new Error(`no route from ${from} to ${to}`);
  };
  for (const point of through('entry', side('entry', null))) go(point);
  let here = roomAt(plan, 'level-1', [walker.x, -walker.z]);
  visited.push(here);
  for (const room of ['kitchen', 'bedroom-a', 'bedroom-b', 'bathroom']) {
    for (const [door, from] of route(here, room)) for (const point of through(door, side(door, from))) go(point);
    go(centre(room));
    here = roomAt(plan, 'level-1', [walker.x, -walker.z]);
    visited.push(here);
  }
  assert.deepEqual(visited, ['living', 'kitchen', 'bedroom-a', 'bedroom-b', 'bathroom']);
});

test('walls stop the walker away from the doors, including under a window', () => {
  // From the living room north into the bedroom wall, and south into the wall below the living window.
  const north = walkTo({x: 3.5, z: -2, feet: 0}, [3.5, 6]);
  assert.ok(-north.z < 4 - 0.09 - 0.2, `crossed the bedroom wall to y ${-north.z}`);
  const south = walkTo({x: 2, z: -2, feet: 0}, [2, -3]);
  assert.ok(-south.z > 0.09 + 0.2, `crossed the window wall to y ${-south.z}`);
});
