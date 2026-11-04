import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {gzipSync,deflateSync,brotliCompressSync} from 'node:zlib';
import * as policy from './public-url.mjs';
import {createUrlFetcher} from './fetch-url.mjs';
import {fetchDrawing,pinnedRequest as drawingRequest} from './architecture-drawings.mjs';
const publicRecords=[{address:'93.184.216.34',family:4}];
const publicLookup=async()=>publicRecords;
const html='<html><main><p>'+'Fixture public source. '.repeat(30)+'</p></main></html>';
const secrets={CLOUDFLARE_ACCOUNT_ID:'fixture-account',CLOUDFLARE_API_TOKEN:'fixture-credential'};
const response=(status=200,headers={'content-type':'text/html'},bytes=Buffer.from(html))=>{
  const body={closed:false,destroy(){this.closed=true;},async *[Symbol.asyncIterator](){yield bytes;}};
  return {status,ok:status>=200&&status<300,headers:new Headers(headers),body};
};
const denied=error=>{assert.equal(error.code,'PUBLIC_DESTINATION_DENIED');assert.equal(error.retryable,false);return true;};
const fixture=(directRequest,extra={})=>createUrlFetcher({}, {directRequest,lookup:publicLookup,...extra});

test('private, mapped, expanded, multicast and reserved addresses remain outside the public boundary',()=>{
  const blocked=['10.0.0.1','127.0.0.1','169.254.169.254','::ffff:a00:1','0:0:0:0:0:0:0:1','ff02::1','2001:db8::1','192.0.2.4','198.51.100.2','203.0.113.4','not-an-address','::ffff:127.0.0.1','fc00::1','64:ff9b::a00:1','2002:0a00:0001::'];
  assert.deepEqual(blocked.filter(address=>!policy.isPrivateAddress(address)),[]);
});
test('ordinary public IPv4 and IPv6 destinations remain usable',()=>{
  for(const address of ['8.8.8.8','1.1.1.1','93.184.216.34','2606:4700:4700::1111','2001:4860:4860::8888','::ffff:93.184.216.34'])assert.equal(policy.isPrivateAddress(address),false,address);
  assert.equal(policy.publicUrl('https://example.com/page#section'),true);
});
test('local host suffixes with a trailing DNS dot cannot bypass URL validation',()=>{
  for(const url of ['https://box.internal./x','https://box.local./x','https://localhost./x','https://127.1/x','https://0x7f000001/x','https://user:password@example.com/x'])assert.equal(policy.publicUrl(url),false,url);
});
test('the default DNS resolver is actually consulted and blocks a private destination',async t=>{
  const lookup=t.mock.method(dns,'lookup',async()=>[{address:'10.0.0.5',family:4}]);
  await assert.rejects(policy.assertPublicDns('private.example.com'),denied);assert.equal(lookup.mock.calls.length,1);
});
test('an explicit null resolver cannot disable the public DNS check',async()=>{
  await assert.rejects(policy.assertPublicDns('private.example.com',null),/resolver|required/i);
});
test('one private answer among public DNS answers rejects the complete destination',async()=>{
  await assert.rejects(policy.assertPublicDns('mixed.example.com',async()=>[...publicRecords,{address:'::ffff:a00:1',family:6}]),denied);
});
test('empty and malformed DNS answers fail closed',async()=>{
  for(const records of [[],[{address:'not-an-ip'}],[{}]])await assert.rejects(policy.assertPublicDns('invalid.example.com',async()=>records),/private|reserved|DNS/i);
});
test('default direct source retrieval cannot skip DNS validation',async t=>{
  t.mock.method(dns,'lookup',async()=>[{address:'10.0.0.5',family:4}]);
  const http=t.mock.method(globalThis,'fetch',async()=>response());
  await assert.rejects(createUrlFetcher({})({url:'https://private.example.com/page'}),denied);assert.equal(http.mock.calls.length,0);
});
test('a private source is rejected before a remote renderer is called',async t=>{
  t.mock.method(dns,'lookup',async()=>[{address:'10.0.0.5',family:4}]);
  const http=t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,headers:new Headers(),json:async()=>({success:true,result:'# Fixture\n\n'+'Source text. '.repeat(30)})}));
  await assert.rejects(createUrlFetcher(secrets)({url:'https://private.example.com/page'}),denied);assert.equal(http.mock.calls.length,0);
});
test('direct source transport receives the validated DNS pool instead of resolving the name again',async()=>{
  let resolutions=0,seen;
  const fetcher=fixture(async(url,options)=>{seen={url,records:await options.lookup('public.example.com')};return response();}, {lookup:async()=>++resolutions===1?publicRecords:[{address:'10.0.0.5',family:4}]});
  const out=await fetcher({url:'https://public.example.com/page'});
  assert.equal(out.method,'direct');assert.equal(resolutions,1);assert.deepEqual(seen.records,publicRecords);assert.match(out.text,/Fixture public source/);
});
test('a private redirect is blocked and the preceding response body is released',async()=>{
  const first=response(302,{location:'https://internal.example.com/private'}),calls=[];
  const fetcher=fixture(async url=>{calls.push(url);return first;},{lookup:async host=>host==='internal.example.com'?[{address:'10.0.0.5',family:4}]:publicRecords});
  await assert.rejects(fetcher({url:'https://public.example.com/start'}),denied);assert.deepEqual(calls,['https://public.example.com/start']);assert.equal(first.body.closed,true);
});
test('a busy renderer cannot retry around a known private-redirect denial',async()=>{
  const calls={render:0,direct:0};
  const request=async()=>{calls.render++;return {ok:false,status:429,headers:new Headers(),json:async()=>({success:false,errors:[{message:'Browser is too busy'}]})};};
  const directRequest=async()=>{calls.direct++;return response(302,{location:'https://127.0.0.1/private'});};
  await assert.rejects(createUrlFetcher(secrets,{request,directRequest,lookup:publicLookup})({url:'https://public.example.com/start'}),denied);
  assert.deepEqual(calls,{render:1,direct:1});
});
test('redirect limits release every response and stop issuing requests',async()=>{
  const replies=[];const fetcher=fixture(async()=>{const reply=response(302,{location:'/loop'});replies.push(reply);return reply;});
  await assert.rejects(fetcher({url:'https://public.example.com/start'}),/redirects/i);
  assert.equal(replies.length,5);assert.equal(replies.every(reply=>reply.body.closed),true);
});
test('failed and oversized source bodies are released before reporting the error',async()=>{
  for(const [reply,message] of [[response(503),/HTTP 503/],[response(200,{},Buffer.alloc(8*1024*1024+1)),/8 MB/]]){
    await assert.rejects(fixture(async()=>reply)({url:'https://public.example.com/page'}),message);assert.equal(reply.body.closed,true);
  }
});
test('the pinned connector preserves the original TLS target and uses only its vetted address pool',async()=>{
  assert.equal(typeof policy.pinnedRequest,'function');
  const target=new URL('https://public.example.com/page');let resolutions=0,captured;
  const lookup=async()=>{resolutions++;target.hostname='127.0.0.1';return publicRecords;};
  const connect=(url,options,onResponse)=>{
    captured={url,options};const req=new EventEmitter();
    options.lookup('public.example.com',{all:true},(error,records)=>{
      assert.ifError(error);assert.deepEqual(records,publicRecords);
      const res=Readable.from([Buffer.from('public body')]);res.statusCode=200;res.headers={'content-type':'text/plain'};onResponse(res);
    });return req;
  };
  const out=await policy.pinnedRequest(target,{lookup,connect});
  assert.equal(captured.url,'https://public.example.com/page');assert.equal(captured.options.agent,false);assert.equal(captured.options.rejectUnauthorized,true);assert.equal(out.status,200);
  await new Promise((resolve,reject)=>captured.options.lookup('public.example.com',{},(error,address,family)=>{if(error)return reject(error);assert.equal(address,publicRecords[0].address);assert.equal(family,4);resolve();}));
  assert.equal(resolutions,1);
});
test('a blocked DNS pool never reaches the connector',async()=>{
  assert.equal(typeof policy.pinnedRequest,'function');let calls=0;
  await assert.rejects(policy.pinnedRequest('https://private.example.com/page',{lookup:async()=>[{address:'::ffff:a00:1',family:6}],connect:()=>{calls++;}}),denied);assert.equal(calls,0);
});
test('drawing downloads share the same connector and reject mapped private DNS answers',async()=>{
  let calls=0;
  await assert.rejects(fetchDrawing('https://private.example.com/plan.png',{lookup:async()=>[{address:'::ffff:a00:1',family:6}],request:async()=>{calls++;return response(200,{'content-type':'image/png'},Buffer.from('fixture'));}}),denied);
  assert.equal(calls,0);assert.equal(drawingRequest,policy.pinnedRequest);
});

test('compressed and layered HTTP source content remains readable after the native transport change',async()=>{
  const url='https://public.example.com/encoded',plain=Buffer.from(html);
  const expected=(await fixture(async()=>response())({url})).text;
  for(const [encoding,bytes] of [['gzip',gzipSync(plain)],['deflate',deflateSync(plain)],['br',brotliCompressSync(plain)],['gzip, br',brotliCompressSync(gzipSync(plain))]]){
    const out=await fixture(async()=>response(200,{'content-type':'text/html','content-encoding':encoding},bytes))({url});
    assert.equal(out.text,expected,encoding);
  }
});
test('the source size cap applies to decompressed content and releases the wire stream',async()=>{
  const raw=Readable.from([gzipSync(Buffer.alloc(8*1024*1024+1,0x61))]);
  const reply=response(200,{'content-type':'text/plain','content-encoding':'gzip'});reply.body=raw;
  await assert.rejects(fixture(async()=>reply)({url:'https://public.example.com/large'}),/8 MB/);
  await new Promise(setImmediate);assert.equal(raw.destroyed,true);
});
test('unsupported or corrupt HTTP coding cannot become a usable source',async()=>{
  for(const coding of ['unsupported','__proto__']){
    const reply=response(200,{'content-type':'text/html','content-encoding':coding});
    await assert.rejects(fixture(async()=>reply)({url:'https://public.example.com/invalid'}),/encoding/i);assert.equal(reply.body.closed,true);
  }
  const raw=Readable.from([Buffer.from(html)]),reply=response(200,{'content-type':'text/html','content-encoding':'gzip'});reply.body=raw;
  await assert.rejects(fixture(async()=>reply)({url:'https://public.example.com/corrupt'}),/header|compression/i);
  await new Promise(setImmediate);assert.equal(raw.destroyed,true);
});
test('drawing transfer coding is decoded before the bytes reach file handling',async()=>{
  const bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  const reply=response(200,{'content-type':'image/svg+xml','content-encoding':'gzip'},gzipSync(bytes));
  const out=await fetchDrawing('https://public.example.com/plan.svg',{lookup:publicLookup,request:async()=>reply});
  assert.deepEqual(out.bytes,bytes);assert.equal(out.contentType,'image/svg+xml');
});
