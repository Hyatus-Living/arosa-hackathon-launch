import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {fullState} from './fixtures/project-state.mjs';
import {computeDealValuation} from '../../acres-research/market-store.mjs';
import {buildSchemes} from '../../acres-research/schemes.mjs';
import {budgetFor} from '../../acres-research/budget-lines.mjs';

const {document}=parseHTML('<!doctype html><html><body></body></html>');
globalThis.document=document;
const {HELP_BASE,HELP_TOPICS,helpLink}=await import('../public/help-links.js');
const {renderParcel}=await import('../public/core-view.js');
const {renderSchemes}=await import('../public/schemes-view.js');
const {reportModel,renderReport}=await import('../public/report-view.js');

const SLUGS=['buildable-area','three-options','budget','land-value','deal-tiers','sources-and-freshness'];
const winthrop=JSON.parse(readFileSync(new URL('./fixtures/report-winthrop.json',import.meta.url),'utf8'));
const lot={listPrice:6_000_000,lotArea:10000,lotFront:100,lotDepth:100,lotTypeCode:'5',bldgArea:0,residFar:3.44,affResFar:5.01,zoningDistrict:'R7-1',address:'20 EXAMPLE AVENUE',borough:'QN',zipCode:'11373',frontStreetFeet:80};
const valuation=computeDealValuation({...lot,withCandidates:true});
const schemes={projectId:'p1',version:3,schemes:buildSchemes({candidates:valuation.candidates}),basis:{source:'listing',listingId:'l1',ask:6_000_000,askFrom:'listing',dealVerdict:valuation.dealVerdict,infeasible:false},stale:null,updated:1};
const priced={...schemes,schemes:schemes.schemes.map(s=>({...s,budget:budgetFor(s)}))};
const helpOf=(root)=>[...root.querySelectorAll('a.help-link')];
const slugOf=(a)=>a.getAttribute('href').replace(`${HELP_BASE}/`,'');

function assertLinks(links){
  assert.ok(links.length>0);
  for(const a of links){
    assert.ok(SLUGS.includes(slugOf(a)),`${a.getAttribute('href')} is one of the six articles`);
    assert.equal(a.getAttribute('href'),`https://witharosa.ai/help/${slugOf(a)}`);
    assert.equal(a.getAttribute('target'),'_blank');
    assert.equal(a.getAttribute('rel'),'noopener noreferrer');
    assert.match(a.getAttribute('aria-label'),/^How (is|are|sources)/);
    assert.match(a.getAttribute('aria-label'),/new tab$/);
  }
}

test('the help base is one constant and the topics are exactly the six articles',()=>{
  assert.equal(HELP_BASE,'https://witharosa.ai/help');
  assert.deepEqual(Object.keys(HELP_TOPICS).sort(),[...SLUGS].sort());
  assert.throws(()=>helpLink('pricing'),/Unknown help article/);
  const text=helpLink('budget'),icon=helpLink('budget',{icon:true});
  assert.equal(text.textContent,'How is this calculated?');
  assert.equal(icon.textContent,'');
  assert.ok(icon.querySelector('svg[aria-hidden="true"]'));
  assert.equal(icon.getAttribute('aria-label'),'How is the development budget calculated? Opens in a new tab');
  for(const f of ['core-view.js','schemes-view.js','report-view.js','help-links.js']) assert.doesNotMatch(readFileSync(new URL(`../public/${f}`,import.meta.url),'utf8').replace(/^.*HELP_BASE = .*$/m,''),/witharosa\.ai\/help/,`${f} takes the address from HELP_BASE`);
});

test('the site page links the buildable area, the three options, land value, budget and sources',()=>{
  const page=renderParcel(fullState,{canSend:true,canEdit:true,schemes:priced});
  const links=helpOf(page);
  assertLinks(links);
  const slugs=new Set(links.map(slugOf));
  for(const slug of ['buildable-area','three-options','land-value','budget','sources-and-freshness']) assert.ok(slugs.has(slug),slug);
  const snapshot=page.querySelector('.uw-snapshot');
  assert.equal(snapshot.querySelector('dt a.help-link').closest('div').querySelector('dt').textContent,'Buildable floor area');
  assert.equal(page.querySelector('.uw-schemes-head h2').textContent,'Three ways to build it');
  assert.equal(page.querySelector('#core-schemes-title').textContent,'Three ways to build it');
  assert.equal(page.querySelectorAll('.uw-scheme dt a[data-help="land-value"]').length,3);
  assert.ok(page.querySelector('#core-sources a[data-help="sources-and-freshness"]'));
});

test('links add no words to the figures: labels and values read as before',()=>{
  const labels=(root)=>[...root.querySelectorAll('dt, .uw-scheme-slots li > strong')].map(n=>n.textContent);
  const withLinks=renderSchemes(priced,{canSend:true});
  const before=labels(withLinks);
  helpOf(withLinks).forEach(a=>a.remove());
  assert.deepEqual(labels(withLinks),before);
  assert.equal(before.filter(l=>l==='A developer can pay').length,3);
  assert.equal(before.filter(l=>l==='Budget').length,3);
  assert.equal(helpOf(renderSchemes(schemes,{canSend:true})).filter(a=>slugOf(a)==='budget').length,0,'no budget drawn, so no budget link');
  assert.equal(helpOf(renderSchemes(priced,{canSend:true})).filter(a=>slugOf(a)==='budget').length,3);
});

test('a loading or failed section carries no link',()=>{
  assert.equal(helpOf(renderSchemes({loading:true})).length,0);
  assert.equal(helpOf(renderSchemes({error:'down'})).length,0);
});

test('the full report links buildable area, land value, three options, budget and sources',()=>{
  const root=renderReport(reportModel({...winthrop,schemes:priced}));
  const links=helpOf(root);
  assertLinks(links);
  const slugs=new Set(links.map(slugOf));
  for(const slug of ['buildable-area','three-options','land-value','budget','sources-and-freshness']) assert.ok(slugs.has(slug),slug);
  const terms=Object.fromEntries([...root.querySelectorAll('.report-terms > div')].map(d=>[d.querySelector('dt').textContent,d.querySelector('dd').textContent]));
  const lead=priced.schemes.filter(s=>s.returns).reduce((a,s)=>(!a||s.returns.landValue>a.returns.landValue?s:a),null);
  assert.equal(terms['Land value, what a developer can pay'],'$'+Math.round(lead.returns.landValue).toLocaleString('en-US'),'the cover gives the leading option, as the site page does');
  assert.match(root.querySelector('#report-decision').textContent,/pursue conditional diligence/,'the run decision keeps its own figure');
  assert.equal(terms['Deal tier'],'Fair deal');
  assert.ok(root.querySelector('.report-terms a[data-help="deal-tiers"]'),'the tier links its article');
  assert.ok(root.querySelector('#report-sources a[data-help="sources-and-freshness"]'));
  assert.ok(root.querySelector('#report-schemes .report-source-line a[data-help="three-options"]'));
});

test('the report prints without the links',()=>{
  const css=readFileSync(new URL('../public/report.css',import.meta.url),'utf8');
  const print=css.slice(css.indexOf('@media print'));
  assert.match(print,/body\.view-report \.help-link/);
  assert.match(print,/\.report-source-line:has\(> \.help-link:only-child\)/);
});

test('the links are quiet: no box, visible hover and focus, a target of at least 24px',()=>{
  const css=readFileSync(new URL('../public/core.css',import.meta.url),'utf8');
  assert.match(css,/\.help-link:hover/);
  assert.match(css,/\.help-link:focus-visible/);
  assert.match(css,/\.help-link-icon::after \{ content: ""; position: absolute; inset: -5px; \}/);
  assert.doesNotMatch(css.slice(css.indexOf('.help-link {')).split('}')[0],/border:|background|box-shadow/);
});
