// The project state: one persisted set of fields per project (a site that one or more
// conversations work on) that every skill reads and writes, with provenance per field and a
// dependency graph that marks downstream fields stale when an upstream field changes. Runs write
// the fields their tools produced; users write only the user-owned keys. See docs/project-state.md.
import {randomUUID,createHash} from 'node:crypto';
import {normalizeMarketInputs} from './market.mjs';
import {sensitivity} from './proforma.mjs';
import {SCHEME_IDS, SCHEME_PARTS} from './schemes.mjs';
import {KEEP_ASSUMPTION_RANGES, repriceKeep} from './keep.mjs';

// The envelope's parking analysis, headline reconciliation and reader-facing prose: no field is derived
// from them (massing, entitlement sizing, unit mix and returns read the bulk, capacity and lot), so a
// recomputation that changes only these, such as parking run for another transit zone or a newer DOB
// filing, invalidates nothing downstream.
const envelopeBasis = ({parking: _parking, note: _note, citations: _citations, headlineReconciliation: _headline, summary, ...rest}) => {
  if (!summary) return rest;
  const {parkingRequired: _required, parkingTransitZones: _zones, plutoTransitZone: _pluto, proseGuidance: _prose, citations: _cited, sectionUrls: _urls, ...bulk} = summary;
  return {...rest, summary: bulk};
};

// Each field's producing tool and the fields it is derived from. basis, where given, is the part of
// the value its dependents are derived from; only a change to it marks them stale.
export const graph = {
  property: {tool: 'acres_set_subject', dependsOn: []},
  places: {tool: 'acres_nearby_places', dependsOn: ['property']},
  envelope: {tool: 'acres_zoning_envelope', dependsOn: ['property'], basis: envelopeBasis},
  concepts: {tool: 'acres_model_concept', dependsOn: ['property', 'envelope']},
  market: {tool: 'acres_market_inputs', dependsOn: ['property']},
  program: {tool: 'acres_unit_mix', dependsOn: ['concepts', 'market']},
  proFormas: {tool: 'acres_pro_forma', dependsOn: ['concepts', 'market', 'program']},
};

export const auxiliaryGraph = {
  assembly: {tool: 'acres_assemble_site', dependsOn: ['property']},
  entitlements: {tool: 'acres_entitlement_scenarios', dependsOn: ['property', 'envelope']},
  plans: {tool: 'acres_plan_concept', dependsOn: ['property', 'envelope', 'concepts']},
  comparisons: {tool: 'acres_compare_programs', dependsOn: ['property', 'envelope', 'concepts', 'market', 'program']},
  // Keeping the building as it stands (hold, renovate and rent, renovate and sell): it reads the parcel's
  // building and is repriced in code when the user's numbers change (deriveKeep).
  keep: {tool: 'acres_keep_building', dependsOn: ['property', 'assumptions']},
  publicRecords: {tool: 'acres_nyc_public_records', dependsOn: ['property']},
  floorplanAudits: {tool: 'acres_audit_floorplan', dependsOn: ['property', 'concepts', 'plans']},
  assumptions: {tool: 'user', dependsOn: []},
  instructions: {tool: 'user', dependsOn: []},
  architecture: {tool: 'acres_architecture_plan', dependsOn: ['property']},
  // Three ways to build the site, computed from the deal valuation when the site's schemes are read.
  schemes: {tool: 'schemes', dependsOn: ['property', 'envelope', 'market', 'assumptions']},
};

export const fullGraph = {
  ...graph,
  ...auxiliaryGraph,
  envelope: {...graph.envelope, dependsOn: [...graph.envelope.dependsOn, 'assembly']},
  program: {...graph.program, dependsOn: [...graph.program.dependsOn, 'plans']},
  proFormas: {...graph.proFormas, dependsOn: [...graph.proFormas.dependsOn, 'plans', 'assumptions']},
  comparisons: {...auxiliaryGraph.comparisons, dependsOn: [...new Set([...auxiliaryGraph.comparisons.dependsOn, 'assembly', 'entitlements', 'plans', 'proFormas'])]},
};

// Every field that depends on any of the given fields, directly or transitively.
export function dependents(keys, table = graph) {
  const found = new Set();
  const visit = key => {
    for (const [name, field] of Object.entries(table)) if (field.dependsOn.includes(key) && !found.has(name)) { found.add(name); visit(name); }
  };
  keys.forEach(visit);
  return [...found];
}

// Values are stored as canonical JSON (object keys sorted) so a re-selected parcel whose record
// arrives with another key order does not count as a change.
const canonical = value => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const basisKey = (key, value) => canonical(fullGraph[key]?.basis && value ? fullGraph[key].basis(value) : value);
// A new run ID or save time alone does not change the evidence for an unchanged field.
const evidenceKey = ({run, at, ...evidence}) => canonical(evidence);

// Schemes are recomputed whenever they are read, so a page load never changes a report's context.
export function reportFingerprint(projectId, state) {
  const fields=Object.fromEntries(Object.entries(state).filter(([key])=>key!=='architecture'&&key!=='schemes'));
  return createHash('sha256').update(canonical({projectId,fields})).digest('hex');
}

export function reportValuesMatch(state, result) {
  return Object.entries(fieldsFromResult(result,null)).every(([key,field])=>canonical(field.value)===canonical(state[key]?.value));
}

const cite = source => ({title: source.title, url: source.url, kind: source.kind, retrievedAt: source.fetchedAt ?? null});

// Public evidence a later run may read again from the run that recorded it. Computed sources are
// recorded again from the saved fields, and account-gated, licensed or unverified kinds never are.
export const REUSABLE_SOURCE_KINDS = new Set(['research', 'property', 'official_record']);

// The reusable sources behind the project's current fields: each with the fields that cite it and
// the runs that could have recorded it (an accumulated list keeps the runs of its entries).
export function savedSourceRefs(state) {
  const refs = new Map();
  for (const [key, field] of Object.entries(state)) {
    if (!field || field.stale != null || !field.provenance) continue;
    const runs = [...new Set([field.provenance.run, ...(field.provenance.lineage ?? []).map(entry => entry.run)].filter(Boolean))];
    for (const source of field.provenance.sources ?? []) {
      if (!REUSABLE_SOURCE_KINDS.has(source.kind) || !source.retrievedAt) continue;
      const id = JSON.stringify([source.url, source.title, source.retrievedAt]);
      if (!refs.has(id)) refs.set(id, {title: source.title, url: source.url, kind: source.kind, retrievedAt: source.retrievedAt, fields: [], runs: new Set()});
      refs.get(id).fields.push(key);
      for (const run of runs) refs.get(id).runs.add(run);
    }
  }
  return [...refs.values()].map(ref => ({...ref, runs: [...ref.runs]}));
}

// The fields a finished run produced, each with its provenance. Source IDs are per answer, so the
// provenance keeps copies of the sources themselves.
const marketSourceIds = market => [...['rents', 'salePrices', 'commercialRents'].flatMap(k => (market[k] || []).map(r => r.sourceId)), ...['supply', 'pipeline', 'absorption'].map(k => market[k]?.sourceId)].filter(id => id != null);

export function fieldsFromResult(result, run) {
  const sources = result.sources || [];
  const byId = ids => sources.filter(s => ids.includes(s.id)).map(cite);
  const propSourceRows = result.property?.bbl ? sources.filter(s => s.kind === 'property' && s.text?.includes(String(result.property.bbl))) : [];
  const propSources = propSourceRows.map(cite);
  const fields = {};
  if (result.property?.bbl) {
    fields.property = {value: result.property, provenance: {tool: graph.property.tool, run, sources: propSources}};
  }
  if (result.envelope) fields.envelope = {value: result.envelope, provenance: {tool: graph.envelope.tool, run, sources: sources.filter(s => propSourceRows.includes(s) || (result.envelopeSourceId != null && s.id === result.envelopeSourceId)).map(cite)}};
  if (result.program) fields.program = {value: result.program, provenance: {tool: graph.program.tool, run, sources: byId((result.program.byBedrooms || []).map(r => r.sourceId))}};
  if (result.places?.length) fields.places = {value: result.places, provenance: {tool: graph.places.tool, run, sources: byId(result.places.map(p => p.sourceId))}};
  if (result.market) fields.market = {value: result.market, provenance: {tool: graph.market.tool, run, sources: byId(marketSourceIds(result.market))}};
  if (result.proFormas?.length) fields.proFormas = {value: result.proFormas, provenance: {tool: graph.proFormas.tool, run, sources: byId(result.proFormas.flatMap(p => (p.sources || []).map(s => s.sourceId)))}};
  if (result.concepts?.length) fields.concepts = {value: result.concepts, provenance: {tool: graph.concepts.tool, run, sources: byId(result.concepts.map(c => c.context?.sourceId))}};
  if (result.entitlements) {
    const entIds = [...(result.entitlements.sourceId != null ? [result.entitlements.sourceId] : []), ...(result.entitlements.sourceIds || []), ...(result.entitlements.scenarios || []).flatMap(s => s.sourceIds || (s.sourceId != null ? [s.sourceId] : []))];
    const entSources = byId(entIds);
    fields.entitlements = {value: result.entitlements, provenance: {tool: auxiliaryGraph.entitlements.tool, run, sources: entSources.length ? entSources : propSources}};
  }
  if (result.comparisons?.length) {
    const compIds = result.comparisons.flatMap(c => [...(c.sourceIds || []), ...(c.sources || []).map(s => s.sourceId).filter(id => id != null)]);
    fields.comparisons = {value: result.comparisons, provenance: {tool: auxiliaryGraph.comparisons.tool, run, sources: byId(compIds)}};
  }
  if (result.plans?.length) {
    const planIds = result.plans.flatMap(p => [...(p.sourceIds || []), ...(p.sourceId != null ? [p.sourceId] : [])]);
    fields.plans = {value: result.plans, provenance: {tool: auxiliaryGraph.plans.tool, run, sources: byId(planIds)}};
  }
  if (result.assembly) {
    const asmIds = [...(result.assembly.sourceIds || []), ...(result.assembly.parcels || []).map(p => p.sourceId).filter(id => id != null)];
    const asmSources = byId(asmIds);
    fields.assembly = {value: result.assembly, provenance: {tool: auxiliaryGraph.assembly.tool, run, sources: asmSources.length ? asmSources : propSources}};
  }
  if (result.nycPublicRecords) {
    const {proseReportingMandate: _mandate, ...records} = result.nycPublicRecords;
    fields.publicRecords = {value: records, provenance: {tool: auxiliaryGraph.publicRecords.tool, run, sources: byId(Object.values(records.sourceIds || {}))}};
  }
  if (result.floorplanAudits?.length) fields.floorplanAudits = {value: result.floorplanAudits, provenance: {tool: auxiliaryGraph.floorplanAudits.tool, run, sources: []}};
  if (result.keep) fields.keep = {value: result.keep, provenance: {tool: auxiliaryGraph.keep.tool, run, sources: byId(result.keep.sourceIds || [])}};
  return fields;
}

// What the harness is told about the state before a run: enough to know what exists and what to
// regenerate, without the full values.
export function describe(state) {
  const summary = {};
  for (const [key, field] of Object.entries(state)) {
    const value = field.value;
    summary[key] = {
      ...(key === 'property' ? {bbl: value.bbl, address: value.address}
        : key === 'concepts' || key === 'plans' ? {names: value.map(c => c.name)}
        : key === 'proFormas' ? {
            names: value.map(c => c.name),
            ...(value.at(-1)?.development || value.at(-1)?.costs || value.at(-1)?.returns ? {
              latest: {
                name: value.at(-1).name,
                productType: value.at(-1).productType,
                totalDevelopmentCost: value.at(-1).development?.totalDevelopmentCost ?? value.at(-1).costs?.totalDevelopmentCost ?? null,
                profit: value.at(-1).returns?.profit ?? null,
                capRate: value.at(-1).operations?.capRate ?? value.at(-1).capRate ?? null,
              },
            } : {}),
          }
        : key === 'market' ? {
            submarket: value.submarket,
            sections: Object.keys(value).filter(k => ['rents', 'salePrices', 'commercialRents', 'supply', 'pipeline', 'absorption'].includes(k)),
            ...(Array.isArray(value.rents) ? {rents: value.rents.map(r => ({bedrooms: r.bedrooms, rentPerSqftPerMonth: r.rentPerSqftPerMonth}))} : {}),
          }
        : key === 'envelope' ? {
            district: value.district, far: value.metrics?.far, heightFeet: value.metrics?.heightFeet,
            ...(value.capacity?.byUse ? {remainingFloorAreaSqft: Object.fromEntries(Object.entries(value.capacity.byUse).map(([use, u]) => [use, u.remainingFloorAreaSqft]))} : {}),
            ...(value.summary ? {maxDwellingUnits: value.summary.maxDwellingUnits, stoppedBy: value.summary.stoppedBy} : {}),
          }
        : key === 'program' ? {productType: value.productType, units: value.units, residentialGrossSqft: value.residentialGrossSqft}
        : key === 'entitlements' ? {district: value.district, topScenarios: (value.scenarios || []).slice(0, 3).map(s => s.id), paths: (value.paths || value.scenarios || []).map(p => p.name || p.id)}
        : key === 'comparisons' ? {recommendations: value.map(c => c.recommendation?.label || c.winner?.name).filter(Boolean), winner: value[0]?.recommendation?.label || value[0]?.winner?.name, ...(value.at(-1)?.decision ? {decision: value.at(-1).decision.verdict} : {})}
        : key === 'publicRecords' ? {
            bbl: value.bbl,
            totalFilings: value.submittalForensics?.totalFilingsReturned,
            majorFilings: value.submittalForensics?.majorFilings?.length,
            openHpdViolations: value.hpdViolationSummary?.openInSample,
            classCHpdViolations: value.hpdViolationSummary?.classCInSample,
            eDesignations: value.eDesignations?.length,
          }
        : key === 'floorplanAudits' ? {
            count: value.length,
            latest: {
              productType: value.at(-1).productType,
              currentEfficiencyPercent: value.at(-1).summaryMetrics?.currentEfficiencyPercent,
              targetBenchmarkEfficiencyPercent: value.at(-1).summaryMetrics?.targetBenchmarkEfficiencyPercent,
              recoverableNetSqft: value.at(-1).summaryMetrics?.recoverableNetSqft,
            },
          }
        : key === 'keep' ? {
            price: value.price, decision: value.decision?.verdict ?? null,
            ways: (value.strategies || []).map(s => ({id: s.id, priced: s.priced, maxPrice: s.maxPrice ?? null, call: s.call ?? null})),
            ...(value.derived ? {repricedWithUserNumbers: true} : {}),
          }
        : key === 'assumptions' ? {values: value}
        : key === 'instructions' ? {bySection: Object.fromEntries(Object.entries(value).map(([section, text]) => [instructionSections[section], text])), provenance: field.provenance}
        : key === 'schemes' ? {schemes: value.schemes.map(s => ({id: s.id, label: s.label, summary: s.summary, best: s.best, landValue: s.returns?.landValue ?? null}))}
        : key === 'architecture' ? {planId: value.planId, scheme: value.scheme, revision: value.revision, name: value.name, artifacts: Object.keys(value.artifacts || {}), ...(value.plans ? {plans: value.plans} : {})}
        : key === 'assembly' ? {bbls: value.bbls || (value.parcels || []).map(p => p.bbl), totalAreaSqft: value.assembled?.totalAreaSqft ?? value.mergedLotAreaSqft}
        : {count: Array.isArray(value) ? value.length : undefined}),
      updated: new Date(field.updated).toISOString(),
      ...(field.stale ? {stale: key === 'schemes' ? `${field.stale} changed since these were computed; they are recomputed when the site page next loads` : `${field.stale} changed since this was produced; re-run ${fullGraph[key]?.tool} if the answer depends on it`} : {}),
    };
  }
  return summary;
}

function hasMismatchedSubjectBbl(fieldValue, targetBbl) {
  if (!targetBbl || !fieldValue) return false;
  const checkItem = item => {
    if (!item || typeof item !== 'object') return false;
    const itemBbl = item.bbl ?? item.subjectBbl ?? item.property?.bbl ?? item.context?.subject?.bbl ?? item.parcel?.bbl ?? null;
    return itemBbl != null && String(itemBbl) !== String(targetBbl);
  };
  return Array.isArray(fieldValue) ? fieldValue.some(checkItem) : checkItem(fieldValue);
}

// Fields that accumulate across answers instead of being replaced: a new entry supersedes a prior
// one with the same id or name, the rest are kept oldest first, and provenance.lineage records the
// run that produced each kept entry.
const accumulating = new Set(['concepts', 'proFormas']);
export const accumulationCap = 12;
const sameEntry = (a, b) => (a.id != null && a.id === b.id) || (a.name != null && a.name === b.name);
const lineageOf = (entries, provenance) => provenance.lineage || entries.map(e => ({id: e.id ?? null, name: e.name ?? null, run: provenance.run ?? null}));

// Two sites' lists of one accumulating field: top's entries supersede base's of the same id or name,
// each kept entry keeps its own lineage.
function mergeEntries(base, top) {
  const baseLineage = lineageOf(base.value, base.provenance), topLineage = lineageOf(top.value, top.provenance);
  const merged = [...base.value.map((entry, i) => ({entry, lineage: baseLineage[i]})).filter(({entry}) => !top.value.some(next => sameEntry(entry, next))),
    ...top.value.map((entry, i) => ({entry, lineage: topLineage[i]}))].slice(-accumulationCap);
  const sources = [...new Map([...base.provenance.sources || [], ...top.provenance.sources || []].map(s => [`${s.url}::${s.title}`, s])).values()];
  return {value: merged.map(m => m.entry), provenance: {...top.provenance, sources, lineage: merged.map(m => m.lineage)}};
}

function accumulate(prior, field) {
  const priorLineage = lineageOf(prior.value, prior.provenance);
  const kept = prior.value.map((entry, i) => ({entry, lineage: priorLineage[i]})).filter(({entry}) => !field.value.some(next => sameEntry(entry, next)));
  const merged = [...kept, ...field.value.map(entry => ({entry, lineage: {id: entry.id ?? null, name: entry.name ?? null, run: field.provenance.run ?? null}}))].slice(-accumulationCap);
  const sources = [...new Map([...prior.provenance.sources || [], ...field.provenance.sources || []].map(s => [`${s.url}::${s.title}`, s])).values()];
  return {value: merged.map(m => m.entry), provenance: {...field.provenance, sources, lineage: merged.map(m => m.lineage)}};
}

// Reconcile a completed run against the context it read, retaining newer facts and lineage.
export function reconcileResearchFields(base, current, incoming) {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(current)])];
  const sameValue = (a, b) => canonical(a?.value) === canonical(b?.value);
  const revised = new Set(keys.filter(key => canonical(base[key]) !== canonical(current[key])));
  const changedInputs = new Set(keys.filter(key => !sameValue(base[key], current[key]) || base[key]?.stale !== current[key]?.stale));
  const fields = {}, skipped = new Set();
  for (const [key, field] of Object.entries(incoming)) {
    if (changedInputs.has('instructions')) { skipped.add(key); continue; }
    if (!revised.has(key)) { fields[key] = field; continue; }
    const prior = base[key], live = current[key];
    if (sameValue(field, live) && live?.stale === null) continue;
    if (accumulating.has(key) && Array.isArray(live?.value) && live.stale === null) {
      const before = prior?.value || [], beforeLineage = lineageOf(before, prior?.provenance || {});
      const liveLineage = lineageOf(live.value, live.provenance), accepted = [];
      for (const entry of field.value) {
        const a = before.findIndex(item => sameEntry(item, entry)), b = live.value.findIndex(item => sameEntry(item, entry));
        if (b >= 0 && canonical(entry) === canonical(live.value[b])) continue;
        if (canonical(before[a]) !== canonical(live.value[b]) || beforeLineage[a]?.run !== liveLineage[b]?.run) {
          skipped.add(key); changedInputs.add(key);
        } else accepted.push(entry);
      }
      if (accepted.length) fields[key] = {...field, value: accepted};
    } else { skipped.add(key); changedInputs.add(key); }
  }
  const blocked = new Set(dependents([...changedInputs], fullGraph));
  for (const key of Object.keys(fields)) if (blocked.has(key)) { delete fields[key]; skipped.add(key); }
  const affected = [...changedInputs].filter(key => key === 'instructions' || skipped.has(key) || dependents([key], fullGraph).some(name => skipped.has(name)));
  return {fields, skippedFields: [...skipped], changedInputs: affected};
}

// Keys a user may write through the project API. Every other key is produced by a tool in a run.
export const userKeys = ['assumptions', 'market', 'program', 'instructions'];

// The site page's sections a user can leave standing instructions on, keyed by section id.
export const instructionSections = {
  envelope: 'Zoning envelope and scenarios',
  massing: 'Massing',
  architecture: 'Architecture',
  revenue: 'Usable area and revenue',
  assumptions: 'Assumptions and uncertainty',
};

const bad = message => Object.assign(new Error(message), {status: 400});
const plain = value => value != null && typeof value === 'object' && !Array.isArray(value);
function range(value, name, [min, max, whole]) {
  if (whole && !Number.isInteger(value)) throw bad(`${name} must be a whole number.`);
  if (!(Number.isFinite(value) && value >= min && value <= max)) throw bad(`${name} must be a number from ${min} to ${max}.`);
  return value;
}
// The pro forma assumptions a user can set, with the ranges acres_pro_forma enforces (proforma.mjs).
const assumptionRanges = {
  landPrice: [0, 5_000_000_000], hardCostPerSqft: [50, 3000], softCostPerSqft: [0, 1500], capRate: [0.02, 0.15], sellingCostRate: [0, 0.2],
  financing: {loanToCost: [0, 0.95], interestRate: [0, 0.3], termMonths: [1, 120, true]},
  operating: {residentialVacancyRate: [0, 0.5], residentialOpexPerUnitPerYear: [0, 100000], commercialVacancyRate: [0, 0.5], commercialOpexPerSqftPerYear: [0, 500]},
  // Keeping the building: the work, rents, values and terms acres_keep_building takes (keep.mjs).
  keep: KEEP_ASSUMPTION_RANGES,
};
function checkAssumptions(value, spec = assumptionRanges, prefix = '') {
  if (!plain(value)) throw bad(`${prefix || 'assumptions'} must be an object.`);
  for (const [key, item] of Object.entries(value)) {
    if (!(key in spec)) throw bad(`${prefix}${key} is not an assumption a user can set.`);
    if (Array.isArray(spec[key])) range(item, `${prefix}${key}`, spec[key]);
    else checkAssumptions(item, spec[key], `${key}.`);
  }
  return value;
}
function checkProgram(program) {
  if (!plain(program) || !['rental', 'condo'].includes(program.productType)) throw bad('program.productType must be rental or condo.');
  if (!Array.isArray(program.byBedrooms) || !program.byBedrooms.length || program.byBedrooms.length > 4) throw bad('program.byBedrooms must list 1 to 4 bedroom rows.');
  program.byBedrooms.forEach((row, i) => {
    range(row?.bedrooms, `program.byBedrooms[${i}].bedrooms`, [0, 3, true]);
    range(row.units, `program.byBedrooms[${i}].units`, [0, 10000, true]);
    range(row.unitSqft, `program.byBedrooms[${i}].unitSqft`, [250, 5000]);
  });
  if (new Set(program.byBedrooms.map(r => r.bedrooms)).size !== program.byBedrooms.length) throw bad('program.byBedrooms must have one row per bedroom count.');
  return program;
}
function checkInstructions(value) {
  if (!plain(value)) throw bad('instructions must be an object.');
  const kept = {};
  for (const [section, text] of Object.entries(value)) {
    if (!(section in instructionSections)) throw bad(`${section} is not a section that takes instructions.`);
    if (typeof text !== 'string') throw bad(`instructions.${section} must be text.`);
    if (text.length > 2000) throw bad(`instructions.${section} must be at most 2000 characters.`);
    if (text.trim()) kept[section] = text.trim();
  }
  return kept;
}
function checkMarket(market) {
  if (!plain(market)) throw bad('market must be an object.');
  try { return normalizeMarketInputs(market); } catch (error) { throw bad(error.message); }
}

// Validates a user edit and returns it as fields with user provenance, ready for ProjectState.write.
export function userFields(fields, account, at) {
  if (!plain(fields) || !Object.keys(fields).length) throw bad(`fields must set at least one of ${userKeys.join(', ')}.`);
  const provenance = {tool: 'user', account, at: new Date(at).toISOString(), sources: []};
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (!userKeys.includes(key)) throw bad(`${key} is produced by research runs; a user can set only ${userKeys.join(', ')}.`);
    const checked = key === 'assumptions' ? checkAssumptions(value) : key === 'market' ? checkMarket(value) : key === 'instructions' ? checkInstructions(value) : checkProgram(value);
    return [key, {value: checked, provenance}];
  }));
}

// A stored pro forma recomputed in code from its echoed inputs with the user's assumptions on top,
// at the current market figures and unit mix (same gross area and commercial space). Returns null
// when the swap cannot be made honestly (no echoed inputs, product mismatch, no units).
function recompute(previous, market, program, assumptions, replaceProgram) {
  const prior = previous?.inputs;
  if (!prior) return null;
  const units = replaceProgram ? (program.byBedrooms || []).filter(r => r.units > 0).map(r => ({bedrooms: r.bedrooms, count: r.units, netSqft: r.unitSqft})) : prior.program.units;
  if (!units.length) return null;
  const {market: _echo, ...rest} = prior;
  const args = {...rest, ...assumptions, financing: {...rest.financing, ...assumptions.financing}, program: {...prior.program, units}};
  if (rest.operating || assumptions.operating) args.operating = {...rest.operating, ...assumptions.operating};
  const facts = {
    land: prior.landPriceBasis && assumptions.landPrice === undefined ? {...prior.landPriceBasis, sourceId: null} : null,
    taxes: prior.realEstateTaxes ? {...prior.realEstateTaxes, sourceId: null} : null,
  };
  const {base, table} = sensitivity(args, market, previous.sensitivitySteps ?? {}, facts);
  return {...base, sensitivitySteps: previous.sensitivitySteps ?? {}, ...(previous.sensitivity ? {sensitivity: table} : {}), createdAt: new Date().toISOString(), derived: true,
    derivedNote: 'Recomputed in code from the current market inputs and assumptions, preserving each scenario program except for a matching explicit unit-mix edit; re-run acres_pro_forma if the building size or product changed.'};
}

// The derive callback for ProjectState.write: when market, program or assumptions changed, every
// stored pro forma is recomputed so it is current again instead of stale, provided the geometry it
// rests on is not stale. Returns null (the pro formas stay stale) when any one cannot be recomputed.
export function deriveProFormas(state, changed, run = null, priorState = null) {
  if (!['market', 'program', 'assumptions'].some(key => changed.includes(key))) return null;
  if (state.concepts?.stale || state.envelope?.stale || state.assembly?.stale || state.plans?.stale) return null;
  const market = state.market?.value, program = state.program?.value, previous = state.proFormas?.value;
  if (!market || !previous?.length) return null;
  const oldProgram = priorState?.program?.value;
  const programChanged = changed.includes('program');
  const sameResidentialArea = oldProgram?.residentialGrossSqft === program?.residentialGrossSqft;
  if (programChanged && oldProgram?.residentialGrossSqft != null && !sameResidentialArea) return null;
  const sameBuilding = (p, mix) => Boolean(mix && p.inputs?.productType === mix.productType
    && (mix.residentialGrossSqft == null || mix.residentialGrossSqft === p.inputs.program.grossBuildingSqft
      // A single mixed-use scenario can retain its known residential-area basis. Commercial
      // net area is not a deduction from total gross area; the exact unit match below links it.
      // A previously stale model cannot establish that residential-area association.
      || (previous.length === 1 && priorState?.proFormas?.stale == null && sameResidentialArea && mix.residentialGrossSqft > 0
        && mix.residentialGrossSqft <= p.inputs.program.grossBuildingSqft
        && p.inputs.program.commercial.some(space => space.netSqft > 0))));
  const matchesProgram = (p, mix) => sameBuilding(p,mix)
    && canonical(p.inputs.program.units) === canonical((mix.byBedrooms || []).filter(r => r.units > 0).map(r => ({bedrooms:r.bedrooms,count:r.units,netSqft:r.unitSqft})));
  // Exact old-program matches may be edited; an exact new match may revalidate a correction.
  // Ambiguous collections, product changes and changed building sizes stay stale.
  if (programChanged && !previous.every(p => sameBuilding(p,program) && (matchesProgram(p,oldProgram) || matchesProgram(p,program)))) return null;

  let derived;
  try { derived = previous.map(p => recompute(p, market, program, state.assumptions?.value ?? {}, programChanged)); } catch { return null; }
  if (derived.some(p => !p)) return null;
  const strip = list => list.map(({createdAt, derived: _d, derivedNote: _n, ...rest}) => rest);
  const unchanged = canonical(strip(derived)) === canonical(strip(previous));
  if (unchanged && !state.proFormas.stale) return null;
  const basisTitles = new Set(derived.flatMap(({inputs}) => [
    ...(inputs.landPriceBasis ? [`${inputs.landPriceBasis.source}, land price estimate`] : []),
    ...(inputs.realEstateTaxes ? [`${inputs.realEstateTaxes.source}, real estate taxes`] : []),
  ]));
  const sources = [
    ...(state.market.provenance.sources ?? []),
    ...(state.proFormas.provenance?.sources ?? []).filter(source => source.kind === 'official_record' && basisTitles.has(source.title)),
  ];
  const uniqueSources = [...new Map(sources.map(source => [JSON.stringify([source.title, source.url, source.kind, source.retrievedAt]), source])).values()];
  return {proFormas: {value: unchanged ? previous : derived, provenance: {tool: graph.proFormas.tool, run, derived: true, sources: uniqueSources}}};
}

// The derive callback for the keep-the-building analysis: when the user's numbers change, the saved
// analysis is repriced in code from the inputs its run used, with the user's land price as the purchase
// price and assumptions.keep on top. An analysis gone stale for another reason (a new parcel) stays stale.
export function deriveKeep(state, changed) {
  if (!changed.includes('assumptions')) return null;
  const field = state.keep;
  if (!field?.value || (field.stale != null && field.stale !== 'assumptions')) return null;
  let value;
  try { value = repriceKeep(field.value, state.assumptions?.value ?? {}); } catch { return null; }
  if (!value) return null;
  return {keep: {value, provenance: {...field.provenance, tool: auxiliaryGraph.keep.tool, derived: true}}};
}

const PROJECTS_DDL = `CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,owner TEXT NOT NULL,site_key TEXT NOT NULL,bbl TEXT,title TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS modeling_projects(project TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS project_owner ON projects(owner,updated DESC);
CREATE INDEX IF NOT EXISTS project_owner_bbl ON projects(owner,bbl) WHERE bbl IS NOT NULL;
CREATE TABLE IF NOT EXISTS project_events(project TEXT NOT NULL REFERENCES projects(id),seq INTEGER NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(project,seq));
CREATE TABLE IF NOT EXISTS project_field_archive(project TEXT NOT NULL,from_project TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,provenance TEXT NOT NULL,stale TEXT,updated INTEGER NOT NULL,archived INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS project_field_archive_project ON project_field_archive(project,key);
CREATE TABLE IF NOT EXISTS project_event_archive(project TEXT NOT NULL,from_project TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(from_project,seq));
CREATE TABLE IF NOT EXISTS project_aliases(project TEXT PRIMARY KEY,merged_into TEXT NOT NULL,at INTEGER NOT NULL);`;
const FIELDS_DDL = 'CREATE TABLE IF NOT EXISTS project_fields(project TEXT NOT NULL REFERENCES projects(id),key TEXT NOT NULL,value TEXT NOT NULL,provenance TEXT NOT NULL,stale TEXT,updated INTEGER NOT NULL,PRIMARY KEY(project,key));';
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

export class ProjectState {
  constructor(db) {
    this.db = db;
    db.exec(PROJECTS_DDL);
    // A database from before projects keeps its conversation-keyed table until migrate() moves it.
    if (!columns(db, 'project_fields').length) db.exec(FIELDS_DDL);
  }
  create(owner, siteKey, title, at = Date.now(), bbl = null) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,0,?,?)').run(id, owner, siteKey, bbl, title, at, at);
    return id;
  }
  row(project) { return this.db.prepare('SELECT * FROM projects WHERE id=?').get(project) ?? null; }
  // A project merged into another keeps an alias so an open page or a copied site link to it lands
  // on the surviving site instead of 404ing. Chains are acyclic (a target is live when aliased to).
  recordAlias(from, into, at = Date.now()) { this.db.prepare('INSERT OR REPLACE INTO project_aliases VALUES(?,?,?)').run(from, into, at); }
  resolveAlias(project) {
    let current = project;
    for (let i = 0; i < 10 && !this.row(current); i++) {
      const next = this.db.prepare('SELECT merged_into FROM project_aliases WHERE project=?').get(current)?.merged_into;
      if (!next) return null;
      current = next;
    }
    return this.row(current) ? current : null;
  }
  property(project) {
    const row = this.db.prepare("SELECT value FROM project_fields WHERE project=? AND key='property'").get(project);
    return row ? JSON.parse(row.value) : null;
  }
  read(project) {
    return Object.fromEntries(this.db.prepare('SELECT * FROM project_fields WHERE project=?').all(project).map(r => [r.key, {value: JSON.parse(r.value), provenance: JSON.parse(r.provenance), stale: r.stale, updated: r.updated}]));
  }
  // Writes the fields in one transaction and marks the dependents of changed fields stale, except
  // those genuinely recomputed for the new upstream state. An optional derive callback runs inside
  // the transaction after stale-marking with (stateAfterWrite, changedKeys) and returns fields to
  // upsert fresh, for values that are pure calculation from other fields. Returns keys whose
  // values, freshness or provenance changed; only a change to the part of a value its dependents
  // are derived from (its basis) invalidates them.
  write(project, fields, at = Date.now(), derive = null) {
    const keys = Object.keys(fields), changed = [], invalidating = [], revalidated = new Set(), refreshed = new Set();
    this.db.exec('SAVEPOINT project_write');
    try {
      // Accumulate only onto a current value for the same subject; a stale or other-parcel list is replaced.
      const priorState = this.read(project);
      const sameSubject = !fields.property || fields.property.value?.bbl === priorState.property?.value?.bbl;
      if (sameSubject) {
        fields = {...fields};
        for (const key of keys) {
          const prior = priorState[key];
          if (accumulating.has(key) && prior && prior.stale == null && Array.isArray(prior.value)) fields[key] = accumulate(prior, fields[key]);
        }
      }
      for (const key of keys) {
        const value = canonical(fields[key].value);
        const old = this.db.prepare('SELECT value, stale FROM project_fields WHERE project=? AND key=?').get(project, key);
        if (old?.value !== value) changed.push(key);
        if (old?.value !== value && (!old || basisKey(key, JSON.parse(old.value)) !== basisKey(key, fields[key].value))) invalidating.push(key);
        if (old?.stale != null) revalidated.add(key);
        const prior = priorState[key];
        if (prior && (prior.stale != null || evidenceKey(prior.provenance) !== evidenceKey(fields[key].provenance))) refreshed.add(key);
        const updated = changed.includes(key) || refreshed.has(key);
        this.db.prepare('INSERT INTO project_fields VALUES(?,?,?,?,NULL,?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value,provenance=excluded.provenance,stale=NULL,updated=excluded.updated').run(project, key, value, JSON.stringify(updated ? fields[key].provenance : prior.provenance), updated ? at : prior.updated);
      }
      const newPropertyBbl = fields.property?.value?.bbl ?? this.property(project)?.bbl ?? null;
      for (const key of invalidating) for (const dependent of dependents([key], fullGraph)) {
        const coWrittenValid = keys.includes(dependent)
          && (changed.includes(dependent) || revalidated.has(dependent))
          && !hasMismatchedSubjectBbl(fields[dependent]?.value, newPropertyBbl);
        if (!coWrittenValid) {
          this.db.prepare('UPDATE project_fields SET stale=? WHERE project=? AND key=? AND stale IS NULL').run(key, project, dependent);
        }
      }
      if (derive) {
        const derived = derive(this.read(project), changed, priorState) || {};
        const derivedKeys = Object.keys(derived), derivedChanged = [];
        for (const key of derivedKeys) {
          const value = canonical(derived[key].value);
          const old = this.db.prepare('SELECT value, provenance FROM project_fields WHERE project=? AND key=?').get(project, key);
          if (old?.value !== value) {
            if (!changed.includes(key)) changed.push(key);
            derivedChanged.push(key);
          }
          // A derived list is the prior list recomputed entry for entry, so it keeps the prior lineage.
          const provenance = old && !derived[key].provenance.lineage && accumulating.has(key) ? {...derived[key].provenance, lineage: lineageOf(JSON.parse(old.value), JSON.parse(old.provenance))} : derived[key].provenance;
          const prior = priorState[key];
          if (prior && (prior.stale != null || evidenceKey(prior.provenance) !== evidenceKey(provenance))) refreshed.add(key);
          const updated = changed.includes(key) || refreshed.has(key);
          this.db.prepare('INSERT INTO project_fields VALUES(?,?,?,?,NULL,?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value,provenance=excluded.provenance,stale=NULL,updated=excluded.updated').run(project, key, value, JSON.stringify(updated ? provenance : prior.provenance), updated ? at : prior.updated);
        }
        for (const key of derivedChanged) for (const dependent of dependents([key], fullGraph)) {
          if (!derivedKeys.includes(dependent) && !changed.includes(dependent)) {
            this.db.prepare('UPDATE project_fields SET stale=? WHERE project=? AND key=? AND stale IS NULL').run(key, project, dependent);
          }
        }
      }
      if (changed.length || refreshed.size) {
        const property = changed.includes('property') ? this.property(project) : null;
        const bbl = property?.bbl != null ? String(property.bbl) : null;
        const model = property && this.db.prepare('SELECT 1 FROM modeling_projects WHERE project=?').get(project);
        this.db.prepare('UPDATE projects SET version=version+1,updated=?,site_key=COALESCE(?,site_key),bbl=COALESCE(?,bbl),title=COALESCE(?,title) WHERE id=?').run(at, bbl, bbl, model ? null : property?.address || null, project);
      }
      this.db.exec('RELEASE project_write');
    } catch (error) {
      this.db.exec('ROLLBACK TO project_write; RELEASE project_write');
      throw error;
    }
    return [...new Set([...changed, ...refreshed])];
  }
  // Saves one scheme's plan, budget or render part (null clears it), keeping the field's freshness.
  setSchemePart(project, schemeId, part, value, at = Date.now()) {
    if (!SCHEME_IDS.includes(schemeId)) throw bad(`${schemeId} is not a scheme; use one of ${SCHEME_IDS.join(', ')}.`);
    if (!SCHEME_PARTS.includes(part)) throw bad(`${part} is not a scheme part; use one of ${SCHEME_PARTS.join(', ')}.`);
    const field = this.read(project).schemes;
    if (!field) throw Object.assign(new Error('This site has no schemes yet.'), {status: 409});
    const schemes = field.value.schemes.map(s => (s.id === schemeId ? {...s, [part]: value ?? null} : s));
    const changed = this.write(project, {schemes: {value: {...field.value, schemes}, provenance: field.provenance}}, at);
    if (field.stale) this.db.prepare('UPDATE project_fields SET stale=? WHERE project=? AND key=?').run(field.stale, project, 'schemes');
    return changed;
  }
  // Folds one project's fields into another for the same site without losing a value. Per field the newer
  // current value wins, a user edit dated by its edit time; accumulating lists merge entry by entry, the
  // newer side's entry winning a collision. The joining site's fields and every target value replaced
  // are archived with the target. write() then marks the target's dependents of what changed stale.
  mergeFields(source, target, at = Date.now()) {
    const from = this.read(source), into = this.read(target), fields = {}, importedStale = new Map();
    const when = field => (field.provenance?.tool === 'user' && field.provenance.at ? Date.parse(field.provenance.at) : field.updated);
    for (const [key, field] of Object.entries(from)) {
      const mine = into[key];
      if (field.stale != null) {
        // A stale derived output stays archived only, but a newer stale USER edit is still that
        // user's latest instruction. Carry it live and preserve why it was stale rather than
        // silently reverting to an older fresh value on the surviving site.
        if (field.provenance?.tool !== 'user' || canonical(field.value) === canonical(mine?.value) || (mine && when(field) <= when(mine))) continue;
        if (accumulating.has(key) && Array.isArray(field.value) && Array.isArray(mine?.value)) {
          const merged = mergeEntries(mine, field);
          if (canonical(merged.value) !== canonical(mine.value)) { fields[key] = merged; importedStale.set(key, field.stale); }
        } else { fields[key] = {value: field.value, provenance: field.provenance}; importedStale.set(key, field.stale); }
        continue;
      }
      if (mine?.stale == null && canonical(field.value) === canonical(mine?.value)) continue;
      if (accumulating.has(key) && Array.isArray(field.value) && Array.isArray(mine?.value)) {
        const merged = when(field) > when(mine) ? mergeEntries(mine, field) : mergeEntries(field, mine);
        if (canonical(merged.value) !== canonical(mine.value)) fields[key] = merged;
      } else if (!mine || when(field) > when(mine)) fields[key] = {value: field.value, provenance: field.provenance};
    }
    const archive = this.db.prepare('INSERT INTO project_field_archive(project,from_project,key,value,provenance,stale,updated,archived) VALUES(?,?,?,?,?,?,?,?)');
    const keep = (from, key, f) => archive.run(target, from, key, JSON.stringify(f.value), JSON.stringify(f.provenance), f.stale ?? null, f.updated, at);
    for (const [key, f] of Object.entries(from)) keep(source, key, f);
    for (const key of Object.keys(fields)) if (into[key]) keep(target, key, into[key]);
    if (!Object.keys(fields).length) return [];
    const changed = this.write(target, fields, at);
    for (const [key, stale] of importedStale) if (fields[key]) this.db.prepare('UPDATE project_fields SET stale=? WHERE project=? AND key=?').run(stale, target, key);
    // An imported field derived from the other site's inputs is not current just for arriving:
    // where one of its inputs holds a different value here, mark it stale on that input.
    const after = this.read(target);
    for (const key of Object.keys(fields)) {
      const dep = (fullGraph[key]?.dependsOn ?? []).find(name => canonical(from[name]?.value) !== canonical(after[name]?.value));
      if (dep) this.db.prepare('UPDATE project_fields SET stale=? WHERE project=? AND key=? AND stale IS NULL').run(dep, target, key);
    }
    return changed;
  }
  // Every conversation belongs to a project. Conversations from before projects each get one
  // (keyed by the property's BBL, else by the conversation id) and their fields move over.
  attachConversations() {
    if (!columns(this.db, 'conversations').includes('project')) this.db.exec('ALTER TABLE conversations ADD COLUMN project TEXT; CREATE INDEX IF NOT EXISTS conversation_project ON conversations(project);');
    const legacy = columns(this.db, 'project_fields').includes('conversation');
    const orphans = this.db.prepare('SELECT * FROM conversations WHERE project IS NULL').all();
    if (!legacy && !orphans.length) return;
    this.db.exec('BEGIN');
    try {
      for (const c of orphans) {
        const field = legacy ? this.db.prepare("SELECT value FROM project_fields WHERE conversation=? AND key='property'").get(c.id) : null;
        const property = field ? JSON.parse(field.value) : c.property ? JSON.parse(c.property) : null;
        const bbl = property?.bbl != null ? String(property.bbl) : null;
        const id = this.create(c.owner, bbl ?? c.id, property?.address || c.title, c.created, bbl);
        this.db.prepare('UPDATE projects SET updated=? WHERE id=?').run(c.updated, id);
        this.db.prepare('UPDATE conversations SET project=? WHERE id=?').run(id, c.id);
      }
      if (legacy) {
        this.db.exec(`ALTER TABLE project_fields RENAME TO project_fields_legacy; ${FIELDS_DDL}
          INSERT INTO project_fields SELECT c.project,f.key,f.value,f.provenance,f.stale,f.updated FROM project_fields_legacy f JOIN conversations c ON c.id=f.conversation;
          DROP TABLE project_fields_legacy;`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  projectOf(conversation) { return this.db.prepare('SELECT project FROM conversations WHERE id=?').get(conversation)?.project ?? null; }
  // One-time backfill from the runs and properties persisted before the state existed.
  migrate() {
    this.attachConversations();
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 1) return;
    this.db.exec('BEGIN');
    try {
      for (const run of this.db.prepare("SELECT id,conversation,result,updated FROM runs WHERE status='completed' AND result IS NOT NULL ORDER BY created").all()) {
        const fields = fieldsFromResult(JSON.parse(run.result), run.id);
        if (Object.keys(fields).length) this.write(this.projectOf(run.conversation), fields, run.updated);
      }
      for (const c of this.db.prepare("SELECT project,property,updated FROM conversations WHERE property IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project_fields WHERE project=conversations.project AND key='property')").all()) {
        this.write(c.project, {property: {value: JSON.parse(c.property), provenance: {tool: graph.property.tool, migrated: true, sources: []}}}, c.updated);
      }
      this.db.exec('PRAGMA user_version=1; COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
