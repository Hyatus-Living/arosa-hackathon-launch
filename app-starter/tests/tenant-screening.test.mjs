import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {tenantFixture} from '../../acres-research/testing/tenant-screening.mjs';
import {mountDealsScreen,buildDealUnderwritePrompt} from '../public/deals.js';

async function screen(t,f,{legacy=false,absent=false}={}){
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  const original={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};Object.assign(globalThis,{document,window});
  const requests=[];
  globalThis.fetch=async url=>{
    const params=new URL(url,'http://fixture').searchParams;requests.push(params);
    const page=f.page({excludeHighStabilizedRisk:params.get('excludeHighStabilizedRisk')==='true'});
    if(legacy)for(const deal of page.deals)deal.rentStabilization={riskLevel:'clean',badgeLabel:'Clean Delivery · 2 Free-Market Units',summary:'Statutorily exempt; CONH not required.'};
    if(absent)for(const deal of page.deals)delete deal.rentStabilization;
    return new Response(JSON.stringify({...page,userSettings:{dealSettings:{},baselineSettings:{},isCustom:false}}),{headers:{'content-type':'application/json'}});
  };
  const restore=()=>Object.assign(globalThis,original);t.after(restore);
  await mountDealsScreen(document.querySelector('main'),{onUnderwrite:()=>{}});
  return {document,window,requests,restore};
}

test('tenant screening in the inspector and card never turns a low flag into clean delivery',async t=>{
  const f=tenantFixture(t);const id=f.add('small',{unitsRes:2,yearBuilt:1920,bldgClass:'A1'});
  const {document}=await screen(t,f),text=document.querySelector('main').textContent;
  assert.match(text,/Tenant review: limited flags/);assert.match(text,/Rent regulation: unverified/);assert.match(text,/CONH: not assessed/);
  assert.doesNotMatch(text,/Clean Delivery|Free-Market|statutorily exempt|CONH Required/i);
  const links=[...document.querySelectorAll('.tenant-verification-link')];assert.equal(links.length,2);
  assert.deepEqual(links.map(link=>new URL(link.href).hostname),['hcr.ny.gov','www.nyc.gov']);
  assert.ok(links.every(link=>link.target==='_blank'&&/noopener/.test(link.rel)));
  const prompt=buildDealUnderwritePrompt(f.get(id));assert.match(prompt,/Verify rent regulation, occupancy\/vacant delivery and HPD CONH applicability/);
  assert.doesNotMatch(prompt,/Clean Delivery|Free-Market|statutorily exempt/i);
});

test('legacy clearance text and absent profiles become unassessed in cards, details and underwriting',async t=>{
  const f=tenantFixture(t),id=f.add('unknown');
  const {document,restore}=await screen(t,f,{legacy:true});
  assert.match(document.querySelector('main').textContent,/Tenant review: unassessed/);
  assert.doesNotMatch(document.querySelector('main').textContent,/Clean Delivery|Free-Market|statutorily exempt|CONH not required/i);
  const legacy={...f.get(id),rentStabilization:{riskLevel:'clean',badgeLabel:'Clean Delivery · Exempt'}};
  assert.doesNotMatch(buildDealUnderwritePrompt(legacy),/Clean Delivery|Exempt/);
  assert.match(buildDealUnderwritePrompt({...legacy,rentStabilization:undefined}),/Tenant review: unassessed/);
  restore();const absent=await screen(t,f,{absent:true});
  assert.match(absent.document.querySelector('main').textContent,/Tenant review: unassessed/);
});

test('the filter describes high screening flags and explicitly keeps unassessed rows visible',async t=>{
  const f=tenantFixture(t);f.add('unknown');f.add('older',{unitsRes:8,yearBuilt:1920});
  const {document,window,requests}=await screen(t,f);
  assert.match(document.querySelector('main').textContent,/Hide high tenant review flags \(unknowns remain\)/);
  assert.doesNotMatch(document.querySelector('main').textContent,/CONH Risk|Clean Delivery/);
  const checkbox=document.querySelector('input[type=checkbox]');assert.ok(checkbox);
  checkbox.checked=true;checkbox.dispatchEvent(new window.Event('change'));
  await new Promise(setImmediate);await new Promise(setImmediate);
  assert.equal(requests.at(-1).get('excludeHighStabilizedRisk'),'true');
  assert.match(document.querySelector('main').textContent,/Tenant review: missing data/);
  assert.doesNotMatch(document.querySelector('main').textContent,/Tenant review: high flags/);
});
