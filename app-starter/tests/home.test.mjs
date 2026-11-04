import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {projects} from './fixtures/projects.mjs';

const pub=new URL('../public/',import.meta.url);
const read=(name)=>readFileSync(new URL(name,pub),'utf8');
const {document,window}=parseHTML(read('index.html'));
globalThis.document=document;
// The address entry and Your sites work for every account and never reach the deal store: any network call fails the test.
globalThis.fetch=async(url)=>{throw new Error(`home must not fetch ${url}`);};
const {createHome,pendingOutcome}=await import('../public/home.js');

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise((r)=>setImmediate(r));

function mount({canStart=true,listProjects=async()=>projects,underwrite=async()=>false,openPending=()=>{}}={}){
  const addressRoot=document.querySelector('#home-address');
  const sitesRoot=document.querySelector('#home-sites');
  addressRoot.replaceChildren();sitesRoot.replaceChildren();
  let allowed=canStart;
  const home=createHome({addressRoot,sitesRoot,canStart:()=>allowed,listProjects,underwrite,openPending});
  return {home,addressRoot,sitesRoot,setCanStart:(v)=>{allowed=v;}};
}

test('index.html gives home its address and sites mounts on the front page, and home loads its own stylesheet',()=>{
  const welcome=document.querySelector('#welcome');
  assert.ok(welcome.querySelector('#home-address'),'address mount sits on the front page');
  assert.ok(welcome.querySelector('#home-sites'),'sites mount sits on the front page');
  assert.ok(document.querySelector('link[href="/home.css"]'));
});

test('home renders a labelled address form whose submit is disabled while a site cannot start',()=>{
  const {home,addressRoot,setCanStart}=mount({canStart:false});
  home.render();
  const form=addressRoot.querySelector('form');
  assert.ok(form,'address form renders');
  const heading=document.getElementById(form.getAttribute('aria-labelledby'));
  assert.equal(heading?.textContent,'Underwrite an address');
  const input=form.querySelector('input[name="address"]');
  assert.ok(input.getAttribute('aria-label')||form.querySelector(`label[for="${input.id}"]`),'input is labelled');
  const submit=form.querySelector('button[type="submit"]');
  assert.equal(submit.disabled,true,'a viewer, or a start already in flight, cannot underwrite');
  setCanStart(true);home.syncAccess();
  assert.equal(submit.disabled,false,'a participant can underwrite');
  setCanStart(false);home.setPending({label:'88 Oak Avenue, Austin, TX'});
  assert.equal(submit.disabled,true,'a new pending state rechecks whether another site can start');
});

test('submitting an address or a BBL hands it to underwrite with a parcel prompt',()=>{
  const calls=[];
  const {home,addressRoot}=mount({underwrite:async(...args)=>{calls.push(args);return false;}});
  home.render();
  const form=addressRoot.querySelector('form');const input=form.querySelector('input');
  const submit=()=>form.dispatchEvent(new window.Event('submit',{cancelable:true}));
  input.value='   ';submit();
  input.value='88 Oak Avenue, Austin, TX';submit();
  input.value='3012340056';submit();
  assert.equal(calls.length,2,'a blank entry is ignored');
  assert.equal(calls[0][0],'88 Oak Avenue, Austin, TX');assert.match(calls[0][1],/88 Oak Avenue, Austin, TX/);assert.equal(calls[0][2],null);
  assert.equal(calls[1][0],'3012340056');assert.match(calls[1][1],/BBL 3012340056/);assert.equal(calls[1][2],'3012340056');
});

test('a started site clears the address entry; a start that did not happen keeps it for a retry',async()=>{
  const results=[false,true];
  const {home,addressRoot}=mount({underwrite:async()=>results.shift()});
  home.render();
  const form=addressRoot.querySelector('form');const input=form.querySelector('input');
  input.value='5 Elm Road, Boise, ID';
  form.dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
  assert.equal(input.value,'5 Elm Road, Boise, ID','the run did not start, so the address stays');
  form.dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
  assert.equal(input.value,'','the site started, so pressing Underwrite again cannot start it twice');
});

test('a pending conversation is ready with a project, waits on a live run, and fails only after a run ended',()=>{
  const run=(status)=>({id:'r1',status});
  assert.equal(pendingOutcome({projectId:'p_oak',runs:[run('completed')]}),'ready');
  assert.equal(pendingOutcome({projectId:null,runs:[run('queued')]}),'waiting');
  assert.equal(pendingOutcome({projectId:null,runs:[run('completed'),run('running')]}),'waiting');
  assert.equal(pendingOutcome({projectId:null,runs:[run('failed')]}),'failed');
  assert.equal(pendingOutcome({projectId:null,runs:[]}),'none','a conversation whose run never started researched nothing');
});

test('the pending box reports a resolving site, a failure and a ready site, each with a way forward',()=>{
  const opened=[];const seen=[];
  const {home:base,addressRoot}=mount({openPending:(p)=>opened.push(p)});
  const home={...base,setPending:(p)=>{base.setPending(p);seen.push(addressRoot.textContent);}};
  home.render();
  const box=addressRoot.querySelector('[role="status"]');
  assert.equal(box.hidden,true);
  home.setPending({label:'88 Oak Avenue, Austin, TX'});
  assert.equal(box.hidden,false);assert.match(box.textContent,/resolving 88 Oak Avenue, Austin, TX/);
  assert.equal(box.querySelector('button'),null,'nothing to follow until the conversation exists');
  home.setPending({label:'88 Oak Avenue, Austin, TX',conversationId:'c1'});
  assert.equal(box.querySelector('button').textContent,'Follow in chat');
  home.setPending({label:'88 Oak Avenue, Austin, TX',conversationId:'c1',failed:true});
  assert.match(box.textContent,/could not identify a parcel/);assert.ok(box.classList.contains('is-failed'));
  box.querySelector('button').click();
  home.setPending({label:'88 Oak Avenue, Austin, TX',conversationId:'c1',projectId:'p_oak'});
  assert.match(box.textContent,/88 Oak Avenue, Austin, TX is ready/);assert.ok(!box.classList.contains('is-failed'));
  assert.equal(box.querySelector('button').textContent,'Open site');
  box.querySelector('button').click();
  assert.deepEqual(opened.map((p)=>[p.failed||false,p.projectId||null]),[[true,null],[false,'p_oak']]);
  home.setPending(null);assert.equal(box.hidden,true);
  for(const text of seen)assert.doesNotMatch(text,/[—–]|\s-\s/,'no dashes in the copy');
});

test('a pending box mounted on another surface mirrors the same pending site',()=>{
  const {home,addressRoot}=mount();
  home.render();
  const other=document.createElement('section');
  document.body.append(other);
  other.append(home.pendingBox());
  home.setPending({label:'7 Pine Court, Portland, OR',conversationId:'c2'});
  const [onHome,onSites]=[addressRoot,other].map((root)=>root.querySelector('[role="status"]'));
  for(const box of [onHome,onSites]){assert.equal(box.hidden,false);assert.match(box.textContent,/resolving 7 Pine Court, Portland, OR/);}
  other.remove();
  home.setPending({label:'7 Pine Court, Portland, OR',conversationId:'c2',failed:true});
  assert.match(onHome.textContent,/could not identify a parcel/);
  assert.match(onSites.textContent,/resolving/,'a box that left the page is no longer updated');
});

test('Your sites shows a loading state, then the recent sites newest first with a link to every site',async()=>{
  const load=deferred();
  let calls=0;
  const {home,sitesRoot}=mount({listProjects:()=>{calls++;return load.promise;}});
  home.render();
  const section=sitesRoot.querySelector('section');
  assert.equal(calls,0,'the list loads only once home is shown');
  assert.equal(document.getElementById(section.getAttribute('aria-labelledby')).textContent,'Your sites');
  home.showSites();home.showSites();
  assert.equal(calls,1,'showing home twice does not load twice');
  assert.match(section.textContent,/Loading your sites/);
  assert.equal(section.querySelectorAll('.home-site-skeleton').length,4,'site rows hold their places while the list loads');
  assert.equal(section.getAttribute('aria-busy'),'true');
  load.resolve(projects);await flush();
  const rows=[...section.querySelectorAll('[data-project]')];
  assert.deepEqual(rows.map((r)=>r.dataset.project),projects.slice(0,6).map((p)=>p.id),'the six most recent sites');
  assert.match(rows[0].textContent,/1234 Fulton Street, Brooklyn/);
  assert.equal(rows[0].getAttribute('href'),'/sites/p_fulton');
  assert.equal(rows[3].querySelector('strong').textContent,'Untitled site','an untitled site never shows its storage key');
  assert.doesNotMatch(section.textContent,/Loading your sites|addr:/);
  assert.equal(section.getAttribute('aria-busy'),'false');
  assert.ok(section.querySelector('[data-route="/sites"]'),'a link opens every site');
  home.showSites();
  assert.equal(calls,1,'a fresh list is reused');
  home.invalidateSites();home.showSites();
  assert.equal(calls,2,'a run that may have added a site reloads the list');
});

test('on a phone the address field is 16px, so focusing it does not zoom the page',()=>{
  const css=read('home.css');
  const phone=css.slice(css.indexOf('@media (max-width: 850px)'));
  assert.match(phone,/\.home-address-row input \{ font-size: 16px; \}/);
});

test('Your sites shows an empty state for a new account and the error when the list cannot load',async()=>{
  {
    const {home,sitesRoot}=mount({listProjects:async()=>[]});
    home.render();home.showSites();await flush();
    assert.equal(sitesRoot.querySelectorAll('[data-project]').length,0);
    assert.match(sitesRoot.textContent,/Sites you underwrite appear here/);
  }
  {
    const {home,sitesRoot}=mount({listProjects:async()=>{throw new Error('Your sites could not load.');}});
    home.render();home.showSites();await flush();
    assert.match(sitesRoot.textContent,/Your sites could not load\./);
  }
});
