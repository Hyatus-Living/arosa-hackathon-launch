import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {abortable,executionSignal,withExecutionSignal,requestSignal,throwIfCancelled,stoppedError} from './execution-context.mjs';

export const root='https://backend.composio.dev/api/v3.1';
export const exaTools=['EXA_SEARCH','EXA_GET_CONTENTS_ACTION','EXA_FIND_SIMILAR'];
export const serviceUser='acres-service';
const serviceConfig={toolkits:{enable:['exa']},tools:{exa:{enable:exaTools}},instant:{return_instant_charge:true},manage_connections:{enable:false},workbench:{enable:false},multi_account:{enable:false}};
const accountConfig={tags:['readOnlyHint'],instant:{return_instant_charge:true},manage_connections:{enable:false},workbench:{enable:false},multi_account:{enable:false}};

export function composioHeaders(secrets) {
  if(typeof secrets.COMPOSIO_API_KEY!=='string'||secrets.COMPOSIO_API_KEY.length<20)throw new Error('Public research requires the private COMPOSIO_API_KEY binding.');
  return {'content-type':'application/json','x-api-key':secrets.COMPOSIO_API_KEY};
}

// One tool-router session per Arosa account (public read-only tools, Instant charged to the
// project wallet) and one service session that owns the shared Exa connection. Session IDs
// persist on the host so repeated runs reuse them and Composio logs attribute calls per user.
export class SessionStore {
  constructor(path,secrets,request=fetchJson) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path); chmodSync(path,0o600);
    this.db.exec('CREATE TABLE IF NOT EXISTS sessions(user TEXT PRIMARY KEY,session TEXT NOT NULL,created INTEGER NOT NULL)');
    this.secrets=secrets; this.request=request; this.inFlight=new Map();
  }
  async session(user,config) {
    throwIfCancelled();
    const row=this.db.prepare('SELECT session FROM sessions WHERE user=?').get(user);
    if(row)return row.session;
    let flight=this.inFlight.get(user);
    if(!flight){
      flight={controller:new AbortController(),waiters:0};
      this.inFlight.set(user,flight);
      flight.promise=withExecutionSignal(flight.controller.signal,async()=>{
        try{
          const created=await this.request(`${root}/tool_router/session`,{method:'POST',headers:composioHeaders(this.secrets),body:JSON.stringify({user_id:user,...config}),signal:requestSignal(45000)});
          throwIfCancelled();
          if(typeof created.session_id!=='string')throw new Error('Composio did not return a session.');
          this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(user,created.session_id,Date.now());
          return created.session_id;
        }finally{if(this.inFlight.get(user)===flight)this.inFlight.delete(user);}
      });
    }
    flight.waiters++;
    try{return await abortable(flight.promise,executionSignal());}
    finally{
      if(--flight.waiters===0){
        if(this.inFlight.get(user)===flight)this.inFlight.delete(user);
        flight.controller.abort(stoppedError());
      }
    }
  }
  async forAccount(owner) {
    if(!/^[a-f0-9]{24}$/.test(owner))throw new Error('Research sessions require a verified account.');
    const [exa,pub]=await Promise.all([this.session(serviceUser,serviceConfig),this.session(owner,accountConfig)]);
    return {exa,public:pub};
  }
  forService(){return this.session(serviceUser,serviceConfig);}
  close(){for(const flight of this.inFlight.values())flight.controller.abort(stoppedError());this.inFlight.clear();this.db.close();}
}

async function fetchJson(url,options) {
  const r=await fetch(url,{...options,signal:requestSignal(45000)});
  const p=await r.json();
  if(!r.ok)throw new Error(p.error?.message||`Composio returned HTTP ${r.status}`);
  return p;
}
