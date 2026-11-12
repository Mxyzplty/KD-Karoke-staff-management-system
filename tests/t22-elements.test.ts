// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 2: pure element placement and the authored element / sound catalogues.
// Oracle: findings part 2 §33, T22 notes' Step 2 maths table and record shapes (R-1..R-4), plan A13/A15/S3,
// and error-code rows 105/108/112. C-gt: expected numbers below use those formulas and authored data only,
// never placement(), placeElement() or another helper from catalogue/place.ts. Documents and options store ms.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ELEMENTS, elementTrackKind, findElement } from '../apps/web/src/catalogue/elements';
import type { CatalogueElement, Frac } from '../apps/web/src/catalogue/elements';
import { placement, placeElement } from '../apps/web/src/catalogue/place';
import type { PlaceOptions } from '../apps/web/src/catalogue/place';
import { SOUNDS, findSound } from '../apps/web/src/catalogue/sounds';
import { CommandError } from '../apps/web/src/timeline/model';
import type { Cell } from '../apps/web/src/timeline/layouts';

const PORTRAIT = { width: 1080, height: 1920 }, LANDSCAPE = { width: 1920, height: 1080 };
const BOUNDS = { x: 37, y: 83, width: 360, height: 240 };
const TRACK = 'track_element', ASSET = 'asset_element';
const repoFile = (file: string) => new URL(`../${file}`, import.meta.url);
// Local spelling of the stored-property envelope; no production property helper supplies expectations.
const stored = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { defaultValue: value, keyframes: [] }]));
const CELL_DEFAULTS = { source: null, fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 };
function element(id: string): CatalogueElement {
  const e = findElement(id);
  if (!e) throw new Error(`Missing authored element ${id}`);
  return e;
}
function textSlot(e: CatalogueElement) {
  if (e.slot?.kind !== 'text') throw new Error(`${e.id} needs its authored text slot`);
  return e.slot;
}
function mediaSlot(e: CatalogueElement) {
  if (e.slot?.kind !== 'media') throw new Error(`${e.id} needs its authored media slot`);
  return e.slot;
}
function expectCommandError(run: () => unknown, code: string, message: string) {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(CommandError);
  expect(error).toMatchObject({ code, message, error: message });
}

// Worked A15 rectangles, as (x, y, width, height); label-tag's slot height is 160/240 = 2/3.
//  1 star, portrait, no bounds: s=min(648/512,768/512)=1.265625 -> (216,636,648,648); no font.
//  2 star, portrait, bounds: s=min(360/512,240/512)=0.46875 -> (37,83,240,240); no font.
//  3 star, landscape, no bounds: s=min(1152/512,432/512)=0.84375 -> (744,324,432,432); no font.
//  4 star, landscape, bounds: s=0.46875 -> (37,83,240,240); no font.
//  5 tag, portrait, no bounds: s=min(648/720,768/240)=0.9 -> (216,852,648,216); round(216*2/3*.55)=79 -> 48.
//  6 tag, portrait, bounds: s=min(360/720,240/240)=0.5 -> (37,83,360,120); round(120*2/3*.55)=44 -> 44.
//  7 tag, landscape, no bounds: s=min(1152/720,432/240)=1.6 -> (384,348,1152,384); round(384*2/3*.55)=141 -> 48.
//  8 tag, landscape, bounds: s=0.5 -> (37,83,360,120); round(120*2/3*.55)=44 -> 44.
//  9 phone, portrait, no bounds: s=min(648/540,768/1080)=32/45 -> (348,576,384,768); no font.
// 10 phone, portrait, bounds: s=min(360/540,240/1080)=2/9 -> (37,83,120,240); no font.
// 11 phone, landscape, no bounds: s=min(1152/540,432/1080)=0.4 -> (852,324,216,432); no font.
// 12 phone, landscape, bounds: s=2/9 -> (37,83,120,240); no font.
const A15_ELEMENTS = [
  { id: 'sticker-star', type: 'image', width: 512, height: 512 },
  { id: 'label-tag', type: 'text', width: 720, height: 240 },
  { id: 'phone-frame', type: 'layout', width: 540, height: 1080 },
] as const;

describe('A15: §33 placement and stored item, 3 elements × bounds/no bounds × 2 canvases', () => {
  for (const spec of A15_ELEMENTS) for (const canvas of [PORTRAIT, LANDSCAPE]) for (const bounded of [false, true]) {
    it(`${spec.id}, ${canvas.width} × ${canvas.height}, ${bounded ? 'with' : 'without'} bounds`, () => {
      const e = element(spec.id), opts: PlaceOptions = bounded ? { bounds: BOUNDS } : {};
      expect([e.width, e.height]).toEqual([spec.width, spec.height]);
      // §33: fit the supplied positive sides, else fit 60% W × 40% H; R-1: bounds use their top-left.
      const s = bounded ? Math.min(360 / e.width, 240 / e.height) : Math.min(0.6 * canvas.width / e.width, 0.4 * canvas.height / e.height);
      const width = e.width * s, height = e.height * s;
      const rect = { x: bounded ? 37 : (canvas.width - width) / 2, y: bounded ? 83 : (canvas.height - height) / 2, width, height };
      const got = placement(e, canvas, opts);
      expect(got).toMatchObject({ type: spec.type, rect, stretched: false, display: { from: 0, to: 3000 } });
      expect(got.rect).toEqual(rect);
      const item = placeElement(e, canvas, { ...opts, trackId: TRACK, assetId: ASSET, name: 'Placed element' });
      expect(item).toMatchObject({ type: spec.type, trackId: TRACK, display: { from: 0, to: 3000 }, metadata: { assetId: ASSET } });

      if (spec.type === 'image') {
        expect(got.text).toBeUndefined(); expect(got.cells).toBeUndefined();
        expect(item.properties).toEqual(stored({ width: e.width, height: e.height, scale: s, positionX: rect.x, positionY: rect.y }));
        expect(item.details.element).toEqual({ id: e.id, palette: e.palette });
        expect(item).toMatchObject({ playbackRate: 1, details: { name: 'Placed element' }, masks: [], effects: [] });
      } else if (spec.type === 'text') {
        const slot = textSlot(e);
        expect(slot.box).toEqual({ x: 60 / 720, y: 40 / 240, width: 600 / 720, height: 160 / 240 });
        expect(slot).toMatchObject({ fontFamily: 'Manrope', fontWeight: 700 });
        const box = { x: rect.x + slot.box.x * width, y: rect.y + slot.box.y * height, width: slot.box.width * width, height: slot.box.height * height };
        const fontSize = Math.min(48, Math.max(8, Math.round(height * slot.box.height * 0.55)));
        expect(got.text).toEqual({ box, fontSize, color: '#111111', textAlign: 'center', fontFamily: slot.fontFamily, fontWeight: slot.fontWeight });
        expect(got.cells).toBeUndefined();
        expect(item.properties).toMatchObject(stored({ positionX: box.x, positionY: box.y, width: box.width, height: box.height,
          fontSize, fontWeight: slot.fontWeight, color: '#111111', textAlign: 'center' }));
        expect(item.details.text).toBe('');
        expect(item.details.element).toEqual({ id: e.id, palette: e.palette, slot: 'text' });
      } else {
        const openings = mediaSlot(e).openings;
        expect(openings).toEqual([{ x: 30 / 540, y: 90 / 1080, width: 480 / 540, height: 900 / 1080 }]);
        expect(got.cells).toEqual(openings); expect(got.text).toBeUndefined();
        expect(item.properties).toEqual(stored({ positionX: rect.x, positionY: rect.y, width, height, scale: 1, rotation: 0, opacity: 1 }));
        expect(item.details.element).toEqual({ id: e.id, palette: e.palette, slot: 'media' });
        const cells = item.details.cells as Cell[];
        expect(cells).toHaveLength(openings.length);
        cells.forEach((cell, k) => expect(cell).toMatchObject({ bounds: openings[k], ...CELL_DEFAULTS }));
      }
    });
  }
});

describe('§33 fit / stretch: positive supplied sides only, no rectangle rounding', () => {
  const cases: { label: string; id: string; bounds: NonNullable<PlaceOptions['bounds']>; stretched: boolean }[] = [
    { label: 'text element, width only: 360/720 -> 360 × 120', id: 'label-tag', bounds: { x: 11, y: 19, width: 360 }, stretched: false },
    { label: 'text element, height only: 90/240 -> 270 × 90', id: 'label-tag', bounds: { x: 11, y: 19, height: 90 }, stretched: false },
    { label: 'non-stretch element, both sides: min(360/720,240/240) -> 360 × 120', id: 'label-tag', bounds: { x: 11, y: 19, width: 360, height: 240 }, stretched: false },
    { label: 'fractional width: 101.5/720 -> 101.5 × (240*101.5/720), never rounded', id: 'label-tag', bounds: { x: 11.25, y: -19.5, width: 101.5 }, stretched: false },
    { label: 'stretch element, both sides -> the exact 300 × 75 bounds', id: 'underline-scribble', bounds: { x: 11, y: 19, width: 300, height: 75 }, stretched: true },
    { label: 'stretch element, width only: 300/800 -> 300 × 45, still fit', id: 'underline-scribble', bounds: { x: 11, y: 19, width: 300 }, stretched: false },
    { label: 'stretch element, height only: 75/120 -> 500 × 75, still fit', id: 'underline-scribble', bounds: { x: 11, y: 19, height: 75 }, stretched: false },
    { label: 'zero width is ignored when height is positive', id: 'label-tag', bounds: { x: 11, y: 19, width: 0, height: 90 }, stretched: false },
    { label: 'negative height is ignored when width is positive', id: 'label-tag', bounds: { x: 11, y: 19, width: 360, height: -1 }, stretched: false },
  ];
  it.each(cases)('$label', ({ id, bounds, stretched }) => {
    const e = element(id);
    if (id === 'underline-scribble') expect(e.stretch).toBe(true);
    const ratios = [bounds.width !== undefined && bounds.width > 0 ? bounds.width / e.width : Infinity,
      bounds.height !== undefined && bounds.height > 0 ? bounds.height / e.height : Infinity];
    const s = Math.min(...ratios);
    const width = stretched ? bounds.width! : e.width * s, height = stretched ? bounds.height! : e.height * s;
    const rect = { x: bounds.x, y: bounds.y, width, height };
    const got = placement(e, PORTRAIT, { bounds });
    expect(got.rect).toEqual(rect); expect(got.stretched).toBe(stretched);
    const item = placeElement(e, PORTRAIT, { bounds, trackId: TRACK, assetId: ASSET });
    if (id === 'underline-scribble') {
      expect(item.type).toBe('image');
      expect(item.properties).toEqual(stored({ width: stretched ? width : e.width, height: stretched ? height : e.height,
        scale: stretched ? 1 : s, positionX: bounds.x, positionY: bounds.y }));
      expect(item.details.element).toEqual({ id: e.id, palette: e.palette, stretch: true });
    }
  });
});

describe('§33 text-slot font-size clamp and explicit colour', () => {
  // label-tag: slot H = 2/3. Placed H 12 -> round(4.4)=4 -> 8;
  // H 60 -> round(22)=22; H 240 -> round(88)=88 -> 48.
  it.each([[12, 8], [60, 22], [240, 48]])('placed height %i gives font size %i', (height, literalFontSize) => {
    const e = element('label-tag'), slot = textSlot(e), bounds = { x: 5, y: 7, height };
    const placedHeight = e.height * (height / e.height);
    const expected = Math.min(48, Math.max(8, Math.round(placedHeight * slot.box.height * 0.55)));
    expect(expected).toBe(literalFontSize);
    expect(placement(e, PORTRAIT, { bounds }).text?.fontSize).toBe(expected);
    expect(placeElement(e, PORTRAIT, { bounds, trackId: TRACK, assetId: ASSET }).properties.fontSize).toEqual({ defaultValue: expected, keyframes: [] });
  });
  it('a slot colour overrides #111111; an omitted alignment still defaults to center', () => {
    const e = element('ribbon-banner');
    expect(textSlot(e).color).toBe('#FFFFFF');
    expect(placement(e, PORTRAIT).text).toMatchObject({ color: '#FFFFFF', textAlign: 'center' });
    expect(placeElement(e, PORTRAIT, { trackId: TRACK, assetId: ASSET }).properties).toMatchObject(stored({ color: '#FFFFFF', textAlign: 'center' }));
  });
});

describe('§33 time defaults and explicit ms', () => {
  it.each(A15_ELEMENTS)('$id: omitted options mean start 0, duration 3000 ms', ({ id }) => {
    const e = element(id);
    expect(placement(e, PORTRAIT).display).toEqual({ from: 0, to: 3000 });
    expect(placeElement(e, PORTRAIT, { trackId: TRACK, assetId: ASSET }).display).toEqual({ from: 0, to: 3000 });
  });
  it.each(A15_ELEMENTS)('$id: explicit start 1250 and duration 750 mean [1250, 2000)', ({ id }) => {
    const e = element(id), opts = { timelineStart: 1250, duration: 750 };
    expect(placement(e, LANDSCAPE, opts).display).toEqual({ from: 1250, to: 2000 });
    expect(placeElement(e, LANDSCAPE, { ...opts, trackId: TRACK, assetId: ASSET }).display).toEqual({ from: 1250, to: 2000 });
  });
  it('start and duration default independently, and a positive sub-frame duration is not a text-tool limit', () => {
    const e = element('label-tag');
    for (const [opts, display] of [
      [{ timelineStart: 2500 }, { from: 2500, to: 5500 }],
      [{ duration: 1 }, { from: 0, to: 1 }],
    ] as const) {
      expect(placement(e, PORTRAIT, opts).display).toEqual(display);
      expect(placeElement(e, PORTRAIT, { ...opts, trackId: TRACK, assetId: ASSET }).display).toEqual(display);
    }
  });
});

describe('A13 / R-3: pieces and multiple media openings survive the record', () => {
  it('pieces are carried, not placed independently: the whole authored element box is fit and centred', () => {
    const multipart = ELEMENTS.filter(e => e.pieces?.length);
    expect(multipart.length).toBeGreaterThan(0);
    for (const e of multipart) {
      const s = Math.min(0.6 * 1080 / e.width, 0.4 * 1920 / e.height), width = e.width * s, height = e.height * s;
      const rect = { x: (1080 - width) / 2, y: (1920 - height) / 2, width, height };
      expect(placement(e, PORTRAIT).rect).toEqual(rect);
      const item = placeElement(e, PORTRAIT, { trackId: TRACK, assetId: ASSET });
      expect(item.type).toBe('image');
      expect(item.details.element).toEqual({ id: e.id, palette: e.palette, pieces: e.pieces });
      expect(item.properties).toEqual(stored({ width: e.width, height: e.height, scale: s, positionX: rect.x, positionY: rect.y }));
    }
  });
  it('a two-opening media slot keeps opening order and the §33 cell defaults', () => {
    const e = element('split-frame'), openings = mediaSlot(e).openings;
    expect(openings).toHaveLength(2);
    expect(placement(e, PORTRAIT).cells).toEqual(openings);
    const item = placeElement(e, PORTRAIT, { trackId: TRACK, assetId: ASSET });
    expect(item.type).toBe('layout');
    expect(item.details.element).toEqual({ id: e.id, palette: e.palette, slot: 'media' });
    expect(item.details.cells).toHaveLength(2);
    (item.details.cells as Cell[]).forEach((cell, k) => expect(cell).toMatchObject({ bounds: openings[k], ...CELL_DEFAULTS }));
  });
});

describe('S3 (step 2): CommandError codes and exact placement-error messages', () => {
  const badBounds: { label: string; bounds: NonNullable<PlaceOptions['bounds']> }[] = [
    { label: 'x NaN', bounds: { x: NaN, y: 0, width: 1 } },
    { label: 'x Infinity', bounds: { x: Infinity, y: 0, width: 1 } },
    { label: 'y NaN', bounds: { x: 0, y: NaN, height: 1 } },
    { label: 'y -Infinity', bounds: { x: 0, y: -Infinity, height: 1 } },
    { label: 'no side', bounds: { x: 0, y: 0 } },
    { label: 'only zero width', bounds: { x: 0, y: 0, width: 0 } },
    { label: 'only negative height', bounds: { x: 0, y: 0, height: -1 } },
    { label: 'both zero', bounds: { x: 0, y: 0, width: 0, height: 0 } },
    { label: 'both non-positive', bounds: { x: 0, y: 0, width: -1, height: -2 } },
  ];
  it.each(badBounds)('INVALID_BOUNDS: $label', ({ bounds }) => {
    const message = 'bounds requires finite x/y coordinates and at least one positive width or height.';
    for (const { id } of A15_ELEMENTS) {
      const e = element(id);
      expectCommandError(() => placement(e, PORTRAIT, { bounds }), 'INVALID_BOUNDS', message);
      expectCommandError(() => placeElement(e, PORTRAIT, { bounds, trackId: TRACK, assetId: ASSET }), 'INVALID_BOUNDS', message);
    }
  });
  // Media wording from error-code rows 108/112 and timeline/items.ts; literal seconds, not fmt() as an oracle.
  it.each([[-1000, '-1'], [-1, '-0.001'], [NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity']] as const)(
    'INVALID_TIMELINE_START: %s ms is shown as %ss', (timelineStart, shown) => {
      const message = `timelineStart must be >= 0. Received: ${shown}s.`;
      for (const { id } of A15_ELEMENTS) {
        const e = element(id);
        expectCommandError(() => placement(e, PORTRAIT, { timelineStart }), 'INVALID_TIMELINE_START', message);
        expectCommandError(() => placeElement(e, PORTRAIT, { timelineStart, trackId: TRACK, assetId: ASSET }), 'INVALID_TIMELINE_START', message);
      }
    });
  it.each([[0, '0'], [-1000, '-1'], [-1, '-0.001'], [NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity']] as const)(
    'INVALID_DURATION: %s ms is shown as %ss', (duration, shown) => {
      const message = `duration must be positive. Received: ${shown}s.`;
      for (const { id } of A15_ELEMENTS) {
        const e = element(id);
        expectCommandError(() => placement(e, PORTRAIT, { duration }), 'INVALID_DURATION', message);
        expectCommandError(() => placeElement(e, PORTRAIT, { duration, trackId: TRACK, assetId: ASSET }), 'INVALID_DURATION', message);
      }
    });
});

describe('ELEMENTS: authored catalogue invariants', () => {
  it('has at least 10 entries, with unique ids sorted by id', () => {
    expect(ELEMENTS.length).toBeGreaterThanOrEqual(10);
    const ids = ELEMENTS.map(e => e.id);
    expect(ids).toEqual([...ids].sort()); expect(new Set(ids).size).toBe(ids.length);
  });
  it('contains a plain element, a text-slot element and a media-slot element', () => {
    expect(ELEMENTS.some(e => !e.slot)).toBe(true);
    expect(ELEMENTS.some(e => e.slot?.kind === 'text')).toBe(true);
    expect(ELEMENTS.some(e => e.slot?.kind === 'media')).toBe(true);
  });
  it('every file exists and its SVG width/height equal the catalogue dimensions', () => {
    for (const e of ELEMENTS) {
      const file = repoFile(e.file);
      expect(existsSync(file), e.id).toBe(true);
      const svgTag = readFileSync(file, 'utf8').match(/<svg\b[^>]*>/i)?.[0];
      expect(svgTag, e.id).toBeDefined();
      const width = svgTag?.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1];
      const height = svgTag?.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1];
      expect(Number(width), e.id).toBe(e.width); expect(Number(height), e.id).toBe(e.height);
      expect(e.width, e.id).toBeGreaterThan(0); expect(e.height, e.id).toBeGreaterThan(0);
    }
  });
  it('every palette has at most two entries, with #RRGGBB bases actually present in the SVG', () => {
    for (const e of ELEMENTS) {
      expect(e.palette.length, e.id).toBeLessThanOrEqual(2);
      const svg = readFileSync(repoFile(e.file), 'utf8').toLowerCase();
      for (const colour of e.palette) {
        expect(colour.base, e.id).toMatch(/^#[0-9a-f]{6}$/i);
        expect(svg, `${e.id}: ${colour.base}`).toContain(colour.base.toLowerCase());
      }
    }
  });
  it('every piece, text box and media opening is a finite 0..1 fraction with positive size', () => {
    for (const e of ELEMENTS) {
      const boxes: Frac[] = [...(e.pieces ?? []), ...(e.slot?.kind === 'text' ? [e.slot.box] : e.slot?.kind === 'media' ? e.slot.openings : [])];
      for (const b of boxes) {
        for (const n of [b.x, b.y, b.width, b.height]) {
          expect(Number.isFinite(n), e.id).toBe(true); expect(n, e.id).toBeGreaterThanOrEqual(0); expect(n, e.id).toBeLessThanOrEqual(1);
        }
        expect(b.width, e.id).toBeGreaterThan(0); expect(b.height, e.id).toBeGreaterThan(0);
        expect(b.x + b.width, e.id).toBeLessThanOrEqual(1); expect(b.y + b.height, e.id).toBeLessThanOrEqual(1);
      }
    }
  });
  it('findElement resolves each bare id, not unknown or element:-prefixed ids', () => {
    for (const e of ELEMENTS) { expect(findElement(e.id)).toEqual(e); expect(findElement(`element:${e.id}`)).toBeUndefined(); }
    expect(findElement('not-an-authored-element')).toBeUndefined();
  });
  it('elementTrackKind routes stickers to video, every other group to overlay', () => {
    expect(element('corner-brackets').group).toBe('sticker');
    expect(elementTrackKind(element('corner-brackets'))).toBe('video');
    for (const e of ELEMENTS) expect(elementTrackKind(e), e.id).toBe(e.group === 'sticker' ? 'video' : 'overlay');
  });
});

describe('SOUNDS: authored catalogue invariants', () => {
  it('has 11 entries, with unique slugs sorted by slug', () => {
    expect(SOUNDS).toHaveLength(11);
    const slugs = SOUNDS.map(s => s.slug);
    expect(slugs).toEqual([...slugs].sort()); expect(new Set(slugs).size).toBe(11);
  });
  it('every file exists and every durationMs is finite and positive (decode equality is a later UI check)', () => {
    for (const sound of SOUNDS) {
      expect(existsSync(repoFile(sound.file)), sound.slug).toBe(true);
      expect(Number.isFinite(sound.durationMs), sound.slug).toBe(true); expect(sound.durationMs, sound.slug).toBeGreaterThan(0);
    }
  });
  it('findSound resolves each bare slug, not unknown or sound:-prefixed slugs', () => {
    for (const sound of SOUNDS) { expect(findSound(sound.slug)).toEqual(sound); expect(findSound(`sound:${sound.slug}`)).toBeUndefined(); }
    expect(findSound('not-an-authored-sound')).toBeUndefined();
  });
});
