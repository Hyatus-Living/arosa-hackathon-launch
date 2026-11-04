import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import * as sourceView from '../public/source-view.js';
import {sourceList} from '../public/conversation-view.js';
import {fmtDate} from '../public/core-view.js';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const core=readFileSync(new URL('../public/core.js',import.meta.url),'utf8');
const appStart=app.indexOf('function showSource('),appEnd=app.indexOf('\nfunction showConcept(',appStart);
const coreStart=core.indexOf('  function openSource('),coreEnd=core.indexOf('\n  root.addEventListener("click"',coreStart);
const elStart=core.indexOf('function el('),elEnd=core.indexOf('\nexport function createCorePage(',elStart);
assert.ok(appStart>=0&&appEnd>appStart&&coreStart>=0&&coreEnd>coreStart&&elStart>=0&&elEnd>elStart);
function setup(source){
  const {document}=parseHTML('<html><body><dialog id="source-dialog"><h2 id="source-title"></h2><div id="source-body"></div><small class="source-status"></small></dialog></body></html>');
  globalThis.document=document;
  const dialog=document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true;};
  const c={...sourceView,document,fmtDate,URL,state:{messages:[{sources:[source]}]},$:selector=>document.querySelector(selector)};
  vm.createContext(c);vm.runInContext(core.slice(elStart,elEnd)+'\n'+core.slice(coreStart,coreEnd)+'\n'+app.slice(appStart,appEnd),c);
  return {document,dialog,c};
}
const source=(url,title='Readable citation')=>({id:1,url,title,kind:'zoning',text:'Readable source content',fetchedAt:'2026-10-17T12:00:00.000Z'});

test('the source list survives malformed URLs and does not reveal credential-bearing URL titles',()=>{
  setup(source('https://example.com'));
  const sources=[source('not a URL'),source('javascript:alert(1)'),source('https://reader:private@example.com/report',' https://reader:private@example.com/report '),source('https://example.com/rules#one','Official rule')];
  let list;assert.doesNotThrow(()=>{list=sourceList(sources,0);});
  assert.equal(list.querySelectorAll('.source-card').length,4);
  assert.doesNotMatch(list.textContent,/reader:private/);
  assert.match(list.textContent,/Source link unavailable/);assert.match(list.textContent,/Official rule/);
});

test('chat citations keep their excerpt available without unsafe original-source links',()=>{
  for(const url of ['not a URL','javascript:alert(1)','data:text/html,test','https://reader:private@example.com/report']){
    const {document,dialog,c}=setup(source(url,url));
    assert.doesNotThrow(()=>c.showSource(0,1));assert.equal(dialog.open,true);
    assert.equal(Boolean(document.querySelector('#source-body a')),false);
    assert.match(document.querySelector('#source-body').textContent,/Readable source content/);
    assert.doesNotMatch(document.body.textContent,/reader:private|Invalid Date/);
  }
});

test('saved-site source inspection applies the same safe-link policy and retains text',()=>{
  for(const url of ['not a URL','javascript:alert(1)','https://reader:private@example.com/report']){
    const {document,dialog,c}=setup(source(url,url));
    assert.doesNotThrow(()=>c.openSource(source(url,url)));assert.equal(dialog.open,true);
    assert.equal(Boolean(document.querySelector('#source-body a')),false);
    assert.match(document.querySelector('#source-body').textContent,/Readable source content/);
    assert.doesNotMatch(document.body.textContent,/reader:private/);
  }
});

test('valid source links retain exact citation anchors and display known metadata aliases without invalid dates',()=>{
  const citation={...source('https://example.com/rules#one','Official rule'),retrievedAt:'2026-10-17T12:00:00.000Z'};delete citation.fetchedAt;
  let {document,c}=setup(citation);c.showSource(0,1);
  let anchor=document.querySelector('#source-body a');assert.equal(anchor.getAttribute('href'),citation.url);assert.equal(anchor.target,'_blank');assert.match(anchor.rel,/noopener/);
  assert.match(document.querySelector('#source-dialog').textContent,/Retrieved/);assert.doesNotMatch(document.body.textContent,/Invalid Date/);
  ({document,c}=setup({...citation,retrievedAt:'invalid'}));c.openSource({...citation,retrievedAt:'invalid'});
  anchor=document.querySelector('#source-body a');assert.equal(anchor.getAttribute('href'),citation.url);assert.doesNotMatch(document.body.textContent,/Invalid Date/);
});

test('the source dialog shows publisher, date, excerpt and one Open source action, and stays compact without an excerpt',()=>{
  const {document,dialog}=setup(source('https://www.example.com/rules'));
  sourceView.fillSourceDialog({id:1,title:'Rule 12',url:'https://www.example.com/rules',publisher:'City Planning',kind:'zoning',text:'Lots may not exceed 4.0 FAR.',retrievedAt:'2026-10-17T12:00:00.000Z'});
  const body=document.querySelector('#source-body');
  assert.equal(document.querySelector('#source-title').textContent,'Rule 12');
  assert.match(body.querySelector('.source-meta').textContent,/City Planning/);
  assert.match(body.querySelector('.source-meta').textContent,/Retrieved Oct 17, 2026/);
  assert.doesNotMatch(body.textContent,/:00/,'the date has no time of day');
  assert.match(body.querySelector('.source-excerpt').textContent,/4\.0 FAR/);
  assert.equal(body.querySelectorAll('a').length,1);
  assert.equal(body.classList.contains('is-compact'),false);
  sourceView.fillSourceDialog({id:2,title:'Lot data',url:'https://www.example.com/lots',kind:'property'});
  assert.equal(body.querySelector('.source-excerpt'),null);
  assert.match(body.querySelector('.source-meta').textContent,/^example\.com$/,'the publisher falls back to the site name');
  assert.equal(body.classList.contains('is-compact'),true);
  assert.notEqual(dialog.open,true,'filling the dialog does not open it');
});
