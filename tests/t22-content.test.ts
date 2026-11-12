// SPDX-License-Identifier: AGPL-3.0-only
// T22 steps 1/2 only: content counts, manifest coverage and bundled font / sound licences.
// Oracle: plan §3 A1/A3/A7, T22 notes Step 1 (four WOFF2 files, three OFL families, eleven CC0 sounds),
// and vendor/manifest.json. Byte counts and SHA-256 are computed from the real files with node:crypto,
// not copied from catalogue code or inferred from manifest metadata. Presets/templates are deferred below.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ELEMENTS } from '../apps/web/src/catalogue/elements';
import { SOUNDS } from '../apps/web/src/catalogue/sounds';

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

describe('A1: SR-17 content counts (catalogue step now; preset/template steps later)', () => {
  it('ships at least 10 authored elements', () => expect(ELEMENTS.length).toBeGreaterThanOrEqual(10));
  it.todo('A1: at least 14 style presets over the six required categories (step 5)');
  it.todo('A1: at least 10 built-in motion-graphic presets (step 5)');
  it.todo('A1: at least one default project template (step 8)');
  it.todo('A1: all nine existing caption template ids resolve (template/font integration steps)');
});

describe('Lane A 01:36 ruling: the element box is the bounding box of its pieces', () => {
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
