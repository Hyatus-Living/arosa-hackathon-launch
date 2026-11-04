import {publicErrorMessage} from './chat-api.js';
import {skel} from './skeleton.js';

const dialog=document.querySelector('#wallet-dialog');
const content=document.querySelector('#wallet-content');
const notice=document.querySelector('#wallet-notice');
const button=document.querySelector('#wallet-button');
// The rail item stays "Plan"; this month's free usage, Pro, or a credit balance sits beside it as a quiet badge.
const setBalance=(badgeText,title)=>{const badge=document.querySelector('#wallet-balance');if(badge){badge.textContent=badgeText||'';badge.hidden=!badgeText;}button.title=title?`Plan · ${title}`:'Plan';};
const usd=micros=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6}).format(micros/1e6);
const TOPUPS=[1000,2500,5000],DEFAULT_TOPUP=2500;
function element(tag,text,className) {const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
async function request(path,options={}) {
  const response=await fetch('/api'+path,{cache:'no-store',signal:AbortSignal.timeout(30000),...options}).catch(()=>{throw new Error(publicErrorMessage({},'Your plan'));});
  if(response.status>=500&&!response.headers.get('content-type')?.includes('application/json'))throw new Error(publicErrorMessage({status:response.status},'Your plan'));
  if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Sign in to Arosa to view your plan.');
  const data=await response.json();if(!response.ok)throw new Error(publicErrorMessage({status:response.status,message:data.error,userFacing:data.userFacing||(response.status>=400&&response.status<500),code:data.code},'Your plan'));return data;
}
const shortDate=(at,timeZone)=>new Date(at).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone,...(new Date(at).getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{})});

// What the plan section says: the plan, this month's research, and what happens next.
export function planSummary(plan) {
  const runs=n=>`${n} research run${n===1?'':'s'}`;
  if(plan.plan==='team')return {name:'Team access',line:'Unlimited research',detail:`${runs(plan.used)} this month`,badge:null};
  if(plan.plan==='pro') {
    const sub=plan.subscription||{},billing=sub.interval==='year'?'Billed yearly':'Billed monthly';
    const renewal=sub.currentPeriodEnd?(sub.cancelAtPeriodEnd?`Ends ${shortDate(sub.currentPeriodEnd)}`:`Renews ${shortDate(sub.currentPeriodEnd)}`):'';
    return {name:'Arosa Pro',line:'Unlimited research',detail:[billing,renewal,`${runs(plan.used)} this month`].filter(Boolean).join(' · '),badge:'Pro'};
  }
  // Beta testers research without a practical limit in exchange for their feedback; the safety cap
  // shows only if someone reaches it.
  if(plan.plan==='beta')return {name:'Beta tester',line:'Unlimited during the beta',detail:`${runs(plan.used)} this month`,badge:null};
  if(plan.limit===null)return {name:'Free plan',line:`${runs(plan.used)} this month`,detail:'',badge:null};
  const used=Math.min(plan.used,plan.limit);
  return {name:'Free plan',line:`${used} of ${plan.limit} free research runs used`,detail:`Resets ${shortDate(plan.resetsAt,'UTC')}`,badge:`${used}/${plan.limit}`,
    progress:used/plan.limit,reached:plan.used>=plan.limit};
}

const INTERVALS=[['year','Yearly','$600 / year','Save 50%'],['month','Monthly','$100 / month','']];
let planCheckout=null,selectedInterval='year';
function upgrade(plan) {
  const box=element('section',undefined,'wallet-topup plan-upgrade');
  box.setAttribute('aria-label','Upgrade to Arosa Pro');
  const heading=element('div',undefined,'plan-upgrade-head');
  heading.append(element('strong','Arosa Pro'),element('span','Unlimited research'));
  const choices=element('div',undefined,'wallet-amounts plan-intervals');
  choices.setAttribute('role','radiogroup');choices.setAttribute('aria-label','Billing');
  const primary=element('button','Upgrade to Pro','wallet-primary');primary.type='button';primary.id='plan-upgrade';
  const reason=element('small',plan.checkoutAvailable?'Billed by card through secure checkout. Cancel anytime.':'Upgrades open soon.','wallet-reason');
  const buttons=[];
  const select=interval=>{selectedInterval=interval;for(const choice of buttons){const on=choice.dataset.interval===interval;choice.setAttribute('aria-checked',String(on));choice.tabIndex=on?0:-1;}};
  for(const [interval,label,price,note] of INTERVALS) {
    const choice=element('button',undefined,'wallet-amount plan-interval');choice.type='button';choice.dataset.interval=interval;choice.setAttribute('role','radio');
    choice.append(element('span',label),element('strong',price),...(note?[element('small',note)]:[]));
    choice.addEventListener('click',()=>select(interval));
    choice.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
      event.preventDefault();const next=selectedInterval==='year'?'month':'year';select(next);buttons.find(b=>b.dataset.interval===next).focus();
    });
    buttons.push(choice);choices.append(choice);
  }
  select(selectedInterval);
  primary.disabled=!plan.checkoutAvailable;
  primary.addEventListener('click',async()=>{
    for(const node of [primary,...buttons])node.disabled=true;
    primary.textContent='Opening checkout…';notice.textContent='';
    if(!planCheckout||planCheckout.interval!==selectedInterval)planCheckout={interval:selectedInterval,id:crypto.randomUUID()};
    try {
      const result=await request('/plan/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(planCheckout)});
      const url=new URL(result.url);if(url.origin!=='https://checkout.stripe.com')throw new Error('Checkout could not be verified.');
      window.location.assign(url.href);
    } catch(error) {notice.textContent=error.message;for(const node of [primary,...buttons])node.disabled=false;primary.textContent='Upgrade to Pro';}
  });
  box.append(heading,choices,primary,reason);
  return box;
}
function manage() {
  const action=element('button','Manage billing','wallet-retry plan-manage');action.type='button';
  action.addEventListener('click',async()=>{
    action.disabled=true;notice.textContent='';
    try {
      const result=await request('/plan/portal',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
      const url=new URL(result.url);if(url.origin!=='https://billing.stripe.com')throw new Error('Billing could not be verified.');
      window.location.assign(url.href);
    } catch(error){notice.textContent=error.message;action.disabled=false;}
  });
  return action;
}
function planSection(plan) {
  const summary=planSummary(plan);
  const section=element('section',undefined,'wallet-balance plan-summary');
  section.setAttribute('aria-label','Your plan');
  section.append(element('span',summary.name),element('strong',summary.line,'plan-line'));
  if(summary.progress!==undefined) {
    const meter=element('div',undefined,'plan-meter');
    meter.setAttribute('role','progressbar');meter.setAttribute('aria-label','Free research used');
    meter.setAttribute('aria-valuemin','0');meter.setAttribute('aria-valuemax',String(plan.limit));meter.setAttribute('aria-valuenow',String(Math.min(plan.used,plan.limit)));
    const fill=element('span');fill.style.width=`${Math.round(summary.progress*100)}%`;if(summary.reached)meter.classList.add('is-full');
    meter.append(fill);section.append(meter);
  }
  if(summary.detail)section.append(element('small',summary.detail));
  const parts=[section];
  // A beta tester sees the upgrade only after reaching the safety cap.
  if(plan.limit!==null&&(plan.plan==='free'||(plan.plan==='beta'&&plan.used>=plan.limit)))parts.push(upgrade(plan));
  if(plan.plan==='pro'&&plan.manageable)parts.push(manage());
  return parts;
}

// Dates read like "Oct 17, 11:00 AM"; the year appears only when it is not this year.
export function walletDate(at,now=Date.now()) {
  const date=new Date(at);
  const options={month:'short',day:'numeric',hour:'numeric',minute:'2-digit'};
  if(date.getFullYear()!==new Date(now).getFullYear())options.year='numeric';
  return date.toLocaleString('en-US',options);
}

const researchTitle=entry=>[entry.conversationTitle,entry.siteTitle,entry.title,entry.address].find(value=>typeof value==='string'&&value.trim())?.trim()||'';
const OTHER_LABELS={topup:'Credits added',refund:'Refund',dispute:'Payment under review',reserve:'Held for research',release:'Hold released',pending:'Awaiting final cost',usage:'Research request'};

// One row per research request: every charge, hold and release a request made is summed into it,
// so the list reads as what was bought rather than as ledger mechanics.
export function walletRows(entries=[]) {
  const rows=[],byRun=new Map();
  for(const entry of entries) {
    if(entry.runId) {
      let row=byRun.get(entry.runId);
      if(!row) {row={kind:'research',at:entry.at,title:'',operation:entry.operation,chargedMicros:0,heldMicros:0,charged:false,estimated:false,pending:false};byRun.set(entry.runId,row);rows.push(row);}
      row.title||=researchTitle(entry);
      if(entry.kind==='usage'){row.charged=true;row.chargedMicros+=entry.deltaMicros||0;if(entry.estimated)row.estimated=true;}
      if(entry.kind==='reserve'||entry.kind==='pending')row.heldMicros+=entry.reservedMicros||0;
      if(entry.kind==='pending')row.pending=true;
      continue;
    }
    const kind=entry.kind?.startsWith('refund')?'refund':entry.kind;
    rows.push({kind,at:entry.at,title:researchTitle(entry),deltaMicros:entry.deltaMicros||0,heldMicros:entry.reservedMicros||0,estimated:Boolean(entry.estimated)});
  }
  return rows.map(row=>{
    if(row.kind==='research') {
      const label=({meta_visual_segment:'Photo selection',meta_visual_illustrate:'Housing illustration'})[row.operation]||(row.title?`Research on ${row.title}`:'Research request');
      const amount=row.charged?usd(row.chargedMicros):row.heldMicros?`${usd(row.heldMicros)} held`:'No charge';
      const note=row.pending?'Awaiting final cost':row.estimated?'Estimated cost':'';
      return {label,amount,at:row.at,note};
    }
    const label=row.kind==='usage'&&row.title?`Research on ${row.title}`:OTHER_LABELS[row.kind]||'Account activity';
    const amount=row.deltaMicros?usd(row.deltaMicros):(row.kind==='reserve'||row.kind==='pending')&&row.heldMicros?`${usd(row.heldMicros)} held`:'';
    return {label,amount,at:row.at,note:row.kind==='usage'&&row.estimated?'Estimated cost':''};
  });
}

// Plain names for the services research pays for; the vendor behind each is not the customer's concern.
const SERVICE_NAMES={openai:'AI model',anthropic:'AI model',codex:'AI model',meta:'AI model',gemini:'AI model',exa:'Web search',firecrawl:'Web pages',google:'Maps and places'};
function priceLine(rate) {
  if(rate.mode==='estimated_call')return `${usd(rate.amountMicros)} per call`;
  if(rate.mode==='estimated_tokens')return `${usd(rate.inputMicrosPerMillion)} in, ${usd(rate.outputMicrosPerMillion)} out per million tokens`;
  return 'Billed at cost';
}
function pricing(policy) {
  const rates=Object.entries(policy?.rates||{});
  if(!rates.length)return null;
  const details=element('details',undefined,'wallet-pricing');
  const summary=element('summary');summary.append(element('span','Pricing'),element('small','At cost, no markup'));
  const list=element('dl');
  for(const [provider,rate] of rates) {
    const row=element('div');
    row.append(element('dt',SERVICE_NAMES[provider.toLowerCase()]||'Other services'),element('dd',priceLine(rate)));
    list.append(row);
  }
  details.append(summary,list);
  return details;
}

let paymentRequest=null,selectedTopup=DEFAULT_TOPUP;
function topups() {
  const box=element('section',undefined,'wallet-topup');
  box.setAttribute('aria-label','Add credits');
  const amounts=element('div',undefined,'wallet-amounts');
  amounts.setAttribute('role','radiogroup');amounts.setAttribute('aria-label','Top-up amount');
  const primary=element('button',undefined,'wallet-primary');primary.type='button';primary.id='wallet-add';
  const reason=element('small','Paid by card through secure checkout.','wallet-reason');
  const choices=[];
  const select=cents=>{
    selectedTopup=cents;primary.textContent='Add '+usd(cents*10000).replace('.00','');
    for(const choice of choices){const on=Number(choice.dataset.cents)===cents;choice.setAttribute('aria-checked',String(on));choice.tabIndex=on?0:-1;}
  };
  for(const cents of TOPUPS) {
    const choice=element('button',usd(cents*10000).replace('.00',''),'wallet-amount');
    choice.type='button';choice.dataset.cents=String(cents);choice.setAttribute('role','radio');
    choice.addEventListener('click',()=>select(cents));
    choice.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
      event.preventDefault();const step=event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1;
      const next=TOPUPS[(TOPUPS.indexOf(selectedTopup)+step+TOPUPS.length)%TOPUPS.length];select(next);choices[TOPUPS.indexOf(next)].focus();
    });
    choices.push(choice);amounts.append(choice);
  }
  select(selectedTopup);
  primary.addEventListener('click',async()=>{
    const cents=selectedTopup;
    for(const node of [primary,...choices])node.disabled=true;
    primary.textContent='Opening checkout…';notice.textContent='';
    if(!paymentRequest || paymentRequest.amountCents!==cents)paymentRequest={amountCents:cents,id:crypto.randomUUID()};
    try {
      const result=await request('/wallet/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(paymentRequest)});
      const url=new URL(result.url);if(url.origin!=='https://checkout.stripe.com')throw new Error('Checkout could not be verified.');
      window.location.assign(url.href);
    } catch(error) {notice.textContent=error.message;for(const node of [primary,...choices])node.disabled=false;select(cents);}
  });
  box.append(amounts,primary,reason);
  return box;
}

function skeleton() {
  const wrap=element('div',undefined,'wallet-skeleton');
  const status=element('span','Loading your plan','sr-only');status.setAttribute('role','status');
  const balance=element('div',undefined,'wallet-balance');
  balance.append(skel('skel-text',{width:'72px',height:'11px'}),skel('skel-title',{width:'140px',height:'38px'}),skel('skel-text',{width:'180px',height:'12px'}));
  const actions=element('div',undefined,'wallet-topup');
  actions.append(skel('skel-button',{height:'40px'}),skel('skel-button',{height:'44px'}));
  const list=element('div',undefined,'wallet-skeleton-rows');
  for(let i=0;i<3;i++)list.append(skel('skel-text',{height:'40px'}));
  wrap.append(status,balance,actions,list);
  return wrap;
}

let loading=0,loaded=false;
async function refresh() {
  const generation=++loading;
  content.setAttribute('aria-busy','true');
  // Skeleton on the first load only; later refreshes keep the current figures until new ones land.
  if(!loaded)content.replaceChildren(skeleton());
  try {
    // The plan also tells the rest of the app whether this person is a beta tester.
    const planRequest=request('/plan').then(plan=>{window.dispatchEvent(new window.CustomEvent('acres:plan',{detail:plan}));return plan;});
    const [plan,wallet]=await Promise.all([planRequest,request('/wallet')]);if(generation!==loading)return;
    loaded=true;
    const summary=planSummary(plan);
    content.replaceChildren(...planSection(plan));
    // Prepaid credits show below the plan only where credit billing is turned on.
    if(!wallet.enabled)return void setBalance(summary.badge,summary.badge?summary.line:'');
    setBalance(usd(wallet.availableMicros),`${usd(wallet.availableMicros)} available`);
    const balance=element('div',undefined,'wallet-balance');
    const detail=wallet.heldMicros?`${usd(wallet.heldMicros)} held for research in progress`:`${usd(wallet.balanceMicros)} total balance`;
    balance.append(element('span','Available'),element('strong',usd(wallet.availableMicros)),element('small',detail));
    content.append(balance);
    if(wallet.blockedReason)content.append(element('p','Payments on this wallet are under review. New research and top-ups are paused.','wallet-warning'));
    else if(wallet.checkoutAvailable)content.append(topups());
    else content.append(element('p','Top-ups are not enabled yet.','wallet-status'));
    const priceDetails=pricing(wallet.policy);if(priceDetails)content.append(priceDetails);
    content.append(element('h3','Recent activity'));
    const rows=walletRows(wallet.entries||[]);
    if(!rows.length){content.append(element('p','No activity yet.','wallet-status'));return;}
    const list=element('ol',undefined,'wallet-transactions');
    for(const row of rows) {
      const item=element('li');
      const title=element('div',undefined,'wallet-transaction-title');
      title.append(element('strong',row.label),element('span',row.amount));
      item.append(title,element('small',[walletDate(row.at),row.note].filter(Boolean).join(' · ')));
      list.append(item);
    }
    content.append(list);
  } catch(error) {
    if(generation!==loading)return;
    setBalance(null,'');
    if(loaded)return void(notice.textContent=error.message);
    const failed=element('p',undefined,'wallet-error');failed.setAttribute('role','alert');
    const retry=element('button','Retry','wallet-retry');retry.type='button';retry.addEventListener('click',()=>{notice.textContent='';void refresh();});
    failed.append(element('span',error.message),retry);
    content.replaceChildren(failed);
  }
  finally {if(generation===loading)content.removeAttribute('aria-busy');}
}
button.addEventListener('click',()=>{notice.textContent='';dialog.showModal();void refresh();});
document.querySelector('#close-wallet').addEventListener('click',()=>dialog.close());
window.addEventListener('acres:wallet-refresh',()=>void refresh());
// A research request past the free allowance opens the plan with the reason.
window.addEventListener('acres:plan-limit',event=>{notice.textContent=event.detail?.message||'';if(!dialog.open)dialog.showModal();void refresh();});
const params=new URLSearchParams(window.location.search);
const RETURNS={
  wallet:{success:'Payment submitted. Credits appear once it is confirmed.',cancelled:'Checkout cancelled. No credits were added.'},
  plan:{success:'Welcome to Arosa Pro. Your plan updates as soon as the payment is confirmed.',cancelled:'Checkout cancelled. You have not been charged.',manage:''},
};
for(const [key,messages] of Object.entries(RETURNS)) {
  if(!params.has(key))continue;
  dialog.showModal();notice.textContent=messages[params.get(key)]??'';
  // Stripe confirms a new subscription a few seconds after checkout returns; look again until it shows.
  if(key==='plan'&&params.get(key)==='success')for(const delay of [3000,8000,15000])setTimeout(()=>void refresh(),delay);
  params.delete(key);history.replaceState(null,'',window.location.pathname+(params.size?'?'+params:'')+window.location.hash);
}
void refresh();
