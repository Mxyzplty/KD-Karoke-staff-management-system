// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 9 part 2 / OQ-6 revised 05:07: Latin-subset local faces, Google extension, dedup, failure memory and retries.
// Oracle: the pinned Latin range and call/registration contract, not font-loader output. Fresh app modules per test.
// Fake browser font APIs follow T05: status/load and descriptor unicodeRange are observable; no network or glyph rendering.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const SHORT_LATIN = 'u+0-ff,u+131,u+152-153,u+2bb-2bc,u+2c6,u+2da,u+2dc,u+304,u+308,u+329,u+2000-206f,u+20ac,u+2122,u+2191,u+2193,u+2212,u+2215,u+feff,u+fffd';
const EXT = 'U+0100-02BA, U+02BD-02C5', VIET = 'U+0102-0103, U+0110-0111';
const compact = (range: string) => range.replace(/\s+/g, '');
const css = (family = 'Sora', weight = 800, latin = LATIN) => [
  { file: 'latin-ext', range: EXT }, { file: 'vietnamese', range: VIET }, { file: 'latin', range: latin },
].map(({ file, range }) => `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; font-display: swap; src: url(https://fonts.gstatic.com/t22/${file}.woff2) format('woff2'); unicode-range: ${range}; }`).join('\n');
const stylesheet = (body = css()) => new Response(body, { status: 200, headers: { 'content-type': 'text/css' } });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
/** `broken`: a face whose file url contains this text ends in 'error' and its load rejects, as a browser face does for a file it cannot read. */
async function setup(broken?: string) {
  class FakeFontFace {
    status: FontFaceLoadStatus = 'unloaded';
    unicodeRange: string | undefined;
    constructor(public family: string, public source: string | ArrayBuffer, public descriptors: FontFaceDescriptors = {}) { this.unicodeRange = descriptors.unicodeRange; }
    async load() {
      if (broken && typeof this.source === 'string' && this.source.includes(broken)) { this.status = 'error'; throw new Error('A network error occurred.'); }
      this.status = 'loaded'; return this;
    }
  }
  const registered = new Set<FakeFontFace>(), added: FakeFontFace[] = [], deleted: FakeFontFace[] = [];
  // A real FontFaceSet.load loads matching glyph subsets, rather than merely returning registered faces.
  // This parser is fixture-side and independent of bundledCovers/isBundledRange under test.
  const coversCharacter = (face: FakeFontFace, text: string) => {
    if (!face.unicodeRange) return true;
    const points = [...text].map(character => character.codePointAt(0)!);
    return face.unicodeRange.split(',').some(token => {
      const match = /^\s*U\+([0-9a-f?]+)(?:-([0-9a-f]+))?\s*$/i.exec(token);
      if (!match) return false;
      const from = parseInt(match[1].replace(/\?/g, '0'), 16), to = parseInt((match[2] ?? match[1]).replace(/\?/g, 'F'), 16);
      return points.some(point => from <= point && point <= to);
    });
  };
  const fontSet = { add: vi.fn((face: FakeFontFace) => { registered.add(face); added.push(face); }),
    delete: vi.fn((face: FakeFontFace) => { deleted.push(face); return registered.delete(face); }),
    load: vi.fn(async (_spec?: string, text = ' ') => {
      const matching = [...registered].filter(face => coversCharacter(face, text));
      return Promise.all(matching.map(face => face.load()));
    }) };
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => stylesheet());
  vi.stubGlobal('FontFace', FakeFontFace); vi.stubGlobal('document', { fonts: fontSet }); vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const registry = await import('../apps/web/src/text/font-registry'), fonts = await import('../apps/web/src/text/fonts'), bundled = await import('../apps/web/src/catalogue/bundled-fonts');
  return { registry, fonts, bundled, fetch, added, deleted, registered, fontSet };
}
function item(face = 'Sora-ExtraBold') {
  return { id: 'text', type: 'text', details: { text: 'ž', fontFamily: face, fontFamilyDisplay: 'Sora' }, properties: {
    fontWeight: { defaultValue: 800, keyframes: [] }, fontStyle: { defaultValue: 'normal', keyframes: [] }, fontSize: { defaultValue: 48, keyframes: [] },
  } };
}

describe('bundled catalogue and the exact Google Latin unicode block', () => {
  it('LATIN_RANGE is exactly the pinned block, not latin-ext or all of Unicode', async () => expect((await setup()).bundled.LATIN_RANGE).toBe(LATIN));
  it.each([
    { family: 'Sora', italic: false, file: 'Sora-latin.woff2' }, { family: 'Manrope', italic: false, file: 'Manrope-latin.woff2' },
    { family: 'Instrument Serif', italic: false, file: 'InstrumentSerif-Regular-latin.woff2' }, { family: 'Instrument Serif', italic: true, file: 'InstrumentSerif-Italic-latin.woff2' },
  ])('$family italic=$italic has its own local file and range', async ({ family, italic, file }) => {
    const { bundled } = await setup(), found = bundled.bundledFont(family, italic);
    expect(found).toMatchObject({ url: expect.stringContaining(file), unicodeRange: LATIN });
    if (italic) expect(found!.url).not.toBe(bundled.bundledFont(family, false)!.url);
  });
  it.each([{ family: 'Sora', italic: true }, { family: 'Manrope', italic: true }, { family: 'Roboto', italic: false }, { family: 'Poppins', italic: false }])(
    '$family italic=$italic is not a T22 bundle', async ({ family, italic }) => expect((await setup()).bundled.bundledFont(family, italic)).toBeUndefined());
  it.each([{ text: 'abc', expected: true }, { text: '', expected: true }, { text: 'café €', expected: true }, { text: '’', expected: true },
    { text: 'ž', expected: false }, { text: 'ő', expected: false }, { text: 'ğ', expected: false }, { text: 'Ж', expected: false }, { text: '你', expected: false }])(
    'bundledCovers($text) -> $expected', async ({ text, expected }) => expect((await setup()).bundled.bundledCovers(text)).toBe(expected));
  it.each([{ range: LATIN, expected: true }, { range: SHORT_LATIN, expected: true }, { range: ` ${LATIN.toLowerCase().replace(/, /g, ' ,    ')} `, expected: true },
    { range: EXT, expected: false }, { range: undefined, expected: false }])('isBundledRange($range) -> $expected', async ({ range, expected }) => expect((await setup()).bundled.isBundledRange(range)).toBe(expected));
});

describe('Latin load and extension register subsets once, without broadening the bundle range', () => {
  it.each([
    { name: 'Sora-ExtraBold', file: 'Sora-latin.woff2' }, { name: 'Manrope-Bold', file: 'Manrope-latin.woff2' },
    { name: 'InstrumentSerif-Regular', file: 'InstrumentSerif-Regular-latin.woff2' }, { name: 'InstrumentSerif-Italic', file: 'InstrumentSerif-Italic-latin.woff2' },
  ])('$name Latin text adds exactly one loaded bundled face, no fetch/failure', async ({ name, file }) => {
    const e = await setup(), r = e.registry.resolveFont(name)!; await e.fonts.loadFont(r, 'abc');
    expect(e.fetch).not.toHaveBeenCalled(); expect(e.added).toHaveLength(1);
    expect(e.added[0]).toMatchObject({ source: expect.stringContaining(file), unicodeRange: LATIN, status: 'loaded' }); expect(e.registry.fontFailure(r)).toBeNull();
  });
  it('Sora outside Latin: one face-specific Google stylesheet, bundled plus two other subsets, no duplicate Latin face', async () => {
    const e = await setup(), r = e.registry.resolveFont('Sora', 800)!; await e.fonts.loadFont(r, 'ž');
    // One face per request: family Sora, upright (ital 0), weight 800, display=block.
    expect(e.fetch).toHaveBeenCalledTimes(1); expect(e.fetch.mock.calls[0][0]).toBe('https://fonts.googleapis.com/css2?family=Sora:ital,wght@0,800&display=block');
    expect(e.added).toHaveLength(3); expect(e.added.map(face => compact(face.unicodeRange!)).sort()).toEqual([LATIN, EXT, VIET].map(compact).sort());
    expect(e.added.filter(face => face.unicodeRange === LATIN)).toHaveLength(1); expect(e.registry.fontFailure(r)).toBeNull();
  });
  it('Google Latin is also de-duplicated when its equivalent range uses shorter hex and different case/spacing', async () => {
    const e = await setup(), r = e.registry.resolveFont('Sora', 800)!; e.fetch.mockImplementation(async () => stylesheet(css('Sora', 800, SHORT_LATIN)));
    await e.fonts.loadFont(r, 'ž'); expect(e.added).toHaveLength(3); expect(e.added.map(face => compact(face.unicodeRange!)).sort()).toEqual([LATIN, EXT, VIET].map(compact).sort());
  });
  it('abc then ž extends once; another ž call does not fetch/register again', async () => {
    const e = await setup(), r = e.registry.resolveFont('Sora', 800)!;
    await e.fonts.loadFont(r, 'abc'); expect(e.fetch).not.toHaveBeenCalled(); expect(e.added).toHaveLength(1);
    await e.fonts.loadFont(r, 'ž'); expect(e.fetch).toHaveBeenCalledTimes(1); expect(e.added).toHaveLength(3);
    await e.fonts.loadFont(r, 'ž'); expect(e.fetch).toHaveBeenCalledTimes(1); expect(e.added).toHaveLength(3); expect(e.registered.size).toBe(3);
  });
  it('Latin-only text remains successful when the network would fail', async () => {
    const e = await setup(), r = e.registry.resolveFont('Sora', 800)!; e.fetch.mockRejectedValue(new Error('offline'));
    await expect(e.fonts.loadFont(r, 'café € ’')).resolves.toBeUndefined(); expect(e.fetch).not.toHaveBeenCalled(); expect(e.registry.fontFailure(r)).toBeNull(); expect(e.added).toHaveLength(1);
  });
  it('loadFont without text uses the local subset and never fetches', async () => {
    const e = await setup(), r = e.registry.resolveFont('Sora', 800)!; await e.fonts.loadFont(r);
    expect(e.fetch).not.toHaveBeenCalled(); expect(e.added).toHaveLength(1); expect(e.registry.fontFailure(r)).toBeNull();
  });
  it('requestFonts extends an already registered Latin face when new text requires more glyphs', async () => {
    const e = await setup(), r = e.registry.resolveFont('Sora', 800)!; await e.fonts.loadFont(r, 'abc'); expect(e.fetch).not.toHaveBeenCalled();
    e.fonts.requestFonts(item(), 'ž'); await vi.waitFor(() => expect(e.added).toHaveLength(3));
    expect(e.fetch).toHaveBeenCalledTimes(1); expect(e.registry.fontFailure(r)).toBeNull();
  });
});

describe('Google extension failure is remembered without deleting a usable bundled face', () => {
  it('ž failure is the remembered FontError; the bundle stays registered and preview does not refetch', async () => {
    const e = await setup(), r = e.registry.resolveFont('Sora', 800)!; e.fetch.mockRejectedValue(new Error('offline'));
    const error = await e.fonts.loadFont(r, 'ž').then(() => null, caught => caught);
    expect(error).toBeInstanceOf(e.registry.FontError); expect(error).toMatchObject({ code: 'FONT_DELIVERY_FAILED' }); expect(e.registry.fontFailure(r)).toBe(error);
    expect(e.fetch).toHaveBeenCalledTimes(1); expect(e.added).toHaveLength(1); expect(e.added[0].unicodeRange).toBe(LATIN);
    expect(e.registered.has(e.added[0])).toBe(true); expect(e.deleted).not.toContain(e.added[0]);
    for (let draw = 0; draw < 5; draw++) e.fonts.requestFonts(item(), 'ž'); await flush(); await flush(); expect(e.fetch).toHaveBeenCalledTimes(1);
  });
  it('an explicit load retries a failed ž extension and clears the remembered error when Google succeeds', async () => {
    const e = await setup(), r = e.registry.resolveFont('Sora', 800)!; e.fetch.mockRejectedValue(new Error('offline'));
    await expect(e.fonts.loadFont(r, 'ž')).rejects.toMatchObject({ code: 'FONT_DELIVERY_FAILED' });
    expect(e.registry.fontFailure(r)).toMatchObject({ code: 'FONT_DELIVERY_FAILED' }); expect(e.fetch).toHaveBeenCalledTimes(1);
    expect(e.added).toHaveLength(1); const bundledFace = e.added[0]; expect(bundledFace.unicodeRange).toBe(LATIN);
    e.fetch.mockImplementation(async () => stylesheet()); await expect(e.fonts.loadFont(r, 'ž')).resolves.toBeUndefined();
    expect(e.fetch).toHaveBeenCalledTimes(2); expect(e.registry.fontFailure(r)).toBeNull(); expect(e.registered.size).toBe(3); expect(e.deleted).not.toContain(bundledFace);
  });
  it('Latin load after a ž failure is successful and clears the failure without another fetch', async () => {
    const e = await setup(), r = e.registry.resolveFont('Sora', 800)!; e.fetch.mockRejectedValue(new Error('offline'));
    await expect(e.fonts.loadFont(r, 'ž')).rejects.toMatchObject({ code: 'FONT_DELIVERY_FAILED' });
    await expect(e.fonts.loadFont(r, 'abc')).resolves.toBeUndefined(); expect(e.fetch).toHaveBeenCalledTimes(1); expect(e.registry.fontFailure(r)).toBeNull();
    expect(e.registered.size).toBe(1); expect(e.deleted).toEqual([]);
  });
});

// Plan E5: a bundled file that cannot be read fails the export's font preload with FONT_LOAD_FAILED. No Google request can
// stand in for the bundled Latin file: the text is Latin, so nothing is fetched.
describe('E5: a bundled face that ends in error fails the export preload', () => {
  const titleDoc = () => {
    const track = { id: 'O1', name: 'O1', kind: 'overlay', hidden: false, locked: false, muted: false, solo: false, volume: 1 };
    return { schemaVersion: 4, rev: 0, groups: {}, duration: 1000, fps: 30, size: { width: 320, height: 180 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
      tracks: [track], layerOrder: [{ type: 'track', id: 'O1' }], items: [{ ...item(), trackId: 'O1', display: { from: 0, to: 1000 }, details: { text: 'Title', fontFamily: 'Sora-ExtraBold', fontFamilyDisplay: 'Sora' } }] };
  };
  it('loadTextFonts on a Sora title rejects with FONT_LOAD_FAILED when the bundled Sora face ends in error', async () => {
    const e = await setup('Sora-latin'), r = e.registry.resolveFont('Sora', 800)!;
    const error = await e.fonts.loadTextFonts(titleDoc() as never).then(() => null, caught => caught);
    expect(error).toBeInstanceOf(e.registry.FontError); expect(error).toMatchObject({ code: 'FONT_LOAD_FAILED', message: "The font 'Sora-ExtraBold' could not be loaded." });
    expect(e.added).toHaveLength(1); expect(e.added[0]).toMatchObject({ source: expect.stringContaining('Sora-latin.woff2'), status: 'error' });
    // The failed face is taken out again and the failure is remembered for the inspector; Google was not asked.
    expect(e.registered.size).toBe(0); expect(e.registry.fontFailure(r)).toBe(error); expect(e.fetch).not.toHaveBeenCalled();
  });
  it('positive control: the same title loads when the bundled Sora face loads', async () => {
    const e = await setup(); await expect(e.fonts.loadTextFonts(titleDoc() as never)).resolves.toEqual([]);
    expect(e.added).toHaveLength(1); expect(e.added[0]).toMatchObject({ source: expect.stringContaining('Sora-latin.woff2'), status: 'loaded' }); expect(e.fetch).not.toHaveBeenCalled();
  });
});

// Review round 1: the extension belongs to the registration, so a caller that arrives while Google's answer is pending
// waits for the same answer: it never ends with the Latin file only. A failed extension is not kept.
describe('two callers of one bundled face while the Google stylesheet is pending', () => {
  const CYRILLIC = 'U+0400-045F, U+2116', TEXT = 'Привет';
  const withCyrillic = () => `${css('Manrope', 700)}\n@font-face { font-family: 'Manrope'; font-style: normal; font-weight: 700; font-display: swap; src: url(https://fonts.gstatic.com/t22/cyrillic.woff2) format('woff2'); unicode-range: ${CYRILLIC}; }`;
  function hold(e: Awaited<ReturnType<typeof setup>>) {
    const waiting: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
    e.fetch.mockImplementation(() => new Promise<Response>((resolve, reject) => { waiting.push({ resolve, reject }); }));
    return { answer: () => { for (const w of waiting.splice(0)) w.resolve(stylesheet(withCyrillic())); }, fail: () => { for (const w of waiting.splice(0)) w.reject(new Error('offline')); } };
  }
  it('two loadFont calls for one bundled face while Google’s answer is pending both end with the subset faces added', async () => {
    const e = await setup(), r = e.registry.resolveFont('Manrope-Bold')!, google = hold(e), settled = [false, false];
    expect(e.bundled.bundledCovers(TEXT)).toBe(false);
    const calls = [0, 1].map(k => e.fonts.loadFont(r, TEXT).finally(() => { settled[k] = true; }));
    await flush(); await flush();
    expect(e.fetch).toHaveBeenCalledTimes(1); expect(settled, 'neither call ends before Google answers').toEqual([false, false]);
    google.answer(); await expect(Promise.all(calls)).resolves.toEqual([undefined, undefined]);
    const subset = [...e.registered].filter(face => face.unicodeRange === CYRILLIC);
    expect(subset).toHaveLength(1); expect(subset[0].status, 'the face that holds the text is loaded').toBe('loaded');
    // One stylesheet for both callers; the bundled Latin file once, Google's three other subsets once each.
    expect(e.fetch).toHaveBeenCalledTimes(1); expect(e.added).toHaveLength(4); expect(e.registered.size).toBe(4);
    expect(e.added.filter(face => face.unicodeRange === LATIN)).toHaveLength(1); expect(e.deleted).toEqual([]); expect(e.registry.fontFailure(r)).toBeNull();
  });
  it('two loadFont calls for one bundled face while Google’s answer is pending are both refused with the delivery error when Google fails', async () => {
    const e = await setup(), r = e.registry.resolveFont('Manrope-Bold')!, google = hold(e);
    const calls = [0, 1].map(() => e.fonts.loadFont(r, TEXT).then(() => null, caught => caught));
    await flush(); await flush(); expect(e.fetch).toHaveBeenCalledTimes(1);
    google.fail(); const errors = await Promise.all(calls);
    for (const error of errors) { expect(error).toBeInstanceOf(e.registry.FontError); expect(error).toMatchObject({ code: 'FONT_DELIVERY_FAILED' }); }
    // The usable bundled face stays; the failed extension is not kept, so the next call asks Google again.
    expect(e.registered.size).toBe(1); expect([...e.registered][0].unicodeRange).toBe(LATIN); expect(e.deleted).toEqual([]);
    e.fetch.mockImplementation(async () => stylesheet(withCyrillic()));
    await expect(e.fonts.loadFont(r, TEXT)).resolves.toBeUndefined(); expect(e.fetch).toHaveBeenCalledTimes(2);
    expect([...e.registered].filter(face => face.unicodeRange === CYRILLIC)).toHaveLength(1); expect(e.registry.fontFailure(r)).toBeNull();
  });
});

describe('existing Roboto, Google-only and uploaded-font branches remain unchanged', () => {
  it.each([400, 700])('Roboto %i still uses its existing local branch', async weight => {
    const e = await setup(), r = e.registry.resolveFont('Roboto', weight)!; await e.fonts.loadFont(r, 'abc');
    const { SANDBOX_FONTS } = await import('../apps/web/src/mg/fonts');
    const bundled = SANDBOX_FONTS.find(font => font.weight === weight)!;
    // Existing T08 URL is the exact integration oracle: Vitest may inline it as a data URL, without a filename.
    expect(e.fetch).not.toHaveBeenCalled(); expect(e.added).toHaveLength(1); expect(e.added[0].source).toBe(`url(${bundled.src})`); expect(e.registry.fontFailure(r)).toBeNull();
  });
  it('Poppins Latin still fetches Google and registers the stylesheet faces', async () => {
    const e = await setup(), r = e.registry.resolveFont('Poppins', 400)!; e.fetch.mockImplementation(async () => stylesheet(css('Poppins', 400)));
    await e.fonts.loadFont(r, 'abc'); expect(e.fetch).toHaveBeenCalledTimes(1); expect(e.fetch.mock.calls[0][0]).toBe('https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,400&display=block');
    expect(e.added).toHaveLength(3); expect(e.registry.fontFailure(r)).toBeNull();
  });
  it('Poppins delivery failure records FONT_DELIVERY_FAILED and keeps no face', async () => {
    const e = await setup(), r = e.registry.resolveFont('Poppins', 400)!; e.fetch.mockRejectedValue(new Error('offline'));
    const error = await e.fonts.loadFont(r, 'abc').then(() => null, caught => caught);
    expect(error).toBeInstanceOf(e.registry.FontError); expect(error).toMatchObject({ code: 'FONT_DELIVERY_FAILED' }); expect(e.registry.fontFailure(r)).toBe(error); expect(e.registered.size).toBe(0);
  });
  it('an uploaded family loads its stored bytes, not Google or a T22 Latin file', async () => {
    const e = await setup(), names = ['T22 Uploaded', 'T22Uploaded-Regular'], encoded = names.map(name => Uint8Array.from([...name].flatMap(c => [0, c.charCodeAt(0)])));
    const size = 30 + encoded[0].length + encoded[1].length, bytes = new Uint8Array(28 + size), view = new DataView(bytes.buffer);
    view.setUint32(0, 0x10000); view.setUint16(4, 1); view.setUint16(6, 16); view.setUint32(12, 0x6e616d65); view.setUint32(20, 28); view.setUint32(24, size); view.setUint16(30, 2); view.setUint16(32, 30);
    let offset = 0; encoded.forEach((value, k) => { const at = 34 + k * 12; view.setUint16(at, 3); view.setUint16(at + 2, 1); view.setUint16(at + 4, 0x409); view.setUint16(at + 6, k === 0 ? 1 : 6); view.setUint16(at + 8, value.length); view.setUint16(at + 10, offset); bytes.set(value, 58 + offset); offset += value.length; });
    const uploaded = await e.registry.addUserFont(new File([bytes], 'uploaded.ttf', { type: 'font/ttf' }));
    try {
      const r = e.registry.resolveFont(uploaded.family)!; await e.fonts.loadFont(r, 'abc'); expect(e.fetch).not.toHaveBeenCalled(); expect(e.added).toHaveLength(1);
      expect(e.added[0].source).toBeInstanceOf(ArrayBuffer); expect(new Uint8Array(e.added[0].source as ArrayBuffer)).toEqual(bytes); expect(e.registry.fontFailure(r)).toBeNull();
    } finally { await e.registry.removeUserFont(uploaded.sha256); }
  });
});
