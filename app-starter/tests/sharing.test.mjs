import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {arosaAccount,resolveAccount,createAccountResolver} from '../auth.js';

test('resolveAccount hashes unknown emails and honours links case-insensitively',()=>{
  assert.equal(resolveAccount('New.Person@witharosa.ai'),arosaAccount('new.person@witharosa.ai'));
  assert.equal(resolveAccount('michael@witharosa.ai',{'michael@witharosa.ai':'existing-history'}),'existing-history');
  assert.equal(createAccountResolver({'a@witharosa.ai':'linked'})('A@witharosa.ai'),'linked');
});

test('a conversation shared with the reader reads as shared, and the page carries sharing and teams',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const {document}=parseHTML(html);
  globalThis.document=document;
  const {isSharedItem}=await import('../public/conversation-view.js');
  const mine='a'.repeat(24),other='b'.repeat(24);
  const shared={id:'c1',title:'120 Broadway',access:'viewer',owner:{account:other,name:'Alex Rivera'},memberCount:2,lastAuthor:{account:other,name:'Alex Rivera'}};
  const ownShared={id:'c2',title:'Mine shared out',access:'owner',owner:{account:mine,name:'Michael'},memberCount:1,lastAuthor:null};
  const priv={id:'c3',title:'Private',access:'owner',owner:{account:mine,name:'Michael'},memberCount:0,lastAuthor:null};
  assert.equal(isSharedItem(shared,mine),true);
  assert.equal(isSharedItem(priv,mine),false);
  assert.equal(isSharedItem(ownShared,mine),true);
  assert.equal(document.querySelector('#viewer-notice')?.textContent.trim(),'You can view this thread. Ask the owner for access to take part.');
  assert.ok(document.querySelector('#share-button'));
  assert.ok(document.querySelector('#share-dialog'));
  assert.ok(document.querySelector('#rail-teams'));
  assert.ok(document.querySelector('#team-dialog'));
  assert.ok(document.querySelector('#team-create-open'));
  assert.ok(document.querySelector('#team-search'));
});

test('chat API sends PATCH and DELETE and keeps error status',async(t)=>{
  const calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url,method:options.method,body:options.body});
    if(url.includes('/missing'))return {ok:false,status:404,headers:{get:()=>'application/json'},json:async()=>({error:'Not found'})};
    return {ok:true,status:200,headers:{get:()=>'application/json'},json:async()=>({ok:true})};
  };
  t.after(()=>{delete globalThis.fetch;});
  const {patchChat,deleteChat,chatRequest}=await import('../public/chat-api.js');
  await patchChat('/conversations/x/members/account/y',{role:'viewer'});
  await deleteChat('/teams/t1');
  assert.deepEqual(calls.map(c=>c.method),['PATCH','DELETE']);
  assert.equal(calls[0].body,JSON.stringify({role:'viewer'}));
  await assert.rejects(()=>chatRequest('/missing'),e=>e.status===404);
});

test('the team manager separates the sharing default from the team being managed',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const {document}=parseHTML(html);
  globalThis.document=document;
  const {renderTeamManagerList,resolveFocusedTeamId}=await import('../public/team-view.js');
  const teams=[
    {id:'t1',name:'Am Yisroel',role:'owner',memberCount:3},
    {id:'t2',name:'Research Partners',role:'member',memberCount:1},
  ];
  assert.equal(resolveFocusedTeamId(teams,'missing'),'t1');
  assert.equal(resolveFocusedTeamId(teams,'t2'),'t2');

  renderTeamManagerList({teams,selectedTeamId:'t1',focusedTeamId:'t2'});
  const managed=document.querySelector('[data-team-select="t1"]');
  const focused=document.querySelector('[data-team-select="t2"]');
  assert.equal(managed.getAttribute('aria-current'),'true');
  assert.match(focused.textContent,/Default/);
});

test('a team reads the same everywhere and people show their name or their email',async()=>{
  const {teamFacts,mergeTeamDetail,personDisplay}=await import('../public/team-view.js');
  const summary={id:'t1',name:'Acquisitions',memberCount:4,role:'owner'};
  // A detail response that leaves out role and members must not contradict the summary.
  const sparse=mergeTeamDetail(summary,{team:{id:'t1',name:'Acquisitions',members:[]},members:[]});
  assert.deepEqual([teamFacts(summary,'me').meta,teamFacts(sparse,'me').meta],['Owner · 4 people','Owner · 4 people']);
  const members=[{account:'o',name:'Dana Cohen',email:'dana@witharosa.ai',role:'owner'},{account:'me',name:'michael',email:'michael@witharosa.ai',role:'member'}];
  const full=mergeTeamDetail({id:'t2',name:'Partners',memberCount:5,role:'member'},{team:{id:'t2',name:'Partners',owner:{account:'o',name:'Dana Cohen'},role:'member',members}});
  const facts=teamFacts(full,'me');
  assert.deepEqual([facts.count,facts.role,facts.ownerName,facts.meta],[2,'Member','Dana Cohen','Member · 2 people']);
  assert.deepEqual(personDisplay(members[0]),{primary:'Dana Cohen',secondary:'dana@witharosa.ai'});
  assert.deepEqual(personDisplay(members[1]),{primary:'michael@witharosa.ai',secondary:''},'a name that is only the email local part shows the email');
});

test('new conversations immediately lead the conversation list and move cleanly from pending to saved ID',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const {document}=parseHTML(html);
  globalThis.document=document;
  const {
    upsertConversationItem,
    sidebarConversationList,
  }=await import('../public/conversation-view.js');
  const me={account:'a'.repeat(24),name:'Michael'};
  const existing=[{id:'old-1',title:'Older thread',access:'owner',owner:me,memberCount:0}];

  // 1. Optimistic state before POST /conversations resolves
  const pending=sidebarConversationList(existing,{
    state:{id:null,title:'Arosa',messages:[]},
    pendingSubmission:{id:'sub-1',text:'In New Haven, do short-term rental rules differ by zoning district?'},
    submitPending:true,
    busy:false,
    me,
  });
  assert.equal(pending.activeId,'pending-sub-1');
  assert.equal(pending.items[0].id,'pending-sub-1');
  assert.match(pending.items[0].title,/In New Haven, do short-term rental rules differ/);

  // 2. After POST /conversations resolves, the same DOM button transitions to the real UUID
  const archiveAfterCreate=upsertConversationItem(existing,{
    id:'8b3f01ba-9fa7-420c-8e88-abeeb29d7867',
    title:'In New Haven, do short-term rental rules differ by zoning district?',
    updated:Date.now(),
  },me);
  const resolved=sidebarConversationList(archiveAfterCreate,{
    state:{id:'8b3f01ba-9fa7-420c-8e88-abeeb29d7867',title:'In New Haven, do short-term rental rules differ by zoning district?',messages:[]},
    pendingSubmission:{id:'sub-1',text:'In New Haven, do short-term rental rules differ by zoning district?'},
    submitPending:true,
    busy:false,
    me,
  });
  assert.equal(resolved.activeId,'8b3f01ba-9fa7-420c-8e88-abeeb29d7867');
  assert.deepEqual(resolved.items.map(c=>c.id),['8b3f01ba-9fa7-420c-8e88-abeeb29d7867','old-1'],'the saved conversation takes the pending one\'s place');
});

test('formatWorkedDuration, savedActivity, and decorateAnswerHeader render ChatGPT-style thinking duration and dateline header',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const {document}=parseHTML(html);
  globalThis.document=document;
  const {formatWorkedDuration,savedActivity}=await import('../public/activity-view.js');
  const {decorateAnswerHeader,formatAsOfDate}=await import('../public/conversation-view.js');

  assert.equal(formatWorkedDuration(130000),'Worked for 2m 10s');
  assert.equal(formatWorkedDuration(120000),'Worked for 2m');
  assert.equal(formatWorkedDuration(42000),'Worked for 42s');
  assert.equal(formatWorkedDuration(3900000),'Worked for 1h 5m');
  assert.equal(formatWorkedDuration(130000,true),'Worked for 2m 10s · Interrupted');
  assert.equal(formatWorkedDuration(null),'Research complete');

  const activityRoot=savedActivity('run-123',async()=>({events:[]}),()=>'Search',false,130000);
  assert.equal(activityRoot.querySelector('.research-status')?.textContent,'Worked for 2m 10s');

  const answer=document.createElement('div');
  answer.className='answer';
  answer.innerHTML='<h1>New Haven, CT — Short-Term Rental Regulations</h1><p>As of October 15, 2026</p><p>Assuming New Haven, Connecticut: yes, zoning can change the answer.</p>';
  decorateAnswerHeader(answer,{completedAt:Date.parse('2026-10-15T12:00:00Z'),hasSources:true});
  assert.equal(answer.querySelector('.answer-lead-title')?.textContent,'New Haven, CT — Short-Term Rental Regulations');
  assert.equal(answer.querySelector('.answer-dateline')?.textContent,'As of October 15, 2026');
  assert.match(formatAsOfDate(Date.parse('2026-10-15T12:00:00Z')),/^As of October 15, 2026$/);
});
