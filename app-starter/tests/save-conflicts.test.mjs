import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ChatStore} from '../../acres-research/store.mjs';
import {saveProjectFields} from '../public/core-model.js';

const owner='a'.repeat(24);
function setup(t,fields={}){
  const dir=mkdtempSync(join(tmpdir(),'acres-save-conflicts-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const id=store.createConversation(owner).projectId;
  const read=()=>store.projectView(owner,id);
  const write=fields=>store.updateProjectState(owner,id,{version:read().version,fields});
  if(Object.keys(fields).length)write(fields);
  const calls=[];
  const api={
    get:async path=>{assert.equal(path,`/projects/${id}/state`);calls.push({method:'GET'});return read();},
    patch:async(path,body)=>{assert.equal(path,`/projects/${id}/state`);calls.push({method:'PATCH',body});return store.updateProjectState(owner,id,body);},
  };
  return {id,store,read,write,api,calls};
}

test('a stale assumption save merges independent numeric and nested edits through the real versioned store',async(t)=>{
  const initial={landPrice:1000000,capRate:.05,financing:{loanToCost:.6,interestRate:.08}};
  const {id,read,write,api}=setup(t,{assumptions:initial});
  const before=read();
  write({assumptions:{...initial,landPrice:1200000,financing:{loanToCost:.7,interestRate:.08}}});
  const edited={...initial,capRate:.06,financing:{loanToCost:.6,interestRate:.09}};
  const snapshot=structuredClone({before,edited});
  const saved=await saveProjectFields(api,id,before,{assumptions:edited});
  assert.deepEqual(saved.fields.assumptions.value,{landPrice:1200000,capRate:.06,financing:{loanToCost:.7,interestRate:.09}});
  assert.deepEqual({before,edited},snapshot,'the submitted draft and saved baseline are immutable');
  assert.equal(saved.version,3);
});

test('overlapping assumption edits require review and leave the other saved value untouched',async(t)=>{
  const {id,read,write,api,calls}=setup(t,{assumptions:{landPrice:1000000}});
  const before=read();const latest=write({assumptions:{landPrice:1200000}});
  await assert.rejects(()=>saveProjectFields(api,id,before,{assumptions:{landPrice:1400000}}),error=>error.status===409&&error.latest.version===latest.version&&/changed while you were saving/.test(error.message));
  assert.equal(calls.filter(call=>call.method==='PATCH').length,1,'a conflicting draft is not automatically written again');
  assert.equal(read().fields.assumptions.value.landPrice,1200000);
  assert.equal(read().version,latest.version);
});

test('deleting an override preserves independently added defaults and nested financing inputs',async(t)=>{
  const {id,read,write,api}=setup(t,{assumptions:{landPrice:1000000,financing:{interestRate:.08}}});
  const before=read();
  write({assumptions:{landPrice:1000000,capRate:.06,financing:{interestRate:.08,loanToCost:.7}}});
  const saved=await saveProjectFields(api,id,before,{assumptions:{landPrice:1000000}});
  assert.deepEqual(saved.fields.assumptions.value,{landPrice:1000000,capRate:.06,financing:{loanToCost:.7}});
});

test('section instructions merge independent edits and blank untouched boxes do not delete a new instruction',async(t)=>{
  const {id,read,write,api}=setup(t,{instructions:{massing:'Original massing',revenue:'Rental'}});
  const before=read();
  write({instructions:{massing:'Original massing',revenue:'Condo',architecture:'Keep the stairs'}});
  const saved=await saveProjectFields(api,id,before,{instructions:{massing:'  Six storeys  ',revenue:'Rental',architecture:'',envelope:'',assumptions:''}});
  assert.deepEqual(saved.fields.instructions.value,{massing:'Six storeys',revenue:'Condo',architecture:'Keep the stairs'});
});

test('clearing an override that another editor changed is a conflict, not an automatic deletion',async(t)=>{
  const {id,read,write,api}=setup(t,{assumptions:{capRate:.05,landPrice:1000000}});
  const before=read();write({assumptions:{capRate:.06,landPrice:1000000}});
  await assert.rejects(()=>saveProjectFields(api,id,before,{assumptions:{landPrice:1000000}}),error=>error.status===409&&error.latest.fields.assumptions.value.capRate===.06);
  assert.equal(read().fields.assumptions.value.capRate,.06);
});

test('matching edits and version changes in unrelated project fields retain the normal retry workflow',async(t)=>{
  const {id,read,write,api}=setup(t,{assumptions:{landPrice:1000000}});
  const before=read();const same=write({assumptions:{landPrice:1200000}});
  const converged=await saveProjectFields(api,id,before,{assumptions:{landPrice:1200000}});
  assert.equal(converged.version,same.version,'matching values do not add a persisted version');
  write({instructions:{massing:'Retain the courtyard'}});
  const saved=await saveProjectFields(api,id,converged,{assumptions:{landPrice:1400000}});
  assert.equal(saved.fields.assumptions.value.landPrice,1400000);
  assert.equal(saved.fields.instructions.value.massing,'Retain the courtyard');
});

test('a first local assumption save preserves a concurrently added assumption from an empty saved field',async(t)=>{
  const {id,read,write,api}=setup(t);
  const before=read();write({assumptions:{capRate:.06}});
  const saved=await saveProjectFields(api,id,before,{assumptions:{landPrice:1000000}});
  assert.deepEqual(saved.fields.assumptions.value,{capRate:.06,landPrice:1000000});
});
