import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {SIGN_OUT_URL,SIGNED_OUT_URL,accountDisplay,clearSavedDraft,endAccessSession,markSigningOut} from '../public/sign-out.js';

test('sign out points at the Cloudflare Access logout path for this app',()=>{
  assert.equal(SIGN_OUT_URL,'/cdn-cgi/access/logout');
});

test('signed-out users land on the public Arosa site and the session ends without navigating to Access',async()=>{
  // Signing out also ends the Arosa login session, so the next sign-in can be someone else.
  const signedOut=new URL(SIGNED_OUT_URL);
  assert.equal(signedOut.origin+signedOut.pathname,'https://login.witharosa.ai/sign-out');
  assert.equal(signedOut.searchParams.get('return_to'),'https://witharosa.ai/');
  const calls=[];
  assert.equal(await endAccessSession(async(url,options)=>{calls.push({url,options});}),true);
  assert.deepEqual(calls,[{url:'/cdn-cgi/access/logout',options:{credentials:'include',mode:'no-cors',cache:'no-store'}}]);
  assert.equal(await endAccessSession(async()=>{throw new Error('offline');}),false);
  assert.equal(await endAccessSession(null),false);
});

test('account display names the signed-in person and falls back to the email',()=>{
  assert.deepEqual(accountDisplay({name:'Michael Ort',email:'michael@witharosa.ai'}),{primary:'Michael Ort',secondary:'michael@witharosa.ai',initials:'MO',email:'michael@witharosa.ai'});
  assert.deepEqual(accountDisplay({name:null,email:'Alex.Rivera@witharosa.ai'}),{primary:'alex.rivera@witharosa.ai',secondary:'',initials:'AR',email:'alex.rivera@witharosa.ai'});
  assert.deepEqual(accountDisplay({name:'chaim',email:'chaim@witharosa.ai'}),{primary:'chaim@witharosa.ai',secondary:'',initials:'C',email:'chaim@witharosa.ai'},'a name that is only the email local part is not a name');
  assert.deepEqual(accountDisplay({name:'  ',email:''}),{primary:'Arosa account',secondary:'Saved to your Arosa account',initials:'A',email:null});
  assert.deepEqual(accountDisplay(null),{primary:'Arosa account',secondary:'Saved to your Arosa account',initials:'A',email:null});
});

test('signing out clears only the current account draft and never blocks leaving',()=>{
  const store=new Map([['mine','draft'],['theirs','keep']]);
  const storage={removeItem:key=>store.delete(key)};
  assert.equal(clearSavedDraft(storage,'mine'),true);
  assert.equal(store.has('mine'),false);
  assert.equal(store.get('theirs'),'keep');
  assert.equal(clearSavedDraft(storage,null),false);
  assert.equal(clearSavedDraft(null,'mine'),false);
  assert.equal(clearSavedDraft({removeItem(){throw new Error('blocked');}},'mine'),false);
});

test('the app shows who is signed in and offers sign out in the top bar and sidebar',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const {document}=parseHTML(html);
  const signOut=document.querySelector('#sign-out');
  assert.ok(signOut);
  assert.equal(signOut.getAttribute('href'),SIGN_OUT_URL);
  assert.match(signOut.textContent,/Sign out/);
  for(const link of document.querySelectorAll('a.sign-out'))assert.equal(link.getAttribute('href'),SIGN_OUT_URL);
  assert.ok(document.querySelector('#account-name'));
  assert.ok(document.querySelector('#account-email'));
  assert.ok(document.querySelector('#account-initials'));
  assert.ok(document.querySelector('#logout'));
});

test('a hung Access logout request still lets the user leave',async()=>{
  const started=Date.now();
  assert.equal(await endAccessSession(()=>new Promise(()=>{}),25),false);
  assert.ok(Date.now()-started<2000,'sign-out must resolve near the timeout, not hang');
});

test('signing out is announced on every sign-out link and repeats are ignored',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const {document}=parseHTML(html);
  // The main menu has one sign-out link; an expired session adds another to its notice.
  assert.equal(document.querySelectorAll('#navigation a.sign-out').length,1);
  const notice=document.createElement('a');notice.className='sign-out';notice.href=SIGN_OUT_URL;notice.textContent='sign out to switch accounts';document.body.append(notice);
  const links=[...document.querySelectorAll('a.sign-out')];
  assert.ok(links.length>=2);
  assert.equal(markSigningOut(links),true);
  for(const link of links){
    assert.ok(link.classList.contains('is-pending'));
    assert.equal(link.getAttribute('aria-disabled'),'true');
    assert.match(link.textContent,/Signing out/);
  }
  assert.equal(markSigningOut(links),false);
});
