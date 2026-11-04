import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {ChatStore} from './store.mjs';
import {KnowledgeStore} from './knowledge.mjs';
import {evaluateRun,consolidateDream,runDreamCycle,reviewDreamItem,dreamReport,dreamJudgeFromEnv} from './dream.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const officialUrl='https://www.nyc.gov/assets/planning/download/pdf/zoning/special-district-guide.pdf';
const officialText='# Special District Guide\n\n'+'Under Section 91-22, floor area bonuses require certified public plaza maintenance agreements and transit easement volume dedication across eligible parcels. '.repeat(2);

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'acres-dream-review-'));
  const paths={chat:join(dir,'chat.sqlite'),knowledge:join(dir,'knowledge.sqlite')};
  const store=new ChatStore(paths.chat);
  const knowledge=new KnowledgeStore(paths.knowledge);
  t.after(()=>{
    knowledge.close();
    store.close();
    rmSync(dir,{recursive:true,force:true});
  });
  return {store,knowledge,dir,paths};
}

function publishUap(knowledge){
  const source={id:'zr-23-22',title:'NYC ZR 23-22',url:'https://zr.planning.nyc.gov/article-ii/chapter-3',jurisdiction:'US-NY-NYC',topics:['zoning'],authority:'statute',kind:'zoning-text'};
  const text='# Section 23-22\n\nUniversal Affordability Preference (UAP) permits an additional 20 percent residential floor area bonus.';
  knowledge.register(source);
  knowledge.publish(source,Buffer.from(text),text,source,[],'none',new Date().toISOString());
}

// One completed run per call: a steer, a zero-hit reformulation and an official cited source with full text.
function recordLearningRun(store,owner,conv,i=1){
  const run=store.createRun(owner,conv.id,`Analyze UAP at 120 Broadway (${i})`);
  store.begin(run);
  store.event(run.id,'tool.started',{tool:'acres_fanout_search',arguments:{query:'skylineinclusion'}});
  store.event(run.id,'tool.completed',{tool:'acres_fanout_search',arguments:{query:'skylineinclusion'},durationMs:40,success:true,result:{results:[]}});
  store.event(run.id,'tool.started',{tool:'acres_fanout_search',arguments:{query:'Universal Affordability Preference'}});
  store.event(run.id,'tool.completed',{tool:'acres_fanout_search',arguments:{query:'Universal Affordability Preference'},durationMs:40,success:true,result:{results:[{id:1}]}});
  store.event(run.id,'run.steered',{text:'Always include a 5.5% exit cap rate in rental underwriting'});
  store.addMessage(conv.id,run.id,'user','Always include a 5.5% exit cap rate in rental underwriting',{steer:true},owner);
  store.finish(run,'completed',{
    answer:'The special district guide requires plaza maintenance agreements for bonus floor area [1].',
    property:{bbl:'1000477501',address:'120 BROADWAY',borough:'MN',jurisdiction:'nyc'},
    sources:[{id:1,title:'Special District Guide',url:officialUrl,text:officialText,kind:'zoning'}],
  });
  return run;
}

test('dreaming writes memories, expansions and source promotions as proposed, and none of them influence prompts, search or the corpus until approved',async t=>{
  const {store,knowledge}=setup(t);
  publishUap(knowledge);
  const conv=store.createConversation('alice');
  recordLearningRun(store,'alice',conv,1);
  recordLearningRun(store,'alice',conv,2);

  const cycle=await runDreamCycle({store,knowledge});
  assert.equal(cycle.runsEvaluated,2);
  assert.equal(cycle.sourcesPromoted,0,'staged sources must not promote without review');

  const memories=store.listMemories();
  assert.ok(memories.length>=1);
  assert.ok(memories.every(m=>m.status==='proposed'));
  assert.deepEqual(store.memoriesForRun('alice',conv.id),[],'proposed memories must not reach prompts');

  const expansions=knowledge.listExpansions();
  assert.equal(expansions.length,1);
  assert.equal(expansions[0].status,'proposed');
  assert.equal(knowledge.expansionsMap({account:'alice'}).size,0,'proposed expansions must not expand search');
  assert.equal((await knowledge.search({query:'skylineinclusion',city:'US-NY-NYC',limit:5})).results.length,0);

  const [staged]=knowledge.stagedSources();
  assert.equal(staged.status,'staged');
  assert.equal(staged.review_status,'proposed');
  assert.equal(staged.times_cited,2);
  assert.equal(knowledge.stagedSources('promoted').length,0);

  const steer=memories.find(m=>m.rule.includes('5.5% exit cap'));
  reviewDreamItem({store,knowledge,kind:'memory',id:steer.id,decision:'approve',by:'michael',now:1000});
  const approvedMemory=store.listMemories().find(m=>m.id===steer.id);
  assert.equal(approvedMemory.status,'approved');
  assert.equal(approvedMemory.approved_by,'michael');
  assert.equal(approvedMemory.approved_at,1000);
  assert.ok(store.memoriesForRun('alice',conv.id).some(m=>m.includes('5.5% exit cap')));

  reviewDreamItem({store,knowledge,kind:'expansion',id:expansions[0].id,decision:'approve',by:'michael',scope:'global'});
  const after=await knowledge.search({query:'skylineinclusion',city:'US-NY-NYC',limit:5});
  assert.equal(after.results[0]?.sourceId,'zr-23-22','approved global expansion must expand search');

  reviewDreamItem({store,knowledge,kind:'source',id:officialUrl,decision:'approve',by:'michael'});
  const [promoted]=knowledge.stagedSources('promoted');
  assert.equal(promoted.url,officialUrl);
  assert.equal(promoted.approved_by,'michael');
  const hits=await knowledge.search({query:'91-22 transit easement volume dedication',city:'US-NY-NYC',limit:5});
  assert.ok(hits.results.some(r=>r.url===officialUrl),'approved source must be promoted into the corpus');
});

test('rejected items stay inert and record who rejected them and when',async t=>{
  const {store,knowledge}=setup(t);
  const conv=store.createConversation('alice');
  recordLearningRun(store,'alice',conv,1);
  recordLearningRun(store,'alice',conv,2);
  await runDreamCycle({store,knowledge});

  const steer=store.listMemories().find(m=>m.rule.includes('5.5% exit cap'));
  reviewDreamItem({store,knowledge,kind:'memory',id:steer.id,decision:'reject',by:'reviewer',now:2000});
  reviewDreamItem({store,knowledge,kind:'source',id:officialUrl,decision:'reject',by:'reviewer',now:2000});
  const rejected=store.listMemories().find(m=>m.id===steer.id);
  assert.equal(rejected.status,'rejected');
  assert.equal(rejected.rejected_by,'reviewer');
  assert.equal(rejected.rejected_at,2000);
  assert.deepEqual(store.memoriesForRun('alice',conv.id),[]);

  // A later run repeating the same steer adds evidence but never reopens the rejection.
  recordLearningRun(store,'alice',conv,3);
  await runDreamCycle({store,knowledge});
  assert.equal(store.listMemories().find(m=>m.id===steer.id).status,'rejected');
  assert.equal(knowledge.stagedSources()[0].review_status,'rejected');
  assert.equal(knowledge.stagedSources('promoted').length,0);
  assert.throws(()=>reviewDreamItem({store,knowledge,kind:'memory',id:'missing',decision:'approve',by:'x'}),/not found/i);
});

test('migration approves pre-existing memories, expansions and staged sources exactly once, recording approved_by=migration',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-dream-migrate-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const chatPath=join(dir,'chat.sqlite'),knowledgePath=join(dir,'knowledge.sqlite');

  const legacyChat=new DatabaseSync(chatPath);
  legacyChat.exec(`CREATE TABLE workspace_memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL CHECK(scope IN ('account','team','jurisdiction','global')),principal TEXT NOT NULL,category TEXT NOT NULL,rule TEXT NOT NULL,evidence_runs TEXT NOT NULL,confidence REAL NOT NULL DEFAULT 0.8,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(scope,principal,rule));
    INSERT INTO workspace_memories VALUES('m-acct','account','alice','user-steer','Always show a 6% exit cap.','["r1"]',0.9,1,1);
    INSERT INTO workspace_memories VALUES('m-jur','jurisdiction','nyc','citation-hygiene','Verify every citation index.','["r1"]',0.8,1,1);`);
  legacyChat.close();
  const legacyKnowledge=new DatabaseSync(knowledgePath);
  legacyKnowledge.exec(`CREATE TABLE learned_expansions(term TEXT PRIMARY KEY,expansion TEXT NOT NULL,source_run TEXT,confidence REAL NOT NULL DEFAULT 1,updated TEXT NOT NULL);
    CREATE TABLE staged_sources(url TEXT PRIMARY KEY,title TEXT NOT NULL,jurisdiction TEXT NOT NULL,host TEXT NOT NULL,authority REAL NOT NULL,times_cited INTEGER NOT NULL DEFAULT 1,sample_run TEXT,status TEXT NOT NULL DEFAULT 'staged',updated TEXT NOT NULL);
    INSERT INTO learned_expansions VALUES('sliver rule','23-692 narrow building height','r1',0.9,'2026-01-01');
    INSERT INTO staged_sources VALUES('${officialUrl}','Guide','US-NY-NYC','www.nyc.gov',0.9,1,'r1','staged','2026-01-01');`);
  legacyKnowledge.close();

  let store=new ChatStore(chatPath),knowledge=new KnowledgeStore(knowledgePath);
  const memories=store.listMemories();
  assert.equal(memories.length,2);
  for(const m of memories){
    assert.equal(m.status,'approved');
    assert.equal(m.approved_by,'migration');
  }
  assert.equal(memories.find(m=>m.id==='m-acct').account,'alice');
  assert.ok(store.memoriesForRun('alice',null).includes('Always show a 6% exit cap.'),'legacy memories keep influencing prompts after deploy');
  const [expansion]=knowledge.listExpansions();
  assert.equal(expansion.status,'approved');
  assert.equal(expansion.approved_by,'migration');
  assert.equal(expansion.scope,'global');
  assert.equal(knowledge.expansionsMap().get('sliver rule'),'23-692 narrow building height','legacy expansions keep expanding search after deploy');
  const [staged]=knowledge.stagedSources();
  assert.equal(staged.review_status,'approved');
  assert.equal(staged.approved_by,'migration');

  // Reopening must not re-approve rows a reviewer has since rejected.
  reviewDreamItem({store,knowledge,kind:'memory',id:'m-acct',decision:'reject',by:'reviewer'});
  reviewDreamItem({store,knowledge,kind:'expansion',id:expansion.id,decision:'reject',by:'reviewer'});
  store.close();knowledge.close();
  store=new ChatStore(chatPath);knowledge=new KnowledgeStore(knowledgePath);
  try{
    assert.equal(store.listMemories().find(m=>m.id==='m-acct').status,'rejected');
    assert.equal(knowledge.listExpansions()[0].status,'rejected');
    assert.equal(knowledge.expansionsMap().size,0);
  }finally{store.close();knowledge.close();}
});

test('approved memories and expansions never apply across accounts unless their scope is global',async t=>{
  const {store,knowledge}=setup(t);
  const aliceConv=store.createConversation('alice');
  recordLearningRun(store,'alice',aliceConv,1);
  recordLearningRun(store,'alice',aliceConv,2);
  // A citation-hygiene lesson is jurisdiction-scoped; force one with a repair event.
  const repairRun=store.createRun('alice',aliceConv.id,'Check UAP citations');
  store.begin(repairRun);
  store.event(repairRun.id,'turn.repair',{reason:'Invalid [9] citation',sourceCount:1});
  store.finish(repairRun,'completed',{answer:'UAP bonus applies to qualifying affordable floor area [1].',property:{bbl:'1000477501',borough:'MN',jurisdiction:'nyc'},sources:[{id:1,title:'ZR',url:'https://zr.planning.nyc.gov/article-ii/chapter-3'}]});
  await runDreamCycle({store,knowledge});

  for(const m of store.listMemories())reviewDreamItem({store,knowledge,kind:'memory',id:m.id,decision:'approve',by:'michael'});
  const [expansion]=knowledge.listExpansions();
  reviewDreamItem({store,knowledge,kind:'expansion',id:expansion.id,decision:'approve',by:'michael'});

  const jurisdictionMemory=store.listMemories().find(m=>m.scope==='jurisdiction');
  assert.equal(jurisdictionMemory.account,'alice','dream-written jurisdiction lessons stay bound to the originating account');
  assert.equal(expansion.account,'alice');

  // Bob works in the same jurisdiction and is a participant in Alice's conversation.
  store.grantMember('alice',aliceConv.id,'account','bob','participant','bob@witharosa.ai');
  const bobConv=store.createConversation('bob');
  store.project.write(store.projectOf(bobConv.id),{property:{value:{bbl:'1000477501',borough:'MN',jurisdiction:'nyc'},provenance:{source:'test'}}});
  assert.ok(store.memoriesForRun('alice',aliceConv.id).length>=2);
  assert.deepEqual(store.memoriesForRun('bob',bobConv.id),[],'alice-bound memories must not reach bob');
  assert.deepEqual(store.memoriesForRun('bob',aliceConv.id),[],'sharing a conversation must not leak the owner account memories');
  assert.equal(knowledge.expansionsMap({account:'alice',jurisdictions:['US-NY-NYC']}).size,1);
  assert.equal(knowledge.expansionsMap({account:'bob',jurisdictions:['US-NY-NYC']}).size,0);
  assert.equal(knowledge.expansionsMap().size,0);

  // Widening to global on approval is the only way across accounts.
  reviewDreamItem({store,knowledge,kind:'memory',id:jurisdictionMemory.id,decision:'approve',by:'michael',scope:'global'});
  reviewDreamItem({store,knowledge,kind:'expansion',id:expansion.id,decision:'approve',by:'michael',scope:'global'});
  assert.deepEqual(store.memoriesForRun('bob',bobConv.id),[jurisdictionMemory.rule]);
  assert.equal(knowledge.expansionsMap({account:'bob'}).size,1);
  assert.throws(()=>reviewDreamItem({store,knowledge,kind:'memory',id:jurisdictionMemory.id,decision:'approve',by:'michael',scope:'team'}),/scope/i);
});

test('consolidation is replayable without duplicating rows or inflating citation counts',async t=>{
  const {store,knowledge}=setup(t);
  const conv=store.createConversation('alice');
  const runs=[recordLearningRun(store,'alice',conv,1),recordLearningRun(store,'alice',conv,2)];
  const evaluations=[];
  for(const r of runs){
    evaluations.push(await evaluateRun({run:store.runRow(r.id),events:store.runEvents(r.id),messages:store.messageRows(conv.id),projectState:store.project.read(store.projectOf(conv.id))}));
  }
  const first=consolidateDream({store,knowledge,evaluations});
  const counts=()=>({
    memories:store.listMemories().length,
    evidence:store.listMemories().map(m=>m.evidenceRuns.length).join(','),
    confidence:store.listMemories().map(m=>m.confidence).join(','),
    expansions:knowledge.listExpansions().length,
    staged:knowledge.stagedSources().map(s=>s.times_cited).join(','),
  });
  const before=counts();
  const second=consolidateDream({store,knowledge,evaluations});
  // Replay the runs in a different order too: an earlier run must not count as a new citation.
  consolidateDream({store,knowledge,evaluations:[evaluations[0]]});
  assert.deepEqual(counts(),before);
  assert.ok(first.memoriesConsolidated>=1);
  assert.equal(first.expansionsLearned,1);
  assert.equal(second.memoriesConsolidated,0);
  assert.equal(second.expansionsLearned,0);
  assert.equal(second.sourcesStaged,0);
  assert.equal(knowledge.stagedSources()[0].times_cited,2);
});

test('evaluation completion is recorded only after its writes succeed',async t=>{
  const {store,knowledge}=setup(t);
  const conv=store.createConversation('alice');
  const run=recordLearningRun(store,'alice',conv,1);

  const brokenKnowledge=Object.create(knowledge);
  brokenKnowledge.stageOfficialSource=()=>{throw new Error('disk full');};
  await assert.rejects(runDreamCycle({store,knowledge:brokenKnowledge}),/disk full/);
  assert.equal(store.getEvaluation(run.id),null);
  assert.equal(store.unevaluatedRuns().length,1);
  assert.equal(store.listMemories().length,0,'memory writes roll back with the failed evaluation');

  const saveEvaluation=store.saveEvaluation;
  store.saveEvaluation=()=>{throw new Error('locked');};
  await assert.rejects(runDreamCycle({store,knowledge}),/locked/);
  store.saveEvaluation=saveEvaluation;
  assert.equal(store.unevaluatedRuns().length,1);

  const replay=await runDreamCycle({store,knowledge});
  assert.equal(replay.runsEvaluated,1);
  assert.ok(store.getEvaluation(run.id));
  assert.equal(knowledge.listExpansions().length,1);
  assert.equal(knowledge.stagedSources()[0].times_cited,1);
});

test('evaluateRun scores from evidence: an uncited answer or a failed tool can never score 1.0',async t=>{
  const {store}=setup(t);
  const conv=store.createConversation('alice');

  // Exact shapes emitted by codex.mjs for a tool that threw.
  const failedRun=store.createRun('alice',conv.id,'Check FAR');
  store.begin(failedRun);
  store.event(failedRun.id,'tool.started',{tool:'acres_find_property',arguments:{address:'120 Broadway'}});
  store.event(failedRun.id,'tool.completed',{tool:'acres_find_property',arguments:{address:'120 Broadway'},durationMs:12,success:false,result:{error:'PLUTO unavailable'}});
  store.event(failedRun.id,'tool.started',{tool:'acres_fanout_search',arguments:{query:'C5-5 FAR'}});
  store.event(failedRun.id,'tool.completed',{tool:'acres_fanout_search',arguments:{query:'C5-5 FAR'},durationMs:30,success:true,result:{results:[{id:1}]}});
  store.finish(failedRun,'completed',{answer:'C5-5 permits a maximum commercial FAR of 15.0 [1].',sources:[{id:1,title:'ZR 33-12',url:'https://zr.planning.nyc.gov/article-iii/chapter-3'}]});
  const failed=await evaluateRun({run:store.run('alice',failedRun.id),events:store.runEvents(failedRun.id)});
  assert.equal(failed.signals.failedToolCount,1);
  assert.ok(failed.toolEfficiency<=0.5,`one of two tools failed, got ${failed.toolEfficiency}`);
  assert.ok(failed.overall<1);

  // No tools, no sources, no citations: nothing supports the answer.
  const bareRun=store.createRun('alice',conv.id,'Can I build a tower here?');
  store.begin(bareRun);
  store.finish(bareRun,'completed',{answer:'Yes, you can build a 40-story tower on this lot. The district allows it.',sources:[]});
  const bare=await evaluateRun({run:store.run('alice',bareRun.id),events:[]});
  assert.equal(bare.citationFidelity,0);
  assert.equal(bare.toolEfficiency,0);
  assert.ok(bare.overall<0.5,`uncited run scored ${bare.overall}`);

  // Partially cited answer: coverage, not a flat 1.
  const partialRun=store.createRun('alice',conv.id,'Summarize UAP');
  store.begin(partialRun);
  store.event(partialRun.id,'tool.started',{tool:'acres_fanout_search',arguments:{query:'UAP'}});
  store.event(partialRun.id,'tool.completed',{tool:'acres_fanout_search',arguments:{query:'UAP'},durationMs:30,success:true,result:{results:[{id:1}]}});
  store.finish(partialRun,'completed',{answer:'UAP grants a 20 percent floor area bonus [1]. It also waives all parking requirements citywide. Height limits rise by forty feet everywhere.',sources:[{id:1,title:'ZR 23-22',url:'https://zr.planning.nyc.gov/article-ii/chapter-3'}]});
  const partial=await evaluateRun({run:store.run('alice',partialRun.id),events:store.runEvents(partialRun.id)});
  assert.ok(Math.abs(partial.citationFidelity-1/3)<0.01,`expected one of three claims cited, got ${partial.citationFidelity}`);

  // A failed run without a deliverable scores 0 completeness.
  const noAnswer=await evaluateRun({run:{id:'x',owner:'alice',status:'failed',input:'q',result:null,error:'Research timed out.'},events:[]});
  assert.equal(noAnswer.domainCompleteness,0);
  assert.ok(noAnswer.overall<0.3);
});

test('the scheduled entry accepts an optional judge through DREAM_JUDGE and keeps it off by default',async()=>{
  assert.equal(dreamJudgeFromEnv({}),null);
  assert.equal(dreamJudgeFromEnv({DREAM_JUDGE:'off'}),null);
  assert.throws(()=>dreamJudgeFromEnv({DREAM_JUDGE:'gpt'}),/DREAM_JUDGE/);

  const calls=[];
  const agent=async args=>{calls.push(args);return 'Notes follow.\n```json\n{"notes":"Answer skipped the parking waiver check.","memories":[{"scope":"global","principal":"everyone","category":"judge-insight","rule":"Check parking waivers before stating parking requirements.","confidence":0.9}],"expansions":[{"term":"parking waiver","expansion":"ZR 25-261 waiver of requirements"}]}\n```';};
  const judge=dreamJudgeFromEnv({DREAM_JUDGE:'codex'},{agent,loadSecrets:()=>({CODEX_BIN:'/bin/false'})});
  assert.equal(typeof judge,'function');
  const run={id:'r1',owner:'alice',status:'completed',input:'Parking at 120 Broadway?',result:{answer:'No parking is required [1].',sources:[{id:1,title:'ZR',url:'https://zr.planning.nyc.gov/article-ii/chapter-5'}]}};
  const ev=await evaluateRun({run,events:[],judge});
  assert.equal(calls.length,1);
  assert.equal(calls[0].label,'dream-judge');
  assert.deepEqual(calls[0].dynamicTools,[]);
  assert.equal(ev.notes,'Answer skipped the parking waiver check.');
  const judged=ev.candidateMemories.find(m=>m.category==='judge-insight');
  assert.equal(judged.scope,'account','a judge cannot write global memories');
  assert.equal(judged.principal,'alice');
  assert.equal(ev.candidateExpansions.at(-1).term,'parking waiver');
});

test('dream:report summarizes recent dream runs and the review queue, and dream:approve/reject flip status from the host CLI',async t=>{
  const {store,knowledge,dir,paths}=setup(t);
  const conv=store.createConversation('alice');
  recordLearningRun(store,'alice',conv,1);
  recordLearningRun(store,'alice',conv,2);
  await runDreamCycle({store,knowledge});

  const report=dreamReport({store,knowledge,runs:5});
  assert.match(report,/^# Dream report/m);
  assert.match(report,/## Run scores/);
  assert.match(report,/5\.5% exit cap/);
  assert.match(report,/skylineinclusion/);
  assert.match(report,new RegExp(officialUrl.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(report,/## Promotion candidates/);

  const cli=join(here,'..','scripts','dream-review.mjs');
  const env={...process.env,RESEARCH_STATE_PATH:paths.chat,KNOWLEDGE_DB_PATH:paths.knowledge};
  const out=join(dir,'report.md');
  execFileSync(process.execPath,[cli,'report','--out',out,'--runs','3'],{env});
  assert.ok(existsSync(out));
  assert.match(readFileSync(out,'utf8'),/skylineinclusion/);

  const memory=store.listMemories().find(m=>m.rule.includes('5.5% exit cap'));
  const [expansion]=knowledge.listExpansions();
  execFileSync(process.execPath,[cli,'approve','--id',memory.id,'--kind','memory','--by','michael'],{env});
  execFileSync(process.execPath,[cli,'reject','--id',expansion.id,'--kind','expansion','--by','michael'],{env});
  execFileSync(process.execPath,[cli,'approve','--id',officialUrl,'--kind','source','--by','michael'],{env});
  assert.equal(store.listMemories().find(m=>m.id===memory.id).approved_by,'michael');
  assert.equal(knowledge.listExpansions()[0].rejected_by,'michael');
  assert.equal(knowledge.stagedSources('promoted').length,1);
  assert.throws(()=>execFileSync(process.execPath,[cli,'approve','--id',memory.id,'--kind','policy'],{env,stdio:'pipe'}));
});

test('a judge failure keeps the heuristic evaluation and never aborts the cycle',async t=>{
  const {store,knowledge}=setup(t),conv=store.createConversation('alice');
  recordLearningRun(store,'alice',conv,1);recordLearningRun(store,'alice',conv,2);
  const judged=[];
  const result=await runDreamCycle({store,knowledge,judge:async({run})=>{judged.push(run.id);if(judged.length===2)throw new Error('second judge unavailable');return {notes:'Completed first evaluation'};}});
  assert.equal(result.runsEvaluated,2,'both runs are scored even though one judge call failed');
  assert.equal(result.judgeFailed,1);
  assert.equal(store.unevaluatedRuns().length,0);
  const first=store.getEvaluation(judged[0]),second=store.getEvaluation(judged[1]);
  assert.equal(first.notes,'Completed first evaluation');
  assert.equal(first.signals.judgeError,null);
  assert.match(second.signals.judgeError,/second judge unavailable/);
  assert.equal(second.notes,null);
  // The failed run keeps its heuristic result, identical to scoring with no judge at all.
  const heuristic=await evaluateRun({run:store.runRow(judged[1]),events:store.runEvents(judged[1]),messages:store.messageRows(conv.id),projectState:store.project.read(store.projectOf(conv.id))});
  assert.equal(second.overall,heuristic.overall);
  assert.ok(second.overall>0,'heuristic mechanics score survives the judge failure');

  // A judge that never answers times out into the same heuristic fallback.
  const slow=await evaluateRun({run:{id:'slow',owner:'alice',status:'completed',input:'q',result:{answer:'Supported answer with a citation [1].',sources:[{id:1,title:'ZR',url:'https://zr.planning.nyc.gov/article-ii/chapter-3'}]}},events:[],judge:async()=>new Promise(()=>{}),judgeTimeoutMs:20});
  assert.match(slow.judgeError,/timed out/);
  assert.ok(slow.overall>0);
  assert.equal(slow.notes,null);

  // A judge reply that is not usable JSON also falls back instead of throwing.
  const garbledJudge=dreamJudgeFromEnv({DREAM_JUDGE:'codex'},{agent:async()=>'no json here',loadSecrets:()=>({})});
  const garbled=await evaluateRun({run:{id:'g',owner:'alice',status:'completed',input:'q',result:{answer:'Supported answer with a citation [1].',sources:[{id:1,title:'ZR',url:'https://zr.planning.nyc.gov/article-ii/chapter-3'}]}},events:[],judge:garbledJudge});
  assert.ok(garbled.judgeError);
  assert.ok(garbled.overall>0);
});
