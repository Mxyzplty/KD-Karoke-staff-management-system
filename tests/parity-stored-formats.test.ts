// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic stored-format regressions; these do not establish reference parity.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { callResult, contextOf, loadStored } from '../parity/g01';
import { runG08 } from '../parity/g08';
import { compareExport, matchExportFrames, storedWindows } from '../parity/g08-export';
import { writeSyntheticG08 } from '../parity/g08-synthetic';
import { emptyDocument } from '../apps/web/src/store/model';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'd34-formats-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const spec = { start: 'st', length: 'len', label: 'name', unit: 's' as const };
const row = { st: 9.5, len: 1, name: 'A-B' };
const expected = [{ label: 'A-B', startMs: 9500, lengthMs: 1000 }];

describe('stored result formats', () => {
  beforeEach(() => mkdir(path.join(root, 'results')));
  const put = (id: string, data: unknown) => writeFile(path.join(root, 'results', `${id}.json`), JSON.stringify(data));
  it('reads result text and block arrays, including block references', async () => {
    await put('A', { result: 'first\n<<<BLOCK>>>\nsecond' });
    await put('B', { result: ['@@SAME:A#0', { text: 'third' }, { ok: true }] });
    const stored = await loadStored(root);
    expect(stored.blocks('A')).toEqual(['first', 'second']);
    expect(stored.blocks('B')).toEqual(['first', 'third', '{"ok":true}']);
  });
  it('preserves legacy field precedence and reads a plain result object as one JSON block', async () => {
    await put('A', { result_text: 'text', result_blocks: ['blocks'], result: 'fallback' });
    await put('B', { result_blocks: ['blocks'], result: 'fallback' });
    await put('C', { result: { text: 'a plain object, not a block' } });
    const stored = await loadStored(root);
    expect(stored.blocks('A')).toEqual(['text']);
    expect(stored.blocks('B')).toEqual(['blocks']);
    expect(stored.blocks('C')).toEqual(['{"text":"a plain object, not a block"}']);
  });
  it('reads an object with a boolean success as one block, success at its top level', async () => {
    const result = { success: false, error: 'No transition', code: 'TRANSITION_NOT_FOUND', data: { nested: [1] } };
    await put('A', { result });
    const blocks = (await loadStored(root)).blocks('A');
    expect(blocks).toEqual([JSON.stringify(result)]);
    expect(callResult(blocks)).toEqual(result);
  });
  it('keeps an object result when notes name another file; empty, null and absent results keep the notes rule', async () => {
    const notes = 'same as A', fallback = ['{"success":true}'];
    await put('A', { result: fallback[0] });
    await put('B', { result: { success: false }, notes });
    await put('C', { result: { content: [{ type: 'text', text: '{"success":false}' }], isError: false }, notes });
    await put('D', { result: {}, notes });
    await put('E', { result: { content: [], isError: false }, notes });
    await put('F', { result: null, notes });
    await put('G', { result: '', notes });
    await put('H', { result: [], notes });
    await put('I', { notes });
    await put('J', { result: {} });
    const stored = await loadStored(root);
    expect(stored.blocks('B')).toEqual(['{"success":false}']);
    expect(stored.blocks('C')).toEqual(['{"success":false}']);
    for (const id of ['D', 'E', 'F', 'G', 'H', 'I']) expect(stored.blocks(id), id).toEqual(fallback);
    expect(() => stored.blocks('J')).toThrow(/J: no result content/);
  });
  it('reads {images, note} as one block with no call result to compare', async () => {
    const result = { images: ['preview.jpg'], note: 'no success field' };
    await put('A', { result });
    const blocks = (await loadStored(root)).blocks('A');
    expect(blocks).toEqual([JSON.stringify(result)]);
    expect(callResult(blocks)).toBeUndefined();
  });
  it('reads {content, isError} through the block list, so success and nested reads stay visible', async () => {
    const json = { success: true, data: { tracks: {}, layerOrder: [] } }, file = { type: 'image', file: 'a.png', bytes: 3, label: 'a', media_type: 'image/png', sha256: 'ab', ts: 1 };
    await put('A', { result: { content: [{ type: 'text', text: 'prose' }, { type: 'text', text: JSON.stringify(json) }, file], isError: false } });
    const blocks = (await loadStored(root)).blocks('A');
    expect(blocks).toEqual(['prose', JSON.stringify(json), JSON.stringify(file)]);
    expect(callResult(blocks)).toEqual(json);
    expect(contextOf(blocks)).toEqual(json.data);
  });
  it('reads an object that only resembles {content, isError} as any other object', async () => {
    const shapes = [{ content: 'text', isError: false }, { content: [{ text: 'a' }] }, { content: [{ text: 'a' }], note: 'no isError' }, { content: [{ text: 'a' }], isError: false, success: true }];
    for (const [i, result] of shapes.entries()) await put(`A${i}`, { result });
    const stored = await loadStored(root);
    shapes.forEach((result, i) => expect(stored.blocks(`A${i}`)).toEqual([JSON.stringify(result)]));
    expect(callResult(stored.blocks('A3'))).toEqual(shapes[3]);
  });
});

describe('G-08 replay on object results', () => {
  type Rec = Record<string, any>;
  // The synthetic folder with each record's JSON block moved into `result`, in the shapes research 3.8 reports; no stored record is read.
  const objectFolder = async () => {
    const dir = path.join(root, 'ref'), f = await writeSyntheticG08(dir), results = path.join(dir, 'results');
    const file = (id: string) => path.join(results, `${id}.json`), read = async (id: string) => JSON.parse(await readFile(file(id), 'utf8')) as Rec;
    const edit = async (id: string, change: (result: any) => unknown) => { const r = await read(id); await writeFile(file(id), JSON.stringify({ ...r, result: change(r.result) })); };
    for (const name of await readdir(results)) {
      const id = name.slice(0, -5), { result_text, result_blocks, ...r } = await read(id);
      await writeFile(file(id), JSON.stringify({ ...r, result: JSON.parse((result_blocks ?? result_text.split('\n<<<BLOCK>>>\n'))[1]) }));
    }
    const envelope = (result: Rec) => ({ content: [{ type: 'text', text: 'prose' }, { type: 'text', text: JSON.stringify(result) }], isError: false });
    await edit('t02', envelope);
    await edit('e02', envelope);
    await edit('C00', () => ({ images: ['preview.jpg'], note: 'no success field' }));
    await edit('R01', result => [result]);
    return { edit, run: () => runG08(dir, { calls: f.calls, assets: f.assets, toolField: f.toolField, inputField: f.inputField, blockBase: f.blockBase, output: path.join(root, 'out') }) };
  };
  it('reaches a report with the counts of the text folder, and still fails a wrong stored code', async () => {
    const { edit, run } = await objectFolder();
    expect(await run()).toMatchObject({ golden: 'G-08', status: 'uncompared', steps: 22, passed: 20, failed: 0, uncompared: 2 });
    expect(JSON.parse(await readFile(path.join(root, 'out', 'report.json'), 'utf8'))).toMatchObject({ steps: 22, passed: 20 });
    await edit('e01', result => ({ ...result, code: 'WRONG_CODE' }));
    await edit('e02', result => ({ ...result, content: [result.content[0], { type: 'text', text: JSON.stringify({ success: false, error: 'Cut not resolved', code: 'WRONG_CODE' }) }] }));
    const report = await run(), failed = report.parts.flatMap(p => p.steps).filter(s => s.status === 'failed');
    expect(failed.map(s => [s.id, s.diffs.map(d => d.path)])).toEqual([['e01', ['code']], ['e02', ['code']]]);
  });
});

describe('export stored formats', () => {
  it('accepts call-id keyed windows while keeping explicit fields and units', () => {
    expect(storedWindows({ C01: row, C02: { st: 11, len: 2, name: 'B-C' } }, spec, 30)).toEqual([...expected, { label: 'B-C', startMs: 11000, lengthMs: 2000 }]);
  });
  it('retains array and list formats and rejects a malformed keyed row', () => {
    expect(storedWindows([row], spec, 30)).toEqual(expected);
    expect(storedWindows({ windows: [row] }, { ...spec, list: 'windows' }, 30)).toEqual(expected);
    expect(() => storedWindows({ C01: row, C02: { st: 'bad', len: 1, name: 'bad' } }, spec, 30)).toThrow(/entry C02/);
    expect(() => storedWindows({ C01: row, C02: { st: 1 } }, spec, 30)).toThrow(/entry C02/);
    expect(() => storedWindows({ windows: { C01: row } }, { ...spec, list: 'windows' }, 30)).toThrow(/has no array 'windows'/);
  });
  it('ignores only the index metadata filename when matching frames', () => {
    expect(matchExportFrames(['_index.json', '_windows.json', 'E-9500.png'], '^E-(\\d+)\\.png$', 'ms', 30)).toEqual([{ file: 'E-9500.png', frame: 285 }]);
    expect(() => matchExportFrames(['_index.json'], '^E-(\\d+)\\.png$', 'ms', 30)).toThrow(/holds no stored frame/);
    for (const name of ['other.json', 'index.json', 'x_index.json', '_index.json.bak', '_INDEX.JSON']) expect(() => matchExportFrames([name], '^E-(\\d+)\\.png$', 'ms', 30)).toThrow(`frames/export/${name}:`);
    expect(() => matchExportFrames(['E-1.png'], '^E-(\\d+)\\.png$', 'bad' as never, 30)).toThrow(/frame-time-unit/);
  });
  it('validates index JSON and then validates windows JSON with a valid index', async () => {
    const folder = path.join(root, 'frames', 'export');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'E-0.png'), 'synthetic placeholder');
    await writeFile(path.join(folder, '_windows.json'), '{broken windows');
    await writeFile(path.join(folder, '_index.json'), '{broken index');
    const compare = compareExport(root, { frameName: '^E-(\\d+)\\.png$', frameUnit: 'ms', windows: spec });
    await expect(compare(emptyDocument(), 'synthetic', path.join(root, 'out'))).rejects.toThrow(/_index\.json.*(?:JSON|json)/);
    await writeFile(path.join(folder, '_index.json'), JSON.stringify({ arbitrary: 'metadata' }));
    await expect(compare(emptyDocument(), 'synthetic', path.join(root, 'out'))).rejects.toThrow(SyntaxError);
  });
  it('refuses an index link that leaves the reference folder', async () => {
    const ref = path.join(root, 'ref'), folder = path.join(ref, 'frames', 'export'), outside = path.join(root, 'outside');
    await mkdir(folder, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(folder, 'E-0.png'), 'synthetic placeholder');
    await writeFile(path.join(folder, '_windows.json'), '[]');
    await symlink(outside, path.join(folder, '_index.json'), 'junction');
    const compare = compareExport(ref, { frameName: '^E-(\\d+)\\.png$', frameUnit: 'ms', windows: spec });
    await expect(compare(emptyDocument(), 'synthetic', path.join(root, 'out'))).rejects.toThrow(/_index\.json escapes/);
  });
});

describe('G-08 export CLI', () => {
  it('reaches the replay runner with a valid frame unit and rejects a bad unit', async () => {
    const calls = path.join(root, 'calls.json'), assets = path.join(root, 'assets.json');
    await writeFile(calls, JSON.stringify([['missing-call']]));
    await writeFile(assets, '{}');
    const ref = path.join(root, 'ref');
    await mkdir(path.join(ref, 'results'), { recursive: true });
    const args = ['--golden', 'G-08', '--xapp-ref', ref, '--calls', calls, '--assets', assets, '--tool-field', 'tool', '--input-field', 'input', '--output', path.join(root, 'out'), '--export', '--frame-name', '^E-(\\d+)\\.png$', '--windows', 'start=st,length=len,label=name,unit=s', '--frame-time-unit'];
    const run = (unit: string) => spawnSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'parity/cli.ts', ...args, unit], { encoding: 'utf8', timeout: 180000 });
    const good = run('ms');
    expect(good.status).not.toBe(0);
    expect(good.stderr).toMatch(/--calls names missing-call, which has no results\/missing-call\.json/);
    const bad = run('bad');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/--frame-time-unit must be ms, s or frame/);
  }, 240000);
});
