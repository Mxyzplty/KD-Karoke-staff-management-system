// SPDX-License-Identifier: AGPL-3.0-only
// T21 key storage: values are sealed in their own IndexedDB database, bound to the origin they were entered for, and removable.
// Runs on fake-indexeddb with Node's WebCrypto; real-browser persistence is out of reach of this file.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, test } from 'vitest';
import { getSecret, hasSecret, putSecret, removeSecret, secretOrigin } from '../apps/web/src/settings/secrets';

const A = 'https://api.openai.com', B = 'https://api.anthropic.com';
/** As Delete local data does it: the whole database. */
const clearSecrets = () => new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('cutframe-secrets'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
beforeEach(async () => { await clearSecrets(); });

/** Every raw record in the secrets database. */
function raw() {
  return new Promise<any[]>((resolve, reject) => {
    const open = indexedDB.open('cutframe-secrets', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction('keys').objectStore('keys').getAll();
      all.onsuccess = () => { open.result.close(); resolve(all.result); };
      all.onerror = () => reject(all.error);
    };
  });
}

describe('secrets', () => {
  test('a stored key reads back for its own origin', async () => {
    await putSecret('model:c1', 'sk-abc', A);
    expect(await getSecret('model:c1', A)).toBe('sk-abc');
    expect(await hasSecret('model:c1')).toBe(true);
    expect(await secretOrigin('model:c1')).toBe(A);
  });
  test('another origin gets nothing (a key can only go to the site it was entered for)', async () => {
    await putSecret('model:c1', 'sk-abc', A);
    expect(await getSecret('model:c1', B)).toBeUndefined();
    expect(await getSecret('model:c1', 'https://api.openai.com.evil.com')).toBeUndefined();
  });
  test('unknown ids are absent', async () => {
    expect(await getSecret('nope', A)).toBeUndefined();
    expect(await hasSecret('nope')).toBe(false);
    expect(await secretOrigin('nope')).toBeUndefined();
  });
  test('the value is stored sealed: no plaintext in the record, the sealing key non-extractable, a fresh IV each time', async () => {
    await putSecret('model:c1', 'sk-plain-text-value', A);
    const first = (await raw()).find(r => r.id === 'model:c1');
    expect(first.iv).toHaveLength(12);
    expect(first.data).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(first.data).toString('latin1')).not.toContain('sk-plain-text-value');
    const master = (await raw()).find(r => r.id === 'master');
    expect(master.key.extractable).toBe(false);
    await putSecret('model:c1', 'sk-plain-text-value', A);
    const second = (await raw()).find(r => r.id === 'model:c1');
    expect(Buffer.from(second.iv).equals(Buffer.from(first.iv))).toBe(false);
    expect(await getSecret('model:c1', A)).toBe('sk-plain-text-value');
  });
  test('putSecret replaces a value and rebinds its origin', async () => {
    await putSecret('k', 'one', A); await putSecret('k', 'two', B);
    expect(await getSecret('k', A)).toBeUndefined();
    expect(await getSecret('k', B)).toBe('two');
  });
  test('keys are independent, and removeSecret removes only its own (and is harmless twice)', async () => {
    await putSecret('x', '1', A); await putSecret('y', '2', B);
    await removeSecret('x'); await removeSecret('x');
    expect(await hasSecret('x')).toBe(false);
    expect(await getSecret('y', B)).toBe('2');
  });
  test('unicode and long values survive', async () => {
    const value = 'ключ-🔑-' + 'z'.repeat(5000);
    await putSecret('u', value, A);
    expect(await getSecret('u', A)).toBe(value);
  });
  test('deleting the database takes its sealing key with it', async () => {
    await putSecret('x', '1', A);
    await clearSecrets();
    expect(await hasSecret('x')).toBe(false);
    expect(await raw()).toEqual([]);
    await putSecret('x', '2', A); // a new sealing key is made on demand
    expect(await getSecret('x', A)).toBe('2');
  });
});
