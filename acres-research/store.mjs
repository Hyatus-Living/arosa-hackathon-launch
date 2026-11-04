import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,existsSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {safeTrace,appendRunTraceEvent} from './trace.mjs';
import {EventEmitter} from 'node:events';
import {ProjectState,fieldsFromResult,fullGraph,userFields,deriveProFormas,deriveKeep,reconcileResearchFields,reportFingerprint,reportValuesMatch,savedSourceRefs} from './project-state.mjs';
// The site page's own progress rule, so a saved-site card and its page agree on steps done.
import {siteProgress,runStep} from '../app-starter/public/core-model.js';
import {ARCHITECTURE_DDL,migrateArchitecture} from './architecture-artifacts.mjs';
import {buildSchemes,optionSnapshot} from './schemes.mjs';
import {DRAWINGS_DDL} from './architecture-drawings.mjs';
import {validateFilterSnapshot} from './listing-filter-schema.mjs';
import {validateListingPage,listingPageResearchContext,listingPageHistoryNote} from './listing-page-context.mjs';

const RANK={viewer:1,participant:2,owner:3};
const RUN_ATTEMPTS=2;
const personName=p=>p?.name||(p?.email?(p.email.split('@')[0]||p.email):'A teammate');
const PROJECT_VISIBLE=`EXISTS(SELECT 1 FROM conversations c WHERE c.project=p.id AND (c.owner=?
  OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation=c.id AND cm.principal_type='account' AND cm.principal=? AND cm.removed_at IS NULL)
  OR EXISTS(SELECT 1 FROM conversation_members cm JOIN teams t ON t.id=cm.principal JOIN team_members tm ON tm.team=cm.principal AND tm.account=? WHERE cm.conversation=c.id AND cm.principal_type='team' AND cm.removed_at IS NULL AND tm.removed_at IS NULL AND t.archived_at IS NULL)))`;
function fail(status,message){const e=new Error(message);e.status=status;return e;}
// The projects an account can see: its own, and every project of a conversation it owns or is shared.
// Takes the account four times.
const VISIBLE_PROJECTS=`SELECT rowid FROM projects WHERE owner=?
  UNION ALL SELECT visible.rowid FROM conversations c JOIN projects visible ON visible.id=c.project WHERE c.owner=?
  UNION ALL SELECT visible.rowid FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation JOIN projects visible ON visible.id=c.project
    WHERE cm.principal_type='account' AND cm.principal=? AND cm.removed_at IS NULL
  UNION ALL SELECT visible.rowid FROM team_members tm JOIN teams t ON t.id=tm.team
    JOIN conversation_members cm ON cm.principal_type='team' AND cm.principal=tm.team AND cm.removed_at IS NULL
    JOIN conversations c ON c.id=cm.conversation JOIN projects visible ON visible.id=c.project
    WHERE tm.account=? AND tm.removed_at IS NULL AND t.archived_at IS NULL`;
const like=q=>`%${String(q).replace(/[\\%_]/g,'\\$&')}%`;
const requestJson=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);

const SHARING_DDL=`
CREATE TABLE IF NOT EXISTS people(account TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL,created INTEGER NOT NULL,archived_at INTEGER);
CREATE TABLE IF NOT EXISTS team_members(team TEXT NOT NULL REFERENCES teams(id),account TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','member')),added_by TEXT NOT NULL,added_at INTEGER NOT NULL,removed_at INTEGER,PRIMARY KEY(team,account));
CREATE TABLE IF NOT EXISTS conversation_members(conversation TEXT NOT NULL REFERENCES conversations(id),principal_type TEXT NOT NULL CHECK(principal_type IN ('account','team')),principal TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','participant')),added_by TEXT NOT NULL,added_at INTEGER NOT NULL,removed_at INTEGER,PRIMARY KEY(conversation,principal_type,principal));
CREATE TABLE IF NOT EXISTS share_links(conversation TEXT NOT NULL REFERENCES conversations(id),token TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role IN ('viewer','participant')),created_by TEXT NOT NULL,expires_at INTEGER,revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS share_links_conversation ON share_links(conversation);
CREATE TABLE IF NOT EXISTS option_links(token TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),scheme TEXT NOT NULL,snapshot TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS option_links_project ON option_links(project,scheme);
CREATE INDEX IF NOT EXISTS conversation_member_active_principal ON conversation_members(principal_type,principal,conversation) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS team_member_active_account ON team_members(account,team) WHERE removed_at IS NULL;`;

const DREAM_DDL=`
CREATE TABLE IF NOT EXISTS run_evaluations(
  run TEXT PRIMARY KEY REFERENCES runs(id),
  overall REAL NOT NULL,
  citation_fidelity REAL NOT NULL,
  tool_efficiency REAL NOT NULL,
  state_reuse REAL NOT NULL,
  domain_completeness REAL NOT NULL,
  signals TEXT NOT NULL,
  notes TEXT,
  evaluated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_memories(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('account','team','jurisdiction','global')),
  principal TEXT NOT NULL,
  category TEXT NOT NULL,
  rule TEXT NOT NULL,
  evidence_runs TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  account TEXT,
  team TEXT,
  jurisdiction TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  approved_by TEXT,
  approved_at INTEGER,
  rejected_by TEXT,
  rejected_at INTEGER,
  UNIQUE(scope,principal,rule)
);
CREATE INDEX IF NOT EXISTS workspace_memories_lookup ON workspace_memories(scope,principal,confidence DESC);
CREATE TABLE IF NOT EXISTS dream_runs(
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  runs_evaluated INTEGER NOT NULL DEFAULT 0,
  memories_consolidated INTEGER NOT NULL DEFAULT 0,
  expansions_learned INTEGER NOT NULL DEFAULT 0,
  sources_staged INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);`;

// A conversation is named by its first request, read as a title: the client's bracketed page note,
// parenthetical figures and everything after the first sentence are dropped, and long ones cut at a word.
export function conversationTitle(input) {
  let text=String(input).replace(/^\[[^\]]*\]\n\n/,'');
  for(let prev='';prev!==text;){prev=text;text=text.replace(/\s*\([^()]*\)/g,'');}
  const sentence=text.replace(/\s+/g,' ').trim().split(/(?<=[.!?])\s/)[0].replace(/\.$/,'');
  return sentence.length<=72?sentence:sentence.slice(0,72).replace(/[\s,;:]+\S*$/,'')+'…';
}

// How long an ended site job stays in the pending jobs list.
const ENDED_JOB_MS=30*60000;

export class ChatStore {
  constructor(path) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.traceDir=join(dirname(path),'traces');
    this.db=new DatabaseSync(path); chmodSync(path,0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,title TEXT NOT NULL,property TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_owner ON conversations(owner,updated DESC);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation TEXT NOT NULL REFERENCES conversations(id),status TEXT NOT NULL,input TEXT NOT NULL,result TEXT,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS run_owner ON runs(owner,created DESC);
      CREATE INDEX IF NOT EXISTS run_conversation ON runs(conversation);
      CREATE INDEX IF NOT EXISTS run_queued_created ON runs(created) WHERE status='queued';
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation TEXT NOT NULL REFERENCES conversations(id),run TEXT REFERENCES runs(id),role TEXT NOT NULL,text TEXT NOT NULL,payload TEXT,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation);
      CREATE INDEX IF NOT EXISTS message_user_recent ON messages(conversation,seq DESC) WHERE role='user';
      CREATE TABLE IF NOT EXISTS events(run TEXT NOT NULL REFERENCES runs(id),seq INTEGER NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(run,seq));
      ${SHARING_DDL}
      ${DREAM_DDL}`);
    this.project=new ProjectState(this.db);this.project.migrate();
    this.db.exec('CREATE INDEX IF NOT EXISTS conversation_owner_project ON conversations(owner,project)');
    this.db.exec(ARCHITECTURE_DDL);migrateArchitecture(this.db);this.db.exec(DRAWINGS_DDL);
    this.projectFeed=new EventEmitter();this.projectFeed.setMaxListeners(0);
    this.migrateSharing();
    this.migrateDreamReview();
    // The browser draft a conversation was created from, so two tabs sending a first message in the
    // same sitting land in one thread instead of forking duplicates.
    if(!this.query('PRAGMA table_info(conversations)').some(c=>c.name==='client_draft_id'))this.db.exec('ALTER TABLE conversations ADD COLUMN client_draft_id TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS conversation_client_draft ON conversations(owner,client_draft_id) WHERE client_draft_id IS NOT NULL');
    // Sites that one owner opened twice for one lot before this rule existed (or whose merge waited)
    // converge now, oldest site first.
    for(const {id} of this.query('SELECT MIN(id) AS id FROM projects WHERE bbl IS NOT NULL GROUP BY owner,bbl HAVING COUNT(*)>1'))this.convergeSite(id);
  }
  query(sql,...args){return this.db.prepare(sql).all(...args);}
  one(sql,...args){return this.db.prepare(sql).get(...args);}
  write(sql,...args){return this.db.prepare(sql).run(...args);}

  migrateSharing(){
    if(this.one('PRAGMA user_version').user_version>=2)return;
    this.db.exec('BEGIN');
    try{
      this.db.exec(SHARING_DDL);
      const cols=this.query('PRAGMA table_info(messages)').map(r=>r.name);
      if(!cols.includes('author'))this.db.exec('ALTER TABLE messages ADD COLUMN author TEXT');
      this.db.exec(`UPDATE messages SET author=(SELECT runs.owner FROM runs WHERE runs.id=messages.run) WHERE role='user' AND run IS NOT NULL AND author IS NULL`);
      this.db.exec('PRAGMA user_version=2; COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  // Dream output is gated on review. Rows written before the gate existed were already live,
  // so they are approved once by 'migration'; the status column marks the migration as done.
  migrateDreamReview(){
    if(this.query('PRAGMA table_info(workspace_memories)').some(c=>c.name==='status'))return;
    this.db.exec('BEGIN');
    try{
      for(const col of ['account TEXT','team TEXT','jurisdiction TEXT',"status TEXT NOT NULL DEFAULT 'proposed'",'approved_by TEXT','approved_at INTEGER','rejected_by TEXT','rejected_at INTEGER']){
        this.db.exec(`ALTER TABLE workspace_memories ADD COLUMN ${col}`);
      }
      this.write(`UPDATE workspace_memories SET status='approved',approved_by='migration',approved_at=?,
        account=CASE WHEN scope='account' THEN principal END,
        team=CASE WHEN scope='team' THEN principal END,
        jurisdiction=CASE WHEN scope='jurisdiction' THEN principal END`,Date.now());
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  // -- People -------------------------------------------------------------
  personRow(account){return account?this.one('SELECT * FROM people WHERE account=?',account):null;}
  personByEmail(email){return email?this.one('SELECT * FROM people WHERE email=?',String(email).trim().toLowerCase()):null;}
  displayName(account){
    return personName(this.personRow(account));
  }
  personPayload(account){
    const p=this.personRow(account);
    return {account,email:p?.email??null,name:this.displayName(account)};
  }
  peopleByAccount(accounts){
    const out={};
    for(const a of [...new Set(accounts||[])])if(a)out[a]=this.personPayload(a);
    return out;
  }
  touchPerson(account,email){
    if(!account)return null;
    if(!email)return this.personPayload(account);
    email=String(email).trim().toLowerCase();
    if(!email)return this.personPayload(account);
    const byEmail=this.one('SELECT * FROM people WHERE email=?',email);
    if(byEmail&&byEmail.account!==account)return this.personPayload(account);
    const now=Date.now();
    this.write('INSERT INTO people(account,email,name,first_seen,last_seen) VALUES(?,?,NULL,?,?) ON CONFLICT(account) DO UPDATE SET email=excluded.email,last_seen=excluded.last_seen',account,email,now,now);
    return this.personPayload(account);
  }
  setMyName(account,email,name){
    if(name===undefined){if(email)this.touchPerson(account,email);return this.personPayload(account);}
    const normalized=name===null?null:String(name).trim()||null;
    if(normalized&&normalized.length>80)throw fail(400,'Name must be at most 80 characters.');
    const existing=this.personRow(account),now=Date.now();
    const cleanEmail=email?String(email).trim().toLowerCase():null;
    if(existing){
      if(cleanEmail&&cleanEmail!==existing.email){
        const byEmail=this.one('SELECT * FROM people WHERE email=?',cleanEmail);
        if(byEmail&&byEmail.account!==account){this.write('UPDATE people SET name=?,last_seen=? WHERE account=?',normalized,now,account);return this.personPayload(account);}
      }
      this.write('UPDATE people SET name=?,email=COALESCE(?,email),last_seen=? WHERE account=?',normalized,cleanEmail,now,account);
    }else if(cleanEmail){
      const byEmail=this.one('SELECT * FROM people WHERE email=?',cleanEmail);
      if(!byEmail)this.write('INSERT INTO people(account,email,name,first_seen,last_seen) VALUES(?,?,?,?,?)',account,cleanEmail,normalized,now,now);
    }
    return this.personPayload(account);
  }
  searchPeople(q=''){
    q=String(q||'');
    return this.query(`SELECT * FROM people WHERE (?='' OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') ORDER BY COALESCE(name,email) LIMIT 20`,q,like(q),like(q))
      .map(p=>({account:p.account,email:p.email,name:p.name??(p.email.split('@')[0]||p.email)}));
  }

  // Aggregate totals for the public site. Only counts leave here: no account, property or message content.
  publicCounts(){
    const sites=key=>this.one("SELECT COUNT(DISTINCT p.site_key) n FROM projects p JOIN project_fields f ON f.project=p.id AND f.key=? WHERE f.value NOT IN ('null','[]','{}')",key).n;
    return {
      propertiesResearched:sites('property'),
      sitesUnderwritten:sites('proFormas'),
      sourcesCited:this.one("SELECT COALESCE(SUM(json_array_length(payload,'$.sources')),0) n FROM messages WHERE role='assistant' AND json_valid(payload)").n,
      researchRuns:this.one("SELECT COUNT(*) n FROM runs WHERE status='completed'").n,
    };
  }

  // -- Access -------------------------------------------------------------
  // Wallet rows name their research by the conversation it ran in, for the runs this account can see.
  runTitles(account,runIds){
    const titles={};
    for(const id of runIds.slice(0,100)){
      const run=this.one('SELECT r.conversation,c.title FROM runs r JOIN conversations c ON c.id=r.conversation WHERE r.id=?',id);
      if(run&&this.access(account,run.conversation)&&run.title!=='New conversation')titles[id]=run.title;
    }
    return titles;
  }
  access(account,conversationId){
    if(!account||!conversationId)return null;
    const c=this.one('SELECT owner FROM conversations WHERE id=?',conversationId);
    if(!c)return null;
    if(c.owner===account)return 'owner';
    let best=null;
    const direct=this.one(`SELECT role FROM conversation_members WHERE conversation=? AND principal_type='account' AND principal=? AND removed_at IS NULL`,conversationId,account);
    if(direct)best=direct.role;
    for(const r of this.query(`SELECT cm.role AS role FROM conversation_members cm JOIN teams t ON t.id=cm.principal JOIN team_members tm ON tm.team=cm.principal AND tm.account=? WHERE cm.conversation=? AND cm.principal_type='team' AND cm.removed_at IS NULL AND tm.removed_at IS NULL AND t.archived_at IS NULL`,account,conversationId)){
      if(!best||RANK[r.role]>RANK[best])best=r.role;
    }
    return best;
  }
  requireAccess(account,conversationId,min='viewer'){
    const a=this.access(account,conversationId);
    if(!a)throw fail(404,'Conversation not found.');
    if(RANK[a]<RANK[min])throw fail(403,min==='owner'?'Only the conversation owner can manage sharing.':'You do not have permission to do that in this conversation.');
    return a;
  }
  effectiveMembers(c){
    const map=new Map();
    const consider=(account,role,via)=>{
      if(!account||account===c.owner)return;
      const cur=map.get(account);
      if(!cur||RANK[role]>RANK[cur.role]||(RANK[role]===RANK[cur.role]&&via==='direct'))map.set(account,{account,role,via});
    };
    for(const r of this.query(`SELECT principal,role FROM conversation_members WHERE conversation=? AND principal_type='account' AND removed_at IS NULL`,c.id))consider(r.principal,r.role,'direct');
    for(const r of this.query(`SELECT cm.role AS role,tm.account AS account FROM conversation_members cm JOIN teams t ON t.id=cm.principal JOIN team_members tm ON tm.team=cm.principal WHERE cm.conversation=? AND cm.principal_type='team' AND cm.removed_at IS NULL AND tm.removed_at IS NULL AND t.archived_at IS NULL`,c.id))consider(r.account,r.role,'team');
    const others=[...map.values()].map(m=>({account:m.account,name:this.displayName(m.account),email:this.personRow(m.account)?.email??null,role:m.role,via:m.via}))
      .sort((a,b)=>a.name.localeCompare(b.name)||a.account.localeCompare(b.account));
    return [{account:c.owner,name:this.displayName(c.owner),email:this.personRow(c.owner)?.email??null,role:'owner',via:'owner'},...others];
  }
  messageRows(conversationId,{history=false}={}){
    const rows=this.query(`WITH selected AS MATERIALIZED (
      SELECT * FROM messages WHERE conversation=? ${history?"AND COALESCE(json_extract(payload,'$.error'),0)=0 ORDER BY seq DESC LIMIT 13":''}
    ) SELECT m.*,r.owner AS run_owner,r.created AS run_created,r.updated AS run_updated,p.name AS author_name,p.email AS author_email
      FROM selected m LEFT JOIN runs r ON r.id=m.run LEFT JOIN people p ON p.account=COALESCE(m.author,r.owner) ORDER BY m.seq`,conversationId);
    return rows.map(m=>{
      const author=m.role==='user'?(m.author??m.run_owner??null):null;
      const payload=JSON.parse(m.payload||'{}');
      const durationMs=m.role==='assistant'?(payload.durationMs??((m.run_created&&m.run_updated&&m.run_updated>=m.run_created)?m.run_updated-m.run_created:null)):null;
      const completedAt=m.role==='assistant'?(payload.completedAt??m.run_updated??m.created??null):null;
      return {id:m.id,role:m.role,text:m.text,runId:m.run,created:m.created,...(durationMs!==null&&durationMs!==undefined?{durationMs}:{}),...(completedAt?{completedAt}:{}),...payload,author,authorName:author?personName({name:m.author_name,email:m.author_email}):null};
    });
  }
  isMultiAuthor(conversationId,extra=null){
    const authors=new Set(this.query(`SELECT DISTINCT COALESCE(m.author,r.owner) AS author FROM messages m LEFT JOIN runs r ON r.id=m.run
      WHERE m.conversation=? AND m.role='user' AND COALESCE(m.author,r.owner,'')<>'' LIMIT 2`,conversationId).map(row=>row.author));
    if(extra)authors.add(extra);
    return authors.size>1;
  }
  harnessAuthorName(run){return this.isMultiAuthor(run.conversation,run.owner)?this.displayName(run.owner):null;}
  userRequestContext(run){
    // Historical constraints remain in the durable message store. Page only user
    // requests, bounded to this run's starting snapshot and recheck access on reads.
    this.requireAccess(run.owner,run.conversation,'participant');
    const boundary=this.one("SELECT seq FROM messages WHERE conversation=? AND run=? AND role='user' ORDER BY seq LIMIT 1",run.conversation,run.id)?.seq;
    if(!Number.isSafeInteger(boundary))throw new Error('The run has no starting user message.');
    const total=this.one("SELECT count(*) AS n FROM messages WHERE conversation=? AND role='user' AND seq<? AND COALESCE(json_extract(payload,'$.error'),0)=0",run.conversation,boundary).n;
    const read=({beforeSeq=boundary}={})=>{
      this.requireAccess(run.owner,run.conversation,'participant');
      if(!Number.isSafeInteger(beforeSeq)||beforeSeq<1)throw new Error('Use a positive integer prior-request cursor.');
      const rows=this.query(`SELECT m.seq,m.id,m.text,m.created,m.payload,COALESCE(m.author,r.owner) AS author,p.name AS author_name,p.email AS author_email
        FROM messages m LEFT JOIN runs r ON r.id=m.run LEFT JOIN people p ON p.account=COALESCE(m.author,r.owner)
        WHERE m.conversation=? AND m.role='user' AND m.seq<? AND COALESCE(json_extract(m.payload,'$.error'),0)=0 ORDER BY m.seq DESC LIMIT 9`,run.conversation,Math.min(beforeSeq,boundary));
      const page=rows.slice(0,8);
      return {reference:'prior_user_requests',total,snapshotBeforeSeq:boundary,nextBeforeSeq:rows.length>8?page.at(-1).seq:null,requests:page.reverse().map(m=>{
        const payload=JSON.parse(m.payload||'{}');
        return {id:m.id,seq:m.seq,text:m.text,author:m.author,authorName:m.author?personName({name:m.author_name,email:m.author_email}):null,created:m.created,...(payload.listingPage?{listingPage:payload.listingPage}:{})};
      })};
    };
    return {initial:read(),read,authorize:()=>this.requireAccess(run.owner,run.conversation,'participant')};
  }

  // -- Conversations ------------------------------------------------------
  // A conversation joins the project it names (viewer access is enough to start one) or starts its own.
  // A new site started from a listing records the listing's BBL at once, so the listing finds its
  // site while the first run is still identifying the parcel.
  createConversation(owner,{projectId=null,bbl=null,clientDraftId=null}={}) {
    // A repeat create from the same browser draft (a second tab's first send) returns the thread
    // the draft already opened instead of forking a duplicate.
    if(clientDraftId){
      const existing=this.one('SELECT id FROM conversations WHERE owner=? AND client_draft_id=?',owner,clientDraftId);
      if(existing)return this.conversation(owner,existing.id);
    }
    const id=randomUUID(),now=Date.now();
    if(projectId)this.requireProject(owner,projectId,'viewer');
    this.db.exec('BEGIN');
    try{
      // The owner's existing site for this lot takes the conversation: one owner, one lot, one site.
      const project=projectId||(bbl&&this.one('SELECT id FROM projects WHERE owner=? AND bbl=? AND id NOT IN (SELECT project FROM modeling_projects) ORDER BY created,id LIMIT 1',owner,bbl)?.id)||this.project.create(owner,id,'New conversation',now,bbl);
      this.write('INSERT INTO conversations(id,owner,title,property,created,updated,project,client_draft_id) VALUES(?,?,?,?,?,?,?,?)',id,owner,'New conversation',null,now,now,project,clientDraftId);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.conversation(owner,id);
  }
  projectOf(conversationId){return this.project.projectOf(conversationId);}
  conversation(account,id) {
    const access=this.access(account,id);
    if(!access)return null;
    const c=this.one('SELECT * FROM conversations WHERE id=?',id);
    const property=this.project.property(c.project)??(c.property?JSON.parse(c.property):null);
    return {id:c.id,title:c.title,projectId:c.project,property,created:c.created,updated:c.updated,
      ...(this.one('SELECT 1 FROM modeling_projects WHERE project=?',c.project)?{workflow:'modeling',site:{id:c.project,title:this.project.row(c.project).title,workflow:'modeling'}}:{}),
      owner:{account:c.owner,name:this.displayName(c.owner)},access,members:this.effectiveMembers(c),
      messages:this.messageRows(id),
      runs:this.query('SELECT id,owner,status,input,created,updated,error FROM runs WHERE conversation=? ORDER BY created',id).map(r=>({...r,authorName:this.displayName(r.owner)}))};
  }
  list(account,q='') {
    q=String(q||'');
    const rows=this.query(`WITH visible_projects(rowid) AS (
      ${VISIBLE_PROJECTS}
    ) SELECT c.id,c.title,c.owner,c.project,c.created,c.updated,
      (SELECT COALESCE(m.author,r.owner) FROM messages m LEFT JOIN runs r ON r.id=m.run WHERE m.conversation=c.id AND m.role='user' AND COALESCE(m.author,r.owner,'')<>'' ORDER BY m.seq DESC LIMIT 1) AS last_author,
      -- The site the conversation is attached to: a project with a parcel or underwriting, as the sites list counts one.
      -- One site per parcel, as that list keeps it: a conversation on a parcel's other project names the
      -- visible project with the most underwriting, then the newest.
      (SELECT json_patch(json_object('id',s.id,'title',s.title),CASE WHEN s.id IN (SELECT project FROM modeling_projects) THEN '{"workflow":"modeling"}' ELSE '{}' END) FROM projects p JOIN projects s ON s.id=COALESCE((SELECT twin.id FROM projects twin
          WHERE NULLIF(TRIM(p.bbl),'') IS NOT NULL AND twin.bbl=p.bbl AND twin.rowid IN (SELECT rowid FROM visible_projects)
            AND p.id NOT IN (SELECT project FROM modeling_projects) AND twin.id NOT IN (SELECT project FROM modeling_projects)
          ORDER BY (SELECT COUNT(*) FROM project_fields f WHERE f.project=twin.id) DESC,twin.updated DESC,twin.id DESC LIMIT 1),p.id)
        WHERE p.id=c.project AND (NULLIF(TRIM(p.bbl),'') IS NOT NULL OR EXISTS(SELECT 1 FROM project_fields f WHERE f.project=p.id))) AS site FROM conversations c
      WHERE (c.owner=?
        OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation=c.id AND cm.principal_type='account' AND cm.principal=? AND cm.removed_at IS NULL)
        OR EXISTS(SELECT 1 FROM conversation_members cm JOIN teams t ON t.id=cm.principal JOIN team_members tm ON tm.team=cm.principal AND tm.account=? WHERE cm.conversation=c.id AND cm.principal_type='team' AND cm.removed_at IS NULL AND tm.removed_at IS NULL AND t.archived_at IS NULL))
      AND (?='' OR c.title LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation=c.id AND m.text LIKE ? ESCAPE '\\')) ORDER BY c.updated DESC LIMIT 100`,
      account,account,account,account,account,account,account,q,like(q),like(q));
    if(!rows.length)return [];
    const ids=JSON.stringify(rows.map(c=>c.id));
    const summaries=new Map(this.query(`WITH members AS (
      SELECT conversation,principal AS account,role FROM conversation_members WHERE conversation IN (SELECT value FROM json_each(?)) AND principal_type='account' AND removed_at IS NULL
      UNION ALL SELECT cm.conversation,tm.account,cm.role FROM conversation_members cm JOIN teams t ON t.id=cm.principal JOIN team_members tm ON tm.team=cm.principal
        WHERE cm.conversation IN (SELECT value FROM json_each(?)) AND cm.principal_type='team' AND cm.removed_at IS NULL AND tm.removed_at IS NULL AND t.archived_at IS NULL
    ) SELECT m.conversation,COUNT(DISTINCT CASE WHEN m.account<>c.owner AND m.account<>'' THEN m.account END) AS member_count,
      MAX(CASE WHEN m.account=? THEN CASE WHEN m.role='participant' THEN 2 ELSE 1 END ELSE 0 END) AS access_rank
      FROM members m JOIN conversations c ON c.id=m.conversation GROUP BY m.conversation`,ids,ids,account).map(row=>[row.conversation,row]));
    const people=new Map(this.query('SELECT account,name,email FROM people WHERE account IN (SELECT value FROM json_each(?))',JSON.stringify([...new Set(rows.flatMap(c=>[c.owner,c.last_author]).filter(Boolean))])).map(row=>[row.account,row]));
    return rows.map(c=>{
      const summary=summaries.get(c.id);
      return {id:c.id,title:c.title,projectId:c.project,created:c.created,updated:c.updated,access:c.owner===account?'owner':([null,'viewer','participant'][summary?.access_rank??0]),
        owner:{account:c.owner,name:personName(people.get(c.owner))},memberCount:summary?.member_count??0,
        lastAuthor:c.last_author?{account:c.last_author,name:personName(people.get(c.last_author))}:null,
        site:c.site===null?null:JSON.parse(c.site)};
    });
  }

  deleteConversation(account,id,{onlyEmpty=false}={}){
    const a=this.access(account,id);
    if(!a)throw fail(404,'Conversation not found.');
    if(a!=='owner')throw fail(403,'Only the conversation owner can delete this conversation.');
    const projectTables=['project_fields','project_events','option_links','architecture_artifacts','architecture_jobs','architecture_plans','architecture_drawings','architecture_drafts'];
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const project=this.projectOf(id);
      const last=!this.one('SELECT 1 FROM conversations WHERE project=? AND id<>? LIMIT 1',project,id);
      const removeProject=last&&this.one('SELECT owner FROM projects WHERE id=?',project).owner===account&&!this.one('SELECT 1 FROM modeling_projects WHERE project=?',project);
      if(onlyEmpty){
        const content=['runs','messages','conversation_members','share_links'].some(table=>this.one(`SELECT 1 FROM ${table} WHERE conversation=? LIMIT 1`,id));
        const projectWork=removeProject&&projectTables.some(table=>this.one(`SELECT 1 FROM ${table} WHERE project=? LIMIT 1`,project));
        if(content||projectWork)throw fail(409,'This conversation contains saved work and was kept. Reopen it to check its status.');
      }else if(this.one(`SELECT id FROM runs WHERE conversation=? AND status IN ('queued','running') LIMIT 1`,id))throw fail(409,'A run is still in progress in this conversation.');
      this.write('DELETE FROM events WHERE run IN (SELECT id FROM runs WHERE conversation=?)',id);
      this.write('DELETE FROM run_evaluations WHERE run IN (SELECT id FROM runs WHERE conversation=?)',id);
      this.write('DELETE FROM messages WHERE conversation=?',id);
      this.write('DELETE FROM runs WHERE conversation=?',id);
      this.write('DELETE FROM conversation_members WHERE conversation=?',id);
      this.write('DELETE FROM share_links WHERE conversation=?',id);
      this.write('DELETE FROM conversations WHERE id=?',id);
      // Only the project owner may remove the site when its last conversation is deleted.
      if(removeProject){
        for(const table of projectTables)this.write(`DELETE FROM ${table} WHERE project=?`,project);
        this.write('DELETE FROM projects WHERE id=?',project);
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return true;
  }

  // -- Runs ---------------------------------------------------------------
  createRun(sender,conversation,input,id=randomUUID(),listingFilters=null) {
    if(listingFilters){
      if(typeof listingFilters.prompt!=='string'||!listingFilters.prompt.trim()||listingFilters.prompt.length>3000)throw fail(400,'Invalid filter prompt.');
      listingFilters={prompt:listingFilters.prompt,snapshot:validateFilterSnapshot(listingFilters.snapshot),...(listingFilters.page !== undefined ? {page:validateListingPage(listingFilters.page)} : {})};
    }
    const existingRaw=this.one('SELECT * FROM runs WHERE id=?',id);
    if(existingRaw&&existingRaw.conversation===conversation&&this.access(sender,conversation)){
      if(existingRaw.input!==input)throw fail(409,'This request ID already belongs to another request.');
      const queued=this.one('SELECT data FROM events WHERE run=? AND seq=1',id);
      const originalFilters=queued?(JSON.parse(queued.data).listingFilters??null):null;
      if(requestJson(originalFilters)!==requestJson(listingFilters))throw fail(409,'This request ID already has different filters.');
      return this.run(sender,id);
    }
    const access=this.access(sender,conversation);
    if(!access)throw fail(404,'Conversation not found.');
    if(access==='viewer')throw fail(403,'Viewers cannot send messages.');
    if(existingRaw)throw fail(409,'This request ID already belongs to another request.');
    if(this.query("SELECT id FROM runs WHERE owner=? AND created>?",sender,Date.now()-3600000).length>=30)throw new Error('You have reached 30 research requests this hour.');
    if(this.query("SELECT id FROM runs WHERE conversation=? AND status='queued'",conversation).length>=10)throw new Error('This conversation already has 10 queued messages.');
    const now=Date.now();this.write('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)',id,sender,conversation,'queued',input,null,null,now,now);
    // A bracketed page note the client put in front of the question (plan or deals page) never becomes the title.
    const title=conversationTitle(input);
    this.write('UPDATE conversations SET title=CASE WHEN title=? THEN ? ELSE title END,updated=? WHERE id=?','New conversation',title,now,conversation);
    this.write("UPDATE projects SET title=? WHERE id=? AND title='New conversation'",title,this.projectOf(conversation));
    this.event(id,'run.queued',{message:input,...(listingFilters?{listingFilters}:{})});return this.run(sender,id);
  }
  projectState(account,id){return this.access(account,id)?this.project.read(this.projectOf(id)):null;}
  // The reusable sources the project's current fields cite, with the text the citing run recorded,
  // read from the runs of the project's own chats, most cited and newest first. SQLite selects the
  // matching sources, so other source text is never parsed here. Saved knowledge is excluded, since a
  // run reads its current version from the knowledge store.
  savedSources(projectId,fields){
    const refs=savedSourceRefs(fields),runs=[...new Set(refs.flatMap(ref=>ref.runs))],urls=[...new Set(refs.map(ref=>ref.url))];
    if(!runs.length)return [];
    const list=values=>values.map(()=>'?').join(',');
    const byRun=new Map();
    for(const row of this.query(`SELECT r.id AS run,s.value AS source FROM runs r JOIN conversations c ON c.id=r.conversation JOIN json_each(r.result,'$.sources') s WHERE c.project=? AND r.result IS NOT NULL AND r.id IN (${list(runs)}) AND json_extract(s.value,'$.url') IN (${list(urls)})`,projectId,...runs,...urls)){
      if(!byRun.has(row.run))byRun.set(row.run,[]);
      byRun.get(row.run).push(JSON.parse(row.source));
    }
    return refs.flatMap(ref=>{
      const source=ref.runs.flatMap(run=>byRun.get(run)??[]).find(s=>s.url===ref.url&&s.title===ref.title&&s.fetchedAt===ref.retrievedAt&&s.kind===ref.kind&&s.verified!==false&&!s.knowledge&&s.text);
      return source?[{title:source.title,url:source.url,kind:source.kind,text:source.text,fetchedAt:source.fetchedAt,publishedDate:source.publishedDate??null,offset:source.offset??0,...(source.totalCharacters?{totalCharacters:source.totalCharacters}:{}),...(source.pdf?{pdf:source.pdf}:{}),...(source.completeJson?{completeJson:true}:{}),fields:ref.fields}]:[];
    }).sort((a,b)=>b.fields.length-a.fields.length||b.fetchedAt.localeCompare(a.fetchedAt));
  }
  runRow(id){const r=this.one('SELECT * FROM runs WHERE id=?',id);return r?{...r,result:r.result?JSON.parse(r.result):null}:null;}
  run(account,id){
    const r=this.runRow(id);if(!r)return null;
    return this.access(account,r.conversation)?r:null;
  }
  runForViewer(account,id){return this.run(account,id);}
  canControl(account,run){if(!run)return false;return run.owner===account||this.access(account,run.conversation)==='owner';}
  addMessage(conversation,run,role,text,payload={},author=null) {
    const id=randomUUID();this.write('INSERT INTO messages(id,conversation,run,role,text,payload,created,author) VALUES(?,?,?,?,?,?,?,?)',id,conversation,run,role,text,JSON.stringify(payload),Date.now(),author);return id;
  }
  begin(run,listingPage=null) {
    this.db.exec('SAVEPOINT run_begin');
    try {
      this.requireAccess(run.owner,run.conversation,'participant');
      const claimed=this.write("UPDATE runs SET status='running',updated=? WHERE id=? AND status IN ('queued','running')",Date.now(),run.id);
      if(!claimed.changes)throw new Error('Run is no longer queued.');
      // A run resumed after a restart already saved its user message on its first start.
      run.attempt=this.runAttempts(run.id)+1;
      if(run.attempt===1)this.addMessage(run.conversation,run.id,'user',run.input,listingPage ? {listingPage} : {},run.owner);
      const project=this.projectOf(run.conversation);
      const projectRow=this.project.row(project);
      run.projectSnapshot={id:project,version:projectRow.version,owner:projectRow.owner,workflow:this.one('SELECT 1 FROM modeling_projects WHERE project=?',project)?'modeling':'underwriting',fields:this.project.read(project)};
      this.db.exec('RELEASE run_begin');
    } catch(error) {this.db.exec('ROLLBACK TO run_begin; RELEASE run_begin');throw error;}
    this.event(run.id,'run.started',run.attempt>1?{attempt:run.attempt}:{});
    const messages=this.messageRows(run.conversation,{history:true});
    const multi=this.isMultiAuthor(run.conversation,run.owner);
    const recent=messages.slice(0,-1),latestPage=recent.findLastIndex(m=>m.role==='user'&&m.listingPage);
    return recent.map((m,i)=>{
      const text=m.role==='user'&&m.listingPage?`${i===latestPage?listingPageResearchContext(m.listingPage):listingPageHistoryNote(m.listingPage)}\n\n${m.text}`:m.text;
      return {role:m.role,text:multi&&m.role==='user'&&m.author?`[${m.authorName}] ${text}`:text};
    });
  }
  finish(run,status,result,error=null,partial=null) {
    let finalResult,stateEvent=null,publication=null,reportContext=null,savedKeys=[],mergeEvents=[];
    this.db.exec('SAVEPOINT run_finish');
    try {
      finalResult=result?{...result}:null;
      if(finalResult){delete finalResult.projectUpdate;delete finalResult.reportContext;}
      // A failed run whose tools finished (only its written answer was rejected) still publishes
      // what the tools produced, so their work is not lost.
      const published=finalResult||(status==='failed'&&partial?partial:null);
      // A run writes the project only when its sender may write it; a viewer's attached
      // conversation reads the shared state without changing it.
      const projectId=this.projectOf(run.conversation);
      const access=published?this.projectAccess(run.owner,projectId):null,snapshot=run.projectSnapshot;
      const liveState=published&&snapshot&&RANK[access]>=RANK.viewer?this.project.read(projectId):null;
      const contextMatches=Boolean(liveState&&snapshot.id===projectId&&reportFingerprint(snapshot.id,snapshot.fields)===reportFingerprint(projectId,liveState));
      if(published&&RANK[access]>=RANK.participant){
        const incoming=fieldsFromResult(published,run.id);
        if(!snapshot)throw new Error('A run must begin before publishing its results.');
        publication=snapshot.id===projectId?reconcileResearchFields(snapshot.fields,liveState,incoming):{fields:{},skippedFields:Object.keys(incoming),changedInputs:['project']};
        const changed=this.project.write(projectId,publication.fields,Date.now());
        const currentVersion=this.project.row(projectId).version;
        if(!finalResult)savedKeys=changed;
        if(changed.length){
          const data={projectId,version:currentVersion,keys:changed};
          this.event(run.id,'state.updated',data);
          stateEvent=this.appendProjectEvent(projectId,'state.updated',{...data,run:run.id});
        }
        if(finalResult&&publication.skippedFields.length){
          const appliedFields=[...new Set([...Object.keys(publication.fields),...changed])];
          finalResult.projectUpdate={status:appliedFields.length?'partial':'not_applied',reason:'project_changed',projectId,baseVersion:snapshot.version,currentVersion,skippedFields:publication.skippedFields,changedInputs:publication.changedInputs,appliedFields};
        }
      }
      if(finalResult)reportContext={projectId,fingerprint:contextMatches&&(publication?!publication.skippedFields.length:reportValuesMatch(liveState,finalResult))?reportFingerprint(projectId,publication?this.project.read(projectId):liveState):null};
      if(savedKeys.length)error=`${error} The results this run calculated were saved to the site.`;
      const finishedAt=Date.now(),durationMs=Math.max(0,finishedAt-(run.created||finishedAt));
      this.write('UPDATE runs SET status=?,result=?,error=?,updated=? WHERE id=?',status,finalResult?JSON.stringify(finalResult):null,error,finishedAt,run.id);
      if(finalResult)this.addMessage(run.conversation,run.id,'assistant',finalResult.answer,{sources:finalResult.sources,ui:finalResult.ui,concepts:finalResult.concepts,...(finalResult.places?.length?{places:finalResult.places}:{}),...(finalResult.market?{market:finalResult.market}:{}),...(finalResult.proFormas?.length?{proFormas:finalResult.proFormas}:{}),...(finalResult.entitlements?{entitlements:finalResult.entitlements}:{}),...(finalResult.comparisons?.length?{comparisons:finalResult.comparisons}:{}),...(finalResult.plans?.length?{plans:finalResult.plans}:{}),...(finalResult.assembly?{assembly:finalResult.assembly}:{}),...(finalResult.projectUpdate?{projectUpdate:finalResult.projectUpdate}:{}),...(finalResult.dealSearch?{dealSearch:finalResult.dealSearch}:{}),...(finalResult.dealSearches?.length?{dealSearches:finalResult.dealSearches}:{}),...(finalResult.deck?{deck:true}:{}),...(finalResult.filterContext?{filterContext:true,...(finalResult.filterUpdate?{filterUpdate:finalResult.filterUpdate}:{})}:{}),reportContext,traceId:run.id,durationMs,completedAt:finishedAt});
      else this.addMessage(run.conversation,run.id,'assistant',error||'Stopped.',{error:status==='failed',interrupted:status==='interrupted',retryText:run.input,...(savedKeys.length?{savedFields:savedKeys}:{}),traceId:run.id,durationMs,completedAt:finishedAt});
      if(published?.property&&!publication?.skippedFields.includes('property'))this.write('UPDATE conversations SET property=? WHERE id=?',JSON.stringify(published.property),run.conversation);
      if(publication)mergeEvents=this.convergeSite(projectId,run.id);
      this.write('UPDATE conversations SET updated=? WHERE id=?',finishedAt,run.conversation);
      this.event(run.id,`run.${status}`,{result:finalResult,error,traceId:run.id});
      this.db.exec('RELEASE run_finish');
    } catch (err) {
      this.db.exec('ROLLBACK TO run_finish; RELEASE run_finish');
      throw err;
    }
    if(stateEvent)this.projectFeed.emit(stateEvent.projectId,stateEvent);
    for(const event of mergeEvents)this.projectFeed.emit(event.projectId,event);
  }
  // One owner, one lot, one site. When a project's BBL matches other projects of the same owner, all
  // of them join the oldest (on a tie, one that is not the project just written): their conversations attach to it, their research folds in (newest value
  // per field) and their drawings move over; the emptied projects are removed. A merge waits while it
  // would cut in on work, a run still in flight or a plan render in a joining project, or while the two sites are not open
  // to exactly the same people in the same roles (either side's members would reach the other's work; a live
  // share link always holds it);
  // the next write or restart tries again. Returns the merged events to publish.
  convergeSite(projectId,exceptRun=null){
    const p=this.project.row(projectId);
    if(!p?.bbl||this.one('SELECT 1 FROM modeling_projects WHERE project=?',projectId))return [];
    const [target,...sources]=this.query('SELECT id FROM projects WHERE owner=? AND bbl=? AND id NOT IN (SELECT project FROM modeling_projects) ORDER BY created,id=?,id',p.owner,p.bbl,projectId).map(r=>r.id);
    // Who besides the owner can open a site: its chats' members by role, or anyone with a live share link.
    const outsideAccess=project=>this.query(`SELECT DISTINCT m.principal_type||':'||m.principal||':'||m.role AS grant FROM conversation_members m JOIN conversations c ON c.id=m.conversation
      WHERE c.project=? AND m.removed_at IS NULL UNION SELECT DISTINCT 'link' FROM share_links l JOIN conversations c ON c.id=l.conversation
      WHERE c.project=? AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>?) ORDER BY 1`,project,project,Date.now()).map(r=>r.grant).join('|');
    const sameOutsideAccess=(a,b)=>{const x=outsideAccess(a);return !x.includes('link')&&x===outsideAccess(b);};
    const events=[];
    for(const source of sources){
      const busy=this.one(`SELECT 1 FROM runs r JOIN conversations c ON c.id=r.conversation WHERE c.project=? AND r.status='running' AND r.id<>? LIMIT 1`,source,exceptRun??'')
        ||this.one(`SELECT 1 FROM architecture_jobs WHERE project=? AND status IN ('queued','running') LIMIT 1`,source)
        ||this.one(`SELECT 1 FROM architecture_drafts WHERE project=? AND status IN ('queued','running') LIMIT 1`,source);
      if(busy||!sameOutsideAccess(source,target))continue;
      events.push(this.mergeProject(source,target));
    }
    return events;
  }
  // Two sites that both hold plan revisions under one scheme collide on UNIQUE(project,scheme,revision)
  // when rows simply move over. Renumber both histories as one timeline ordered by save time, keeping
  // each plan's parent chain and remapping the revision its jobs, artifacts and drafts are bound to.
  mergePlanRevisions(source,target){
    const tableExists=name=>this.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",name);
    if(!tableExists('architecture_plans'))return;
    for(const {scheme} of this.query('SELECT DISTINCT scheme FROM architecture_plans WHERE project IN (?,?)',source,target)){
      const rows=this.query('SELECT project,plan_id,revision,parent_revision,created_at FROM architecture_plans WHERE project IN (?,?) AND scheme=? ORDER BY created_at,project,revision',source,target,scheme);
      if(!rows.some(r=>r.project===source)||!rows.some(r=>r.project===target))continue;
      const map=new Map(rows.map((r,i)=>[`${r.project}|${r.plan_id}|${r.revision}`,i+1]));
      const key=r=>`${r.project}|${r.plan_id}|${r.revision}`;
      for(const table of ['architecture_jobs','architecture_artifacts','architecture_drafts']){
        if(!tableExists(table))continue;
        for(const r of this.query(`SELECT project,plan_id,revision FROM ${table} WHERE project IN (?,?) AND plan_id IS NOT NULL AND revision IS NOT NULL`,source,target)){
          const next=map.get(key(r));if(next===undefined)continue;
          this.write(`UPDATE ${table} SET revision=? WHERE project=? AND plan_id=? AND revision=?`,-next,r.project,r.plan_id,r.revision);
        }
      }
      for(const r of rows){
        const next=map.get(key(r)),mapped=r.parent_revision==null?null:map.get(`${r.project}|${r.plan_id}|${r.parent_revision}`),parent=mapped==null?null:-mapped;
        this.write('UPDATE architecture_plans SET revision=?,parent_revision=? WHERE project=? AND plan_id=? AND revision=?',-next,parent,r.project,r.plan_id,r.revision);
      }
      for(const table of ['architecture_plans','architecture_jobs','architecture_artifacts','architecture_drafts']){
        if(!tableExists(table))continue;
        this.write(`UPDATE ${table} SET revision=-revision WHERE project IN (?,?) AND revision<0`,source,target);
      }
      this.write('UPDATE architecture_plans SET parent_revision=-parent_revision WHERE project IN (?,?) AND parent_revision<0',source,target);
    }
  }
  mergeProject(source,target){
    const at=Date.now(),conversations=this.query('SELECT id FROM conversations WHERE project=?',source).map(r=>r.id);
    this.db.exec('SAVEPOINT project_merge');
    try{
      this.mergePlanRevisions(source,target);
      const keys=this.project.mergeFields(source,target,at);
      for(const table of ['conversations','architecture_plans','architecture_jobs','architecture_artifacts','architecture_drawings','architecture_drafts','option_links'])this.write(`UPDATE ${table} SET project=? WHERE project=?`,target,source);
      if(this.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alert_rules'"))this.write('UPDATE alert_rules SET project=? WHERE project=?',target,source);
      if(this.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='listing_investigations'"))this.write("UPDATE listing_investigations SET data=json_set(data,'$.projectId',?) WHERE json_extract(data,'$.projectId')=?",target,source);
      this.write('UPDATE projects SET updated=MAX(updated,(SELECT updated FROM projects WHERE id=?)) WHERE id=?',source,target);
      // The joining site's history stays with the target, outside the live feed its subscribers replay.
      this.write('INSERT INTO project_event_archive(project,from_project,seq,event,data,time) SELECT ?,project,seq,event,data,time FROM project_events WHERE project=?',target,source);
      for(const table of ['project_fields','project_events'])this.write(`DELETE FROM ${table} WHERE project=?`,source);
      this.project.recordAlias(source,target,at);
      this.write('DELETE FROM projects WHERE id=?',source);
      const event=this.appendProjectEvent(target,'site.merged',{projectId:target,from:source,conversations,keys,version:this.project.row(target).version});
      this.db.exec('RELEASE project_merge');
      return event;
    }catch(e){this.db.exec('ROLLBACK TO project_merge; RELEASE project_merge');throw e;}
  }
  event(run,event,data) {
    this.seqByRun??=new Map();
    let prevSeq=this.seqByRun.get(run);
    if(prevSeq===undefined){
      prevSeq=Number(this.one('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE run=?',run).seq);
    }
    const seq=prevSeq+1;
    this.seqByRun.set(run,seq);
    const now=Date.now();
    const safe=safeTrace(data);
    const liveRecord={seq,event,time:now,...safe};
    // Published sequence IDs are immutable: replay after any delivered chunk must
    // contain only subsequent text, including when lanes interleave their messages.
    if(event!=='message.delta')appendRunTraceEvent(this.traceDir,run,liveRecord);
    this.write('INSERT INTO events VALUES(?,?,?,?,?)',run,seq,event,JSON.stringify(liveRecord),now);
    return liveRecord;
  }
  runEvents(id,after=0){return this.query('SELECT data FROM events WHERE run=? AND seq>? ORDER BY seq',id,after).map(r=>JSON.parse(r.data));}
  runEventPage(id,after,limit=32){return this.query('SELECT data FROM events WHERE run=? AND seq>? ORDER BY seq LIMIT ?',id,after,limit).map(r=>JSON.parse(r.data));}
  runStatus(account,id){const row=this.one('SELECT id,owner,conversation,status,error,created,updated FROM runs WHERE id=?',id);return row&&this.access(account,row.conversation)?row:null;}
  events(account,id,after=0) {if(!this.run(account,id))return null;return this.runEvents(id,after);}
  exportTrace(id){
    const run=this.runRow(id);
    if(!run)return null;
    const events=this.runEvents(id);
    const evaluation=this.getEvaluation(id);
    const traceFile=join(this.traceDir,`${id}.jsonl`);
    return {run,events,evaluation,traceFile};
  }
  syncTraceFiles(){
    mkdirSync(this.traceDir,{recursive:true,mode:0o700});
    const runs=this.query('SELECT id FROM runs ORDER BY created ASC');
    let synced=0;
    for(const {id} of runs){
      const traceFile=join(this.traceDir,`${id}.jsonl`);
      if(existsSync(traceFile))continue;
      const events=this.runEvents(id).filter(e=>e.event!=='message.delta');
      if(!events.length)continue;
      const content=events.map(rec=>JSON.stringify({traceId:id,isoTime:new Date(rec.time||Date.now()).toISOString(),...rec})).join('\n')+'\n';
      writeFileSync(traceFile,content,{mode:0o600});
      synced++;
    }
    return {synced,totalRuns:runs.length,traceDir:this.traceDir};
  }
  runAttempts(id){return this.one("SELECT count(*) AS n FROM events WHERE run=? AND event='run.started'",id).n;}
  // A run a restart cut off is queued again from its persisted input, ahead of later messages in its
  // conversation. It fails instead when a restart already cut it off once, or when a paid provider
  // call it made has not settled: that hold waits for reconciliation and the call is never
  // repeated automatically (docs/BILLING.md).
  recover() {
    for(const r of this.query("SELECT * FROM runs WHERE status='running'")){
      const attempts=this.runAttempts(r.id);
      const unresolved=this.one(`SELECT SUM(event='billing.invoked')-SUM(event='billing.settled') AS n FROM events WHERE run=?`,r.id).n>0;
      if(attempts>=RUN_ATTEMPTS||unresolved){this.finish(r,'failed',null,attempts>=RUN_ATTEMPTS?'The research server restarted twice during this request. Retry this message.':'The research server restarted. Retry this message.');continue;}
      this.write("UPDATE runs SET status='queued',updated=? WHERE id=?",Date.now(),r.id);
      this.event(r.id,'run.requeued',{attempt:attempts+1,status:'Resumed after a server restart.'});
    }
  }
  close(){this.db.close();}

  // -- Projects -----------------------------------------------------------
  // The project owner owns it; grants on the owner's attached conversations carry over as they are,
  // and any access to any other attached conversation gives read access only.
  projectAccess(account,projectId){
    const p=projectId?this.project.row(projectId):null;
    if(!p||!account)return null;
    if(p.owner===account)return 'owner';
    let best=null;
    for(const c of this.query('SELECT id,owner FROM conversations WHERE project=?',projectId)){
      const a=this.access(account,c.id);if(!a)continue;
      const role=c.owner===p.owner?a:'viewer';
      if(!best||RANK[role]>RANK[best])best=role;
    }
    return best;
  }
  canReadProject(account,projectId){
    if(!account||!projectId)return false;
    return Boolean(this.one(`SELECT 1 FROM projects p WHERE p.id=? AND (p.owner=? OR ${PROJECT_VISIBLE})`,projectId,account,account,account,account));
  }
  requireProject(account,projectId,min='viewer'){
    const a=this.projectAccess(account,projectId);
    if(!a)throw fail(404,'Project not found.');
    if(RANK[a]<RANK[min])throw fail(403,'You do not have permission to change this project.');
    return a;
  }
  // The project and every state field (null parts for fields not produced yet).
  createModel(account,address,title=address,bbl=null){
    if(bbl!==null&&!/^\d{10}$/.test(bbl))throw fail(400,'Choose the property address from the New York City suggestions so the model links to its parcel.');
    const now=Date.now();
    this.db.exec('SAVEPOINT create_model');
    try{
      const id=this.project.create(account,randomUUID(),title,now);
      this.write('INSERT INTO modeling_projects(project) VALUES(?)',id);
      this.project.write(id,{property:{value:{address,...(bbl?{bbl}:{})},provenance:{tool:'user',account,at:new Date(now).toISOString(),sources:[]}}},now);
      if(bbl)this.write('UPDATE projects SET bbl=? WHERE id=?',bbl,id);
      // The name can differ from the address; setting the subject must not replace it here.
      this.write('UPDATE projects SET title=? WHERE id=?',title,id);
      this.appendProjectEvent(id,'model.created',{projectId:id,account,title,address});
      this.db.exec('RELEASE create_model');
      return this.projectView(account,id);
    }catch(error){this.db.exec('ROLLBACK TO create_model');this.db.exec('RELEASE create_model');throw error;}
  }
  renameModel(account,projectId,{version,title}={}){
    this.requireProject(account,projectId,'participant');
    if(!this.one('SELECT 1 FROM modeling_projects WHERE project=?',projectId))throw fail(404,'Model not found.');
    if(typeof title!=='string'||!title.trim()||title.trim().length>200)throw fail(400,'Name the modeling project using 1 to 200 characters.');
    title=title.trim();
    this.commitProjectWrite(projectId,()=>{
      const project=this.project.row(projectId);
      if(version!==project.version)throw Object.assign(fail(409,'The project changed since you read it. Reload and apply your edit again.'),{version:project.version});
      if(title===project.title)return [];
      this.write('UPDATE projects SET title=?,version=version+1,updated=? WHERE id=?',title,Date.now(),projectId);
      this.appendProjectEvent(projectId,'model.renamed',{projectId,version:project.version+1,account,title});
      return ['title'];
    });
    return this.projectView(account,projectId);
  }
  projectView(account,projectId){
    const access=this.projectAccess(account,projectId);
    if(!access){
      const into=this.project.resolveAlias(projectId);
      if(into&&into!==projectId){const view=this.projectView(account,into);return view?{...view,mergedFrom:projectId}:null;}
      return null;
    }
    const p=this.project.row(projectId),state=this.project.read(projectId);
    const empty={value:null,provenance:null,stale:null,updated:null};
    return {id:p.id,siteKey:p.site_key,bbl:p.bbl,title:p.title,workflow:this.one('SELECT 1 FROM modeling_projects WHERE project=?',p.id)?'modeling':'underwriting',owner:{account:p.owner,name:this.displayName(p.owner)},access,version:p.version,created:p.created,updated:p.updated,
      fields:Object.fromEntries([...new Set([...Object.keys(fullGraph),...Object.keys(state)])].map(key=>[key,state[key]??empty]))};
  }
  // How long runs of the same request usually take, from run start to finish: the median of the
  // latest completed runs whose request opens the same way (the page's buttons send fixed wording)
  // and that saved results to their site, so a run that only asked a question back does not count.
  // Null until there are enough of them to say.
  typicalRunMs(input){
    const durations=this.query(`SELECT r.updated-(SELECT e.time FROM events e WHERE e.run=r.id AND e.event='run.started' ORDER BY e.seq DESC LIMIT 1) AS ms FROM runs r
      WHERE r.status='completed' AND substr(r.input,1,48)=substr(?,1,48) AND EXISTS(SELECT 1 FROM events s WHERE s.run=r.id AND s.event='state.updated')
      ORDER BY r.updated DESC LIMIT 5`,String(input||'')).map(r=>r.ms).filter(ms=>Number.isFinite(ms)&&ms>0).sort((a,b)=>a-b);
    return durations.length>=3?durations[Math.floor(durations.length/2)]:null;
  }
  // The account's research on sites still queued or running, newest first: the pending jobs the app
  // keeps in view wherever the user goes. A site has a parcel or saved fields, as in Sites. step is
  // the one a running job is working on, read from the tools it has started. A queued job says what
  // it waits for: an earlier run in its own conversation, or a free slot (queueAhead runs before it).
  // Jobs that ended in the last half hour follow, so a person who left the page sees them finish.
  activeSiteRuns(account,now=Date.now()){
    return this.query(`SELECT r.id,r.status,r.created,r.updated,r.input,r.conversation,p.id AS project,p.title,p.bbl,EXISTS(SELECT 1 FROM modeling_projects m WHERE m.project=p.id) AS modeling FROM runs r
      JOIN conversations c ON c.id=r.conversation JOIN projects p ON p.id=c.project
      WHERE r.owner=? AND (r.status IN ('queued','running') OR (r.status IN ('completed','failed','interrupted') AND r.updated>?))
        AND (NULLIF(TRIM(p.bbl),'') IS NOT NULL OR EXISTS(SELECT 1 FROM project_fields f WHERE f.project=p.id))
      ORDER BY r.created DESC LIMIT 20`,account,now-ENDED_JOB_MS)
      .map(r=>{
        const state={fields:this.project.read(r.project)};
        const base={id:r.id,status:r.status,created:r.created,conversationId:r.conversation,projectId:r.project,title:r.title,bbl:r.bbl,progress:siteProgress(state),...(r.modeling?{workflow:'modeling'}:{})};
        if(r.status!=='queued'&&r.status!=='running')return {...base,endedAt:r.updated};
        // A specialist tool runs through the capability gateway; its step is the capability's.
        const tools=this.query("SELECT CASE json_extract(data,'$.tool') WHEN 'acres_execute_capability' THEN json_extract(data,'$.arguments.name') ELSE json_extract(data,'$.tool') END AS tool FROM events WHERE run=? AND event='tool.started' ORDER BY seq",r.id).map(e=>e.tool);
        const startedAt=r.status==='running'?this.one("SELECT time FROM events WHERE run=? AND event='run.started' ORDER BY seq DESC LIMIT 1",r.id)?.time??null:null;
        const queue=r.status==='queued'?{waitingFor:this.one("SELECT 1 FROM runs WHERE conversation=? AND status='running'",r.conversation)?'run':'slot',queueAhead:this.one("SELECT count(*) AS n FROM runs WHERE status='queued' AND created<?",r.created).n}:{};
        return {...base,step:r.status==='running'&&!r.modeling?runStep(state,tools):null,startedAt,typicalMs:this.typicalRunMs(r.input),...queue};
      });
  }
  listProjects(account,q=''){
    return this.projectPage(account,{q}).projects;
  }
  projectPage(account,{q='',cursor=null,sitesOnly=false,modelsOnly=false,legacyModelsOnly=false,modelingLibrary=false}={}){
    q=String(q||'');
    let position=null;
    if(cursor!==null){
      const match=typeof cursor==='string'&&cursor.match(/^(\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
      if(!match||!Number.isSafeInteger(Number(match[1])))throw fail(400,'Invalid site page cursor.');
      position={updated:Number(match[1]),id:match[2]};
    }
    const rows=this.query(`WITH visible_projects(rowid) AS (
      ${VISIBLE_PROJECTS}
    ), selected_projects AS MATERIALIZED (
      SELECT p.id,p.updated FROM projects p
      WHERE p.rowid IN (SELECT rowid FROM visible_projects) AND (?='' OR p.title LIKE ? ESCAPE '\\' OR p.site_key LIKE ? ESCAPE '\\' OR p.bbl LIKE ? ESCAPE '\\')
      ${sitesOnly?"AND p.id NOT IN (SELECT project FROM modeling_projects) AND (NULLIF(TRIM(p.bbl),'') IS NOT NULL OR EXISTS(SELECT 1 FROM project_fields site_field WHERE site_field.project=p.id))":''}
      ${modelsOnly?'AND p.id IN (SELECT project FROM modeling_projects)':''}
      ${legacyModelsOnly?"AND p.id NOT IN (SELECT project FROM modeling_projects) AND EXISTS(SELECT 1 FROM project_fields model_field WHERE model_field.project=p.id AND model_field.key IN ('architecture','concepts') AND model_field.value NOT IN ('null','[]'))":''}
      ${modelingLibrary?"AND (p.id IN (SELECT project FROM modeling_projects) OR EXISTS(SELECT 1 FROM project_fields model_field WHERE model_field.project=p.id AND model_field.key IN ('architecture','concepts') AND model_field.value NOT IN ('null','[]')))":''}
      -- One site per parcel: conversations started apart can each resolve the same BBL, so the list
      -- keeps the visible project with the most underwriting (then the newest) and hides the rest.
      AND (${modelsOnly||legacyModelsOnly||modelingLibrary?'1':'0'}=1 OR p.id IN (SELECT project FROM modeling_projects) OR NULLIF(TRIM(p.bbl),'') IS NULL OR NOT EXISTS(SELECT 1 FROM projects twin
        WHERE twin.rowid IN (SELECT rowid FROM visible_projects) AND twin.bbl=p.bbl AND twin.id<>p.id
          AND twin.id NOT IN (SELECT project FROM modeling_projects)
          AND ((SELECT COUNT(*) FROM project_fields f WHERE f.project=twin.id),twin.updated,twin.id)>((SELECT COUNT(*) FROM project_fields f WHERE f.project=p.id),p.updated,p.id)))
      ${position?'AND (p.updated < ? OR (p.updated = ? AND p.id < ?))':''} ORDER BY p.updated DESC,p.id DESC LIMIT 101
    ) SELECT p.*,(p.id IN (SELECT project FROM modeling_projects)) AS is_modeling,(SELECT MIN(r.created) FROM runs r JOIN conversations c ON c.id=r.conversation WHERE c.project=p.id AND r.status IN ('queued','running')) AS running,
      (SELECT COUNT(*) FROM conversations c WHERE c.project=p.id) AS conversations FROM projects p
      JOIN selected_projects selected ON selected.id=p.id ORDER BY selected.updated DESC,selected.id DESC`,
      account,account,account,account,q,like(q),like(q),like(q),...(position?[position.updated,position.updated,position.id]:[]));
    return {projects:rows.slice(0,100).map(p=>({progress:siteProgress({fields:this.project.read(p.id)}),running:p.running??null,id:p.id,siteKey:p.site_key,bbl:p.bbl,modeling:Boolean(p.is_modeling),title:p.title,owner:{account:p.owner,name:this.displayName(p.owner)},access:this.projectAccess(account,p.id),version:p.version,updated:p.updated,conversationCount:p.conversations})),
      nextCursor:rows.length>100?`${rows[99].updated}:${rows[99].id}`:null};
  }
  // A user edit of the user-owned keys, guarded by the version the editor last read.
  updateProjectState(account,projectId,{version,fields}={}){
    this.requireProject(account,projectId,'participant');
    const current=this.project.row(projectId).version;
    if(version!==current)throw Object.assign(fail(409,'The project changed since you read it. Reload and apply your edit again.'),{version:current});
    const at=Date.now();
    let stateEvent=null;
    this.db.exec('SAVEPOINT project_edit');
    try{
      const changed=this.project.write(projectId,userFields(fields,account,at),at,(state,changed,prior)=>({...deriveProFormas(state,changed,null,prior),...deriveKeep(state,changed)}));
      if(changed.length)stateEvent=this.appendProjectEvent(projectId,'state.updated',{projectId,version:this.project.row(projectId).version,keys:changed,account});
      this.db.exec('RELEASE project_edit');
    }catch(e){this.db.exec('ROLLBACK TO project_edit; RELEASE project_edit');throw e;}
    if(stateEvent)this.projectFeed.emit(projectId,stateEvent);
    return this.projectView(account,projectId);
  }
  // The site's three schemes recomputed from its deal valuation (MarketStore.lotValuation), saved when
  // they changed; the parts other features drew stay with a scheme that is still the same building.
  refreshSchemes(projectId,lot){
    const state=this.project.read(projectId),v=lot.valuation;
    const value={
      schemes:buildSchemes({candidates:v.candidates,concepts:state.concepts?.value||[],prior:state.schemes?.value?.schemes||[]}),
      basis:{source:lot.source,listingId:lot.listingId,ask:lot.ask,askFrom:lot.askFrom,dealVerdict:v.dealVerdict,priceVerdict:v.priceVerdict??null,dealTierBasis:v.dealTierBasis??null,
        gates:(v.gates||[]).map(g=>({id:g.id,severity:g.severity,label:g.label})),infeasible:v.infeasibleAtTarget,
        nearbyLand:lot.nearbyLand??null,
        subsidized:v.subsidizedRental?{landValue:v.subsidizedRental.landValue,units:v.subsidizedRental.units,amiPct:v.subsidizedRental.amiPct,subsidyPerUnit:v.subsidizedRental.subsidyPerUnit,taxCreditEquity:v.subsidizedRental.taxCreditEquity,capped:v.subsidizedRental.capped}:null},
    };
    this.commitProjectWrite(projectId,()=>this.project.write(projectId,{schemes:{value,provenance:{tool:'schemes',source:lot.source,listingId:lot.listingId,sources:[]}}}));
    return this.schemesView(projectId);
  }
  // Another feature's part of one scheme: plan, budget or render (see project-state.mjs).
  setSchemePart(projectId,schemeId,part,value){
    this.commitProjectWrite(projectId,()=>this.project.setSchemePart(projectId,schemeId,part,value));
    return this.schemesView(projectId);
  }
  schemesView(projectId){
    const field=this.project.read(projectId).schemes;
    return {projectId,version:this.project.row(projectId).version,schemes:field?.value.schemes??null,basis:field?.value.basis??null,stale:field?.stale??null,updated:field?.updated??null};
  }
  commitProjectWrite(projectId,write){
    let stateEvent=null;
    this.db.exec('SAVEPOINT project_derive');
    try{
      const changed=write();
      if(changed.length)stateEvent=this.appendProjectEvent(projectId,'state.updated',{projectId,version:this.project.row(projectId).version,keys:changed});
      this.db.exec('RELEASE project_derive');
    }catch(e){this.db.exec('ROLLBACK TO project_derive; RELEASE project_derive');throw e;}
    if(stateEvent)this.projectFeed.emit(projectId,stateEvent);
  }
  appendProjectEvent(projectId,event,data){
    const seq=Number(this.one('SELECT COALESCE(MAX(seq),0) AS seq FROM project_events WHERE project=?',projectId).seq)+1;
    const now=Date.now(),record={seq,event,time:now,...data};
    this.write('INSERT INTO project_events VALUES(?,?,?,?,?)',projectId,seq,event,JSON.stringify(record),now);
    return record;
  }
  projectEvents(projectId,after=0){return this.query('SELECT data FROM project_events WHERE project=? AND seq>? ORDER BY seq',projectId,after).map(r=>JSON.parse(r.data));}
  projectEventPage(projectId,after,limit=32){return this.query('SELECT data FROM project_events WHERE project=? AND seq>? ORDER BY seq LIMIT ?',projectId,after,limit).map(r=>JSON.parse(r.data));}

  // -- Members / grants ---------------------------------------------------
  listGrants(conversationId){
    return this.query('SELECT * FROM conversation_members WHERE conversation=? AND removed_at IS NULL ORDER BY added_at,principal_type,principal',conversationId).map(r=>{
      const isAccount=r.principal_type==='account';
      const team=isAccount?null:this.one('SELECT name FROM teams WHERE id=?',r.principal);
      return {principalType:r.principal_type,principal:r.principal,role:r.role,
        name:isAccount?this.displayName(r.principal):(team?.name??'A team'),
        email:isAccount?(this.personRow(r.principal)?.email??null):null,
        addedBy:r.added_by,addedAt:r.added_at};
    });
  }
  grantEntry(conversationId,principalType,principal){return this.listGrants(conversationId).find(g=>g.principalType===principalType&&g.principal===principal)||null;}
  grantMember(owner,conversationId,principalType,principal,role,inviteeEmail){
    this.requireAccess(owner,conversationId,'owner');
    if(!['account','team'].includes(principalType))throw fail(400,'Invalid member type.');
    if(!['viewer','participant'].includes(role))throw fail(400,'Role must be viewer or participant.');
    if(typeof principal!=='string'||!principal)throw fail(400,'A member is required.');
    const conv=this.one('SELECT * FROM conversations WHERE id=?',conversationId),now=Date.now();
    if(principalType==='account'&&principal===conv.owner){
      return {principalType,principal,role:'owner',name:this.displayName(principal),email:this.personRow(principal)?.email??null,addedBy:owner,addedAt:now};
    }
    if(principalType==='team'){
      const t=this.one('SELECT * FROM teams WHERE id=?',principal);
      if(!t||t.archived_at)throw fail(404,'Team not found.');
    }else if(inviteeEmail)this.touchPerson(principal,inviteeEmail);
    this.write(`INSERT INTO conversation_members(conversation,principal_type,principal,role,added_by,added_at,removed_at) VALUES(?,?,?,?,?,?,NULL)
      ON CONFLICT(conversation,principal_type,principal) DO UPDATE SET role=excluded.role,added_by=excluded.added_by,added_at=excluded.added_at,removed_at=NULL`,
      conversationId,principalType,principal,role,owner,now);
    return this.grantEntry(conversationId,principalType,principal);
  }
  setGrantRole(owner,conversationId,principalType,principal,role){
    this.requireAccess(owner,conversationId,'owner');
    if(!['viewer','participant'].includes(role))throw fail(400,'Role must be viewer or participant.');
    const res=this.write('UPDATE conversation_members SET role=? WHERE conversation=? AND principal_type=? AND principal=? AND removed_at IS NULL',role,conversationId,principalType,principal);
    if(!res.changes)throw fail(404,'Member not found.');
    return this.grantEntry(conversationId,principalType,principal);
  }
  removeGrant(owner,conversationId,principalType,principal){
    this.requireAccess(owner,conversationId,'owner');
    this.write('UPDATE conversation_members SET removed_at=? WHERE conversation=? AND principal_type=? AND principal=? AND removed_at IS NULL',Date.now(),conversationId,principalType,principal);
    return true;
  }

  // -- Share links --------------------------------------------------------
  createLink(owner,conversationId,expiresAt=null){
    this.requireAccess(owner,conversationId,'owner');
    if(expiresAt!==null&&expiresAt!==undefined&&!(typeof expiresAt==='number'&&Number.isFinite(expiresAt)))throw fail(400,'Invalid link expiry.');
    const token=randomBytes(32).toString('base64url'),exp=expiresAt??null;
    this.write('INSERT INTO share_links(conversation,token,role,created_by,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)',conversationId,token,'viewer',owner,exp);
    return {token,role:'viewer',expiresAt:exp,path:`/shared/${token}`,conversationId};
  }
  listLinks(owner,conversationId){
    this.requireAccess(owner,conversationId,'owner');
    return this.query('SELECT * FROM share_links WHERE conversation=? ORDER BY rowid DESC',conversationId).map(r=>({
      token:r.token,role:r.role,createdBy:{account:r.created_by,name:this.displayName(r.created_by)},createdByName:this.displayName(r.created_by),
      expiresAt:r.expires_at,revokedAt:r.revoked_at,revoked:!!r.revoked_at,path:`/shared/${r.token}`}));
  }
  revokeLink(owner,conversationId,token){
    this.requireAccess(owner,conversationId,'owner');
    if(!this.one('SELECT token FROM share_links WHERE conversation=? AND token=?',conversationId,token))throw fail(404,'Share link not found.');
    this.write('UPDATE share_links SET revoked_at=? WHERE conversation=? AND token=? AND revoked_at IS NULL',Date.now(),conversationId,token);
    return true;
  }
  claimLink(account,token){
    const link=this.one('SELECT * FROM share_links WHERE token=?',token),now=Date.now();
    if(!link||link.revoked_at||(link.expires_at!==null&&link.expires_at<now))return null;
    const conv=this.one('SELECT * FROM conversations WHERE id=?',link.conversation);
    if(!conv)return null;
    if(account!==conv.owner){
      const direct=this.one(`SELECT * FROM conversation_members WHERE conversation=? AND principal_type='account' AND principal=?`,conv.id,account);
      if(!direct)this.write('INSERT INTO conversation_members(conversation,principal_type,principal,role,added_by,added_at,removed_at) VALUES(?,?,?,?,?,?,NULL)',conv.id,'account',account,'viewer',link.created_by,now);
      else if(direct.removed_at)this.write(`UPDATE conversation_members SET role='viewer',added_by=?,added_at=?,removed_at=NULL WHERE conversation=? AND principal_type='account' AND principal=?`,link.created_by,now,conv.id,account);
    }
    return {conversationId:conv.id,access:this.access(account,conv.id)};
  }

  // -- Option links -------------------------------------------------------
  // One of a site's options sent to an architect or contractor: a copy of the option as it stood,
  // opened by its token at /api/public/options/<token>. Only the site owner sends or withdraws one, as
  // only an owner makes share links; tokens are never listed, so withdrawing takes every link to an option.
  createOptionLink(account,projectId,schemeId){
    const access=this.projectAccess(account,projectId);
    if(!access)throw fail(404,'Project not found.');
    if(access!=='owner')throw fail(403,'Only the site owner can send an option.');
    const state=this.project.read(projectId),field=state.schemes,scheme=field?.value.schemes.find(s=>s.id===schemeId);
    if(!scheme?.program)throw fail(404,'Option not found.');
    const p=this.project.row(projectId),at=Date.now(),token=randomBytes(32).toString('base64url');
    const snapshot=optionSnapshot({scheme,basis:field.value.basis,concepts:state.concepts?.value||[],at,
      site:{address:state.property?.value?.address||p.title,bbl:p.bbl},sender:{name:this.displayName(account)}});
    this.db.exec('SAVEPOINT option_link');
    let event;
    try{
      this.write('INSERT INTO option_links(token,project,scheme,snapshot,created_by,created_at,revoked_at) VALUES(?,?,?,?,?,?,NULL)',token,projectId,schemeId,JSON.stringify(snapshot),account,at);
      event=this.appendProjectEvent(projectId,'option.sent',{projectId,scheme:schemeId,label:scheme.label,account,name:snapshot.sender.name});
      this.db.exec('RELEASE option_link');
    }catch(e){this.db.exec('ROLLBACK TO option_link; RELEASE option_link');throw e;}
    this.projectFeed.emit(projectId,event);
    return {token,path:`/api/public/options/${token}`,createdAt:at,option:snapshot};
  }
  withdrawOptionLinks(account,projectId,schemeId){
    const access=this.projectAccess(account,projectId);
    if(!access)throw fail(404,'Project not found.');
    if(access!=='owner')throw fail(403,'Only the site owner can withdraw a sent option.');
    const {changes}=this.write('UPDATE option_links SET revoked_at=? WHERE project=? AND scheme=? AND revoked_at IS NULL',Date.now(),projectId,schemeId);
    if(changes){
      const event=this.appendProjectEvent(projectId,'option.withdrawn',{projectId,scheme:schemeId,account,name:this.displayName(account),links:Number(changes)});
      this.projectFeed.emit(projectId,event);
    }
    return {withdrawn:Number(changes)};
  }
  optionLink(token){
    const row=this.one('SELECT * FROM option_links WHERE token=? AND revoked_at IS NULL',token);
    return row?{project:row.project,...JSON.parse(row.snapshot)}:null;
  }
  // Whether the reader may send the site's options, and each option's latest send.
  optionSends(account,projectId){
    const rows=this.query('SELECT scheme,MAX(created_at) AS at,created_by FROM option_links WHERE project=? AND revoked_at IS NULL GROUP BY scheme',projectId);
    return {canSend:this.projectAccess(account,projectId)==='owner',sent:Object.fromEntries(rows.map(r=>[r.scheme,{at:r.at,by:this.displayName(r.created_by)}]))};
  }

  // -- Teams --------------------------------------------------------------
  teamRowRaw(id){return this.one('SELECT * FROM teams WHERE id=?',id);}
  isTeamMember(account,id){return !!this.one('SELECT account FROM team_members WHERE team=? AND account=? AND removed_at IS NULL',id,account);}
  requireTeam(account,id,ownerOnly=false){
    const t=this.teamRowRaw(id);
    if(!t||t.archived_at)throw fail(404,'Team not found.');
    const isOwner=t.owner===account;
    if(!isOwner&&!this.isTeamMember(account,id))throw fail(404,'Team not found.');
    if(ownerOnly&&!isOwner)throw fail(403,'Only the team owner can manage this team.');
    return t;
  }
  teamPayload(t,account){
    const members=this.query('SELECT * FROM team_members WHERE team=? AND removed_at IS NULL ORDER BY CASE WHEN role=\'owner\' THEN 0 ELSE 1 END,added_at,account',t.id)
      .map(m=>({account:m.account,name:this.displayName(m.account),email:this.personRow(m.account)?.email??null,role:m.role,addedAt:m.added_at}));
    return {id:t.id,name:t.name,owner:{account:t.owner,name:this.displayName(t.owner)},role:t.owner===account?'owner':'member',memberCount:members.length,created:t.created,members};
  }
  createTeam(owner,name){
    name=typeof name==='string'?name.trim():'';
    if(!name||name.length>80)throw fail(400,'Team name must be 1 to 80 characters.');
    const id=randomUUID(),now=Date.now();
    this.db.exec('BEGIN');
    try{
      this.write('INSERT INTO teams(id,name,owner,created,archived_at) VALUES(?,?,?,?,NULL)',id,name,owner,now);
      this.write('INSERT INTO team_members(team,account,role,added_by,added_at,removed_at) VALUES(?,?,?,?,?,NULL)',id,owner,'owner',owner,now);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.team(owner,id);
  }
  listTeams(account){
    return this.query(`SELECT t.* FROM teams t WHERE t.archived_at IS NULL AND (t.owner=? OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.team=t.id AND tm.account=? AND tm.removed_at IS NULL)) ORDER BY t.name COLLATE NOCASE`,account,account)
      .map(t=>{const {members,...rest}=this.teamPayload(t,account);return rest;});
  }
  team(account,id){
    const t=this.teamRowRaw(id);
    if(!t||t.archived_at)return null;
    if(t.owner!==account&&!this.isTeamMember(account,id))return null;
    return this.teamPayload(t,account);
  }
  renameTeam(owner,id,name){
    this.requireTeam(owner,id,true);
    name=typeof name==='string'?name.trim():'';
    if(!name||name.length>80)throw fail(400,'Team name must be 1 to 80 characters.');
    this.write('UPDATE teams SET name=? WHERE id=?',name,id);
    return this.team(owner,id);
  }
  archiveTeam(owner,id){
    this.requireTeam(owner,id,true);
    const now=Date.now();this.write('UPDATE teams SET archived_at=? WHERE id=?',now,id);
    return {id,archived:true,archivedAt:now};
  }
  addTeamMember(owner,id,accountToAdd,email){
    const t=this.requireTeam(owner,id,true);
    if(typeof accountToAdd!=='string'||!accountToAdd)throw fail(400,'A member account is required.');
    if(accountToAdd!==t.owner){
      if(email)this.touchPerson(accountToAdd,email);
      const now=Date.now();
      this.write(`INSERT INTO team_members(team,account,role,added_by,added_at,removed_at) VALUES(?,?,?,?,?,NULL)
        ON CONFLICT(team,account) DO UPDATE SET role=CASE WHEN team_members.role='owner' THEN 'owner' ELSE excluded.role END,added_by=excluded.added_by,added_at=excluded.added_at,removed_at=NULL`,
        id,accountToAdd,'member',owner,now);
    }
    return this.team(owner,id);
  }
  removeTeamMember(owner,id,accountToRemove){
    const t=this.requireTeam(owner,id,true);
    if(accountToRemove===t.owner)throw fail(400,'The team owner cannot be removed.');
    this.write('UPDATE team_members SET removed_at=? WHERE team=? AND account=? AND removed_at IS NULL',Date.now(),id,accountToRemove);
    return this.team(owner,id);
  }

  // -- Dreaming & Evaluations ---------------------------------------------
  saveEvaluation(runId,{overall=1,citationFidelity=1,toolEfficiency=1,stateReuse=1,domainCompleteness=1,signals={},notes=null,evaluatedAt=Date.now()}={}){
    this.write(`INSERT INTO run_evaluations(run,overall,citation_fidelity,tool_efficiency,state_reuse,domain_completeness,signals,notes,evaluated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run) DO UPDATE SET
        overall=excluded.overall,
        citation_fidelity=excluded.citation_fidelity,
        tool_efficiency=excluded.tool_efficiency,
        state_reuse=excluded.state_reuse,
        domain_completeness=excluded.domain_completeness,
        signals=excluded.signals,
        notes=excluded.notes,
        evaluated_at=excluded.evaluated_at`,
      runId,overall,citationFidelity,toolEfficiency,stateReuse,domainCompleteness,JSON.stringify(signals||{}),notes,evaluatedAt);
    return this.getEvaluation(runId);
  }
  getEvaluation(runId){
    const row=this.one('SELECT * FROM run_evaluations WHERE run=?',runId);
    if(!row)return null;
    return {
      run:row.run,
      overall:row.overall,
      citationFidelity:row.citation_fidelity,
      toolEfficiency:row.tool_efficiency,
      stateReuse:row.state_reuse,
      domainCompleteness:row.domain_completeness,
      signals:JSON.parse(row.signals||'{}'),
      notes:row.notes,
      evaluatedAt:row.evaluated_at,
    };
  }
  unevaluatedRuns(limit=50){
    return this.query(`SELECT r.* FROM runs r LEFT JOIN run_evaluations e ON e.run=r.id
      WHERE r.status IN ('completed','failed','interrupted') AND e.run IS NULL
      ORDER BY r.created ASC LIMIT ?`,limit)
      .map(r=>({...r,result:r.result?JSON.parse(r.result):null}));
  }
  // Inserts a proposed memory, or adds new run evidence to an existing one without touching its
  // review status. Replaying a run already in the evidence changes nothing.
  upsertMemory({scope='account',principal,category='workflow',rule,runId=null,confidence=0.85,account=null,team=null,jurisdiction=null,now=Date.now()}={}){
    if(!['account','team','jurisdiction','global'].includes(scope))throw new Error(`Invalid memory scope: ${scope}`);
    const cleanPrincipal=String(principal||'global').trim();
    const cleanRule=String(rule||'').trim();
    if(!cleanPrincipal||!cleanRule)return null;
    const existing=this.one('SELECT * FROM workspace_memories WHERE scope=? AND principal=? AND rule=?',scope,cleanPrincipal,cleanRule);
    if(existing){
      const runs=JSON.parse(existing.evidence_runs||'[]');
      if(!runId||runs.includes(runId))return {...existing,changed:false};
      const nextConf=Math.min(1,Math.max(Number(existing.confidence)||0,Number(confidence)||0.85)+0.05);
      this.write('UPDATE workspace_memories SET evidence_runs=?,confidence=?,updated=? WHERE id=?',
        JSON.stringify([...runs,runId]),nextConf,now,existing.id);
      return {...this.one('SELECT * FROM workspace_memories WHERE id=?',existing.id),changed:true};
    }
    const id=randomUUID();
    const evidence=runId?[runId]:[];
    this.write(`INSERT INTO workspace_memories(id,scope,principal,category,rule,evidence_runs,confidence,created,updated,account,team,jurisdiction,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'proposed')`,
      id,scope,cleanPrincipal,category,cleanRule,JSON.stringify(evidence),confidence,now,now,
      scope==='account'?cleanPrincipal:account,scope==='team'?cleanPrincipal:team,scope==='jurisdiction'?cleanPrincipal:jurisdiction);
    return {...this.one('SELECT * FROM workspace_memories WHERE id=?',id),changed:true};
  }
  // Approving with scope 'global' is the only way a memory reaches other accounts.
  reviewMemory(id,{decision,by,scope=null,now=Date.now()}={}){
    const row=this.one('SELECT * FROM workspace_memories WHERE id=?',id);
    if(!row)throw new Error(`Memory not found: ${id}`);
    if(decision==='approved'){
      if(scope==='global')this.write("UPDATE workspace_memories SET scope='global',principal='global',account=NULL,team=NULL,jurisdiction=NULL WHERE id=?",id);
      this.write("UPDATE workspace_memories SET status='approved',approved_by=?,approved_at=? WHERE id=?",by,now,id);
    }else{
      this.write("UPDATE workspace_memories SET status='rejected',rejected_by=?,rejected_at=? WHERE id=?",by,now,id);
    }
    return this.one('SELECT * FROM workspace_memories WHERE id=?',id);
  }
  listMemories({scope=null,principal=null,status=null}={}){
    const rows=this.query(`SELECT * FROM workspace_memories
      WHERE (? IS NULL OR scope=?) AND (? IS NULL OR principal=?) AND (? IS NULL OR status=?)
      ORDER BY confidence DESC, updated DESC`,scope,scope,principal,principal,status,status);
    return rows.map(r=>({...r,evidenceRuns:JSON.parse(r.evidence_runs||'[]')}));
  }
  // Only approved memories reach prompts. Account memories apply to that account alone, and a
  // memory bound to an originating account never reaches another account unless it is global.
  memoriesForRun(account,conversationId){
    const principals=new Map([['global',new Set(['global'])]]);
    const add=(s,p)=>{if(!p)return;if(!principals.has(s))principals.set(s,new Set());principals.get(s).add(String(p));};
    add('account',account);
    if(conversationId){
      const conv=this.one('SELECT property FROM conversations WHERE id=?',conversationId);
      const prop=this.project.property(this.projectOf(conversationId))??(conv?.property?JSON.parse(conv.property):null);
      if(prop?.jurisdiction)add('jurisdiction',String(prop.jurisdiction).toLowerCase());
      else if(prop?.bbl||prop?.borough)add('jurisdiction','nyc');
      for(const r of this.query(`SELECT principal FROM conversation_members WHERE conversation=? AND principal_type='team' AND removed_at IS NULL`,conversationId)){
        add('team',r.principal);
      }
    }
    if(account){
      for(const t of this.query(`SELECT id FROM teams t WHERE t.archived_at IS NULL AND (t.owner=? OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.team=t.id AND tm.account=? AND tm.removed_at IS NULL))`,account,account)){
        add('team',t.id);
      }
    }
    const candidates=[];
    for(const [scope,set] of principals.entries()){
      for(const p of set){
        for(const row of this.query(`SELECT * FROM workspace_memories WHERE scope=? AND principal=? AND status='approved'
          AND (scope='global' OR account IS NULL OR account=?) ORDER BY confidence DESC, updated DESC LIMIT 8`,scope,p,account??null)){
          candidates.push(row);
        }
      }
    }
    candidates.sort((a,b)=>(b.confidence-a.confidence)||(b.updated-a.updated));
    const seen=new Set(),out=[];
    for(const c of candidates){
      if(seen.has(c.rule))continue;
      seen.add(c.rule);
      out.push(c.rule);
      if(out.length>=8)break;
    }
    return out;
  }
  recordDreamRun({id=randomUUID(),startedAt=Date.now(),finishedAt=Date.now(),runsEvaluated=0,memoriesConsolidated=0,expansionsLearned=0,sourcesStaged=0,summary=null}={}){
    this.write(`INSERT INTO dream_runs(id,started_at,finished_at,runs_evaluated,memories_consolidated,expansions_learned,sources_staged,summary)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        finished_at=excluded.finished_at,
        runs_evaluated=excluded.runs_evaluated,
        memories_consolidated=excluded.memories_consolidated,
        expansions_learned=excluded.expansions_learned,
        sources_staged=excluded.sources_staged,
        summary=excluded.summary`,
      id,startedAt,finishedAt,runsEvaluated,memoriesConsolidated,expansionsLearned,sourcesStaged,summary?JSON.stringify(summary):null);
    return this.one('SELECT * FROM dream_runs WHERE id=?',id);
  }
  dreamRuns(limit=5){
    return this.query('SELECT * FROM dream_runs ORDER BY started_at DESC LIMIT ?',limit)
      .map(r=>({...r,summary:r.summary?JSON.parse(r.summary):null}));
  }
  evaluationsBetween(from,to){
    return this.query('SELECT run FROM run_evaluations WHERE evaluated_at>=? AND evaluated_at<=? ORDER BY evaluated_at',from,to)
      .map(r=>this.getEvaluation(r.run));
  }
}
