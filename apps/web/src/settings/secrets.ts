// SPDX-License-Identifier: AGPL-3.0-only
// T21 key storage (ticket "Providers" (4)): the user's keys, in this browser for this origin only. Its own IndexedDB
// database (not the project database, so no project file, checkpoint, export or bundle reads it), each value sealed with
// AES-GCM under a non-extractable WebCrypto key. That protects against a copied profile folder, not against code running
// on our own origin. Every key is bound to the one origin it was entered for: getSecret answers only for that origin, so a
// request carrying a key can go only to that provider's endpoint.
const DB = 'cutframe-secrets', STORE = 'keys', MASTER = 'master';
type Sealed = { id: string; origin: string; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

const done = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
function open() {
  const request = indexedDB.open(DB, 1);
  request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: 'id' }); };
  return done(request);
}
async function withDb<T>(run: (db: IDBDatabase) => Promise<T>) { const db = await open(); try { return await run(db); } finally { db.close(); } }
const read = <T,>(db: IDBDatabase, id: string) => done<T | undefined>(db.transaction(STORE).objectStore(STORE).get(id));
/** The sealing key, made on first use. Two tabs may race: `add` lets one win and the other reads the winner's key. */
async function master(db: IDBDatabase): Promise<CryptoKey> {
  const stored = await read<{ key: CryptoKey }>(db, MASTER);
  if (stored) return stored.key;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  try { await done(db.transaction(STORE, 'readwrite').objectStore(STORE).add({ id: MASTER, key })); return key; }
  catch { return (await read<{ key: CryptoKey }>(db, MASTER))!.key; }
}
export const putSecret = (id: string, value: string, origin: string) => withDb(async db => {
  const key = await master(db), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  await done(db.transaction(STORE, 'readwrite').objectStore(STORE).put({ id, origin, iv, data } satisfies Sealed));
});
/** The key, for the origin it was entered for only. */
export const getSecret = (id: string, origin: string) => withDb(async db => {
  const row = await read<Sealed>(db, id);
  if (!row || row.origin !== origin) return undefined;
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv }, await master(db), row.data));
});
export const hasSecret = (id: string) => withDb(async db => !!await read<Sealed>(db, id));
export const secretOrigin = (id: string) => withDb(async db => (await read<Sealed>(db, id))?.origin);
export const removeSecret = (id: string) => withDb(db => done(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)));
