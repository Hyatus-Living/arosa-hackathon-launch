import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {renderSchemes} from '../public/schemes-view.js';
import {sendNote,mailtoHref,openSendOption,withdrawLinks} from '../public/send-option.js';
import {optionPage,messagePage,massingSvg} from '../share-view.mjs';
import {computeDealValuation} from '../../acres-research/market-store.mjs';
import {buildSchemes,optionSnapshot} from '../../acres-research/schemes.mjs';
import {budgetFor} from '../../acres-research/budget-lines.mjs';

function dom(t){
  const original={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
  const {document,window}=parseHTML('<html><body></body></html>');
  window.HTMLElement.prototype.showModal=function(){this.open=true;};
  window.HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  Object.assign(globalThis,{document,window});
  t.after(()=>Object.assign(globalThis,original));
  return document;
}

// An option as the research service freezes it, priced by the real valuation for a vacant Queens lot.
const lot={listPrice:6_000_000,lotArea:10000,lotFront:100,lotDepth:100,lotTypeCode:'5',bldgArea:0,residFar:3.44,affResFar:5.01,zoningDistrict:'R7-1',address:'20 EXAMPLE AVENUE',borough:'QN',zipCode:'11373',frontStreetFeet:80};
const schemes=buildSchemes({candidates:computeDealValuation({...lot,withCandidates:true}).candidates});
const square=[[0,0],[60,0],[60,80],[0,80]];
const drawn={...schemes[0],budget:budgetFor(schemes[0]),massing:{conceptId:'c1'},plan:{planId:'p',revision:2,svg:'11111111-1111-1111-1111-111111111111'},
  render:{status:'succeeded',views:[{view:'street',artifactId:'22222222-2222-2222-2222-222222222222'},{view:'aerial',artifactId:'33333333-3333-3333-3333-333333333333'}]}};
const option=optionSnapshot({scheme:drawn,basis:{askFrom:'listing',ask:6_000_000},concepts:[{id:'c1',levels:[{footprint:square,height:10,count:7}],lot:[[0,0],[100,0],[100,100],[0,100]]}],
  site:{address:'20 Example Avenue <b>',bbl:'4012340001'},sender:{name:'Alice Avery'},at:Date.UTC(2026,9,22,15)});
const read={projectId:'p1',version:3,schemes,basis:{askFrom:'listing',ask:6_000_000},stale:null,updated:1};

test('the note names the site, the option and what the link holds, and opens in the user\'s own mail app',()=>{
  const url='https://build.witharosa.ai/options/t';
  assert.equal(sendNote(option,url),`Here is the option we are considering for 20 Example Avenue <b>: ${schemes[0].summary.charAt(0).toLowerCase()}${schemes[0].summary.slice(1)}. The floor plan, rendering and budget are at ${url}`);
  assert.match(sendNote({...option,plan:null,renders:[]},url),/\. The budget is at https:/);
  assert.match(sendNote({...option,plan:null,renders:[],scheme:{...option.scheme,budget:null}},url),/\. The figures are at https:/);
  const href=mailtoHref(option,'Line one & two');
  assert.ok(href.startsWith('mailto:?subject='));
  assert.equal(new URLSearchParams(href.slice('mailto:?'.length)).get('body'),'Line one & two');
  assert.equal(new URLSearchParams(href.slice('mailto:?'.length)).get('subject'),'As of right option for 20 Example Avenue <b>');
});

test('each option card offers the send to the site owner only, quietly, with its latest send',t=>{
  dom(t);
  const owner=renderSchemes({...read,sends:{canSend:true,sent:{[schemes[1].id]:{at:Date.UTC(2026,9,21,15),by:'Alice Avery'}}}},{canSend:true,projectId:'p1'});
  const cards=[...owner.querySelectorAll('.uw-scheme')];
  assert.deepEqual(cards.map(c=>c.querySelector('.uw-scheme-send-button')?.textContent),Array(3).fill('Send to an architect or GC'));
  assert.ok(cards.every(c=>c.querySelectorAll('button.primary').length===0),'option card actions stay secondary');
  assert.deepEqual(cards.map(c=>c.querySelector('.uw-scheme-sent').textContent),['','Sent Oct 21 by Alice AveryWithdraw','']);
  assert.equal(renderSchemes({...read,sends:{canSend:false,sent:{}}},{canSend:true}).querySelector('.uw-scheme-send'),null,'viewers and participants see no send');
  assert.equal(renderSchemes(read,{canSend:true}).querySelector('.uw-scheme-send'),null);
});

test('the sheet makes the link, fills an editable note and keeps the mail link in step with it',async t=>{
  const document=dom(t);
  window.location={origin:'https://app.witharosa.ai'};
  const calls=[];
  globalThis.fetch=async(url,init)=>{calls.push([url,init.method]);return new Response(JSON.stringify({token:'tok',path:'/api/public/options/tok',createdAt:Date.UTC(2026,9,22,15),option}),{status:201});};
  let sent=null;
  const dialog=openSendOption({projectId:'p1',scheme:schemes[0],onSent:link=>{sent=link;}});
  assert.equal(dialog.querySelector('h2').textContent,'Send to an architect or GC');
  assert.equal(dialog.querySelector('[role="status"]').textContent,'Making the link…');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(calls,[[`/api/projects/p1/schemes/${schemes[0].id}/send`,'POST']]);
  assert.equal(dialog.querySelector('[role="status"]').textContent,'');
  assert.equal(sent.token,'tok');
  const url=dialog.querySelector('#send-option-link').value;
  assert.equal(url,'https://build.witharosa.ai/api/public/options/tok','links always name the main address');
  const note=dialog.querySelector('#send-option-note');
  assert.equal(note.value,sendNote(option,url));
  note.value='Edited note';note.dispatchEvent(new window.Event('input'));
  assert.equal(decodeURIComponent(dialog.querySelector('a.send-option-primary').getAttribute('href')),decodeURIComponent(mailtoHref(option,'Edited note')));
  assert.deepEqual([...dialog.querySelectorAll('button')].map(b=>b.textContent),['','Copy link','Copy note']);
  dialog.close();
  assert.equal(document.querySelector('dialog'),null);
});

test('withdrawing asks once, then stops every link to the option',async t=>{
  dom(t);
  const calls=[];
  globalThis.fetch=async(url,init)=>{calls.push([url,init.method]);return new Response(JSON.stringify({withdrawn:2}),{status:200});};
  let withdrawn=false;
  const box=withdrawLinks({projectId:'p1',scheme:schemes[0],onWithdrawn:()=>{withdrawn=true;}});
  box.querySelector('button').click();
  assert.equal(box.firstChild.textContent,'Stop every link to this option from opening?');
  [...box.querySelectorAll('button')].find(b=>b.textContent==='Keep').click();
  assert.deepEqual([box.textContent,calls.length],['Withdraw',0],'keeping changes nothing');
  box.querySelector('button').click();
  [...box.querySelectorAll('button')].find(b=>b.textContent==='Withdraw links').click();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual([calls,withdrawn],[[[`/api/projects/p1/schemes/${schemes[0].id}/send`,'DELETE']],true]);
});

test('a refused send says why in the sheet',async t=>{
  dom(t);
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Only the site owner can send an option.'}),{status:403});
  const dialog=openSendOption({projectId:'p1',scheme:schemes[0]});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(dialog.querySelector('[role="status"]').textContent,'The link could not be made. Only the site owner can send an option.');
});

test('the shared page shows one option at the sender\'s costs, with its drawings to download and the way to apply',()=>{
  const html=optionPage(option,{files:'/options/tok/files'});
  const {document}=parseHTML(html);
  assert.equal(document.querySelector('title').textContent,'As of right option for 20 Example Avenue <b>');
  assert.equal(document.querySelector('h1').textContent,'20 Example Avenue <b>');
  assert.ok(!html.includes('<b>:')&&!html.includes('Avenue <b>'),'text is escaped');
  assert.match(document.querySelector('.caveat').textContent,/at Alice Avery's costs and is a screening estimate/);
  assert.match(document.querySelector('.from').textContent,/^Sent by Alice Avery on October 22, 2026$/);
  assert.deepEqual([...document.querySelectorAll('a[download]')].map(a=>[a.getAttribute('href'),a.getAttribute('download')]),[
    ['/options/tok/files/22222222-2222-2222-2222-222222222222','rendering-street.png'],
    ['/options/tok/files/33333333-3333-3333-3333-333333333333','rendering-aerial.png'],
    ['/options/tok/files/11111111-1111-1111-1111-111111111111','floor-plan-as_of_right-r2.svg']]);
  assert.deepEqual([...document.querySelectorAll('a.help')].map(a=>a.getAttribute('href')),['https://witharosa.ai/help/three-options','https://witharosa.ai/help/land-value','https://witharosa.ai/help/budget']);
  assert.ok([...document.querySelectorAll('a')].some(a=>a.getAttribute('href')==='https://witharosa.ai/beta'&&a.textContent==='Apply for the beta'));
  assert.equal(document.querySelectorAll('svg.massing path.m-top').length,7);
  const budget=document.querySelector('table.budget');
  assert.equal(budget.querySelector('tfoot td').textContent,`$${Math.round(option.scheme.budget.total).toLocaleString('en-US')}`);
  assert.equal(document.querySelector("main").textContent.match(/\b[Yy]our\b|undefined|\bNaN\b|—/)?.[0],undefined,'the page speaks of the sender, never "your"');
  assert.match(document.querySelector('main').textContent,/split by Arosa's default budget shares/);
  assert.match(document.querySelector('main').textContent,/at the \$6\.00M asking price/);
});

test('a drawn option sends the architect\'s package: drawing set, zoning analysis, model, CAD and schedules',()=>{
  const ids=['package','drawings-pdf','zd1-pdf','ifc','dxf','schedules'];
  const files=Object.fromEntries(ids.map((kind,i)=>[kind,`4444444${i}-4444-4444-4444-444444444444`]));
  const packaged=optionSnapshot({scheme:{...drawn,plan:{...drawn.plan,files}},basis:null,site:{address:'20 Example Avenue',bbl:'4012340001'},sender:{name:'Alice Avery'},at:1});
  const {document}=parseHTML(optionPage(packaged,{files:'/f'}));
  const section=document.querySelector('[aria-labelledby="files-title"]');
  assert.equal(section.querySelector('h2').textContent,'Files for the architect');
  assert.deepEqual([...section.querySelectorAll('li strong')].map(n=>n.textContent),
    ['Everything in one file (ZIP)','Drawing set (PDF)','Zoning analysis (PDF)','Building model (IFC)','CAD drawings (DXF)','Schedules (Excel)']);
  assert.deepEqual([...section.querySelectorAll('a[download]')].map(a=>[a.getAttribute('href'),a.getAttribute('download')]),
    ids.map((kind,i)=>[`/f/${files[kind]}`,`${kind.replace('-pdf','')}-as_of_right-r2.${['zip','pdf','pdf','ifc','dxf','xlsx'][i]}`]));
  assert.match(section.textContent,/Lot lines come from the city's tax map, not a survey\./);
  assert.match(section.textContent,/a DOB filing needs drawings sealed by a registered architect or engineer/);
  assert.match(sendNote(packaged,'https://x'),/The floor plan, drawing set, building model, rendering and budget are at https:\/\/x$/);
  assert.equal(parseHTML(optionPage(option,{files:'/f'})).document.querySelector('[aria-labelledby="files-title"]'),null,'an option sent before the package has no files list');
});

test('an option with nothing drawn still reads, and a missing link says what to do',()=>{
  const bare={...option,plan:null,renders:[],massing:null,scheme:{...option.scheme,budget:null}};
  const {document}=parseHTML(optionPage(bare,{files:'/f'}));
  assert.equal(document.querySelectorAll('img, a[download], table, svg.massing').length,0);
  assert.ok(document.querySelector('dl.figures'));
  assert.match(messagePage('This link is not available','Ask for a new one.'),/<h1>This link is not available<\/h1>/);
  assert.match(massingSvg({lot:null,levels:[{footprint:square,height:10,count:2}]}),/aria-label="Building shape, 2 storeys"/);
});

test('the web app serves option links outside sign-in and proxies the send',()=>{
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const options=server.indexOf("app.get('/api/public/options/:token'"),auth=server.indexOf("app.use('/api',authenticate)");
  assert.ok(options>0&&options<auth,'the option page is served before the /api sign-in check, like the other /api/public paths');
  assert.match(server,/app\.get\('\/api\/public\/options\/:token\/files\/:fileId',/);
  assert.match(server,/app\.delete\('\/api\/projects\/:id\/schemes\/:schemeId\/send',/);
  assert.match(server,/'Referrer-Policy':'no-referrer'/);
  assert.match(server,/app\.post\('\/api\/projects\/:id\/schemes\/:schemeId\/send',\(req,res\)=>proxy\(req,res,`\/projects\/\$\{encodeURIComponent\(req\.params\.id\)\}\/schemes\/\$\{encodeURIComponent\(req\.params\.schemeId\)\}\/send`,\{\}\)\);/);
  assert.match(readFileSync(new URL('../Dockerfile',import.meta.url),'utf8'),/COPY app-starter\/server\.js .*app-starter\/share-view\.mjs \.\//);
  assert.match(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),/<link rel="stylesheet" href="\/send-option\.css" \/>/);
});
