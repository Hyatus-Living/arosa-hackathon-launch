import {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {
  MousePointer2, PenLine, Scissors, DoorOpen, AppWindow, Ruler, Upload, FileJson, Download, Save,
  Undo2, Redo2, ZoomIn, ZoomOut, Maximize, ScanSearch, Trash2, RotateCcw, Ellipsis,
} from 'lucide-react';
import {
  DEFAULTS, LIMITS, checkUpload, sanitizeSvg, extractPrimitives, proposeFromPrimitives, readingLosses,
  readPascalScene, calibrate, drawingSource, linkDrawingSources, metresPerPixel, toMetres, toPixels, planFromDrawing, planFromJson, blankPlan, detectRooms, validatePlan,
  exportPlan, addWall, splitWall, deleteItem, placeOpening, reprojectPlan, wallLength, moveJoint,
  translateWall, translateOpening, snapPoint, nearestWall, updateItem, interiorPoint, roomArea, roomLabel,
  savePlan, loadPlan, writeDraft, readDraft, clearDraft,
  listDrawings, uploadDrawing, fetchDrawing, planEventActions,
  DEFAULT_SCHEME,
} from '../public/plan-intake.js';
import './plan-editor.css';
import {LoadBoundary} from './load-boundary.jsx';
import {ModelIntake} from './model-intake.jsx';

const roots = new Map();
const HIT_PX = 22; // half of a 44 px target
const FEET = 0.3048;
// Areas are shown in square feet; the plan itself stays in metres.
const sqft = (v) => `${Math.round(v / (FEET * FEET)).toLocaleString('en-US')} sq ft`;
const num = (v, d = 3) => Number(v.toFixed(d));
const KIND_LABELS = {ifc: 'IFC model', svg: 'SVG', pdf: 'PDF', png: 'PNG', jpeg: 'JPEG', webp: 'WebP', 'pascal-scene': 'Pascal scene'};
const baseRef = (ref) => ref.split('#')[0];
const replaces = (update) => `Saving replaces ${update.by === 'agent' ? "Arosa's " : ''}revision ${update.revision}.`;
const storage = () => {
  try { return window.localStorage; } catch { return null; }
};

const UPLOAD_LIMITS = 'SVG up to 2 MB; PNG, JPEG or WebP up to 15 MB; PDF up to 25 MB; an edited .pascal.json scene up to 10 MB.';

// The toolbar's More menu: less frequent file actions, each with a line saying what it does.
function ToolbarMore({items}) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const escape = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector('.plan-more-toggle')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return (
    <div className="plan-more" ref={ref}>
      <button type="button" className="plan-more-toggle" aria-expanded={open} aria-controls="plan-more-menu" aria-label="More file actions" title="More file actions" onClick={() => setOpen(!open)}>
        <Ellipsis aria-hidden="true" /><span className="plan-label">More</span>
      </button>
      {open && (
        <div className="plan-more-menu" id="plan-more-menu" role="group" aria-label="More file actions">
          {items.map(({label, what, Icon, disabled, onSelect}) => (
            <div key={label} className="plan-more-item">
              <button type="button" disabled={disabled} onClick={() => { setOpen(false); onSelect(); }}><Icon aria-hidden="true" />{label}</button>
              <span>{what}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function useHistory(initial) {
  const [state, setState] = useState({past: [], plan: initial, future: []});
  const latest = useRef(state);
  const update = (fn) => {
    const next = fn(latest.current);
    latest.current = next;
    setState(next);
    return next.plan;
  };
  return {
    plan: state.plan,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    current: () => latest.current.plan,
    commit: (next, base = latest.current.plan) => update((s) => ({past: base ? [...s.past, base].slice(-100) : s.past, plan: next, future: []})),
    live: (next) => update((s) => ({...s, plan: next})),
    reset: (next) => update(() => ({past: [], plan: next, future: []})),
    undo: () => update((s) => s.past.length ? {past: s.past.slice(0, -1), plan: s.past.at(-1), future: [s.plan, ...s.future]} : s),
    redo: () => update((s) => s.future.length ? {past: [...s.past, s.plan], plan: s.future[0], future: s.future.slice(1)} : s),
    linkDrawing: (name, drawing) => update((s) => {
      const link = (p) => linkDrawingSources(p, name, drawing);
      return {...s, past: s.past.map(link), plan: link(s.plan), future: s.future.map(link)};
    }),
    acceptSaved: (submitted, saved) => update((s) => {
      const stamp = (p) => p ? {...p, id: saved.id, revision: saved.revision, parentRevision: saved.parentRevision} : null;
      return {past: s.past.map(stamp), plan: s.plan === submitted ? saved : stamp(s.plan), future: s.future.map(stamp)};
    }),
    rebaseRevision: (revision) => update((s) => {
      const stamp = (p) => p ? {...p, revision} : null;
      return {past: s.past.map(stamp), plan: stamp(s.plan), future: s.future.map(stamp)};
    }),
  };
}

async function renderPdfPage(file, pageNumber) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false}).promise;
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({scale: 1});
  const viewport = page.getViewport({scale: Math.min(4, 2400 / Math.max(base.width, base.height))});
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return {url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, pages: pdf.numPages};
}
function imageSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
    img.onerror = () => reject(new Error('The image could not be read.'));
    img.src = url;
  });
}

function PlanEditor({projectId, scheme = DEFAULT_SCHEME, onAction}) {
  const history = useHistory(null);
  const {plan} = history;
  const [underlay, setUnderlay] = useState(null); // {url, kind, ref, drawingId, viewBox, proposal, file, pages, page}
  const [calibration, setCalibration] = useState(null);
  const [picks, setPicks] = useState([]);
  const [distance, setDistance] = useState('');
  const [distanceUnit, setDistanceUnit] = useState('m');
  const [tool, setTool] = useState('select');
  const [selection, setSelection] = useState(null);
  const [levelSelection, setLevelSelection] = useState(null);
  const [drawStart, setDrawStart] = useState(null);
  const [hover, setHover] = useState(null);
  const [view, setView] = useState(null);
  const [notice, setNotice] = useState(null); // {tone, text}
  // An edited Pascal scene picked as a drawing, waiting for the reader to have Arosa import it: {name, drawingId}.
  const [scene, setScene] = useState(null);
  const [intakeFile,setIntakeFile] = useState(null);
  // Set when the reader asks Arosa for the plan from the empty page; cleared when a plan or an update arrives.
  const [drafting, setDrafting] = useState(false);
  // Confirmations lie over the canvas briefly; warnings and errors stay until the next edit or tool.
  useEffect(() => {
    if (!notice || (notice.tone !== 'info' && notice.tone !== 'success')) return undefined;
    const timer = setTimeout(() => setNotice((current) => (current === notice ? null : current)), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [saved, setSaved] = useState({revision: null, plan: null});
  const savedRef = useRef(saved);
  const editorGeneration = useRef(0);
  const reloadGeneration = useRef(0);
  const saveInFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [draftOffer, setDraftOffer] = useState(null);
  const [labels, setLabels] = useState([]);
  const [drawings, setDrawings] = useState([]);
  const [update, setUpdate] = useState(null); // a newer revision offered while there are unsaved edits
  // A plan or an offered update ends the drafting wait.
  useEffect(() => { if (plan || update) setDrafting(false); }, [plan, update]);
  const ownRevisions = useRef(new Set());
  const drawingGeneration = useRef(0);
  const pdfPageGeneration = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const heldEvents = useRef([]);
  const drainEvents = useRef(null);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const fileRef = useRef(null);
  const jsonRef = useRef(null);
  const [ppu, setPpu] = useState(1);
  const level = plan?.levels.find((l) => levelSelection?.planId === plan.id && l.id === levelSelection.id) || plan?.levels[0];
  const visiblePlan = useMemo(() => {
    if (!plan) return null;
    const walls = plan.walls.filter((w) => w.levelId === level.id), wallIds = new Set(walls.map((w) => w.id));
    return {...plan, walls, rooms: plan.rooms.filter((r) => r.levelId === level.id), openings: plan.openings.filter((o) => wallIds.has(o.wallId))};
  }, [plan, level?.id]);

  // An uncalibrated drawing is shown alone in pixels; everything else is in metres.
  const metric = Boolean(calibration) || (!underlay && Boolean(plan));
  const issues = useMemo(() => (plan ? validatePlan(plan) : []), [plan]);
  const errors = issues.filter((i) => i.severity === 'error');
  const issueFor = (kind, id) => issues.filter((i) => i.ref.kind === kind && i.ref.id === id);
  const dirty = Boolean(plan) && JSON.stringify(exportPlan(plan)) !== JSON.stringify(saved.plan && exportPlan(saved.plan));

  useEffect(() => () => { ++drawingGeneration.current; ++pdfPageGeneration.current; ++editorGeneration.current; ++reloadGeneration.current; }, [projectId, scheme]);
  useEffect(() => {
    const url = underlay?.url;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [underlay?.url]);

  // Load the saved plan and the site's drawings, and offer any unsaved local draft.
  useEffect(() => {
    let alive = true;
    const request = ++reloadGeneration.current, before = history.current(), drawing = drawingGeneration.current;
    (async () => {
      let current = null;
      const list = listDrawings({fetch, projectId}).catch(() => []); // The list is additional: local files still work without it.
      try { current = await loadPlan({fetch, projectId, scheme}); }
      catch { if (alive && request === reloadGeneration.current) setNotice({tone: 'warning', text: 'Saved plans are unavailable right now. You can still draft one here.'}); }
      const drawingList = await list;
      if (!alive) return;
      const untouched = history.current() === before && drawingGeneration.current === drawing;
      if (current && request === reloadGeneration.current && rememberSaved(current)) {
        if (untouched) history.reset(current);
        else setUpdate({revision: current.revision});
      }
      setDrawings(drawingList);
      const draft = storage() && readDraft(storage(), projectId, scheme);
      if (draft && untouched) setDraftOffer({draft, serverRevision: savedRef.current.revision});
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [projectId, scheme]);

  // Project events wait until the first load has settled and while a save is in flight, then are
  // judged against what is on screen; the stream replays history on every connect.
  useEffect(() => {
    const events = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
    events.onmessage = (e) => {
      heldEvents.current.push(JSON.parse(e.data));
      drainEvents.current();
    };
    return () => events.close();
  }, [projectId]);
  drainEvents.current = () => {
    if (!loaded || saveInFlight.current || !heldEvents.current.length) return;
    const events = heldEvents.current;
    heldEvents.current = [];
    const act = planEventActions(events, {projectId, scheme, revision: saved.revision, own: ownRevisions.current, dirty, empty: !plan && !underlay, drawingIds: new Set(drawings.map((d) => d.id))});
    if (act.revision?.action === 'load') void reloadLatest(act.revision.by, {keepDraft: true});
    if (act.revision?.action === 'offer') setUpdate(act.revision);
    if (act.refreshDrawings) void refreshDrawings().then((list) => {
      const drawing = act.showDrawing && list.find((d) => d.id === act.showDrawing);
      if (drawing) void openDrawing(drawing);
    });
  };
  useEffect(() => drainEvents.current(), [loaded, saving]);

  useEffect(() => {
    if (plan && dirty && storage()) {
      try { writeDraft(storage(), projectId, plan, scheme); } catch { /* Storage can be full or blocked; the draft is a convenience. */ }
    }
  }, [plan, dirty, projectId, scheme]);

  // Pixels per view unit, for constant 44 px targets at any zoom.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !view) return;
    // A hidden canvas (the phone chat covers the page) measures zero; keep the last scale.
    const measure = () => svg.clientWidth && svg.clientHeight && setPpu(Math.min(svg.clientWidth / view.w, svg.clientHeight / view.h));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [view]);

  // View coordinates: metres with y flipped (svgY = -north) once calibrated, else drawing pixels.
  const toView = (p) => (metric ? [p[0], -p[1]] : p);
  const fromView = (p) => (metric ? [p[0], -p[1]] : p);
  const underlayRect = useMemo(() => {
    if (!underlay) return null;
    const [x, y, w, h] = underlay.viewBox;
    if (!calibration) return {x, y, w, h};
    const k = metresPerPixel(calibration), tl = toMetres([x, y], calibration);
    return {x: tl[0], y: -tl[1], w: w * k, h: h * k};
  }, [underlay, calibration]);

  const fit = () => {
    const pts = [];
    if (visiblePlan) for (const w of visiblePlan.walls) pts.push(toView(w.start), toView(w.end));
    if (underlayRect) pts.push([underlayRect.x, underlayRect.y], [underlayRect.x + underlayRect.w, underlayRect.y + underlayRect.h]);
    if (!pts.length) pts.push([-1, -9], [11, 1]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs) || 10, h = Math.max(...ys) - Math.min(...ys) || 10, pad = Math.max(w, h) * 0.06;
    setView({x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: w + pad * 2, h: h + pad * 2});
  };
  useEffect(fit, [Boolean(plan), plan?.id, level?.id, underlay, calibration]);
  const zoom = (factor) => setView((v) => ({x: v.x + (v.w * (1 - factor)) / 2, y: v.y + (v.h * (1 - factor)) / 2, w: v.w * factor, h: v.h * factor}));

  const say = (tone, text) => setNotice({tone, text});
  const geometry = (next, base) => history.commit({...next, rooms: detectRooms(next, {labels})}, base);
  // A placement that goes through clears the warning the last attempt left on the canvas.
  const clearWarning = () => setNotice((current) => (current?.tone === 'warning' ? null : current));
  const pointer = (e) => {
    const svg = svgRef.current, pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [p.x, p.y];
  };
  const radius = HIT_PX / ppu;

  // ---- Intake ----
  // A drawing from disk is also stored with the site so Arosa can see it; one from the site list is not.
  function beginDrawing() {
    ++pdfPageGeneration.current;
    return ++drawingGeneration.current;
  }
  async function onDrawing(file, drawing = null, generation = beginDrawing()) {
    let pendingUrl = null;
    try {
      const {kind} = checkUpload(file);
      if (kind === 'ifc') {setIntakeFile(file);return;}
      if (kind === 'pascal-scene') {
        // A scene is not an underlay: it is stored with the site and Arosa imports it as a revision.
        const {nodes} = await readPascalScene(file);
        if (generation !== drawingGeneration.current) return;
        setScene({name: drawing?.name ?? file.name, drawingId: drawing?.id ?? null});
        say('info', `${file.name} is an edited 3D scene with ${nodes} parts. Import it with Arosa to make it the next plan revision.`);
        if (!drawing) void attachDrawing(file, generation);
        return;
      }
      setScene(null);
      // A drawing saved with this plan reuses its recorded calibration; any other needs a new one.
      const stored = drawingSource(plan, {kind, ref: file.name, drawingId: drawing?.id})?.calibration;
      const restored = stored ? calibrate(stored.pointA, stored.pointB, stored.distanceMetres) : null;
      const drawingId = drawing?.id ?? null;
      if (kind === 'svg') {
        const text = await file.text();
        if (generation !== drawingGeneration.current) return;
        const clean = sanitizeSvg(text, {DOMParser});
        const proposal = proposeFromPrimitives(extractPrimitives(clean.svg, {DOMParser}));
        const url = URL.createObjectURL(new Blob([clean.svg], {type: 'image/svg+xml'}));
        setUnderlay({url, kind, ref: file.name, drawingId, viewBox: clean.viewBox, proposal});
        const removed = clean.removed.length ? ` Removed ${clean.removed.length} unsafe item${clean.removed.length === 1 ? '' : 's'}.` : '';
        // Losses stay on screen (a warning does not time out) until the user moves on.
        const losses = readingLosses(proposal);
        say(losses ? 'warning' : 'info', `Found ${proposal.walls.length} candidate walls and ${proposal.openings.length} openings.${losses ? ` ${losses}` : ''}${removed}${stored ? ' Saved scale restored.' : ' Calibrate next: pick two points and type their distance.'}`);
      } else if (kind === 'pdf') {
        const page = await renderPdfPage(file, 1);
        if (generation !== drawingGeneration.current) { URL.revokeObjectURL(page.url); return; }
        setUnderlay({url: page.url, kind, ref: `${file.name}#page=1`, drawingId, viewBox: [0, 0, page.width, page.height], proposal: null, file, pages: page.pages, page: 1});
        say('info', `Page 1 of ${page.pages} locked as an underlay.${stored ? ' Saved scale restored.' : ' Calibrate it, then trace the walls.'}`);
      } else {
        const url = URL.createObjectURL(file);
        pendingUrl = url;
        const [w, h] = await imageSize(url);
        if (generation !== drawingGeneration.current) { URL.revokeObjectURL(url); return; }
        setUnderlay({url, kind, ref: file.name, drawingId, viewBox: [0, 0, w, h], proposal: null});
        pendingUrl = null;
        say('info', `Image locked as an underlay.${stored ? ' Saved scale restored.' : ' Calibrate it, then trace the walls.'}`);
      }
      setCalibration(restored);
      setPicks([]);
      setLabels([]);
      ++pdfPageGeneration.current;
      setTool(stored ? 'select' : 'calibrate');
      if (!drawing) void attachDrawing(file, generation);
    } catch (error) {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      if (generation === drawingGeneration.current) say('danger', error.message);
    }
  }
  async function refreshDrawings() {
    try {
      const list = await listDrawings({fetch, projectId});
      setDrawings(list);
      return list;
    } catch {
      return []; // The list is additional: the editor still works from local files without it.
    }
  }
  async function attachDrawing(file, generation) {
    try {
      const view = await uploadDrawing({fetch, projectId, file});
      if (generation !== drawingGeneration.current) return;
      setDrawings((list) => [view, ...list.filter((d) => d.id !== view.id)]);
      history.linkDrawing(file.name, view);
      // The site stores a normalised name (floor.JPG becomes floor.jpg); Arosa's plans refer to that name.
      setUnderlay((u) => (u && baseRef(u.ref) === file.name ? {...u, ref: view.name + u.ref.slice(file.name.length), drawingId: view.id} : u));
      setScene((current) => (current && current.name === file.name ? {name: view.name, drawingId: view.id} : current));
      onAction?.({kind: 'drawing', name: view.name});
    } catch (error) {
      if (generation === drawingGeneration.current) say('warning', `${file.name} is shown here but was not saved to this site. ${error.message}`);
    }
  }
  async function openDrawing(drawing) {
    const generation = beginDrawing();
    try {
      const file = await fetchDrawing({fetch, projectId, drawing});
      if (generation !== drawingGeneration.current) return;
      await onDrawing(file, drawing, generation);
    } catch (error) {
      if (generation === drawingGeneration.current) say('danger', error.message);
    }
  }
  async function onPdfPage(n) {
    const generation = drawingGeneration.current, pageGeneration = ++pdfPageGeneration.current;
    try {
      const page = await renderPdfPage(underlay.file, n);
      if (generation !== drawingGeneration.current || pageGeneration !== pdfPageGeneration.current) { URL.revokeObjectURL(page.url); return; }
      setUnderlay((u) => ({...u, url: page.url, ref: `${baseRef(u.ref)}#page=${n}`, viewBox: [0, 0, page.width, page.height], page: n}));
      const stored = drawingSource(plan, {...underlay, ref: `${baseRef(underlay.ref)}#page=${n}`})?.calibration;
      say('info', `Page ${n} of ${page.pages} locked as an underlay.${stored ? ' Saved scale restored.' : ' Calibrate it, then trace the walls.'}`);
      setCalibration(stored ? calibrate(stored.pointA, stored.pointB, stored.distanceMetres) : null);
      setPicks([]);
      setTool(stored ? 'select' : 'calibrate');
    } catch (error) {
      if (generation === drawingGeneration.current && pageGeneration === pdfPageGeneration.current) say('danger', error.message);
    }
  }
  async function onJson(file) {
    const generation = beginDrawing();
    try {
      if (file.size > LIMITS.svgBytes) throw new Error(`${file.name} is too large; the limit is 2 MB.`);
      const text = await file.text();
      if (generation !== drawingGeneration.current) return;
      const json = JSON.parse(text);
      const next = planFromJson(json, {ref: file.name});
      ++pdfPageGeneration.current;
      history.commit({...next, id: plan?.id ?? next.id ?? null, revision: plan?.revision ?? saved.revision, parentRevision: plan?.parentRevision ?? null}, plan);
      setUnderlay(null);
      setCalibration(null);
      setLabels([]);
      setSelection(null);
      setTool('select');
      say('info', `Loaded ${next.walls.length} walls, ${next.openings.length} openings and ${next.rooms.length} rooms from ${file.name}.`);
    } catch (error) {
      if (generation === drawingGeneration.current) say('danger', error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message);
    }
  }

  // ---- Calibration ----
  function applyCalibration(e) {
    e.preventDefault();
    try {
      const value = Number(distance) * (distanceUnit === 'ft' ? FEET : 1);
      const next = calibrate(picks[0], picks[1], value);
      // The underlay is traced on the level in view; only that level moves with the new scale.
      if (plan) history.commit(reprojectPlan(plan, calibration, next, underlay, level.id), plan);
      setCalibration(next);
      setLabels((underlay.proposal?.labels || []).map((l) => ({text: l.text, at: toMetres(l.at, next)})));
      setPicks([]);
      setDistance('');
      setTool('select');
      say('info', `Scale set: 1 px = ${next.metresPerPixel.toPrecision(4)} m. Point A is the plan origin.`);
    } catch (error) {
      say('danger', error.message);
    }
  }
  function createFromDrawing(withProposal) {
    const proposal = withProposal ? underlay.proposal : {walls: [], openings: [], labels: []};
    const next = planFromDrawing({proposal, calibration, source: {kind: underlay.kind, ref: underlay.ref, ...(underlay.drawingId ? {drawingId: underlay.drawingId} : {})}});
    history.commit({...next, id: plan?.id ?? null, revision: plan?.revision ?? saved.revision, parentRevision: null}, plan);
    setTool(withProposal ? 'select' : 'wall');
    say('info', withProposal ? `Created ${next.walls.length} walls, ${next.openings.length} openings and ${next.rooms.length} rooms. Check each against the drawing.` : 'Trace the walls: click a start point, then each corner. Press Escape to finish.');
  }

  // ---- Canvas interaction ----
  function onPointerDown(e) {
    if (e.button !== 0) return;
    const viewPt = pointer(e), p = fromView(viewPt);
    const target = e.target.closest('[data-kind]');
    const kind = target?.dataset.kind, id = target?.dataset.id;
    svgRef.current.setPointerCapture(e.pointerId);
    if (!target) svgRef.current.focus({preventScroll: true});
    if (tool === 'calibrate') {
      const px = calibration ? toPixels(p, calibration) : p;
      setPicks((prev) => (prev.length >= 2 ? [px] : [...prev, px]));
      return;
    }
    if (!plan || !metric) return;
    if (tool === 'wall') {
      const snapped = snapPoint(visiblePlan, p, radius).point;
      if (drawStart) {
        if (Math.hypot(snapped[0] - drawStart[0], snapped[1] - drawStart[1]) < 0.05) return;
        geometry(addWall(plan, {start: drawStart, end: snapped, levelId: level.id}), plan);
      }
      setDrawStart(snapped);
      return;
    }
    if (tool === 'split' || tool === 'door' || tool === 'window') {
      const wall = nearestWall(visiblePlan, p, radius);
      if (!wall) return say('warning', 'Click on a wall.');
      try {
        if (tool === 'split') {
          // The clicked half keeps its id and stays selected, so the split shows at once.
          geometry(splitWall(plan, wall.id, p), plan);
          setSelection({kind: 'wall', id: wall.id});
        } else {
          const next = placeOpening(plan, {wallId: wall.id, kind: tool, at: p});
          history.commit(next, plan);
          setSelection({kind: 'opening', id: next.openings.at(-1).id});
        }
        clearWarning();
      } catch (error) {
        say('warning', error.message);
      }
      return;
    }
    if (kind === 'joint') {
      const wall = plan.walls.find((w) => w.id === id);
      dragRef.current = {type: 'joint', levelId: wall.levelId, from: wall[target.dataset.end], base: plan, moved: false};
    } else if (kind === 'wall' || kind === 'opening' || kind === 'room') {
      setSelection({kind, id});
      if (kind !== 'room') dragRef.current = {type: kind, id, start: p, base: plan, moved: false};
    } else {
      setSelection(null);
      dragRef.current = {type: 'pan', client: [e.clientX, e.clientY], view};
    }
  }
  function onPointerMove(e) {
    const p = fromView(pointer(e));
    if (tool === 'wall' && plan) setHover(snapPoint(visiblePlan, p, radius).point);
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.type === 'pan') {
      setView({...drag.view, x: drag.view.x - (e.clientX - drag.client[0]) / ppu, y: drag.view.y - (e.clientY - drag.client[1]) / ppu});
      return;
    }
    drag.moved = true;
    if (drag.type === 'joint') {
      const others = {...drag.base, walls: drag.base.walls.filter((w) => w.levelId === drag.levelId && !samePoint(w.start, drag.from) && !samePoint(w.end, drag.from))};
      history.live(moveJoint(drag.base, drag.from, snapPoint(others, p, radius).point, drag.levelId));
    } else if (drag.type === 'wall') {
      const d = [Math.round((p[0] - drag.start[0]) * 100) / 100, Math.round((p[1] - drag.start[1]) * 100) / 100];
      history.live(translateWall(drag.base, drag.id, d));
    } else if (drag.type === 'opening') {
      history.live(translateOpening(drag.base, drag.id, [p[0] - drag.start[0], p[1] - drag.start[1]]));
    }
  }
  function onPointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.moved) return;
    if (drag.type === 'opening') {
      if (plan !== drag.base) history.commit(plan, drag.base);
    }
    else if (drag.type !== 'pan') geometry(plan, drag.base);
  }
  function travelHistory(direction) {
    const next = history[direction]();
    if (!underlay || !next) return;
    const stored = drawingSource(next, underlay)?.calibration;
    const restored = stored ? calibrate(stored.pointA, stored.pointB, stored.distanceMetres) : null;
    setCalibration(restored);
    setLabels(restored ? (underlay.proposal?.labels || []).map((l) => ({text: l.text, at: toMetres(l.at, restored)})) : []);
    if (!restored) setTool('calibrate');
    else if (tool === 'calibrate') setTool('select');
  }
  function onKeyDown(e) {
    if (e.target.closest('input, select, textarea')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      return travelHistory(e.shiftKey ? 'redo' : 'undo');
    }
    if (e.key === 'Escape') {
      setDrawStart(null);
      setHover(null);
      setPicks([]);
      if (tool !== 'select') setTool('select');
      else setSelection(null);
      return;
    }
    const shortcuts = {v: 'select', w: 'wall', s: 'split', d: 'door', n: 'window', c: 'calibrate'};
    if (!mod && shortcuts[e.key.toLowerCase()] && (plan || e.key.toLowerCase() === 'c')) return chooseTool(shortcuts[e.key.toLowerCase()]);
    if (!selection || !plan) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeSelected();
      return;
    }
    const arrows = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1]};
    if (arrows[e.key] && selection.kind !== 'room') {
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : 0.01, [dx, dy] = arrows[e.key];
      if (selection.kind === 'wall') geometry(translateWall(plan, selection.id, [dx * step, dy * step]), plan);
      else {
        const next = translateOpening(plan, selection.id, [dx * step, dy * step]);
        if (next !== plan) history.commit(next, plan);
      }
    }
  }
  function chooseTool(next) {
    setTool(next);
    setNotice(null);
    setDrawStart(null);
    setHover(null);
    if (next === 'calibrate') setPicks([]);
  }
  function chooseLevel(id) {
    onPointerUp();
    setLevelSelection({planId: plan.id, id});
    setSelection(null);
    setDrawStart(null);
    setHover(null);
  }
  function selectItem(next) {
    const item = plan[{wall: 'walls', opening: 'openings', room: 'rooms', object: 'objects', level: 'levels'}[next.kind]]?.find((x) => x.id === next.id);
    const id = next.kind === 'opening' ? plan.walls.find((w) => w.id === item?.wallId)?.levelId : next.kind === 'level' ? item?.id : item?.levelId;
    if (plan.levels.some((l) => l.id === id) && id !== level.id) chooseLevel(id);
    setSelection(next);
  }
  function removeSelected() {
    const collection = {wall: 'walls', opening: 'openings', room: 'rooms'}[selection.kind];
    const next = deleteItem(plan, collection, selection.id);
    if (selection.kind === 'wall') geometry(next, plan);
    else history.commit(next, plan);
    setSelection(null);
  }

  // ---- Save and export ----
  function rememberSaved(next) {
    if (next.revision < (savedRef.current.revision ?? 0)) return false;
    const baseline = {revision: next.revision, plan: next};
    savedRef.current = baseline;
    setSaved(baseline);
    return true;
  }
  async function save() {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    ++reloadGeneration.current;
    const generation = editorGeneration.current, submitted = history.current();
    setSaving(true);
    setConflict(null);
    setNotice(null);
    try {
      const result = await savePlan({fetch, projectId, scheme, plan: submitted});
      if (generation !== editorGeneration.current) return;
      if (result.status === 'conflict') {
        setConflict(result);
        return;
      }
      ownRevisions.current.add(result.plan.revision);
      if (rememberSaved(result.plan)) {
        const current = history.acceptSaved(submitted, result.plan);
        const laterEdits = Boolean(current) && JSON.stringify(exportPlan(current)) !== JSON.stringify(exportPlan(result.plan));
        setUpdate(null);
        setLoaded(true);
        let tone = 'success', message = `Saved revision ${result.plan.revision}.`;
        const local = storage();
        if (laterEdits) {
          message += ' Your later edits are unsaved.';
          try {
            if (!local) throw new Error('Draft storage is unavailable.');
            writeDraft(local, projectId, current, scheme);
          } catch {
            tone = 'warning'; message += ' They could not be stored in this browser; export them before closing the page.';
          }
        } else if (local) {
          try { clearDraft(local, projectId, scheme); }
          catch { tone = 'warning'; message += ' The older local draft could not be removed.'; }
        }
        say(tone, message);
      } else say('info', `Saved revision ${result.plan.revision}. A newer saved revision ${savedRef.current.revision} is available; your current work is unchanged.`);
      onAction?.({kind: 'revision', revision: result.plan.revision});
    } catch (error) {
      if (generation === editorGeneration.current) say('danger', error.message || 'The plan could not be saved.');
    } finally {
      if (generation === editorGeneration.current) { saveInFlight.current = false; setSaving(false); }
    }
  }
  // A live update loads in place without touching a local draft; Reload and Load discard it.
  async function reloadLatest(by, {keepDraft = false} = {}) {
    const generation = editorGeneration.current, request = ++reloadGeneration.current;
    const before = history.current(), drawing = drawingGeneration.current;
    try {
      const current = await loadPlan({fetch, projectId, scheme});
      if (generation !== editorGeneration.current || request !== reloadGeneration.current) return;
      setLoaded(true);
      if (!current) { say('info', 'No plan has been saved for this site yet.'); return; }
      if (!rememberSaved(current)) return;
      if (history.current() !== before || drawingGeneration.current !== drawing) {
        setUpdate({revision: current.revision, by});
        say('info', 'A saved revision arrived while you were working. Your changes are kept.');
        return;
      }
      history.reset(current);
      let draftCleanupFailed = false;
      if (!keepDraft && storage()) {
        try { clearDraft(storage(), projectId, scheme); } catch { draftCleanupFailed = true; }
      }
      setConflict(null);
      setUpdate(null);
      setSelection(null);
      // Reload the selected drawing's saved scale with its geometry, else drop the underlay.
      if (underlay) {
        const source = drawingSource(current, underlay);
        if (source?.calibration) {
          setCalibration(calibrate(source.calibration.pointA, source.calibration.pointB, source.calibration.distanceMetres));
          setTool('select');
        } else { setUnderlay(null); setCalibration(null); }
      }
      const message = by === 'agent' ? `Arosa updated the plan to revision ${current.revision}.` : by === 'user' ? `Loaded revision ${current.revision}, saved by a teammate or in another window.` : `Loaded revision ${current.revision}.`;
      say(draftCleanupFailed ? 'warning' : 'info', message + (draftCleanupFailed ? ' The older local draft could not be removed.' : ''));
    } catch (error) {
      if (generation === editorGeneration.current && request === reloadGeneration.current) say('danger', error.message);
    }
  }
  // Keep my edits on top of the newer revision: the next save replaces it.
  function keepMine() {
    ++reloadGeneration.current;
    const revision = Math.max(update.revision, savedRef.current.revision ?? 0);
    history.rebaseRevision(revision);
    savedRef.current = {...savedRef.current, revision};
    setSaved(savedRef.current);
    say('info', `Your work is kept. ${replaces({...update, revision})}`);
    setUpdate(null);
  }
  function download() {
    const doc = exportPlan(plan);
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], {type: 'application/json'}));
    const a = Object.assign(document.createElement('a'), {href: url, download: `${(doc.name || 'plan').replace(/[^\w.-]+/g, '-')}.plan.json`});
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- Render ----
  const selectedWall = selection?.kind === 'wall' ? visiblePlan?.walls.find((w) => w.id === selection.id) : null;
  const selectedOpening = selection?.kind === 'opening' ? visiblePlan?.openings.find((o) => o.id === selection.id) : null;
  const selectedRoom = selection?.kind === 'room' ? visiblePlan?.rooms.find((r) => r.id === selection.id) : null;
  const toolButtons = [
    ['select', 'Select', MousePointer2, 'V', 'pick a room, wall or opening'], ['wall', 'Wall', PenLine, 'W', 'draw a wall'], ['split', 'Split', Scissors, 'S', 'cut a wall in two'],
    ['door', 'Door', DoorOpen, 'D', 'add a door to a wall'], ['window', 'Window', AppWindow, 'N', 'add a window to a wall'],
  ];
  const empty = !plan && !underlay;
  // Before a plan or drawing exists the intake prompt takes the canvas; the side column appears
  // with the first drawing or plan, so the prompt hands off to the canvas in place.
  const bare = empty && drawings.length === 0;
  const revisionText = `${saved.revision ? `Revision ${saved.revision}` : 'Not saved yet'}${dirty ? ' · unsaved changes' : ''}`;

  return (
    <div className="plan-editor" onKeyDown={onKeyDown}>
      <span id="plan-upload-limits" className="plan-sr">{UPLOAD_LIMITS}</span>
      <div className="plan-toolbar" role="toolbar" aria-label="Plan tools">
        <div className="plan-tools">
          {plan && <label className="plan-level"><span className="plan-label">Level</span>
            <select aria-label="Plan level" value={level.id} onChange={(e) => chooseLevel(e.target.value)}>
              {plan.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>}
          <div className="plan-group">
            <button type="button" aria-label="Upload a drawing" aria-describedby="plan-upload-limits" title={`Upload a drawing. ${UPLOAD_LIMITS}`} onClick={() => fileRef.current.click()}><Upload aria-hidden="true" /><span className="plan-label">Drawing</span></button>
            <input ref={fileRef} type="file" hidden accept=".svg,.pdf,.png,.jpg,.jpeg,.webp,.json,image/svg+xml,application/pdf,image/png,image/jpeg,image/webp,application/json" data-testid="drawing-input" onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onDrawing(f); }} />
            <input ref={jsonRef} type="file" hidden accept=".json,application/json" data-testid="json-input" onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onJson(f); }} />
          </div>
          <div className="plan-group">
            <button type="button" aria-pressed={tool === 'calibrate'} disabled={!underlay} onClick={() => chooseTool('calibrate')} aria-label={`${calibration ? 'Recalibrate' : 'Calibrate'} (C)`} title={`${calibration ? 'Recalibrate' : 'Calibrate'}: set the drawing's scale from one known length (C)`}><Ruler aria-hidden="true" /><span className="plan-label">{calibration ? 'Recalibrate' : 'Calibrate'}</span></button>
            {toolButtons.map(([id, label, Icon, key, what]) => (
              <button key={id} type="button" aria-pressed={tool === id} disabled={!plan || !metric} onClick={() => chooseTool(id)} aria-label={`${label} (${key})`} title={`${label}: ${what} (${key})`}><Icon aria-hidden="true" /><span className="plan-label">{label}</span></button>
            ))}
            <button type="button" disabled={!plan} aria-label="Detect rooms" title="Detect rooms: name the spaces the walls enclose" onClick={() => history.commit({...plan, rooms: detectRooms(plan, {labels})}, plan)}><ScanSearch aria-hidden="true" /><span className="plan-label">Detect rooms</span></button>
          </div>
          <div className="plan-group">
            <button type="button" className="plan-icon" aria-label="Undo" title="Undo" disabled={!history.canUndo} onClick={() => travelHistory('undo')}><Undo2 aria-hidden="true" /></button>
            <button type="button" className="plan-icon" aria-label="Redo" title="Redo" disabled={!history.canRedo} onClick={() => travelHistory('redo')}><Redo2 aria-hidden="true" /></button>
            <button type="button" className="plan-icon" aria-label="Zoom in" title="Zoom in" disabled={!view} onClick={() => zoom(0.8)}><ZoomIn aria-hidden="true" /></button>
            <button type="button" className="plan-icon" aria-label="Zoom out" title="Zoom out" disabled={!view} onClick={() => zoom(1.25)}><ZoomOut aria-hidden="true" /></button>
            <button type="button" className="plan-icon" aria-label="Fit to view" title="Fit to view" disabled={!view} onClick={fit}><Maximize aria-hidden="true" /></button>
          </div>
        </div>
        <div className="plan-group plan-group-end">
          <span className="plan-status" aria-live="polite">
            <span className="plan-revision" title={revisionText}>{revisionText}</span>
            {calibration && (
              <span className="plan-scale" title={`${(1 / calibration.metresPerPixel).toFixed(2)} px per m`}>
                1 px = {calibration.metresPerPixel.toPrecision(4)} m
                <button type="button" className="plan-link" onClick={() => chooseTool('calibrate')}><RotateCcw aria-hidden="true" />Redo</button>
              </span>
            )}
          </span>
          <ToolbarMore items={[
            {label: 'Load plan JSON', what: 'Open a plan saved as a JSON file.', Icon: FileJson, onSelect: () => jsonRef.current.click()},
            {label: 'Export plan JSON', what: 'Download this plan as a JSON file.', Icon: Download, disabled: !plan, onSelect: download},
          ]} />
          <button type="button" className={plan && !draftOffer && !update && !conflict ? "plan-primary" : undefined} disabled={!plan || saving || errors.length > 0 || !dirty} onClick={save} title={errors.length ? `Fix ${errors.length} error${errors.length === 1 ? '' : 's'} before saving` : undefined}>
            <Save aria-hidden="true" />{saving ? 'Saving' : 'Save'}
          </button>
        </div>
      </div>

      <ModelIntake key={projectId} projectId={projectId} plan={plan} initialFile={intakeFile} onFileConsumed={()=>setIntakeFile(null)} onImport={next=>{
        history.commit({...next,id:plan?.id??null,revision:plan?.revision??saved.revision,parentRevision:plan?.parentRevision??null},plan);
        setSelection(null);setUnderlay(null);setScene(null);setLevelSelection(null);setView(null);
        say('info','IFC imported as an editable draft. Review the model and save a new revision.');
      }}/>
      {draftOffer && (
        <div className="plan-banner" role="region" aria-label="Unsaved draft">
          <p>
            This browser has an unsaved draft
            {draftOffer.draft.revision ? ` based on revision ${draftOffer.draft.revision}` : ''}
            {draftOffer.serverRevision && draftOffer.serverRevision !== draftOffer.draft.revision ? `; the saved plan is now revision ${draftOffer.serverRevision}` : ''}.
          </p>
          <div className="plan-banner-actions">
            <button type="button" className="plan-primary" onClick={() => { history.commit(draftOffer.draft, plan); setDraftOffer(null); }}>Restore draft</button>
            <button type="button" onClick={() => { if (storage()) clearDraft(storage(), projectId, scheme); setDraftOffer(null); }}>Discard</button>
          </div>
        </div>
      )}
      {update && (
        <div className="plan-banner tone-info" role="status" aria-label="Plan update">
          <p>
            <strong>{update.by === 'agent' ? 'Arosa updated the plan' : 'A saved plan is available'}</strong>{' '}{update.by === 'agent' ? 'to revision' : 'at revision'} {update.revision}.
            {' '}Load it, or keep your unsaved changes. {replaces(update)}
          </p>
          <div className="plan-banner-actions">
            <button type="button" className="plan-primary" onClick={() => reloadLatest(update.by)}>Load</button>
            <button type="button" onClick={keepMine}>Keep mine</button>
          </div>
        </div>
      )}
      {conflict && (
        <div className="plan-banner tone-warning" role="alert">
          <p>{conflict.message || `Revision ${conflict.revision} was saved elsewhere.`} Your changes are still on this page. Export them before reloading if you want to keep them.</p>
          <div className="plan-banner-actions">
            <button type="button" className="plan-primary" onClick={() => reloadLatest()}>Reload revision {conflict.revision}</button>
            <button type="button" onClick={download}>Export my version</button>
            <button type="button" onClick={() => setConflict(null)}>Keep editing</button>
          </div>
        </div>
      )}

      <div className={`plan-body${bare ? ' is-empty' : ''}`}>
        <div className="plan-canvas-wrap">
          {notice && <p className={`plan-notice tone-${notice.tone}`} role="status">{notice.text}</p>}
          {empty ? (
            <div className={`plan-empty${drafting ? ' is-drafting' : ''}`}>
              {/* While Arosa drafts, the canvas holds the drawing's place and says so. */}
              {drafting && <div className="plan-drafting-sheet" aria-hidden="true"><span /><span /><span /><span /></div>}
              <h3 role="status">
                {drafting ? <><span className="research-dots" aria-hidden="true"><i /><i /><i /></span>Arosa is drafting the floor plan</> : 'No floor plan yet'}
              </h3>
              {drafting ? <p>It appears here when saved.</p> : (
                <div className="plan-banner-actions">
                  {/* A follow-up button: the page sends "Draft the floor plan for this site" into the site's chat. */}
                  <button type="button" className="plan-primary" data-follow-field="architecture" data-follow-action="draft" data-plan-canvas="" onClick={() => setDrafting(true)}>Find the plan with Arosa</button>
                  <button type="button" onClick={() => { history.commit(blankPlan(), plan); chooseTool('wall'); }}><PenLine aria-hidden="true" />Draw it yourself</button>
                  <button type="button" aria-describedby="plan-upload-limits" onClick={() => fileRef.current.click()}><Upload aria-hidden="true" />Upload a drawing</button>
                </div>
              )}
            </div>
          ) : view && (
            <svg
              ref={svgRef}
              className={`plan-canvas tool-${tool}`}
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              role="application"
              tabIndex={0}
              aria-label={`Floor plan canvas${level ? `: ${level.name}` : ''}. Tools: V select, W wall, S split, D door, N window, C calibrate. Arrow keys move the selection, Delete removes it.`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => setHover(null)}
            >
              {underlay && underlayRect && <image className="plan-underlay" href={underlay.url} x={underlayRect.x} y={underlayRect.y} width={underlayRect.w} height={underlayRect.h} preserveAspectRatio="none" pointerEvents="none" />}
              {!plan && underlay?.proposal && (
                <g className="plan-candidates" pointerEvents="none">
                  {underlay.proposal.walls.map((w, i) => {
                    const [a, b] = calibration ? [toView(toMetres(w.a, calibration)), toView(toMetres(w.b, calibration))] : [w.a, w.b];
                    return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeWidth={4 / ppu} />;
                  })}
                </g>
              )}
              {plan && metric && <PlanShapes plan={visiblePlan} toView={toView} ppu={ppu} selection={selection} issueFor={issueFor} onSelect={setSelection} />}
              {selectedWall && tool === 'select' && ['start', 'end'].map((end) => {
                const p = toView(selectedWall[end]);
                return <circle key={end} className="plan-handle" data-kind="joint" data-id={selectedWall.id} data-end={end} cx={p[0]} cy={p[1]} r={radius} aria-label={`Drag the ${end} of wall ${selectedWall.id}`} />;
              })}
              {tool === 'wall' && drawStart && hover && (
                <line className="plan-preview" x1={toView(drawStart)[0]} y1={toView(drawStart)[1]} x2={toView(hover)[0]} y2={toView(hover)[1]} strokeWidth={2 / ppu} />
              )}
              {tool === 'wall' && hover && <circle className="plan-snap" cx={toView(hover)[0]} cy={toView(hover)[1]} r={5 / ppu} pointerEvents="none" />}
              {picks.map((px, i) => {
                const p = calibration ? toView(toMetres(px, calibration)) : px;
                return (
                  <g key={i} className="plan-pick" pointerEvents="none">
                    <circle cx={p[0]} cy={p[1]} r={8 / ppu} strokeWidth={2 / ppu} />
                    <text x={p[0] + 12 / ppu} y={p[1] - 12 / ppu} fontSize={14 / ppu}>{i ? 'B' : 'A'}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        <aside className="plan-side" aria-label="Plan details">
          {scene && (
            <section className="plan-card">
              <h3>Import the edited scene</h3>
              <p>{scene.drawingId ? `${scene.name} is saved with this site.` : `Saving ${scene.name} to this site.`} Arosa reads it into the next plan revision and renders its walkthrough.</p>
              <div className="plan-banner-actions">
                {/* A follow-up button: the page sends the import request into the site's chat. */}
                <button type="button" className="plan-primary" disabled={!scene.drawingId} data-follow-field="architecture" data-follow-action="import" data-follow-drawing={scene.name} data-plan-canvas=""
                  onClick={() => { setScene(null); say('info', 'Arosa is importing the scene. Follow along in the chat; the editor shows the new revision when it is saved.'); }}>Import with Arosa</button>
              </div>
            </section>
          )}
          {drawings.length > 0 && (
            <section className="plan-card">
              <h3>Project files <span className="plan-mono">{drawings.length}</span></h3>
              <ul className="plan-drawings">
                {drawings.map((d) => (
                  <li key={d.id}>
                    <button type="button" aria-pressed={underlay?.drawingId === d.id} onClick={() => openDrawing(d)}>
                      <span className="plan-drawing-name">{d.name}</span>
                      <span className="plan-drawing-meta">{KIND_LABELS[d.kind]} · {d.by === 'agent' ? 'Found by Arosa' : 'Uploaded'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {tool === 'calibrate' && underlay && (
            <section className="plan-card">
              <h3>Calibrate the drawing</h3>
              <p>Click two points whose real distance you know, such as the ends of a dimension line. Point A becomes the plan origin.</p>
              <div className="plan-grid">
                {[0, 1].flatMap((i) => [0, 1].map((axis) => (
                  <NumberField key={`${i}${axis}`} label={`${i ? 'B' : 'A'} ${axis ? 'down' : 'across'}`} unit="px" step={0.1} value={picks[i]?.[axis] ?? 0}
                    onCommit={(v) => setPicks((prev) => {
                      const next = [0, 1].map((k) => [...(prev[k] ?? [0, 0])]);
                      next[i][axis] = v;
                      return next;
                    })} />
                )))}
              </div>
              <form className="plan-form" onSubmit={applyCalibration}>
                <label>Known distance
                  <span className="plan-inline">
                    <input type="number" inputMode="decimal" min="0" step="any" required value={distance} onChange={(e) => setDistance(e.target.value)} disabled={picks.length < 2} />
                    <select aria-label="Distance unit" value={distanceUnit} onChange={(e) => setDistanceUnit(e.target.value)}><option value="m">m</option><option value="ft">ft</option></select>
                  </span>
                </label>
                <button type="submit" className="plan-primary" disabled={picks.length < 2 || !distance}>Apply scale</button>
              </form>
            </section>
          )}
          {underlay?.kind === 'pdf' && underlay.pages > 1 && (
            <section className="plan-card">
              <label>PDF page
                <select value={underlay.page} onChange={(e) => onPdfPage(Number(e.target.value))}>
                  {Array.from({length: underlay.pages}, (_, i) => <option key={i} value={i + 1}>Page {i + 1}</option>)}
                </select>
              </label>
            </section>
          )}
          {!plan && calibration && (
            <section className="plan-card">
              <h3>Create the plan</h3>
              {underlay.proposal?.walls.length ? (
                <>
                  <p>{underlay.proposal.walls.length} candidate walls and {underlay.proposal.openings.length} openings were read from the drawing. Use them as a starting point and correct anything that does not match.</p>
                  {readingLosses(underlay.proposal) && <p className="plan-reading-losses">{readingLosses(underlay.proposal)}</p>}
                  <div className="plan-banner-actions">
                    <button type="button" className="plan-primary" onClick={() => createFromDrawing(true)}>Use candidates</button>
                    <button type="button" onClick={() => createFromDrawing(false)}>Trace by hand</button>
                  </div>
                </>
              ) : (
                <>
                  <p>No reliable wall lines were found in this drawing. Trace the walls over it.</p>
                  <button type="button" className="plan-primary" onClick={() => createFromDrawing(false)}>Start tracing</button>
                </>
              )}
            </section>
          )}
          {plan && (
            <section className="plan-card">
              <TextField label="Plan name" value={plan.name} onCommit={(name) => history.commit({...plan, name}, plan)} />
            </section>
          )}
          {selectedWall && <WallInspector wall={selectedWall} issues={issueFor('wall', selectedWall.id)} onChange={(patch) => (patch.start || patch.end ? geometry : history.commit)(updateItem(plan, 'walls', selectedWall.id, patch), plan)}
            onSplit={() => { try { geometry(splitWall(plan, selectedWall.id, mid(selectedWall)), plan); clearWarning(); } catch (error) { say('warning', error.message); } }}
            onOpening={(kind) => { const next = placeOpening(plan, {wallId: selectedWall.id, kind, at: mid(selectedWall)}); history.commit(next, plan); setSelection({kind: 'opening', id: next.openings.at(-1).id}); clearWarning(); }}
            onDelete={removeSelected} />}
          {selectedOpening && <OpeningInspector opening={selectedOpening} wall={plan.walls.find((w) => w.id === selectedOpening.wallId)} issues={issueFor('opening', selectedOpening.id)} onChange={(patch) => history.commit(updateItem(plan, 'openings', selectedOpening.id, patch), plan)} onDelete={removeSelected} />}
          {selectedRoom && <RoomInspector room={selectedRoom} issues={issueFor('room', selectedRoom.id)} onChange={(patch) => history.commit(updateItem(plan, 'rooms', selectedRoom.id, patch), plan)} onDelete={removeSelected} />}
          {plan && !selection && <AddWallForm key={level.id} height={level.height} onAdd={(start, end) => geometry(addWall(plan, {start, end, levelId: level.id}), plan)} />}
          {plan && (
            <section className="plan-card">
              <h3>Checks</h3>
              {issues.length === 0 ? <p className="tone-success">Every room is closed, no walls overlap and every opening fits its wall.</p> : (
                <ul className="plan-issues">
                  {issues.map((i, n) => (
                    <li key={n}><button type="button" className={`plan-issue tone-${i.severity === 'error' ? 'danger' : 'warning'}`} onClick={() => selectItem(i.ref)}>{i.message}</button></li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {plan && <ItemLists plan={visiblePlan} selection={selection} issueFor={issueFor} onSelect={selectItem} />}
        </aside>
      </div>
    </div>
  );
}

const samePoint = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.005;
const mid = (w) => [(w.start[0] + w.end[0]) / 2, (w.start[1] + w.end[1]) / 2];

function wallPolygon(w, toView) {
  const len = wallLength(w), n = [-(w.end[1] - w.start[1]) / len, (w.end[0] - w.start[0]) / len], h = w.thickness / 2;
  return [[w.start[0] + n[0] * h, w.start[1] + n[1] * h], [w.end[0] + n[0] * h, w.end[1] + n[1] * h], [w.end[0] - n[0] * h, w.end[1] - n[1] * h], [w.start[0] - n[0] * h, w.start[1] - n[1] * h]]
    .map(toView).map((p) => p.join(',')).join(' ');
}

function PlanShapes({plan, toView, ppu, selection, issueFor, onSelect}) {
  const keySelect = (kind, id) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect({kind, id});
    }
  };
  const isSel = (kind, id) => selection?.kind === kind && selection.id === id;
  const state = (kind, id) => {
    const list = issueFor(kind, id);
    return list.some((i) => i.severity === 'error') ? ' has-error' : list.length ? ' has-warning' : '';
  };
  const hit = 44 / ppu;
  return (
    <g>
      {plan.rooms.map((r) => {
        const c = toView(interiorPoint(r.polygon));
        const label = isSel('room', r.id) ? {name: r.name, area: true} : roomLabel(r, ppu);
        return (
          <g key={r.id} className={`plan-room${isSel('room', r.id) ? ' is-selected' : ''}${state('room', r.id)}`} data-kind="room" data-id={r.id} tabIndex={0} role="button" aria-label={`Room ${r.name}, ${sqft(roomArea(r))}`} onKeyDown={keySelect('room', r.id)}>
            <polygon points={r.polygon.map(toView).map((p) => p.join(',')).join(' ')} />
            <title>{`${r.name}, ${sqft(roomArea(r))}`}</title>
            {label && <text x={c[0]} y={c[1]} fontSize={13 / ppu} textAnchor="middle">{label.name}</text>}
            {label?.area && <text x={c[0]} y={c[1] + 16 / ppu} fontSize={11 / ppu} textAnchor="middle" className="plan-area">{sqft(roomArea(r))}</text>}
          </g>
        );
      })}
      {plan.walls.map((w) => {
        const a = toView(w.start), b = toView(w.end);
        return (
          <g key={w.id} className={`plan-wall${isSel('wall', w.id) ? ' is-selected' : ''}${state('wall', w.id)}`} data-kind="wall" data-id={w.id} tabIndex={0} role="button" aria-label={`Wall ${w.id}, ${wallLength(w).toFixed(2)} m`} onKeyDown={keySelect('wall', w.id)}>
            <polygon points={wallPolygon(w, toView)} />
            <line className="plan-hit" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeWidth={Math.max(hit, w.thickness)} />
          </g>
        );
      })}
      {plan.openings.map((o) => {
        const w = plan.walls.find((x) => x.id === o.wallId);
        if (!w) return null;
        const len = wallLength(w), u = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
        const s = [w.start[0] + u[0] * o.offset, w.start[1] + u[1] * o.offset], e = [s[0] + u[0] * o.width, s[1] + u[1] * o.width];
        const opening = {...w, start: s, end: e, thickness: w.thickness * 1.02};
        const a = toView(s), b = toView(e);
        return (
          <g key={o.id} className={`plan-opening kind-${o.kind}${isSel('opening', o.id) ? ' is-selected' : ''}${state('opening', o.id)}`} data-kind="opening" data-id={o.id} tabIndex={0} role="button" aria-label={`${o.kind === 'door' ? 'Door' : 'Window'} ${o.id}, ${o.width.toFixed(2)} m wide`} onKeyDown={keySelect('opening', o.id)}>
            <polygon points={wallPolygon(opening, toView)} />
            <line className="plan-opening-mark" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeWidth={2 / ppu} />
            <line className="plan-hit" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeWidth={hit} />
          </g>
        );
      })}
    </g>
  );
}

function NumberField({label, value, onCommit, min, step = 0.01, unit = 'm'}) {
  const [text, setText] = useState(String(num(value)));
  useEffect(() => setText(String(num(value))), [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v !== value && (min === undefined || v >= min)) onCommit(v);
    else setText(String(num(value)));
  };
  return (
    <label>{label}
      <span className="plan-inline">
        <input type="number" inputMode="decimal" step={step} min={min} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
        <span className="plan-unit">{unit}</span>
      </span>
    </label>
  );
}
function Issues({issues}) {
  return issues.length ? <ul className="plan-issues">{issues.map((i, n) => <li key={n} className={`tone-${i.severity === 'error' ? 'danger' : 'warning'}`}>{i.message}</li>)}</ul> : null;
}
function WallInspector({wall, issues, onChange, onSplit, onOpening, onDelete}) {
  const setPt = (end, axis) => (v) => onChange({[end]: axis === 0 ? [v, wall[end][1]] : [wall[end][0], v]});
  return (
    <section className="plan-card">
      <h3>Wall {wall.id} <span className="plan-mono">{wallLength(wall).toFixed(2)} m</span></h3>
      <Issues issues={issues} />
      <div className="plan-grid">
        <NumberField label="Start east" value={wall.start[0]} onCommit={setPt('start', 0)} />
        <NumberField label="Start north" value={wall.start[1]} onCommit={setPt('start', 1)} />
        <NumberField label="End east" value={wall.end[0]} onCommit={setPt('end', 0)} />
        <NumberField label="End north" value={wall.end[1]} onCommit={setPt('end', 1)} />
        <NumberField label="Thickness" value={wall.thickness} min={0.01} onCommit={(v) => onChange({thickness: v})} />
        <NumberField label="Height" value={wall.height} min={0.1} onCommit={(v) => onChange({height: v})} />
      </div>
      <label>Material<input value={wall.material} onChange={(e) => onChange({material: e.target.value})} /></label>
      <div className="plan-banner-actions">
        <button type="button" onClick={() => onOpening('door')}><DoorOpen aria-hidden="true" />Add door</button>
        <button type="button" onClick={() => onOpening('window')}><AppWindow aria-hidden="true" />Add window</button>
        <button type="button" onClick={onSplit}><Scissors aria-hidden="true" />Split in half</button>
        <button type="button" className="plan-danger" onClick={onDelete}><Trash2 aria-hidden="true" />Delete</button>
      </div>
    </section>
  );
}
function OpeningInspector({opening, wall, issues, onChange, onDelete}) {
  return (
    <section className="plan-card">
      <h3>{opening.kind === 'door' ? 'Door' : 'Window'} {opening.id} <span className="plan-mono">on {opening.wallId}{wall ? `, ${wallLength(wall).toFixed(2)} m` : ''}</span></h3>
      <Issues issues={issues} />
      <div className="plan-grid">
        <label>Kind
          <select value={opening.kind} onChange={(e) => onChange({kind: e.target.value, ...(e.target.value === 'window' ? {swing: null} : {})})}>
            <option value="door">Door</option><option value="window">Window</option>
          </select>
        </label>
        {opening.kind === 'door' && (
          <label>Swing
            <select value={opening.swing ?? ''} onChange={(e) => onChange({swing: e.target.value || null})}>
              <option value="">Not set</option><option value="left">Left hinge</option><option value="right">Right hinge</option>
            </select>
          </label>
        )}
        <NumberField label="Offset from wall start" value={opening.offset} onCommit={(v) => onChange({offset: v})} />
        <NumberField label="Width" value={opening.width} min={0.05} onCommit={(v) => onChange({width: v})} />
        <NumberField label="Sill" value={opening.sill} min={0} onCommit={(v) => onChange({sill: v})} />
        <NumberField label="Height" value={opening.height} min={0.05} onCommit={(v) => onChange({height: v})} />
      </div>
      <div className="plan-banner-actions"><button type="button" className="plan-danger" onClick={onDelete}><Trash2 aria-hidden="true" />Delete</button></div>
    </section>
  );
}
function TextField({label, value, onCommit}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => (text.trim() && text.trim() !== value ? onCommit(text.trim()) : setText(value));
  return <label>{label}<input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} /></label>;
}
function RoomInspector({room, issues, onChange, onDelete}) {
  return (
    <section className="plan-card">
      <h3>Room <span className="plan-mono">{sqft(roomArea(room))} to wall centerlines</span></h3>
      <Issues issues={issues} />
      <TextField label="Name" value={room.name} onCommit={(name) => onChange({name})} />
      <div className="plan-banner-actions"><button type="button" className="plan-danger" onClick={onDelete}><Trash2 aria-hidden="true" />Remove room</button></div>
    </section>
  );
}
function AddWallForm({onAdd, height}) {
  const [v, setV] = useState({sx: '', sy: '', ex: '', ey: ''});
  const ready = Object.values(v).every((x) => x !== '' && Number.isFinite(Number(x)));
  return (
    <section className="plan-card">
      <h3>Add a wall by coordinates</h3>
      <form className="plan-grid" onSubmit={(e) => { e.preventDefault(); onAdd([Number(v.sx), Number(v.sy)], [Number(v.ex), Number(v.ey)]); setV({sx: '', sy: '', ex: '', ey: ''}); }}>
        {[['sx', 'Start east'], ['sy', 'Start north'], ['ex', 'End east'], ['ey', 'End north']].map(([k, label]) => (
          <label key={k}>{label}<span className="plan-inline"><input type="number" inputMode="decimal" step="0.01" value={v[k]} onChange={(e) => setV({...v, [k]: e.target.value})} /><span className="plan-unit">m</span></span></label>
        ))}
        <button type="submit" disabled={!ready}>Add wall ({DEFAULTS.thickness} m thick, {height} m high)</button>
      </form>
    </section>
  );
}
function ItemLists({plan, selection, issueFor, onSelect}) {
  const groups = [
    ['Rooms', 'room', plan.rooms, (r) => `${r.name} · ${sqft(roomArea(r))}`],
    ['Walls', 'wall', plan.walls, (w) => `${w.id} · ${wallLength(w).toFixed(2)} m`],
    ['Openings', 'opening', plan.openings, (o) => `${o.kind === 'door' ? 'Door' : 'Window'} ${o.id} · ${o.width.toFixed(2)} m`],
  ];
  return groups.map(([title, kind, items, label]) => (
    <details key={kind} className="plan-card plan-list" open={kind === 'room'}>
      <summary>{title} <span className="plan-mono">{items.length}</span></summary>
      <ul>
        {items.map((x) => {
          const flagged = issueFor(kind, x.id).some((i) => i.severity === 'error');
          return <li key={x.id}><button type="button" aria-pressed={selection?.kind === kind && selection.id === x.id} className={flagged ? 'tone-danger' : ''} onClick={() => onSelect({kind, id: x.id})}>{label(x)}</button></li>;
        })}
      </ul>
    </details>
  ));
}

window.acresPlanEditor = {
  mount(container, {projectId, scheme, onAction}) {
    this.unmount(container);
    const root = createRoot(container);
    roots.set(container, root);
    root.render(<LoadBoundary message="The floor plan editor did not load."><PlanEditor key={scheme} projectId={projectId} scheme={scheme} onAction={onAction} /></LoadBoundary>);
  },
  unmount(container) {
    roots.get(container)?.unmount();
    roots.delete(container);
  },
};
