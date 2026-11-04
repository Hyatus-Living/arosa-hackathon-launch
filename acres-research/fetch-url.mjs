import {requestSignal,throwIfCancelled} from './execution-context.mjs';
import dns from 'node:dns/promises';
import {readFileSync} from 'node:fs';
import {publicUrl,assertPublicDns,pinnedRequest,responseBody,PublicDestinationError} from './public-url.mjs';
import {extractText} from './knowledge-refresh.mjs';
import {isPdfUrl} from './pdf-pages.mjs';
import {BillingError} from './wallet.mjs';

// Read public PDFs directly to preserve physical pages. HTML prefers rendered
// markdown, with the static extractor as fallback, except on static text hosts,
// which read directly first. No browser actions, cookies, or custom auth, ever.

export function cleanFetchedMarkdown(rawText) {
  let text = String(rawText || '').trim();
  const head = text.slice(0, 1200);
  if (
    /title:\s*"?(?:Page not found|Access Denied|Just a moment|Sorry, you have been blocked|Attention Required)/i.test(head) ||
    /^(?:#+\s*)?(?:Page not found\s*\|\s*Zoning Resolution|Sorry, you have been blocked|Access Denied|Just a moment\.\.\.)/im.test(head)
  ) {
    throw new Error('Source returned a blocking or not-found page.');
  }
  // Strip the ~20,000-char Drupal global navigation tree on NYC Zoning Resolution pages
  // while preserving frontmatter/title and the ## Breadcrumb + section body.
  if (text.includes('[Skip to main content]') && text.includes('## Breadcrumb')) {
    text = text.replace(/\[Skip to main content\][\s\S]*?(?=## Breadcrumb\b)/, '');
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function cloudflareConfigured(secrets){
  return typeof secrets?.CLOUDFLARE_ACCOUNT_ID==='string'&&secrets.CLOUDFLARE_ACCOUNT_ID.length>=8
    &&typeof secrets?.CLOUDFLARE_API_TOKEN==='string'&&secrets.CLOUDFLARE_API_TOKEN.length>=10;
}
async function viaCloudflare(url,secrets,request){
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${secrets.CLOUDFLARE_ACCOUNT_ID}/browser-run/markdown`;
  const r=await request(endpoint,{method:'POST',headers:{authorization:`Bearer ${secrets.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({url}),signal:requestSignal(55000)});
  const p=await r.json();
  if(!r.ok||p.success!==true||typeof p.result!=='string')throw new Error(p?.errors?.[0]?.message||`Cloudflare Browser Run returned HTTP ${r.status}`);
  const browserMs=Number(r.headers?.get?.('x-browser-ms-used'))||null;
  const text=cleanFetchedMarkdown(p.result);
  return {text,method:'cloudflare-markdown',browserMs};
}
async function viaDirect(url,request,lookup){
  let current=url,response;
  for(let hops=0;;hops++){
    if(!publicUrl(current))throw new PublicDestinationError('Redirect left the public HTTPS web.');
    const addresses=await assertPublicDns(new URL(current).hostname,lookup);
    response=await request(current,{headers:{'user-agent':'ArosaResearch/1.0 (public source retrieval)','accept-encoding':'gzip, deflate, br'},redirect:'manual',signal:requestSignal(45000),lookup:async()=>addresses});
    if([301,302,303,307,308].includes(response.status)){
      response.body?.destroy?.();
      const location=response.headers.get('location');
      if(!location||hops===4)throw new Error('The source address redirects without an end.');
      current=new URL(location,current).href;
      continue;
    }
    break;
  }
  if(!response.ok){response.body?.destroy?.();throw new Error(`Source returned HTTP ${response.status}.`);}
  const body=responseBody(response),chunks=[];let bytes=0;
  for await(const chunk of body){bytes+=chunk.length;if(bytes>8*1024*1024){body.destroy?.();throw new Error('Source exceeds the 8 MB fetch limit.');}chunks.push(Buffer.from(chunk));}
  const raw=Buffer.concat(chunks);
  const extracted=extractText(raw,response.headers.get('content-type')||'');
  const text=extracted.pdfPages?extracted.text:cleanFetchedMarkdown(extracted.text);
  const documentUrl=extracted.pdfPages?new URL(current):null;if(documentUrl)documentUrl.hash='';
  return {text,method:'direct',publishedAt:extracted.publishedAt||null,finalUrl:documentUrl?documentUrl.href:current,...(extracted.pdfPages?{pdfPages:extracted.pdfPages}:{title:extracted.title||null})};
}
const BUSY_RE=/too busy/i;
// Hosts the source registry marks as serving their text as server-rendered HTML
// (accessPoints[].staticHtml) are read directly first; rendering runs only when
// that read is thin or fails.
export function staticHtmlHosts(entries){
  return new Set(entries.filter(entry=>entry.enabled!==false).flatMap(entry=>entry.accessPoints.filter(point=>point.staticHtml===true).map(point=>new URL(point.url).hostname)));
}
export const STATIC_HTML_HOSTS=staticHtmlHosts(JSON.parse(readFileSync(new URL('./source-registry.json',import.meta.url),'utf8')));
// Meter the provider response before decoding it: completed HTTP errors settle fixed-call charges,
// while a request that never returns a response remains pending. Direct reads are never charged.
export function createUrlFetcher(secrets,{request=fetch,directRequest=pinnedRequest,lookup=dns.lookup,staticHosts=STATIC_HTML_HOSTS,meterRender=render=>render()}={}){
  return async function fetchUrl({url,requirePdf=false}){
    if(!publicUrl(url))throw new PublicDestinationError('Fetch accepts public HTTPS URLs only.');
    if(requirePdf||isPdfUrl(url)){
      const out=await viaDirect(url,directRequest,lookup);
      if(!out.pdfPages)throw new Error('This URL did not return a PDF document.');
      if(!out.text.trim())throw new Error('PDF has no extractable text; it may be blank or scanned.');
      return {url:out.finalUrl,...out,title:out.finalUrl};
    }
    const attempts=[];
    const rendered=async()=>{
      await assertPublicDns(new URL(url).hostname,lookup);
      const out=await viaCloudflare(url,secrets,(...args)=>meterRender(()=>request(...args)));
      if(out.text.length<200)throw new Error('Rendered page returned too little usable text.');
      return {url,title:out.text.match(/^#\s+(.+)$/m)?.[1]?.replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').trim()||out.text.match(/^title:\s*"?([^"\n]+)"?/m)?.[1]?.trim()||url,...out};
    };
    const failed=(label,e)=>{throwIfCancelled();if(e.code==='PUBLIC_DESTINATION_DENIED'||e instanceof BillingError)throw e;attempts.push(`${label}: ${e.message}`);};
    const renderFirst=cloudflareConfigured(secrets)&&!staticHosts.has(new URL(url).hostname);
    let busy=false;
    if(renderFirst){
      try{return await rendered();}
      catch(e){failed('cloudflare',e);busy=BUSY_RE.test(e.message);}
    }
    try{
      const out=await viaDirect(url,directRequest,lookup);
      if(out.text.length<200)throw new Error('Direct fetch returned too little usable text.');
      return {url:out.finalUrl||url,...out,title:out.pdfPages?out.finalUrl:out.title||url};
    }catch(e){failed('direct',e);}
    // Static hosts render only after a thin direct read. A busy browser pool is
    // transient: the direct fetch above already ran immediately, so give
    // rendering exactly one more try before giving up.
    if(cloudflareConfigured(secrets)&&(!renderFirst||busy)){
      try{return await rendered();}
      catch(e){failed(renderFirst?'cloudflare retry':'cloudflare',e);busy=BUSY_RE.test(e.message);}
    }
    const error=new Error(`Could not read this URL (${attempts.join('; ')||'no fetch method configured'}). Try Exa contents or another source.`);
    error.retryable=busy;
    throw error;
  };
}
