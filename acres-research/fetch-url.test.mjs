import test from 'node:test';
import assert from 'node:assert/strict';
import {createUrlFetcher,cloudflareConfigured,cleanFetchedMarkdown,staticHtmlHosts,STATIC_HTML_HOSTS} from './fetch-url.mjs';
import {BillingError} from './wallet.mjs';

const cfSecrets={CLOUDFLARE_ACCOUNT_ID:'account-12345678',CLOUDFLARE_API_TOKEN:'token-1234567890'};
const fixtureFetcher=(secrets,request,options={})=>createUrlFetcher(secrets,{request,directRequest:request,lookup:async()=>[{address:'93.184.216.34',family:4}],...options});

test('direct-first experiment preserves static facts but a long HTML shell can omit operative rendered text',async()=>{
  const staticText='Static operative zoning provision. '.repeat(20),shell='Public guidance introduction and navigation context. '.repeat(20),operative='SPECIAL-OPERATIVE-RULE';
  for(const dynamic of [false,true]){
    let rendered=0,direct=0;
    const request=async url=>{
      if(String(url).includes('cloudflare')){rendered++;return {ok:true,status:200,headers:{get:()=>null},json:async()=>({success:true,result:dynamic?`${shell}\n${operative}`:staticText})};}
      direct++;return {ok:true,status:200,headers:{get:key=>key==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(`<html><body><main>${dynamic?shell:staticText}</main></body></html>`);})()};
    };
    const staticRead=await fixtureFetcher({},request)({url:'https://www.nyc.gov/fixture'});
    const renderedRead=await fixtureFetcher(cfSecrets,request)({url:'https://www.nyc.gov/fixture'});
    assert.equal(direct,1);assert.equal(rendered,1);assert.ok(staticRead.text.length>200);
    if(dynamic){assert.doesNotMatch(staticRead.text,/SPECIAL-OPERATIVE-RULE/);assert.match(renderedRead.text,/SPECIAL-OPERATIVE-RULE/);}
    else assert.equal(staticRead.text,renderedRead.text);
    assert.equal(renderedRead.method,'cloudflare-markdown');
  }
});

test('cloudflare markdown is preferred and browser time is reported',async()=>{
  let seen;
  const fetchUrl=fixtureFetcher(cfSecrets,async(url,options)=>{
    seen={url,options};
    return {ok:true,status:200,headers:{get:k=>k==='x-browser-ms-used'?'2400':null},json:async()=>({success:true,result:'# Zoning Resolution\n\n'+'Operative text. '.repeat(30)})};
  });
  const out=await fetchUrl({url:'https://www.nyc.gov/zr'});
  assert.match(seen.url,/browser-run\/markdown$/);
  assert.equal(seen.options.headers.authorization,'Bearer token-1234567890');
  assert.equal(JSON.parse(seen.options.body).url,'https://www.nyc.gov/zr');
  assert.equal(out.method,'cloudflare-markdown');assert.equal(out.browserMs,2400);assert.equal(out.title,'Zoning Resolution');
  assert.equal(cloudflareConfigured(cfSecrets),true);assert.equal(cloudflareConfigured({}),false);
});

test('falls back to direct fetch when cloudflare fails, and rejects non-public URLs before any request',async()=>{
  let calls=0;
  const html='<html><head><title>T</title></head><body><main><p>'+'Direct paragraph text. '.repeat(20)+'</p></main></body></html>';
  const request=async(url)=>{
    calls++;
    if(String(url).includes('cloudflare'))return {ok:false,status:502,headers:{get:()=>null},json:async()=>({success:false,errors:[{message:'render failed'}]})};
    return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(html);})()};
  };
  const fetchUrl=fixtureFetcher(cfSecrets,request);
  const out=await fetchUrl({url:'https://www.nyc.gov/page'});
  assert.equal(out.method,'direct');assert.match(out.text,/Direct paragraph/);
  const before=calls;
  await assert.rejects(fetchUrl({url:'https://127.0.0.1/secret'}),/public HTTPS/);
  assert.equal(calls,before);
});

test('cleanFetchedMarkdown strips NYC Zoning Resolution Drupal navigationChrome and rejects soft-404 / block pages',()=>{
  const rawZr='[Skip to main content](#main-content)\n\n' + '* [Article I](https://zr.planning.nyc.gov/article-i)\n'.repeat(300) + '## Breadcrumb\n\n1. [Home](/) \n\n# Chapter 3: Bulk Regulations\n\n23-22 Maximum Floor Area Ratio.';
  const cleaned=cleanFetchedMarkdown(rawZr,'https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-22');
  assert.doesNotMatch(cleaned,/Skip to main content/);
  assert.match(cleaned,/23-22 Maximum Floor Area Ratio/);
  assert.ok(cleaned.length < 500, 'navigation tree must be stripped from ZR markdown');

  assert.throws(
    ()=>cleanFetchedMarkdown('# Page not found | Zoning Resolution\n\nThe requested page could not be found.','https://zr.planning.nyc.gov/article-vii/chapter-4/74-79'),
    /blocking or not-found/
  );
  assert.throws(
    ()=>cleanFetchedMarkdown('# Sorry, you have been blocked\n\nCloudflare Ray ID','https://www.nyc.gov/site/planning/index.page'),
    /blocking or not-found/
  );
});


function busyThenRequest({cloudflare,direct}){
  const calls={cloudflare:0,direct:0};
  const html='<html><head><title>T</title></head><body><main><p>'+'Direct paragraph text. '.repeat(20)+'</p></main></body></html>';
  const request=async url=>{
    if(String(url).includes('cloudflare')){
      const outcome=cloudflare[calls.cloudflare++];
      if(outcome==='busy')return {ok:false,status:429,headers:{get:()=>null},json:async()=>({success:false,errors:[{message:'Browser is too busy, please retry later'}]})};
      if(outcome==='fail')return {ok:false,status:502,headers:{get:()=>null},json:async()=>({success:false,errors:[{message:'render failed'}]})};
      return {ok:true,status:200,headers:{get:()=>null},json:async()=>({success:true,result:'# Rendered\n\n'+'Rendered text. '.repeat(30)})};
    }
    calls.direct++;
    if(direct==='fail')return {ok:false,status:503,headers:{get:()=>null}};
    return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(html);})()};
  };
  return {request,calls};
}

test('cloudflare "too busy" falls to direct fetch immediately without a second render',async()=>{
  const {request,calls}=busyThenRequest({cloudflare:['busy'],direct:'ok'});
  const out=await fixtureFetcher(cfSecrets,request)({url:'https://www.nyc.gov/page'});
  assert.equal(out.method,'direct');
  assert.deepEqual(calls,{cloudflare:1,direct:1});
});

test('cloudflare "too busy" with a failed direct fetch retries cloudflare once',async()=>{
  const {request,calls}=busyThenRequest({cloudflare:['busy','ok'],direct:'fail'});
  const out=await fixtureFetcher(cfSecrets,request)({url:'https://www.nyc.gov/page'});
  assert.equal(out.method,'cloudflare-markdown');
  assert.deepEqual(calls,{cloudflare:2,direct:1});
});

test('a busy failure that persists is marked retryable; a hard render failure is not retried',async()=>{
  const busy=busyThenRequest({cloudflare:['busy','busy'],direct:'fail'});
  const busyError=await fixtureFetcher(cfSecrets,busy.request)({url:'https://www.nyc.gov/page'}).catch(e=>e);
  assert.equal(busyError.retryable,true);
  assert.equal(busy.calls.cloudflare,2);
  const hard=busyThenRequest({cloudflare:['fail'],direct:'fail'});
  const hardError=await fixtureFetcher(cfSecrets,hard.request)({url:'https://www.nyc.gov/page'}).catch(e=>e);
  assert.equal(hard.calls.cloudflare,1);
  assert.equal(hardError.retryable,false);
});

test('a heading that is a markdown link is stored as its plain text title',async()=>{
  const fetchUrl=fixtureFetcher(cfSecrets,async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({success:true,result:'# [Chapter 18:14 Short-Term Rentals](https://ecode360.com/36690277#36690277)\n\n'+'Operative text. '.repeat(30)})}));
  const out=await fetchUrl({url:'https://ecode360.com/36690277'});
  assert.equal(out.title,'Chapter 18:14 Short-Term Rentals');
});

function staticHostRequest({directBody,rendered='# Rendered\n\n'+'Rendered text. '.repeat(30)}){
  const calls={cloudflare:0,direct:0};
  const request=async url=>{
    if(String(url).includes('cloudflare')){
      calls.cloudflare++;
      if(rendered==='busy')return {ok:false,status:429,headers:{get:()=>null},json:async()=>({success:false,errors:[{message:'Browser is too busy, please retry later'}]})};
      return {ok:true,status:200,headers:{get:()=>null},json:async()=>({success:true,result:rendered})};
    }
    calls.direct++;
    if(typeof directBody==='number')return {ok:false,status:directBody,headers:{get:()=>null}};
    return {ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from(directBody);})()};
  };
  return {request,calls};
}

const zrSection='<html><head><title>23-22 | Zoning Resolution</title></head><body><nav>Article I Article II</nav><main><p>23-22</p><p>Floor area regulations</p><p>'+'Operative zoning text. '.repeat(12)+'</p>'
  +'<table><tbody><tr><td><p><b>District</b></p></td><td><p>Standard</p></td><td><p>Qualifying</p></td></tr>'
  +'<tr><td><p>R6A R6<sup>1</sup></p><p>R7B</p></td><td><p>3.00</p></td><td><p>3.90</p></td></tr>'
  +'<tr><td><p>R8</p></td><td><p>7.20<sup>1</sup></p></td><td><p>8.64<sup>2</sup></p></td></tr></tbody></table>'
  +'<p><sup>1</sup>Within 100 feet of a wide street</p></main></body></html>';

test('a static official text host is read directly with no browser request or render charge, keeping its title and table rows',async()=>{
  for(const url of ['https://zr.planning.nyc.gov/article-ii/chapter-3/23-22','https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-22']){
    const {request,calls}=staticHostRequest({directBody:zrSection});
    let charged=0;
    const out=await fixtureFetcher(cfSecrets,request,{meterRender:render=>{charged++;return render();}})({url});
    assert.equal(out.method,'direct');assert.match(out.text,/Operative zoning text/);
    assert.deepEqual(calls,{cloudflare:0,direct:1});assert.equal(charged,0);
    assert.equal(out.title,'23-22 | Zoning Resolution');
    assert.match(out.text,/^District \| Standard \| Qualifying\nR6A R6\[1\] \/ R7B \| 3\.00 \| 3\.90\nR8 \| 7\.20\[1\] \| 8\.64\[2\]$/m);
    assert.match(out.text,/\[1\]Within 100 feet/);assert.doesNotMatch(out.text,/7\.201|R61|Article II/);
  }
});

test('static hosts come from source registry flags, so any jurisdiction can opt in without a code change',()=>{
  assert.ok(STATIC_HTML_HOSTS.has('zr.planning.nyc.gov'));assert.ok(STATIC_HTML_HOSTS.has('zoningresolution.planning.nyc.gov'));
  const hosts=staticHtmlHosts([{accessPoints:[{url:'https://library.municode.example/code',staticHtml:true},{url:'https://maps.example.gov/viewer'}]},{enabled:false,accessPoints:[{url:'https://retired.example.gov/code',staticHtml:true}]}]);
  assert.deepEqual([...hosts],['library.municode.example']);
});

test('a host flagged static by the registry skips the first render wherever it is',async()=>{
  const {request,calls}=staticHostRequest({directBody:zrSection});
  const out=await fixtureFetcher(cfSecrets,request,{staticHosts:new Set(['codes.example.gov'])})({url:'https://codes.example.gov/chapter-5'});
  assert.equal(out.method,'direct');assert.deepEqual(calls,{cloudflare:0,direct:1});
});

test('a thin or failed direct read on a static host still falls through to one charged render',async()=>{
  for(const directBody of ['<html><body><main><p>Loading</p></main></body></html>',503]){
    const {request,calls}=staticHostRequest({directBody});
    let charged=0;
    const out=await fixtureFetcher(cfSecrets,request,{meterRender:render=>{charged++;return render();}})({url:'https://zr.planning.nyc.gov/article-ii/chapter-3'});
    assert.equal(out.method,'cloudflare-markdown');assert.equal(out.title,'Rendered');
    assert.deepEqual(calls,{cloudflare:1,direct:1});assert.equal(charged,1);
  }
  const {request}=staticHostRequest({directBody:503});
  await assert.rejects(fixtureFetcher({},request)({url:'https://zr.planning.nyc.gov/article-ii/chapter-3'}),/direct: Source returned HTTP 503/);
});

test('PDFs on a static host keep the direct PDF path',async()=>{
  const {request,calls}=staticHostRequest({directBody:'<html><body><main><p>'+'Not a PDF. '.repeat(40)+'</p></main></body></html>'});
  await assert.rejects(fixtureFetcher(cfSecrets,request)({url:'https://zr.planning.nyc.gov/pdf/article-ii.pdf'}),/did not return a PDF/);
  assert.deepEqual(calls,{cloudflare:0,direct:1});
});

test('a thin static read with a busy browser is retryable and is not rendered twice',async()=>{
  const {request,calls}=staticHostRequest({directBody:'<html><body><main><p>Loading</p></main></body></html>',rendered:'busy'});
  const error=await fixtureFetcher(cfSecrets,request)({url:'https://zr.planning.nyc.gov/article-vii/chapter-4/74-75'}).catch(e=>e);
  assert.equal(error.retryable,true);assert.deepEqual(calls,{cloudflare:1,direct:1});
  assert.match(error.message,/direct: Direct fetch returned too little usable text\.; cloudflare: Browser is too busy/);
  assert.doesNotMatch(error.message,/cloudflare retry/);
});

test('other hosts still render first and retry a busy browser once, each render charged',async()=>{
  const busy=busyThenRequest({cloudflare:['busy','busy'],direct:'fail'});
  let charged=0;
  const error=await fixtureFetcher(cfSecrets,busy.request,{meterRender:render=>{charged++;return render();}})({url:'https://www.nyc.gov/page'}).catch(e=>e);
  assert.deepEqual(busy.calls,{cloudflare:2,direct:1});assert.equal(charged,2);
  assert.match(error.message,/cloudflare: Browser is too busy[^;]*; direct: Source returned HTTP 503\.; cloudflare retry: Browser is too busy/);
});

test('a refused render charge stops a rendered read, while a static direct read needs no charge',async()=>{
  const refuse=()=>{throw new BillingError('Not enough credits. Top up your wallet to continue research.',402);};
  const other=staticHostRequest({directBody:zrSection});
  await assert.rejects(fixtureFetcher(cfSecrets,other.request,{meterRender:refuse})({url:'https://www.nyc.gov/page'}),/Not enough credits/);
  assert.deepEqual(other.calls,{cloudflare:0,direct:0});
  const zr=staticHostRequest({directBody:zrSection});
  const out=await fixtureFetcher(cfSecrets,zr.request,{meterRender:refuse})({url:'https://zr.planning.nyc.gov/article-ii/chapter-3/23-22'});
  assert.equal(out.method,'direct');assert.deepEqual(zr.calls,{cloudflare:0,direct:1});
});
