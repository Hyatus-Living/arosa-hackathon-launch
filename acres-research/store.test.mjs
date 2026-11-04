import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore,conversationTitle} from './store.mjs';
import {RunManager} from './manager.mjs';
import {safeTrace} from './trace.mjs';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'acres-store-'));const store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
test('conversations, searches, runs and traces cannot be read across accounts',t=>{
 const s=setup(t),c=s.createConversation('alice'),r=s.createRun('alice',c.id,'Research 120 Broadway');s.begin(r);s.finish(r,'completed',{answer:'C5-5 [1]',sources:[],property:{bbl:'1000477501'}});
 assert.equal(s.conversation('bob',c.id),null);assert.equal(s.run('bob',r.id),null);assert.equal(s.events('bob',r.id),null);assert.deepEqual(s.list('bob','Broadway'),[]);assert.equal(s.list('alice','Broadway').length,1);assert.equal(s.list('alice','%').length,0);
 const conv=s.conversation('alice',c.id);
 assert.equal(conv.messages.length,2);
 assert.equal(typeof conv.messages[1].durationMs,'number');
 assert.equal(typeof conv.messages[1].completedAt,'number');
 assert.equal(s.createRun('alice',c.id,'Research 120 Broadway',r.id).id,r.id);assert.equal(s.query('SELECT id FROM runs').length,1);
});
test('two first sends from one browser draft open one conversation, and only for their owner',t=>{
 const s=setup(t),draft='11111111-2222-4333-8444-555555555555',other='22222222-3333-4444-8555-666666666666';
 const first=s.createConversation('alice',{clientDraftId:draft});
 const again=s.createConversation('alice',{clientDraftId:draft});
 assert.equal(again.id,first.id,'the second tab lands in the thread the draft already opened');
 assert.equal(s.query('SELECT id FROM conversations WHERE owner=?','alice').length,1);
 assert.notEqual(s.createConversation('alice',{clientDraftId:other}).id,first.id,'a rotated draft is a new thread');
 assert.notEqual(s.createConversation('bob',{clientDraftId:draft}).id,first.id,'a draft id never crosses accounts');
 assert.notEqual(s.createConversation('alice').id,first.id,'no draft id, no dedupe');
 s.deleteConversation('alice',first.id);
 assert.notEqual(s.createConversation('alice',{clientDraftId:draft}).id,first.id,'a deleted thread frees its draft for a fresh one');
});
test('a server restart queues the interrupted run again once, then fails it on a second restart',t=>{
 const s=setup(t),c=s.createConversation('alice'),r=s.createRun('alice',c.id,'question');s.begin(r);s.recover();
 assert.equal(s.run('alice',r.id).status,'queued');assert.deepEqual(s.events('alice',r.id).at(-1),{...s.events('alice',r.id).at(-1),event:'run.requeued',attempt:2});
 const resumed=s.runRow(r.id);s.begin(resumed);assert.equal(resumed.attempt,2);
 assert.equal(s.query("SELECT count(*) n FROM messages WHERE run=? AND role='user'",r.id)[0].n,1,'the resumed run does not repeat the user message');
 s.recover();assert.equal(s.run('alice',r.id).status,'failed');assert.match(s.run('alice',r.id).error,/restarted twice/);assert.equal(s.events('alice',r.id).at(-1).event,'run.failed');
});
test('a restart never repeats a run whose paid provider call has no settled outcome',t=>{
 const s=setup(t),c=s.createConversation('alice'),settled=s.createRun('alice',c.id,'settled'),open=s.createRun('alice',s.createConversation('alice').id,'open');
 for(const r of [settled,open]){s.begin(r);s.event(r.id,'billing.invoked',{provider:'exa',operation:'EXA_SEARCH'});}
 s.event(settled.id,'billing.settled',{provider:'exa',operation:'EXA_SEARCH',amountMicros:1000});
 s.recover();
 assert.equal(s.runRow(settled.id).status,'queued','calls that settled are paid for; the run resumes');
 assert.equal(s.runRow(open.id).status,'failed');assert.match(s.runRow(open.id).error,/^The research server restarted\. Retry this message\./);
});
test('queue order, steering, cancellation and reconnect event replay',async t=>{
 const s=setup(t),c=s.createConversation('alice');let finish;const started=[];
 const m=new RunManager(s,{},async(input,_secrets,_progress,emit,onControl)=>{started.push(input.message);onControl({steer:async text=>emit('test.steer',{text}),interrupt:async()=>finish()});await new Promise(r=>{finish=r;});return {answer:'Answer [1]',sources:[],property:null};});
 const a=m.enqueue('alice',c.id,'first'),b=m.enqueue('alice',c.id,'second');assert.deepEqual(started,['first']);assert.equal(s.run('alice',b.id).status,'queued');assert.equal(await m.control('bob',a.id,'interrupt'),null);
 await m.control('alice',a.id,'steer','focus');assert.equal(s.events('alice',a.id).at(-1).event,'run.steered');await m.control('alice',b.id,'interrupt');assert.equal(s.run('alice',b.id).status,'interrupted');
 const done=new Promise(r=>m.once(a.id,e=>{if(e.event==='run.interrupted')r();}));await m.control('alice',a.id,'interrupt');await done;assert.equal(s.run('alice',a.id).status,'interrupted');assert.equal(started.length,1);assert.ok(s.events('alice',a.id,1).every(e=>e.seq>1));
});
test('traces remove credential fields, bearer strings and private reasoning',()=>{
 const cleaned=safeTrace({token:'private',nested:{api_key:'private',reasoning:'private',answer:'Bearer abc123 sk-123456789'},title:'public'});assert.equal(JSON.stringify(cleaned).includes('private'),false);assert.equal(cleaned.nested.answer,'[redacted] [redacted]');
});

test('token usage survives redaction and persists per user across conversations without leaking credentials',t=>{
 const s=setup(t),runs=[];
 for(const [index,question] of ['first conversation','second conversation'].entries()) {
  const c=s.createConversation('alice'),r=s.createRun('alice',c.id,question);s.begin(r);runs.push(r);
  s.event(r.id,'turn.started',{threadId:'thread-'+index,turnId:'turn-'+index});
  s.event(r.id,'billing.usage',{provider:'codex',usage:{inputTokens:100+index,cachedInputTokens:20,outputTokens:30,totalTokens:130+index,reasoningOutputTokens:10,accessToken:'private',reasoning:'private'}});
 }
 for(const [index,r] of runs.entries()) {
  const event=s.events('alice',r.id).find(e=>e.event==='billing.usage');
  assert.deepEqual(event.usage,{inputTokens:100+index,cachedInputTokens:20,outputTokens:30,totalTokens:130+index,reasoningOutputTokens:10});
  assert.equal(JSON.stringify(event).includes('private'),false);assert.equal(s.events('bob',r.id),null);
  assert.equal(s.events('alice',r.id).find(e=>e.event==='turn.started').threadId,'thread-'+index);
 }
 assert.equal(s.query('SELECT id FROM runs WHERE owner=?','alice').length,2);
});
test('token-count exceptions cannot pass credential strings or invalid numeric values through redaction',()=>{
 assert.deepEqual(safeTrace({inputTokens:'private-token',cachedInputTokens:-1,outputTokens:1.5,totalTokens:Infinity,reasoningOutputTokens:10,token:'private',refreshToken:'private'}),{reasoningOutputTokens:10});
});

test('a conversation is titled by its first sentence without the figures in parentheses',()=>{
  assert.equal(conversationTitle('Underwrite Woodside Ave, SI (BBL 5006180260) in R2 (83,200 SF lot, 0 SF existing building), listed at $1,300,000 ($21 per buildable SF (est.)). Compare the scenarios.'),'Underwrite Woodside Ave, SI in R2, listed at $1,300,000');
  assert.equal(conversationTitle('How much more could 120 Broadway support?'),'How much more could 120 Broadway support?');
  assert.equal(conversationTitle('[Listing page]\n\nhi'),'hi');
  assert.equal(conversationTitle('Draft the plan for this site and tell me what else could be done with it and how to finance it'),'Draft the plan for this site and tell me what else could be done with…');
});

test('wallet rows learn the conversation title of runs the account can see, and nothing else',t=>{
  const s=setup(t),c=s.createConversation('alice'),r=s.createRun('alice',c.id,'Underwrite 1 Main St (BBL 1). Then the pro forma.');
  const other=s.createConversation('bob'),hidden=s.createRun('bob',other.id,'Bob private question');
  assert.deepEqual(s.runTitles('alice',[r.id,hidden.id,'missing']),{[r.id]:'Underwrite 1 Main St'});
});
test('an answer that built the deck is marked so the chat can open it, and other answers are not',t=>{
 const s=setup(t),c=s.createConversation('alice');
 const answer=(result)=>{const r=s.createRun('alice',c.id,'Review the site');s.begin(r);s.finish(r,'completed',{answer:'Done.',sources:[],...result});return s.conversation('alice',c.id).messages.findLast(m=>m.role==='assistant');};
 assert.equal(answer({deck:{title:'Synthetic deck',slideCount:7}}).deck,true);
 assert.equal(answer({}).deck,undefined);
});
