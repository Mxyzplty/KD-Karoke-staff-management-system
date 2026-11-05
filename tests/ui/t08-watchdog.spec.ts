// SPDX-License-Identifier: AGPL-3.0-only
// T08 per-frame watchdog in the real sandbox: media-load holds must not loosen the execution limit, and must not trip it either.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { counterVideo, longGopVideo } from './t08-support';

const redSvg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>').toString('base64');

test.beforeEach(async ({ page }) => { await page.goto('/src/mg/harness.html'); });

test('runaway code inside a media hold window is still stopped by MG_WATCHDOG, well under 6 s', async ({ page }) => {
  test.setTimeout(30_000);
  const r = await page.evaluate(async src => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const code = `export const Graphic = () => { useEffect(() => { let x = 0; while (true) { x++; } }, []); return <Img src={getAssetUrl('a')} style={{width:16,height:16}} />; };`;
    const started = performance.now(); let error = '';
    try { await renderer.render({ code, frame: 0, width: 16, height: 16, fps: 30, durationInFrames: 30, assetMap: { a: src } }); }
    catch (e) { error = (e as { code?: string }).code ?? String(e); }
    const elapsed = performance.now() - started;
    // The renderer must still be usable afterwards.
    const recovered = await renderer.render({ code: "export const Graphic = () => <AbsoluteFill style={{backgroundColor: '#00ff00'}} />;", frame: 0, width: 16, height: 16 });
    renderer.dispose(); return { error, elapsed, recovered: recovered.image.startsWith('data:image/png;base64,') };
  }, redSvg);
  expect(r.error).toBe('MG_WATCHDOG');
  expect(r.elapsed).toBeLessThan(6000);
  expect(r.recovered).toBe(true);
});

test('expensive steps inside a media hold window are stopped by the execution time limit, not the step cap (review B1)', async ({ page }) => {
  test.setTimeout(30_000);
  const r = await page.evaluate(async src => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    // Each step stringifies 100,000 numbers (far over the 40 µs a step would need to reach the 200,000 step cap in 8 s), so
    // only the time limit can stop this 8 s loop, which runs while the Img load holds the frame.
    const code = `export const Graphic = () => { useEffect(() => { const big = new Array(100000).fill(1.25), end = Date.now() + 8000; let n = 0; while (Date.now() < end) { n += JSON.stringify(big).length; } }, []); return <Img src={getAssetUrl('a')} style={{width:16,height:16}} />; };`;
    const started = performance.now(); let error = '', message = '';
    try { await renderer.render({ code, frame: 0, width: 16, height: 16, fps: 30, durationInFrames: 30, assetMap: { a: src } }); }
    catch (e) { error = (e as { code?: string }).code ?? String(e); message = String((e as Error).message); }
    const elapsed = performance.now() - started; renderer.dispose();
    return { error, message, elapsed };
  }, redSvg);
  expect(r.error).toBe('MG_WATCHDOG');
  expect(r.message).toBe('Motion graphic exceeded the per-frame execution budget.');
  // The 1.7 s execution budget plus startup; the loop alone would run 8 s.
  expect(r.elapsed).toBeLessThan(4000);
});

test('a late OffthreadVideo frame (f110) renders and decodes the right counter; media loads do not trip the watchdog', async ({ page }) => {
  test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the counter video');
  test.setTimeout(60_000);
  const video = 'data:video/mp4;base64,' + readFileSync(counterVideo()).toString('base64');
  const r = await page.evaluate(async src => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer(); const out: { frame: number; elapsed: number; n: number | null; error: string; message: string }[] = [];
    for (const frame of [110, 3, 119]) {
      const code = `export const Graphic = () => <OffthreadVideo src={getAssetUrl('clip')} style={{width:64,height:64}} muted={true} volume={0} />;`;
      const started = performance.now(); let n: number | null = null, error = '', message = '';
      try {
        const res = await renderer.render({ code, frame, width: 64, height: 64, fps: 30, durationInFrames: 200, assetMap: { clip: src } });
        const image = new Image(); image.src = res.image; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); n = 0;
        for (let k = 0; k < 8; k++) { const p = ctx.getImageData(4 + 8 * k, 32, 1, 1).data; if (p[3] === 255 && p[0] > 128) n |= 1 << k; }
      } catch (e) { error = (e as { code?: string }).code ?? String(e); message = e instanceof Error ? e.message : String(e); }
      out.push({ frame, elapsed: performance.now() - started, n, error, message });
    }
    renderer.dispose(); return out;
  }, video);
  // Every frame's code, message and time are in the report, so a rare failure (1 in 33 isolated runs in review round 2) can be read.
  const report = JSON.stringify(r);
  test.info().annotations.push({ type: 'measured', description: report });
  expect(r.map(x => x.error), report).toEqual(['', '', '']);
  expect(r.map(x => x.n), report).toEqual([110, 3, 119]);
  for (const x of r) expect(x.elapsed).toBeGreaterThan(0);
});

test('a slow seek near the end of a 1080p long-GOP clip succeeds (media wait is not charged to the execution watchdog)', async ({ page }) => {
  test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the long-GOP clip');
  test.setTimeout(90_000);
  const video = 'data:video/mp4;base64,' + readFileSync(longGopVideo()).toString('base64');
  const r = await page.evaluate(async src => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const code = `export const Graphic = () => <OffthreadVideo src={getAssetUrl('clip')} style={{width:192,height:108}} muted={true} volume={0} />;`;
    const started = performance.now(); let error = '', image = '';
    try { image = (await renderer.render({ code, frame: 118, width: 192, height: 108, fps: 30, durationInFrames: 200, assetMap: { clip: src } })).image; }
    catch (e) { error = (e as { code?: string }).code ?? String(e); }
    renderer.dispose(); return { error, image: image.startsWith('data:image/png;base64,'), elapsed: performance.now() - started };
  }, video);
  expect(r.error).toBe('');
  expect(r.image).toBe(true);
  expect(r.elapsed).toBeGreaterThan(0);
});

test('plain compute without media that busy-loops for ~3 s still fails with MG_WATCHDOG (holds did not loosen the execution limit)', async ({ page }) => {
  test.setTimeout(30_000);
  const r = await page.evaluate(async () => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const code = `export const Graphic = () => { const end = Date.now() + 3000; let ticks = 0; while (Date.now() < end) { ticks++; } return <AbsoluteFill style={{backgroundColor:'#00ff00'}} />; };`;
    const started = performance.now(); let error = '', image = '';
    try { image = (await renderer.render({ code, frame: 0, width: 16, height: 16, fps: 30, durationInFrames: 30 })).image; }
    catch (e) { error = (e as { code?: string }).code ?? String(e); }
    const elapsed = performance.now() - started; renderer.dispose();
    return { error, image, elapsed };
  });
  expect(r.error).toBe('MG_WATCHDOG');
  expect(r.image).toBe('');
  expect(r.elapsed).toBeLessThan(6000);
});

test('a 1080x1920 frame with three video panels renders however long the boot and the serialisation take (item 4)', async ({ page }) => {
  test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the counter video');
  test.setTimeout(120_000);
  // On the landed tree every video-bearing frame of this shape aborted with "exceeded the 2 second per-frame watchdog"
  // (60 of 60 in the repro), because the host armed one 2 s compute clock before it appended the iframe and never
  // stopped charging it: the srcdoc parse and eval of the ~1.45 MB bundle (median 468 ms) and measure + rasterise of the
  // frame (median 1866 ms, three full-resolution panel PNGs plus the 1080x1920 one) came out of the graphic's budget, so
  // the frame aborted with no graphic time at all. The sandbox charged the same serialisation to its own 1.7 s execution
  // budget. Both phases now have their own budget (mg/watchdog.ts, mg/sandbox-entry.tsx outputSince).
  // Every budget is a wall-clock number, so the frame has to be slow on the machine that runs it. The 1500 tiles make
  // rasterise walk their computed styles (the 2000-element budget is the ceiling on that), and the 3x CPU throttle
  // multiplies boot, serialisation and the decodes on whatever machine runs the test, so their sum passes the 2 s the
  // whole frame used to get while each phase stays inside its own budget (boot 4 s, output 8 s in the sandbox and 10 s
  // in the host). Mutation checks: with the phase reporting removed from mg/index.ts this fails "exceeded the 2 second
  // per-frame watchdog"; with outputSince removed from mg/sandbox-entry.tsx, "exceeded the per-frame execution budget".
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 3 });
  const video = 'data:video/mp4;base64,' + readFileSync(counterVideo()).toString('base64');
  const r = await page.evaluate(async src => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const panel = (top: number) => `<OffthreadVideo src={getAssetUrl('clip')} style={{position:'absolute',left:0,top:${top},width:1080,height:640}} muted={true} volume={0} />`;
    const tiles = `{Array.from({length:1500},(_,i) => <div key={i} style={{position:'absolute',left:(i%40)*27,top:Math.floor(i/40)*27,width:24,height:24,fontSize:10,backgroundColor:'rgb('+(i%251)+',80,120)'}}>{i%10}</div>)}`;
    const code = `export const Graphic = () => <AbsoluteFill>${panel(0)}${panel(640)}${panel(1280)}${tiles}</AbsoluteFill>;`;
    const started = performance.now(); let error = '', message = '', image = '';
    try { image = (await renderer.render({ code, frame: 10, width: 1080, height: 1920, fps: 30, durationInFrames: 120, assetMap: { clip: src } })).image; }
    catch (e) { error = (e as { code?: string }).code ?? String(e); message = e instanceof Error ? e.message : String(e); }
    const elapsed = performance.now() - started; renderer.dispose();
    return { error, message, elapsed, png: image.startsWith('data:image/png;base64,') };
  }, video);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const report = JSON.stringify(r);
  test.info().annotations.push({ type: 'measured', description: report });
  // The regression is exactly this: the frame charged to the graphic's budget, whichever side counted it.
  expect(r.message, report).not.toMatch(/per-frame watchdog|per-frame execution budget/);
  // A machine so slow that the throttled serialisation runs past its own budget proves nothing either way.
  test.skip(/did not serialise/.test(r.message), 'the throttled frame outran the serialisation budget on this machine');
  expect(r.error, report).toBe('');
  expect(r.png, report).toBe(true);
  // The frame has to have taken longer than the budget it used to be charged to, or it proves nothing.
  expect(r.elapsed, report).toBeGreaterThan(2000);
});

test('graphic code that runs during the output phase is still stopped by the execution budget (FU-B1)', async ({ page }) => {
  test.setTimeout(30_000);
  // The first version of the output budget (above) gave the whole phase the 8 s output cap, so a timer the graphic had
  // queued burned the thread for 6 s after mg:out and the frame rendered "successfully": the step cap, the execution
  // caps and the heap check were all skipped for anything that ran once outputSince was set. Only our own measure and
  // rasterise work gets that budget now (mg/sandbox-entry.tsx outputTick); graphic code keeps every limit, and the
  // output time is credited back to it only while none is running. Two timer hops put the burn past mg:out, which the
  // sandbox reaches after one timeout(0) of its own; rasterise then awaits fonts.ready, so the timer gets the thread.
  const r = await page.evaluate(async () => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const code = `export const Graphic = () => { useEffect(() => { let hop = 0; const next = () => { if (++hop < 2) { setTimeout(next, 0); return; } const end = Date.now() + 6000; while (Date.now() < end) {} }; setTimeout(next, 0); }, []); return <AbsoluteFill style={{backgroundColor:'#00ff00'}} />; };`;
    const started = performance.now(); let error = '', message = '', image = '';
    try { image = (await renderer.render({ code, frame: 0, width: 64, height: 64, fps: 30, durationInFrames: 30 })).image; }
    catch (e) { error = (e as { code?: string }).code ?? String(e); message = e instanceof Error ? e.message : String(e); }
    const elapsed = performance.now() - started; renderer.dispose();
    return { error, message, elapsed, png: image.startsWith('data:image/png;base64,') };
  });
  const report = JSON.stringify(r);
  test.info().annotations.push({ type: 'measured', description: report });
  expect(r.error, report).toBe('MG_WATCHDOG');
  expect(r.message, report).toBe('Motion graphic exceeded the per-frame execution budget.');
  expect(r.png, report).toBe(false);
  // The burn alone is 6 s, and the output cap it used to be charged to is 8 s.
  expect(r.elapsed, report).toBeLessThan(4000);
});

// FU2-B1: the same hole, for graphic time that ends inside a *native* call, which no instrumented tick follows. A
// catastrophic regex is the cheapest way to hold the thread inside one call, and it is calibrated per machine: one more
// 'a' doubles the work, with a fresh RegExp each time so every measurement is a first execution. The length is the
// first n whose own measurement passes 2 s, so the burn in the sandbox is that measured time and not an extrapolation
// from a short sample (which overshot to 7 s on this machine). 2 s is past the 1.7 s execution budget, and the frame
// dies at the sandbox's first checkpoint after the burn, which keeps the whole frame inside the 6-7 s the tree before
// this one (cdc5af4) took to fail these.
const BURN_MS = 2000;
const burnLength = (page: Page) => page.evaluate(min => {
  let n = 16, ms = 0;
  for (; n < 40; n++) { const re = new RegExp('^(a+)+$'); const t = performance.now(); re.test('a'.repeat(n) + 'b'); ms = performance.now() - t; if (ms > min) break; }
  return { n, ms: Math.round(ms) };
}, BURN_MS);
// One timer hop inside useEffect lands the body after mg:out, which the sandbox reaches after one timeout(0) of its own;
// rasterise then awaits fonts.ready and the next hop gets the thread.
const nativeBurn = (page: Page, body: string) => page.evaluate(async source => {
  const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
  const renderer = createMotionGraphicRenderer();
  const code = `export const Graphic = () => { useEffect(() => { setTimeout(() => { ${source} }, 0); }, []); return <AbsoluteFill style={{backgroundColor:'#00ff00'}} />; };`;
  const started = performance.now(); let error = '', message = '', image = '';
  try { image = (await renderer.render({ code, frame: 0, width: 64, height: 64, fps: 30, durationInFrames: 30 })).image; }
  catch (e) { error = (e as { code?: string }).code ?? String(e); message = e instanceof Error ? e.message : String(e); }
  const elapsed = performance.now() - started; renderer.dispose();
  return { error, message, elapsed, png: image.startsWith('data:image/png;base64,') };
}, body);

test('a hop-2 callback that ticks on entry and then burns the thread in a native call fails by name (FU2-B1 case A)', async ({ page }) => {
  test.setTimeout(60_000);
  const burn = await burnLength(page);
  // The callback ticks on entry, so the clock it banked there is the graphic's; nothing ticks after the regex, so only
  // our own checkpoints (checkBudgets at every 64 elements, after img.decode() and at post) can charge it.
  const r = await nativeBurn(page, `setTimeout(() => { /^(a+)+$/.test('a'.repeat(${burn.n}) + 'b'); }, 0);`);
  const report = JSON.stringify({ ...burn, ...r });
  test.info().annotations.push({ type: 'measured', description: report });
  expect(r.error, report).toBe('MG_WATCHDOG');
  expect(r.message, report).toBe('Motion graphic exceeded the per-frame execution budget.');
  expect(r.png, report).toBe(false);
  expect(r.elapsed, report).toBeLessThan(7000);
});

test('a hop-2 bound native callback that never ticks at all fails by name (FU2-B1 case B)', async ({ page }) => {
  test.setTimeout(60_000);
  const burn = await burnLength(page);
  // Nothing in this callback is instrumented, so without the entry tick on scheduled callbacks the frame has no tick
  // between mg:out and the finished PNG, and used to render.
  const r = await nativeBurn(page, `const re = /^(a+)+$/; setTimeout(re.test.bind(re, 'a'.repeat(${burn.n}) + 'b'), 0);`);
  const report = JSON.stringify({ ...burn, ...r });
  test.info().annotations.push({ type: 'measured', description: report });
  expect(r.error, report).toBe('MG_WATCHDOG');
  expect(r.message, report).toBe('Motion graphic exceeded the per-frame execution budget.');
  expect(r.png, report).toBe(false);
  expect(r.elapsed, report).toBeLessThan(7000);
});
