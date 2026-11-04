import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {KnowledgeStore,chunkSourceText} from '../../acres-research/knowledge.mjs';
import {workspaceClaim} from '../dist/auth.js';
import {fixture,call,toolError,accountA,accountB} from './fixture.mjs';

test('MCP preserves a complete captured document across pages, reconnects and source updates within its owner and retention',async t=>{
  const f=await fixture();
  try{
    const corpusPath=join(dirname(f.evidence.db.prepare('PRAGMA database_list').get().file),'corpus.sqlite');
    const source={id:'nyc-zr',url:'https://www.nyc.gov/synthetic-mcp-source.pdf',title:'Synthetic continuation fixture',jurisdiction:'US-NY-NYC',kind:'guidance',topics:['development_capacity']};
    // Page ranges model extracted PDF metadata. This tests transport continuity, not PDF extraction.
    const sections=['Introductory fixture context 🏘️.\n'.repeat(1900),'Middle fixture context 🧱.\n'.repeat(1900),'Quasar covenant fixture terminus, including the final character Ω.'];
    const text=sections.join('\n\n'),pages=[];let position=0;
    sections.forEach((section,index)=>{pages.push({page:index+1,start:position,end:position+section.length});position+=section.length+2;});
    function publish(value,pdfPages=pages){
      const corpus=new KnowledgeStore(corpusPath);
      try{
        corpus.register(source);
        return corpus.publish(source,Buffer.from(value),value,{...source,pdfPages},chunkSourceText(value,pdfPages).map(()=>[1,0]),'fixture',new Date().toISOString()).versionId;
      }finally{corpus.close();}
    }
    const version=publish(text),client=await f.connect();
    const found=await call(client,'search',{query:'Quasar covenant'});assert.equal(found.results.length,1);
    const id=found.results[0].id,excerpt=await call(client,'fetch',{id});
    assert.match(excerpt.text,/Quasar covenant/);assert.equal(excerpt.metadata.versionId,version);
    assert.deepEqual(excerpt.metadata.excerpt.pdf,{page:3,pageCount:3,extractor:'pdf-pages-v1'});
    assert.equal(excerpt.metadata.documentOffset,null);assert.equal(excerpt.metadata.nextOffset,0);
    const digest=createHash('sha256').update(text).digest('hex');assert.equal(excerpt.metadata.documentHash,digest);
    assert.equal(excerpt.metadata.documentCharacters,text.length);assert.equal(excerpt.metadata.untrusted,true);
    assert.deepEqual(excerpt.metadata.documentPdfPages,pages);
    assert.equal(text.slice(pages[2].start,pages[2].end),sections[2]);
    async function complete(connection){
      let offset=0,restored='';const offsets=[];
      do{
        const page=await call(connection,'fetch',{id,offset});
        assert.equal(page.metadata.documentOffset,offset);assert.equal(page.metadata.documentHash,digest);
        assert.equal(page.metadata.versionId,version);assert.deepEqual(page.metadata.excerpt,excerpt.metadata.excerpt);
        assert.deepEqual(page.metadata.documentPdfPages,pages);
        assert.ok(page.text.length>0&&page.text.length<=48000);restored+=page.text;offsets.push(offset);
        const next=page.metadata.nextOffset;
        assert.ok(next===null||Number.isSafeInteger(next)&&next>offset);assert.ok(offsets.length<10);offset=next;
      }while(offset!==null);
      assert.equal(restored,text);assert.equal(createHash('sha256').update(restored).digest('hex'),digest);
      assert.ok(offsets.length>=3);
      return offsets;
    }
    const offsets=await complete(client);
    assert.equal((await toolError(client,'fetch',{id,offset:text.length})).error.code,'INVALID_INPUT');
    const otherAccount=await f.connect('google|user-b');
    assert.equal((await toolError(otherAccount,'fetch',{id,offset:0})).error.code,'SOURCE_NOT_FOUND');
    f.members.push({subject:'google|user-a',accountId:accountA,workspaceId:'other',enabled:true,scopes:['acres:read']});
    const otherWorkspace=await f.connect('google|user-a',{}, {[workspaceClaim]:'other'});
    assert.equal((await toolError(otherWorkspace,'fetch',{id,offset:0})).error.code,'SOURCE_NOT_FOUND');
    await f.restart();
    const reconnected=await f.connect('google|user-a',{}, {[workspaceClaim]:'pilot'});assert.deepEqual(await call(reconnected,'fetch',{id}),excerpt);await complete(reconnected);
    const replacement=text+'\nA later Quasar covenant fixture revision.';
    const changedPages=pages.map(page=>({...page}));changedPages[2].end=replacement.length;
    const newVersion=publish(replacement,changedPages);assert.notEqual(newVersion,version);
    const newSearch=await call(reconnected,'search',{query:'Quasar covenant'});assert.equal(newSearch.results.length,1);
    assert.notEqual(newSearch.results[0].id,id);const later=await call(reconnected,'fetch',{id:newSearch.results[0].id});assert.equal(later.metadata.versionId,newVersion);assert.deepEqual(later.metadata.documentPdfPages,changedPages);
    await complete(reconnected);assert.deepEqual(await call(reconnected,'fetch',{id}),excerpt);
    const ownerA=`pilot:${accountA}`,ownerB=`pilot:${accountB}`;
    const independent=f.evidence.record(ownerB,{...source,text,pdfPages:pages,versionId:version,excerpt:{text:excerpt.text,...excerpt.metadata.excerpt}});
    assert.notEqual(independent.id,id);assert.equal(f.evidence.db.prepare('SELECT count(*) n FROM evidence_documents').get().n,3);
    f.evidence.deleteOwner(ownerA);
    assert.equal((await toolError(reconnected,'fetch',{id,offset:0})).error.code,'SOURCE_NOT_FOUND');
    const survivor=await f.connect('google|user-b');assert.equal((await call(survivor,'fetch',{id:independent.id,offset:0})).text,text.slice(0,48000));
    assert.equal(f.evidence.db.prepare('SELECT count(*) n FROM evidence_documents').get().n,1);
    const future=Date.now()+31*86400000;f.evidence.now=()=>future;
    assert.equal((await toolError(survivor,'fetch',{id:independent.id,offset:0})).error.code,'SOURCE_NOT_FOUND');
    f.evidence.prune();assert.equal(f.evidence.db.prepare('SELECT count(*) n FROM evidence_documents').get().n,0);
    t.diagnostic(JSON.stringify({characters:text.length,documentHash:digest,offsets,reconnect:true,versionImmutable:true,accountIsolation:true,workspaceIsolation:true,ownerDeletion:true,expiry:true}));
  }finally{await f.done();}
});
