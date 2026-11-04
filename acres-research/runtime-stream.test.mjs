import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {ChatStore} from './store.mjs';
import {streamEvents} from './event-stream.mjs';
import {createResearchServer} from './service.mjs';

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'runtime-stream-')),store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
class Response extends EventEmitter {
  frames=[];blocked=false;ended=false;destroyed=false;
  writeHead(){}
  write(frame){this.frames.push(frame);return !this.blocked;}
  end(){this.ended=true;this.emit('close');}
  destroy(){this.destroyed=true;this.emit('close');}
}
test('published delta rows survive reconnect at every boundary and keep interleaved message identity',t=>{
  const s=fixture(t),c=s.createConversation('alice'),r=s.createRun('alice',c.id,'question');
  const chunks=[['a','Hello'],['b','Other'],['a',' world'],['b',' answer']];
  const events=chunks.map(([id,delta])=>s.event(r.id,'message.delta',{id,delta}));
  for(let split=0;split<=events.length;split++){
    const delivered=events.slice(0,split),after=delivered.at(-1)?.seq||1;
    const received=[...delivered,...s.runEventPage(r.id,after)];
    assert.deepEqual(received,events);
    assert.equal(received.filter(e=>e.id==='a').map(e=>e.delta).join(''),'Hello world');
    assert.equal(received.filter(e=>e.id==='b').map(e=>e.delta).join(''),'Other answer');
  }
});
test('slow SSE readers retain a cursor, page their backlog and do not buffer live payloads',async()=>{
  const res=new Response(),feed=new EventEmitter(),events=Array.from({length:75},(_,i)=>({seq:i+1,event:'status',status:String(i)}));
  let reads=0,maxPage=0,closed;
  res.blocked=true;
  streamEvents({res,readPage:(after,limit)=>{reads++;const page=events.filter(e=>e.seq>after).slice(0,limit);maxPage=Math.max(maxPage,page.length);return page;},
    subscribe:fn=>{feed.on('event',fn);return()=>feed.off('event',fn);},allowed:()=>true,finished:()=>true,onClose:c=>closed=c});
  for(let i=0;i<500;i++)feed.emit('event',{large:'ignored'});
  assert.equal(reads,1);assert.equal(res.frames.filter(x=>x.startsWith('id:')).length,1);
  const done=once(res,'close');res.blocked=false;res.emit('drain');await done;
  assert.equal(closed,75);assert.equal(maxPage,32);assert.equal(res.frames.filter(x=>x.startsWith('id:')).length,75);assert.equal(feed.listenerCount('event'),0);
});
test('a stalled subscriber times out without delaying a healthy subscriber',async()=>{
  const feed=new EventEmitter(),slow=new Response(),fast=new Response(),events=[{seq:1,event:'status'}];slow.blocked=true;
  const options={readPage:()=>events,subscribe:fn=>{feed.on('event',fn);return()=>feed.off('event',fn);},allowed:()=>true,terminal:()=>true,drainTimeoutMs:10};
  const stopped=once(slow,'close');streamEvents({...options,res:slow});streamEvents({...options,res:fast});
  await tick();assert.equal(fast.ended,true);await stopped;assert.equal(slow.destroyed,true);assert.equal(feed.listenerCount('event'),0);
});
test('replay rechecks access after a blocked write drains',async()=>{
  const res=new Response(),events=[{seq:1,event:'status'},{seq:2,event:'private'}];let access=true;res.blocked=true;
  streamEvents({res,readPage:()=>events,subscribe:()=>()=>{},allowed:()=>access});
  const done=once(res,'close');access=false;res.blocked=false;res.emit('drain');await done;
  assert.equal(res.frames.some(x=>x.includes('private')),false);
});
test('run status reads omit result and event history, retaining account access checks',async t=>{
  const s=fixture(t),owner='a'.repeat(24),c=s.createConversation(owner),r=s.createRun(owner,c.id,'question');
  s.write("UPDATE runs SET status='failed',result=? WHERE id=?",'{invalid JSON intentionally unread}',r.id);
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store:s});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/runs/${r.id}/status`;
  const response=await fetch(url,{headers:{authorization:'Bearer test','x-acres-account':owner}}),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.status,'failed');assert.equal('result' in data,false);assert.equal('events' in data,false);
  const replay=await fetch(url.replace('/status','/events'),{headers:{authorization:'Bearer test','x-acres-account':owner}});
  assert.equal(replay.status,200);assert.match(await replay.text(),/: connected/);
  const denied=await fetch(url,{headers:{authorization:'Bearer test','x-acres-account':'b'.repeat(24)}});assert.equal(denied.status,404);
});
