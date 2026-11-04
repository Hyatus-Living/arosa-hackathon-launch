import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';

const queueSql="SELECT * FROM runs WHERE status='queued' ORDER BY created";
function local(t,automaticClose=true) {
  const dir=mkdtempSync(join(tmpdir(),'acres-queue-dispatch-')),path=join(dir,'chat.sqlite');
  let store=new ChatStore(path);
  const close=()=>{store.close();rmSync(dir,{recursive:true});};
  if(automaticClose)t.after(close);
  return {get store(){return store;},close,reopen(){store.close();store=new ChatStore(path);return store;}};
}
function controlled(t) {
  const f=local(t,false),calls=[],gates=new Map(),runs=[];let released=false;
  const manager=new RunManager(f.store,{RESEARCH_CONCURRENCY:2},async input=>{
    calls.push(input.message);
    if(!released)await new Promise(resolve=>gates.set(input.message,resolve));
    return {answer:input.message,sources:[]};
  });
  const wait=id=>{
    if(['completed','failed','interrupted'].includes(f.store.runRow(id).status))return Promise.resolve();
    return new Promise(resolve=>{const listener=e=>{if(/^run\.(completed|failed|interrupted)$/.test(e.event)){manager.off(id,listener);resolve();}};manager.on(id,listener);});
  };
  t.after(async()=>{released=true;for(const resolve of gates.values())resolve();await Promise.all(runs.map(run=>wait(run.id)));assert.equal(manager.active.size,0);f.close();});
  return {...f,manager,calls,wait,release:message=>gates.get(message)(),enqueue:(owner,conversation,message)=>{const run=manager.enqueue(owner,conversation,message);runs.push(run);return run;}};
}

test('opening an existing history-heavy store indexes only queued runs without changing history or FIFO ties',t=>{
  const f=local(t),store=f.store,conversation=store.createConversation('alice'),now=Date.now(),insert=store.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)');
  store.db.exec('BEGIN');
  for(let i=0;i<4000;i++)insert.run('history-'+i,'alice',conversation.id,['completed','failed','interrupted'][i%3],'Historic '+i,'{"answer":"Saved '+i+'"}',null,now-i-86400000,now-i-86400000);
  for(const [id,created] of [['later',now+1],['first-tie',now],['second-tie',now]])insert.run(id,'alice',conversation.id,'queued',id,null,null,created,created);
  store.db.exec('COMMIT');
  store.db.exec('DROP INDEX IF EXISTS run_queued_created');
  const before=store.query('SELECT * FROM runs ORDER BY id');
  f.reopen();
  assert.deepEqual(f.store.query('SELECT * FROM runs ORDER BY id'),before);
  assert.deepEqual(f.store.query(queueSql).map(r=>r.id),['first-tie','second-tie','later']);
  const plan=f.store.query('EXPLAIN QUERY PLAN '+queueSql).map(r=>r.detail);
  assert.ok(plan.some(detail=>detail.includes('USING INDEX run_queued_created')),plan.join('; '));
  assert.ok(plan.every(detail=>!detail.includes('TEMP B-TREE')));
  assert.equal(f.store.one("SELECT sum(ncell) AS cells FROM dbstat WHERE name='run_queued_created'").cells,3);
});

test('a full research worker pool does not read the queue, and completion still dispatches waiting work',async t=>{
  const f=controlled(t),a=f.store.createConversation('alice'),b=f.store.createConversation('bob'),c=f.store.createConversation('charlie');
  const first=f.enqueue('alice',a.id,'first'),second=f.enqueue('bob',b.id,'second');
  const query=f.store.query.bind(f.store);let queueReads=0;
  f.store.query=(sql,...args)=>{if(sql===queueSql)queueReads++;return query(sql,...args);};
  const third=f.enqueue('charlie',c.id,'third');
  f.manager.pump();f.manager.pump();
  assert.equal(queueReads,0);
  assert.deepEqual(f.calls,['first','second']);
  f.release('second');await f.wait(second.id);
  assert.deepEqual(f.calls,['first','second','third']);assert.ok(queueReads>0);
  f.release('first');f.release('third');await Promise.all([f.wait(first.id),f.wait(third.id)]);
});

test('indexed dispatch retains account fairness and serializes a conversation ahead of later same-account work',async t=>{
  const f=controlled(t),a=f.store.createConversation('alice'),b=f.store.createConversation('bob'),other=f.store.createConversation('alice'),c=f.store.createConversation('charlie');
  const first=f.enqueue('alice',a.id,'alice-active'),second=f.enqueue('bob',b.id,'bob-active');
  const follow=f.enqueue('alice',a.id,'alice-follow'),old=f.enqueue('alice',other.id,'alice-other'),fresh=f.enqueue('charlie',c.id,'charlie-fresh');
  f.release('bob-active');await f.wait(second.id);
  assert.deepEqual(f.calls,['alice-active','bob-active','charlie-fresh']);
  f.release('charlie-fresh');await f.wait(fresh.id);
  assert.equal(f.calls.at(-1),'alice-other');
  f.release('alice-active');await f.wait(first.id);
  assert.equal(f.calls.at(-1),'alice-follow');
  f.release('alice-other');f.release('alice-follow');await Promise.all([f.wait(old.id),f.wait(follow.id)]);
});

test('queue limits count the intended conversation and recent sender without counting completed history',t=>{
  const {store}=local(t),a=store.createConversation('alice'),other=store.createConversation('alice'),old=Date.now()-7200000,insert=store.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<40;i++)insert.run('old-'+i,'alice',a.id,'completed','Historic',null,null,old,old);
  for(let i=0;i<10;i++)store.createRun('alice',a.id,'Queued '+i);
  assert.throws(()=>store.createRun('alice',a.id,'Over conversation cap'),/10 queued/);
  const allowed=store.createRun('alice',other.id,'Other conversation');assert.equal(allowed.status,'queued');
  const third=store.createConversation('alice');
  for(let i=0;i<19;i++)insert.run('recent-'+i,'alice',third.id,'completed','Recent',null,null,Date.now(),Date.now());
  assert.throws(()=>store.createRun('alice',third.id,'Over hourly cap'),/30 research/);
});

test('queue index follows claims, cancellation and restart recovery while preserving queued requests',async t=>{
  const f=local(t),a=f.store.createConversation('alice'),b=f.store.createConversation('bob'),active=f.store.createRun('alice',a.id,'Started before restart'),queued=f.store.createRun('bob',b.id,'Still waiting');
  f.store.begin(active);
  f.reopen();const calls=[],manager=new RunManager(f.store,{},async input=>{calls.push(input.message);return {answer:'Done',sources:[]};});
  assert.equal(f.store.runRow(active.id).status,'queued');assert.equal(f.store.runRow(queued.id).status,'queued');
  const stopped=f.store.createRun('bob',b.id,'Cancelled before dispatch');await manager.control('bob',stopped.id,'interrupt');
  assert.deepEqual(f.store.query(queueSql).map(r=>r.id),[active.id,queued.id]);
  const done=Promise.all([active,queued].map(run=>new Promise(resolve=>manager.on(run.id,e=>{if(e.event==='run.completed')resolve();}))));manager.pump();await done;
  assert.deepEqual(calls,['Started before restart','Still waiting']);assert.equal(manager.active.size,0);assert.equal(f.store.runRow(stopped.id).status,'interrupted');
  assert.deepEqual(f.store.query(queueSql),[]);
  assert.equal(f.store.one("SELECT coalesce(sum(ncell),0) AS cells FROM dbstat WHERE name='run_queued_created'").cells,0);
});

test('a run killed mid-flight by a restart completes exactly once after the next boot',async t=>{
  const f=local(t),conversation=f.store.createConversation('alice');
  new RunManager(f.store,{},()=>new Promise(()=>{})).enqueue('alice',conversation.id,'Underwrite 1 Main St');
  await new Promise(r=>setTimeout(r,10));
  const run=f.store.query('SELECT * FROM runs')[0];assert.equal(run.status,'running');
  f.reopen();const calls=[],manager=new RunManager(f.store,{},async input=>{calls.push(input.message);return {answer:'Done',sources:[]};});
  const done=new Promise(resolve=>manager.on(run.id,e=>{if(e.event==='run.completed')resolve();}));manager.pump();await done;
  assert.deepEqual(calls,['Underwrite 1 Main St']);assert.equal(f.store.runRow(run.id).status,'completed');
  assert.deepEqual(f.store.query('SELECT role,text FROM messages WHERE run=? ORDER BY seq',run.id).map(m=>[m.role,m.text]),[['user','Underwrite 1 Main St'],['assistant','Done']]);
  assert.deepEqual(f.store.runEvents(run.id).map(e=>e.event).filter(e=>/^run\./.test(e)),['run.queued','run.started','run.requeued','run.started','run.completed']);
});
test('a cancelled run that never returns is finalized by the watchdog, and its late result is ignored',async t=>{
  const f=local(t,false),calls=[];let finishLate;
  const late=new Promise(resolve=>{finishLate=resolve;});
  const manager=new RunManager(f.store,{INTERRUPT_WATCHDOG_MS:60},async input=>{calls.push(input.message);await late;return {answer:'Too late',sources:[]};});
  t.after(()=>{finishLate();f.close();});
  const conversation=f.store.createConversation('alice');
  const run=manager.enqueue('alice',conversation.id,'Underwrite 1 Main St');
  await new Promise(r=>setTimeout(r,10));
  assert.equal(f.store.runRow(run.id).status,'running');
  const result=await manager.control('alice',run.id,'interrupt');
  assert.equal(result.status,'interrupting');
  await new Promise(r=>setTimeout(r,150));
  assert.equal(f.store.runRow(run.id).status,'interrupted','the watchdog finalized the run');
  assert.equal(manager.active.size,0,'the conversation is free for a new message');
  finishLate();await new Promise(r=>setTimeout(r,20));
  assert.equal(f.store.runRow(run.id).status,'interrupted','the late result did not reopen or overwrite the run');
  assert.equal(f.store.query("SELECT count(*) n FROM messages WHERE run=? AND role='assistant'",run.id)[0].n,1,'one assistant record for the run');
});

test('draining finishes the in-flight run, keeps new runs queued and hands them to the next process',async t=>{
  const f=local(t),gates=new Map(),calls=[];
  const execute=async input=>{calls.push(input.message);await new Promise(resolve=>gates.set(input.message,resolve));return {answer:input.message,sources:[]};};
  const manager=new RunManager(f.store,{},execute),conversation=f.store.createConversation('alice');
  const first=manager.enqueue('alice',conversation.id,'in flight');
  await new Promise(resolve=>setImmediate(resolve));
  let drained=false;const draining=manager.drain().then(()=>{drained=true;});
  const other=f.store.createConversation('bob'),later=manager.enqueue('bob',other.id,'asked during the deploy');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['in flight']);
  assert.equal(drained,false);
  assert.equal(f.store.runRow(later.id).status,'queued');
  gates.get('in flight')();
  await draining;
  assert.equal(f.store.runRow(first.id).status,'completed');
  assert.equal(f.store.runRow(later.id).status,'queued');
  assert.equal(manager.active.size,0);
  const next=new RunManager(f.reopen(),{},async input=>({answer:input.message,sources:[]}));
  await new Promise(resolve=>{next.on(later.id,e=>{if(e.event==='run.completed')resolve();});next.pump();});
  assert.equal(f.store.runRow(later.id).status,'completed');
});

test('draining an idle manager resolves at once and starts nothing',async t=>{
  const f=local(t),calls=[];
  const manager=new RunManager(f.store,{},async input=>{calls.push(input.message);return {answer:input.message,sources:[]};});
  await manager.drain();
  const conversation=f.store.createConversation('alice'),run=manager.enqueue('alice',conversation.id,'after shutdown began');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[]);
  assert.equal(f.store.runRow(run.id).status,'queued');
});

test('six research runs go at once by default and the seventh waits in the queue',async t=>{
  const f=local(t,false),calls=[],gates=[];
  const manager=new RunManager(f.store,{},async input=>{calls.push(input.message);await new Promise(resolve=>gates.push(resolve));return {answer:input.message,sources:[]};});
  t.after(async()=>{for(const g of gates)g();await manager.settled();});
  for(let n=1;n<=7;n++)manager.enqueue(`owner${n}`.padEnd(24,'0'),f.store.createConversation(`owner${n}`.padEnd(24,'0')).id,`run ${n}`);
  await new Promise(setImmediate);
  assert.equal(calls.length,6);
  assert.equal(f.store.one("SELECT count(*) AS n FROM runs WHERE status='queued'").n,1);
});
