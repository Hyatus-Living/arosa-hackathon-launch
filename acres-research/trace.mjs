import {mkdirSync, appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

const usageCountFields = new Set(['inputTokens','cachedInputTokens','outputTokens','totalTokens','reasoningOutputTokens']);

export function safeTrace(value) {
  if (typeof value === 'string') return value.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted]').slice(0,24000);
  if (Array.isArray(value)) return value.slice(0,50).map(safeTrace);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key,item])=>usageCountFields.has(key) ? Number.isSafeInteger(item)&&item>=0 : !/(token|secret|password|authorization|api.?key|cookie|reasoning)/i.test(key)).map(([key,item])=>[key,safeTrace(item)]));
  return value;
}

export function createTrace(input, root='/home/openclaw/.openclaw/acres-state/traces') {
  mkdirSync(root,{recursive:true,mode:0o700});
  const id=randomUUID(), path=join(root,`${id}.jsonl`);
  const emit=(event,data={})=>appendFileSync(path,JSON.stringify({traceId:id,time:new Date().toISOString(),event,...safeTrace(data)})+'\n',{mode:0o600});
  emit('request.received',{input});
  return {id,path,emit};
}

export function appendRunTraceEvent(traceDir, runId, record) {
  if (!traceDir || !runId || !record || record.event === 'message.delta') return null;
  try {
    mkdirSync(traceDir, {recursive: true, mode: 0o700});
    const path = join(traceDir, `${runId}.jsonl`);
    const line = JSON.stringify({
      traceId: runId,
      isoTime: new Date(record.time || Date.now()).toISOString(),
      ...record,
    }) + '\n';
    appendFileSync(path, line, {mode: 0o600});
    return path;
  } catch {
    return null;
  }
}
