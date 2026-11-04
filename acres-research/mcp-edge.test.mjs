import test from 'node:test';
import assert from 'node:assert/strict';
import edge from '../infra/acres-mcp-edge.mjs';

test('MCP edge pins its origin, forwards OAuth and preserves upstream challenges',async()=>{
  const prior=global.fetch,calls=[];
  global.fetch=async(request,options)=>{calls.push({url:request.url,authorization:request.headers.get('authorization'),origin:request.headers.get('origin'),host:request.headers.get('host'),body:request.method==='POST'?await request.text():null,redirect:options.redirect});return new Response('denied',{status:401,headers:{'www-authenticate':'Bearer resource_metadata="https://mcp.witharosa.ai/.well-known/oauth-protected-resource/mcp"'}});};
  try {
    const env={UPSTREAM_ORIGIN:'https://acres-mcp-125672997221.us-central1.run.app'};
    for(const path of ['/mcp','//evil.example/mcp']) {
      const response=await edge.fetch(new Request('https://mcp.witharosa.ai'+path,{method:'POST',headers:{authorization:'Bearer fixture',origin:'https://chatgpt.com',host:'mcp.witharosa.ai'},body:'{"jsonrpc":"2.0"}'}),env);
      assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/resource_metadata/);
      const last=calls.at(-1);assert.equal(new URL(last.url).origin,env.UPSTREAM_ORIGIN);assert.equal(last.authorization,'Bearer fixture');assert.equal(last.origin,'https://chatgpt.com');assert.equal(last.host,null);assert.equal(last.body,'{"jsonrpc":"2.0"}');assert.equal(last.redirect,'manual');
    }
    const n=calls.length;assert.equal((await edge.fetch(new Request('https://other.hyatus.com/mcp'),env)).status,404);assert.equal(calls.length,n);
  } finally {global.fetch=prior;}
});
