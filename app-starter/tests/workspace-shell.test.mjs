import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {filterPopoverPosition,bindFilterPopover} from '../public/filter-popover.js';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');

test('the chat is one drawer: no history column, and its header keeps its actions and opens History in place',()=>{
  const {document}=parseHTML(html),nav=document.querySelector('#navigation'),chat=document.querySelector('#main');
  assert.ok(!nav.querySelector('#history,.teams-nav,.new-chat,.nav-search'),'the main menu must exclude chat history and actions');
  assert.ok(!chat.querySelector('#history,.teams-nav'),'the drawer shows no history list');
  assert.equal(document.querySelector('#chat-history-dialog'),null,'history is not a dialog');
  assert.equal(document.querySelector('#chat-history'),null,'and not a column beside the chat');
  assert.ok(chat.querySelector('.chat-history-open[data-history-open]'),'the drawer opens History in place');assert.ok(chat.querySelector('.new-chat'));
  assert.ok(chat.querySelector('#share-button'));
  assert.ok(nav.querySelector('#site-nav-title'));assert.ok(nav.querySelector('[data-view="properties"]'));assert.ok(nav.querySelector('[data-view="sources"]'));
  assert.ok(!document.querySelector('.topbar #share-button,.topbar #export-deck-button'),'chat actions must stay with the chat');
  assert.equal(Boolean(document.querySelector('#chat-dock-toggle')),false,'the floating ask bar replaces the dock toggle');
});
test("the main menu offers home, saved sites and what's new on every page, and the brand goes home",()=>{
  const {document}=parseHTML(html),routes=[...document.querySelectorAll('#navigation .app-nav [data-route]')];
  assert.deepEqual(routes.map(n=>[n.textContent.trim(),n.dataset.route]),[['Home','/'],['Underwriting','/sites'],['Modeling','/modeling'],["What's new",'/whats-new']]);
  assert.equal(document.querySelector('.workspace-tabs'),null,'the main menu replaces the top bar tabs');
  const start=source.indexOf('$(".brand").addEventListener'),end=source.indexOf('\ndocument',start);
  assert.ok(start>0&&end>start);let target=null,prevented=false;
  const context={$:s=>document.querySelector(s),navigate:path=>target=path};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const event=new document.defaultView.Event('click');event.preventDefault=()=>{prevented=true;};document.querySelector('.brand').dispatchEvent(event);
  assert.equal(target,'/');assert.equal(prevented,true);
});
test('filter positions stay inside right, bottom, narrow and zoomed viewport edges',()=>{
  for(const viewport of [{width:1440,height:900},{width:820,height:620},{width:390,height:700},{width:320,height:300}]){
    const panel={width:Math.min(340,viewport.width-24),height:Math.min(520,viewport.height-24)};
    for(const anchor of [{left:0,bottom:80},{left:viewport.width-80,bottom:180},{left:120,bottom:viewport.height-15}]){
      const p=filterPopoverPosition(anchor,panel,viewport);
      assert.ok(p.left>=12&&p.top>=12);assert.ok(p.left+panel.width<=viewport.width-12);assert.ok(p.top+panel.height<=viewport.height-12);
    }
  }
});
test('selecting a conversation from history opens it in the drawer, over home from a site page, even an empty or pending one',async()=>{
  const start=source.indexOf('  const conversation = e.target.closest("[data-conversation]");'),end=source.indexOf('\n  const draft =',start);
  assert.ok(start>0&&end>start);
  for(const view of ['site','plan','report','home','sites'])for(const id of ['empty-conversation','pending-local']){
    const {document}=parseHTML('<button data-conversation="'+id+'">Empty chat</button>');let loaded=null,navigated=null,docked=null;
    const context={archive:[],route:{view},navigate:path=>{navigated=path;context.route={view:'home'};},setChatDock:open=>docked=open,
      openConversation:async value=>loaded=value,historyView:{isOpen:()=>false,close(){},hold:fn=>fn(),accessRemoved(){}},toggleContext(){},closeNav(){},handleAccessRemoved(){},toast(){}};
    vm.createContext(context);const click=vm.runInContext('(e)=>{'+source.slice(start,end)+'}',context);
    click({target:document.querySelector('button')});await Promise.resolve();
    assert.equal(docked,true);assert.equal(navigated,['site','plan','report'].includes(view)?'/':null);assert.equal(loaded,id.startsWith('pending-')?null:id);
  }
});
test('filter binding uses the top layer, follows viewport changes and synchronizes dismissal',()=>{
  const {document,window}=parseHTML('<details><summary>Costs</summary><div></div></details>');
  globalThis.window=window;window.innerWidth=1000;window.innerHeight=700;
  const details=document.querySelector('details'),panel=details.querySelector('div'),summary=details.querySelector('summary');
  summary.getBoundingClientRect=()=>({left:940,bottom:200});panel.getBoundingClientRect=()=>({width:340,height:480});
  let showing=false,opens=0,closes=0;panel.matches=selector=>selector===':popover-open'&&showing;
  panel.showPopover=()=>{showing=true;opens++;};panel.hidePopover=()=>{showing=false;closes++;};
  bindFilterPopover(details,panel);details.open=true;details.dispatchEvent(new window.Event('toggle'));
  assert.equal(opens,1);assert.equal(panel.getAttribute('popover'),'auto');assert.equal(panel.style.left,'648px');assert.equal(panel.style.top,'208px');
  window.innerHeight=400;window.dispatchEvent(new window.Event('resize'));assert.equal(panel.style.top,'12px');
  const dismissal=new window.Event('toggle');dismissal.newState='closed';panel.dispatchEvent(dismissal);assert.equal(details.open,false);
  details.dispatchEvent(new window.Event('toggle'));assert.equal(closes,1);
});

test('History reopens a modeling conversation in its model workspace',async()=>{
  const start=source.indexOf('  const conversation = e.target.closest("[data-conversation]");'),end=source.indexOf('\n  const draft =',start);
  const {document}=parseHTML('<button data-conversation="model-chat">Design notes</button>');
  const calls=[],context={archive:[{id:'model-chat',site:{id:'model_1',workflow:'modeling'}}],route:{view:'site'},
    sitePath:(id,section)=>section==='architecture'?'/modeling/'+id:'/sites/'+id,siteAttach:Promise.resolve(),rememberProjectChat(){},
    navigate:path=>calls.push(['navigate',path]),setChatDock:open=>calls.push(['dock',open]),openConversation:async id=>calls.push(['open',id]),
    historyView:{isOpen:()=>false,close(){},hold:fn=>fn()},toggleContext(){},closeNav(){},handleAccessRemoved(){},toast:error=>{throw new Error(error);}};
  vm.createContext(context);vm.runInContext('(e)=>{'+source.slice(start,end)+'}',context)({target:document.querySelector('button')});
  await new Promise(setImmediate);
  assert.deepEqual(calls,[['navigate','/modeling/model_1'],['dock',true],['open','model-chat']]);
});
test('filter panels stay in the viewport when asynchronous status content grows, without reading layout while closed',async()=>{
  const {document,window}=parseHTML('<details><summary>Costs</summary><div>Baseline</div></details>');
  globalThis.window=window;window.innerWidth=1000;window.innerHeight=700;
  const details=document.querySelector('details'),panel=details.querySelector('div');let height=480,reads=0,showing=false;
  details.querySelector('summary').getBoundingClientRect=()=>({left:940,bottom:200});
  panel.getBoundingClientRect=()=>{reads++;return {width:340,height};};
  panel.matches=selector=>selector===':popover-open'&&showing;panel.showPopover=()=>{showing=true;};panel.hidePopover=()=>{showing=false;};
  bindFilterPopover(details,panel);details.open=true;details.dispatchEvent(new window.Event('toggle'));assert.equal(panel.style.top,'208px');
  height=600;panel.textContent='Baseline saved. Updating results. Your typed changes are not applied yet.';await new Promise(setImmediate);
  assert.equal(panel.style.top,'88px','A growing notice keeps the panel bottom inside the viewport');
  details.open=false;details.dispatchEvent(new window.Event('toggle'));const before=reads;
  panel.textContent='A later closed-panel notice';await new Promise(setImmediate);assert.equal(reads,before,'Closed panels do not force layout');
});
test('listing details retain safe source links and clearly qualified unit screening estimates',async()=>{
  const {document,window}=parseHTML(html);globalThis.document=document;globalThis.window=window;
  const {renderInspector}=await import('../public/listing-inspector.js');
  const row={id:'local',address:'Local test property',bbl:'3012340056',borough:'BK',maxUapZfa:6800,maxBuildableUnits:10,flashcardValuation:{},similarComps:[]};
  const options={canStart:()=>true,onUnderwrite(){},onAsk(){},onClose(){}};
  for(const url of ['javascript:alert(1)','https://secret@example.com/site']){
    const view=renderInspector({...row,url},options);assert.ok(!view.querySelector('a.inspector-link'),'unsafe URLs must not become listing links');
    assert.match(view.textContent,/Most units allowed10Zoning cap, one per 680 SF of floor area/);assert.doesNotMatch(view.textContent,/Screening unit estimate|density rules unverified/);
  }
  const view=renderInspector({...row,url:'https://example.com/site'},options);assert.equal(view.querySelector('a.inspector-link').href,'https://example.com/site');
});

test('the top bar is a phone-only strip; its controls live in the rail, the chat header and the ask bar',()=>{
  const {document}=parseHTML(html),bar=document.querySelector('.shell > header.topbar');
  assert.deepEqual([...bar.querySelectorAll('button,a,strong')].map(n=>n.id||n.className),['icon-button mobile-menu','conversation-title'],'menu and title only');
  assert.equal(document.querySelector('#page-crumb'),null,'no breadcrumb');
  const plan=document.querySelector('#navigation .rail-site .workspace-tools #plan-button');
  assert.ok(plan&&plan.hasAttribute('hidden'),'Floor plan is a rail item under This site, shown by the architecture feature');
  assert.ok(document.querySelector('#navigation .nav-item[data-view="sources"]'),'Property & sources opens from the rail');
  assert.ok(document.querySelector('.shell > #ask-bar > form#ask-handle'));
  const css=readFileSync(new URL('../public/workspace-shell.css',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  const desktop=css.slice(css.indexOf('@media (min-width: 851px)'));
  assert.match(desktop,/\.topbar \{ display: none; \}/,'the top bar is hidden at desktop widths');
  assert.match(desktop,/--topbar-h: 0px/,'and the shell reclaims its row');
});
test('the rail view buttons open the property context; the listings section, which also carries data-view, must not',()=>{
  assert.match(source,/document\.querySelectorAll\("#navigation \[data-view\]"\)\.forEach/,'scope the handler to the rail');
  assert.doesNotMatch(source,/document\.querySelectorAll\("\[data-view\]"\)\.forEach/);
});
test('a site page can open its conversation without sending: the rail offers Conversation under This site',()=>{
  const {document}=parseHTML(html);
  const item=document.querySelector('#navigation .rail-site .workspace-tools #site-chat-button');
  assert.ok(item,'Conversation item in the rail site section');
  assert.equal(item.textContent.trim(),'Conversation');
  const start=source.indexOf('$("#site-chat-button").addEventListener'),end=source.indexOf('\n});',start);
  assert.ok(start>0,'the item opens the docked chat');
  assert.match(source.slice(start,end),/setChatDock\(true/);
});
test('a saved search can only be reused where listings exist; the button is not offered otherwise',()=>{
  const start=source.indexOf('if (m.filterUpdate'),end=source.indexOf('\n',start);
  assert.ok(start>0);
  assert.match(source.slice(start,end),/m\.filterUpdate && dealsOnHome/);
});
test('the shared-search link is read only where home shows listings',()=>{
  const start=source.indexOf('const listings = createListings({'),end=source.indexOf('\n});',start);
  assert.ok(start>0);
  assert.match(source.slice(start,end),/searchUrl: route\.view === "home" \? window\.location\.href : null/);
});
test('recent conversations live in the left rail on every page: the latest eight, with site and time, the open one current',async()=>{
  const {document,window}=parseHTML(html);globalThis.document=document;globalThis.window=window;
  const rail=document.querySelector('#navigation .rail-recent');
  assert.ok(rail,'the main menu holds a Recent section');
  assert.equal(rail.querySelector('#rail-recent-title').textContent.trim(),'Recent');
  assert.equal(rail.getAttribute('aria-labelledby'),'rail-recent-title');
  const {renderRecentRail,refreshRecentTimes}=await import('../public/conversation-view.js');
  const now=Date.UTC(2026,9,26,12),hour=3600000;
  const items=Array.from({length:10},(_,i)=>({id:'c'+i,title:'Question '+i,updated:now-i*8*hour,...(i%3===0?{site:{id:'site'+i,title:'Site '+i}}:{})}));
  renderRecentRail(rail,[items[4],...items.filter((_,i)=>i!==4),{id:'pending-1',title:'Sending',updated:now}],'c2',now);
  const rows=[...rail.querySelectorAll('[data-recent]')];
  assert.equal(rail.hidden,false);
  assert.deepEqual(rows.map(r=>r.dataset.recent),['c0','c1','c2','c3','c4','c5','c6','c7'],'the latest eight by last update, no pending row');
  assert.equal(rows[0].dataset.site,'site0');assert.equal(rows[1].dataset.site,undefined);
  assert.match(rows[0].textContent,/Question 0/);assert.match(rows[0].textContent,/Site 0 · just now/);
  assert.match(rows[1].textContent,/8 hours ago/);assert.match(rows[5].textContent,/yesterday/);assert.match(rows[7].textContent,/days ago/);
  assert.deepEqual(rows.map(r=>r.getAttribute('aria-current')),[null,null,'true',null,null,null,null,null]);
  assert.ok(rows.every(r=>r.tagName==='BUTTON'&&r.type==='button'));
  assert.equal(rows[0].title,'Question 0, Site 0');
  renderRecentRail(rail,[{id:'n',title:'1234 Fulton Street',updated:now-hour,site:{id:'s',title:'1234 Fulton Street'}},{id:'u',title:'Untitled site',updated:now-2*hour,site:{id:'t',title:null}}],null,now);
  const [named,untitled]=rail.querySelectorAll('[data-recent]');
  assert.equal(named.title,'1234 Fulton Street','a site conversation named for its site does not repeat the name');
  assert.equal(named.querySelector('small').textContent,'Saved site · 1 hour ago');
  assert.equal(untitled.title,'Untitled site');assert.equal(untitled.querySelector('small').textContent,'Saved site · 2 hours ago');
  refreshRecentTimes(rail,now+3*hour);
  assert.equal(named.querySelector('small').textContent,'Saved site · 4 hours ago','times move on while the page stays open');
  renderRecentRail(rail,[],null,now);assert.equal(rail.hidden,true,'no conversations, no section');
  const css=readFileSync(new URL('../public/workspace-shell.css',import.meta.url),'utf8');
  assert.equal(cssRule(css,'.sidebar .nav-item.rail-recent-item')['min-height'],'44px','rows are at least 44 px tall');
  assert.equal(cssRule(css,'.rail-recent-text small')['text-overflow'],'ellipsis','long titles never widen the rail');
  assert.equal(cssRule(css,'body.sidebar-collapsed .rail-recent').display,'flex');
  assert.equal(cssRule(css,'.rail-recent')['min-height'],'calc(37px + 44px)','at its shortest the section holds its label and All conversations, no taller than the label and one row');
  const surfaces=readFileSync(new URL('../public/surfaces.css',import.meta.url),'utf8');
  for(const [selector,prop] of [['.sidebar .nav-item.rail-all-conversations','min-height'],['.history-view-back','width'],['.history-view-back','height'],['#search-results .history-item','min-height'],['.search-failed button','min-height']])
    assert.equal(cssRule(surfaces,selector)[prop],'44px',selector+' '+prop+' is at least 44 px');
});
// The declarations the rules naming a selector set, in source order, within an optional @media block.
function cssRule(css,selector,media){
  css=css.replace(/\/\*[\s\S]*?\*\//g,'');
  if(media)css=css.split(media).slice(1).map(block=>block.slice(0,block.indexOf('\n}'))).join('\n');
  const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[1].split(',').map(x=>x.trim()).includes(selector));
  assert.ok(rules.length,selector+' has a rule');
  return Object.fromEntries(rules.flatMap(r=>r[2].split(';')).map(d=>d.split(':').map(x=>x.trim())).filter(([k])=>k).map(([k,...v])=>[k,v.join(':')]));
}
test('a short rail shows whole Recent rows, never a cut one, and fades its edge while more rows wait below',async()=>{
  const {fitRecentRail}=await import('../public/conversation-view.js');
  // The rail lays the list out in `room` px; each row is 44 px with 2 px between.
  const rail=(room,count)=>{
    const list={style:{maxHeight:'300px'},classList:new Set(),scrollTop:0,firstElementChild:count?{offsetHeight:44}:null,scrollHeight:count*46-2,
      get clientHeight(){const cap=parseFloat(this.style.maxHeight);return Math.min(room,Number.isNaN(cap)?Infinity:cap,this.scrollHeight);}};
    list.classList.toggle=(name,on)=>{on?list.classList.add(name):list.classList.delete(name);};
    fitRecentRail({querySelector:()=>list,ownerDocument:{defaultView:{getComputedStyle:()=>({rowGap:'2px'})}}});
    return list;
  };
  // Below one row's height the list gives up its rows; All conversations under it still reaches them.
  for(const [room,rows] of [[120,2],[137,3],[44,1],[30,0],[300,6]]){
    const list=rail(room,8);
    assert.equal(list.style.maxHeight,Math.max(0,rows*46-2)+'px',room+' px holds '+rows+' whole rows');
    assert.ok(list.classList.has('has-more'),'more rows wait below, so the edge fades');
    list.scrollTop=list.scrollHeight-list.clientHeight;list.onscroll();
    assert.ok(!list.classList.has('has-more'),'at the end the edge is plain');
  }
  const roomy=rail(400,8);
  assert.equal(roomy.style.maxHeight,'','a rail with room shows every row');assert.ok(!roomy.classList.has('has-more'));
  const hidden=rail(0,8);assert.equal(hidden.style.maxHeight,'','a hidden rail is fitted again when it shows');
  assert.equal(rail(120,0).style.maxHeight,'');
  const css=readFileSync(new URL('../public/workspace-shell.css',import.meta.url),'utf8');
  assert.match(cssRule(css,'.rail-recent-list.has-more')['mask-image'],/linear-gradient\(to bottom/);
  assert.equal(cssRule(css,'.rail-recent','@media (max-width: 850px)').flex,'none','in the phone menu the list keeps its height and the whole menu scrolls');
  assert.equal(cssRule(css,'.rail-recent-list','@media (max-width: 850px)').overflow,'visible');
});
test('a recent row on a site opens that site with the drawer on it; any other opens in the drawer over the current page',async()=>{
  const start=source.indexOf('  const recent = e.target.closest("[data-recent]");'),end=source.indexOf('\n  const conversation = e.target.closest("[data-conversation]");',start);
  assert.ok(start>0&&end>start);
  for(const phone of [false,true])for(const [view,projectId,path] of [['home',null,'/'],['sites',null,'/sites'],['site','fx-plan','/sites/fx-plan'],['site','other','/sites/other']])for(const site of ['fx-plan',null])for(const own of [true,false]){
    const {document}=parseHTML('<button data-recent="conv_1"'+(site?' data-site="'+site+'"':'')+'>Row</button>');
    const calls=[];
    // A conversation on a parcel's other project names the parcel's saved site.
    const context={route:{view,projectId},state:{id:null},siteAttach:Promise.resolve(),dock:false,archive:[{id:'conv_1',projectId:own?'fx-plan':'fx-twin'}],
      // A new page closes the drawer on a phone.
      navigate:p=>{calls.push(['navigate',p]);context.route.projectId=p.split('/')[2];if(phone)context.dock=false;},sitePath:id=>'/sites/'+id,
      openConversation:async id=>calls.push(['open',id]),setChatDock:(open,o)=>{calls.push(['dock',open,o.focus]);context.dock=open;},
      rememberProjectChat:(p,c)=>calls.push(['remember',p,c]),closeNav:()=>calls.push(['closeNav']),historyView:{close(){}},handleAccessRemoved(){},toast(){}};
    vm.createContext(context);const click=vm.runInContext('(e)=>{'+source.slice(start,end)+'}',context);
    click({target:document.querySelector('button')});await new Promise(setImmediate);
    const moves=calls.filter(c=>c[0]==='navigate').map(c=>c[1]);
    if(site&&projectId!==site){
      assert.deepEqual(moves,['/sites/fx-plan'],path+': a site row opens its site');
      if(own)assert.ok(calls.some(c=>c[0]==='remember'&&c[1]==='fx-plan'&&c[2]==='conv_1'),'the site opens on this conversation');
      else assert.ok(!calls.some(c=>c[0]==='remember'),'a twin project\'s conversation is not remembered as the site\'s own');
    }else assert.deepEqual(moves,[],path+': no route change');
    assert.ok(calls.some(c=>c[0]==='open'&&c[1]==='conv_1'));
    assert.equal(context.dock,true,path+(phone?' on a phone':'')+': the drawer is open on the conversation');
    assert.ok(calls.some(c=>c[0]==='dock'&&c[1]===true&&c[2]===false),'the drawer opens without taking focus');
    assert.ok(calls.some(c=>c[0]==='closeNav'),'the phone menu closes');
  }
});
test('a plain Recent row clicked while a site page is still attaching its own conversation stays open',async()=>{
  const start=source.indexOf('  const recent = e.target.closest("[data-recent]");'),end=source.indexOf('\n  const conversation = e.target.closest("[data-conversation]");',start);
  const {document}=parseHTML('<button data-recent="conv_row">Row</button>');
  let attached;
  const context={route:{view:'site',projectId:'fx-plan'},state:{id:null},archive:[],navigate(){},sitePath:id=>'/sites/'+id,setChatDock(){},rememberProjectChat(){},closeNav(){},historyView:{close(){}},handleAccessRemoved(){},toast(){},
    openConversation:async id=>{context.state.id=id;}};
  // The site page opened its own conversation once the history arrived.
  context.siteAttach=new Promise(resolve=>{attached=()=>{context.state.id='conv_site';resolve();};});
  vm.createContext(context);vm.runInContext('(e)=>{'+source.slice(start,end)+'}',context)({target:document.querySelector('button')});
  await new Promise(setImmediate);
  assert.equal(context.state.id,null,'the row waits for the site to attach');
  attached();await new Promise(setImmediate);
  assert.equal(context.state.id,'conv_row','the conversation the reader picked is the one left open');
});
// The site-page binding, run from production source: dockOnSite, siteCanSend, reattachSite.
function siteBinding(context){
  const start=source.indexOf('const siteChats = new Map();'),end=source.indexOf('\n// The underwriting report reads',start);
  assert.ok(start>0&&end>start);
  vm.createContext(context);vm.runInContext(source.slice(start,end).replace('const siteChats','var siteChats'),context);
  return context;
}
test('a conversation opened from Recent over a site neither receives the site page requests nor sets who may make them',()=>{
  const viewer={route:{view:'site',projectId:'site_1'},state:{id:'conv_other',projectId:null,access:'viewer'},session:{},canSend(){return this.state.access!=='viewer';}};
  const c=siteBinding(viewer);c.canSend=c.canSend.bind(c);
  c.siteChats.set('site_1',{id:'conv_site',access:'owner',title:'Site'});
  assert.equal(c.dockOnSite(),false);
  assert.equal(c.siteCanSend(),true,'the owner keeps the site controls while a shared conversation is open over the site');
  c.siteChats.set('site_1',{id:'conv_site',access:'viewer'});
  assert.equal(c.siteCanSend(),false,'a reader of the site stays a reader');
  c.state={id:'conv_site',projectId:'site_1',access:'owner'};
  assert.equal(c.dockOnSite(),true);assert.equal(c.siteCanSend(),true,'the site conversation itself decides once it is open');
  c.state={id:null,projectId:null,access:null};assert.equal(c.dockOnSite(),true,'a new chat on the site is the site chat');
  c.route={view:'home'};c.state={id:'conv_other',projectId:null,access:'viewer'};assert.equal(c.dockOnSite(),true,'off a site, the dock is the chat');
});
test('a site page request with another conversation open brings the site conversation back and sends there',async()=>{
  const start=source.indexOf('document.addEventListener("acres-follow-up", (e) => {'),end=source.indexOf('\n});',start)+4;
  assert.ok(start>0);
  const run=async(state)=>{
    const sent=[],attached=[];
    const c=siteBinding({route:{view:'site',projectId:'site_1'},state,session:{},canSend:()=>true,siteAttach:Promise.resolve(),toast(){},
      followUpMessage:ref=>'Draft '+ref.field,queuePlanNote:d=>sent.push(['note',d.planNote]),send:async text=>{sent.push([text,c.state.id]);},
      attachProjectConversation:async projectId=>{attached.push(projectId);c.state={id:'conv_site',projectId,access:'owner'};},
      document:{addEventListener:(name,fn)=>{c.listener=fn;}}});
    vm.runInContext(source.slice(start,end),c);
    c.listener({detail:{ref:{conversation:'x',field:'architecture',action:'draft'}}});
    await new Promise(setImmediate);
    c.listener({detail:{projectId:'site_1',planNote:{kind:'revision'}}});
    return {sent,attached};
  };
  const over=await run({id:'conv_market',projectId:null,access:'owner'});
  assert.deepEqual(over.attached,['site_1'],'the site conversation comes back into the dock');
  assert.deepEqual(over.sent[0],['Draft architecture','conv_site'],'the request goes to the site conversation, not the one opened over it');
  assert.deepEqual(over.sent[1],['note',{kind:'revision'}],'plan notes still queue');
  const own=await run({id:'conv_site',projectId:'site_1',access:'owner'});
  assert.deepEqual(own.attached,[]);assert.deepEqual(own.sent[0],['Draft architecture','conv_site']);
});
test('a conversation started or opened on a site page shows as that site in the rail before the list refreshes',()=>{
  const start=source.indexOf('function renderHistory() {'),end=source.indexOf('\n}',start)+2;
  const rendered=[];
  const c={archive:[{id:'conv_new',title:'Draft the plan',updated:2},{id:'conv_listed',title:'Old',updated:1,site:null}],state:{},pendingSubmission:null,submitPending:false,busy:false,me:null,historyLoading:false,
    siteChats:new Map([['site_1',{id:'conv_new',title:'1234 Fulton Street'}],['site_2',{id:'conv_listed',title:'Other'}]]),
    sidebarConversationList:a=>({items:a,activeId:null}),renderNavigation(){},renderRecentRail:(_r,items)=>rendered.push(...items),refitRecent(){},$:()=>null};
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);c.renderHistory();
  assert.deepEqual(JSON.parse(JSON.stringify(rendered[0].site)),{id:'site_1',title:'1234 Fulton Street'});
  assert.equal(rendered[1].site,null,'the conversation list has the last word once it has answered');
});
test('one scroll container per page: the shell clips what reaches past it, so the document never scrolls and only the page section does',()=>{
  const read=file=>readFileSync(new URL('../public/'+file,import.meta.url),'utf8');
  const shell=cssRule(read('workspace-shell.css'),'.shell');
  // clip, not hidden: a hidden shell is itself a scroll box that focus or an anchor can move.
  assert.equal(shell.overflow,'clip','an absolutely placed node inside a page (a screen reader caption) must not grow the document');
  for(const [file,selector] of [['workspace-shell.css','.core-page'],['workspace-shell.css','#home-listings'],['report.css','.report-page'],['whats-new.css','.whats-new-page'],['workspace-shell.css','.shell > .welcome']])
    assert.equal(cssRule(read(file),selector)['overflow-y'],'auto',selector+' scrolls on its own');
});
