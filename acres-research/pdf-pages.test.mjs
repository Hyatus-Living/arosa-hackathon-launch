import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHTML} from 'linkedom';
import {extractText,refreshKnowledge} from './knowledge-refresh.mjs';
import {KnowledgeStore,chunkText,hash} from './knowledge.mjs';
import {createUrlFetcher} from './fetch-url.mjs';
import {selectPdfPage} from './pdf-pages.mjs';
import {createResearchTools} from './tools.mjs';
import {createKnowledgeHandlers} from './knowledge-tools.mjs';
import {buildUnderwritingDeck,renderDeckHtml} from './deliverable.mjs';
import {municipalPdf,pdfDocument} from './testing/pdf-document.mjs';

const url='https://www.nyc.gov/fixture.pdf';
const source={id:'pdf-source',url,title:'Synthetic municipal PDF',jurisdiction:'US-NY-NYC',topics:['registration'],authority:'official_agency',kind:'guidance'};
const cf={CLOUDFLARE_ACCOUNT_ID:'pdf-fixture-account',CLOUDFLARE_API_TOKEN:'pdf-fixture-token'};
const lookup=async()=>[{address:'93.184.216.34',family:4}];
const response=(raw=municipalPdf())=>new Response(raw,{headers:{'content-type':'application/pdf',etag:'pdf-etag'}});
const document=()=>({url,title:source.title,...extractText(municipalPdf(),'application/pdf'),method:'direct'});
const toolsFor=doc=>createResearchTools({},()=>{},null,null,{fetchedPages:new Map([[url,doc]])});
function knowledge(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-pdf-pages-')),path=join(dir,'knowledge.sqlite'),store=new KnowledgeStore(path),calls={embedded:0,classified:0};
  t.after(()=>{store.close();rmSync(dir,{recursive:true});});
  const embedder={space:'pdf-fixture:1',async embed(texts){calls.embedded+=texts.length;return texts.map(()=>[1,0]);}},classifier={name:'pdf-fixture',async classify(){calls.classified++;return {topics:['registration'],topicScores:{registration:1},classifier:'pdf-fixture'};}};
  const refresh=fetcher=>refreshKnowledge({store,sources:[source],embedder,classifier,fetcher});
  const legacy=()=>{
    store.register(source);const raw=municipalPdf(),text=extractText(raw,'application/pdf').text,registryHash=hash(JSON.stringify({source,embeddingSpace:embedder.space,classifier:classifier.name,extractor:'text-v3'}));
    return store.publish(source,raw,text,{...source,registryHash,extractor:'text-v3'},chunkText(text).map(()=>[1,0]),embedder.space,'2026-01-01T00:00:00.000Z',{etag:'pdf-etag'});
  };
  return {store,path,embedder,classifier,calls,refresh,legacy};
}

test('PDF extraction retains physical page ranges, including a blank middle page',()=>{
  const out=extractText(municipalPdf(),'application/pdf');assert.equal(out.pdfPages.length,3);assert.deepEqual(out.pdfPages.map(p=>p.page),[1,2,3]);
  assert.match(out.text.slice(out.pdfPages[0].start,out.pdfPages[0].end),/FIRST-PAGE-GUIDANCE/);assert.equal(out.text.slice(out.pdfPages[1].start,out.pdfPages[1].end).trim(),'');assert.match(out.text.slice(out.pdfPages[2].start,out.pdfPages[2].end),/APPENDIX-REVIEW/);
  assert.match(out.text,/Printed page 1 of 2/);assert.equal(out.pdfPages[0].start,0);
});

test('PDF magic with an octet-stream type retains physical page identity',()=>{
  const out=extractText(municipalPdf(),'application/octet-stream');assert.equal(out.pdfPages[2].page,3);assert.match(out.text.slice(out.pdfPages[2].start,out.pdfPages[2].end),/physical page three/);
});

test('known PDFs and explicitly requested PDF endpoints use direct bytes before a configured renderer',async()=>{
  for(const [address,requirePdf] of [[url,false],['https://www.nyc.gov/download?id=pdf',true],[url+'#page=3',true]]){
    let rendered=0,direct=0;const reader=createUrlFetcher(cf,{lookup,directRequest:async()=>{direct++;return response();},request:async()=>{rendered++;return {ok:true,json:async()=>({success:true,result:'# Browser chrome\n\n'+'Not the source document. '.repeat(20)})};}});
    const out=await reader({url:address,requirePdf});assert.equal(out.method,'direct');assert.equal(out.pdfPages.length,3);assert.equal(rendered,0);assert.equal(direct,1);
    assert.equal(new URL(out.url).hash,'');
    assert.equal(out.title,out.url);assert.match(selectPdfPage(out,3).title,/^PDF page 3 of 3: https:\/\/www\.nyc\.gov\//);
  }
});

test('an explicit PDF read rejects HTML and public-destination denial still precedes requests',async()=>{
  let calls=0;const reader=createUrlFetcher({},{lookup,directRequest:async()=>{calls++;return new Response('<main>'+'Not a PDF. '.repeat(30)+'</main>',{headers:{'content-type':'text/html'}});}});
  await assert.rejects(reader({url:'https://www.nyc.gov/download',requirePdf:true}),/PDF/);const before=calls;await assert.rejects(reader({url:'https://127.0.0.1/private.pdf',requirePdf:true}),/public HTTPS/);assert.equal(calls,before);
});

test('page reads cite separate physical pages and keep the cached whole document intact',async()=>{
  const tools=toolsFor(document()),third=await tools.execute('acres_fetch_url',{url,page:3}),first=await tools.execute('acres_fetch_url',{url,page:1});
  assert.equal(third.pdf.page,3);assert.equal(third.pdf.pageCount,3);assert.equal(third.url,url+'#page=3');assert.match(third.text,/APPENDIX-REVIEW/);assert.doesNotMatch(third.text,/FIRST-PAGE-GUIDANCE/);
  assert.equal(first.pdf.page,1);assert.notEqual(first.sourceId,third.sourceId);assert.equal((await tools.execute('acres_fetch_url',{url,page:3})).sourceId,third.sourceId);
  const whole=await tools.execute('acres_fetch_url',{url});assert.match(whole.text,/FIRST-PAGE-GUIDANCE/);assert.match(whole.text,/APPENDIX-REVIEW/);assert.equal(whole.pdfPageCount,3);assert.equal(whole.url,url);
});

test('PDF fragments select physical pages and conflicting or invalid page requests fail clearly',async()=>{
  const tools=toolsFor(document()),page=await tools.execute('acres_fetch_url',{url:url+'#page=3&zoom=120'});assert.equal(page.pdf.page,3);assert.equal(page.url,url+'#page=3');
  assert.equal((await tools.execute('acres_fetch_url',{url:url+'#page=1&PAGE=3'})).pdf.page,3);
  await assert.rejects(tools.execute('acres_fetch_url',{url:url+'#page=1',page:3}),/conflict|different/i);
  for(const value of [0,-1,1.5,4,Number.MAX_SAFE_INTEGER+1])await assert.rejects(tools.execute('acres_fetch_url',{url,page:value}),/page/i);
});

test('blank PDF pages produce no evidence instead of borrowing a neighboring page',async()=>{
  const tools=toolsFor(document());await assert.rejects(tools.execute('acres_fetch_url',{url,page:2}),/no extractable text|blank|scanned/i);assert.equal(tools.sources.length,0);
});

test('character paging within a selected PDF page cannot spill into the next page',async()=>{
  const first='FIRST '+ 'A'.repeat(30000),second='SECOND-PHYSICAL-PAGE '+ 'B'.repeat(500),text=first+'\n\n'+second;
  const tools=toolsFor({url,title:source.title,text,method:'direct',pdfPages:[{page:1,start:0,end:first.length},{page:2,start:first.length+2,end:text.length}]});
  const a=await tools.execute('acres_fetch_url',{url,page:1}),b=await tools.execute('acres_fetch_url',{url,page:1,offset:a.nextOffset});assert.equal(a.text.length,24000);assert.equal(b.nextOffset,null);assert.equal(a.text+b.text,first);assert.doesNotMatch(b.text,/SECOND-PHYSICAL/);assert.equal(b.url,url+'#page=1');assert.notEqual(a.sourceId,b.sourceId);
});

test('finding a phrase in a PDF returns its physical page and a page-specific citation',async()=>{
  const tools=toolsFor(document()),out=await tools.execute('acres_fetch_url',{url,find:'APPENDIX-REVIEW'});assert.equal(out.pdf.page,3);assert.equal(out.url,url+'#page=3');assert.notEqual(out.matchedIndex,null);assert.doesNotMatch(out.text,/FIRST-PAGE-GUIDANCE/);assert.match(tools.sources[0].title,/PDF page 3 of 3/);
  const needle='EXACT [A.1]+(z)',first='İ'.repeat(200)+' '+needle,second='SECOND-PAGE '+ 'B'.repeat(500),text=first+'\n\n'+second;
  const unicode=toolsFor({url,title:source.title,text,method:'direct',pdfPages:[{page:1,start:0,end:first.length},{page:2,start:first.length+2,end:text.length}]}),found=await unicode.execute('acres_fetch_url',{url,find:needle});
  assert.equal(found.pdf.page,1);assert.equal(found.matchedIndex,first.indexOf(needle));assert.doesNotMatch(found.text,/SECOND-PAGE/);
});

test('page-specific source references survive JSON and HTML report collection',async()=>{
  const tools=toolsFor(document());await tools.execute('acres_fetch_url',{url,page:1});await tools.execute('acres_fetch_url',{url,page:3});
  const deck=buildUnderwritingDeck({sources:tools.sources}),doc=parseHTML(renderDeckHtml(deck)).document,links=[...doc.querySelectorAll('#verification-and-risks a')];
  assert.ok(links.some(a=>a.getAttribute('href')===url+'#page=1'));assert.ok(links.some(a=>a.getAttribute('href')===url+'#page=3'));assert.match(doc.body.textContent,/PDF page 1 of 3/);assert.match(doc.body.textContent,/PDF page 3 of 3/);
});

test('PDF ingestion creates page-bounded chunks and search results keep physical-page provenance',async t=>{
  const f=knowledge(t),result=await f.refresh(async()=>response());assert.equal(result.failed,0);const id=f.store.source(source.id).current_version,row=f.store.one('SELECT * FROM versions WHERE id=?',id),meta=JSON.parse(row.metadata);
  assert.equal(meta.extractor,'pdf-pages-v1');assert.equal(meta.pdfPages.length,3);const chunks=f.store.all('SELECT * FROM chunks WHERE version=? ORDER BY ordinal',id);assert.ok(chunks.every(c=>/^\[PDF page (1|3) of 3\]/.test(c.text)));assert.ok(chunks.every(c=>!(c.text.includes('FIRST-PAGE-GUIDANCE')&&c.text.includes('APPENDIX-REVIEW'))));
  const search=await f.store.search({query:'APPENDIX-REVIEW',city:'US-NY-NYC'});const hit=search.results.find(r=>r.text.includes('APPENDIX-REVIEW'));assert.equal(hit.pdf.page,3);assert.equal(hit.url,url+'#page=3');assert.match(hit.title,/PDF page 3 of 3/);
});

test('legacy cached PDF bytes can supply pages without network reads or rewriting their version',async t=>{
  const f=knowledge(t),legacy=f.legacy(),prior=process.env.ACRES_KNOWLEDGE_DB;process.env.ACRES_KNOWLEDGE_DB=f.path;t.after(()=>{if(prior===undefined)delete process.env.ACRES_KNOWLEDGE_DB;else process.env.ACRES_KNOWLEDGE_DB=prior;});
  const tools=createResearchTools({}),out=await tools.execute('acres_fetch_url',{url,page:3});assert.equal(out.method,'knowledge-cache');assert.equal(out.cacheHit,true);assert.equal(out.pdf.page,3);assert.equal(tools.sources[0].knowledge.versionId,legacy.versionId);assert.equal(f.store.source(source.id).current_version,legacy.versionId);assert.equal(JSON.parse(f.store.one('SELECT metadata FROM versions WHERE id=?',legacy.versionId).metadata).extractor,'text-v3');
  const first=await tools.execute('acres_get_knowledge_source',{versionId:legacy.versionId,page:1});assert.match(first.text,/FIRST-PAGE-GUIDANCE/);assert.equal(first.pdf.page,1);
  const queryUrl=url+'?revision=other';assert.equal(f.store.findByUrl(queryUrl),null);
  const alternate={...source,id:'alternate-pdf',url:queryUrl},raw=pdfDocument([['SECOND-DOCUMENT',...Array(8).fill('A distinct query-selected document paragraph.')]]),extracted=extractText(raw,'application/pdf');
  f.store.register(alternate);const saved=f.store.publish(alternate,raw,extracted.text,{...alternate,extractor:'pdf-pages-v1',pdfPages:extracted.pdfPages},chunkText(extracted.text).map(()=>[1,0]),f.embedder.space,'2026-01-02T00:00:00.000Z');
  const separate=await tools.execute('acres_fetch_url',{url:queryUrl,page:1});assert.match(separate.text,/SECOND-DOCUMENT/);assert.equal(separate.pdf.pageCount,1);assert.equal(separate.url,queryUrl+'#page=1');assert.equal(tools.sources.find(s=>s.id===separate.sourceId).knowledge.versionId,saved.versionId);
});

test('historical PDF page reads derive from that exact version raw bytes, not a newer document',async t=>{
  const f=knowledge(t),old=f.legacy();await f.refresh(async()=>response(pdfDocument([['CHANGED-PAGE-ONE',...Array(8).fill('A changed source paragraph.')],['CHANGED-PAGE-TWO',...Array(8).fill('Another changed source paragraph.')]])));
  const latest=f.store.source(source.id).current_version,seen=new Set([old.versionId,latest]),records=[],handlers=createKnowledgeHandlers({open:()=>new KnowledgeStore(f.path),seen,record:value=>{records.push(value);return {id:records.length};}});
  const historical=await handlers.acres_get_knowledge_source({versionId:old.versionId,page:3});assert.match(historical.text,/APPENDIX-REVIEW/);assert.doesNotMatch(historical.text,/CHANGED-PAGE/);assert.equal(historical.pdf.pageCount,3);assert.equal(records[0].url,url+'#page=3');assert.equal(records[0].knowledge.versionId,old.versionId);
  const current=await handlers.acres_get_knowledge_source({versionId:latest,page:2});assert.match(current.text,/CHANGED-PAGE-TWO/);assert.equal(current.pdf.pageCount,2);assert.equal(JSON.parse(f.store.one('SELECT metadata FROM versions WHERE id=?',old.versionId).metadata).extractor,'text-v3');
});

test('PDF extractor upgrade preserves old versions and later conditional reads reuse the new version',async t=>{
  const f=knowledge(t),old=f.legacy();let firstHeaders;
  const upgraded=await f.refresh(async(_url,options)=>{firstHeaders=options.headers;return response();});assert.equal(upgraded.changed,1);assert.equal(firstHeaders['if-none-match'],undefined);
  const latest=f.store.source(source.id).current_version;assert.notEqual(latest,old.versionId);assert.equal(f.store.one('SELECT count(*) AS n FROM versions WHERE source=?',source.id).n,2);assert.equal(JSON.parse(f.store.one('SELECT metadata FROM versions WHERE id=?',old.versionId).metadata).extractor,'text-v3');assert.equal(JSON.parse(f.store.one('SELECT metadata FROM versions WHERE id=?',latest).metadata).extractor,'pdf-pages-v1');
  const embedded=f.calls.embedded,classified=f.calls.classified;const repeated=await f.refresh(async(_url,options)=>{assert.equal(options.headers['if-none-match'],'pdf-etag');return new Response(null,{status:304});});assert.equal(repeated.unchanged,1);assert.equal(f.store.source(source.id).current_version,latest);assert.equal(f.calls.embedded,embedded);assert.equal(f.calls.classified,classified);
});
