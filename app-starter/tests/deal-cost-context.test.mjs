import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {mountDealsScreen} from '../public/deals.js';
import {normalizeDealSettings} from '../../acres-research/market-store.mjs';

const defaults={hardCostPerGrossSqft:375,softCostPctOfHard:.22,carryAndFinancingPct:.1,zfaToGrossFactor:1.15};
const ids={hardCostPerGrossSqft:'deals-hard-cost',softCostPctOfHard:'deals-soft-cost',carryAndFinancingPct:'deals-carry-cost',zfaToGrossFactor:'deals-gross-factor'};
const profile=(values={},isCustom=false)=>({isCustom,dealSettings:{...defaults,...values},baselineSettings:{...defaults}});
const deal=id=>({listing_id:id,address:`${id} Test Street`,borough:'Brooklyn',zip_code:'11201',lot_area_sqft:2500,uap_unused_zfa:5000,deal_verdict:'fair_deal'});
const payload=(settings=profile(),rows=[deal('a'),deal('b')],total=4)=>({userSettings:settings,deals:rows,total});
const flush=()=>new Promise(setImmediate);

async function setup(t,settings=profile()){
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  globalThis.document=document;globalThis.window=window;
  const c={document,window,root:document.querySelector('main'),requests:[],underwrites:[]};
  let active=null;Object.defineProperty(document,'activeElement',{get:()=>active,configurable:true});
  window.HTMLElement.prototype.focus=function(){active=this;c.focused=this.id;};
  globalThis.fetch=(url,options={})=>new Promise(resolve=>c.requests.push({url,method:options.method||'GET',params:new URL(url,'http://fixture').searchParams,body:options.body?JSON.parse(options.body):null,answer:(body,status=200)=>resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}))}));
  t.after(()=>{delete globalThis.fetch;});
  c.mount=async(settings)=>{
    const pending=mountDealsScreen(c.root,{onUnderwrite:(_deal,prompt)=>c.underwrites.push(prompt)});
    c.requests.at(-1).answer(payload(settings));await pending;
  };
  c.get=id=>c.root.querySelector(`#${id}`);
  c.type=(key,value)=>{const input=c.get(ids[key]);input.value=String(value);input.dispatchEvent(new window.Event('input'));};
  c.click=id=>c.get(id).click();
  c.select=(id,value)=>{const select=c.get(id);for(const option of select.querySelectorAll('option'))option.toggleAttribute('selected',option.value===value);select.dispatchEvent(new window.Event('change'));};
  c.answer=async(request,settings=profile(),rows,total)=>{request.answer(payload(settings,rows,total));await flush();};
  c.badge=()=>c.root.querySelector('.deals-profile-badge').textContent;
  c.prompt=()=>{c.click('deals-underwrite-btn');return c.underwrites.at(-1);};
  await c.mount(settings);return c;
}

test('Recalculate sends explicit zero assumptions at the same precision as the owning model',async(t)=>{
  const c=await setup(t),entered={hardCostPerGrossSqft:477.6,softCostPctOfHard:0,carryAndFinancingPct:0,zfaToGrossFactor:1.23456};
  for(const [key,value] of Object.entries(entered))c.type(key,value);
  c.click('deals-apply-costs');await flush();const request=c.requests.at(-1),normalized=normalizeDealSettings(entered);
  for(const key of Object.keys(ids))assert.equal(Number(request.params.get(key)),normalized[key]);
  assert.equal(request.params.get('softCostPctOfHard'),'0');assert.equal(request.params.get('carryAndFinancingPct'),'0');
  await c.answer(request);assert.match(c.badge(),/unsaved assumptions/i);assert.equal(c.get(ids.hardCostPerGrossSqft).value,'478');
  assert.match(c.prompt(),/\$478\/GSF rental hard cost, \$375\/GSF condo hard cost, 0% soft cost, 0% carry/);
});

test('applied assumptions survive filters, sorting and subsequent pages',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',900);c.type('softCostPctOfHard',0);c.click('deals-apply-costs');await flush();await c.answer(c.requests.at(-1));
  c.select('deals-borough-filter','Queens');await flush();let request=c.requests.at(-1);assert.equal(request.params.get('hardCostPerGrossSqft'),'900');assert.equal(request.params.get('softCostPctOfHard'),'0');await c.answer(request);
  c.select('deals-sort-by','unused_far');await flush();request=c.requests.at(-1);assert.equal(request.params.get('hardCostPerGrossSqft'),'900');await c.answer(request);
  c.click('deals-more-btn');await flush();request=c.requests.at(-1);assert.equal(request.params.get('hardCostPerGrossSqft'),'900');assert.equal(request.params.get('softCostPctOfHard'),'0');
  await c.answer(request,profile(),[deal('c')],3);assert.match(c.prompt(),/\$900\/GSF/);
});

test('unapplied typing survives selection and filtering without changing result assumptions',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',1200);
  c.root.querySelector('[data-deal-card="b"]').click();assert.equal(c.get(ids.hardCostPerGrossSqft).value,'1200');assert.match(c.badge(),/unapplied/i);
  c.select('deals-borough-filter','Queens');await flush();const request=c.requests.at(-1);assert.equal(request.params.get('hardCostPerGrossSqft'),null);await c.answer(request);
  assert.equal(c.get(ids.hardCostPerGrossSqft).value,'1200');assert.match(c.prompt(),/\$375\/GSF/);
  c.click('deals-apply-costs');await flush();assert.equal(c.requests.at(-1).params.get('hardCostPerGrossSqft'),'1200');await c.answer(c.requests.at(-1));
});

test('typing during recalculation remains unapplied while the returned results use the submitted costs',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',900);c.click('deals-apply-costs');await flush();const request=c.requests.at(-1);
  c.get(ids.hardCostPerGrossSqft).focus();c.type('hardCostPerGrossSqft',1200);await c.answer(request);
  assert.equal(c.get(ids.hardCostPerGrossSqft).value,'1200');assert.match(c.badge(),/unapplied/i);assert.match(c.prompt(),/\$900\/GSF/);
  assert.equal(c.document.activeElement===c.get(ids.hardCostPerGrossSqft),true,'the active cost field retains focus after the results update');
});

test('saving defaults acknowledges persistence separately from refreshing the result assumptions',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',600);c.click('deals-save-profile');await flush();const put=c.requests.at(-1);
  assert.equal(put.method,'PUT');assert.equal(put.body.dealSettings.hardCostPerGrossSqft,600);
  put.answer(profile({hardCostPerGrossSqft:600},true));await flush();assert.match(c.prompt(),/\$375\/GSF/,'old cards keep their old assumption context until replacement results arrive');
  const request=c.requests.at(-1);assert.equal(request.method,'GET');await c.answer(request,profile({hardCostPerGrossSqft:600},true));
  assert.equal(c.get(ids.hardCostPerGrossSqft).value,'600');assert.match(c.badge(),/custom saved profile/i);assert.match(c.prompt(),/\$600\/GSF/);
});

test('Reset Baseline intentionally clears applied overrides after its acknowledged write',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',900);c.click('deals-apply-costs');await flush();await c.answer(c.requests.at(-1));
  c.click('deals-reset-profile');await flush();const put=c.requests.at(-1);assert.deepEqual(put.body,{reset:true});put.answer(profile());await flush();
  const request=c.requests.at(-1);assert.equal(request.params.get('hardCostPerGrossSqft'),null);await c.answer(request);
  assert.equal(c.get(ids.hardCostPerGrossSqft).value,'375');assert.match(c.badge(),/NYC Baseline/);
});

test('blank or out-of-range inputs do not recalculate or save coerced assumptions',async(t)=>{
  const c=await setup(t);
  for(const [key,value] of [['softCostPctOfHard',''],['hardCostPerGrossSqft',0],['zfaToGrossFactor',.9],['carryAndFinancingPct',2]]){
    for(const [name,value] of Object.entries(defaults))c.type(name,value);c.type(key,value);
    c.click('deals-apply-costs');c.click('deals-save-profile');await flush();
    assert.equal(c.requests.length,1);assert.equal(c.focused,ids[key]);assert.ok(c.get('deals-notice').textContent.length>0);
  }
});

test('a failed recalculation does not relabel old result figures with new costs',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',900);c.click('deals-apply-costs');await flush();
  c.requests.at(-1).answer({error:'Result refresh unavailable'},503);await flush();
  assert.match(c.prompt(),/\$375\/GSF/);assert.equal(c.get(ids.hardCostPerGrossSqft).value,'900');
  assert.match(c.get('deals-notice').textContent,/previous assumptions/i);
});

test('later typing survives saving defaults and the result refresh without becoming applied',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',900);c.click('deals-save-profile');await flush();const put=c.requests.at(-1);
  c.type('hardCostPerGrossSqft',1200);put.answer(profile({hardCostPerGrossSqft:900},true));await flush();await c.answer(c.requests.at(-1),profile({hardCostPerGrossSqft:900},true));
  assert.equal(c.get(ids.hardCostPerGrossSqft).value,'1200');assert.match(c.badge(),/unapplied/i);assert.match(c.prompt(),/\$900\/GSF/);
});

test('an old profile response cannot restart or replace a remounted explorer context',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',800);c.click('deals-save-profile');await flush();const put=c.requests.at(-1);
  await c.mount(profile({hardCostPerGrossSqft:425},true));const count=c.requests.length;
  put.answer(profile({hardCostPerGrossSqft:800},true));await flush();
  assert.equal(c.requests.length,count);assert.equal(c.get(ids.hardCostPerGrossSqft).value,'425');assert.match(c.prompt(),/\$425\/GSF/);
});

test('profile writes cannot race each other or append pages during the mutation',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',800);c.click('deals-save-profile');await flush();const put=c.requests.at(-1);
  c.click('deals-reset-profile');c.click('deals-more-btn');await flush();assert.equal(c.requests.length,2);
  put.answer(profile({hardCostPerGrossSqft:800},true));await flush();await c.answer(c.requests.at(-1),profile({hardCostPerGrossSqft:800},true));
  assert.equal(c.get('deals-reset-profile').disabled,false);
});

test('an earlier page completion cannot re-enable pagination during a profile save',async(t)=>{
  const c=await setup(t);c.click('deals-more-btn');await flush();const page=c.requests.at(-1);
  c.type('hardCostPerGrossSqft',800);c.click('deals-save-profile');await flush();const put=c.requests.at(-1);
  await c.answer(page,profile(),[deal('c')],4);
  const disabled=c.get('deals-more-btn').disabled,cardCount=c.root.querySelectorAll('[data-deal-card]').length;
  put.answer(profile({hardCostPerGrossSqft:800},true));await flush();await c.answer(c.requests.at(-1),profile({hardCostPerGrossSqft:800},true));
  assert.equal(disabled,true);
  assert.equal(cardCount,2,'the obsolete page is not appended during the write');
  assert.equal(c.get('deals-more-btn').disabled,false);
});

test('a saved-default refresh failure is reported accurately and old pages retain their valuation snapshot',async(t)=>{
  const c=await setup(t);c.type('hardCostPerGrossSqft',900);c.click('deals-save-profile');await flush();c.requests.at(-1).answer(profile({hardCostPerGrossSqft:900},true));await flush();
  c.requests.at(-1).answer({error:'Refresh failed'},503);await flush();
  assert.match(c.get('deals-notice').textContent,/defaults saved/i);assert.match(c.prompt(),/\$375\/GSF/);
  c.click('deals-more-btn');await flush();const request=c.requests.at(-1);assert.equal(request.params.get('hardCostPerGrossSqft'),'375');
  await c.answer(request,profile({hardCostPerGrossSqft:900},true),[deal('c')],3);assert.match(c.prompt(),/\$375\/GSF/);
});
