// Local dry run of the dream model judge against fixture run data. No Codex, wallet or network:
// a stub agent stands in for runCodex, so this exercises createCodexJudge -> evaluateRun ->
// runDreamCycle (including the judge-failure heuristic fallback) against throwaway stores.
//   node scripts/dream-judge-dry-run.mjs
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from '../acres-research/store.mjs';
import {KnowledgeStore} from '../acres-research/knowledge.mjs';
import {createCodexJudge,runDreamCycle} from '../acres-research/dream.mjs';

const dir=mkdtempSync(join(tmpdir(),'acres-dream-dry-run-'));
const store=new ChatStore(join(dir,'chat.sqlite'));
const knowledge=new KnowledgeStore(join(dir,'knowledge.sqlite'));
try{
  const conv=store.createConversation('alice');
  const run=store.createRun('alice',conv.id,'Fixture: UAP bonus at 120 Broadway?');
  store.begin(run);
  store.event(run.id,'tool.started',{tool:'acres_fanout_search',arguments:{query:'uap bouns'}});
  store.event(run.id,'tool.completed',{tool:'acres_fanout_search',arguments:{query:'uap bouns'},success:true,result:{results:[]}});
  store.event(run.id,'tool.started',{tool:'acres_fanout_search',arguments:{query:'universal affordability preference ZR 23-22'}});
  store.event(run.id,'tool.completed',{tool:'acres_fanout_search',arguments:{query:'universal affordability preference ZR 23-22'},success:true,result:{results:[{id:1}]}});
  store.finish(run,'completed',{
    answer:'UAP permits an additional 20 percent residential floor area bonus [1].',
    property:{bbl:'1000477501',borough:'MN',jurisdiction:'nyc'},
    sources:[{id:1,title:'NYC ZR 23-22',url:'https://zr.planning.nyc.gov/article-ii/chapter-3/23-22',text:'Universal Affordability Preference (UAP) permits an additional 20 percent residential floor area bonus.'}],
  });

  const agentCalls=[];
  const agent=async args=>{
    agentCalls.push({label:args.label,effort:args.effort,tools:args.dynamicTools.length});
    if(agentCalls.length===2)throw new Error('stub judge outage');
    return '```json\n{"notes":"Fixture answer is supported by the captured ZR text.","memories":[{"scope":"global","category":"judge-insight","rule":"Confirm the affordability bonus percentage in the operative zoning text before underwriting it.","confidence":0.9}],"expansions":[{"term":"uap bouns","expansion":"universal affordability preference ZR 23-22"}]}\n```';
  };
  const judge=createCodexJudge({secrets:{CODEX_BIN:'/bin/false'},agent});

  const cycle=await runDreamCycle({store,knowledge,judge});
  const [ev]=cycle.evaluations;
  console.log(JSON.stringify({
    event:'dream_judge_dry_run',
    agentCalls,
    runsEvaluated:cycle.runsEvaluated,
    judgeFailed:cycle.judgeFailed,
    overall:ev.overall,
    notes:ev.notes,
    judgeError:ev.judgeError,
    memories:ev.candidateMemories.map(m=>({scope:m.scope,principal:m.principal,category:m.category,rule:m.rule})),
    expansions:ev.candidateExpansions.map(e=>({term:e.term,expansion:e.expansion,scope:e.scope,account:e.account})),
  },null,2));

  // Second fixture run: the stub judge now fails, so the heuristic result must stand alone.
  const run2=store.createRun('alice',conv.id,'Fixture: judge outage run');
  store.begin(run2);
  store.finish(run2,'completed',{answer:'UAP permits an additional 20 percent residential floor area bonus [1].',sources:[{id:1,title:'NYC ZR 23-22',url:'https://zr.planning.nyc.gov/article-ii/chapter-3/23-22',text:'UAP text.'}]});
  const cycle2=await runDreamCycle({store,knowledge,judge});
  const [ev2]=cycle2.evaluations;
  console.log(JSON.stringify({event:'dream_judge_dry_run_fallback',runsEvaluated:cycle2.runsEvaluated,judgeFailed:cycle2.judgeFailed,overall:ev2.overall,judgeError:ev2.judgeError,notes:ev2.notes},null,2));
}finally{
  knowledge.close();
  store.close();
  rmSync(dir,{recursive:true,force:true});
}
