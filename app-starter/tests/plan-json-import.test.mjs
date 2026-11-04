import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as intake from '../public/plan-intake.js';

const source=readFileSync(new URL('../frontend/plan-editor.jsx',import.meta.url),'utf8');
const start=source.indexOf('  async function onJson('),end=source.indexOf('\n  // ---- Calibration ----',start);
assert.ok(start>=0&&end>start);
const fixture=JSON.parse(readFileSync(new URL('./fixtures/sample-floorplan.json',import.meta.url),'utf8'));
const modern=()=>intake.exportPlan(intake.planFromFixture(fixture,{ref:'sample.json'}));

function setup(){
  const prior={...modern(),id:'current-plan',revision:8,parentRevision:7};
  const context={...intake,plan:prior,saved:{revision:8},underlay:{url:'blob:prior'},calibration:{metresPerPixel:.1},labels:['prior'],selection:'wall-1',tool:'select',notices:[],commits:[],drawingGeneration:{current:0},pdfPageGeneration:{current:0},
    beginDrawing:()=>++context.drawingGeneration.current,
    history:{commit:doc=>{context.commits.push(doc);context.plan=doc;}},
    setUnderlay:value=>{context.underlay=value;},setCalibration:value=>{context.calibration=value;},setLabels:value=>{context.labels=value;},setSelection:value=>{context.selection=value;},setTool:value=>{context.tool=value;},
    say:(tone,text)=>context.notices.push({tone,text}),
  };
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const load=async doc=>{
    const text=JSON.stringify(doc);await context.onJson({name:'import.plan.json',size:Buffer.byteLength(text),text:async()=>text});
  };
  return {context,prior,load};
}

const badCases=[
  ['missing collections',()=>({schema:intake.PLAN_SCHEMA,name:'Broken plan',units:'m'}),/levels|walls|list/i],
  ['modern feet units',()=>({...modern(),units:'ft'}),/units|metres/i],
  ['unusable coordinate types',()=>{const doc=modern();doc.walls[0].start=['3',null];return doc;},/start|coordinate/i],
  ['ambiguous duplicate identities',()=>{const doc=modern();doc.walls.push({...doc.walls[0]});return doc;},/duplicate|unique/i],
  ['unknown wall references',()=>{const doc=modern();doc.openings[0].wallId='missing-wall';return doc;},/wall/i],
  ['invalid source calibration',()=>{const doc=modern();doc.sources[0].calibration={pointA:null,pointB:[1,0],distanceMetres:0};return doc;},/calibration|point|distance/i],
  ['unsupported schema versions',()=>({...modern(),schema:'acres.architecture.plan/2',rooms:[],openings:[]}),/schema/i],
];
for(const [label,make,diagnostic] of badCases)test(`JSON import rejects ${label} before touching the working plan`,async()=>{
  const {context:c,prior,load}=setup();const underlay=c.underlay,calibration=c.calibration;
  await load(make());
  assert.equal(c.commits.length,0,'invalid input never enters undo/history state');
  assert.equal(c.plan,prior);assert.equal(c.underlay,underlay);assert.equal(c.calibration,calibration);
  assert.equal(c.labels[0],'prior');assert.equal(c.selection,'wall-1');
  assert.equal(c.notices.at(-1).tone,'danger');assert.match(c.notices.at(-1).text,diagnostic);
});

test('a supported v1 import preserves metric geometry, metadata and the current project revision identity',async()=>{
  const {context:c,load}=setup(),doc=modern();
  doc.id='foreign-plan';doc.revision=99;doc.sources.push({title:'Design note',url:'https://example.com/note'});
  await load(doc);
  assert.equal(c.commits.length,1);assert.equal(c.plan.units,'m');
  assert.equal(c.plan.id,'current-plan');assert.equal(c.plan.revision,8);assert.equal(c.plan.parentRevision,7);
  assert.deepEqual(JSON.parse(JSON.stringify(c.plan.walls)),doc.walls);
  assert.deepEqual(JSON.parse(JSON.stringify(c.plan.sources)),doc.sources);
  assert.equal(c.underlay,null);assert.equal(c.notices.at(-1).tone,'info');
});

test('supported legacy feet imports convert geometry exactly once into the metric editor',async()=>{
  const {context:c,load}=setup(),legacy=structuredClone(fixture);legacy.units='ft';
  await load(legacy);
  assert.equal(c.commits.length,1);assert.equal(c.plan.units,'m');
  assert.ok(Math.abs(c.plan.walls[0].end[0]-legacy.walls[0].end[0]*.3048)<1e-6);
  assert.ok(Math.abs(c.plan.walls[0].height-legacy.height*.3048)<1e-6);
});

test('an editable incomplete plan with open wall ends is imported for repair without claiming geometry validity',async()=>{
  const {context:c,load}=setup(),doc=modern();
  doc.walls=[{...doc.walls[0],roomIds:[]}];doc.openings=[];doc.rooms=[];
  await load(doc);
  assert.equal(c.commits.length,1);
  assert.ok(intake.validatePlan(c.plan).some(issue=>issue.code==='wall-open-end'));
  assert.equal(c.notices.at(-1).tone,'info');
});
