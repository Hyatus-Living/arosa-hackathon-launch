import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {workspaceClaim} from '../dist/auth.js';
import {providerJson} from '../../acres-research/public-http.mjs';
import {request as httpRequest} from 'node:http';
import {fixture,call,accountA,accountB,serviceToken} from './fixture.mjs';

test('real Streamable HTTP exposes the reviewed tools, schemas, annotations and account identity',async()=>{
  const f=await fixture();
  try {
    const client=await f.connect('google|user-a',{'x-acres-account':accountB,'x-acres-workspace':'forged'});
    const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name).sort(),['fetch','find_nearby_properties','get_account','get_project_state','get_property','list_memberships','list_projects','resolve_property','search','set_project_assumptions']);
    for(const tool of tools){assert.equal(tool.annotations.readOnlyHint,tool.name!=='set_project_assumptions');assert.equal(tool.annotations.destructiveHint,false);assert.equal(typeof tool.annotations.openWorldHint,'boolean');assert.equal(tool.inputSchema.additionalProperties,false);assert.ok(tool.outputSchema);assert.equal(tool._meta.securitySchemes.length,1);}
    const account=await call(client,'get_account');assert.equal(account.accountId,accountA);assert.equal(account.workspaceId,'pilot');
    const candidates=await call(client,'resolve_property',{address:'120 bway downtown Manhattan',borough:'Manhattan'});assert.equal(candidates.candidates.length,2);assert.equal(candidates.confirmed,false);
    const property=await call(client,'get_property',{bbl:'1000477501'});assert.equal(property.dataset.version,'26c');assert.equal(property.parcel.address,'120 BROADWAY');
    const nearby=await call(client,'find_nearby_properties',{bbl:'1000477501'});assert.equal(nearby.method,'centroid_bounding_box');assert.equal(nearby.radiusMeters,150);assert.match(nearby.note,/does not prove adjacency/);
    const source=await call(client,'fetch',{id:property.source.id});assert.match(source.text,/120 BROADWAY/);assert.equal(source.metadata.untrusted,true);
    assert.ok(f.logs.some(x=>x.event==='mcp_tool_completed'));
    assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(serviceToken));assert.doesNotMatch(JSON.stringify(f.logs),/120 bway/);
  } finally {await f.done();}
});

test('released corpus search/fetch survives reconnect and both server restarts; other accounts cannot fetch it',async()=>{
  const f=await fixture();
  try {
    const a=await f.connect(),b=await f.connect('google|user-b');
    const search=await call(a,'search',{query:'floor area zoning'});assert.equal(search.results.length,1);assert.equal(search.results[0].title,'NYC zoning fixture');assert.equal(search.coverage.exhaustive,false);
    const id=search.results[0].id,source=await call(a,'fetch',{id});assert.equal(source.metadata.publishedAt,null);assert.equal(source.metadata.untrusted,true);assert.equal(source.metadata.stale,false);assert.ok(source.metadata.lastChecked);assert.match(source.text,/Untrusted document/);
    const denied=await b.callTool({name:'fetch',arguments:{id}});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/SOURCE_NOT_FOUND/);
    await f.restart();const reconnected=await f.connect();const restored=await call(reconnected,'fetch',{id});assert.equal(restored.text,source.text);assert.equal(restored.metadata.retrievedAt,source.metadata.retrievedAt);
    const repeated=await call(reconnected,'search',{query:'floor area zoning'});assert.equal(repeated.results[0].id,id);
  } finally {await f.done();}
});

test('OAuth discovery and signed-token enforcement reject missing, expired, wrong-audience and uninvited access',async()=>{
  const f=await fixture();
  try {
    const metadata=await (await fetch(f.base+'/.well-known/oauth-protected-resource/mcp')).json();assert.equal(metadata.resource,f.config.resourceUrl);assert.deepEqual(metadata.scopes_supported,['acres:read','acres:state:read','acres:state:write','acres:admin']);
    const request=async token=>fetch(f.base+'/mcp',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:'{}'});
    assert.equal((await request()).status,401);
    const signed=await f.token(),parts=signed.split('.');parts[1]=Buffer.from(JSON.stringify({sub:'google|user-b',scope:'acres:read'})).toString('base64url');
    assert.equal((await request(parts.join('.'))).status,401);
    for(const claims of [{aud:'https://wrong.example/mcp'},{iss:'https://wrong.example/'},{exp:Math.floor(Date.now()/1000)-60},{exp:Math.floor(Date.now()/1000)+3600}]) {
      const response=await request(await f.token('google|user-a',claims));assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/resource_metadata/);
    }
    const noScope=await request(await f.token('google|user-a',{scope:'other:read'}));assert.equal(noScope.status,403);assert.match(noScope.headers.get('www-authenticate'),/insufficient_scope/);
    assert.equal((await request(await f.token('google|uninvited'))).status,403);
    f.members[0].enabled=false;assert.equal((await request(await f.token())).status,403);
    assert.equal((await fetch(f.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+await f.token('google|user-b'),origin:'https://evil.example','content-type':'application/json'},body:'{}'})).status,403);
    const backend=f.config.backendUrl;
    assert.equal((await fetch(backend+'/mcp-api/tools/get_account',{method:'POST',headers:{authorization:'Bearer web-only-test','content-type':'application/json'},body:'{"arguments":{}}'})).status,401);
    assert.equal((await fetch(backend+'/conversations',{headers:{authorization:'Bearer '+serviceToken,'x-acres-account':accountA}})).status,401);
    const malformed=await new Promise((resolve,reject)=>{const req=httpRequest(backend,{path:'http://[',method:'GET'},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(malformed,400);
  } finally {await f.done();}
});

test('public access provisions isolated self-service accounts and serves the OpenAI challenge token',async()=>{
  const f=await fixture({publicAccess:true,openaiChallengeToken:'fixture-challenge-token'});
  try {
    const challenge=await fetch(f.base+'/.well-known/openai-apps-challenge');
    assert.equal(challenge.status,200);assert.match(challenge.headers.get('content-type'),/^text\/plain/);
    assert.equal(await challenge.text(),'fixture-challenge-token');
    const one=await f.connect('arosa|public-one'),two=await f.connect('arosa|public-two');
    const a=await call(one,'get_account'),b=await call(two,'get_account');
    assert.match(a.accountId,/^[a-f0-9]{24}$/);assert.equal(a.workspaceId,'public');
    assert.notEqual(a.accountId,b.accountId);
    const again=await call(await f.connect('arosa|public-one'),'get_account');assert.equal(again.accountId,a.accountId,'subject mapping is deterministic');
    const property=await call(one,'get_property',{bbl:'1000477501'});
    const denied=await two.callTool({name:'fetch',arguments:{id:property.source.id}});assert.equal(denied.isError,true);
    assert.equal((await call(await f.connect(),'get_account')).accountId,accountA,'reviewed memberships keep precedence');
    f.members[0].enabled=false;
    assert.equal((await fetch(f.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+await f.token(),'content-type':'application/json'},body:'{}'})).status,403,'a disabled membership is denied, not demoted to public');
  } finally {await f.done();}
  const closed=await fixture();
  try {assert.equal((await fetch(closed.base+'/.well-known/openai-apps-challenge')).status,404);} finally {await closed.done();}
});

test('invalid inputs, generic integration operations and arbitrary URLs cannot invoke domain operations',async()=>{
  let requests=0;const f=await fixture({request:async()=>{requests++;return [];}});
  try {
    const client=await f.connect();
    for(const [name,args] of [['get_account',{accountId:accountB}],['get_property',{bbl:"1' OR 1=1"}],['resolve_property',{address:'Boston',borough:'Boston'}],['find_nearby_properties',{bbl:'1000477501',radiusMeters:1000}],['fetch',{id:'https://169.254.169.254/'}],['acres_execute_tool',{slug:'GMAIL_SEND_EMAIL',arguments:{}}]]) {
      // SDK versions can report validation errors as a tool error or a JSON-RPC
      // rejection. Both must fail before any domain/provider operation runs.
      let result;
      try {result=await client.callTool({name,arguments:args});}catch(error){assert.match(error.message,/invalid|not found|validation/i);continue;}
      assert.equal(result.isError,true,`${name} must reject ${JSON.stringify(args)}`);
    }
    assert.equal(requests,0);
  } finally {await f.done();}
});

test('coverage gaps and provider failure are explicit partial results, without leaking error details',async()=>{
  const f=await fixture({release:false,searchWeb:async()=>{throw new Error('Bearer private-provider-secret');},request:()=>providerJson('https://provider.example',{},async()=>new Response('private-provider-secret',{status:429}))});
  try {
    const client=await f.connect(),result=await call(client,'search',{query:'zoning'});
    assert.deepEqual(result.results,[]);assert.deepEqual(result.issues.map(x=>x.code),['CORPUS_UNRELEASED','PROVIDER_UNAVAILABLE']);assert.equal(result.coverage.exhaustive,false);
    assert.doesNotMatch(JSON.stringify(result)+JSON.stringify(f.logs),/private-provider-secret/);
    const limited=await client.callTool({name:'get_property',arguments:{bbl:'1000477501'}});assert.equal(limited.isError,true);assert.match(limited.content[0].text,/PROVIDER_RATE_LIMITED/);assert.doesNotMatch(limited.content[0].text,/private-provider-secret/);
  } finally {await f.done();}
});

test('workspace switching requires a signed claim and does not transfer evidence',async()=>{
  const f=await fixture();
  try {
    const a=await f.connect();const source=(await call(a,'search',{query:'floor area'})).results[0];await a.close();
    f.members.push({subject:'google|user-a',accountId:accountA,workspaceId:'second',enabled:true,scopes:['acres:read']});
    const denied=await fetch(f.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+await f.token(),'content-type':'application/json'},body:'{}'});assert.equal(denied.status,403);
    const client=new Client({name:'workspace-test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+await f.token('google|user-a',{[workspaceClaim]:'second'})}}});
    await client.connect(transport);
    try {assert.equal((await call(client,'get_account')).workspaceId,'second');const result=await client.callTool({name:'fetch',arguments:{id:source.id}});assert.equal(result.isError,true);}
    finally {await client.close();}
  } finally {await f.done();}
});
