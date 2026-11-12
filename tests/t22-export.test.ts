// SPDX-License-Identifier: AGPL-3.0-only
// T22 E3/E5: real element placement/frame plans reach known export picture branches; bound-title FONT_* failures propagate.
// Oracle: the written export contract. No browser, helper or real font. The tiny bitmap stand-in tests dispatch, not pixels.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectStore } from '../apps/web/src/store/database';
import { emptyDocument } from '../apps/web/src/store/model';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';

const fonts = vi.hoisted(() => ({ loadTextFonts: vi.fn() }));
vi.mock('../apps/web/src/text/fonts', () => ({ loadTextFonts: fonts.loadTextFonts }));

import { findElement } from '../apps/web/src/catalogue/elements';
import { placeElement } from '../apps/web/src/catalogue/place';
import { drawSource, runExport } from '../apps/web/src/export/pipeline';
import { ExportError } from '../apps/web/src/export/errors';
import { framePlan } from '../apps/web/src/render/model';
import { clearSources } from '../apps/web/src/render/sources';

beforeEach(() => { fonts.loadTextFonts.mockReset(); });
afterEach(() => { clearSources(); vi.unstubAllGlobals(); });
const SIZE = { width: 320, height: 180 }, MS = 200;
const prop = (defaultValue: unknown) => ({ defaultValue, keyframes: [] });
function document(items: RecordData[]): ProjectDocument {
  const tracks = [
    { id: 'V1', name: 'V1', kind: 'video' as const, hidden: false, locked: false, muted: false, solo: false, volume: 1 },
    { id: 'O1', name: 'O1', kind: 'overlay' as const, hidden: false, locked: false, muted: false, solo: false, volume: 1 },
  ];
  return { ...emptyDocument(), duration: MS, fps: 30, size: SIZE, tracks, layerOrder: tracks.map(t => ({ type: 'track' as const, id: t.id })), items };
}
const TITLES_FONT = 'T22UnavailableTitles-Bold';
// The record binding is not an argument of runExport: this is its document, with the bound key and chosen titles face.
const DEFAULTS = { templateId: 't22-export-unloadable', epoch: 3, captionsFont: 'Roboto-Bold', titlesFont: TITLES_FONT, accentFont: 'Roboto-Regular', palette: [{ name: 'Ink', hex: '#111111' }] };
function boundTitle(): ProjectDocument {
  const doc = document([{ id: 'template-title', type: 'text', trackId: 'O1', display: { from: 0, to: MS }, details: { text: 'Latin template title', fontFamily: TITLES_FONT, fontFamilyDisplay: 'T22 Unavailable Titles' },
    properties: { positionX: prop(30), positionY: prop(40), width: prop(260), height: prop(80), fontSize: prop(36), fontWeight: prop(700), color: prop('#ffffff'), opacity: prop(1), scale: prop(1) } }]);
  doc.templateDefaults = structuredClone(DEFAULTS); return doc;
}

describe('T22 export drawSource: placed elements are known picture kinds, not CLIENT_BUG or video decodes', () => {
  it.each([
    { id: 'sticker-star', type: 'image', trackId: 'V1', kinds: ['image'] },
    { id: 'label-tag', type: 'text', trackId: 'O1', kinds: ['image', 'text'] },
    { id: 'phone-frame', type: 'layout', trackId: 'O1', kinds: ['layout', 'image'] },
  ])('$id: placeElement builds a $type item and every planned draw resolves through its known picture branch', async ({ id, type, trackId, kinds }) => {
    const assetId = `cpu-picture-${id}`, item = placeElement(findElement(id)!, SIZE, { trackId, assetId, duration: MS, bounds: { x: 40, y: 20, width: 120, height: 120 } });
    if (type === 'text') item.details.text = 'Unit label';
    expect(item.type).toBe(type); expect(item.details.element.id).toBe(id); const doc = document([item]), plan = framePlan(doc, 100, SIZE);
    expect(plan.pending).toEqual([]); expect(plan.draws.map(d => d.kind)).toEqual(kinds);
    const bitmap = { width: 64, height: 64, close: vi.fn() } as unknown as ImageBitmap;
    const decode = vi.fn(async () => bitmap); vi.stubGlobal('createImageBitmap', decode);
    const read = vi.fn(async () => new Blob(['CPU picture fixture'], { type: 'image/png' })), store = { media: { read } } as unknown as ProjectStore;
    const refOf = vi.fn(), frame = vi.fn(), owned: ImageBitmap[] = [];
    const sources = await Promise.all(plan.draws.map(draw => drawSource(store, draw, refOf as never, { frame } as never, new Set(), undefined, owned)));
    for (const [index, draw] of plan.draws.entries()) {
      if (draw.kind === 'image') expect(sources[index]).toEqual({ image: bitmap, width: 64, height: 64 });
      else if (draw.kind === 'text') expect(sources[index]).toBeNull();
      else expect(sources[index]).toEqual({ cells: [null] }); // phone-frame's single empty media opening
    }
    expect(read).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledWith(assetId); expect(decode).toHaveBeenCalledOnce();
    expect(refOf).not.toHaveBeenCalled(); expect(frame).not.toHaveBeenCalled(); expect(owned).toEqual([]); expect(fonts.loadTextFonts).not.toHaveBeenCalled();
  });
});

describe('T22 E5: a bound project cannot silently export with a substitute titles font', () => {
  it.each(['FONT_NOT_FOUND', 'FONT_LOAD_FAILED', 'FONT_DELIVERY_FAILED', 'FONT_TOO_LARGE', 'FONT_NAME_REQUIRED'])('%s from preloading the template titles font fails runExport with that ExportError code and message', async code => {
    const doc = boundTitle(), before = structuredClone(doc), message = `${code}: the bound titles face could not load`, failure = Object.assign(new Error(message), { code });
    fonts.loadTextFonts.mockRejectedValue(failure);
    const store = { library: async () => ({ assets: [], folders: [], links: [] }), media: { read: vi.fn() } } as unknown as ProjectStore;
    const error = await runExport({ store, doc }).catch(caught => caught);
    expect(error).toBeInstanceOf(ExportError); expect(error).toMatchObject({ code, message }); expect(fonts.loadTextFonts).toHaveBeenCalledOnce();
    const [loaded, range] = fonts.loadTextFonts.mock.calls[0]; expect(range).toBeUndefined(); expect(loaded.templateDefaults).toEqual(DEFAULTS);
    expect(loaded.items).toHaveLength(1); expect(loaded.items[0]).toMatchObject({ id: 'template-title', type: 'text', details: { fontFamily: TITLES_FONT } }); expect(doc).toEqual(before);
  });
});
