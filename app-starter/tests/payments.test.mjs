import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createPayments,verifyStripeWebhook} from '../payments.mjs';
import {Wallet} from '../../acres-research/wallet.mjs';

const owner='a'.repeat(24),secret='test-only-webhook-secret';
function signed(event,time=Math.floor(Date.now()/1000)) {
  const raw=Buffer.from(JSON.stringify(event));return {raw,signature:`t=${time},v1=${createHmac('sha256',secret).update(time+'.').update(raw).digest('hex')}`};
}
function purchase() {return {livemode:false,type:'checkout.session.completed',data:{object:{id:'cs_test_purchase',mode:'payment',currency:'usd',amount_total:1000,payment_status:'paid',metadata:{purpose:'acres-prepaid-v1',walletOwner:owner,amountCents:'1000'}}}};}
// A minimal transactional repository without coupling payments to Firestore internals.
function fixture() {
  let balance=0;const operations=new Map();let chain=Promise.resolve();
  const repository={async transact(owner,key,mutate){const task=chain.then(()=>{const change=mutate({balanceMicros:balance,heldMicros:0},operations.get(key)||null);if(change){balance=change.wallet.balanceMicros;operations.set(key,change.operation);}return operations.get(key);});chain=task.catch(()=>{});return task;},async snapshot(){return {balanceMicros:balance};}};
  const wallet=new Wallet(repository);return {wallet,payments:createPayments({wallet,secretKey:'sk_test_fixture',webhookSecret:secret}),balance:()=>balance};
}
test('Stripe signature requires exact raw body and rejects replay outside the time window',()=>{
  const event=purchase(),{raw,signature}=signed(event);assert.deepEqual(verifyStripeWebhook(raw,signature,secret),event);
  assert.throws(()=>verifyStripeWebhook(Buffer.from(raw+' '),signature,secret),/signature/);
  const old=signed(event,Math.floor(Date.now()/1000)-301);assert.throws(()=>verifyStripeWebhook(old.raw,old.signature,secret),/Expired/);
  assert.throws(()=>verifyStripeWebhook(raw,signature,'wrong-secret'),/signature/);
});
test('a verified paid session is credited once across duplicate deliveries; unpaid returns add nothing',async()=>{
  const f=fixture(),event=purchase(),s=signed(event);await Promise.all([f.payments.webhook(s.raw,s.signature),f.payments.webhook(s.raw,s.signature)]);assert.equal(f.balance(),10_000_000);
  event.data.object.payment_status='unpaid';event.data.object.id='cs_unpaid';const unpaid=signed(event);await f.payments.webhook(unpaid.raw,unpaid.signature);assert.equal(f.balance(),10_000_000);
});
test('wrong currency, amount, owner and environment cannot create credits',async()=>{
  for(const change of [e=>{e.data.object.currency='eur';},e=>{e.data.object.amount_total=500;},e=>{e.data.object.metadata.walletOwner='someone-else';},e=>{e.livemode=true;}]) {
    const f=fixture(),event=purchase();change(event);const s=signed(event);await assert.rejects(f.payments.webhook(s.raw,s.signature));assert.equal(f.balance(),0);
  }
});
test('Checkout derives account metadata server-side, restricts amounts, and preserves idempotency',async()=>{
  const requests=[];const wallet={snapshot:async()=>({})};
  const payments=createPayments({wallet,secretKey:'test-key',fetcher:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({url:'https://checkout.stripe.com/c/pay/test',livemode:false})};}});
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await payments.checkout(owner,1000,id);
  const form=new URLSearchParams(requests[0].options.body);assert.equal(form.get('metadata[walletOwner]'),owner);assert.equal(form.get('payment_intent_data[metadata][walletOwner]'),owner);assert.equal(form.get('line_items[0][price_data][unit_amount]'),'1000');assert.equal(requests[0].options.headers['Idempotency-Key'],`acres:${owner}:${id}`);
  await assert.rejects(payments.checkout(owner,1,id),/Choose/);await assert.rejects(payments.checkout(owner,1000,'missing'),/ID/);assert.equal(requests.length,1);
});
test('refund arriving before purchase delivery reconciles once without creating free credits',async()=>{
  const f=fixture(),session=purchase().data.object;
  const payments=createPayments({wallet:f.wallet,secretKey:'test-key',webhookSecret:secret,fetcher:async()=>({ok:true,json:async()=>({data:[session]})})});
  const refund={livemode:false,type:'charge.refunded',data:{object:{id:'ch_purchase',payment_intent:'pi_purchase',amount:1000,amount_refunded:1000,currency:'usd',metadata:session.metadata}}};
  let s=signed(refund);await payments.webhook(s.raw,s.signature);assert.equal(f.balance(),0);
  s=signed(purchase());await payments.webhook(s.raw,s.signature);assert.equal(f.balance(),0);
  s=signed(refund);await payments.webhook(s.raw,s.signature);assert.equal(f.balance(),0);
});
