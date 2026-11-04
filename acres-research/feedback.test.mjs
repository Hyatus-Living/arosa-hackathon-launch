// Explicit operator configuration for this isolated test deployment.
process.env.AROSA_ADMIN_EMAILS='michael@witharosa.ai,alex@witharosa.ai,chaim@witharosa.ai';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {BetaTesters} from './beta.mjs';
import {Feedback,parseFeedbackReply,replyProblem,repairReply,MAX_FOLLOW_UPS} from './feedback.mjs';
import {feedbackInstructions} from './feedback-instructions.mjs';
import {createResearchServer} from './service.mjs';

const alice='a'.repeat(24),admin='c'.repeat(24);

function storeFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-feedback-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return store;
}

// A stand-in for the model: asks until the packet says the final turn, or finishes when told to.
function scriptedAgent(calls) {
  return async options=>{
    calls.push(options);
    const packet=JSON.parse(options.message.slice(options.message.indexOf('{')));
    if(packet.finalTurn)return '```json\n{"done":true,"reply":"Thanks, that helps.","summary":"The map hides listings after a filter change on the home page.","category":"bug"}\n```';
    return JSON.stringify({done:false,reply:`Question ${packet.followUpsAsked+1}: what did you expect to see?`});
  };
}

test('beta access belongs to the lower-cased email, can be revoked and granted again',t=>{
  const beta=new BetaTesters(storeFixture(t));
  assert.equal(beta.grant(' Tester@Example.COM ','Michael@witharosa.ai',1),'tester@example.com');
  assert.equal(beta.has('TESTER@example.com'),true);
  assert.deepEqual(beta.list().map(row=>({...row})),[{email:'tester@example.com',grantedBy:'michael@witharosa.ai',grantedAt:1}]);
  beta.grant('tester@example.com','alex@witharosa.ai',2);
  assert.equal(beta.list()[0].grantedAt,1,'a repeat grant keeps the original grant');
  beta.revoke('tester@example.com',3);
  assert.equal(beta.has('tester@example.com'),false);
  assert.deepEqual(beta.list(),[]);
  assert.throws(()=>beta.revoke('tester@example.com'),{status:404});
  beta.grant('tester@example.com','alex@witharosa.ai',4);
  assert.deepEqual(beta.list().map(row=>({...row})),[{email:'tester@example.com',grantedBy:'alex@witharosa.ai',grantedAt:4}]);
  assert.throws(()=>beta.grant('not an email','x'),{status:400});
  assert.equal(beta.has(null),false);
});

test('the feedback agent asks at most three follow-ups, then thanks the person and saves a summary and category',async t=>{
  const calls=[],feedback=new Feedback(storeFixture(t),{agent:scriptedAgent(calls)});
  let session=await feedback.start(alice,'tester@example.com',{text:'The map went blank',page:'/listings/abc',context:{view:'listings',listingId:'abc',secret:'dropped',conversationId:7}});
  assert.equal(session.status,'open');
  assert.deepEqual(session.context,{view:'listings',listingId:'abc'},'only known string context is kept');
  assert.deepEqual(session.messages.map(m=>m.role),['user','agent']);
  assert.match(session.messages[1].text,/^Question 1/);
  for(let i=2;i<=MAX_FOLLOW_UPS;i++)session=await feedback.send(alice,session.id,`Answer ${i}`);
  assert.equal(session.messages.filter(m=>m.role==='agent').length,MAX_FOLLOW_UPS);
  session=await feedback.send(alice,session.id,'It happens every time');
  assert.equal(session.status,'done');
  assert.equal(session.summary,'The map hides listings after a filter change on the home page.');
  assert.equal(session.category,'bug');
  assert.equal(session.messages.at(-1).text,'Thanks, that helps.');
  await assert.rejects(feedback.send(alice,session.id,'One more thing'),{status:409});
  await assert.rejects(feedback.send(admin,session.id,'Not mine'),{status:404});
  const options=calls[0];
  assert.deepEqual(options.dynamicTools,[],'no research tools');
  assert.equal(options.includeSkill,false);
  assert.equal(options.instructions,feedbackInstructions());
  await assert.rejects(options.execute('acres_search',{}),/no tools/);
  assert.match(options.message,/untrusted data/);
});

test('finishing early summarizes what the agent has; a failed reply leaves the session open to try again',async t=>{
  const calls=[];let broken=true;
  const agent=async options=>{if(broken)throw new Error('model down');return scriptedAgent(calls)(options);};
  const feedback=new Feedback(storeFixture(t),{agent});
  await assert.rejects(feedback.start(alice,null,{text:'Love the deal ranking'}),e=>e.status===502&&/Try again/.test(e.message));
  const [stored]=feedback.list();
  assert.equal(stored.status,'open');assert.equal(stored.messageCount,1,'the person\'s words are kept');
  broken=false;
  const finished=await feedback.finish(alice,stored.id);
  assert.equal(finished.status,'done');assert.equal(finished.category,'bug');
  assert.equal((await feedback.finish(alice,stored.id)).messages.length,finished.messages.length,'finishing twice adds nothing');
  await assert.rejects(feedback.start(alice,null,{text:'   '}),{status:400});
});

test('feedback replies are parsed from plain or fenced JSON and unknown categories become other',()=>{
  assert.deepEqual(parseFeedbackReply('{"done":false,"reply":"Where did it happen?"}'),{done:false,reply:'Where did it happen?',summary:'',category:'other'});
  assert.equal(parseFeedbackReply('Sure. ```json\n{"done":true,"reply":"Thanks","summary":"S","category":"praise"}\n```').category,'praise');
  assert.equal(parseFeedbackReply('{"done":true,"reply":"Thanks","summary":"S","category":"feature"}').category,'other');
  assert.throws(()=>parseFeedbackReply('{"done":false}'),/no text/);
});

test('a follow-up asks exactly one question and the closing reply asks none',()=>{
  const ask=reply=>replyProblem({done:false,reply});
  assert.equal(ask('Got it. Which page were you on?'),null,'one question');
  assert.equal(ask('Did it happen on a site page or the home page?'),null,'one ask offering a choice');
  assert.match(ask('Which page? And which filter?'),/exactly one question/,'two question marks');
  assert.match(ask('What did you expect to see, and how did it affect your work?'),/one thing only/,'two asks joined by and');
  assert.match(ask('Was it slow to load or did it fail?'),/one thing only/,'two asks joined by or');
  assert.match(ask('Thanks for this.'),/exactly one question/,'a follow-up must ask');
  assert.match(ask('Thanks. That helps a lot. Which page was it?'),/two short sentences/);
  assert.equal(replyProblem({done:true,reply:'Thank you, that helps.'}),null);
  assert.match(replyProblem({done:true,reply:'Thanks. Anything else?'}),/must not ask/,'no question on the closing turn');
});

test('a reply that still breaks the rule keeps only its first question',()=>{
  assert.equal(repairReply({done:false,reply:'What did you expect to see, and how did it affect your work?'}),'What did you expect to see?');
  assert.equal(repairReply({done:false,reply:'Thanks. Which page? And which filter?'}),'Thanks. Which page?');
  assert.equal(repairReply({done:false,reply:'What did you expect, where were you, and why does it matter?'}),'What did you expect?');
  assert.equal(repairReply({done:true,reply:'Thanks, that helps. Anything else?'}),'Thanks, that helps.');
});

test('a reply that asks two things gets one corrected retry, and is trimmed if the retry fails too',async t=>{
  const store=storeFixture(t);
  const compound='What did you expect to see, and how did it affect your work?';
  const seen=[];
  let replies=[compound,'What did you expect to see?'];
  const agent=async options=>{seen.push(JSON.parse(options.message.slice(options.message.indexOf('{'))));return JSON.stringify({done:false,reply:replies.shift()});};
  const feedback=new Feedback(store,{agent});
  const fixed=await feedback.start(alice,null,{text:'The map went blank'});
  assert.equal(fixed.messages.at(-1).text,'What did you expect to see?');
  assert.equal(seen.length,2);
  assert.equal(seen[1].rejectedReply,compound);assert.match(seen[1].correction,/one thing only/);
  replies=[compound,compound];
  const trimmed=await feedback.send(alice,fixed.id,'Listings');
  assert.equal(trimmed.messages.at(-1).text,'What did you expect to see?');
  assert.equal(seen.length,4,'one retry only');
});

test('a reply that is not the JSON asked for gets one corrected retry before the person sees an error',async t=>{
  const seen=[];
  let replies=['Which page were you on?','{"done":false,"reply":"Which page were you on?"}'];
  const agent=async options=>{seen.push(JSON.parse(options.message.slice(options.message.indexOf('{'))));return replies.shift();};
  const feedback=new Feedback(storeFixture(t),{agent});
  const session=await feedback.start(alice,null,{text:'Something broke'});
  assert.equal(session.messages.at(-1).text,'Which page were you on?');
  assert.match(seen[1].correction,/one JSON object/);
  replies=['not json','still not json'];
  await assert.rejects(feedback.send(alice,session.id,'The home page'),{status:502});
});

test('admins grant beta access over HTTP; beta testers send feedback that admins can read, without using a research run',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-feedback-http-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  const calls=[];
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test',FREE_RUNS_PER_MONTH:1},store,execute:async()=>({answer:'x',sources:[],ui:[]}),maps:null,feedbackAgent:scriptedAgent(calls)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=(path,{method='GET',body,account=alice,email='tester@example.com'}={})=>fetch(base+path,{method,headers:{authorization:'Bearer test','x-acres-account':account,'x-acres-email':email,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const asAdmin=(path,options={})=>api(path,{...options,account:admin,email:'michael@witharosa.ai'});

  assert.equal((await api('/feedback',{method:'POST',body:{text:'hi'}})).status,403,'only beta testers send feedback');
  assert.equal((await api('/admin/beta-testers',{method:'POST',body:{email:'tester@example.com'}})).status,403,'only admins grant access');
  assert.equal((await api('/admin/feedback')).status,403);
  assert.equal((await api('/plan').then(r=>r.json())).plan,'free');

  await asAdmin('/admin/crm/import',{method:'POST',body:{source:'test',contacts:[{name:'Tess Tester',sourceRef:'1'},{name:'Other',sourceRef:'2'}]}});
  const contacts=(await (await asAdmin('/admin/crm')).json()).contacts;
  const tess=contacts.find(c=>c.name==='Tess Tester'),other=contacts.find(c=>c.name==='Other');
  await asAdmin(`/admin/crm/${tess.id}`,{method:'PATCH',body:{email:'Tester@Example.com'}});
  await asAdmin(`/admin/crm/${other.id}`,{method:'PATCH',body:{email:'tester@example.com',status:'beta_active'}});
  const granted=await (await asAdmin('/admin/beta-testers',{method:'POST',body:{email:'Tester@Example.com'}})).json();
  assert.equal(granted.email,'tester@example.com');assert.equal(granted.invitedContacts,1,'only the contact earlier in the funnel moves');
  const crm=await (await asAdmin('/admin/crm')).json();
  assert.deepEqual(crm.betaTesters.map(b=>b.email),['tester@example.com']);
  assert.equal(crm.contacts.find(c=>c.id===tess.id).status,'beta_invited');
  assert.equal(crm.contacts.find(c=>c.id===other.id).status,'beta_active');

  const plan=await (await api('/plan')).json();
  assert.equal(plan.plan,'beta');assert.equal(plan.beta,true);assert.equal(plan.limit,1000);assert.equal(plan.betaAllowance,1000);
  const runsBefore=store.one('SELECT count(*) n FROM runs').n;
  const opened=await api('/feedback',{method:'POST',body:{text:'The map went blank',page:'/',context:{view:'home'}}});
  assert.equal(opened.status,201);
  const session=await opened.json();
  assert.match(session.messages[1].text,/what did you expect/);
  const done=await (await api(`/feedback/${session.id}/finish`,{method:'POST',body:{}})).json();
  assert.equal(done.status,'done');
  assert.equal(store.one('SELECT count(*) n FROM runs').n,runsBefore,'feedback is not a research run');
  assert.equal((await api('/plan').then(r=>r.json())).used,0);

  const list=await (await asAdmin('/admin/feedback')).json();
  assert.deepEqual(list.sessions.map(s=>[s.email,s.page,s.category,s.summary,s.messageCount]),[['tester@example.com','/','bug','The map hides listings after a filter change on the home page.',3]]);
  const transcript=await (await asAdmin(`/admin/feedback/${session.id}`)).json();
  assert.deepEqual(transcript.messages.map(m=>m.role),['user','agent','agent']);
  assert.equal((await api(`/feedback/${session.id}/finish`,{method:'POST',body:{},account:admin,email:'michael@witharosa.ai'})).status,404,'a session belongs to its sender');

  const revoked=await (await asAdmin('/admin/beta-testers/tester%40example.com',{method:'DELETE'})).json();
  assert.deepEqual(revoked.betaTesters,[]);
  assert.equal((await api('/plan').then(r=>r.json())).plan,'free');
  assert.equal((await api('/feedback',{method:'POST',body:{text:'hi'}})).status,403);
});
