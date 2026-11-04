// One synchronous admission boundary for durable and legacy research requests. Six runs at once:
// measured on openclaw-builder (4 vCPU, 16 GB) a run holds about 450 MB (its Codex harness plus
// research state) and little CPU, since the model works remotely, and the subscription's weekly
// window stood at 1% used; six leave the host over 5 GB free. Further requests wait in the queue.
// RESEARCH_CONCURRENCY in the service secrets overrides the six.
export const researchSlots = secrets => Number(secrets?.RESEARCH_CONCURRENCY) || 6;

export class ResearchAdmission {
  constructor(limit = 6) { this.limit = limit; this.active = 0; this.onAvailable = () => {}; }
  acquire() {
    if (this.closed || this.active >= this.limit) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.onAvailable();
    };
  }
  close() { this.closed = true; }
}
