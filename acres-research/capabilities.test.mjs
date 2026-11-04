import test from 'node:test';
import assert from 'node:assert/strict';
import {CAPABILITIES,registeredToolNames,registeredSkillNames,directToolNames,gatewayToolNames,searchCapabilities,loadSkill,assertExecutable,toolsForTags} from './capabilities.mjs';

test('the short universal index keeps detailed NYC playbooks discoverable on demand',()=>{
  const index=loadSkill('creative-zoning').text;
  assert.ok(index.length<4000);assert.match(index,/nyc-statutory-playbooks/);
  const matches=searchCapabilities({query:'NYC statutory playbooks',kind:'skill',limit:20}).results;
  assert.ok(matches.some(r=>r.name==='nyc-statutory-playbooks'));
  const detail=loadSkill('nyc-statutory-playbooks').text;
  assert.ok(detail.length>index.length);assert.match(detail,/485|UAP|Universal Affordability/);
});
import {LANES,JUDGE_TOOLS,normalizeSpawnLanes,researchMode} from './lanes.mjs';
import {createResearchTools} from './tools.mjs';
import {createConceptTools} from './concepts.mjs';
import {createPlacesTools} from './places.mjs';
import {createZoningTools} from './zoning.mjs';
import {createMarketTools} from './market.mjs';
import {createProFormaTools} from './proforma.mjs';
import {createPlanningTools} from './planning.mjs';
import {createEntitlementTools} from './entitlements.mjs';
import {createFeasibilityTools} from './feasibility.mjs';
import {createKeepTools} from './keep.mjs';
import {createAssemblyTools} from './assembly.mjs';
import {createNycPublicRecordsTools} from './nycdb.mjs';
import {createMunicipalRecordsTools} from './municipal-records.mjs';
import {createFloorplanAuditTools} from './floorplan-audit.mjs';
import {createDeliverableTools} from './deliverable.mjs';
import {createDevelopmentLedgerTools} from './ledger.mjs';
import {createTradePressTools} from './news-feeds.mjs';
import {createPrecedentTools} from './precedents.mjs';
import {generatedUiTool} from './generated-ui.mjs';
import {createArchitectureTools} from './architecture-tools.mjs';
import {createAlertTools} from './alert-tools.mjs';

function everyBuiltDefinitionName(){
  const noop=()=>{},record=()=>null,getProperty=()=>null;
  const tools=createResearchTools({});
  const market=createMarketTools({emit:noop,record});
  const builders=[
    createConceptTools({emit:noop,getProperty,record,streetView:null}),
    createPlacesTools({maps:{},getProperty,record}),
    createZoningTools({getProperty}),
    market,
    createProFormaTools({emit:noop,getMarket:()=>market.market}),
    createPlanningTools({available:true}),
    createEntitlementTools({getProperty,enabled:true}),
    createFeasibilityTools({emit:noop,getMarket:()=>market.market}),
    createKeepTools({emit:noop,getProperty,record}),
    createAssemblyTools({findParcel:noop,available:true}),
    createNycPublicRecordsTools({getProperty,record,emit:noop}),
    createMunicipalRecordsTools({record,emit:noop}),
    createFloorplanAuditTools({emit:noop,getMarket:()=>market.market}),
    createDeliverableTools({emit:noop}),
    createDevelopmentLedgerTools({getProperty,record,emit:noop}),
    createTradePressTools({getProperty,record,emit:noop}),
    createPrecedentTools({getProperty,record}),
    createArchitectureTools({plans:{}}),
    createAlertTools({alerts:{}}),
  ];
  return new Set([...tools.definitions,...builders.flatMap(b=>b.definitions),generatedUiTool].map(d=>d.name));
}

test('the registry registers exactly the tools the service builds',()=>{
  const built=everyBuiltDefinitionName();
  assert.deepEqual([...built].sort(),[...registeredToolNames()].sort(),
    'a tool is built but not registered, or registered but never built');
  for(const entry of CAPABILITIES){
    assert.ok(entry.title&&entry.when&&entry.tags.length,`${entry.name} needs a title, a when-to-use, and tags`);
  }
  assert.ok(registeredSkillNames().includes('creative-zoning'));
  assert.ok(registeredToolNames().includes('acres_assemble_site'));
  assert.ok(registeredToolNames().includes('acres_nyc_public_records'));
  assert.ok(registeredToolNames().includes('acres_market_comps'));
});

test('every registered tool is reachable by the lead agent and by legacy lanes',()=>{
  for(const nyc of [true,false]){
    const direct=directToolNames({nyc}),gateway=gatewayToolNames({nyc});
    assert.deepEqual([...direct,...gateway].sort(),[...registeredToolNames()].sort(),`lead mode (nyc ${nyc}) must reach every tool exactly once, directly or through the gateway`);
  }
  const lanes=new Set([...LANES.flatMap(l=>l.tools),...JUDGE_TOOLS]);
  const unreachable=registeredToolNames().filter(n=>n!=='generateSandboxedUi'&&!lanes.has(n));
  assert.deepEqual(unreachable,[],'legacy lanes mode silently loses tools (the entitlement/compare failure mode)');
  assert.ok(LANES.find(l=>l.id==='zoning').tools.includes('acres_entitlement_scenarios'));
  assert.ok(LANES.find(l=>l.id==='zoning').tools.includes('acres_assemble_site'));
  assert.ok(LANES.find(l=>l.id==='comps').tools.includes('acres_compare_programs'));
  assert.ok(LANES.find(l=>l.id==='comps').tools.includes('acres_entitlement_scenarios'));
});

test('NYC records and the core zoning compute tools are direct in NYC runs and behind the gateway elsewhere',()=>{
  const direct=directToolNames();
  const nycCore=['acres_nyc_public_records','acres_development_ledger','acres_zoning_envelope','acres_entitlement_scenarios'];
  for(const name of nycCore){
    assert.ok(direct.includes(name),`${name} must be offered directly to the lead agent in an NYC run`);
    assert.ok(!gatewayToolNames().includes(name),`${name} must not also sit behind the gateway in an NYC run`);
    assert.ok(!directToolNames({nyc:false}).includes(name),`${name} is not carried on every turn of a run elsewhere`);
    assert.ok(gatewayToolNames({nyc:false}).includes(name),`${name} stays reachable through the gateway elsewhere`);
    assert.equal(assertExecutable(name).name,name,'an execute_capability call for it still runs');
  }
  const query='how much more can this site build, entitlement paths';
  assert.equal(searchCapabilities({query}).results.find(r=>r.name==='acres_entitlement_scenarios').how,'Call it directly by name.');
  const elsewhere=searchCapabilities({query},new Map(),null,{nyc:false}).results.find(r=>r.name==='acres_entitlement_scenarios');
  assert.equal(elsewhere.exposure,'gateway');
  assert.match(elsewhere.how,/acres_execute_capability/);
  const lanes=new Set([...LANES.flatMap(l=>l.tools),...JUDGE_TOOLS]);
  for(const name of nycCore)assert.ok(lanes.has(name),`${name} stays reachable in lanes mode`);
  const [all]=normalizeSpawnLanes({lanes:[{title:'Everything',charter:'Wide net.'}]});
  for(const name of nycCore)assert.ok(all.tools.includes(name),`${name} stays reachable by spawned lanes`);
  assert.ok(gatewayToolNames().includes('acres_pro_forma'),'specialist tools outside the NYC records and zoning core stay behind the gateway');
});

test('capability search ranks the fitting specialist tool and skill first',()=>{
  const {results}=searchCapabilities({query:'how much more can this site build, entitlement paths'});
  assert.equal(results.find(r=>r.kind==='tool').name,'acres_entitlement_scenarios','the fitting specialist tool must rank first among tools');
  assert.ok(results.indexOf(results.find(r=>r.name==='acres_entitlement_scenarios'))<=1,'and in the top two overall');
  assert.ok(results.some(r=>r.kind==='skill'&&r.name==='entitlement-paths'));
  const assemblage=searchCapabilities({query:'combine adjoining tax lots assemblage',kind:'tool'});
  assert.equal(assemblage.results[0].name,'acres_assemble_site');
  const expanded=searchCapabilities({query:'sliver',kind:'tool'},new Map(),new Map([['sliver','envelope height setback']]));
  assert.equal(expanded.results[0].name,'acres_zoning_envelope');
  const legal=searchCapabilities({query:'court opinion variance precedent',kind:'skill'});
  assert.equal(legal.results[0].name,'case-law');
  assert.ok(legal.results.every(r=>r.kind==='skill'));
  const hostFiltered=searchCapabilities({query:'floor plans pro forma'},new Map([['acres_pro_forma',{description:'Run a pro forma',inputSchema:{type:'object'}}]]));
  assert.ok(!hostFiltered.results.some(r=>r.name==='acres_plan_concept'),'tools this host did not build must not be offered');
  assert.throws(()=>searchCapabilities({query:''}),/1 to 500/);
  assert.throws(()=>searchCapabilities({query:'x',kind:'banana'}),/kind/);
});

test('skills load by name and unknown or meta capabilities fail closed',()=>{
  const loaded=loadSkill('case-law');
  assert.match(loaded.text,/court opinions/i);
  assert.match(loaded.note,/not a mandatory sequence/);
  assert.throws(()=>loadSkill('nope'),/Unknown skill/);
  assert.throws(()=>assertExecutable('acres_spawn_lanes'),/called directly/);
  assert.throws(()=>assertExecutable('acres_nope'),/Unknown capability/);
  assert.equal(assertExecutable('acres_pro_forma').name,'acres_pro_forma');
});

test('tag selection is the only lane tool mechanism and stays inside the registry',()=>{
  const legal=toolsForTags(['legal']);
  assert.ok(legal.includes('acres_fanout_search'));
  assert.ok(!legal.includes('acres_model_concept'));
  for(const lane of LANES)assert.deepEqual(lane.tools,toolsForTags(lane.tags),`${lane.id} tools must be derived from its tags`);
});

test('spawn lane requests are bounded, validated, and cannot recurse',()=>{
  const [lane]=normalizeSpawnLanes({lanes:[{title:'Contrary authority',charter:'Try to falsify the leading idea.',tags:['legal','evidence']}]});
  assert.equal(lane.id,'contrary-authority');
  assert.ok(!lane.tools.includes('acres_spawn_lanes'));
  assert.ok(!lane.tools.includes('acres_model_concept'));
  const [all]=normalizeSpawnLanes({lanes:[{title:'Everything',charter:'Wide net.'}]});
  assert.ok(all.tools.includes('acres_entitlement_scenarios'));
  assert.ok(!all.tools.includes('generateSandboxedUi'));
  assert.throws(()=>normalizeSpawnLanes({lanes:[{title:'x',charter:'y',tags:['banana']}]}),/Unknown capability tag/);
  assert.throws(()=>normalizeSpawnLanes({lanes:[{title:'x',charter:'y',tools:['acres_nope']}]}),/Unknown tool/);
  assert.throws(()=>normalizeSpawnLanes({lanes:Array(5).fill({title:'x',charter:'y'})}),/1 to 4 lanes/);
  assert.throws(()=>normalizeSpawnLanes({lanes:[{title:'x'}]}),/charter/);
  const dup=normalizeSpawnLanes({lanes:[{title:'Text',charter:'a'},{title:'Text',charter:'b'}]});
  assert.notEqual(dup[0].id,dup[1].id);
});

test('lead mode is the default and the legacy parallel flag no longer forces lanes',()=>{
  assert.equal(researchMode({}),'lead');
  assert.equal(researchMode({RESEARCH_PARALLEL_ENABLED:true}),'lead');
  assert.equal(researchMode({RESEARCH_MODE:'lanes'}),'lanes');
  assert.equal(researchMode({RESEARCH_MODE:'lead',RESEARCH_PARALLEL_ENABLED:true}),'lead');
});
