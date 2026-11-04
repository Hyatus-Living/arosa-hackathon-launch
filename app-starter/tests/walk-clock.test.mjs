import test from 'node:test';
import assert from 'node:assert/strict';
import {advance} from '@react-three/fiber';
import {advanceWalkClock,startWalkClock} from '../frontend/walk-clock.mjs';

test('30 manual frames advance the Fiber simulation by one second at walking speed',()=>{
  let distance=0,frames=0;
  const state={frameloop:'never',clock:{elapsedTime:0,getDelta:()=>0},gl:{},internal:{
    priority:0,frames:0,subscribers:[{store:{getState:()=>state},ref:{current:(_state,delta)=>{
      distance+=1.4*Math.min(delta,0.05);frames++;
    }}}],
  }};
  const render=timestamp=>advance(timestamp,false,state);
  advanceWalkClock(render,0);
  for(let frame=1;frame<=30;frame++)advanceWalkClock(render,frame*1000/30);
  assert.equal(state.clock.elapsedTime,1);
  assert.ok(Math.abs(distance-1.4)<1e-9,`walked ${distance} m in one second`);
  assert.equal(frames-1,30);
  assert.equal((frames-1)/state.clock.elapsedTime,30);
});

test('display clock stops when hidden, resumes once, and cancels its pending frame on cleanup',()=>{
  const frames=new Map(),listeners=new Map(),times=[];
  let id=0;
  const document={visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const stop=startWalkClock(time=>times.push(time),{
    document,requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
  });
  const render=time=>{const [id,fn]=frames.entries().next().value;frames.delete(id);fn(time);};
  render(1000);render(1016);
  assert.deepEqual(times,[1,1.016]);
  assert.equal(frames.size,1);
  document.visibilityState='hidden';listeners.get('visibilitychange')();
  assert.equal(frames.size,0);
  document.visibilityState='visible';listeners.get('visibilitychange')();
  assert.equal(frames.size,1);
  render(5000);
  assert.equal(times.at(-1),5);
  stop();
  assert.equal(frames.size,0);
  assert.equal(listeners.size,0);
});
