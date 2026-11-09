// SPDX-License-Identifier: AGPL-3.0-only
// T08 silent render failure (review M2): graphicPicture (mg/frames.ts) is the exact picture of a motion graphic for the paused preview, seek, capture and
// export. A graphic that fails to render is asked once more; if it fails again nothing is drawn, the failure names the graphic and its error (the caller
// reports it: captureFrame notRendered, tests/ui/t08-capture-failure.spec.ts) and the preview's error panel gets the message (useGraphicErrors).
// Oracle: T08 notes (a render failure is never silent) and the contract in frames.ts: two attempts, then {itemId, error}. The renderer module is mocked, so
// the render calls are counted exactly; the bitmap decode is stubbed (no browser).
// Review m3 (the coordinator's rule of 2 Nov): static failures (COMPILATION_ERROR, VALIDATION_ERROR, MG_SANDBOX_DENIED, MG_MEMORY_LIMIT,
// UNSUPPORTED_OPTION) are not asked again; MG_WATCHDOG is asked again only for capture; other errors (media, renderer crash: MG_RENDER_FAILED) keep the retry.
// Review m4: graphicFields for no code does not load the renderer.
// Attached video MIME (Author's ruling, 9 Nov: an MG with an attached video asset exports and its video plays): OPFS keeps no MIME type, so the blob URL
// behind getAssetUrl takes the asset row's mimeType, else the blob's own (tests/ui/t08-video-asset-export.spec.ts is the end-to-end proof).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAgain, STATIC_RENDER_CODES } from '../apps/web/src/mg/errors';
import { clearGraphics, graphicAssets, graphicFields, graphicPicture, useGraphicErrors } from '../apps/web/src/mg/frames';
import { MotionGraphicError } from '../apps/web/src/mg/errors';
import { itemDraw } from '../apps/web/src/render/model';
import type { Draw } from '../apps/web/src/render/model';

const h = vi.hoisted(() => ({ render: vi.fn(), compile: vi.fn(), dispose: vi.fn(), created: 0 }));
vi.mock('../apps/web/src/mg/index', () => ({ createMotionGraphicRenderer: () => { h.created++; return { render: h.render, compile: h.compile, dispose: h.dispose }; } }));

const bitmap = { width: 540, height: 960, close: vi.fn() };
beforeEach(() => {
  h.render.mockReset(); h.compile.mockReset(); h.dispose.mockReset(); h.created = 0; bitmap.close.mockReset();
  vi.stubGlobal('Image', class { src = ''; decode = async () => undefined; });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
});
afterEach(() => { clearGraphics(); vi.unstubAllGlobals(); });

const CODE = 'export const G = () => <AbsoluteFill />;';
const props = { positionX: { defaultValue: 0, keyframes: [] }, positionY: { defaultValue: 0, keyframes: [] }, width: { defaultValue: 540, keyframes: [] }, height: { defaultValue: 960, keyframes: [] }, scale: { defaultValue: 1, keyframes: [] } };
const project = (details: Record<string, unknown> = {}) => ({
  schemaVersion: 4, rev: 0, size: { width: 540, height: 960 }, fps: 30, duration: 4000, background: {}, transitions: [], markers: [],
  tracks: [{ id: 'O1', kind: 'overlay' }], layerOrder: [{ type: 'track', id: 'O1' }], groups: {},
  items: [{ id: 'g1', type: 'motionGraphic', trackId: 'O1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000, properties: props, details: { name: 'Lower third', code: CODE, ...details } }],
}) as unknown as Parameters<typeof itemDraw>[0];
const drawAt = (ms = 500, details: Record<string, unknown> = {}) => { const doc = project(details); return itemDraw(doc, doc.items[0], ms) as Draw; };
const store = {} as Parameters<typeof graphicPicture>[0];
const IMAGE = 'data:image/png;base64,AAAA';
const failure = (code = 'MG_RENDER_FAILED', message = 'render failed: boom at frame 12') => new MotionGraphicError(code, message);

describe('graphicPicture: a graphic that renders', () => {
  it('first attempt succeeds: one render call; the picture is the bitmap with its size; no error is recorded', async () => {
    h.render.mockResolvedValue({ image: IMAGE });
    const s = await graphicPicture(store, drawAt());
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(s).toEqual({ image: bitmap, width: 540, height: 960 });
    expect(useGraphicErrors.getState().errors).toEqual({});
  });
  it('the render call carries the graphic\'s code, frame, canvas, fps, length, field values and item box', async () => {
    h.render.mockResolvedValue({ image: IMAGE });
    const d = drawAt(500, { fieldValues: { title: 'Set' } });
    await graphicPicture(store, d);
    const g = d.graphic!;
    // The second argument is the resolver for an id the code does not name as a literal (item 3): one rule for the paused
    // preview, playback, capture and the export.
    expect(h.render).toHaveBeenCalledWith({ code: CODE, frame: g.frame, width: g.canvas.width, height: g.canvas.height, fps: g.fps, durationInFrames: g.durationInFrames,
      fieldValues: { title: 'Set' }, assetMap: {}, itemSize: { width: d.box.W, height: d.box.H } }, expect.any(Function));
  });
});

describe('graphicPicture: a graphic that fails once or twice (never silent)', () => {
  it('fails then succeeds: exactly 2 render calls and a picture; the earlier error does not stay', async () => {
    h.render.mockRejectedValueOnce(failure()).mockResolvedValueOnce({ image: IMAGE });
    useGraphicErrors.setState({ errors: { g1: 'an earlier error' } });
    const s = await graphicPicture(store, drawAt());
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(s).toEqual({ image: bitmap, width: 540, height: 960 });
    expect(useGraphicErrors.getState().errors).toEqual({});
  });
  it('fails twice: exactly 2 render calls (no third), no image; the result names the graphic, its id, the error code and message', async () => {
    h.render.mockRejectedValue(failure());
    const s = await graphicPicture(store, drawAt());
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(s).toEqual({ itemId: 'g1', error: "Motion graphic 'Lower third' (g1) could not be rendered: MG_RENDER_FAILED: render failed: boom at frame 12" });
  });
  it('fails twice: the preview\'s error panel gets the message under the item id', async () => {
    h.render.mockRejectedValue(failure());
    await graphicPicture(store, drawAt());
    expect(useGraphicErrors.getState().errors).toEqual({ g1: 'render failed: boom at frame 12' });
  });
  it('the error of the second attempt is the one reported (the first one is not)', async () => {
    h.render.mockRejectedValueOnce(failure('MG_RENDER_FAILED', 'first')).mockRejectedValueOnce(failure('MG_WATCHDOG', 'second'));
    const s = await graphicPicture(store, drawAt()) as { error: string };
    expect(s.error).toContain('MG_WATCHDOG: second');
    expect(s.error).not.toContain('first');
  });
  it('an error without a string code (a plain Error) is reported with its message only; a non-Error is reported as text', async () => {
    h.render.mockRejectedValue(new Error('sandbox died'));
    expect(await graphicPicture(store, drawAt())).toEqual({ itemId: 'g1', error: "Motion graphic 'Lower third' (g1) could not be rendered: sandbox died" });
    h.render.mockReset(); h.render.mockRejectedValue('plain text');
    expect(await graphicPicture(store, drawAt())).toEqual({ itemId: 'g1', error: "Motion graphic 'Lower third' (g1) could not be rendered: plain text" });
  });
  it('a graphic without a name is called "Motion graphic"', async () => {
    h.render.mockRejectedValue(failure());
    const s = await graphicPicture(store, drawAt(500, { name: undefined })) as { error: string };
    expect(s.error).toMatch(/^Motion graphic 'Motion graphic' \(g1\) could not be rendered: /);
  });
  it('a failing decode counts as a failed attempt (the image data cannot be read): 2 attempts, then the named error', async () => {
    h.render.mockResolvedValue({ image: IMAGE });
    vi.stubGlobal('Image', class { src = ''; decode = async () => { throw new Error('The source image cannot be decoded.'); }; });
    const s = await graphicPicture(store, drawAt()) as { error: string };
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(s.error).toContain('The source image cannot be decoded.');
  });
  it('each call asks again from the start: a later call after two failures renders again and succeeds', async () => {
    h.render.mockRejectedValueOnce(failure()).mockRejectedValueOnce(failure()).mockResolvedValue({ image: IMAGE });
    expect(await graphicPicture(store, drawAt())).toMatchObject({ error: expect.any(String) });
    expect(await graphicPicture(store, drawAt())).toMatchObject({ image: bitmap });
    expect(h.render).toHaveBeenCalledTimes(3);
    expect(useGraphicErrors.getState().errors).toEqual({});
  });
  it('the errors of two graphics are kept apart, and one graphic rendering again clears only its own', async () => {
    const other = (() => { const doc = project(); doc.items[0].id = 'g2'; return itemDraw(doc, doc.items[0], 500) as Draw; })();
    h.render.mockRejectedValue(failure());
    await graphicPicture(store, drawAt()); await graphicPicture(store, other);
    expect(Object.keys(useGraphicErrors.getState().errors).sort()).toEqual(['g1', 'g2']);
    h.render.mockReset(); h.render.mockResolvedValue({ image: IMAGE });
    await graphicPicture(store, drawAt());
    expect(Object.keys(useGraphicErrors.getState().errors)).toEqual(['g2']);
  });
  it('closing the project during a render: a failure the disposal cut short is not the graphic\'s error (nothing is recorded)', async () => {
    let fail!: (e: unknown) => void;
    h.render.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = graphicPicture(store, drawAt());
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledTimes(1));
    clearGraphics();
    fail(failure('MG_RENDER_FAILED', 'disposed'));
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledTimes(2));
    fail(failure('MG_RENDER_FAILED', 'disposed'));
    await pending;
    expect(useGraphicErrors.getState().errors).toEqual({});
  });
});

describe('graphicPicture: which failures are asked again (review m3)', () => {
  const STATIC = ['COMPILATION_ERROR', 'VALIDATION_ERROR', 'MG_SANDBOX_DENIED', 'MG_MEMORY_LIMIT', 'UNSUPPORTED_OPTION'];
  for (const purpose of ['preview', 'capture'] as const) for (const code of STATIC) {
    it(`${code} on a ${purpose} frame fails at once: one render call, the named error`, async () => {
      h.render.mockRejectedValue(failure(code, 'static'));
      const s = await graphicPicture(store, drawAt(), purpose);
      expect(h.render).toHaveBeenCalledTimes(1);
      expect(s).toEqual({ itemId: 'g1', error: `Motion graphic 'Lower third' (g1) could not be rendered: ${code}: static` });
      expect(useGraphicErrors.getState().errors).toEqual({ g1: 'static' });
    });
  }
  it('MG_WATCHDOG on a preview frame (the default) fails at once: one budget, not two', async () => {
    h.render.mockRejectedValue(failure('MG_WATCHDOG', 'runaway'));
    expect(await graphicPicture(store, drawAt())).toMatchObject({ error: expect.stringContaining('MG_WATCHDOG: runaway') });
    expect(h.render).toHaveBeenCalledTimes(1);
  });
  it('MG_WATCHDOG in capture is asked once more: 2 render calls, and a second attempt that renders is the picture', async () => {
    h.render.mockRejectedValue(failure('MG_WATCHDOG', 'runaway'));
    expect(await graphicPicture(store, drawAt(), 'capture')).toMatchObject({ error: expect.stringContaining('MG_WATCHDOG: runaway') });
    expect(h.render).toHaveBeenCalledTimes(2);
    h.render.mockReset(); h.render.mockRejectedValueOnce(failure('MG_WATCHDOG', 'slow once')).mockResolvedValueOnce({ image: IMAGE });
    expect(await graphicPicture(store, drawAt(), 'capture')).toEqual({ image: bitmap, width: 540, height: 960 });
    expect(h.render).toHaveBeenCalledTimes(2);
  });
  for (const purpose of ['preview', 'capture'] as const) {
    it(`a media or renderer failure (MG_RENDER_FAILED, a plain Error) on a ${purpose} frame keeps the one retry`, async () => {
      h.render.mockRejectedValue(failure('MG_RENDER_FAILED', "Asset 'a' could not be loaded within the sandbox asset deadline."));
      await graphicPicture(store, drawAt(), purpose);
      expect(h.render).toHaveBeenCalledTimes(2);
      h.render.mockReset(); h.render.mockRejectedValue(new Error('sandbox died'));
      await graphicPicture(store, drawAt(), purpose);
      expect(h.render).toHaveBeenCalledTimes(2);
    });
  }
  it('a retried failure followed by a static one stops there: 2 calls, the static error reported', async () => {
    h.render.mockRejectedValueOnce(failure('MG_RENDER_FAILED', 'first')).mockRejectedValueOnce(failure('COMPILATION_ERROR', 'second')).mockResolvedValue({ image: IMAGE });
    expect(await graphicPicture(store, drawAt())).toMatchObject({ error: expect.stringContaining('COMPILATION_ERROR: second') });
    expect(h.render).toHaveBeenCalledTimes(2);
  });

  // The rule above is one exported predicate so the parity adapter's frame() applies it too (FU-m1).
  describe('renderAgain, the shared rule (mg/errors.ts)', () => {
    it('lists exactly the static codes the cases above use', () => {
      expect([...STATIC_RENDER_CODES]).toEqual(STATIC);
    });
    for (const code of STATIC) it(`${code}: never asked again, on either purpose`, () => {
      for (const purpose of ['preview', 'capture'] as const) expect(renderAgain(code, 0, purpose)).toBe(false);
    });
    it('MG_WATCHDOG: static on a preview frame, asked again for capture (the default)', () => {
      expect(renderAgain('MG_WATCHDOG', 0, 'preview')).toBe(false);
      expect(renderAgain('MG_WATCHDOG', 0, 'capture')).toBe(true);
      expect(renderAgain('MG_WATCHDOG', 0)).toBe(true);
    });
    it('any other code, and an error with no code, is asked again — once', () => {
      for (const code of ['MG_RENDER_FAILED', 'MG_ASSET_TIMEOUT', undefined]) {
        expect(renderAgain(code, 0), `${code} first`).toBe(true);
        expect(renderAgain(code, 1), `${code} second`).toBe(false);
        expect(renderAgain(code, 2), `${code} third`).toBe(false);
      }
    });
  });
});

describe('graphicFields: a graphic with no code (review m4)', () => {
  for (const code of ['', '   ', '\n\t ']) {
    it(`code ${JSON.stringify(code)} lists no fields without loading the renderer or compiling`, async () => {
      expect(await graphicFields(store, code)).toEqual([]);
      expect(h.created).toBe(0);
      expect(h.compile).not.toHaveBeenCalled();
    });
  }
  it('code is compiled once for its list (the renderer is loaded for it)', async () => {
    h.compile.mockResolvedValue({ fields: [{ name: 'title', defaultValue: 'Hi' }] });
    expect(await graphicFields(store, CODE)).toEqual([{ name: 'title', defaultValue: 'Hi' }]);
    expect(await graphicFields(store, CODE)).toEqual([{ name: 'title', defaultValue: 'Hi' }]);
    expect(h.created).toBe(1);
    expect(h.compile).toHaveBeenCalledTimes(1);
  });
});

describe('graphicPicture: the MIME type of an attached asset\'s URL (Author\'s ruling, 9 Nov)', () => {
  const VIDEO = (id: string) => `export const G = () => <OffthreadVideo src={getAssetUrl('${id}')} muted={true} volume={0} />;`;
  const made: Blob[] = [];
  const attached = (read: Blob, row: unknown) => ({ media: { read: vi.fn(async () => read) }, row: vi.fn(async () => row) }) as unknown as typeof store;
  beforeEach(() => {
    made.length = 0; h.render.mockResolvedValue({ image: IMAGE });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(b => { made.push(b as Blob); return `blob:asset-${made.length}`; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => { graphicAssets([]); vi.mocked(URL.createObjectURL).mockRestore(); vi.mocked(URL.revokeObjectURL).mockRestore(); });

  it('the asset row\'s mimeType types the blob behind the URL (the stored blob\'s type is empty), and the render gets that URL', async () => {
    graphicAssets([{ agentId: 'clip', id: 'a1' }]);
    const s = attached(new Blob(['v'], { type: '' }), { mimeType: 'video/mp4' });
    expect(await graphicPicture(s, drawAt(500, { code: VIDEO('clip') }))).toEqual({ image: bitmap, width: 540, height: 960 });
    expect(made).toHaveLength(1); expect(made[0].type).toBe('video/mp4');
    expect(h.render.mock.calls[0][0].assetMap).toEqual({ clip: 'blob:asset-1' });
    expect(s.media.read).toHaveBeenCalledWith('a1'); expect(s.row).toHaveBeenCalledWith('assets', 'a1');
  });
  it('a row without a mimeType (or no row) keeps the blob\'s own type', async () => {
    graphicAssets([{ agentId: 'clip', id: 'a2' }, { agentId: 'other', id: 'a3' }]);
    await graphicPicture(attached(new Blob(['v'], { type: 'video/webm' }), {}), drawAt(500, { code: VIDEO('clip') }));
    await graphicPicture(attached(new Blob(['v'], { type: 'video/webm' }), undefined), drawAt(500, { code: VIDEO('other') }));
    expect(made.map(b => b.type)).toEqual(['video/webm', 'video/webm']);
  });
  it('the URL of an asset is made once, whatever the number of frames', async () => {
    graphicAssets([{ agentId: 'clip', id: 'a4' }]);
    const s = attached(new Blob(['v'], { type: '' }), { mimeType: 'video/mp4' });
    await graphicPicture(s, drawAt(0, { code: VIDEO('clip') })); await graphicPicture(s, drawAt(500, { code: VIDEO('clip') }));
    expect(made).toHaveLength(1); expect(s.media.read).toHaveBeenCalledTimes(1);
  });
});
