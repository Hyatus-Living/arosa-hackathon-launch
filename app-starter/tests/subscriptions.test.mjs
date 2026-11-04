import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createSubscriptions} from '../subscriptions.mjs';

const account='a'.repeat(24),secret='test-only-subscription-secret';
const prices={month:'price_month',year:'price_year'};
function signed(event,time=Math.floor(Date.now()/1000)) {
  const raw=Buffer.from(JSON.stringify(event));return {raw,signature:`t=${time},v1=${createHmac('sha256',secret).update(time+'.').update(raw).digest('hex')}`};
}
const sub=(over={})=>({id:'sub_1',object:'subscription',status:'active',customer:'cus_1',cancel_at_period_end:false,
  metadata:{purpose:'arosa-pro-v1',account},items:{data:[{current_period_end:1790000000,price:{id:'price_year',recurring:{interval:'year'}}}]},...over});
const event=(type,object,over={})=>({id:'evt_1',type,livemode:false,created:1780000000,data:{object},...over});
function fixture({stripe={}}={}) {
  const recorded=[],calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    const path=url.replace('https://api.stripe.com/v1/','');
    const body=stripe[path.split('?')[0]]||{};
    return {ok:true,json:async()=>body};
  };
  const subscriptions=createSubscriptions({secretKey:'sk_test_fixture',webhookSecret:secret,prices,fetcher,research:async(owner,value)=>{recorded.push({owner,value});}});
  return {subscriptions,recorded,calls};
}

test('checkout opens a Stripe subscription for the chosen price, tagged with the account',async()=>{
  const f=fixture({stripe:{'checkout/sessions':{livemode:false,url:'https://checkout.stripe.com/c/pay/cs_test'}}});
  const result=await f.subscriptions.checkout(account,'buyer@example.com','month',null,crypto.randomUUID());
  assert.equal(result.url,'https://checkout.stripe.com/c/pay/cs_test');
  const form=new URLSearchParams(f.calls[0].options.body);
  assert.equal(form.get('mode'),'subscription');assert.equal(form.get('line_items[0][price]'),'price_month');
  assert.equal(form.get('customer_email'),'buyer@example.com');assert.equal(form.get('client_reference_id'),account);
  assert.equal(form.get('subscription_data[metadata][account]'),account);assert.equal(form.get('subscription_data[metadata][purpose]'),'arosa-pro-v1');
  assert.match(f.calls[0].options.headers['Idempotency-Key'],/^arosa-pro:/);
  await f.subscriptions.checkout(account,'buyer@example.com','year','cus_9',crypto.randomUUID());
  const again=new URLSearchParams(f.calls[1].options.body);
  assert.equal(again.get('customer'),'cus_9');assert.equal(again.get('customer_email'),null,'a returning customer keeps one Stripe customer');
  await assert.rejects(f.subscriptions.checkout(account,null,'week',null,crypto.randomUUID()),{status:400});
});

test('subscription events are verified and mirrored into the plan, from either event shape',async()=>{
  const f=fixture({stripe:{'subscriptions/sub_1':sub({status:'active'})}});
  const updated=signed(event('customer.subscription.updated',sub({cancel_at_period_end:true})));
  await f.subscriptions.webhook(updated.raw,updated.signature);
  assert.deepEqual(f.recorded[0],{owner:account,value:{status:'active',interval:'year',currentPeriodEnd:1790000000000,cancelAtPeriodEnd:true,customer:'cus_1',subscription:'sub_1',eventCreated:1780000000}});
  const completed=signed(event('checkout.session.completed',{id:'cs_1',mode:'subscription',subscription:'sub_1',metadata:{purpose:'arosa-pro-v1',account}}));
  await f.subscriptions.webhook(completed.raw,completed.signature);
  assert.equal(f.recorded[1].value.status,'active');
  const deleted=signed(event('customer.subscription.deleted',sub({status:'canceled'})));
  await f.subscriptions.webhook(deleted.raw,deleted.signature);
  assert.equal(f.recorded[2].value.status,'canceled');
});

test('events for other products, other prices or the wrong environment change nothing',async()=>{
  const f=fixture();
  const other=signed(event('customer.subscription.updated',sub({metadata:{purpose:'something-else',account}})));
  await f.subscriptions.webhook(other.raw,other.signature);
  assert.equal(f.recorded.length,0);
  const wrongPrice=signed(event('customer.subscription.updated',sub({items:{data:[{price:{id:'price_other',recurring:{interval:'year'}}}]}})));
  await assert.rejects(f.subscriptions.webhook(wrongPrice.raw,wrongPrice.signature),{status:400});
  const live=signed(event('customer.subscription.updated',sub(),{livemode:true}));
  await assert.rejects(f.subscriptions.webhook(live.raw,live.signature),/environment/);
  const forged=signed(event('customer.subscription.updated',sub()));
  // Flip the first hex digit to a different one; writing '0' is a no-op when the real digest starts with 0.
  await assert.rejects(f.subscriptions.webhook(forged.raw,forged.signature.replace(/v1=(.)/,(_,c)=>'v1='+(c==='0'?'1':'0'))),/signature/);
  assert.equal(f.recorded.length,0);
});

test('without Stripe configured, upgrades are closed rather than half-working',async()=>{
  const subscriptions=createSubscriptions({secretKey:'sk_test',webhookSecret:null,prices,research:async()=>{}});
  assert.equal(subscriptions.available,false);
  await assert.rejects(subscriptions.checkout(account,null,'month',null,crypto.randomUUID()),/not open/);
});
