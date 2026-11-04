import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {publicUrl} from './public-url.mjs';
import {PublicToolError} from './public-http.mjs';

export const pilotLimits={toolRequestsPerHour:120,publicSearchesPerHour:30,publicSearchesPerDay:200,stateRequestsPerHour:240,adminRequestsPerHour:60};
// Hourly per-account counters: acres:read tools, project state reads/writes, admin reads.
const hourlyLimits={tool:pilotLimits.toolRequestsPerHour,state:pilotLimits.stateRequestsPerHour,admin:pilotLimits.adminRequestsPerHour};
const knownDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value.slice(0,10)?value:null;
export class EvidenceStore {
  constructor(path,{retentionDays=30,now=Date.now}={}) {
    if(!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>365)throw new Error('Evidence retention must be 1 to 365 days.');
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);chmodSync(path,0o600);this.now=now;this.retentionDays=retentionDays;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS evidence_owner ON evidence(owner,expires);
      CREATE INDEX IF NOT EXISTS evidence_expiry ON evidence(expires);
      CREATE TABLE IF NOT EXISTS evidence_documents(owner TEXT NOT NULL,hash TEXT NOT NULL,text TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(owner,hash));
      CREATE INDEX IF NOT EXISTS evidence_document_expiry ON evidence_documents(expires);
      CREATE TABLE IF NOT EXISTS usage(owner TEXT NOT NULL,kind TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(owner,kind,bucket));`);
  }
  record(owner,{title,url,text,excerpt=null,pdfPages=null,kind='research',jurisdiction='US-NY-NYC',publishedAt=null,effectiveFrom=null,effectiveTo=null,observedAt=null,versionId=null,coverageNote=null,lastChecked=null,lastAttempted=null,refreshFailed=null,stale=null}) {
    if(!publicUrl(url)||typeof text!=='string'||!text.trim())return null;
    if(!['US','US-NY','US-NY-NYC'].includes(jurisdiction))return null;
    const canonical=new URL(url);
    if([...canonical.searchParams.keys()].some(key=>/(token|secret|password|api.?key|signature|credential)/i.test(key)))return null;
    const documentHash=createHash('sha256').update(text).digest('hex');
    const captured=excerpt?.text||text;
    const snapshot={title:String(title||url).slice(0,500),url:canonical.href,text:captured.slice(0,48000),metadata:{
      kind:String(kind).slice(0,100),jurisdiction,publishedAt:knownDate(publishedAt),effectiveFrom:knownDate(effectiveFrom),effectiveTo:knownDate(effectiveTo),versionId:typeof versionId==='string'?versionId.slice(0,200):null,coverageNote:typeof coverageNote==='string'?coverageNote.slice(0,2000):null,
      observedAt:knownDate(observedAt),lastChecked:knownDate(lastChecked),lastAttempted:knownDate(lastAttempted),refreshFailed:typeof refreshFailed==='boolean'?refreshFailed:null,stale:typeof stale==='boolean'?stale:null,
      textTruncated:captured.length>48000||captured!==text,untrusted:true,documentHash,documentCharacters:text.length,
      documentOffset:excerpt?null:0,nextOffset:excerpt?0:text.length>48000?48000:null,
      ...(pdfPages?{documentPdfPages:pdfPages.map(({page,start,end})=>({page,start,end}))}:{}),
      excerpt:excerpt?{chunkId:excerpt.chunkId,ordinal:excerpt.ordinal,...(excerpt.pdf?{pdf:excerpt.pdf}:{})}:null,
    }};
    const id='src_'+createHash('sha256').update(owner+'\n'+JSON.stringify(snapshot)).digest('hex');
    const timestamp=new Date(this.now()).toISOString();
    const payload={id,...snapshot,metadata:{...snapshot.metadata,observedAt:knownDate(observedAt)||timestamp,retrievedAt:timestamp}};
    const expires=this.now()+this.retentionDays*86400000;
    this.db.prepare('INSERT INTO evidence_documents VALUES(?,?,?,?) ON CONFLICT(owner,hash) DO UPDATE SET expires=MAX(expires,excluded.expires)').run(owner,documentHash,text,expires);
    this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires WHERE evidence.expires<=?').run(id,owner,JSON.stringify(payload),expires,this.now());
    return this.fetch(owner,id);
  }
  fetch(owner,id,{offset}={}) {
    const row=this.db.prepare('SELECT payload FROM evidence WHERE owner=? AND id=? AND expires>?').get(owner,id,this.now());
    if(!row)return null;
    const payload=JSON.parse(row.payload);
    if(offset===undefined)return payload;
    if(!Number.isSafeInteger(offset)||offset<0)throw new PublicToolError('INVALID_INPUT','Source offset must be a nonnegative safe integer.',400);
    const document=payload.metadata.documentHash?this.db.prepare('SELECT text FROM evidence_documents WHERE owner=? AND hash=? AND expires>?').get(owner,payload.metadata.documentHash,this.now()):null;
    if(!document){if(offset===0)return payload;throw new PublicToolError('INVALID_INPUT','This older snapshot has no retained continuation.',400);}
    if(offset>=document.text.length)throw new PublicToolError('INVALID_INPUT','Source offset is outside the retained document.',400);
    const text=document.text.slice(offset,offset+48000),nextOffset=offset+text.length<document.text.length?offset+text.length:null;
    return {...payload,text,metadata:{...payload.metadata,documentOffset:offset,nextOffset,textTruncated:nextOffset!==null}};
  }
  admit(owner,{publicWeb=false,kind='tool'}={}) {
    if(!Object.hasOwn(hourlyLimits,kind))throw new Error(`Unknown admission counter: ${kind}`);
    const hour=Math.floor(this.now()/3600000),day=Math.floor(this.now()/86400000);
    const limits=[[owner,kind,hour,hourlyLimits[kind]],...(publicWeb?[[owner,'search',hour,pilotLimits.publicSearchesPerHour],['*','provider',day,pilotLimits.publicSearchesPerDay]]:[])];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const [account,kind,bucket,limit] of limits) {
        const row=this.db.prepare('SELECT count FROM usage WHERE owner=? AND kind=? AND bucket=?').get(account,kind,bucket);
        if((row?.count||0)>=limit)throw new PublicToolError('QUOTA_EXCEEDED','The Arosa pilot request limit has been reached. Try again after the quota window resets.',429);
      }
      for(const [account,kind,bucket] of limits)this.db.prepare('INSERT INTO usage VALUES(?,?,?,1) ON CONFLICT(owner,kind,bucket) DO UPDATE SET count=count+1').run(account,kind,bucket);
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
    this.prune();
  }
  prune() {
    this.db.prepare('DELETE FROM evidence WHERE expires<=?').run(this.now());
    this.db.prepare('DELETE FROM evidence_documents WHERE expires<=?').run(this.now());
    this.db.prepare("DELETE FROM usage WHERE (kind='provider' AND bucket<?) OR (kind!='provider' AND bucket<?)").run(Math.floor(this.now()/86400000)-2,Math.floor(this.now()/3600000)-48);
  }
  deleteOwner(owner){this.db.prepare('DELETE FROM evidence WHERE owner=?').run(owner);this.db.prepare('DELETE FROM evidence_documents WHERE owner=?').run(owner);this.db.prepare('DELETE FROM usage WHERE owner=?').run(owner);}
  async backup(path){await backup(this.db,path);chmodSync(path,0o600);}
  close(){this.db.close();}
}
