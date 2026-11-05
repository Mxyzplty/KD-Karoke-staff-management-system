// SPDX-License-Identifier: AGPL-3.0-only
// Edit journal (findings §4, part 3 §45.2): one record per new undo entry plus "Undo" / "Redo" records, with item counts.
// Queued in memory (cap 1000), flushed 4 s after the first queued record, at 30 records, and on tab hide / pagehide.
// Analytics and audit only: a failed flush is reported at most once a minute and never blocks editing.
import type { JournalInput } from './bus';

export type JournalRecord = JournalInput & { project_id: string; session_id: string; seq: number; client_ts: string };
export type JournalSink = (records: JournalRecord[]) => Promise<void>;
type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void; now: () => number };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() };
/** One id per page load (W3-RT-15); seq counts up within it. */
export const pageSessionId = `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
export const FLUSH_MS = 4000, FLUSH_COUNT = 30, QUEUE_CAP = 1000;

export class EditJournal {
  queue: JournalRecord[] = [];
  private seq = 0;
  private timer: unknown;
  private lastError = -Infinity;
  constructor(public projectId: string, private sink: JournalSink, public sessionId = pageSessionId, private timers: Timers = realTimers, private onError?: (e: unknown) => void) {}
  record(input: JournalInput) {
    this.queue.push({ project_id: this.projectId, session_id: this.sessionId, ...input, seq: ++this.seq, client_ts: new Date(this.timers.now()).toISOString() });
    if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP);
    if (this.queue.length >= FLUSH_COUNT) void this.flush();
    else if (this.timer === undefined) this.timer = this.timers.set(() => { this.timer = undefined; void this.flush(); }, FLUSH_MS);
  }
  async flush() {
    if (this.timer !== undefined) { this.timers.clear(this.timer); this.timer = undefined; }
    if (!this.queue.length) return;
    const batch = this.queue.splice(0);
    try { await this.sink(batch); } catch (e) {
      if (this.timers.now() - this.lastError >= 60000) { this.lastError = this.timers.now(); this.onError?.(e); }
    }
  }
  bindLifecycle(targetDocument: Document = document, targetWindow: Window = window) {
    const hide = () => { if (targetDocument.visibilityState === 'hidden') void this.flush(); };
    const leave = () => { void this.flush(); };
    targetDocument.addEventListener('visibilitychange', hide); targetWindow.addEventListener('pagehide', leave);
    return () => { targetDocument.removeEventListener('visibilitychange', hide); targetWindow.removeEventListener('pagehide', leave); };
  }
}
