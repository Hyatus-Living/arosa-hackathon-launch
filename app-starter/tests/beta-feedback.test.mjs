import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const json=body=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>body});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// Page modules wire themselves to the DOM on import, so each case installs a fresh document.
let copies=0;
async function mount(file,fetchImpl,pathname='/') {
  const {document,window}=parseHTML(html);
  window.location={search:'',pathname,hash:'',assign(){}};
  for(const dialog of document.querySelectorAll('dialog')){dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new window.Event('close'));};}
  Object.assign(globalThis,{document,window,history:{replaceState(){}},fetch:fetchImpl});
  const module=await import(`../public/${file}?copy=${++copies}`);
  await tick();
  return {document,window,module};
}
const planEvent=(window,plan)=>window.dispatchEvent(new window.CustomEvent('acres:plan',{detail:plan}));

test('the feedback context names the page and the open site, listing or conversation',async()=>{
  const {module}=await mount('beta-feedback.js',async()=>json({}));
  assert.deepEqual(module.feedbackContext('/'),{view:'home'});
  assert.deepEqual(module.feedbackContext('/sites/p1/plan','c1'),{view:'sites',projectId:'p1',conversationId:'c1'});
  assert.deepEqual(module.feedbackContext('/listings/l%201'),{view:'listings',listingId:'l 1'});
  assert.deepEqual(module.feedbackContext('/chat','c2'),{view:'chat',conversationId:'c2'});
});

test('only beta testers see the bar; Give feedback opens a panel that sends the page, asks follow-ups and finishes',async()=>{
  const posts=[];
  const replies=[
    {id:'s1',status:'open',messages:[{role:'user',text:'The map went blank'},{role:'agent',text:'Which filter did you change?'}]},
    {id:'s1',status:'done',messages:[{role:'user',text:'The map went blank'},{role:'agent',text:'Which filter did you change?'},{role:'agent',text:'Thanks, that helps.'}]},
  ];
  const {document,window,module}=await mount('beta-feedback.js',async(url,options)=>{posts.push({url,body:JSON.parse(options.body)});return json(replies.shift());},'/sites/p1');
  module.setFeedbackContext(()=>'conv-1');
  const bar=document.querySelector('#beta-bar'),dialog=document.querySelector('#feedback-dialog');
  assert.ok(bar.hidden);
  planEvent(window,{plan:'free',beta:false});assert.ok(bar.hidden);
  planEvent(window,{plan:'beta',beta:true});assert.equal(bar.hidden,false);
  assert.equal(bar.textContent.replace(/\s+/g,' ').trim(),"You're testing Arosa early. Give feedback");
  assert.equal(bar.querySelectorAll('button').length,1,'one action');

  document.querySelector('#beta-feedback-button').click();
  assert.ok(dialog.open);
  assert.match(document.querySelector('#feedback-thread').textContent,/Tell us anything/);
  assert.ok(document.querySelector('#feedback-finish').hidden,'nothing to finish before the first reply');
  document.querySelector('#feedback-text').value='The map went blank';
  document.querySelector('#feedback-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  assert.match(document.querySelector('#feedback-thread').textContent,/The map went blank/,'the message shows while Arosa replies');
  assert.ok(document.querySelector('.feedback-working'));
  await tick();await tick();
  assert.deepEqual(posts[0],{url:'/api/feedback',body:{text:'The map went blank',page:'/sites/p1',context:{view:'sites',projectId:'p1',conversationId:'conv-1'}}});
  assert.deepEqual([...document.querySelectorAll('#feedback-thread .feedback-message')].map(n=>n.className.split(' ').at(-1)),['feedback-user','feedback-agent']);
  assert.equal(document.querySelector('#feedback-text').value,'');
  assert.equal(document.querySelector('#feedback-finish').hidden,false);

  document.querySelector('#feedback-finish').click();
  await tick();await tick();
  assert.equal(posts[1].url,'/api/feedback/s1/finish');
  assert.ok(document.querySelector('#feedback-form').hidden,'a finished conversation takes no more replies');
  assert.match(document.querySelector('#feedback-thread').textContent,/Thanks, that helps\.Sent to the Arosa team/);
  dialog.close();
  document.querySelector('#beta-feedback-button').click();
  assert.equal(document.querySelector('#feedback-form').hidden,false,'the next feedback starts fresh');
  assert.match(document.querySelector('#feedback-thread').textContent,/Tell us anything/);
});

test('a failed send keeps the typed text and says to try again',async()=>{
  const {document,window}=await mount('beta-feedback.js',async()=>({ok:false,status:502,headers:{get:()=> 'application/json'},json:async()=>({error:'Arosa could not reply just now. Try again.'})}));
  document.querySelector('#beta-feedback-button').click();
  document.querySelector('#feedback-text').value='Something broke';
  document.querySelector('#feedback-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await tick();await tick();
  assert.equal(document.querySelector('#feedback-notice').textContent,'Arosa could not reply just now. Try again.');
  assert.equal(document.querySelector('#feedback-text').value,'Something broke');
  assert.equal(document.querySelector('#feedback-send').disabled,false);
});

test('beta feedback eligibility survives the free daily access view',async()=>{
  const plan={plan:'community',beta:true,used:12,limit:50,remaining:38,resetsAt:Date.UTC(2026,9,21,4),timeZone:'America/New_York',limits:{research:{label:'Research requests',used:12,limit:50,remaining:38}},manageable:false};
  const {document,window}=await mount('beta-feedback.js',async()=>json({}));
  let seen;
  window.addEventListener('acres:plan',event=>{seen=event.detail;});
  globalThis.fetch=async()=>json(plan);
  const module=await import(`../public/wallet.js?beta-copy=${++copies}`);await tick();
  assert.equal(seen.beta,true);
  assert.equal(document.querySelector('#beta-bar').hidden,false);
  const summary=module.planSummary(plan);
  assert.equal(summary.name,'Free access');assert.equal(summary.line,'38 of 50 research requests left today');
  assert.doesNotMatch(document.querySelector('#wallet-content').textContent,/Unlimited|Upgrade|Arosa Pro/);
});

test('the admin feedback tab lists sessions with person, page, category and summary, and opens the transcript',async()=>{
  const {document,module}=await mount('feedback-admin.js',async()=>json({}));
  assert.deepEqual(module.feedbackHeadline({status:'done',category:'missing_feature',summary:'Wants a CSV export.'}),{category:'Missing feature',summary:'Wants a CSV export.'});
  assert.deepEqual(module.feedbackHeadline({status:'open',category:null,summary:null}),{category:'In progress',summary:'Not summarized yet.'});
  const content=document.createElement('div');
  const opened=[];
  const request=async path=>{opened.push(path);return {context:{view:'listings',listingId:'l1'},messages:[{role:'user',text:'Rents look low'},{role:'agent',text:'Which listing?'}]};};
  module.renderFeedback(content,{sessions:[{id:'s1',email:'tester@example.com',page:'/listings/l1',status:'done',category:'data_issue',summary:'Rent comps look low.',created:Date.UTC(2026,9,21),messageCount:2}]},{request});
  const row=content.querySelector('.feedback-row');
  assert.match(row.textContent,/tester@example\.com/);assert.match(row.textContent,/\/listings\/l1/);
  assert.match(row.textContent,/Data issue/);assert.match(row.textContent,/Rent comps look low\./);
  row.open=true;row.dispatchEvent(new globalThis.window.Event('toggle'));
  await tick();
  assert.deepEqual(opened,['/admin/feedback/s1']);
  assert.deepEqual([...row.querySelectorAll('.feedback-message')].map(n=>n.textContent),['Rents look low','Which listing?']);
  assert.match(row.textContent,/Listing l1/);
  module.renderFeedback(content,{sessions:[]},{request});
  assert.match(content.textContent,/No feedback yet/);
});

test('the outreach tab lists beta testers and offers one beta action on each contact with an email',async()=>{
  const {document,module}=await mount('crm-admin.js',async()=>json({}));
  // linkedom's select has a read-only value; the contact form sets it.
  Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.chosen??'';},set(value){this.chosen=value;}});
  const betaEmails=new Set(['pat@example.com']);
  assert.equal(module.isBetaContact({email:' Pat@Example.com'},betaEmails),true);
  assert.equal(module.isBetaContact({email:null},betaEmails),false);
  const calls=[];
  const data={contacts:[{id:'1',name:'Pat',status:'beta_invited',email:'pat@example.com',touches:[]},{id:'2',name:'Sam',status:'new',email:'sam@example.com',touches:[]},{id:'3',name:'No Email',status:'new',email:null,touches:[]}],
    betaTesters:[{email:'pat@example.com',grantedBy:'michael@witharosa.ai',grantedAt:Date.UTC(2026,9,20)}]};
  const request=async(path,options={})=>{calls.push([path,options.method||'GET',options.body&&JSON.parse(options.body)]);return path==='/admin/crm'?{...data,betaTesters:[...data.betaTesters,{email:'sam@example.com',grantedAt:Date.UTC(2026,9,21)}]}:{};};
  const content=document.createElement('div');
  module.renderOutreach(content,data,{request});
  const beta=content.querySelector('.crm-beta');
  assert.ok(beta===content.firstElementChild.firstElementChild,'beta testers sit at the top of the tab');
  assert.match(beta.textContent,/pat@example\.com/);
  const actions=[...content.querySelectorAll('.crm-row')].map(row=>[...row.querySelectorAll('.admin-actions .admin-secondary')].map(b=>b.textContent));
  assert.deepEqual(actions,[['Remove beta tester'],['Make beta tester'],[]]);
  assert.match(content.querySelector('.crm-row').textContent,/Beta tester/);
  content.querySelectorAll('.crm-row')[1].querySelector('.admin-actions .admin-secondary').click();
  await tick();await tick();
  assert.deepEqual(calls,[['/admin/beta-testers','POST',{email:'sam@example.com'}],['/admin/crm','GET',undefined]]);
  assert.match(content.querySelector('.crm-beta').textContent,/sam@example\.com/,'the list reloads after a grant');
});

test('beta testers see the same free allowance and no upgrade at the daily limit',async()=>{
  for(const used of [3,50]) {
    const plan={plan:'community',beta:true,used,limit:50,remaining:50-used,resetsAt:Date.UTC(2026,9,21,4),timeZone:'America/New_York',checkoutAvailable:false,limits:{research:{label:'Research requests',used,limit:50,remaining:50-used}}};
    const {document}=await mount('wallet.js',async()=>json(plan));
    const content=document.querySelector('#wallet-content');
    assert.match(content.textContent,/Free access/);
    assert.match(content.textContent,new RegExp(`${50-used} of 50 research requests left today`));
    assert.doesNotMatch(content.textContent,/Unlimited|Upgrade|Arosa Pro/);
    assert.equal(content.querySelector('.plan-upgrade'),null);
    assert.equal(document.querySelector('#wallet-balance').textContent,`${50-used} left`);
  }
});
