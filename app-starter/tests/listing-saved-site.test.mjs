import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderInspector} from '../public/listing-inspector.js';
import {listingCard,siteSummary} from '../public/listing-card.js';
import {followUpMessage} from '../public/core-model.js';
import {readFileSync} from 'node:fs';

const row={id:'listing-saved-site',listing_id:'listing-saved-site',address:'Synthetic saved site',bbl:'3009660001',borough:'BK',list_price:2000000,maxUapZfa:6800,flashcardValuation:{},similarComps:[]};
const at=Date.UTC(2026,9,18,15);
const site={id:'site-1',bbl:'3009660001',access:'owner',updated:at+60000,progress:{done:4,stale:false,underwritten:at,landPrice:2000000,profit:1250000,call:'supports_price'}};
function dom(t){
  const original={document:globalThis.document,window:globalThis.window};
  const {document,window}=parseHTML('<html><body></body></html>');
  Object.assign(globalThis,{document,window});
  t.after(()=>Object.assign(globalThis,original));
}
function inspector(t,options){
  dom(t);
  const calls=[];
  const view=renderInspector(row,{canStart:()=>true,onUnderwrite:()=>calls.push('underwrite'),onOpenSite:s=>calls.push(['open',s.id]),onRegenerate:s=>calls.push(['regenerate',s.id]),onAsk(){},onClose(){},...options});
  return {view,calls};
}
const button=(view,label)=>[...view.querySelectorAll('button')].find(b=>b.textContent===label);

test('a listing with a saved site opens that underwriting and names its date and result',t=>{
  const {view,calls}=inspector(t,{site});
  assert.equal(button(view,'Underwrite'),undefined);
  assert.equal(view.querySelector('.inspector-site').textContent,'Underwritten Oct 18, 2026 · Works at the price · $1.25M profit');
  button(view,'Open underwriting').click();
  button(view,'Regenerate').click();
  assert.deepEqual(calls,[['open','site-1'],['regenerate','site-1']]);
});

test('a listing without a saved site offers Underwrite, and a viewer cannot regenerate a shared site',t=>{
  const fresh=inspector(t,{});
  assert.ok(button(fresh.view,'Underwrite'));assert.equal(button(fresh.view,'Regenerate'),undefined);
  const shared=inspector(t,{site:{...site,access:'viewer'}});
  assert.ok(button(shared.view,'Open underwriting'));assert.equal(button(shared.view,'Regenerate'),undefined);
});

test('the summary says how far an unfinished site got and states a loss as a loss',()=>{
  assert.equal(siteSummary({...site,progress:{done:0,stale:false,underwritten:null,profit:null,call:null}}),'Underwriting started Oct 18, 2026');
  assert.equal(siteSummary({...site,progress:{done:3,stale:true,underwritten:at,profit:-400000,call:'no_land_value'}}),'Underwriting 3 of 4 steps, Oct 18, 2026 · Needs a refresh · No land value · $400,000 loss');
});

test('a listing card carries its saved site',t=>{
  dom(t);
  const card=listingCard(row,{onOpen(){},site});
  assert.equal(card.dataset.bbl,'3009660001');
  assert.match(card.querySelector('.listing-card-site').textContent,/^Underwritten Oct 18, 2026/);
  assert.equal(listingCard(row,{onOpen(){}}).querySelector('.listing-card-site'),null);
});

test('Regenerate asks for a fresh pass, unlike finishing the underwriting',()=>{
  assert.match(followUpMessage({action:'regenerate'}),/again from scratch.*Do not reuse earlier underwriting results/s);
  assert.match(followUpMessage({action:'all'}),/Reuse whatever in the project state is current/);
  assert.match(followUpMessage({action:'regenerate',instructions:{envelope:'Keep it under seven storeys.'}}),/- Zoning envelope and scenarios: Keep it under seven storeys\./);
});

test('the web server forwards a new site\'s BBL to research',()=>{
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const route=server.split('\n').find(line=>line.startsWith("app.all('/api/conversations',"));
  assert.match(route,/req\.body\?\.bbl!==undefined\?\{bbl:req\.body\.bbl\}/);
});
