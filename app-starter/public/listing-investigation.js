import {chatRequest,postChat} from './chat-api.js';
import {marked} from './vendor/marked.esm.js';
import {skel} from './skeleton.js';

const terminal=new Set(['completed','failed','cancelled','needs_attention']);
const labels={queued:'Queued',preparing:'Checking property records',creating:'Starting research',in_progress:'Researching the listing',reviewing:'Checking evidence',cancelling:'Stopping research',cancelled:'Research stopped',completed:'Research complete',failed:'Research could not finish',needs_attention:'Research needs attention'};
const objectives=['acquisition screening','redevelopment','rental hold','renovation/resale','assemblage'];
// What each objective makes the research look for first, as the investigation prompt prioritizes it.
export const OBJECTIVE_NOTES={
  'acquisition screening':'Material problems with the site, and the other uses the evidence supports.',
  redevelopment:'How much can legally be built, earlier plans and permits, development rights and who occupies the building.',
  'rental hold':'Verified income, rent regulation, taxes and the capital work the building needs.',
  'renovation/resale':'The legal layout, the work that is permitted, and closed sales of comparable properties.',
  assemblage:'Who owns the neighboring lots, how they adjoin, and the rights that could be combined.',
};
let currentClose=null;
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function button(text,action){const node=el('button','home-follow',text);node.type='button';node.addEventListener('click',action);return node;}
function field(label,node){const wrap=el('label','investigation-field');wrap.append(el('span','',label),node);return wrap;}
// Saved investigations while they load: the status line and two history rows in their places.
function historySkeleton(){const box=el('div','investigation-skeleton');box.setAttribute('aria-hidden','true');box.append(skel('skel-block',{height:'46px'}),skel('skel-text',{width:'30%',marginTop:'8px'}),skel('skel-button',{width:'min(320px,80%)'}),skel('skel-button',{width:'min(280px,70%)'}));return box;}

// Render only document structure. HTML, images and arbitrary model-supplied links stay inert.
function appendResearchMarkdown(parent,tokens,sources){
  for(const token of tokens){
    let node;
    if(token.type==='space')continue;
    if(token.type==='table'){
      node=el('table');const head=el('thead'),body=el('tbody'),row=el('tr');
      for(const cell of token.header){const th=el('th');appendResearchMarkdown(th,cell.tokens,sources);row.append(th);}head.append(row);
      for(const cells of token.rows){const tr=el('tr');for(const cell of cells){const td=el('td');appendResearchMarkdown(td,cell.tokens,sources);tr.append(td);}body.append(tr);}
      node.append(head,body);
    }else if(token.type==='list'){
      node=el(token.ordered?'ol':'ul');for(const item of token.items){const li=el('li');appendResearchMarkdown(li,item.tokens,sources);node.append(li);}
    }else if(token.tokens){
      const tags={heading:'h3',paragraph:'p',text:'span',strong:'strong',em:'em',del:'s',blockquote:'blockquote',link:'span'};
      node=el(tags[token.type]||'span');appendResearchMarkdown(node,token.tokens,sources);
    }else if(token.type==='text'){
      node=el('span');let offset=0;
      for(const match of token.text.matchAll(/\[(\d+)\]/g)){
        node.append(document.createTextNode(token.text.slice(offset,match.index)));
        const source=sources.get(Number(match[1]));
        if(source){const link=el('a','',match[0]);link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';node.append(link);}
        else node.append(document.createTextNode(match[0]));offset=match.index+match[0].length;
      }
      node.append(document.createTextNode(token.text.slice(offset)));
    }else node=el(token.type==='code'?'pre':token.type==='codespan'?'code':token.type==='br'?'br':'span','',token.text||token.raw||'');
    parent.append(node);
  }
}

export function researchReportView(result){
  const root=el('div','investigation-report');
  root.append(el('p','investigation-notice','Automated research findings. Check the linked records before relying on ownership, legal or financial conclusions.'));
  if(result.unresolvedCitationCount)root.append(el('p','investigation-notice','Some source references could not be linked and are marked unavailable. Verify those claims before relying on them.'));
  // Source content is always text. Neither HTML nor model-supplied scripts are executed.
  const text=el('div','investigation-report-text'),sources=el('ol','investigation-sources'),safeSources=new Map();
  for(const source of result.sources){
    let url;try{url=new URL(source.url);}catch{continue;}
    if(url.protocol!=='https:'||url.username||url.password)continue;
    safeSources.set(source.id,{...source,url:url.href});
    const item=el('li'),link=el('a','',source.title||`Source ${source.id}`);link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';item.value=source.id;item.append(link);sources.append(item);
  }
  appendResearchMarkdown(text,marked.lexer(result.answer),safeSources);
  root.append(text,el('h3','','Sources'),sources);return root;
}

export function createListingInvestigation(deal,{request=chatRequest,post=postChat,streamFactory=url=>new EventSource(url)}={}){
  const dialog=el('dialog','listing-investigation'),focusBefore=document.activeElement;
  const listingId=String(deal.listing_id||deal.id),heading=el('h2','','Investigate listing');heading.id='investigation-heading';dialog.setAttribute('aria-labelledby',heading.id);
  let stream=null,closed=false,policy=null,selected=null,requestId=null,submitting=false,activeJob=null;
  const historyEntries=new Map(),historyLabel=job=>`${job.depth==='max'?'Max':'Standard'} · ${new Date(job.created).toLocaleDateString()} · ${labels[job.status]||job.status}`;
  const close=()=>{closed=true;stream?.close();dialog.close?.();dialog.remove();focusBefore?.focus?.();};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const closeButton=button('Close',close);closeButton.classList.add('investigation-close');
  const head=el('div','investigation-head'),titles=el('div');titles.append(heading,el('p','investigation-subtitle',deal.address||`BBL ${deal.bbl}`));head.append(titles,closeButton);
  const form=el('form','investigation-form'),depth=el('select'),objective=el('select'),question=el('textarea');
  depth.name='depth';for(const [value,label] of [['standard','Standard'],['max','Max, deeper investigation']]){const option=el('option','',label);option.value=value;if(value==='standard')option.setAttribute('selected','');depth.append(option);}
  objective.name='objective';for(const value of objectives){const option=el('option','',value[0].toUpperCase()+value.slice(1));option.value=value;if(value===objectives[0])option.setAttribute('selected','');objective.append(option);}
  question.name='question';question.maxLength=1000;question.rows=3;question.placeholder='For example: Who manages the owner LLC, and what happened to the previous development application?';
  const objectiveField=field('Investment objective',objective),objectiveNote=el('small','investigation-note',OBJECTIVE_NOTES[objective.value]);
  objectiveNote.id='investigation-objective-note';objective.setAttribute('aria-describedby',objectiveNote.id);objectiveField.append(objectiveNote);
  objective.addEventListener('change',()=>{objectiveNote.textContent=OBJECTIVE_NOTES[objective.value];});
  form.append(field('Research depth',depth),objectiveField,field('Specific question (optional)',question));
  // One action, with what it costs and that it keeps running in the background beside it.
  const pricing=el('p','investigation-pricing'),start=el('button','home-follow primary','Start investigation');start.type='submit';start.disabled=true;
  const startRow=el('div','investigation-start');startRow.append(start,pricing);form.append(startRow);
  const status=el('p','investigation-status sr-only','Loading saved investigations…');status.setAttribute('role','status');
  const controls=el('div','investigation-controls'),history=el('div','investigation-history'),report=el('div');
  const setup=el('details','investigation-setup'),setupTitle=el('summary','','New investigation');
  setup.setAttribute('open','');setup.append(setupTitle,form);
  const loading=historySkeleton();
  // Findings first: a completed report sits right under its status line, above controls and saved history.
  dialog.append(head,setup,status,loading,report,controls,history);
  const availability=()=>{
    const mode=policy?.modes[depth.value];start.disabled=submitting||!mode?.enabled||Boolean(activeJob);
    if(!policy)return;
    pricing.textContent=!mode?.enabled?'This research depth is not available right now.':policy.billed?`$${(mode.chargeMicros/1e6).toFixed(2)} once research starts, even if stopped; $${(mode.reserveMicros/1e6).toFixed(2)} held first. Keeps running if you close this.`:'Takes several minutes and keeps running if you close this.';
  };
  depth.addEventListener('change',availability);form.addEventListener('input',()=>{if(!submitting)requestId=null;});
  const display=job=>{
    if(closed)return;selected=job;
    const entry=historyEntries.get(job.id);if(entry){entry.job=job;entry.button.textContent=historyLabel(job);}
    if(!['completed','failed','cancelled'].includes(job.status))activeJob=job;else if(activeJob?.id===job.id)activeJob=null;
    status.classList.remove('sr-only');
    status.textContent=`${labels[job.status]||job.status} · ${job.depth==='max'?'Max':'Standard'} · ${new Date(job.created).toLocaleString()}${job.error?` · ${job.error}`:''}`;
    controls.replaceChildren();report.replaceChildren();
    if(job.result){report.append(researchReportView(job.result));setup.removeAttribute('open');}
    // Reconnecting is the way forward when research needs attention; stopping is always the quiet choice.
    if(job.status==='needs_attention'){const reconnect=button('Reconnect to research',async()=>{
      try{const resumed=await post(`/listing-investigations/${job.id}/resume`,{});display(resumed);watch(resumed);}catch(error){status.textContent=error.message;}
    });reconnect.classList.add('primary');controls.append(reconnect);}
    if(!terminal.has(job.status)||job.canCancel){const stop=button('Stop research',async()=>{
      stop.disabled=true;stop.textContent='Stopping…';
      try{const stopping=await post(`/listing-investigations/${job.id}/cancel`,{});display(stopping);watch(stopping);}catch(error){status.textContent=error.message;stop.disabled=false;stop.textContent='Stop research';}
    });stop.className='investigation-quiet';controls.append(stop);}
    availability();
  };
  const watch=job=>{
    stream?.close();if(terminal.has(job.status)||closed)return;
    let cursor=job.eventSeq||0;
    stream=streamFactory(`/api/listing-investigations/${job.id}/events?after=${cursor}`);
    stream.onmessage=event=>{const update=JSON.parse(event.data);if(update.seq<=cursor)return;cursor=update.seq;display(update.job);if(terminal.has(update.job.status))stream.close();};
    stream.onerror=()=>{if(!closed&&!terminal.has(selected?.status))status.textContent='Reconnecting to your saved investigation…';};
  };
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(start.disabled)return;
    submitting=true;requestId??=crypto.randomUUID();availability();start.textContent='Starting…';
    try{
      const job=await post('/listing-investigations',{id:requestId,listingId,depth:depth.value,objective:objective.value,question:question.value.trim()});
      requestId=null;display(job);watch(job);
    }catch(error){if(!closed)status.textContent=error.message;}
    finally{submitting=false;start.textContent='Start investigation';availability();}
  });
  // A failed load says so on one line with Try again, which loads both again.
  const load=()=>Promise.all([request('/listing-investigations/policy'),request(`/listing-investigations?listingId=${encodeURIComponent(listingId)}`)]).then(([config,saved])=>{
    if(closed)return;policy=config;loading.remove();
    activeJob=saved.investigations.find(job=>!['completed','failed','cancelled'].includes(job.status))||null;
    if(saved.investigations.length){
      history.append(el('h3','','Saved investigations'));
      for(const job of saved.investigations){const entry={job};entry.button=button(historyLabel(job),()=>{display(entry.job);watch(entry.job);});historyEntries.set(job.id,entry);history.append(entry.button);}
      // Findings first: a running investigation leads, else the newest completed report (the list is
      // newest first), so a failed retry never hides the report already on file.
      const latest=activeJob||saved.investigations.find(job=>job.status==='completed')||saved.investigations[0];display(latest);watch(latest);
    }else{status.textContent='No saved investigation for this listing.';status.classList.remove('sr-only');}
    availability();
  }).catch(error=>{
    if(closed)return;loading.remove();status.textContent='';
    const failed=el('div','retry-line'),reason=el('span','',error.message);reason.setAttribute('role','alert');
    const retry=el('button','retry-line-action','Try again');retry.type='button';
    retry.addEventListener('click',()=>{failed.replaceWith(loading);status.textContent='Loading saved investigations…';load();});
    failed.append(reason,retry);status.after(failed);
  });
  const ready=load();
  return {dialog,close,ready};
}

export function showListingInvestigation(deal){
  currentClose?.();const panel=createListingInvestigation(deal);currentClose=panel.close;
  document.body.append(panel.dialog);panel.dialog.showModal();return panel;
}
