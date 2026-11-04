import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
import {parseRoute,routePath,bodyModes,resolveRoute} from '../public/core-route.js';
import {WHATS_NEW} from '../public/whats-new-data.js';

const {document}=parseHTML('<!doctype html><html><body></body></html>');
globalThis.document=document;
const {renderWhatsNew,createWhatsNewPage}=await import('../public/whats-new.js');

test("what's new has its own address, view class, nav entry and server route",()=>{
  assert.deepEqual(parseRoute('/whats-new'),{view:'whats-new'});
  assert.equal(routePath(parseRoute('/whats-new')),'/whats-new');
  const on=Object.entries(bodyModes(parseRoute('/whats-new'))).filter(([,v])=>v).map(([k])=>k);
  assert.deepEqual(on,['view-whats-new']);
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(server,/'\/whats-new'/);
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/href="\/whats-new\.css"/);
  assert.match(html,/id="whats-new-page"[^>]*hidden/);
  assert.match(html,/href="\/whats-new" data-route="\/whats-new"/);
});

test("without a session the what's new address lays out as home, never the page",()=>{
  const history={replaceState(){}};
  assert.deepEqual(resolveRoute({pathname:'/whats-new',search:'',hash:''},history,false),{view:'home'});
  assert.deepEqual(resolveRoute({pathname:'/whats-new',search:'',hash:''},history,{namespace:'a'}),{view:'whats-new'});
});

test('entries are merged pull requests #277-#290 only, newest first',()=>{
  assert.equal(WHATS_NEW.length,14);
  assert.deepEqual(WHATS_NEW.map((e)=>e.pr),[290,289,288,287,286,285,284,283,282,281,280,279,278,277]);
  for(const entry of WHATS_NEW){
    assert.match(entry.date,/^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.title.length>0);
  }
  const dates=WHATS_NEW.map((e)=>e.date);
  assert.deepEqual(dates,[...dates].sort().reverse());
});

test('the page lists every entry with its date, newest first, as plain text',()=>{
  const root=renderWhatsNew();
  assert.equal(root.querySelector('h1').textContent,"What's new");
  const items=[...root.querySelectorAll('.whats-new-entry')];
  assert.equal(items.length,WHATS_NEW.length);
  assert.equal(items[0].querySelector('.whats-new-entry-title').textContent,WHATS_NEW[0].title);
  assert.equal(items.at(-1).querySelector('.whats-new-entry-title').textContent,WHATS_NEW.at(-1).title);
  assert.equal(items[0].querySelector('time').dateTime,WHATS_NEW[0].date);
  const evil=renderWhatsNew([{date:'2026-10-20',pr:1,title:'<img src=x onerror=alert(1)>'}]);
  assert.equal(evil.querySelector('img'),null);
  assert.equal(evil.querySelector('.whats-new-entry-title').textContent,'<img src=x onerror=alert(1)>');
});

test('show renders into the page section and leave hides it',()=>{
  const section=document.createElement('section');
  section.hidden=true;
  const page=createWhatsNewPage({root:section});
  page.show();
  assert.equal(section.hidden,false);
  assert.equal(section.querySelectorAll('.whats-new-entry').length,WHATS_NEW.length);
  page.leave();
  assert.equal(section.hidden,true);
});
