// SPDX-License-Identifier: AGPL-3.0-only
// Execution-key ledger (agent tool results A0.2 item 1): the last 250 calls, in memory and in this tab's session storage,
// so a duplicated delivery of one call (helper re-send after a reconnect, a retried MCP request) applies once.
import type { ToolResult } from './protocol';

export const LEDGER_KEY = 'cutframe:tool-execution-ledger:v1';
export const LEDGER_SIZE = 250;
export const KEY_COLLISION: ToolResult = { success: false, code: 'TOOL_EXECUTION_KEY_COLLISION', error: 'This tool execution key was already used for different input, so the operation was not run.' };
export const STATE_UNKNOWN: ToolResult = { success: false, code: 'TOOL_EXECUTION_STATE_UNKNOWN', error: 'This operation started previously but its result was not recorded. It was not repeated to avoid a duplicate edit.' };

type Entry = { key: string; tool: string; fingerprint: string; result?: ToolResult };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

/** JSON with object keys sorted at every level (the input fingerprint). */
export function fingerprint(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(value ?? {}));
}

export class Ledger {
  private entries: Entry[];
  private running = new Map<string, Promise<ToolResult>>();
  constructor(private storage: Storage | undefined = globalThis.sessionStorage) {
    let stored: unknown = [];
    try { stored = JSON.parse(this.storage?.getItem(LEDGER_KEY) ?? '[]'); } catch { /* unreadable: start empty */ }
    this.entries = Array.isArray(stored) ? stored.filter((e: Entry) => typeof e?.key === 'string' && typeof e.fingerprint === 'string').slice(-LEDGER_SIZE) : [];
  }
  private save() { try { this.storage?.setItem(LEDGER_KEY, JSON.stringify(this.entries)); } catch { /* full or blocked: memory only */ } }
  private put(entry: Entry) {
    this.entries = [...this.entries.filter(e => e.key !== entry.key), entry].slice(-LEDGER_SIZE);
    this.save();
  }
  /** Runs `exec` once per execution key. A completed key with the same tool and input returns its stored result; a key
   *  still running in this page shares the first run; a key that started before a reload but has no result is not run. */
  run(key: string, tool: string, input: unknown, exec: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
    const fp = fingerprint(input), seen = this.entries.find(e => e.key === key);
    if (seen) {
      if (seen.tool !== tool || seen.fingerprint !== fp) return Promise.resolve(KEY_COLLISION);
      if (seen.result) return Promise.resolve(seen.result);
      return this.running.get(key) ?? Promise.resolve(STATE_UNKNOWN);
    }
    this.put({ key, tool, fingerprint: fp });
    const done = (async () => {
      try { const result = await exec(); this.put({ key, tool, fingerprint: fp, result }); return result; } finally { this.running.delete(key); }
    })();
    this.running.set(key, done);
    return done;
  }
}
