// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 8 / A12/P1/P9: closed data-only templates, membership/personal copies, byte-identical transfer and failure atomicity.
// Oracle: findings §22 Cutframe spec, plan P1/P9, error-code §14 texts, and the pinned step-8 contract.
// Hash/base64 expectations use node:crypto and fixture bytes, never the app's hashing/import/export helpers.
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import { StoreError } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import type { RecordData } from '../apps/web/src/store/model';
import { templateProblem, templateRefs, refKind, REF_KINDS, TEMPLATE_VERSION } from '../apps/web/src/templates/model';
import type { Template } from '../apps/web/src/templates/model';
import { DEFAULT_TEMPLATE, DEFAULT_FILES } from '../apps/web/src/templates/default';
import { BUILT_IN_TEMPLATES, TEMPLATES_ROW, TEMPLATE_FORMAT, listTemplates, findTemplate, saveTemplate, updateTemplate, personalCopy,
  deleteTemplate, saveToMyTemplates, verifyBuiltIn, exportTemplate, importTemplate } from '../apps/web/src/templates/library';
import { templateErrorText, templateError, TEMPLATE_FALLBACK } from '../apps/web/src/templates/errors';
import { addUserFont, removeUserFont, loadUserFonts, userFonts, userBlob, findFont } from '../apps/web/src/text/font-registry';

const NOW = new Date('2026-11-11T05:00:00.000Z'), opened: ProjectStore[] = [];
let initialFonts = new Set<string>();
beforeEach(async () => { await loadUserFonts(true); initialFonts = new Set(userFonts().map(font => font.sha256)); });
afterEach(async () => {
  for (const font of [...userFonts()]) if (!initialFonts.has(font.sha256)) await removeUserFont(font.sha256);
  for (const store of opened.splice(0)) await store.close();
});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function setup() {
  let tick = NOW.getTime(); const files = new Map<string, Blob>();
  const media: MediaStore = { write: vi.fn(async (id, blob) => { files.set(id, blob); }), read: vi.fn(async id => { const blob = files.get(id); if (!blob) throw new Error(`Missing bytes ${id}`); return blob; }),
    remove: vi.fn(async (_kind, id) => { files.delete(id); }), list: vi.fn(async () => [...files.keys()]) };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return { store, files };
}
function template(id = 'user-template'): Template {
  return { id, name: 'User template', family: 'Personal', author: 'Test', palette: [{ name: 'Accent', hex: '#123456' }], examples: [],
    assets: { fonts: [{ name: 'Roboto', ref: 'font:Roboto' }], audio: [], images: [] }, defaults: { captionsFont: 'Roboto', titlesFont: 'Roboto', accentFont: 'Roboto' },
    captionTemplateId: 'default', presetIds: ['text/big-headline'], guidance: '', learning: true, preferences: '', version: 1, savedAt: NOW.toISOString() };
}
async function failure(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, caught => caught); expect(error).toBeInstanceOf(StoreError); expect(error).toMatchObject({ code }); return error;
}
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
function wav() {
  const bytes = new Uint8Array(46), view = new DataView(bytes.buffer), ascii = (at: number, text: string) => bytes.set([...text].map(c => c.charCodeAt(0)), at);
  ascii(0, 'RIFF'); view.setUint32(4, 38, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, 2, true); return bytes;
}
// Minimal sfnt name table for registry/transfer tests, not a glyph-rendering font (no FontFace/DOM is installed in Node).
function fontBytes(family: string) {
  const names = [family, `${family.replace(/\s/g, '')}-Regular`], encoded = names.map(name => Uint8Array.from([...name].flatMap(c => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255])));
  const tableSize = 30 + encoded.reduce((sum, bytes) => sum + bytes.length, 0), bytes = new Uint8Array(28 + tableSize), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, 1); view.setUint16(6, 16); view.setUint32(12, 0x6e616d65); view.setUint32(20, 28); view.setUint32(24, tableSize);
  view.setUint16(30, 2); view.setUint16(32, 30); let offset = 0;
  encoded.forEach((value, k) => { const at = 34 + k * 12; view.setUint16(at, 3); view.setUint16(at + 2, 1); view.setUint16(at + 4, 0x409);
    view.setUint16(at + 6, k === 0 ? 1 : 6); view.setUint16(at + 8, value.length); view.setUint16(at + 10, offset); bytes.set(value, 58 + offset); offset += value.length; });
  return bytes;
}
async function mediaTemplate(store: ProjectStore) {
  const sound = wav(), image = await store.upload(new File([PNG], 'picture.png', { type: 'image/png' })), audio = await store.upload(new File([sound], 'tone.wav', { type: 'audio/wav' }));
  const t = template('with-assets'); t.examples = [{ name: image.name, ref: `asset:${image.id}` }];
  t.assets.images = [{ name: image.name, ref: `asset:${image.id}` }]; t.assets.audio = [{ name: audio.name, ref: `asset:${audio.id}` }]; await saveTemplate(store, t);
  return { t, image, audio, sound };
}

describe('template model: closed schema, typed refs and pure reference helpers', () => {
  it('default/fixture validate; constants and ref-kind permissions are literal contract values', () => {
    expect(templateProblem(DEFAULT_TEMPLATE)).toBeNull(); expect(templateProblem(template())).toBeNull(); expect(TEMPLATE_VERSION).toBe(1);
    expect(TEMPLATES_ROW).toBe('templates'); expect(TEMPLATE_FORMAT).toBe('cutframe-template');
    expect(REF_KINDS).toEqual({ examples: ['preset', 'asset', 'element', 'sound'], fonts: ['font'], audio: ['sound', 'asset'], images: ['element', 'asset'] });
  });
  it.each(['template', 'palette', 'example-ref', 'font-ref', 'audio-ref', 'image-ref', 'defaults', 'assets'])('unknown field in %s is rejected', where => {
    const t = template() as RecordData;
    if (where === 'template') t.extra = true;
    if (where === 'palette') t.palette[0].extra = true;
    if (where === 'defaults' || where === 'assets') t[where].extra = true;
    if (where === 'example-ref') t.examples = [{ name: 'Example', ref: 'preset:text/big-headline', extra: true }];
    if (where === 'font-ref') t.assets.fonts[0].extra = true;
    if (where === 'audio-ref') t.assets.audio = [{ name: 'Sound', ref: 'sound:mouse-click', extra: true }];
    if (where === 'image-ref') t.assets.images = [{ name: 'Image', ref: 'element:sticker-star', extra: true }];
    expect(templateProblem(t)).not.toBeNull();
  });
  it.each(['', 'UPPER', 'has_space', 'two words', 'a/b'])('id %j is not a lowercase slug', id => expect(templateProblem({ ...template(), id })).not.toBeNull());
  it.each(['#fff', '#GG0000', '123456', 'rgb(1,2,3)'])('bad hex %j is rejected', hex => { const t = template(); t.palette[0].hex = hex; expect(templateProblem(t)).not.toBeNull(); });
  it.each([{ list: 'examples', ref: 'font:Roboto' }, { list: 'fonts', ref: 'sound:mouse-click' }, { list: 'audio', ref: 'element:sticker-star' }, { list: 'images', ref: 'preset:text/big-headline' }])(
    '$list rejects $ref', ({ list, ref }) => { const t = template(); if (list === 'examples') t.examples = [{ name: 'Bad', ref }]; else t.assets[list as 'fonts' | 'audio' | 'images'] = [{ name: 'Bad', ref }]; expect(templateProblem(t)).not.toBeNull(); });
  it.each([0, 2, '1'])('version %j is invalid', version => expect(templateProblem({ ...template(), version })).not.toBeNull());
  it('empty guidance/preferences are valid; non-string values and non-boolean learning are not', () => {
    expect(templateProblem(template())).toBeNull();
    for (const patch of [{ guidance: 42 }, { preferences: null }, { learning: 'true' }]) expect(templateProblem({ ...template(), ...patch })).not.toBeNull();
  });
  it.each(['captionsFont', 'titlesFont', 'accentFont'])('%s is nonempty text, but not checked for registry existence', key => {
    const t = template(); t.defaults[key as keyof Template['defaults']] = 'Not Installed Yet'; expect(templateProblem(t)).toBeNull();
    for (const value of ['', '   ', 42]) expect(templateProblem({ ...t, defaults: { ...t.defaults, [key]: value } })).not.toBeNull();
  });
  it('optional fields can be absent; basedOn, if present, must equal id', () => {
    const t = template(); delete t.captionTemplateId; expect(templateProblem(t)).toBeNull();
    expect(templateProblem({ ...t, basedOn: t.id })).toBeNull(); expect(templateProblem({ ...t, basedOn: 'another-id' })).not.toBeNull();
  });
  it('templateRefs includes each list entry and refKind reads the five allowed prefixes', () => {
    const t = template(); t.examples = [{ name: 'Example', ref: 'preset:text/big-headline' }]; t.assets.audio = [{ name: 'Audio', ref: 'sound:mouse-click' }]; t.assets.images = [{ name: 'Image', ref: 'element:sticker-star' }];
    const expected = [...t.examples, ...t.assets.fonts, ...t.assets.audio, ...t.assets.images]; expect(templateRefs(t)).toEqual(expect.arrayContaining(expected)); expect(templateRefs(t)).toHaveLength(expected.length);
    for (const kind of ['font', 'sound', 'element', 'asset', 'preset']) expect(refKind(`${kind}:value`)).toBe(kind);
  });
});

describe('A12/P1: library membership, authoring and personal copies', () => {
  it('fresh store contains the built-in default, with mine empty', async () => {
    const { store } = setup(), list = await listTemplates(store); expect(list.builtIn).toContainEqual(DEFAULT_TEMPLATE); expect(list.mine).toEqual([]); expect(BUILT_IN_TEMPLATES).toContainEqual(DEFAULT_TEMPLATE);
  });
  it('save/list/find/delete for a user template; same id replaces it', async () => {
    const { store } = setup(), t = template(); expect(await saveTemplate(store, t)).toEqual(t);
    expect((await listTemplates(store)).mine).toEqual([t]); expect((await listTemplates(store)).builtIn.some(p => p.id === t.id)).toBe(false); expect(await findTemplate(store, t.id)).toEqual(t);
    const replacement = { ...t, name: 'Replacement' }; await saveTemplate(store, replacement); expect((await listTemplates(store)).mine).toEqual([replacement]);
    await deleteTemplate(store, t.id); expect((await listTemplates(store)).mine).toEqual([]); expect(await findTemplate(store, t.id)).toBeUndefined();
  });
  it('saving default membership twice lists it once; deleting membership never deletes the built-in', async () => {
    const { store } = setup(); await saveToMyTemplates(store, DEFAULT_TEMPLATE.id); await saveToMyTemplates(store, DEFAULT_TEMPLATE.id);
    expect((await listTemplates(store)).mine).toEqual([DEFAULT_TEMPLATE]); await deleteTemplate(store, DEFAULT_TEMPLATE.id);
    expect((await listTemplates(store)).mine).toEqual([]); expect((await listTemplates(store)).builtIn).toContainEqual(DEFAULT_TEMPLATE);
  });
  it('personal copy is pure; before editing views show built-in values, after editing all views show the copy, deletion restores', async () => {
    const { store } = setup(), pristine = structuredClone(DEFAULT_TEMPLATE); await saveToMyTemplates(store, DEFAULT_TEMPLATE.id);
    expect(personalCopy(DEFAULT_TEMPLATE)).toEqual({ ...pristine, basedOn: pristine.id }); expect(DEFAULT_TEMPLATE).toEqual(pristine);
    expect(await findTemplate(store, pristine.id)).toEqual(pristine); expect((await listTemplates(store)).mine).toEqual([pristine]); expect((await listTemplates(store)).builtIn.find(t => t.id === pristine.id)).toEqual(pristine);
    const changed = await updateTemplate(store, pristine.id, t => ({ ...t, defaults: { ...t.defaults, titlesFont: 'Roboto' }, palette: [{ name: 'Personal', hex: '#123456' }] }), NOW);
    const expected = { ...pristine, defaults: { ...pristine.defaults, titlesFont: 'Roboto' }, palette: [{ name: 'Personal', hex: '#123456' }], basedOn: pristine.id, savedAt: NOW.toISOString() };
    expect(changed).toEqual(expected); expect(await findTemplate(store, pristine.id)).toEqual(expected); expect((await listTemplates(store)).mine).toEqual([expected]); expect((await listTemplates(store)).builtIn.find(t => t.id === pristine.id)).toEqual(expected); expect(DEFAULT_TEMPLATE).toEqual(pristine);
    await deleteTemplate(store, pristine.id); expect(await findTemplate(store, pristine.id)).toEqual(pristine);
    expect((await listTemplates(store)).builtIn.find(t => t.id === pristine.id)).toEqual(pristine); expect((await listTemplates(store)).mine).toEqual([]);
  });
  it('update stamps a user template and rejects invalid results atomically', async () => {
    const { store } = setup(), t = template(); await saveTemplate(store, t); const changed = await updateTemplate(store, t.id, old => ({ ...old, preferences: 'Changed' }), NOW);
    expect(changed).toMatchObject({ preferences: 'Changed', savedAt: NOW.toISOString() }); const before = await store.row('settings', 'templates');
    await failure(updateTemplate(store, t.id, old => ({ ...old, version: 2 }), NOW), 'TEMPLATE_INVALID'); expect(await store.row('settings', 'templates')).toEqual(before);
  });
  it('invalid save and unknown update/membership/export use their own codes without a row write', async () => {
    const { store } = setup(), before = await store.row('settings', 'templates');
    await failure(saveTemplate(store, { ...template(), version: 2 }), 'TEMPLATE_INVALID'); await failure(updateTemplate(store, 'missing', t => t), 'TEMPLATE_NOT_FOUND');
    await failure(saveToMyTemplates(store, 'missing'), 'TEMPLATE_NOT_FOUND'); await failure(exportTemplate(store, 'missing'), 'TEMPLATE_NOT_FOUND'); expect(await store.row('settings', 'templates')).toEqual(before);
  });
});

describe('verifyBuiltIn checks real bytes, wrapping missing/hash failures as DEFAULT_UNAVAILABLE', () => {
  const realLoad = async (path: string) => new Blob([readFileSync(new URL(`../${path}`, import.meta.url))]);
  it('all real default files resolve', async () => { await expect(verifyBuiltIn(DEFAULT_TEMPLATE, realLoad)).resolves.toBeUndefined(); });
  it('one missing file rejects', async () => {
    await failure(verifyBuiltIn(DEFAULT_TEMPLATE, async path => { if (path === DEFAULT_FILES[0].path) throw new Error('missing'); return realLoad(path); }), 'DEFAULT_UNAVAILABLE');
  });
  it('one changed byte stream rejects', async () => {
    await failure(verifyBuiltIn(DEFAULT_TEMPLATE, async path => path === DEFAULT_FILES[0].path ? new Blob(['changed']) : realLoad(path)), 'DEFAULT_UNAVAILABLE');
  });
});

describe('P9: media and uploaded-font JSON transfer', () => {
  it('exports each library file once with independent bytes/hash/base64 and remaps refs into an empty second store', async () => {
    const source = setup(), destination = setup(), { t, image, audio, sound } = await mediaTemplate(source.store), exported = await exportTemplate(source.store, t.id);
    expect(exported.file).toMatchObject({ format: 'cutframe-template', version: 1, template: t }); expect(exported.file.assets).toHaveLength(2); expect([...exported.carries.media].sort()).toEqual([image.name, audio.name].sort());
    for (const [asset, bytes, kind, mime] of [[image, PNG, 'image', 'image/png'], [audio, sound, 'audio', 'audio/wav']] as const) expect(exported.file.assets.find(entry => entry.id === asset.id)).toEqual({ id: asset.id, name: asset.name, kind, mime, sha256: hash(bytes), bytes: bytes.byteLength, data: Buffer.from(bytes).toString('base64') });
    const imported = await importTemplate(destination.store, JSON.parse(JSON.stringify(exported.file))), library = (await destination.store.library()).assets;
    const newImage = library.find(asset => asset.sha256 === hash(PNG))!, newAudio = library.find(asset => asset.sha256 === hash(sound))!; expect(newImage).toBeDefined(); expect(newAudio).toBeDefined();
    const expected = structuredClone(t); expected.examples[0].ref = `asset:${newImage.id}`; expected.assets.images[0].ref = `asset:${newImage.id}`; expected.assets.audio[0].ref = `asset:${newAudio.id}`; expect(imported).toEqual(expected);
    expect(new Uint8Array(await (await destination.store.media.read(newImage.id)).arrayBuffer())).toEqual(PNG); expect(new Uint8Array(await (await destination.store.media.read(newAudio.id)).arrayBuffer())).toEqual(sound);
    const renamed = structuredClone(exported.file); renamed.assets.forEach(entry => { entry.name = `alternate-${entry.name}`; });
    // Changed filenames must not defeat SHA reuse after the cross-store reference remap.
    await importTemplate(destination.store, renamed); expect((await destination.store.library()).assets.map(asset => asset.id).sort()).toEqual([newImage.id, newAudio.id].sort());
    expect((await listTemplates(destination.store)).mine.filter(template => template.id === t.id)).toHaveLength(1);
  });
  it('same-store import reuses existing SHA-256 assets and leaves one template after two imports', async () => {
    const { store } = setup(), { t } = await mediaTemplate(store), file = (await exportTemplate(store, t.id)).file, ids = (await store.library()).assets.map(asset => asset.id).sort();
    // Simulate a different library's opaque ids and filenames while preserving every byte/SHA. Neither id nor name can be the reuse key.
    const externalIds = new Map(file.assets.map(entry => [entry.id, crypto.randomUUID()]));
    file.assets.forEach(entry => { entry.id = externalIds.get(entry.id)!; entry.name = `alternate-${entry.name}`; });
    for (const ref of [...file.template.examples, ...file.template.assets.fonts, ...file.template.assets.audio, ...file.template.assets.images])
      if (ref.ref.startsWith('asset:')) ref.ref = `asset:${externalIds.get(ref.ref.slice(6))!}`;
    await importTemplate(store, file); await importTemplate(store, file); expect((await store.library()).assets.map(asset => asset.id).sort()).toEqual(ids); expect((await listTemplates(store)).mine.filter(template => template.id === t.id)).toHaveLength(1);
  });
  it('catalogue/font-registry refs export no embedded library files', async () => {
    const { store } = setup(), t = template('catalogue-only'); t.examples = [{ name: 'Preset', ref: 'preset:text/big-headline' }]; t.assets.audio = [{ name: 'Sound', ref: 'sound:mouse-click' }]; t.assets.images = [{ name: 'Element', ref: 'element:sticker-star' }];
    await saveTemplate(store, t); expect((await exportTemplate(store, t.id)).file.assets).toEqual([]);
  });
  it('an uploaded default font is embedded with id=sha256 and restored byte-identically after removal', async () => {
    const { store } = setup(), bytes = fontBytes('T22 Transfer Font'), upload = await addUserFont(new File([bytes], 'transfer.ttf', { type: 'font/ttf' })), t = template('with-font');
    t.defaults = { captionsFont: upload.family, titlesFont: upload.family, accentFont: upload.family }; t.assets.fonts = [{ name: upload.family, ref: `font:${upload.family}` }]; await saveTemplate(store, t);
    const { file, carries } = await exportTemplate(store, t.id); expect(carries.fonts).toEqual([upload.family]);
    expect(file.assets).toEqual([{ id: hash(bytes), name: 'transfer.ttf', kind: 'font', mime: 'font/ttf', sha256: hash(bytes), bytes: bytes.byteLength, data: Buffer.from(bytes).toString('base64') }]);
    await removeUserFont(upload.sha256); expect(findFont(upload.family)).toBeNull(); const second = setup(); expect(await importTemplate(second.store, JSON.parse(JSON.stringify(file)))).toEqual(t);
    expect(userFonts().some(font => font.family === upload.family && font.sha256 === hash(bytes))).toBe(true); expect(new Uint8Array(await (await userBlob(hash(bytes))).arrayBuffer())).toEqual(bytes);
  });
});

async function snapshot(store: ProjectStore, files: Map<string, Blob>) {
  const blobs = await Promise.all([...files.entries()].map(async ([id, blob]) => [id, hash(new Uint8Array(await blob.arrayBuffer()))]));
  return { assets: (await store.library()).assets, fonts: structuredClone(userFonts()), row: await store.row('settings', 'templates'), blobs: blobs.sort((a, b) => a[0].localeCompare(b[0])) };
}
describe('P9 failing imports leave library assets, uploaded fonts, template rows and stored bytes unchanged', () => {
  const cases: { label: string; change: (file: RecordData) => void }[] = [
    { label: 'wrong format', change: file => { file.format = 'other'; } }, { label: 'newer version', change: file => { file.version = 2; } },
    { label: 'unknown file field', change: file => { file.extra = true; } }, { label: 'unknown template field', change: file => { file.template.extra = true; } },
    { label: 'unknown asset field', change: file => { file.assets.find((entry: RecordData) => entry.kind === 'audio').extra = true; } },
    { label: 'bad hash', change: file => { file.assets.find((entry: RecordData) => entry.kind === 'audio').sha256 = '0'.repeat(64); } },
    { label: 'wrong byte count', change: file => { file.assets.find((entry: RecordData) => entry.kind === 'audio').bytes++; } },
    { label: 'non-base64 data', change: file => { file.assets.find((entry: RecordData) => entry.kind === 'audio').data = 'not base64 !!!'; } },
    { label: 'missing asset file', change: file => { file.assets = file.assets.filter((entry: RecordData) => entry.kind !== 'audio'); } },
    { label: 'font entry is not a font', change: file => { const entry = file.assets.find((entry: RecordData) => entry.kind === 'font'); entry.id = entry.sha256 = hash(PNG); entry.bytes = PNG.byteLength; entry.data = Buffer.from(PNG).toString('base64'); } },
  ];
  it.each(cases)('$label', async ({ change }) => {
    const source = setup(), target = setup(), { t } = await mediaTemplate(source.store), font = await addUserFont(new File([fontBytes('T22 Transfer Font')], 'transfer.ttf', { type: 'font/ttf' }));
    t.defaults.titlesFont = font.family; t.assets.fonts.push({ name: font.family, ref: `font:${font.family}` }); await saveTemplate(source.store, t);
    const file = JSON.parse(JSON.stringify((await exportTemplate(source.store, t.id)).file));
    // A valid new font/file precedes a late bad entry: checking only the first entry must not permit a partial write.
    file.assets.sort((a: RecordData, b: RecordData) => ['font', 'image', 'audio'].indexOf(a.kind) - ['font', 'image', 'audio'].indexOf(b.kind));
    await removeUserFont(font.sha256); await addUserFont(new File([fontBytes('T22 Existing Font')], 'existing.ttf', { type: 'font/ttf' }));
    await target.store.upload(new File([PNG], 'untouched.png', { type: 'image/png' })); await saveTemplate(target.store, template('untouched'));
    change(file); const before = await snapshot(target.store, target.files), error = await importTemplate(target.store, file).then(() => null, caught => caught);
    expect.soft(error).toBeInstanceOf(StoreError); expect.soft(error).toMatchObject({ code: 'TEMPLATE_INVALID' }); expect(await snapshot(target.store, target.files)).toEqual(before);
  });
  // Review round 1. A valid file with one font this browser does not have and two named media files; entries in the order font, image, audio.
  async function fileWithFont() {
    const source = setup(), { t } = await mediaTemplate(source.store), font = await addUserFont(new File([fontBytes('T22 Transfer Font')], 'transfer.ttf', { type: 'font/ttf' }));
    t.defaults.titlesFont = font.family; t.assets.fonts.push({ name: font.family, ref: `font:${font.family}` }); await saveTemplate(source.store, t);
    const file = JSON.parse(JSON.stringify((await exportTemplate(source.store, t.id)).file));
    file.assets.sort((a: RecordData, b: RecordData) => ['font', 'image', 'audio'].indexOf(a.kind) - ['font', 'image', 'audio'].indexOf(b.kind));
    await removeUserFont(font.sha256); return { file, font };
  }
  const otherWav = () => { const bytes = wav(); bytes[45] = 1; return bytes; };
  it('an asset entry no reference names is refused and nothing is stored', async () => {
    const target = setup(), { file, font } = await fileWithFont(), extra = otherWav();
    // Well formed in every field (bytes, size, SHA-256, kind); only no examples / audio / images reference names it.
    file.assets.push({ id: crypto.randomUUID(), name: 'unnamed.wav', kind: 'audio', mime: 'audio/wav', sha256: hash(extra), bytes: extra.byteLength, data: Buffer.from(extra).toString('base64') });
    const before = await snapshot(target.store, target.files); await failure(importTemplate(target.store, file), 'TEMPLATE_INVALID');
    expect((await target.store.library()).assets).toEqual([]); expect(userFonts().some(f => f.sha256 === font.sha256)).toBe(false);
    expect(await findTemplate(target.store, file.template.id)).toBeUndefined(); expect(await snapshot(target.store, target.files)).toEqual(before);
  });
  it('a failing second upload leaves no font, no upload and no template', async () => {
    const target = setup(), { file, font } = await fileWithFont();
    const kept = await target.store.upload(new File([otherWav()], 'untouched.wav', { type: 'audio/wav' })); await saveTemplate(target.store, template('untouched'));
    const before = await snapshot(target.store, target.files), upload = target.store.upload.bind(target.store), error = new Error('The second upload failed.'); let uploads = 0;
    const spy = vi.spyOn(target.store, 'upload').mockImplementation(async (...args: Parameters<ProjectStore['upload']>) => { if (++uploads === 2) throw error; return upload(...args); });
    // The import rejects with the very error the upload threw, not a new or wrapped one.
    try { await expect(importTemplate(target.store, file)).rejects.toBe(error); } finally { spy.mockRestore(); }
    expect(uploads, 'the image was uploaded, then the audio upload failed').toBe(2);
    expect(userFonts().some(f => f.sha256 === font.sha256), 'the font the import added is gone').toBe(false);
    expect((await target.store.library()).assets.map(asset => asset.id), 'the first upload is gone; the file that was there stays').toEqual([kept.id]);
    expect(await findTemplate(target.store, file.template.id)).toBeUndefined(); expect(await snapshot(target.store, target.files)).toEqual(before);
  });
  it('a failing template save after the uploads leaves no font, no upload and no template', async () => {
    const target = setup(), { file, font } = await fileWithFont();
    const kept = await target.store.upload(new File([otherWav()], 'untouched.wav', { type: 'audio/wav' })); await saveTemplate(target.store, template('untouched'));
    const before = await snapshot(target.store, target.files), swap = target.store.swapRow.bind(target.store) as (...args: any[]) => Promise<any>, error = new Error('The template save failed.');
    // Only the write of the templates row fails; every other row swap passes through.
    const uploads = vi.spyOn(target.store, 'upload'), save = vi.spyOn(target.store, 'swapRow').mockImplementation((async (...args: any[]) => {
      if (args[0] === 'settings' && args[1] === TEMPLATES_ROW) throw error; return swap(...args);
    }) as typeof target.store.swapRow);
    try {
      // The import rejects with the very error the save threw, not a new or wrapped one.
      await expect(importTemplate(target.store, file)).rejects.toBe(error);
      expect(uploads, 'the image and the audio were both uploaded before the save').toHaveBeenCalledTimes(2);
    } finally { save.mockRestore(); uploads.mockRestore(); }
    expect(userFonts().some(f => f.sha256 === font.sha256), 'the font the import added is gone').toBe(false);
    expect((await target.store.library()).assets.map(asset => asset.id), 'both uploads are gone; the file that was there stays').toEqual([kept.id]);
    expect(await findTemplate(target.store, file.template.id)).toBeUndefined(); expect(await snapshot(target.store, target.files)).toEqual(before);
  });
});

describe('§14 template error texts, pattern groups and typographic apostrophes', () => {
  it.each([
    ['TEMPLATE_AUTHORING_BILLING_UNAVAILABLE', 'We couldn’t check your template allowance. Please try again.'],
    ['TEMPLATE_AUTHORING_QUOTA_EXCEEDED', 'Your personal-template allowance is in use. Wait for pending saves to finish or check your plan.'],
    ['TEMPLATE_AUTHORING_MONTHLY_LIMIT', 'You’ve reached your plan’s monthly template limit. Check your plan or wait for your allowance to reset.'],
    ['TEMPLATE_RATE_LIMITED', 'Too many template requests. Wait a moment, then try again.'],
  ])('%s exact text', (code, text) => expect(templateErrorText(code)).toBe(text));
  it.each(['TEMPLATE_UNAVAILABLE', 'UNKNOWN_CODE', 'TEMPLATE_AUTHORING_UNKNOWN', 'TEMPLATE_PREAUTH_POST', null, 42, {}])('%j uses the generic fallback, not an AUTH substring match', code => {
    expect(TEMPLATE_FALLBACK).toBe('We couldn’t complete that request. Please try again.'); expect(templateErrorText(code)).toBe('We couldn’t complete that request. Please try again.');
  });
  it.each(['HAS_CONFLICT', 'TEMPLATE_SELECTION_STALE', 'SOURCE_CHANGED', 'PRECONFLICTPOST', 'PRESTALEPOST', 'PRECHANGEDPOST'])('%s refresh/review group', code => expect(templateErrorText(code)).toBe('This project or template changed. Refresh it and review your choice again.'));
  it.each(['ITEM_FORGOTTEN', 'SOURCE_CORRECTED', 'REVIEW_SUPERSEDED', 'PREFORGOTTENPOST', 'PRECORRECTEDPOST', 'PRESUPERSEDEDPOST'])('%s source-changed group', code => expect(templateErrorText(code)).toBe('The source has changed or was removed. Start a new review to use the current project.'));
  it.each(['AUTH', 'TEMPLATE_AUTH_ERROR', 'TEMPLATE_UNAUTHORIZED', 'TEMPLATE_FORBIDDEN_EXTRA'])('%s access segment', code => expect(templateErrorText(code)).toBe('You don’t have access to this template.'));
  it.each(['DEFAULT_UNAVAILABLE', 'PREFIX_DEFAULT_UNAVAILABLE_SUFFIX', 'XDEFAULT_UNAVAILABLEY'])('%s uses our own built-in text', code => expect(templateErrorText(code)).toBe('The built-in templates aren’t available yet. Please try again later.'));
  it.each(['TEMPLATE_NOT_FOUND', 'TEMPLATE_INVALID'])('%s has a nonempty non-fallback text without the reference brand', code => {
    const text = templateErrorText(code); expect(text.trim().length).toBeGreaterThan(0); expect(text).not.toBe(TEMPLATE_FALLBACK); expect(text).not.toMatch(/xapp/i);
  });
  it('templateError is a StoreError with the code/text and optional diagnostic detail', () => {
    const error = templateError('TEMPLATE_SELECTION_STALE'); expect(error).toBeInstanceOf(StoreError); expect(error.code).toBe('TEMPLATE_SELECTION_STALE'); expect(error.message).toBe('This project or template changed. Refresh it and review your choice again.');
    const detailed = templateError('TEMPLATE_INVALID', 'Diagnostic detail'); expect(detailed).toBeInstanceOf(StoreError); expect(detailed.message).toContain('Diagnostic detail');
  });
});
