import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {fullState} from './fixtures/project-state.mjs';

const {document}=parseHTML('<!doctype html><html><body></body></html>');
globalThis.document=document;
const {renderParcel}=await import('../public/core-view.js');
const {snapshot,siteProgress,leadingScheme,decisionDiffers}=await import('../public/core-model.js');
const text=(node)=>{const out=[];const walk=(n)=>{for(const c of n.childNodes){if(c.nodeType===3)out.push(c.data);else walk(c);}};walk(node);return out.join(' ').replace(/\s+/g,' ').trim();};

// Every step done, and a buy decision from an older run that put the land at $2.54M.
const done=Object.fromEntries(Object.entries(fullState.fields).map(([key,f])=>[key,{...f,stale:null}]));
done.comparisons={...done.comparisons,value:[{...done.comparisons.value[0],decision:{call:'supports_price',landPrice:2_145_000,maxLandPrice:2_542_356,verdict:'UAP rental supports the $2,145,000 land price.'}}]};
const finished={...fullState,fields:done};
const option=(id,label,returns)=>({id,label,summary:label,program:{},returns:{completedValue:10_000_000,profit:1_000_000,totalCost:8_000_000,condoMargin:null,yieldOnCost:null,...returns}});
const priced=(lead=3_343_377,basis={ask:1_950_000,askFrom:'listing',dealVerdict:'great_deal'})=>({basis,schemes:[
  option('as_of_right','As of right',{landValue:lead,profit:3_699_711,condoMargin:30}),
  option('max_bonus','Most floor area',{landValue:684_663,profit:1_227_612,condoMargin:8.3}),
  option('alternative','Alternative',{landValue:-1_054_604,profit:-3_355_555,yieldOnCost:4.73}),
]});

test('the deal card, the header and the options give one land value once the options are priced',()=>{
  const root=renderParcel(finished,{canSend:true,canEdit:true,schemes:priced()});
  const card=text(root.querySelector('.uw-snapshot'));
  assert.match(card,/Land price \$1\.95M/,'the price the options are figured at');
  assert.match(card,/Land value \$3\.34M What a developer can pay at your costs · As of right/);
  assert.match(card,/Profit \$3\.70M 30\.0% condo margin at the price/);
  assert.doesNotMatch(card,/Value when built|\$21\.03M|\$1\.83M/,'nothing from the older pro forma');
  assert.match(text(root.querySelector('.uw-verdict')),/could pay up to \$3\.34M\. The asking price is \$1\.95M\./);
  assert.match(text(root.querySelector('.uw-scheme')),/\$3\.34M/,'the leading option names the same figure');
});

test('the deal card names the store tier with the deal-tiers article, and leaves it out when there is none',()=>{
  const root=renderParcel(finished,{canSend:true,canEdit:true,schemes:priced()});
  const tier=root.querySelector('.uw-snapshot-tier');
  assert.equal(text(tier),'Deal tier: Great deal');
  const link=tier.querySelector('a[data-help="deal-tiers"]');
  assert.ok(link,'the tier links its article');
  assert.match(link.href,/\/help\/deal-tiers$/);
  const untiered=renderParcel(finished,{canSend:true,canEdit:true,schemes:priced(3_343_377,{ask:1_950_000,askFrom:'listing',dealVerdict:'unmatched_parcel'})});
  assert.equal(untiered.querySelector('.uw-snapshot-tier'),null);
  assert.equal(untiered.querySelector('a[data-help="deal-tiers"]'),null);
});

test('a run whose land figure differs from the options says so and offers Regenerate first',()=>{
  const root=renderParcel(finished,{canSend:true,canEdit:true,schemes:priced()});
  const next=root.querySelector('.uw-next');
  assert.match(text(next),/Steps 3 and 4 show that run's own comparison, which values the land differently from the options above\. Regenerate to work them again on today's figures\./);
  const primary=next.querySelectorAll('.primary');
  assert.equal(primary.length,1,'one primary action');
  assert.equal(primary[0].dataset.followAction,'regenerate');
  assert.match(text(root.querySelector('#core-step-decide .uw-answer-note')),/^This run's comparison put the land at up to \$2\.54M\. The options below are priced today at your deal settings\.$/);
  // A run that found no land value says so, never "up to $0".
  const nothing={...finished,fields:{...done,comparisons:{...done.comparisons,value:[{...done.comparisons.value[0],decision:{call:'no_land_value',landPrice:2_145_000,maxLandPrice:-400_000,verdict:'No land value.'}}]}}};
  assert.match(text(renderParcel(nothing,{canSend:true,canEdit:true,schemes:priced()}).querySelector('.uw-answer-note')),/^This run's comparison found no land value\. The options below/);
  // Within 10% and the same call, the run still agrees with the options: the report stays first.
  const close=renderParcel(finished,{canSend:true,canEdit:true,schemes:priced(2_700_000)});
  assert.equal(close.querySelector('.uw-answer-note'),null);
  assert.equal(close.querySelector('.uw-next .primary').textContent,'Open the full report');
});

test('with no priced options yet the card reads the run pro forma, as before',()=>{
  for(const schemes of [undefined,{loading:true},{schemes:[{id:'x',returns:null}],basis:null}]){
    const card=text(renderParcel(finished,{canSend:true,canEdit:true,schemes}).querySelector('.uw-snapshot'));
    assert.match(card,/Value when built \$21\.03M/);
    assert.match(card,/Profit \$1\.83M 9\.5% return on cost/);
  }
  assert.equal(decisionDiffers(finished,undefined),null);
});

test('while the options load, the card keeps the options the state last saved',()=>{
  const state={...finished,fields:{...done,schemes:{value:priced(),stale:null,updated:1}}};
  assert.match(text(renderParcel(state,{canSend:true,canEdit:true,schemes:{loading:true}}).querySelector('.uw-snapshot')),/Land value \$3\.34M/);
});

test('the sites list reads the same figures and call as the page',()=>{
  const state={...finished,fields:{...done,schemes:{value:priced(),stale:null,updated:1}}};
  const p=siteProgress(state);
  assert.equal(p.profit,3_699_711);
  assert.equal(p.landPrice,1_950_000);
  assert.equal(p.call,'supports_price');
  assert.equal(siteProgress({...finished,fields:{...done,schemes:{value:priced(1_000_000),stale:null,updated:1}}}).call,'below_price');
  const none=priced(-5);none.schemes[1].returns.landValue=0;
  assert.equal(siteProgress({...finished,fields:{...done,schemes:{value:none,stale:null,updated:1}}}).call,'no_land_value');
  assert.equal(siteProgress(finished).call,'supports_price','the run decision without options');
});

test('the leading option is the one that pays the most for the land; none pays shows no figure',()=>{
  assert.equal(leadingScheme(priced()).id,'as_of_right');
  assert.equal(leadingScheme({schemes:[{returns:null}]}),null);
  assert.equal(leadingScheme(null),null);
  const none=priced(-2_000_000);
  none.schemes[1].returns.landValue=-1;
  const s=snapshot(finished,none);
  assert.equal(s.priced,true);
  assert.ok(s.landValue<=0);
  const card=text(renderParcel(finished,{canSend:true,canEdit:true,schemes:none}).querySelector('.uw-snapshot'));
  assert.match(card,/Land value None No option pays for the land at your costs/);
  assert.equal(snapshot(finished,priced(3_000_000,{ask:null,askFrom:null,dealVerdict:'unpriced_opportunity'})).call,null,'no price, no call');
});

test('the full report gives the site page answer on its cover and keeps the run as a dated record',async()=>{
  const {reportModel,renderReport}=await import('../public/report-view.js');
  const {landAnswer}=await import('../public/core-model.js');
  const root=renderReport(reportModel({project:finished,schemes:priced()}));
  const cover=root.querySelector('#report-cover');
  assert.equal(cover.querySelector('.report-verdict-text').textContent,landAnswer(priced()));
  assert.equal(cover.querySelector('.report-call').textContent,'Supports the price');
  const terms=Object.fromEntries([...cover.querySelectorAll('.report-terms > div')].map(d=>[d.querySelector('dt').textContent,d.querySelector('dd').textContent]));
  assert.equal(terms['Land value, what a developer can pay'],'$3,343,377');
  assert.equal(terms['Land price'],'$1,950,000');
  assert.equal(terms['Profit'],'$3,699,711');
  assert.equal(terms['Deal tier'],'Great deal');
  const note=text(root.querySelector('#report-decision .report-run-note'));
  assert.match(note,/^Recorded by the underwriting run of [A-Z][a-z]+ \d+, \d{4}\. The cover and the three options are priced today at your costs\. That run's comparison put the land at up to \$2,542,356; regenerate the site/);
  assert.ok(root.querySelector('#report-proforma .report-run-note'));
  // Without priced options the cover is the run's, as before, and carries no run note.
  const before=renderReport(reportModel({project:finished}));
  assert.match(before.querySelector('.report-verdict-text').textContent,/supports the \$2,145,000 land price/);
  assert.equal(before.querySelector('.report-run-note'),null);
});

// Nearby development-site sales for the lot: 15 sales, $203 a buildable foot, $2.37M for this lot.
const near=(fields={})=>({perBuildableSqft:203,sales:15,radiusMiles:0.53,months:24,value:2_366_980,asOf:'2026-10-23',...fields});
const withNear=(n,lead)=>{const read=priced(lead);read.basis={...read.basis,nearbyLand:n};return read;};

test('with five or more nearby sales the page leads with what they sold for and shows the residual as what a developer can pay',()=>{
  const root=renderParcel(finished,{canSend:true,canEdit:true,schemes:withNear(near())});
  assert.equal(text(root.querySelector('.uw-verdict')),'You can build 20,000 sq ft. Land value: nearby development-site sales, adjusted to this lot, put it at about $2.37M; a developer earning your target return at your costs could pay up to $3.34M. The asking price is $1.95M.');
  const cells=[...root.querySelectorAll('.uw-snapshot > div')].map(text);
  assert.deepEqual(cells.map(c=>c.split(' $')[0].split(' 20,000')[0]),['Land price','Buildable floor area','Land value','A developer can pay']);
  assert.match(cells[2],/^Land value \$2\.37M 15 nearby sales, adjusted to this lot$/);
  assert.match(cells[3],/^A developer can pay \$3\.34M At your costs · As of right Deal tier: Great deal$/);
  assert.ok(root.querySelector('.uw-snapshot > div:nth-child(3) dt a[data-help="land-value"]'),'the land value links its article');
  assert.ok(root.querySelector('.uw-snapshot > div:nth-child(4) a[data-help="deal-tiers"]'),'the tier stays on the residual');
  assert.match(text(root.querySelector('.uw-schemes')),/15 development-site sales within 0\.5 miles over the last 24 months put this lot at \$203 per buildable SF, about \$2\.37M/);
  assert.equal(root.querySelector('.uw-scheme dt').firstChild.textContent,'A developer can pay');
});

test('when a developer could pay less than nearby sales the page says buyers pay more; fewer than five sales leave the residual as the land value',()=>{
  const above=renderParcel(finished,{canSend:true,canEdit:true,schemes:withNear(near(),1_000_000)});
  assert.match(text(above.querySelector('.uw-verdict')),/could pay up to \$1\.00M, less than buyers nearby are paying\. The asking/);
  const none=withNear(near(),-1);none.schemes.forEach(o=>{o.returns.landValue=-1;});
  assert.match(text(renderParcel(finished,{canSend:true,canEdit:true,schemes:none}).querySelector('.uw-verdict')),/none of the three ways to build it pays for the land at your costs and target return, so buyers nearby are paying more than the returns support\./);
  for(const n of [near({sales:4}),near({value:null}),null]){
    const root=renderParcel(finished,{canSend:true,canEdit:true,schemes:withNear(n)});
    assert.match(text(root.querySelector('.uw-verdict')),/Land value: a developer earning your target return at your costs could pay up to \$3\.34M\./);
    assert.match(text(root.querySelector('.uw-snapshot')),/Land value \$3\.34M What a developer can pay at your costs · As of right Deal tier: Great deal Profit \$3\.70M/);
  }
});

test('the report cover leads with the nearby sales and keeps the tier on what a developer can pay',async()=>{
  const {reportModel,renderReport}=await import('../public/report-view.js');
  const cover=renderReport(reportModel({project:finished,schemes:withNear(near())})).querySelector('#report-cover');
  const terms=[...cover.querySelectorAll('.report-terms > div')].map(d=>[d.querySelector('dt').textContent,d.querySelector('dd').textContent]);
  assert.deepEqual(terms.slice(0,5).map(t=>t[0]),['Land price','Buildable area at 4.00 FAR','Land value, nearby sales','Nearby sales','A developer can pay']);
  assert.deepEqual(terms[2],['Land value, nearby sales','$2,366,980']);
  assert.equal(terms[4][1],'$3,343,377');
  assert.match(cover.querySelector('.report-verdict-text').textContent,/^Land value: nearby development-site sales, adjusted to this lot, put it at about \$2\.37M/);
  assert.ok(cover.querySelector('.report-terms a[data-help="deal-tiers"]'));
});

test('the tier says what set it: on nearby sales it sits with them and gives the ask as a share of what they sold for',async()=>{
  const read=withNear(near());
  read.basis={...read.basis,dealVerdict:'good_deal',priceVerdict:'good_deal',dealTierBasis:{basis:'nearby',askToNearby:0.824,thresholds:{great_deal:0.7,good_deal:0.85,fair_deal:1}},
    gates:[{id:'returns',severity:'review',label:'Returns short of the price tier'}]};
  const root=renderParcel(finished,{canSend:true,canEdit:true,schemes:read});
  assert.match(text(root.querySelector('.uw-snapshot > div:nth-child(3)')),/^Land value \$2\.37M 15 nearby sales, adjusted to this lot Deal tier: Good deal · ask 82% of nearby land value$/);
  assert.equal(root.querySelector('.uw-snapshot > div:nth-child(4) .uw-snapshot-tier'),null,'the residual no longer carries the tier');
  assert.match(text(root.querySelector('.uw-verdict')),/The asking price is \$1\.95M\. Deal tier: Good deal, the ask is 82% of the land value from nearby sales\.$/);
  // No option pays: the tier stops at Good and the page says why.
  const capped=withNear(near(),-1);capped.schemes.forEach(o=>{o.returns.landValue=-1;});
  capped.basis={...read.basis,priceVerdict:'great_deal',dealTierBasis:{...read.basis.dealTierBasis,askToNearby:0.6},gates:[{id:'infeasible',severity:'review',label:"Doesn't pencil at target returns"},...read.basis.gates]};
  assert.match(text(renderParcel(finished,{canSend:true,canEdit:true,schemes:capped}).querySelector('.uw-verdict')),/Deal tier: Good deal, the ask is 60% of the land value from nearby sales\. Held at Good: doesn't pencil at target returns\.$/);
  // Too few nearby sales: the tier is set on what a developer can pay and sits with it.
  const residual=priced();residual.basis={...residual.basis,priceVerdict:'great_deal',dealTierBasis:{basis:'residual',askToNearby:null,thresholds:null},gates:[]};
  const r=renderParcel(finished,{canSend:true,canEdit:true,schemes:residual});
  assert.match(text(r.querySelector('.uw-snapshot')),/Land value \$3\.34M What a developer can pay at your costs · As of right Deal tier: Great deal · on what a developer can pay/);
  assert.match(text(r.querySelector('.uw-verdict')),/Deal tier: Great deal, set on what a developer can pay at your costs\.$/);
  const {reportModel,renderReport}=await import('../public/report-view.js');
  const terms=Object.fromEntries([...renderReport(reportModel({project:finished,schemes:read})).querySelectorAll('#report-cover .report-terms > div')].map(d=>[d.querySelector('dt').textContent,d.querySelector('dd').textContent]));
  assert.equal(terms['Deal tier'],'Good deal');
  assert.equal(terms['How the tier is set'],'The ask is 82% of the land value from nearby sales');
});

test('an unpriced tier names no basis, and one mile reads in the singular',async()=>{
  const read=withNear(near({radiusMiles:1}));
  read.basis={...read.basis,ask:null,askFrom:null,dealVerdict:'unpriced_opportunity',dealTierBasis:{basis:'nearby',askToNearby:null,thresholds:{great_deal:0.7,good_deal:0.85,fair_deal:1}},gates:[]};
  const root=renderParcel(finished,{canSend:true,canEdit:true,schemes:read});
  assert.equal(text(root.querySelector('.uw-snapshot-tier')),'Deal tier: Unpriced');
  assert.match(text(root.querySelector('.uw-schemes')),/15 development-site sales within 1 mile over the last 24 months/);
});
