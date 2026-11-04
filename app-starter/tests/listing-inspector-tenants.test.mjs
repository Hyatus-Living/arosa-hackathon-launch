import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderInspector} from '../public/listing-inspector.js';
import {computeRentStabilizationProfile} from '../../acres-research/market-store.mjs';

const row={id:'screening-retention',address:'Synthetic retention property',bbl:'3009660001',borough:'BK',maxUapZfa:6800,flashcardValuation:{},similarComps:[]};
const options={canStart:()=>true,onUnderwrite(){},onAsk(){},onClose(){}};
function render(t,profile){
  const original={document:globalThis.document,window:globalThis.window};
  const {document,window}=parseHTML('<html><body></body></html>');
  Object.assign(globalThis,{document,window});
  t.after(()=>Object.assign(globalThis,original));
  return renderInspector({...row,...(profile===undefined?{}:{rentStabilization:profile})},options);
}
function tenantSummary(view){
  return [...view.querySelectorAll('dt')].find(node=>node.textContent==='Tenants')?.nextElementSibling.textContent;
}
function guidance(view){
  const links=[...view.querySelectorAll('a.inspector-verification-link')];
  assert.equal(links.length,2);
  assert.deepEqual(links.map(link=>new URL(link.href).hostname),['hcr.ny.gov','www.nyc.gov']);
  assert.ok(links.every(link=>link.target==='_blank'&&link.rel==='noopener noreferrer'));
  assert.ok(links.every(link=>link.getAttribute('aria-label')===`${link.textContent} (opens in a new tab)`));
  return links;
}

test('inspector replaces legacy delivery clearance with unassessed screening and official guidance',t=>{
  const view=render(t,{riskLevel:'clean',badgeLabel:'Clean Delivery · 2 Free-Market Units',summary:'Statutorily exempt; CONH not required.'});
  assert.match(tenantSummary(view),/have not been verified/);
  assert.doesNotMatch(view.textContent,/Statutorily exempt|CONH not required|Clean Delivery|Free-Market/);
  guidance(view);
});

test('inspector includes an unassessed tenant review when the profile is missing',t=>{
  const view=render(t);
  assert.match(tenantSummary(view),/have not been verified/);
  guidance(view);
});

test('inspector preserves current screening data and safely renders verification links',t=>{
  const profile=structuredClone(computeRentStabilizationProfile({unitsRes:2,unitsTotal:2,yearBuilt:1930,bldgClass:'S2'}));
  profile.verificationLinks.push({label:'Unsafe script',url:'javascript:alert(1)'},{label:'Credential URL',url:'https://secret@example.com/'});
  profile.verificationLinks[0]={...profile.verificationLinks[0],label:'HCR <script>guidance</script>'};
  const before=JSON.stringify(profile),view=render(t,profile);
  assert.equal(tenantSummary(view),profile.summary);
  const links=guidance(view);
  assert.equal(links[0].textContent,'HCR <script>guidance</script>');
  assert.equal(view.querySelectorAll('script').length,0);
  assert.equal(JSON.stringify(profile),before);
});
