import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {sensitivity} from './proforma.mjs';

const owner='a'.repeat(24);
const market={submarket:'Controlled mixed use',rents:[{bedrooms:1,rentPerSqftPerMonth:8,source:'Fixture',retrievedAt:'2026-10-18'}],commercialRents:[{use:'retail',rentPerSqftPerYear:100,source:'Fixture',retrievedAt:'2026-10-18'}]};
const inputs={name:'Mixed use',productType:'rental',program:{grossBuildingSqft:10000,units:[{bedrooms:1,count:10,netSqft:600}],commercial:[{use:'retail',netSqft:1000}]},landPrice:1000000,hardCostPerSqft:200,softCostPerSqft:50,financing:{loanToCost:.6,interestRate:.08,termMonths:24},operating:{residentialVacancyRate:.05,residentialOpexPerUnitPerYear:10000,commercialVacancyRate:.1,commercialOpexPerSqftPerYear:5},capRate:.05};
const mix=(area=9000,count=10)=>({productType:'rental',residentialGrossSqft:area,byBedrooms:[{bedrooms:1,units:count,unitSqft:600}]});
const model=args=>{const {base,table}=sensitivity(args,market);return {...base,sensitivity:table,sensitivitySteps:{}};};
function fixture(t,{program=mix(),extra=[]}={}){
  const dir=mkdtempSync(join(tmpdir(),'mixed-use-edit-')),store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const conversation=store.createConversation(owner),run=store.createRun(owner,conversation.id,'Underwrite mixed use');store.begin(run);
  store.finish(run,'completed',{answer:'Controlled fixture',property:{bbl:'1000010001'},market,program,proFormas:[model(inputs),...extra],sources:[]});
  const view=()=>store.projectView(owner,conversation.projectId);
  const edit=program=>store.updateProjectState(owner,conversation.projectId,{version:view().version,fields:{program}});
  return {store,run,view,edit};
}

test('an explicit mixed-use unit edit preserves total gross and commercial area without subtracting net from gross',t=>{
  for(const area of [9000,8200]){
    const f=fixture(t,{program:mix(area)}),before=f.view().fields.proFormas.value[0],after=f.edit(mix(area,9)).fields.proFormas;
    assert.equal(after.stale,null);assert.equal(after.value[0].inputs.program.units[0].count,9);
    assert.equal(after.value[0].inputs.program.grossBuildingSqft,10000);assert.deepEqual(after.value[0].inputs.program.commercial,before.inputs.program.commercial);
    assert.equal(after.value[0].development.totalDevelopmentCost,before.development.totalDevelopmentCost);assert.ok(after.value[0].operations.noi<before.operations.noi);
    assert.deepEqual(f.store.run(owner,f.run.id).result.proFormas[0],before,'explicit state edits do not rewrite the narrated run');
  }
});

test('changed or removed residential area and changed product remain stale for mixed-use scenarios',t=>{
  for(const program of [mix(9500,9),mix(10000,10),{...mix(9000,9),productType:'condo'},{productType:'rental',byBedrooms:mix(9000,9).byBedrooms}]){
    const f=fixture(t),before=f.view().fields.proFormas.value,after=f.edit(program).fields.proFormas;
    assert.equal(after.stale,'program');assert.deepEqual(after.value,before);
  }
});

test('multiple mixed-use scenarios and an unmatched prior mix remain stale rather than inheriting one edit',t=>{
  for(const config of [
    {extra:[model({...inputs,name:'Different building',program:{...inputs.program,grossBuildingSqft:12000}})]},
    {extra:[model({...inputs,name:'Different units',program:{...inputs.program,units:[{bedrooms:1,count:8,netSqft:600}]}})]},
    {program:mix(9000,8)},
    {program:{productType:'rental',byBedrooms:mix().byBedrooms}},
  ]){
    const f=fixture(t,config),before=f.view().fields.proFormas.value,after=f.edit(mix(9000,9)).fields.proFormas;
    assert.equal(after.stale,'program');assert.deepEqual(after.value,before);
  }
});

test('a rejected mixed-use area change cannot establish a new association for a later unit edit',t=>{
  const f=fixture(t),before=f.view().fields.proFormas.value;
  const resized=f.edit(mix(9500));assert.equal(resized.fields.proFormas.stale,'program');assert.deepEqual(resized.fields.proFormas.value,before);
  const later=f.edit(mix(9500,9));assert.equal(later.fields.proFormas.stale,'program');assert.deepEqual(later.fields.proFormas.value,before);
});
