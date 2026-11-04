import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fanoutSearch} from './fanout.mjs';
import {KnowledgeStore} from './knowledge.mjs';
import {createResearchTools} from './tools.mjs';
import {executionSignal,withExecutionSignal} from './execution-context.mjs';

test('fan-out returns explicit partial coverage at its deadline and aborts slow provider work',async()=>{
  let slowSignal,lateResolve;const events=[];
  const out=await fanoutSearch({query:'zoning',timeoutMs:20,onProvider:event=>events.push(event),providers:[
    {name:'fast',search:async()=>[{url:'https://www.nyc.gov/rules',title:'Rules',snippet:'evidence'}]},
    {name:'slow',search:()=>{slowSignal=executionSignal();return new Promise(resolve=>{lateResolve=resolve;});}},
  ]});
  assert.equal(out.partial,true);assert.deepEqual(out.providers,['fast']);assert.deepEqual(out.timedOutProviders,['slow']);
  assert.deepEqual(out.failedProviders,['slow']);assert.equal(slowSignal.aborted,true);
  assert.equal(events.length,2);lateResolve([{url:'https://www.nyc.gov/late'}]);await Promise.resolve();
  assert.equal(events.length,2);assert.equal(out.results.length,1);
});

test('parent cancellation rejects fan-out even after another provider produced usable results',async()=>{
  const controller=new AbortController();let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const running=withExecutionSignal(controller.signal,()=>fanoutSearch({query:'zoning',providers:[
    {name:'fast',search:async()=>[{url:'https://www.nyc.gov/rules'}]},
    {name:'slow',search:()=>{started();return new Promise(()=>{});}},
  ]}));
  await ready;controller.abort(new Error('stopped'));
  await assert.rejects(running,/stopped/);
});

test('broad discovery starts web requests while knowledge routing is still pending',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-fanout-start-')),path=join(dir,'knowledge.sqlite');
  const priorDb=process.env.ACRES_KNOWLEDGE_DB,priorCfg=process.env.ACRES_KNOWLEDGE_CONFIG,priorFetch=global.fetch;
  let releaseRouter,webStarted;const webReady=new Promise(resolve=>{webStarted=resolve;});
  try {
    const store=new KnowledgeStore(path),source={id:'rules',url:'https://www.nyc.gov/rules',title:'Zoning rules',jurisdiction:'US-NY-NYC',topics:[],kind:'guidance'};
    store.register(source);store.publish(source,Buffer.from('Zoning rules.'),'Zoning rules.',source,[],'none',new Date().toISOString());store.close();
    process.env.ACRES_KNOWLEDGE_DB=path;process.env.ACRES_KNOWLEDGE_CONFIG=join(dir,'absent');
    global.fetch=async url=>{
      if(String(url).includes('typesafe.ai'))return new Promise(resolve=>{releaseRouter=()=>resolve({ok:true,json:async()=>({data:{_has_direct_indexed_match:.99,_needs_web_fanout:0,rules:.99}})});});
      assert.match(String(url),/serper/);webStarted();return {ok:true,json:async()=>({organic:[{link:source.url,title:'Rules',snippet:'Zoning'}]})};
    };
    const tools=createResearchTools({SERPER_API_KEY:'test-serper-12345',TYPESAFE_API_KEY:'test-typesafe-12345'});
    const running=tools.execute('acres_fanout_search',{query:'Zoning rules'});
    await webReady;assert.equal(typeof releaseRouter,'function');releaseRouter();
    const out=await running;assert.equal(out.partial,false);assert.ok(out.providers.includes('serper'));
    assert.equal(out.jevRoute.needsWebFanout,0);assert.ok(out.directSources.length);
  } finally {
    global.fetch=priorFetch;if(priorDb===undefined)delete process.env.ACRES_KNOWLEDGE_DB;else process.env.ACRES_KNOWLEDGE_DB=priorDb;
    if(priorCfg===undefined)delete process.env.ACRES_KNOWLEDGE_CONFIG;else process.env.ACRES_KNOWLEDGE_CONFIG=priorCfg;
    rmSync(dir,{recursive:true,force:true});
  }
});
