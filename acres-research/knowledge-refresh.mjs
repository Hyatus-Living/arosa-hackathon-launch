import {requestSignal,throwIfCancelled,abortable} from './execution-context.mjs';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {KnowledgeStore,knowledgePath,hash,chunkSourceText} from './knowledge.mjs';
import {extractPdfPages,PDF_EXTRACTOR} from './pdf-pages.mjs';
import {embeddingProvider,classifierProvider,CLASSIFICATION_SAMPLE_VERSION} from './knowledge-providers.mjs';
import {isAuthoritativeSourceUrl} from './jurisdiction.mjs';

export function validateSource(source) {
  if(!source?.url||!isAuthoritativeSourceUrl(source.url))throw new Error('Source URL is outside the approved public-source registry.');
}
export async function fetchSource(source,previous,fetcher=fetch) {
  validateSource(source);
  const headers={'user-agent':'ArosaKnowledge/1.0 (public zoning research; daily update)'};
  if(previous?.etag)headers['if-none-match']=previous.etag;
  if(previous?.modified)headers['if-modified-since']=previous.modified;
  let url=source.url,response;
  for(let redirects=0;redirects<4;redirects++) {
    response=await fetcher(url,{headers,redirect:'manual',signal:requestSignal(60000)});
    if([301,302,303,307,308].includes(response.status)) {url=new URL(response.headers.get('location'),url).href;validateSource({...source,url});continue;}
    break;
  }
  if(response.status===304){if(!previous?.current_version)throw new Error('Source returned not-modified without a stored version.');return {unchanged:true};}
  if(!response.ok)throw new Error(`Source returned HTTP ${response.status}.`);
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>8*1024*1024)throw new Error('Source exceeds the 8 MB ingestion limit.');chunks.push(chunk);}
  return {raw:Buffer.concat(chunks),contentType:response.headers.get('content-type')||'',etag:response.headers.get('etag'),modified:response.headers.get('last-modified')};
}
// Bumped whenever HTML extraction output changes, so unchanged bytes are extracted again.
export const HTML_EXTRACTOR='text-v4';
const UNIT_BEFORE=/\b(ft|feet|foot|sq|sf|yd|m|cm|mm|km)\.?\s*$/i;
const CELL_BLOCKS='p,div,li,br,h1,h2,h3,h4,h5,h6,ul,ol,section';
const cellsOf=row=>[...row.children].filter(cell=>/^t[dh]$/i.test(cell.tagName));
// A table of values: some row has several cells, no cell holds page structure, and cells stay short.
function isDataTable(table){
  const rows=[...table.querySelectorAll('tr')];
  if(!rows.some(row=>cellsOf(row).length>1)||table.querySelector('table,h1,h2,h3,h4,h5,h6,ul,ol,section,article'))return false;
  return rows.every(row=>cellsOf(row).every(cell=>cell.textContent.replace(/\s+/g,' ').trim().length<=300));
}
export function extractText(raw,contentType) {
  if(contentType.includes('pdf')||raw.subarray(0,4).toString()==='%PDF') {
    return extractPdfPages(raw);
  }
  if(!contentType.includes('html'))throw new Error('Source must be HTML or PDF.');
  const {document}=parseHTML(raw.toString('utf8'));
  const pageTitle=document.querySelector('title')?.textContent.replace(/\s+/g,' ').trim()||'';
  if(/access denied|just a moment|robot challenge/i.test(pageTitle))throw new Error('Source returned a blocking page.');
  const published=document.querySelector('meta[property="article:published_time"]')?.getAttribute('content');
  for(const node of document.querySelectorAll('head,title,script,style,nav,header,footer,noscript,svg'))node.remove();
  // Omitted head/body tags are valid HTML; the body getter can create an empty body.
  let root=document.querySelector('main')||document.querySelector('#main-content')||document.querySelector('.main-content')||document.querySelector('.about-main-image')||document.querySelector('body');
  if(!root){root=document.createElement('div');for(const node of [...document.childNodes])root.appendChild(node);}
  const heading=root.querySelector('h1')?.textContent.replace(/\s+/g,' ').trim()||'';
  // A footnote marker stays apart from the value it marks: 7.20<sup>1</sup> reads 7.20[1], never 7.201.
  // Ordinals, exponents after a unit (ft<sup>2</sup>) and markers already bracketed are left as written.
  for(const sup of root.querySelectorAll('sup')){
    const marker=sup.textContent.trim(),before=sup.previousSibling?.textContent||'';
    if(/^(\d{1,3}|[*\u2020\u2021]+)$/.test(marker)&&!UNIT_BEFORE.test(before))sup.textContent=`[${marker}]`;
  }
  // Data tables keep one line per row: cells joined by |, blocks stacked in one cell joined by /.
  // Tables that lay out a page (headings, lists or tables inside, long cells, one column) keep the general block layout.
  for(const table of [...root.querySelectorAll('table')].filter(isDataTable)){
    const rows=[...table.querySelectorAll('tr')].map(row=>cellsOf(row).map(cell=>{
      for(const node of cell.querySelectorAll(CELL_BLOCKS))node.after(document.createTextNode('\u0001'));
      return cell.textContent.split('\u0001').map(part=>part.replace(/\s+/g,' ').trim()).filter(Boolean).join(' / ');
    }).join(' | ')).filter(row=>row.replace(/[\s|]/g,''));
    const caption=table.querySelector('caption')?.textContent.replace(/\s+/g,' ').trim();
    const block=document.createElement('p');block.textContent=[caption,...rows].filter(Boolean).join('\n');table.replaceWith(block);
  }
  for(const node of root.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,br,section,caption'))node.appendChild(document.createTextNode('\n\n'));
  return {text:root.textContent.replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n\n').trim(),title:pageTitle.includes(heading)?pageTitle||null:heading,publishedAt:published&&!Number.isNaN(Date.parse(published))?new Date(published).toISOString():null};
}

export async function refreshKnowledge({store,sources,embedder,classifier,fetcher=fetch,onlySources,queuedOnly=false}) {
  throwIfCancelled();
  if(!embedder||!classifier)throw new Error('The updater requires embedding and classification credentials.');
  const id=randomUUID(),started=new Date().toISOString();
  if(!store.acquire(id))throw new Error('Another knowledge update is already running.');
  const result={runId:id,changed:0,unchanged:0,failed:0,sources:[]};
  try {
    store.beginRun(id,started);
    for(const source of sources){validateSource(source);store.register(source);}
    if(!sources.length)throw new Error('The source registry must not be empty.');
    store.write(`UPDATE sources SET active=0 WHERE id NOT LIKE 'staged-%' AND id NOT IN (${sources.map(()=>'?').join(',')})`,...sources.map(s=>s.id));
    let selected=sources;
    if(onlySources?.length) {
      if(onlySources.some(id=>!sources.some(s=>s.id===id)))throw new Error('Unknown source identifier.');
      selected=selected.filter(s=>onlySources.includes(s.id));
    }
    if(queuedOnly){const pending=new Set(store.all('SELECT source FROM refresh_requests WHERE completed IS NULL').map(r=>r.source));selected=selected.filter(s=>pending.has(s.id));}
    for(const source of selected) {
      const now=new Date().toISOString(),previous=store.source(source.id);
      try {
        const current=previous.current_version?store.one('SELECT raw_hash,text,metadata,substr(raw,1,4) AS signature FROM versions WHERE id=?',previous.current_version):null;
        const registryHashFor=extractor=>hash(JSON.stringify({source,embeddingSpace:embedder.space,classifier:classifier.name||'test',classificationSample:CLASSIFICATION_SAMPLE_VERSION,extractor}));
        let extractor=current&&Buffer.from(current.signature).toString()==='%PDF'?PDF_EXTRACTOR:HTML_EXTRACTOR,registryHash=registryHashFor(extractor);
        const fetched=await fetchSource(source,current&&JSON.parse(current.metadata).registryHash===registryHash?previous:null,fetcher);
        throwIfCancelled();
        if(fetched.unchanged||(current?.raw_hash===hash(fetched.raw)&&JSON.parse(current.metadata).registryHash===registryHash)) {
          store.checked(source.id,now,fetched);store.write('UPDATE refresh_requests SET completed=? WHERE source=?',now,source.id);
          result.unchanged++;result.sources.push({id:source.id,status:'unchanged'});continue;
        }
        const extracted=extractText(fetched.raw,fetched.contentType);
        extractor=extracted.pdfPages?PDF_EXTRACTOR:HTML_EXTRACTOR;registryHash=registryHashFor(extractor);
        if(extracted.text.trim().length<200)throw new Error('Source returned too little usable text.');
        if(current?.text===extracted.text&&JSON.parse(current.metadata).registryHash===registryHash) {
          store.checked(source.id,now,fetched);store.write('UPDATE refresh_requests SET completed=? WHERE source=?',now,source.id);
          result.unchanged++;result.sources.push({id:source.id,status:'unchanged'});continue;
        }
        const classification=await abortable(classifier.classify(source.title,extracted.text));
        throwIfCancelled();
        const metadata={...source,registryHash,publishedAt:extracted.publishedAt,effectiveFrom:source.effectiveFrom||null,effectiveTo:source.effectiveTo||null,
          topics:[...new Set([...source.topics,...classification.topics])],topicScores:classification.topicScores,classifier:classification.classifier,classificationCoverage:classification.classificationCoverage||null,embeddingSpace:embedder.space,extractor,...(extracted.pdfPages?{pdfPages:extracted.pdfPages}:{})};
        const chunks=chunkSourceText(extracted.text,extracted.pdfPages),vectors=chunks.map(text=>store.vector(hash(text),embedder.space));
        const missing=chunks.map((text,index)=>({text,index})).filter(r=>!vectors[r.index]);
        if(missing.length){const embedded=await abortable(embedder.embed(missing.map(r=>r.text)));throwIfCancelled();if(embedded.length!==missing.length)throw new Error('Incomplete document embeddings.');missing.forEach((r,i)=>{vectors[r.index]=embedded[i];});}
        throwIfCancelled();
        const published=store.publish(source,fetched.raw,extracted.text,metadata,vectors,embedder.space,now,fetched);
        result.changed++;result.sources.push({id:source.id,status:'updated',...published,embedded:missing.length});
      } catch(error) {
        throwIfCancelled();
        // Each source is independent. A bad download or model result cannot replace its last good version.
        store.failed(source.id,now,error.message);result.failed++;result.sources.push({id:source.id,status:'failed',error:error.message});
      }
    }
    store.finishRun(id,result);return result;
  } catch(error) {
    store.finishRun(id,{...result,failed:result.failed+1,error:error.message});throw error;
  } finally {store.release(id);}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const config={...JSON.parse(readFileSync(process.env.ACRES_KNOWLEDGE_CONFIG||'/etc/acres-research/knowledge.json','utf8')),...process.env};
  const store=new KnowledgeStore(knowledgePath());
  try {
    const result=await refreshKnowledge({store,sources:JSON.parse(readFileSync(new URL('./knowledge-sources.json',import.meta.url),'utf8')),embedder:embeddingProvider(config),classifier:classifierProvider(config),queuedOnly:process.argv.includes('--queued-only'),onlySources:process.argv.filter(a=>a.startsWith('--source=')).map(a=>a.slice(9))});
    console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;
  } finally {store.close();}
}
