import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {parseRoute,routePath,resolveRoute,bodyModes} from '../public/core-route.js';
import {
  headroomFar,assumptionInputs,readAssumptions,saveProjectFields,shouldRefetch,
  collectSources,followUpMessage,parcelFlags,provenanceLabel,staleLabel,zfaBand,conceptsNewestFirst,stepView,snapshot,siteName,
} from '../public/core-model.js';
import {fullState,subjectOnlyState,property} from './fixtures/project-state.mjs';

const {document}=parseHTML('<!doctype html><html><body></body></html>');
globalThis.document=document;
const {renderParcel}=await import('../public/core-view.js');
const text=(node)=>{const out=[];const walk=(n)=>{for(const c of n.childNodes){if(c.nodeType===3)out.push(c.data);else walk(c);}};walk(node);return out.join(' ').replace(/\s+/g,' ');};
const sectionText=(root,id)=>text(root.querySelector(`#core-${id}`));

test('routes: home, the sites list, a site page and shared links',()=>{
  assert.deepEqual(parseRoute('/'),{view:'home'});
  assert.deepEqual(parseRoute('/sites'),{view:'sites'});
  assert.deepEqual(parseRoute('/sites/'),{view:'sites'});
  assert.deepEqual(parseRoute('/sites/p1'),{view:'site',projectId:'p1'});
  assert.deepEqual(parseRoute('/sites/bad%20id'),{view:'sites'});
  assert.deepEqual(parseRoute('/shared/t'),{view:'shared',token:'t'});
  assert.deepEqual(parseRoute('/sites/a/b'),{view:'home'});
  assert.deepEqual(parseRoute('/elsewhere'),{view:'home'});
  assert.equal(routePath(parseRoute('/sites/p1')),'/sites/p1');
  assert.equal(routePath(parseRoute('/sites')),'/sites');
  assert.equal(routePath(parseRoute('/')),'/');
  assert.equal(routePath(parseRoute('/shared/t')),'/shared/t');
});

test('an open listing has its own address on home that round-trips any store id',()=>{
  for(const id of ['broker:ripco:131747:for_sale','3009280034:for_sale','addr:509_pacific_st,_brooklyn,_ny_11217:11217:for_sale']){
    const route=parseRoute(routePath({view:'home',listingId:id}));
    assert.deepEqual(route,{view:'home',listingId:id});
    assert.match(routePath(route),/^\/listings\/[^/]+$/);
  }
  assert.deepEqual(parseRoute('/listings/'),{view:'home'});
  assert.deepEqual(parseRoute('/listings/a/b'),{view:'home'});
  assert.equal(routePath({view:'home'}),'/');
});

test('a site Arosa is still resolving has its own address under the sites list, which lays out as a site',()=>{
  assert.deepEqual(parseRoute('/sites/new'),{view:'starting'});
  assert.deepEqual(parseRoute('/sites/new/'),{view:'starting'});
  assert.equal(routePath({view:'starting'}),'/sites/new');
  assert.deepEqual(parseRoute('/sites/new/plan'),{view:'plan',projectId:'new'},'only the bare address is reserved');
  const modes=bodyModes({view:'starting'});
  assert.equal(modes['core-mode'],true);assert.equal(modes['view-site'],true);assert.equal(modes['view-sites'],false);
  const calls=[];
  assert.deepEqual(resolveRoute({pathname:'/sites/new',search:'',hash:''},{replaceState:(...a)=>calls.push(a)},{namespace:'a'}),{view:'starting'});
  assert.deepEqual(resolveRoute({pathname:'/sites/new',search:'',hash:''},{replaceState:(...a)=>calls.push(a)},null),{view:'home'});
  assert.deepEqual(calls,[]);
});

test('old /core links are aliases of the sites list and the site page',()=>{
  assert.deepEqual(parseRoute('/core'),{view:'sites'});
  assert.deepEqual(parseRoute('/core/'),{view:'sites'});
  assert.deepEqual(parseRoute('/core/p1'),{view:'site',projectId:'p1'});
  assert.deepEqual(parseRoute('/core/bad%20id'),{view:'sites'});
  assert.equal(routePath(parseRoute('/core/p1')),'/sites/p1');
  assert.equal(routePath(parseRoute('/core')),'/sites');
});

test('resolveRoute rewrites an alias to its named route in place, keeping the hash',()=>{
  const calls=[];
  const history={replaceState:(...args)=>calls.push(args)};
  assert.deepEqual(resolveRoute({pathname:'/core/p1',search:'',hash:'#thread=c1'},history,true),{view:'site',projectId:'p1'});
  assert.deepEqual(resolveRoute({pathname:'/core',search:'?q=1',hash:''},history,true),{view:'sites'});
  assert.deepEqual(calls,[[null,'','/sites/p1#thread=c1'],[null,'','/sites?q=1']]);
  calls.length=0;
  for(const pathname of ['/','/sites','/sites/p1','/shared/t'])resolveRoute({pathname,search:'',hash:'#thread=c1'},history,true);
  assert.deepEqual(calls,[],'named routes, shared links and #thread= deep links are left as they are');
});

test('without a session every route lays out as home, and old links are still rewritten',()=>{
  const calls=[];
  const history={replaceState:(...args)=>calls.push(args)};
  for(const pathname of ['/','/sites','/sites/p1','/core','/core/p1','/shared/t'])
    assert.deepEqual(resolveRoute({pathname,search:'',hash:''},history,false),{view:'home'},pathname);
  assert.deepEqual(calls,[[null,'','/sites'],[null,'','/sites/p1']]);
});

test('the server returns the app for home, the chat, sites, a site page, its floor plan and old /core links',async()=>{
  const child=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',HOST:'127.0.0.1'},stdio:['ignore','pipe','inherit']});
  try{
    const port=await new Promise((resolve,reject)=>{
      let out='';
      const timer=setTimeout(()=>reject(new Error('server did not report its port within 10 s')),10000);
      child.stdout.on('data',(chunk)=>{out+=chunk;const m=out.match(/http:\/\/[^\s:]+:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});
      child.once('exit',(code)=>{clearTimeout(timer);reject(new Error(`server exited with code ${code} before listening`));});
    });
    const base=`http://127.0.0.1:${port}`;
    const index=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
    for(const path of ['/','/chat','/sites','/sites/p1','/sites/p1/plan','/core','/core/p1','/core/p1/plan','/shared/t']){
      const res=await fetch(base+path);
      assert.equal(res.status,200,path);
      assert.equal(await res.text(),index,path);
    }
    // A malformed percent-encoding in an app link still loads the app, whose router reads it; an API path keeps its error.
    for(const path of ['/listings/%E0%A4%A','/listings/abc%','/sites/%ZZ','/sites/%E0%A4%A/plan','/shared/%']){
      const res=await fetch(base+path);
      assert.equal(res.status,200,path);
      assert.equal(await res.text(),index,path);
    }
    assert.notEqual((await fetch(base+'/api/market-store/deals/%ZZ')).status,200);
    const attachmentModule=await fetch(base+'/plan-text-attachment.js');
    assert.equal(attachmentModule.status,200);
    assert.match(attachmentModule.headers.get('content-type'),/javascript/);
    assert.match(await attachmentModule.text(),/export async function readPlanText/);
  }finally{child.kill();}
});

test('Modeling has its own routes and preserves old plan links and feature access',()=>{
  const calls=[],history={replaceState:(...args)=>calls.push(args)},at=pathname=>({pathname,search:'?view=3d',hash:''});
  for(const path of ['/modeling/p1','/sites/p1/plan','/core/p1/plan']){
    assert.deepEqual(parseRoute(path),{view:'plan',projectId:'p1'});
    assert.equal(routePath(parseRoute(path)),'/modeling/p1');
    assert.deepEqual(resolveRoute(at(path),history,{architectureEnabled:true}),{view:'plan',projectId:'p1'});
  }
  assert.deepEqual(parseRoute('/modeling'),{view:'models'});
  assert.deepEqual(resolveRoute(at('/modeling'),history,{architectureEnabled:false}),{view:'sites'});
  assert.deepEqual(resolveRoute(at('/modeling/p1'),history,null),{view:'home'});
  assert.ok(calls.some(c=>c[2]==='/modeling/p1?view=3d'));
});
test('FAR headroom is unused zoning floor area over lot area',()=>{
  assert.equal(headroomFar({uap_unused_zfa:12000,lot_area_sqft:5000}),2.4);
  assert.equal(headroomFar({uap_unused_zfa:0,unused_residential_zfa:9000,lot_area_sqft:4000}),2.25);
  assert.equal(headroomFar({uap_unused_zfa:10,lot_area_sqft:0}),null);
});

test('parcel mode renders four underwriting steps from a full state, each answered in a line',()=>{
  let mounted=null;
  const root=renderParcel(fullState,{canSend:true,canEdit:true,conceptViewer:(c)=>{mounted=c.id;return document.createElement('canvas');}});
  const steps=[...root.querySelectorAll('.uw-steps > li')];
  assert.deepEqual(steps.map(s=>s.id),['core-property','core-step-build','core-step-worth','core-step-decide']);
  assert.deepEqual(steps.map(s=>s.className.replace('uw-step is-','')),['done','done','stale','stale']);
  assert.equal(root.querySelector('h1').textContent,'1234 Fulton Street');
  assert.equal(root.querySelectorAll('.core-section').length,0,'no tabbed sections remain');

  const snap=text(root.querySelector('.uw-snapshot'));
  assert.match(snap,/Land price \$4\.50M/);
  assert.match(snap,/Buildable floor area 20,000 sq ft FAR 4/);
  assert.match(snap,/Value when built \$21\.03M UAP rental/);
  assert.match(snap,/Profit \$1\.83M 9\.5% return on cost/);
  const next=root.querySelector('.uw-next');
  assert.match(text(next),/2 of 4 steps done\. 2 steps need a refresh because an earlier result changed\./);
  assert.equal(next.querySelector('[data-follow-action="all"]').textContent,'Update the underwriting');
  assert.equal(root.querySelectorAll('[data-follow-action="all"]').length,1,'one underwriting action on the page');

  const property=text(root.querySelector('#core-property'));
  assert.match(property,/5,000 sq ft lot/);
  assert.match(property,/BBL 3012340056/);
  assert.match(property,/50 ft by 100 ft/);
  assert.match(property,/Historic district: Crown Heights North/);
  assert.match(property,/2015 preliminary flood zone/);
  assert.match(property,/E-designation E-123/);

  const build=root.querySelector('#core-step-build');
  assert.match(text(build.querySelector('.uw-answer')),/^Up to 20,000 sq ft of floor area at FAR 4, about 8 storeys and 85 ft\. The most added floor area comes from Universal Affordability Preference: 21,850 sq ft, as of right\.$/);
  const scenarioHeads=[...build.querySelectorAll('#core-envelope .core-compare thead th')].map(th=>th.textContent).slice(1);
  assert.deepEqual(scenarioHeads,['As of right','Universal Affordability Preference','Zoning map amendment']);
  const env=sectionText(root,'envelope');
  assert.match(env,/Maximum FAR 4/);
  assert.match(env,/Residential with affordable bonus 5\.01 25,050 sq ft 21,850 sq ft/);
  assert.match(env,/85% 2,720 sq ft 17,280 sq ft 22,330 sq ft/);
  assert.match(env,/Not quantified/);
  assert.match(env,/18 to 30 months/);
  assert.match(env,/front: wide, rear: narrow/);
  assert.ok(build.querySelector('details.uw-more #core-envelope'),'the envelope working sits behind the step disclosure');

  assert.equal(root.querySelector('#core-massing'),null);
  assert.equal(mounted,null,'underwriting never mounts a 3D model');

  const worth=root.querySelector('#core-step-worth');
  assert.match(text(worth.querySelector('.uw-answer')),/^31 units\. UAP rental: \$21\.03M value on \$19\.20M total cost, 9\.5% return on cost\.$/);
  const revenue=sectionText(root,'revenue');
  assert.match(revenue,/1 bedroom 50% 16 650 sq ft 10,400 sq ft \$5\.6 \$3,640/);
  assert.doesNotMatch(revenue,/plan checks|Existing building plan/);
  assert.match(revenue,/Total development cost \$19\.20M/);
  assert.match(revenue,/Unlevered return on cost 9\.5%/);
  assert.match(revenue,/Rent -10%/);
  assert.match(revenue,/82 percent efficiency/);
  assert.match(revenue,/Rent, studio \$6\.2 per sq ft per month StreetEasy Oct 14, 2026 Median asking rent/);
  assert.match(sectionText(root,'assumptions'),/Saved by you/);

  const decide=root.querySelector('#core-step-decide');
  assert.match(text(decide.querySelector('.uw-answer')),/^Pursue UAP rental\. \$1\.50M profit after approval risk, -\$0\.70M if rents fall 10%\. \d+ items to check before an offer\.$/);
  const verdict=sectionText(root,'decide');
  assert.match(verdict,/Recommended: UAP rental/);
  assert.match(verdict,/Rents below \$5\.10 per sq ft per month/);
  assert.match(verdict,/Pro forma is out of date: the underwriting assumptions changed\./);
  assert.match(verdict,/Rear street: width unknown, assumed narrow/);
  assert.match(verdict,/20 percent of floor area permanently affordable/);

  const chips=[...root.querySelectorAll('.core-prov')];
  assert.equal(chips.find(c=>c.dataset.field==='assumptions'),undefined,'assumptions are your numbers, not a research chip');
  assert.match(chips.find(c=>c.dataset.field==='envelope').textContent,/Arosa zoning envelope/);
  assert.ok(root.querySelector('[data-stale-field="proFormas"]'));
  assert.ok(root.querySelector('[data-stale-field="comparisons"]'));

  const sources=[...root.querySelectorAll('[data-state-source]')];
  assert.equal(sources.length,3,'sources are deduplicated by URL');
  assert.match(text(sources[1]),/used for zoning envelope, entitlement scenarios/);
  assert.match(text(root.querySelector('#core-sources summary')),/Sources \(3\)/);

  // One primary action on the page; each step keeps its answer and details, and its other actions sit in its More menu.
  assert.equal(root.querySelectorAll('button.primary').length,1,'one primary action');
  assert.equal(root.querySelector('#core-property .uw-menu'),null,'a step with nothing else to do has no menu');
  const menuItems=(id)=>[...root.querySelectorAll(`#core-step-${id} .uw-menu .uw-menu-item`)].map(i=>[i.querySelector('button').textContent,i.querySelector('.uw-menu-what').textContent.length>0]);
  assert.deepEqual(menuItems('build'),[['Redo this step',true],['Explain the zoning',true],['Add a note for Arosa',true]]);
  assert.deepEqual(menuItems('worth').map(([l])=>l),['Redo this step','Add a note for Arosa']);
  assert.deepEqual(menuItems('decide').map(([l])=>l),['Redo this step','Price keeping the building']);
  for(const step of root.querySelectorAll('.uw-steps > li')){
    assert.equal(step.querySelectorAll('.uw-step-foot [data-follow-field]').length,0,'no follow-up buttons outside the More menu');
  }
  assert.equal(root.querySelector('#core-step-worth details.uw-numbers-toggle summary').textContent,'Your numbers · land $4.50M','your numbers stay on step 3');
  const valueNote=root.querySelector('.uw-snapshot .uw-snapshot-note');
  assert.equal(valueNote.title,valueNote.textContent,'a clamped pro forma name keeps its full text');
});

test('a run that finished later steps without step 2 names the skipped step and offers it first',()=>{
  const {envelope:_e,entitlements:_n,concepts:_c,...rest}=fullState.fields;
  const fields=Object.fromEntries(Object.entries(rest).map(([key,f])=>[key,{...f,stale:null}]));
  const root=renderParcel({...fullState,fields},{canSend:true,canEdit:true});
  const steps=[...root.querySelectorAll('.uw-steps > li')];
  assert.deepEqual(steps.map(s=>s.className.replace('uw-step is-','')),['done','todo','done','done']);
  const next=root.querySelector('.uw-next');
  assert.match(text(next),/3 of 4 steps done\. Step 2, What you can build, was skipped/);
  const run=next.querySelector('.core-follow.primary');
  assert.equal(run.textContent,'Run step 2');
  assert.deepEqual([run.dataset.followField,run.dataset.followAction],['envelope','compute']);
  assert.equal(followUpMessage({field:'envelope',action:'compute'}),'Compute the zoning envelope for this site.');
  assert.equal(next.querySelector('[data-follow-action="all"]').textContent,'Finish the underwriting');
});

test('a clicked request shows as starting in its step and the status line until the run reports',()=>{
  const all=renderParcel(fullState,{canSend:true,canEdit:true,pending:{field:'all',action:'all'}});
  const next=all.querySelector('.uw-next');
  assert.ok(next.classList.contains('is-running'));
  assert.match(text(next),/Step 3 of 4 · Starting…/);
  const busy=next.querySelector('[data-follow-action="all"]');
  assert.equal(busy.textContent,'Starting…');
  assert.equal(busy.disabled,true);
  assert.equal(busy.getAttribute('aria-busy'),'true');
  assert.equal(all.querySelector('#core-step-worth').className,'uw-step is-starting','a full run starts at the first unfinished step');
  assert.match(text(all.querySelector('#core-step-worth .core-run')),/Starting…/);
  const step=renderParcel(fullState,{canSend:true,canEdit:true,pending:{field:'envelope',action:'recompute'}});
  assert.equal(step.querySelector('#core-step-build').className,'uw-step is-starting');
  assert.match(text(step.querySelector('#core-step-build .uw-status')),/Starting/);
  assert.equal(step.querySelector('#core-step-build .uw-menu [data-follow-action="recompute"]'),null,'no second request from a starting step');
  const reported=renderParcel(fullState,{canSend:true,canEdit:true,pending:{field:'envelope',action:'recompute'},run:{label:'Computing the zoning envelope',tools:['acres_zoning_envelope']}});
  assert.equal(reported.querySelector('#core-step-build').className,'uw-step is-running','the run replaces the starting state');
  assert.match(text(reported.querySelector('.uw-next')),/Step 2 of 4 · Computing the zoning envelope/);
});

test('a freshly resolved parcel says what each step will produce and invents no figures',()=>{
  const root=renderParcel(subjectOnlyState,{canSend:true,canEdit:true});
  assert.match(root.querySelector('h1').textContent,/1 Example Street/);
  assert.match(text(root.querySelector('#core-property .uw-answer')),/^R7A · 5,000 sq ft lot · 3,200 sq ft, 2 floors, built 1925, class K1$/);
  const statuses=[...root.querySelectorAll('.uw-steps > li')].map(s=>s.className.replace('uw-step is-',''));
  assert.deepEqual(statuses,['done','todo','todo','todo']);
  assert.match(text(root.querySelector('#core-step-build .uw-promise')),/floor area the zoning allows/);
  assert.match(text(root.querySelector('#core-step-worth .uw-promise')),/pro forma on your numbers/);
  assert.equal(root.querySelector('#core-revenue'),null,'no empty working is rendered');
  assert.doesNotMatch(text(root.querySelector('.uw-steps')),/\$\d/);
  assert.match(text(root.querySelector('.uw-snapshot')),/Buildable floor area After step 2/);
  assert.match(sectionText(root,'sources'),/NYC MapPLUTO/);
  const inputs=[...root.querySelectorAll('#core-assumptions-form input')];
  assert.ok(inputs.length>0);
  assert.ok(inputs.every(i=>i.value===''),'no assumption values are prefilled');
  assert.equal(root.querySelectorAll('[data-follow-action="compute"]').length,0,'no per-section compute buttons');
  assert.equal(root.querySelector('.uw-next [data-follow-action="all"]').textContent,'Finish the underwriting');
  const missing=renderParcel({id:'p',version:1,title:'Underwrite 793 BROADWAY, New York, NY 10003, MN (BBL 1005620028) in C6-1',fields:{}},{canSend:true,canEdit:true});
  assert.equal(missing.querySelector('h1').textContent,'793 BROADWAY, New York, NY 10003, MN');
  assert.equal(missing.querySelector('.uw-next [data-follow-action="all"]').textContent,'Underwrite this site');
  assert.match(text(missing.querySelector('#core-property .uw-promise')),/parcel record/);
  const viewer=renderParcel({id:'p',version:1,fields:{}},{canSend:false,canEdit:false});
  assert.equal(viewer.querySelector('[data-follow-action="all"]'),null,'viewers get no underwriting action');
  assert.match(text(viewer.querySelector('.uw-next')),/only its participants can ask Arosa/);
  assert.ok([...viewer.querySelectorAll('#core-assumptions-form input')].every(i=>i.disabled));
});

test('a live run shows progress in its step, queues the rest and offers the chat instead of a second run',()=>{
  const root=renderParcel(subjectOnlyState,{canSend:true,canEdit:true,run:{label:'Computing the zoning envelope',tools:['acres_set_subject','acres_zoning_envelope']}});
  const statuses=[...root.querySelectorAll('.uw-steps > li')].map(s=>s.className.replace('uw-step is-',''));
  assert.deepEqual(statuses,['done','running','queued','queued']);
  assert.match(text(root.querySelector('#core-step-build .core-run')),/Computing the zoning envelope/);
  assert.match(text(root.querySelector('.uw-next')),/Step 2 of 4 · Computing the zoning envelope/);
  assert.ok(root.querySelector('.uw-next [data-open-chat]'));
  assert.equal(root.querySelectorAll('[data-follow-action="all"]').length,0);
  const early=renderParcel({id:'p',version:1,fields:{}},{canSend:true,run:{label:'Starting research',tools:[]}});
  assert.equal(early.querySelector('#core-property').className,'uw-step is-running','a run with no tool yet works on the first unfinished step');
});

test('a run that reads the saved floor plan stays on its steps; one that drafts it moves past them',()=>{
  const reading=renderParcel(subjectOnlyState,{canSend:true,canEdit:true,run:{label:'Reading the floor plan',tools:['acres_set_subject','acres_zoning_envelope','acres_read_plan']}});
  assert.equal(reading.querySelector('#core-step-build').className,'uw-step is-running');
  assert.match(text(reading.querySelector('.uw-next')),/Step 2 of 4/);
  const drafting=renderParcel(subjectOnlyState,{canSend:true,canEdit:true,run:{label:'Saving the plan',tools:['acres_set_subject','acres_zoning_envelope','acres_read_plan','acres_save_plan','acres_read_plan']}});
  assert.equal(drafting.querySelectorAll('.uw-step.is-running').length,0);
});

test('a running step shows what the run found for it, what it is doing, its reasoning headline, sources and time left',()=>{
  const pro={tool:'acres_execute_capability',arguments:{name:'acres_pro_forma',arguments:{}},status:'complete',finding:'Rental: worth $3.20M built, profit $0.40M'};
  const run={label:'Comparing development programs',tools:['acres_set_subject','acres_zoning_envelope','acres_pro_forma','acres_compare_programs'],startedAt:Date.now()-3*60000,typicalMs:7*60000,trail:[
    {tool:'acres_zoning_envelope',arguments:{district:'R6A'},status:'complete',finding:'Up to 42,300 sq ft of zoning floor area in R6A'},
    {tool:'acres_fetch_url',arguments:{url:'https://zr.planning.nyc.gov/article-ii/chapter-3/23-21'},status:'complete',sources:[{title:'ZR 23-21 Floor Area Regulations',url:'https://zr.planning.nyc.gov/x'}]},
    pro,
    {text:'Checking 485-x eligibility',thought:true},
    {tool:'acres_execute_capability',arguments:{name:'acres_compare_programs',arguments:{}},status:'running'},
  ]};
  const root=renderParcel(subjectOnlyState,{canSend:true,canEdit:true,run});
  const statuses=[...root.querySelectorAll('.uw-steps > li')].map(s=>s.className.replace('uw-step is-',''));
  assert.deepEqual(statuses,['done','running','running','running']);
  const build=text(root.querySelector('#core-step-build'));
  assert.match(build,/Computed the R6A zoning envelope Up to 42,300 sq ft of zoning floor area in R6A/);
  assert.match(build,/Saved to the site when the underwriting finishes/,'an earlier step the run worked through waits for the save');
  assert.equal(root.querySelector('#core-step-build .core-run'),null,'only the step being worked on shows the live line');
  assert.match(text(root.querySelector('#core-step-worth')),/Ran a pro forma Rental: worth \$3\.20M built, profit \$0\.40M/);
  const decide=root.querySelector('#core-step-decide');
  assert.match(text(decide.querySelector('.core-run')),/Comparing development programs/);
  assert.match(text(decide.querySelector('.uw-trail-thought')),/Checking 485-x eligibility/);
  assert.match(text(decide.querySelector('.uw-trail-sources')),/1 source read so far, latest: ZR 23-21 Floor Area Regulations/);
  assert.match(text(decide.querySelector('.uw-trail-time')),/About 4 min left, 3 min so far/);
  assert.match(text(root.querySelector('.uw-next')),/Step 4 of 4 · Comparing development programs/,'the status names the step the run is on');
  assert.match(text(decide),/You can leave this page: the underwriting keeps going/);
  const waiting=renderParcel(subjectOnlyState,{canSend:true,canEdit:true,run:{label:'Waiting for a free research slot',tools:[],trail:[],startedAt:null,queued:true}});
  assert.match(text(waiting.querySelector('.uw-next')),/Waiting for a free research slot/);
  assert.match(text(waiting.querySelector('.uw-step.is-running .uw-trail')),/starts on its own when one frees up, and keeps going if you leave this page/);
  assert.doesNotMatch(text(root),/acres_|\u2014/,'no tool names or em dashes reach the page');
});

test('a failed request says so where the run showed, offers the same action again, and a half-done step reads incomplete',()=>{
  const root=renderParcel(subjectOnlyState,{canSend:true,canEdit:true,run:null,runFailure:{message:'Arosa hit a server problem and could not finish this request. Try again in a minute.'}});
  const next=root.querySelector('.uw-next');
  assert.ok(next.classList.contains('is-failed'));
  assert.match(text(next),/The last request did not finish\. Arosa hit a server problem/);
  assert.equal(next.querySelector('[data-follow-action="all"]').textContent,'Try the update again');
  const partial=renderParcel({...subjectOnlyState,fields:{...subjectOnlyState.fields,entitlements:fullState.fields.entitlements}},{canSend:true,canEdit:true,run:null});
  const build=partial.querySelector('#core-step-build');
  assert.equal(build.className,'uw-step is-partial');
  assert.match(text(build.querySelector('.uw-status')),/Incomplete/);
  assert.equal(build.querySelector('[data-follow-action="recompute"]').textContent,'Finish this step');
});

test('step state, snapshot and site name read the project state contract',()=>{
  assert.deepEqual(stepView({fields:{}}).map(s=>s.status),['todo','todo','todo','todo']);
  assert.deepEqual(stepView(fullState).map(s=>[s.id,s.done,s.stale]),[['property',true,false],['build',true,false],['worth',true,true],['decide',true,true]]);
  assert.deepEqual(stepView(fullState,{tools:['acres_pro_forma']}).map(s=>s.status),['done','done','running','queued']);
  // A run that reaches the envelope before saving the parcel is still confirming it.
  assert.deepEqual(stepView({fields:{}},{tools:['acres_zoning_envelope']}).map(s=>s.status),['running','running','queued','queued']);
  assert.deepEqual(snapshot({fields:{}}),{landPrice:null,buildableSqft:null,maxFar:null,value:null,profit:null,returnOnCost:null,proFormaName:null});
  assert.equal(snapshot(fullState).buildableSqft,20000);
  assert.equal(siteName({title:'Underwrite 1 Main St (BBL 1)'}),'1 Main St');
  assert.equal(siteName({}),'Untitled site');
  assert.equal(siteName({fields:{property:{value:{address:'123 WEST 23RD STREET'}}}}),'123 West 23rd Street');
  assert.equal(siteName({fields:{property:{value:{address:'88 Oak Avenue'}}}}),'88 Oak Avenue');
});

test('assumptions edit as percents and save as fractions',()=>{
  const inputs=Object.fromEntries(assumptionInputs(fullState.fields.assumptions.value).map(i=>[i.path,i.input]));
  assert.equal(inputs['financing.loanToCost'],'65');
  assert.equal(inputs['financing.interestRate'],'7.25');
  assert.equal(inputs.landPrice,'4500000');
  assert.deepEqual(readAssumptions(inputs),fullState.fields.assumptions.value);
  assert.deepEqual(readAssumptions({landPrice:'$5,000,000',capRate:'5%','financing.termMonths':'',hardCostPerSqft:' '}),{landPrice:5000000,capRate:0.05});
  assert.throws(()=>readAssumptions({capRate:'abc'}),/Exit cap rate must be a positive number/);
});

test('saving assumptions sends the rendered version and retries once on a stale version',async()=>{
  const calls=[];
  const fields={assumptions:{landPrice:5000000}};
  const latest={...fullState,version:9};
  const api={
    get:async(path)=>{calls.push(['GET',path]);return latest;},
    patch:async(path,body)=>{
      calls.push(['PATCH',path,body.version]);
      if(body.version===7){const e=new Error('stale');e.status=409;throw e;}
      return {...latest,version:10,fields:{...latest.fields,assumptions:{value:body.fields.assumptions,provenance:{tool:'user'},stale:null,updated:1}}};
    },
  };
  const saved=await saveProjectFields(api,'proj_1234',fullState,fields);
  assert.equal(saved.version,10);
  assert.deepEqual(calls,[['PATCH','/projects/proj_1234/state',7],['GET','/projects/proj_1234/state'],['PATCH','/projects/proj_1234/state',9]]);

  const always={get:async()=>latest,patch:async()=>{const e=new Error('stale');e.status=409;throw e;}};
  await assert.rejects(()=>saveProjectFields(always,'proj_1234',fullState,fields),e=>e.status===409&&/changed while you were saving/.test(e.message)&&e.latest===latest);
  const forbidden={get:async()=>latest,patch:async()=>{const e=new Error('nope');e.status=403;throw e;}};
  await assert.rejects(()=>saveProjectFields(forbidden,'proj_1234',fullState,fields),e=>e.status===403);
});

test('live updates refetch only for a newer version of the open project',()=>{
  assert.equal(shouldRefetch({projectId:'proj_1234',version:8,keys:['envelope']},fullState),true);
  assert.equal(shouldRefetch({projectId:'proj_1234',version:7,keys:['envelope']},fullState),false);
  assert.equal(shouldRefetch({projectId:'other',version:99,keys:[]},fullState),false);
});

test('page controls become structured follow-ups with readable messages',()=>{
  assert.equal(followUpMessage({conversation:'c1',field:'proFormas',action:'recompute'}),'Recompute the pro forma for this site from the saved project state, including my latest assumptions.');
  assert.equal(followUpMessage({conversation:null,field:'envelope',action:'compute'}),'Compute the zoning envelope for this site.');
  assert.throws(()=>followUpMessage({field:'envelope',action:'delete'}));
  assert.equal(followUpMessage({conversation:'c1',field:'concepts',action:'revise',note:'  Push the tower back from Pacific St. '}),'Model a revision of the latest massing concept that stays within the zoning envelope, and show what changed. My instructions for this section: Push the tower back from Pacific St.');
});

test('do all is one message that carries every section instruction in page order',()=>{
  const message=followUpMessage({conversation:'c1',field:'all',action:'all',instructions:{revenue:'Condo only.',massing:'Keep it under seven storeys.',envelope:' ',lobby:'ignored'}});
  assert.match(message,/^Underwrite this site end to end in one pass/);
  assert.match(message,/the pro forma, and the program comparison with the acquisition decision at the land price/,'a full run reaches the decision step');
  assert.match(message,/read its public records \(DOB filings, certificates of occupancy, ACRIS deeds with the owner of record, HPD registration and violations\)/,'a full run reads the property history');
  assert.match(message,/Leave site assembly out: it needs the neighboring lots to combine\. End by listing each section as produced, kept as current, or not produced, with the reason\./,'the ask names what it leaves out');
  assert.match(message,/redo only what is missing or stale/);
  const lines=message.split('\n').filter(l=>l.startsWith('- '));
  assert.deepEqual(lines,['- Usable area and revenue: Condo only.']);
  assert.doesNotMatch(followUpMessage({field:'all',action:'all',instructions:{}}),/instructions/);
});

test('notes for Arosa sit behind each step, open when saved, and the viewer cannot edit them',()=>{
  const state={...subjectOnlyState,fields:{...subjectOnlyState.fields,instructions:{value:{envelope:'Keep it under seven storeys.'},provenance:{tool:'user'},updated:Date.now()}}};
  const root=renderParcel(state,{canSend:true,canEdit:true});
  const boxes=Object.fromEntries([...root.querySelectorAll('textarea[data-instructions]')].map(t=>[t.dataset.instructions,t]));
  assert.deepEqual(Object.keys(boxes).sort(),['assumptions','envelope','revenue']);
  assert.equal(boxes.envelope.value,'Keep it under seven storeys.');
  assert.ok(root.querySelector(`label[for="${boxes.envelope.id}"]`),'every box has a label');
  const build=root.querySelector('#core-step-build details.uw-notes');
  assert.equal(build.open,true,'a step with saved notes shows them');
  assert.equal(build.hidden,false);
  assert.match(build.querySelector('summary').textContent,/Your notes for Arosa \(1\)/);
  assert.equal(root.querySelector('#core-step-build [data-notes-open]').textContent,'Edit your notes (1)');
  const worth=root.querySelector('#core-step-worth details.uw-notes');
  assert.equal(worth.hidden,true,'an empty notes panel waits behind the More menu');
  assert.equal(root.querySelector('#core-step-worth [data-notes-open="worth"]').textContent,'Add a note for Arosa');
  const viewer=renderParcel(state,{canSend:false,canEdit:false});
  assert.ok([...viewer.querySelectorAll('textarea[data-instructions]')].every(t=>t.disabled));
});

test('the envelope shows the operative zoning floor area with filed context and a conditional community facility row',()=>{
  const env=fullState.fields.envelope;
  const headlineReconciliation={
    rows:[
      {label:'Zoning maximum ZFA',valueSqft:20000,basis:'pluto_far_x_lot_area',reason:null},
      {label:'Community facility maximum ZFA (conditional)',valueSqft:24000,conditional:true,reason:'Available only to a qualifying community facility program.'},
      {label:'DOB filed proposed ZFA (governing NB/A1)',valueSqft:30000,operative:false,reason:'Context, not the headline: the ledger records no zoning lot span for new building filings.'},
      {label:'Operative figure',valueSqft:20000,basis:'zoning_maximum'},
    ],
    operativeFigure:{valueSqft:20000,basis:'zoning_maximum',reason:'The zoning maximum stands, PLUTO residential FAR 4 x 5,000 sq ft of lot area.'},
  };
  const state={...fullState,fields:{...fullState.fields,envelope:{...env,value:{...env.value,headlineReconciliation}}}};
  const envText=sectionText(renderParcel(state,{canSend:true,canEdit:true}),'envelope');
  assert.match(envText,/Headline zoning floor area Operative figure 20,000 sq ft Zoning maximum ZFA 20,000 sq ft Community facility maximum ZFA \(conditional\) 24,000 sq ft DOB filed proposed ZFA \(governing NB\/A1\), context only 30,000 sq ft/);
  assert.match(envText,/The zoning maximum stands, PLUTO residential FAR 4/);
  assert.doesNotMatch(sectionText(renderParcel(fullState,{canSend:true,canEdit:true}),'envelope'),/Headline zoning floor area/);
});

test('Core draws no 85 to 100 percent range when the existing floor area is the DOB-filed figure',async()=>{
  const {capacity}=await import('../../acres-research/zoning.mjs');
  // 10,000 sq ft at FAR 3 with 20,000 sq ft gross standing and 15,000 sq ft filed: the filing is the existing floor
  // area, so a range of shares of the gross area would mix two bases (its 100% row would leave 15,000 beside 20,000).
  const filed=capacity({lotarea:10000,bldgarea:20000,numfloors:4,residfar:3},{existingZfaSqft:15000,basis:'existing ZFA stated on job 123'});
  assert.equal(filed.existingFloorArea.basis,'dob_filed_zfa');
  assert.deepEqual(zfaBand(filed),[]);
  const estimated=capacity({lotarea:10000,bldgarea:20000,numfloors:4,residfar:3});
  assert.deepEqual(zfaBand(estimated).map(b=>[b.percent,b.zfaSqft]),[[85,17000],[90,18000],[95,19000],[100,20000]]);
});

test('provenance, staleness, flags and helpers read the contract directly',()=>{
  assert.equal(provenanceLabel({tool:'user'}),'Your input');
  assert.equal(provenanceLabel({tool:'acres_pro_forma'}),'Arosa pro forma');
  assert.equal(provenanceLabel({tool:'acres_new_tool'}),'Arosa');
  assert.equal(staleLabel({stale:null}),null);
  assert.match(staleLabel({stale:'market'}),/market inputs changed/);
  assert.deepEqual(parcelFlags({...property,histdist:'',pfirm15_flag:'',edesignum:'',landmark:'Old Merchant House',ownername:'NYC HOUSING AUTHORITY',splitzone:'Y'}),['Landmark: Old Merchant House','Split zoning lot','NYCHA owner']);
  assert.deepEqual(zfaBand(fullState.fields.envelope.value.capacity).map(b=>b.percent),[85,90,95,100]);
  assert.deepEqual(zfaBand(undefined),[]);
  assert.deepEqual(conceptsNewestFirst(fullState.fields.concepts.value).map(c=>c.id),['c-uap','c-base']);
  assert.deepEqual(collectSources(subjectOnlyState).map(s=>s.fields),[['property']]);
});

test('a finished site opens its full report as the one primary action',()=>{
  const state={...fullState,id:'p_done',fields:Object.fromEntries(Object.entries(fullState.fields).map(([k,f])=>[k,{...f,stale:null}]))};
  const root=renderParcel(state,{canSend:true,canEdit:true,run:null});
  assert.deepEqual([...root.querySelectorAll('.uw-steps > li')].map(s=>s.className),['uw-step is-done','uw-step is-done','uw-step is-done','uw-step is-done']);
  const link=root.querySelector('.uw-next a.core-follow.primary');
  assert.equal(link.textContent,'Open the full report');
  assert.equal(link.dataset.route,'/sites/p_done/report');
  assert.equal(root.querySelectorAll('.uw-next .primary').length,1);
});

test('the entitlement baseline says the existing floor area is not recorded instead of printing blanks',()=>{
  const ent=fullState.fields.entitlements;
  const baseline={governingFar:7.52,greatestFar:7.52,maxFloorAreaSqft:75200,existingFloorAreaSqft:null,remainingFloorAreaSqft:null};
  const gap={...fullState,fields:{...fullState.fields,entitlements:{...ent,value:{...ent.value,baseline}}}};
  const page=text(renderParcel(gap,{canSend:true,canEdit:true}));
  assert.match(page,/Baseline: FAR 7\.52, 75,200 sq ft permitted\. The existing floor area is not recorded, so the remaining floor area is not known\./);
  assert.doesNotMatch(page,/permitted, \S+ existing/);
  assert.match(text(renderParcel(fullState,{canSend:true,canEdit:true})),/20,000 sq ft permitted, 3,200 sq ft existing, 16,800 sq ft remaining\./);
});
