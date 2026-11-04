import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as intake from '../public/plan-intake.js';

const source=readFileSync(new URL('../frontend/plan-editor.jsx',import.meta.url),'utf8');
const historyStart=source.indexOf('function useHistory('),historyEnd=source.indexOf('\nasync function renderPdfPage(',historyStart);
const saveStart=source.indexOf('  // ---- Save and export ----'),saveEnd=source.indexOf('\n  function download()',saveStart);
const initialStart=source.indexOf('  // Load the saved plan and'),initialEnd=source.indexOf('\n  // Project events wait',initialStart);
const messageStart=source.indexOf('const replaces ='),messageEnd=source.indexOf('\n',messageStart);
assert.ok(historyStart>=0&&historyEnd>historyStart&&saveStart>=0&&saveEnd>saveStart&&initialStart>=0&&initialEnd>initialStart);
assert.ok(messageStart>=0&&messageEnd>messageStart);
const fixture=JSON.parse(readFileSync(new URL('./fixtures/sample-floorplan.json',import.meta.url),'utf8'));
const base=()=>({...intake.exportPlan(intake.planFromFixture(fixture,{ref:'floor.json'})),id:'plan-A',revision:1,parentRevision:null});
const change=(plan,name)=>({...plan,rooms:plan.rooms.map((room,i)=>i?room:{...room,name})});
const flush=()=>new Promise(setImmediate);
const name=plan=>plan.rooms[0].name;

function setup(initial=base()){
  const cells=[],refs=[];let cursor=0;
  const c={...intake,projectId:'A',scheme:intake.DEFAULT_SCHEME,plan:initial,saved:{revision:initial?.revision??null,plan:initial},savedRef:{current:{revision:initial?.revision??null,plan:initial}},editorGeneration:{current:0},reloadGeneration:{current:0},saveInFlight:{current:false},drawingGeneration:{current:0},ownRevisions:{current:new Set()},underlay:null,calibration:null,update:null,notices:[],actions:[],requests:[],drafts:new Map(),storageFailure:null,
    useState:value=>{const i=cursor++;if(!(i in cells))cells[i]=value;return [cells[i],next=>{cells[i]=typeof next==='function'?next(cells[i]):next;c.plan=cells[i].plan;}];},
    useRef:value=>{const i=cursor++;return refs[i]??=( {current:value} );},
    setSaving:value=>{c.saving=value;},setConflict:value=>{c.conflict=value;},setNotice:value=>{c.notice=value;},
    setSaved:value=>{c.saved=typeof value==='function'?value(c.saved):value;},setUpdate:value=>{c.update=value;},setSelection:value=>{c.selection=value;},setCalibration:value=>{c.calibration=value;},setTool:value=>{c.tool=value;},setUnderlay:value=>{c.underlay=value;},setDrawings:value=>{c.drawings=value;},setDraftOffer:value=>{c.draftOffer=value;},setLoaded:value=>{c.loaded=value;},
    baseRef:ref=>ref.split('#')[0],say:(tone,text)=>c.notices.push({tone,text}),onAction:value=>c.actions.push(value),
    fetch:(url,options={})=>new Promise(resolve=>c.requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null,answer:(body,status=200)=>resolve(new Response(JSON.stringify(body),{status}))})),
  };
  const local={getItem:key=>c.drafts.get(key)??null,setItem:(key,value)=>{if(c.storageFailure==='write')throw new Error('Draft storage full');c.drafts.set(key,value);},removeItem:key=>{if(c.storageFailure==='clear')throw new Error('Draft cleanup blocked');c.drafts.delete(key);}};
  c.storage=()=>local;
  vm.createContext(c);vm.runInContext(source.slice(messageStart,messageEnd)+'\n'+source.slice(historyStart,historyEnd)+'\n'+source.slice(saveStart,saveEnd),c);
  c.render=()=>{cursor=0;c.history=c.useHistory(initial);c.plan=c.history.plan;return c.history;};c.render();
  c.edit=value=>{c.history.commit(change(c.plan,value));c.render();};
  c.undo=()=>{c.history.undo();c.render();};c.redo=()=>{c.history.redo();c.render();};
  c.find=method=>c.requests.filter(r=>r.method===method);
  c.ack=(request,revision=2)=>request.answer({revision,parentRevision:revision-1,planId:'plan-A',plan:{...request.body.plan,revision}} ,201);
  c.loadedPlan=(request,plan,revision)=>request.answer({current:{revision,plan:{...plan,revision}}});
  c.startInitial=()=>{c.useEffect=effect=>{c.initialCleanup=effect();};vm.runInContext(source.slice(initialStart,initialEnd),c);};
  return c;
}

test('a save acknowledgment retains later typing, undo history and a draft based on the saved revision',async()=>{
  const c=setup();c.edit('Submitted');const pending=c.save();c.edit('Later typing');
  c.ack(c.find('PUT')[0]);await pending;c.render();
  assert.equal(name(c.plan),'Later typing');assert.equal(c.plan.revision,2);assert.equal(c.saved.revision,2);
  assert.equal(name(c.saved.plan),'Submitted');assert.equal(c.history.canUndo,true);
  const draft=JSON.parse(c.drafts.get(intake.draftKey('A')));assert.equal(name(draft),'Later typing');assert.equal(draft.revision,2);
  assert.match(c.notices.at(-1).text,/unsaved/);assert.equal(c.actions[0].revision,2);
});

test('normal saves preserve undo and redo, with every history snapshot using the current server revision',async()=>{
  const c=setup(),original=name(c.plan);c.edit('Submitted');const pending=c.save();c.ack(c.find('PUT')[0]);await pending;c.render();
  assert.equal(c.history.canUndo,true);c.undo();assert.equal(name(c.plan),original);assert.equal(c.plan.revision,2);
  c.redo();assert.equal(name(c.plan),'Submitted');assert.equal(c.plan.revision,2);
  c.undo();const again=c.save();assert.equal(c.find('PUT')[1].body.parentRevision,2);c.ack(c.find('PUT')[1],3);await again;
});

test('undo during an in-flight save remains undone and its redo path survives the response',async()=>{
  const c=setup(),original=name(c.plan);c.edit('Submitted');const pending=c.save();c.undo();
  c.ack(c.find('PUT')[0]);await pending;c.render();
  assert.equal(name(c.plan),original);assert.equal(c.plan.revision,2);assert.equal(c.history.canRedo,true);
  c.redo();assert.equal(name(c.plan),'Submitted');assert.equal(c.plan.revision,2);
});

test('a second save before the UI updates cannot send a duplicate revision request',async()=>{
  const c=setup();c.edit('Submitted');const first=c.save(),second=c.save();
  assert.equal(c.find('PUT').length,1);c.ack(c.find('PUT')[0]);await Promise.all([first,second]);
  assert.equal(c.actions.length,1);
});

test('local draft cleanup failure cannot turn a persisted save into a failed-save result',async()=>{
  const c=setup();c.edit('Submitted');c.storageFailure='clear';const pending=c.save();c.ack(c.find('PUT')[0]);await pending;c.render();
  assert.equal(c.saved.revision,2);assert.equal(c.actions.length,1);
  assert.notEqual(c.notices.at(-1).tone,'danger');assert.match(c.notices.at(-1).text,/Saved revision 2/);
});

test('revision conflicts retain the latest local edits without emitting a saved-revision action',async()=>{
  const c=setup();c.edit('Submitted');const pending=c.save();c.edit('Later typing');
  c.find('PUT')[0].answer({error:'Revision 3 exists',revision:3},409);await pending;c.render();
  assert.equal(name(c.plan),'Later typing');assert.equal(c.plan.revision,1);assert.equal(c.conflict.revision,3);assert.equal(c.actions.length,0);
});

test('a revision load started while clean cannot erase edits made before it returns',async()=>{
  const c=setup(),pending=c.reloadLatest('agent',{keepDraft:true});c.edit('Typed during load');
  c.loadedPlan(c.find('GET')[0],change(base(),'Remote'),3);await pending;c.render();
  assert.equal(name(c.plan),'Typed during load');assert.equal(c.plan.revision,1);assert.equal(c.update.revision,3);
});

test('out-of-order reloads keep the newest requested revision',async()=>{
  const c=setup(),old=c.reloadLatest(),latest=c.reloadLatest();
  c.loadedPlan(c.find('GET')[1],change(base(),'Newest'),3);await latest;
  c.loadedPlan(c.find('GET')[0],change(base(),'Obsolete'),2);await old;c.render();
  assert.equal(name(c.plan),'Newest');assert.equal(c.plan.revision,3);assert.equal(c.saved.revision,3);
});

test('a load response from before a successful save cannot roll back its acknowledged revision',async()=>{
  const c=setup(),loading=c.reloadLatest();c.edit('Submitted');const saving=c.save();
  c.ack(c.find('PUT')[0]);await saving;
  c.loadedPlan(c.find('GET')[0],base(),1);await loading;c.render();
  assert.equal(name(c.plan),'Submitted');assert.equal(c.plan.revision,2);assert.equal(c.saved.revision,2);
});

test('an empty server response does not erase the working plan or report an undefined revision',async()=>{
  const c=setup(),before=c.plan,pending=c.reloadLatest();c.find('GET')[0].answer({current:null});await pending;c.render();
  assert.equal(c.plan,before);assert.notEqual(c.notices.at(-1).tone,'danger');assert.doesNotMatch(c.notices.at(-1).text,/undefined/);
});

test('Keep mine rebases undo history as well as the visible plan onto the chosen revision',()=>{
  const c=setup(),original=name(c.plan);c.edit('Mine');c.update={revision:3,by:'user'};c.keepMine();c.render();
  c.undo();assert.equal(name(c.plan),original);assert.equal(c.plan.revision,3);c.redo();assert.equal(c.plan.revision,3);
});

test('Keep mine with only a drawing keeps it without inventing an incomplete plan document',()=>{
  const c=setup(null);c.underlay={ref:'survey.svg'};c.update={revision:3,by:'user'};c.keepMine();c.render();
  assert.equal(c.plan,null);assert.equal(c.underlay.ref,'survey.svg');assert.equal(c.saved.revision,3);
});

test('a save response from an unmounted editor cannot update state or dispatch an action',async()=>{
  const c=setup();c.edit('Submitted');const before=c.plan,pending=c.save();++c.editorGeneration.current;
  c.ack(c.find('PUT')[0]);await pending;c.render();
  assert.equal(c.plan,before);assert.equal(c.saved.revision,1);assert.equal(c.actions.length,0);assert.equal(c.notices.length,0);
});

test('a reload response from an unmounted editor cannot replace its plan',async()=>{
  const c=setup(),before=c.plan,pending=c.reloadLatest();++c.editorGeneration.current;
  c.loadedPlan(c.find('GET')[0],change(base(),'Remote'),3);await pending;c.render();
  assert.equal(c.plan,before);assert.equal(c.saved.revision,1);assert.equal(c.notices.length,0);
});

test('an older save acknowledgment cannot replace a newer loaded server snapshot',async()=>{
  const c=setup();c.edit('Submitted');const saving=c.save(),loading=c.reloadLatest();
  c.loadedPlan(c.find('GET')[0],change(base(),'Newer server plan'),3);await loading;
  c.ack(c.find('PUT')[0],2);await saving;c.render();
  assert.equal(c.plan.revision,3);assert.equal(name(c.plan),'Newer server plan');assert.equal(c.saved.revision,3);
});

test('the initial saved-plan read offers its revision instead of replacing a draft begun during loading',async()=>{
  const c=setup(null);c.startInitial();c.history.commit(change(base(),'Draft begun while loading'));c.render();
  const read=c.requests.find(r=>r.url.endsWith('/architecture'));const drawings=c.requests.find(r=>r.url.endsWith('/drawings'));
  c.loadedPlan(read,change(base(),'Saved plan'),3);drawings.answer({drawings:[]});await flush();await flush();c.render();
  assert.equal(name(c.plan),'Draft begun while loading');assert.equal(c.update.revision,3);assert.equal(c.loaded,true);
});

test('Save cancels an older read even when that read returns before the save acknowledgment',async()=>{
  const c=setup();c.edit('Submitted');const loading=c.reloadLatest(),saving=c.save();
  c.loadedPlan(c.find('GET')[0],base(),1);await loading;c.render();
  assert.equal(name(c.plan),'Submitted');assert.equal(c.history.canUndo,true);
  c.ack(c.find('PUT')[0]);await saving;c.render();
  assert.equal(name(c.plan),'Submitted');assert.equal(c.plan.revision,2);
  assert.doesNotMatch(c.notices.at(-1).text,/unsaved/);
});

test('Keep mine cancels an earlier load instead of presenting the same revision choice again',async()=>{
  const c=setup();c.edit('Mine');const loading=c.reloadLatest();
  c.update={revision:3,by:'user'};c.keepMine();c.render();
  c.loadedPlan(c.find('GET')[0],change(base(),'Remote'),3);await loading;c.render();
  assert.equal(name(c.plan),'Mine');assert.equal(c.plan.revision,3);assert.equal(c.update,null);
});

test('a draft-storage write failure preserves later work and accurately acknowledges the persisted save',async()=>{
  const c=setup();c.edit('Submitted');const pending=c.save();c.edit('Later typing');c.storageFailure='write';
  c.ack(c.find('PUT')[0]);await pending;c.render();
  assert.equal(name(c.plan),'Later typing');assert.equal(c.plan.revision,2);assert.equal(c.saved.revision,2);
  assert.equal(c.actions[0].revision,2);assert.equal(c.notices.at(-1).tone,'warning');
  assert.match(c.notices.at(-1).text,/Saved revision 2/);assert.match(c.notices.at(-1).text,/unsaved/);assert.match(c.notices.at(-1).text,/export/i);
});
