// One synchronous admission boundary for durable and legacy research requests.
// Tune RESEARCH_CONCURRENCY to the capacity of the host and model provider.
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
