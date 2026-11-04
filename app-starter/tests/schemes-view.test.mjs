import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {renderSchemes,schemesReportBlock,schemeModelMessage,schemesBasisLine} from '../public/schemes-view.js';
import {renderParcel} from '../public/core-view.js';
import {reportModel,renderReport} from '../public/report-view.js';
import {computeDealValuation} from '../../acres-research/market-store.mjs';
import {buildSchemes} from '../../acres-research/schemes.mjs';
import {budgetFor} from '../../acres-research/budget-lines.mjs';

function dom(t){
  const original={document:globalThis.document,window:globalThis.window};
  const {document,window}=parseHTML('<html><body></body></html>');
  Object.assign(globalThis,{document,window});
  t.after(()=>Object.assign(globalThis,original));
}

// Schemes as the route returns them, priced by the real valuation for a vacant Queens lot.
const lot={listPrice:6_000_000,lotArea:10000,lotFront:100,lotDepth:100,lotTypeCode:'5',bldgArea:0,residFar:3.44,affResFar:5.01,zoningDistrict:'R7-1',address:'20 EXAMPLE AVENUE',borough:'QN',zipCode:'11373',frontStreetFeet:80};
const valuation=computeDealValuation({...lot,withCandidates:true});
const read=(extra={})=>({projectId:'p1',version:3,schemes:buildSchemes({candidates:valuation.candidates,...extra}),basis:{source:'listing',listingId:'l1',ask:6_000_000,askFrom:'listing',dealVerdict:valuation.dealVerdict,infeasible:false},stale:null,updated:1});
const state={id:'p1',version:3,fields:{property:{value:{bbl:'4012340001',address:'20 EXAMPLE AVENUE',borough:'QN',zonedist1:'R7-1',lotarea:10000},provenance:{tool:'acres_set_subject',sources:[]},stale:null,updated:1}}};

test('the section waits for a parcel, shows three placeholder cards while pricing and offers a retry when it fails',t=>{
  dom(t);
  assert.equal(renderSchemes(undefined),null);
  assert.equal(renderSchemes({projectId:'p1',version:0,schemes:null,basis:null}),null);
  const loading=renderSchemes({loading:true});
  assert.equal(loading.querySelectorAll('.uw-scheme').length,3);
  assert.equal(loading.querySelector('[role="status"]').textContent,'Pricing three ways to build it');
  const failed=renderSchemes({error:'down'});
  assert.match(failed.textContent,/The three options did not load\./);
  assert.ok(failed.querySelector('button[data-schemes-retry]'));
});

test('three cards in order, the deal card\'s winner marked, with plain figures and one action each',t=>{
  dom(t);
  const root=renderSchemes(read(),{canSend:true});
  const cards=[...root.querySelectorAll('.uw-scheme')];
  assert.deepEqual(cards.map(c=>c.querySelector('h3').textContent),['As of right','Most floor area','Alternative']);
  const best=cards.filter(c=>c.classList.contains('is-best'));
  assert.equal(best.length,1);
  assert.equal(best[0].querySelector('.uw-scheme-badge').textContent,'Pays the most for the land');
  const winner=read().schemes.find(s=>s.best);
  assert.equal(best[0].dataset.scheme,winner.id);
  assert.equal(winner.returns.landValue,valuation.valueDriver.landValue);
  for(const card of cards){
    const labels=[...card.querySelectorAll('dt')].map(d=>d.textContent);
    assert.equal(labels[0],'A developer can pay');assert.ok(labels.includes('Yield on cost')||labels.includes('Condo margin'));assert.ok(labels.includes('Profit'));
    assert.match(card.textContent,/at the asking price|at the land value above/,'the return states the land basis it is figured on');
    assert.equal(card.querySelectorAll('button.primary').length,0);
    assert.equal(card.querySelector('button[data-scheme-model]'),null);
    assert.deepEqual([...card.querySelectorAll('.uw-scheme-slots li')].map(li=>li.textContent),['BudgetNot drawn yet']);
  }
  assert.doesNotMatch(root.textContent,/\buap\b|\bzfa\b|mih_|as_of_right|max_bonus|undefined|NaN|—/);
  assert.match(root.querySelector('.uw-schemes-basis').textContent,/at the \$6\.00M asking price\.$/);
  assert.ok([...renderSchemes(read(),{canSend:false}).querySelectorAll('button[data-scheme-model]')].every(b=>b.disabled));
});

test('underwriting options keep their financials and do not embed modeling or drawing prerequisites',t=>{
  dom(t);const snapshot=read();
  snapshot.schemes[0].plan={drawn:{units:20,zfaSqft:10000},revision:1,svg:'plan-artifact'};
  snapshot.schemes[0].render={status:'succeeded',street:'render-artifact'};
  for(const report of [false,true]){
    const root=report?schemesReportBlock(snapshot,{projectId:'p1'})[1]:renderSchemes(snapshot,{projectId:'p1',canSend:true,planEnabled:true});
    assert.equal(root.querySelector('[data-part=plan]'),null);
    assert.equal(root.querySelector('[data-part=render]'),null);
    assert.equal(root.querySelector('[data-schemes-draft]'),null);
    assert.equal(root.querySelector('[data-scheme-model]'),null);
    assert.ok(root.querySelector('.uw-scheme-figures'));
    assert.doesNotMatch(root.textContent,/Plan holds|No building shape yet/);
  }
});

test('a priced budget shows in its slot on the page and in the report',t=>{
  dom(t);
  const priced={...read(),schemes:read().schemes.map(s=>({...s,budget:budgetFor(s)}))};
  for(const root of [renderSchemes(priced,{canSend:true}),renderReport(reportModel({project:state,schemes:priced})).querySelector('#report-schemes')]){
    const slot=root.querySelector('.uw-scheme [data-part="budget"]');
    assert.equal(slot.querySelector('strong').textContent,'Budget');
    assert.ok(slot.querySelector('table.scheme-budget-table'));
    assert.doesNotMatch(slot.textContent,/Not drawn yet/);
  }
});



test('the agent is asked to model an option at its own size, and an unpriced lot says what the returns assume',()=>{
  const s=read().schemes[1];
  assert.match(schemeModelMessage(s),new RegExp(`about ${s.program.zfa.toLocaleString('en-US')} SF of zoning floor area over ${s.program.storeys} storeys`));
  assert.match(schemesBasisLine({askFrom:'assumptions',ask:2_500_000}),/your land price of \$2\.50M/);
  assert.match(schemesBasisLine({askFrom:null,ask:null}),/with no price set/);
});

test('the site page shows the options after its four steps, and the report has them as a chapter without page actions',t=>{
  dom(t);
  const page=renderParcel(state,{canSend:true,canEdit:true,schemes:read()});
  const steps=page.querySelector('.uw-steps'),section=page.querySelector('#core-schemes');
  assert.ok(section);assert.equal(steps.nextElementSibling,section);
  assert.equal(renderParcel(state,{canSend:true,canEdit:true}).querySelector('#core-schemes'),null);
  const report=renderReport(reportModel({project:state,schemes:read()}));
  const chapter=report.querySelector('#report-schemes');
  assert.equal(chapter.querySelector('h2').textContent,'Three ways to build it');
  assert.equal(chapter.querySelectorAll('.uw-scheme').length,3);
  assert.equal(chapter.querySelector('button'),null);
  assert.ok([...report.querySelectorAll('.report-toc a')].some(a=>a.textContent==='Three ways to build it'));
  assert.equal(renderReport(reportModel({project:state})).querySelector('#report-schemes'),null);
});

test('the site page and the report read the schemes route',()=>{
  const core=readFileSync(new URL('../public/core.js',import.meta.url),'utf8');
  assert.match(core,/api\.get\(`\/projects\/\$\{encodeURIComponent\(state\.id\)\}\/schemes`\)/);
  const report=readFileSync(new URL('../public/report-view.js',import.meta.url),'utf8');
  assert.match(report,/chatRequest\(`\/projects\/\$\{id\}\/schemes`\)/);
  assert.doesNotMatch(core,/draftSchemePlans/);
});

test('the option that pays the most for the land says why under its badge; the others carry no reason',t=>{
  dom(t);
  const schemes=read().schemes;
  const best=schemes.find(s=>s.best);
  assert.ok(best.reason,'the R7-1 bonus building holds affordable floor area, so the winner explains itself');
  const cards=[...renderSchemes(read(),{canSend:true}).querySelectorAll('.uw-scheme')];
  const reasons=cards.map(c=>c.querySelector('.uw-scheme-reason')?.textContent??null);
  assert.deepEqual(reasons,schemes.map(s=>s.best?best.reason:null));
  assert.equal(cards.find(c=>c.classList.contains('is-best')).querySelector('.uw-scheme-summary').nextElementSibling.className,'uw-scheme-reason');
});

test('where no option pays for the land, none is marked as paying the most',t=>{
  dom(t);
  const unpaid=read();
  unpaid.schemes=unpaid.schemes.map(s=>({...s,returns:{...s.returns,landValue:-Math.abs(s.returns.landValue)-1},reason:null}));
  const cards=[...renderSchemes(unpaid,{canSend:true}).querySelectorAll('.uw-scheme')];
  assert.equal(cards.length,3);
  assert.ok(unpaid.schemes.some(s=>s.best));
  assert.equal(cards.filter(c=>c.classList.contains('is-best')).length,0);
  assert.equal(cards.filter(c=>c.querySelector('.uw-scheme-badge')).length,0);
});
