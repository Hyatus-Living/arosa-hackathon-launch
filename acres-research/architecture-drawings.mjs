import {requestSignal,throwIfCancelled} from './execution-context.mjs';
// Floor plan drawings stored per project: the SVG, PDF or raster image a plan is traced from.
// The user uploads one or the agent attaches one by URL; both land here, are served back only
// through the account-scoped architecture routes, and announce themselves on the project event
// stream so an open editor lists them at once. The type comes from the bytes, never a header.
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {lookup as dnsLookup} from 'node:dns/promises';
import {join} from 'node:path';
import {publicUrl,assertPublicDns,pinnedRequest,responseBody} from './public-url.mjs';
export {pinnedRequest};

const MB = 1024 * 1024;
export const DRAWING_KINDS = {
  ifc: {contentType: 'application/x-step', max: 25 * MB},
  svg: {contentType: 'image/svg+xml', max: 2 * MB},
  png: {contentType: 'image/png', max: 15 * MB},
  jpeg: {contentType: 'image/jpeg', max: 15 * MB},
  webp: {contentType: 'image/webp', max: 15 * MB},
  pdf: {contentType: 'application/pdf', max: 25 * MB},
  // An edited Pascal scene returning through the hand-off (acres_import_pascal_scene).
  'pascal-scene': {contentType: 'application/json', max: 10 * MB},
};
export const DRAWING_MAX_BYTES = 25 * MB;
const EXTENSION = {ifc: 'ifc', svg: 'svg', png: 'png', jpeg: 'jpg', webp: 'webp', pdf: 'pdf', 'pascal-scene': 'pascal.json'};

export const DRAWINGS_DDL = `
CREATE TABLE IF NOT EXISTS architecture_drawings(drawing_id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,kind TEXT NOT NULL,content_type TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,path TEXT NOT NULL,source_url TEXT,found_on TEXT,created_by TEXT NOT NULL,created_via TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS architecture_drawings_project ON architecture_drawings(project,created_at DESC);`;

const bad = (message, status = 400) => Object.assign(new Error(message), {status});

// The drawing kind the bytes are, or null.
export function sniffDrawing(bytes) {
  const head = bytes.subarray(0, 16);
  if (bytes.subarray(0, 256).toString().trimStart().startsWith('ISO-10303-21;')) return 'ifc';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const text = bytes.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').trimStart();
  if (/^<svg[\s>]/i.test(text)) return 'svg';
  if (text.startsWith('{') && /"nodes"\s*:/.test(text)) return 'pascal-scene';
  return null;
}

// A display name: printable, at most 200 characters, with the kind's extension.
export function drawingName(value, kind) {
  const base = String(value ?? '').replace(/[\u0000-\u001f\u007f"\\/]/g, '').replace(/\s*[\u2013\u2014]\s*/g, ', ').trim().slice(0, 200).replace(/(?:\.pascal)?\.[A-Za-z0-9]{1,5}$/i, '');
  return `${base || 'drawing'}.${EXTENSION[kind]}`;
}

// Reads a public HTTPS URL up to the drawing cap, re-checking every redirect hop (address, DNS
// and allow(url), which refuses excluded sources) before following it.
export async function fetchDrawing(url, {request = pinnedRequest, lookup = dnsLookup, accept = 'image/*,application/pdf;q=0.9,*/*;q=0.5', allow = () => true} = {}) {
  let current = url, response;
  for (let hops = 0; ; hops++) {
    if (!publicUrl(current)) throw bad('Attach a drawing from a public https:// address.');
    if (!allow(current)) throw bad('That address is not a usable plan source.');
    const addresses=await assertPublicDns(new URL(current).hostname, lookup);
    response = await request(current, {headers: {'user-agent': 'ArosaResearch/1.0 (floor plan retrieval)', accept,'accept-encoding':'gzip, deflate, br'}, signal: requestSignal(45000),lookup:async()=>addresses});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    response.body?.destroy?.();
    const location = response.headers.get('location');
    if (!location || hops === 4) throw bad('The drawing address redirects without an end.', 502);
    current = new URL(location, current).href;
  }
  if (!response.ok) { response.body?.destroy?.(); throw bad(`The drawing address returned HTTP ${response.status}.`, 502); }
  const body=responseBody(response),chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > DRAWING_MAX_BYTES) { body.destroy?.(); throw bad('The drawing exceeds 25 MB.', 413); }
    chunks.push(Buffer.from(chunk));
  }
  return {bytes: Buffer.concat(chunks), finalUrl: current, contentType: response.headers.get('content-type') || ''};
}

// A Content-Disposition value any name survives: an ASCII fallback plus the UTF-8 name.
export const contentDisposition = name => `inline; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
const decoded = value => { try { return decodeURIComponent(value); } catch { return value; } };

const view = r => ({id: r.drawing_id, name: r.name, kind: r.kind, contentType: r.content_type, bytes: r.bytes, sha256: r.sha256,
  sourceUrl: r.source_url, foundOn: r.found_on, createdAt: r.created_at, createdBy: r.created_by, by: r.created_via});

export class Drawings {
  // store: the ChatStore (access checks and the project event stream).
  constructor(store, {stateDir, fetchDrawing: fetcher = fetchDrawing}) {
    // fetcher(url, {allow}) downloads a URL; allow(url) refuses excluded sources on every hop.
    this.store = store;
    this.root = join(stateDir, 'architecture', 'drawings');
    this.fetchDrawing = fetcher;
  }
  list(account, projectId) {
    this.store.requireProject(account, projectId, 'viewer');
    return this.store.query('SELECT * FROM architecture_drawings WHERE project=? ORDER BY created_at DESC,rowid DESC', projectId).map(view);
  }
  row(projectId, drawingId) { return this.store.one('SELECT * FROM architecture_drawings WHERE project=? AND drawing_id=?', projectId, drawingId) ?? null; }

  // Stores the bytes as a new drawing and announces it; by is "user" or "agent".
  add(account, projectId, {bytes, name, sourceUrl = null, foundOn = null, by}) {
    this.store.requireProject(account, projectId, 'participant');
    const kind = sniffDrawing(bytes);
    if (!kind) throw bad('Upload an SVG, PDF, PNG, JPEG or WebP drawing, or a Pascal scene JSON.', 415);
    const {contentType, max} = DRAWING_KINDS[kind];
    if (bytes.length > max) throw bad(`The ${kind.toUpperCase()} drawing exceeds ${max / MB} MB.`, 413);
    const id = randomUUID(), dir = join(this.root, projectId), path = join(dir, `${id}.${EXTENSION[kind]}`);
    mkdirSync(dir, {recursive: true, mode: 0o700});
    writeFileSync(path, bytes, {mode: 0o600});
    const row = {drawing_id: id, project: projectId, name: drawingName(name, kind), kind, content_type: contentType, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), path, source_url: sourceUrl, found_on: foundOn, created_by: account, created_via: by, created_at: Date.now()};
    this.store.write('INSERT INTO architecture_drawings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', ...Object.values(row));
    const event = this.store.appendProjectEvent(projectId, 'architecture.drawing', {projectId, drawingId: id, name: row.name, kind, by});
    this.store.projectFeed.emit(projectId, event);
    return view(row);
  }

  async addFromUrl(account, projectId, {url, name, foundOn = null, by, allow}) {
    this.store.requireProject(account, projectId, 'participant');
    if (typeof url !== 'string' || url.length > 2000) throw bad('Send the drawing address as url.');
    const {bytes, finalUrl} = await this.fetchDrawing(url, {allow});
    throwIfCancelled();
    const fallback = decoded(new URL(finalUrl).pathname.split('/').pop() || '');
    return this.add(account, projectId, {bytes, name: name || fallback, sourceUrl: finalUrl, foundOn, by});
  }

  // The stored row and a stream, or null when the account cannot read the project.
  open(account, projectId, drawingId) {
    if (!this.store.projectAccess(account, projectId)) return null;
    const row = this.row(projectId, drawingId);
    if (!row || !row.path.startsWith(this.root + '/')) return null;
    const stat = lstatSync(row.path, {throwIfNoEntry: false});
    if (!stat?.isFile() || stat.size !== row.bytes) return null;
    return {drawing: view(row), stream: () => createReadStream(row.path), read: () => readFileSync(row.path)};
  }
}
