import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,chunkText} from './knowledge.mjs';
import {EvidenceStore} from './mcp-store.mjs';
import {createMcpDomain} from './mcp-domain.mjs';

test('MCP search retains its matched excerpt and every character of the immutable document',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-mcp-pages-')),path=join(dir,'knowledge.sqlite');
  const evidence=new EvidenceStore(join(dir,'evidence.sqlite'));
  t.after(()=>{evidence.close();rmSync(dir,{recursive:true,force:true});});
  const k=new KnowledgeStore(path),source={id:'long',url:'https://www.nyc.gov/long',title:'Rules',jurisdiction:'US-NY-NYC',topics:[],kind:'guidance'};
  const text='Unrelated introductory rules 🏘️.\n\n'.repeat(2200)+'Quasar permit requirements apply to the final section.\n';
  k.register(source);const version=k.publish(source,Buffer.from(text),text,source,chunkText(text).map(()=>[1,0]),'test',new Date().toISOString());k.close();
  let fullVersionReads=0;
  const domain=createMcpDomain({evidence,releasedSourceIds:['long'],openCorpus:()=>{
    const store=new KnowledgeStore(path,{readOnly:true}),one=store.one.bind(store);
    store.one=(sql,...args)=>{if(sql.includes('FROM versions WHERE id=')){fullVersionReads++;assert.doesNotMatch(sql,/SELECT \*/);}return one(sql,...args);};return store;
  }});
  const context={accountId:'a'.repeat(24),workspaceId:'pilot'};
  const result=await domain.call('search',{query:'Quasar permit'},context);
  assert.ok(result.results.length);assert.equal(fullVersionReads,1);
  const id=result.results[0].id,matched=await domain.call('fetch',{id},context);
  assert.match(matched.text,/Quasar/);assert.equal(matched.metadata.versionId,version.versionId);
  assert.ok(matched.metadata.excerpt.chunkId);assert.equal(matched.metadata.documentOffset,null);
  assert.equal(matched.metadata.nextOffset,0);assert.equal(matched.metadata.documentCharacters,text.length);
  let offset=0,full='';
  do {const page=await domain.call('fetch',{id,offset},context);assert.ok(page.text.length<=48000);assert.equal(page.metadata.documentOffset,offset);full+=page.text;offset=page.metadata.nextOffset;} while(offset!==null);
  assert.equal(full,text);
  await assert.rejects(domain.call('fetch',{id,offset:text.length},context),error=>error.code==='INVALID_INPUT');
  await assert.rejects(domain.call('fetch',{id,offset:0},{...context,accountId:'b'.repeat(24)}),error=>error.code==='SOURCE_NOT_FOUND');
  assert.deepEqual(await domain.call('fetch',{id},context),matched);
  assert.equal(evidence.db.prepare('SELECT count(*) n FROM evidence_documents').get().n,1);
});

test('evidence pages preserve PDF excerpt identity, retention, and explicit rerecording after expiry',t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-evidence-pages-'));let now=Date.now();
  const store=new EvidenceStore(join(dir,'evidence.sqlite'),{now:()=>now,retentionDays:1});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const source={url:'https://www.nyc.gov/rules.pdf#page=3',text:'first page\n'.repeat(5000)+'third page target',versionId:'v1',excerpt:{text:'[PDF page 3 of 3]\nthird page target',chunkId:'c3',ordinal:2,pdf:{page:3,pageCount:3,extractor:'pdf-pages-v1'}}};
  const first=store.record('owner',source);
  assert.match(first.text,/page 3/);assert.equal(first.metadata.excerpt.pdf.page,3);
  assert.equal(store.fetch('other',first.id,{offset:0}),null);
  now+=86400001;assert.equal(store.fetch('owner',first.id),null);
  const again=store.record('owner',source);assert.equal(again.id,first.id);assert.notEqual(again.metadata.retrievedAt,first.metadata.retrievedAt);
  assert.equal(store.fetch('owner',again.id,{offset:48000}).text,source.text.slice(48000));
  store.deleteOwner('owner');assert.equal(store.db.prepare('SELECT count(*) n FROM evidence_documents').get().n,0);
});

test('freshness changes create new evidence without rewriting an earlier observation',t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-evidence-freshness-')),store=new EvidenceStore(join(dir,'evidence.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const source={url:'https://www.nyc.gov/rules',text:'Stable rule text.',lastChecked:'2026-10-01T00:00:00Z',lastAttempted:'2026-10-01T00:00:00Z',stale:false,refreshFailed:false};
  const fresh=store.record('owner',source),failed=store.record('owner',{...source,lastAttempted:'2026-10-02T00:00:00Z',stale:true,refreshFailed:true});
  assert.notEqual(failed.id,fresh.id);assert.equal(failed.metadata.refreshFailed,true);assert.equal(failed.metadata.lastChecked,source.lastChecked);
  assert.deepEqual(store.fetch('owner',fresh.id),fresh);assert.equal(store.db.prepare('SELECT count(*) n FROM evidence_documents').get().n,1);
});
