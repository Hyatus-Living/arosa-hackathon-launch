// Pure logic behind the architecture viewer: the manifest selection map, walker collision, camera
// stops and mode state. No React or Three.js here, so it runs under node --test.
//
// Coordinates: the plan document is in metres with x east and y north. The GLB and the 3D views
// use glTF axes, y up and z = -north, so a plan point [x, y] at height h is the world point
// [x, h, -y]. Collision works in the world's horizontal x/z plane.

export const EYE_HEIGHT = {initial: 1.6, min: 1.2, max: 2};
// Knee and chest slices sit below every door head and catch the wall under a window sill.
// Radius keeps the eye a readable distance from a wall it walks into (a flat, screen-filling
// surface otherwise) while still clearing a standard 0.8 m doorway.
const WALKER = {radius: 0.35, stepUp: 0.35, slices: [0.35, 1.5]};

// The glTF loader renames nodes with PropertyBinding.sanitizeNodeName; match manifest names the same way.
export const nodeName = name => name.replace(/\s/g, '_').replace(/[[\]\.:\/]/g, '');

export function selectionIndex(manifest) {
  const objects = new Map(), rooms = new Map();
  for (const object of manifest.objects) {
    const name = nodeName(object.glbNodeName);
    objects.set(name, object);
    if (object.roomId) rooms.set(object.roomId, [...(rooms.get(object.roomId) || []), name]);
  }
  return {
    objects,
    rooms,
    walls: new Set(manifest.collision.walls.map(w => nodeName(w.glbNodeName))),
    floors: new Set(manifest.collision.floors.map(f => nodeName(f.glbNodeName))),
  };
}

// names: the picked mesh's name followed by its ancestors' names, nearest first.
export function pickRoom(index, names) {
  const name = names.find(n => index.objects.has(n));
  if (!name) return null;
  const object = index.objects.get(name);
  return {objectName: name, roomId: object.roomId ?? null, levelId: object.levelId ?? null};
}

// Triangles of an indexed or plain position buffer in world space, nine numbers per triangle.
export function worldTriangles(positions, indices, m) {
  const count = indices ? indices.length : positions.length / 3;
  const out = new Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = (indices ? indices[i] : i) * 3, x = positions[v], y = positions[v + 1], z = positions[v + 2];
    out[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

// Where triangles cross the horizontal plane at height y, as [x1, z1, x2, z2] segments.
export function sliceSegments(triangles, y) {
  const segments = [];
  for (let t = 0; t < triangles.length; t += 9) {
    const hits = [];
    for (let a = 0; a < 3; a++) {
      const p = t + a * 3, q = t + ((a + 1) % 3) * 3;
      const ya = triangles[p + 1], yb = triangles[q + 1];
      if ((ya - y) * (yb - y) >= 0) continue;
      const k = (y - ya) / (yb - ya);
      hits.push(triangles[p] + k * (triangles[q] - triangles[p]), triangles[p + 2] + k * (triangles[q + 2] - triangles[p + 2]));
    }
    if (hits.length === 4) segments.push(hits);
  }
  return segments;
}

// Collision for one level: wall outlines at walker heights above its floor, plus the floor triangles.
export function collisionWorld({walls, floors, elevation, baseElevation = elevation}) {
  return {segments: WALKER.slices.flatMap(h => sliceSegments(walls, elevation + h)), floors, baseElevation, radius: WALKER.radius, stepUp: WALKER.stepUp};
}

function closest(px, pz, [ax, az, bx, bz]) {
  const dx = bx - ax, dz = bz - az, len = dx * dx + dz * dz;
  const k = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len)) : 0;
  return [ax + k * dx, az + k * dz];
}

// Moves a circle of the given radius by delta, pushing it out of every segment it overlaps.
// Sub-steps shorter than the radius keep a fast move from jumping through a wall.
export function resolveMove(from, delta, segments, radius) {
  const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.z) / (radius * 0.5)));
  let x = from.x, z = from.z;
  for (let s = 0; s < steps; s++) {
    x += delta.x / steps;
    z += delta.z / steps;
    for (let pass = 0; pass < 3; pass++) {
      for (const segment of segments) {
        const [qx, qz] = closest(x, z, segment);
        const d = Math.hypot(x - qx, z - qz);
        if (d >= radius || d === 0) continue;
        x = qx + ((x - qx) / d) * radius;
        z = qz + ((z - qz) / d) * radius;
      }
    }
  }
  return {x, z};
}

// Height of the highest level floor triangle under (x, z) that is no higher than maxY. Either
// winding counts, since exporters disagree on which side of a slab faces up.
export function groundHeight(floors, x, z, maxY) {
  let best = null;
  for (let t = 0; t < floors.length; t += 9) {
    const ax = floors[t], ay = floors[t + 1], az = floors[t + 2];
    const bx = floors[t + 3] - ax, by = floors[t + 4] - ay, bz = floors[t + 5] - az;
    const cx = floors[t + 6] - ax, cy = floors[t + 7] - ay, cz = floors[t + 8] - az;
    const ny = bz * cx - bx * cz;
    const nLength = Math.hypot(by * cz - bz * cy, ny, bx * cy - by * cx);
    if (!nLength || Math.abs(ny) / nLength < 0.5) continue;
    const px = x - ax, pz = z - az, det = bx * cz - cx * bz;
    const u = (px * cz - cx * pz) / det, v = (bx * pz - px * bz) / det;
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
    const y = ay + u * by + v * cy;
    if (y <= maxY + 1e-9 && (best === null || y > best)) best = y;
  }
  return best;
}

// One walker step: slide against walls, then stand on the floor below. Off every floor, the walker
// stands on the site at the lowest level; above it, a step with no floor beneath is refused.
export function stepWalker(walker, delta, world) {
  const next = resolveMove(walker, delta, world.segments, world.radius);
  let feet = groundHeight(world.floors, next.x, next.z, walker.feet + world.stepUp);
  if (feet === null) {
    if (walker.feet - world.baseElevation > world.stepUp) return walker;
    feet = world.baseElevation;
  }
  return {x: next.x, z: next.z, feet};
}

export function pointInPolygon([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const levelOf = (plan, item) => item.levelId ?? plan.levels[0].id;
export const roomsOn = (plan, levelId) => plan.rooms.filter(r => levelOf(plan, r) === levelId);
// What each room on a level is, as the planner drew it: part of a whole apartment (a room with a unit id),
// a space the floor laid out for a unit that holds no whole apartment (the planner names it so and counts
// no unit there), or shared space. Returns {rooms: Map(roomId -> 'whole' | 'short' | 'shared'), whole, short}.
export const SHORT_SPACE = 'Space too small for a unit';
export function unitCheck(plan, levelId) {
  const rooms = new Map(), units = new Set();
  let short = 0;
  for (const room of roomsOn(plan, levelId)) {
    if (room.unitId) { rooms.set(room.id, 'whole'); units.add(room.unitId); }
    else if (room.name === SHORT_SPACE) { rooms.set(room.id, 'short'); short += 1; }
    else rooms.set(room.id, 'shared');
  }
  return {rooms, whole: units.size, short};
}
export const polygonArea = polygon => Math.abs(polygon.reduce((s, [x, y], i) => { const [nx, ny] = polygon[(i + 1) % polygon.length]; return s + x * ny - nx * y; }, 0)) / 2;
// Dragging in Walk looks the way the pointer moves (drag right looks right, drag up looks
// up), like every first-person view. The dollhouse orbit keeps grab-the-world dragging.
export function dragLook(view, dx, dy, speed) {
  return {yaw: view.yaw - dx * speed, pitch: Math.max(-1.2, Math.min(1.2, view.pitch - dy * speed))};
}
// The apartments on a level for the exploded view: name, bedrooms, area (m²) and the area-weighted plan centre.
export function unitCards(plan, levelId) {
  const units = new Map();
  for (const room of roomsOn(plan, levelId)) {
    if (!room.unitId) continue;
    const a = polygonArea(room.polygon), [cx, cy] = centroid(room.polygon);
    const unit = units.get(room.unitId) ?? {id: room.unitId, name: room.name.match(/^Unit \S+/)?.[0] ?? 'Apartment', beds: room.beds ?? null, area: 0, x: 0, y: 0};
    unit.area += a; unit.x += cx * a; unit.y += cy * a;
    units.set(room.unitId, unit);
  }
  return [...units.values()].map(({x, y, ...unit}) => ({...unit, at: [x / unit.area, y / unit.area]}));
}
// The exploded dollhouse lifts each storey of the published model EXPLODE_GAP metres more than the one below,
// and every storey above the open one a further `reveal` metres so the open floor shows from above.
export const EXPLODE_GAP = 1.2;
export function storeyLifts(storeys, openId = null, reveal = 0) {
  const sorted = [...storeys].sort((a, b) => a.elevation - b.elevation);
  const open = sorted.findIndex(s => s.id === openId);
  return new Map(sorted.map((s, i) => [s.id, i * EXPLODE_GAP + (open >= 0 && i > open ? reveal : 0)]));
}
// The highest storey a plan level stands for (a typical floor covers several).
export const levelTop = level => level.storeys?.at(-1)?.elevation ?? level.elevation;

// One frame of the plan-to-3D story at progress 0..1. Up to STORY_RISE the camera looks straight down at
// the chosen floor while the section cut rises from the slab to STORY_CUT, so the walls grow into a plan;
// after that the cut climbs past the roof as the camera swings down to a three-quarter view.
export const STORY_CUT = 1.2;
const STORY_RISE = 0.4;
const ease = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
export function storyFrame(progress, {center: [cx, cy, cz], span, floor, top}) {
  const p = Math.min(1, Math.max(0, progress));
  const t = ease(Math.max(0, (p - STORY_RISE) / (1 - STORY_RISE)));
  const cut = p < STORY_RISE ? floor + lerp(0.05, STORY_CUT, p / STORY_RISE) : lerp(floor + STORY_CUT, top + 1, t);
  const target = [cx, lerp(floor, cy, t), cz];
  const polar = lerp(0.001, 1, t), azimuth = lerp(0, -0.6, t), radius = lerp(span, span * 1.5, t);
  const position = [cx + radius * Math.sin(polar) * Math.sin(azimuth), target[1] + radius * Math.cos(polar), cz + radius * Math.sin(polar) * Math.cos(azimuth)];
  return {cut, target, position};
}
export const roomAt = (plan, levelId, point) => roomsOn(plan, levelId).find(r => pointInPolygon(point, r.polygon))?.id ?? null;
export const centroid = polygon => [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length];

// The middle of an opening, its wall normal and the room found a little way out on each side
// (null for outdoors): sides[0] lies along +normal, sides[1] along -normal.
export function doorSides(plan, opening) {
  const wall = plan.walls.find(w => w.id === opening.wallId);
  const [x1, y1] = wall.start, [x2, y2] = wall.end;
  const length = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / length, uy = (y2 - y1) / length;
  const along = opening.offset + opening.width / 2;
  const center = [x1 + ux * along, y1 + uy * along], normal = [-uy, ux];
  const probe = wall.thickness / 2 + 0.3, levelId = levelOf(plan, wall);
  const sides = [1, -1].map(s => roomAt(plan, levelId, [center[0] + normal[0] * probe * s, center[1] + normal[1] * probe * s]));
  return {center, normal, wall, levelId, sides};
}

const offset = ([x, y], [nx, ny], d) => [x + nx * d, y + ny * d];

export function entrance(plan, levelId) {
  for (const opening of plan.openings.filter(o => o.kind === 'door')) {
    const door = doorSides(plan, opening);
    if (door.levelId !== levelId || (door.sides[0] === null) === (door.sides[1] === null)) continue;
    const inward = door.sides[0] === null ? [-door.normal[0], -door.normal[1]] : door.normal;
    return {opening, roomId: door.sides[0] ?? door.sides[1], center: door.center, inward, outside: offset(door.center, inward, -1.5), inside: offset(door.center, inward, 0.9)};
  }
  return null;
}

function levelBounds(plan, levelId) {
  const points = [...plan.walls.filter(w => levelOf(plan, w) === levelId).flatMap(w => [w.start, w.end]), ...roomsOn(plan, levelId).flatMap(r => r.polygon)];
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return {minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys)};
}

// Orbit pose looking down at a plan point from the south-east, far enough to frame `size` metres.
function orbitAt([x, y], elevation, size) {
  const target = [x, elevation + 0.6, -y], d = size * 0.8 + 2.5;
  return {target, position: [x + d * 0.45, elevation + d * 0.85, -y + d * 0.55]};
}

// Named camera stops: an overview of the ground level, the entrance and one per room. Walk poses
// stand at eye height just inside a room's door looking toward its centre; orbit poses frame it.
export function cameraStops(plan, {eyeHeight}) {
  const ground = plan.levels[0];
  const b = levelBounds(plan, ground.id);
  const stops = [{id: 'overview', name: 'Overview', levelId: ground.id, roomId: null, walk: null, orbit: orbitAt([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], ground.elevation, Math.hypot(b.maxX - b.minX, b.maxY - b.minY))}];
  const doors = plan.openings.filter(o => o.kind === 'door').map(o => doorSides(plan, o));
  const eye = (levelId, [x, y]) => [x, plan.levels.find(l => l.id === levelId).elevation + eyeHeight, -y];
  const door = entrance(plan, ground.id);
  if (door) {
    stops.push({id: 'entrance', name: 'Entrance', levelId: ground.id, roomId: null,
      walk: {position: eye(ground.id, door.outside), target: eye(ground.id, offset(door.center, door.inward, 3))},
      orbit: (({target}) => ({target, position: [target[0] - door.inward[0] * 7, ground.elevation + 5, target[2] + door.inward[1] * 7]}))(orbitAt(door.center, ground.elevation, 4))});
  }
  for (const room of plan.rooms) {
    const levelId = levelOf(plan, room), level = plan.levels.find(l => l.id === levelId);
    const middle = centroid(room.polygon);
    const xs = room.polygon.map(p => p[0]), ys = room.polygon.map(p => p[1]);
    const into = doors.find(d => d.levelId === levelId && d.sides.includes(room.id));
    let stand = middle, look = [middle[0], middle[1] + 1];
    if (into) {
      const normal = into.sides[0] === room.id ? into.normal : [-into.normal[0], -into.normal[1]];
      const inside = offset(into.center, normal, 0.45);
      stand = pointInPolygon(inside, room.polygon) ? inside : middle;
      look = Math.hypot(middle[0] - stand[0], middle[1] - stand[1]) > 0.2 ? middle : offset(stand, normal, 2);
      // A slight angle shows the room's depth instead of starting face-on to a blank wall.
      const angled = offset(look, [-normal[1], normal[0]], 0.4);
      if (pointInPolygon(angled, room.polygon)) look = angled;
    }
    stops.push({id: `room:${room.id}`, name: room.name, levelId, roomId: room.id,
      walk: {position: eye(levelId, stand), target: eye(levelId, look)},
      orbit: orbitAt(middle, level.elevation, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)))});
  }
  // A plan with neither a door nor a room still walks: from the middle of the ground level.
  if (!stops.some(s => s.walk)) {
    const middle = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    stops[0].walk = {position: eye(ground.id, middle), target: eye(ground.id, [middle[0], middle[1] + 1])};
  }
  return stops;
}

// Viewer state: plan, dollhouse or walk; the level shown; the selection shared by plan and 3D;
// and the latest camera command (pose), which a 3D mode applies when its seq changes.
export function initialArchitectureState({plan}, {webgl}) {
  return {mode: 'plan', levelId: plan.levels[0].id, roomId: null, objectName: null, eyeHeight: EYE_HEIGHT.initial,
    unavailable: webgl ? null : 'webgl', pose: {stopId: null, mode: null, seq: 0}, started: {dollhouse: false, walk: false}};
}

export function architectureReducer({plan, manifest}) {
  const index = selectionIndex(manifest);
  const stops = cameraStops(plan, {eyeHeight: EYE_HEIGHT.initial});
  const pose = (state, stopId, mode = state.mode) => ({...state, pose: {stopId, mode, seq: state.pose.seq + 1}});
  // Walk opens in the largest living space on the ground floor, so the first frame reads as
  // being inside the home rather than facing a stair-enclosure wall; the entrance stays a
  // Go-to stop, and plans with no living space start at the entrance or the first walk pose.
  const circulation = /stair|enclosure|elevator|lift|shaft|corridor|hallway|lobby|vestibule|entry|foyer/i;
  const livingRooms = plan.rooms
    .filter(room => levelOf(plan, room) === plan.levels[0].id && !circulation.test(room.name))
    .sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon));
  const walkStart = stops.find(s => s.id === `room:${livingRooms[0]?.id}`)
    ?? stops.find(s => s.id === 'entrance') ?? stops.find(s => s.walk);
  return function reduce(state, action) {
    switch (action.type) {
      case 'mode': {
        if (action.mode !== 'plan' && state.unavailable) return state;
        const next = {...state, mode: action.mode};
        if (action.mode === 'plan' || state.started[action.mode]) return next;
        const first = action.mode === 'walk' ? walkStart : stops[0];
        return pose({...next, levelId: first.levelId, started: {...state.started, [action.mode]: true}}, first.id);
      }
      case 'select-room': {
        const room = plan.rooms.find(r => r.id === action.roomId);
        return {...state, roomId: room?.id ?? null, objectName: null, levelId: room ? levelOf(plan, room) : state.levelId};
      }
      case 'select-object': {
        const object = index.objects.get(action.name);
        if (!object) return {...state, roomId: null, objectName: null};
        return {...state, roomId: object.roomId ?? null, objectName: action.name, levelId: object.levelId ?? state.levelId};
      }
      case 'level': {
        const room = plan.rooms.find(r => r.id === state.roomId);
        const keep = room && levelOf(plan, room) === action.levelId;
        return {...state, levelId: action.levelId, roomId: keep ? state.roomId : null, objectName: keep ? state.objectName : null};
      }
      case 'stop': {
        const stop = stops.find(s => s.id === action.stopId);
        if (state.mode === 'walk' && !stop.walk) return state;
        return pose({...state, levelId: stop.levelId, roomId: stop.roomId, objectName: null}, stop.id);
      }
      case 'reset': {
        const reset = pose({...state, roomId: null, objectName: null, levelId: plan.levels[0].id}, state.mode === 'walk' ? walkStart.id : 'overview');
        return {...reset, pose: {...reset.pose, reset: true}};
      }
      case 'eye-height':
        return {...state, eyeHeight: Math.round(Math.min(EYE_HEIGHT.max, Math.max(EYE_HEIGHT.min, action.value)) * 20) / 20};
      case 'unavailable':
        return {...state, unavailable: action.reason, mode: 'plan'};
      default:
        throw new Error(`Unknown architecture view action ${action.type}`);
    }
  };
}
