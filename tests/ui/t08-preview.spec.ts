// SPDX-License-Identifier: AGPL-3.0-only
// T08 motion graphics drawn by T15's render model: the paused preview shows the export's graphic frame (preview = export).
// Oracle: findings §16 addendum ("frame mapping after a start trim; clamp at the designed end; a split continues the graphic; preview and export give the
// same frame for the same timeline time"), ticket T08 "MG clock", D25 (itemWidth / itemHeight = the box, useVideoConfig = the project canvas),
// G-06 (durationInFrames = the clip length in frames), findings part 5 §53.1 (the box) and §53.5 (the canvas run).
// The graphic encodes its frame in 8 blocks (bit k white = set), so the drawn frame is read from the pixels, never from the code under test.
import { test, expect, type Page } from '@playwright/test';
import { createProject, guard, openEditor, skipTour } from './t02-support';
import { runCanvas, seekMs, shown } from './t15-support';

test.setTimeout(90_000);
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const seen: string[] = []; errors.set(page, seen);
  page.on('pageerror', e => seen.push(`pageerror: ${e.message}`));
  guard(page); await skipTour(page);
});
test.afterEach(async ({ page }) => { expect(errors.get(page), 'errors thrown in the page').toEqual([]); });

const FPS = 30, W = 540, H = 960;
const frameMs = (n: number) => n / FPS * 1000;
const COUNTER = (extra = '') => `export const Counter = () => { const f = useCurrentFrame(); ${extra} return <AbsoluteFill>{[0,1,2,3,4,5,6,7].map(k => <div key={k} style={{position:'absolute', left:k*itemWidth/8, top:0, width:itemWidth/8, height:itemHeight, backgroundColor: (f >> k) & 1 ? '#ffffff' : '#000000'}} />)}</AbsoluteFill>; };`;
type Box = { x: number; y: number; w: number; h: number };
const BOX: Box = { x: 100, y: 200, w: 200, h: 100 };

const track = { id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 };
const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });
type G = { id?: string; from?: number; to?: number; trim?: number; source?: number | null; box?: Box; code?: string | null };
/** A 540 x 960 30 fps project holding motion graphics on one overlay track. */
function doc(graphics: G[], extra: Record<string, unknown> = {}) {
  const items = graphics.map((g, n) => {
    const from = g.from ?? 0, to = g.to ?? 4000, box = g.box ?? BOX, trim = g.trim ?? 0;
    return { id: g.id ?? `g${n}`, type: 'motionGraphic', trackId: 'o1', display: { from, to }, trim: { from: trim, to: trim + to - from }, ...g.source === null ? {} : { sourceDuration: g.source ?? to - from },
      playbackRate: 1, details: { name: 'Motion graphic', ...g.code === null ? {} : { code: g.code ?? COUNTER() } }, metadata: { summary: 'A counter.' }, effects: [], masks: [],
      properties: { positionX: prop(box.x), positionY: prop(box.y), width: prop(box.w), height: prop(box.h), scale: prop(1) } };
  });
  return { schemaVersion: 4, rev: 0, groups: {}, duration: Math.max(...items.map(i => i.display.to)), fps: FPS, size: { width: W, height: H }, background: { type: 'color', value: 'transparent' },
    transitions: [], markers: [], tracks: [track], layerOrder: [{ type: 'track', id: 'o1' }], items, ...extra };
}

/** The frame the counter shows in `box` of run 0 (bit k = the block centre is bright), or null when the box centre is transparent. */
const readFrame = (page: Page, box: Box = BOX) => page.evaluate(({ box }) => {
  const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, ctx = c.getContext('2d')!, s = c.width / 540;
  let frame = 0;
  for (let k = 0; k < 8; k++) {
    const d = ctx.getImageData(Math.floor((box.x + (k + 0.5) * box.w / 8) * s), Math.floor((box.y + box.h / 2) * s), 1, 1).data;
    if (d[3] < 250) return null;
    if (d[0] > 128) frame |= 1 << k;
  }
  return frame;
}, { box });
/** Bounding box of all non-transparent pixels of run 0, and how many pixels are non-transparent. */
const painted = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 0) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n } : null;
});
/** Seek to timeline frame `n` (a project frame) and wait for the exact picture. */
async function showAt(page: Page, n: number) { await seekMs(page, frameMs(n)); await shown(page, n); }

test.describe('paused preview draws the export\'s graphic frame', () => {
  test('1. an opaque graphic is drawn in exactly its box (x 100, y 200, 200 x 100) and nowhere else; data-exact is true', async ({ page }) => {
    await openEditor(page, doc([{}]), 'T08 box');
    await showAt(page, 15); // 500 ms
    expect(await readFrame(page)).toBe(15);
    expect(await painted(page)).toEqual({ x: 100, y: 200, w: 200, h: 100, n: 200 * 100 });
    await expect(runCanvas(page)).toHaveAttribute('data-exact', 'true');
    const size = await runCanvas(page).evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
    expect(size).toEqual([W, H]);
  });

  test('2. a start trim of 1000 ms: at t = 500 ms the drawn frame is 45 (1500 ms into the graphic)', async ({ page }) => {
    await openEditor(page, doc([{ from: 0, to: 3000, trim: 1000, source: 4000 }]), 'T08 trim');
    await showAt(page, 15);
    expect(await readFrame(page)).toBe(45);
  });

  test('3. past the designed end (2000 ms = frames 0-59) inside a longer clip the frame stays at the last frame, 59', async ({ page }) => {
    await openEditor(page, doc([{ from: 0, to: 6000, source: 2000 }]), 'T08 clamp');
    await showAt(page, 59); expect(await readFrame(page)).toBe(59);
    await showAt(page, 60); expect(await readFrame(page)).toBe(59);
    await showAt(page, 150); expect(await readFrame(page)).toBe(59);
    await showAt(page, 30); expect(await readFrame(page)).toBe(30);
  });

  test('4. a split continues the graphic: the last frame before the cut and the first after it are consecutive', async ({ page }) => {
    await openEditor(page, doc([{ id: 'g', from: 0, to: 6000, source: 6000 }]), 'T08 split');
    const r = await page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; return (await import(p)).activeRuntime.call('splitItem', { itemId: 'g', timestampS: 3 }); }) as { success: boolean; data: { leftItemId: string; rightItemId: string } };
    expect(r.success).toBe(true);
    const items = await page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document.items)); }) as { id: string; display: { from: number; to: number }; trim: { from: number } }[];
    expect(items.find(i => i.id === r.data.rightItemId)).toMatchObject({ display: { from: 3000 }, trim: { from: 3000 } });
    expect(items.find(i => i.id === r.data.leftItemId)).toMatchObject({ display: { from: 0, to: 3000 } });
    await showAt(page, 89); const before = await readFrame(page);
    await showAt(page, 90); const after = await readFrame(page);
    expect(before).toBe(89);
    expect(after).toBe(90);
    expect(after! - before!).toBe(1);
    await showAt(page, 150); expect(await readFrame(page)).toBe(150);
  });

  test('5. D25 / config: a div of itemWidth x itemHeight fills exactly the box; useVideoConfig is the project canvas and durationInFrames is the clip length in frames', async ({ page }) => {
    // Green only if every number is right (clip 2000 ms at 30 fps = 60 frames); red otherwise.
    const code = `export const Cfg = () => { const c = useVideoConfig(); const ok = itemWidth === 200 && itemHeight === 100 && c.width === ${W} && c.height === ${H} && c.fps === ${FPS} && c.durationInFrames === 60; return <div style={{width:itemWidth, height:itemHeight, backgroundColor: ok ? '#00ff00' : '#ff0000'}} />; };`;
    await openEditor(page, doc([{ from: 0, to: 2000, code }]), 'T08 config');
    await showAt(page, 15);
    const px = await page.evaluate(({ box }) => {
      const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(box.x, box.y, box.w, box.h).data;
      const bad: number[] = []; for (let i = 0; i < d.length; i += 4) if (d[i] !== 0 || d[i + 1] !== 255 || d[i + 2] !== 0 || d[i + 3] !== 255) bad.push(i / 4);
      return bad.length;
    }, { box: BOX });
    expect(px, 'pixels of the box that are not opaque green').toBe(0);
    expect(await painted(page)).toEqual({ x: 100, y: 200, w: 200, h: 100, n: 200 * 100 });
  });

  test('6. preview = export: the export path (framePlan, picture, composite) gives the same pixels in the box as the paused preview, and as a direct render of the frame', async ({ page }) => {
    await openEditor(page, doc([{ from: 0, to: 4000, trim: 600, source: 4000 }]), 'T08 export');
    await showAt(page, 15); // t = 500 ms; graphic time 1100 ms = frame 33
    expect(await readFrame(page)).toBe(33);
    const r = await page.evaluate(async ({ box }) => {
      const m = '/src/render/model.ts', s = '/src/render/sources.ts', k = '/src/render/compositor.ts', d = '/src/store/database.ts', e = '/src/editor.tsx', g = '/src/mg/index.ts';
      const { framePlan, projectSize } = await import(m), { picture } = await import(s), { composite } = await import(k), { projectStore } = await import(d), { activeSession } = await import(e), { createMotionGraphicRenderer } = await import(g);
      const doc = activeSession.document, size = projectSize(doc), t = 500;
      const plan = framePlan(doc, t, size), sources = await Promise.all(plan.draws.map((x: any) => picture(projectStore, x, undefined)));
      const out = new OffscreenCanvas(size.width, size.height), ctx = out.getContext('2d')!;
      composite(ctx as any, plan.draws, sources, size, 'black');
      const bytes = (data: Uint8ClampedArray) => Array.from(data);
      const exported = bytes(ctx.getImageData(box.x, box.y, box.w, box.h).data);
      const live = bytes((document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement).getContext('2d')!.getImageData(box.x, box.y, box.w, box.h).data);
      // A direct render of the expected frame (33), laid out at the box size.
      const draw = plan.draws[0], renderer = createMotionGraphicRenderer();
      const res = await renderer.render({ code: draw.item.details.code, frame: 33, width: size.width, height: size.height, fps: 30, durationInFrames: draw.graphic.durationInFrames, fieldValues: {}, assetMap: {}, itemSize: { width: draw.box.W, height: draw.box.H } });
      const img = new Image(); img.src = res.image; await img.decode();
      const direct = new OffscreenCanvas(box.w, box.h), dctx = direct.getContext('2d')!; dctx.drawImage(img, 0, 0, box.w, box.h);
      const directBytes = bytes(dctx.getImageData(0, 0, box.w, box.h).data);
      const diff = (a: number[], b: number[]) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
      return { count: plan.draws.length, graphicFrame: draw.graphic.frame, length: live.length, exportVsPreview: diff(exported, live), directVsPreview: diff(directBytes, live), allOpaque: live.every((v, i) => i % 4 !== 3 || v === 255) };
    }, { box: BOX });
    expect(r.count).toBe(1);
    expect(r.graphicFrame).toBe(33);
    expect(r.length).toBe(BOX.w * BOX.h * 4);
    expect(r.allOpaque).toBe(true);
    expect(r.exportVsPreview, 'RGBA bytes that differ between the export frame and the paused preview').toBe(0);
    expect(r.directVsPreview, 'RGBA bytes that differ between a direct render of frame 33 and the paused preview').toBe(0);
  });

  test('7. getAssetUrl: an <Img> of a linked image shows the image\'s pixels', async ({ page }) => {
    // A 2 x 2 PNG: red, green / blue, yellow. Stretched over the 200 x 100 box, each quadrant centre is its own texel centre.
    const code = `export const Pic = () => <Img src={getAssetUrl('image_1')} style={{width:itemWidth, height:itemHeight, imageRendering:'pixelated'}} />;`;
    const id = await createProject(page, doc([{ code }]), 'T08 asset');
    const agentId = await page.evaluate(async ({ id }) => {
      const p = '/src/store/database.ts'; const { projectStore } = await import(p);
      const c = new OffscreenCanvas(2, 2), x = c.getContext('2d')!;
      [['#ff0000', 0, 0], ['#00ff00', 1, 0], ['#0000ff', 0, 1], ['#ffff00', 1, 1]].forEach(([col, px, py]) => { x.fillStyle = col as string; x.fillRect(px as number, py as number, 1, 1); });
      const blob = await c.convertToBlob({ type: 'image/png' }), asset = await projectStore.upload(new File([blob], 'quad.png', { type: 'image/png' }));
      await projectStore.updateAsset(asset.id, (a: any) => ({ ...a, processing_status: 'ready', processing_steps: { ...a.processing_steps, probe: 'complete', thumbnails: 'complete' } }));
      await projectStore.attach(id, asset.id);
      return ((await projectStore.projectAssets(id)) as { agent_id: string }[]).map(l => l.agent_id);
    }, { id });
    expect(agentId).toEqual(['image_1']);
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await showAt(page, 0).catch(() => undefined); // playhead 0 is already shown; the wait below is the real one
    await expect(runCanvas(page)).toHaveAttribute('data-exact', 'true', { timeout: 20000 });
    const quad = await page.evaluate(({ box }) => {
      const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, x = c.getContext('2d')!;
      const at = (u: number, v: number) => Array.from(x.getImageData(box.x + u, box.y + v, 1, 1).data);
      return { tl: at(50, 25), tr: at(150, 25), bl: at(50, 75), br: at(150, 75), outside: Array.from(x.getImageData(box.x - 5, box.y - 5, 1, 1).data) };
    }, { box: BOX });
    expect(quad).toEqual({ tl: [255, 0, 0, 255], tr: [0, 255, 0, 255], bl: [0, 0, 255, 255], br: [255, 255, 0, 255], outside: [0, 0, 0, 0] });
  });

  test('8. a graphic that throws at frame >= 30 draws at frame 10 and draws nothing at frame 40 (data-exact false, nothing thrown in the page)', async ({ page }) => {
    const code = COUNTER(`if (f >= 30) throw new Error('G-06 boom at frame ' + f);`);
    await openEditor(page, doc([{ code }]), 'T08 broken');
    await showAt(page, 10);
    expect(await readFrame(page)).toBe(10);
    await seekMs(page, frameMs(40));
    await expect(runCanvas(page)).toHaveAttribute('data-frame', '40', { timeout: 20000 });
    await expect(runCanvas(page)).toHaveAttribute('data-exact', 'false');
    expect(await painted(page)).toBeNull();
    await showAt(page, 20); expect(await readFrame(page)).toBe(20); // a good frame afterwards draws again
  });

  test('9. stage note: neither a graphic with code nor a graphic without code (an empty graphic) shows a "Not rendered yet" note', async ({ page }) => {
    await openEditor(page, doc([{}]), 'T08 note with code');
    await showAt(page, 15);
    await expect(page.locator('p.pending-render')).toHaveCount(0);
    await openEditor(page, doc([{ code: null }]), 'T08 note without code');
    await showAt(page, 15); // the empty graphic: nothing drawn, nothing pending, no note
    await expect(page.locator('p.pending-render')).toHaveCount(0);
    expect(await painted(page)).toBeNull();
  });

  test('10. playback: ~1.5 s of play paints and never fails (stale or not-ready frames are allowed); after the pause the paused frame is exact again', async ({ page }) => {
    await openEditor(page, doc([{ to: 3000 }]), 'T08 playback');
    await showAt(page, 0);
    await page.evaluate(async () => { const p = '/src/render/playback.ts'; (await import(p)).resetPlaybackStats(); });
    await page.locator('section.preview').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(async () => { const p = '/src/render/playback.ts'; return (await import(p)).usePlayback.getState().playing as boolean; })).toBe(true);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(async () => { const p = '/src/render/playback.ts'; return (await import(p)).usePlayback.getState().playing as boolean; })).toBe(false);
    const stats = await page.evaluate(async () => { const p = '/src/render/playback.ts'; return { ...(await import(p)).playbackStats } as Record<string, number>; });
    expect(stats.painted, JSON.stringify(stats)).toBeGreaterThan(0);
    expect(stats.failed, JSON.stringify(stats)).toBe(0);
    const ms = await page.evaluate(async () => { const p = '/src/editor/view.ts'; return (await import(p)).view().playheadMs as number; });
    expect(ms).toBeGreaterThan(500);
    const n = Math.round(ms / 1000 * FPS);
    await shown(page, n, 0, 20000);
    expect(await readFrame(page)).toBe(Math.min(n, 89));
  });
});
