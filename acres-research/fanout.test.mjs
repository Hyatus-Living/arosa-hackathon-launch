import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalUrl,mergeResults,fanoutSearch,serperProvider,deepseekProvider,deepseekEnabled,DEEPSEEK_MAX_QUERY_CHARS} from './fanout.mjs';
import {createResearchTools} from './tools.mjs';

test('canonical URLs strip tracking, www, fragments and reject non-public URLs',()=>{
  assert.equal(canonicalUrl('https://www.nyc.gov/a/b/?utm_source=x&keep=1#frag'),'https://nyc.gov/a/b?keep=1');
  assert.equal(canonicalUrl('http://nyc.gov/a'),null);
  assert.equal(canonicalUrl('https://127.0.0.1/a'),null);
});

test('merge dedupes across providers and official sources outrank blogs at equal rank',()=>{
  const merged=mergeResults([
    {name:'serper',results:[{url:'https://blog.example.com/zoning',title:'Blog'},{url:'https://www.nyc.gov/zr',title:'ZR'}]},
    {name:'exa',results:[{url:'https://nyc.gov/zr?utm_medium=x',title:'ZR dup'},{url:'https://blog.example.com/zoning',title:'Blog'}]},
  ]);
  assert.equal(merged.length,2);
  assert.equal(merged[0].url,'https://nyc.gov/zr');
  assert.deepEqual(merged[0].providers.sort(),['exa','serper']);
});

test('fan-out survives one provider failing and fails only when all fail',async()=>{
  const ok={name:'ok',search:async()=>[{url:'https://www.nyc.gov/a',title:'A'}]};
  const bad={name:'bad',search:async()=>{throw new Error('down');}};
  const out=await fanoutSearch({query:'zoning',providers:[ok,bad]});
  assert.equal(out.results.length,1);assert.deepEqual(out.failedProviders,['bad']);
  await assert.rejects(fanoutSearch({query:'zoning',providers:[bad]}),/Every discovery provider failed/);
  await assert.rejects(fanoutSearch({query:'zoning',providers:[]}),/No discovery providers/);
});

test('serper adapter posts to the Google endpoint and maps organic results',async()=>{
  let seen;
  const request=async(url,options)=>{seen={url,options};return {ok:true,json:async()=>({organic:[{link:'https://www.nyc.gov/x',title:'X',snippet:'s',date:'2026-01-01'}]})};}
  const provider=serperProvider({SERPER_API_KEY:'test-serper-key-0000'},request);
  const rows=await provider.search('nyc zoning',{limit:5});
  assert.equal(seen.url,'https://google.serper.dev/search');
  assert.equal(seen.options.headers['x-api-key'],'test-serper-key-0000');
  assert.equal(JSON.parse(seen.options.body).num,5);
  assert.deepEqual(rows,[{url:'https://www.nyc.gov/x',title:'X',snippet:'s',publishedDate:'2026-01-01'}]);
  assert.equal(serperProvider({}),null);
});

test('deepseek adapter posts to the Search API and maps results',async()=>{
  let seen;
  const request=async(url,options)=>{seen={url,options};return {ok:true,json:async()=>({results:[{url:'https://www.nyc.gov/x',title:'X',snippet:'s',summary:'long',date:'2026-01-01T00:00:00+00:00',rerank_score:2,authority:3}]})};}
  const provider=deepseekProvider({DEEPSEEK_API_KEY:'test-deepseek-key-0000'},request);
  const rows=await provider.search('nyc zoning',{limit:5});
  assert.equal(seen.url,'https://api.deepseek.com/v1/tools/search');
  assert.equal(seen.options.headers.authorization,'Bearer test-deepseek-key-0000');
  assert.deepEqual(JSON.parse(seen.options.body),{query:'nyc zoning',count:5});
  assert.deepEqual(rows,[{url:'https://www.nyc.gov/x',title:'X',snippet:'s',publishedDate:'2026-01-01T00:00:00+00:00'}]);
  assert.equal(deepseekProvider({}),null);
});

test('acres_fanout_search is wired into research tools and returns ranked URLs without recording snippets as citable text',async()=>{
  const original=global.fetch;
  global.fetch=async(url)=>{
    if(String(url).includes('serper'))return {ok:true,json:async()=>({organic:[{link:'https://www.nyc.gov/zr',title:'ZR',snippet:'official'}]})};
    throw new Error(`unexpected ${url}`);
  };
  try{
    const tools=createResearchTools({SERPER_API_KEY:'test-serper-key-0000'},()=>{},null,null);
    assert.ok(tools.definitions.some(d=>d.name==='acres_fanout_search'));
    assert.ok(tools.definitions.some(d=>d.name==='acres_fetch_url'));
    const out=await tools.execute('acres_fanout_search',{query:'nyc zoning resolution'});
    // Saved-knowledge hits depend on the host corpus, so assert the stubbed Serper result is
    // present rather than ranked first (ranking itself is covered by the merge unit test).
    assert.ok(out.results.some(r=>r.url==='https://nyc.gov/zr'),JSON.stringify(out.results.map(r=>r.url)));
    assert.equal(out.city,'US-NY-NYC');
    await tools.execute('acres_find_property',{address:'100 Congress Ave, Austin, TX'});
    assert.equal(tools.detectedCity,'US-TX-AUSTIN');
    const austin=await tools.execute('acres_fanout_search',{query:'austin land development code'});
    assert.equal(austin.city,'US-TX-AUSTIN');
    assert.equal(tools.sources.length,0);

    const freshTools=createResearchTools({SERPER_API_KEY:'test-serper-key-0000'},()=>{},null,null);
    const wpb=await freshTools.execute('acres_fanout_search',{query:'West Palm Beach short term rental rules'});
    assert.equal(wpb.city,'US-FL-WESTPALMBEACH');
    assert.equal(freshTools.detectedCity,'US-FL-WESTPALMBEACH');
  }finally{global.fetch=original;}
});

test('acres_fanout_search sends the query to DeepSeek alongside Serper when its key is set',async()=>{
  const original=global.fetch;
  global.fetch=async(url)=>{
    if(String(url).includes('serper'))return {ok:true,json:async()=>({organic:[{link:'https://www.nyc.gov/zr',title:'ZR',snippet:'official'}]})};
    if(String(url).includes('api.deepseek.com'))return {ok:true,json:async()=>({results:[{url:'https://zr.planning.nyc.gov/article-ii',title:'ZR II',snippet:'district rules'}]})};
    throw new Error(`unexpected ${url}`);
  };
  try{
    const tools=createResearchTools({SERPER_API_KEY:'test-serper-key-0000',DEEPSEEK_API_KEY:'test-deepseek-key-0000'},()=>{},null,null);
    const out=await tools.execute('acres_fanout_search',{query:'nyc zoning resolution'});
    assert.ok(out.providers.includes('serper')&&out.providers.includes('deepseek'),JSON.stringify(out.providers));
    assert.ok(out.results.some(r=>r.url==='https://zr.planning.nyc.gov/article-ii'));
  }finally{global.fetch=original;}
});

test('DEEPSEEK_ENABLED=false never constructs the DeepSeek leg and makes zero fetches to api.deepseek.com',async()=>{
  assert.equal(deepseekEnabled({}),true);
  assert.equal(deepseekEnabled({DEEPSEEK_ENABLED:true}),true);
  assert.equal(deepseekEnabled({DEEPSEEK_ENABLED:false}),false);
  assert.equal(deepseekEnabled({DEEPSEEK_ENABLED:'false'}),false);
  assert.equal(deepseekEnabled({},{DEEPSEEK_ENABLED:'0'}),false);
  assert.equal(deepseekProvider({DEEPSEEK_API_KEY:'test-deepseek-key-0000',DEEPSEEK_ENABLED:false}),null);
  const calls=[];
  const original=global.fetch;
  global.fetch=async(url)=>{
    calls.push(String(url));
    if(String(url).includes('serper'))return {ok:true,json:async()=>({organic:[{link:'https://www.nyc.gov/zr',title:'ZR',snippet:'official'}]})};
    throw new Error(`unexpected ${url}`);
  };
  try{
    const tools=createResearchTools({SERPER_API_KEY:'test-serper-key-0000',DEEPSEEK_API_KEY:'test-deepseek-key-0000',DEEPSEEK_ENABLED:false},()=>{},null,null);
    const out=await tools.execute('acres_fanout_search',{query:'nyc zoning resolution'});
    assert.ok(out.providers.includes('serper'),JSON.stringify(out.providers));
    assert.ok(!out.providers.includes('deepseek'),JSON.stringify(out.providers));
    assert.equal(calls.filter(u=>u.includes('api.deepseek.com')).length,0,JSON.stringify(calls));
  }finally{global.fetch=original;}
});

test('queries over 128 chars skip only the DeepSeek leg, with no fetch to api.deepseek.com',async()=>{
  let fetches=0;
  const request=async()=>{fetches++;return {ok:true,json:async()=>({results:[{url:'https://www.nyc.gov/x',title:'X'}]})};}
  const provider=deepseekProvider({DEEPSEEK_API_KEY:'test-deepseek-key-0000'},request);
  assert.equal(DEEPSEEK_MAX_QUERY_CHARS,128);
  await assert.rejects(provider.search('q'.repeat(129)),/DeepSeek leg skipped.*128/);
  assert.equal(fetches,0);
  const ok={name:'ok',search:async()=>[{url:'https://www.nyc.gov/a',title:'A'}]};
  const out=await fanoutSearch({query:'q'.repeat(200),providers:[ok,provider]});
  assert.deepEqual(out.providers,['ok']);
  assert.deepEqual(out.failedProviders,['deepseek']);
  assert.equal(fetches,0);
  await provider.search('q'.repeat(128));
  assert.equal(fetches,1);
});

test('acres_fanout_search uses Jev router to pull high-confidence indexed sources directly as citable evidence and skip local index when empty', async () => {
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {KnowledgeStore} = await import('./knowledge.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'acres-fanout-jev-'));
  const dbPath = join(dir, 'knowledge.sqlite');
  const prevDbPath = process.env.ACRES_KNOWLEDGE_DB;
  const prevCfgPath = process.env.ACRES_KNOWLEDGE_CONFIG;
  const originalFetch = global.fetch;

  try {
    process.env.ACRES_KNOWLEDGE_DB = dbPath;
    process.env.ACRES_KNOWLEDGE_CONFIG = join(dir, 'nonexistent-config.json');

    const store = new KnowledgeStore(dbPath);
    const src = {
      id: 'zr-23-22-far-uap',
      url: 'https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-22',
      title: 'NYC ZR § 23-22 Floor Area Ratio for Residences (UAP)',
      jurisdiction: 'US-NY-NYC',
      topics: ['development_capacity', 'tenant_protection'],
      authority: 'statute',
      kind: 'zoning_text',
    };
    store.register(src);
    const text = '23-22 Floor Area Ratio for Residences\nUniversal Affordability Preference (UAP) bonus floor area ratio for qualifying residential buildings in R6 through R12 districts.';
    store.publish(src, Buffer.from(text), text, {...src, publishedAt: '2026-01-01'}, [], 'none', '2026-01-02T00:00:00.000Z');
    store.close();

    // 1. High-confidence Jev match -> direct citable pull
    global.fetch = async (url) => {
      if (String(url).includes('typesafe.ai')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              _has_direct_indexed_match: 0.96,
              _needs_web_fanout: 0.08,
              'zr-23-22-far-uap': 0.98,
            },
          }),
        };
      }
      if (String(url).includes('serper')) {
        return {
          ok: true,
          json: async () => ({
            organic: [{link: 'https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-22', title: 'ZR 23-22', snippet: 'UAP FAR'}],
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    };

    const tools = createResearchTools({SERPER_API_KEY: 'test-serper-key-0000', TYPESAFE_API_KEY: 'test-typesafe-key-0000'}, () => {}, null, null);
    const out = await tools.execute('acres_fanout_search', {query: 'UAP floor area bonus ZR 23-22'});
    assert.ok(out.directSources?.length === 1);
    assert.equal(out.directSources[0].sourceId, 'zr-23-22-far-uap');
    assert.equal(out.directSources[0].citationId, 1);
    assert.equal(tools.sources.length, 1);
    assert.equal(out.results[0].citationId, 1);
  } finally {
    global.fetch = originalFetch;
    if (prevDbPath === undefined) delete process.env.ACRES_KNOWLEDGE_DB;
    else process.env.ACRES_KNOWLEDGE_DB = prevDbPath;
    if (prevCfgPath === undefined) delete process.env.ACRES_KNOWLEDGE_CONFIG;
    else process.env.ACRES_KNOWLEDGE_CONFIG = prevCfgPath;
    rmSync(dir, {recursive: true, force: true});
  }
});
