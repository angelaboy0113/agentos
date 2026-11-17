// UI activity is replaceable; source grants, evidence and terminal events are not.
// Keep at most one display update in flight and one latest pending update per job.
const displayKeys = new Set(['type', 'phase', 'elapsedSeconds', 'executionEngine', 'activity', 'message']);
export function isDisplayProgress(event) {
  return event?.type === 'progress'
    && ['codex_working', 'tool_activity'].includes(event.phase)
    && Object.keys(event).every(key => displayKeys.has(key));
}

export class ProgressPublisher {
  constructor(send, {intervalMs = 1000, onDisplayError = () => {}} = {}) {
    this.send = send;
    this.intervalMs = intervalMs;
    this.onDisplayError = onDisplayError;
    this.pending = null;
    this.inFlight = null;
    this.timer = null;
    this.closed = false;
    this.lastStarted = -Infinity;
  }

  async emit(event) {
    if (isDisplayProgress(event)) {
      if (!this.closed) {
        const next = structuredClone(event);
        // A heartbeat-like model pulse cannot erase a newer unsent tool counter.
        this.pending = this.pending?.phase === 'tool_activity' && next.phase === 'codex_working'
          ? {...this.pending, ...next, phase: 'tool_activity', activity: this.pending.activity}
          : next;
        this.schedule();
      }
      return {bufferedDisplay: true};
    }
    if (this.closed) throw new Error('Progress publisher is closed');
    await this.flush();
    return this.send(event); // Preserve acknowledgement and errors for every durable event.
  }

  schedule() {
    if (this.inFlight || this.timer || !this.pending || this.closed) return;
    const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastStarted));
    if (!wait) this.start();
    else {
      this.timer = setTimeout(() => { this.timer = null; this.start(); }, wait);
      this.timer.unref?.();
    }
  }

  start() {
    if (this.inFlight || !this.pending) return;
    const event = this.pending;
    this.pending = null;
    this.lastStarted = Date.now();
    this.inFlight = Promise.resolve().then(() => this.send(event)).catch(error => {
      // Display failure must not replay a query or discard the eventual result.
      try { this.onDisplayError(error); } catch { /* Diagnostics cannot fail execution. */ }
    }).finally(() => { this.inFlight = null; this.schedule(); });
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    while (this.inFlight || this.pending) {
      if (!this.inFlight) this.start();
      await this.inFlight;
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async close() {
    this.closed = true;
    await this.flush();
  }
}
