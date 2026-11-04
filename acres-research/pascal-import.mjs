// Pascal scene -> architecture plan v1: the return leg of the Pascal hand-off. A user downloads
// pascal-scene.json, edits it in Pascal (local or hosted), uploads it back as a drawing, and the
// agent imports it here as a new plan revision. The mapping inverts planning/exporters/pascal.py:
// ground (x, z) -> plan (x, -z), wall-local opening centres -> offset/sill, room zones -> rooms.
// Element identity comes from metadata.acresId when the node carries it (everything Acres
// exported does); nodes created in Pascal get fresh pascal-prefixed ids. Node kinds with no plan
// meaning (site, slab, roof, items, scans, guides) are dropped and reported, never guessed at.

const MAX_NODES = 5000;
const idOk = id => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(id);
const finitePair = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const finite = (n, fallback = null) => (Number.isFinite(Number(n)) ? Number(n) : fallback);
const round6 = n => Math.round(n * 1e6) / 1e6;
const planPoint = ([x, z], building) => {
  const [tx, , tz] = building?.position ?? [0, 0, 0], yaw = building?.rotation?.[1] ?? 0;
  return [round6(tx + x * Math.cos(yaw) + z * Math.sin(yaw)),
    round6(-tz + x * Math.sin(yaw) - z * Math.cos(yaw)) || 0];
};

// Zone rings arrive in two states: Acres-exported files carry net rings (inside wall faces),
// Pascal-loaded scenes carry gross rings on the wall centrelines. Plan v1 rooms must bound to
// centrelines, so snap each zone edge onto its collinear boundary wall's centreline and rebuild
// the vertices from consecutive line intersections. Edges already on a centreline do not move;
// anything unmatched keeps the zone ring as written and validation downstream has the last word.
function snapRoomPolygon(polygon, boundaryWalls) {
  if (!boundaryWalls.length || polygon.length < 3) return polygon;
  const lines = polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const dir = [b[0] - a[0], b[1] - a[1]], len = Math.hypot(...dir);
    if (len < 1e-9) return null;
    const unit = [dir[0] / len, dir[1] / len];
    let point = a;
    for (const wall of boundaryWalls) {
      const wdir = [wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]], wlen = Math.hypot(...wdir);
      if (wlen < 1e-9) continue;
      const wunit = [wdir[0] / wlen, wdir[1] / wlen];
      if (Math.abs(unit[0] * wunit[1] - unit[1] * wunit[0]) > 0.02) continue;
      const dist = Math.abs((wall.start[0] - a[0]) * unit[1] - (wall.start[1] - a[1]) * unit[0]);
      if (dist < 0.3) { point = wall.start; break; }
    }
    return {point, dir: unit};
  });
  if (lines.some(l => !l)) return polygon;
  const intersect = (l1, l2) => {
    const den = l1.dir[0] * l2.dir[1] - l1.dir[1] * l2.dir[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((l2.point[0] - l1.point[0]) * l2.dir[1] - (l2.point[1] - l1.point[1]) * l2.dir[0]) / den;
    return [round6(l1.point[0] + l1.dir[0] * t), round6(l1.point[1] + l1.dir[1] * t)];
  };
  const snapped = polygon.map((vertex, i) => intersect(lines[(i + lines.length - 1) % lines.length], lines[i]) || vertex);
  return snapped;
}

export function pascalSceneToPlan(scene, {name} = {}) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error('The Pascal scene must be a JSON object.');
  const nodes = scene.nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) throw new Error('The Pascal scene has no nodes object.');
  const entries = Object.entries(nodes).filter(([, n]) => n && typeof n === 'object');
  if (!entries.length || entries.length > MAX_NODES) throw new Error(`The Pascal scene must hold 1 to ${MAX_NODES} nodes.`);
  const warnings = [];
  const byType = type => entries.filter(([, n]) => n.type === type);
  const used = new Set();
  const claim = (node, fallback) => {
    let id = idOk(node.metadata?.acresId) ? node.metadata.acresId : fallback;
    if (used.has(id)) { let i = 2; while (used.has(`${id}-${i}`)) i++; id = `${id}-${i}`; warnings.push(`Duplicate element id renamed to ${id}.`); }
    used.add(id);
    return id;
  };

  const levelNodes = byType('level').sort((a, b) => finite(a[1].level, 0) - finite(b[1].level, 0));
  if (!levelNodes.length) throw new Error('The Pascal scene has no levels to import.');
  const levelIdOf = new Map(), levelBuilding = new Map(), levels = [];
  // baseElevation offsets the running stack, independently for each building.
  const buildings = byType('building'), stackTop = new Map();
  levelNodes.forEach(([nodeId, node], i) => {
    const height = finite(node.height) > 0 ? finite(node.height) : 2.8;
    if (!Number.isFinite(Number(node.height))) warnings.push(`Level ${node.name || i + 1} had no height; 2.8 m assumed.`);
    const id = claim(node, `level-${i + 1}`);
    levelIdOf.set(nodeId, id);
    const owner = buildings.find(([id]) => id === node.parentId)
      ?? buildings.find(([, building]) => building.children?.includes(nodeId));
    const buildingId = owner?.[0] ?? null, building = owner?.[1];
    if ((building?.rotation?.[0] ?? 0) !== 0 || (building?.rotation?.[2] ?? 0) !== 0)
      throw new Error(`Pascal building ${building.name || buildingId} is tilted. Plan floors must be horizontal; use an upright building before importing.`);
    levelBuilding.set(nodeId, building);
    const base = (stackTop.get(buildingId) ?? 0) + finite(node.baseElevation, 0);
    levels.push({id, name: typeof node.name === 'string' && node.name.trim() ? node.name.slice(0, 100) : `Level ${i + 1}`, elevation: round6(base + (building?.position?.[1] ?? 0)), height: round6(height), slabThickness: 0.2});
    stackTop.set(buildingId, base + height);
  });
  const slabThickness = new Map();
  for (const [, node] of byType('slab')) {
    const levelId = levelIdOf.get(node.parentId);
    if (levelId && finite(node.thickness) > 0) slabThickness.set(levelId, round6(node.thickness));
  }
  for (const level of levels) if (slabThickness.has(level.id)) level.slabThickness = slabThickness.get(level.id);

  const wallIdOf = new Map(), walls = [];
  for (const [nodeId, node] of byType('wall')) {
    const levelId = levelIdOf.get(node.parentId);
    if (!levelId || !finitePair(node.start) || !finitePair(node.end)) { warnings.push(`Wall ${node.name || nodeId} skipped: missing level or endpoints.`); continue; }
    const id = claim(node, `wall-pascal-${nodeId.slice(-8)}`);
    wallIdOf.set(nodeId, id);
    const level = levels.find(l => l.id === levelId);
    walls.push({
      id, levelId, start: planPoint(node.start, levelBuilding.get(node.parentId)), end: planPoint(node.end, levelBuilding.get(node.parentId)),
      thickness: finite(node.thickness) > 0 ? round6(Math.min(finite(node.thickness), 1)) : 0.15,
      height: finite(node.height) > 0 ? round6(node.height) : level.height,
      material: typeof node.metadata?.material === 'string' ? node.metadata.material.slice(0, 40) : 'generic',
      roomIds: [],
    });
  }
  if (!walls.length) throw new Error('The Pascal scene has no importable walls.');

  const openings = [];
  for (const [nodeId, node] of [...byType('door'), ...byType('window')]) {
    const wallId = wallIdOf.get(node.wallId || node.parentId);
    const width = finite(node.width), height = finite(node.height), pos = Array.isArray(node.position) ? node.position : [];
    if (!wallId || !(width > 0) || !(height > 0) || !Number.isFinite(Number(pos[0]))) { warnings.push(`Opening ${node.name || nodeId} skipped: missing wall or size.`); continue; }
    const offset = Number(pos[0]) - width / 2;
    if (offset < -0.01) warnings.push(`Opening ${node.name || nodeId} starts before its wall; clamped to the wall start.`);
    openings.push({
      id: claim(node, `opening-pascal-${nodeId.slice(-8)}`), wallId, kind: node.type,
      offset: round6(Math.max(0, offset)), width: round6(width),
      sill: round6(Math.max(0, (Number.isFinite(Number(pos[1])) ? Number(pos[1]) : height / 2) - height / 2)),
      height: round6(height), swing: node.metadata?.swing ?? null,
    });
  }

  const rooms = [];
  for (const [nodeId, node] of byType('zone')) {
    // The exporter uses marked zones to keep courtyard gaps outside the room set.
    if (node.metadata?.floorVoid === true) continue;
    const levelId = levelIdOf.get(node.parentId);
    const polygon = Array.isArray(node.polygon) && node.polygon.length >= 3 && node.polygon.every(finitePair) ? node.polygon.map(point => planPoint(point, levelBuilding.get(node.parentId))) : null;
    if (!levelId || !polygon) { warnings.push(`Room ${node.name || nodeId} skipped: missing level or polygon.`); continue; }
    const id = claim(node, `room-pascal-${nodeId.slice(-8)}`);
    const boundaryWalls = (Array.isArray(node.boundaryWallIds) ? node.boundaryWallIds : [])
      .map(boundary => walls.find(w => w.id === wallIdOf.get(boundary))).filter(Boolean);
    rooms.push({id, levelId, name: typeof node.name === 'string' && node.name.trim() ? node.name.slice(0, 100) : 'Room', polygon: snapRoomPolygon(polygon, boundaryWalls), netAreaMethod: 'inside-wall-faces'});
    for (const wall of boundaryWalls) if (!wall.roomIds.includes(id)) wall.roomIds.push(id);
  }
  for (const wall of walls) wall.roomIds.sort();

  const handled = new Set(['level', 'wall', 'door', 'window', 'zone', 'slab', 'site', 'building']);
  const dropped = {};
  for (const [, node] of entries) if (!handled.has(node.type)) dropped[node.type || 'unknown'] = (dropped[node.type || 'unknown'] || 0) + 1;
  for (const [type, count] of Object.entries(dropped)) warnings.push(`${count} ${type} node(s) have no plan meaning and were not imported.`);
  if (!rooms.length) warnings.push('The scene has no room zones; the imported plan will have walls but no rooms until zones are added in Pascal or rooms are drawn in the editor.');

  const building = byType('building')[0]?.[1];
  const planName = (typeof name === 'string' && name.trim()) || building?.name || 'Imported Pascal plan';
  const plan = {
    schema: 'acres.architecture.plan/1', id: 'import', revision: 1, parentRevision: null,
    name: String(planName).slice(0, 200), units: 'm', levels, walls, openings, rooms, objects: [],
    sources: [{kind: 'pascal-scene', ref: String(planName).slice(0, 200)}],
  };
  return {plan, warnings};
}
