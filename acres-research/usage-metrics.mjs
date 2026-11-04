// Agent usage updates (Codex, Meta) are cumulative within one agent invocation, not billable deltas.
// Legacy events without a stream identity cannot safely be added across concurrent agents.
const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens'];
const zero = () => Object.fromEntries(fields.map(key => [key, 0]));

export function aggregateUsageEvents(events = []) {
  const streams = new Map(), expected = new Set(),outcomes=new Map(),reasoning=new Map();
  let samples = 0, unattributedSamples = 0, invalidSamples = 0;
  for (const raw of events) {
    const event = raw.event ?? raw.e;
    const data = raw.d ?? raw;
    if (event === 'billing.agent.started' && data.usageStreamId) expected.add(data.usageStreamId);
    if (event === 'billing.agent.completed' && data.usageStreamId) {expected.add(data.usageStreamId);outcomes.set(data.usageStreamId,data.outcome);}
    if (event !== 'billing.usage') continue;
    samples++;
    const id = data.usageStreamId;
    if (!id || data.usageSemantics !== 'cumulative') { unattributedSamples++; continue; }
    expected.add(id);
    const usage = data.usage;
    if (!usage || fields.some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0)
      || usage.cachedInputTokens > usage.inputTokens) { invalidSamples++; continue; }
    const old = streams.get(id);
    if (old && fields.some(key => usage[key] < old[key])) { invalidSamples++; continue; }
    streams.set(id, Object.fromEntries(fields.map(key => [key, usage[key]])));
    if(Number.isSafeInteger(usage.reasoningOutputTokens)&&usage.reasoningOutputTokens>=0&&usage.reasoningOutputTokens>=(reasoning.get(id)??0))reasoning.set(id,usage.reasoningOutputTokens);
    else reasoning.delete(id);
  }
  const knownTotals = zero();
  for (const usage of streams.values()) for (const key of fields) knownTotals[key] += usage[key];
  const missingStreams = [...expected].filter(id => !streams.has(id));
  const unfinishedStreams=[...expected].filter(id=>outcomes.get(id)!=='completed');
  const complete = samples > 0 && !unattributedSamples && !invalidSamples && !missingStreams.length&&!unfinishedStreams.length;
  const knownReasoningOutputTokens=[...reasoning.values()].reduce((sum,value)=>sum+value,0);
  return {
    ...Object.fromEntries(fields.map(key => [key, complete ? knownTotals[key] : null])),
    status: complete ? 'complete' : samples ? 'partial' : 'unavailable',
    knownTotals, samples, streams: streams.size, missingStreams: missingStreams.length,
    unattributedSamples, invalidSamples,unfinishedStreams:unfinishedStreams.length,
    reasoningOutputTokens:complete&&reasoning.size===expected.size?knownReasoningOutputTokens:null,
    knownReasoningOutputTokens,reasoningStreams:reasoning.size,
  };
}

export function summarizeUsage(measurements = []) {
  const totals = zero();
  for (const measurement of measurements) {
    const known = measurement?.knownTotals ?? (measurement?.status === 'complete' ? measurement : null);
    if (known) for (const key of fields) totals[key] += known[key] ?? 0;
  }
  const completeRuns = measurements.filter(value => value?.status === 'complete').length;
  const complete = measurements.length > 0 && completeRuns === measurements.length;
  const knownReasoningOutputTokens=measurements.reduce((sum,m)=>sum+(m?.knownReasoningOutputTokens??m?.reasoningOutputTokens??0),0);
  return {
    ...Object.fromEntries(fields.map(key => [key, complete ? totals[key] : null])),
    knownTotals: totals, completeRuns, totalRuns: measurements.length,
    status: complete ? 'complete' : completeRuns || measurements.some(m => m?.status==='partial'||m?.samples) ? 'partial' : 'unavailable',
    cacheHitPct: complete && totals.inputTokens > 0 ? Math.round(totals.cachedInputTokens / totals.inputTokens * 1000) / 10 : null,
    reasoningOutputTokens:complete&&measurements.every(m=>Number.isSafeInteger(m?.reasoningOutputTokens))?knownReasoningOutputTokens:null,knownReasoningOutputTokens,
  };
}
