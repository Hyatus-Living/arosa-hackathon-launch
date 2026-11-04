import express from 'express';
import {isModelInputRequest,mountModelInputProxy} from './model-intake-proxy.mjs';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {authenticate,resolveAccount,isAdminEmail,isArchitectureEnabled} from './auth.js';
import {betaApplyAllowed} from './beta-apply.mjs';
import {optionPage,messagePage} from './share-view.mjs';
import compression from 'compression';
import {Wallet,FirestoreWalletRepository,BillingError} from '../acres-research/wallet.mjs';
import {createPayments} from './payments.mjs';
import {createSubscriptions,PRO_PRICES} from './subscriptions.mjs';
const billingEnabled=process.env.BILLING_ENABLED==='true';
const wallet=new Wallet(new FirestoreWalletRepository());
const payments=createPayments({wallet,secretKey:process.env.STRIPE_SECRET_KEY,webhookSecret:process.env.STRIPE_WEBHOOK_SECRET,live:process.env.STRIPE_LIVE==='true'});
const checkoutAvailable=billingEnabled && Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
// Arosa Pro subscriptions; their webhook records each change in the research service, which applies the free allowance.
const subscriptions=createSubscriptions({secretKey:process.env.STRIPE_SECRET_KEY,webhookSecret:process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET,live:process.env.STRIPE_LIVE==='true',
  prices:{month:process.env.STRIPE_PRICE_PRO_MONTHLY,year:process.env.STRIPE_PRICE_PRO_YEARLY},
  research:async(account,subscription)=>{
    const response=await fetch('http://10.42.0.2:18800/plan/subscription',{method:'PUT',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.RESEARCH_TOKEN}`,'x-acres-account':account},body:JSON.stringify(subscription),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new BillingError('The subscription could not be recorded.');
  }});
const app=express();
// Compress at the origin: Cloudflare compresses only toward the browser, so the tunnel otherwise carries API JSON raw.
// Event streams stay uncompressed so each event flushes as it arrives; other types use the default compressible check.
app.use(compression({filter:(req,res)=>!String(res.getHeader('Content-Type')).includes('text/event-stream')&&compression.filter(req,res)}));
// Payment delivery remains disabled unless the separately configured billing integration is enabled.
app.post('/api/payments/stripe/webhook',express.raw({type:'application/json',limit:'60kb'}),async(req,res)=>{
  if(!checkoutAvailable)return res.status(503).json({error:'Payments are not enabled.'});
  try{res.json(await payments.webhook(req.body,req.get('stripe-signature')));}
  catch(error){res.status(error.status||503).json({error:error.message});}
});
// Stripe's subscription events. Under /api/public, which Cloudflare Access lets through without sign-in;
// the Stripe signature authenticates each event.
app.post('/api/public/stripe/subscriptions',express.raw({type:'application/json',limit:'60kb'}),async(req,res)=>{
  try{res.json(await subscriptions.webhook(req.body,req.get('stripe-signature')));}
  catch(error){res.status(error.status||503).json({error:error.message});}
});
// Model files are parsed after authentication; plans accept 2 MB and other API bodies 60 KB.
const planJson=express.json({limit:'2100kb'}),defaultJson=express.json({limit:'60kb'});
app.use((req,res,next)=>isModelInputRequest(req)?next():(req.method==='PUT'&&/^\/api\/projects\/[^/]+\/architecture\/plan$/.test(req.path)?planJson:defaultJson)(req,res,next));
app.get('/healthz',(_req,res)=>res.json({ok:true}));
// Aggregate totals for the stats strip on witharosa.ai, which proxies this path. It is the only
// public API path: a path-scoped Cloudflare Access application bypasses sign-in for it.
app.get('/api/public/stats',async(_req,res)=>{
  try {
    const response=await fetch('http://10.42.0.2:18800/public-stats',{headers:{authorization:`Bearer ${process.env.RESEARCH_TOKEN}`},signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('Research stats are unavailable.');
    res.set('Cache-Control','public, max-age=60, s-maxage=300').json(await response.json());
  } catch {res.set('Cache-Control','no-store').status(503).json({error:'Stats are unavailable.'});}
});
// The stop link in alert emails, also under /api/public: the signed token is the authority. Opening
// the link shows a button, so mail scanners that prefetch links cannot stop an alert; mail apps
// use the one-click POST (RFC 8058) directly.
const unsubscribePage=(title,text,form='')=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #1d1d1f;background:#1d1d1f;color:#fff;cursor:pointer}</style></head><body><h1>${title}</h1><p>${text}</p>${form}</body></html>`;
app.get('/api/public/alerts/unsubscribe',(req,res)=>{
  const token=String(req.query.token||'');
  res.set('Cache-Control','no-store').type('html').send(unsubscribePage('Stop this Arosa alert','Stop sending these alert emails to you? You can turn alerts back on in chat by asking Arosa to show your alerts.',
    `<form method="post" action="/api/public/alerts/unsubscribe?token=${encodeURIComponent(token)}"><button type="submit">Stop alert emails</button></form>`));
});
app.post('/api/public/alerts/unsubscribe',express.urlencoded({extended:false,limit:'2kb'}),async(req,res)=>{
  res.set('Cache-Control','no-store');
  try {
    const response=await fetch('http://10.42.0.2:18800/alerts/unsubscribe',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.RESEARCH_TOKEN}`},body:JSON.stringify({token:String(req.query.token||'')}),signal:AbortSignal.timeout(10000)});
    if(response.status===404)return res.status(404).type('html').send(unsubscribePage('Link not recognized','This stop link is not valid. Ask Arosa in chat to show your alerts to manage them.'));
    if(!response.ok)throw new Error('Unsubscribe failed.');
    const {stopped}=await response.json();
    res.type('html').send(unsubscribePage('Alert stopped',stopped==='all'?'Arosa will not send you alert emails. Ask Arosa in chat to turn them back on.':stopped==='deleted'?'This alert was already removed and will not email you again.':'This alert is paused and will not email you again. Ask Arosa in chat to show your alerts to resume it.'));
  } catch {res.status(503).type('html').send(unsubscribePage('Try again shortly','Arosa could not stop this alert right now. Open the link again in a minute.'));}
});
// Applications from the beta page on witharosa.ai, which proxies this path. Like the stats strip, a
// path-scoped Cloudflare Access application bypasses sign-in for it. A filled hidden field marks a
// bot and is accepted without saving; each address may apply a few times an hour.
const betaApplyLog=new Map();
app.post('/api/public/beta-apply',express.json({limit:'8kb'}),async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(req.get('origin')!=='https://witharosa.ai')return res.status(403).json({error:'Apply from witharosa.ai/beta.'});
  if(req.body?.website)return res.json({ok:true});
  const client=String(req.get('x-forwarded-for')||req.get('cf-connecting-ip')||req.ip).split(',')[0].trim();
  if(!betaApplyAllowed(betaApplyLog,client))return res.status(429).json({error:'Too many applications from here. Try again in an hour.'});
  const {name,email,company,role,phone,focus}=req.body||{};
  try {
    const response=await fetch('http://10.42.0.2:18800/public/beta-applications',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.RESEARCH_TOKEN}`},body:JSON.stringify({name,email,company,role,phone,focus}),signal:AbortSignal.timeout(10000)});
    res.status(response.status).json(await response.json());
  } catch {res.status(503).json({error:'We could not send your application. Try again in a minute.'});}
});
// An option sent to an architect or contractor (share-view.mjs), under /api/public like the stats strip:
// a path-scoped Cloudflare Access application lets /api/public/options through without sign-in (see
// docs/arosa-cloudflare-cutover.md), and the link's token is the authority. The page sends no referrer,
// so the token stays out of the font and site requests it makes.
const researchBearer=()=>({authorization:`Bearer ${process.env.RESEARCH_TOKEN}`});
app.get('/api/public/options/:token',async(req,res)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex'});
  const token=encodeURIComponent(req.params.token);
  try {
    const response=await fetch(`http://10.42.0.2:18800/public/options/${token}`,{headers:researchBearer(),signal:AbortSignal.timeout(10000)});
    if(response.status===404)return res.status(404).type('html').send(messagePage('This link is not available','It may have been mistyped or withdrawn. Ask the person who sent it for a new one.'));
    if(!response.ok)throw new Error('The option could not be read.');
    res.type('html').send(optionPage(await response.json(),{files:`/api/public/options/${token}/files`}));
  } catch {res.status(503).type('html').send(messagePage('Try again shortly','Arosa could not open this option right now. Open the link again in a minute.'));}
});
app.get('/api/public/options/:token/files/:fileId',(req,res)=>{
  res.set('Referrer-Policy','no-referrer');
  return streamFile(req,res,`/public/options/${encodeURIComponent(req.params.token)}/files/${encodeURIComponent(req.params.fileId)}`,researchBearer());
});
app.use('/api',authenticate);
// The app lives at build.witharosa.ai and still answers on app.witharosa.ai; witharosa.ai is the public site. AROSA_APP_ORIGINS lists the origins that may call the API.
const appOrigins=new Set((process.env.AROSA_APP_ORIGINS||'https://build.witharosa.ai,https://app.witharosa.ai,https://witharosa.ai').split(','));
// The Map Tiles key is a browser key: restrict it to this app's origin and the Map Tiles API in Google Cloud.
function identityHeaders(req) {return {'authorization':`Bearer ${process.env.RESEARCH_TOKEN}`,'x-acres-account':req.account,...(req.email?{'x-acres-email':req.email}:{})};}
function requireAdmin(req,res,next) {
  if(!isAdminEmail(req.email))return res.status(403).json({error:'Admin access is required.'});
  next();
}
async function touchPerson(req) {
  try{await fetch('http://10.42.0.2:18800/people/me',{method:'POST',headers:{'content-type':'application/json',...identityHeaders(req)},body:JSON.stringify({}),signal:AbortSignal.timeout(5000)});}
  catch{/* The people directory is additive; a failed touch must not block sign-in. */}
}
app.get('/api/session',async(req,res)=>{void touchPerson(req);res.set('Cache-Control','no-store').json({namespace:req.account,email:req.email||null,isAdmin:isAdminEmail(req.email),architectureEnabled:isArchitectureEnabled(req.email),...(process.env.GOOGLE_MAP_TILES_API_KEY?{maps:{tilesKey:process.env.GOOGLE_MAP_TILES_API_KEY}}:{})});});
app.use('/api',(req,res,next)=>{
  const origin=req.get('origin');
  if(origin&&!appOrigins.has(origin))return res.status(403).json({error:'Please use the Arosa app to send messages.'});next();
});
async function billingPolicy(account,email) {
  const response=await fetch('http://10.42.0.2:18800/billing-policy',{headers:{authorization:`Bearer ${process.env['RESEARCH_TOKEN']}`,'x-acres-account':account,...(email?{'x-acres-email':email}:{})},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Research billing configuration is unavailable.');
  const policy=await response.json();
  if(!policy.enabled || !policy.ready)throw new Error('Research billing configuration is not ready.');
  return policy;
}
app.get('/api/wallet',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!billingEnabled)return res.json({enabled:false,checkoutAvailable:false,currency:'USD',entries:[]});
  try{
    const [snapshot,policy]=await Promise.all([wallet.snapshot(req.account),billingPolicy(req.account,req.email)]);
    // Each research charge is named by the conversation it ran in.
    const ids=[...new Set(snapshot.entries.map(entry=>entry.runId).filter(Boolean))];
    const titles=ids.length?(await (await fetch(`http://10.42.0.2:18800/run-titles?ids=${encodeURIComponent(ids.join(','))}`,{headers:identityHeaders(req),signal:AbortSignal.timeout(5000)})).json()).titles:{};
    res.json({...snapshot,entries:snapshot.entries.map(entry=>titles[entry.runId]?{...entry,conversationTitle:titles[entry.runId]}:entry),enabled:true,checkoutAvailable,policy});
  }
  catch(error){res.status(error.status||503).json({error:error.message});}
});
app.post('/api/wallet/checkout',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!checkoutAvailable)return res.status(503).json({error:'Credit top-ups are not enabled yet.'});
  try{await billingPolicy(req.account,req.email);res.json(await payments.checkout(req.account,req.body.amountCents,req.body.id));}
  catch(error){res.status(error.status||503).json({error:error.message});}
});
async function planStatus(req) {
  const response=await fetch('http://10.42.0.2:18800/plan',{headers:identityHeaders(req),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new BillingError('Your plan could not load.');
  return response.json();
}
app.get('/api/plan',async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{const {customer,...plan}=await planStatus(req);res.json({...plan,manageable:Boolean(customer),checkoutAvailable:subscriptions.available,prices:PRO_PRICES});}
  catch(error){res.status(error.status||503).json({error:error.message});}
});
app.post('/api/plan/checkout',async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
    const plan=await planStatus(req);
    if(!['free','beta'].includes(plan.plan))throw new BillingError('Your plan already includes unlimited research.',409);
    res.json(await subscriptions.checkout(req.account,req.email,req.body.interval,plan.customer,req.body.id));
  }catch(error){res.status(error.status||503).json({error:error.message});}
});
app.post('/api/plan/portal',async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{res.json(await subscriptions.portal((await planStatus(req)).customer));}
  catch(error){res.status(error.status||503).json({error:error.message});}
});
async function proxy(req,res,path,payload,cacheControl='no-store') {
  const requestId=randomUUID();res.set('Cache-Control',cacheControl);res.set('X-Request-ID',requestId);
  const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try {
    const upstream=await fetch(`http://10.42.0.2:18800${path}`,{method:req.method,headers:{'content-type':'application/json',...identityHeaders(req),'x-request-id':requestId},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(path.includes('/events')?600000:330000)])});
    res.status(upstream.status);res.set('Content-Type',upstream.headers.get('content-type')||'application/json');
    if(upstream.headers.get('content-type')?.includes('text/event-stream')) {res.set('X-Accel-Buffering','no');res.flushHeaders();const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.end());stream.pipe(res);}
    else res.send(await upstream.text());
  } catch(e) {
    console.error(JSON.stringify({event:'research_transport_failed',requestId,account:req.account,path,error:e.name,message:e.message}));
    if(!res.headersSent)res.status(502).json({error:'The research connection was interrupted. Reload to reconnect to your saved request.',requestId});else res.end();
  }
}
app.get('/api/street-view',async(req,res)=>{
  // A concept's Street View photo, fetched by the research host with its own key.
  const pano=String(req.query.pano||''),heading=Number(req.query.heading),fov=Number(req.query.fov||90);
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(pano)||!(heading>=0&&heading<=360)||!(fov>=40&&fov<=120))return res.status(400).json({error:'Unknown street photo.'});
  const query=new URLSearchParams({pano,heading:String(Math.round(heading)),fov:String(Math.round(fov))});
  try {
    const upstream=await fetch(`http://10.42.0.2:18800/street-view?${query}`,{headers:identityHeaders(req),signal:AbortSignal.timeout(20000)});
    if(!upstream.ok)return res.status(upstream.status===404?404:502).json({error:'The street photo is unavailable.'});
    res.status(200).set('Content-Type',upstream.headers.get('content-type')||'image/jpeg').set('Cache-Control','private, max-age=86400');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch(e) {
    console.error(JSON.stringify({event:'street_view_failed',account:req.account,error:e.name}));
    if(!res.headersSent)res.status(502).json({error:'The street photo is unavailable.'});
  }
});
app.all('/api/conversations',(req,res)=>proxy(req,res,`/conversations${req.url.includes('?')?req.url.slice(req.url.indexOf('?')):''}`,req.method==='POST'?(typeof req.body?.projectId==='string'?{projectId:req.body.projectId}:req.body?.bbl!==undefined?{bbl:req.body.bbl}:{}):null));
app.all('/api/conversations/:id',(req,res)=>proxy(req,res,`/conversations/${req.params.id}`));
app.get('/api/conversations/:id/deck',(req,res)=>proxy(req,res,`/conversations/${encodeURIComponent(req.params.id)}/deck${querySuffix(req)}`));
app.post('/api/conversations/:id/runs',(req,res)=>proxy(req,res,`/conversations/${req.params.id}/runs`,{message:req.body.message,id:req.body.id,...(req.body.listingFilters?{listingFilters:req.body.listingFilters}:{})}));
app.get('/api/listing-investigations/policy',(req,res)=>proxy(req,res,'/listing-investigations/policy'));
app.get('/api/listing-investigations',(req,res)=>proxy(req,res,`/listing-investigations?listingId=${encodeURIComponent(req.query.listingId||'')}`));
app.post('/api/listing-investigations',(req,res)=>proxy(req,res,'/listing-investigations',{id:req.body.id,listingId:req.body.listingId,depth:req.body.depth,objective:req.body.objective,question:req.body.question,projectId:req.body.projectId}));
app.get('/api/listing-investigations/:id',(req,res)=>proxy(req,res,`/listing-investigations/${encodeURIComponent(req.params.id)}`));
app.get('/api/listing-investigations/:id/events',(req,res)=>proxy(req,res,`/listing-investigations/${encodeURIComponent(req.params.id)}/events?after=${encodeURIComponent(req.get('last-event-id')||req.query.after||0)}`));
app.post('/api/listing-investigations/:id/cancel',(req,res)=>proxy(req,res,`/listing-investigations/${encodeURIComponent(req.params.id)}/cancel`,{}));
app.post('/api/listing-investigations/:id/resume',(req,res)=>proxy(req,res,`/listing-investigations/${encodeURIComponent(req.params.id)}/resume`,{}));
app.get('/api/runs',(req,res)=>proxy(req,res,'/runs'));
app.get('/api/runs/:id',(req,res)=>proxy(req,res,`/runs/${req.params.id}`));
app.get('/api/listing-investigations/policy',(req,res)=>proxy(req,res,'/listing-investigations/policy'));
app.get('/api/listing-investigations',(req,res)=>proxy(req,res,`/listing-investigations?listingId=${encodeURIComponent(req.query.listingId||'')}`));
app.post('/api/listing-investigations',(req,res)=>proxy(req,res,'/listing-investigations',{id:req.body.id,listingId:req.body.listingId,depth:req.body.depth,objective:req.body.objective,question:req.body.question,projectId:req.body.projectId}));
app.get('/api/listing-investigations/:id',(req,res)=>proxy(req,res,`/listing-investigations/${encodeURIComponent(req.params.id)}`));
app.get('/api/listing-investigations/:id/events',(req,res)=>proxy(req,res,`/listing-investigations/${encodeURIComponent(req.params.id)}/events?after=${encodeURIComponent(req.get('last-event-id')||req.query.after||0)}`));
app.post('/api/listing-investigations/:id/cancel',(req,res)=>proxy(req,res,`/listing-investigations/${encodeURIComponent(req.params.id)}/cancel`,{}));
app.post('/api/listing-investigations/:id/resume',(req,res)=>proxy(req,res,`/listing-investigations/${encodeURIComponent(req.params.id)}/resume`,{}));
app.get('/api/runs/:id/status',(req,res)=>proxy(req,res,`/runs/${req.params.id}/status`));
app.get('/api/runs/:id/events',(req,res)=>proxy(req,res,`/runs/${req.params.id}/events?after=${encodeURIComponent(req.get('last-event-id')||req.query.after||0)}`));
app.post('/api/runs/:id/:action',(req,res)=>proxy(req,res,`/runs/${req.params.id}/${req.params.action}`,{message:req.body.message}));
function querySuffix(req) {return req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'';}
function resolveInvitee(body) {
  if(!body||typeof body!=='object')return body;
  if(typeof body.email==='string'&&body.email.trim()&&!body.teamId) {
    const email=body.email.trim().toLowerCase();
    return {...body,email,account:body.account||resolveAccount(email)};
  }
  return body;
}
function forwardBody(req) {return ['POST','PATCH','PUT'].includes(req.method)?(req.body||{}):null;}
app.all('/api/conversations/:id/members',(req,res)=>proxy(req,res,`/conversations/${encodeURIComponent(req.params.id)}/members`,req.method==='POST'?resolveInvitee(req.body||{}):forwardBody(req)));
app.all('/api/conversations/:id/members/:principalType/:principal',(req,res)=>proxy(req,res,`/conversations/${encodeURIComponent(req.params.id)}/members/${encodeURIComponent(req.params.principalType)}/${encodeURIComponent(req.params.principal)}`,forwardBody(req)));
app.all('/api/conversations/:id/links',(req,res)=>proxy(req,res,`/conversations/${encodeURIComponent(req.params.id)}/links`,forwardBody(req)));
app.all('/api/conversations/:id/links/:token',(req,res)=>proxy(req,res,`/conversations/${encodeURIComponent(req.params.id)}/links/${encodeURIComponent(req.params.token)}`,forwardBody(req)));
app.get('/api/shared/:token',(req,res)=>proxy(req,res,`/shared/${encodeURIComponent(req.params.token)}`));
app.all('/api/teams',(req,res)=>proxy(req,res,`/teams${querySuffix(req)}`,forwardBody(req)));
app.all('/api/teams/:id',(req,res)=>proxy(req,res,`/teams/${encodeURIComponent(req.params.id)}`,forwardBody(req)));
app.all('/api/teams/:id/members',(req,res)=>proxy(req,res,`/teams/${encodeURIComponent(req.params.id)}/members`,req.method==='POST'?resolveInvitee(req.body||{}):forwardBody(req)));
app.all('/api/teams/:id/members/:account',(req,res)=>proxy(req,res,`/teams/${encodeURIComponent(req.params.id)}/members/${encodeURIComponent(req.params.account)}`,forwardBody(req)));
app.get('/api/people',(req,res)=>{
  if(!isAdminEmail(req.email)&&!String(req.email||'').toLowerCase().endsWith('@witharosa.ai'))return res.json({people:[]});
  return proxy(req,res,`/people${querySuffix(req)}`);
});
app.post('/api/people/me',(req,res)=>proxy(req,res,'/people/me',req.body||{}));
app.get('/api/projects',(req,res)=>proxy(req,res,`/projects${querySuffix(req)}`));
app.post('/api/projects',(req,res)=>proxy(req,res,'/projects',req.body||{}));
app.get('/api/projects/:id/state',(req,res)=>proxy(req,res,`/projects/${encodeURIComponent(req.params.id)}/state`));
app.get('/api/projects/:id/schemes',(req,res)=>proxy(req,res,`/projects/${encodeURIComponent(req.params.id)}/schemes`));
app.post('/api/projects/:id/schemes/:schemeId/send',(req,res)=>proxy(req,res,`/projects/${encodeURIComponent(req.params.id)}/schemes/${encodeURIComponent(req.params.schemeId)}/send`,{}));
app.delete('/api/projects/:id/schemes/:schemeId/send',(req,res)=>proxy(req,res,`/projects/${encodeURIComponent(req.params.id)}/schemes/${encodeURIComponent(req.params.schemeId)}/send`));
app.post('/api/projects/:id/schemes/:schemeId/render',(req,res)=>proxy(req,res,`/projects/${encodeURIComponent(req.params.id)}/schemes/${encodeURIComponent(req.params.schemeId)}/render`,{}));
app.patch('/api/projects/:id/state',(req,res)=>proxy(req,res,`/projects/${encodeURIComponent(req.params.id)}/state`,{version:req.body.version,fields:req.body.fields}));
app.patch('/api/projects/:id/name',(req,res)=>proxy(req,res,`/projects/${encodeURIComponent(req.params.id)}/name`,{version:req.body.version,title:req.body.title}));
// EventSource reconnects send Last-Event-ID; passing it on as the cursor resumes instead of replaying history.
app.get('/api/projects/:id/events',(req,res)=>{
  const after=req.get('last-event-id')||req.query.after;
  return proxy(req,res,`/projects/${encodeURIComponent(req.params.id)}/events${after?`?after=${encodeURIComponent(after)}`:''}`);
});
const architecturePath=(req,...rest)=>[`/projects/${encodeURIComponent(req.params.id)}/architecture`,...rest.map(encodeURIComponent)].join('/');
// Each scheme has its own plan; the research service checks the scheme name.
const schemeQuery=req=>typeof req.query.scheme==='string'?`?scheme=${encodeURIComponent(req.query.scheme)}`:'';
app.get('/api/projects/:id/architecture',(req,res)=>proxy(req,res,architecturePath(req)+schemeQuery(req)));
mountModelInputProxy(app,proxy);
app.put('/api/projects/:id/architecture/plan',(req,res)=>proxy(req,res,architecturePath(req,'plan'),{parentRevision:req.body.parentRevision,plan:req.body.plan,scheme:req.body.scheme}));
app.get('/api/projects/:id/architecture/revisions/:revision',(req,res)=>proxy(req,res,architecturePath(req,'revisions',req.params.revision)+schemeQuery(req)));
app.post('/api/projects/:id/architecture/jobs',(req,res)=>proxy(req,res,architecturePath(req,'jobs'),{revision:req.body.revision,settings:req.body.settings,scheme:req.body.scheme}));
app.get('/api/projects/:id/architecture/schemes/draft',(req,res)=>proxy(req,res,architecturePath(req,'schemes','draft')));
app.post('/api/projects/:id/architecture/schemes/draft',(req,res)=>proxy(req,res,architecturePath(req,'schemes','draft'),{}));
app.get('/api/projects/:id/architecture/jobs/:jobId',(req,res)=>proxy(req,res,architecturePath(req,'jobs',req.params.jobId)));
app.post('/api/projects/:id/architecture/jobs/:jobId/cancel',(req,res)=>proxy(req,res,architecturePath(req,'jobs',req.params.jobId,'cancel'),{}));
// Artifact files (GLB, IFC, SVG, preview, manifest) and drawings stream through with their type and ETag.
const artifactHeaders=['content-type','content-length','etag','content-disposition','content-security-policy','x-content-type-options','x-architecture-revision'];
async function streamFile(req,res,path,headers=identityHeaders(req)) {
  const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try {
    const upstream=await fetch(`http://10.42.0.2:18800${path}`,{headers:{...headers,...(req.get('if-none-match')?{'if-none-match':req.get('if-none-match')}:{})},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(330000)])});
    res.status(upstream.status).set('Cache-Control','private, no-cache');
    for(const name of artifactHeaders)if(upstream.headers.get(name))res.set(name,upstream.headers.get(name));
    if(!upstream.body||upstream.status===304)return res.end();
    const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.end());stream.pipe(res);
  } catch(e) {
    console.error(JSON.stringify({event:'architecture_artifact_failed',account:req.account,path,error:e.name}));
    if(!res.headersSent)res.status(502).json({error:'The file is unavailable.'});else res.end();
  }
}
app.get('/api/projects/:id/architecture/artifacts/:artifactId',(req,res)=>streamFile(req,res,architecturePath(req,'artifacts',req.params.artifactId)));
// Drawings: JSON {url,name} is parsed by the global JSON parser and proxied; any other body is the
// file itself, which the JSON parser leaves unread, streamed to the research host up to 25 MB.
const drawingLimit=25*1024*1024;
app.post('/api/projects/:id/architecture/drawings',async(req,res)=>{
  const path=architecturePath(req,'drawings');
  if(req.is('application/json'))return proxy(req,res,path,{url:req.body.url,name:req.body.name});
  const length=Number(req.get('content-length'));
  if(!(length>0))return res.status(411).json({error:'Choose a drawing file to upload.'});
  if(length>drawingLimit)return res.status(413).json({error:'Drawings can be up to 25 MB.'});
  const requestId=randomUUID();res.set('Cache-Control','no-store');res.set('X-Request-ID',requestId);
  const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try {
    // 600 s leaves room for 25 MB on a slow link; a browser that goes away aborts the upstream upload.
    const upstream=await fetch(`http://10.42.0.2:18800${path}`,{method:'POST',headers:{'content-type':req.get('content-type')||'application/octet-stream','content-length':String(length),...(req.get('x-drawing-name')?{'x-drawing-name':req.get('x-drawing-name')}:{}),...identityHeaders(req),'x-request-id':requestId},body:Readable.toWeb(req),duplex:'half',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(600000)])});
    res.status(upstream.status).set('Content-Type',upstream.headers.get('content-type')||'application/json').send(await upstream.text());
  } catch(e) {
    console.error(JSON.stringify({event:'architecture_drawing_upload_failed',requestId,account:req.account,path,error:e.name}));
    if(!res.headersSent)res.status(502).json({error:'The drawing could not be uploaded. Try again.',requestId});
  }
});
app.get('/api/projects/:id/architecture/drawings',(req,res)=>proxy(req,res,architecturePath(req,'drawings')));
app.get('/api/projects/:id/architecture/drawings/:drawingId',(req,res)=>streamFile(req,res,architecturePath(req,'drawings',req.params.drawingId)));
app.get('/api/news/lots/:bbl',(req,res)=>proxy(req,res,`/news/lots/${encodeURIComponent(req.params.bbl)}`));
app.get('/api/nearby-pipeline',(req,res)=>proxy(req,res,`/nearby-pipeline${querySuffix(req)}`));
app.get('/api/market-store/status',(req,res)=>proxy(req,res,'/market-store/status'));
app.get('/api/market-store/deals',(req,res)=>proxy(req,res,`/market-store/deals${querySuffix(req)}`));
// Map pins run to about 200 KB compressed and change only when the store does, so the browser keeps them and
// revalidates: an unchanged body answers 304 from Express's ETag instead of crossing the tunnel again.
app.get('/api/market-store/deals/pins',(req,res)=>proxy(req,res,`/market-store/deals/pins${querySuffix(req)}`,undefined,'private, no-cache'));
app.get('/api/market-store/deals/:id',(req,res)=>proxy(req,res,`/market-store/deals/${encodeURIComponent(req.params.id)}${querySuffix(req)}`));
app.get('/api/market-store/user-settings',(req,res)=>proxy(req,res,'/market-store/user-settings'));
app.get('/api/market-store/saved-searches',(req,res)=>proxy(req,res,'/market-store/saved-searches'));
app.post('/api/market-store/saved-searches',(req,res)=>proxy(req,res,'/market-store/saved-searches',{name:req.body.name,search:req.body.search}));
app.patch('/api/market-store/saved-searches/:id',(req,res)=>proxy(req,res,`/market-store/saved-searches/${encodeURIComponent(req.params.id)}`,{name:req.body.name}));
app.delete('/api/market-store/saved-searches/:id',(req,res)=>proxy(req,res,`/market-store/saved-searches/${encodeURIComponent(req.params.id)}`));
app.put('/api/market-store/user-settings',(req,res)=>proxy(req,res,'/market-store/user-settings',req.body||{}));
app.get('/api/admin/crm',requireAdmin,(req,res)=>proxy(req,res,'/admin/crm'));
app.post('/api/admin/crm/import',requireAdmin,(req,res)=>proxy(req,res,'/admin/crm/import',req.body||{}));
app.patch('/api/admin/crm/:id',requireAdmin,(req,res)=>proxy(req,res,`/admin/crm/${encodeURIComponent(req.params.id)}`,req.body||{}));
app.post('/api/admin/crm/:id/touches',requireAdmin,(req,res)=>proxy(req,res,`/admin/crm/${encodeURIComponent(req.params.id)}/touches`,req.body||{}));
app.get('/api/admin/crm/enrich/plan',requireAdmin,(req,res)=>proxy(req,res,'/admin/crm/enrich/plan'));
app.post('/api/admin/crm/enrich',requireAdmin,(req,res)=>proxy(req,res,'/admin/crm/enrich',{capUsd:req.body?.capUsd}));
app.post('/api/admin/crm/:id/enrich',requireAdmin,(req,res)=>proxy(req,res,`/admin/crm/${encodeURIComponent(req.params.id)}/enrich`,{action:req.body?.action}));
app.get('/api/admin/beta-testers',requireAdmin,(req,res)=>proxy(req,res,'/admin/beta-testers'));
app.post('/api/admin/beta-testers',requireAdmin,(req,res)=>proxy(req,res,'/admin/beta-testers',{email:req.body.email}));
app.delete('/api/admin/beta-testers/:email',requireAdmin,(req,res)=>proxy(req,res,`/admin/beta-testers/${encodeURIComponent(req.params.email)}`));
app.get('/api/admin/feedback',requireAdmin,(req,res)=>proxy(req,res,'/admin/feedback'));
app.get('/api/admin/feedback/:id',requireAdmin,(req,res)=>proxy(req,res,`/admin/feedback/${encodeURIComponent(req.params.id)}`));
// Beta feedback conversations; the research service checks that the sender is a beta tester.
app.post('/api/feedback',(req,res)=>proxy(req,res,'/feedback',{text:req.body.text,page:req.body.page,context:req.body.context}));
app.post('/api/feedback/:id/messages',(req,res)=>proxy(req,res,`/feedback/${encodeURIComponent(req.params.id)}/messages`,{text:req.body.text}));
app.post('/api/feedback/:id/finish',(req,res)=>proxy(req,res,`/feedback/${encodeURIComponent(req.params.id)}/finish`,{}));
app.get('/api/admin/market-store',requireAdmin,(req,res)=>proxy(req,res,'/admin/market-store'));
app.put('/api/admin/market-store/config',requireAdmin,(req,res)=>proxy(req,res,'/admin/market-store/config',req.body||{}));
app.post('/api/admin/market-store/sync',requireAdmin,(req,res)=>proxy(req,res,'/admin/market-store/sync',req.body||{}));
app.post('/api/admin/market-store/revalue',requireAdmin,(req,res)=>proxy(req,res,'/admin/market-store/revalue',req.body||{}));
app.post('/api/chat',(_req,res)=>res.status(410).json({error:'This version of Arosa has been updated. Reload the page to continue.'}));
app.get(['/modeling','/modeling/:projectId','/chat','/whats-new','/listings/:listingId','/shared/:token','/sites','/sites/:projectId','/sites/:projectId/plan','/sites/:projectId/report','/core','/core/:projectId','/core/:projectId/plan'],(_req,res)=>res.sendFile('index.html',{root:'public'}));
// Content-hashed files (the bundled shell under assets/ and the generated views' chunks) never change
// under their name, so browsers keep them. Every other file revalidates on each load (a 304 when
// unchanged), so a deploy reaches browsers at once; no-cache passes through Cloudflare unchanged.
const hashedFile=/[/\\](?:assets[/\\][^/\\]+|genui[/\\][^/\\]+-[A-Z0-9]{8}\.(?:js|css))$/;
// A malformed percent-encoding in an app link fails param decoding before its route runs; the app still loads
// and its router reads the link. API paths keep their error.
app.use((err,req,res,next)=>err instanceof URIError&&req.method==='GET'&&!req.path.startsWith('/api/')?res.sendFile('index.html',{root:'public'}):next(err));
app.use(express.static('public',{setHeaders:(res,path)=>res.set('Cache-Control',hashedFile.test(path)?'public, max-age=31536000, immutable':'no-cache')}));const host=process.env.HOST||'0.0.0.0';const server=app.listen(process.env.PORT||8080,host,()=>console.log(`Listening on http://${host}:${server.address().port}`));
