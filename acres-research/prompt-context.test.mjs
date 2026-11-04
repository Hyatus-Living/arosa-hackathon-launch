import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPromptContext,TOOL_INLINE_CHARS} from './prompt-context.mjs';
import {ChatStore} from './store.mjs';

test('oversized evidence stays complete and immutable behind bounded paged context',async()=>{
  const context=createPromptContext();
  const result={sources:[{id:7,text:'Matched operative passage '.repeat(4000),fullDocument:{versionId:'immutable-version',offset:0}}],comparables:Array.from({length:300},(_,i)=>({id:i,value:i*1000}))};
  const original=JSON.stringify(result),packed=context.pack(result,'evidence');
  assert.equal(packed.coverage,'partial');assert.ok(JSON.stringify(packed).length<=TOOL_INLINE_CHARS);
  result.comparables[299].value=-1;
  let text='',offset=0;
  do{const page=await context.read({reference:packed.reference,offset});assert.ok(JSON.stringify(page).length<=TOOL_INLINE_CHARS);text+=page.text;offset=page.nextOffset;}while(offset!==null);
  assert.equal(text,original);
  assert.equal(JSON.parse((await context.read({reference:packed.reference,path:['comparables','299']})).text).value,299000);
  await assert.rejects(context.read({reference:packed.reference,path:['__proto__']}),/ordinary object keys/);
  await assert.rejects(createPromptContext().read({reference:packed.reference}),/Unknown context reference/);
});

test('the current question stays verbatim while context components expose explicit retrieval coverage',()=>{
  const context=createPromptContext(),userMessage='Q'.repeat(3000);
  const input=context.input({userMessage,message:`${'large listing capture '.repeat(2000)}\n${userMessage}`,history:[{role:'user',text:'Retain all constraints '.repeat(2000)}],project:{instructions:{bySection:{brief:'Confirmed instruction '.repeat(2000)},provenance:{account:'alice'}}}});
  assert.ok(input.endsWith(userMessage));assert.match(input,/"coverage":"partial"/);assert.match(input,/All original values and rows are retained/);
  assert.ok(input.length<45000);
});

test('context validates paging arguments before reading durable user requests',async()=>{
  let reads=0;
  const context=createPromptContext({userHistory:{read:async()=>{reads++;return {requests:[]};}}});
  for(const args of [{path:null},{path:'x'},{offset:-1},{maxChars:0}])await assert.rejects(context.read({reference:'prior_user_requests',...args}));
  assert.equal(reads,0);
});

test('a page larger than one read returns reads as a full page with the rest left for nextOffset',async()=>{
  const context=createPromptContext();
  const packed=context.pack({text:'x'.repeat(30000)},'Large result');
  const page=await context.read({reference:packed.reference,maxChars:25000});
  assert.equal(page.offset,0);assert.ok(page.text.length<=12000);assert.equal(page.nextOffset,page.text.length);
});

test('prior user requests remain paged, attributed, snapshot-bound and access-controlled beyond the recent tail',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-prompt-history-')),store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.touchPerson('alice','alice@example.com');store.touchPerson('bob','bob@example.com');
  const conversation=store.createConversation('alice');
  store.grantMember('alice',conversation.id,'account','bob','participant','bob@example.com');
  store.addMessage(conversation.id,null,'user','Never assume commercial net area equals gross area.',{},'alice');
  for(let i=0;i<15;i++){store.addMessage(conversation.id,null,'user',`Request ${i}`,{},i%2?'alice':'bob');store.addMessage(conversation.id,null,'assistant',`Reply ${i}`);}
  const run=store.createRun('bob',conversation.id,'Current question');const recent=store.begin(run);
  assert.equal(recent.some(m=>m.text.includes('Never assume')),false);
  const source=store.userRequestContext(run),context=createPromptContext({userHistory:source});
  store.addMessage(conversation.id,run.id,'user','A future steer',{},'bob');
  let page=source.initial,requests=[...page.requests];
  while(page.nextBeforeSeq!==null){page=await context.read({reference:'prior_user_requests',beforeSeq:page.nextBeforeSeq});requests.push(...page.requests);}
  assert.equal(requests.length,16);assert.equal(new Set(requests.map(r=>r.id)).size,16);
  const constraint=requests.find(r=>r.text.startsWith('Never assume'));assert.equal(constraint.author,'alice');assert.ok(Number.isFinite(constraint.created));
  assert.equal(requests.some(r=>r.text==='A future steer'||r.text==='Current question'),false);
  const retained=context.pack(requests,'Historical requests',100);
  store.removeGrant('alice',conversation.id,'account','bob');
  await assert.rejects(context.read({reference:'prior_user_requests'}),{status:404});
  await assert.rejects(context.read({reference:retained.reference}),{status:404});
});
