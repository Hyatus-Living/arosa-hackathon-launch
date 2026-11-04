import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import * as view from '../public/conversation-view.js';
import {listingSearchesView} from '../public/listing-search-view.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const notice={status:'not_applied',reason:'project_changed',skippedFields:['property'],changedInputs:['property'],baseVersion:1,currentVersion:2};
const documentOf=()=>parseHTML('<html><body><article class="message assistant"><div class="assistant-label">Arosa</div><div class="answer"><p>Historical answer remains readable.</p></div></article></body></html>').document;
const flush=()=>new Promise(setImmediate);

test('publication notices explain unapplied and partial updates without replacing the answer',()=>{
  const document=documentOf(),article=document.querySelector('article'),answer=article.querySelector('.answer');
  view.renderProjectUpdateNotice(article,notice);
  assert.equal(article.querySelectorAll('.project-update-notice').length,1);assert.match(article.textContent,/site updates were not applied/);assert.match(article.textContent,/Rerun/);assert.equal(article.querySelector('.answer'),answer);
  view.renderProjectUpdateNotice(article,{...notice,status:'partial'});
  assert.equal(article.querySelectorAll('.project-update-notice').length,1);assert.match(article.textContent,/Some results/);assert.match(article.textContent,/newer work is preserved/);assert.equal(article.querySelector('.answer'),answer);
});

test('unknown or absent publication metadata cannot render raw fields or leave an obsolete warning',()=>{
  const document=documentOf(),article=document.querySelector('article');
  view.renderProjectUpdateNotice(article,{...notice,skippedFields:['<img src=x onerror=alert(1)>']});
  assert.equal(article.querySelector('.project-update-notice').getAttribute('role'),'note');assert.equal(article.querySelector('img'),null);
  view.renderProjectUpdateNotice(article,{...notice,status:'future_status'});assert.equal(article.querySelector('.project-update-notice'),null);
  view.renderProjectUpdateNotice(article,notice);view.renderProjectUpdateNotice(article,null);assert.equal(article.querySelector('.project-update-notice'),null);assert.match(article.textContent,/Historical answer remains readable/);
});

test('the actual persisted assistant-message rendering branch shows the publication notice on reload',()=>{
  const document=documentOf(),el=document.querySelector('article'),anchor=source.indexOf('messages.forEach((m, i) => {');
  const start=source.indexOf('    if (m.role === "user") {',anchor),end=source.indexOf('    if (m.role === "assistant" && !m.error) {',start);
  assert.ok(anchor>=0&&start>anchor&&end>start);
  const c={document,el,m:{role:'assistant',text:'Historical answer remains readable.',projectUpdate:notice},i:0,runRecord:()=>null,answerHtml:()=>'<p>Historical answer remains readable.</p>',decorateAnswerHeader:view.decorateAnswerHeader,renderProjectUpdateNotice:view.renderProjectUpdateNotice};
  c.listingSearchesView=listingSearchesView;c.dealsOnHome=true;
  vm.createContext(c);vm.runInContext('(()=>{'+source.slice(start,end)+'})()',c);
  assert.ok(el.querySelector('.project-update-notice'));assert.match(el.textContent,/site updates were not applied/);assert.match(el.querySelector('.answer').textContent,/Historical answer remains readable/);
});

test('the actual terminal-event controller shows the notice before a failed conversation readback',async()=>{
  const document=documentOf(),root=document.querySelector('article'),start=source.indexOf('function watchRun(id) {'),end=source.indexOf('\nfunction toolName(',start);assert.ok(start>=0&&end>start);
  let onEvent;const errors=[],c={document,Event,Map,Set,generation:1,state:{id:'c1'},activeRun:null,busy:false,activity:[],liveMessages:new Map(),liveUi:[],eventStream:null,connectionInterrupted:false,liveTurn:{key:'r1',root},window:{dispatchEvent(){}},
    streamRun:(_id,callback)=>{onEvent=callback;return {close(){}};},render(){},renderLiveTurn(){},updateLiveTurn(){},renderProjectUpdateNotice:view.renderProjectUpdateNotice,openConversation:()=>Promise.reject(new Error('Readback failed')),afterRunFinished(){},refreshHistory(){},noteRunEnded(){},toast:message=>errors.push(message),scheduleRender(){}};
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);c.watchRun('r1');
  onEvent({event:'run.completed',result:{projectUpdate:notice}});await flush();
  assert.ok(root.querySelector('.project-update-notice'));assert.match(root.textContent,/site updates were not applied/);assert.deepEqual(errors,['Readback failed']);
});
