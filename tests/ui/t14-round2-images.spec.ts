// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { bytes, expectedFacts, ffprobe, media } from '../media-fixtures';
import { datedAvi, heifCase } from '../t14-round2-fixtures';
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await page.goto('/'); });
const decode = (page: Page, encoded: Uint8Array) => page.evaluate(async b64 => {
  const lib = '/src/media/libav.ts'; const b = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const image = await (await import(lib)).decodeImageLibav(new Blob([b])); return { width: image.width, height: image.height, data: Array.from(image.data) as number[] };
}, Buffer.from(encoded).toString('base64'));
function errors(actual: number[], expected: Uint8Array) {
  let max = 0, se = 0; for (let i = 0; i < expected.length; i++) { const d = actual[Math.floor(i / 3) * 4 + i % 3] - expected[i]; max = Math.max(max, Math.abs(d)); se += d * d; }
  return { max, rms: Math.sqrt(se / expected.length) };
}
test('F20 software probe detects AVI and retains an ffprobe-confirmed remuxed date', async ({ page }) => {
  const dated = datedAvi(), plain = bytes(media('mpeg4.avi'));
  expect(ffprobe(dated.file).format.tags?.date).toBe('2020-01-02T03:04:05Z'); expect(ffprobe(media('mpeg4.avi')).format.format_name).toBe('avi');
  const r = await page.evaluate(async files => {
    const p = '/src/media/probe.ts'; const { probeMedia } = await import(p);
    return Promise.all(files.map(async b64 => probeMedia(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]), 'clip.avi', 'video')));
  }, [plain.toString('base64'), dated.bytes.toString('base64')]);
  expect.soft(r[0].container).toBe('avi'); expect.soft(r[0].capturedAt).toBeNull(); expect.soft(r[1].container).toBe('avi'); expect.soft(r[1].capturedAt).toBe('2020-01-02T03:04:05.000Z');
});
test('F20 supplemental forced software probe preserves supported MP4 rotation, date and ISO 6709 metadata', async ({ page }) => {
  // This is not evidence of a rotated/GPS-bearing AVI: those cases were not reproduced in review.
  for (const name of ['h264-aac.mp4', 'rotation-90.mp4']) {
    const f = media(name), facts = expectedFacts(f);
    const actual = await page.evaluate(async ({ name, b64 }) => { const p = '/src/media/libav.ts'; return (await import(p)).probeLibav(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]), name); }, { name, b64: bytes(f).toString('base64') });
    expect(actual.video).toMatchObject({ rotation: facts.video.rotation, displayWidth: facts.video.displayWidth, displayHeight: facts.video.displayHeight });
    const stamp = ffprobe(f).format.tags?.creation_time;
    expect(actual.capturedAt).toBe(stamp ? new Date(stamp).toISOString() : null); expect(actual.latitude).toBeCloseTo(52.37, 4); expect(actual.longitude).toBeCloseTo(4.89, 4);
  }
});
test('F21 HEIF imir axes and both irot/imir association orders match independent ffmpeg pixels', async ({ page }) => {
  const outputs: number[][] = [];
  for (const axis of [0, 1] as const) for (const rotation of [0, 1, 2, 3] as const) for (const mirrorFirst of [false, true]) {
    const f = heifCase({ axis, rotation, mirrorFirst }), actual = await decode(page, f.bytes), e = errors(actual.data, f.rgb);
    expect.soft([actual.width, actual.height]).toEqual([f.width, f.height]);
    console.log(`F21 axis=${axis} ccw=${rotation * 90} mirrorFirst=${mirrorFirst}: max=${e.max} rms=${e.rms}`);
    expect.soft(e.max).toBeLessThanOrEqual(2); expect.soft(e.rms).toBeLessThanOrEqual(1); outputs.push(actual.data);
  }
  expect(outputs[0]).not.toEqual(outputs[8]);
});
test('F22 HEIF colour: no colr VUI709 full, conflicting colr, unspecified fields, and absent-both', async ({ page }) => {
  for (const options of [{ vui: true }, { vui: true, colr: '601' }, { vui: true, colr: 'unspecified' }, { colr: '709' }, {}] as const) {
    const f = heifCase(options), encoded = ffprobe(f.encodedPath).streams[0];
    if (options.vui) expect([encoded.color_range, encoded.color_space, encoded.color_transfer, encoded.color_primaries]).toEqual(['pc', 'bt709', 'bt709', 'bt709']);
    else expect(encoded.color_space).toBeUndefined();
    const actual = await decode(page, f.bytes), e = errors(actual.data, f.rgb);
    console.log(`F22 ${JSON.stringify(options)}: max=${e.max} rms=${e.rms}`);
    expect.soft(e.max).toBeLessThanOrEqual(2); expect.soft(e.rms).toBeLessThanOrEqual(1);
  }
});
test('F23 SVG intrinsic physical units and one dimension plus viewBox preserve poster geometry and pixels', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const p = '/src/media/probe.ts', w = '/src/media/worker-client.ts'; const { probeMedia } = await import(p), { browserSteps } = await import(w);
    const cases = ['width="1in" height="1in"', 'width="2.54cm" height="25.4mm"', 'width="96" viewBox="0 0 2 1"', 'height="48" viewBox="0 0 2 1"', ''];
    return Promise.all(cases.map(async attrs => {
      const blob = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="50%" height="100%" fill="red"/><rect x="50%" width="50%" height="100%" fill="blue"/></svg>`], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob), image = new Image(); image.src = url; await image.decode(); const intrinsic = [image.naturalWidth, image.naturalHeight]; URL.revokeObjectURL(url);
      const info = await probeMedia(blob, 'units.svg', 'image'); const thumbs = await browserSteps().thumbnails({ blob, asset: { type: 'image' }, info, signal: new AbortController().signal });
      const bitmap = await createImageBitmap(thumbs.poster), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return { intrinsic, probed: [info.image.width, info.image.height], poster: [thumbs.width, thumbs.height], pixels: [Array.from(ctx.getImageData(10, 10, 1, 1).data), Array.from(ctx.getImageData(canvas.width - 10, 10, 1, 1).data)] };
    }));
  });
  expect(r[0].intrinsic).toEqual([96, 96]); expect(r[2].intrinsic).toEqual([96, 48]); expect(r[4].intrinsic).toEqual([300, 150]);
  for (const c of r) { expect.soft(c.probed).toEqual(c.intrinsic); expect.soft(c.poster).toEqual(c.intrinsic); expect(c.pixels[0][0]).toBeGreaterThan(240); expect(c.pixels[1][2]).toBeGreaterThan(240); }
});
