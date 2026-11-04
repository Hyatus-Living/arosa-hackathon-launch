import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DOMParser} from 'linkedom';
import * as intake from '../../public/plan-intake.js';

const source=readFileSync(new URL('../../frontend/plan-editor.jsx',import.meta.url),'utf8');
const svg=readFileSync(new URL('./sample-floorplan.svg',import.meta.url),'utf8');
export const drawingFile=(name='drawing.svg',type='image/svg+xml')=>new File([type==='image/svg+xml'?svg:'PDF renderer fixture'],name,{type});

// Executes the editor's actual intake, calibration and reload handlers. PDF rendering and browser
// state setters are controlled here; this is controller evidence, not a browser/rendering test.
export function calibrationController(initial) {
  const c={...intake,DOMParser,Blob,plan:structuredClone(initial),projectId:'calibration-project',scheme:intake.DEFAULT_SCHEME,underlay:null,calibration:null,
    saved:{revision:initial?.revision??0},savedRef:{current:{revision:initial?.revision??0}},picks:[],distance:'',distanceUnit:'m',
    drawingGeneration:{current:0},pdfPageGeneration:{current:0},editorGeneration:{current:0},reloadGeneration:{current:0},
    notices:[],commits:[],drawings:[],baseRef:ref=>ref.split('#')[0],storage:()=>null,onAction(){},
    URL:{createObjectURL:()=>`blob:fixture`,revokeObjectURL(){}},
    renderPdfPage:async(_file,n)=>({url:`blob:page-${n}`,width:1000,height:800,pages:3}),
    fetch:()=>{throw new Error('Assign the local API transport before reload.');},
    say:(tone,text)=>c.notices.push({tone,text}),
  };
  for(const key of ['Underlay','Calibration','Picks','Labels','Selection','Tool','Saved','Loaded','Conflict','Update','Distance','Drawings','Scene']) {
    const field=key[0].toLowerCase()+key.slice(1);
    c[`set${key}`]=value=>{c[field]=typeof value==='function'?value(c[field]):value;};
  }
  // The level in view, as the editor holds it: the first level unless another is selected.
  Object.defineProperty(c,'level',{get:()=>c.plan?.levels[0],enumerable:true});
  c.history={commit:next=>{c.plan=next;c.commits.push(next);},current:()=>c.plan,reset:next=>{c.plan=next;},linkDrawing:(name,drawing)=>{c.plan=intake.linkDrawingSources(c.plan,name,drawing);}};
  vm.createContext(c);
  const intakeStart=source.indexOf('  // A drawing from disk is also stored');
  const intakeEnd=source.indexOf('  // ---- Canvas interaction ----',intakeStart);
  const saveStart=source.indexOf('  function rememberSaved(');
  const reloadEnd=source.indexOf('  function keepMine(',saveStart);
  if(intakeStart<0||intakeEnd<0||saveStart<0||reloadEnd<0)throw new Error('Editor handler boundaries changed.');
  vm.runInContext(source.slice(intakeStart,intakeEnd)+'\n'+source.slice(saveStart,reloadEnd),c);
  c.apply=(distance,picks=[[0,0],[100,0]])=>{c.distance=String(distance);c.picks=picks;c.applyCalibration({preventDefault(){}});};
  return c;
}
