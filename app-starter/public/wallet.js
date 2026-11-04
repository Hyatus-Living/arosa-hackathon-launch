import {publicErrorMessage} from './chat-api.js';
import {skel} from './skeleton.js';

const dialog=document.querySelector('#wallet-dialog');
const content=document.querySelector('#wallet-content');
const notice=document.querySelector('#wallet-notice');
const button=document.querySelector('#wallet-button');
function element(tag,text,className) {const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function setBalance(text,title) {
  const badge=document.querySelector('#wallet-balance');
  badge.textContent=text||'';badge.hidden=!text;
  button.title=title?`Daily usage · ${title}`:'Daily usage';
}
async function request(path,options={}) {
  const response=await fetch('/api'+path,{cache:'no-store',signal:AbortSignal.timeout(30000),...options}).catch(()=>{throw new Error(publicErrorMessage({},'Daily usage'));});
  if(response.status>=500&&!response.headers.get('content-type')?.includes('application/json'))throw new Error(publicErrorMessage({status:response.status},'Daily usage'));
  if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Sign in to Arosa to view your daily usage.');
  const data=await response.json();if(!response.ok)throw new Error(publicErrorMessage({status:response.status,message:data.error,userFacing:data.userFacing||(response.status>=400&&response.status<500),code:data.code},'Daily usage'));return data;
}
export function planSummary(plan) {
  const reset=new Date(plan.resetsAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:plan.timeZone,timeZoneName:'short'});
  return {name:'Free access',line:`${plan.remaining} of ${plan.limit} research requests left today`,detail:`Resets ${reset} (New York)`,badge:`${plan.remaining} left`};
}
function manage() {
  const action=element('button','Manage existing subscription','wallet-retry plan-manage');action.type='button';
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
  section.setAttribute('aria-label','Free daily access');
  section.append(element('span',summary.name),element('strong',summary.line,'plan-line'),element('small',summary.detail));
  const list=element('ul',undefined,'daily-usage-list');list.setAttribute('aria-label','Daily allowances');
  for(const [kind,usage] of Object.entries(plan.limits)) {
    const item=element('li');item.dataset.kind=kind;
    const row=element('div',undefined,'daily-usage-row');
    row.append(element('strong',usage.label),element('span',`${usage.remaining} of ${usage.limit} left`));
    const used=Math.min(usage.used,usage.limit),meter=element('div',undefined,'plan-meter');
    meter.setAttribute('role','progressbar');meter.setAttribute('aria-label',`${usage.label} used today`);
    meter.setAttribute('aria-valuemin','0');meter.setAttribute('aria-valuemax',String(usage.limit));meter.setAttribute('aria-valuenow',String(used));
    const fill=element('span');fill.style.width=`${usage.limit?Math.round(used/usage.limit*100):100}%`;
    if(usage.remaining===0)meter.classList.add('is-full');
    meter.append(fill);item.append(row,meter);list.append(item);
  }
  const note=element('p','Arosa is free to use. No card or payment needed. Daily allowances reset automatically at midnight in New York.','daily-usage-note');
  const saved=element('p','Sign-in saves your work and tracks your daily allowance. Browsing, editing saved work and downloading artifacts are unrestricted.','daily-usage-note');
  const source=element('a','View the MIT-licensed source','daily-usage-source');
  source.href='https://github.com/Hyatus-Living/arosa-hackathon-launch';source.target='_blank';source.rel='noopener noreferrer';
  return [section,list,note,saved,source,...(plan.manageable?[manage()]:[])];
}
function skeleton() {
  const wrap=element('div',undefined,'wallet-skeleton');
  const status=element('span','Loading daily usage','sr-only');status.setAttribute('role','status');
  wrap.append(status,skel('skel-title',{width:'75%',height:'30px'}));
  for(let i=0;i<4;i++)wrap.append(skel('skel-text',{height:'40px'}));
  return wrap;
}

let loading=0,loaded=false,resetTimer=null,limitKind=null;
async function refresh() {
  const generation=++loading;
  content.setAttribute('aria-busy','true');
  if(!loaded)content.replaceChildren(skeleton());
  try {
    const plan=await request('/plan');if(generation!==loading)return;
    loaded=true;
    window.dispatchEvent(new window.CustomEvent('acres:plan',{detail:plan}));
    content.replaceChildren(...planSection(plan));
    const summary=planSummary(plan);setBalance(summary.badge,summary.line);
    if(limitKind&&plan.limits[limitKind].remaining>0){limitKind=null;notice.textContent='';}
    clearTimeout(resetTimer);
    if(plan.resetsAt>Date.now())resetTimer=setTimeout(()=>void refresh(),plan.resetsAt-Date.now()+100);
  } catch(error) {
    if(generation!==loading)return;
    setBalance(null,'');
    if(loaded)return void(notice.textContent=error.message);
    const failed=element('p',undefined,'wallet-error');failed.setAttribute('role','alert');
    const retry=element('button','Retry','wallet-retry');retry.type='button';retry.addEventListener('click',()=>{notice.textContent='';void refresh();});
    failed.append(element('span',error.message),retry);content.replaceChildren(failed);
  } finally {if(generation===loading)content.removeAttribute('aria-busy');}
}
button.addEventListener('click',()=>{notice.textContent='';dialog.showModal();void refresh();});
document.querySelector('#close-wallet').addEventListener('click',()=>dialog.close());
window.addEventListener('acres:wallet-refresh',()=>void refresh());
window.addEventListener('acres:plan-limit',event=>{
  limitKind=event.detail?.kind||'research';notice.textContent=event.detail?.message||'';
  if(!dialog.open)dialog.showModal();void refresh();
});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();});
const params=new URLSearchParams(window.location.search);
if(params.get('plan')==='manage') {
  dialog.showModal();params.delete('plan');
  history.replaceState(null,'',window.location.pathname+(params.size?'?'+params:'')+window.location.hash);
}
void refresh();
