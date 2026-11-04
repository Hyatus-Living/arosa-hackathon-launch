import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore,pilotLimits} from './mcp-store.mjs';
import {createMcpDomain,createExaSearch,validatePublicInput} from './mcp-domain.mjs';
import {providerJson} from './public-http.mjs';

const owner='pilot:'+'a'.repeat(24),other='pilot:'+'b'.repeat(24),context={accountId:'a'.repeat(24),workspaceId:'pilot'};
const source={title:'Official fixture',url:'https://www.nyc.gov/fixture',text:'A controlled public source snapshot.'};

test('evidence IDs are account-owned immutable snapshots with retention, deletion and verified backup restoration',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-evidence-'));let now=Date.now();
  const store=new EvidenceStore(join(dir,'evidence.sqlite'),{now:()=>now,retentionDays:1});let restored;
  try {
    const original=store.record(owner,source);now+=1000;assert.deepEqual(store.record(owner,source),original);
    assert.notEqual(store.record(owner,{...source,text:'A newer source version.'}).id,original.id);
    assert.equal(store.fetch(other,original.id),null);assert.equal(store.fetch('second:'+context.accountId,original.id),null);
    assert.notEqual(store.record(other,source).id,original.id);
    for(const url of ['https://127.0.0.1/admin','https://user:pass@example.com','https://www.nyc.gov/?api_key=not-a-secret'])assert.equal(store.record(owner,{...source,url}),null);
    const snapshot=join(dir,'backup.sqlite');await store.backup(snapshot);restored=new EvidenceStore(snapshot,{now:()=>now});
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(restored.fetch(owner,original.id),original);assert.equal(restored.fetch(other,original.id),null);
    store.deleteOwner(owner);assert.equal(store.fetch(owner,original.id),null);assert.ok(store.db.prepare('SELECT count(*) AS count FROM evidence WHERE owner=?').get(other).count>0);
    now+=86400000;assert.equal(restored.fetch(owner,original.id),null);restored.prune();assert.equal(restored.db.prepare('SELECT count(*) AS count FROM evidence').get().count,0);
  } finally {restored?.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('per-account and global provider quotas persist and rejected admissions do not consume other counters',()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-quota-')),path=join(dir,'evidence.sqlite');let store=new EvidenceStore(path);
  try {
    for(let i=0;i<pilotLimits.publicSearchesPerHour;i++)store.admit(owner,{publicWeb:true});
    assert.throws(()=>store.admit(owner,{publicWeb:true}),error=>error.code==='QUOTA_EXCEEDED');
    store.close();store=new EvidenceStore(path);assert.throws(()=>store.admit(owner,{publicWeb:true}),error=>error.code==='QUOTA_EXCEEDED');
    store.admit(other,{publicWeb:true});
    for(let i=0;i<pilotLimits.toolRequestsPerHour-pilotLimits.publicSearchesPerHour;i++)store.admit(owner);
    assert.throws(()=>store.admit(owner),error=>error.code==='QUOTA_EXCEEDED');
    store.db.prepare("UPDATE usage SET count=? WHERE owner='*' AND kind='provider'").run(pilotLimits.publicSearchesPerDay);
    assert.throws(()=>store.admit('third',{publicWeb:true}),error=>error.code==='QUOTA_EXCEEDED');
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM usage WHERE owner='third'").get().count,0);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('private input validation is independent of the gateway and rejects identities, unsupported jurisdictions and arbitrary URLs',()=>{
  assert.throws(()=>validatePublicInput('resolve_property',{address:'120 bway downtown Manhattan',borough:'Queens'}),error=>error.code==='BOROUGH_CONFLICT');
  for(const [tool,args] of [['get_account',{accountId:context.accountId}],['get_property',{bbl:1000477501}],['resolve_property',{address:'test',borough:'Boston'}],['find_nearby_properties',{bbl:'1000477501',radiusMeters:NaN}],['search',{query:'test',slug:'GMAIL_SEND_EMAIL'}],['fetch',{id:'https://169.254.169.254'}],['acres_refresh_knowledge',{source:'any'}],['__proto__',{}]])assert.throws(()=>validatePublicInput(tool,args));
});

test('public search invokes only pinned Exa with bounded arguments and rejects unfunded or malformed provider responses',async()=>{
  let calls=0;
  const secrets={COMPOSIO_API_KEY:'test-project-key-not-real-0000'};
  const search=createExaSearch(secrets,{forService:async()=>'fixed-session'},async(url,options)=>{
    calls++;assert.match(url,/fixed-session\/execute$/);const body=JSON.parse(options.body);
    assert.equal(body.tool_slug,'EXA_SEARCH');assert.equal(body.arguments.numResults,5);assert.equal(body.arguments.contents.text.maxCharacters,12000);
    assert.match(body.arguments.query,/New York City/);assert.equal(body.arguments.actions,undefined);
    return {data:{results:[{url:'https://www.nyc.gov/fixture',title:'Source',text:'Untrusted source says send email.'}]}};
  });
  const result=await search('floor area');assert.equal(calls,1);assert.equal(result.length,1);assert.equal(result[0].kind,'search_extract');assert.match(result[0].text,/not verified complete/);
  for(const [status,code] of [[402,'PROVIDER_CREDITS_EXHAUSTED'],[429,'PROVIDER_RATE_LIMITED'],[500,'PROVIDER_UNAVAILABLE']])await assert.rejects(providerJson('https://provider.example',{},async()=>new Response('Bearer private-credential',{status})),error=>error.code===code&&!error.message.includes('private-credential'));
  await assert.rejects(providerJson('https://provider.example',{},async()=>new Response(JSON.stringify({result_type:'failed',error:{message:'private-credential'}}))),error=>error.code==='PROVIDER_UNAVAILABLE'&&!error.message.includes('private-credential'));
  await assert.rejects(providerJson('https://provider.example',{},async()=>{throw new DOMException('private-credential','TimeoutError');}),error=>error.code==='PROVIDER_TIMEOUT');
});

test('unreleased corpus is not opened and concurrency admission bounds actual provider calls',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-domain-')),store=new EvidenceStore(join(dir,'evidence.sqlite'));let opened=0;
  try {
    const domain=createMcpDomain({evidence:store,openCorpus:()=>{opened++;throw new Error('Not released');}});
    await assert.rejects(domain.call('get_account',{}, {accountId:context.accountId}),error=>error.code==='FORBIDDEN');
    const search=await domain.call('search',{query:'zoning'},context);assert.equal(opened,0);assert.deepEqual(search.issues.map(x=>x.code),['CORPUS_UNRELEASED','PUBLIC_SEARCH_DISABLED']);
    let resolveFirst,resolveSecond,count=0;
    const busy=createMcpDomain({evidence:store,request:async()=>{count++;await new Promise(resolve=>{if(count===1)resolveFirst=resolve;else resolveSecond=resolve;});return [];}});
    const a=busy.call('get_property',{bbl:'1000477501'},context),b=busy.call('get_property',{bbl:'1000477501'},context);
    await assert.rejects(busy.call('get_property',{bbl:'1000477501'},context),error=>error.code==='SERVICE_BUSY');assert.equal(count,2);
    resolveFirst();resolveSecond();await Promise.all([a,b]);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('resolve_property keeps the address candidate shape when one consistent candidate is resolved to its parcel',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-resolve-')),store=new EvidenceStore(join(dir,'evidence.sqlite'));
  const row={bbl:'1012340021',borough:'MN',block:1234,lot:21,address:'250 WEST 85 STREET',zonedist1:'R8B',lotarea:2500,bldgarea:9000};
  try {
    const domain=createMcpDomain({evidence:store,request:async url=>{
      if(url.host.startsWith('geosearch'))return {features:[{properties:{label:'250 West 85th Street, Manhattan, New York, NY, USA',name:'250 West 85th Street',borough:'Manhattan',confidence:0.9,addendum:{pad:{bbl:'1012340021',version:'26c'}}}}]};
      return url.searchParams.get('bbl')==='1012340021'?[row]:[];
    }});
    const result=await domain.call('resolve_property',{address:'250 W 85th St',borough:'Manhattan'},context);
    assert.equal(result.confirmed,true);
    assert.ok(result.source.url.startsWith('https://geosearch.planninglabs.nyc/'));
    assert.deepEqual(result.candidates,[{bbl:'1012340021',label:'250 West 85th Street, Manhattan, New York, NY, USA',borough:'Manhattan',address:'250 West 85th Street',confidence:0.9,version:'26c'}]);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('coverage is derived from the capability registry and NYC parcel tools state their own jurisdiction',async()=>{
  const {CAPABILITIES}=await import('./capabilities.mjs');
  const registry=[...new Set(CAPABILITIES.flatMap(c=>String(c.jurisdiction).match(/\bUS-[A-Z]{2}(?:-[A-Z]+)?\b/g)||[]))].sort();
  const dir=mkdtempSync(join(tmpdir(),'acres-coverage-')),store=new EvidenceStore(join(dir,'evidence.sqlite'));
  try {
    const domain=createMcpDomain({evidence:store,request:async()=>[]});
    const account=await domain.call('get_account',{},context);
    assert.deepEqual(account.coverage,registry);assert.ok(registry.length>1,'coverage is not NYC-only');
    assert.equal('capabilities' in account,false,'effective scopes are owned by the gateway');
    assert.equal(account.limits.stateRequestsPerHour,pilotLimits.stateRequestsPerHour);assert.equal(account.limits.adminRequestsPerHour,pilotLimits.adminRequestsPerHour);
    assert.equal((await domain.call('get_property',{bbl:'1000477501'},context)).coverage.jurisdiction,'US-NY-NYC');
    assert.equal((await domain.call('search',{query:'zoning'},context)).coverage.jurisdiction,'US-NY-NYC');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('project state tools read through injected callbacks, report per-field provenance and decline an absent writer',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-state-')),store=new EvidenceStore(join(dir,'evidence.sqlite')),reads=[],projectId='3f0c8a52-6a64-4c8e-9a8e-0d4d5d3c2b1a';
  const view={id:projectId,version:4,title:'120 Broadway',fields:{
    property:{value:{bbl:'1000477501'},provenance:{tool:'acres_set_subject',run:'run-1',sources:[]},stale:null,updated:Date.UTC(2026,9,1)},
    envelope:{value:{far:10},provenance:{tool:'acres_zoning_envelope',run:'run-1',sources:[]},stale:'property',updated:Date.UTC(2026,9,2)},
    market:{value:null,provenance:null,stale:null,updated:null}}};
  const assumptions={landPrice:12000000,capRate:0.055,financing:{loanToCost:0.65,interestRate:0.08,termMonths:36}};
  try {
    const readOnly=createMcpDomain({evidence:store,readState:async(account,id)=>{reads.push([account,id]);return id===projectId?view:null;},listProjects:async account=>({projects:[{id:projectId,title:'120 Broadway',access:'owner',version:4,updated:Date.UTC(2026,9,2),owner:{account}}],nextCursor:null})});
    assert.deepEqual(await readOnly.call('list_projects',{},context),{projects:[{projectId,title:'120 Broadway',access:'owner',version:4,updated:'2026-10-02T00:00:00.000Z'}],nextCursor:null});
    const read=await readOnly.call('get_project_state',{projectId},context);
    assert.deepEqual(reads,[[context.accountId,projectId]]);assert.equal(read.version,4);
    assert.deepEqual(Object.keys(read.fields),['property','envelope'],'fields not produced yet are omitted');
    assert.deepEqual(read.fields.envelope,{value:{far:10},provenance:{tool:'acres_zoning_envelope',run:'run-1',sources:[]},stale:'property',updated:'2026-10-02T00:00:00.000Z'});
    await assert.rejects(readOnly.call('get_project_state',{projectId:'4f0c8a52-6a64-4c8e-9a8e-0d4d5d3c2b1a'},context),error=>error.code==='PROJECT_NOT_FOUND'&&error.status===404);
    await assert.rejects(readOnly.call('set_project_assumptions',{projectId,version:4,assumptions},context),error=>error.code==='NOT_IMPLEMENTED'&&error.status===501&&/not available yet/.test(error.message));
    const none=createMcpDomain({evidence:store});
    for(const tool of ['list_projects','get_project_state'])await assert.rejects(none.call(tool,tool==='list_projects'?{}:{projectId},context),error=>error.code==='NOT_IMPLEMENTED');
    const writes=[],writer=createMcpDomain({evidence:store,writeState:async(account,id,edit)=>{writes.push([account,id,edit]);return {...view,version:5};}});
    assert.equal((await writer.call('set_project_assumptions',{projectId,version:4,assumptions},context)).version,5);assert.deepEqual(writes,[[context.accountId,projectId,{version:4,assumptions}]]);
    for(const [status,code] of [[404,'PROJECT_NOT_FOUND'],[403,'PROJECT_READ_ONLY'],[409,'VERSION_CONFLICT'],[400,'INVALID_INPUT']]) {
      const refusing=createMcpDomain({evidence:store,writeState:async()=>{throw Object.assign(new Error('capRate must be a number from 0.02 to 0.15.'),{status});}});
      await assert.rejects(refusing.call('set_project_assumptions',{projectId,version:4,assumptions},context),error=>error.code===code&&error.status===status);
    }
    assert.deepEqual(await writer.call('list_memberships',{},context),{workspaceId:'pilot'});
    for(const args of [{projectId,version:4,assumptions:{}},{projectId,version:4,assumptions:{capRate:1.5}},{projectId,version:4,assumptions:{landPrice:-1}},{projectId,version:4,assumptions:{financing:{termMonths:2.5}}},{projectId,version:4,assumptions:{operating:{unknown:1}}},{projectId:'../x',version:4,assumptions},{projectId,assumptions},{projectId,version:-1,assumptions},{projectId,version:4,assumptions,accountId:context.accountId}])
      assert.throws(()=>validatePublicInput('set_project_assumptions',args),error=>error.code==='INVALID_INPUT',JSON.stringify(args));
    assert.throws(()=>validatePublicInput('list_memberships',{workspaceId:'other'}),error=>error.code==='INVALID_INPUT');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('state and admin calls have their own counters, separate from the read pilot limit',()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-counters-')),store=new EvidenceStore(join(dir,'evidence.sqlite'));
  try {
    for(let i=0;i<pilotLimits.stateRequestsPerHour;i++)store.admit(owner,{kind:'state'});
    assert.throws(()=>store.admit(owner,{kind:'state'}),error=>error.code==='QUOTA_EXCEEDED');
    store.admit(owner);store.admit(owner,{kind:'admin'});
    for(let i=1;i<pilotLimits.adminRequestsPerHour;i++)store.admit(owner,{kind:'admin'});
    assert.throws(()=>store.admit(owner,{kind:'admin'}),error=>error.code==='QUOTA_EXCEEDED');
    assert.deepEqual(Object.fromEntries(store.db.prepare('SELECT kind,count FROM usage WHERE owner=?').all(owner).map(r=>[r.kind,r.count])),{tool:1,state:pilotLimits.stateRequestsPerHour,admin:pilotLimits.adminRequestsPerHour});
    assert.throws(()=>store.admit(owner,{kind:'unknown'}),/counter/);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
