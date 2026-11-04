import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decideListingFilters} from './listing-filter-jev.mjs';
import {FILTER_SCHEMA,FILTER_SCHEMA_ID,defaultFilterValues} from './listing-filter-schema.mjs';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';

const snapshot=()=>({schema:FILTER_SCHEMA_ID,revision:3,values:{...defaultFilterValues(),borough:'QN',maxPrice:2000000},baselineCosts:{hardCostPerGrossSqft:375,softCostPctOfHard:.22,carryAndFinancingPct:.1,zfaToGrossFactor:1.15}});
function evaluator({control='preserve',response='research',borough=false,invalid=false}={},calls=[]) {
  return async body=>{
    calls.push(body);
    return {answers:Object.fromEntries(Object.entries(body.questions).map(([key,q])=>{
      let answer;
      // The old coupled question reproduces the observed live filter-only misclassification.
      if(key==='mode')answer='filters';
      else if(key==='control_action')answer=invalid?'undecided':control;
      else if(key==='response_kind')answer=response;
      else if(key==='initialization')answer='preserve';
      else if(q.criteria.keep)answer=key==='borough'&&borough?'set':'keep';
      else if(key==='borough')answer=Object.keys(q.criteria).find(id=>q.criteria[id].value==='BK');
      assert.ok(answer,key);return [key,{type:'choice',choice:answer}];
    }))};
  };
}

test('a comparison with preserved controls runs research once and never asks for field edits',async()=>{
  const base=snapshot(),calls=[],out=await decideListingFilters({snapshot:base,prompt:'Compare Brooklyn and Queens. Keep the page controls unchanged.'},{},evaluator({},calls));
  assert.deepEqual(out,{mode:'research',filterUpdate:null});assert.equal(calls.length,1);
  assert.deepEqual(calls[0].state.current,base);assert.deepEqual(calls[0].state.schema,FILTER_SCHEMA);assert.equal(Object.keys(calls[0].state.current.values).length,FILTER_SCHEMA.required.length);
});

test('keep-only instructions acknowledge unchanged controls without exposing a field mutation stage',async()=>{
  const base=snapshot(),calls=[],out=await decideListingFilters({snapshot:base,prompt:'Keep all filters as they are.'},{},evaluator({response:'acknowledge',borough:true},calls));
  assert.deepEqual(out,{mode:'filters',filterUpdate:null,answer:'Your filters are unchanged.'});assert.equal(calls.length,1);
});

test('an actual filter command changes only its requested values and needs no research',async()=>{
  const base=snapshot(),out=await decideListingFilters({snapshot:base,prompt:'Show Brooklyn. Keep the rest.'},{},evaluator({control:'change',response:'acknowledge',borough:true}));
  assert.equal(out.mode,'filters');assert.deepEqual(out.filterUpdate.values,{...base.values,borough:'BK'});assert.deepEqual(out.filterUpdate.base,base);
});

test('an explicit filter edit and analysis request preserve both actions',async()=>{
  const base=snapshot(),out=await decideListingFilters({snapshot:base,prompt:'Show Brooklyn and explain the remaining listings.'},{},evaluator({control:'change',response:'research',borough:true}));
  assert.equal(out.mode,'both');assert.deepEqual(out.filterUpdate.values,{...base.values,borough:'BK'});
});

test('an invalid control decision fails before any mutation question or execution',async()=>{
  const calls=[];await assert.rejects(decideListingFilters({snapshot:snapshot(),prompt:'Compare the listings.'},{},evaluator({invalid:true},calls)),/invalid decision.*control_action/);assert.equal(calls.length,1);
});

test('normal saved runs execute research and combined intents with the authoritative complete state',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-listing-intent-')),store=new ChatStore(join(dir,'chat.sqlite')),owner='a'.repeat(24),calls=[];
  t.after(()=>{store.close();rmSync(dir,{recursive:true});});
  const manager=new RunManager(store,{},async input=>{calls.push(input);return {answer:'Research answer',sources:[],ui:[]};},null,null,null,request=>decideListingFilters(request,{},evaluator({control:request.prompt.startsWith('Show')?'change':'preserve',borough:true})));
  for(const prompt of ['Compare the areas. Keep the controls unchanged.','Show Brooklyn and compare the listings.']) {
    const conversation=store.createConversation(owner),id=crypto.randomUUID(),base=snapshot(),done=new Promise(resolve=>manager.on(id,e=>{if(/^run\.(completed|failed)$/.test(e.event))resolve();}));
    manager.enqueue(owner,conversation.id,prompt,id,{prompt,snapshot:base});await done;
    assert.equal(store.run(owner,id).status,'completed');const answer=store.conversation(owner,conversation.id).messages.find(m=>m.role==='assistant');
    assert.equal(answer.text,'Research answer');assert.equal(answer.filterContext,true);
    if(prompt.startsWith('Compare'))assert.equal(answer.filterUpdate,undefined);else assert.equal(answer.filterUpdate.values.borough,'BK');
  }
  assert.equal(calls.length,2);assert.equal(calls[0].listingContext.values.borough,'QN');assert.equal(calls[1].listingContext.values.borough,'BK');assert.equal(Object.keys(calls[1].listingContext.values).length,FILTER_SCHEMA.required.length);
});
