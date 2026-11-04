import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {fullState} from './fixtures/project-state.mjs';

const {document}=parseHTML('<!doctype html><html><body></body></html>');
globalThis.document=document;
const {renderParcel}=await import('../public/core-view.js');
const {reportModel,renderReport}=await import('../public/report-view.js');

const stories=[
  {id:'a',publisher:'New York YIMBY',title:'Permits Filed for 2314 Cambreleng Avenue in Belmont, The Bronx',url:'https://newyorkyimby.com/2026/10/a.html',publishedAt:'2026-10-20T12:00:00.000Z',summary:'',onLot:true,addresses:['2314 CAMBRELENG AVENUE']},
  {id:'b',publisher:'The Real Deal',title:'Developer buys the corner',url:'https://therealdeal.com/new-york/2026/10/19/b/',publishedAt:'2026-10-19T12:00:00.000Z',summary:'',onLot:false,addresses:['2320 CAMBRELENG AVENUE']},
];
const items=root=>[...root.querySelectorAll('li')].map(li=>[li.querySelector('a').textContent,li.querySelector('a').getAttribute('href'),li.querySelector('a').getAttribute('target'),li.querySelector('.news-meta').textContent]);
const expected=[
  ['Permits Filed for 2314 Cambreleng Avenue in Belmont, The Bronx','https://newyorkyimby.com/2026/10/a.html','_blank','New York YIMBY · Oct 20, 2026 · This lot'],
  ['Developer buys the corner','https://therealdeal.com/new-york/2026/10/19/b/','_blank','The Real Deal · Oct 19, 2026 · On the block, 2320 Cambreleng Avenue'],
];

test('the site page shows In the news with each story linking out, and nothing while there are none',()=>{
  const section=renderParcel(fullState,{canSend:false,canEdit:false,news:{bbl:'2030890010',stories}}).querySelector('#core-news');
  assert.equal(section.querySelector('h2').textContent,'In the news');
  assert.deepEqual(items(section),expected);
  for(const news of [null,{bbl:'2030890010',stories:null},{bbl:'2030890010',stories:[]}])
    assert.equal(renderParcel(fullState,{canSend:false,canEdit:false,news}).querySelector('#core-news'),null);
});

test('the report lists the same stories in the site chapter',()=>{
  const block=[...renderReport(reportModel({project:{...fullState,id:'p1'},news:stories})).querySelectorAll('.report-block')].find(b=>b.querySelector('h3')?.textContent==='In the news');
  assert.deepEqual(items(block),expected);
  const none=renderReport(reportModel({project:{...fullState,id:'p1'}}));
  assert.ok(![...none.querySelectorAll('.report-block h3')].some(h=>h.textContent==='In the news'));
});

test('the app proxies a lot\'s stories to research',()=>{
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(server,/app\.get\('\/api\/news\/lots\/:bbl',\(req,res\)=>proxy\(req,res,`\/news\/lots\/\$\{encodeURIComponent\(req\.params\.bbl\)\}`\)\);/);
});
