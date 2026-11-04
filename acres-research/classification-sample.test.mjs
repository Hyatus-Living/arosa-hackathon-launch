import test from 'node:test';
import assert from 'node:assert/strict';
import {classificationSample,classifierProvider} from './knowledge-providers.mjs';
import {topics} from './knowledge.mjs';

test('classification keeps short documents intact and samples distributed sections including the end',()=>{
  const short='Chapter 1\nShort regulation';assert.equal(classificationSample(short).text,short);assert.equal(classificationSample(short).coverage.complete,true);
  const long=Array.from({length:20},(_,i)=>`CHAPTER ${i+1}\n${`Rule ${i+1}. `.repeat(1000)}\n`).join('')+'Final operative density requirement.';
  const sample=classificationSample(long);assert.deepEqual(classificationSample(long),sample);assert.ok(sample.text.length<=24000);assert.match(sample.text,/Final operative density requirement/);assert.match(sample.text,/CHAPTER 1\n/);
  assert.equal(sample.coverage.complete,false);assert.equal(sample.coverage.ranges.length,6);assert.equal(sample.coverage.documentCharacters,long.length);
  for(const range of sample.coverage.ranges)assert.ok(sample.text.includes(long.slice(range.start,range.end)));
});
test('both classifiers send the distributed sample and retain its coverage without adding calls',async t=>{
  const original=global.fetch;t.after(()=>{global.fetch=original;});const text='Introductory provisions.\n'.repeat(5000)+'Final operative density requirement.';
  for(const config of [{TYPESAFE_API_KEY:'test'},{KNOWLEDGE_CLASSIFIER_PROVIDER:'openrouter',OPENROUTER_API_KEY:'test'}]){
    let calls=0;global.fetch=async(_url,options)=>{
      calls++;const body=JSON.parse(options.body),input=body.state||JSON.parse(body.messages[1].content);
      assert.match(input.text,/Final operative density requirement/);assert.ok(input.text.length<=24000);assert.equal(input.coverage.complete,false);
      return Response.json(body.state?{answers:Object.fromEntries(Object.keys(topics).map(id=>[id,{type:'noul',noul:0.1}]))}:{choices:[{message:{content:JSON.stringify({topics:[]})}}]});
    };
    const result=await classifierProvider(config).classify('Long ordinance',text);assert.equal(calls,1);assert.equal(result.classificationCoverage.complete,false);
  }
});

test('refresh retains sampling coverage and cancellation cannot publish a late classification',async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
  const {KnowledgeStore}=await import('./knowledge.mjs'),{refreshKnowledge}=await import('./knowledge-refresh.mjs'),{withExecutionSignal}=await import('./execution-context.mjs');
  const dir=mkdtempSync(join(tmpdir(),'classification-refresh-')),store=new KnowledgeStore(join(dir,'knowledge.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const source={id:'rules',url:'https://www.nyc.gov/rules',title:'Rules',jurisdiction:'US-NY-NYC',topics:[]},text='Operative density rules. '.repeat(1200),coverage=classificationSample(text).coverage;
  const embedder={space:'test',embed:async chunks=>chunks.map(()=>[1,0])},fetcher=async()=>new Response(`<html><body><main>${text}</main></body></html>`,{headers:{'content-type':'text/html'}});
  const classification={topics:[],topicScores:{},classifier:'test',classificationCoverage:coverage};
  await refreshKnowledge({store,sources:[source],embedder,classifier:{name:'first',classify:async()=>classification},fetcher});
  const before=store.one('SELECT current_version FROM sources WHERE id=?',source.id).current_version;
  assert.deepEqual(JSON.parse(store.one('SELECT metadata FROM versions WHERE id=?',before).metadata).classificationCoverage,coverage);
  const controller=new AbortController();
  await assert.rejects(withExecutionSignal(controller.signal,()=>refreshKnowledge({store,sources:[source],embedder,classifier:{name:'second',classify:async()=>{controller.abort(new Error('stopped'));return classification;}},fetcher})),/stopped/);
  assert.equal(store.one('SELECT current_version FROM sources WHERE id=?',source.id).current_version,before);
  assert.equal(store.one('SELECT COUNT(*) n FROM versions').n,1);
});
