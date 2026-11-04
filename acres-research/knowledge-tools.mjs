import {existsSync,readFileSync} from 'node:fs';
import {openKnowledge,topics,knowledgeFreshness} from './knowledge.mjs';
import {embeddingProvider,jevRouterProvider} from './knowledge-providers.mjs';
import {resolveSearchJurisdiction} from './jurisdiction.mjs';
import {extractPdfPages,selectPdfPage} from './pdf-pages.mjs';

const definition=(name,description,properties,required)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
export const knowledgeDefinitions=[
  definition('acres_search_knowledge','Search saved official zoning and short-term rental sources by jurisdiction using keywords and semantic similarity. Choose this when stored evidence helps; there is no required order relative to source discovery or live research. Results include source versions, freshness and effective dates. Unknown dates are not proof of current law.',{
    query:{type:'string'},city:{type:'string',description:'Optional jurisdiction identifier or city/state name (e.g. US-NY-NYC, US-FL-MIAMI, or "West Palm Beach, FL"); automatically inferred from the query or active site when omitted.'},topic:{type:'string',enum:Object.keys(topics)},asOf:{type:'string',description:'Optional YYYY-MM-DD historical effective date. Only dated sources are eligible.'},limit:{type:'integer',minimum:1,maximum:15},
  },['query']),
  definition('acres_get_knowledge_source','Read a saved source version already seen in knowledge search or a cached URL read, with citation text and provenance. For a PDF pass its physical page number, starting at 1. Long text returns bounded character slices; offsets are local to the selected PDF page. No required investigation order.',{versionId:{type:'string'},offset:{type:'integer',minimum:0,description:'Character offset in this version or selected PDF page, default 0.'},page:{type:'integer',minimum:1,description:'Physical PDF page number, starting at 1; printed page labels may differ.'}},['versionId']),
  definition('acres_refresh_knowledge','Queue a bounded refresh of an existing registered source. Runs in the background, not during this answer. Only registered public sources may be refreshed.',{source:{type:'string'}},['source']),
];

export function isIrrelevantSpecialDistrictSource(url,query='',property=null){
  const u=String(url||'').toLowerCase();
  if(!/(?:^|\/\/)(?:zr|zoningresolution)\.planning\.nyc\.gov\b/.test(u))return false;
  const q=String(query||'').toLowerCase();
  const sp=[property?.spdist1,property?.spdist2,property?.spdist3].filter(Boolean).join(' ').toUpperCase();
  const zd=[property?.zonedist1,property?.zonedist2,property?.zonedist3,property?.zonedist4].filter(Boolean).join(' ').toUpperCase();
  if(u.includes('/article-viii/chapter-1')&&!/\b(midtown|81-\d|\bmid\b)\b/i.test(q)&&!sp.includes('MID'))return true;
  if(u.includes('/article-ix/chapter-1')&&!/\b(lower manhattan|91-\d|\blm\b)\b/i.test(q)&&!sp.includes('LM'))return true;
  if(u.includes('/article-x/chapter-1')&&!/\b(downtown brooklyn|schermerhorn|101-\d|\bdb\b)\b/i.test(q)&&!sp.includes('DB'))return true;
  if(u.includes('/article-xi/chapter-9')&&!/\b(hillsides?|steep slope|119-\d|\bhs\b)\b/i.test(q)&&!sp.includes('HS'))return true;
  if(u.includes('/article-xii/chapter-3')&&!/\b(special mixed use|\bmx\b|mx-\d|123-\d)\b/i.test(q)&&!sp.includes('MX')&&!zd.includes('/'))return true;
  if(u.includes('/article-xiv/chapter-3')&&!/\b(soho|noho|\bsnx\b|143-\d)\b/i.test(q)&&!sp.includes('SNX'))return true;
  if(property){
    if(u.includes('/article-vi/chapter-4')&&!/\b(flood|fema|firm|pfirm|frce|resilien|64-\d)\b/i.test(q)&&String(property.firm07_flag||'')!=='1'&&String(property.pfirm15_flag||'')!=='1')return true;
    if(u.includes('/article-vii/chapter-7')&&!/\b(split|divided|boundary|77-\d)\b/i.test(q)&&!property.zonedist2&&String(property.splitzone||'').toUpperCase()!=='Y')return true;
  }
  return false;
}

export function createKnowledgeHandlers({record,configPath=process.env.ACRES_KNOWLEDGE_CONFIG||'/etc/acres-research/knowledge.json',open=openKnowledge,embedder,jevRouter,seen=new Set(),getCity=null,getProperty=null}={}) {
  async function using(callback) {
    const store=open();
    if(!store)return {available:false,note:'The saved knowledge corpus is not initialized. Use the public research tools and state the coverage gap.'};
    try{return await callback(store);}finally{store.close();}
  }
  return {
    acres_search_knowledge:args=>using(async store=>{
      const cfg=(!embedder&&jevRouter===undefined&&existsSync(configPath))?JSON.parse(readFileSync(configPath,'utf8')):null;
      const provider=embedder||(cfg?embeddingProvider(cfg):null);
      const router=jevRouter!==undefined?jevRouter:(cfg?jevRouterProvider(cfg):null);
      const city=resolveSearchJurisdiction({city:args?.city,query:args?.query,fallbackCity:getCity?.()||null});
      const result=await store.search({...args,city},provider,router);
      const activeProperty=getProperty?.()||null;
      result.results=(result.results||[]).filter(item=>!isIrrelevantSpecialDistrictSource(item.url,args?.query,activeProperty));
      for(const item of result.results){seen.add(item.versionId);const source=record({title:item.title,url:item.url,text:item.text,kind:item.kind,publishedDate:item.publishedAt,knowledge:item});item.citationId=source?.id;}
      return result;
    }),
    acres_get_knowledge_source:({versionId,offset=0,page})=>using(store=>{
      if(!seen.has(versionId))throw new Error('Search this source version before retrieving it.');
      if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Source offset must be a nonnegative safe integer.');
      const row=store.one('SELECT v.text,v.metadata,v.observed_at,substr(v.raw,1,4) AS signature,s.last_success,s.last_checked,s.error,s.current_version FROM versions v JOIN sources s ON s.id=v.source WHERE v.id=?',versionId);
      if(!row)throw new Error('Saved source version not found.');
      const meta=JSON.parse(row.metadata);let document={url:meta.url,title:meta.title||meta.url,text:row.text,pdfPages:meta.pdfPages};
      const freshness={...knowledgeFreshness(row),superseded:row.current_version!==versionId};
      if(page!==undefined){
        if(!document.pdfPages&&Buffer.from(row.signature).toString()==='%PDF')document={...document,...extractPdfPages(Buffer.from(store.one('SELECT raw FROM versions WHERE id=?',versionId).raw))};
        document=selectPdfPage(document,page);
      }
      if(offset>0&&offset>=document.text.length)throw new Error('Source offset is outside this version or selected PDF page.');
      const text=document.text.slice(offset,offset+24000),nextOffset=offset+text.length<document.text.length?offset+text.length:null;
      const source=record({title:document.title,url:document.url,text,kind:meta.kind,publishedDate:meta.publishedAt,...(document.pdf?{pdf:document.pdf}:{}),knowledge:{versionId,observedAt:row.observed_at,...freshness,effectiveFrom:meta.effectiveFrom||null,effectiveTo:meta.effectiveTo||null,offset,totalCharacters:document.text.length,...(document.pdf?{pdf:document.pdf}:{})}});
      return {versionId,metadata:meta,...freshness,text,offset,totalCharacters:document.text.length,nextOffset,truncated:nextOffset!==null,citationId:source?.id,...(document.pdfPages?{pdfPageCount:document.pdfPages.length}:{}),...(document.pdf?{pdf:document.pdf}:{})};
    }),
    acres_refresh_knowledge:({source})=>using(store=>store.requestRefresh(source)),
  };
}
