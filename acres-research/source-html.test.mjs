import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractText,refreshKnowledge} from './knowledge-refresh.mjs';
import {createUrlFetcher} from './fetch-url.mjs';
import {KnowledgeStore,hash,chunkText} from './knowledge.mjs';

const extract=html=>extractText(Buffer.from(html),'text/html; charset=utf-8');
const sentence='The fixture requires registration before the described activity begins. ';
const rule=sentence.repeat(8).trim();
const compact=`<!doctype html><html lang=en><meta charset=utf-8><title>Fixture guidance</title><meta property="article:published_time" content="2026-01-03T09:00:00-05:00"><body><header>Site header</header><nav>Site menu</nav><div id=content><h1>Registration guidance</h1><p>${rule}</p></div><script>hiddenScript()</script><footer>Site footer</footer></body></html>`;
const source={id:'compact-source',url:'https://www.nyc.gov/compact-source',title:'Fixture guidance',jurisdiction:'US-NY-NYC',topics:['registration'],authority:'official_agency',kind:'guidance'};
const embedder={space:'html-fixture:1',async embed(texts){return texts.map(()=>[1,0]);}};
const classifier={name:'html-fixture',async classify(){return {topics:['registration'],topicScores:{registration:1},classifier:'html-fixture'};}};
function knowledgeFixture(t){
  const dir=mkdtempSync(join(tmpdir(),'acres-source-html-')),store=new KnowledgeStore(join(dir,'knowledge.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;
}

test('compact HTML with an omitted head reads the populated body and retains its publication date',()=>{
  const result=extract(compact);
  assert.match(result.text,/Registration guidance/);assert.match(result.text,/requires registration/);
  assert.doesNotMatch(result.text,/Fixture guidance|Site header|Site menu|hiddenScript|Site footer/);
  assert.equal(result.publishedAt,'2026-01-03T14:00:00.000Z');
});
test('HTML with omitted head and body tags retains all source blocks without head metadata',()=>{
  const result=extract('<!doctype html><html><meta charset=utf-8><title>Metadata title</title><h1>Actual guidance</h1><p>First source paragraph.</p><section><p>Second source paragraph.</p></section></html>');
  assert.match(result.text,/Actual guidance/);assert.match(result.text,/First source paragraph/);assert.match(result.text,/Second source paragraph/);
  assert.doesNotMatch(result.text,/Metadata title/);assert.ok(result.text.indexOf('First')<result.text.indexOf('Second'));
});
test('sibling HTML fragments preserve leading text, all blocks and trailing text once in order',()=>{
  const result=extract('Leading source text.<h1>Guidance</h1><p>First paragraph.</p><section>Second paragraph.</section>Trailing source text.');
  const parts=['Leading source text.','Guidance','First paragraph.','Second paragraph.','Trailing source text.'];
  const indexes=parts.map(part=>{assert.equal(result.text.split(part).length,2);return result.text.indexOf(part);});
  assert.deepEqual(indexes,[...indexes].sort((a,b)=>a-b));
});
test('a text-only HTML response remains source text without synthesizing a document body',()=>{
  assert.equal(extract('An ordinary source sentence.').text,'An ordinary source sentence.');
});
test('existing explicit content roots keep their priority over surrounding page furniture',()=>{
  for(const [open,close] of [['<main>','</main>'],['<div id=main-content>','</div>'],['<div class=main-content>','</div>'],['<div class=about-main-image>','</div>']]){
    const result=extract(`<html><head><title>Metadata</title></head><body>Outside before.${open}<p>Selected source.</p>${close}Outside after.<nav>Site menu.</nav></body></html>`);
    assert.equal(result.text,'Selected source.');
  }
});
test('compact blocking pages still fail before content extraction',()=>{
  for(const title of ['Access denied','Just a moment','Robot challenge'])assert.throws(()=>extract(`<html><title>${title}</title><body><p>${rule}</p></body></html>`),/blocking page/);
});
test('invalid publication dates remain unknown when the omitted-head document is readable',()=>{
  const result=extract(compact.replace('2026-01-03T09:00:00-05:00','invalid-date'));
  assert.match(result.text,/requires registration/);assert.equal(result.publishedAt,null);
});
test('empty and non-content HTML do not become usable text through metadata or scripts',()=>{
  for(const html of ['', '<html><head><title>Metadata title</title><script>hidden()</script></head><body></body></html>','<title>Metadata title</title><script>hidden()</script>'])assert.equal(extract(html).text,'');
});
test('direct URL retrieval accepts the compact source body and keeps its date and final URL',async()=>{
  const fetcher=createUrlFetcher({},{lookup:async()=>[{address:'93.184.216.34',family:4}],directRequest:async()=>new Response(compact,{headers:{'content-type':'text/html'}})});
  const result=await fetcher({url:source.url});
  assert.equal(result.method,'direct');assert.equal(result.url,source.url);assert.match(result.text,/requires registration/);
  assert.equal(result.publishedAt,'2026-01-03T14:00:00.000Z');
});
test('knowledge refresh publishes a readable compact source with exact raw evidence',async t=>{
  const store=knowledgeFixture(t);
  const result=await refreshKnowledge({store,sources:[source],embedder,classifier,fetcher:async()=>new Response(compact,{headers:{'content-type':'text/html'}})});
  assert.equal(result.failed,0);assert.equal(result.changed,1);
  const current=store.source(source.id),version=store.one('SELECT * FROM versions WHERE id=?',current.current_version);
  assert.equal(version.raw_hash,hash(Buffer.from(compact)));assert.match(version.text,/requires registration/);
  assert.equal(JSON.parse(version.metadata).publishedAt,'2026-01-03T14:00:00.000Z');
});
test('the new extraction revision reprocesses unchanged bytes while preserving the old citation version',async t=>{
  const store=knowledgeFixture(t),raw=Buffer.from(`<html><head><title>Guidance</title></head><body><main><p>${rule}</p></main></body></html>`);
  store.register(source);
  const registryHash=hash(JSON.stringify({source,embeddingSpace:embedder.space,classifier:classifier.name,extractor:'text-v2'}));
  const old=store.publish(source,raw,rule,{...source,registryHash,extractor:'text-v2'},chunkText(rule).map(()=>[1,0]),embedder.space,'2026-01-01T00:00:00.000Z',{etag:'legacy-etag'});
  const result=await refreshKnowledge({store,sources:[source],embedder,classifier,fetcher:async(_url,options)=>{assert.equal(options.headers['if-none-match'],undefined);return new Response(raw,{headers:{'content-type':'text/html',etag:'current-etag'}});}});
  assert.equal(result.changed,1);assert.equal(result.failed,0);assert.equal(result.unchanged,0);
  const current=store.source(source.id);assert.notEqual(current.current_version,old.versionId);
  const previous=store.one('SELECT * FROM versions WHERE id=?',old.versionId),version=store.one('SELECT * FROM versions WHERE id=?',current.current_version);
  assert.equal(previous.text,rule);assert.equal(JSON.parse(previous.metadata).extractor,'text-v2');
  assert.equal(version.raw_hash,previous.raw_hash);assert.equal(JSON.parse(version.metadata).extractor,'text-v4');
  assert.ok(store.one('SELECT id FROM chunks WHERE version=?',old.versionId));
  const repeat=await refreshKnowledge({store,sources:[source],embedder,classifier,fetcher:async(_url,options)=>{assert.equal(options.headers['if-none-match'],'current-etag');return new Response(null,{status:304});}});
  assert.equal(repeat.unchanged,1);assert.equal(repeat.failed,0);assert.equal(store.source(source.id).current_version,current.current_version);
});

test('data tables read one row per line with their caption, while layout tables keep headings and paragraphs as blocks',()=>{
  const data=extract('<body><table><caption>Table 1: Maximum FAR</caption><tr><th>District</th><th>FAR</th></tr><tr><td><p>R6</p><p>R7B</p></td><td>3.00<sup>1</sup></td></tr></table></body>');
  assert.equal(data.text,'Table 1: Maximum FAR\nDistrict | FAR\nR6 / R7B | 3.00[1]');
  const layout=extract('<body><table><tr><td><h2>Section 5.1 Height</h2><p>No building shall exceed 35 feet.</p><p>Exceptions apply as follows.</p><ul><li>Chimneys</li><li>Spires</li></ul><h2>Section 5.2 Setbacks</h2><p>Front yard 20 feet.</p></td></tr></table></body>');
  assert.deepEqual(layout.text.split('\n\n'),['Section 5.1 Height','No building shall exceed 35 feet.','Exceptions apply as follows.','Chimneys','Spires','Section 5.2 Setbacks','Front yard 20 feet.']);
  const headed=extract('<body><table><tr><td><h4>R6</h4><span>note</span></td><td>3.00</td></tr></table></body>');
  assert.doesNotMatch(headed.text,/R6note/);assert.match(headed.text,/R6\n\nnote/);
});

test('only footnote markers are bracketed, never ordinals, unit exponents or markers already in brackets',()=>{
  const out=extract('<body><p>1<sup>st</sup> Avenue and 10<sup>th</sup> Street, 2,500 ft<sup>2</sup> lot, FAR 7.20<sup>1</sup>, R6<sup>*</sup>, see note<sup>[2]</sup>.</p></body>');
  assert.equal(out.text,'1st Avenue and 10th Street, 2,500 ft2 lot, FAR 7.20[1], R6[*], see note[2].');
});

test('the page title is the h1 unless the title element already names it',()=>{
  assert.equal(extract('<title>NYC Department of Buildings</title><body><h1>Zoning Permits</h1><p>Body</p></body>').title,'Zoning Permits');
  assert.equal(extract('<title>23-22 Floor area | Zoning Resolution</title><body><h1>Floor area</h1><p>Body</p></body>').title,'23-22 Floor area | Zoning Resolution');
  assert.equal(extract('<title>23-22 | Zoning Resolution</title><body><p>Body</p></body>').title,'23-22 | Zoning Resolution');
  assert.equal(extract('<body><h1>Only heading</h1><p>Body</p></body>').title,'Only heading');
});
