import {runCodex} from './codex.mjs';
import {createResearchTools,savedPageIndex,subjectResearchGuidance} from './tools.mjs';
import {generatedUiTool,generatedUiContent} from './generated-ui.mjs';
import {createConceptTools} from './concepts.mjs';
import {createGoogleMaps,createPlacesTools} from './places.mjs';
import {createZoningTools,describeDistrict,zoningResolutionUrlFor,suggestedLot,headlineReconciliation,governingFiledProposal,recordedBuildingArea,rules as zoningRules} from './zoning.mjs';
import {computeEnvelope} from './envelope.mjs';
import {createMarketTools,recommendUnitMix} from './market.mjs';
import {createProFormaTools,recomputeProForma} from './proforma.mjs';
import {createPlanningTools} from './planning.mjs';
import {createEntitlementTools,entitlementScenarios} from './entitlements.mjs';
import {createParcelLookups} from './nyc-zoning-lookups.mjs';
import {createFeasibilityTools} from './feasibility.mjs';
import {createKeepTools} from './keep.mjs';
import {createAssemblyTools, taxLotOutline} from './assembly.mjs';
import {createNycPublicRecordsTools} from './nycdb.mjs';
import {openMarketStore} from './market-store.mjs';
import {buildSchemes,dealValuationBrief,THREE_OPTIONS_METHOD_URL} from './schemes.mjs';
import {createMunicipalRecordsTools} from './municipal-records.mjs';
import {createFloorplanAuditTools} from './floorplan-audit.mjs';
import {createDeliverableTools} from './deliverable.mjs';
import {createArchitectureTools} from './architecture-tools.mjs';
import {createAlertTools} from './alert-tools.mjs';
import {createDevelopmentLedgerTools,createSubjectLedger} from './ledger.mjs';
import {createTradePressTools} from './news-feeds.mjs';
import {createPrecedentTools} from './precedents.mjs';
import {openKnowledge} from './knowledge.mjs';
import {LANES,JUDGE_TOOLS,laneInstructions,judgeInstructions,judgePacket,validateCitations,citationIds,withoutUnsupportedCitations,researchMode,spawnEnabled,normalizeSpawnLanes} from './lanes.mjs';
import {fieldsFromResult} from './project-state.mjs';
import {gatewayDefinitions,directToolNames,searchCapabilities,loadSkill,assertExecutable} from './capabilities.mjs';
import {runInNyc} from './jurisdiction.mjs';
import {executionSignal,withExecutionSignal,combinedSignal,throwIfCancelled,stoppedError} from './execution-context.mjs';
import {isDeepStrictEqual} from 'node:util';
import {isSplitLot} from './scheme-outlines.mjs';

// The curated zoning table was verified against the Zoning Resolution in October 2026; it
// still stays off unless the host explicitly opts in.
export function createConfiguredZoningTools(secrets,getProperty,record=()=>null,ledger=null,lookups=null) {
  return secrets.ENABLE_CURATED_ZONING===true?createZoningTools({getProperty,record,ledger,lookups,taxLotOutline}):{definitions:[],handlers:{},envelope:null};
}

const RECORDS_PENDING_NOTE='NYC public records for this lot are being read; their digest (owner, violations, filings, certificate of occupancy, E-designations) arrives as recordsDigest with a later tool result. Call acres_nyc_public_records only for detail beyond it.';
const RECORDS_DIGEST_GUIDANCE='recordsDigest summarizes the subject\'s NYC public records; cite recordsDigest.sourceId. Report the owner as the owner of record per the named deed and its dates, with any caveat, never as verified title. Report open violations as obligations that run with the property: DOB signs off no work and issues no certificate of occupancy while they stand. A count named in countsAreAtLeast covers only the most recent rows, never the total. majorFilingsInProgress lists filings with an action since actionSince; lapsedUnresolvedCount counts older ones that most likely lapsed. Undated filings are listed separately; their age and whether they lapsed are unknown. Name any unavailableEndpoints as unavailable, never as holding no records. Call acres_nyc_public_records for filing history, violation detail, ACRIS instruments, E-designation requirements and landmarks.';
function makeAux({emit,secrets,tools,progress,ui,priorState=null,shared=null,dealStore,plans=null,meter=null,listingContext=null,alerts=null}){
  let laneState={},laneConflicts=new Set();
  const selected=(key,local)=>{
    if(local)return local;
    if(laneConflicts.has(key))throw new Error(`Parallel lanes disagree on ${key}. Resolve it explicitly before using dependent tools.`);
    return laneState[key]??priorState?.[key]??null;
  };
  const selectedArray=(key,local=[])=>{
    if(!local.length&&laneConflicts.has(key))throw new Error(`Parallel lanes produced invalid ${key}. Regenerate it before using dependent tools.`);
    return local.length||laneState[key]?.length?[...local,...(laneState[key]||[])]:priorState?.[key]||[];
  };
  const maps=createGoogleMaps(secrets);
  const getEffectiveProperty=()=>selected('property',tools.property);
  const conceptTools=createConceptTools({emit,getProperty:getEffectiveProperty,record:tools.record,streetView:maps?maps.streetViewMetadata:null});
  const placeTools=createPlacesTools({maps,getProperty:getEffectiveProperty,record:tools.record});
  // What nearby development sites sold for on the subject's as-of-right area, as its site page shows it.
  const nearbyLand=(property,{now}={})=>{const s=openMarketStore({readOnly:true});if(!s)return {value:null,reason:'the market store holding the nearby development-site sales is not available'};try{return s.lotNearbyLand({bbl:property.bbl,property,now});}finally{s.close();}};
  const ledger=createSubjectLedger({getProperty:getEffectiveProperty,nearbyLand});
  // Live parcel lookups (current zoning map, mapped streets, MIH area, filed existing ZFA), shared by
  // the envelope and entitlement tools and memoized per BBL for the run.
  const parcelLookups=createParcelLookups();
  const zoningTools=createConfiguredZoningTools(secrets,getEffectiveProperty,tools.record,ledger,parcelLookups);
  const marketTools=createMarketTools({emit,record:tools.record,getProperty:getEffectiveProperty,getMaxDwellingUnits:()=>{const env=selected('envelope',zoningTools.envelope);return env?.summary?.maxDwellingUnits??env?.density?.maxUnits??null;},initialMarket:priorState?.market||null,initialProgram:priorState?.program||null,dealStoreAccess:dealStore,ledger,listingContext});
  // The run owner's budget line shares for line-item pro formas, or null for the defaults.
  const budgetSplits=()=>{if(!dealStore?.account)return null;const s=openMarketStore({readOnly:true});if(!s)return null;try{return s.getUserDealSettings(dealStore.account).budgetSplits;}finally{s.close();}};
  const proFormaTools=createProFormaTools({emit,getMarket:()=>marketTools.effectiveMarket,ledger,record:tools.record,getBudgetSplits:budgetSplits});
  const planningTools=createPlanningTools({planningDir:secrets.ACRES_PLANNING_DIR||undefined,emit});
  const entitlementTools=createEntitlementTools({getProperty:getEffectiveProperty,getSameBlock:()=>tools.sameBlockContext,enabled:secrets.ENABLE_CURATED_ZONING===true,emit,record:tools.record,lookups:parcelLookups});
  const storeSchemes=new Map();
  const feasibilityTools=createFeasibilityTools({emit,getMarket:()=>marketTools.effectiveMarket,ledger,record:tools.record,getStoreOptions:()=>storeSchemes.get(getEffectiveProperty()?.bbl)??null});
  // Keeping the building: holding, renovating and renting, or renovating and selling what stands on the lot.
  const keepTools=createKeepTools({emit,getProperty:getEffectiveProperty,ledger,record:tools.record});
  const assemblyTools=createAssemblyTools({findParcel:(bbl)=>tools.execute('acres_find_property',{bbl}),planningDir:secrets.ACRES_PLANNING_DIR||undefined,emit});
  // The subject lot's registered rent-stabilized count comes from the deal store's monthly copy.
  const rentStabilizedLookup=bbl=>{const s=openMarketStore({readOnly:true});if(!s)return null;try{return s.lookupRentStabilizedUnits(bbl);}finally{s.close();}};
  const nycRecordsTools=createNycPublicRecordsTools({getProperty:getEffectiveProperty,record:tools.record,emit,rentStabilizedLookup});
  const municipalRecordsTools=createMunicipalRecordsTools({record:tools.record,emit});
  const ledgerTools=createDevelopmentLedgerTools({getProperty:getEffectiveProperty,record:tools.record,emit,nearbyLand});
  const tradePressTools=createTradePressTools({getProperty:getEffectiveProperty,record:tools.record,emit});
  const precedentTools=createPrecedentTools({getProperty:getEffectiveProperty,record:tools.record});
  const floorplanAuditTools=createFloorplanAuditTools({emit,getMarket:()=>marketTools.effectiveMarket});
  const deliverableTools=createDeliverableTools({
    getStateSnapshot:()=>({
      property:getEffectiveProperty(),
      envelope:selected('envelope',zoningTools.envelope),
      entitlements:selected('entitlements',entitlementTools.entitlements),
      assembly:selected('assembly',assemblyTools.assembly),
      concepts:selectedArray('concepts',conceptTools.concepts),
      plans:selectedArray('plans',planningTools.plans),
      floorplanAudits:selectedArray('floorplanAudits',floorplanAuditTools.audits),
      market:marketTools.effectiveMarket,
      program:marketTools.effectiveProgram,
      proFormas:selectedArray('proFormas',proFormaTools.proFormas),
      comparisons:selectedArray('comparisons',feasibilityTools.comparisons),
      assumptions:priorState?.assumptions??null,
    }),
    getSources:()=>shared?.sources||[],
    emit,
  });
  const architectureTools=createArchitectureTools({plans,secrets,meter,emit});
  const alertTools=createAlertTools({alerts});
  const aux={conceptTools,placeTools,zoningTools,marketTools,proFormaTools,planningTools,entitlementTools,feasibilityTools,keepTools,assemblyTools,nycRecordsTools,municipalRecordsTools,ledgerTools,tradePressTools,precedentTools,floorplanAuditTools,deliverableTools,architectureTools,alertTools};
  // The subject brief computes the envelope without saving it, so an agent can value a site straight
  // from the brief and leave the build step unsaved under a finished pro forma. A run that valued the
  // subject therefore saves its default envelope when neither the run nor the saved project holds one.
  aux.fillEnvelope=async()=>{
    const property=getEffectiveProperty();
    if(!property?.bbl||!zoningTools.handlers.acres_zoning_envelope)return false;
    if(priorState?.property?.bbl===property.bbl&&priorState.envelope)return false;
    progress('Saving the zoning envelope');
    console.log(JSON.stringify({event:'research_envelope_filled',bbl:property.bbl}));
    await zoningTools.handlers.acres_zoning_envelope({});
    return true;
  };
  aux.adoptLaneState=({state,conflicts})=>{
    laneState=structuredClone(state);laneConflicts=new Set(conflicts.filter(c=>c.resolution==='unresolved').map(c=>c.field));
    const own=aggregate([{status:'completed',tools,aux}]);
    for(const [key,value] of Object.entries(laneState))if(Array.isArray(value))laneState[key]=value.slice(own[key]?.length||0);
    marketTools.adoptLaneState({market:state.market,program:state.program,conflicts:laneConflicts});
  };
  aux.definitions=[...architectureTools.definitions,...alertTools.definitions,...zoningTools.definitions,...conceptTools.definitions,...placeTools.definitions,...marketTools.definitions,...proFormaTools.definitions,...planningTools.definitions,...entitlementTools.definitions,...feasibilityTools.definitions,...keepTools.definitions,...assemblyTools.definitions,...nycRecordsTools.definitions,...municipalRecordsTools.definitions,...ledgerTools.definitions,...tradePressTools.definitions,...precedentTools.definitions,...floorplanAuditTools.definitions,...deliverableTools.definitions];
  const runSpecialist=async(name,fn)=>{throwIfCancelled();const state=tools.consumeCall(name);const result=await fn();throwIfCancelled();return tools.annotate(name,result,state);};
  // Confirming the subject computes its starting figures in the same result, outside the call
  // budget: the envelope, the as-of-right and UAP baseline and the DOB filed capacity, each cited.
  // Figures already computed for this parcel win over a new default: this run's envelope and
  // entitlements first, then the saved project's, and only when they come from the subject's own
  // inputs (district, lot, use, form, table FAR, built area, full UAP uplift) so a scheme never
  // briefs it. The brief never replaces the envelope or entitlements that become project state, and
  // each part that cannot be computed returns a short note so the selection itself still succeeds.
  const briefed=new Set();
  // Section links and prose stay in the recorded source; the inline brief keeps the figures, the
  // 85 to 100 percent existing ZFA band among them.
  const compactEnvelope=({sectionUrls,proseGuidance,...figures})=>figures;
  const compactCapacity=({zfaVsGfaGuidance:{note,...band},...figures})=>({...figures,zfaVsGfaGuidance:band});
  // The headline keeps each row's figure, basis, standing and reason; filing details stay in filedCapacity and the source.
  const compactHeadline=({guidance,rows,...table})=>({...table,rows:rows.filter(r=>r.label!=='Operative figure').map(({label,valueSqft,basis,operative,conditional,jobNumber,stage,shareOfZoningMaximumPercent,bandsSqft,reason})=>
    Object.fromEntries(Object.entries({label,valueSqft,basis,operative,conditional,jobNumber,stage,shareOfZoningMaximumPercent,bandsSqft,reason}).filter(([,v])=>v!==undefined&&v!==null)))});
  const compactBaseline=sized=>{
    const uap=sized.scenarios?.find(s=>s.id==='universal-affordability-preference'),mih=sized.scenarios?.find(s=>s.id==='mandatory-inclusionary-housing');
    return {asOfRight:sized.baseline,uap:uap?{totalFloorAreaSqft:uap.totalFloorAreaSqft,resultingFar:uap.resultingFar,addedFloorAreaSqft:uap.addedFloorAreaSqft,affordableRequiredSqft:uap.affordableRequiredSqft,affordableShareOfTotalPercent:uap.affordableShareOfTotalPercent}:null,...(mih?{mih:{name:mih.name,totalFloorAreaSqft:mih.totalFloorAreaSqft,resultingFar:mih.resultingFar,addedFloorAreaSqft:mih.addedFloorAreaSqft,options:mih.mihOptions}}:{})};
  };
  const sameCode=(a,b)=>Boolean(a)&&Boolean(b)&&String(a).toUpperCase()===String(b).toUpperCase();
  // The district the envelope handler models for a parcel, and the one entitlements size it with.
  const envelopeDistrict=property=>{
    const code=['zonedist1','zonedist2','zonedist3','zonedist4'].map(k=>property[k]).find(v=>typeof v==='string'&&v.trim());
    return code?(describeDistrict(code)?.code??code.trim().toUpperCase()):null;
  };
  const baselineDistrict=property=>String(property.zonedist1||'').split(/[\s/]/)[0]||null;
  // Only a parcel-path envelope carries capacity; a district-only call is a hypothetical. A subject
  // envelope is also the one the parcel path computes by default: its district, the suggested lot
  // outline, the default use and form, the table FAR and no affordable bonus. Only street widths may
  // be refined; any other input makes it a scheme, and an envelope that cannot be compared never fits.
  const envelopeFits=(envelope,property)=>{
    if(!envelope?.summary||!('capacity' in envelope)||!sameCode(envelope.summary.district,envelopeDistrict(property)))return false;
    const district=describeDistrict(envelopeDistrict(property)),outline=suggestedLot(property);
    if(!district||!outline||envelope.affordable!==false)return false;
    const specialDistricts=['spdist1','spdist2','spdist3'].map(k=>property[k]).filter(v=>typeof v==='string'&&v.trim());
    let subject;
    try{subject=computeEnvelope({rules:zoningRules,district,specialDistricts,lot:outline.polygon,frontages:envelope.lot?.streets,communityDistrict:property.cd??null});}catch{return false;}
    return envelope.use===subject.use&&envelope.form===subject.form&&isDeepStrictEqual(envelope.lot?.polygon,subject.lot.polygon)&&isDeepStrictEqual(envelope.floorArea?.maxFar,subject.floorArea.maxFar)&&isDeepStrictEqual(envelope.floorArea?.maxFloorAreaSqft,subject.floorArea.maxFloorAreaSqft);
  };
  // Saved figures are recorded again in this run so they can be cited like any computed figure.
  const recordSaved=(what,district,figures,property)=>tools.record({
    title:`Saved project ${what} (BBL ${property.bbl}, ${district})`,
    url:zoningResolutionUrlFor(describeDistrict(district)||{code:district},[]),
    text:JSON.stringify({bbl:property.bbl,district,[what]:figures}),
    kind:'zoning_envelope',
  })?.id??null;
  const subjectBrief=async property=>{
    if(briefed.has(property.bbl))return {subjectBrief:'The starting figures for this subject are in the earlier acres_set_subject result of this run.'};
    briefed.add(property.bbl);
    const saved=priorState?.property?.bbl===property.bbl?priorState:null;
    // Each part reads its own sources, so they run together and the brief takes as long as its slowest
    // part. Each writes its own fields; they merge in a fixed order so the guidance reads the same.
    const parts=await Promise.all([
      async (brief,present)=>{ // envelope
        if(zoningTools.handlers.acres_zoning_envelope){
          if(zoningTools.envelopeBbl===property.bbl&&envelopeFits(zoningTools.envelope,property)){
            brief.zoningHeadline=compactHeadline(zoningTools.envelope.headlineReconciliation);
            brief.envelopeFrom='the earlier acres_zoning_envelope result in this run';
            if(zoningTools.envelopeSourceId)brief.sourceIds.envelope=zoningTools.envelopeSourceId;
            present.push('the envelope computed earlier in this run');
          }else if(envelopeFits(saved?.envelope,property)){
            const summary=compactEnvelope(saved.envelope.summary);
            // The saved envelope's maxima meet today's governing filing, recorded beside it.
            brief.zoningHeadline=compactHeadline(headlineReconciliation(saved.envelope.capacity,governingFiledProposal(ledger),saved.envelope));
            Object.assign(brief,{envelopeSummary:summary,envelopeFrom:'saved project'});
            const id=recordSaved('envelope',summary.district,{...summary,headlineReconciliation:brief.zoningHeadline},property);
            if(id)brief.sourceIds.envelope=id;
            present.push('the saved project envelope');
          }else{
            try{
              const zoning=await zoningTools.handlers.acres_zoning_envelope({},{capture:false});
              brief.zoningHeadline=compactHeadline(zoning.headlineReconciliation);
              if(zoning.envelopeSummary){brief.envelopeSummary=compactEnvelope(zoning.envelopeSummary);present.push('the envelope');}
              else{
                brief.envelopeNote=zoning.envelopeNote??'No envelope is computed for this parcel.';
                if(Object.keys(zoning.capacity?.byUse??{}).length){brief.capacity=compactCapacity(zoning.capacity);present.push('the PLUTO floor area capacity by use');}
              }
              if(zoning.sourceId)brief.sourceIds.envelope=zoning.sourceId;
            }catch(error){brief.envelopeNote=error.message;}
          }
        }
      },
      async (brief,present)=>{ // baseline
        if(entitlementTools.handlers.acres_entitlement_scenarios){
          const district=baselineDistrict(property);
          const current=entitlementTools.entitlements;
          if(!district)brief.baselineNote='PLUTO reports no zoning district for this parcel, so no as-of-right baseline is computed.';
          else if(!describeDistrict(district))brief.baselineNote=`${district} has no curated floor area ratio, so no as-of-right baseline is computed; read the Zoning Resolution for this district.`;
          else{
            try{
              // Earlier figures brief the subject only when they equal its own baseline and full UAP uplift.
              // Without a PLUTO lot area only the lot area they were sized with is unconfirmed, and the note says so.
              const plutoLot=Number(property.lotarea),built=recordedBuildingArea(property);
              const subjectFor=lotAreaSqft=>compactBaseline(entitlementScenarios({district,lotAreaSqft,existingFloorAreaSqft:built}));
              const subject=plutoLot>0?subjectFor(plutoLot):null;
              const fits=sized=>{
                if(!sized?.baseline)return false;
                const lot=plutoLot>0?plutoLot:Number(sized.lotAreaSqft);
                return lot>0&&isDeepStrictEqual(compactBaseline(sized),plutoLot>0?subject:subjectFor(lot));
              };
              const lotNote=sized=>{if(!(plutoLot>0))brief.baselineNote=`PLUTO has no lot area for this parcel, so these figures use the ${sized.lotAreaSqft} sq ft lot area sized earlier; confirm it against the tax map or a survey.`;};
              if(fits(current)){
                Object.assign(brief,{baseline:compactBaseline(current),baselineFrom:'the earlier acres_entitlement_scenarios result in this run'});
                lotNote(current);
                if(current.sourceId)brief.sourceIds.baseline=current.sourceId;
                present.push('the as-of-right and UAP floor area computed earlier in this run');
              }else if(fits(saved?.entitlements)){
                const baseline=compactBaseline(saved.entitlements);
                Object.assign(brief,{baseline,baselineFrom:'saved project'});
                lotNote(saved.entitlements);
                const id=recordSaved('baseline',district,baseline,property);
                if(id)brief.sourceIds.baseline=id;
                present.push('the saved as-of-right and UAP floor area');
              }else if(!(plutoLot>0))brief.baselineNote='PLUTO has no lot area for this parcel, so the as-of-right baseline cannot be confirmed; size it with acres_entitlement_scenarios and the lot area from the tax map or a survey.';
              else{
                const sized=await entitlementTools.handlers.acres_entitlement_scenarios({},{capture:false});
                brief.baseline=compactBaseline(sized);
                present.push(brief.baseline.mih?'the as-of-right and MIH floor area':brief.baseline.uap?'the as-of-right and UAP floor area':'the as-of-right floor area');
                if(sized.sourceId)brief.sourceIds.baseline=sized.sourceId;
              }
            }catch(error){brief.baselineNote=error.message;}
          }
        }
      },
      async (brief,present)=>{ // filedCapacity
        try{
          const {sourceId,...filed}=ledger.filedCapacity({record:tools.record});
          Object.assign(brief,filed);
          if(filed.filedCapacity&&sourceId){present.push('the filed capacity');brief.sourceIds.filedCapacity=sourceId;}
        }catch(error){brief.filedCapacityNote=`The development ledger could not be read (${error.message}), so filed capacity for this parcel is unknown; never report it as zero.`;}
      },
      async (brief,present)=>{ // dealValuation
        // The site page's options and nearby land figure, valued like the site page at the project owner's deal
        // settings, so a run compares programs against the same valuation.
        if(dealStore?.read&&property.bbl){
          const store=openMarketStore({readOnly:true});
          if(store)try{
            const lot=store.lotValuation({bbl:property.bbl,property,account:dealStore.siteAccount,landPrice:saved?.assumptions?.landPrice});
            if(lot?.valuation.candidates?.length){
              const schemes=buildSchemes({candidates:lot.valuation.candidates});
              brief.dealValuation=dealValuationBrief(lot,schemes);
              storeSchemes.set(property.bbl,schemes);
              const id=tools.record({title:`Arosa site options and nearby land value for BBL ${property.bbl}, computed by Arosa's deal model`,url:THREE_OPTIONS_METHOD_URL,text:JSON.stringify(brief.dealValuation),kind:'deal_store'})?.id;
              if(id)brief.sourceIds.dealValuation=id;
            }
          }catch(error){brief.dealValuationNote=`The deal store could not value this lot (${error.message}).`;}
          finally{store.close();}
        }
      },
    ].map(async part=>{const out={brief:{sourceIds:{}},present:[]};await part(out.brief,out.present);return out;}));
    const brief={sourceIds:{}},present=[];
    for(const part of parts){const {sourceIds,...fields}=part.brief;Object.assign(brief,fields);Object.assign(brief.sourceIds,sourceIds);present.push(...part.present);}
    // The operative figure leads; filed maxima are context and never top the brief.
    // A split lot without per-district apportionment has no single figure: its headline says so, and the
    // envelope and baseline of its first district over the whole lot are bounds, never its capacity.
    const unapportioned=isSplitLot(property)&&brief.zoningHeadline?.operativeFigure.valueSqft===null;
    // splitLotNote already says the envelope is a whole-lot bound, so the envelope keeps only its split flags.
    if(unapportioned&&brief.envelopeSummary?.splitLot){const {note,...flags}=brief.envelopeSummary.splitLot;brief.envelopeSummary={...brief.envelopeSummary,splitLot:flags};}
    if(unapportioned)brief.splitLotNote=`PLUTO marks this lot split between zoning districts and no per-district apportionment is available, so the envelope and the as-of-right baseline treat the whole lot as ${baselineDistrict(property)}: they are bounds for that district, not the lot's capacity.`;
    else if(brief.zoningHeadline&&brief.zoningHeadline.operativeFigure.valueSqft===null)delete brief.zoningHeadline;
    if(brief.zoningHeadline&&!unapportioned)present.unshift('the operative zoning floor area');
    if(unapportioned)brief.briefGuidance=`Lead with zoningHeadline: no single zoning floor area is computed for this split lot; say why. ${brief.splitLotNote} Find the district boundary or each district's share of the lot before stating a capacity, and cite the sourceIds of any figure you use.`;
    else if(present.length)brief.briefGuidance=`Start the answer from these computed figures and cite them with their sourceIds: ${present.join(', ')}.${brief.zoningHeadline?' Lead with zoningHeadline.operativeFigure and its reason; filings that are not operative and maxEverFiled figures are context, never the lot\'s capacity.':''} Call acres_zoning_envelope or acres_entitlement_scenarios again only to refine them (street widths, use, form, transfers, mergers or conversion).`;
    if(brief.dealValuation)brief.briefGuidance=`${brief.briefGuidance??''} When the question turns on value, price or what to build, dealValuation holds the site page's options and nearby land figure (cite sourceIds.dealValuation): compare programs against them and say why a figure of yours differs. Leave them out of answers about other questions.`.trim();
    return brief;
  };
  // The subject's NYC public records are read once its brief is back, so they never hold up the brief or
  // compete with its lookups. Their digest rides, uncharged, on the first tool result after they arrive;
  // a records call made before then reuses the reads already under way.
  let subjectRecords=null;
  const readSubjectRecords=bbl=>{
    if(subjectRecords?.bbl===bbl)return;
    const pending=subjectRecords={bbl,read:null,delivered:false};
    nycRecordsTools.digest(bbl).then(digest=>{pending.read={digest};},error=>{pending.read={error};});
  };
  const withSubjectRecords=(name,result)=>{
    const pending=subjectRecords;
    if(!pending||pending.delivered||!result||typeof result!=='object'||Array.isArray(result))return result;
    if(name==='acres_nyc_public_records'&&result.bbl===pending.bbl){pending.delivered=true;return result;}
    if(!pending.read||name==='acres_set_subject')return result;
    pending.delivered=true;
    if(pending.read.error)return {...result,recordsNote:`NYC public records for BBL ${pending.bbl} could not be read (${pending.read.error.message}); call acres_nyc_public_records if the answer needs them.`};
    return {...result,recordsDigest:nycRecordsTools.citeDigest(pending.read.digest),recordsGuidance:RECORDS_DIGEST_GUIDANCE};
  };
  aux.execute=async(name,args)=>withSubjectRecords(name,await dispatch(name,args));
  const dispatch=async(name,args)=>{
    throwIfCancelled();
    if(conceptTools.handlers[name])return runSpecialist(name,()=>conceptTools.handlers[name](args));
    if(placeTools.handlers[name]){progress('Finding nearby places');return runSpecialist(name,()=>placeTools.handlers[name](args));}
    if(zoningTools.handlers[name]){progress('Reading the zoning envelope');return runSpecialist(name,()=>zoningTools.handlers[name](args));}
    if(marketTools.handlers[name]){progress('Recording market inputs');return runSpecialist(name,()=>marketTools.handlers[name](args));}
    if(proFormaTools.handlers[name]){progress('Running the pro forma');return runSpecialist(name,()=>proFormaTools.handlers[name](args));}
    if(planningTools.handlers[name]){progress('Laying out floor plans');return runSpecialist(name,()=>planningTools.handlers[name](args));}
    if(entitlementTools.handlers[name]){progress('Sizing entitlement paths');return runSpecialist(name,()=>entitlementTools.handlers[name](args));}
    if(feasibilityTools.handlers[name]){progress('Comparing program feasibility');return runSpecialist(name,()=>feasibilityTools.handlers[name](args));}
    if(keepTools.handlers[name]){progress('Pricing the building as it stands');return runSpecialist(name,()=>keepTools.handlers[name](args));}
    if(assemblyTools.handlers[name]){progress('Assembling the site from its tax lots');return runSpecialist(name,()=>assemblyTools.handlers[name](args));}
    if(nycRecordsTools.handlers[name]){progress('Checking NYC DOB, ACRIS, and HPD records');return runSpecialist(name,()=>nycRecordsTools.handlers[name](args));}
    if(municipalRecordsTools.handlers[name]){progress('Querying municipal GIS and zoning records');return runSpecialist(name,()=>municipalRecordsTools.handlers[name](args));}
    if(ledgerTools.handlers[name]){progress('Reading the development ledger');return runSpecialist(name,()=>ledgerTools.handlers[name](args));}
    if(tradePressTools.handlers[name]){progress('Reading trade press about the block');return runSpecialist(name,()=>tradePressTools.handlers[name](args));}
    if(precedentTools.handlers[name]){progress('Finding floor-area precedents');return runSpecialist(name,()=>precedentTools.handlers[name](args));}
    if(floorplanAuditTools.handlers[name]){progress('Auditing floor-plan efficiency and code compliance');return runSpecialist(name,()=>floorplanAuditTools.handlers[name](args));}
    if(architectureTools.handlers[name]){progress(name==='acres_find_floor_plan'?'Finding the floor plan':name==='acres_attach_drawing'?'Attaching the drawing':name==='acres_save_plan'?'Drawing the floor plan':name==='acres_render_plan'?'Rendering the walkthrough':name==='acres_import_pascal_scene'?'Importing the Pascal scene':'Reading the floor plan');return runSpecialist(name,()=>architectureTools.handlers[name](args));}
    if(alertTools.handlers[name]){progress('Managing your email alerts');return runSpecialist(name,()=>alertTools.handlers[name](args));}
    if(deliverableTools.handlers[name]){progress('Generating institutional underwriting deck');return runSpecialist(name,()=>deliverableTools.handlers[name](args));}
    if(name==='acres_set_subject'){
      const selected=await tools.execute(name,args),brief=await subjectBrief(tools.property);
      // A brief with figures replaces the advice to run the envelope and entitlement tools.
      const computed=Boolean(brief.envelopeSummary||brief.envelopeFrom||brief.capacity||brief.baseline);
      if(tools.property?.bbl){readSubjectRecords(tools.property.bbl);if(!subjectRecords.delivered)brief.recordsNote=RECORDS_PENDING_NOTE;}
      return {...selected,...(computed?{researchGuidance:subjectResearchGuidance(tools.property,{computed})}:{}),...brief};
    }
    if(name!==generatedUiTool.name)return tools.execute(name,args);
    if(ui.length>=3)throw new Error('Use at most three useful interfaces per answer.');
    const content=generatedUiContent(args);ui.push(content);emit('ui.generated',{content});
    return {displayed:true,note:'The interface will appear in the chat. Keep the answer and citations concise.'};
  };
  return aux;
}

async function meteredAgent({agent,meter,label,callArgs}){
  throwIfCancelled();
  // Metered under the engine's provider (codex, meta); a test double without one counts as Codex.
  const provider=agent.provider||'codex';
  const authorization=meter?await meter.authorize(provider,`${provider}_${label}`):null;
  let usage;
  try{
    throwIfCancelled();
    const providerManaged=authorization&&agent.handlesProviderDispatch===true;
    const invoke=()=>agent({...callArgs,label,onUsage:value=>{usage=value;},...(providerManaged?{invokeProvider:(fn,options)=>authorization.invoke(fn,options)}:{})});
    const answer=authorization&&!providerManaged?await authorization.invoke(invoke):await invoke();
    if(authorization)await authorization.settle({usage});
    throwIfCancelled();
    return answer;
  }catch(error){
    if(authorization){if(usage)await authorization.settle({usage});else await authorization.pending();}
    throw error;
  }
}

// One steer/interrupt surface over all currently active agent calls (lead and
// any spawned lanes). Steers broadcast to every active turn; interrupts are
// sticky so lanes registering after an interrupt stop immediately.
function makeControls(onControl,controller){
  const controls=new Set();
  let interrupted=false;
  const composite={
    steer:async text=>{
      const active=[...controls];
      if(!active.length)throw new Error('This run is not ready for steering. Queue your message instead.');
      const settled=await Promise.allSettled(active.map(c=>c.steer(text)));
      const ok=settled.find(s=>s.status==='fulfilled');
      if(!ok)throw settled[0].reason;
      return ok.value;
    },
    interrupt:async()=>{
      interrupted=true;
      controller.abort(stoppedError());
      await Promise.allSettled([...controls].map(c=>c.interrupt()));
    },
  };
  onControl(composite);
  const register=()=>{
    let mine=null;
    return c=>{
      if(c){
        mine=c;
        controls.add(c);
        if(interrupted)void Promise.resolve().then(()=>c.interrupt()).catch(()=>{});
      }else if(mine){
        controls.delete(mine);
        mine=null;
      }
    };
  };
  return {register,done:()=>onControl(null)};
}

export function aggregate(pairs,canonicalBbl=null,{reconcile=true}={}){
  const live=pairs.filter(p=>p&&p.status!=='failed');
  const first=(pick)=>live.map(pick).find(Boolean);
  const property=first(p=>p.tools?.property)||null;
  const subjectBbl=property?.bbl||canonicalBbl||null;
  const subjectPairs=subjectBbl?live.filter(p=>!p.tools?.property?.bbl||String(p.tools.property.bbl)===String(subjectBbl)):live;
  const firstSubject=(pick)=>subjectPairs.map(pick).find(Boolean);
  const envelopeTools=subjectPairs.find(p=>{
    const zoning=p.aux?.zoningTools;
    return zoning?.envelope&&(!subjectBbl||!zoning.envelopeBbl||String(zoning.envelopeBbl)===String(subjectBbl));
  })?.aux.zoningTools;
  const marketPair=subjectPairs.find(p=>p.aux?.marketTools?.market);
  const market=marketPair?.aux?.marketTools?.market??null;
  const programPair=subjectPairs.find(p=>p.aux?.marketTools?.program);
  const rawProgram=programPair?.aux?.marketTools?.program??null;
  const program=rawProgram;
  const rawProFormas=subjectPairs.flatMap(p=>p.aux?.proFormaTools?.proFormas||[]);
  const proFormas=rawProFormas; // Preserve each computed scenario and its narrated inputs.
  return {
    concepts:subjectPairs.flatMap(p=>p.aux?.conceptTools?.concepts||[]),
    places:subjectPairs.flatMap(p=>p.aux?.placeTools?.places||[]),
    market,
    proFormas,
    envelope:envelopeTools?.envelope??null,
    envelopeSourceId:envelopeTools?.envelopeSourceId??null,
    program,
    property,
    entitlements:firstSubject(p=>p.aux?.entitlementTools?.entitlements)??null,
    comparisons:subjectPairs.flatMap(p=>p.aux?.feasibilityTools?.comparisons||[]),
    keep:subjectPairs.flatMap(p=>p.aux?.keepTools?.analyses||[]).at(-1)??null,
    plans:subjectPairs.flatMap(p=>p.aux?.planningTools?.plans||[]),
    assembly:firstSubject(p=>p.aux?.assemblyTools?.assembly)??null,
    nycPublicRecords:firstSubject(p=>p.aux?.nycRecordsTools?.records)??null,
    municipalRecords:firstSubject(p=>p.aux?.municipalRecordsTools?.latest)??null,
    floorplanAudits:subjectPairs.flatMap(p=>p.aux?.floorplanAuditTools?.audits||[]),
    deck:firstSubject(p=>p.aux?.deliverableTools?.deck)??null,
    dealSearch:first(p=>p.aux?.marketTools?.deals?.filters)??null,
    dealSearches:pairs.filter(Boolean).flatMap(p=>p.aux?.marketTools?.dealSearches||[]).sort((a,b)=>(a.sourceId??Infinity)-(b.sourceId??Infinity)),
  };
}

// Producer tools validate shape. Merge only completed, same-subject outputs with
// valid citation references. Exact conflicts require a lead decision, never a
// timing-dependent winner or an invented reconciliation of competing facts.
export function mergeLaneState(lead,lanes,canonicalBbl=null,sources=[]) {
  const own=aggregate([lead],canonicalBbl,{reconcile:false}),conflicts=[];
  const completed=lanes.filter(l=>l.status==='completed');
  const subjects=[...new Set(completed.map(l=>l.tools?.property?.bbl).filter(Boolean))];
  const subject=own.property?.bbl||canonicalBbl||(subjects.length===1?subjects[0]:null);
  const ambiguous=!subject&&subjects.length>1;
  if(ambiguous)conflicts.push({field:'property',resolution:'unresolved',reason:'Lanes selected different subjects.',subjects});
  const accepted=completed.filter(l=>!ambiguous&&(!subject||!l.tools?.property?.bbl||l.tools.property.bbl===subject));
  const state=aggregate([lead,...accepted],subject,{reconcile:false});
  const candidates=accepted.map(l=>({id:l.id,state:aggregate([l],subject,{reconcile:false})}));
  const ids=new Set(sources.map(s=>s.id));
  const validIds=value=>value==null||ids.has(value)||(typeof value==='object'&&Object.values(value).every(validIds));
  const validRefs=value=>{
    if(!value||typeof value!=='object')return true;
    return Object.entries(value).every(([key,child])=>key==='sourceId'||key==='sourceIds'?validIds(child):validRefs(child));
  };
  for(const key of Object.keys(state)){
    if(key==='envelopeSourceId')continue;
    const values=candidates.filter(c=>c.state[key]!=null&&(!Array.isArray(c.state[key])||c.state[key].length));
    if(!values.length)continue;
    if(values.some(c=>!validRefs(c.state[key]))){
      state[key]=own[key];conflicts.push({field:key,resolution:own[key]&&(!Array.isArray(own[key])||own[key].length)?'lead retained':'unresolved',reason:'Lane state contains an unknown citation.'});continue;
    }
    if(Array.isArray(state[key]))continue;
    const different=values.some(c=>!isDeepStrictEqual(c.state[key],values[0].state[key]));
    if(own[key]!=null){
      state[key]=own[key];
      if(values.some(c=>!isDeepStrictEqual(c.state[key],own[key])))conflicts.push({field:key,resolution:'lead retained',lanes:values.map(c=>c.id)});
    }else if(different){
      state[key]=null;conflicts.push({field:key,resolution:'unresolved',candidates:values.map(c=>({lane:c.id,value:c.state[key]}))});
    }
  }
  // An envelope's citation belongs to that exact envelope.
  state.envelopeSourceId=state.envelope?(own.envelope?own.envelopeSourceId:candidates.find(c=>isDeepStrictEqual(c.state.envelope,state.envelope))?.state.envelopeSourceId)??null:null;
  if(state.envelopeSourceId!=null&&!ids.has(state.envelopeSourceId)){
    state.envelope=null;state.envelopeSourceId=null;conflicts.push({field:'envelope',resolution:'unresolved',reason:'Lane envelope contains an unknown citation.'});
  }
  // A completed search is immutable evidence even if its lane's later draft
  // fails. It is not modeled subject state, and comparisons may concern other lots.
  state.dealSearches=aggregate([lead,...lanes],subject,{reconcile:false}).dealSearches.filter(validRefs);
  return {state,conflicts,excludedLanes:completed.filter(l=>!accepted.includes(l)).map(l=>l.id)};
}

// Citation validation judges the written answer; the structured results come from tools that keep
// their own source provenance. When only the prose fails, the error carries those results so the
// run can still save them to the project while it reports the failure.
// A sentence that still fails costs that sentence, not the answer (withoutUnsupportedCitations): a
// word-only sentence loses its brackets (citationsDropped), a figure sentence whose figures the cited
// sources state keeps them (citationsByFigures), and any other is left out (citationsRemoved). Only an
// answer that fails as a whole (an unknown source, no citations) fails the run.
function resultSources(result){
  // Generated surfaces can carry their own citations; preserve that evidence until they expose
  // explicit source references. Prose results retain the evidence behind every persisted field.
  if(result.ui?.length||result.deck)return result;
  const cited=new Set(citationIds(result.answer));
  const key=(s,at)=>JSON.stringify([s.url,s.title,s.kind,at??null]);
  const fields=Object.values(fieldsFromResult(result,null));
  const evidence=new Set(fields.flatMap(f=>f.provenance.sources).map(s=>key(s,s.retrievedAt)));
  return {...result,sources:result.sources.filter(s=>cited.has(s.id)||evidence.has(key(s,s.fetchedAt)))};
}
function validatedResult(result){
  try{validateCitations(result.answer,result.sources);}
  catch(error){
    const relaxed=withoutUnsupportedCitations(result.answer,result.sources);
    if(relaxed){
      if(relaxed.removed.length)console.log(JSON.stringify({event:'research_citations_degraded',removed:relaxed.removed.map(c=>c.slice(0,300))}));
      return resultSources({...result,answer:relaxed.answer,citationsDropped:relaxed.dropped,citationsByFigures:relaxed.figureSupported,citationsRemoved:relaxed.removed});
    }
    // The run store keeps only the first failure; the log keeps them all for diagnosis.
    console.log(JSON.stringify({event:'research_citations_failed',failures:(error.failures||[{message:error.message,code:error.code}]).map(f=>({code:f.code||null,message:f.message?.slice(0,160),claim:f.claim?.slice(0,300)??null,sourceIds:f.sourceIds??null}))}));
    const {answer:_answer,ui:_ui,...partialResult}=result;throw Object.assign(error,{partialResult});
  }
  return resultSources(result);
}

// The structured results a lead run saves to the project, from its collected tool state.
function researchResult(out,sources){
  return {sources, property:out.property, concepts:out.concepts, places:out.places, market:out.market, proFormas:out.proFormas, envelope:out.envelope, envelopeSourceId:out.envelopeSourceId, program:out.program,
    ...(out.entitlements?{entitlements:out.entitlements}:{}),
    ...(out.comparisons?.length?{comparisons:out.comparisons}:{}),
    ...(out.keep?{keep:out.keep}:{}),
    ...(out.plans?.length?{plans:out.plans}:{}),
    ...(out.assembly?{assembly:out.assembly}:{}),
    ...(out.nycPublicRecords?{nycPublicRecords:out.nycPublicRecords}:{}),
    ...(out.municipalRecords?{municipalRecords:out.municipalRecords}:{}),
    ...(out.floorplanAudits?.length?{floorplanAudits:out.floorplanAudits}:{}),
    ...(out.dealSearch?{dealSearch:out.dealSearch}:{}),
    ...(out.dealSearches.length?{dealSearches:out.dealSearches}:{}),
    ...(out.deck?{deck:out.deck}:{})};
}

// A research run, underwriting included, gets 20 minutes for its main turn and the check, fill and
// repair turns that follow it; runs are queued and worked in the background, so the person need not
// wait on the page.
export const RUN_DEADLINE_MS=20*60000;

function loadExpansions(){
  const store=openKnowledge();
  if(!store)return null;
  try{return store.expansionsMap();}finally{store.close();}
}

export async function research(input,secrets,progress=()=>{},emit=()=>{},onControl=()=>{},agent=runCodex) {
  const controller=new AbortController();
  const signal=combinedSignal(executionSignal(),input.signal,controller.signal);
  const activeEmit=(event,data)=>{if(event.startsWith('billing.')||(!signal.aborted&&!executionSignal()?.aborted))emit(event,data);};
  return withExecutionSignal(signal,async()=>{
    try{
      throwIfCancelled();
      return await researchRun(input,secrets,status=>{if(!signal.aborted&&!executionSignal()?.aborted)progress(status);},activeEmit,onControl,agent,controller);
    }finally{controller.abort(stoppedError());}
  });
}

// The most saved sources a follow-up run lists and can read again without fetching.
export const SAVED_SOURCE_LIMIT=20;

async function researchRun({message, userMessage = message, history = [], userHistory = null, propertyBbl, project = {}, priorState = null, memories = [], meter = null, composio = null, authorName = null, dealStore = {read: false, sync: false}, architecture = null, listingContext = null, alerts = null, savedSources = () => []}, secrets, progress, emit, onControl, agent, controller) {
  if (researchMode(secrets)!=='lanes') {
    // Lead mode (default): one agent with full discretion. Core evidence and
    // property tools are direct, as are the NYC records and zoning compute when
    // the run is about New York City; other specialist tools and skills are discovered
    // through the capability registry; parallel lanes happen only if the lead
    // calls acres_spawn_lanes. Everything shares one citation pool and budget.
    // The agent sees which saved sources it can open again, most cited first and capped so the
    // prompt stays small on large sites; their text is read only when it opens one.
    const saved=savedSources().slice(0,SAVED_SOURCE_LIMIT);
    const shared={sources:[],retrievedParcels:new Map(),seenKnowledge:new Set(),calls:0,subjectBbl:propertyBbl||priorState?.property?.bbl||null,savedPages:savedPageIndex(saved)};
    if(saved.length)project={...project,savedSources:saved.map(({title,url,offset,fetchedAt,fields})=>({title,url,...(offset?{offset}:{}),retrievedAt:fetchedAt,fields}))};
    const tools = createResearchTools(secrets, progress, meter, composio, shared);
    const ui=[];
    const aux=makeAux({emit,secrets,dealStore,listingContext,tools,progress,ui,priorState,shared,plans:architecture,meter,alerts});
    const allDefinitions=[...tools.definitions,...aux.definitions,generatedUiTool];
    const definitionByName=new Map(allDefinitions.map(d=>[d.name,d]));
    tools.offer(definitionByName.keys());
    const nyc=runInNyc({message,history,propertyBbl:propertyBbl||priorState?.property?.bbl||null});
    const direct=new Set(directToolNames({nyc}));
    const spawnOn=spawnEnabled(secrets);
    // Composio discovery only works with a per-account session; without one the
    // tools can only fail, so they are not offered.
    const composioTools=new Set(composio?[]:['acres_discover_tools','acres_execute_tool']);
    const leadDefinitions=[...allDefinitions.filter(d=>direct.has(d.name)&&!composioTools.has(d.name)),...gatewayDefinitions.filter(d=>spawnOn||d.name!=='acres_spawn_lanes')];
    const loadSkillDef=gatewayDefinitions.find(d=>d.name==='acres_load_skill');
    const controls=makeControls(onControl,controller);
    const spawned=[];
    let spawnedLaneResults=[];
    let spawnUsed=false;

    const runLane=async lane=>{
      const laneTools=createResearchTools(secrets,progress,meter,composio,shared);
      const laneAux=makeAux({emit,secrets,dealStore,listingContext,tools:laneTools,progress,ui,priorState,shared,plans:architecture,meter,alerts});
      const record={id:lane.id,status:'running',tools:laneTools,aux:laneAux};
      spawned.push(record);
      const allowed=new Set(lane.tools);
      const definitions=[...laneTools.definitions,...laneAux.definitions].filter(d=>allowed.has(d.name)&&!composioTools.has(d.name)).concat(loadSkillDef?[loadSkillDef]:[]);
      laneTools.offer(definitions.map(d=>d.name));
      const execute=async(name,args)=>{if(name==='acres_load_skill')return loadSkill(args.name);if(!allowed.has(name))throw new Error('This tool is unavailable in this lane.');return laneAux.execute(name,args);};
      const laneMessage=lane.question&&lane.question!==message?`${lane.question}\n\nOriginal user question: ${message}`:(lane.question||message);
      emit('lane.started',{lane:lane.id,spawned:true});
      try{
        const text=await meteredAgent({agent,meter,label:`lane_${lane.id}`,callArgs:{message:laneMessage,userMessage:lane.question||userMessage,effortMessage:`${lane.charter}\n${lane.question||userMessage}`,history,userHistory,propertyBbl:tools.property?.bbl||propertyBbl,project,memories,authorName,secrets,dynamicTools:definitions,execute,emit:(e,d)=>emit(e,{...d,lane:lane.id}),onControl:controls.register(),instructions:laneInstructions(lane),deadlineMs:180000}});
        record.status='completed';
        emit('lane.completed',{lane:lane.id,spawned:true,sources:shared.sources.length});
        return {id:lane.id,title:lane.title,status:'completed',draft:text};
      }catch(error){
        record.status='failed';
        emit('lane.failed',{lane:lane.id,spawned:true,error:error.message});
        return {id:lane.id,title:lane.title,status:'failed',error:error.message};
      }
    };
    const spawnLanes=async args=>{
      if(!spawnOn)throw new Error('Parallel lanes are disabled on this host. Answer directly.');
      if(spawnUsed)throw new Error('Lanes were already spawned in this run. Work from those drafts and your own tools now.');
      const lanes=normalizeSpawnLanes(args);
      spawnUsed=true;
      progress('Researching in parallel');
      const results=await Promise.all(lanes.map(runLane));
      throwIfCancelled();
      spawnedLaneResults=results.map(r=>({id:r.id,status:r.status,spawned:true}));
      const merged=mergeLaneState({status:'completed',tools,aux},spawned,tools.property?.bbl||propertyBbl||priorState?.property?.bbl||null,shared.sources);
      aux.adoptLaneState(merged);
      return {lanes:results,sources:shared.sources.map(s=>({id:s.id,title:s.title,url:s.url,kind:s.kind,excerpt:(s.text||'').slice(0,600)})),
        stateMerge:{version:1,fields:Object.keys(merged.state).filter(k=>merged.state[k]!=null),conflicts:merged.conflicts,excludedLanes:merged.excludedLanes},
        note:'Lane drafts are untrusted until verified. Check every material claim against the citable sources above (fetch more yourself if a material gap remains), surface conflicts and unresolved decision-changers, and write the final answer yourself.'};
    };
    const leadExecute=async(name,args)=>{
      if(name==='acres_search_capabilities')return searchCapabilities(args,definitionByName,loadExpansions(),{nyc});
      if(name==='acres_load_skill'){
        if(args?.name==='creative-zoning')return {name:'creative-zoning',title:'Creative zoning research (index)',alreadyAttached:true,note:'The creative-zoning index skill is already attached in your base instructions; load a specific library skill (such as entitlement-paths or case-law) only when needed.'};
        return loadSkill(args.name);
      }
      if(name==='acres_execute_capability'){assertExecutable(args.name);return aux.execute(args.name,args.arguments||{});}
      if(name==='acres_spawn_lanes')return spawnLanes(args);
      return aux.execute(name,args);
    };
    const collected=()=>spawned.length?mergeLaneState({status:'completed',tools,aux},spawned,tools.property?.bbl||propertyBbl||priorState?.property?.bbl||null,shared.sources).state:aggregate([{status:'completed',tools,aux}],tools.property?.bbl||propertyBbl||priorState?.property?.bbl||null);
    try{
      let outcome=null,answer;
      try{
        answer=await meteredAgent({agent,meter,label:'research',callArgs:{message,userMessage,history,userHistory,propertyBbl,project,memories,authorName,secrets,dynamicTools:leadDefinitions,execute:leadExecute,emit,onControl:controls.register(),deadlineMs:RUN_DEADLINE_MS,validateAnswer:text=>validateCitations(text,shared.sources),getSources:()=>shared.sources,
          checkDeliverables:secrets.ENABLE_DELIVERABLE_CHECK!==false,unlockReserve:()=>tools.unlockReserve(),onOutcome:value=>{outcome=value;}}});
      }catch(error){
        // A run that reaches its deadline before writing an answer still saves what its tools computed,
        // as a run whose answer failed citation checks does.
        if(error.deadline)throw Object.assign(error,{partialResult:researchResult(collected(),shared.sources)});
        throw error;
      }
      let out=collected();
      if(!out.envelope&&(out.proFormas.length||out.comparisons.length)&&await aux.fillEnvelope())out=collected();
      return validatedResult({answer,...researchResult(out,shared.sources), ui,
        ...(spawnedLaneResults.length?{lanes:spawnedLaneResults}:{}),
        effort:outcome?.effort??null,budgetExhausted:tools.budget.exhausted,repairFailed:outcome?.repairFailed===true,deliverableCheck:outcome?.check??null,
        fetchedAt:new Date().toISOString()});
    }finally{
      controls.done();
    }
  }

  // Legacy lanes mode (RESEARCH_MODE=lanes): the pre-registry fixed pipeline,
  // retained only so evals can compare it against lead mode on identical
  // prompts. Three charter lanes over one shared citation pool, then a judge.
  const shared={sources:[],retrievedParcels:new Map(),seenKnowledge:new Set()};
  const ui=[];
  const controls=makeControls(onControl,controller);
  try{
    const laneRuns=LANES.map(async lane=>{
      const tools=createResearchTools(secrets,progress,meter,composio,shared);
      const aux=makeAux({emit,secrets,dealStore,listingContext,tools,progress,ui,plans:architecture,meter,alerts});
      const allowed=new Set(lane.tools);
      const definitions=[...tools.definitions,...aux.definitions].filter(d=>allowed.has(d.name));
      tools.offer(definitions.map(d=>d.name));
      const execute=async(name,args)=>{if(!allowed.has(name))throw new Error('This tool is unavailable in this lane.');return aux.execute(name,args);};
      emit('lane.started',{lane:lane.id});
      try{
        const text=await meteredAgent({agent,meter,label:`lane_${lane.id}`,callArgs:{message,userMessage,effortMessage:`${lane.charter}\n${userMessage}`,history,userHistory,propertyBbl,project,memories,authorName,secrets,dynamicTools:definitions,execute,emit:(e,d)=>emit(e,{...d,lane:lane.id}),onControl:controls.register(),instructions:laneInstructions(lane),deadlineMs:180000}});
        emit('lane.completed',{lane:lane.id,sources:shared.sources.length});
        return {id:lane.id,status:'completed',text,tools,aux};
      }catch(error){
        emit('lane.failed',{lane:lane.id,error:error.message});
        return {id:lane.id,status:'failed',error:error.message,tools,aux};
      }
    });
    const lanes=await Promise.all(laneRuns);
    if(lanes.every(l=>l.status==='failed'))throw new Error(lanes[0].error||'Every research lane failed. Please retry.');
    const judgeTools=createResearchTools(secrets,progress,meter,composio,shared);
    const judgeAux=makeAux({emit,secrets,dealStore,listingContext,tools:judgeTools,progress,ui,plans:architecture,meter,alerts});
    const judgeAllowed=new Set(JUDGE_TOOLS);
    const judgeDefinitions=judgeTools.definitions.filter(d=>judgeAllowed.has(d.name));
    judgeTools.offer(judgeDefinitions.map(d=>d.name));
    const judgeExecute=async(name,args)=>{if(name===generatedUiTool.name)return judgeAux.execute(name,args);if(!judgeAllowed.has(name))throw new Error('This tool is unavailable to the judge.');return judgeTools.execute(name,args);};
    emit('judge.started',{lanes:lanes.map(l=>({id:l.id,status:l.status})),sources:shared.sources.length});
    const answer=await meteredAgent({agent,meter,label:'judge',callArgs:{message:judgePacket({question:message,lanes,sources:shared.sources}),history:[],userHistory,propertyBbl,project,memories,authorName,secrets,dynamicTools:[...judgeDefinitions,generatedUiTool],execute:judgeExecute,emit:(e,d)=>emit(e,{...d,lane:'judge'}),onControl:controls.register(),instructions:judgeInstructions(),effort:'high',deadlineMs:240000,includeSkill:false,validateAnswer:text=>validateCitations(text,shared.sources),getSources:()=>shared.sources}});
    emit('judge.completed',{sources:shared.sources.length});
    const out=aggregate([...lanes.map(l=>({status:l.status,tools:l.tools,aux:l.aux})),{status:'completed',tools:judgeTools,aux:judgeAux}],propertyBbl||null);
    return validatedResult({answer,sources:shared.sources,property:out.property,ui,concepts:out.concepts,places:out.places,market:out.market,proFormas:out.proFormas,envelope:out.envelope,envelopeSourceId:out.envelopeSourceId,program:out.program,
      ...(out.entitlements?{entitlements:out.entitlements}:{}),
      ...(out.comparisons?.length?{comparisons:out.comparisons}:{}),
      ...(out.keep?{keep:out.keep}:{}),
      ...(out.plans?.length?{plans:out.plans}:{}),
      ...(out.assembly?{assembly:out.assembly}:{}),
      ...(out.nycPublicRecords?{nycPublicRecords:out.nycPublicRecords}:{}),
      ...(out.dealSearch?{dealSearch:out.dealSearch}:{}),
      ...(out.dealSearches.length?{dealSearches:out.dealSearches}:{}),
      lanes:lanes.map(l=>({id:l.id,status:l.status})),fetchedAt:new Date().toISOString()});
  }finally{
    controls.done();
  }
}
