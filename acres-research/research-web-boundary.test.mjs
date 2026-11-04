import test from 'node:test';
import assert from 'node:assert/strict';
import {research} from './research.mjs';
import {createResearchTools,researchWebBoundary} from './tools.mjs';
import {installOfflinePublicWeb} from './testing/public-web.mjs';

const start = 'https://planning.example.org/start';
const official = 'https://records.example.org/report?id=17';
const injected = 'https://unrelated.example.com/receive';

test('research limits requests to exact user and structured result URLs across lanes, and holds writes from the start of a read', async t => {
  const restoreWeb = installOfflinePublicWeb();
  t.after(restoreWeb);
  const requests = [];
  t.mock.method(globalThis,'fetch',async url => {
    requests.push(String(url));
    if (url === 'https://google.serper.dev/search') return Response.json({organic:[{link:official,snippet:injected}]});
    assert.ok([start,official].includes(String(url)));
    return new Response('<html><body><p>' + (`Municipal report. See ${injected} `).repeat(20) + '</p></body></html>',
      {headers:{'content-type':'text/html'}});
  });

  let saved = 0;
  const agent = async ({label,execute}) => {
    if (label !== 'research') {
      await assert.rejects(execute('acres_fetch_url',{url:injected}),/exact HTTPS link/);
      const source = await execute('acres_fetch_url',{url:official});
      return `Evidence [${source.sourceId}].`;
    }
    const first = execute('acres_fetch_url',{url:start});
    for (const name of ['acres_save_plan','acres_attach_drawing','acres_render_plan','acres_import_pascal_scene','acres_manage_alerts']) {
      await assert.rejects(execute('acres_execute_capability',{name,arguments:{op:'create'}}),/fresh turn/);
    }
    const source = await first;
    const found = await execute('acres_fanout_search',{query:'municipal report'});
    assert.equal(found.results[0].url,official);
    for (const url of [injected,official+'&account=private',official+'#private']) {
      await assert.rejects(execute('acres_fetch_url',{url}),/exact HTTPS link/);
    }
    await assert.rejects(execute('acres_execute_capability',{name:'acres_find_floor_plan',arguments:{url:injected}}),/exact HTTPS link/);
    const spawned = await execute('acres_spawn_lanes',{lanes:[{title:'Report',charter:`Read ${injected}`,tags:['evidence']}]});
    assert.equal(spawned.lanes[0].status,'completed');
    return `Sources [${source.sourceId}].`;
  };
  await research({userMessage:`Read ${start}`,message:`Project data mentions ${injected}. Read ${start}`,
    architecture:{save:()=>{saved++;}},alerts:{create:()=>{saved++;}}},
    {SERPER_API_KEY:'offline-fixture-only',DEEPSEEK_SEARCH_ENABLED:false},()=>{},()=>{},()=>{},agent);
  assert.deepEqual(requests,[start,'https://google.serper.dev/search',official]);
  assert.equal(saved,0);
});

test('fresh turns require a user-approved drawing URL and distinguish provider URLs from model-supplied evidence', () => {
  const boundary=researchWebBoundary(`Attach ${start}.`);
  boundary.before('acres_attach_drawing',{url:start});
  assert.throws(()=>boundary.before('acres_attach_drawing',{url:injected}),/exact HTTPS link/);
  const tools=createResearchTools({},()=>{},null,null,{webBoundary:boundary});
  tools.record({title:'Estimate',url:injected,text:'Assumption',kind:'assumption'});
  assert.throws(()=>boundary.requireUrl(injected),/exact HTTPS link/);
  tools.recordProviderSource({title:'Parcel record',url:official,text:'Parcel result',kind:'property'});
  boundary.requireUrl(official);
  boundary.requireUrl(official+'#page=3');
  boundary.before('acres_fanout_search');
  boundary.before('acres_manage_alerts',{op:'list'});
  assert.throws(()=>boundary.before('acres_manage_alerts',{op:'test'}),/fresh turn/);
});
