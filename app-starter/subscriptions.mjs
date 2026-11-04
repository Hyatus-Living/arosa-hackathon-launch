// Arosa Pro: a Stripe subscription, monthly or yearly, that lifts the free research allowance.
// Checkout and the billing portal are Stripe-hosted; the webhook mirrors each subscription change
// into the research service, which enforces the allowance.
import {BillingError} from '../acres-research/wallet.mjs';
import {verifyStripeWebhook} from './payments.mjs';

const appOrigin=process.env.AROSA_APP_ORIGIN||'https://build.witharosa.ai';
const purpose='arosa-pro-v1';
const ownerPattern=/^[a-f0-9]{24}$/;
export const PRO_PRICES={month:{amount:100},year:{amount:600}};

export function createSubscriptions({secretKey,webhookSecret,live=false,prices={},research,fetcher=fetch}) {
  const available=Boolean(secretKey&&webhookSecret&&prices.month&&prices.year);
  async function stripe(path,form,key) {
    const response=await fetcher('https://api.stripe.com/v1/'+path,{method:form?'POST':'GET',headers:{authorization:`Bearer ${secretKey}`,...(form?{'content-type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},...(form?{body:form.toString()}:{}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok)throw new BillingError('The payment provider is unavailable. Please try again.');
    return data;
  }
  // The subscription carries the account it was bought for; only Arosa Pro prices count.
  async function mirror(subscription,eventCreated) {
    if(subscription.metadata?.purpose!==purpose)return;
    const account=subscription.metadata.account,price=subscription.items?.data?.[0]?.price;
    const interval=Object.keys(prices).find(key=>prices[key]===price?.id);
    if(!ownerPattern.test(account||'')||!interval||price.recurring?.interval!==interval)throw new BillingError('Invalid subscription.',400);
    const periodEnd=subscription.current_period_end??subscription.items.data[0].current_period_end;
    const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer.id;
    await research(account,{status:subscription.status,interval,currentPeriodEnd:periodEnd?periodEnd*1000:null,
      cancelAtPeriodEnd:Boolean(subscription.cancel_at_period_end),customer,subscription:subscription.id,eventCreated});
  }
  return {
    available,
    async checkout(account,email,interval,customer,id) {
      if(!available)throw new BillingError('Upgrades are not open yet.');
      if(!ownerPattern.test(account))throw new BillingError('Invalid account.',401);
      if(!prices[interval])throw new BillingError('Choose monthly or yearly billing.',400);
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id||''))throw new BillingError('A payment request ID is required.',400);
      const form=new URLSearchParams({mode:'subscription','line_items[0][price]':prices[interval],'line_items[0][quantity]':'1',
        success_url:`${appOrigin}/?plan=success`,cancel_url:`${appOrigin}/?plan=cancelled`,client_reference_id:account,allow_promotion_codes:'true'});
      if(customer)form.set('customer',customer);else if(email)form.set('customer_email',email);
      for(const prefix of ['metadata','subscription_data[metadata]']){form.set(`${prefix}[account]`,account);form.set(`${prefix}[purpose]`,purpose);}
      const session=await stripe('checkout/sessions',form,`arosa-pro:${account}:${id}`);
      if(session.livemode!==live||typeof session.url!=='string'||!session.url.startsWith('https://checkout.stripe.com/'))throw new BillingError('Payment configuration could not be verified.');
      return {url:session.url};
    },
    async portal(customer) {
      if(!available)throw new BillingError('Billing is not open yet.');
      if(!/^cus_\w+$/.test(customer||''))throw new BillingError('There is no subscription to manage.',404);
      const session=await stripe('billing_portal/sessions',new URLSearchParams({customer,return_url:`${appOrigin}/?plan=manage`}));
      if(typeof session.url!=='string'||!session.url.startsWith('https://billing.stripe.com/'))throw new BillingError('Billing could not be verified.');
      return {url:session.url};
    },
    async webhook(raw,signature) {
      if(!available)throw new BillingError('Upgrades are not open yet.');
      const event=verifyStripeWebhook(raw,signature,webhookSecret);
      if(event.livemode!==live)throw new BillingError('Wrong payment environment.',400);
      const object=event.data?.object;
      if(!object||!Number.isSafeInteger(event.created))throw new BillingError('Invalid payment event.',400);
      if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed'].includes(event.type))
        await mirror(object,event.created);
      // Checkout can finish before the subscription events arrive; read the subscription it created.
      if(event.type==='checkout.session.completed'&&object.mode==='subscription'&&object.metadata?.purpose===purpose)
        await mirror(await stripe('subscriptions/'+encodeURIComponent(object.subscription)),event.created);
      return {received:true};
    },
  };
}
