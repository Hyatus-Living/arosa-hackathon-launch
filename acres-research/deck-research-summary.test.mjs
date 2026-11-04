import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHTML} from 'linkedom';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';

const owner='a'.repeat(24),viewer='b'.repeat(24),stranger='c'.repeat(24);
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-report-summary-')),store=new ChatStore(join(dir,'chat.sqlite')),conversation=store.createConversation(owner);
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'local-report-summary'},store,execute:async()=>{throw Error('Export must not execute research.');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true});});
  const url=`http://127.0.0.1:${server.address().port}/conversations/${conversation.id}/deck`;
  const request=(format='',account=owner)=>fetch(url+format,{headers:{authorization:'Bearer local-report-summary','x-acres-account':account}});
  const json=async()=>{const response=await request();assert.equal(response.status,200);return response.json();};
  const html=async()=>{const response=await request('?format=html');assert.equal(response.status,200);return parseHTML(await response.text()).document;};
  const seed=(text,result={})=>{const run=store.createRun(owner,conversation.id,'Review synthetic site');store.begin(run);store.finish(run,'completed',{answer:text,sources:[],...result});return store.conversation(owner,conversation.id).messages.findLast(m=>m.role==='assistant');};
  const field=(key,value,at)=>store.project.write(conversation.projectId,{[key]:{value,provenance:{run:'newer-fixture-input',sources:[]}}},at);
  return {store,conversation,url,request,json,html,seed,field};
}

test('actual report JSON and HTML retain the completed paragraph and its message, run and date',async t=>{
  const f=await fixture(t),message=f.seed('# Review\n\n**Keep the existing structure** until access is verified. [s1]\n\nCheck the recorded documents next.',{property:{bbl:'1000477501',address:'Synthetic parcel'}}),report=await f.json(),summary=report.slides[0].researchSummary;
  assert.equal(summary.text,'Keep the existing structure until access is verified.');assert.equal(summary.messageId,message.id);assert.equal(summary.runId,message.runId);assert.equal(summary.completedAt,message.completedAt);
  assert.equal(summary.contextStatus,'current');
  const doc=await f.html(),section=doc.querySelector('#executive-summary .research-summary');assert.match(section.textContent,/Keep the existing structure/);assert.equal(section.querySelector('time').getAttribute('datetime'),new Date(message.completedAt).toISOString());assert.doesNotMatch(section.textContent,/\[s1\]|Check the recorded/);
});

test('a recorded comparison thesis and a completed research summary retain their separate meaning',async t=>{
  const f=await fixture(t);f.seed('Recorded-access review is still required.',{comparisons:[{recommendation:{label:'Rental',rationale:'Rental leads under the stated comparison assumptions.'},variants:[]}]});
  const report=await f.json();assert.equal(report.slides[0].thesis,'Rental leads under the stated comparison assumptions.');assert.equal(report.slides[0].researchSummary.text,'Recorded-access review is still required.');
  const text=(await f.html()).querySelector('#executive-summary').textContent;assert.match(text,/Rental leads under/);assert.match(text,/Recorded-access review/);
});

test('failed and interrupted attempts cannot replace a completed summary',async t=>{
  const f=await fixture(t),message=f.seed('A completed research finding.');
  for(const status of ['failed','interrupted']){const run=f.store.createRun(owner,f.conversation.id,'Incomplete attempt');f.store.begin(run);f.store.finish(run,status,null,'Internal failure text');}
  assert.equal((await f.json()).slides[0].researchSummary.messageId,message.id);assert.doesNotMatch((await f.html()).querySelector('#executive-summary').textContent,/Internal failure text/);
});

test('newer parcel, market, assumption or standing-instruction inputs suppress an older summary',async t=>{
  const f=await fixture(t),message=f.seed('This finding belongs to the earlier site inputs.',{property:{bbl:'1000477501',address:'Prior fixture'}});
  for(const [key,value] of [['property',{bbl:'1000477501',address:'Prior fixture'}],['property',{bbl:'3000010001',address:'New fixture'}],['market',{submarket:'New fixture market'}],['assumptions',{landPrice:2000000}],['instructions',{market:'Use the revised scope'}]]){
    f.field(key,value,message.completedAt);assert.equal((await f.json()).slides[0].researchSummary,null);assert.doesNotMatch((await f.html()).querySelector('#executive-summary').textContent,/This finding belongs/);
  }
});

test('an independent architecture marker does not discard a still-applicable completed summary',async t=>{
  const f=await fixture(t),message=f.seed('An applicable completed research finding.');f.field('architecture',{revision:2},message.completedAt+100);
  assert.equal((await f.json()).slides[0].researchSummary.messageId,message.id);
});

test('a completed answer whose site publication was skipped cannot become the report summary',async t=>{
  const f=await fixture(t);f.seed('Earlier parcel A answer.',{property:{bbl:'1000477501',address:'Parcel A'}});
  const run=f.store.createRun(owner,f.conversation.id,'Old-context answer');f.store.begin(run);f.field('property',{bbl:'3000010001',address:'Parcel B'},Date.now()+100);
  f.store.finish(run,'completed',{answer:'An old-context conclusion for parcel A.',sources:[],property:{bbl:'1000477501',address:'Parcel A'}});
  assert.equal(f.store.runRow(run.id).result.projectUpdate.status,'not_applied');assert.equal((await f.json()).slides[0].researchSummary,null);assert.doesNotMatch((await f.html()).querySelector('#executive-summary').textContent,/old-context conclusion|Earlier parcel A/);
});

test('legacy stored assistant text uses its persisted completion date without requiring new state fields',async t=>{
  const f=await fixture(t);f.store.addMessage(f.conversation.id,null,'assistant','A retained historical answer.',{});
  const message=f.store.conversation(owner,f.conversation.id).messages[0],summary=(await f.json()).slides[0].researchSummary;
  assert.equal(summary.messageId,message.id);assert.equal(summary.completedAt,message.created);assert.equal(summary.runId,null);assert.equal(summary.text,'A retained historical answer.');
  assert.equal(summary.contextStatus,'unverified');assert.match((await f.html()).querySelector('.research-summary').textContent,/match to the current site inputs is unverified/);
});

test('report summaries render stored text without creating HTML elements or retaining citation tokens',async t=>{
  const f=await fixture(t);f.seed('# Review\n\n<img src=x onerror=alert(1)> **Keep** [the source](https://example.com/source). [s12]');
  const doc=await f.html(),summary=doc.querySelector('.research-summary');assert.equal(summary.querySelector('img'),null);assert.match(summary.textContent,/<img src=x onerror=alert\(1\)> Keep the source\./);assert.doesNotMatch(summary.textContent,/\[s12\]/);
});

test('empty or heading-only answers do not invent a completed institutional synthesis',async t=>{
  const f=await fixture(t);f.seed('# Review\n\n[s1]');const cover=(await f.json()).slides[0];assert.equal(cover.researchSummary,null);assert.equal(cover.thesis,null);
  const text=(await f.html()).querySelector('#executive-summary').textContent;assert.doesNotMatch(text,/Integrated zoning, massing|grounded in primary municipal records/);assert.match(text,/No research summary/);
});

test('viewer report reads retain attribution while a private outsider still receives 404',async t=>{
  const f=await fixture(t),message=f.seed('A shared completed finding.');f.store.grantMember(owner,f.conversation.id,'account',viewer,'viewer');
  const response=await f.request('',viewer);assert.equal(response.status,200);assert.equal((await response.json()).slides[0].researchSummary.messageId,message.id);assert.equal((await f.request('',stranger)).status,404);
});

test('the summary is a bounded first paragraph rather than the complete research transcript',async t=>{
  const f=await fixture(t);f.seed('A finding with context. '.repeat(40)+'\n\nA different later paragraph.');const summary=(await f.json()).slides[0].researchSummary.text;
  assert.ok(summary.length<=550);assert.match(summary,/…$/);assert.doesNotMatch(summary,/different later/);
});

test('an answer-only result from changed context cannot spoof report applicability',async t=>{
  const f=await fixture(t);f.seed('Earlier context.',{property:{bbl:'1000477501',address:'Parcel A'}});
  const run=f.store.createRun(owner,f.conversation.id,'Answer from old context');f.store.begin(run);f.field('property',{bbl:'3000010001',address:'Parcel B'},Date.now());
  f.store.finish(run,'completed',{answer:'Old-context answer without published fields.',sources:[],reportContext:{projectId:f.conversation.projectId,fingerprint:'forged'}});
  const message=f.store.conversation(owner,f.conversation.id).messages.at(-1);assert.equal(message.reportContext.fingerprint,null);assert.equal(Object.hasOwn(f.store.runRow(run.id).result,'reportContext'),false);
  assert.equal((await f.json()).slides[0].researchSummary,null);
});

test('a viewer-owned attached conversation can export its applicable read-only research answer',async t=>{
  const f=await fixture(t);f.seed('Initial site research.',{property:{bbl:'1000477501',address:'Synthetic parcel'}});f.store.grantMember(owner,f.conversation.id,'account',viewer,'viewer');
  const attached=f.store.createConversation(viewer,{projectId:f.conversation.projectId}),run=f.store.createRun(viewer,attached.id,'Read-only research');f.store.begin(run);f.store.finish(run,'completed',{answer:'An applicable read-only finding.',sources:[],property:{bbl:'1000477501',address:'Synthetic parcel'}});
  const response=await fetch(f.url.replace(f.conversation.id,attached.id),{headers:{authorization:'Bearer local-report-summary','x-acres-account':viewer}});assert.equal(response.status,200);const summary=(await response.json()).slides[0].researchSummary;
  assert.equal(summary.text,'An applicable read-only finding.');assert.equal(summary.contextStatus,'current');assert.equal(summary.runId,run.id);assert.equal(f.store.projectView(viewer,f.conversation.projectId).access,'viewer');
  const different=f.store.createRun(viewer,attached.id,'Read-only research about another parcel');f.store.begin(different);f.store.finish(different,'completed',{answer:'A finding about parcel B that cannot update this site.',sources:[],property:{bbl:'3000010001',address:'Parcel B'}});
  const newer=f.store.conversation(viewer,attached.id).messages.at(-1);assert.equal(newer.reportContext.fingerprint,null);
  const retained=await fetch(f.url.replace(f.conversation.id,attached.id),{headers:{authorization:'Bearer local-report-summary','x-acres-account':viewer}});assert.equal((await retained.json()).slides[0].researchSummary.runId,run.id);
});
