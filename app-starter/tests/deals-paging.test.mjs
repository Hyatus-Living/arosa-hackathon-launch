import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const {document,window}=parseHTML(html);
globalThis.document=document;
globalThis.window=window;
globalThis.Event=window.Event;
const {mountDealsScreen}=await import('../public/deals.js');
let focused=null;
window.HTMLElement.prototype.focus=function(){focused=this;};

const savedSettings={hardCostPerGrossSqft:375,softCostPctOfHard:0.22,carryAndFinancingPct:0.1,zfaToGrossFactor:1.15};
const deal=(id,borough='Brooklyn')=>({listing_id:id,address:`${id} Test St`,borough,zip_code:'11201',lot_area_sqft:2500,uap_unused_zfa:5000,deal_verdict:'fair_deal'});
const response=(deals,total)=>({deals,total,userSettings:{isCustom:false,dealSettings:{...savedSettings},baselineSettings:{...savedSettings}}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const cards=()=>[...document.querySelectorAll('[data-deal-card]')].map(c=>c.dataset.dealCard);
const selectBorough=(value)=>{
  const borough=document.querySelector('#deals-borough-filter');
  for(const o of borough.querySelectorAll('option'))o.toggleAttribute('selected',o.value===value);
  borough.dispatchEvent(new window.Event('change'));
};

// Every request waits until the test answers it, so responses can arrive in any order.
function deferredFetch(t){
  const requests=[];
  globalThis.fetch=(url)=>new Promise(resolve=>requests.push({
    params:new URL(url,'http://x').searchParams,
    answer:(body)=>resolve({ok:true,headers:{get:()=>'application/json'},json:async()=>body}),
  }));
  t.after(()=>{delete globalThis.fetch;});
  return requests;
}

async function mount(requests,firstPage){
  const container=document.createElement('div');
  document.body.replaceChildren(container);
  const mounted=mountDealsScreen(container,{onUnderwrite:()=>{}});
  await tick();
  requests.at(-1).answer(firstPage);
  await mounted;
}

test('deal list and inspector give planned units beside the most the zoning allows',async(t)=>{
  const requests=deferredFetch(t);
  const sample={...deal('units'),uap_max_buildable_zfa:6800,maxBuildableUnits:10,plannedUnits:8,list_price:1_000_000};
  await mount(requests,response([sample],1));
  const labels=document.body.textContent.match(/8 planned units \(most allowed 10\)/g);
  assert.ok(labels?.length>=2,'both list card and inspector name both counts');
  assert.doesNotMatch(document.body.textContent,/10 max units|\(10 units\)/);
});

test('the selected deal inspector links to the original listing',async(t)=>{
  const requests=deferredFetch(t);
  const sample={...deal('source'),url:'https://example.com/listing/source'};
  await mount(requests,response([sample],1));
  assert.equal(document.querySelector('.deal-listing-link')?.getAttribute('href'),sample.url);
});

test('map pins are keyboard-operable: roving tabindex, arrows move, Enter inspects',async(t)=>{
  const requests=deferredFetch(t);
  const first={...deal('first'),latitude:40.6782,longitude:-73.9442};
  const second={...deal('second'),latitude:40.7282,longitude:-73.9949};
  await mount(requests,response([first,second],2));
  const key=(pin,value)=>{const event=new window.Event('keydown');event.key=value;pin.dispatchEvent(event);};
  let pins=[...document.querySelectorAll('.deal-map-pin')];
  assert.equal(pins.length,2);
  assert.deepEqual(pins.map(p=>p.getAttribute('tabindex')),['0','-1'],'one tab stop for the whole map');
  assert.equal(pins[0].getAttribute('role'),'button');
  assert.match(pins[1].getAttribute('aria-label'),/Inspect second Test St/);
  key(pins[0],'ArrowDown');
  assert.deepEqual(pins.map(p=>p.getAttribute('tabindex')),['-1','0'],'arrow keys move the tab stop');
  key(pins[1],'Enter');
  await tick();
  pins=[...document.querySelectorAll('.deal-map-pin')];
  assert.equal(document.querySelector('.deal-map-pin.is-selected')?.getAttribute('data-deal-id'),'second','Enter inspects the focused pin like a click');
  assert.deepEqual(pins.map(p=>p.getAttribute('tabindex')),['-1','0'],'the inspected pin keeps the tab stop');
});

test('Show more values the next page with the cost inputs the list on screen was valued with',async(t)=>{
  const requests=deferredFetch(t);
  await mount(requests,response([deal('a'),deal('b')],4));

  document.querySelector('#deals-hard-cost').value='900';
  document.querySelector('#deals-apply-costs').click();
  await tick();
  assert.equal(requests[1].params.get('hardCostPerGrossSqft'),'900');
  requests[1].answer(response([deal('a'),deal('b')],4));
  await tick();
  assert.equal(document.querySelector('#deals-hard-cost').value,'900','the input keeps the cost the cards were valued with');

  document.querySelector('#deals-more-btn').click();
  await tick();
  assert.equal(requests[2].params.get('offset'),'2');
  assert.equal(requests[2].params.get('hardCostPerGrossSqft'),'900','the second page uses the recalculated cost, not the saved one');
  assert.equal(requests[2].params.get('softCostPctOfHard'),'0.22');
  requests[2].answer(response([deal('c'),deal('d')],4));
  await tick();
  assert.deepEqual(cards(),['a','b','c','d'],'pages append in the order the store ranked them');
  assert.equal(focused?.dataset?.dealCard,'c','focus moves to the first newly loaded listing');
  assert.equal(document.querySelector('#deals-more-btn'),null);
});

for(const order of [['page','filter'],['filter','page']]){
  test(`a filter change wins over a slower Show more when the ${order[0]} answers first`,async(t)=>{
    const requests=deferredFetch(t);
    await mount(requests,response([deal('bk-1'),deal('bk-2')],4));
    document.querySelector('#deals-more-btn').click();
    await tick();
    const page=requests.at(-1);
    assert.equal(page.params.get('offset'),'2');
    selectBorough('Staten Island');
    await tick();
    const filter=requests.at(-1);
    assert.equal(filter.params.get('borough'),'Staten Island');
    assert.equal(filter.params.get('offset'),'0');

    const answers={page:()=>page.answer(response([deal('bk-3'),deal('bk-4')],4)),filter:()=>filter.answer(response([deal('si-1','Staten Island')],1))};
    for(const step of order){answers[step]();await tick();}
    assert.deepEqual(cards(),['si-1'],'only the Staten Island list shows');
    assert.equal(document.querySelector('.deals-more'),null,'the count comes from the Staten Island query');
  });
}

test('Show more does nothing while a new query is loading',async(t)=>{
  const requests=deferredFetch(t);
  await mount(requests,response([deal('bk-1'),deal('bk-2')],4));
  selectBorough('Queens');
  await tick();
  const sent=requests.length;
  document.querySelector('#deals-more-btn').click();
  await tick();
  assert.equal(requests.length,sent,'the old list is not extended with the new filters');
  requests.at(-1).answer(response([deal('qn-1','Queens')],1));
  await tick();
  assert.deepEqual(cards(),['qn-1']);
});

test('an empty result shows no map hint',async(t)=>{
  const requests=deferredFetch(t);
  await mount(requests,response([],0));
  assert.match(document.querySelector('.deals-map-header').textContent,/0 parcels/);
  assert.equal(document.querySelector('.deals-map-hint'),null);
});
