// Fixture for the floor plan page inside the full app shell: serves the real index.html for every
// client route with in-memory stand-ins for the session, the project conversation, the project state,
// the architecture plan, drawings and the project event stream, plus a ten-listing deal feed with its
// map pins, the saved site fx-plan, three conversations (one on fx-plan, one shared by a teammate
// through /shared/fx-shared-link), a team and a plan, so every page and dialog has content and the
// sharing and team actions work.
// Run `npm run build` in app-starter first, then `node tests/plan-page-fixture/server.mjs` and open
// /sites/fx-plan/plan. Set ARCHITECTURE=off to check that the plan route falls back to the site page,
// and ADMIN=1 to sign in as an admin.
// Like the research service, the event stream replays the project's history after the cursor
// (?after or Last-Event-ID) on every connect, and drawing names are normalised.
// Sending an option makes a link like the research service's; /api/public/options/:token renders the page it opens,
// with the sample floor plan and, when RENDERS names a directory holding street.png and aerial.png, those
// as the rendering stills.
// Test hooks: POST /__agent-revision/:id saves a revision as Arosa, POST /__rendered-plan/:id seeds the
// matching sample plan and walkthrough artifacts, POST /__teammate-revision/:id saves
// one as another user, POST /__agent-drawing/:id attaches the sample SVG as Arosa, POST
// /__drop-streams/:id ends the open event streams so browsers reconnect, GET /__notes lists the
// messages sent to the conversation and GET /__stream-connects the cursor of every stream connect.
import express from 'express';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {stateWithArchitecture} from '../fixtures/architecture-states.mjs';
import {planFromFixture, exportPlan} from '../../public/plan-intake.js';
import {drawingName} from '../../../acres-research/architecture-drawings.mjs';
import {segmentHousingPhoto,illustrateHousing} from '../../../acres-research/meta-visual.mjs';
import {processModelInput} from '../../../acres-research/model-intake.mjs';
import {computeDealValuation} from '../../../acres-research/market-store.mjs';
import {buildSchemes, optionSnapshot} from '../../../acres-research/schemes.mjs';
import {optionPage, messagePage} from '../../share-view.mjs';
import {budgetFor} from '../../../acres-research/budget-lines.mjs';
import {DEALS, SETTINGS, pinsOf, searchFeed, pageOf} from '../fixtures/deal-feed.mjs';

const publicDir = fileURLToPath(new URL('../../public', import.meta.url));
const fixtures = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const app = express();
const projects = new Map();
const conversations = new Map();
const clients = new Map();
const notes = [];
const connects = [];
const history = new Map();
let seq = 0;

// A new project holds the sample state with its options priced and saved, as reading a site's options
// saves them in the research service, so the saved site's card and its page show the same figures.
function project(id) {
  if (!projects.has(id)) {
    projects.set(id, {plan: null, revision: null, revisions: [], drawings: [], artifacts: [], jobs: [], state: {...stateWithArchitecture, id}});
    saveSchemes(id);
  }
  return projects.get(id);
}
function emit(id, event, data) {
  const record = {seq: ++seq, event, time: Date.now(), projectId: id, ...data};
  history.set(id, [...(history.get(id) || []), record]);
  for (const res of clients.get(id) || []) res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
}
function summary(id) {
  const p = project(id);
  return {projectId: id, current: p.plan ? {planId: 'plan_fixture', revision: p.revision, parentRevision: p.plan.parentRevision, createdAt: Date.now(), plan: p.plan, artifacts: p.artifacts, jobs: p.jobs} : null, revisions: p.revisions};
}
function save(id, plan, by) {
  const p = project(id);
  const revision = (p.revision ?? 0) + 1;
  p.plan = {...plan, id: 'plan_fixture', revision, parentRevision: p.revision};
  p.artifacts = [];
  p.jobs = [];
  p.revisions.unshift({revision, parentRevision: p.revision, createdAt: Date.now()});
  p.revision = revision;
  emit(id, 'architecture.revision', {revision, parentRevision: p.plan.parentRevision, by});
  return p.plan;
}
const samplePlan = () => ({schema: 'acres.architecture.plan/1', objects: [], sources: [], ...JSON.parse(fixtures('architecture/sample-plan.json'))});
const fixtureArtifact = (id, kind, revision, jobId, contentType) => {
  const name = kind === 'manifest' ? 'sample-manifest.json' : 'sample.glb';
  return {id, kind, revision, jobId, sha256: kind.padEnd(64, '0').slice(0, 64), bytes: fixtures(`architecture/${name}`).length, contentType, createdAt: Date.now()};
};
function attachFixtureWalkthrough(id, plan) {
  const jobId = `fixture-render-${plan.revision}`;
  const glb = fixtureArtifact(`${jobId}-glb`, 'glb', plan.revision, jobId, 'model/gltf-binary');
  const manifest = fixtureArtifact(`${jobId}-manifest`, 'manifest', plan.revision, jobId, 'application/json');
  project(id).jobs = [{id: jobId, projectId: id, revision: plan.revision, status: 'succeeded', reason: null, createdAt: Date.now(), startedAt: Date.now(), finishedAt: Date.now(), artifacts: [glb, manifest]}];
}
function attach(id, {name, contentType, body, by}) {
  const kind = {'application/x-step': 'ifc', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp'}[contentType];
  const view = {id: `drw_${randomUUID().slice(0, 8)}`, name: drawingName(name, kind), kind, contentType, bytes: body.length, sha256: '0'.repeat(64), sourceUrl: null, foundOn: null, createdAt: Date.now(), createdBy: 'fixture', by};
  project(id).drawings.unshift({view, body});
  emit(id, 'architecture.drawing', {drawingId: view.id, name: view.name, kind, by});
  return view;
}

app.post('/api/projects/:id/architecture/drawings', express.raw({type: (req) => !req.is('application/json'), limit: '25mb'}), (req, res) => {
  const name = decodeURIComponent(req.get('x-drawing-name') || 'drawing');
  res.status(201).json(attach(req.params.id, {name, contentType: req.get('content-type'), body: req.body, by: 'user'}));
});
app.post('/api/projects/:id/architecture/:operation', express.json({limit:'36mb'}), async (req,res,next)=>{
  if(!['import-ifc','validate-scan','visual-segment','visual-illustrate'].includes(req.params.operation))return next();
  if(project(req.params.id).state.workflow!=='modeling')return res.status(404).json({error:'Open a Modeling project.'});
  if(req.params.operation.startsWith('visual-')) {
    try {const options={key:process.env.MODEL_API_KEY};return res.json(await (req.params.operation==='visual-segment'?segmentHousingPhoto(req.body,options):illustrateHousing(req.body,options)));}
    catch(error){return res.status(error.status||500).json({error:error.message});}
  }
  try {res.json(await processModelInput(req.params.operation,req.body,{retain:({bytes,name})=>attach(req.params.id,{name,contentType:'application/x-step',body:bytes,by:'user'})}));}
  catch(error){res.status(error.status||500).json({error:error.message});}
});
app.use(express.json({limit: '3mb'}));
const shell = (_req, res) => res.sendFile('index.html', {root: publicDir});
app.get(['/modeling', '/modeling/:id', '/', '/chat', '/whats-new', '/shared/:token', '/sites', '/sites/:id', '/sites/:id/plan', '/sites/:id/report', '/core', '/core/:id', '/core/:id/plan', '/listings/:id'], shell);
app.use(express.static(publicDir));

// The deal feed's first listing starts the path from a listing to a site and its floor plan:
// /listings/4964456219:for_sale. Starting that site from the listing creates a run that
// resolves the parcel after RESOLVE_MS (default 4000) into project fx-new, whose first step then
// researches for RESEARCH_MS (default 300000) before the run completes.
const BASE_FEED=DEALS.slice();
app.post('/__feed-repeat',(req,res)=>{DEALS.splice(0,DEALS.length,...BASE_FEED,...(req.body.repeat?Array.from({length:2},(_,i)=>BASE_FEED.map(d=>({...d,id:d.id+'-copy-'+i,address:d.address+' Annex '+(i+1)}))).flat():[]));res.json({total:DEALS.length});});
const DEAL = DEALS[0];
app.get('/api/market-store/status', (_req, res) => res.json({ok: true}));
app.get('/api/market-store/deals', (req, res) => res.json({...pageOf(searchFeed(DEALS, req.query), req.query), userSettings: SETTINGS}));
app.get('/api/market-store/deals/pins', (req, res) => res.json(pinsOf(searchFeed(DEALS, req.query))));
app.get('/api/market-store/deals/:id', (req, res) => {
  const deal = DEALS.find((d) => d.id === req.params.id);
  return deal ? res.json({deal, userSettings: SETTINGS}) : res.status(404).json({error: 'Not found.'});
});
app.get('/api/market-store/user-settings', (_req, res) => res.json({...SETTINGS, baselineSettings: SETTINGS.dealSettings, costsConfirmed: process.env.COSTS_CONFIRMED!=='false'}));
const NEW_SITE = {id: 'fx-new', bbl: DEAL.bbl, access: 'owner', title: `Underwrite 125 Shepherd Ave, Brooklyn, NY 11208, BK (BBL ${DEAL.bbl}) in M1-1`, progress: {done: 4, next: null, stale: false, underwritten: Date.UTC(2026, 9, 18, 15), landPrice: 1850000, profit: 640000, call: 'supports_price'}};
const resolvedSites = [];
const runs = new Map();
const runClients = new Map();
function runEmit(run, event) {
  const record = {seq: run.events.length + 1, time: Date.now(), ...event};
  run.events.push(record);
  for (const res of runClients.get(run.id) || []) res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
}
function startSiteRun(conversation, run) {
  run.status = 'running';
  runEmit(run, {event: 'status', status: 'Identifying the parcel'});
  setTimeout(() => {
    conversation.projectId = NEW_SITE.id;
    if (!resolvedSites.includes(NEW_SITE)) resolvedSites.push(NEW_SITE);
    projects.set(NEW_SITE.id, {plan: null, revision: null, revisions: [], drawings: [], state: {id: NEW_SITE.id, version: 1, title: NEW_SITE.title, fields: {}}});
    runEmit(run, {event: 'tool.started', tool: 'acres_set_subject', arguments: {bbl: DEAL.bbl}});
    runEmit(run, {event: 'tool.completed', tool: 'acres_set_subject', success: true});
    runEmit(run, {event: 'status', status: 'Confirming the parcel'});
    setTimeout(() => {
      run.status = 'completed';
      conversation.messages.push({id: `m_${randomUUID().slice(0, 8)}`, role: 'assistant', text: 'The parcel is confirmed.', runId: run.id});
      runEmit(run, {event: 'run.completed'});
    }, Number(process.env.RESEARCH_MS || 300000));
  }, Number(process.env.RESOLVE_MS || 4000));
}
// Pending jobs: runs still going in a conversation that has its site.
const activeRuns = () => [...conversations.values()].flatMap((c) => c.projectId ? c.runs.filter((r) => r.status === 'running').map((r) => ({id: r.id, status: r.status, created: r.created, conversationId: c.id, projectId: c.projectId, title: NEW_SITE.title, bbl: DEAL.bbl, progress: {done: 1, next: 2}, step: 2})) : []);
app.get('/api/runs', (_req, res) => res.json({runs: activeRuns()}));
app.get('/api/runs/:id/status', (req, res) => (runs.has(req.params.id) ? res.json({status: runs.get(req.params.id).status}) : res.status(404).json({error: 'Not found.'})));
app.get('/api/runs/:id', (req, res) => (runs.has(req.params.id) ? res.json(runs.get(req.params.id)) : res.status(404).json({error: 'Not found.'})));
app.get('/api/runs/:id/events', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({error: 'Not found.'});
  res.writeHead(200, {'content-type': 'text/event-stream', connection: 'keep-alive'});
  res.write(': connected\n\n');
  const after = Number(req.get('last-event-id') || req.query.after || 0);
  for (const record of run.events) if (record.seq > after) res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
  const list = runClients.get(run.id) || new Set();
  list.add(res);
  runClients.set(run.id, list);
  req.on('close', () => list.delete(res));
});

// The saved conversations: one on the fx-plan site with a cited answer, one market question, and one a
// teammate shared through a link. Seeded at start and again by POST /__reset.
const ME = {account: 'fixture', name: 'Fixture User'}, TEAMMATE = {account: 'teammate', name: 'Dana Teammate'};
const SITE_SOURCES = [
  {id: 1, title: 'NYC MapPLUTO 25v2', url: 'https://data.cityofnewyork.us/resource/64uk-42ks.json?bbl=3012340056', kind: 'web', publisher: 'NYC Department of City Planning', text: 'Lot area 5,000 sq ft; zoning district R7A with a C2-4 overlay; residential FAR 4.0.', retrievedAt: '2026-10-15T13:58:00Z'},
  {id: 2, title: 'NYC Zoning Resolution 23-22', url: 'https://zr.planning.nyc.gov/article-ii/chapter-3/23-22', kind: 'web', publisher: 'NYC Department of City Planning', text: 'Maximum residential floor area ratio and lot coverage in R7A districts.', retrievedAt: '2026-10-15T13:59:00Z'},
];
// The two feed answers are worked out from the feed, so they always agree with the cards beside them.
const count = (n) => ['No', 'One', 'Two', 'Three', 'Four'][n] ?? String(n);
const sqft = (n) => n.toLocaleString('en-US');
function cheapLandAnswer() {
  const cheap = DEALS.filter((d) => d.borough === 'BK' && d.style === 'land' && d.uapPricePerBuildableZfa < 150);
  const named = cheap.map((d) => `${d.address} in ${d.neighborhood}, zoned ${d.zoningDistrict}, at $${d.uapPricePerBuildableZfa}`);
  return `${count(cheap.length)} Brooklyn land ${cheap.length === 1 ? 'listing prices' : 'listings price'} under $150 per buildable foot${named.length ? `: ${named.join('; ')}.` : '.'}`;
}
function bronxAnswer() {
  const [more, less] = DEALS.filter((d) => d.borough === 'BX').sort((a, b) => b.unusedUapZfa - a.unusedUapZfa);
  const cost = more.uapPricePerBuildableZfa <= less.uapPricePerBuildableZfa ? 'and costs less' : 'but costs more';
  const site = (d) => (d.existingBldgAreaSqft ? `The ${d.neighborhood} listing has ${sqft(d.existingBldgAreaSqft)} sq ft of building on it.` : `The ${d.neighborhood} lot is vacant.`);
  return `The ${more.neighborhood} listing has more unused floor area, ${sqft(more.unusedUapZfa)} sq ft against ${sqft(less.unusedUapZfa)} in ${less.neighborhood}, ${cost} per buildable foot: $${more.uapPricePerBuildableZfa} against $${less.uapPricePerBuildableZfa}. ${site(more)} ${site(less)}`;
}
const LINKS = new Map();
const TEAMS = new Map();
function seed() {
  const at = Date.UTC(2026, 9, 24, 15);
  const conversation = (id, title, extra, turns) => {
    const conv = {id, projectId: null, title, access: 'owner', members: [], owner: ME, updated: at, runs: [], messages: [], ...extra};
    turns.forEach(([ask, answer, sources], i) => {
      const run = {id: `${id}_run${i + 1}`, status: 'completed', input: ask, owner: conv.owner.account, created: at - (turns.length - i) * 3600000, events: []};
      conv.runs.push(run);
      runs.set(run.id, run);
      conv.messages.push({id: `${run.id}_q`, role: 'user', text: ask, runId: run.id, author: conv.owner.account, created: run.created},
        {id: `${run.id}_a`, role: 'assistant', text: answer, runId: run.id, created: run.created + 60000, ...(sources ? {sources} : {})});
    });
    conversations.set(id, conv);
  };
  conversation('conv_fx_plan', project('fx-plan').state.title, {projectId: 'fx-plan'}, [
    ['How much floor area can this lot hold?', 'The lot is 5,000 sq ft in R7A with a C2-4 overlay [1]. At a residential FAR of 4.0 it holds about 20,000 sq ft of floor area, 16,800 more than the building on it now [2].', SITE_SOURCES],
  ]);
  conversation('conv_fx_market', 'Land under $150 per buildable foot in Brooklyn', {updated: at - 86400000}, [
    ['Which Brooklyn land listings price under $150 per buildable foot?', cheapLandAnswer()],
  ]);
  conversation('conv_fx_shared', 'Two Bronx listings compared', {access: 'viewer', owner: TEAMMATE, members: [{principalType: 'account', principal: ME.account, role: 'viewer', name: ME.name}], updated: at - 2 * 86400000}, [
    ['Compare the two Bronx listings for new construction.', bronxAnswer()],
  ]);
  LINKS.clear();
  LINKS.set('fx-shared-link', {token: 'fx-shared-link', conversationId: 'conv_fx_shared', role: 'viewer', createdBy: TEAMMATE, createdByName: TEAMMATE.name, expiresAt: null, revokedAt: null, revoked: false, path: '/shared/fx-shared-link'});
  TEAMS.clear();
  TEAMS.set('team_fx', {id: 'team_fx', name: 'Acquisitions', owner: ME, created: Date.UTC(2026, 8, 1),
    members: [{...ME, email: 'fixture@witharosa.ai', role: 'owner', addedAt: Date.UTC(2026, 8, 1)}, {...TEAMMATE, email: 'dana@example.com', role: 'member', addedAt: Date.UTC(2026, 8, 2)}]});
}
const nextMonth = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

app.get('/api/session', (_req, res) => res.json({namespace: 'fixture', email: 'fixture@witharosa.ai', isAdmin: process.env.ADMIN === '1', architectureEnabled: process.env.ARCHITECTURE !== 'off'}));
// Everyone the fixture knows: the teams' members and the people conversations are shared with.
app.get('/api/people', (req, res) => {
  const q = String(req.query.q || '').toLowerCase(), people = new Map();
  for (const m of [...TEAMS.values()].flatMap((t) => t.members)) people.set(m.account, {account: m.account, email: m.email, name: m.name});
  for (const m of [...conversations.values()].flatMap((c) => c.members)) if (m.principalType === 'account' && m.email) people.set(m.principal, {account: m.principal, email: m.email, name: m.name});
  res.json({people: [...people.values()].filter((p) => !q || p.email.includes(q) || p.name.toLowerCase().includes(q)).slice(0, 20)});
});
app.post('/api/people/me', (_req, res) => res.json({account: 'fixture', email: 'fixture@witharosa.ai', name: 'Fixture User'}));
// Teams and sharing answer as the research service does: the same payloads, and the same errors for
// an unknown team or conversation, a bad name or role, and a reader who does not own what they manage.
const fail = (res, status, error) => res.status(status).json({error});
const personFor = (email) => ({account: `acct_${email}`, name: email.split('@')[0].replace(/^./, (c) => c.toUpperCase()), email});
const validName = (name) => typeof name === 'string' && name.trim() && name.trim().length <= 80 ? name.trim() : null;
const teamView = (t) => ({...t, role: t.owner.account === ME.account ? 'owner' : 'member', memberCount: t.members.length});
function ownTeam(req, res) {
  const team = TEAMS.get(req.params.id);
  if (!team) return void fail(res, 404, 'Team not found.');
  if (team.owner.account !== ME.account) return void fail(res, 403, 'Only the team owner can manage this team.');
  return team;
}
app.get('/api/teams', (_req, res) => res.json({teams: [...TEAMS.values()].map((t) => { const {members, ...team} = teamView(t); return team; })}));
app.post('/api/teams', (req, res) => {
  const name = validName(req.body.name);
  if (!name) return fail(res, 400, 'Name must be 1 to 80 characters.');
  const team = {id: `team_${randomUUID().slice(0, 8)}`, name, owner: ME, created: Date.now(), members: [{...ME, email: 'fixture@witharosa.ai', role: 'owner', addedAt: Date.now()}]};
  TEAMS.set(team.id, team);
  res.status(201).json(teamView(team));
});
app.get('/api/teams/:id', (req, res) => (TEAMS.has(req.params.id) ? res.json(teamView(TEAMS.get(req.params.id))) : fail(res, 404, 'Team not found.')));
app.patch('/api/teams/:id', (req, res) => {
  const team = ownTeam(req, res), name = validName(req.body.name);
  if (!team) return;
  if (!name) return fail(res, 400, 'Name must be 1 to 80 characters.');
  team.name = name;
  res.json(teamView(team));
});
app.delete('/api/teams/:id', (req, res) => {
  const team = ownTeam(req, res);
  if (!team) return;
  TEAMS.delete(team.id);
  res.json({id: team.id, archived: true, archivedAt: Date.now()});
});
app.post('/api/teams/:id/members', (req, res) => {
  const team = ownTeam(req, res), email = String(req.body.email || '').trim().toLowerCase();
  if (!team) return;
  if (!email) return fail(res, 400, 'A member account is required.');
  if (!team.members.some((m) => m.email === email)) team.members.push({...personFor(email), role: 'member', addedAt: Date.now()});
  res.json(teamView(team));
});
app.delete('/api/teams/:id/members/:account', (req, res) => {
  const team = ownTeam(req, res);
  if (!team) return;
  if (req.params.account === team.owner.account) return fail(res, 400, 'The team owner cannot be removed.');
  team.members = team.members.filter((m) => m.account !== req.params.account);
  res.json(teamView(team));
});
// The conversation a sharing request manages, when the reader owns it.
function ownConversation(req, res) {
  const conversation = conversations.get(req.params.id);
  if (!conversation) return void fail(res, 404, 'Conversation not found.');
  if (conversation.access !== 'owner') return void fail(res, 403, 'Only the conversation owner can manage sharing.');
  return conversation;
}
const ROLES = ['viewer', 'participant'];
app.get('/api/plan', (_req, res) => res.json({plan: 'free', used: 1, limit: 3, resetsAt: nextMonth(), manageable: false, checkoutAvailable: false, prices: {}}));
app.get('/api/wallet', (_req, res) => res.json({enabled: false, checkoutAvailable: false, currency: 'USD', entries: []}));
app.get('/api/conversations', (_req, res) => res.json({conversations: [...conversations.values()].sort((a, b) => b.updated - a.updated).map(({messages, runs, ...c}) => ({...c, site: projects.has(c.projectId) ? {id: c.projectId, title: projects.get(c.projectId).state.title, ...(projects.get(c.projectId).state.workflow==='modeling'?{workflow:'modeling'}:{})} : null}))}));
app.get('/api/conversations/:id/members', (req, res) => { const c = ownConversation(req, res); if (c) res.json({members: c.members}); });
app.post('/api/conversations/:id/members', (req, res) => {
  const conversation = ownConversation(req, res), {role, teamId} = req.body, email = String(req.body.email || '').trim().toLowerCase();
  if (!conversation) return;
  if (!ROLES.includes(role)) return fail(res, 400, 'Role must be viewer or participant.');
  const team = teamId ? TEAMS.get(teamId) : null;
  if (teamId && !team) return fail(res, 404, 'Team not found.');
  if (!team && !email) return fail(res, 400, 'An account or email is required.');
  const person = team ? null : personFor(email);
  const member = team ? {principalType: 'team', principal: team.id, role, name: team.name, email: null} : {principalType: 'account', principal: person.account, role, name: person.name, email};
  conversation.members = [...conversation.members.filter((m) => !(m.principalType === member.principalType && m.principal === member.principal)), {...member, addedBy: ME.account, addedAt: Date.now()}];
  res.json({member, members: conversation.members});
});
app.patch('/api/conversations/:id/members/:principalType/:principal', (req, res) => {
  const conversation = ownConversation(req, res);
  if (!conversation) return;
  if (!ROLES.includes(req.body.role)) return fail(res, 400, 'Role must be viewer or participant.');
  const member = conversation.members.find((m) => m.principalType === req.params.principalType && m.principal === req.params.principal);
  if (!member) return fail(res, 404, 'Member not found.');
  member.role = req.body.role;
  res.json({member, members: conversation.members});
});
app.delete('/api/conversations/:id/members/:principalType/:principal', (req, res) => {
  const conversation = ownConversation(req, res);
  if (!conversation) return;
  conversation.members = conversation.members.filter((m) => !(m.principalType === req.params.principalType && m.principal === req.params.principal));
  res.json({removed: true, members: conversation.members});
});
app.get('/api/conversations/:id/links', (req, res) => {
  if (ownConversation(req, res)) res.json({links: [...LINKS.values()].filter((l) => l.conversationId === req.params.id).map(({conversationId, ...l}) => l)});
});
app.post('/api/conversations/:id/links', (req, res) => {
  if (!ownConversation(req, res)) return;
  const token = randomUUID().replaceAll('-', '');
  const link = {token, conversationId: req.params.id, role: 'viewer', createdBy: ME, createdByName: ME.name, expiresAt: null, revokedAt: null, revoked: false, path: `/shared/${token}`};
  LINKS.set(token, link);
  res.status(201).json(link);
});
app.delete('/api/conversations/:id/links/:token', (req, res) => {
  if (!ownConversation(req, res)) return;
  const link = LINKS.get(req.params.token);
  if (!link || link.conversationId !== req.params.id) return fail(res, 404, 'Share link not found.');
  Object.assign(link, {revokedAt: link.revokedAt ?? Date.now(), revoked: true});
  res.json({revoked: true});
});
app.get('/api/shared/:token', (req, res) => {
  const link = LINKS.get(req.params.token);
  return link && !link.revoked ? res.json({conversationId: link.conversationId, access: 'viewer'}) : res.status(404).json({error: 'Share link not found.'});
});
app.post('/api/conversations', (req, res) => {
  const conversation = {id: `conv_${randomUUID().slice(0, 8)}`, projectId: req.body.projectId ?? null, title: 'Fixture site', messages: [], runs: [], access: 'owner', members: [], owner: {account: 'fixture'}, updated: Date.now()};
  const model=projects.get(req.body.projectId)?.state;
  if(model?.workflow==='modeling'){conversation.workflow='modeling';conversation.site={id:model.id,title:model.title,workflow:'modeling'};conversation.property=model.fields.property.value;}
  conversations.set(conversation.id, conversation);
  res.status(201).json(conversation);
});
app.get('/api/conversations/:id', (req, res) => (conversations.has(req.params.id) ? res.json(conversations.get(req.params.id)) : res.status(404).json({error: 'Not found.'})));
app.post('/api/conversations/:id/runs', (req, res) => {
  const conversation = conversations.get(req.params.id);
  notes.push(req.body.message);
  const runId = req.body.id || randomUUID();
  conversation.messages.push({id: `m_${randomUUID().slice(0, 8)}`, role: 'user', text: req.body.message, runId});
  const run = {id: runId, status: 'completed', input: req.body.message, owner: 'fixture', created: Date.now(), events: []};
  conversation.runs.push(run);
  runs.set(runId, run);
  if (/(^|\n)(Set up|Underwrite|Draft) /.test(req.body.message)) startSiteRun(conversation, run);
  else conversation.messages.push({id: `m_${randomUUID().slice(0, 8)}`, role: 'assistant', text: 'Noted. I will use it for the next pass on the plan.', runId});
  res.status(202).json({id: runId, status: run.status});
});
app.get('/api/projects', (req, res) => {
  const q = String(req.query.q || '');
  const {state} = project('fx-plan');
  const saved = {id: state.id, siteKey: state.siteKey, bbl: state.bbl, title: state.title, owner: ME, access: 'owner', version: state.version, conversationCount: 1, updated: state.updated};
  // A site shows as running only while a run on that site is going.
  const running = (id) => activeRuns().find((r) => r.projectId === id)?.created ?? null;
  const models=[...projects.values()].map(p=>p.state).filter(p=>p.workflow==='modeling');
  const rows=req.query.modelsOnly==='true'?models:req.query.legacyModelsOnly==='true'?[saved]:[...resolvedSites,saved];
  res.json({projects: rows.filter((p) => !q || p.bbl === q || p.title.includes(q)).map((p) => ({...p, running: running(p.id)})),nextCursor:null});
});
app.post('/api/projects',(req,res)=>{
  const id='model_'+randomUUID().slice(0,8),now=Date.now();
  const p=project(id);
  p.state={...p.state,id,title:req.body.title,siteKey:id,bbl:null,workflow:'modeling',version:0,created:now,updated:now,fields:Object.fromEntries(Object.keys(p.state.fields).map(key=>[key,{value:null,provenance:null,updated:null,stale:null}]))};
  p.state.fields.property={value:{address:req.body.address},provenance:{tool:'user'},updated:now,stale:null};
  res.status(201).json(p.state);
});
const stateFailures=new Map();
app.post('/__state-failure/:id',(req,res)=>{if(req.body.status)stateFailures.set(req.params.id,req.body.status);else stateFailures.delete(req.params.id);res.json({ok:true});});
app.post('/__access/:id',(req,res)=>{const conversation=[...conversations.values()].find(c=>c.projectId===req.params.id);conversation.access=req.body.access;res.json({access:conversation.access});});
app.get('/api/projects/:id/state', (req, res) => {const status=stateFailures.get(req.params.id);if(status)return res.status(status).json({error:status===404?'Not found.':'Internal Server Error'});res.json(project(req.params.id).state);});
// Three schemes priced by the real valuation for a sample listed lot.
const SCHEME_LOT = {listPrice: 6_000_000, lotArea: 10000, lotFront: 100, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 3.44, affResFar: 5.01, zoningDistrict: 'R7-1', address: '20 EXAMPLE AVENUE', borough: 'QN', zipCode: '11373', frontStreetFeet: 80};
const sent = new Map(), options = new Map();
const FILES = {'00000000-0000-0000-0000-00000000000a': () => fixtures('sample-floorplan.svg'), '00000000-0000-0000-0000-00000000000b': () => readFileSync(`${process.env.RENDERS}/street.png`), '00000000-0000-0000-0000-00000000000c': () => readFileSync(`${process.env.RENDERS}/aerial.png`)};
function schemesOf(id) {
  const {state} = project(id);
  const v = computeDealValuation({...SCHEME_LOT, withCandidates: true});
  return {projectId: id, version: state.version, schemes: buildSchemes({candidates: v.candidates, concepts: state.fields.concepts?.value || []}).map((s) => (s.program ? {...s, budget: budgetFor(s)} : s)),
    basis: {source: 'listing', listingId: 'fixture', ask: SCHEME_LOT.listPrice, askFrom: 'listing', dealVerdict: v.dealVerdict, infeasible: v.infeasibleAtTarget}, stale: null, updated: Date.now(),
    sends: {canSend: true, sent: Object.fromEntries([...sent].filter(([key]) => key.startsWith(`${id}:`)).map(([key, value]) => [key.slice(id.length + 1), value]))}};
}
// Reading a site's options reprices and saves them on the project, as the research service does.
function saveSchemes(id) {
  const {state} = project(id);
  if (!state.fields?.property?.value?.bbl) return null;
  const read = schemesOf(id);
  state.fields = {...state.fields, schemes: {value: {schemes: read.schemes, basis: read.basis}, provenance: {tool: 'schemes', source: 'listing', listingId: 'fixture', sources: []}, stale: null, updated: read.updated}};
  return read;
}
app.get('/api/projects/:id/schemes', (req, res) => {
  const {state} = project(req.params.id);
  res.json(saveSchemes(req.params.id) || {projectId: req.params.id, version: state.version, schemes: null, basis: null, stale: null, updated: null});
});
app.post('/api/projects/:id/schemes/:schemeId/send', (req, res) => {
  const {state} = project(req.params.id), read = schemesOf(req.params.id), at = Date.now();
  const scheme = read.schemes.find((s) => s.id === req.params.schemeId);
  const drawn = {...scheme, plan: {planId: 'plan_fixture', revision: 1, svg: '00000000-0000-0000-0000-00000000000a'},
    render: process.env.RENDERS ? {status: 'succeeded', views: [{view: 'street', artifactId: '00000000-0000-0000-0000-00000000000b'}, {view: 'aerial', artifactId: '00000000-0000-0000-0000-00000000000c'}]} : null};
  const token = randomUUID().replaceAll('-', '').padEnd(43, 'x');
  const option = optionSnapshot({scheme: drawn, basis: read.basis, concepts: state.fields.concepts?.value || [], site: {address: state.title, bbl: state.bbl ?? null}, sender: {name: 'Fixture User'}, at});
  options.set(token, option);
  sent.set(`${req.params.id}:${scheme.id}`, {at, by: 'Fixture User'});
  emit(req.params.id, 'option.sent', {scheme: scheme.id, label: scheme.label, name: 'Fixture User'});
  res.status(201).json({token, path: `/api/public/options/${token}`, createdAt: at, option});
});
app.delete('/api/projects/:id/schemes/:schemeId/send', (req, res) => {
  const withdrawn = sent.delete(`${req.params.id}:${req.params.schemeId}`);
  res.json({withdrawn: withdrawn ? 1 : 0});
});
app.get('/api/public/options/:token', (req, res) => {
  const option = options.get(req.params.token);
  if (!option) return res.status(404).type('html').send(messagePage('This link is not available', 'It may have been mistyped or withdrawn. Ask the person who sent it for a new one.'));
  res.type('html').send(optionPage(option, {files: `/api/public/options/${req.params.token}/files`}));
});
app.get('/api/public/options/:token/files/:fileId', (req, res) => (options.has(req.params.token) && FILES[req.params.fileId] ? res.type(req.params.fileId.endsWith('a') ? 'image/svg+xml' : 'image/png').send(FILES[req.params.fileId]()) : res.status(404).end()));
app.get('/api/projects/:id/architecture', (req, res) => res.json(summary(req.params.id)));
app.get('/api/projects/:id/architecture/artifacts/:artifactId', (req, res) => {
  const p = project(req.params.id);
  const artifact = p.jobs.flatMap(job => job.artifacts).find(item => item.id === req.params.artifactId);
  if (!artifact) return res.status(404).json({error: 'Artifact not found.'});
  if (artifact.kind === 'glb') return res.type('model/gltf-binary').send(fixtures('architecture/sample.glb'));
  if (artifact.kind === 'manifest') return res.type('application/json').send(fixtures('architecture/sample-manifest.json'));
  return res.status(404).json({error: 'Artifact not found.'});
});
app.get('/api/projects/:id/architecture/schemes/draft', (_req, res) => res.json({drafts: []}));
app.put('/api/projects/:id/architecture/plan', (req, res) => {
  const p = project(req.params.id);
  if ((req.body.parentRevision ?? null) !== p.revision) return res.status(409).json({error: `Revision ${p.revision} was saved after you started editing.`, revision: p.revision});
  const plan = save(req.params.id, req.body.plan, 'user');
  res.status(201).json({revision: plan.revision, parentRevision: plan.parentRevision, planId: plan.id, plan, artifacts: []});
});
app.get('/api/projects/:id/architecture/drawings', (req, res) => res.json({drawings: project(req.params.id).drawings.map((d) => d.view)}));
app.get('/api/projects/:id/architecture/drawings/:drawingId', (req, res) => {
  const drawing = project(req.params.id).drawings.find((d) => d.view.id === req.params.drawingId);
  if (!drawing) return res.status(404).json({error: 'Drawing not found.'});
  res.set({'content-type': drawing.view.contentType, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"}).send(drawing.body);
});
app.get('/api/projects/:id/events', (req, res) => {
  res.writeHead(200, {'content-type': 'text/event-stream', connection: 'keep-alive'});
  res.write(': connected\n\n');
  const after = Number(req.get('last-event-id') || req.query.after || 0);
  connects.push({projectId: req.params.id, after});
  for (const record of history.get(req.params.id) || []) if (record.seq > after) res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
  const list = clients.get(req.params.id) || new Set();
  list.add(res);
  clients.set(req.params.id, list);
  req.on('close', () => list.delete(res));
});
app.use('/api', (_req, res) => res.status(404).json({error: 'Not found.'}));

// Arosa saves the sample plan (or renames the current one) as a revision. Rendering stays separate.
app.post('/__agent-revision/:id', (req, res) => {
  const p = project(req.params.id);
  const base = p.plan || exportPlan(planFromFixture(JSON.parse(fixtures('sample-floorplan.json')), {ref: 'Listing floor plan.svg'}));
  const plan = save(req.params.id, {...base, name: `${base.name.replace(/ \(Arosa\)$/, '')} (Arosa)`}, 'agent');
  res.json(plan);
});
// The explicit rendered-demo hook uses only the matching plan, GLB, and manifest fixture.
app.post('/__rendered-plan/:id', (req, res) => {
  const base = samplePlan();
  const plan = save(req.params.id, {...base, name: `${base.name.replace(/ \(Arosa\)$/, '')} (Arosa)`}, 'agent');
  attachFixtureWalkthrough(req.params.id, plan);
  res.json(plan);
});
app.post('/__agent-drawing/:id', (req, res) => res.json(attach(req.params.id, {name: 'Listing floor plan.svg', contentType: 'image/svg+xml', body: fixtures('sample-floorplan.svg'), by: 'agent'})));
app.post('/__teammate-revision/:id', (req, res) => {
  const p = project(req.params.id);
  res.json(save(req.params.id, {...p.plan, name: `${p.plan.name.replace(/ \(teammate\)$/, '')} (teammate)`}, 'user'));
});
app.post('/__state-change/:id', (req,res) => {
  const p=project(req.params.id);p.state={...p.state,version:p.state.version+1,updated:Date.now(),fields:{...p.state.fields,...req.body.fields}};
  emit(req.params.id,'state.updated',{version:p.state.version,keys:Object.keys(req.body.fields)});res.json({version:p.state.version});
});
app.post('/__drop-streams/:id', (req, res) => {
  for (const stream of clients.get(req.params.id) || []) stream.end();
  res.json({dropped: true});
});
app.post('/__reset', (_req, res) => { stateFailures.clear();projects.clear(); conversations.clear(); runs.clear(); sent.clear(); options.clear(); resolvedSites.length = 0; history.clear(); seed(); res.json({reset: true}); });
seed();
app.get('/__notes', (_req, res) => res.json(notes));
app.get('/__stream-connects', (_req, res) => res.json(connects));

const port = Number(process.env.PORT || 4795);
app.listen(port, '127.0.0.1', () => console.log(`Plan page fixture: http://127.0.0.1:${port}/sites/fx-plan/plan`));
