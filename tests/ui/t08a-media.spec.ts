// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ffmpegAvailable, media } from '../media-fixtures';

const redSvg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>').toString('base64');
const animation = { v: '5.7.4', fr: 30, ip: 0, op: 30, w: 64, h: 64, nm: 'authored red square', ddd: 0, assets: [], layers: [{ ddd: 0, ind: 1, ty: 1, nm: 'red solid', sw: 64, sh: 64, sc: '#ff0000', ip: 0, op: 30, st: 0, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } } }] };

test('Img loads a host-supplied asset into an untainted PNG', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const pixel = await page.evaluate(async src => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    const result = await renderMotionGraphic({ code: `export const Graphic = () => <Img src={getAssetUrl('red')} style={{width:64,height:64}} />;`, frame: 0, width: 64, height: 64, assetMap: { red: src } });
    const image = new Image(); image.src = result.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return Array.from(ctx.getImageData(32, 32, 1, 1).data);
  }, redSvg);
  expect(pixel).toEqual([255, 0, 0, 255]);
});

test('OffthreadVideo seeks and renders distinct frames from an authored video', async ({ page }) => {
  test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the authored media fixture');
  const video = 'data:video/mp4;base64,' + readFileSync(media('h264-aac.mp4')).toString('base64');
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async src => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    const args = { code: `export const Graphic = () => <OffthreadVideo src={getAssetUrl('clip')} style={{width:64,height:64}} />;`, width: 64, height: 64, fps: 30, durationInFrames: 30, assetMap: { clip: src } };
    const first = await renderMotionGraphic({ ...args, frame: 0 }); const later = await renderMotionGraphic({ ...args, frame: 15 });
    return [first.image, later.image];
  }, video);
  expect(result[0]).toMatch(/^data:image\/png;base64,/); expect(result[1]).not.toBe(result[0]);
});

test('Lottie rasterises an authored red layer', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const pixel = await page.evaluate(async animationData => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    const code = `export const Graphic = () => <Lottie animationData={${JSON.stringify(animationData)}} />;`;
    const result = await renderMotionGraphic({ code, frame: 5, width: 64, height: 64, fps: 30, durationInFrames: 30 });
    const image = new Image(); image.src = result.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return Array.from(ctx.getImageData(32, 32, 1, 1).data);
  }, animation);
  expect(pixel).toEqual([255, 0, 0, 255]);
});

test('ThreeCanvas renders a visible red mesh into the resulting PNG', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const pixel = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    const code = `export const Graphic = () => <ThreeCanvas width={64} height={64} camera={{position:[0,0,5]}}><mesh><boxGeometry args={[2,2,2]} /><meshBasicMaterial color="red" /></mesh></ThreeCanvas>;`;
    const result = await renderMotionGraphic({ code, frame: 0, width: 64, height: 64, fps: 30, durationInFrames: 30 });
    const image = new Image(); image.src = result.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return Array.from(ctx.getImageData(32, 32, 1, 1).data);
  });
  expect(pixel[0]).toBeGreaterThan(200); expect(pixel[1]).toBeLessThan(30); expect(pixel[2]).toBeLessThan(30); expect(pixel[3]).toBe(255);
});

test('OffthreadVideo trim aliases and playbackRate select the same source frame', async ({ page }) => {
  test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the authored media fixture');
  const video = 'data:video/mp4;base64,' + readFileSync(media('h264-aac.mp4')).toString('base64');
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async src => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer();
    const outputs = [];
    // trimAfter / endAt cases sit inside the window (T08 notes Q7: nothing is drawn once the local frame reaches its end).
    for (const [frame, props] of [[10, ''], [5, 'trimBefore={5}'], [5, 'startFrom={5}'], [5, 'playbackRate={2}'], [10, 'trimAfter={11}'], [10, 'endAt={11}']] as const) {
      const code = `export const Graphic = () => <OffthreadVideo src={getAssetUrl('clip')} style={{width:64,height:64}} ${props} muted={true} volume={0} pauseWhenLoading={true} delayRenderTimeoutInMilliseconds={1800} toneMapped={true} transparent={false} />;`;
      const result = await renderer.render({ code, frame, width: 64, height: 64, fps: 30, durationInFrames: 30, assetMap: { clip: src } }); outputs.push(result.image);
    }
    renderer.dispose(); return outputs;
  }, video);
  for (const frame of result.slice(1)) expect(frame).toBe(result[0]);
});

test('Lottie loop, speed and backward playback select the same authored animation frame', async ({ page }) => {
  test.setTimeout(30_000);
  const moving = { ...animation, layers: [{ ...animation.layers[0], sw: 16, sh: 16, ks: { ...animation.layers[0].ks, p: { a: 1, k: [{ t: 0, s: [0, 0, 0], e: [30, 0, 0], o: { x: .33, y: .33 }, i: { x: .67, y: .67 } }, { t: 30, s: [30, 0, 0] }] } } }] };
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async animationData => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer(); const outputs = [];
    for (const [frame, props] of [[20, ''], [10, 'playbackRate={2}'], [50, 'loop={true}'], [9, 'direction="backward"'], [0, '']] as const) {
      const code = `export const Graphic = () => <Lottie animationData={${JSON.stringify(animationData)}} ${props} renderer="svg" preserveAspectRatio="xMidYMid meet" assetsPath="" onAnimationLoaded={() => {}} style={{width:64,height:64}} className="animation" />;`;
      const result = await renderer.render({ code, frame, width: 64, height: 64, fps: 30, durationInFrames: 60 }); outputs.push(result.image);
    }
    renderer.dispose(); return outputs;
  }, moving);
  for (const frame of result.slice(1, 4)) expect(frame).toBe(result[0]);
  expect(result[4]).not.toBe(result[0]);
});

for (const rendererName of ['svg', 'canvas', 'html'] as const) {
  test(`Lottie ${rendererName} renderer paints the authored solid`, async ({ page }) => {
    await page.goto('/src/mg/harness.html');
    const pixel = await page.evaluate(async ({ animationData, rendererName }) => {
      const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
      const code = `export const Graphic = () => <Lottie animationData={${JSON.stringify(animationData)}} renderer="${rendererName}" style={{width:64,height:64}} />;`;
      const result = await renderMotionGraphic({ code, frame: 5, width: 64, height: 64, fps: 30, durationInFrames: 30 });
      const image = new Image(); image.src = result.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return Array.from(ctx.getImageData(32, 32, 1, 1).data);
    }, { animationData: animation, rendererName });
    expect(pixel).toEqual([255, 0, 0, 255]);
  });
}

test('ThreeCanvas accepts orthographic camera and gl options with visible output', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const pixel = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    const code = `export const Graphic = () => <ThreeCanvas width={64} height={64} orthographic camera={{position:[0,0,5],zoom:20}} gl={{alpha:true,antialias:false}} style={{width:64,height:64}}><mesh><boxGeometry args={[2,2,2]} /><meshBasicMaterial color="red" /></mesh></ThreeCanvas>;`;
    const result = await renderMotionGraphic({ code, frame: 0, width: 64, height: 64, fps: 30, durationInFrames: 30 });
    const image = new Image(); image.src = result.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return Array.from(ctx.getImageData(32, 32, 1, 1).data);
  });
  expect(pixel[0]).toBeGreaterThan(200); expect(pixel[1]).toBeLessThan(30); expect(pixel[3]).toBe(255);
});

test('ThreeCanvas updates scene geometry from the graphic frame', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const images = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    const code = `const Box = () => { const f = useCurrentFrame(); return <mesh rotation={[0,0,f/30]}><boxGeometry args={[2,1,1]} /><meshBasicMaterial color="red" /></mesh>; }; export const Graphic = () => <ThreeCanvas width={64} height={64} camera={{position:[0,0,5]}}><Box /></ThreeCanvas>;`;
    const args = { code, width: 64, height: 64, fps: 30, durationInFrames: 60 };
    return [(await renderMotionGraphic({ ...args, frame: 0 })).image, (await renderMotionGraphic({ ...args, frame: 30 })).image];
  });
  expect(images[0]).not.toBe(images[1]);
});

test('Img reports a failed asset instead of returning a completed frame', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const error = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    try {
      await renderMotionGraphic({ code: `export const Graphic = () => <Img src={getAssetUrl('bad')} pauseWhenLoading={true} delayRenderTimeoutInMilliseconds={300} onError={() => {}} />;`, frame: 0, width: 16, height: 16, assetMap: { bad: 'data:image/png;base64,bm90LWEtcG5n' } });
      return '';
    } catch (e) { return String(e); }
  });
  expect(error).toMatch(/image|load/i);
});

test('Lottie onAnimationLoaded updates component state before capture', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const pixel = await page.evaluate(async animationData => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    const code = `export const Graphic = () => { const [loaded,setLoaded]=useState(false); return <AbsoluteFill style={{backgroundColor:loaded?'#00ff00':'#ff0000'}}><Lottie animationData={${JSON.stringify(animationData)}} onAnimationLoaded={() => setLoaded(true)} style={{width:1,height:1}} /></AbsoluteFill>; };`;
    const result = await renderMotionGraphic({ code, frame: 0, width: 16, height: 16 });
    const image = new Image(); image.src = result.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return Array.from(ctx.getImageData(8, 8, 1, 1).data);
  }, animation);
  expect(pixel).toEqual([0, 255, 0, 255]);
});

test('Lottie preserveAspectRatio changes letterboxing of a non-square container', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const pixels = await page.evaluate(async animationData => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer(); const colors = [];
    for (const aspect of ['xMidYMid meet', 'none']) {
      const code = `export const Graphic = () => <Lottie animationData={${JSON.stringify(animationData)}} preserveAspectRatio="${aspect}" style={{width:64,height:32}} />;`;
      const result = await renderer.render({ code, frame: 0, width: 64, height: 32 });
      const image = new Image(); image.src = result.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); colors.push([Array.from(ctx.getImageData(4, 16, 1, 1).data), Array.from(ctx.getImageData(32, 16, 1, 1).data)]);
    }
    renderer.dispose(); return colors;
  }, animation);
  expect(pixels[0][0]).toEqual([0, 0, 0, 0]);
  expect(pixels[0][1]).toEqual([255, 0, 0, 255]);
  expect(pixels[1][0]).toEqual([255, 0, 0, 255]);
  expect(pixels[1][1]).toEqual([255, 0, 0, 255]);
});

test('Lottie assetsPath cannot fetch an unapproved external image', async ({ page }) => {
  const requests: string[] = [], failures: string[] = [];
  page.on('request', request => { if (request.url().includes('t08a-lottie.invalid')) requests.push(request.url()); });
  page.on('requestfailed', request => { if (request.url().includes('t08a-lottie.invalid')) failures.push(request.failure()?.errorText ?? 'unknown'); });
  await page.goto('/src/mg/harness.html');
  const outcome = await page.evaluate(async animationData => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer();
    await renderer.render({ code: `export const Graphic = () => <div>safe</div>;`, frame: 0, width: 16, height: 16 });
    const code = `export const Graphic = () => <Lottie animationData={${JSON.stringify(animationData)}} assetsPath="https://t08a-lottie.invalid/" />;`;
    try { await renderer.render({ code, frame: 0, width: 64, height: 64 }); return 'rendered'; }
    catch (e) { return (e as Error & { code?: string }).code ?? 'failed'; }
    finally { renderer.dispose(); }
  }, { ...animation, assets: [{ id: 'image_0', w: 16, h: 16, u: '', p: 'probe.png', e: 0 }], layers: [{ ...animation.layers[0], ty: 2, refId: 'image_0' }] });
  expect(outcome).not.toBe('MG_WATCHDOG');
  expect(requests.length > 0 || outcome !== 'rendered').toBe(true);
  expect(failures).toHaveLength(requests.length);
  expect(failures).toEqual(Array(failures.length).fill('csp'));
});
