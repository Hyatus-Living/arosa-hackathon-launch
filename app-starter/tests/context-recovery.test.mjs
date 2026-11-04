import test from 'node:test';
import assert from 'node:assert/strict';
import {attachContextRecovery} from '../frontend/context-recovery.mjs';

function fakeCanvas(){
  const listeners=new Map();
  return {
    addEventListener:(type,fn)=>listeners.set(type,fn),
    removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);},
    fire(type){
      const event={prevented:false,preventDefault(){this.prevented=true;}};
      listeners.get(type)?.(event);
      return event;
    },
    has:(type)=>listeners.has(type),
  };
}

test('context loss is acknowledged once and restore is reported once',()=>{
  const canvas=fakeCanvas();let lost=0,restored=0;
  const detach=attachContextRecovery(canvas,{onLost:()=>lost++,onRestored:()=>restored++});
  const event=canvas.fire('webglcontextlost');
  assert.equal(event.prevented,true,'preventDefault allows the browser to restore the context');
  assert.equal(lost,1);
  canvas.fire('webglcontextlost');
  assert.equal(lost,1,'a repeated loss while already lost is not reported twice');
  canvas.fire('webglcontextrestored');
  assert.equal(restored,1);
  canvas.fire('webglcontextrestored');
  assert.equal(restored,1,'a restore with no matching loss is ignored');
  detach();
  assert.equal(canvas.has('webglcontextlost'),false);
  assert.equal(canvas.has('webglcontextrestored'),false);
  canvas.fire('webglcontextlost');
  assert.equal(lost,1,'detached listeners stay detached');
});
