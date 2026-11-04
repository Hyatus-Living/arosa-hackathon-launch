// Writes the walkthrough fixture for the sample apartment: a small GLB with stable node names
// and the companion manifest, in the shape the Blender/Bonsai worker publishes. The plan comes
// from sample-plan.json (metres, x east, y north); the GLB uses glTF axes (y up, z = -north).
// Run from the repository root: node app-starter/tests/fixtures/architecture/build-fixture.mjs
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BoxGeometry, ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, Shape} from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';

// GLTFExporter reads its binary output back through FileReader, which Node lacks.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(buffer => { this.result = buffer; this.onloadend?.(); }); }
};

const here = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(here, 'sample-plan.json'), 'utf8'));
const level = plan.levels[0];
const SLAB = 0.2;

// IFC GlobalIds are 22 characters from a 64-symbol alphabet; derive stable ones from the ids.
const IFC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const globalId = id => [...createHash('sha256').update(id).digest()].slice(0, 22).map(b => IFC_CHARS[b % 64]).join('');

const materials = {
  wall: new MeshStandardMaterial({name: 'wall', color: '#e7e3da', roughness: 0.9}),
  floor: new MeshStandardMaterial({name: 'floor', color: '#c8b392', roughness: 0.8}),
  glass: new MeshStandardMaterial({name: 'glass', color: '#9fc4d8', roughness: 0.1, transparent: true, opacity: 0.35}),
  threshold: new MeshStandardMaterial({name: 'threshold', color: '#8b7d68', roughness: 0.7}),
};

// A box spanning [a, b] along the wall, [bottom, top] in height and the wall thickness across.
function wallBox(wall, a, b, bottom, top, thickness = wall.thickness) {
  const [x1, y1] = wall.start, [x2, y2] = wall.end;
  const length = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / length, uy = (y2 - y1) / length;
  const box = new BoxGeometry(b - a, top - bottom, thickness);
  const mid = (a + b) / 2;
  box.rotateY(Math.atan2(uy, ux));
  box.translate(x1 + ux * mid, level.elevation + (bottom + top) / 2, -(y1 + uy * mid));
  return box;
}

const scene = new Group();
scene.name = 'apartment';
const objects = [], wallNodes = [], floorNodes = [];
const add = (mesh, entry) => { scene.add(mesh); objects.push({glbNodeName: mesh.name, ifcGlobalId: globalId(entry.id), kind: entry.kind, levelId: level.id, ...(entry.roomId ? {roomId: entry.roomId} : {}), name: entry.name}); };

for (const wall of plan.walls) {
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const openings = plan.openings.filter(o => o.wallId === wall.id).sort((p, q) => p.offset - q.offset);
  // Walls run half a thickness past their ends so corners and T-junctions close.
  const pieces = [];
  let cursor = -wall.thickness / 2;
  for (const o of openings) {
    pieces.push(wallBox(wall, cursor, o.offset, 0, wall.height));
    if (o.sill > 0) pieces.push(wallBox(wall, o.offset, o.offset + o.width, 0, o.sill));
    pieces.push(wallBox(wall, o.offset, o.offset + o.width, o.sill + o.height, wall.height));
    cursor = o.offset + o.width;
  }
  pieces.push(wallBox(wall, cursor, length + wall.thickness / 2, 0, wall.height));
  const mesh = new Mesh(mergeGeometries(pieces), materials.wall);
  mesh.name = `wall-${wall.id}`;
  add(mesh, {id: wall.id, kind: 'wall', name: `Wall ${wall.id}`});
  wallNodes.push(mesh.name);
  for (const o of openings) {
    const pane = o.kind === 'window'
      ? new Mesh(wallBox(wall, o.offset, o.offset + o.width, o.sill, o.sill + o.height, 0.02), materials.glass)
      : new Mesh(wallBox(wall, o.offset, o.offset + o.width, 0, 0.015, wall.thickness), materials.threshold);
    pane.name = `${o.kind}-${o.id}`;
    add(pane, {id: o.id, kind: o.kind, name: (o.id[0].toUpperCase() + o.id.slice(1)).replace(/-/g, ' ')});
  }
}

for (const room of plan.rooms) {
  const shape = new Shape();
  room.polygon.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  const slab = new ExtrudeGeometry(shape, {depth: SLAB, bevelEnabled: false});
  slab.rotateX(-Math.PI / 2);
  slab.translate(0, level.elevation - SLAB, 0);
  const mesh = new Mesh(slab, materials.floor);
  mesh.name = `floor-${room.id}`;
  add(mesh, {id: `${room.id}-floor`, kind: 'floor', roomId: room.id, name: `${room.name} floor`});
  floorNodes.push(mesh.name);
}

const glb = await new GLTFExporter().parseAsync(scene, {binary: true});
writeFileSync(join(here, 'sample.glb'), Buffer.from(glb));
const manifest = {
  objects,
  levels: plan.levels.map(l => ({id: l.id, name: l.name, elevation: l.elevation, height: l.height})),
  collision: {walls: wallNodes.map(glbNodeName => ({glbNodeName})), floors: floorNodes.map(glbNodeName => ({glbNodeName}))},
};
writeFileSync(join(here, 'sample-manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`sample.glb ${glb.byteLength} bytes, ${objects.length} objects`);
