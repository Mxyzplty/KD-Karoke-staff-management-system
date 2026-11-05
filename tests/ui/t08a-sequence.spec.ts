// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test('Sequence handles positive, negative and nested offsets and visibility boundaries', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/src/mg/harness.html');
  const actual = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer();
    const inner = `const Inner = () => <AbsoluteFill style={{backgroundColor:useCurrentFrame() === EXPECTED ? '#00ff00' : '#ff0000'}} />;`;
    const cases = [
      [5, `${inner.replace('EXPECTED', '0')} export const Graphic = () => <Sequence from={5} durationInFrames={4}><Inner /></Sequence>;`],
      [8, `${inner.replace('EXPECTED', '3')} export const Graphic = () => <Sequence from={5} durationInFrames={4}><Inner /></Sequence>;`],
      [9, `${inner.replace('EXPECTED', '4')} export const Graphic = () => <Sequence from={5} durationInFrames={4}><Inner /></Sequence>;`],
      [5, `${inner.replace('EXPECTED', '7')} export const Graphic = () => <Sequence from={-2}><Inner /></Sequence>;`],
      [15, `${inner.replace('EXPECTED', '5')} export const Graphic = () => <Sequence from={4}><Sequence from={6}><Inner /></Sequence></Sequence>;`],
      [3, `${inner.replace('EXPECTED', '-2')} export const Graphic = () => <Sequence from={5} durationInFrames={4} premountFor={3}><Inner /></Sequence>;`],
      [10, `${inner.replace('EXPECTED', '5')} export const Graphic = () => <Sequence from={5} durationInFrames={4} postmountFor={2}><Inner /></Sequence>;`],
    ] as const;
    const pixels = [];
    for (const [frame, code] of cases) {
      const result = await renderer.render({ code, frame, width: 16, height: 16, fps: 30, durationInFrames: 30 });
      const image = new Image(); image.src = result.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); pixels.push(Array.from(ctx.getImageData(8, 8, 1, 1).data));
    }
    renderer.dispose(); return pixels;
  });
  const green = [0, 255, 0, 255], transparent = [0, 0, 0, 0];
  expect(actual).toEqual([green, green, transparent, green, green, transparent, transparent]);
});

test('Sequence dimensions, layout, class and style affect the rendered frame', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
    const code = `const Inner = () => { const c=useVideoConfig(); return <div style={{width:8,height:8,backgroundColor:c.width===8 && c.height===8 ? '#00ff00' : '#ff0000'}} />; }; export const Graphic = () => <Sequence from={0} width={8} height={8} layout="absolute-fill" name="test" className="sequence-class" showInTimeline={false} style={{left:4,top:4}}><Inner /></Sequence>;`;
    const frame = await renderMotionGraphic({ code, frame: 0, width: 16, height: 16, fps: 30, durationInFrames: 30 });
    const image = new Image(); image.src = frame.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return [Array.from(ctx.getImageData(5, 5, 1, 1).data), Array.from(ctx.getImageData(0, 0, 1, 1).data)];
  });
  expect(result).toEqual([[0, 255, 0, 255], [0, 0, 0, 0]]);
});

test('premounted and postmounted children run effects while remaining hidden', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const pixels = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer(); const result = [];
    for (const frame of [3, 10]) {
      const code = `const Inner = ({notify}) => { useEffect(() => { notify(true); }, []); return <div style={{backgroundColor:'red',width:16,height:16}} />; }; export const Graphic = () => { const [mounted,setMounted]=useState(false); return <AbsoluteFill style={{backgroundColor:mounted?'#00ff00':'#0000ff'}}><Sequence from={5} durationInFrames={4} premountFor={3} postmountFor={2}><Inner notify={setMounted} /></Sequence></AbsoluteFill>; };`;
      const frameImage = await renderer.render({ code, frame, width: 16, height: 16 });
      const image = new Image(); image.src = frameImage.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); result.push(Array.from(ctx.getImageData(8, 8, 1, 1).data));
    }
    renderer.dispose(); return result;
  });
  expect(pixels).toEqual([[0, 255, 0, 255], [0, 255, 0, 255]]);
});
