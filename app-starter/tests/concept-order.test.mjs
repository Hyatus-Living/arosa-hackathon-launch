import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {conceptsNewestFirst} from '../public/core-model.js';
import {massingBlock,renderParcel} from '../public/core-view.js';
import {fullState} from './fixtures/project-state.mjs';

const {document}=parseHTML('<html><body></body></html>');
globalThis.document=document;

test('producer ISO dates determine concept order and the default displayed design',()=>{
  const template=fullState.fields.concepts.value[0];
  const concepts=[
    {...template,id:'older',name:'Earlier revision',version:5,createdAt:'2026-10-15T16:30:00.000Z'},
    {...template,id:'newer',name:'New alternative',version:1,createdAt:'2026-10-16T16:30:00.000Z'},
  ];
  assert.deepEqual(conceptsNewestFirst(concepts).map(c=>c.id),['newer','older']);
  const state={...fullState,fields:{...fullState.fields,concepts:{...fullState.fields.concepts,value:concepts}}};
  let mounted;
  const ctx={canSend:false,canEdit:false,conceptViewer:concept=>{mounted=concept.id;return document.createElement('div');}};
  const root=massingBlock(state,ctx);
  assert.equal(mounted,'newer');
  assert.match(root.textContent,/Within modeled envelope/);
  assert.match(root.textContent,/Review the assumptions and applicable rules/);
  assert.equal(root.querySelector('.core-version[aria-pressed="true"]').dataset.concept,'newer');
  massingBlock(state,{...ctx,selectedConceptId:'older'});
  assert.equal(mounted,'older','an explicit user selection survives chronological ordering');
  assert.deepEqual(concepts.map(c=>c.id),['older','newer'],'saved input order is not mutated');
});

test('ISO dates and legacy numeric timestamps share one chronological order, including epoch zero',()=>{
  const concepts=[
    {id:'epoch',createdAt:0,version:9},
    {id:'recent',createdAt:'2026-10-16T16:30:00.000Z',version:1},
    {id:'before-epoch',createdAt:-1,version:10},
  ];
  assert.deepEqual(conceptsNewestFirst(concepts).map(c=>c.id),['recent','epoch','before-epoch']);
});

test('unknown dates follow dated concepts; equal dates retain revision and stable tie ordering',()=>{
  const concepts=[
    {id:'unknown-a',createdAt:'invalid',version:3},
    {id:'v1',createdAt:'1969-12-31T23:59:59.000Z',version:1},
    {id:'unknown-b',createdAt:'',version:3},
    {id:'v2-first',createdAt:'1969-12-31T23:59:59.000Z',version:2},
    {id:'v2-second',createdAt:'1969-12-31T23:59:59.000Z',version:2},
    {id:'unknown-c',createdAt:null,version:1},
  ];
  assert.deepEqual(conceptsNewestFirst(concepts).map(c=>c.id),['v2-first','v2-second','v1','unknown-a','unknown-b','unknown-c']);
});

test('the comparison panel shows the latest written comparison from the producer array, matching reports',()=>{
  const comparisons=[
    {createdAt:'2026-10-15T16:30:00.000Z',variants:[],recommendation:{label:'Earlier program'}},
    {createdAt:'2026-10-16T16:30:00.000Z',variants:[],recommendation:{label:'Latest program'}},
  ];
  const state={...fullState,fields:{...fullState.fields,comparisons:{value:comparisons,provenance:{tool:'acres_compare_programs'}}}};
  const root=renderParcel(state,{canSend:false,canEdit:false});
  assert.match(root.querySelector('#core-decide .core-recommendation').textContent,/Latest program/);
  assert.doesNotMatch(root.querySelector('#core-decide').textContent,/Earlier program/);
});
