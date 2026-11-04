// Plan, Dollhouse and Walk views of one architecture revision:
//   window.acresArchitectureView.render(container, {plan, glbUrl, manifestUrl, pascalScene, onSelect})
// plan is the architecture plan v1 document; glbUrl and manifestUrl are the worker's published
// walkthrough artifacts. pascalScene is the same revision's editable scene, kept for the editor:
// the walkthrough never rebuilds geometry from it. onSelect receives the shared room/object
// selection whenever it changes in any view.
import React, {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {architectureReducer, cameraStops, initialArchitectureState, levelOf, roomAt, selectionIndex} from './architecture-model.mjs';
import {ArchitecturePlan, formatArea} from './architecture-plan.jsx';
import {loadArchitectureModel, TouchStick, Walkthrough} from './walkthrough.jsx';
import {LoadBoundary} from './load-boundary.jsx';

const roots = new Map();
const NOTICES = {
  webgl: 'This browser cannot show the 3D model. The plan is still available.',
  model: 'The 3D model could not be loaded. The plan is still available.',
};
const MODES = [['plan', 'Plan'], ['dollhouse', 'Dollhouse'], ['walk', 'Walk']];
const EMPTY_MANIFEST = {objects: [], levels: [], collision: {walls: [], floors: []}};

function hasWebgl() {
  const canvas = document.createElement('canvas');
  return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
}

function ArchitectureView({plan, glbUrl, manifestUrl, onSelect, root, startedAt}) {
  const [manifest, setManifest] = useState(null);
  const [model, setModel] = useState(null);
  const context = useMemo(() => ({plan, manifest: manifest || EMPTY_MANIFEST}), [plan, manifest]);
  const reducer = useMemo(() => architectureReducer(context), [context]);
  const reducerRef = useRef(reducer);
  reducerRef.current = reducer;
  const [state, dispatch] = useReducer((s, a) => reducerRef.current(s, a), context, c => initialArchitectureState(c, {webgl: hasWebgl()}));
  const index = useMemo(() => selectionIndex(context.manifest), [context]);
  const stops = useMemo(() => cameraStops(plan, {eyeHeight: state.eyeHeight}), [plan, state.eyeHeight]);
  const [walker, setWalker] = useState(null);
  const [furnished, setFurnished] = useState(true);
  const [detailedLighting,setDetailedLighting]=useState(false);
  const [lightingUnavailable,setLightingUnavailable]=useState(false);
  const lightingFailed=useCallback(()=>{setDetailedLighting(false);setLightingUnavailable(true);},[]);
  const [check, setCheck] = useState(false);
  // The dollhouse can also be shown exploded or as the plan-to-3D story ('explode' | 'story' | null).
  const [show, setShow] = useState(null);
  const [progress, setProgress] = useState(0);
  const stage = useRef(null);
  const input = useRef({keys: new Set(), stick: [0, 0]});

  useEffect(() => { requestAnimationFrame(() => { root.dataset.planMs = String(Math.round(performance.now() - startedAt)); }); }, [root, startedAt]);

  const [requested3D, request3D] = useState(false);
  useEffect(() => { if (state.mode !== 'plan') request3D(true); }, [state.mode]);
  // Keep the initial plan paint cheap, then load the model in the background once the browser
  // is idle, so the first move into 3D (often Walk inside) opens rendered instead of loading.
  useEffect(() => {
    if (requested3D) return;
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(() => request3D(true), {timeout: 2500});
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(() => request3D(true), 1200);
    return () => clearTimeout(timer);
  }, [requested3D]);
  // Retain one model after the first 3D request.
  useEffect(() => {
    if (!requested3D || state.unavailable === 'webgl') return;
    let active = true, built = null;
    const controller = new AbortController();
    (async () => {
      const response = await fetch(manifestUrl, {credentials: 'same-origin', signal: controller.signal});
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      const loaded = await response.json();
      if (!active) return;
      setManifest(loaded);
      built = await loadArchitectureModel(glbUrl, selectionIndex(loaded), plan.levels, {signal: controller.signal});
      if (!active) { built.dispose(); return; }
      if (active) { root.dataset.modelMs = String(Math.round(performance.now() - startedAt)); setModel(built); }
    })().catch(error => {
      if (!active) return;
      console.warn('[acres] walkthrough model unavailable', error);
      if (active) dispatch({type: 'unavailable', reason: 'model'});
    });
    return () => { active = false; controller.abort(); built?.dispose(); };
  }, [requested3D, glbUrl, manifestUrl, plan, root, startedAt, state.unavailable === 'webgl']);

  const selection = state.objectName || state.roomId;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const object = state.objectName ? index.objects.get(state.objectName) : null;
    onSelect?.(selection ? {roomId: state.roomId, objectName: state.objectName, ifcGlobalId: object?.ifcGlobalId ?? null, kind: object?.kind ?? (state.roomId ? 'room' : null), levelId: state.levelId} : null);
  }, [selection]);

  // Movement keys drive Walk while it is open, except while typing in a form control.
  useEffect(() => {
    if (state.mode !== 'walk') return;
    const typing = event => /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable;
    const down = event => {
      if (typing(event) || event.metaKey || event.ctrlKey || event.altKey) return;
      input.current.keys.add(event.code);
      if (event.code.startsWith('Arrow')) event.preventDefault();
    };
    const up = event => input.current.keys.delete(event.code);
    const clear = () => { input.current.keys.clear(); input.current.stick=[0,0]; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange',clear);
    return () => { clear(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange',clear); };
  }, [state.mode]);

  useEffect(() => { root.dataset.mode = state.mode; if (state.mode !== 'dollhouse') setShow(null); }, [root, state.mode]);
  // Scrolling over the model drives the story instead of zooming.
  useEffect(() => {
    if (show !== 'story') return;
    const wheel = event => { event.preventDefault(); setProgress(p => Math.min(1, Math.max(0, p + event.deltaY * 0.0012))); };
    const node = stage.current;
    node.addEventListener('wheel', wheel, {passive: false});
    return () => node.removeEventListener('wheel', wheel);
  }, [show]);
  // Both open on a floor with apartments when the chosen one has none.
  const toggle = view => {
    const homes = plan.levels.find(l => plan.rooms.some(r => r.unitId && levelOf(plan, r) === l.id));
    if (show !== view && homes && !plan.rooms.some(r => r.unitId && levelOf(plan, r) === state.levelId)) dispatch({type: 'level', levelId: homes.id});
    setShow(current => (current === view ? null : view));
    setProgress(0);
  };
  const here = walker ? roomAt(plan, walker.levelId, [walker.x, walker.y]) : null;
  useEffect(() => { root.dataset.walkerRoom = here ?? ''; }, [root, here]);

  const room = plan.rooms.find(r => r.id === state.roomId);
  const picked = state.objectName ? index.objects.get(state.objectName) : null;
  const level = plan.levels.find(l => l.id === state.levelId);
  const threeD = state.mode !== 'plan';
  const stopChoices = stops.filter(s => state.mode !== 'walk' || s.walk);
  const walkHere = roomId => { dispatch({type: 'mode', mode: 'walk'}); dispatch({type: 'stop', stopId: `room:${roomId}`}); };
  return (
    <div className="concept-view arch-view">
      <div className="concept-toolbar" role="group" aria-label="View">
        {MODES.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={state.mode === id} disabled={id !== 'plan' && Boolean(state.unavailable)} onClick={() => dispatch({type: 'mode', mode: id})}>{label}</button>
        ))}
        {state.mode !== 'walk' && !state.unavailable && (
          <button type="button" className="arch-walk-inside" onClick={() => { if (room && stops.some(s => s.id === `room:${room.id}` && s.walk)) walkHere(room.id); else dispatch({type: 'mode', mode: 'walk'}); }}>Walk inside</button>
        )}
        {plan.levels.length > 1 && state.mode !== 'walk' && (
          <select className="arch-select" aria-label="Floor" value={state.levelId} onChange={event => dispatch({type: 'level', levelId: event.target.value})}>
            {plan.levels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        {threeD && show !== 'story' && (
          <select className="arch-select concept-toggle" aria-label="Go to" value="" onChange={event => { dispatch({type: 'stop', stopId: event.target.value}); event.target.blur(); }}>
            <option value="" disabled>Go to…</option>
            {stopChoices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {state.mode === 'plan' && <button type="button" aria-pressed={check} onClick={() => setCheck(on => !on)}>Check units</button>}
        {state.mode === 'dollhouse' && <button type="button" aria-pressed={show === 'story'} onClick={() => toggle('story')}>Plan to 3D</button>}
        {state.mode === 'dollhouse' && <button type="button" aria-pressed={show === 'explode'} onClick={() => toggle('explode')}>Explode</button>}
        {show === 'story' && (
          <label className="arch-eye">Build
            <input type="range" min="0" max="1" step="0.01" value={progress} onChange={event => setProgress(Number(event.target.value))} />
          </label>
        )}
        {threeD && <button type="button" onClick={() => dispatch({type: 'reset'})}>Reset</button>}
        {state.mode === 'walk' && (
          <button type="button" aria-pressed={furnished} onClick={() => setFurnished(value => !value)}>Illustrative interiors</button>
        )}
        {state.mode === 'walk' && furnished && (
          <button type="button" aria-pressed={detailedLighting} onClick={()=>{setLightingUnavailable(false);setDetailedLighting(value=>!value);}}>Detailed lighting</button>
        )}
        {state.mode === 'walk' && (
          <label className="arch-eye">Eye height
            <input type="range" min="1.2" max="2" step="0.05" value={state.eyeHeight} onChange={event => dispatch({type: 'eye-height', value: Number(event.target.value)})} />
            <output>{state.eyeHeight.toFixed(2)} m</output>
          </label>
        )}
      </div>
      {state.unavailable && <p className="arch-notice" role="status">{NOTICES[state.unavailable]}</p>}
      <div className="concept-canvas arch-canvas" data-mode={state.mode}>
        {!state.unavailable && model && (
          <div className="arch-stage" hidden={!threeD} ref={stage}>
            <Walkthrough model={model} index={index} state={state} dispatch={dispatch} stops={stops} plan={plan} storeys={context.manifest.levels} show={show} progress={progress} input={input} furnished={furnished} detailedLighting={detailedLighting} onLightingFailure={lightingFailed} walker={walker}
              onWalker={setWalker} onFps={fps => { root.dataset.walkFps = fps.toFixed(1); }}
              onFirstFrame={() => { root.dataset.modelReadyMs ??= String(Math.round(performance.now() - startedAt)); }}
              onError={() => dispatch({type: 'unavailable', reason: 'webgl'})} />
          </div>
        )}
        {threeD && !model && <p className="concept-fallback">Loading the 3D model…</p>}
        {state.mode === 'plan' && <ArchitecturePlan plan={plan} levelId={state.levelId} roomId={state.roomId} onSelectRoom={roomId => dispatch({type: 'select-room', roomId})} walker={walker} check={check} />}
        {state.mode === 'walk' && model && (
          <>
            <ArchitecturePlan plan={plan} levelId={walker?.levelId ?? state.levelId} roomId={here} walker={walker} compact
              onSelectRoom={roomId => { if (roomId && stops.some(s => s.id === `room:${roomId}` && s.walk)) dispatch({type: 'stop', stopId: `room:${roomId}`}); }} />
            <p className="arch-hud"><span>{here ? plan.rooms.find(r => r.id === here).name : 'Outside'}</span><span className="arch-walk-help">Drag to look, stick or W A S D to move, scroll to zoom, Shift to run</span><span className="arch-touch-help">Drag to look · Stick to move</span></p>
            <TouchStick input={input} />
          </>
        )}
        {show === 'story' && <p className="arch-hud">Scroll over the model to raise the walls into the building</p>}
      </div>
      {state.mode === 'walk' && furnished && <p className="arch-interior-note">Furniture, finishes and lighting are illustrative. The plan remains unchanged. <a href="/architecture-assets/credits.html" target="_blank" rel="noopener noreferrer">Interior asset credits</a></p>}
      {state.mode === 'walk' && lightingUnavailable && <p className="arch-interior-note" role="status">Detailed lighting could not be displayed. The interactive view is still available.</p>}
      <div className="arch-selection" aria-live="polite">
        {room
          ? <><strong>{room.name}</strong><span>{formatArea(room.polygon)}{plan.levels.length > 1 ? ` · ${plan.levels.find(l => l.id === levelOf(plan, room)).name}` : ''}</span>
            {!state.unavailable && <button type="button" onClick={() => walkHere(room.id)}>Walk here</button>}</>
          : picked ? <><strong>{picked.name}</strong><span>{picked.kind}</span></>
          : <span>{state.mode === 'plan' ? `${level.name}, ${plan.rooms.filter(r => levelOf(plan, r) === level.id).length} rooms` : 'No room selected'}</span>}
      </div>
    </div>
  );
}

window.acresArchitectureView = {
  render(container, {plan, glbUrl, manifestUrl, pascalScene = null, onSelect = null}) {
    this.unmount(container);
    const root = createRoot(container);
    roots.set(container, root);
    root.render(<LoadBoundary message="The 3D walkthrough did not load."><ArchitectureView plan={plan} glbUrl={glbUrl} manifestUrl={manifestUrl} pascalScene={pascalScene} onSelect={onSelect} root={container} startedAt={performance.now()} /></LoadBoundary>);
  },
  unmount(container) {
    roots.get(container)?.unmount();
    roots.delete(container);
  },
};
