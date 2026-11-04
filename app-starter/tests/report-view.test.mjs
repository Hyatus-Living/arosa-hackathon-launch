import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
import {parseRoute,routePath,bodyModes} from '../public/core-route.js';
import {fullState} from './fixtures/project-state.mjs';

const {document}=parseHTML('<!doctype html><html><body></body></html>');
globalThis.document=document;
const {reportModel,renderReport,narrative,massingFloors,massingSvg,reportSkeleton}=await import('../public/report-view.js');
// Synthetic project and narrative; no production conversation is distributed.
const winthrop=JSON.parse(readFileSync(new URL('./fixtures/report-winthrop.json',import.meta.url),'utf8'));
const text=(node)=>node.textContent.replace(/\s+/g,' ');
const render=(input)=>{const model=reportModel(input);return {model,root:renderReport(model)};};

test('the report has its own address under the site and lays out as a site page',()=>{
  assert.deepEqual(parseRoute('/sites/p1/report'),{view:'report',projectId:'p1'});
  assert.equal(routePath(parseRoute('/sites/p1/report')),'/sites/p1/report');
  assert.deepEqual(parseRoute('/core/p1/report'),{view:'report',projectId:'p1'});
  assert.deepEqual(parseRoute('/sites/bad%20id/report'),{view:'sites'});
  const on=Object.entries(bodyModes(parseRoute('/sites/p1/report'))).filter(([,v])=>v).map(([k])=>k);
  assert.deepEqual(on,['view-site','view-report']);
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(server,/'\/sites\/:projectId\/report'/);
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/href="\/report\.css"/);
  assert.match(html,/id="report-page"[^>]*hidden/);
});

test('the cover states the completed steps and figures of the recommended synthetic scheme',()=>{
  const {root}=render(winthrop),cover=root.querySelector('.report-cover');
  assert.equal(cover.querySelector('h1').textContent,'1234 Fulton Street');
  assert.match(text(cover),/BBL 3012340056.*R7A, C2-4.*5,000 sq ft lot/);
  assert.match(text(cover),/Underwriting in progress/);
  const terms=Object.fromEntries([...cover.querySelectorAll('.report-terms > div')].map(d=>[d.querySelector('dt').textContent,d.querySelector('dd').textContent]));
  assert.deepEqual(terms,{'Land price':'$4,500,000','Buildable area at 4.00 FAR':'20,000 sq ft','Recommended scheme':'UAP rental','Stabilized value':'$21,033,684','Profit':'$1,700,000','Return on cost':'9.5%'});
  assert.match(text(cover),/needs a refresh/);
});

test('the answer narrative is filed by chapter and the acquisition position closes the decision',()=>{
  const story=narrative(winthrop.conversation.messages[1].text);
  const titles=Object.fromEntries(Object.entries(story.chapters).map(([k,v])=>[k,v.map((s)=>s.title)]));
  assert.deepEqual(titles.build,['Capacity and physical feasibility']);
  assert.deepEqual(titles.risks,['Tenant, occupancy and CONH findings']);
  assert.ok(titles.proforma.includes('Sensitivity table'));
  assert.ok(titles.entitlements.includes('UAP obligation and approval path'));
  assert.equal(story.lead.length,3,'the summary is the lead, without the title or the as-of line');
  assert.match(story.decision[0].text,/^\*\*Acquisition position:\*\*/);
  const {root}=render(winthrop);
  assert.match(text(root.querySelector('#report-decision')),/Acquisition position: pursue conditional diligence/);
});

test('every chapter is present in reading order with structured tables',()=>{
  const {root}=render(winthrop);
  assert.deepEqual([...root.querySelectorAll('section.report-chapter')].map((s)=>s.id),
    ['report-site','report-build','report-program','report-market','report-proforma','report-entitlements','report-risks','report-decision','report-sources']);
  const returns=root.querySelector('#report-proforma table[aria-label="Returns by scheme"]');
  assert.equal(returns.querySelectorAll('thead th').length,3);
  const profit=[...returns.querySelectorAll('tbody tr')].find((tr)=>tr.querySelector('th').textContent==='Profit');
  assert.deepEqual([...profit.querySelectorAll('td')].map((td)=>td.textContent),['$950,000','$1,700,000']);
  const loss=[...returns.querySelectorAll('tbody tr')].find(tr=>tr.querySelector('th').textContent==='Profit with rents 10% lower');
  assert.match(loss.querySelector('td').className,/is-neg/);
  const sensitivity=root.querySelector('table[aria-label="Sensitivity"]');
  assert.deepEqual([...sensitivity.querySelectorAll('tbody th')].map((th)=>th.textContent).slice(0,3),['Rent -10%','Cost +10%']);
  assert.match(text(root.querySelector('#report-proforma')),/Needs a refresh after pro forma model changed/);
  assert.equal(root.querySelectorAll('#report-build .report-massing .m-top').length,0,'a fixture without floor polygons does not invent a massing');
});

test('figures keep their record and sources, and citations link to numbered sources',()=>{
  const {model,root}=render(winthrop);
  assert.equal(model.sources.list.length,3);
  const envelopeLine=root.querySelector('#report-build .report-source-line');
  assert.match(text(envelopeLine),/^Zoning envelope, Oct \d+, 2026/);
  assert.deepEqual([...envelopeLine.querySelectorAll('.report-cite')].map((a)=>a.getAttribute('href')),['#report-source-2']);
  const rentRow=root.querySelector('table[aria-label="Rents"] tbody tr');
  assert.equal(rentRow.querySelector('.report-cite').textContent,'3');
  assert.match(text(rentRow),/Median asking rent, new construction/);
  for (const link of root.querySelectorAll('.report-cite')) assert.ok(root.querySelector(link.getAttribute('href')),`${link.getAttribute('href')} exists`);
  assert.equal(root.querySelector('#report-source-2 a').getAttribute('href').startsWith('https://zr.planning.nyc.gov/'),true);
});

test('the page prints no em dash, no answer HTML and no owner name',()=>{
  const {root}=render(winthrop);
  assert.doesNotMatch(root.textContent,/—/);
  assert.doesNotMatch(root.textContent,/PRIVATE OWNER/);
  assert.equal(root.querySelectorAll('script,iframe,style').length,0);
  const css=readFileSync(new URL('../public/report.css',import.meta.url),'utf8');
  assert.match(css,/@media print/);
  assert.match(css,/body\.view-report \.shell > :not\(#report-page\)/);
});

test('a site still underwriting reports what it has and says the decision has not run',()=>{
  const {root}=render({project:fullState,conversation:null});
  assert.match(text(root.querySelector('.report-verdict')),/Underwriting in progress/);
  assert.ok(root.querySelector('table[aria-label="Unit mix"]'));
  assert.ok(root.querySelector('table[aria-label="Massing concepts"]'));
  assert.match(text(root.querySelector('.report-stale-list')),/Pro forma model needs a refresh after your assumptions changed/);
  const decision=root.querySelector('#report-decision');
  assert.equal(decision.querySelector('.report-decision'),null,'no call is shown before the decision runs');
  assert.match(text(decision),/What would change it ?Rents below \$5\.10 per sq ft per month/);
});

test('massing extrudes each storey from its footprint and marks the height limit',()=>{
  const floors=massingFloors({levels:[{count:3,height:10,footprint:[[0,0],[40,0],[40,60],[0,60]],label:'Typical'}]});
  assert.deepEqual(floors.map((f)=>f.z),[0,10,20]);
  const svg=massingSvg(floors,[[0,0],[40,0],[40,100],[0,100]],{limitFeet:45});
  assert.equal(svg.querySelectorAll('.m-top').length,3);
  assert.equal(svg.querySelectorAll('.m-front').length+svg.querySelectorAll('.m-side').length,6,'two walls of each storey face the viewer');
  assert.deepEqual([...svg.querySelectorAll('text')].map((t)=>t.textContent),['45 ft limit','30 ft']);
  assert.equal(reportSkeleton().getAttribute('aria-hidden'),'true');
});
