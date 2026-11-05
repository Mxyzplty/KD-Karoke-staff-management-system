// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test('slide and wipe directions visibly render both scenes and distinct directions', async ({ page }) => {
  test.setTimeout(40_000);
  await page.goto('/src/mg/harness.html');
  const results = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer(); const images: Record<string, { image: string; red: number; blue: number }> = {};
    for (const [kind, directions] of Object.entries({ slide: ['from-left', 'from-right', 'from-top', 'from-bottom'], wipe: ['from-left', 'from-top-left', 'from-top', 'from-top-right', 'from-right', 'from-bottom-right', 'from-bottom', 'from-bottom-left'] })) {
      for (const direction of directions) {
        const code = `export const Graphic = () => <TransitionSeries><TransitionSeries.Sequence durationInFrames={20}><AbsoluteFill style={{backgroundColor:'#ff0000'}} /></TransitionSeries.Sequence><TransitionSeries.Transition timing={linearTiming({durationInFrames:10})} presentation={${kind}({direction:'${direction}'})} /><TransitionSeries.Sequence durationInFrames={20}><AbsoluteFill style={{backgroundColor:'#0000ff'}} /></TransitionSeries.Sequence></TransitionSeries>;`;
        const frame = await renderer.render({ code, frame: 15, width: 32, height: 32, fps: 30, durationInFrames: 30 });
        const image = new Image(); image.src = frame.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); const rgba = ctx.getImageData(0, 0, 32, 32).data;
        let red = 0, blue = 0; for (let i = 0; i < rgba.length; i += 4) { if (rgba[i] > 200 && rgba[i + 2] < 30) red++; if (rgba[i + 2] > 200 && rgba[i] < 30) blue++; }
        images[`${kind}:${direction}`] = { image: frame.image, red, blue };
      }
    }
    renderer.dispose(); return images;
  });
  for (const result of Object.values(results)) { expect(result.red).toBeGreaterThan(0); expect(result.blue).toBeGreaterThan(0); }
  for (const kind of ['slide', 'wipe']) {
    expect(results[`${kind}:from-left`].image).not.toBe(results[`${kind}:from-right`].image);
    expect(results[`${kind}:from-top`].image).not.toBe(results[`${kind}:from-bottom`].image);
  }
});

test('text and SVG rasterise into readable untainted, repeatable pixels', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    const args = { code: `export const Graphic = () => <AbsoluteFill style={{backgroundColor:'white'}}><div style={{color:'black',font:'bold 24px sans-serif'}}>ABC</div><svg width="64" height="20"><rect width="64" height="20" fill="red" /></svg></AbsoluteFill>;`, frame: 0, width: 64, height: 64 };
    const first = await renderMotionGraphic(args), second = await renderMotionGraphic(args);
    const image = new Image(); image.src = first.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); const rgba = ctx.getImageData(0, 0, 64, 64).data;
    let black = 0, red = 0; for (let i = 0; i < rgba.length; i += 4) { if (rgba[i] < 50 && rgba[i + 1] < 50 && rgba[i + 2] < 50 && rgba[i + 3] === 255) black++; if (rgba[i] > 200 && rgba[i + 1] < 50 && rgba[i + 2] < 50) red++; }
    return { black, red, first: first.image, second: second.image };
  });
  expect(result.black).toBeGreaterThan(10); expect(result.red).toBeGreaterThan(100); expect(result.second).toBe(result.first);
});

test('Sequence rebases, TransitionSeries retains graphic time, and config duration is the clip length', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const pixels = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer();
    const predicate = `const f=useCurrentFrame(), c=useVideoConfig(); return <AbsoluteFill style={{backgroundColor:f===EXPECTED && c.durationInFrames===30 ? '#00ff00' : '#ff0000'}} />;`;
    const seq = `const Inner = () => { ${predicate.replace('EXPECTED', '10')} }; export const Graphic = () => <Sequence from={5}><Inner /></Sequence>;`;
    const series = `const Inner = () => { ${predicate.replace('EXPECTED', '15')} }; export const Graphic = () => <TransitionSeries><TransitionSeries.Sequence durationInFrames={20}><div /></TransitionSeries.Sequence><TransitionSeries.Transition timing={linearTiming({durationInFrames:10})} /><TransitionSeries.Sequence durationInFrames={20}><Inner /></TransitionSeries.Sequence></TransitionSeries>;`;
    const results = [];
    for (const code of [seq, series]) {
      const frame = await renderer.render({ code, frame: 15, width: 16, height: 16, fps: 30, durationInFrames: 30 });
      const image = new Image(); image.src = frame.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); results.push(Array.from(ctx.getImageData(3, 8, 1, 1).data));
    }
    renderer.dispose(); return results;
  });
  expect(pixels).toEqual([[0, 255, 0, 255], [0, 255, 0, 255]]);
});

test('transition easing and fade/slide enter and exit styles change actual pixels', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/src/mg/harness.html');
  const images = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer(); const values: number[][] = [];
    const cases = [
      ['linearTiming({durationInFrames:10})', 'fade()', 8],
      ['linearTiming({durationInFrames:10,easing:Easing.quad})', 'fade()', 8],
      ['linearTiming({durationInFrames:10})', 'fade({shouldFadeOutExitingScene:true})', 8],
      ['linearTiming({durationInFrames:10})', "fade({enterStyle:{filter:'brightness(0)'}})", 8],
      ['linearTiming({durationInFrames:10})', "fade({exitStyle:{filter:'brightness(0)'}})", 8],
      ['linearTiming({durationInFrames:10})', "slide({direction:'from-left'})", 3],
      ['linearTiming({durationInFrames:10})', "slide({direction:'from-left',enterStyle:{filter:'brightness(0)'}})", 3],
      ['linearTiming({durationInFrames:10})', "slide({direction:'from-left'})", 12],
      ['linearTiming({durationInFrames:10})', "slide({direction:'from-left',exitStyle:{filter:'brightness(0)'}})", 12],
    ] as const;
    for (const [timing, presentation, x] of cases) {
      const code = `export const Graphic = () => <TransitionSeries><TransitionSeries.Sequence durationInFrames={20}><AbsoluteFill style={{backgroundColor:'red'}} /></TransitionSeries.Sequence><TransitionSeries.Transition timing={${timing}} presentation={${presentation}} /><TransitionSeries.Sequence durationInFrames={20}><AbsoluteFill style={{backgroundColor:'blue'}} /></TransitionSeries.Sequence></TransitionSeries>;`;
      const result = await renderer.render({ code, frame: 15, width: 16, height: 16, fps: 30, durationInFrames: 30 });
      const image = new Image(); image.src = result.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); values.push(Array.from(ctx.getImageData(x, 8, 1, 1).data));
    }
    renderer.dispose(); return values;
  });
  expect(images[0][2]).toBeGreaterThan(images[1][2]); // quadratic easing is 0.25 at halfway
  expect(images[2]).not.toEqual(images[0]); // exiting scene also fades
  expect(images[3][2]).toBeLessThan(images[0][2]);
  expect(images[4][0]).toBeLessThan(images[0][0]);
  expect(images[6][2]).toBeLessThan(images[5][2]);
  expect(images[8][0]).toBeLessThan(images[7][0]);
});
