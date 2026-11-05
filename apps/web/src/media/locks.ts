// SPDX-License-Identifier: AGPL-3.0-only
// Cross-tab exclusive locks (Web Locks API). A lock held by any tab means "this upload or preparation is alive".
// Without the API (Node tests) an in-process FIFO mutex per name stands in, with the same semantics.
type LockOptions = { ifAvailable?: boolean };
type Locks = { request<T>(name: string, options: LockOptions, run: (lock: unknown) => Promise<T>): Promise<T>; query(): Promise<{ held?: { name?: string }[] }> };
/** Lock names. `identity` serializes reuse decisions (name + size, reference hash, stock item; review F6). */
export const lockNames = {
  upload: (assetId: string) => `cutframe-upload:${assetId}`,
  prepare: (assetId: string) => `cutframe-prepare:${assetId}`,
  prepareAttempt: (assetId: string, attemptId: string) => `cutframe-prepare-attempt:${assetId}:${attemptId}`,
  reference: (referenceId: string) => `cutframe-reference:${referenceId}`,
  identity: (key: string) => `cutframe-identity:${key}`,
};
const api = (): Locks | undefined => (globalThis.navigator as { locks?: Locks } | undefined)?.locks;
const tails = new Map<string, Promise<void>>(), held = new Set<string>();
async function local<T>(name: string, ifAvailable: boolean, run: () => Promise<T>): Promise<T | typeof BUSY> {
  if (ifAvailable && tails.has(name)) return BUSY;
  const previous = tails.get(name) ?? Promise.resolve();
  let release!: () => void; const mine = new Promise<void>(r => { release = r; });
  const tail = previous.then(() => mine); tails.set(name, tail);
  await previous; held.add(name);
  try { return await run(); } finally { held.delete(name); release(); if (tails.get(name) === tail) tails.delete(name); }
}
const BUSY = Symbol('busy');
/** Wait for the lock, then run. */
export async function withLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  const locks = api();
  if (locks) return locks.request(name, {}, run);
  return local(name, false, run) as Promise<T>;
}
/** Run only if nobody holds the lock right now; `undefined` when it is held elsewhere. */
export async function tryLock<T>(name: string, run: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const locks = api();
  if (locks) return locks.request(name, { ifAvailable: true }, async lock => lock ? { ran: true as const, value: await run() } : { ran: false as const });
  const out = await local(name, true, run);
  return out === BUSY ? { ran: false } : { ran: true, value: out as T };
}
export async function heldLocks(): Promise<Set<string>> {
  const locks = api();
  if (!locks) return new Set(held);
  return new Set(((await locks.query()).held ?? []).map(l => l.name ?? ''));
}
