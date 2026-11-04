import {requestSignal,executionSignal,combinedSignal,withExecutionSignal,abortable,throwIfCancelled} from './execution-context.mjs';
import {composioHeaders,root,exaTools} from './composio.mjs';
import {publicUrl} from './public-url.mjs';
import {scoreSourceAuthority} from './jurisdiction.mjs';

// Tier 1 discovery fan-out: one query to every configured provider in parallel,
// canonical-URL dedup, reciprocal-rank fusion with an authority prior.
// Snippets are discovery hints only; cited text must come from a fetch.

export function authorityScore(url){
  const s=scoreSourceAuthority(url);
  return s>0?s:0.4;
}
export function canonicalUrl(raw){
  if(!publicUrl(raw))return null;
  const u=new URL(raw);
  u.hash='';
  for(const k of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(k))u.searchParams.delete(k);
  u.hostname=u.hostname.toLowerCase().replace(/^www\./,'');
  if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');
  return u.href;
}
// providers: [{name, weight?, results:[{url,title,snippet,publishedDate}]}] in rank order.
export function mergeResults(providerLists,{limit=12}={}){
  const byUrl=new Map();
  for(const {name,weight=1,results=[]} of providerLists){
    results.forEach((r,i)=>{
      const url=canonicalUrl(r.url);if(!url)return;
      const hit=byUrl.get(url)||{url,title:r.title||url,snippet:r.snippet||r.text||'',publishedDate:r.publishedDate||null,providers:[],score:0,bestRank:99};
      hit.score+=weight/(60+i+1)+authorityScore(url)*0.004;
      hit.bestRank=Math.min(hit.bestRank,i);
      if(!hit.providers.includes(name))hit.providers.push(name);
      if((r.snippet||'').length>hit.snippet.length)hit.snippet=r.snippet;
      if(r.title&&hit.title===url)hit.title=r.title;
      byUrl.set(url,hit);
    });
  }
  return [...byUrl.values()].sort((a,b)=>b.score-a.score||a.bestRank-b.bestRank).slice(0,limit)
    .map((h,i)=>({...h,rank:i+1,authority:authorityScore(h.url)}));
}

async function asJson(request,url,options){
  const r=await request(url,{...options,signal:requestSignal(30000)});
  const p=typeof r.json==='function'?await r.json():r;
  if(r.ok===false||p?.error)throw new Error(p?.error?.message||`Search provider returned HTTP ${r.status}`);
  return p;
}
export function serperProvider(secrets,request=fetch){
  const key=secrets.SERPER_API_KEY;
  if(typeof key!=='string'||key.length<10)return null;
  return {name:'serper',weight:1,async search(query,{limit=8}={}){
    const p=await asJson(request,'https://google.serper.dev/search',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify({q:query,num:Math.min(limit,10)})});
    return (p.organic||[]).map(o=>({url:o.link,title:o.title,snippet:o.snippet||'',publishedDate:o.date||null}));
  }};
}
export function exaProvider(secrets,sessions,request=fetch){
  if(!sessions?.exa)return null;
  return {name:'exa',weight:1,async search(query,{limit=8}={}){
    const p=await asJson(request,`${root}/tool_router/session/${sessions.exa}/execute`,{method:'POST',headers:composioHeaders(secrets),body:JSON.stringify({tool_slug:'EXA_SEARCH',arguments:{query,numResults:Math.min(limit,8),contents:{highlights:{numSentences:2}}}})});
    const rows=p.data?.results||p.data?.data?.results||[];
    return rows.map(o=>({url:o.url||o.id,title:o.title,snippet:(o.highlights||[]).join(' ')||o.text?.slice(0,400)||'',publishedDate:o.publishedDate||null}));
  }};
}
// DeepSeek kill-switch (D2 option B): DEEPSEEK_ENABLED in secrets.json or the
// process env. Anything other than an explicit false keeps the leg on; an
// explicit false makes deepseekProvider return null, so the leg is never
// constructed and no request to api.deepseek.com is ever made.
export function deepseekEnabled(secrets={},env=process.env){
  const v=secrets?.DEEPSEEK_ENABLED??env?.DEEPSEEK_ENABLED;
  if(v===undefined||v===null)return true;
  if(typeof v==='boolean')return v;
  return !/^(false|0|no|off)$/i.test(String(v).trim());
}
export const DEEPSEEK_MAX_QUERY_CHARS=128;
export function deepseekProvider(secrets,request=fetch){
  if(!deepseekEnabled(secrets))return null;
  const key=secrets.DEEPSEEK_API_KEY;
  if(typeof key!=='string'||key.length<10)return null;
  return {name:'deepseek',weight:1,async search(query,{limit=8}={}){
    // DeepSeek Search caps queries at 128 chars. Skip this leg only (the throw
    // surfaces in failedProviders); the other providers still run.
    if(typeof query==='string'&&query.length>DEEPSEEK_MAX_QUERY_CHARS)throw new Error(`DeepSeek leg skipped: query exceeds ${DEEPSEEK_MAX_QUERY_CHARS} characters.`);
    const p=await asJson(request,'https://api.deepseek.com/v1/tools/search',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({query,count:Math.min(limit,50)})});
    return (p.results||[]).map(o=>({url:o.url,title:o.title,snippet:o.snippet||'',publishedDate:o.date||null}));
  }};
}
export function localProvider(searchKnowledge){
  if(typeof searchKnowledge!=='function')return null;
  return {name:'knowledge',weight:1,async search(query,{limit=8}={}){
    const r=await searchKnowledge({query,limit:Math.min(limit,8)});
    const seenUrls=new Set(),out=[];
    for(const o of r?.results||[]){
      const key=canonicalUrl(o.url)||o.url;
      if(!key||seenUrls.has(key))continue;
      seenUrls.add(key);
      out.push({url:o.url,title:o.title,snippet:o.text?.slice(0,400)||'',publishedDate:o.publishedAt||null,knowledge:{versionId:o.versionId,observedAt:o.observedAt}});
    }
    return out;
  }};
}
export async function fanoutSearch({query,providers,limit=12,onProvider=()=>{},timeoutMs=30000}){
  if(typeof query!=='string'||!query.trim()||query.length>1000)throw new Error('Provide a fan-out query of 1 to 1,000 characters.');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('Use a discovery deadline from 1 to 60,000 milliseconds.');
  throwIfCancelled();
  const active=providers.filter(Boolean);
  if(!active.length)throw new Error('No discovery providers are configured.');
  const deadline=new AbortController(),signal=combinedSignal(executionSignal(),deadline.signal),timings=[];
  const timer=setTimeout(()=>deadline.abort(new DOMException('Discovery deadline exceeded.','TimeoutError')),timeoutMs);
  let settled;
  try {settled=await Promise.allSettled(active.map(async p=>{
    const started=Date.now();
    try {
      const results=await abortable(withExecutionSignal(signal,()=>p.search(query,{limit:8})),signal);
      signal.throwIfAborted();
      const timing={provider:p.name,status:'ok',count:results.length,ms:Date.now()-started};timings.push(timing);onProvider(timing);
      return {name:p.name,weight:p.weight??1,results};
    } catch(error){
      throwIfCancelled();
      const timing={provider:p.name,status:deadline.signal.aborted?'timed_out':'failed',ms:Date.now()-started};timings.push(timing);onProvider({...timing,error:String(error?.message||error).slice(0,160)});throw error;
    }
  }));} finally {clearTimeout(timer);}
  throwIfCancelled();
  const ok=[],failed=[];
  settled.forEach((s,i)=>{if(s.status==='fulfilled')ok.push(s.value);else failed.push(active[i].name);});
  if(!ok.length)throw new Error('Every discovery provider failed. Try another query or tool.');
  return {query,results:mergeResults(ok,{limit}),providers:ok.map(p=>p.name),failedProviders:failed,partial:failed.length>0,
    timedOutProviders:timings.filter(row=>row.status==='timed_out').map(row=>row.provider),providerTimings:active.map(provider=>timings.find(row=>row.provider===provider.name)),
    note:'Discovery only: snippets do not prove operative text. Fetch the URLs you rely on before citing them.'};
}
export const pinnedFanoutTools=[...exaTools];
