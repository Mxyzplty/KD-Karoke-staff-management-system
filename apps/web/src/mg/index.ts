// SPDX-License-Identifier: AGPL-3.0-only
import sandboxSource from './sandbox.generated.js?raw';
import { compileMotionGraphic, type CompiledGraphic } from './compiler';
import { isTrustedCode, MotionGraphicError } from './errors';
import { FrameCache } from './cache';
import { frameWatchdog } from './watchdog';
import { SANDBOX_FONTS } from './fonts';
import type { ElementBox } from './sandbox-entry';
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
export { compileMotionGraphic } from './compiler';
export { graphicFrame, graphicTimeMs } from './clock';
export { patchCode, editMotionGraphicCode, validateSummary } from './edits';
/** width/height: the canvas (useVideoConfig). D25: the graphic is laid out at the item's size (itemWidth/itemHeight), never
 *  scaled. itemSize returns an item-size image; itemBox returns a canvas-size image with the graphic placed at x/y. */
export type RenderOptions = { code: string; frame: number; width: number; height: number; fps?: number; durationInFrames?: number; trimStartMs?: number; designedLengthMs?: number; props?: Record<string, unknown>; fieldValues?: Record<string, unknown>; assetMap?: Record<string, string>; itemSize?: { width: number; height: number }; itemBox?: { x: number; y: number; width: number; height: number } };
type ExecuteOptions = Omit<RenderOptions, 'code' | 'itemSize' | 'itemBox'> & { itemWidth?: number; itemHeight?: number };
export type GraphicImage = { image: string; width: number; height: number; boxes: ElementBox[]; fields: unknown[] };
// The container's frame-src policy also applies when its child navigates itself.
// srcdoc bootstrap is permitted; a subsequent load or policy violation tears the child down.
export function containerDocument(script: string, width: number, height: number): string {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;padding:0;background:transparent}*{box-sizing:border-box}</style>`;
  const inner = `<!doctype html><html><head>${head}</head><body><script nonce="${nonce}">${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
  const outer = `const frame=document.createElement('iframe');frame.sandbox.add('allow-scripts');frame.width=${width};frame.height=${height};frame.style.border='0';let loads=0,reported=false;const report=()=>{if(reported)return;reported=true;frame.remove();parent.postMessage({type:'mg:navigated'},'*');};frame.addEventListener('load',()=>{if(++loads>1)report();});addEventListener('securitypolicyviolation',e=>{if(e.effectiveDirective==='frame-src')report();});frame.srcdoc=${JSON.stringify(inner).replaceAll('<', '\\u003c')};document.body.append(frame);`;
  return `<!doctype html><html><head>${head}</head><body><script nonce="${nonce}">${outer}</script></body></html>`;
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`; return JSON.stringify(value) ?? 'null'; }
async function embeddedAssets(map: Record<string, string>): Promise<Record<string, string>> {
  if (Object.values(map).reduce((bytes, url) => bytes + url.length * 2, 0) > 64 * 1024 * 1024) throw new MotionGraphicError('MG_MEMORY_LIMIT', 'Motion graphic asset map exceeds the memory budget.');
  return Object.fromEntries(await Promise.all(Object.entries(map).map(async ([id, url]) => {
    if (url === '' || url.startsWith('data:')) return [id, url];
    let blob: Blob;
    try {
      const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(1800) }); if (!response.ok || !response.body) throw Error('Asset response is unavailable.');
      const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 32 * 1024 * 1024) { await reader.cancel(); throw new MotionGraphicError('MG_MEMORY_LIMIT', `Asset '${id}' exceeds the 32 MiB sandbox asset budget.`); } chunks.push(value as Uint8Array<ArrayBuffer>); }
      blob = new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
    } catch (error) { if (error instanceof MotionGraphicError) throw error; throw new MotionGraphicError('MG_RENDER_FAILED', `Asset '${id}' could not be loaded within the sandbox asset deadline.`); }
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsDataURL(blob); }); return [id, data];
  })));
}
/** Each video asset's frame starts (seconds, ascending) by asset URL, for the OffthreadVideo hold (video-frame.ts); null
 *  when Mediabunny reads no video track, or not within the asset deadline (a later render can still get them). The 32 blob or
 *  http URLs used last are kept; a read that failed is dropped, so a later render reads again. A data URL would keep its whole
 *  asset alive as the key, so it is read again each render. */
const frameStartsByUrl = new Map<string, Promise<number[] | null>>();
function videoFrameStarts(url: string, data: string): Promise<number[] | null> {
  let starts = frameStartsByUrl.get(url);
  if (starts) { frameStartsByUrl.delete(url); frameStartsByUrl.set(url, starts); }
  else {
    const read: Promise<number[] | null> = (async () => {
      const input = new Input({ source: new BlobSource(await (await fetch(data)).blob()), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack(); if (!track) return null;
        const list: number[] = [];
        for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) list.push(packet.timestamp);
        return list.length ? list.sort((a, b) => a - b) : null;
      } finally { input.dispose(); }
    })().catch(() => { if (frameStartsByUrl.get(url) === read) frameStartsByUrl.delete(url); return null; });
    starts = read;
    if (!url.startsWith('data:')) { frameStartsByUrl.set(url, starts); if (frameStartsByUrl.size > 32) frameStartsByUrl.delete(frameStartsByUrl.keys().next().value!); }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([starts, new Promise<null>(resolve => { timer = setTimeout(resolve, 1800, null); })]).finally(() => clearTimeout(timer));
}
/** A resolver for an asset id the compile-time map does not carry (the host's project assets); undefined: not attached. */
export type ResolveAsset = (agentId: string) => Promise<string | undefined>;
/** Asset ids a code reached through something other than a string literal — a constant, a computed name — learned from the
 *  render-time refusal that names them. Code → ids, the 128 codes rendered last, shared by every renderer so the per-call
 *  ones (renderMotionGraphic, the adapter) do not each pay the extra pass. Cleared with the project (frames.ts). */
const learned = new Map<string, Set<string>>();
function learn(code: string, id: string) {
  const ids = learned.get(code) ?? new Set<string>();
  learned.delete(code); learned.set(code, ids.add(id));
  if (learned.size > 128) learned.delete(learned.keys().next().value!);
}
/** The id a render refused as not attached (runtime-components.tsx getAssetUrl), when the map did not already carry it. */
function unknownAsset(error: unknown, map: Record<string, string>): string | undefined {
  if (!(error instanceof MotionGraphicError) || error.code !== 'VALIDATION_ERROR') return undefined;
  const id = (error.details as { assetId?: unknown } | undefined)?.assetId;
  return typeof id === 'string' && !Object.hasOwn(map, id) ? id : undefined;
}
export function createMotionGraphicRenderer() {
  const cache = new FrameCache<GraphicImage>(); const active = new Set<() => void>(); let disposed = false, queue: Promise<unknown> = Promise.resolve();
  const execute = async (compiled: CompiledGraphic, options: ExecuteOptions, mode: 'compile' | 'render'): Promise<any> => {
    if (disposed) throw new MotionGraphicError('MG_DISPOSED', 'Motion graphic renderer is disposed.');
    if (!Number.isFinite(options.fps ?? 30) || (options.fps ?? 30) <= 0 || (options.fps ?? 30) > 1000) throw new MotionGraphicError('VALIDATION_ERROR', 'Motion graphic fps must be positive and at most 1000.');
    const width = options.itemWidth ?? options.width, height = options.itemHeight ?? options.height;
    if (!Number.isInteger(options.frame) || [options.width, options.height, width, height].some(n => !Number.isInteger(n) || n <= 0) || options.width * options.height > 4096 * 4096 || width * height > 4096 * 4096) throw new MotionGraphicError('MG_MEMORY_LIMIT', 'Motion graphic frame dimensions exceed the memory budget or the frame is not an integer.');
    const assetMap = await embeddedAssets(options.assetMap ?? {}); if (disposed) throw new MotionGraphicError('MG_DISPOSED', 'Motion graphic renderer is disposed.');
    const frameStarts: Record<string, number[]> = {};
    if (mode === 'render') await Promise.all(Object.entries(options.assetMap ?? {}).map(async ([id, url]) => { const starts = url && await videoFrameStarts(url, assetMap[id]); if (starts) frameStarts[id] = starts; }));
    if (disposed) throw new MotionGraphicError('MG_DISPOSED', 'Motion graphic renderer is disposed.');
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe'); iframe.sandbox.add('allow-scripts'); iframe.setAttribute('aria-hidden', 'true'); iframe.style.cssText = 'position:fixed;left:-20000px;top:0;border:0;'; iframe.width = String(width); iframe.height = String(height);
      iframe.srcdoc = containerDocument(sandboxSource, width, height);
      const channel = new MessageChannel(); let done = false;
      const clean = () => { watchdog.stop(); removeEventListener('message', ready); channel.port1.close(); channel.port2.close(); iframe.remove(); active.delete(cancel); };
      const finish = (error?: unknown, result?: unknown) => { if (done) return; done = true; clean(); error ? reject(error) : resolve(result); };
      const cancel = () => finish(new MotionGraphicError('MG_DISPOSED', 'Motion graphic renderer is disposed.'));
      // The sandbox starting up and the frame being serialised are not the graphic's compute: each gets its own budget
      // (watchdog.ts, item 4). Boot runs from here, because appending the iframe parses and evaluates the bundle.
      const watchdog = frameWatchdog(error => finish(error)); watchdog.phase('boot');
      const navigated = () => finish(new MotionGraphicError('MG_SANDBOX_DENIED', 'Navigation from the motion graphic sandbox is blocked.'));
      let readySent = false, loads = 0;
      iframe.addEventListener('load', () => { if (++loads > 1) navigated(); });
      const ready = (e: MessageEvent) => {
        if (e.origin !== 'null') return;
        if (e.source === iframe.contentWindow && e.data?.type === 'mg:navigated') { navigated(); return; }
        if (readySent || e.source !== iframe.contentWindow?.[0] || e.data?.type !== 'mg:ready') return;
        readySent = true; iframe.contentWindow![0].postMessage({ type: 'mg:init', js: compiled.js, options: { ...options, assetMap, frameStarts }, mode, fonts: SANDBOX_FONTS }, '*', [channel.port2]);
        watchdog.phase('compute'); // the sandbox is up: from here the clock is the graphic's own work
      };
      channel.port1.onmessage = e => { const r = e.data; if (r?.type === 'mg:hold' && typeof r.waiting === 'boolean') { watchdog.hold(r.waiting); return; } if (r?.type === 'mg:out') { watchdog.phase('output'); return; } if (r?.ok === true && (mode === 'compile' || typeof r.image === 'string' && r.image.startsWith('data:image/png;base64,') && r.width === width && r.height === height && Array.isArray(r.boxes))) { watchdog.check(); finish(undefined, r); } else if (r?.ok === false && isTrustedCode(r.code) && typeof r.message === 'string') finish(new MotionGraphicError(r.code, r.message, r.details)); else finish(new MotionGraphicError('MG_RENDER_FAILED', 'Invalid sandbox response.')); };
      active.add(cancel); addEventListener('message', ready); document.body.append(iframe);
    });
  };
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const run = queue.then(f, f); queue = run.catch(() => {}); return run; };
  return {
    cache,
    /** fields: the editable fields the dry run declared ({name, defaultValue, meta}; the inspector's Fields section). */
    compile: (code: string, assetMap: Record<string, string> = {}) => serial(async () => { const compiled = compileMotionGraphic(code, assetMap), r = await execute(compiled, { frame: 0, width: 1080, height: 1920, assetMap }, 'compile'); return { ...compiled, fields: Array.isArray(r?.fields) ? r.fields as unknown[] : [] }; }),
    render: (options: RenderOptions, resolve?: ResolveAsset): Promise<GraphicImage> => serial(async () => {
      if (disposed) throw new MotionGraphicError('MG_DISPOSED', 'Motion graphic renderer is disposed.');
      const key = canonical(options), old = cache.get(key); if (old) return structuredClone(old);
      const fps = options.fps ?? 30, frame = Math.max(0, Math.min(Math.round(options.frame + (options.trimStartMs ?? 0) * fps / 1000), options.designedLengthMs === undefined ? Infinity : Math.max(0, Math.ceil(options.designedLengthMs * fps / 1000) - 1)));
      const { code: _code, itemSize, itemBox: b, ...rest } = options, size = b ?? itemSize;
      const item = size ? { itemWidth: Math.max(1, Math.round(size.width)), itemHeight: Math.max(1, Math.round(size.height)) } : {};
      // An id the code does not write as a literal is not in the map, so the sandbox refuses it by name: the host asks the
      // caller for that one id and runs again — at most one new id a pass, so at most as many passes as the ids the code
      // actually reaches. The cache key stays the caller's options, so a learned id never splits the cache; the map's
      // 64 MB cap and the frame-start cache still apply to whatever ends up in it.
      const assetMap: Record<string, string> = { ...(options.assetMap ?? {}) };
      if (resolve) for (const id of learned.get(options.code) ?? []) if (!Object.hasOwn(assetMap, id)) { const url = await resolve(id); if (typeof url === 'string') assetMap[id] = url; }
      let result: any;
      for (;;) {
        try { result = await execute(compileMotionGraphic(options.code, assetMap), { ...rest, assetMap, frame, ...item }, 'render'); break; }
        catch (error) {
          const id = unknownAsset(error, assetMap), url = id === undefined ? undefined : await resolve?.(id);
          if (id === undefined || typeof url !== 'string') throw error;
          assetMap[id] = url; learn(options.code, id);
        }
      }
      delete result.ok;
      if (b) {
        const image = new Image(); image.src = result.image; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = options.width; canvas.height = options.height; canvas.getContext('2d')!.drawImage(image, b.x, b.y);
        result.image = canvas.toDataURL('image/png'); result.width = options.width; result.height = options.height;
        result.boxes = result.boxes.map((box: ElementBox) => ({ ...box, x: b.x + box.x, y: b.y + box.y }));
      }
      // Retained PNG and metadata are charged in bytes; no full timeline arrays are kept.
      cache.set(key, structuredClone(result), key.length * 2 + result.image.length * 2 + JSON.stringify(result.boxes).length * 2 + JSON.stringify(result.fields).length * 2);
      return result;
    }),
    /** Project close (frames.ts clearGraphics): the learned ids go with the project whose assets they name. */
    clearLearnedAssets() { learned.clear(); },
    dispose() { disposed = true; active.forEach(cancel => cancel()); cache.clear(); },
  };
}
export async function renderMotionGraphic(options: RenderOptions, resolve?: ResolveAsset): Promise<GraphicImage> { const renderer = createMotionGraphicRenderer(); try { return await renderer.render(options, resolve); } finally { renderer.dispose(); } }
