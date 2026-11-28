// SPDX-License-Identifier: AGPL-3.0-only
// T09 D39 capture seam (D39 method artifact §5): a test-only Playwright route overlay of the canonical /src/export/pipeline.ts.
// The actual Vite-served module gets one synchronous observation call right after the frame loop's getImageData, before
// rgbaToI420; the same image then goes on unchanged to I420/VideoFrame/encode. The observer copies only predeclared frames.
// No product file, shared helper or config changes; no await, copyTo, prototype wrapper or replacement drawer. Every failure
// keeps the original error first, then archives what was collected before the observer is removed (reviewed r1 flow).
import { expect, type Page, type Route, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { completed, runExport, type Run } from './t16a-support';

export const PIPELINE_PATH = '/src/export/pipeline.ts';
/** Repository source pin of apps/web/src/export/pipeline.ts (D39 method §8). */
export const PIPELINE_SHA256 = 'c676816a683ee80added3d94d762f79730fd56aff370a3d3911f5b77f8694c63';
/** vendor/roboto/Roboto-Bold.ttf, the bundled caption face. */
export const FONT_SHA256 = 'baf44ce81636cc927fc27768437e5da853bac699e8aaf832d042f0dfed29b4b4';
export const ANCHOR = 'const image = ctx.getImageData(0, 0, size.width, size.height);';
const CALL = 'globalThis.__t09AlphaCapture?.observe({ n, k, t, ts, image, size, fps, doc, plan, draws, ctx, o });';
export const INSERTION = `\n${CALL}`;
const OLD_MARKERS = ['__t09AlphaCapture', '__t09EncoderBoundary', 'T09_ENCODER_BOUNDARY', 'T09_PREENCODE'];
/** Deliberate wiring faults for the runner's red phase only; unset in every acceptance run. */
export const WIRING_RED = process.env.T09_D39_WIRING_RED ?? '';
const WIRING_MODES = ['', 'absent-readback', 'preview-substitution', 'wrong-frame', 'wrong-coordinate', 'undetected-control'];
if (!WIRING_MODES.includes(WIRING_RED)) throw new Error(`unknown T09_D39_WIRING_RED ${WIRING_RED}`);

export const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
export class D39CaptureRed extends Error {
  constructor(readonly problems: string[]) { super(`D39_CAPTURE_WIRING_RED: ${problems.slice(0, 12).join('; ')}`); this.name = 'D39_CAPTURE_WIRING_RED'; }
}

type Receipt = { url: string; status: number; contentType: string; originalSha256: string; overlaySha256: string; anchorAt: number; sourceMap: 'absent' | 'matches-source' };
export type Overlay = { installed: boolean; receipts: Receipt[]; variants: string[]; errors: string[]; original?: string; overlay?: string; dispose: () => Promise<void> };

/** Registers the exact-module overlay. Call before the test's first navigation. */
export async function installPipelineOverlay(page: Page, info: TestInfo): Promise<Overlay> {
  const source = readFileSync(new URL('../../apps/web/src/export/pipeline.ts', import.meta.url));
  if (sha256(source) !== PIPELINE_SHA256) throw new D39CaptureRed([`pipeline source drift: ${sha256(source)}`]);
  const o: Overlay = { installed: false, receipts: [], variants: [], errors: [], dispose: async () => undefined };
  if (WIRING_RED === 'absent-readback') return o;
  const match = (url: URL) => url.pathname === PIPELINE_PATH;
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.search) { o.variants.push(url.href); return route.continue(); }
    try {
      const response = await route.fetch(), original = await response.text(), at = original.indexOf(ANCHOR);
      const problems: string[] = [];
      if (response.status() !== 200) problems.push(`status ${response.status()}`);
      if (at < 0 || original.indexOf(ANCHOR, at + 1) >= 0) problems.push('readback anchor missing or not unique');
      for (const m of OLD_MARKERS) if (original.includes(m)) problems.push(`old or foreign overlay marker ${m}`);
      // Vite's inline source map carries the served module's source text: it must be the pinned repository file.
      const map = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(original);
      let sourceMap: Receipt['sourceMap'] = 'absent';
      if (map) {
        const content = JSON.parse(Buffer.from(map[1], 'base64').toString('utf8')).sourcesContent?.[0];
        if (typeof content === 'string' && sha256(content) === PIPELINE_SHA256) sourceMap = 'matches-source';
        else problems.push('served source map does not carry the pinned pipeline source');
      }
      if (problems.length) { o.errors.push(...problems); return route.fulfill({ response }); }
      const overlay = original.slice(0, at + ANCHOR.length) + INSERTION + original.slice(at + ANCHOR.length);
      if (overlay.split(INSERTION).length !== 2 || overlay.replace(INSERTION, '') !== original) { o.errors.push('insertion is not reversible byte for byte'); return route.fulfill({ response }); }
      const receipt: Receipt = { url: url.href, status: response.status(), contentType: response.headers()['content-type'] ?? '', originalSha256: sha256(original), overlaySha256: sha256(overlay), anchorAt: at, sourceMap };
      if (!o.original) {
        o.original = original; o.overlay = overlay;
        writeFileSync(info.outputPath('pipeline-served-original.js'), original, { flag: 'wx' });
        writeFileSync(info.outputPath('pipeline-served-overlay.js'), overlay, { flag: 'wx' });
      }
      o.receipts.push(receipt);
      const headers = { ...response.headers() }; delete headers['content-length'];
      return route.fulfill({ response, body: overlay, headers });
    } catch (error) { o.errors.push(`route: ${String((error as Error)?.message ?? error)}`); return route.abort(); }
  };
  await page.route(match, handler);
  o.installed = true; o.dispose = () => page.unroute(match, handler);
  return o;
}

export type Capture = { n: number; k: number; t: number; ts: number; width: number; height: number; colorSpace: string; nonce: string; faces: unknown; draws: Draw[]; rgba: Buffer; sha256: string };
export type Draw = { itemId: string; type: string; kind: string; alpha: number; blend: string; filter: string; path: string };
export type CaptureMeta = { doc: any; plan: { fps: number; first: number; count: number; shiftMs: number }; size: { width: number; height: number }; fps: number; options: Record<string, unknown>; context: Record<string, unknown> | null; faces: unknown; fontSha256: string };
export type Captured = { run: Run; captures: Map<number, Capture>; meta: CaptureMeta };

/** Page side, self-contained (serialized by page.evaluate): arms one observer for one export. */
async function arm(cfg: { frames: number[]; nonce: string; label: string; maxBytes: number }) {
  const g = globalThis as any, KEY = '__t09AlphaCapture';
  if (Object.getOwnPropertyDescriptor(g, KEY)) throw new Error('PRIOR_OBSERVER_STATE');
  const fp = '/src/mg/fonts.ts', pp = '/src/export/pipeline.ts', ep = '/src/export/index.ts';
  const face = (await import(fp)).SANDBOX_FONTS.find((f: any) => f.family === 'Roboto' && f.weight === 700);
  const bytes = Uint8Array.from(atob(String(face?.src ?? '').split(',')[1] ?? ''), (v: string) => v.charCodeAt(0));
  const fontSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
  const pipeline = await import(pp), entry = await import(ep);
  const roboto = () => Array.from((g.document?.fonts ?? []) as Iterable<FontFace>).filter(f => f.family.replace(/["']/g, '') === 'Roboto' && f.weight === '700')
    .map(f => ({ family: f.family.replace(/["']/g, ''), weight: f.weight, style: f.style, status: f.status })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  const want = new Set(cfg.frames), state: any = { label: cfg.label, frames: cfg.frames, calls: 0, next: null, order: [], duplicates: [], bytes: 0, captures: {}, meta: null, failure: null, released: [] };
  const pick = (o: any) => Object.fromEntries(['bitrate', 'range', 'resolution', 'title', 'filename', 'remux', 'forceWasm', 'maxDecoders'].filter(k => o[k] !== undefined).map(k => [k, structuredClone(o[k])]));
  const observe = (e: any) => {
    try {
      state.calls++;
      if (state.next !== null && e.n !== state.next) state.order.push({ expected: state.next, got: e.n });
      state.next = e.n + 1;
      if (!state.meta) state.meta = { doc: structuredClone(e.doc), plan: { ...e.plan }, size: { ...e.size }, fps: e.fps, options: pick(e.o),
        context: e.ctx.getContextAttributes ? { ...e.ctx.getContextAttributes() } : null, faces: roboto(), fontSha256, firstN: e.n };
      if (!want.has(e.n)) return;
      if (state.captures[e.n]) { state.duplicates.push(e.n); return; }
      state.bytes += e.image.data.length;
      if (state.bytes > cfg.maxBytes) throw new Error(`capture exceeds sealed bound ${cfg.maxBytes}`);
      state.captures[e.n] = { n: e.n, k: e.k, t: e.t, ts: e.ts, width: e.image.width, height: e.image.height, colorSpace: e.image.colorSpace, nonce: cfg.nonce, faces: roboto(),
        draws: e.draws.map((d: any) => ({ itemId: d.item.id, type: d.item.type, kind: d.kind, alpha: d.alpha, blend: d.blend, filter: d.filter, path: d.path })),
        rgba: e.image.data.slice() };
    } catch (error) { state.failure = String((error as Error)?.stack ?? error); throw error; }
  };
  Object.defineProperty(g, KEY, { value: { observe, state }, configurable: true });
  const text = String(pipeline.runExport);
  return { overlaid: text.split('__t09AlphaCapture?.observe(').length === 2, entryHasStart: typeof entry.startExport === 'function', fontSha256 };
}
function summary() {
  const s = (globalThis as any).__t09AlphaCapture?.state;
  if (!s) throw new Error('MISSING_OBSERVER_STATE');
  const captures = Object.fromEntries(Object.entries(s.captures).map(([n, c]: [string, any]) => [n, { ...c, rgba: undefined, byteLength: c.rgba?.length ?? null }]));
  return { ...s, captures };
}
function frameBase64(n: number) {
  const c = (globalThis as any).__t09AlphaCapture.state.captures[n], bytes: Uint8ClampedArray = c.rgba; let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function release(n: number) { const s = (globalThis as any).__t09AlphaCapture.state; s.captures[n].rgba = null; s.released.push(n); return true; }
function disarm() {
  delete (globalThis as any).__t09AlphaCapture;
  return { removed: !Object.getOwnPropertyDescriptor(globalThis, '__t09AlphaCapture') };
}

const errorRecord = (error: any) => ({ name: error?.name ?? typeof error, message: String(error?.message ?? error), stack: error?.stack ?? null });

/** Runs one real export through startExport/awaitExport with the observer armed for `frames`, then collects, archives,
 *  disarms and verifies. Returns the completed Run, the owned capture buffers and the observed run metadata. */
export async function captureExport(page: Page, info: TestInfo, overlay: Overlay, id: string, opts: { bitrate?: number; range: { startS: number; endS: number } }, frames: number[], label: string): Promise<Captured> {
  const requested = [...new Set(frames)].sort((a, b) => a - b), nonce = randomUUID();
  const size = await page.evaluate(async id => { const sp = '/src/store/database.ts'; return (await (await import(sp)).projectStore.read(id)).document.size as { width: number; height: number }; }, id);
  const maxBytes = requested.length * size.width * size.height * 4;
  const armed = await page.evaluate(arm, { frames: WIRING_RED === 'wrong-frame' ? requested.map(n => n + 1) : requested, nonce, label, maxBytes });
  let run: Run | undefined, exportError: unknown, exportRejected = false, observed: any = null, cleanup: any = null;
  let collectionStatus = 'not_attempted', cleanupStatus = 'not_attempted';
  const failures: { stage: string; error: unknown }[] = [], archives: Record<string, { file: boolean; attachment: boolean; fallbackLog: boolean }> = {};
  const captures = new Map<number, Capture>(), frameFiles: Record<number, { file: string; sha256: string; bytes: number }> = {};
  const failureSummary = () => ({
    primaryExport: { rejected: exportRejected, exception: exportRejected ? errorRecord(exportError) : null, returnedStatus: run?.status ?? null, returnedError: run?.error ?? null },
    collection: { status: collectionStatus, observed: observed !== null, frames: Object.keys(frameFiles).length },
    cleanup: { status: cleanupStatus, result: cleanup }, archives, failures: failures.map(f => ({ stage: f.stage, error: errorRecord(f.error) })),
  });
  const evidence = () => ({ label, requested, nonce, armed, opts, overlay: { installed: overlay.installed, receipts: overlay.receipts, variants: overlay.variants, errors: overlay.errors },
    run: run ? { ...run, file: run.file ?? null } : null, observed, frameFiles, wiringRed: WIRING_RED || null, ...failureSummary() });
  const archive = async (phase: 'before-cleanup' | 'after-cleanup') => {
    const result: (typeof archives)[string] = archives[phase] = { file: false, attachment: false, fallbackLog: false };
    try { writeFileSync(info.outputPath(`${label}-capture-${phase}.json`), JSON.stringify(evidence(), null, 2), { flag: 'wx' }); result.file = true; }
    catch (error) { failures.push({ stage: `${phase}.file-archive`, error }); }
    try { await info.attach(`${label} D39 capture ${phase}`, { body: JSON.stringify(evidence()), contentType: 'application/json' }); result.attachment = true; }
    catch (error) { failures.push({ stage: `${phase}.attachment-archive`, error }); }
    if (!result.file && !result.attachment) {
      try { console.error(`T09_D39_ARCHIVE_UNAVAILABLE ${JSON.stringify(evidence())}`); result.fallbackLog = true; }
      catch (error) { failures.push({ stage: `${phase}.fallback-log`, error }); }
    }
  };
  try { run = await runExport(page, id, opts); } catch (error) { exportRejected = true; exportError = error; }
  try {
    observed = await page.evaluate(summary);
    // One owned buffer at a time: transport, hash, archive (gzip of the raw RGBA), keep in Node, then release in the page.
    for (const key of Object.keys(observed.captures).map(Number).sort((a, b) => a - b)) {
      const rgba = Buffer.from(await page.evaluate(frameBase64, key), 'base64'), file = info.outputPath(`${label}-frame-${key}.rgba.gz`), c = observed.captures[key];
      writeFileSync(file, gzipSync(rgba), { flag: 'wx' }); frameFiles[key] = { file, sha256: sha256(rgba), bytes: rgba.length };
      captures.set(key, { ...c, rgba, sha256: frameFiles[key].sha256 });
      await page.evaluate(release, key);
    }
    collectionStatus = 'collected';
  } catch (error) { collectionStatus = 'unavailable'; failures.push({ stage: 'observer-collection', error }); }
  try { await archive('before-cleanup'); }
  finally {
    cleanupStatus = 'attempted';
    try { cleanup = await page.evaluate(disarm); cleanupStatus = 'completed'; }
    catch (error) { cleanupStatus = 'unavailable'; failures.push({ stage: 'observer-cleanup', error }); }
    await archive('after-cleanup');
  }
  try { writeFileSync(info.outputPath(`${label}-capture-journal.json`), JSON.stringify(failureSummary(), null, 2), { flag: 'wx' }); }
  catch (error) { failures.push({ stage: 'failure-journal', error }); }
  if (exportRejected || run?.status === 'failed' || failures.length) {
    try { console.error(`T09_D39_CAPTURE_FAILURE ${JSON.stringify(failureSummary())}`); } catch (error) { failures.push({ stage: 'failure-summary-log', error }); }
  }
  if (exportRejected) throw exportError; // The exact original rejection first.
  completed(run!); // A returned failed Run keeps priority over secondary collection/archive/cleanup failures.
  if (failures.length) throw failures[0].error;
  expect(cleanup.removed, 'observer removed').toBe(true);

  if (WIRING_RED === 'preview-substitution') await substitutePreview(page, observed.meta, captures);
  const meta: CaptureMeta = observed.meta, problems: string[] = [];
  if (!overlay.installed) problems.push('pipeline overlay not installed');
  if (!overlay.receipts.length) problems.push('no route receipt for the canonical pipeline module');
  if (overlay.errors.length) problems.push(...overlay.errors.map(e => `route: ${e}`));
  if (overlay.variants.length) problems.push(`ambiguous pipeline module variants: ${overlay.variants.join(', ')}`);
  if (new Set(overlay.receipts.map(r => `${r.originalSha256}/${r.overlaySha256}`)).size > 1) problems.push('route served different module bytes across loads');
  if (!armed.overlaid) problems.push('the live pipeline runExport is not the overlaid module');
  if (!armed.entryHasStart) problems.push('export entry missing');
  if (!meta) problems.push('no actual readback observed');
  else {
    const { plan } = meta, lastN = plan.first + plan.count - 1;
    if (observed.calls !== plan.count) problems.push(`observed ${observed.calls} readbacks for ${plan.count} planned frames`);
    if (observed.order.length || observed.next !== lastN + 1) problems.push(`readbacks not one continuous frame loop: ${JSON.stringify(observed.order.slice(0, 4))} next ${observed.next}`);
    if (meta.plan.first !== (meta as any).firstN) problems.push('first readback is not plan.first');
    if (opts.bitrate !== undefined && meta.options.bitrate !== opts.bitrate) problems.push('export bitrate differs from the requested option');
    if (JSON.stringify(meta.options.range) !== JSON.stringify(opts.range)) problems.push('export range differs from the requested option');
    if (meta.size.width !== size.width || meta.size.height !== size.height) problems.push('export size differs from the project size');
    for (const n of requested) if (n < plan.first || n > lastN) problems.push(`requested frame ${n} outside the plan ${plan.first}…${lastN}`);
  }
  if (observed.failure) problems.push(`observer failure: ${observed.failure}`);
  if (observed.duplicates.length) problems.push(`duplicate captures ${observed.duplicates.join(',')}`);
  const got = [...captures.keys()].sort((a, b) => a - b);
  if (JSON.stringify(got) !== JSON.stringify(requested)) problems.push(`captured frames ${JSON.stringify(got)} differ from requested ${JSON.stringify(requested)}`);
  for (const c of captures.values()) {
    if (c.nonce !== nonce) problems.push(`frame ${c.n}: no receipt from the armed observer`);
    if (!meta) continue;
    const { plan, fps } = meta;
    if (c.k !== c.n - plan.first) problems.push(`frame ${c.n}: k ${c.k}`);
    if (c.t !== c.n / fps * 1000 + plan.shiftMs) problems.push(`frame ${c.n}: plan time ${c.t}`);
    if (c.ts !== (c.n - plan.first) / fps) problems.push(`frame ${c.n}: encoded time ${c.ts}`);
    if (c.width !== meta.size.width || c.height !== meta.size.height || c.rgba.length !== c.width * c.height * 4) problems.push(`frame ${c.n}: dimensions ${c.width}x${c.height}/${c.rgba.length}`);
  }
  if (problems.length) throw new D39CaptureRed(problems);
  return { run: run!, captures, meta };
}

/** Wiring-red only: replaces the captured records by production-composite preview frames, which carry no observer receipt. */
async function substitutePreview(page: Page, meta: CaptureMeta, captures: Map<number, Capture>) {
  for (const c of [...captures.values()]) {
    const rgba: number[] = await page.evaluate(async ({ doc, t, size }) => {
      const mp = '/src/render/model.ts', cp = '/src/render/compositor.ts';
      const plan = (await import(mp)).framePlan(doc, t, size), ctx = new OffscreenCanvas(size.width, size.height).getContext('2d', { willReadFrequently: true })!;
      (await import(cp)).composite(ctx, plan.draws, plan.draws.map(() => null), size, 'black'); return Array.from(ctx.getImageData(0, 0, size.width, size.height).data);
    }, { doc: meta.doc, t: c.t, size: meta.size });
    captures.set(c.n, { ...c, nonce: 'preview', rgba: Buffer.from(rgba) });
  }
}

/** Writes the sealed reference record before the export and returns its hash. */
export function sealReference(info: TestInfo, label: string, record: unknown) {
  const body = JSON.stringify(record);
  writeFileSync(info.outputPath(`${label}-sealed-reference.json`), body, { flag: 'wx' });
  return sha256(body);
}
/** Hash of the measured rows' identity (offsets, M, P) and expected factors, compared with the sealed one. */
export const supportHash = (rows: { at: number; M: number; P: number }[], expected: Record<string, number>) => sha256(JSON.stringify({ rows: rows.map(r => [r.at, r.M, r.P]), expected }));
/** Offsets the measured rows carry; the wrong-coordinate wiring fault moves them one pixel right of the sealed support. */
export const offsetsFor = (support: number[]) => (WIRING_RED === 'wrong-coordinate' ? support.map(at => at + 4) : support);

/** Caption items displayed at t: the caption-draw premise of a measurement. */
export const visibleCaptions = (doc: any, t: number) => doc.items.filter((i: any) => i.type === 'caption' && t >= i.display.from && t < i.display.to);
const GEOMETRY = ['fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderWidth', 'borderColor', 'textAlign', 'opacity', 'scale', 'rotation', 'positionX', 'positionY', 'width', 'height', 'textDecoration'];
/** Render-relevant projection of the visible caption items; `omit` names a control's single whitelisted change. */
export const geometry = (doc: any, t: number, omit: string[] = []) => visibleCaptions(doc, t).map((i: any) => ({ id: i.id, display: i.display, trim: i.trim ?? null,
  details: { text: i.details.text, words: i.details.words.map((w: any) => [w.text, w.startMs, w.endMs]), fontFamily: i.details.fontFamily, renderMode: i.details.renderMode ?? null, renderConfig: i.details.renderConfig ?? null, textAnimation: i.details.textAnimation ?? null },
  properties: Object.fromEntries(GEOMETRY.filter(k => !omit.includes(k)).map(k => [k, i.properties?.[k] ?? null])) }));
export type Box = { x0: number; x1: number; y0: number; y1: number };
/** Independently fixed background-only grid of a frame: outside every given caption box and ink box, dilated 8 px. */
export function backgroundRows(frame: Uint8Array, size: { width: number; height: number }, boxes: Box[]) {
  const step = Math.max(4, Math.floor(size.width / 80)), out: { at: number; rgba: number[] }[] = [];
  for (let y = 0; y < size.height; y += step) for (let x = 0; x < size.width; x += step) {
    if (boxes.some(b => x >= b.x0 - 8 && x <= b.x1 + 8 && y >= b.y0 - 8 && y <= b.y1 + 8)) continue;
    const at = (y * size.width + x) * 4; out.push({ at, rgba: [frame[at], frame[at + 1], frame[at + 2], frame[at + 3]] });
  }
  return out;
}
/** A caption item's stored box. */
export const captionBox = (i: any): Box => {
  const v = (k: string) => i.properties[k]?.defaultValue;
  return { x0: v('positionX'), x1: v('positionX') + v('width'), y0: v('positionY'), y1: v('positionY') + v('height') };
};
