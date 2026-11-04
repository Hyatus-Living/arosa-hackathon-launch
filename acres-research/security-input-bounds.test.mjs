import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inferUrlJurisdiction} from './jurisdiction.mjs';
import {validatePlan as validateStoredPlan} from './architecture-artifacts.mjs';
import {planFromJson,validatePlan} from './plan-intake.mjs';

// A child timeout also bounds the test if a synchronous parser regresses.
function bounded(code) {
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',timeout:5000,killSignal:'SIGKILL',maxBuffer:8192,
  });
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
}

test('jurisdiction inference requires complete government and codifier hostnames',()=>{
  const domains=[['myflorida.com','US-FL'],['flsenate.gov','US-FL'],['leg.state.fl.us','US-FL'],
    ['ca.gov','US-CA'],['leginfo.legislature.ca.gov','US-CA'],['cityofchicago.org','US-IL-CHICAGO'],['chicago.gov','US-IL-CHICAGO']];
  for(const [domain,jurisdiction] of domains) {
    assert.equal(inferUrlJurisdiction(`https://${domain}/rules`),jurisdiction);
    assert.equal(inferUrlJurisdiction(`https://www.${domain}/rules`),jurisdiction);
    assert.equal(inferUrlJurisdiction(`https://${domain}.example/rules`),null);
    if (!domain.startsWith('leg.') && !domain.startsWith('leginfo.'))
      assert.equal(inferUrlJurisdiction(`https://fake${domain}/rules`),null);
  }
  for(const [domain,path,jurisdiction] of [['municode.com','/fl/miami/codes','US-FL-MIAMI'],['up.codes','/viewer/california/building-code','US-CA']]) {
    assert.equal(inferUrlJurisdiction(`https://${domain}${path}`),jurisdiction);
    assert.equal(inferUrlJurisdiction(`https://library.${domain}${path}`),jurisdiction);
    assert.equal(inferUrlJurisdiction(`https://fake${domain}${path}`),null);
    assert.equal(inferUrlJurisdiction(`https://${domain}.example${path}`),null);
  }
});

test('citation validation finishes for repeated evidence labels followed by ordinary text',()=>bounded(`
  import {validateCitations} from './acres-research/lanes.mjs';
  try { validateCitations('The source contains evidence pages [1].', [{id:1,title:'Evidence',url:'https://example.com',verified:true,text:('Evidence page 1.  ').repeat(100)+'!'}]); }
  catch(error) { if (!error.code) throw error; }
`));

test('drawing names are bounded before whitespace normalization',()=>bounded(`
  import assert from 'node:assert/strict';
  import {drawingName} from './acres-research/architecture-drawings.mjs';
  assert.equal(drawingName('x'+'\\u2000'.repeat(200000)+'y','svg'),'x.svg');
  assert.equal(drawingName('  Floor 1 \\u2013 east.pdf  ','pdf'),'Floor 1, east.pdf');
`));

const plan=polygon=>({schema:'acres.architecture.plan/1',name:'Room',units:'m',levels:[{id:'l1',elevation:0,height:3}],
  walls:[],openings:[],rooms:[{id:'r1',levelId:'l1',name:'Room',polygon}],objects:[],sources:[]});

test('import, storage and geometry validation reject oversized polygons before reading coordinates',()=>{
  const polygon=Array(2001);
  Object.defineProperty(polygon,0,{get(){throw new Error('Coordinates must not be read before checking the limit.');}});
  const document=plan(polygon);
  for(const validate of [doc=>planFromJson(doc,{ref:'room.json'}),validateStoredPlan,validatePlan])
    assert.throws(()=>validate(document),/polygon.*at most 2,000/);
  assert.equal(planFromJson(plan(Array.from({length:2000},(_,i)=>[i,0])),{ref:'room.json'}).rooms[0].polygon.length,2000);
});

test('polygon limits apply to the complete plan as well as each room',()=>{
  const document=plan([]);
  document.rooms=Array.from({length:11},(_,i)=>({id:`r${i}`,levelId:'l1',name:'Room',polygon:Array.from({length:2000},()=>[0,0])}));
  for(const validate of [doc=>planFromJson(doc,{ref:'room.json'}),validateStoredPlan,validatePlan])
    assert.throws(()=>validate(document),/polygons.*at most 20,000/);
});
