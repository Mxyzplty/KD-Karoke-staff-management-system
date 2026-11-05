// SPDX-License-Identifier: AGPL-3.0-only
// T05 on the T16a export path (export/pipeline.ts runExport + drawSource). Oracles:
//   "written-spec oracle" = T05's brief: every text's faces load before the first frame; a FONT_* failure fails the export
//                           with that code; a text draw is a known picture kind (no source); an unknown kind is CLIENT_BUG
import { describe, it, expect, vi } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';

const fonts = vi.hoisted(() => ({ loadTextFonts: vi.fn() }));
vi.mock('../apps/web/src/text/fonts', () => ({ loadTextFonts: fonts.loadTextFonts }));

import { drawSource, runExport } from '../apps/web/src/export/pipeline';
import { classifyExportError, ExportError } from '../apps/web/src/export/errors';

const textDoc = () => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: 2000, fps: 30, size: { width: 640, height: 360 }, background: { type: 'color', value: 'transparent' },
  transitions: [], markers: [], tracks: [{ id: 'v1', kind: 'video', name: 'v1', muted: false, solo: false, locked: false, hidden: false, volume: 1 }],
  layerOrder: [{ type: 'track', id: 'v1' }],
  items: [{ id: 'txt', type: 'text', trackId: 'v1', display: { from: 0, to: 2000 }, trim: { from: 0, to: 2000 }, sourceDuration: 2000, details: { text: 'Hello', name: 'txt' }, metadata: {} }],
}) as unknown as ProjectDocument;
const store = { library: async () => ({ assets: [] }), media: { read: async () => new Blob() } } as never;
const fontError = (code: string) => Object.assign(new Error(`${code} text`), { code });

describe('T05 export preflight (written-spec oracle: fonts load before the first frame; FONT_* fails the export by name)', () => {
  it.each(['FONT_NOT_FOUND', 'FONT_LOAD_FAILED', 'FONT_DELIVERY_FAILED', 'FONT_TOO_LARGE', 'FONT_NAME_REQUIRED'])('a %s from the preload fails the export with ExportError of that code and its message', async code => {
    fonts.loadTextFonts.mockReset().mockRejectedValue(fontError(code));
    const doc = textDoc();
    const err = await runExport({ store, doc }).catch(e => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err).toMatchObject({ code, message: `${code} text` });
    expect(fonts.loadTextFonts).toHaveBeenCalledTimes(1);
    expect(fonts.loadTextFonts.mock.calls[0][0].items.map((i: { id: string }) => i.id)).toEqual(['txt']);
  });
  it('the thrown FONT_* error classifies to the §12 row (never CLIENT_BUG / UNKNOWN)', async () => {
    fonts.loadTextFonts.mockReset().mockRejectedValue(fontError('FONT_NOT_FOUND'));
    const err = await runExport({ store, doc: textDoc() }).catch(e => e);
    expect(classifyExportError(err)).toMatchObject({ code: 'FONT_NOT_FOUND', kind: 'user_fixable' });
  });
  it('an error without a FONT_ code is rethrown unchanged (not wrapped as ExportError)', async () => {
    const boom = new Error('network gone');
    fonts.loadTextFonts.mockReset().mockRejectedValue(boom);
    expect(await runExport({ store, doc: textDoc() }).catch(e => e)).toBe(boom);
  });
  it('a non-FONT_ code is rethrown unchanged too', async () => {
    const e0 = fontError('DECODE_ERROR');
    fonts.loadTextFonts.mockReset().mockRejectedValue(e0);
    expect(await runExport({ store, doc: textDoc() }).catch(e => e)).toBe(e0);
  });
  it('the preload runs before the frame loop: when it resolves the run goes on (an abort raised inside it stops the export right after it)', async () => {
    const ac = new AbortController();
    fonts.loadTextFonts.mockReset().mockImplementation(async () => { ac.abort(); return ['Noto Sans SC']; });
    const err = await runExport({ store, doc: textDoc(), signal: ac.signal }).catch(e => e);
    expect(fonts.loadTextFonts).toHaveBeenCalledTimes(1);
    expect((err as { name?: string }).name).toBe('AbortError');
  });
  it('no text item still calls the preload with the document and the export range (it filters texts itself)', async () => {
    const ac = new AbortController();
    fonts.loadTextFonts.mockReset().mockImplementation(async () => { ac.abort(); return []; });
    await runExport({ store, doc: textDoc(), signal: ac.signal }).catch(() => undefined);
    expect(fonts.loadTextFonts).toHaveBeenCalledWith(expect.objectContaining({ items: expect.any(Array) }), undefined);
  });
  it('a range export hands the same range to the preload (so it loads only the texts the range draws)', async () => {
    const ac = new AbortController();
    fonts.loadTextFonts.mockReset().mockImplementation(async () => { ac.abort(); return []; });
    await runExport({ store, doc: textDoc(), range: { startS: 0.5, endS: 1.5 }, signal: ac.signal }).catch(() => undefined);
    expect(fonts.loadTextFonts).toHaveBeenCalledWith(expect.objectContaining({ items: expect.any(Array) }), { startS: 0.5, endS: 1.5 });
  });
});

describe('T05 drawSource (written-spec oracle: text is a picture kind with no source; unknown kinds stay CLIENT_BUG)', () => {
  const run = (d: unknown) => {
    const refOf = vi.fn(), frame = vi.fn();
    return { p: drawSource({} as never, d as never, refOf as never, { frame } as never, new Set(), undefined), refOf, frame };
  };
  it('a text draw resolves null (the compositor draws it); refOf and the decoders are never called', async () => {
    const { p, refOf, frame } = run({ kind: 'text', item: { id: 't1' } });
    await expect(p).resolves.toBeNull();
    expect(refOf).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
  });
  it('an unknown kind still rejects with CLIENT_BUG naming the item and the kind', async () => {
    const { p, refOf } = run({ kind: 'sparkle', item: { id: 'x9' } });
    await expect(p).rejects.toMatchObject({ code: 'CLIENT_BUG', message: expect.stringMatching(/x9.*'sparkle'/) });
    expect(refOf).not.toHaveBeenCalled();
  });
});
