import React, {useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {initializeGpuRenderer, SceneGroundReplacement} from '@pascal-app/viewer';
import {CameraControls} from '@react-three/drei';
import {Canvas, useThree} from '@react-three/fiber';
import {ACESFilmicToneMapping, EdgesGeometry, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Raycaster, Shape, Sphere, Vector3} from 'three';
import {WebGPURenderer} from 'three/webgpu';
import {TilesRenderer, TilesPlugin} from '3d-tiles-renderer/r3f';
import {GoogleCloudAuthPlugin, ReorientationPlugin, GLTFExtensionsPlugin, TileCompressionPlugin, TileFlatteningPlugin} from '3d-tiles-renderer/plugins';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {solarPosition, shadowPolygonInFrame, SUN_MOMENTS} from './solar.mjs';
import {LoadBoundary} from './load-boundary.jsx';
import {VisualWorkbench} from './visual-workbench.jsx';

const FOOT = 0.3048;
class CameraBoundary extends React.Component {
  constructor(props) { super(props); this.state = {failed: false}; }
  static getDerivedStateFromError() { return {failed: true}; }
  componentDidCatch(error) { console.warn('[acres] concept camera failed', error); }
  render() { return this.state.failed ? null : this.props.children; }
}
const roots = new Map();

const EXPLODED_GAP = 5;
function bounds(concept, exploded) {
  const {lot, levels} = conceptGeometry(concept);
  const points = [...lot, ...levels.flatMap(level => level.footprint)];
  if (!points.length) return {center: [0, 0, 0], radius: 20, height: 10, minX: -10, maxX: 10, minZ: -10, maxZ: 10};
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minZ = Math.min(...points.map(p => p[1])), maxZ = Math.max(...points.map(p => p[1]));
  const offset = i => exploded ? i * EXPLODED_GAP : 0;
  const minY = Math.min(-FOOT, ...levels.map((level, i) => level.floorElevationFeet * FOOT + offset(i)));
  const maxY = Math.max(0, ...levels.map((level, i) => (level.floorElevationFeet + level.heightFeet) * FOOT + offset(i)));
  const height = maxY - minY, radius = Math.hypot(maxX - minX, maxZ - minZ, height) / 2;
  return {center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2], radius, height, minX, maxX, minZ, maxZ};
}

// Geometry in scene metres: the lot and one footprint per storey. Concepts saved before
// footprints were stored are rebuilt from the walls of each level.
function conceptGeometry(concept) {
  const nodes = Object.values(concept?.scene?.nodes || {});
  const polygon = value => Array.isArray(value) && value.length >= 3 && value.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])) ? value : [];
  const lot = [concept?.lot, nodes.find(n => n.type === 'zone' && n.properties?.acres === 'lot')?.polygon, nodes.find(n => n.type === 'zone')?.polygon].map(polygon).find(value => value.length) || [];
  const walls = new Map();
  for (const wall of nodes.filter(n => n.type === 'wall')) {
    if (!walls.has(wall.parentId)) walls.set(wall.parentId, []);
    walls.get(wall.parentId).push(wall.start);
  }
  const levelIds = nodes.filter(n => n.type === 'level').map(n => n.id);
  const levels = (Array.isArray(concept?.levels) ? concept.levels : []).map((level, i) => ({...level, footprint: [level.footprint, walls.get(level.levelId || levelIds[i])].map(polygon).find(value => value.length) || []}));
  return {lot, levels};
}

function geometryMessage({lot, levels}) {
  if (!lot.length) return 'This massing has no valid lot polygon, so Arosa cannot draw dimensions or a building model.';
  if (!levels.some(level => level.footprint.length)) return 'This massing has no valid storey footprints, so Arosa cannot draw a building model.';
  return null;
}

async function createConceptRenderer(props, onUnavailable) {
  const result = await initializeGpuRenderer({
    powerPreference: props.powerPreference,
    createRenderer: parameters => {
      const renderer = new WebGPURenderer({...props, ...parameters, alpha: true});
      renderer.toneMapping = ACESFilmicToneMapping;
      return renderer;
    },
  });
  if (result.status === 'ready') return result.renderer;
  onUnavailable();
  // The canvas is removed by onUnavailable; configuring a failed renderer must not continue.
  return new Promise(() => {});
}

function Camera({view, extent, lot, sceneReady}) {
  const [controls, setControls] = useState(null);
  const camera = useThree(state => state.camera);
  const invalidate = useThree(state => state.invalidate);
  useEffect(() => {
    const c = controls;
    if (!c) return;
    const [x, y, z] = extent.center, d = extent.radius * 2.4 + 4;
    const sphere = new Sphere(new Vector3(x, y, z), extent.radius * 1.15);
    const pose = () => {
      if (view === 'street') {
        // Stand on the street, which the concept convention puts at the lot's smallest z, a little
        // to one side, and look up at the frontage. Neighbours are drawn with front faces only, so
        // standing inside one across the street does not block the view.
        const streetZ = lot.minZ, back = Math.max(18, Math.min(36, extent.height * 0.5));
        c.setLookAt(x + (lot.maxX - lot.minX) * 0.6, 1.7, streetZ - back, x, Math.min(extent.height * 0.3, 28), streetZ + (lot.maxZ - lot.minZ) * 0.2, false);
      } else {
        c.setLookAt(x + d * 0.8, y + d * 0.7, z + d * 0.8, x, y, z, false);
        c.fitToSphere(sphere, false);
      }
      c.update(1 / 60);
      invalidate();
    };
    pose();
  }, [controls, view, sceneReady, extent.center[0], extent.center[1], extent.center[2], extent.radius, extent.height, lot.minX, lot.maxX, lot.minZ, lot.maxZ, camera, invalidate]);
  return <CameraControls makeDefault ref={setControls} azimuthRotateSpeed={-1} polarRotateSpeed={-1} dollySpeed={0.1} />;
}

function MassingModel({concept, exploded, onReady}) {
  const invalidate = useThree(state => state.invalidate);
  const group = useMemo(() => buildConceptGroup(concept, {exploded, includeEnvelope: false}), [concept, exploded]);
  useEffect(() => { invalidate(); onReady(true); return () => disposeConceptGroup(group); }, [group, invalidate, onReady]);
  return <primitive object={group} dispose={null} />;
}

// Surrounding buildings and the existing building as extruded footprints in the viewer's canvas.
// A footprint is drawn in the shape's x/y plane and rotated so its extrusion rises along y.
function ContextBuildings({buildings, showContext, showExisting}) {
  const invalidate = useThree(state => state.invalidate);
  const shapes = useMemo(() => buildings.map(b => {
    const shape = new Shape();
    b.polygon.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    shape.closePath();
    const geometry = new ExtrudeGeometry(shape, {depth: Math.max(b.height, 0.5), bevelEnabled: false});
    return {key: `${b.bin || ''}:${b.bbl || ''}:${b.polygon[0]}`, geometry, edges: new EdgesGeometry(geometry, 20), base: b.base || 0, existing: b.existing};
  }), [buildings]);
  useEffect(() => { invalidate(); return () => { for (const s of shapes) { s.geometry.dispose(); s.edges.dispose(); } }; }, [shapes, invalidate]);
  useEffect(() => { invalidate(); }, [showContext, showExisting, invalidate]);
  return (
    <group>
      {shapes.filter(s => (s.existing ? showExisting : showContext)).map(s => (
        <group key={s.key} position={[0, s.base, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh geometry={s.geometry} raycast={() => null}>
            {s.existing
              ? <meshStandardMaterial color="#4c6fd9" transparent opacity={0.28} depthWrite={false} />
              : <meshStandardMaterial color="#c9cbc2" roughness={0.95} metalness={0} />}
          </mesh>
          <lineSegments geometry={s.edges} raycast={() => null}>
            <lineBasicMaterial color={s.existing ? '#2f4fb5' : '#8f938a'} transparent opacity={s.existing ? 0.9 : 0.6} />
          </lineSegments>
        </group>
      ))}
    </group>
  );
}

// The as-of-right envelope as a translucent limit around the massing: consecutive storeys
// that share a footprint extrude as one volume. Hidden in exploded view, where storeys part.
function EnvelopeOverlay({levels}) {
  const invalidate = useThree(state => state.invalidate);
  const shapes = useMemo(() => {
    const groups = levelRuns(levels);
    return groups.map((g, i) => {
      const shape = new Shape();
      g.footprint.forEach(([x, z], j) => (j ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
      shape.closePath();
      const geometry = new ExtrudeGeometry(shape, {depth: Math.max((g.topFeet - g.baseFeet) * FOOT, 0.1), bevelEnabled: false});
      return {key: i, geometry, edges: new EdgesGeometry(geometry, 20), base: g.baseFeet * FOOT};
    });
  }, [levels]);
  useEffect(() => { invalidate(); return () => { for (const s of shapes) { s.geometry.dispose(); s.edges.dispose(); } }; }, [shapes, invalidate]);
  return (
    <group>
      {shapes.map(s => (
        <group key={s.key} position={[0, s.base, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh geometry={s.geometry} raycast={() => null}>
            <meshStandardMaterial color="#d9a441" transparent opacity={0.16} depthWrite={false} />
          </mesh>
          <lineSegments geometry={s.edges} raycast={() => null}>
            <lineBasicMaterial color="#a8761d" transparent opacity={0.85} />
          </lineSegments>
        </group>
      ))}
    </group>
  );
}

const slugify = name => (name || 'concept').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'concept';
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function extrudedVolume(footprint, baseFeet, topFeet, material, name) {
  const shape = new Shape();
  footprint.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
  shape.closePath();
  const mesh = new Mesh(new ExtrudeGeometry(shape, {depth: Math.max((topFeet - baseFeet) * FOOT, 0.05), bevelEnabled: false}), material);
  mesh.name = name;
  const holder = new Group();
  holder.rotation.x = -Math.PI / 2;
  holder.position.y = baseFeet * FOOT;
  holder.add(mesh);
  return holder;
}
function levelRuns(levels) {
  const runs = [];
  for (const level of levels) {
    const key = JSON.stringify(level.footprint);
    const last = runs.at(-1);
    if (last && last.key === key && Math.abs(last.topFeet - level.floorElevationFeet) < 1e-6) last.topFeet = level.floorElevationFeet + level.heightFeet;
    else runs.push({key, footprint: level.footprint, baseFeet: level.floorElevationFeet, topFeet: level.floorElevationFeet + level.heightFeet, label: level.label});
  }
  return runs;
}
function buildConceptGroup(concept, {exploded = false, includeEnvelope = true} = {}) {
  const {lot, levels} = conceptGeometry(concept);
  const group = new Group();
  group.name = concept.name || 'Concept';
  group.userData.conceptId = concept.id;
  group.add(extrudedVolume(lot, -1, 0, new MeshStandardMaterial({color: '#8f938a', roughness: 1}), 'Lot'));
  const material = new MeshStandardMaterial({color: '#b3a284', roughness: 0.9});
  const runs = exploded ? levels.map((level, i) => ({...level, baseFeet: level.floorElevationFeet + i * EXPLODED_GAP / FOOT, topFeet: level.floorElevationFeet + level.heightFeet + i * EXPLODED_GAP / FOOT})) : levelRuns(levels);
  for (const run of runs) group.add(extrudedVolume(run.footprint, run.baseFeet, run.topFeet, material, run.label || 'Storey'));
  if (includeEnvelope && !exploded && concept.envelope?.levels?.length) {
    const envelopeMaterial = new MeshStandardMaterial({color: '#d9a441', transparent: true, opacity: 0.25, roughness: 1});
    for (const run of levelRuns(concept.envelope.levels)) group.add(extrudedVolume(run.footprint, run.baseFeet, run.topFeet, envelopeMaterial, 'Zoning envelope'));
  }
  return group;
}
function disposeConceptGroup(group) {
  const geometries = new Set(), materials = new Set();
  group.traverse(node => { if (node.isMesh) { geometries.add(node.geometry); materials.add(node.material); } });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
// Massing GLB from the same footprints the viewer draws: a lot plate, one extrusion per
// distinct storey run, and translucent envelope volumes when the concept carries them.
async function buildConceptGlb(concept) {
  const group = buildConceptGroup(concept);
  try {
    const buffer = await new GLTFExporter().parseAsync(group, {binary: true});
    return new Blob([buffer], {type: 'model/gltf-binary'});
  } finally { disposeConceptGroup(group); }
}
// PNG capture of the live 3D view: render once, then read the drawing buffer in the same task.
function CaptureBridge() {
  const gl = useThree(state => state.gl), scene = useThree(state => state.scene), camera = useThree(state => state.camera);
  useEffect(() => {
    const handler = event => {
      if (event.detail?.canvas !== gl.domElement) return;
      try {
        gl.render(scene, camera);
        gl.domElement.toBlob(blob => {
          if (event.detail?.resolve) return blob ? event.detail.resolve(blob) : event.detail.reject(new Error('Could not capture the building model.'));
          if (blob) downloadBlob(blob, event.detail?.filename || 'concept.png');
        }, 'image/png');
      } catch (error) { if (event.detail?.reject) event.detail.reject(error); else console.warn('[acres] PNG capture failed', error); }
    };
    window.addEventListener('acres:capture-view', handler);
    return () => window.removeEventListener('acres:capture-view', handler);
  }, [gl, scene, camera]);
  return null;
}
async function planPng(root, filename) {
  const svg = root?.querySelector('svg.concept-plan');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const box = svg.viewBox.baseVal;
  const width = 1600, height = Math.max(1, Math.round((width * box.height) / box.width));
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], {type: 'image/svg+xml;charset=utf-8'}));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    canvas.toBlob(blob => { if (blob) downloadBlob(blob, filename); }, 'image/png');
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}

// Project a geographic point into the concept frame using the context's stored frame: x east and
// z south in metres around the parcel, then rotated about the subject's centre onto the lot's.
function placeInFrame(context, latitude, longitude) {
  const f = context?.frame, o = context?.origin;
  if (!f || !o) return null;
  const k = 111320, x = (longitude - o.longitude) * k * Math.cos((o.latitude * Math.PI) / 180), z = -(latitude - o.latitude) * k;
  const dx = x - f.origin[0], dz = z - f.origin[1], ex = [f.into[1], -f.into[0]], ez = f.into;
  return [dx * ex[0] + dz * ex[1] + f.lotCenter[0], dx * ez[0] + dz * ez[1] + f.lotCenter[1]];
}
const PLACE_COLORS = {transit: '#1f6f8b', retail: '#b35c1e', parks: '#3f7d3a', schools: '#7a3e9d'};
const PLACE_COLORS_NIGHT = {transit: '#5db3d6', retail: '#e08a4a', parks: '#7fb873', schools: '#c49ae0'};
const placeColors = () => (typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? PLACE_COLORS_NIGHT : PLACE_COLORS);
const PLACE_LABELS = {transit: 'Transit', retail: 'Retail', parks: 'Parks', schools: 'Schools'};
const compassName = bearing => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((bearing % 360) + 360) % 360 / 45) % 8];

// Google Photorealistic 3D Tiles around the lot, georeferenced into the concept frame: the
// reorientation plugin puts the parcel's coordinates at the origin with +Y up and x west, z
// north; the groups below turn that into the context frame (x east, z south, rotated so x runs
// along the frontage, centred on the modeled lot) and lift the ground at the lot centre to y = 0.
// The lot itself is flattened so the massing stands on cleared ground.
const dracoLoader = typeof window !== 'undefined' ? new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/') : null;
function PhotoTiles({apiKey, context, lot, onStatus}) {
  const invalidate = useThree(state => state.invalidate);
  const [tiles, setTiles] = useState(null);
  const [flattening, setFlattening] = useState(null);
  const [groundOffset, setGroundOffset] = useState(0);
  const frame = context.frame, origin = context.origin;
  const ex = [frame.into[1], -frame.into[0]];
  const turn = Math.atan2(ex[1], ex[0]);
  const lotCenter = frame.lotCenter;
  const shape = useMemo(() => {
    if (!lot.length) return null;
    const outline = new Shape();
    lot.forEach(([x, z], i) => (i ? outline.lineTo(x, -z) : outline.moveTo(x, -z)));
    outline.closePath();
    const geometry = new ExtrudeGeometry(outline, {depth: 6, bevelEnabled: false});
    const mesh = new Mesh(geometry, new MeshBasicMaterial({visible: false}));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -5.7;
    return mesh;
  }, [lot]);
  // Flatten everything standing on the lot down to just above the ground.
  useEffect(() => {
    if (!flattening || !shape) return;
    shape.updateMatrixWorld(true);
    flattening.addShape(shape, new Vector3(0, -1, 0), {threshold: Infinity, thresholdMode: 'flatten', flattenRange: 0});
    return () => { try { flattening.deleteShape(shape); } catch { /* the tileset may already be gone */ } };
  }, [flattening, shape]);
  // Each loaded model may refine the ground under the lot: measure it and move the tiles so the
  // ground at the lot centre sits at y = 0, and refresh the attribution text.
  useEffect(() => {
    if (!tiles) return;
    let corrections = 0, timer = null, offset = 0;
    const raycaster = new Raycaster();
    const measure = () => {
      timer = null;
      try {
        raycaster.set(new Vector3(lotCenter[0], 600, lotCenter[1]), new Vector3(0, -1, 0));
        const hit = raycaster.intersectObject(tiles.group, true)[0];
        if (hit && Math.abs(hit.point.y) > 0.25 && corrections < 24) {
          corrections++;
          offset = Math.max(-80, Math.min(80, offset - hit.point.y));
          setGroundOffset(offset);
        }
      } catch (error) { console.warn('[acres] photo ground measure failed', error); }
      onStatus({attributions: tiles.getAttributions([]).map(a => String(a.value)).filter(Boolean), error: null});
      invalidate();
    };
    const schedule = () => { if (!timer) timer = setTimeout(measure, 350); };
    const failed = event => onStatus({error: event?.error?.message || 'Photo tiles failed to load.'});
    tiles.addEventListener('load-model', schedule);
    tiles.addEventListener('tiles-load-end', schedule);
    tiles.addEventListener('load-error', failed);
    tiles.errorTarget = 12;
    return () => { clearTimeout(timer); tiles.removeEventListener('load-model', schedule); tiles.removeEventListener('tiles-load-end', schedule); tiles.removeEventListener('load-error', failed); };
  }, [tiles, lotCenter[0], lotCenter[1], onStatus, invalidate]);
  useEffect(() => { invalidate(); }, [groundOffset, invalidate]);
  return (
    <group position={[lotCenter[0], groundOffset, lotCenter[1]]} rotation={[0, turn, 0]}>
      <group position={[-frame.origin[0], 0, -frame.origin[1]]} rotation={[0, Math.PI, 0]}>
        <TilesRenderer ref={setTiles}>
          <TilesPlugin plugin={GoogleCloudAuthPlugin} args={{apiToken: apiKey, autoRefreshToken: true}} />
          <TilesPlugin plugin={GLTFExtensionsPlugin} args={{dracoLoader}} />
          <TilesPlugin plugin={TileCompressionPlugin} />
          <TilesPlugin plugin={ReorientationPlugin} args={{lat: origin.latitude * Math.PI / 180, lon: origin.longitude * Math.PI / 180, height: 0, up: '+y'}} />
          <TilesPlugin plugin={TileFlatteningPlugin} ref={setFlattening} />
        </TilesRenderer>
      </group>
      <SceneGroundReplacement />
    </group>
  );
}

function formatLength(metres, units) {
  return units === 'm' ? `${Math.round(metres)} m` : `${Math.round(metres / FOOT)} ft`;
}

// A true plan drawn from the concept geometry: the lot, each distinct storey footprint, the
// surrounding buildings, the existing building and a north arrow when the block is georeferenced.
function PlanView({concept, geometry, showContext, showExisting, places, sun = null}) {
  // The plan follows the app theme: a light drawing sheet by day, a dark sheet at night.
  const night = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const P = night
    ? {sheet: '#1d1f1b', contextFill: '#2d302a', contextStroke: '#4d5148', lotFill: '#23261f', lotStroke: '#c9ccc2', parcel: '#8fce6e', envelope: '#d9a441', storeyFill: '#b08a5e', storeyStroke: '#ece7da', existing: '#7d9bff', ink: '#ece9e2', street: '#a9ada2', markerRing: '#1d1f1b'}
    : {sheet: '#eef0e9', contextFill: '#d6d8d0', contextStroke: '#aeb2a8', lotFill: '#f7f8f3', lotStroke: '#3a3f36', parcel: '#1f4632', envelope: '#a8761d', storeyFill: '#8c6a4a', storeyStroke: '#2b2520', existing: '#2f4fb5', ink: '#1f1b17', street: '#5d6356', markerRing: '#fff'};
  const {lot, levels} = geometry;
  const context = concept.context;
  const envelopeFootprints = [...new Set((concept.envelope?.levels || []).map(l => JSON.stringify(l.footprint)))].map(s => JSON.parse(s));
  // Schematic sun study: neighbours and existing buildings cast from their recorded heights,
  // the concept from each storey run's top. Swept hulls, so stepped massing overestimates a
  // little; the caption in the toolbar says what this is and is not.
  const shadows = [];
  if (sun) {
    const bearing = concept.context?.bearingDeg;
    for (const b of concept.context?.buildings || []) {
      if (b.existing ? !showExisting : !showContext) continue;
      const hull = shadowPolygonInFrame(b.polygon, b.height || 0, sun.altitudeDeg, sun.azimuthDeg, bearing);
      if (hull) shadows.push({hull, concept: false});
    }
    for (const run of levelRuns(levels)) {
      const hull = shadowPolygonInFrame(run.footprint, (run.topFeet || 0) * FOOT, sun.altitudeDeg, sun.azimuthDeg, bearing);
      if (hull) shadows.push({hull, concept: true});
    }
  }
  const points = [...lot, ...levels.flatMap(l => l.footprint), ...envelopeFootprints.flat(), ...shadows.flatMap(s => s.hull)];
  if (!points.length) return null;
  const xs = points.map(p => p[0]), zs = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const size = Math.max(maxX - minX, maxZ - minZ);
  const placed = places.map(p => ({...p, at: placeInFrame(context, p.latitude, p.longitude)})).filter(p => p.at);
  const reach = placed.length ? Math.max(...placed.map(p => Math.max(Math.abs(p.at[0] - (minX + maxX) / 2), Math.abs(p.at[1] - (minZ + maxZ) / 2)))) + 12 : 0;
  const pad = Math.max(showContext && context ? Math.max(size * 0.9, 36) : Math.max(size * 0.25, 8), reach);
  const view = {x: minX - pad, z: minZ - pad, w: maxX - minX + pad * 2, h: maxZ - minZ + pad * 2};
  const unit = view.w / 100, font = Math.max(unit * 2.6, 0.6), stroke = unit * 0.35;
  const path = polygon => polygon.map(([x, z], i) => `${i ? 'L' : 'M'}${x} ${z}`).join(' ') + ' Z';
  // Group storeys that share a footprint so the plan labels a range per distinct outline.
  const distinct = [];
  levels.forEach((level, i) => {
    const key = JSON.stringify(level.footprint);
    const last = distinct.at(-1);
    if (last && last.key === key) last.to = i + 1; else distinct.push({key, footprint: level.footprint, from: i + 1, to: i + 1});
  });
  const centroid = polygon => [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length];
  const units = concept.units || 'ft';
  const bar = units === 'm' ? (view.w > 150 ? 50 : 20) : (view.w > 150 ? 100 * FOOT : 50 * FOOT);
  const north = context?.north;
  const northAngle = north ? (Math.atan2(north[0], -north[1]) * 180) / Math.PI : null;
  const buildings = context?.buildings || [];
  return (
    <svg className="concept-plan" viewBox={`${view.x} ${view.z} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Plan of ${concept.name}`}>
      <rect x={view.x} y={view.z} width={view.w} height={view.h} fill={P.sheet} />
      {shadows.map((s, i) => (
        <path key={`sh${i}`} d={path(s.hull)} fill={P.ink} fillOpacity={s.concept ? 0.26 : 0.14} stroke="none" />
      ))}
      {showContext && buildings.filter(b => !b.existing).map((b, i) => (
        <path key={`c${i}`} d={path(b.polygon)} fill={P.contextFill} stroke={P.contextStroke} strokeWidth={stroke} strokeLinejoin="round" />
      ))}
      <path d={path(lot)} fill={P.lotFill} stroke={P.lotStroke} strokeWidth={stroke * 1.2} strokeDasharray={`${unit * 1.6} ${unit}`} />
      {context?.parcel?.polygon && (
        <path d={path(context.parcel.polygon)} fill="none" stroke={P.parcel} strokeWidth={stroke * 1.4} strokeDasharray={`${unit * 2.2} ${unit * 0.7} ${unit * 0.5} ${unit * 0.7}`} />
      )}
      {envelopeFootprints.map((footprint, i) => (
        <path key={`env${i}`} d={path(footprint)} fill="none" stroke={P.envelope} strokeWidth={stroke * 1.2} strokeDasharray={`${unit * 1.2} ${unit * 0.8}`} />
      ))}
      {distinct.map((d, i) => (
        <path key={`l${i}`} d={path(d.footprint)} fill={P.storeyFill} fillOpacity={Math.min(0.18 + i * 0.16, 0.8)} stroke={P.storeyStroke} strokeWidth={stroke} strokeLinejoin="round" />
      ))}
      {showExisting && buildings.filter(b => b.existing).map((b, i) => (
        <path key={`e${i}`} d={path(b.polygon)} fill="none" stroke={P.existing} strokeWidth={stroke * 1.3} strokeDasharray={`${unit * 0.9} ${unit * 0.7}`} />
      ))}
      {distinct.map((d, i) => {
        const [cx, cz] = centroid(d.footprint);
        // Skip labels that would not fit inside their outline once the plan is zoomed out.
        const width = Math.max(...d.footprint.map(p => p[0])) - Math.min(...d.footprint.map(p => p[0]));
        if (font * 3.2 > width || font * 1.3 * distinct.length > Math.max(...d.footprint.map(p => p[1])) - Math.min(...d.footprint.map(p => p[1]))) return null;
        return (
          <text key={`t${i}`} x={cx} y={cz + font * 0.35 + (i - (distinct.length - 1) / 2) * font * 1.3} fontSize={font} textAnchor="middle" fill={P.ink} fontFamily="system-ui, sans-serif">
            {d.from === d.to ? `L${d.from}` : `L${d.from}–${d.to}`}
          </text>
        );
      })}
      <text x={(minX + maxX) / 2} y={minZ - unit * 2.2} fontSize={font * 0.9} textAnchor="middle" fill={P.street} fontFamily="system-ui, sans-serif" letterSpacing={unit * 0.3}>STREET</text>
      {placed.map((p, i) => (
        <g key={`p${i}`} transform={`translate(${p.at[0]} ${p.at[1]})`}>
          <circle r={unit * 1.4} fill={placeColors()[p.group] || '#888'} stroke={P.markerRing} strokeWidth={stroke} />
          <text x={unit * 2} y={font * 0.35} fontSize={font * 0.8} fill={P.ink} fontFamily="system-ui, sans-serif">{p.name}</text>
        </g>
      ))}
      <g transform={`translate(${view.x + unit * 5} ${view.z + view.h - unit * 5})`}>
        <line x1="0" y1="0" x2={bar} y2="0" stroke={P.ink} strokeWidth={stroke * 1.5} />
        <line x1="0" y1={-unit} x2="0" y2={unit} stroke={P.ink} strokeWidth={stroke * 1.5} />
        <line x1={bar} y1={-unit} x2={bar} y2={unit} stroke={P.ink} strokeWidth={stroke * 1.5} />
        <text x={bar / 2} y={-unit * 1.6} fontSize={font * 0.85} textAnchor="middle" fill={P.ink} fontFamily="system-ui, sans-serif">{formatLength(bar, units)}</text>
      </g>
      {northAngle !== null && (
        <g transform={`translate(${view.x + view.w - unit * 7} ${view.z + unit * 8}) rotate(${northAngle})`}>
          <path d={`M0 ${-unit * 4.5} L${unit * 2.2} ${unit * 3} L0 ${unit * 1.6} L${-unit * 2.2} ${unit * 3} Z`} fill={P.ink} />
          <text x="0" y={-unit * 5.5} fontSize={font * 0.9} textAnchor="middle" fill={P.ink} fontFamily="system-ui, sans-serif">N</text>
        </g>
      )}
    </svg>
  );
}

function ConceptScene({concept, places, tilesKey, threadId, modelingProjectId}) {
  const [view, setView] = useState('3d');
  const [exploded, setExploded] = useState(false);
  const [gpu, setGpu] = useState(true);
  const [sceneReady, setSceneReady] = useState(false);
  const [showContext, setShowContext] = useState(true);
  const [showExisting, setShowExisting] = useState(false);
  const [showEnvelope, setShowEnvelope] = useState(true);
  const [showSun, setShowSun] = useState(false);
  const [sunMomentId, setSunMomentId] = useState('equ-12');
  const [copied, setCopied] = useState(false);
  const rootRef = React.useRef(null);
  const rendererRef = React.useRef(null);
  const createRenderer = React.useCallback(props => {
    rendererRef.current ||= createConceptRenderer(props, () => setGpu(false));
    return rendererRef.current;
  }, []);
  const [showPhoto, setShowPhoto] = useState(false);
  const [photoStatus, setPhotoStatus] = useState({attributions: [], error: null});
  const onPhotoStatus = React.useCallback(update => setPhotoStatus(s => ({...s, ...update})), []);
  const extent = bounds(concept, exploded);
  const geometry = useMemo(() => conceptGeometry(concept), [concept]);
  const missingGeometry = geometryMessage(geometry);
  const lotExtent = useMemo(() => {
    const xs = geometry.lot.map(p => p[0]), zs = geometry.lot.map(p => p[1]);
    return xs.length ? {minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs)} : {minX: extent.minX, maxX: extent.maxX, minZ: extent.minZ, maxZ: extent.maxZ};
  }, [geometry, extent.minX, extent.maxX, extent.minZ, extent.maxZ]);
  useEffect(() => { if (!('gpu' in navigator) && !document.createElement('canvas').getContext('webgl2')) setGpu(false); }, []);
  const m = concept.metrics;
  const context = concept.context;
  const neighbours = context?.buildings?.filter(b => !b.existing).length || 0;
  const existing = context?.existing || null;
  const contextBuildings = (context?.buildings || []).filter(b => !exploded || b.existing === false);
  const photoAvailable = Boolean(tilesKey && context?.frame && context?.origin);
  const streetView = context?.streetView || null;
  const photo = streetView ? `/api/street-view?${new URLSearchParams({pano: streetView.panoId, heading: String(Math.round(streetView.heading)), fov: '90'})}` : null;
  const nearby = Object.entries(PLACE_LABELS).map(([group, label]) => [group, label, places.filter(p => p.group === group).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 5)]).filter(([, , list]) => list.length);
  return (
    <div className="concept-view" ref={rootRef}>
      <div className="concept-toolbar" role="group" aria-label="View">
        {[['3d', '3D'], ['plan', 'Plan'], ['street', 'Street']].map(([id, label]) => (
          <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
        ))}
        <button type="button" aria-pressed={exploded} onClick={() => setExploded(v => !v)}>Exploded</button>
        {photoAvailable && <button type="button" className="concept-toggle" aria-pressed={showPhoto} onClick={() => setShowPhoto(v => !v)}>Photo</button>}
        {neighbours > 0 && <button type="button" className={photoAvailable ? undefined : 'concept-toggle'} aria-pressed={showContext && !showPhoto} disabled={showPhoto} onClick={() => setShowContext(v => !v)}>Neighbours</button>}
        {existing && <button type="button" className="concept-toggle" aria-pressed={showExisting} onClick={() => setShowExisting(v => !v)}>Existing building</button>}
        {concept.envelope && <button type="button" className="concept-toggle" aria-pressed={showEnvelope} onClick={() => setShowEnvelope(v => !v)}>Envelope</button>}
        {view === 'plan' && context?.origin && <button type="button" className="concept-toggle" aria-pressed={showSun} onClick={() => setShowSun(v => !v)}>Sun</button>}
        {view === 'plan' && showSun && context?.origin && (
          <select aria-label="Sun study moment" value={sunMomentId} onChange={e => setSunMomentId(e.target.value)}>
            {SUN_MOMENTS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
        <button type="button" className="concept-toggle" onClick={() => {
          const base = slugify(concept.name);
          if (view === 'plan') void planPng(rootRef.current, `${base}-plan.png`);
          else window.dispatchEvent(new CustomEvent('acres:capture-view', {detail: {canvas: rootRef.current?.querySelector('.concept-canvas canvas'), filename: `${base}-${view}.png`}}));
        }}>PNG</button>
        <button type="button" onClick={() => { buildConceptGlb(concept).then(blob => downloadBlob(blob, `${slugify(concept.name)}.glb`)).catch(error => console.warn('[acres] GLB export failed', error)); }}>GLB</button>
        {threadId && <button type="button" onClick={async () => {
          const url = `${window.location.origin}/#thread=${encodeURIComponent(threadId)}&concept=${encodeURIComponent(concept.id)}`;
          try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
          catch { window.prompt('Copy the link to this model:', url); }
        }}>{copied ? 'Copied' : 'Copy link'}</button>}
      </div>
      <div className="concept-canvas">
        {missingGeometry ? <p className="concept-fallback" role="status">{missingGeometry} The reported metrics remain available below.</p> : !gpu && view !== 'plan' ? <p className="concept-fallback">3D is not available in this browser. The plan view still works.</p>
          : gpu ? (
            <Canvas frameloop="demand" dpr={[1, 2]} camera={{position: [50, 50, 50], fov: 50, near: 0.05, far: Math.max(1000, extent.radius * 12)}} gl={createRenderer}>
              <ambientLight intensity={1.2} />
              <directionalLight position={[8, 14, 6]} intensity={1.5} />
              <CameraBoundary>
                <MassingModel concept={concept} exploded={exploded} onReady={setSceneReady} />
                <Camera view={view} extent={extent} lot={lotExtent} sceneReady={sceneReady} />
                {contextBuildings.length > 0 && <ContextBuildings buildings={contextBuildings} showContext={showContext && !showPhoto} showExisting={showExisting} />}
                {showEnvelope && !exploded && concept.envelope?.levels?.length > 0 && <EnvelopeOverlay levels={concept.envelope.levels} />}
                <CaptureBridge />
                {showPhoto && photoAvailable && <PhotoTiles apiKey={tilesKey} context={context} lot={geometry.lot} onStatus={onPhotoStatus} />}
              </CameraBoundary>
            </Canvas>
          ) : null}
        {!missingGeometry && view === 'plan' && <PlanView concept={concept} geometry={geometry} showContext={showContext} showExisting={showExisting} places={places} sun={showSun && context?.origin ? solarPosition(new Date((SUN_MOMENTS.find(m => m.id === sunMomentId) || SUN_MOMENTS[4]).utc), context.origin.latitude, context.origin.longitude) : null} />}
        {!missingGeometry && view === 'plan' && showSun && context?.origin && (
          <p className="concept-attribution">Schematic sun study ({(SUN_MOMENTS.find(m => m.id === sunMomentId) || {}).label || ''}): shadows swept from modeled and recorded building heights. Not a shadow-impact analysis.</p>
        )}
        {showPhoto && view !== 'plan' && (
          <p className="concept-attribution"><strong>Google</strong>{photoStatus.error ? `Photo tiles unavailable: ${photoStatus.error}` : photoStatus.attributions.length ? photoStatus.attributions.join(' · ') : 'Loading photo tiles…'}</p>
        )}
      </div>
      {modelingProjectId && <VisualWorkbench projectId={modelingProjectId} concept={concept} canvasRef={rootRef} canCapture={gpu && sceneReady && view !== 'plan' && !showPhoto} photoTilesVisible={showPhoto} />}
      {view === 'street' && photo && (
        <figure className="concept-photo">
          <img src={photo} alt={`Street View photo facing the lot from the ${compassName(streetView.heading)}`} loading="lazy" width="640" height="400" />
          <figcaption>Google Street View from about {Math.round(streetView.distanceMeters)} m away, facing {compassName(streetView.heading)} toward the lot{streetView.date ? `, captured ${streetView.date}` : ''}. The photo shows the street as it was, not the concept.</figcaption>
        </figure>
      )}
      {nearby.length > 0 && (
        <div className="concept-places" aria-label="Nearby places">
          {nearby.map(([group, label, list]) => (
            <div key={group}><dt style={{color: placeColors()[group]}}>{label}</dt>
              {list.map((p, i) => <dd key={i}>{p.name} <small>{p.distanceMeters} m {p.direction}</small></dd>)}
            </div>
          ))}
        </div>
      )}
      <dl className="concept-metrics">
        <div><dt>Storeys</dt><dd>{m.storeys}</dd></div>
        <div><dt>Gross floor area</dt><dd>{m.grossFloorAreaSqft.toLocaleString()} sq ft</dd></div>
        <div><dt>Lot</dt><dd>{m.lotAreaSqft.toLocaleString()} sq ft</dd></div>
        <div><dt>FAR</dt><dd>{m.far}{m.maxFar ? ` of ${m.maxFar}` : ''}</dd></div>
        <div><dt>Height</dt><dd>{m.heightFeet} ft{m.maxHeightFeet ? ` of ${m.maxHeightFeet}` : ''}</dd></div>
        {m.units != null && <div><dt>Units</dt><dd>{m.units}{m.grossSqftPerUnit ? ` · ${m.grossSqftPerUnit.toLocaleString()} sq ft each` : ''}</dd></div>}
        {existing && <div><dt>Existing building</dt><dd>{existing.heightFeet} ft{existing.storeys ? `, ${existing.storeys} storeys` : ''}{existing.yearBuilt ? ` (${existing.yearBuilt})` : ''}</dd></div>}
        {concept.revision && <div><dt>Version</dt><dd>{`v${concept.revision.version ?? '—'} of ${concept.revision.parentName || 'earlier concept'}`}</dd></div>}
        {concept.revision?.deltas && <div><dt>Change</dt><dd>{`${concept.revision.deltas.grossFloorAreaSqft > 0 ? '+' : ''}${concept.revision.deltas.grossFloorAreaSqft.toLocaleString()} sq ft`}{concept.revision.deltas.far !== undefined ? ` · FAR ${concept.revision.deltas.far > 0 ? '+' : ''}${concept.revision.deltas.far}` : ''}{concept.revision.deltas.units !== undefined ? ` · ${concept.revision.deltas.units > 0 ? '+' : ''}${concept.revision.deltas.units} units` : ''}</dd></div>}
      </dl>
      {concept.compliance && (
        <div className="concept-compliance" data-compliant={concept.compliance.compliant}>
          <strong>Envelope check</strong>
          {concept.compliance.compliant
            ? <span>Every modeled storey sits within the modeled envelope. Review zoning assumptions and applicable rules.</span>
            : <ul>{concept.compliance.violations.map((v, i) => <li key={i}>{v.level}: {v.reason}</li>)}</ul>}
        </div>
      )}
      <table className="concept-levels">
        <thead><tr><th>Storey</th><th>Use</th><th>Floor at</th><th>Height</th><th>Area</th>{m.units != null && <th>Units</th>}</tr></thead>
        <tbody>
          {[...geometry.levels].reverse().map((level, i) => (
            <tr key={i}><td>{level.label}</td><td>{level.use || '—'}</td><td>{level.floorElevationFeet} ft</td><td>{level.heightFeet} ft</td><td>{level.areaSqft.toLocaleString()} sq ft</td>{m.units != null && <td>{level.units ?? '—'}</td>}</tr>
          ))}
        </tbody>
      </table>
      <p className="concept-note">
        Massing illustrates the zoning hypothesis in this answer. Areas are gross modeled footprints, not zoning floor area, and nothing here is an entitlement.
        {context ? ` Surrounding buildings come from NYC building footprints within ${context.radiusMeters} m, extruded to their recorded roof heights; their placement against the modeled lot is approximate.` : ''}
        {photoAvailable ? ' Photo shows Google Photorealistic 3D Tiles georeferenced to the parcel, with the lot flattened; alignment to the modeled lot is approximate.' : ''}
      </p>
    </div>
  );
}

window.acresConceptView = {
  render(container, concept, {places = [], tilesKey = null, threadId = null, modelingProjectId = null} = {}) {
    this.unmount(container);
    const root = createRoot(container);
    roots.set(container, root);
    root.render(<LoadBoundary message="The 3D model did not load."><ConceptScene concept={concept} places={Array.isArray(places) ? places : []} tilesKey={typeof tilesKey === 'string' && tilesKey ? tilesKey : null} threadId={typeof threadId === 'string' && threadId ? threadId : null} modelingProjectId={modelingProjectId} /></LoadBoundary>);
  },
  buildGlb(concept) { return buildConceptGlb(concept); },
  unmount(container) {
    const root = roots.get(container);
    root?.unmount();
    roots.delete(container);
  },
};
