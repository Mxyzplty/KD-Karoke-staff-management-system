// SPDX-License-Identifier: AGPL-3.0-only
// Bundled by build-sandbox.ts; executed only in an opaque-origin scripts-only iframe.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createRuntime } from './runtime';
import { trustedError } from './errors';
import { apply, appendChild, checkFault, checkFrames, createElement, currentFault, fail, installGuards, now, onScheduled, scope, timeout } from './sandbox-guards';
import { currentFrame } from './video-frame';

const host = parent.parent, nonce = (document.currentScript as HTMLScriptElement).nonce;
const send = MessagePort.prototype.postMessage;
const computedStyle = getComputedStyle.bind(globalThis), Serializer = XMLSerializer, Canvas = HTMLCanvasElement, Video = HTMLVideoElement;
const create = (name: string) => apply(createElement, document, [name]);
installGuards();
function walk(element: unknown, depth = 0): void {
  if (depth > 30 || element === null || typeof element !== 'object') return;
  if (Array.isArray(element)) { for (const child of element) walk(child, depth + 1); return; }
  if (React.isValidElement(element)) {
    const e = element as React.ReactElement<any>;
    if (typeof e.type === 'function') walk((e.type as any)(e.props), depth + 1);
    else if (e.type && typeof e.type === 'object' && 'type' in e.type) walk(React.createElement((e.type as any).type, e.props), depth + 1);
    else if (e.type && typeof e.type === 'object' && 'render' in e.type) walk((e.type as any).render(e.props, null), depth + 1);
    else walk(e.props.children, depth + 1);
  }
}
export type ElementBox = { tag: string; id: string | null; x: number; y: number; width: number; height: number };
const elementLimit = 2000;
function measure(root: HTMLElement): ElementBox[] {
  const elements = root.querySelectorAll('*');
  if (elements.length > elementLimit) fail('MG_MEMORY_LIMIT', `Motion graphic exceeds the ${elementLimit} element budget.`);
  const r = root.getBoundingClientRect();
  return Array.from(elements, e => { const b = e.getBoundingClientRect(); return { tag: e.tagName.toLowerCase(), id: e.id || null, x: b.x - r.x, y: b.y - r.y, width: b.width, height: b.height }; });
}
// Bundled faces (fonts.ts). Loaded into the document before graphic code runs; the @font-face rules travel in each
// rasterised SVG, which cannot see document fonts.
type SandboxFont = { family: string; weight: number; src: string };
let fontFaces = '';
async function loadFonts(fonts: unknown): Promise<void> {
  const valid = Array.isArray(fonts) && fonts.length <= 8 && fonts.every(f => f && typeof f.family === 'string' && /^[A-Za-z0-9 ]{1,64}$/.test(f.family) && Number.isInteger(f.weight) && f.weight >= 100 && f.weight <= 900 && typeof f.src === 'string' && /^data:(font\/|application\/(font|x-font|octet-stream))/.test(f.src));
  if (!valid) fail('MG_RENDER_FAILED', 'Sandbox fonts are invalid.');
  try { await Promise.all((fonts as SandboxFont[]).map(async f => { const face = new FontFace(f.family, `url(${f.src})`, { weight: String(f.weight) }); await face.load(); document.fonts.add(face); })); }
  catch { fail('MG_RENDER_FAILED', 'A sandbox font could not be loaded.'); }
  fontFaces = (fonts as SandboxFont[]).map(f => `@font-face{font-family:"${f.family}";font-weight:${f.weight};src:url(${f.src});}`).join('');
}
async function rasterise(root: HTMLElement, width: number, height: number, tick: () => void): Promise<string> {
  await document.fonts.ready;
  const clone = root.cloneNode(true) as HTMLElement, originals = [root, ...root.querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
  const names = Array.from(computedStyle(root)).filter(name => !name.startsWith('--'));
  const baselines = new Map<string, string[]>(), values = new Map<Element, string[]>();
  const baselineRoot = create('div'); baselineRoot.style.cssText = 'position:fixed;visibility:hidden;'; document.body.append(baselineRoot);
  for (let i = 0; i < originals.length; i++) {
    if (i % 64 === 0) tick();
    const source = originals[i] as HTMLElement, target = copies[i] as HTMLElement, computed = computedStyle(source);
    const key = `${source.namespaceURI}|${source.tagName}`;
    let baseline = baselines.get(key);
    if (!baseline) {
      const element = document.createElementNS(source.namespaceURI, source.tagName);
      if (source.namespaceURI === 'http://www.w3.org/2000/svg') { const svg = document.createElementNS(source.namespaceURI, 'svg'); svg.append(element); baselineRoot.append(svg); }
      else baselineRoot.append(element);
      const style = computedStyle(element); baseline = names.map(name => style.getPropertyValue(name)); baselines.set(key, baseline); baselineRoot.replaceChildren();
    }
    const parent = values.get(source.parentElement!), own: string[] = []; let css = '';
    for (let j = 0; j < names.length; j++) {
      const name = names[j], value = computed.getPropertyValue(name); own[j] = value;
      // Keep inheritance compact while retaining browser defaults that differ from this tag's parent.
      if (i === 0 || value !== baseline[j] || value !== parent?.[j] || name === 'font-size' || name === 'font-weight' || name.startsWith('margin') || name.startsWith('padding')) css += `${name}:${value};`;
    }
    values.set(source, own); target.setAttribute('style', `${css}animation:none;transition:none;`);
    if (source instanceof Canvas || source instanceof Video) {
      const canvas = source instanceof Canvas ? source : create('canvas') as HTMLCanvasElement;
      // The OffthreadVideo hold waited for the frame; never draw a video with no current frame as a blank.
      if (source instanceof Video) { if (!currentFrame(source)) fail('MG_RENDER_FAILED', 'Video frame was not decoded at the requested time.'); canvas.width = source.videoWidth; canvas.height = source.videoHeight; canvas.getContext('2d')!.drawImage(source, 0, 0); }
      const img = create('img') as HTMLImageElement; img.src = canvas.toDataURL('image/png'); img.style.cssText = target.style.cssText; img.width = canvas.width; img.height = canvas.height; target.replaceWith(img);
    }
  }
  baselineRoot.remove(); clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  if (fontFaces) { const style = create('style'); style.textContent = fontFaces; clone.prepend(style); }
  const xml = new Serializer().serializeToString(clone);
  if (xml.length > 16 * 1024 * 1024) fail('MG_MEMORY_LIMIT', 'Motion graphic serialisation exceeds the memory budget.');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`;
  const img = create('img') as HTMLImageElement; img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`; await img.decode(); tick();
  const canvas = create('canvas') as HTMLCanvasElement; canvas.width = width; canvas.height = height; canvas.getContext('2d')!.drawImage(img, 0, 0);
  canvas.getContext('2d')!.getImageData(0, 0, 1, 1); return canvas.toDataURL('image/png');
}

let started = false;
addEventListener('message', async function initialise(event: MessageEvent) {
  if (started || event.source !== host || event.data?.type !== 'mg:init' || event.ports.length !== 1) return;
  started = true; removeEventListener('message', initialise); const port = event.ports[0];
  document.querySelectorAll('script,meta').forEach(node => node.remove());
  const { js, options, mode, fonts } = event.data;
  let runtime: ReturnType<typeof createRuntime> | undefined, root: ReturnType<typeof createRoot> | undefined;
  let stage = 'compile', steps = 0; const start = now();
  // Media holds (T08 notes, watchdog): time with a media load open is given back to the 1.7 s execution budget only while
  // no graphic code runs. The credit starts when the task that opened the hold returns to the event loop and stops at the
  // next tick (graphic code ticks on every function entry and loop step); at most 1.8 s per load and 4 s per frame. Nothing
  // runs past 5.8 s (1.7 s + 4 s + 0.1 s) from the start of the frame.
  // Measuring and serialising the finished frame (from mg:out) is not graphic code either, so that work of ours has its
  // own budget instead of the 1.7 s execution one (item 4): a 1080x1920 frame with three video panels serialises in about
  // 1.9 s, which used to abort the frame with no graphic time at all. The graphic builds the DOM that is serialised, so
  // this is a hard cap and not a credit; the 16 MB serialisation and 128 MB memory limits bound the work it can pile up.
  // Graphic code can still run in that phase - a timer it queued firing while rasterise awaits fonts.ready or
  // img.decode(), a React effect scheduled then - and it keeps every limit it had before (FU-B1): it ticks through tick,
  // which measure and rasterise never call, so the step cap, the heap check and both execution caps still apply, with
  // only our output time given back. Our clock stops at the first tick of graphic code and restarts, like a media hold,
  // when the event loop comes back to us. A tick is not the only place the caps are checked, because graphic time can
  // end inside a native call nothing ticks after: scheduled callbacks tick on entry while this phase is open, and both
  // caps are checked again at every checkpoint of ours (checkBudgets, FU2-B1).
  let credited = 0, holdCredit = 0, loads = 0, idleSince: number | undefined, resuming = false;
  let output = 0, outputSince: number | undefined, outputResuming = false, inOutput = false;
  const bank = (t: number) => {
    if (idleSince === undefined) return;
    const credit = Math.max(0, Math.min(t - idleSince, loads * 1800 - holdCredit, 4000 - credited));
    holdCredit += credit; credited += credit; idleSince = undefined;
  };
  const resume = () => { if (resuming) return; resuming = true; timeout(() => { resuming = false; if (loads) idleSince ??= now(); }, 0); };
  const bankOutput = (t: number) => { if (outputSince === undefined) return; output += Math.max(0, t - outputSince); outputSince = undefined; };
  const resumeOutput = () => { if (outputResuming) return; outputResuming = true; timeout(() => { outputResuming = false; if (inOutput) outputSince ??= now(); }, 0); };
  const onMediaWait = (waiting: boolean) => {
    if (waiting) { if (loads++ === 0) { holdCredit = 0; apply(send, port, [{ type: 'mg:hold', waiting }]); } resume(); }
    else { bank(now()); loads = 0; apply(send, port, [{ type: 'mg:hold', waiting }]); }
  };
  const heapAtStart = (performance as any).memory?.usedJSHeapSize ?? 0;
  const checkHeap = () => {
    const memory = (performance as any).memory;
    if (memory && memory.usedJSHeapSize - heapAtStart > 128 * 1024 * 1024) fail('MG_MEMORY_LIMIT', 'Motion graphic exceeded the memory budget.');
  };
  // Graphic code: every tick of it, whatever phase the frame is in.
  const tick = () => {
    checkFrames();
    checkFault();
    const t = now(); if (idleSince !== undefined) { bank(t); resume(); }
    if (inOutput) { bankOutput(t); resumeOutput(); }
    if (++steps > 200_000 || t - start - credited - output > 1700 || t - start - output > 5800) fail('MG_WATCHDOG', 'Motion graphic exceeded the per-frame execution budget.');
    if (steps % 1024 === 0) checkHeap();
  };
  // Both caps, at a point of ours where no graphic code is running: the open output span is credited here although no
  // tick has banked it, so our own serialising is still never charged to the graphic. A tick is not the only place the
  // caps have to hold, because graphic time can end inside a native call that nothing ticks after - a callback that
  // ticked on entry and then ran a catastrophic regex - and that time would otherwise leave the frame with the graphic's
  // clock stopped (FU2-B1).
  const checkBudgets = () => {
    const t = now(); if (idleSince !== undefined) { bank(t); resume(); }
    if (inOutput) outputSince ??= t;
    const out = output + (outputSince === undefined ? 0 : Math.max(0, t - outputSince));
    if (t - start - credited - out > 1700 || t - start - out > 5800) fail('MG_WATCHDOG', 'Motion graphic exceeded the per-frame execution budget.');
    if (out > 8000) fail('MG_WATCHDOG', 'Motion graphic frame did not serialise within the 8 second budget.');
  };
  // Our own measuring and serialising, under the output cap. Graphic code never ticks here, but it can run at our awaits,
  // so the checkpoints are the ones right after them: every 64 elements (the first is fonts.ready returning), after
  // img.decode() and at post. Between two of them only our code runs, where out grows with the clock and the graphic's
  // own time stands still, so a frame of ours can never fail these on serialising alone.
  const outputTick = () => { checkFrames(); checkFault(); checkBudgets(); checkHeap(); };
  const post = (value: unknown) => {
    // A failure has already named itself; a frame about to be reported as good has to be inside both caps.
    try { checkFrames(); if ((value as { ok?: unknown })?.ok === true) checkBudgets(); } catch (error) { value = { ok: false, ...trustedError(error)! }; }
    apply(send, port, [value]);
  };
  // Graphic code that never ticks at all - setTimeout(re.test.bind(re, s), 0) - gets one tick on entry, so the output
  // span is banked and the time the callback burns is the graphic's, not our serialisation's (FU2-B1). Only in the
  // output phase: before mg:out a blocked thread is the host watchdog's to catch (mg/watchdog.ts), and leaving the
  // phases before it alone keeps our own bundled timers (runtime-components) off the graphic's clock.
  onScheduled(() => { if (inOutput) tick(); });
  try {
    if (mode === 'render') await loadFonts(fonts ?? []);
    let evaluate: ((scope: object) => any) | undefined;
    (globalThis as any).__mgDefine = (fn: typeof evaluate) => { evaluate = fn; };
    const script = create('script') as HTMLScriptElement; script.nonce = nonce;
    script.textContent = `__mgDefine(function (__mgScope) { with (__mgScope) { return (function () { "use strict";\n${js}\n})(); } });`;
    try { apply(appendChild, document.body, [script]); } finally { script.remove(); delete (globalThis as any).__mgDefine; }
    if (!evaluate) throw Error('Compiled code did not produce a valid React component');
    const run = (dryRun: boolean) => {
      const rt = createRuntime(dryRun ? { dryRun: true, assetMap: options.assetMap } : { ...options, onMediaWait });
      const component = evaluate!(scope(rt, tick));
      if (typeof component !== 'function' && !(component && typeof component === 'object' && '$$typeof' in component)) throw Error('Compiled code did not produce a valid React component');
      return { component, rt };
    };
    const dry = run(true); walk(React.createElement(dry.component)); checkFault();
    if (mode === 'compile') { post({ ok: true, fields: [...dry.rt.fields.values()] }); return; }
    stage = 'render'; const result = run(false); runtime = result.rt;
    const width = options.itemWidth ?? options.width, height = options.itemHeight ?? options.height;
    const container = create('div'); container.style.cssText = `position:relative;width:${width}px;height:${height}px;overflow:hidden;`; document.body.append(container);
    let reactError: unknown;
    root = createRoot(container, { onUncaughtError: e => { reactError = e; } });
    flushSync(() => root!.render(React.createElement(result.component, options.props ?? {})));
    checkFault(); if (reactError) throw reactError; await runtime.settle(); checkFault();
    await new Promise<void>(resolve => timeout(resolve, 0)); checkFault(); if (reactError) throw reactError;
    // The frame is drawn and settled: measuring and serialising it is not the graphic's compute, so from here both this
    // sandbox and the host charge it to their own output budget (8 s here, 10 s in mg/watchdog.ts), not the graphic's.
    apply(send, port, [{ type: 'mg:out' }]); inOutput = true; outputSince = now();
    const boxes = measure(container), image = await rasterise(container, width, height, outputTick); checkFault();
    post({ ok: true, image, width, height, boxes, fields: [...runtime.fields.values()] });
  } catch (e) {
    const error = currentFault() ?? e, known = trustedError(error);
    let message = 'Unknown motion graphic error.';
    try { message = String((error as any)?.message ?? error).slice(0, 4096); } catch { /* A thrown value need not have a readable message. */ }
    const result = known ? { ok: false, ...known } : { ok: false, code: stage === 'compile' ? 'COMPILATION_ERROR' : 'MG_RENDER_FAILED', message: stage === 'compile' ? `compilation error: ${message}` : message };
    try { post(result); } catch { post({ ...result, details: undefined }); }
  } finally { try { root?.unmount(); runtime?.dispose(); } finally { port.close(); } }
});
host.postMessage({ type: 'mg:ready' }, '*');
