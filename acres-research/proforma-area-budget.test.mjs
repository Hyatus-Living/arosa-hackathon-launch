import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {normalizeProgram,sensitivity,recomputeProForma,createProFormaTools} from './proforma.mjs';
import {createFeasibilityTools} from './feasibility.mjs';
import {comparisonFixture} from './fixtures/comparison-ledger.mjs';
import {ChatStore} from './store.mjs';
import {fieldsFromResult} from './project-state.mjs';

const areaError=/net area.*grossBuildingSqft/;
const tooSmall={grossBuildingSqft:1000,units:[{bedrooms:0,count:10,netSqft:450}]};
const mixed={grossBuildingSqft:5000,units:[{bedrooms:0,count:6,netSqft:500}],commercial:[{use:'retail',netSqft:2500}]};
const commercialOnly={grossBuildingSqft:1000,units:[],commercial:[{use:'retail',netSqft:1100}]};
const ledgerShared=f=>{const shared={...f.shared,landPriceSource:'ledger',taxSource:'ledger'};delete shared.landPrice;return shared;};
function fixture(t){const f=comparisonFixture();t.after(()=>f.close());return f;}

test('underwriting programs must fit combined apartment and commercial net area inside total gross area',()=>{
  for(const program of [tooSmall,mixed,commercialOnly])assert.throws(()=>normalizeProgram(program),areaError);
});

test('fitting programs retain exact input quantities and full-efficiency fits',()=>{
  const programs=[{...mixed,commercial:[{use:'retail',netSqft:2000}]},{...commercialOnly,commercial:[{use:'retail',netSqft:1000}]},
    {grossBuildingSqft:1000,units:[{bedrooms:0,count:3,netSqft:333.33333333333337}]},
    {grossBuildingSqft:1000,units:[{bedrooms:0,count:2,netSqft:500},{bedrooms:1,count:0,netSqft:5000}]}];
  for(const program of programs){const before=structuredClone(program),normalized=normalizeProgram(program);assert.deepEqual(program,before);assert.deepEqual(normalized.units,program.units);assert.deepEqual(normalized.commercial,program.commercial??[]);}
  assert.throws(()=>normalizeProgram({grossBuildingSqft:1000,units:[{bedrooms:0,count:2,netSqft:500.00001}]}),areaError);
});

test('programs count whole apartments and must contain something that earns income',()=>{
  assert.throws(()=>normalizeProgram({grossBuildingSqft:5000,units:[{bedrooms:0,count:2.5,netSqft:500}]}),/count must be a whole number/);
  for(const program of [{grossBuildingSqft:5000,units:[]},{grossBuildingSqft:5000,units:[{bedrooms:0,count:0,netSqft:500}],commercial:[{use:'retail',netSqft:0}]}])
    assert.throws(()=>normalizeProgram(program),/at least one unit or some commercial area/);
});

test('rental and condo calculations and stored-model recomputation cannot earn income from overprogrammed area',t=>{
  const f=fixture(t);
  for(const productType of ['rental','condo'])assert.throws(()=>sensitivity({...f.shared,market:f.market,productType,program:tooSmall}),areaError);
  const {base}=sensitivity({...f.shared,market:f.market,productType:'rental'});
  assert.throws(()=>recomputeProForma(base,{market:f.market,program:{productType:'rental',byBedrooms:[{bedrooms:0,units:40,unitSqft:450}]}}),areaError);
  const corrected=recomputeProForma(base,{market:f.market,program:{productType:'rental',byBedrooms:[{bedrooms:0,units:11,unitSqft:450}]}});
  assert.equal(corrected.inputs.program.units[0].count,11);assert.ok(Number.isFinite(corrected.returns.profit));
});

test('an oversized pro forma fails before ledger reads, citation capture, emission or use of a result slot',async t=>{
  const f=fixture(t),emitted=[],tools=createProFormaTools({getMarket:()=>f.market,ledger:f.ledger,record:f.tools.record,emit:(...event)=>emitted.push(event)}),args={...ledgerShared(f),productType:'rental'};
  for(const program of [tooSmall,mixed,commercialOnly]){
    await assert.rejects(()=>tools.handlers.acres_pro_forma({...args,program}),areaError);
    assert.deepEqual(f.counts,{land:0,taxes:0});assert.equal(f.queries.length,0);assert.equal(f.tools.sources.length,0);assert.equal(tools.proFormas.length,0);assert.equal(emitted.length,0);
  }
  for(let i=0;i<4;i++)await tools.handlers.acres_pro_forma(args);
  assert.equal(tools.proFormas.length,4);assert.equal(emitted.length,4);assert.deepEqual(f.counts,{land:4,taxes:4});
  await assert.rejects(()=>tools.handlers.acres_pro_forma(args),/At most four/);assert.deepEqual(f.counts,{land:4,taxes:4});
});

test('all comparison effective programs are checked before any ledger or comparison capture',async t=>{
  const f=fixture(t),emitted=[],tools=createFeasibilityTools({getMarket:()=>f.market,ledger:f.ledger,record:f.tools.record,emit:(...event)=>emitted.push(event)}),shared=ledgerShared(f),base={label:'Market',productType:'rental'};
  for(const variant of [{label:'Small gross override',productType:'rental',grossBuildingSqft:1000},{label:'Full override',productType:'condo',program:tooSmall},{label:'Mixed override',productType:'rental',program:mixed}]){
    await assert.rejects(()=>tools.handlers.acres_compare_programs({shared,variants:[base,variant]}),areaError);
    assert.deepEqual(f.counts,{land:0,taxes:0});assert.equal(f.queries.length,0);assert.equal(f.tools.sources.length,0);assert.equal(tools.comparisons.length,0);assert.equal(emitted.length,0);
  }
  await tools.handlers.acres_compare_programs({shared,variants:[base,{label:'Condo',productType:'condo'}]});
  assert.equal(tools.comparisons.length,1);assert.equal(emitted.length,1);assert.deepEqual(f.counts,{land:1,taxes:1});
});

test('an overcapacity saved unit mix keeps prior finances stale and a fitting correction revalidates without replacing identical figures',async t=>{
  const f=comparisonFixture(),store=new ChatStore(join(f.dir,'chat.sqlite')),owner='a'.repeat(24);
  t.after(()=>{store.close();f.close();});
  await f.proformas.handlers.acres_pro_forma({...f.shared,productType:'rental'});const model=f.proformas.proFormas[0],conversation=store.createConversation(owner);
  const program={productType:'rental',byBedrooms:[{bedrooms:0,units:10,unitSqft:450}]};
  store.project.write(conversation.projectId,fieldsFromResult({property:f.property,market:f.market,program,proFormas:[model],sources:[]},'seed'));
  const before=store.projectView(owner,conversation.projectId),over=store.updateProjectState(owner,conversation.projectId,{version:before.version,fields:{program:{...program,byBedrooms:[{bedrooms:0,units:40,unitSqft:450}]}}});
  assert.ok(over.fields.proFormas.stale);assert.deepEqual(over.fields.proFormas.value,before.fields.proFormas.value);assert.equal(over.fields.program.value.byBedrooms[0].units,40);
  const corrected=store.updateProjectState(owner,conversation.projectId,{version:over.version,fields:{program}});
  assert.equal(corrected.fields.proFormas.stale,null);assert.deepEqual(corrected.fields.proFormas.value,before.fields.proFormas.value);
  const unchanged=store.updateProjectState(owner,conversation.projectId,{version:corrected.version,fields:{program}});
  assert.equal(unchanged.version,corrected.version);assert.deepEqual(unchanged.fields.proFormas,corrected.fields.proFormas);
});

test('a pro forma whose net area is over 90% of its gross area flags that no core is deducted',t=>{
  const f=fixture(t),run=program=>sensitivity({...f.shared,market:f.market,productType:'rental',program}).base;
  const full=run({grossBuildingSqft:1000,units:[{bedrooms:0,count:2,netSqft:500}]});
  assert.match(full.assumptions.join(' '),/efficiency 1 is above 0\.9: no core or circulation is deducted/);
  assert.equal(run({grossBuildingSqft:1000,units:[{bedrooms:0,count:2,netSqft:450}]}).assumptions,undefined);
});
