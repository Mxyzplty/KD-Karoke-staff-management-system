// SPDX-License-Identifier: AGPL-3.0-only
// Follows the open project's document for the agent link: which snapshot parts changed (the resource notification) and
// whether the user made the change (the stale-read gate). Every change that does not happen inside an agent call is a user
// change: UI edits, Undo / Redo, a reload or keep-mine that replaces the document, a restored checkpoint (a new runtime).
import type { ProjectDocument } from '../store/model';
import { SNAPSHOT_KEYS } from '../timeline/bus';
import { activeRuntime } from '../timeline/runtime';
import type { Runtime } from '../timeline/runtime';

export type Change = { parts: string[]; user: boolean; at: number };
/** How often the watcher looks for a new runtime (project opened or reopened, checkpoint restored). Short, because the
 *  first runtime it finds becomes the baseline: a user edit made before then would never be reported. */
export const RUNTIME_POLL_MS = 50;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export class Watcher {
  private runtime?: Runtime;
  private off?: () => void;
  private seen?: ProjectDocument;
  private agent = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private onChange: (change: Change, before: ProjectDocument, after: ProjectDocument) => void, private current: () => Runtime | undefined = () => activeRuntime) {}
  start() { this.sync(); this.timer ??= setInterval(() => this.sync(), RUNTIME_POLL_MS); }
  stop() { clearInterval(this.timer); this.timer = undefined; this.off?.(); this.off = undefined; this.runtime = undefined; }
  /** The open project's runtime; follows a replaced one and reports what differs from the last document seen. */
  sync(): Runtime | undefined {
    const runtime = this.current();
    if (runtime !== this.runtime) {
      this.off?.();
      this.runtime = runtime;
      this.off = runtime?.bus.subscribe(() => this.check());
      this.check();
    }
    return runtime;
  }
  /** Runs one agent tool call: the changes it makes are agent changes. */
  asAgent<T>(fn: () => T): T {
    this.agent++;
    try { return fn(); } finally { this.check(); this.agent--; }
  }
  private check() {
    const doc = this.runtime?.bus.doc;
    if (!doc || doc === this.seen) return;
    const before = this.seen;
    this.seen = doc;
    if (!before) return;
    const parts = SNAPSHOT_KEYS.filter(k => !same(before[k], doc[k]));
    if (parts.length) this.onChange({ parts, user: this.agent === 0, at: Date.now() }, before, doc);
  }
}
