import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderInspector} from '../public/listing-inspector.js';
import {poolFixture} from '../../acres-research/testing/comparable-pool.mjs';

function render(t,similarComps){
  const previous={document:globalThis.document,window:globalThis.window};
  const {document,window}=parseHTML('<html><body></body></html>');Object.assign(globalThis,{document,window});t.after(()=>Object.assign(globalThis,previous));
  const root=renderInspector({id:'subject',address:'1 Price Street',bbl:'3009660001',borough:'BK',maxUapZfa:10000,flashcardValuation:{},similarComps},{canStart:()=>true,onUnderwrite(){},onAsk(){},onClose(){}});
  document.body.append(root);return root;
}

test('the inspector explains actual ranked peers with model points and their own match evidence',t=>{
  const f=poolFixture(t),comps=f.store.getSimilarCompsForDeal(f.subject()),before=JSON.stringify(comps),root=render(t,comps),rows=[...root.querySelectorAll('.inspector-comps li')];
  assert.equal(rows.length,5);assert.match(rows[0].textContent,/2 Price Street/);assert.match(rows[0].textContent,/Match score 99\/100/);assert.match(rows[1].textContent,/Match score 96\/100/);
  for(let i=0;i<comps.length;i++)for(const reason of comps[i].similarityReasons)assert.ok(rows[i].textContent.includes(reason),'Each peer exposes its supplied match evidence');
  const section=root.querySelector('.inspector-comps').parentElement;assert.match(section.textContent,/location, zoning, street context, buildable size and sale status/);assert.doesNotMatch(section.textContent,/% similar/);
  assert.match(rows[0].textContent,/Sold 2026-10-02/);assert.match(rows[1].textContent,/For sale/);assert.match(rows[0].textContent,/\$110\/BSF/);assert.match(rows[1].textContent,/\$120\/BSF/);assert.equal(JSON.stringify(comps),before);
});

test('missing or invalid match scores remain unavailable while explicit zero and numeric strings retain their values',t=>{
  const values=[0,'79',null,'',NaN,'unknown',101,-1],root=render(t,values.map((similarityScore,i)=>({id:String(i),address:'Peer '+i,listingType:'for_sale',price:1000000,similarityScore,similarityReasons:[]}))),rows=[...root.querySelectorAll('.inspector-comps li')];
  assert.match(rows[0].textContent,/Match score 0\/100/);assert.match(rows[1].textContent,/Match score 79\/100/);
  for(const row of rows.slice(2)){assert.match(row.textContent,/Match score unavailable/);assert.doesNotMatch(row.textContent,/\/100|% similar|NaN|undefined/);}
  for(const row of rows)assert.match(row.textContent,/Match details unavailable/);
});

test('match reasons stay associated with their peer and render external text without markup',t=>{
  const reason='<img src=x onerror=alert(1)>',comps=[{address:'First peer',similarityScore:80,similarityReasons:[reason,'Same R7A zoning']},{address:'Second peer',similarityScore:30,similarityReasons:['Same borough (BK)']}],root=render(t,comps),rows=[...root.querySelectorAll('.inspector-comps li')];
  assert.ok(rows[0].textContent.includes(reason));assert.match(rows[0].textContent,/Same R7A zoning/);assert.doesNotMatch(rows[0].textContent,/Same borough/);assert.match(rows[1].textContent,/Same borough \(BK\)/);assert.doesNotMatch(rows[1].textContent,/Same R7A zoning/);assert.equal(root.querySelectorAll('.inspector-comps img, .inspector-comps script').length,0);
});
