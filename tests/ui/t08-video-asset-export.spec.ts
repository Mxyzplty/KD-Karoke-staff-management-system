// SPDX-License-Identifier: AGPL-3.0-only
// T08 attached video asset in an exported MG. Oracle: Author's ruling of 9 Nov, "an MG with an attached video asset exports and its video plays".
// OPFS keeps no MIME type, so before the fix the blob URL behind getAssetUrl had type '' and the video never loaded: the export failed.
// The asset is uploaded through the app with its real MIME type and attached (agent id video_1); the MG shows it 1:1 on a 64 x 64 canvas at 30 fps;
// the export runs the real route (startExport). Ground truth: the counter video's 8 luma blocks encode the source frame number in binary (bit k =
// block k from the left; t08-support counterVideo), so output frame n must decode to source frame n (no trim, rate 1). A failed export, a blank,
// a frozen or a wrong-time video each leave a mismatch.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ffmpegAvailable } from '../media-fixtures';
import { createProject, skipTour } from './t02-support';
import { uploadAsset } from './t15-support';
import { counterVideo } from './t08-support';
import { completed, decodeRgba, mimeOf, openAndIngest, runExport } from './t16a-support';

const SIZE = 64, FPS = 30, FRAMES = 30, p = (v: number) => ({ defaultValue: v, keyframes: [] });
const CODE = `export const G = () => <OffthreadVideo src={getAssetUrl('video_1')} style={{width:${SIZE},height:${SIZE}}} muted={true} volume={0} />;`;
const doc = {
  schemaVersion: 4, rev: 0, groups: {}, duration: 1000, fps: FPS, size: { width: SIZE, height: SIZE }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: [{ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 }], layerOrder: [{ type: 'track', id: 'o1' }],
  items: [{
    id: 'g1', type: 'motionGraphic', trackId: 'o1', display: { from: 0, to: 1000 }, trim: { from: 0, to: 1000 }, sourceDuration: 1000, playbackRate: 1,
    details: { name: 'Attached video', code: CODE }, metadata: {}, effects: [], masks: [],
    properties: { positionX: p(0), positionY: p(0), width: p(SIZE), height: p(SIZE), scale: p(1) },
  }],
};

test.skip(!ffmpegAvailable(), 'ffmpeg generates the counter video and decodes the exported file');
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

test('an MG with an attached video asset exports and its video plays (output frame n shows source frame n)', async ({ page }) => {
  const file = counterVideo(), id = await createProject(page, doc, 'T08 attached video');
  await uploadAsset(page, id, readFileSync(file), path.basename(file), mimeOf(file));
  // The code names video_1: the first video attached to the project.
  const agentIds = await page.evaluate(async id => { const s = '/src/store/database.ts'; return ((await (await import(s)).projectStore.projectAssets(id)) as { agent_id: string }[]).map(l => l.agent_id); }, id);
  expect(agentIds).toEqual(['video_1']);
  await openAndIngest(page, id); // the editor's runtime hands the live links to getAssetUrl
  const run = await runExport(page, id); completed(run);
  const frames = decodeRgba(run.file!, SIZE, SIZE);
  expect(frames).toHaveLength(FRAMES);
  const decoded = frames.map(f => { let n = 0; for (let k = 0; k < 8; k++) if (f[(32 * SIZE + 4 + 8 * k) * 4] > 128) n |= 1 << k; return n; });
  test.info().annotations.push({ type: 'decoded source frame per output frame', description: JSON.stringify(decoded) });
  const mismatches = decoded.flatMap((n, i) => n === i ? [] : [`output frame ${i}: expected source frame ${i}, got ${n}`]);
  expect(mismatches).toEqual([]);
});
