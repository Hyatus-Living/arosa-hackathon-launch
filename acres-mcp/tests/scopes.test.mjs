import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {contracts} from '../dist/contracts.js';
import {readMemberships} from '../dist/config.js';
import {fixture,call,toolError,listen,close,accountA,accountB,serviceToken,allScopes} from './fixture.mjs';

const bbl='1000477501',projectId='3f0c8a52-6a64-4c8e-9a8e-0d4d5d3c2b1a',sourceId='src_'+'0'.repeat(64),iso='2026-10-01T00:00:00.000Z';
const coverage={jurisdiction:'US-NY-NYC',notes:[]};
const stateFields={
  property:{value:{bbl},provenance:{tool:'acres_set_subject',run:'run-1',sources:[{title:'PLUTO',url:'https://data.cityofnewyork.us/pluto'}]},stale:null,updated:iso},
  envelope:{value:{far:10},provenance:{tool:'acres_zoning_envelope',run:'run-1',sources:[]},stale:'property',updated:iso},
};
const assumptions={landPrice:12000000,hardCostPerSqft:450,capRate:0.055,financing:{loanToCost:0.65,interestRate:0.08,termMonths:36},operating:{residentialVacancyRate:0.05,commercialOpexPerSqftPerYear:12}};
const stateOutput={projectId,version:3,fields:stateFields};
// One valid input and the backend's valid output for every tool.
const cases={
  get_account:{input:{},output:{accountId:accountA,workspaceId:'pilot',coverage:['US-CT-NEWHAVEN','US-NY-NYC'],limits:{toolRequestsPerHour:120,publicSearchesPerHour:30,publicSearchesPerDay:200,stateRequestsPerHour:240,adminRequestsPerHour:60},sourceSearch:{corpus:'configured',publicWeb:'disabled'}}},
  resolve_property:{input:{address:'120 Broadway',borough:'Manhattan'},output:{candidates:[{bbl,label:'120 Broadway, Manhattan',borough:'Manhattan',address:'120 BROADWAY',confidence:1,version:'26c'}],confirmed:true,note:'Exact match.',source:null,coverage}},
  get_property:{input:{bbl},output:{bbl,parcel:{address:'120 BROADWAY',residfar:10},dataset:{name:'NYC Planning PLUTO',version:'26c',url:'https://data.cityofnewyork.us/pluto'},source:null,coverage}},
  find_nearby_properties:{input:{bbl},sent:{bbl,radiusMeters:150},output:{bbl,radiusMeters:150,records:[],method:'centroid_bounding_box',limit:50,truncated:false,note:'Proximity does not prove adjacency.',source:null,coverage}},
  search:{input:{query:'floor area'},output:{results:[],coverage:{jurisdiction:'US-NY-NYC',corpus:{releasedSourceCount:0,available:false,mode:'lexical'},publicWeb:{enabled:false},exhaustive:false},issues:[]}},
  fetch:{input:{id:sourceId},output:{id:sourceId,title:'Fixture',url:'https://www.nyc.gov/fixture',text:'Untrusted text.',metadata:{kind:'research',jurisdiction:'US-FL-MIAMI',publishedAt:null,effectiveFrom:null,effectiveTo:null,versionId:null,coverageNote:null,textTruncated:false,untrusted:true,observedAt:iso,retrievedAt:iso,lastChecked:null,stale:null}}},
  list_projects:{input:{},output:{projects:[{projectId,title:'120 Broadway',access:'owner',version:3,updated:iso}],nextCursor:null}},
  get_project_state:{input:{projectId},output:stateOutput},
  set_project_assumptions:{input:{projectId,version:3,assumptions},output:stateOutput},
  list_memberships:{input:{},output:{workspaceId:'pilot'}},
};
const membersOf=scopes=>[
  {subject:'google|user-a',accountId:accountA,workspaceId:'pilot',enabled:true,scopes},
  {subject:'google|user-b',accountId:accountB,workspaceId:'pilot',enabled:true,scopes:['acres:read']},
  {subject:'google|other',accountId:'c'.repeat(24),workspaceId:'other',enabled:true,scopes:allScopes},
];
// Fields the gateway owns: effective scopes and the reviewed membership file.
const expected=(tool,scopes=allScopes)=>tool==='get_account'?{...cases[tool].output,capabilities:scopes}
  :tool==='list_memberships'?{...cases[tool].output,members:membersOf(scopes).slice(0,2).map(({subject,accountId,enabled,scopes})=>({subject,accountId,enabled,scopes}))}
  :cases[tool].output;

async function fakeBackend(respond=()=>null) {
  const requests=[];
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const request={method:req.method,path:req.url,headers:req.headers,body:JSON.parse(text)},tool=req.url.split('/').at(-1);requests.push(request);
    const {status=200,payload={...cases[tool].output,requestId:req.headers['x-request-id']}}=respond(tool,request)||{};
    res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload));
  });
  return {server,requests,url:await listen(server)};
}

test('contracts declare one of the four scopes, accurate read-only hints and no literal jurisdiction',()=>{
  assert.deepEqual(Object.keys(contracts).sort(),Object.keys(cases).sort());
  for(const [name,contract] of Object.entries(contracts)) {
    assert.ok(allScopes.includes(contract.scope),name);
    assert.equal(contract.readOnly,name!=='set_project_assumptions',name);
  }
  assert.equal(contracts.list_projects.scope,'acres:state:read');assert.equal(contracts.get_project_state.scope,'acres:state:read');
  assert.equal(contracts.set_project_assumptions.scope,'acres:state:write');assert.equal(contracts.list_memberships.scope,'acres:admin');
  for(const name of ['get_account','resolve_property','get_property','find_nearby_properties','search','fetch'])assert.equal(contracts[name].scope,'acres:read');
  const source=readFileSync(new URL('../src/contracts.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/['"]US-[A-Z]{2}/,'coverage jurisdictions come from the backend registry, not the contract');
  assert.deepEqual(contracts.get_project_state.input.shape.projectId.safeParse(projectId).success,true);
});

test('every tool round-trips its schema and sends the documented private request',async()=>{
  const backend=await fakeBackend(),f=await fixture({backendUrl:backend.url,members:membersOf(allScopes)});
  try {
    const client=await f.connect('google|user-a',{'x-acres-account':accountB,'x-acres-workspace':'other'},{scope:allScopes.join(' ')});
    const {tools}=await client.listTools();
    for(const tool of tools) {
      assert.deepEqual(tool._meta.securitySchemes,[{type:'oauth2',scopes:[contracts[tool.name].scope]}],tool.name);
      assert.equal(tool.annotations.readOnlyHint,contracts[tool.name].readOnly,tool.name);
    }
    for(const [name,{input,sent}] of Object.entries(cases)) {
      assert.deepEqual(await call(client,name,input),expected(name),name);
      const request=backend.requests.at(-1);
      assert.equal(request.method,'POST');assert.equal(request.path,`/mcp-api/tools/${name}`);
      assert.equal(request.headers.authorization,`Bearer ${serviceToken}`);assert.equal(request.headers['x-acres-account'],accountA);assert.equal(request.headers['x-acres-workspace'],'pilot');
      assert.match(request.headers['x-request-id'],/^[a-f0-9-]{36}$/);assert.match(request.headers['content-type'],/^application\/json/);
      assert.deepEqual(request.body,{arguments:sent||input},name);
    }
    assert.equal(backend.requests.length,Object.keys(cases).length);
  } finally {await f.done();await close(backend.server);}
});

test('a tool runs only when both the token and the membership grant its scope; public accounts stay read-only',async()=>{
  const backend=await fakeBackend(),f=await fixture({backendUrl:backend.url,members:membersOf(allScopes),publicAccess:true});
  try {
    const clients={
      tokenLimited:await f.connect('google|user-a',{},{scope:'acres:read'}),
      membershipLimited:await f.connect('google|user-b',{},{scope:allScopes.join(' ')}),
      public:await f.connect('arosa|public-user',{},{scope:allScopes.join(' ')}),
    };
    for(const [kind,client] of Object.entries(clients)) {
      assert.deepEqual((await call(client,'get_account')).capabilities,['acres:read'],kind);
      for(const [name,{input}] of Object.entries(cases)) {
        const scope=contracts[name].scope;
        if(scope==='acres:read'){await call(client,name,input);continue;}
        const before=backend.requests.length,failure=await toolError(client,name,input);
        assert.equal(failure.error.code,'INSUFFICIENT_SCOPE',`${kind} ${name}`);assert.equal(failure.error.scope,scope);assert.match(failure.error.message,new RegExp(scope));
        assert.match(failure._meta['mcp/www_authenticate'][0],new RegExp(`error="insufficient_scope", scope="${scope}"`));
        assert.equal(backend.requests.length,before,'a denied scope never reaches the private service');
      }
    }
    const stateOnly=await f.connect('google|user-a',{},{scope:'acres:state:read'});
    assert.equal((await toolError(stateOnly,'get_account')).error.scope,'acres:read');
    assert.deepEqual((await call(stateOnly,'get_project_state',{projectId})).fields,stateFields);
    const listed=await call(await f.connect('google|user-a',{},{scope:'acres:admin'}),'list_memberships');
    assert.deepEqual(listed.members.map(m=>m.subject),['google|user-a','google|user-b'],'only the caller workspace is listed');
    const none=await fetch(f.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+await f.token('google|user-b',{scope:'acres:admin'}),'content-type':'application/json'},body:'{}'});
    assert.equal(none.status,403,'no effective scope at all is refused at the transport');assert.match(none.headers.get('www-authenticate'),/insufficient_scope/);
  } finally {await f.done();await close(backend.server);}
});

test('private service failures map to safe, specific errors for every tool',async()=>{
  let failure=null;
  const backend=await fakeBackend((tool,request)=>failure?.(tool,request)),f=await fixture({backendUrl:backend.url,members:membersOf(allScopes)});
  try {
    const client=await f.connect('google|user-a',{},{scope:allScopes.join(' ')});
    const scenarios=[
      ['QUOTA_EXCEEDED',()=>({status:429,payload:{error:{code:'QUOTA_EXCEEDED',message:'private detail'}}}),/limit has been reached/],
      ['BACKEND_UNAVAILABLE',()=>({status:500,payload:{error:{code:'SECRET_INTERNAL_CODE',message:'private detail'}}}),/could not complete/],
      ['INVALID_BACKEND_RESPONSE',(tool)=>({payload:{...cases[tool].output,requestId:'0'.repeat(36)}}),/could not complete/],
      ['INVALID_BACKEND_RESPONSE',(tool,request)=>({payload:{...Object.fromEntries(Object.entries(cases[tool].output).slice(1)),requestId:request.headers['x-request-id']}}),/could not complete/],
    ];
    for(const [code,respond,message] of scenarios) {
      failure=respond;
      for(const [name,{input}] of Object.entries(cases)) {
        const result=await toolError(client,name,input);
        assert.equal(result.error.code,code,`${code} ${name}`);assert.match(result.error.message,message);assert.doesNotMatch(JSON.stringify(result),/private detail|SECRET_INTERNAL/);assert.match(result.requestId,/^[a-f0-9-]{36}$/);
      }
    }
    failure=()=>({status:404,payload:{error:{code:'PROJECT_NOT_FOUND'}}});
    for(const name of ['get_project_state','set_project_assumptions'])assert.equal((await toolError(client,name,cases[name].input)).error.code,'PROJECT_NOT_FOUND');
    for(const [code,status,message] of [['VERSION_CONFLICT',409,/changed since it was read/],['PROJECT_READ_ONLY',403,/read but not change/]]) {
      failure=()=>({status,payload:{error:{code}}});
      const result=await toolError(client,'set_project_assumptions',cases.set_project_assumptions.input);assert.equal(result.error.code,code);assert.match(result.error.message,message);
    }
    failure=()=>({status:501,payload:{error:{code:'NOT_IMPLEMENTED'}}});
    assert.match((await toolError(client,'set_project_assumptions',cases.set_project_assumptions.input)).error.message,/not available yet/);
    failure=null;
    const before=backend.requests.length;
    for(const [name,args] of [['get_project_state',{projectId:'../conversations'}],['set_project_assumptions',{projectId,version:3,assumptions:{}}],['set_project_assumptions',{projectId,version:3,assumptions:{capRate:0.5}}],['set_project_assumptions',{projectId,version:3,assumptions:{financing:{termMonths:1.5}}}],['set_project_assumptions',{projectId,version:3,assumptions:{landPrice:1,owner:accountB}}],['set_project_assumptions',{projectId,assumptions:{landPrice:1}}],['list_memberships',{workspaceId:'other'}]]) {
      let result;
      try {result=await client.callTool({name,arguments:args});}catch(error){assert.match(error.message,/invalid|validation/i);continue;}
      assert.equal(result.isError,true,`${name} must reject ${JSON.stringify(args)}`);
    }
    assert.equal(backend.requests.length,before,'invalid inputs never reach the private service');
  } finally {await f.done();await close(backend.server);}
});

test('the private service serves registry coverage and per-field project state, and applies versioned assumption writes',async()=>{
  const members=membersOf(allScopes);members[1].scopes=['acres:read','acres:state:read','acres:state:write'];
  const f=await fixture({state:true,members});
  try {
    const conversation=f.chat.createConversation(accountA),project=f.chat.projectOf(conversation.id);
    f.chat.project.write(project,{property:{value:{bbl},provenance:{tool:'acres_set_subject',run:null,sources:[]}}},Date.parse(iso));
    const a=await f.connect('google|user-a',{},{scope:allScopes.join(' ')}),b=await f.connect('google|user-b',{},{scope:allScopes.join(' ')});
    const account=await call(a,'get_account');
    for(const code of ['US-NY-NYC','US-FL-MIAMI','US-CT-NEWHAVEN'])assert.ok(account.coverage.includes(code),code);
    assert.deepEqual(account.capabilities,allScopes);
    assert.equal((await call(a,'resolve_property',{address:'120 Broadway',borough:'Manhattan'})).coverage.jurisdiction,'US-NY-NYC');
    const {projects}=await call(a,'list_projects');assert.deepEqual(projects.map(p=>p.projectId),[project]);assert.equal(projects[0].access,'owner');
    const state=await call(a,'get_project_state',{projectId:project});
    assert.deepEqual(Object.keys(state.fields),['property'],'fields not produced yet are omitted');
    assert.deepEqual(state.fields.property,{value:{bbl},provenance:{tool:'acres_set_subject',run:null,sources:[]},stale:null,updated:iso});
    assert.equal(state.version,projects[0].version);
    assert.equal((await toolError(b,'get_project_state',{projectId:project})).error.code,'PROJECT_NOT_FOUND');
    assert.equal((await toolError(b,'set_project_assumptions',{projectId:project,version:state.version,assumptions})).error.code,'PROJECT_NOT_FOUND');
    const written=await call(a,'set_project_assumptions',{projectId:project,version:state.version,assumptions});
    assert.deepEqual(written.fields.assumptions.value,assumptions);assert.equal(written.fields.assumptions.provenance.tool,'user');assert.ok(written.version>state.version);
    assert.deepEqual((await call(a,'get_project_state',{projectId:project})).fields.assumptions.value,assumptions);
    assert.equal((await toolError(a,'set_project_assumptions',{projectId:project,version:state.version,assumptions:{capRate:0.06}})).error.code,'VERSION_CONFLICT','a stale version never overwrites');
    assert.equal((await call(a,'list_memberships')).workspaceId,'pilot');
  } finally {await f.done();}
});

test('membership rows default to acres:read and reject unknown or repeated scopes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-scopes-')),path=join(dir,'memberships.json');
  const row={subject:'google|user-a',accountId:accountA,workspaceId:'pilot',enabled:true};
  try {
    writeFileSync(path,JSON.stringify([row]));assert.deepEqual(readMemberships(path)[0].scopes,['acres:read']);
    writeFileSync(path,JSON.stringify([{...row,scopes:['acres:read','acres:admin']}]));assert.deepEqual(readMemberships(path)[0].scopes,['acres:read','acres:admin']);
    for(const scopes of [['acres:write'],[],['acres:read','acres:read']]) {
      writeFileSync(path,JSON.stringify([{...row,scopes}]));assert.throws(()=>readMemberships(path),/invalid/,JSON.stringify(scopes));
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
