import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,chunkText,hash} from './knowledge.mjs';

const metadata=id=>({id,url:`https://www.nyc.gov/${id}`,title:'Official text',jurisdiction:'US-NY-NYC',topics:[],kind:'guidance'});
function publish(store,id,text,vector=[1,0]){const source=metadata(id);store.register(source);return store.publish(source,Buffer.from(text),text,source,chunkText(text).map(()=>vector),'test',new Date().toISOString());}
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'acres-query-work-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

test('knowledge exact lexical retrieval loads text only for ranked candidates and uses URL index',async t=>{
  const store=new KnowledgeStore(join(fixture(t),'knowledge.sqlite'));t.after(()=>store.close());
  for(let i=0;i<220;i++)publish(store,`source-${i}`,`Unrelated passage number ${i}.`);
  const target=publish(store,'target','Quasar registration is required.');
  const result=await store.search({query:'Quasar',city:'US-NY-NYC',recordRetrieval:false});
  assert.equal(result.candidateChunks,221);assert.equal(result.loadedTextChunks,1);
  assert.equal(result.results[0].versionId,target.versionId);
  const plan=store.all('EXPLAIN QUERY PLAN SELECT id FROM sources WHERE active=1 AND url=?',metadata('target').url).map(row=>row.detail).join('\n');
  assert.match(plan,/sources_url_active/);
});

test('shared immutable vectors survive reopen but never cross a replacement database or embedding space',t=>{
  const dir=fixture(t),path=join(dir,'knowledge.sqlite'),text='Shared text with stable hash.';
  let store=new KnowledgeStore(path);publish(store,'source',text,[1,0]);store.close();
  store=new KnowledgeStore(path);let reads=0;const one=store.one.bind(store);store.one=(sql,...args)=>{if(sql.includes('FROM vectors'))reads++;return one(sql,...args);};
  assert.deepEqual(store.vector(hash(text),'test'),[1,0]);assert.equal(reads,0);
  assert.equal(store.vector(hash(text),'other'),null);assert.equal(reads,1);store.close();
  const replacement=join(dir,'replacement.sqlite');store=new KnowledgeStore(replacement);publish(store,'source',text,[0,1]);store.close();
  renameSync(replacement,path);store=new KnowledgeStore(path);
  assert.deepEqual(store.vector(hash(text),'test'),[0,1]);store.close();
});

test('failed publication cannot seed the shared vector cache and duplicate publication cannot overwrite it',t=>{
  const store=new KnowledgeStore(join(fixture(t),'knowledge.sqlite'));t.after(()=>store.close());
  const text='Vector cache rollback probe.',checked=store.checked.bind(store);
  store.checked=()=>{throw new Error('rollback');};
  assert.throws(()=>publish(store,'failed',text),/rollback/);
  assert.equal(store.vector(hash(text),'test'),null);
  store.checked=checked;publish(store,'source',text,[1,0]);publish(store,'duplicate',text,[0,1]);
  assert.deepEqual(store.vector(hash(text),'test'),[1,0]);
});

test('semantic ranking still evaluates every eligible peer, including a late stronger result',async t=>{
  const store=new KnowledgeStore(join(fixture(t),'knowledge.sqlite'));t.after(()=>store.close());
  for(let i=0;i<150;i++)publish(store,`source-${i}`,`Quasar passage ${i}.`,[0,1]);
  const target=publish(store,'last','Quasar strongest semantic passage.',[1,0]);
  const found=await store.search({query:'Quasar',city:'US-NY-NYC',recordRetrieval:false},{space:'test',embed:async()=>[[1,0]]});
  assert.equal(found.candidateChunks,151);assert.equal(found.results[0].versionId,target.versionId);
});
