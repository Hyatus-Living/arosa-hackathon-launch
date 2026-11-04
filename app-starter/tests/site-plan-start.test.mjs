import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function startSite(site, prompt, bbl) {'),end=source.indexOf('\nasync function discardEmptyConversation(',start);
assert.ok(start>=0&&end>start,'production startSite');

// Floor plan & 3D from a listing whose lot already has a site: the site's plan page opens, and when
// that site has no plan yet the drafting request goes into the site's own conversation once.
function setup({plan=null}={}){
  const c={calls:[],sent:[],history:{state:null},route:{view:'starting',projectId:null},pendingSite:null,
    findSite:async bbl=>bbl==='3011560001'?{id:'p1',bbl}:null,
    sitePath:(id,section)=>section==='architecture'?`/sites/${id}/plan`:`/sites/${id}`,
    navigate(path){c.calls.push(['navigate',path]);c.route={view:path.endsWith('/plan')?'plan':'site',projectId:'p1'};},
    chatRequest:async path=>{c.calls.push(['get',path]);return {current:plan};},
    attachProjectConversation:async id=>{c.calls.push(['attach',id]);},
    send:async(text,options)=>{c.sent.push([text,options]);return {conversationId:'c1',started:true};},
    startBlankChat(){throw new Error('an existing site must not start a new chat');},
  };
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);
  return c;
}

test('an existing underwriting only opens its financial workflow and never requests architecture',async()=>{
  const c=setup();await c.startSite({section:null},'Underwrite it','3011560001');
  assert.deepEqual(JSON.parse(JSON.stringify(c.calls)),[['navigate','/sites/p1']]);
  assert.deepEqual(c.sent,[]);
});

test('Model this property creates an addressed modeling project and drafts there, without underwriting',async()=>{
  const calls=[],c={postChat:async(path,body)=>{calls.push(['post',path,body]);return{id:'m1'};},navigate:path=>{calls.push(['navigate',path]);c.route={projectId:'m1'};},routePath:r=>'/modeling/'+r.projectId,siteAttach:Promise.resolve(),route:{},send:async text=>calls.push(['send',text]),toast:error=>{throw new Error(error);}};
  const start=source.indexOf('async function planListing('),end=source.indexOf('\n// The architecture section',start);
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);
  await c.planListing({address:'1234 Fulton Street'},'Draft a plan');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['post','/projects',{workflow:'modeling',address:'1234 Fulton Street',title:'1234 Fulton Street'}],['navigate','/modeling/m1'],['send','Draft a plan']]);
});

test('a site that already has a plan, or a plain site open, only navigates',async()=>{
  const planned=setup({plan:{revision:2}});
  await planned.startSite({section:'architecture'},'Draft the plan','3011560001');
  assert.deepEqual(planned.sent,[]);
  const plain=setup();
  await plain.startSite({section:null},'Underwrite it','3011560001');
  assert.deepEqual(JSON.parse(JSON.stringify(plain.calls)),[['navigate','/sites/p1']]);assert.deepEqual(plain.sent,[]);
});
