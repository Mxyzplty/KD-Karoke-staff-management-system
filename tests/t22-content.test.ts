// SPDX-License-Identifier: AGPL-3.0-only
// T22 catalogue/preset/template content: counts, manifest coverage, bundled licences and authored libraries.
// Oracle: plan §3 A1/A2/A3/A7, §31 and the pinned step-5 content contract; Step 1's four WOFF2 files/three OFL families/eleven CC0 sounds,
// and vendor/manifest.json. Byte counts and SHA-256 are computed from the real files with node:crypto,
// not copied from catalogue code or inferred from manifest metadata. Caption integration/browser sound decode remain later checks.
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ELEMENTS } from '../apps/web/src/catalogue/elements';
import { SOUNDS } from '../apps/web/src/catalogue/sounds';
import { DEFAULT_TEMPLATE, DEFAULT_FILES } from '../apps/web/src/templates/default';
import { BUILT_IN_TEMPLATES } from '../apps/web/src/templates/library';
import { templateProblem } from '../apps/web/src/templates/model';
import { bindTemplate } from '../apps/web/src/templates/binding';
import { findTemplate as findCaptionTemplate } from '../apps/web/src/captions/templates';
import { findFont } from '../apps/web/src/text/font-registry';
import { ProjectStore } from '../apps/web/src/store/database';
import type { MediaStore } from '../apps/web/src/store/media';
import { STYLE_PRESETS } from '../apps/web/src/presets/content';
import { BUILT_IN_MG_PRESETS } from '../apps/web/src/presets/mg-content';
import { stylePresetProblem } from '../apps/web/src/presets/model';
import type { DirectPreset, GraphicStylePreset } from '../apps/web/src/presets/model';
import { applyStylePreset } from '../apps/web/src/presets/apply';
import { presetProblem } from '../apps/web/src/mg/presets';
import { compileMotionGraphic } from '../apps/web/src/mg/compiler';
import { API_NAMES, createRuntime } from '../apps/web/src/mg/runtime';
import { build } from './t03-fixtures';

type ManifestFile = { path: string; bytes: number; sha256: string };
type Component = { name: string; license: string; files: ManifestFile[] };
const repoFile = (file: string) => new URL(`../${file}`, import.meta.url);
const manifest = JSON.parse(readFileSync(repoFile('vendor/manifest.json'), 'utf8')) as { components: Component[] };
const FONT_FILES = [
  'vendor/t22/fonts/Sora-latin.woff2',
  'vendor/t22/fonts/Manrope-latin.woff2',
  'vendor/t22/fonts/InstrumentSerif-Regular-latin.woff2',
  'vendor/t22/fonts/InstrumentSerif-Italic-latin.woff2',
] as const;
const CONTENT_FILES = [...ELEMENTS.map(e => e.file), ...SOUNDS.map(s => s.file), ...FONT_FILES];
const templateStores: ProjectStore[] = [];
afterEach(async () => { for (const store of templateStores.splice(0)) await store.close(); });

describe('A3 (steps 1/2): every referenced element, sound and bundled font is byte-pinned in the vendor manifest', () => {
  it.each(CONTENT_FILES)('%s: exact path, real byte count and real SHA-256', file => {
    const entries = manifest.components.flatMap(component => component.files.filter(entry => entry.path === file));
    expect(entries, file).toHaveLength(1);
    const bytes = readFileSync(repoFile(file));
    expect(entries[0].path).toBe(file);
    expect(entries[0].bytes, file).toBe(bytes.byteLength);
    expect(entries[0].sha256, file).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
  it('covers all four WOFF2 files on disk, not just a hand-picked subset', () => {
    const onDisk = readdirSync(repoFile('vendor/t22/fonts/')).filter(file => file.endsWith('.woff2')).map(file => `vendor/t22/fonts/${file}`);
    expect(onDisk.sort()).toEqual([...FONT_FILES].sort());
  });
});

describe('A7 (step 1): the bundled font components are OFL-1.1 and sound components CC0-1.0', () => {
  it('every component with a vendor/t22/fonts/ file declares OFL-1.1', () => {
    const components = manifest.components.filter(component => component.files.some(file => file.path.startsWith('vendor/t22/fonts/')));
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) expect(component.license, component.name).toBe('OFL-1.1');
  });
  it('every component with a vendor/t22/sounds/ file declares CC0-1.0', () => {
    const components = manifest.components.filter(component => component.files.some(file => file.path.startsWith('vendor/t22/sounds/')));
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) expect(component.license, component.name).toBe('CC0-1.0');
  });
  it.each(['Sora', 'Manrope', 'InstrumentSerif'])('%s has its own OFL.txt on disk', family => {
    // Step 1 uses family-prefixed names in the shared fonts directory, not family subdirectories.
    const file = `vendor/t22/fonts/${family}-OFL.txt`;
    expect(existsSync(repoFile(file)), file).toBe(true);
    expect(readFileSync(repoFile(file), 'utf8').length, file).toBeGreaterThan(0);
  });
});

describe('A1: SR-17 content counts (catalogues, presets and project templates)', () => {
  it('ships at least 10 authored elements', () => expect(ELEMENTS.length).toBeGreaterThanOrEqual(10));
  it('A1: at least 14 style presets over the six required categories, with unique ids', () => {
    expect(STYLE_PRESETS.length).toBeGreaterThanOrEqual(14); expect(new Set(STYLE_PRESETS.map(p => p.id)).size).toBe(STYLE_PRESETS.length);
    for (const category of ['text', 'lower-thirds', 'info-cards', 'slide-in-panels', 'misc', 'collages']) expect(STYLE_PRESETS.some(p => p.id.split('/')[0] === category), category).toBe(true);
  });
  it('A1: at least 10 built-in motion-graphic presets, with unique ids', () => {
    expect(BUILT_IN_MG_PRESETS.length).toBeGreaterThanOrEqual(10); expect(new Set(BUILT_IN_MG_PRESETS.map(p => p.id)).size).toBe(BUILT_IN_MG_PRESETS.length);
  });
  it('A1: at least one valid built-in project template, with resolvable preset/caption/catalogue/font references', () => {
    expect(BUILT_IN_TEMPLATES.length).toBeGreaterThanOrEqual(1); expect(BUILT_IN_TEMPLATES).toContainEqual(DEFAULT_TEMPLATE);
    const presetIds = new Set(STYLE_PRESETS.map(p => p.id));
    for (const t of BUILT_IN_TEMPLATES) {
      expect(templateProblem(t), t.id).toBeNull(); expect(findCaptionTemplate(t.captionTemplateId ?? ''), t.id).toBeDefined();
      for (const id of t.presetIds) expect(presetIds.has(id), `${t.id}: ${id}`).toBe(true);
      for (const name of Object.values(t.defaults)) expect(findFont(name), `${t.id}: ${name}`).not.toBeNull();
      for (const { ref } of [...t.examples, ...t.assets.fonts, ...t.assets.audio, ...t.assets.images]) {
        const colon = ref.indexOf(':'), kind = ref.slice(0, colon), id = ref.slice(colon + 1);
        if (kind === 'preset') expect(presetIds.has(id), ref).toBe(true);
        if (kind === 'element') expect(ELEMENTS.some(e => e.id === id), ref).toBe(true);
        if (kind === 'sound') expect(SOUNDS.some(sound => sound.slug === id), ref).toBe(true);
        if (kind === 'font') expect(findFont(id), ref).not.toBeNull();
      }
    }
  });
  it.todo('A1: all nine existing caption template ids resolve (template/font integration steps)');
});

describe('A3/A7/A2: our default project template files, content identity and binding', () => {
  it('uses our name/fonts/palette/sound collection, not the reference default content', () => {
    expect(DEFAULT_TEMPLATE.name).not.toBe('Xapp Default'); expect(DEFAULT_TEMPLATE.name).not.toMatch(/xapp/i);
    for (const name of Object.values(DEFAULT_TEMPLATE.defaults)) {
      const found = findFont(name); expect(found, name).not.toBeNull(); expect(['Inter', 'Montserrat', 'DM Serif Display']).not.toContain(found!.entry.family);
    }
    for (const swatch of DEFAULT_TEMPLATE.palette) {
      expect(['white', 'paper', 'sky']).not.toContain(swatch.name.toLowerCase()); expect(['#FFFFFF', '#F7F6F2', '#8BBCDF']).not.toContain(swatch.hex.toUpperCase());
    }
    expect(DEFAULT_TEMPLATE.assets.audio.length).not.toBe(25);
  });
  it('every default font/sound file has the required manifest licence', () => {
    for (const file of DEFAULT_FILES) if (file.path.startsWith('vendor/t22/fonts/') || file.path.startsWith('vendor/t22/sounds/')) {
      const owners = manifest.components.filter(component => component.files.some(entry => entry.path === file.path)); expect(owners, file.path).toHaveLength(1);
      expect(owners[0].license, file.path).toBe(file.path.startsWith('vendor/t22/fonts/') ? 'OFL-1.1' : 'CC0-1.0');
    }
  });
  it.each(DEFAULT_FILES)('$path: default path/hash equal the manifest and the real SHA-256', file => {
    const entries = manifest.components.flatMap(component => component.files.filter(entry => entry.path === file.path)); expect(entries, file.path).toHaveLength(1);
    expect(entries[0].sha256).toBe(file.sha256); expect(createHash('sha256').update(readFileSync(repoFile(file.path))).digest('hex')).toBe(file.sha256);
  });
  it('DEFAULT_FILES covers every sound/element ref and at least one independently identified file per font family', () => {
    const paths = new Set(DEFAULT_FILES.map(file => file.path)); expect(paths.size).toBe(DEFAULT_FILES.length);
    // Step 1's documented file/family association, not a font-loader implementation lookup.
    const fontPaths: Record<string, string[]> = { Manrope: ['vendor/t22/fonts/Manrope-latin.woff2'], Sora: ['vendor/t22/fonts/Sora-latin.woff2'],
      'Instrument Serif': ['vendor/t22/fonts/InstrumentSerif-Regular-latin.woff2', 'vendor/t22/fonts/InstrumentSerif-Italic-latin.woff2'] };
    for (const { ref } of [...DEFAULT_TEMPLATE.examples, ...DEFAULT_TEMPLATE.assets.fonts, ...DEFAULT_TEMPLATE.assets.audio, ...DEFAULT_TEMPLATE.assets.images]) {
      const colon = ref.indexOf(':'), kind = ref.slice(0, colon), id = ref.slice(colon + 1);
      if (kind === 'sound') expect(paths.has(SOUNDS.find(sound => sound.slug === id)!.file), ref).toBe(true);
      if (kind === 'element') expect(paths.has(ELEMENTS.find(element => element.id === id)!.file), ref).toBe(true);
      if (kind === 'font') { const family = findFont(id)!.entry.family; expect(fontPaths[family], family).toBeDefined(); expect(fontPaths[family].some(path => paths.has(path)), family).toBe(true); }
    }
  });
  it('A2: the default template binds to a fresh project', async () => {
    const bytes = new Map<string, Blob>(), media: MediaStore = { write: vi.fn(async (id, blob) => { bytes.set(id, blob); }), read: vi.fn(async id => bytes.get(id)!), remove: vi.fn(async () => {}) };
    const store = new ProjectStore(crypto.randomUUID(), () => Date.now(), media); templateStores.push(store); const project = await store.create('Default binding');
    expect(await bindTemplate(store, project.id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'default-content' })).toEqual({ epoch: 1, templateId: DEFAULT_TEMPLATE.id });
  });
});

describe('A1/A2: every authored style and built-in MG preset is valid and usable', () => {
  it.each(STYLE_PRESETS)('$id has a valid shape and a 118..430-character description', p => {
    expect(stylePresetProblem(p), p.id).toBeNull(); expect(p.description.length, p.id).toBeGreaterThanOrEqual(118); expect(p.description.length, p.id).toBeLessThanOrEqual(430);
  });
  it.each(BUILT_IN_MG_PRESETS)('$id passes T08 presetProblem', p => expect(presetProblem(p), p.id).toBeNull());
  for (const p of STYLE_PRESETS) for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) it(`${p.id} applies on ${canvas.width}×${canvas.height}`, () => {
    const doc = build({ extra: { size: canvas } });
    const items = applyStylePreset(doc, p, 0); expect(items.length).toBeGreaterThan(0); expect(doc.items).toHaveLength(items.length);
  });
  const graphicStyles = STYLE_PRESETS.filter(p => typeof (p as GraphicStylePreset).mg_code === 'string') as GraphicStylePreset[];
  const codeRows = [...graphicStyles, ...BUILT_IN_MG_PRESETS].flatMap(p => [{ id: p.id, variant: 'mg_code', code: p.mg_code },
    ...(p.mg_code_h ? [{ id: p.id, variant: 'mg_code_h', code: p.mg_code_h }] : [])]);
  it.each(codeRows)('$id $variant compiles without error', ({ code }) => expect(() => compileMotionGraphic(code)).not.toThrow());
  it.each(codeRows)('$id $variant renders finite static markup at four frames × three boxes', ({ id, code }) => {
    const compiled = compileMotionGraphic(code);
    for (const frame of [0, 10, 45, 149]) {
      for (const box of [{ width: 540, height: 1920 }, { width: 600, height: 300 }, { width: 1080, height: 30 }]) {
        const api: Record<string, any> = createRuntime({ frame, itemWidth: box.width, itemHeight: box.height, dryRun: true });
        const Component = new Function(...API_NAMES, '__mgKey', '__mgTick', compiled.js)(...API_NAMES.map(name => api[name]), (key: unknown) => key, () => {}) as React.ComponentType;
        const html = renderToStaticMarkup(React.createElement(Component));
        expect(html, `${id}, frame${frame}, ${box.width}×${box.height}`).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
  });
  it('all preset text is our own, direct fonts are approved, and MG code names only Roboto', () => {
    for (const p of [...STYLE_PRESETS, ...BUILT_IN_MG_PRESETS]) expect(JSON.stringify(p), p.id).not.toMatch(/xapp/i);
    for (const p of STYLE_PRESETS) for (const item of (p as DirectPreset).items ?? []) if (item.type === 'text' && item.details.fontFamily !== undefined)
      expect(['Roboto', 'Manrope', 'Sora', 'Instrument Serif'], p.id).toContain(item.details.fontFamily);
    for (const { id, code } of codeRows) {
      const named = [...code.matchAll(/fontFamily\s*:\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
      for (const family of named) expect(family, id).toBe('Roboto');
    }
  });
});

describe('A13 C-gt: settled from code, RC 6.1, no stored output — pieces drawing is not built because it is unreachable with this catalogue', () => {
  it('no catalogue element has both pieces and stretch, so spare-space pieces drawing is unreachable', () => {
    expect(ELEMENTS.filter(element => element.pieces?.length && element.stretch)).toEqual([]);
  });
  it('every multipart element spans 0..1 on both axes, to 1e-9', () => {
    const multipart = ELEMENTS.filter(element => element.pieces?.length);
    expect(multipart.length).toBeGreaterThan(0);
    for (const element of multipart) {
      const pieces = element.pieces!;
      const x = Math.min(...pieces.map(piece => piece.x)), y = Math.min(...pieces.map(piece => piece.y));
      const right = Math.max(...pieces.map(piece => piece.x + piece.width)), bottom = Math.max(...pieces.map(piece => piece.y + piece.height));
      for (const [got, expected] of [[x, 0], [y, 0], [right, 1], [bottom, 1]]) expect(Math.abs(got - expected), element.id).toBeLessThanOrEqual(1e-9);
      expect(Math.abs((right - x) * element.width - element.width), element.id).toBeLessThanOrEqual(1e-9);
      expect(Math.abs((bottom - y) * element.height - element.height), element.id).toBeLessThanOrEqual(1e-9);
    }
  });
  it('every SVG width, height and viewBox size equal the catalogue size (viewBox origins need not be zero)', () => {
    for (const element of ELEMENTS) {
      const tag = readFileSync(repoFile(element.file), 'utf8').match(/<svg\b[^>]*>/i)?.[0];
      expect(tag, element.id).toBeDefined();
      const width = Number(tag?.match(/\bwidth=["']([^"']+)["']/i)?.[1]), height = Number(tag?.match(/\bheight=["']([^"']+)["']/i)?.[1]);
      const viewBox = tag?.match(/\bviewBox=["']([^"']+)["']/i)?.[1].trim().split(/[\s,]+/).map(Number);
      expect([width, height], element.id).toEqual([element.width, element.height]);
      expect(viewBox, element.id).toHaveLength(4); expect(viewBox?.slice(2), element.id).toEqual([element.width, element.height]);
    }
  });
  it.todo('Later UI: each catalogue sound decodes in the browser and its durationMs equals the decoded length');
});
