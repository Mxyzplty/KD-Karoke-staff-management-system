// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { goldenSamples } from '../t08a-golden-samples';
import frozenGoldens from '../t08a-golden/frames.json' with { type: 'json' };

test('authored reference samples render the expected flat-colour pixels and repeat deterministically', async ({ page }) => {
  await page.goto('/');
  for (const sample of goldenSamples) {
    const result = await page.evaluate(async ({ code, probes }) => {
      const modulePath = '/src/mg/index.ts';
      const { renderMotionGraphic } = await import(/* @vite-ignore */ modulePath);
      const args = { code, frame: 8, width: 64, height: 64, fps: 30, durationInFrames: 150 };
      const first = await renderMotionGraphic(args);
      const second = await renderMotionGraphic(args);
      const image = new Image();
      image.src = first.image;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return {
        width: first.width, height: first.height,
        image: first.image, repeated: second.image,
        pixels: probes.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data)),
        rgba: Array.from(ctx.getImageData(0, 0, 64, 64).data),
      };
    }, sample);
    expect([result.width, result.height], sample.name).toEqual([64, 64]);
    expect(result.image, sample.name).toMatch(/^data:image\/png;base64,/);
    expect(result.repeated, sample.name).toBe(result.image);
    expect(result.pixels, sample.name).toEqual(sample.probes.map(([, , rgba]) => rgba));
    // Frozen authored RGBA pixels, encoded as [run length, r, g, b, a].
    const expected: number[] = [];
    for (const [count, r, g, b, a] of frozenGoldens.frames[sample.name]) {
      for (let i = 0; i < count; i++) expected.push(r, g, b, a);
    }
    expect(expected).toHaveLength(frozenGoldens.width * frozenGoldens.height * 4);
    const mismatch = expected.findIndex((value, i) => result.rgba[i] !== value);
    expect(mismatch, `${sample.name}: first mismatching channel`).toBe(-1);
  }
});

test('graphic code cannot read parent DOM or local storage, or make network requests', async ({ page }) => {
  const escapedRequests: string[] = [];
  page.on('request', request => {
    if (request.url().startsWith('https://t08a-network-probe.invalid/')) escapedRequests.push(request.url());
  });
  await page.goto('/');
  const refusal = await page.evaluate(async () => {
    const modulePath = '/src/mg/index.ts';
    const { renderMotionGraphic } = await import(/* @vite-ignore */ modulePath);
    const code = `export const Graphic = () => {
      let parentBlocked = false;
      let storageBlocked = false;
      try { void window.parent.document.body; } catch (_) { parentBlocked = true; }
      try { void localStorage.length; } catch (_) { storageBlocked = true; }
      try { fetch('https://t08a-network-probe.invalid/escape').catch(() => {}); } catch (_) {}
      return <AbsoluteFill style={{backgroundColor: parentBlocked && storageBlocked ? '#00ff00' : '#ff0000'}} />;
    };`;
    try { await renderMotionGraphic({ code, frame: 0, width: 16, height: 16, fps: 30, durationInFrames: 30 }); return 'rendered'; }
    catch (error) { return (error as Error & {code?:string}).code; }
  });
  expect(refusal).toBe('MG_SANDBOX_DENIED');
  expect(escapedRequests).toEqual([]);
});

test('runaway graphic is terminated and a subsequent graphic still renders', async ({ page }) => {
  test.setTimeout(20_000);
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/mg/index.ts';
    const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const base = { frame: 0, width: 16, height: 16, fps: 30, durationInFrames: 30 };
    let heartbeat = 0; const timer = setInterval(() => heartbeat++, 5);
    const started = performance.now();
    let error = '';
    try {
      await renderer.render({ ...base, code: 'export const Graphic = () => { while (true) {} return <div />; };' });
    } catch (e) { error = String(e); }
    const elapsed = performance.now() - started;
    const duringAttack = heartbeat; clearInterval(timer);
    const recovered = await renderer.render({ ...base, code: "export const Graphic = () => <AbsoluteFill style={{backgroundColor: '#00ff00'}} />;" });
    renderer.dispose();
    return { error, elapsed, duringAttack, image: recovered.image };
  });
  expect(result.error).not.toBe('');
  expect(result.elapsed).toBeLessThan(10_000);
  expect(result.duringAttack).toBeGreaterThan(0);
  expect(result.image).toMatch(/^data:image\/png;base64,/);
});

test('frame cache distinguishes frame, field values, and dimensions', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/mg/index.ts';
    const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const code = `export const Graphic = () => {
      const frame = useCurrentFrame(); const color = editable('color', '#ff0000');
      return <AbsoluteFill style={{backgroundColor: color}}><div style={{position:'absolute', left:frame, top:0, width:2, height:2, backgroundColor:'#000000'}} /></AbsoluteFill>;
    };`;
    const args = { code, frame: 0, width: 16, height: 16, fps: 30, durationInFrames: 30 };
    const first = await renderer.render(args);
    const repeated = await renderer.render(args);
    const later = await renderer.render({ ...args, frame: 5 });
    const field = await renderer.render({ ...args, fieldValues: { color: '#0000ff' } });
    const sized = await renderer.render({ ...args, width: 20 });
    const stats = renderer.cache.stats;
    renderer.dispose();
    return { first: first.image, repeated: repeated.image, later: later.image, field: field.image, width: sized.width, height: sized.height, stats };
  });
  expect(result.repeated).toBe(result.first);
  expect(result.later).not.toBe(result.first);
  expect(result.field).not.toBe(result.first);
  expect([result.width, result.height]).toEqual([20, 16]);
  expect(result.stats.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
});
