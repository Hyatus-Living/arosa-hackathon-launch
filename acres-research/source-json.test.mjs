import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractText,refreshKnowledge,JSON_EXTRACTOR} from './knowledge-refresh.mjs';
import {KnowledgeStore,hash} from './knowledge.mjs';
import {createUrlFetcher} from './fetch-url.mjs';
import {fetchReviewSources} from './listing-investigation-provider.mjs';

const url="https://data.cityofnewyork.us/resource/bnx9-e6tj.json?$where=document_id%3D'fixture-record'&$limit=1";
const raw='[{"document_id":"fixture-record","doc_type":"DEED","document_amt":"1250000.00","document_date":"2026-01-02T00:00:00.000","recorded_datetime":"2026-01-05T00:00:00.000","name":"Café owner","record_number":9007199254740993,"recorded":true,"notes":null}]';
const context={listing:{address:'Fixture address'},depth:'standard',objective:'acquisition screening'};
const fetcherFor=directRequest=>createUrlFetcher({},{lookup:async()=>[{address:'93.184.216.34',family:4}],directRequest});
const jsonResponse=()=>new Response(raw,{headers:{'content-type':'application/json; charset=utf-8',etag:'record-v1'}});

test('JSON extraction preserves exact fields, values and large record numbers without interpreting them',()=>{
  for(const contentType of ['application/json; charset=utf-8','application/geo+json']) {
    const result=extractText(Buffer.from(raw),contentType);
    assert.equal(result.text,raw);
    assert.equal(result.extractor,JSON_EXTRACTOR);
    assert.equal(result.publishedAt,null,'record dates do not establish a source publication date');
    assert.equal(result.title,null);
  }
  assert.throws(()=>extractText(Buffer.from('[{"document_id":'), 'application/json'),/malformed JSON/);
  for(const scalar of ['null','"no records"','42'])assert.throws(()=>extractText(Buffer.from(scalar),'application/json'),/object or array/);
});

test('direct JSON review evidence retains the exact bounded query and source row',async()=>{
  const requests=[];
  const fetcher=fetcherFor(async(requested,options)=>{requests.push(requested);assert.equal(options.redirect,'manual');assert.ok(options.signal);return jsonResponse();});
  const [result]=await fetchReviewSources([{id:3,url,title:'Recorded document'}],context,undefined,fetcher);
  assert.deepEqual(requests,[url]);
  assert.equal(result.reference,'W3');assert.equal(result.status,'retrieved');
  assert.equal(result.url,url);assert.equal(result.text,raw);assert.equal(result.excerpted,false);
});

test('malformed JSON and unavailable responses cannot become usable review evidence',async()=>{
  for(const response of [()=>new Response('{broken',{headers:{'content-type':'application/json'}}),()=>new Response('Unavailable',{status:503})]) {
    const [result]=await fetchReviewSources([{id:1,url,title:'Recorded document'}],context,undefined,fetcherFor(async()=>response()));
    assert.equal(result.status,'unavailable');assert.equal(result.url,url);assert.equal(result.text,undefined);
  }
});

test('JSON knowledge versions retain raw evidence and reuse conditional reads with the JSON extractor',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-source-json-')),store=new KnowledgeStore(join(dir,'knowledge.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const source={id:'structured-record',url,title:'Recorded document',jurisdiction:'US-NY-NYC',topics:['property_records'],authority:'official_agency',kind:'record'};
  const embedder={space:'json-fixture:1',async embed(texts){return texts.map(()=>[1,0]);}};
  const classifier={name:'json-fixture',async classify(){return {topics:['property_records'],topicScores:{property_records:1},classifier:'json-fixture'};}};
  const first=await refreshKnowledge({store,sources:[source],embedder,classifier,fetcher:async()=>jsonResponse()});
  assert.equal(first.changed,1);assert.equal(first.failed,0);
  const version=store.one('SELECT * FROM versions WHERE id=?',store.source(source.id).current_version);
  assert.equal(version.text,raw);assert.equal(version.raw_hash,hash(Buffer.from(raw)));
  assert.equal(JSON.parse(version.metadata).extractor,JSON_EXTRACTOR);assert.equal(JSON.parse(version.metadata).url,url);
  const second=await refreshKnowledge({store,sources:[source],embedder,classifier,fetcher:async(_url,{headers})=>{
    assert.equal(headers['if-none-match'],'record-v1');return new Response(null,{status:304});
  }});
  assert.equal(second.unchanged,1);assert.equal(second.failed,0);
  assert.equal(store.one('SELECT count(*) AS n FROM versions').n,1);
});
