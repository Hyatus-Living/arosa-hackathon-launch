import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {computeDealValuation} from './market-store.mjs';
import {buildSchemes,optionSnapshot,optionFiles} from './schemes.mjs';
import {budgetFor} from './budget-lines.mjs';

const [alice,bob,carol,dave]=['a','b','c','d'].map(c=>c.repeat(24));
// A vacant Queens lot priced by the real valuation; nothing here is tuned to a known answer.
const lot={listPrice:6_000_000,lotArea:10000,lotFront:100,lotDepth:100,lotTypeCode:'5',bldgArea:0,residFar:3.44,affResFar:5.01,zoningDistrict:'R7-1',address:'20 EXAMPLE AVENUE',borough:'QN',zipCode:'11373',frontStreetFeet:80};
const square=[[0,0],[60,0],[60,80],[0,80]];

async function open(t){
  const dir=mkdtempSync(join(tmpdir(),'acres-option-links-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,maps:null,execute:async()=>({answer:'x',sources:[],ui:[]}),
    architecture:{stateDir:join(dir,'state'),buildPlan:()=>{throw new Error('unused');},worker:null,pipelineVersion:'test'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.architectureJobs?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=(path,{method='GET',account=alice,bearer='test'}={})=>fetch(base+path,{method,headers:{...(bearer?{authorization:`Bearer ${bearer}`}:{}),...(account?{'x-acres-account':account}:{}),'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
  store.touchPerson(alice,'alice@example.com');store.setMyName(alice,'alice@example.com','Alice Avery');
  const conversation=store.createConversation(alice),projectId=conversation.projectId;
  store.grantMember(alice,conversation.id,'account',bob,'participant');
  store.grantMember(alice,conversation.id,'account',carol,'viewer');
  // A drawn floor plan, the architect's package and drawing set, a street still for the first option, and one more file the link must not reach.
  const file=(name,kind,type)=>{
    const id=randomUUID(),path=join(dir,name);writeFileSync(path,`${kind} bytes`);
    store.write('INSERT INTO architecture_artifacts(artifact_id,project,revision,job_id,kind,path,sha256,bytes,content_type,created_at,plan_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,projectId,2,null,kind,path,kind,Buffer.byteLength(`${kind} bytes`),type,1,'plan-1');
    return id;
  };
  const svg=file('plan.svg','svg','image/svg+xml'),street=file('street.png','render-street','image/png'),ifc=file('model.ifc','ifc','application/x-step');
  const zip=file('package.zip','package','application/zip'),set=file('drawings.pdf','drawings-pdf','application/pdf');
  const valuation=computeDealValuation({...lot,withCandidates:true});
  const schemes=buildSchemes({candidates:valuation.candidates,concepts:[{id:'c1',name:'Mid-rise',levels:[{footprint:square,height:10,count:7}],lot:[[0,0],[100,0],[100,100],[0,100]],metrics:{grossFloorAreaSqft:valuation.candidates[0].zfa,storeys:valuation.candidates[0].storeys}}]});
  store.project.write(projectId,{property:{value:{bbl:'4012340001',address:'20 Example Avenue'},provenance:{tool:'acres_set_subject',sources:[]}},
    concepts:{value:[{id:'c1',name:'Mid-rise',levels:[{footprint:square,height:10,count:7}],lot:[[0,0],[100,0],[100,100],[0,100]]}],provenance:{tool:'acres_concepts',sources:[]}},
    schemes:{value:{schemes,basis:{source:'listing',ask:6_000_000,askFrom:'listing'}},provenance:{tool:'schemes',sources:[]}}});
  const first=schemes[0].id;
  store.setSchemePart(projectId,first,'plan',{planId:'plan-1',revision:2,svg,files:{package:zip,'drawings-pdf':set}});
  store.setSchemePart(projectId,first,'render',{artifactId:street,status:'succeeded',url:'/x',jobId:'j1',reason:null,views:[{view:'street',artifactId:street,url:'/x'}],renderSeconds:90,at:1});
  store.setSchemePart(projectId,first,'budget',budgetFor(schemes[0]));
  return {store,api,projectId,conversation,first,files:{svg,street,ifc,zip,set}};
}

test('only the site owner sends an option, and the send is a project event with the option frozen as it stood',async t=>{
  const {store,api,projectId,first,files}=await open(t);
  assert.equal((await api(`/projects/${projectId}/schemes/${first}/send`,{method:'POST',account:bob})).status,403,'a participant cannot send');
  assert.equal((await api(`/projects/${projectId}/schemes/${first}/send`,{method:'POST',account:carol})).status,403,'a viewer cannot send');
  assert.equal((await api(`/projects/${projectId}/schemes/${first}/send`,{method:'POST',account:dave})).status,404,'an outsider does not see the site');
  assert.equal((await api(`/projects/${projectId}/schemes/tallest/send`,{method:'POST'})).status,404);
  const before=store.projectEvents(projectId).length;
  const res=await api(`/projects/${projectId}/schemes/${first}/send`,{method:'POST'});
  assert.equal(res.status,201);
  const link=await res.json();
  assert.match(link.token,/^[\w-]{43}$/);assert.equal(link.path,`/api/public/options/${link.token}`);
  assert.deepEqual([link.option.site,link.option.sender],[{address:'20 Example Avenue',bbl:'4012340001'},{name:'Alice Avery'}]);
  assert.deepEqual(link.option.plan,{revision:2,artifactId:files.svg,files:{package:files.zip,'drawings-pdf':files.set}});
  assert.deepEqual(link.option.renders,[{view:'street',artifactId:files.street}]);
  assert.equal(link.option.massing.levels[0].count,7);
  assert.ok(link.option.scheme.budget.lines.length);
  const events=store.projectEvents(projectId).slice(before);
  assert.deepEqual(events.map(e=>[e.event,e.scheme,e.label,e.name]),[['option.sent',first,'As of right','Alice Avery']]);
  assert.ok(!JSON.stringify(events).includes(link.token),'the activity never carries the token');

  const sends=store.optionSends(carol,projectId);
  assert.deepEqual([sends.canSend,sends.sent[first].by,sends.sent[first].at],[false,'Alice Avery',link.createdAt]);
  assert.deepEqual([store.optionSends(bob,projectId).canSend,store.optionSends(alice,projectId).canSend],[false,true]);
  // Later changes to the site do not change what was sent.
  store.setSchemePart(projectId,first,'plan',null);
  assert.deepEqual(store.optionLink(link.token).plan,{revision:2,artifactId:files.svg,files:{package:files.zip,'drawings-pdf':files.set}});
});

test('the link reads without an account, shows only its own files and never names the site record',async t=>{
  const {api,projectId,first,files}=await open(t);
  const {token}=await (await api(`/projects/${projectId}/schemes/${first}/send`,{method:'POST'})).json();
  const read=await api(`/public/options/${token}`,{account:null});
  assert.equal(read.status,200);
  const option=await read.json();
  assert.deepEqual(Object.keys(option).sort(),['at','basis','massing','plan','renders','scheme','sender','site'],'the option and nothing about the account, conversation or other options');
  assert.deepEqual(Object.keys(option.scheme).sort(),['budget','id','label','note','program','returns','summary']);
  assert.equal(option.scheme.id,first);
  const svg=await api(`/public/options/${token}/files/${files.svg}`,{account:null});
  assert.deepEqual([svg.status,svg.headers.get('content-type'),await svg.text()],[200,'image/svg+xml','svg bytes']);
  assert.equal((await api(`/public/options/${token}/files/${files.street}`,{account:null})).status,200);
  const zip=await api(`/public/options/${token}/files/${files.zip}`,{account:null});
  assert.deepEqual([zip.status,zip.headers.get('content-type'),zip.headers.get('content-disposition')],[200,'application/zip','attachment; filename="package-r2.zip"'],'the architect\'s package downloads');
  assert.equal((await api(`/public/options/${token}/files/${files.set}`,{account:null})).headers.get('content-disposition'),'attachment; filename="drawings-pdf-r2.pdf"');
  assert.equal((await api(`/public/options/${token}/files/${files.ifc}`,{account:null})).status,404,'a file of the site the option does not name');
  assert.equal((await api(`/public/options/${'x'.repeat(43)}`,{account:null})).status,404);
  for(const path of ['abc',`${token}x`,`${token}/files/abc`,`${token}/extra`])assert.equal((await api(`/public/options/${path}`,{account:null})).status,404,`a malformed link ${path.length}`);
  assert.equal((await api(`/public/options/${token}`,{account:null,bearer:null})).status,401,'only the web app reads links');
});

test('only the site owner withdraws an option\'s links, which then stop opening',async t=>{
  const {store,api,projectId,first}=await open(t);
  const tokens=[];
  for(let i=0;i<2;i++)tokens.push((await (await api(`/projects/${projectId}/schemes/${first}/send`,{method:'POST'})).json()).token);
  assert.equal((await api(`/projects/${projectId}/schemes/${first}/send`,{method:'DELETE',account:bob})).status,403);
  assert.equal((await api(`/projects/${projectId}/schemes/${first}/send`,{method:'DELETE',account:dave})).status,404);
  const res=await api(`/projects/${projectId}/schemes/${first}/send`,{method:'DELETE'});
  assert.deepEqual([res.status,await res.json()],[200,{withdrawn:2}]);
  for(const token of tokens)assert.equal((await api(`/public/options/${token}`,{account:null})).status,404);
  assert.deepEqual(store.optionSends(alice,projectId).sent,{});
  const last=store.projectEvents(projectId).at(-1);
  assert.deepEqual([last.event,last.scheme,last.links],['option.withdrawn',first,2]);
  assert.deepEqual(await (await api(`/projects/${projectId}/schemes/${first}/send`,{method:'DELETE'})).json(),{withdrawn:0});
});

test('a sent link goes with a deleted site',async t=>{
  const {store,api,projectId,conversation,first}=await open(t);
  const {token}=await (await api(`/projects/${projectId}/schemes/${first}/send`,{method:'POST'})).json();
  store.deleteConversation(alice,conversation.id);
  assert.equal(store.optionLink(token),null);
});

test('a snapshot lists the files it may serve and draws no shape from a metric concept',()=>{
  const scheme={id:'as_of_right',label:'As of right',summary:'Rental',note:null,program:{},returns:{},budget:null,massing:{conceptId:'m'},
    plan:{planId:'p',revision:1,svg:'s1'},render:{status:'running',views:[]}};
  const option=optionSnapshot({scheme,basis:null,concepts:[{id:'m',units:'m',levels:[{footprint:square,height:3,count:2}]}],site:{address:'1 Main St'},sender:{name:'A'},at:1});
  assert.deepEqual([option.massing,option.renders,optionFiles(option)],[null,[],['s1']]);
  const sent=optionSnapshot({scheme:{...scheme,plan:{...scheme.plan,files:{package:'z1',ifc:'i1'}}},basis:null,site:{address:'1 Main St'},sender:{name:'A'},at:1});
  assert.deepEqual(optionFiles(sent),['s1','z1','i1'],'the architect\'s package goes with the plan drawing');
});
