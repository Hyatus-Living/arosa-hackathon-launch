// Three ways to build a site, picked from the buildings the deal valuation weighed: the best one
// on standard floor area alone, the largest one that uses the affordability bonus, 485-x or city financing (the best
// of those that build as much), and the best remaining one that differs from each of them in exit or in kind of program. Every number comes from the valuation;
// the plan, budget and render parts are filled by their own features through setSchemePart.
import {MIH_RULES} from './mih-areas.mjs';

export const SCHEME_IDS = ['as_of_right', 'max_bonus', 'alternative'];
// The parts other features fill in, each null until drawn.
export const SCHEME_PARTS = ['plan', 'budget', 'render'];
const LABELS = {as_of_right: 'As of right', max_bonus: 'Most floor area', alternative: 'Alternative'};

// The MIH small-project building is held under the exemption's thresholds, so it is never the most floor area.
const bonusOf = c => c.key !== 'mih_exempt' && (c.key === 'uap' || c.taxProgram !== null);
// The kind of program a building is built under. The mapped MIH options are one kind (the same building
// with another set-aside), and a 485-x election or a 99-unit cap is the same kind as the building
// without it; city financing (every unit affordable) and the small-project exemption are kinds of their own.
const programKind = c => `${MIH_RULES.options[c.key] ? 'mih' : c.key}:${c.taxProgram?.kind === 'city-financed' ? 'city' : 'market'}`;
const PICKS = {
  as_of_right: c => !bonusOf(c),
  max_bonus: bonusOf,
  alternative: (c, chosen) => chosen.every(o => o.exit !== c.exit || programKind(o) !== programKind(c)),
};
// Why a scheme is empty, and why the alternative is not a different kind of building.
const EMPTY_NOTES = {
  as_of_right: 'Every building priced here uses a bonus or tax program.',
  max_bonus: 'No affordability bonus, 485-x or city-financed building fits this lot.',
  alternative: 'No other residential building fits this lot.',
};
// The fallback alternative is the next best building, which repeats the kind of an option above it.
const nextBestNote = (pick, chosen) => {
  const same = chosen.find(o => o.c.exit === pick.exit && programKind(o.c) === programKind(pick)) ?? chosen.find(o => programKind(o.c) === programKind(pick)) ?? chosen[0];
  return `No other kind of building fits this lot, so this is the ${LABELS[same.id]} building priced another way.`;
};
// Why a small building is drawn on a large MIH lot: it stays under the exemption's thresholds.
const exemptNote = `Kept to ${MIH_RULES.smallProject.maxResidentialSqft.toLocaleString('en-US')} SF and ${MIH_RULES.smallProject.maxUnits} units to stay under the MIH threshold, so no affordable set-aside applies. The exemption holds only on a zoning lot that existed when the MIH area was mapped.`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const sf = n => Math.round(n).toLocaleString('en-US');
const money = n => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`);
const pct = n => Math.round(n * 100);
// The share of a building's floor area held affordable, in words: "44% affordable at 60% AMI on average".
// A condo's affordable floor area is held as rentals (most affordable homes in new buildings are rented), so
// it says so. A city-financed building says it in its program (every unit affordable), so it has no share line.
const affordableShare = c => (c.affordableZfa > 0 && c.taxProgram?.kind !== 'city-financed'
  ? `${pct(c.affordableZfa / c.zfa)}% affordable${c.exit === 'condo' ? ' rentals' : ''}${c.affordableAmiPct ? ` at ${c.affordableAmiPct}% AMI on average` : ''}` : null);
// The program in plain words: "Rental with the affordability bonus and 485-x Option B, held to 99 units", or
// "Rental with city financing, every unit affordable at 54% AMI on average".
export function describeProgram(c) {
  const with_ = [
    c.key === 'uap' ? 'the affordability bonus' : c.key === 'mih_exempt' ? 'the MIH small-project exemption' : MIH_RULES.options[c.key] ? `MIH ${MIH_RULES.options[c.key].label}` : null,
    c.taxProgram?.kind === 'city-financed' ? 'city financing' : c.taxProgram ? `485-x Option ${c.taxProgram.option}` : null,
  ].filter(Boolean);
  const terms = c.taxProgram?.kind === 'city-financed' ? `, every unit affordable at ${c.taxProgram.amiPct}% AMI on average` : c.taxProgram?.cappedAt99 ? ', held to 99 units' : '';
  return `${c.exit === 'condo' ? 'Condo' : 'Rental'}${with_.length ? ` with ${with_.join(' and ')}` : ''}${terms}`;
}

const programOf = c => ({
  key: c.key, exit: c.exit, zfa: c.zfa, grossSqft: c.grossSqft, storeys: c.storeys, units: c.units, unitMix: c.unitMix,
  affordableZfa: c.affordableZfa, affordableAmiPct: c.affordableAmiPct ?? null, affordableRentPsf: c.affordableRentPsf ?? null, taxProgram: c.taxProgram,
});
// Parts drawn for a scheme stay with it while the building is the same one.
const sameBuilding = (a, b) => a && b && a.key === b.key && a.exit === b.exit && a.zfa === b.zfa && a.storeys === b.storeys
  && canonicalTax(a.taxProgram) === canonicalTax(b.taxProgram);
const canonicalTax = t => (t ? `${t.kind}:${t.option}:${t.cappedAt99}` : '');
const taxKind = c => c.taxProgram?.kind ?? null;

// The modeled concept closest to the scheme's floor area and storeys, within 15% and one storey.
function matchConcept(program, concepts, taken) {
  let best = null;
  for (const concept of concepts || []) {
    const id = concept.id ?? concept.name;
    const area = concept.metrics?.grossFloorAreaSqft, storeys = concept.metrics?.storeys;
    if (!id || taken.has(id) || !(area > 0) || !(storeys > 0)) continue;
    const areaGap = Math.abs(area - program.zfa) / program.zfa, storeyGap = Math.abs(storeys - program.storeys);
    if (areaGap > 0.15 || storeyGap > 1) continue;
    const score = areaGap + storeyGap / Math.max(1, program.storeys);
    if (!best || score < best.score) best = {id, score};
  }
  return best ? {conceptId: best.id, source: 'concept'} : null;
}

// Why the building that pays the most for the land is the one to build, against the drawn building with
// the most floor area held affordable: either that affordable area earns less than it costs to build, or it
// pays for itself. Nothing to say when no drawn building holds affordable floor area, or when even the
// lead pays nothing for the land. The bonus is measured against the same building without it (same exit
// and tax program): the lead, or another drawn building. Without one, the gap is not the bonus's alone.
function recommendedReason(drawn) {
  const lead = drawn.find(o => o.c.leads);
  if (!(lead?.c.returns.landValue > 0)) return null;
  const other = drawn.filter(o => o !== lead && o.c.affordableZfa > 0 && o.c.zfa > lead.c.zfa).sort((a, b) => b.c.zfa - a.c.zfa)[0];
  if (other) {
    const gap = money(lead.c.returns.landValue - other.c.returns.landValue);
    const more = `Pays ${gap} more for the land than the ${LABELS[other.id]} building`;
    const ami = other.c.affordableAmiPct ? ` at ${other.c.affordableAmiPct}% AMI on average` : '';
    if (other.c.key !== 'uap') return `${more}, where ${pct(other.c.affordableZfa / other.c.zfa)}% of the floor area is affordable${ami} and earns less than it costs to build.`;
    const base = drawn.find(o => o.c.key === 'standard' && o.c.exit === other.c.exit && taxKind(o.c) === taxKind(other.c));
    if (base === lead) return `Most new buildings skip the bonus: here it adds ${sf(other.c.zfa - lead.c.zfa)} SF that must all be affordable${ami} and earns less than it costs to build, so this building pays ${gap} more for the land than the ${LABELS[other.id]} building.`;
    if (!(base?.c.returns.landValue > other.c.returns.landValue)) return `${more}.`;
    return `Most new buildings skip the bonus: the ${LABELS[other.id]} building is the ${LABELS[base.id]} building with it, ${sf(other.c.zfa - base.c.zfa)} SF larger and paying ${money(base.c.returns.landValue - other.c.returns.landValue)} less for the land. This building pays ${gap} more for the land than the ${LABELS[other.id]} building.`;
  }
  const plain = drawn.filter(o => o !== lead && !(o.c.affordableZfa > 0) && o.c.zfa < lead.c.zfa).sort((a, b) => b.c.returns.landValue - a.c.returns.landValue)[0];
  if (!(lead.c.affordableZfa > 0) || !plain) return null;
  const more = `${money(lead.c.returns.landValue - plain.c.returns.landValue)} more for the land than the ${LABELS[plain.id]} building`;
  if (lead.c.taxProgram?.kind === 'city-financed') return `City loans and tax credit equity cover the cost of making every unit affordable at ${lead.c.taxProgram.amiPct}% AMI on average, so this building pays ${more}.`;
  return lead.c.key === 'uap' ? `The bonus pays for itself here: ${more}, with ${affordableShare(lead.c)}.` : `Pays ${more}, with ${affordableShare(lead.c)}.`;
}

// The three schemes from a valuation's candidates (most land first). prior is the stored list, whose
// plan, budget and render parts carry over to a scheme that is still the same building.
export function buildSchemes({candidates = [], concepts = [], prior = []} = {}) {
  // The three site schemes are residential buildings; a priced commercial candidate competes for the
  // land value in the valuation but is not drawn as a site scheme yet.
  candidates = candidates.filter(c => c.key !== 'commercial');
  const used = new Set(), chosen = [], taken = new Set();
  const schemes = SCHEME_IDS.map(id => {
    const fits = candidates.filter(c => !used.has(c.id));
    // Only the alternative falls back to the next best building; the other two are a kind of building.
    // Most floor area is the largest building of its kind, so a smaller one never takes its name.
    const kind = fits.filter(c => PICKS[id](c, chosen.map(o => o.c)));
    const pick = (id === 'max_bonus' ? kind.reduce((a, c) => (c.zfa > a.zfa ? c : a), kind[0]) : kind[0]) ?? (id === 'alternative' ? fits[0] : null) ?? null;
    const before = prior.find(s => s.id === id);
    if (!pick) {
      const note = candidates.length ? EMPTY_NOTES[id] : 'No residential building fits this lot.';
      return {id, label: LABELS[id], candidateId: null, summary: note, best: false, reason: null, note, program: null, returns: null, massing: null, plan: null, budget: null, render: null};
    }
    used.add(pick.id);
    const nextBest = !PICKS[id](pick, chosen.map(o => o.c));
    const note = [nextBest ? nextBestNote(pick, chosen) : null, pick.key === 'mih_exempt' ? exemptNote : null].filter(Boolean).join(' ') || null;
    chosen.push({id, c: pick});
    const program = programOf(pick);
    const keep = sameBuilding(before?.program, program);
    const massing = matchConcept(program, concepts, taken);
    if (massing) taken.add(massing.conceptId);
    return {
      id, label: LABELS[id], candidateId: pick.id,
      summary: [describeProgram(pick), `${sf(pick.zfa)} SF`, plural(pick.storeys, 'storey'), plural(pick.units, 'unit'), affordableShare(pick)].filter(Boolean).join(', '),
      best: pick.leads,
      reason: null,
      note,
      program,
      returns: pick.returns,
      massing,
      plan: keep ? before.plan ?? null : null,
      budget: keep ? before.budget ?? null : null,
      render: keep ? before.render ?? null : null,
    };
  });
  // The building to build is the one that pays the most for the land; it says why in one sentence.
  const reason = recommendedReason(chosen);
  return reason ? schemes.map(s => (s.best ? {...s, reason} : s)) : schemes;
}

// The public page that explains how the three options are chosen and priced; a brief citing their figures
// points a reader there, since the figures themselves are Arosa's own computation.
export const THREE_OPTIONS_METHOD_URL = 'https://witharosa.ai/help/three-options';

// The site page's three options and the figures its deal tier rests on, compact for a research brief:
// each option's program, exit, floor area, units and land value, with the note that says why an option is
// not the kind its label names; what nearby development sites sold for; and the tier with its basis.
// lot is MarketStore.lotValuation; schemes are buildSchemes of its candidates.
export function dealValuationBrief(lot, schemes = buildSchemes({candidates: lot.valuation.candidates})) {
  const v = lot.valuation, near = lot.nearbyLand;
  return {
    source: lot.source, ask: lot.ask, askFrom: lot.askFrom,
    options: schemes.map(s => ({
      id: s.id, label: s.label, best: s.best, summary: s.summary, exit: s.program?.exit ?? null, zfa: s.program?.zfa ?? null,
      units: s.program?.units ?? null, landValue: s.returns?.landValue ?? null, ...(s.reason ? {reason: s.reason} : {}),
      ...(s.note && s.note !== s.summary ? {note: s.note} : {}),
    })),
    nearbyLand: near ? {value: near.value, perBuildableSqft: near.perBuildableSqft, sales: near.sales, radiusMiles: near.radiusMiles, months: near.months, asOf: near.asOf} : null,
    tier: {dealVerdict: v.dealVerdict ?? null, priceVerdict: v.priceVerdict ?? null, basis: v.dealTierBasis?.basis ?? null, askToNearby: v.dealTierBasis?.askToNearby ?? null},
  };
}

// What an option link shows (store.createOptionLink): one scheme frozen as it stood when it was sent,
// with the files a viewer may open (the plan drawing, the architect's package by artifact kind and the
// rendering stills) and the modeled shape.
export function optionSnapshot({scheme, basis, concepts = [], site, sender, at}) {
  const concept = scheme.massing && concepts.find(c => (c.id ?? c.name) === scheme.massing.conceptId);
  const levels = (concept?.units !== 'm' && concept?.levels || []).filter(l => l.footprint?.length > 2 && l.height > 0);
  return {
    at, site, sender,
    scheme: {id: scheme.id, label: scheme.label, summary: scheme.summary, note: scheme.note, program: scheme.program, returns: scheme.returns, budget: scheme.budget},
    basis: basis ? {askFrom: basis.askFrom, ask: basis.ask} : null,
    plan: scheme.plan?.svg ? {revision: scheme.plan.revision, artifactId: scheme.plan.svg, files: scheme.plan.files ?? {}} : null,
    renders: scheme.render?.status === 'succeeded' ? scheme.render.views.map(v => ({view: v.view, artifactId: v.artifactId})) : [],
    massing: levels.length ? {lot: concept.lot ?? null, levels: levels.map(l => ({footprint: l.footprint, height: l.height, count: l.count ?? 1}))} : null,
  };
}
export const optionFiles = snapshot => [snapshot.plan?.artifactId, ...Object.values(snapshot.plan?.files ?? {}), ...snapshot.renders.map(r => r.artifactId)].filter(Boolean);
