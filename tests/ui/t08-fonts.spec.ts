// SPDX-License-Identifier: AGPL-3.0-only
// T08 bundled font (Roboto 400/700) in the real sandbox: the face that lays text out is the face that is drawn, and a family
// outside the bundle falls back to the system font (what the FONT WARNING describes). Roboto is not installed on the test
// machine, so any Roboto that renders comes from the bundle.
import { expect, test } from '@playwright/test';

type Variant = { family: string; weight?: number };
type Rendered = { diff: Record<string, number>; same: Record<string, boolean>; width: Record<string, number> };

// Renders `Rag fiQ` (120 px, black on white, 600x200) once per variant and compares them in the page.
async function compare(page: import('@playwright/test').Page, variants: Record<string, Variant>, pairs: [string, string][]): Promise<Rendered> {
  await page.goto('/src/mg/harness.html');
  return page.evaluate(async ({ variants, pairs }) => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const pixels: Record<string, Uint8ClampedArray> = {}, width: Record<string, number> = {};
    for (const [name, v] of Object.entries(variants)) {
      const code = `export const Graphic = () => <AbsoluteFill style={{backgroundColor:'#ffffff'}}><span style={{position:'absolute',left:10,top:10,fontSize:120,color:'#000000',fontFamily:${JSON.stringify(v.family)},fontWeight:${v.weight ?? 400}}}>Rag fiQ</span></AbsoluteFill>;`;
      const r = await renderer.render({ code, frame: 0, width: 600, height: 200, fps: 30, durationInFrames: 30 });
      const image = new Image(); image.src = r.image; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 200;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      pixels[name] = ctx.getImageData(0, 0, 600, 200).data;
      width[name] = (r.boxes as { tag: string; width: number }[]).find(b => b.tag === 'span')!.width;
    }
    renderer.dispose();
    const diff: Record<string, number> = {}, same: Record<string, boolean> = {};
    for (const [a, b] of pairs) {
      let n = 0, identical = true;
      for (let i = 0; i < pixels[a].length; i += 4) {
        if (Math.abs(pixels[a][i] - pixels[b][i]) > 64) n++;
        if (pixels[a][i] !== pixels[b][i] || pixels[a][i + 1] !== pixels[b][i + 1] || pixels[a][i + 2] !== pixels[b][i + 2] || pixels[a][i + 3] !== pixels[b][i + 3]) identical = false;
      }
      diff[`${a}|${b}`] = n; same[`${a}|${b}`] = identical;
    }
    return { diff, same, width };
  }, { variants, pairs });
}

test('Roboto, Arial, sans-serif and Roboto render pixel-identical', async ({ page }) => {
  const r = await compare(page, { list: { family: 'Roboto, Arial, sans-serif' }, roboto: { family: 'Roboto' } }, [['list', 'roboto']]);
  expect(r.same['list|roboto']).toBe(true);
});

test('Roboto differs from Arial by more than 2000 pixels (the bundled face is drawn)', async ({ page }) => {
  const r = await compare(page, { roboto: { family: 'Roboto' }, arial: { family: 'Arial' } }, [['roboto', 'arial']]);
  expect(r.diff['roboto|arial']).toBeGreaterThan(2000);
});

test('Roboto weight 700 differs from weight 400 by more than 2000 pixels (the bold face is bundled too)', async ({ page }) => {
  const r = await compare(page, { regular: { family: 'Roboto', weight: 400 }, bold: { family: 'Roboto', weight: 700 } }, [['regular', 'bold']]);
  expect(r.diff['regular|bold']).toBeGreaterThan(2000);
});

test('layout uses the face that is drawn: measured span width equals for Roboto and Roboto, Arial, and differs for Arial', async ({ page }) => {
  const r = await compare(page, { roboto: { family: 'Roboto' }, list: { family: 'Roboto, Arial' }, arial: { family: 'Arial' } }, []);
  expect(r.width.roboto).toBeGreaterThan(0);
  expect(r.width.list).toBe(r.width.roboto);
  expect(r.width.arial).not.toBe(r.width.roboto);
});

test('a family outside the bundle (Montserrat, Arial) renders the same as Arial', async ({ page }) => {
  const r = await compare(page, { montserrat: { family: 'Montserrat, Arial' }, arial: { family: 'Arial' } }, [['montserrat', 'arial']]);
  expect(r.same['montserrat|arial']).toBe(true);
  expect(r.width.montserrat).toBe(r.width.arial);
});
