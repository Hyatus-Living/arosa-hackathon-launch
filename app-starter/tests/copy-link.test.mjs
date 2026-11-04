import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderParcel} from '../public/core-view.js';
import {renderInspector} from '../public/listing-inspector.js';
import {fullState} from './fixtures/project-state.mjs';

const {document,window}=parseHTML('<html><body></body></html>');
globalThis.document=document;
globalThis.window=window;
const tick=()=>new Promise((resolve)=>setImmediate(resolve));

test('the site header copies the site link only when the page supplies the copier',async()=>{
  const plain=renderParcel(fullState,{canSend:false,canEdit:false});
  assert.equal(plain.querySelector('.uw-share'),null);

  let copiedFor=null;
  const root=renderParcel(fullState,{canSend:false,canEdit:false,onCopySiteLink:async(id)=>{copiedFor=id;}});
  const button=[...root.querySelectorAll('.uw-share button')].find((b)=>b.textContent==='Copy link');
  assert.ok(button,'expected a Copy link button in the site header');
  button.click();
  await tick();
  assert.equal(copiedFor,fullState.id);
  assert.match(root.querySelector('.uw-share-status').textContent,/Link copied\. People with access can open it\./);
});

test('a failed site copy says so instead of claiming success',async()=>{
  const root=renderParcel(fullState,{canSend:false,canEdit:false,onCopySiteLink:async()=>{throw new Error('denied');}});
  root.querySelector('.uw-share button').click();
  await tick();
  assert.match(root.querySelector('.uw-share-status').textContent,/Could not copy\./);
});

test('the site header exports the deck of the site conversation when there is one',()=>{
  let opened=0;
  const root=renderParcel(fullState,{canSend:false,canEdit:false,onCopySiteLink:async()=>{},onExportDeck:()=>{opened++;}});
  const labels=[...root.querySelectorAll('.uw-share button')].map((b)=>b.textContent);
  assert.deepEqual(labels,['Copy link','Underwriting package']);
  root.querySelectorAll('.uw-share button')[1].click();
  assert.equal(opened,1);
  const none=renderParcel(fullState,{canSend:false,canEdit:false,onCopySiteLink:async()=>{},onExportDeck:null});
  assert.deepEqual([...none.querySelectorAll('.uw-share button')].map((b)=>b.textContent),['Copy link'],'no deck before the site has a conversation');
});

const deal={id:'deal-1',address:'1 Test Street',bbl:'3009660001',borough:'BK',maxUapZfa:6800,flashcardValuation:{},similarComps:[]};
const base={canStart:()=>true,onUnderwrite(){},onAsk(){},onClose(){}};

test('the listing menu copies the listing link only when the page supplies the copier',()=>{
  const plain=renderInspector(deal,base);
  assert.equal([...plain.querySelectorAll('button')].some((b)=>b.textContent==='Copy link'),false);

  let copied=null;
  const root=renderInspector(deal,{...base,onCopyLink:(d)=>{copied=d;}});
  const button=[...root.querySelectorAll('.inspector-menu button')].find((b)=>b.textContent==='Copy link');
  assert.ok(button,'expected a Copy link item in the listing More menu');
  assert.match(button.parentElement.textContent,/opens for anyone signed in/);
  button.click();
  assert.equal(copied.listing_id,deal.id);
});
