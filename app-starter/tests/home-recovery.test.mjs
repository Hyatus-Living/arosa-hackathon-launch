import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createHome} from '../public/home.js';
import {projects} from './fixtures/projects.mjs';

const {document}=parseHTML('<html><body></body></html>');
globalThis.document=document;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

function mount(listProjects){
  const addressRoot=document.createElement('div');
  const sitesRoot=document.createElement('div');
  const home=createHome({addressRoot,sitesRoot,canStart:()=>true,listProjects,underwrite:async()=>false,openPending:()=>{}});
  home.render();
  return {home,sitesRoot};
}

test('a failed site list offers an immediate retry and deduplicates pending requests',async()=>{
  let calls=0;
  const retry=deferred();
  const {home,sitesRoot}=mount(()=>{calls++;return calls===1?Promise.reject(new Error('Connection interrupted.')):retry.promise;});
  home.showSites();await flush();
  assert.match(sitesRoot.textContent,/Connection interrupted\./);
  assert.equal(sitesRoot.querySelector('.retry-line [role="alert"]').textContent,'Connection interrupted.','the reason reads on one line beside its retry');
  const button=sitesRoot.querySelector('button');
  assert.ok(button,'the failure offers a retry without leaving home');
  assert.equal(button.textContent,'Try again');
  button.click();home.showSites();
  assert.equal(calls,2,'the retry starts exactly one replacement request');
  assert.equal(sitesRoot.querySelector('section').getAttribute('aria-busy'),'true');
  retry.resolve(projects);await flush();
  assert.equal(sitesRoot.querySelector('section').getAttribute('aria-busy'),'false');
  assert.equal(sitesRoot.querySelector('[data-project]').dataset.project,projects[0].id);
  assert.doesNotMatch(sitesRoot.textContent,/Connection interrupted/);
  home.showSites();
  assert.equal(calls,2,'the successful result is cached');
});

test('returning home retries a failed site request immediately rather than caching its error',async()=>{
  let calls=0;
  const {home,sitesRoot}=mount(async()=>{if(++calls===1)throw new Error('Temporary failure');return projects;});
  home.showSites();await flush();
  home.showSites();await flush();
  assert.equal(calls,2);
  assert.equal(sitesRoot.querySelectorAll('[data-project]').length,6);
});
