import {createHmac, timingSafeEqual} from 'node:crypto';
import {BillingError, money} from '../acres-research/wallet.mjs';
const appOrigin=process.env.AROSA_APP_ORIGIN||'https://build.witharosa.ai';

const ownerPattern=/^[a-f0-9]{24}$/;
const purpose='acres-prepaid-v1';
export function verifyStripeWebhook(raw, signature, secret, now=Date.now()) {
  if (!secret || typeof signature!=='string' || !Buffer.isBuffer(raw)) throw new BillingError('Invalid payment signature.',400);
  const fields=signature.split(',').map(part=>part.split('='));
  const timestamp=fields.find(([key])=>key==='t')?.[1];
  if(!/^\d+$/.test(timestamp||'') || Math.abs(now/1000-Number(timestamp))>300)throw new BillingError('Expired payment signature.',400);
  const expected=createHmac('sha256',secret).update(timestamp+'.').update(raw).digest();
  const valid=fields.some(([key,value])=>key==='v1' && /^[a-f0-9]{64}$/.test(value||'') && timingSafeEqual(expected,Buffer.from(value,'hex')));
  if(!valid)throw new BillingError('Invalid payment signature.',400);
  try {return JSON.parse(raw.toString('utf8'));}catch{throw new BillingError('Invalid payment event.',400);}
}
export function createPayments({wallet,secretKey,webhookSecret,live=false,fetcher=fetch}) {
  async function stripe(path,form,key) {
    if(!secretKey)throw new BillingError('Credit top-ups are not configured.');
    const response=await fetcher('https://api.stripe.com/v1/'+path,{method:form?'POST':'GET',headers:{authorization:`Bearer ${secretKey}`,...(form?{'content-type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},...(form?{body:form.toString()}:{}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok)throw new BillingError('The payment provider is unavailable. Please try again.');
    return data;
  }
  return {
    async checkout(owner,amountCents,id) {
      if(!ownerPattern.test(owner))throw new BillingError('Invalid wallet identity.',401);
      if(![1000,2500,5000].includes(amountCents))throw new BillingError('Choose a $10, $25, or $50 top-up.',400);
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id||''))throw new BillingError('A payment request ID is required.',400);
      if((await wallet.snapshot(owner)).blockedReason)throw new BillingError('Payments for this wallet need review.',402);
      const form=new URLSearchParams({mode:'payment',success_url:`${appOrigin}/?wallet=success`,cancel_url:`${appOrigin}/?wallet=cancelled`,'payment_method_types[0]':'card','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(amountCents),'line_items[0][price_data][product_data][name]':'Arosa research credits','line_items[0][quantity]':'1'});
      for(const prefix of ['metadata','payment_intent_data[metadata]']) {
        form.set(`${prefix}[walletOwner]`,owner);form.set(`${prefix}[purpose]`,purpose);form.set(`${prefix}[amountCents]`,String(amountCents));
      }
      const session=await stripe('checkout/sessions',form,`acres:${owner}:${id}`);
      if(session.livemode!==live || typeof session.url!=='string' || !session.url.startsWith('https://checkout.stripe.com/'))throw new BillingError('Payment configuration could not be verified.');
      return {url:session.url};
    },
    async webhook(raw,signature) {
      const event=verifyStripeWebhook(raw,signature,webhookSecret);
      if(event.livemode!==live)throw new BillingError('Wrong payment environment.',400);
      const object=event.data?.object;
      if(!object)throw new BillingError('Invalid payment event.',400);
      if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
        if(object.metadata?.purpose!==purpose)return {received:true};
        const owner=object.metadata.walletOwner,cents=Number(object.metadata.amountCents);
        if(!ownerPattern.test(owner||'') || ![1000,2500,5000].includes(cents) || object.mode!=='payment' || object.currency!=='usd' || object.amount_total!==cents || !/^cs_/.test(object.id||''))throw new BillingError('Invalid credit purchase.',400);
        if(object.payment_status==='paid')await wallet.credit(owner,'stripe:'+object.id,money(cents*10000),{paymentReference:object.id});
      }
      if(event.type==='charge.refunded') {
        if(object.metadata?.purpose!==purpose)return {received:true};
        const owner=object.metadata.walletOwner;
        if(!ownerPattern.test(owner||'') || object.currency!=='usd' || !Number.isSafeInteger(object.amount_refunded) || object.amount_refunded<0 || object.amount_refunded>object.amount)throw new BillingError('Invalid refund.',400);
        // Reconcile the purchase first, even if refund delivery precedes checkout delivery.
        const sessions=await stripe('checkout/sessions?payment_intent='+encodeURIComponent(object.payment_intent)+'&limit=1');
        const session=sessions.data?.[0];
        if(session?.metadata?.purpose!==purpose || session.metadata.walletOwner!==owner || session.payment_status!=='paid' || session.currency!=='usd' || session.amount_total!==object.amount)throw new BillingError('Refund purchase could not be verified.');
        await wallet.credit(owner,'stripe:'+session.id,money(object.amount*10000),{paymentReference:session.id});
        await wallet.refund(owner,'stripe-refund:'+object.id,object.amount_refunded*10000);
      }
      if(event.type==='charge.dispute.created') {
        const charge=await stripe('charges/'+encodeURIComponent(object.charge));
        if(charge.metadata?.purpose===purpose) {
          if(!ownerPattern.test(charge.metadata.walletOwner||''))throw new BillingError('Invalid disputed wallet.',400);
          await wallet.block(charge.metadata.walletOwner,'stripe-dispute:'+object.id);
        }
      }
      return {received:true};
    },
  };
}
