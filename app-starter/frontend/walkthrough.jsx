// The dollhouse and walk views of a published architecture GLB. The GLB comes from the processing
// worker; its node names match the manifest, which says which nodes are rooms, walls and floors.
// Nothing here rebuilds geometry from the plan: the plan only supplies levels and camera stops.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Canvas, useFrame, useThree} from '@react-three/fiber';
import {CameraControls, Html, Sky} from '@react-three/drei';
import {Box3, Color, DoubleSide, Object3D, PCFShadowMap, Plane, Sphere, Vector3} from 'three';
import {dragLook, groundHeight, levelTop, stepWalker, storeyLifts, storyFrame, unitCards} from './architecture-model.mjs';
import {dollhouseMeshVisible, setSpaceShellVisible} from './architecture-loader.mjs';
import {startWalkClock} from './walk-clock.mjs';
import {InteriorScene} from './interior-scene.jsx';
import {PhotoRenderer} from './photo-renderer.jsx';
import {daylightEnvironment} from './daylight-environment.mjs';
import {attachContextRecovery} from './context-recovery.mjs';

const HIGHLIGHT = new Color('#3d6fe0'), NO_GLOW = new Color('#000000');
const WALK_SPEED = 1.4, RUN_SPEED = 2.8, LOOK_SPEED = 0.005;

function InteriorEnvironment() {
  const {scene}=useThree();
  useEffect(()=>{
    const environment=daylightEnvironment(),previous=scene.environment,previousIntensity=scene.environmentIntensity;
    scene.environment=environment;scene.environmentIntensity=.5;
    return ()=>{scene.environment=previous;scene.environmentIntensity=previousIntensity;environment.dispose();};
  },[scene]);
  return null;
}


const MOVE_KEYS = {KeyW: [1, 0], ArrowUp: [1, 0], KeyS: [-1, 0], ArrowDown: [-1, 0], KeyD: [0, 1], ArrowRight: [0, 1], KeyA: [0, -1], ArrowLeft: [0, -1]};

export {loadArchitectureModel} from './architecture-loader.mjs';

// Tints the selected room's nodes and, in the plain dollhouse, hides storeys above the chosen level.
// Meshes carry the model's own storey ids, so heights come from the manifest's storeys.
function SceneState({model, index, mode, whole, levels, storeys, levelId, roomId, objectName}) {
  const invalidate = useThree(state => state.invalidate);
  useEffect(() => {
    const top = levelTop(levels.find(l => l.id === levelId));
    const heights = new Map(storeys.map(s => [s.id, s.elevation]));
    const tinted = new Set([...(index.rooms.get(roomId) || []), ...(objectName ? [objectName] : [])]);
    for (const mesh of model.meshes) {
      mesh.visible = mode === 'walk' || whole || dollhouseMeshVisible(mesh, index, heights, top);
      setSpaceShellVisible(mesh,mode === 'walk');
      for (const material of [mesh.material].flat()) {
        if (!material.emissive) continue;
        const selected = tinted.has(mesh.userData.node);
        material.emissive.copy(selected ? HIGHLIGHT : NO_GLOW);
        material.emissiveIntensity = selected ? 0.45 : 1;
      }
    }
    invalidate();
  }, [model, index, mode, whole, levels, storeys, levelId, roomId, objectName, invalidate]);
  return null;
}

// The top-level nodes of the model with the storey each belongs to, so a storey moves as one piece.
function storeyNodes(model) {
  const nodes = new Map();
  for (const mesh of model.meshes) {
    let node = mesh;
    while (node.parent && node.parent !== model.scene) node = node.parent;
    if (!nodes.has(node) || nodes.get(node) === null) nodes.set(node, mesh.userData.levelId);
  }
  return [...nodes].map(([node, levelId]) => ({node, levelId, y: node.position.y}));
}

// Pulls the storeys apart (open) or back together, easing over about half a second, with an apartment
// card for each unit on the chosen floor. Leaving the dollhouse snaps the model back at once, before
// Walk reads its world positions for collision.
function Explode({model, lifts, storey, plan, levelId, dollhouse, open}) {
  const invalidate = useThree(state => state.invalidate);
  const nodes = useMemo(() => storeyNodes(model), [model]);
  const amount = useRef(0), cards = useRef(null);
  const place = value => {
    for (const {node, levelId: id, y} of nodes) node.position.y = y + (lifts.get(id) ?? 0) * value;
    if (cards.current) cards.current.position.y = (lifts.get(storey?.id) ?? 0) * value;
    model.scene.updateMatrixWorld(true);
  };
  useEffect(() => { invalidate(); }, [open, invalidate]);
  useEffect(() => { if (!dollhouse) { amount.current = 0; place(0); } }, [dollhouse]);
  useEffect(() => () => { amount.current = 0; place(0); }, [nodes]);
  useFrame((_, delta) => {
    const goal = open ? 1 : 0;
    if (amount.current === goal) return;
    const step = Math.min(1, delta * 4);
    amount.current = Math.abs(goal - amount.current) < 0.01 ? goal : amount.current + (goal - amount.current) * step;
    place(amount.current);
    invalidate();
  });
  if (!open || !storey) return null;
  return (
    <group ref={cards}>
      {unitCards(plan, levelId).map(unit => (
        <Html key={unit.id} position={[unit.at[0], storey.elevation + 1.6, -unit.at[1]]} center className="arch-unit-card" zIndexRange={[20, 0]}>
          <strong>{unit.name}</strong>
          <span>{unit.beds === 0 ? 'Studio' : unit.beds ? `${unit.beds} bed` : ''}{unit.beds !== null ? ' · ' : ''}{Math.round(unit.area / 0.09290304).toLocaleString('en-US')} sq ft</span>
        </Html>
      ))}
    </group>
  );
}

// The plan-to-3D story: a section plane cuts the model at the height storyFrame gives for the
// progress, and the camera follows it. Cut walls are drawn double-sided so they read as solid.
function Story({model, floor, progress}) {
  const {camera, gl, invalidate} = useThree();
  const plane = useMemo(() => new Plane(new Vector3(0, -1, 0), 0), []);
  const box = useMemo(() => {
    const b = new Box3().setFromObject(model.scene), size = b.getSize(new Vector3()), center = b.getCenter(new Vector3());
    return {center: center.toArray(), span: Math.max(size.x, size.z), top: b.max.y};
  }, [model]);
  useEffect(() => {
    gl.clippingPlanes = [plane];
    const materials = new Set(model.meshes.flatMap(mesh => [mesh.material].flat()));
    for (const material of materials) { material.userData.side ??= material.side; material.side = DoubleSide; material.needsUpdate = true; }
    return () => {
      gl.clippingPlanes = [];
      for (const material of materials) { material.side = material.userData.side; material.needsUpdate = true; }
      invalidate();
    };
  }, [gl, model, plane, invalidate]);
  useEffect(() => {
    const {cut, target, position} = storyFrame(progress, {...box, floor});
    plane.constant = cut;
    camera.position.set(...position);
    camera.lookAt(...target);
    invalidate();
  }, [progress, box, floor, camera, plane, invalidate]);
  return null;
}

// Orbit around the model. The polar limit keeps the camera above the ground; the last orbit is
// remembered so returning from Walk lands where the dollhouse was left. `fit` frames a sphere (the
// exploded building) from the current angle.
function Dollhouse({pose, stops, memory, fit}) {
  const [controls, setControls] = useState(null);
  useEffect(() => {
    if (!controls) return;
    const saved = memory.current;
    if (saved.position) controls.setLookAt(...saved.position, ...saved.target, false);
    return () => {
      const position = controls.getPosition(), target = controls.getTarget();
      memory.current = {...memory.current, position: position.toArray(), target: target.toArray()};
    };
  }, [controls, memory]);
  useEffect(() => {
    const stop = stops.find(s => s.id === pose.stopId);
    if (!controls || pose.mode !== 'dollhouse' || memory.current.seq === pose.seq || !stop) return;
    memory.current.seq = pose.seq;
    const {orbit} = stop;
    controls.setLookAt(...orbit.position, ...orbit.target, Boolean(memory.current.position));
    memory.current.position = orbit.position;
    memory.current.target = orbit.target;
  }, [controls, pose, stops, memory]);
  useEffect(() => { if (controls && fit) controls.fitToSphere(fit, true); }, [controls, fit]);
  return <CameraControls ref={setControls} makeDefault azimuthRotateSpeed={-1} polarRotateSpeed={-1} dollySpeed={0.7} minDistance={1.5} maxDistance={160} maxPolarAngle={Math.PI / 2 - 0.06} />;
}

// Eye-level walking: keys or the touch stick move, dragging looks, and every step goes through the
// collision world of the level underfoot.
function Walk({pose, stops, worlds, levels, eyeHeight, input, memory, onWalker, onFps}) {
  const camera = useThree(state => state.camera);
  const gl = useThree(state => state.gl);
  useEffect(() => {
    const fov = camera.fov;
    camera.fov = 72; camera.updateProjectionMatrix();
    return () => { camera.fov = fov; camera.updateProjectionMatrix(); };
  }, [camera]);
  const levelUnder = feet => levels.reduce((best, l) => (l.elevation <= feet + 0.5 && (!best || l.elevation > best.elevation) ? l : best), null);
  useEffect(() => {
    const stop = stops.find(s => s.id === pose.stopId);
    if (pose.mode !== 'walk' || memory.current.seq === pose.seq || !stop?.walk) return;
    const {walk, levelId} = stop;
    if (pose.reset) { camera.fov = 72; camera.updateProjectionMatrix(); }
    const level = levels.find(l => l.id === levelId);
    const [x, , z] = walk.position, [tx, , tz] = walk.target;
    const feet = groundHeight(worlds.get(levelId).floors, x, z, level.elevation + 0.35) ?? level.elevation;
    memory.current = {seq: pose.seq, x, z, feet, yaw: Math.atan2(-(tx - x), -(tz - z)), pitch: 0};
  }, [pose, stops, worlds, levels, memory, camera]);
  useEffect(() => {
    const canvas = gl.domElement;
    let last = null;
    let pointerId = null;
    const down = event => { if(pointerId!==null)return;pointerId=event.pointerId;last = [event.clientX, event.clientY]; canvas.setPointerCapture(event.pointerId); };
    const move = event => {
      if (!last || event.pointerId!==pointerId) return;
      const w = memory.current;
      Object.assign(w, dragLook(w, event.clientX - last[0], event.clientY - last[1], LOOK_SPEED));
      last = [event.clientX, event.clientY];
    };
    const up = event => { if(event.pointerId===pointerId){last = null;pointerId=null;} };
    const wheel = event => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
      camera.fov = Math.max(35, Math.min(95, camera.fov + event.deltaY * unit * 0.08));
      camera.updateProjectionMatrix();
    };
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('lostpointercapture', up);
    canvas.addEventListener('wheel', wheel, {passive: false});
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('lostpointercapture', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }, [gl, camera, memory]);
  const stats = useRef({frames: 0, since: 0, reported: 0});
  useFrame((state, delta) => {
    const w = memory.current;
    if (w.seq === undefined) return;
    const dt = Math.min(delta, 0.05);
    let forward = -input.current.stick[1], right = input.current.stick[0];
    for (const code of input.current.keys) if (MOVE_KEYS[code]) { forward += MOVE_KEYS[code][0]; right += MOVE_KEYS[code][1]; }
    const amount = Math.hypot(forward, right);
    if (amount > 0) {
      const speed = (input.current.keys.has('ShiftLeft') || input.current.keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED) * dt / Math.max(1, amount);
      const sin = Math.sin(w.yaw), cos = Math.cos(w.yaw);
      const next = stepWalker(w, {x: (-sin * forward + cos * right) * speed, z: (-cos * forward - sin * right) * speed}, worlds.get(levelUnder(w.feet).id));
      Object.assign(w, next);
    }
    camera.position.set(w.x, w.feet + eyeHeight, w.z);
    camera.rotation.set(w.pitch, w.yaw, 0, 'YXZ');
    const now = state.clock.elapsedTime, s = stats.current;
    s.frames += 1;
    if (!s.since) s.since = now;
    if (now - s.since >= 1) { onFps(s.frames / (now - s.since)); s.frames = 0; s.since = now; }
    if (now - s.reported > 0.1 && (s.x !== w.x || s.z !== w.z || s.yaw !== w.yaw || s.feet !== w.feet)) {
      Object.assign(s,{reported:now,x:w.x,z:w.z,yaw:w.yaw,feet:w.feet});
      onWalker({x: w.x, y: -w.z, yaw: w.yaw, levelId: levelUnder(w.feet).id});
    }
  });
  return null;
}

// Follow display refresh and stop spending GPU time in a background tab.
function WalkFrameClock({active}) {
  const advance = useThree(state => state.advance);
  useEffect(() => {
    if (!active) return;
    return startWalkClock(advance,{document,requestAnimationFrame,cancelAnimationFrame});
  }, [active, advance]);
  return null;
}

function WalkRenderBudget({active, sceneReady, levelId}) {
  const {gl,setDpr,size}=useThree();
  const samples=useRef({seconds:0,frames:0});
  const compact=size.width<600 || window.matchMedia('(pointer: coarse)').matches;
  useEffect(()=>{
    setDpr(Math.min(window.devicePixelRatio,compact?1:1.5));
    samples.current={seconds:0,frames:0};
  },[compact,setDpr]);
  useEffect(()=>{
    // Architecture and furnishings are static. Rebuild shadows only after a
    // mode/floor/assets change, never just because the camera moves.
    const refresh=()=>{gl.shadowMap.autoUpdate=!active;gl.shadowMap.needsUpdate=true;};
    refresh();
    gl.domElement.addEventListener('webglcontextrestored',refresh);
    return ()=>{gl.domElement.removeEventListener('webglcontextrestored',refresh);gl.shadowMap.autoUpdate=true;};
  },[gl,active,sceneReady,levelId]);
  useFrame((state,delta)=>{
    if(!active||document.visibilityState!=='visible'||delta>.25)return;
    const sample=samples.current;
    sample.seconds+=delta;sample.frames++;
    if(sample.seconds<2)return;
    if(sample.frames/sample.seconds<45){
      setDpr(Math.max(compact ? 0.65 : 0.75,state.viewport.dpr-.15));
    }
    sample.seconds=0;sample.frames=0;
    gl.domElement.dataset.renderDpr=state.viewport.dpr.toFixed(2);
    gl.domElement.dataset.drawCalls=String(gl.info.render.calls);
    gl.domElement.dataset.triangles=String(gl.info.render.triangles);
  });
  return null;
}

// Reports the first frame drawn with the model in a visible canvas.
function FirstFrame({onFrame}) {
  const done = useRef(false);
  useFrame(state => { if (!done.current && state.size.width > 0) { done.current = true; requestAnimationFrame(() => onFrame()); } });
  return null;
}

// Recovers from WebGL context loss (a permanently black canvas otherwise) and, in
// demand mode, redraws after tab return or resize so a stale frame is never kept.
function ContextGuard({onLost,onRestored}) {
  const {gl,invalidate}=useThree();
  useEffect(()=>{
    const detach=attachContextRecovery(gl.domElement,{onLost,onRestored:()=>{invalidate();onRestored();}});
    const redraw=()=>{if(!document.hidden)invalidate();};
    document.addEventListener('visibilitychange',redraw);
    window.addEventListener('resize',redraw);
    return ()=>{detach();document.removeEventListener('visibilitychange',redraw);window.removeEventListener('resize',redraw);};
  },[gl,invalidate,onLost,onRestored]);
  return null;
}

class CanvasBoundary extends React.Component {
  constructor(props) { super(props); this.state = {failed: false}; }
  static getDerivedStateFromError() { return {failed: true}; }
  componentDidCatch(error) { console.warn('[acres] walkthrough failed', error); this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function Walkthrough({model, index, state, dispatch, stops, plan, storeys, show, progress, input, onWalker, onFps, onFirstFrame, onError, furnished, detailedLighting, onLightingFailure, walker}) {
  const levels = plan.levels;
  const [sceneReady,setSceneReady]=useState(false);
  const [canvasEpoch,setCanvasEpoch]=useState(0);
  const restoreTimer=useRef(null);
  const onContextLost=React.useCallback(()=>{
    console.warn('[acres] walkthrough graphics context lost; waiting for restore');
    clearTimeout(restoreTimer.current);
    // Browsers usually restore a lost context; if none arrives, remount for a fresh one.
    restoreTimer.current=setTimeout(()=>setCanvasEpoch(epoch=>epoch+1),3000);
  },[]);
  const onContextRestored=React.useCallback(()=>{clearTimeout(restoreTimer.current);},[]);
  useEffect(()=>()=>clearTimeout(restoreTimer.current),[]);
  // The exploded view opens the top storey of the chosen floor, lifting the storeys above it by most of
  // the building's width.
  const level = levels.find(l => l.id === state.levelId);
  const storey = storeys.find(s => Math.abs(s.elevation - levelTop(level)) < 0.05) ?? null;
  const {lifts, exploded, lightCenter, lightSpan} = useMemo(() => {
    const box = new Box3().setFromObject(model.scene), size = box.getSize(new Vector3());
    const lightCenter=box.getCenter(new Vector3()).toArray(),lightSpan=Math.max(size.x,size.z,8);
    const lifts = storeyLifts(storeys, storey?.id, Math.max(size.x, size.z) * 0.7);
    box.max.y += Math.max(0, ...lifts.values());
    return {lifts, exploded: box.getBoundingSphere(new Sphere()),lightCenter,lightSpan};
  }, [model, storeys, storey]);
  const lightTarget=useMemo(()=>new Object3D(),[]);
  const orbitMemory = useRef({seq: null});
  const walkMemory = useRef({});
  const night = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const base = Math.min(...levels.map(l => l.elevation));
  const pick = event => {
    if (state.mode !== 'dollhouse' || event.delta > 4) return;
    event.stopPropagation();
    const node = event.object.userData.node;
    if (node) dispatch({type: 'select-object', name: node});
  };
  return (
    <CanvasBoundary onError={onError}>
      <Canvas key={canvasEpoch} shadows={state.mode === 'walk' && furnished ? {type:PCFShadowMap} : false} frameloop={state.mode === 'walk' ? 'never' : 'demand'} dpr={[1, 1.5]} camera={{fov: 62, near: 0.05, far: 400, position: [14, 12, 14]}}
        onPointerMissed={() => { if (state.mode === 'dollhouse') dispatch({type: 'select-room', roomId: null}); }}>
        <ContextGuard onLost={onContextLost} onRestored={onContextRestored} />
        <WalkFrameClock active={state.mode === 'walk'} />
        <WalkRenderBudget active={state.mode === 'walk' && furnished} sceneReady={sceneReady} levelId={state.levelId} />
        <color attach="background" args={[night ? '#2a2c27' : '#e8e4dc']} />
        {state.mode === 'walk' && furnished && <InteriorEnvironment />}
        {state.mode === 'walk' && furnished && detailedLighting && sceneReady && <PhotoRenderer version={state.levelId} onFailure={onLightingFailure} />}
        {state.mode === 'walk' && furnished && <Sky userData={{photoBackground:true}} distance={250} sunPosition={[100,35,100]} turbidity={7} rayleigh={1.8} />}
        <hemisphereLight args={['#ffffff', night ? '#3a3d36' : '#b9b3a6', state.mode === 'walk' && furnished ? .6 : (night ? .9 : 1.15)]} />
        <primitive object={lightTarget} position={lightCenter} />
        <directionalLight position={[lightCenter[0]+8,lightCenter[1]+14,lightCenter[2]+6]} target={lightTarget} intensity={state.mode === 'walk' && furnished ? 1.05 : 1.5}
          castShadow={state.mode === 'walk' && furnished} shadow-mapSize={[2048,2048]} shadow-normalBias={.02} shadow-bias={-0.0002}
          shadow-camera-left={-lightSpan} shadow-camera-right={lightSpan} shadow-camera-top={lightSpan} shadow-camera-bottom={-lightSpan} shadow-camera-far={Math.max(100,lightSpan*3)} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, base - 0.01, 0]} receiveShadow raycast={() => null}>
          <circleGeometry args={[80, 48]} />
          <meshStandardMaterial color={night ? '#2a2c27' : '#dcd9cf'} roughness={1} />
        </mesh>
        <primitive object={model.scene} onClick={pick} />
        {state.mode === 'walk' && furnished && <InteriorScene plan={plan} model={model} authoredRooms={model.authoredRooms} authoredFloors={model.authoredFloors} walker={walker} legacyUnstyled={model.legacyUnstyled} onSceneReady={setSceneReady} />}
        <SceneState model={model} index={index} mode={state.mode} whole={Boolean(show)} levels={levels} storeys={storeys} levelId={state.levelId} roomId={state.roomId} objectName={state.objectName} />
        <Explode model={model} lifts={lifts} storey={storey} plan={plan} levelId={state.levelId} dollhouse={state.mode === 'dollhouse'} open={state.mode === 'dollhouse' && show === 'explode'} />
        {state.mode === 'dollhouse' && show === 'story' && <Story model={model} floor={levels.find(l => l.id === state.levelId).elevation} progress={progress} />}
        {state.mode === 'dollhouse' && show !== 'story' && <Dollhouse pose={state.pose} stops={stops} memory={orbitMemory} fit={show === 'explode' ? exploded : null} />}
        {state.mode === 'walk' && <Walk pose={state.pose} stops={stops} worlds={model.worlds} levels={levels} eyeHeight={state.eyeHeight} input={input} memory={walkMemory} onWalker={onWalker} onFps={onFps} />}
        <FirstFrame onFrame={onFirstFrame} />
      </Canvas>
    </CanvasBoundary>
  );
}

// A thumb stick for touch screens: drag inside the ring to walk.
export function TouchStick({input}) {
  const ref = useRef(null);
  const knob=useRef(null),pointer=useRef(null);
  const update = event => {
    const box = ref.current.getBoundingClientRect(), r = box.width / 2;
    let x = (event.clientX - box.left - r) / r, y = (event.clientY - box.top - r) / r;
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }
    input.current.stick = [x, y];
    knob.current.style.transform=`translate(${x*box.width*.3}px, ${y*box.width*.3}px)`;
  };
  const release = () => { pointer.current=null;input.current.stick = [0, 0]; knob.current.style.transform='translate(0,0)'; };
  useEffect(()=>{
    window.addEventListener('blur',release);
    document.addEventListener('visibilitychange',release);
    return ()=>{input.current.stick=[0,0];window.removeEventListener('blur',release);document.removeEventListener('visibilitychange',release);};
  },[input]);
  return (
    <div ref={ref} className="arch-stick" role="presentation"
      onPointerDown={event => { if(pointer.current!==null)return;pointer.current=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId); update(event); }}
      onPointerMove={event => { if(event.pointerId===pointer.current)update(event); }}
      onPointerUp={event=>{if(event.pointerId===pointer.current)release();}}
      onPointerCancel={event=>{if(event.pointerId===pointer.current)release();}}
      onLostPointerCapture={event=>{if(event.pointerId===pointer.current)release();}}>
      <span ref={knob} />
    </div>
  );
}
