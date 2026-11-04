import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {Crm,NB_FILINGS} from './crm.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-crm-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return new Crm(store);
}

const lead=(ref,over={})=>({name:`Buyer ${ref}`,sourceRef:ref,borough:'Queens',details:{lots:4},candidates:[{name:`Buyer ${ref}`,url:'https://example.com/p'}],...over});

test('a re-import updates leads in place and keeps what the team entered',t=>{
  const crm=fixture(t);
  assert.deepEqual(crm.import('buyers',[lead('BP001'),lead('BP002')],1),{created:2,updated:0});
  const [first]=crm.list().contacts.filter(c=>c.source_ref==='BP001');
  crm.update(first.id,{status:'researching',email:'buyer@example.com',notes:'Owns four lots'},2);
  assert.deepEqual(crm.import('buyers',[lead('BP001',{details:{lots:5}}),lead('BP003')],3),{created:1,updated:1});
  const again=crm.get(first.id);
  assert.equal(again.status,'researching');
  assert.equal(again.email,'buyer@example.com');
  assert.equal(again.notes,'Owns four lots');
  assert.deepEqual(again.details,{lots:5,edited:['status','email','notes']});
  assert.equal(crm.list().contacts.length,3);
});

test('logging a reach-out records it and moves a new contact to reached out',t=>{
  const crm=fixture(t);
  crm.import('buyers',[lead('BP001')],1);
  const [contact]=crm.list().contacts;
  const touched=crm.touch(contact.id,'michael@witharosa.ai',{channel:'email',note:'Beta invite sent'},5);
  assert.equal(touched.status,'reached_out');
  assert.equal(touched.last_contacted,5);
  assert.deepEqual(touched.touches.map(x=>[x.channel,x.note,x.byEmail]),[['email','Beta invite sent','michael@witharosa.ai']]);
  crm.update(contact.id,{status:'replied'},6);
  assert.equal(crm.touch(contact.id,'michael@witharosa.ai',{channel:'phone'},7).status,'replied');
  assert.equal(crm.list().counts.replied,1);
});

test('bad input is refused with a clear error',t=>{
  const crm=fixture(t);
  crm.import('buyers',[lead('BP001')],1);
  const [contact]=crm.list().contacts;
  assert.throws(()=>crm.update(contact.id,{status:'friendly'}),{status:400,message:'Unknown status.'});
  assert.throws(()=>crm.touch(contact.id,'a@b.c',{channel:'pigeon'}),{status:400,message:'Unknown channel.'});
  assert.throws(()=>crm.get('00000000-0000-0000-0000-000000000000'),{status:404});
  assert.throws(()=>crm.import('buyers',[{sourceRef:'X'}]),{status:400,message:'Every contact needs a name.'});
  assert.equal(crm.list().contacts.length,1,'a failed import adds nothing');
});

test('granting beta access invites contacts with that email who were earlier in the funnel',t=>{
  const crm=fixture(t);
  crm.import('buyers',[lead('BP001',{email:' Pat@Example.com '}),lead('BP002',{email:'pat@example.com'}),lead('BP003',{email:'sam@example.com'})],1);
  const [a,b]=crm.list().contacts.filter(c=>c.email?.toLowerCase().includes('pat'));
  crm.update(b.id,{status:'not_interested'},2);
  assert.equal(crm.markBetaInvited('PAT@example.com',3),1);
  assert.equal(crm.get(a.id).status,'beta_invited');
  assert.equal(crm.get(b.id).status,'not_interested','a later status is left alone');
  assert.equal(crm.list().contacts.find(c=>c.email==='sam@example.com').status,'new');
});

test('a beta application lands as a new contact keyed by email, and applying again updates it',t=>{
  const crm=fixture(t);
  assert.deepEqual(crm.apply({name:'Dana Builder',email:'Dana@Example.com',company:'Builder LLC',role:'developer',focus:'Walk-ups in Brooklyn'},Date.UTC(2026,9,21)),{ok:true});
  let [c]=crm.list().contacts;
  assert.equal(c.source,'Beta applications');
  assert.equal(c.email,'dana@example.com');
  assert.equal(c.title,'Developer');
  assert.equal(c.status,'new');
  assert.deepEqual(c.details,{role:'developer',focus:'Walk-ups in Brooklyn',appliedAt:'2026-10-21'});
  crm.apply({name:'Dana Builder',email:'dana@example.com',role:'investor',focus:'Queens lots'},Date.UTC(2026,9,22));
  [c]=crm.list().contacts;
  assert.equal(crm.list().contacts.length,1);
  assert.equal(c.details.focus,'Queens lots');
  assert.throws(()=>crm.apply({name:'',email:'a@b.co',role:'developer'}),{status:400,message:'Enter your name.'});
  assert.throws(()=>crm.apply({name:'X',email:'not-an-email',role:'developer'}),{status:400,message:'Enter a valid email address.'});
  assert.throws(()=>crm.apply({name:'X',email:'a@b.co',role:'astronaut'}),{status:400,message:'Choose what best describes you.'});
});

test('enrichment results survive a re-import and a person\'s edits are remembered',t=>{
  const crm=fixture(t);
  crm.import('buyers',[lead('BP001')],1);
  const [c]=crm.list().contacts;
  crm.saveEnrichment(c.id,{details:{lots:4,lookup:{workEmail:'a@b.co'},identity:{verdict:'confirmed'}},email:'a@b.co'},2);
  crm.update(c.id,{email:'a@b.co',phone:'+1 212 555 0100',status:'new'},3);
  assert.deepEqual(crm.get(c.id).details.edited,['phone'],'only fields whose value changed count as edited');
  crm.import('buyers',[lead('BP001',{details:{lots:6}})],4);
  assert.deepEqual(crm.get(c.id).details,{lots:6,lookup:{workEmail:'a@b.co'},identity:{verdict:'confirmed'},edited:['phone']});
});

test('parking a source keeps its contacts, their status and their details, and a re-import keeps them parked',t=>{
  const crm=fixture(t);
  crm.import('buyers',[lead('BP001'),lead('BP002')],1);
  crm.import(NB_FILINGS,[lead('developer:ACME',{details:{segment:'developers',filings:3}})],1);
  const [first]=crm.list().contacts.filter(c=>c.source_ref==='BP001');
  crm.update(first.id,{status:'researching'},2);
  assert.deepEqual(crm.segment('buyers','parked',3),{updated:2});
  const parked=crm.get(first.id);
  assert.equal(parked.status,'researching');
  assert.deepEqual(parked.details,{lots:4,edited:['status'],segment:'parked'});
  crm.import('buyers',[lead('BP001',{details:{lots:6}})],4);
  assert.equal(crm.get(first.id).details.segment,'parked');
  assert.deepEqual(crm.list().contacts.find(c=>c.source===NB_FILINGS).details,{segment:'developers',filings:3});
  assert.throws(()=>crm.segment('buyers','vip'),{status:400,message:'Unknown segment.'});
  assert.throws(()=>crm.segment('nobody','parked'),{status:404});
});
