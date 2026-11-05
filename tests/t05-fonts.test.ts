// SPDX-License-Identifier: AGPL-3.0-only
// T05 font loader paths that need the export item set or the DOM font APIs:
//   m2 — loadTextFonts loads only the texts the export draws (a shown track, within the range), never a hidden or
//        out-of-range text.
//   m3 — a chain font (emoji / CJK) that fails to load is remembered for the session, so the preview stops re-fetching it
//        on every frame; coming back online clears the memory and the next redraw retries.
// Oracle: the written contract (notes §7 and the R2 findings), not the code output.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { build, mkItem, mkTrack, resetIds } from './t03-fixtures';

// The online listener is attached at module load, so window must exist before fonts.ts is imported (hoisted).
const env = vi.hoisted(() => {
  const listeners: Record<string, () => void> = {};
  (globalThis as { window?: unknown }).window = { addEventListener: (e: string, cb: () => void) => { listeners[e] = cb; }, removeEventListener: () => {} };
  return { listeners };
});
const reg = vi.hoisted(() => ({ itemFonts: vi.fn(() => [] as unknown[]), loadUserFonts: vi.fn(async () => {}) }));
vi.mock('../apps/web/src/text/font-registry', async orig => ({ ...await orig<typeof import('../apps/web/src/text/font-registry')>(), itemFonts: reg.itemFonts, loadUserFonts: reg.loadUserFonts }));

import { CJK_NOTICE, loadChainFonts, loadTextFonts, requestFonts } from '../apps/web/src/text/fonts';

class FakeFontFace { status = 'unloaded'; constructor(public family: string, public source: unknown, public descriptors: unknown = {}) {} async load() { this.status = 'loaded'; return this; } }
const flush = () => new Promise(r => setTimeout(r, 0));
const g = globalThis as { document?: unknown; FontFace?: unknown; fetch?: unknown };

beforeEach(() => {
  reg.itemFonts.mockReset().mockReturnValue([]);
  reg.loadUserFonts.mockReset().mockResolvedValue(undefined);
  g.FontFace = FakeFontFace;
  g.document = { fonts: { add() {}, delete() {}, async load() { return []; } } };
  g.fetch = vi.fn(async () => { throw new Error('offline'); });
});
afterEach(() => { resetIds(); delete g.document; delete g.FontFace; delete g.fetch; });

describe('m2 loadTextFonts: only the texts the export draws (a shown track, within the range)', () => {
  const doc = (): ProjectDocument => build({
    tracks: [mkTrack('O1', 'overlay'), mkTrack('H1', 'overlay', { hidden: true }), mkTrack('O2', 'overlay')],
    items: [
      mkItem('a', 'O1', 0, 2000, { type: 'text', details: { text: 'A' } }),
      mkItem('b', 'H1', 0, 2000, { type: 'text', details: { text: 'B' } }),
      mkItem('c', 'O2', 3000, 4000, { type: 'text', details: { text: 'C' } }),
    ],
  });
  const loaded = () => reg.itemFonts.mock.calls.map(c => ((c as unknown[])[0] as { details: { text: string } }).details.text).sort();

  it('a hidden track is skipped; the shown tracks are loaded (no range)', async () => {
    await loadTextFonts(doc());
    expect(loaded()).toEqual(['A', 'C']);
  });
  it('with a range, an out-of-range text is skipped too (only the drawn one loads)', async () => {
    await loadTextFonts(doc(), { startS: 0, endS: 1 });
    expect(loaded()).toEqual(['A']);
  });
});

describe('m3 a failed chain font is remembered for the session (retry only on online / reload)', () => {
  const textItem = { type: 'text', details: { text: '你好' } } as unknown as Parameters<typeof requestFonts>[0];
  it('the preview requests a failed CJK font once, not every frame; coming online clears the memory and it retries', async () => {
    requestFonts(textItem, '你好'); await flush();
    expect(g.fetch).toHaveBeenCalledTimes(1);                 // first attempt
    requestFonts(textItem, '你好'); await flush();
    expect(g.fetch).toHaveBeenCalledTimes(1);                 // remembered failure: no re-fetch on the next frame
    env.listeners.online(); await flush();                    // back online clears the memory
    requestFonts(textItem, '你好'); await flush();
    expect(g.fetch).toHaveBeenCalledTimes(2);                 // retried
  });
  it('loadChainFonts (the export path) still attempts every time and returns the CJK notice on failure', async () => {
    expect(await loadChainFonts('你好')).toEqual([CJK_NOTICE]);
    expect(g.fetch).toHaveBeenCalled();
  });
});
