import React from 'react';
import {centroid, levelOf, roomsOn, unitCheck} from './architecture-model.mjs';

// The plan follows the app theme like the concept plan: a light sheet by day, a dark one at night.
function palette() {
  const night = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return night
    ? {sheet: '#1d1f1b', room: '#262923', roomHover: '#30342c', selected: '#3d5fb8', wall: '#ece7da', opening: '#9aa093', glass: '#7fb3cf', ink: '#ece9e2', muted: '#a9ada2', walker: '#ff8a4c', whole: '#24382b', short: '#4a3a1c', shortLine: '#e0a64a'}
    : {sheet: '#eef0e9', room: '#f7f8f3', roomHover: '#e6e9df', selected: '#c9d6f5', wall: '#2b2520', opening: '#6d7266', glass: '#5d97b8', ink: '#1f1b17', muted: '#5d6356', walker: '#d4561c', whole: '#dcebd9', short: '#f6deb0', shortLine: '#b9771b'};
}

const area = polygon => Math.abs(polygon.reduce((s, [x, y], i) => { const [nx, ny] = polygon[(i + 1) % polygon.length]; return s + x * ny - nx * y; }, 0)) / 2;
// Plans are drawn in metres; areas are shown in square feet.
const formatArea = polygon => `${Math.round(area(polygon) / 0.09290304).toLocaleString('en-US')} sq ft`;
// Plan y points north; SVG y points down, so every point is drawn at (x, -y).
const path = polygon => polygon.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${-y}`).join(' ') + ' Z';

// A wall drawn as solid pieces between its openings. Pieces run half a thickness past the
// wall's own ends so corners close, but stop flush at each opening.
function wallPieces(wall, openings) {
  const [x1, y1] = wall.start, [x2, y2] = wall.end;
  const length = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / length, uy = (y2 - y1) / length;
  const nx = -uy * wall.thickness / 2, ny = ux * wall.thickness / 2;
  const at = (s, side) => [x1 + ux * s + nx * side, y1 + uy * s + ny * side];
  const quad = (a, b) => [at(a, 1), at(b, 1), at(b, -1), at(a, -1)];
  const cuts = openings.map(o => [o.offset, o.offset + o.width]).sort((p, q) => p[0] - q[0]);
  const pieces = [];
  let cursor = -wall.thickness / 2;
  for (const [a, b] of cuts) { if (a > cursor) pieces.push(quad(cursor, a)); cursor = b; }
  pieces.push(quad(cursor, length + wall.thickness / 2));
  return {pieces, at, ux, uy};
}

// check marks each room as part of a whole apartment, a space too small for a unit, or shared space.
export function ArchitecturePlan({plan, levelId, roomId, onSelectRoom, walker, compact, check}) {
  const P = palette();
  const walls = plan.walls.filter(w => levelOf(plan, w) === levelId);
  const rooms = roomsOn(plan, levelId);
  const points = [...walls.flatMap(w => [w.start, w.end]), ...rooms.flatMap(r => r.polygon)];
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY);
  const pad = compact ? size * 0.18 : size * 0.12 + 0.6;
  const view = {x: minX - pad, y: -maxY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2};
  const font = size / 34, line = size / 400;
  const level = plan.levels.find(l => l.id === levelId);
  const status = check ? unitCheck(plan, levelId) : null;
  const fill = room => room.id === roomId ? P.selected : status ? {whole: P.whole, short: 'url(#arch-short)', shared: P.room}[status.rooms.get(room.id)] : P.room;
  return (
    <svg className={`concept-plan arch-plan${compact ? ' arch-minimap' : ''}`} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Plan of ${plan.name || 'the building'}, ${level.name}`}>
      <rect x={view.x} y={view.y} width={view.w} height={view.h} fill={P.sheet} />
      {status && (
        <defs>
          <pattern id="arch-short" patternUnits="userSpaceOnUse" width={font * 0.6} height={font * 0.6} patternTransform="rotate(45)">
            <rect width={font * 0.6} height={font * 0.6} fill={P.short} />
            <line x1="0" y1="0" x2="0" y2={font * 0.6} stroke={P.shortLine} strokeWidth={line * 3} />
          </pattern>
        </defs>
      )}
      {rooms.map(room => (
        <path key={room.id} className="arch-room" d={path(room.polygon)} data-room={room.id} data-check={status?.rooms.get(room.id)} fill={fill(room)}
          style={{'--arch-room-hover': room.id === roomId ? P.selected : P.roomHover}}
          onClick={onSelectRoom ? () => onSelectRoom(room.id === roomId ? null : room.id) : undefined}>
          <title>{room.name}</title>
        </path>
      ))}
      {walls.map(wall => {
        const openings = plan.openings.filter(o => o.wallId === wall.id);
        const {pieces, at, ux, uy} = wallPieces(wall, openings);
        return (
          <g key={wall.id}>
            {pieces.map((piece, i) => <path key={i} d={path(piece)} fill={P.wall} />)}
            {!compact && openings.map(o => {
              if (o.kind === 'window') {
                const [a, b] = [at(o.offset, 0), at(o.offset + o.width, 0)];
                return <g key={o.id} data-opening={o.id}>
                  <path d={path([at(o.offset, 1), at(o.offset + o.width, 1), at(o.offset + o.width, -1), at(o.offset, -1)])} fill={P.sheet} stroke={P.opening} strokeWidth={line} />
                  <line x1={a[0]} y1={-a[1]} x2={b[0]} y2={-b[1]} stroke={P.glass} strokeWidth={line * 2.5} />
                </g>;
              }
              // A door leaf opened 90 degrees from its hinge, with the swing arc.
              const hinge = at(o.offset, 0), close = at(o.offset + o.width, 0);
              const leaf = [hinge[0] - uy * o.width, hinge[1] + ux * o.width];
              return <g key={o.id} data-opening={o.id} fill="none" stroke={P.opening} strokeWidth={line}>
                <line x1={hinge[0]} y1={-hinge[1]} x2={leaf[0]} y2={-leaf[1]} strokeWidth={line * 2} />
                <path d={`M${leaf[0]} ${-leaf[1]} A${o.width} ${o.width} 0 0 1 ${close[0]} ${-close[1]}`} strokeDasharray={`${line * 4} ${line * 3}`} />
              </g>;
            })}
          </g>
        );
      })}
      {!compact && rooms.map(room => {
        const [cx, cy] = centroid(room.polygon);
        const width = Math.max(...room.polygon.map(p => p[0])) - Math.min(...room.polygon.map(p => p[0]));
        const size = Math.min(font, width / Math.max(room.name.length * 0.62, 1));
        return (
          <g key={room.id} className="arch-label" fontFamily="system-ui, sans-serif" textAnchor="middle" pointerEvents="none">
            <text x={cx} y={-cy} fontSize={size} fill={P.ink} fontWeight="600">{room.name}</text>
            <text x={cx} y={-cy + size * 1.3} fontSize={size * 0.8} fill={P.muted}>{formatArea(room.polygon)}</text>
          </g>
        );
      })}
      {!compact && (
        <g transform={`translate(${view.x + font * 1.4} ${view.y + view.h - font * 1.4})`} fontFamily="system-ui, sans-serif">
          <line x1="0" y1="0" x2="2" y2="0" stroke={P.ink} strokeWidth={line * 3} />
          <line x1="0" y1={-font * 0.3} x2="0" y2={font * 0.3} stroke={P.ink} strokeWidth={line * 3} />
          <line x1="2" y1={-font * 0.3} x2="2" y2={font * 0.3} stroke={P.ink} strokeWidth={line * 3} />
          <text x="1" y={-font * 0.55} fontSize={font * 0.8} textAnchor="middle" fill={P.ink}>2 m</text>
          <g transform={`translate(${view.w - font * 3} ${-view.h + font * 4})`}>
            <path d={`M0 ${-font * 1.2} L${font * 0.6} ${font * 0.8} L0 ${font * 0.4} L${-font * 0.6} ${font * 0.8} Z`} fill={P.ink} />
            <text x="0" y={-font * 1.5} fontSize={font * 0.8} textAnchor="middle" fill={P.ink}>N</text>
          </g>
        </g>
      )}
      {status && (
        <g className="arch-check-legend" fontFamily="system-ui, sans-serif" fontSize={font * 0.8} fill={P.ink}
          transform={`translate(${view.x + font * 1.4} ${view.y + font * 1.6})`}>
          <rect y={-font * 0.7} width={font * 0.9} height={font * 0.9} fill={P.whole} stroke={P.muted} strokeWidth={line} />
          <text x={font * 1.3}>{status.whole} whole apartment{status.whole === 1 ? '' : 's'}</text>
          <rect y={font * 0.6} width={font * 0.9} height={font * 0.9} fill="url(#arch-short)" stroke={P.muted} strokeWidth={line} />
          <text x={font * 1.3} y={font * 1.3}>{status.short} space{status.short === 1 ? '' : 's'} too small for a unit</text>
        </g>
      )}
      {walker && walker.levelId === levelId && (
        <g transform={`translate(${walker.x} ${-walker.y}) rotate(${(-walker.yaw * 180) / Math.PI})`} className="arch-walker">
          <path d={`M0 0 L${-size * 0.05} ${-size * 0.09} A${size * 0.1} ${size * 0.1} 0 0 1 ${size * 0.05} ${-size * 0.09} Z`} fill={P.walker} fillOpacity="0.35" />
          <circle r={size * 0.025} fill={P.walker} stroke={P.sheet} strokeWidth={line * 2} />
        </g>
      )}
    </svg>
  );
}

export {formatArea};
