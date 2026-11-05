// SPDX-License-Identifier: AGPL-3.0-only
export const MAX_FRAME_CACHE_BYTES = 64 * 1024 * 1024;
export class FrameCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>(); private bytes = 0;
  readonly maxBytes: number;
  constructor(maxBytes = MAX_FRAME_CACHE_BYTES) { this.maxBytes = Math.min(MAX_FRAME_CACHE_BYTES, Math.max(0, maxBytes)); }
  get stats() { return { bytes: this.bytes, entries: this.entries.size }; }
  get(key: string): T | undefined { return this.entries.get(key)?.value; }
  set(key: string, value: T, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid frame cache byte size');
    const old = this.entries.get(key); if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes) { const key = this.entries.keys().next().value!; this.bytes -= this.entries.get(key)!.bytes; this.entries.delete(key); }
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
