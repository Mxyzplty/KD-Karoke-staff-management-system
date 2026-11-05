// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selfCheck } from '../parity/cli';
import { normalise, canonical, type Json } from '../parity/normalise';
import { fixturePath, manifestFiles, sha256 } from '../parity/fixtures';
import { compatible, checkPackages } from '../scripts/licenses';
import { MockProvider, fixedScript } from '../parity/provider';
import { runScenario, EditorAdapter, compareFrames } from '../parity/runner';
describe('normalisation v1', () => {
  const project = (a = 'a', t = 't'): Json => ({ tracks: [{ id: t }], layerOrder: [{ type: 'track', id: t }], groups: {}, items: [{ id: a, trackId: t, display: { from: 0.123456789, to: 1000 }, properties: { opacity: { defaultValue: 1, keyframes: [{ id: 'k', time: 400.0001, value: 0.4 }] } }, details: { words: [{ startMs: 123, endMs: 234 }] } }], markers: [{ id: 'm', timeMs: 400 }], audit: { savedAt: 'random' }, unknown: { time: 4, sessionId: 'semantic-unknown' } });
  it('maps identities bijectively while retaining every semantic value', () => {
    expect(canonical(normalise(project()))).toBe(canonical(normalise(project('other', 'different'))));
    const text = canonical(normalise(project()));
    expect(text).toContain('0.123456789'); expect(text).toContain('400.0001'); expect(text).toContain('semantic-unknown');
    const changed = project() as Record<string, Json>; changed.markers = [{ id: 'm', timeMs: 401 }];
    expect(canonical(normalise(changed))).not.toBe(text);
  });
  it('refuses alias collapse, duplicates and dangling references', () => {
    expect(() => normalise({ tracks: [{ id: 'x' }, { id: 'x' }] })).toThrow('Duplicate track');
    expect(() => normalise({ items: [{ id: 'a', trackId: 'missing' }] })).toThrow('Dangling track');
    const x = { tracks: [{ id: 'x' }], items: [{ id: 'x', trackId: 'x' }] };
    expect(canonical(normalise(x))).toContain('item:1'); expect(canonical(normalise(x))).toContain('track:1');
  });
  it('numbers IDs independently of JSON key order (properties and dictionary groups)', () => {
    const keyframes = (id: string) => ({ defaultValue: 1, keyframes: [{ id, time: 0, value: 1 }] });
    const item = (properties: Record<string, Json>) => ({ tracks: [{ id: 't' }], items: [{ id: 'i', trackId: 't', properties }] });
    expect(canonical(normalise(item({ opacity: keyframes('ko'), scale: keyframes('ks') })))).toBe(canonical(normalise(item({ scale: keyframes('ks'), opacity: keyframes('ko') }))));
    const groups = (order: string[]) => ({ tracks: [{ id: 't' }], groups: Object.fromEntries(order.map(g => [g, { children: [{ type: 'track', id: 't' }] }])), layerOrder: order.map(id => ({ type: 'group', id })) });
    expect(canonical(normalise(groups(['a', 'b'])).project)).not.toBe(canonical(normalise(groups(['b', 'a'])).project)); // layerOrder is an array: its order is semantic
    const dict = (order: string[]) => ({ groups: Object.fromEntries(order.map(g => [g, { hidden: g === 'b' }])), layerOrder: [{ type: 'group', id: 'b' }, { type: 'group', id: 'a' }] });
    expect(canonical(normalise(dict(['a', 'b'])))).toBe(canonical(normalise(dict(['b', 'a']))));
  });
  it('preserves order and group references', () => {
    const p = { tracks: [{ id: 't' }], groups: { g: { children: [{ type: 'track', id: 't' }] } }, layerOrder: [{ type: 'group', id: 'g' }] };
    expect(canonical(normalise(p))).toContain('group:1');
  });
});
it('parses all31 baseline fixture entries with safe paths', async () => {
  const text = await readFile('fixtures/Cutframe test fixtures (C).md', 'utf8');
  expect(manifestFiles(text).length).toBeGreaterThanOrEqual(31);
  expect(() => manifestFiles('| `../escape` | 2 | `' + 'a'.repeat(64) + '` |')).toThrow('Unsafe');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cutframe-fixture-'));
  const file = path.join(dir, 'probe'); await writeFile(file, 'one'); const first = await sha256(file); await writeFile(file, 'ono'); expect(await sha256(file)).not.toBe(first);
  await expect(fixturePath({ name: 'missing', relative: 'missing', location: 'store', bytes: 1, sha256: first }, dir)).rejects.toThrow('missing');
});
it('license expressions cannot hide a forbidden dependency', () => {
  expect(compatible('(MIT OR CC0-1.0)')).toBe(true); expect(compatible('(MIT AND LicenseRef-Proprietary)')).toBe(false);
  expect(compatible('MIT WITH unknown')).toBe(false); expect(compatible('GPL-2.0-only')).toBe(false); expect(compatible('BSD-4-Clause')).toBe(false);
  expect(checkPackages({ 'node_modules/planted': { license: 'LicenseRef-Proprietary' } })[0]).toContain('planted');
  expect(checkPackages({ 'packages/remotion-packs': { license: 'MIT' } })[0]).toContain('Forbidden');
});
it('mock provider streams fixed text and tool events and records immutable requests', async () => {
  const mock = new MockProvider(); const req = { messages: [{ text: 'first' }] }; const output = [];
  for await (const event of mock.stream(req)) output.push(event);
  req.messages[0].text = 'changed'; expect(mock.requests[0]).toEqual({ messages: [{ text: 'first' }] }); expect(output).toEqual(fixedScript);
  const stop = new AbortController(); stop.abort(); await expect(async () => { for await (const _ of mock.stream(req, stop.signal)) {} }).rejects.toThrow();
});
it('executes real generic adapter dispatch, comparisons and explicit absent editor', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cutframe-parity-'));
  expect((await selfCheck(dir)).selfCheck).toBe('passed');
  const report = await runScenario({ version: 1, inputMode: 'fixture-free', name: 'absent', project: {}, edits: [], sampleTimesMs: [] }, new EditorAdapter(), { output: path.join(dir, 'absent') });
  expect(report.status).toBe('not-implemented');
  expect(compareFrames({ width: 1, height: 1, rgba: [0, 0, 0, 1] }, { width: 1, height: 1, rgba: [1, 0, 0, 1] }).maxPixelError).toBe(1);
});
