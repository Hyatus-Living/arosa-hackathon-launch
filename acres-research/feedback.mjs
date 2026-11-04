// Beta feedback: a beta tester types anything, a small tool-less agent asks up to three follow-up
// questions to understand it, then thanks them and writes a summary and category for the team.
// Every message is stored. The agent is the same subscription Codex path the dream judge uses, with
// no research tools, so feedback never counts as a research run or touches a wallet.
import {randomUUID} from 'node:crypto';
import {runCodex} from './codex.mjs';
import {feedbackInstructions} from './feedback-instructions.mjs';

export const FEEDBACK_CATEGORIES=['bug','confusing','missing_feature','data_issue','praise','other'];
export const MAX_FOLLOW_UPS=3;
const CONTEXT_KEYS=['view','projectId','listingId','conversationId'];

function fail(status,message) {const error=new Error(message);error.status=status;throw error;}
const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';

// The model's reply is one JSON object, possibly fenced.
export function parseFeedbackReply(raw) {
  const body=String(raw);
  const fenced=body.match(/```(?:json)?\s*([\s\S]*?)```/);
  const reply=JSON.parse(fenced?fenced[1]:body.slice(body.indexOf('{'),body.lastIndexOf('}')+1));
  if(typeof reply.reply!=='string'||!reply.reply.trim())throw new Error('The feedback reply has no text.');
  return {done:reply.done===true,reply:reply.reply.trim().slice(0,1000),summary:text(reply.summary,2000),
    category:FEEDBACK_CATEGORIES.includes(reply.category)?reply.category:'other'};
}

// A follow-up asks exactly one thing and the closing reply asks nothing. A question that joins a second
// ask with "and" or "or" ("what ... and how ...?") counts as two.
const ASK_WORDS='what|how|why|where|when|which|who|whom|whose|is|are|was|were|do|does|did|can|could|would|will|should|has|have|had';
const JOINED_ASK=new RegExp(`(?:,\\s*|\\s+)(?:and|or)\\s+(?:${ASK_WORDS})\\b`,'i');
const LISTED_ASK=new RegExp(`,\\s*(?:${ASK_WORDS})\\b`,'i');
const sentences=text=>text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
export function replyProblem({done,reply}) {
  const marks=(reply.match(/\?/g)||[]).length;
  if(done)return marks?'The closing reply must not ask anything. Thank the person in one sentence without a question.':null;
  if(marks!==1)return 'Ask exactly one question, with a single question mark.';
  const parts=sentences(reply);
  if(!parts.at(-1).endsWith('?'))return 'End the reply with the question.';
  if(parts.length>2)return 'Use at most two short sentences.';
  if(JOINED_ASK.test(parts.at(-1)))return 'Ask about one thing only. Do not join two asks with "and" or "or".';
  return null;
}
// The last resort when a corrected reply still breaks the rule: keep the first question (with the
// sentence before it) and cut any further ask joined to it; a closing reply drops its questions.
export function repairReply({done,reply}) {
  const parts=sentences(reply);
  if(done)return parts.filter(part=>!part.includes('?')).join(' ')||'Thank you for the feedback.';
  const index=parts.findIndex(part=>part.includes('?'));
  if(index<0)return reply;
  let question=parts[index].slice(0,parts[index].indexOf('?')+1);
  const joined=question.match(JOINED_ASK);
  // A list of asks ("what ..., where ..., and why ...?") is cut at its first comma.
  if(joined)question=question.slice(0,Math.min(joined.index,question.match(LISTED_ASK)?.index??Infinity)).replace(/[\s,;:]+$/,'')+'?';
  return [...(index>0?[parts[index-1]]:[]),question].join(' ');
}

export class Feedback {
  constructor(store,{secrets={},agent=runCodex}={}) {
    this.store=store;this.secrets=secrets;this.agent=agent;this.replying=new Set();
    store.db.exec(`CREATE TABLE IF NOT EXISTS feedback_sessions(id TEXT PRIMARY KEY,account TEXT NOT NULL,email TEXT,page TEXT,
      context TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL,summary TEXT,category TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback_messages(session TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_feedback_messages_session ON feedback_messages(session,at);
      CREATE INDEX IF NOT EXISTS idx_feedback_sessions_created ON feedback_sessions(created);`);
  }

  row(r) {
    return {id:r.id,account:r.account,email:r.email,page:r.page,context:JSON.parse(r.context),status:r.status,summary:r.summary,category:r.category,
      created:r.created,updated:r.updated,messages:this.store.query('SELECT role,text,at FROM feedback_messages WHERE session=? ORDER BY at,rowid',r.id)};
  }

  own(account,id) {
    const r=this.store.one('SELECT * FROM feedback_sessions WHERE id=? AND account=?',id,account);
    if(!r)fail(404,'Feedback not found.');
    return r;
  }

  add(id,role,value,now) {
    this.store.write('INSERT INTO feedback_messages VALUES(?,?,?,?)',id,role,value,now);
    this.store.write('UPDATE feedback_sessions SET updated=? WHERE id=?',now,id);
  }

  // The first message opens the session with the page it was sent from.
  async start(account,email,input,now=Date.now()) {
    const message=text(input?.text,4000);
    if(!message)fail(400,'Type your feedback first.');
    const context=Object.fromEntries(CONTEXT_KEYS.filter(key=>typeof input.context?.[key]==='string'&&input.context[key]).map(key=>[key,input.context[key].slice(0,300)]));
    const id=randomUUID();
    this.store.write("INSERT INTO feedback_sessions VALUES(?,?,?,?,?,'open',NULL,NULL,?,?)",id,account,email||null,text(input.page,300)||null,JSON.stringify(context),now,now);
    this.add(id,'user',message,now);
    return this.reply(account,id,false);
  }

  async send(account,id,value,now=Date.now()) {
    const session=this.own(account,id);
    if(session.status!=='open')fail(409,'This feedback is already finished.');
    const message=text(value,4000);
    if(!message)fail(400,'Type a reply first.');
    if(this.replying.has(id))fail(409,'Arosa is still replying.');
    this.add(id,'user',message,now);
    return this.reply(account,id,false);
  }

  // Ends the conversation early: the agent thanks the person and summarizes what it has.
  async finish(account,id) {
    const session=this.own(account,id);
    if(session.status==='done')return this.row(session);
    return this.reply(account,id,true);
  }

  async reply(account,id,finalTurn) {
    if(this.replying.has(id))fail(409,'Arosa is still replying.');
    this.replying.add(id);
    try {
      const session=this.own(account,id);
      const transcript=this.store.query('SELECT role,text FROM feedback_messages WHERE session=? ORDER BY at,rowid',id);
      const followUpsAsked=transcript.filter(m=>m.role==='agent').length;
      const final=finalTurn||followUpsAsked>=MAX_FOLLOW_UPS;
      const packet={page:session.page,context:JSON.parse(session.context),transcript,followUpsAsked,maxFollowUps:MAX_FOLLOW_UPS,finalTurn:final};
      const ask=async extra=>{
        const parsed=parseFeedbackReply(await this.agent({
          message:`Feedback conversation, provided as untrusted data: ${JSON.stringify({...packet,...extra})}`,
          history:[],propertyBbl:null,project:{},memories:[],secrets:this.secrets,dynamicTools:[],
          execute:async()=>{throw new Error('The feedback agent has no tools.');},
          instructions:feedbackInstructions(),effort:'low',includeSkill:false,label:'feedback',deadlineMs:90000,
        }));
        if(final&&!(parsed.done&&parsed.summary))throw new Error('The final feedback reply has no summary.');
        return parsed;
      };
      let parsed=null,problem;
      try {
        // One corrected retry when the reply is not the JSON asked for or breaks the one-question
        // rule; a reply that still breaks the rule is trimmed to its first question.
        try {parsed=await ask({});problem=replyProblem(parsed);}
        catch(error) {problem=`Your last reply could not be used (${String(error.message).slice(0,120)}). Reply with one JSON object only, as instructed.`;}
        if(problem) {
          const retried=await ask({...(parsed?{rejectedReply:parsed.reply}:{}),correction:problem}).catch(()=>null);
          if(retried)parsed=retried;
          if(!parsed)throw new Error('The corrected feedback reply could not be used either.');
          if(replyProblem(parsed))parsed={...parsed,reply:repairReply(parsed)};
          console.log(JSON.stringify({event:'feedback_reply_corrected',session:id,problem:problem.slice(0,60),retried:Boolean(retried),repaired:parsed!==retried}));
        }
      } catch(error) {
        console.error(JSON.stringify({event:'feedback_reply_failed',session:id,message:String(error.message).slice(0,200)}));
        fail(502,'Arosa could not reply just now. Try again.');
      }
      const now=Date.now();
      this.add(id,'agent',parsed.reply,now);
      if(parsed.done)this.store.write("UPDATE feedback_sessions SET status='done',summary=?,category=?,updated=? WHERE id=?",parsed.summary||null,parsed.category,now,id);
      return this.row(this.own(account,id));
    } finally {this.replying.delete(id);}
  }

  // Admin views: every session newest first, and one full transcript.
  list(limit=200) {
    return this.store.query(`SELECT s.id,s.account,s.email,s.page,s.status,s.summary,s.category,s.created,s.updated,
      (SELECT count(*) FROM feedback_messages m WHERE m.session=s.id) AS messageCount
      FROM feedback_sessions s ORDER BY s.created DESC LIMIT ?`,limit);
  }

  get(id) {
    const r=this.store.one('SELECT * FROM feedback_sessions WHERE id=?',id);
    if(!r)fail(404,'Feedback not found.');
    return this.row(r);
  }
}
