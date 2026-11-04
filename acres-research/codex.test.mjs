import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {selectEffort,runCodex,closeCodexPool,enumerateAsks,parseCheck,simpleDeliverableCheck,capacityLint,deliverableLint,decisionLint,decisionInputs,filledAnswer} from './codex.mjs';
import {validateCitations} from './lanes.mjs';

function createFakeCodexServer({turns=[]}={}){
  let turnIndex=0;
  const requests=[];
  const spawnCount={value:0};
  const holds=[];
  const release=()=>{for(const r of holds.splice(0))r();};

  const spawnProcess=()=>{
    spawnCount.value++;
    const proc=new EventEmitter();
    proc.stdout=new EventEmitter();
    proc.stderr=new EventEmitter();
    proc.exitCode=null;
    proc.signalCode=null;
    proc.kill=sig=>{
      proc.signalCode=sig||'SIGTERM';
      proc.exitCode=0;
      proc.emit('exit',0);
    };
    setImmediate(()=>{
      proc.stderr.emit('data',Buffer.from('listening on: ws://127.0.0.1:49999\n'));
    });
    return proc;
  };

  const createWebSocket=()=>{
    const ws=new EventEmitter();
    ws.readyState=1;
    ws.terminate=()=>{ws.readyState=3;ws.emit('close');};
    ws.close=ws.terminate;
    ws.send=raw=>{
      const msg=JSON.parse(raw);
      requests.push(msg);
      if(msg.method==='initialize'){
        setImmediate(()=>ws.emit('message',Buffer.from(JSON.stringify({id:msg.id,result:{serverInfo:{name:'fake-codex'}}}))));
      }else if(msg.method==='account/login/start'){
        setImmediate(()=>ws.emit('message',Buffer.from(JSON.stringify({id:msg.id,result:{ok:true}}))));
      }else if(msg.method==='thread/start'){
        setImmediate(()=>ws.emit('message',Buffer.from(JSON.stringify({id:msg.id,result:{thread:{id:'thread-1'}}}))));
      }else if(msg.method==='turn/start'){
        const spec=turns[turnIndex++]||{text:'Default answer [1].'};
        const n=turnIndex;
        setImmediate(async()=>{
          ws.emit('message',Buffer.from(JSON.stringify({id:msg.id,result:{turn:{id:`turn-${n}`}}})));
          if(spec.hold)await new Promise(resolve=>{holds.push(resolve);});
          for(const [i,call] of (spec.toolCalls||[]).entries()){
            ws.emit('message',Buffer.from(JSON.stringify({id:`tc-${n}-${i}`,method:'item/tool/call',params:{threadId:'thread-1',tool:call.tool,arguments:call.arguments||{}}})));
            await new Promise(r=>setTimeout(r,10));
          }
          if(spec.text){
            ws.emit('message',Buffer.from(JSON.stringify({method:'item/agentMessage/delta',params:{itemId:'item-1',delta:spec.text}})));
            ws.emit('message',Buffer.from(JSON.stringify({method:'item/completed',params:{item:{id:'item-1',type:'agentMessage',phase:'final_answer',text:spec.text}}})));
          }
          ws.emit('message',Buffer.from(JSON.stringify({method:'turn/completed',params:{turn:{id:`turn-${n}`,status:'completed'}}})));
        });
      }
    };
    setImmediate(()=>ws.emit('open'));
    return ws;
  };

  const oauth=async()=>({accessToken:'tok',chatgptAccountId:'acc-1'});
  return {spawnProcess,createWebSocket,oauth,requests,spawnCount,release};
}

test('selectEffort routes simple lookups to low, specialist lanes to medium, and complex feasibility to high',()=>{
  assert.equal(selectEffort({message:'What is the zoning of 120 Broadway?'}),'low');
  assert.equal(selectEffort({message:'Compare the ULURP rezoning timeline and 485-x pro forma sensitivity for 120 Broadway'}),'high');
  assert.equal(selectEffort({message:'Assemble lots 1 and 2 and model 3D massing concepts'}),'high');
  assert.equal(selectEffort({message:'Check recent precedents',label:'lane:case-law'}),'medium');
  assert.equal(selectEffort({message:'Any message',effort:'low'}),'low');
});

test('runCodex injects workspace memories and repairs invalid citations in-thread without failing the run',async()=>{
  const fake=createFakeCodexServer({
    turns:[
      {text:'Initial draft with fabricated source [99].'},
      {text:'Corrected draft citing valid source [1].'},
    ],
  });
  const events=[];
  const sources=[{id:1,title:'NYC Planning PLUTO',url:'https://data.cityofnewyork.us/1'}];

  const answer=await runCodex({
    message:'Underwrite 120 Broadway pro forma and sensitivity',
    history:[],
    memories:['Always include a 5.5% exit cap sensitivity row.'],
    dynamicTools:[],
    execute:async()=>({}),
    secrets:{},
    oauth:fake.oauth,
    spawnProcess:fake.spawnProcess,
    createWebSocket:fake.createWebSocket,
    validateAnswer:text=>{
      if(text.includes('[99]'))throw new Error('Research answer contained invalid source reference [99].');
    },
    getSources:()=>sources,
    emit:(ev,data)=>events.push({ev,data}),
  });

  assert.equal(answer,'Corrected draft citing valid source [1].');
  const turnStarts=fake.requests.filter(r=>r.method==='turn/start');
  assert.equal(turnStarts.length,2);
  assert.equal(turnStarts[0].params.effort,'high');
  assert.match(turnStarts[0].params.input[0].text,/Workspace memory hints/);
  assert.match(turnStarts[0].params.input[0].text,/Always include a 5\.5% exit cap sensitivity row\./);
  assert.equal(turnStarts[1].params.effort,'high','citation repair runs at the original effort');
  assert.match(turnStarts[1].params.input[0].text,/failed citation validation/);
  assert.equal(events.some(e=>e.ev==='turn.repair'),true);
});

test('the citation repair turn names the sentence the validator rejected',async t=>{
  t.after(()=>closeCodexPool());
  const sources=[{id:1,title:'NYC Planning PLUTO',url:'https://data.cityofnewyork.us/1',text:'Parcel 1000477501 is zoned C5-5 with a lot area of 20,000 square feet.'}];
  const fake=createFakeCodexServer({turns:[{text:'The parcel is zoned C5-5 [1].\nComparable condominiums sold quickly near the waterfront promenade. [1]'},{text:'The parcel is zoned C5-5 [1].'}]});
  const events=[];
  const answer=await runCodex(codexArgs(fake,{message:'What is the zoning?',getSources:()=>sources,validateAnswer:text=>validateCitations(text,sources),emit:(ev,data)=>events.push({ev,data})}));
  assert.equal(answer,'The parcel is zoned C5-5 [1].');
  const repair=fake.requests.filter(r=>r.method==='turn/start')[1].params.input[0].text;
  assert.match(repair,/The rejected sentence was "Comparable condominiums sold quickly near the waterfront promenade\.", citing \[1\]/);
  const event=events.find(e=>e.ev==='turn.repair').data;
  assert.equal(event.claim,'Comparable condominiums sold quickly near the waterfront promenade.');
  assert.deepEqual(event.claimSourceIds,[1]);
});

test('runCodex reuses warm daemon from pool when CODEX_WARM_POOL is enabled',async t=>{
  t.after(()=>closeCodexPool());
  const fake=createFakeCodexServer({
    turns:[{text:'First answer [1].'},{text:'Second answer [1].'}],
  });
  const secrets={CODEX_WARM_POOL:true,CODEX_BIN:'/opt/acres-research/bin/codex'};

  const first=await runCodex({
    message:'Lookup 120 Broadway',
    dynamicTools:[],
    execute:async()=>({}),
    secrets,
    oauth:fake.oauth,
    spawnProcess:fake.spawnProcess,
    createWebSocket:fake.createWebSocket,
  });
  assert.equal(first,'First answer [1].');
  assert.equal(fake.spawnCount.value,1);

  const second=await runCodex({
    message:'Lookup 122 Broadway',
    dynamicTools:[],
    execute:async()=>({}),
    secrets,
    oauth:fake.oauth,
    spawnProcess:fake.spawnProcess,
    createWebSocket:fake.createWebSocket,
  });
  assert.equal(second,'Second answer [1].');
  // Second call reused the pooled daemon without spawning a second process!
  assert.equal(fake.spawnCount.value,1);
});

function codexArgs(fake,extra={}){
  return {history:[],dynamicTools:[],execute:async()=>({}),secrets:{},oauth:fake.oauth,spawnProcess:fake.spawnProcess,createWebSocket:fake.createWebSocket,...extra};
}
const validOnly=text=>{if(/\[9\d\]/.test(text))throw new Error('Research answer contained invalid source reference.');};

test('enumerateAsks splits numbered, bulleted and multi-question prompts into separate asks',()=>{
  assert.deepEqual(enumerateAsks('For 12 Main St:\n1. What is the zoning?\n2. Size the UAP bonus.\n3) Outline the approval path.'),['What is the zoning?','Size the UAP bonus.','Outline the approval path.']);
  assert.deepEqual(enumerateAsks('Options: (1) as-of-right rental (2) condo conversion (3) landmark transfer'),['as-of-right rental','condo conversion','landmark transfer']);
  assert.deepEqual(enumerateAsks('What is the FAR? How many units fit? Is a variance needed?'),['What is the FAR?','How many units fit?','Is a variance needed?']);
  assert.deepEqual(enumerateAsks('Tell me about this site'),['Tell me about this site']);
});

test('original user request controls effort and asks independently of listing context',async()=>{
  const fake=createFakeCodexServer({turns:[{text:'The zoning is R6 [1].'},{text:'{"complete":true,"missing":[]}'}]});
  const events=[];
  const userMessage='What is the zoning?';
  const context='Authoritative listing context: '+JSON.stringify({rows:Array.from({length:20},(_,i)=>({id:i,address:`Row ${i}`,note:'Compare hypothetical pro forma options'}))});
  await runCodex(codexArgs(fake,{message:`${context}\n\n${userMessage}`,userMessage,checkDeliverables:true,emit:(ev,data)=>events.push({ev,data})}));
  const starts=fake.requests.filter(r=>r.method==='turn/start');
  assert.equal(starts[0].params.effort,'low');
  assert.match(starts[0].params.input[0].text,/Row 19/,'page context is retained');
  assert.doesNotMatch(starts[1].params.input[0].text,/Authoritative listing context|Row 19/);
  assert.deepEqual(events.find(e=>e.ev==='turn.check').data.asks,[userMessage]);
});

test('deliverable verdicts reject malformed, inconsistent, unfinished and extraneous output',()=>{
  for(const raw of ['', '{"complete":', '{"complete":"true"}', '{"complete":false}', '{"complete":false,"missing":[]}', '{"complete":true,"missing":["still missing"]}', '{"complete":true,"missing":null}', '{"complete":false,"missing":[42]}', '{"complete":false,"missing":[" "]}', '{"complete":true,"extra":1}', 'Notes: {"complete":true}', '[{"complete":true}]'])assert.equal(parseCheck(raw),null,raw);
  assert.deepEqual(parseCheck('{"complete":true}'),{complete:true,missing:[]});
  assert.deepEqual(parseCheck('```json\n{"complete":false,"missing":["Missing computation"]}\n```'),{complete:false,missing:['Missing computation']});
});

test('simple checks cover only clarification or an exact sourced single-field lookup',()=>{
  const sources=[{id:1,verified:true,text:JSON.stringify({bbl:'1000477501',address:'120 Broadway'})}];
  assert.equal(simpleDeliverableCheck('What is the BBL?','BBL: 1000477501 [1].',sources)?.basis,'exact_sourced_lookup');
  assert.equal(simpleDeliverableCheck('What is the BBL and ownership?','BBL: 1000477501 [1].',sources),null);
  for(const message of ['What is the BBL? Also provide the zoning district.','What is the BBL; provide zoning.','What is the BBL including zoning','What is the BBL?\nDescribe zoning.','What is the BBL for 120 Broadway?'])assert.equal(simpleDeliverableCheck(message,'BBL: 1000477501 [1].',sources),null,message);
  assert.equal(simpleDeliverableCheck('What is the address? Include its owner.','Address: 120 Broadway [1].',sources),null);
  assert.equal(simpleDeliverableCheck('Lookup the address.','Address: 120 Broadway [1].',sources)?.basis,'exact_sourced_lookup');
  assert.equal(simpleDeliverableCheck('What is the BBL?','BBL: 1000477502 [1].',sources),null);
  assert.equal(simpleDeliverableCheck('Analyze this property','Which property do you mean?')?.basis,'clarification_only');
  assert.equal(simpleDeliverableCheck('Analyze this property','Which property permits 100 units?'),null);
});

test('the citation repair turn names every rejected sentence so one repair can fix them all',async()=>{
  const sources=[{id:1,title:'NYC Planning PLUTO',url:'https://data.cityofnewyork.us/1',text:'Parcel 1000477501 is zoned C5-5 with a lot area of 20,000 square feet.'}];
  const draft='Rents average forty dollars per foot along the corridor [1]. Condominiums sold quickly near the waterfront promenade [1].';
  const fake=createFakeCodexServer({turns:[{text:draft},{text:'The parcel is zoned C5-5 with a lot area of 20,000 square feet [1].'}]});
  const events=[];
  const answer=await runCodex(codexArgs(fake,{message:'What is the zoning?',getSources:()=>sources,validateAnswer:text=>validateCitations(text,sources),emit:(ev,data)=>events.push({ev,data})}));
  assert.equal(answer,'The parcel is zoned C5-5 with a lot area of 20,000 square feet [1].');
  const repair=fake.requests.filter(r=>r.method==='turn/start')[1].params.input[0].text;
  assert.match(repair,/These 2 sentences were rejected/);
  assert.match(repair,/1\. "Rents average forty dollars per foot along the corridor\s*\.", citing \[1\]/);
  assert.match(repair,/2\. "Condominiums sold quickly near the waterfront promenade\s*\.", citing \[1\]/);
  assert.equal(events.find(e=>e.ev==='turn.repair').data.failedClaims,2);
});

test('an exact sourced lookup avoids an extra model turn without changing the answer',async()=>{
  const fake=createFakeCodexServer({turns:[{text:'BBL: 1000477501 [1].'}]});
  const outcomes=[];
  const answer=await runCodex(codexArgs(fake,{message:'What is the BBL?',checkDeliverables:true,getSources:()=>[{id:1,verified:true,text:'{"bbl":"1000477501"}'}],onOutcome:o=>outcomes.push(o)}));
  assert.equal(answer,'BBL: 1000477501 [1].');
  assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,1);
  assert.equal(outcomes[0].check.basis,'exact_sourced_lookup');
});

test('multi-ask BBL and address requests retain initial and final completeness checks',async()=>{
  const sources=[{id:1,verified:true,title:'Parcel BBL address owner and zoning district',url:'https://example.com/parcel',text:JSON.stringify({bbl:'1000477501',address:'120 Broadway',owner:'Example Owner',zoning:'R6'})}];
  for(const {message,draft,missing} of [
    {message:'What is the BBL? Also provide the zoning district.',draft:'BBL: 1000477501 [1].',missing:'Missing zoning district'},
    {message:'What is the address? Include its owner.',draft:'Address: 120 Broadway [1].',missing:'Missing owner'},
  ]){
    const verdict=JSON.stringify({complete:false,missing:[missing]});
    const fake=createFakeCodexServer({turns:[{text:draft},{text:verdict},{text:draft},{text:verdict}]});
    let outcome,unlocked=0;
    const answer=await runCodex(codexArgs(fake,{message,checkDeliverables:true,getSources:()=>sources,validateAnswer:text=>validateCitations(text,sources),onOutcome:value=>outcome=value,unlockReserve:()=>unlocked++}));
    assert.equal(answer,draft);assert.equal(unlocked,1);
    assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,4,'initial check, bounded fill and final check all execute');
    assert.equal(outcome.check.status,'incomplete');assert.equal(outcome.check.basis,'model_check');
    assert.deepEqual(outcome.check.missing,[missing]);assert.equal(outcome.check.initial.status,'incomplete');
  }
});

test('malformed check output leaves verification explicitly unknown without inventing a repair',async()=>{
  const fake=createFakeCodexServer({turns:[{text:'Draft answer [1].'},{text:'{"complete":false,"missing":[]}'}]});
  const outcomes=[];let unlocked=0;
  const answer=await runCodex(codexArgs(fake,{message:'Analyze the options',checkDeliverables:true,onOutcome:o=>outcomes.push(o),unlockReserve:()=>unlocked++}));
  assert.equal(answer,'Draft answer [1].');assert.equal(outcomes[0].check.status,'unverified');
  assert.equal(unlocked,0);assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,2);
});

test('a fill is rechecked once and remaining or unverified gaps never trigger another fill',async()=>{
  for(const [last,status] of [['{"complete":false,"missing":["Still missing the cost"]}','incomplete'],['{"complete":','unverified']]){
    const fake=createFakeCodexServer({turns:[{text:'Initial draft [1].'},{text:'{"complete":false,"missing":["Missing the cost"]}'},{text:'Filled draft [1].'},{text:last}]});
    const outcomes=[];let unlocked=0;
    assert.equal(await runCodex(codexArgs(fake,{message:'Compare program costs',checkDeliverables:true,unlockReserve:()=>unlocked++,onOutcome:o=>outcomes.push(o)})),'Filled draft [1].');
    assert.equal(outcomes[0].check.status,status);assert.equal(outcomes[0].check.initial.status,'incomplete');
    assert.equal(unlocked,1);assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,4);
    assert.match(fake.requests.filter(r=>r.method==='turn/start')[3].params.input[0].text,/Previously missing/);
  }
});

test('deliverable check: an incomplete draft unlocks the reserve and gets one fill turn at the original effort',async()=>{
  const fake=createFakeCodexServer({turns:[
    {text:'Draft naming a UAP option [1].'},
    {text:'{"complete":false,"missing":["UAP option named but never sized","DOB filings retrieved but not reported"]}'},
    {text:'Full answer sizing the UAP option at 12,000 sq ft and reporting the DOB filings [1].'},
    {text:'{"complete":true,"missing":[]}'},
  ]});
  const events=[],outcomes=[];let unlocked=0;
  const answer=await runCodex(codexArgs(fake,{
    message:'Underwrite 120 Broadway: 1. size the UAP bonus 2. report DOB filings 3. approval path',
    validateAnswer:validOnly,getSources:()=>[{id:1,title:'PLUTO',url:'https://data.cityofnewyork.us/1'}],
    checkDeliverables:true,unlockReserve:()=>{unlocked++;},onOutcome:o=>outcomes.push(o),
    emit:(ev,data)=>events.push({ev,data}),
  }));
  assert.match(answer,/sizing the UAP option/);
  const turnStarts=fake.requests.filter(r=>r.method==='turn/start');
  assert.equal(turnStarts.length,4);
  assert.equal(turnStarts[1].params.effort,'low');
  assert.match(turnStarts[1].params.input[0].text,/size the UAP bonus/);
  assert.match(turnStarts[1].params.input[0].text,/Draft naming a UAP option/);
  assert.equal(turnStarts[2].params.effort,'high');
  assert.match(turnStarts[2].params.input[0].text,/never sized/);
  assert.match(turnStarts[2].params.input[0].text,/3 reserved tool calls/);
  assert.equal(unlocked,1);
  const check=events.find(e=>e.ev==='turn.check');
  assert.equal(check.data.complete,false);
  assert.deepEqual(check.data.missing,['UAP option named but never sized','DOB filings retrieved but not reported']);
  assert.equal(outcomes.at(-1).effort,'high');
  assert.equal(outcomes.at(-1).check.status,'complete');
  assert.equal(outcomes.at(-1).check.initial.status,'incomplete');
  assert.equal(events.filter(e=>e.ev==='turn.check').at(-1).data.phase,'after_fill');
  assert.equal(outcomes.at(-1).repairFailed,false);
});

test('deliverable check: a complete draft is returned unchanged and the reserve stays locked',async()=>{
  const fake=createFakeCodexServer({turns:[{text:'Complete draft [1].'},{text:'{"complete":true,"missing":[]}'}]});
  const events=[];let unlocked=0;
  const answer=await runCodex(codexArgs(fake,{message:'What is the FAR at 120 Broadway?',validateAnswer:validOnly,checkDeliverables:true,unlockReserve:()=>{unlocked++;},emit:(ev,data)=>events.push({ev,data})}));
  assert.equal(answer,'Complete draft [1].');
  assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,2);
  assert.equal(unlocked,0);
  assert.equal(events.find(e=>e.ev==='turn.check').data.complete,true);
  assert.equal(events.some(e=>e.ev.startsWith('message.')&&/"complete"/.test(e.data.delta||e.data.text||'')),false,'the check verdict never streams as chat text');
});

const dobJobs=['121184526','121190011','140233875','104512330','121007652','140001234'];
const stubPublicRecords=()=>({bbl:'1000477501',sourceIds:{dobBis:1},
  dobBisFilings:dobJobs.map((jobNumber,i)=>({jobNumber,docNumber:'01',jobType:i?'A1':'NB',outcome:'approved',proposedZoningSqft:48210+i,description:'Filed alteration'})),
  dobNowFilings:[],certificatesOfOccupancy:[],
  proseReportingMandate:'IMPORTANT: report the DOB job numbers.'});

test('reporting lint: a draft that omits every DOB job number reports the table missing and unlocks the reserve over a complete model verdict',async()=>{
  const fake=createFakeCodexServer({turns:[
    {toolCalls:[{tool:'acres_nyc_public_records',arguments:{}}],text:'The lot allows 4.0 FAR as of right [1].'},
    {text:'{"complete":true}'},
    {text:'The lot allows 4.0 FAR [1]; DOB job 121184526 was approved [1].'},
    {text:'{"complete":true,"missing":[]}'},
  ]});
  const events=[],outcomes=[];let unlocked=0;
  const answer=await runCodex(codexArgs(fake,{message:'What can be built here?',validateAnswer:validOnly,checkDeliverables:true,
    execute:async()=>stubPublicRecords(),unlockReserve:()=>{unlocked++;},onOutcome:o=>outcomes.push(o),emit:(ev,data)=>events.push({ev,data})}));
  assert.match(answer,/121184526/);
  const check=outcomes.at(-1).check;
  assert.equal(check.status,'complete');
  assert.equal(check.initial.status,'incomplete');
  assert.ok(check.initial.missing.some(line=>/dobBisFilings/.test(line)),check.initial.missing.join(' | '));
  assert.equal(check.initial.missing.some(line=>/dobNowFilings|certificatesOfOccupancy/.test(line)),false,'empty tables are never required');
  assert.equal(unlocked,1);
  const turnStarts=fake.requests.filter(r=>r.method==='turn/start');
  assert.equal(turnStarts.length,4);
  assert.match(turnStarts[2].params.input[0].text,/dobBisFilings/);
  assert.equal(events.find(e=>e.ev==='turn.check').data.complete,false);
});

test('reporting lint: a draft that says the records returned no filings while rows exist is flagged',async()=>{
  const fake=createFakeCodexServer({turns:[
    {toolCalls:[{tool:'acres_nyc_public_records',arguments:{}}],text:'DOB BIS returned no filings for this lot [1]. Job 121,184,526 appears only as a certificate reference [1].'},
    {text:'{"complete":true}'},
    {text:'DOB BIS lists six filings, including job 121184526 [1].'},
    {text:'{"complete":true,"missing":[]}'},
  ]});
  const outcomes=[];let unlocked=0;
  await runCodex(codexArgs(fake,{message:'Any prior DOB filings?',validateAnswer:validOnly,checkDeliverables:true,
    execute:async()=>stubPublicRecords(),unlockReserve:()=>{unlocked++;},onOutcome:o=>outcomes.push(o)}));
  const {missing}=outcomes.at(-1).check.initial;
  assert.equal(outcomes.at(-1).check.status,'complete');
  assert.equal(missing.some(line=>/dobBisFilings \(6 rows\) retrieved/.test(line)),false,'a job number with thousands separators counts as reported');
  assert.ok(missing.some(line=>/returned no filings/i.test(line)&&/dobBisFilings/.test(line)),missing.join(' | '));
  assert.equal(unlocked,1);
});

test('reporting lint passes a draft that reports a record from each retrieved table',async()=>{
  const fake=createFakeCodexServer({turns:[
    {toolCalls:[{tool:'acres_nyc_public_records',arguments:{}}],text:'DOB BIS shows NB job 121184526 approved for 48,210 sq ft [1]. No HPD violations are open [1].'},
    {text:'{"complete":true}'},
  ]});
  const outcomes=[];let unlocked=0;
  const answer=await runCodex(codexArgs(fake,{message:'Any prior DOB filings?',validateAnswer:validOnly,checkDeliverables:true,
    execute:async()=>stubPublicRecords(),unlockReserve:()=>{unlocked++;},onOutcome:o=>outcomes.push(o)}));
  assert.match(answer,/121184526/);
  assert.equal(outcomes.at(-1).check.status,'complete');
  assert.equal(unlocked,0);
  assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,2);
});

test('deliverable check is skipped when ENABLE_DELIVERABLE_CHECK is false',async()=>{
  const fake=createFakeCodexServer({turns:[{text:'Draft [1].'}]});
  const outcomes=[];
  await runCodex(codexArgs(fake,{message:'What is the FAR?',secrets:{ENABLE_DELIVERABLE_CHECK:false},validateAnswer:validOnly,checkDeliverables:true,onOutcome:o=>outcomes.push(o)}));
  assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,1);
  assert.equal(outcomes.at(-1).check.status,'skipped');
});

test('deliverable check refuses tool calls during the check turn without running them',async()=>{
  const fake=createFakeCodexServer({turns:[
    {text:'Draft [1].'},
    {toolCalls:[{tool:'acres_fetch_url',arguments:{url:'https://www.nyc.gov/x'}}],text:'{"complete":true}'},
  ]});
  const executed=[],events=[];
  await runCodex(codexArgs(fake,{message:'What is the FAR?',validateAnswer:validOnly,checkDeliverables:true,execute:async name=>{executed.push(name);return {};},emit:(ev,data)=>events.push({ev,data})}));
  assert.deepEqual(executed,[]);
  const refused=events.find(e=>e.ev==='tool.completed');
  assert.equal(refused.data.success,false);
  assert.match(refused.data.result.error,/deliverable check/);
});

test('a fill that fails citations falls back to the validated draft without a repair turn',async()=>{
  const fake=createFakeCodexServer({turns:[
    {text:'Validated draft [1].'},
    {text:'{"complete":false,"missing":["pro forma not run"]}'},
    {text:'## Additional detail\n\nFill with fabricated source [98].'},
  ]});
  const outcomes=[];
  const answer=await runCodex(codexArgs(fake,{message:'Underwrite the pro forma',validateAnswer:validOnly,getSources:()=>[{id:1,title:'PLUTO'}],checkDeliverables:true,unlockReserve:()=>{},onOutcome:o=>outcomes.push(o)}));
  assert.equal(answer,'Validated draft [1].');
  assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,3);
  assert.equal(outcomes.at(-1).check.fillStatus,'rejected');
  assert.equal(outcomes.at(-1).repairFailed,false);
});

test('a fill adds to the draft under its heading, and a full corrected answer replaces it',()=>{
  assert.equal(filledAnswer('Draft [1].','## Additional detail\n\nThe UAP option adds 4,000 sq ft [1].'),'Draft [1].\n\n## Additional detail\n\nThe UAP option adds 4,000 sq ft [1].');
  assert.equal(filledAnswer('Draft [1].','Corrected full answer [1].'),'Corrected full answer [1].');
  assert.equal(filledAnswer('Draft [1].','## Additional detail'),'Draft [1].');
});

test('the fill writes only additions, which are appended to the draft and checked together',async()=>{
  const fake=createFakeCodexServer({turns:[
    {text:'Draft sizing the base program [1].'},
    {text:'{"complete":false,"missing":["UAP option named but never sized"]}'},
    {text:'## Additional detail\n\nThe UAP option adds 4,000 sq ft [1].'},
    {text:'{"complete":true,"missing":[]}'},
  ]});
  const outcomes=[];
  const answer=await runCodex(codexArgs(fake,{message:'Size the base and UAP programs',validateAnswer:validOnly,checkDeliverables:true,onOutcome:o=>outcomes.push(o)}));
  assert.equal(answer,'Draft sizing the base program [1].\n\n## Additional detail\n\nThe UAP option adds 4,000 sq ft [1].');
  const turnStarts=fake.requests.filter(r=>r.method==='turn/start');
  assert.match(turnStarts[2].params.input[0].text,/Write only the new material, starting with the line "## Additional detail"/);
  assert.match(turnStarts[3].params.input[0].text,/The UAP option adds 4,000 sq ft/,'the after-fill check reads the combined answer');
  assert.equal(outcomes[0].check.status,'complete');assert.equal(outcomes[0].check.fillStatus,'validated');
});

test('a fill that outlives the run deadline is interrupted and the validated draft is the answer',async()=>{
  const fake=createFakeCodexServer({turns:[
    {text:'Validated draft [1].'},
    {text:'{"complete":false,"missing":["UAP option never sized"]}'},
    {hold:true,text:'## Additional detail\n\nToo late [1].'},
  ]});
  const outcomes=[];
  const started=Date.now();
  const answer=await runCodex(codexArgs(fake,{message:'Size the UAP option',validateAnswer:validOnly,checkDeliverables:true,onOutcome:o=>outcomes.push(o),
    deadlineMs:1500,followUp:{fillMinMs:100,marginMs:200,checkMaxMs:1000}}));
  assert.equal(answer,'Validated draft [1].');
  assert.ok(Date.now()-started<1500,'the run returns before its deadline');
  assert.equal(outcomes[0].check.fillStatus,'timed_out');
  assert.ok(fake.requests.some(r=>r.method==='turn/interrupt'),'the late fill turn is interrupted');
  assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,3,'no turn starts after the time runs out');
});

test('an incomplete draft with too little time left keeps the draft without a fill',async()=>{
  const fake=createFakeCodexServer({turns:[{text:'Validated draft [1].'},{text:'{"complete":false,"missing":["UAP option never sized"]}'}]});
  const outcomes=[];let unlocked=0;
  const answer=await runCodex(codexArgs(fake,{message:'Size the UAP option',validateAnswer:validOnly,checkDeliverables:true,unlockReserve:()=>unlocked++,onOutcome:o=>outcomes.push(o),
    deadlineMs:5000,followUp:{fillMinMs:60000,marginMs:100,checkMaxMs:1000}}));
  assert.equal(answer,'Validated draft [1].');
  assert.equal(outcomes[0].check.fillStatus,'skipped');assert.equal(unlocked,0);
  assert.equal(fake.requests.filter(r=>r.method==='turn/start').length,2);
});

test('the main turn asks for concise reasoning summaries, and a configured service tier reaches the thread',async()=>{
  for(const tier of [undefined,'priority']){
    const fake=createFakeCodexServer({turns:[{text:'Answer [1].'}]});
    await runCodex(codexArgs(fake,{message:'What is the FAR?',secrets:tier?{CODEX_SERVICE_TIER:tier}:{}}));
    assert.equal(fake.requests.find(r=>r.method==='turn/start').params.summary,'concise');
    assert.equal(fake.requests.find(r=>r.method==='thread/start').params.serviceTier,tier);
  }
});

test('the run deadline fails the run with an error marked as the deadline',async()=>{
  const fake=createFakeCodexServer({turns:[{hold:true,text:'Never sent.'}]});
  const error=await runCodex(codexArgs(fake,{message:'Underwrite 1 Main St',deadlineMs:50})).then(()=>null,e=>e);
  assert.match(error.message,/timed out/);assert.equal(error.deadline,true);
});

test('failed tools return a structured error that separates transient from terminal failures',async()=>{
  const fake=createFakeCodexServer({turns:[{toolCalls:[{tool:'acres_fetch_url'},{tool:'acres_discover_tools'},{tool:'acres_pro_forma'}],text:'Answer.'}]});
  const events=[];
  await runCodex(codexArgs(fake,{message:'What is the FAR?',emit:(ev,data)=>events.push({ev,data}),execute:async name=>{
    if(name==='acres_fetch_url')throw new Error('Could not read this URL (cloudflare: Browser is too busy; direct: Source returned HTTP 503.)');
    if(name==='acres_discover_tools')throw new Error('Public research is unavailable for this request.');
    const e=new Error('Pro forma service timed out');e.retryable=false;throw e;
  }}));
  const results=events.filter(e=>e.ev==='tool.completed').map(e=>e.data.result);
  assert.deepEqual(results.map(r=>r.retryable),[true,false,false]);
  assert.match(results[0].error,/too busy/);
});

test('a tool result carrying contentImages reaches the model as input images, never as text or in the trace',async()=>{
  const fake=createFakeCodexServer({turns:[{toolCalls:[{tool:'acres_view_drawing',arguments:{drawingId:'d1'}}],text:'Read it.'}]});
  const events=[];
  await runCodex({message:'Read the plan',history:[],dynamicTools:[],secrets:{},oauth:fake.oauth,spawnProcess:fake.spawnProcess,createWebSocket:fake.createWebSocket,
    execute:async()=>({drawing:{id:'d1'},contentImages:['data:image/png;base64,iVBORw0KGgo=']}),emit:(ev,data)=>events.push({ev,data})});
  const reply=fake.requests.find(r=>r.id==='tc-1-0');
  assert.deepEqual(reply.result.contentItems,[{type:'inputText',text:JSON.stringify({drawing:{id:'d1'},images:1})},{type:'inputImage',imageUrl:'data:image/png;base64,iVBORw0KGgo='}]);
  assert.deepEqual(events.find(e=>e.ev==='tool.completed').data.result,{drawing:{id:'d1'},images:1});
});

test('oversized tool evidence is bounded for the model, losslessly readable and complete in the trace',async()=>{
  const evidence={comparables:Array.from({length:300},(_,i)=>({id:i,address:`Property ${i}`,details:'Complete original evidence '.repeat(20)}))};
  const fake=createFakeCodexServer({turns:[{toolCalls:[{tool:'acres_market'},{tool:'acres_read_context',arguments:{reference:'context_1',path:['comparables','299']}}],text:'Read it.'}]});
  const events=[];let executions=0;
  await runCodex(codexArgs(fake,{message:'Review the comparable evidence',dynamicTools:[{name:'acres_market',description:'Read comparables',inputSchema:{type:'object',properties:{}}}],execute:async()=>{executions++;return evidence;},emit:(ev,data)=>events.push({ev,data})}));
  const initial=fake.requests.find(r=>r.id==='tc-1-0').result.contentItems[0].text;
  assert.ok(initial.length<=24000);assert.equal(JSON.parse(initial).coverage,'partial');
  const page=JSON.parse(fake.requests.find(r=>r.id==='tc-1-1').result.contentItems[0].text);
  assert.deepEqual(JSON.parse(page.text),evidence.comparables[299]);assert.equal(page.nextOffset,null);
  assert.equal(executions,1,'context retrieval does not spend a research tool call');
  assert.deepEqual(events.find(e=>e.ev==='tool.completed'&&e.data.tool==='acres_market').data.result,evidence);
  assert.ok(fake.requests.find(r=>r.method==='thread/start').params.dynamicTools.some(t=>t.name==='acres_read_context'));
});

test('deliverable checks reuse a long full answer already in the thread instead of duplicating it',async()=>{
  const draft='Full analysis and requested evidence. '.repeat(1000);
  const fake=createFakeCodexServer({turns:[{text:draft},{text:'{"complete":true,"missing":[]}'}]});
  const answer=await runCodex(codexArgs(fake,{message:'Compare the alternatives',checkDeliverables:true}));
  assert.equal(answer,draft.trim());
  const check=fake.requests.filter(r=>r.method==='turn/start')[1].params.input[0].text;
  assert.ok(check.length<3000);assert.match(check,/full immediately preceding assistant answer/);
});

test('the check after a long draft gains additions reads the draft and the additions together from the thread',async()=>{
  const draft='Full analysis and requested evidence. '.repeat(1000);
  const fake=createFakeCodexServer({turns:[{text:draft},{text:'{"complete":false,"missing":["UAP never sized"]}'},{text:'## Additional detail\n\nThe UAP option adds 4,000 sq ft.'},{text:'{"complete":true,"missing":[]}'}]});
  const answer=await runCodex(codexArgs(fake,{message:'Compare the alternatives',checkDeliverables:true}));
  assert.match(answer,/requested evidence\.\n\n## Additional detail\n\nThe UAP option adds 4,000 sq ft\.$/);
  const check=fake.requests.filter(r=>r.method==='turn/start')[3].params.input[0].text;
  assert.ok(check.length<3000);assert.match(check,/earlier full answer in this thread followed by the additional detail/);
});

test('an interrupt the harness never answers still lets the turn finish and the interrupt call settle',async()=>{
  const fake=createFakeCodexServer({turns:[{hold:true,text:'Partial answer [1].'}]});
  // The fake never responds to turn/interrupt; the turn then completes on its own.
  let control=null;
  const run=runCodex(codexArgs(fake,{message:'Underwrite 1 Main St',onControl:c=>{control=c??control;}}));
  const completed=run.then(()=>null,error=>error);
  await new Promise(r=>setTimeout(r,30));
  const interrupted=control.interrupt();
  await new Promise(r=>setTimeout(r,10));
  assert.ok(fake.requests.some(r=>r.method==='turn/interrupt'),'the interrupt reached the harness');
  fake.release();
  const error=await completed;
  assert.match(error.message,/stopp|interrupt|abort/i);
  const outcome=await Promise.race([interrupted.then(()=>'settled',()=>'settled'),new Promise(r=>setTimeout(()=>r('hung'),1500))]);
  assert.equal(outcome,'settled','turn/interrupt without a response must not hang its caller');
});

test('decision lint: an answer that runs a pro forma without the acquisition decision is sent back to record it',async()=>{
  assert.deepEqual(decisionLint(new Set(['acres_find_property'])),[]);
  assert.deepEqual(decisionLint(new Set(['acres_pro_forma','acres_compare_programs'])),[]);
  assert.match(decisionLint(new Set(['acres_pro_forma']))[0],/acres_compare_programs/);
  const fake=createFakeCodexServer({turns:[
    {toolCalls:[{tool:'acres_execute_capability',arguments:{name:'acres_pro_forma',arguments:{}}}],text:'The homes lose money at the asking price [1].'},
    {text:'{"complete":true,"missing":[]}'},
    {toolCalls:[{tool:'acres_execute_capability',arguments:{name:'acres_compare_programs',arguments:{}}}],text:'The asking price is not supported; the land is worth at most $1 at a 20% return [1].'},
    {text:'{"complete":true,"missing":[]}'},
  ]});
  const events=[],executed=[];let unlocked=0;
  await runCodex(codexArgs(fake,{message:'Underwrite this site end to end.',validateAnswer:validOnly,checkDeliverables:true,
    execute:async(tool,args)=>{executed.push(args.name||tool);return {ok:true};},unlockReserve:()=>{unlocked++;},emit:(ev,data)=>events.push({ev,data})}));
  assert.deepEqual(executed,['acres_pro_forma','acres_compare_programs']);
  assert.equal(unlocked,1);
  const checks=events.filter(e=>e.ev==='turn.check');
  assert.match(checks[0].data.missing.join(' '),/records no acquisition decision/);
  assert.equal(checks.at(-1).data.phase,'after_fill');
  assert.equal(checks.at(-1).data.complete,true);
});

test('decision lint names a skipped site-page lead before accepting another option',()=>{
  const lead={id:'bonus',label:'Most floor area',best:true,exit:'rental',summary:'Rental with 485-x Option B, 24,000 SF'};
  const comparison={variants:[{label:'Condo alternative',productType:'condo',storeOption:'condo'}],skippedStoreOptions:[{storeOption:'bonus',reason:'Missing tax terms'}]};
  const state=decisionInputs({storeOptions:null,comparison:null},'acres_set_subject',{dealValuation:{options:[lead]}});
  const saved=decisionInputs(state,'acres_compare_programs',comparison);
  assert.match(decisionLint(new Set(['acres_compare_programs']),{draft:'The condo alternative wins.',...saved})[0],/Missing tax terms/);
  assert.deepEqual(decisionLint(new Set(['acres_compare_programs']),{draft:'The site page 485-x rental needs tax terms, so the condo alternative wins.',...saved}),[]);
});

 test('capacity reporting reconciles operative ZFA, and conditions alone do not size a direct ask',()=>{
 const headline={operativeFigure:{valueSqft:75200,basis:'zoning_maximum',reason:'Residential maximum governs.'}};
 assert.equal(capacityLint('Buildable ZFA is 60,000 SF.',headline).length,1);
 assert.deepEqual(capacityLint('Buildable ZFA is 75,200 SF, subject to bulk.',headline),[]);
 assert.equal(capacityLint('The proposed bonus allows 90,000 SF.',headline,'How much can I build?').length,1);
 assert.deepEqual(capacityLint('Address: Example Street.',headline),[]);
 assert.deepEqual(capacityLint('Buildable ZFA is 75.2k SF.',headline),[]);
 assert.deepEqual(capacityLint('The approved bonus governs instead: 90,000 SF because it includes qualifying affordable housing.',headline),[]);
 assert.equal(deliverableLint('How much can I build?','You may be able to build subject to setbacks and approvals.').length,1);
 assert.deepEqual(deliverableLint('How much can I build?','You can build 75,200 SF subject to bulk.'),[]);
 assert.deepEqual(deliverableLint('How much can I build?','I cannot determine floor area without the missing split-district areas.'),[]);
});
