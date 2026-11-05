// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the T15 browser specs (preview stage, seek, quality, playback, capture). Oracle labels are in each spec.
// Real media comes from the fixture store (S1) or from ffmpeg at test time; with neither, the spec skips with a visible reason.
import { expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STORE, hasStore } from '../media-fixtures';
import { createProject, linkClip } from './t02-support';

export { hasStore, STORE };
export const fixture = (...parts: string[]) => path.join(STORE, ...parts);
export const S1 = () => fixture('synthetic', 'S1-framecount-1080x1920-30fps-10s.mp4');
export const haveFile = (file: string) => hasStore && existsSync(file);
export const NO_STORE = 'the fixture store (CUTFRAME_FIXTURES / C:/Users/owner/cutframe-fixtures) is not present on this machine';

const track = (id: string, name: string, kind: string) => ({ id, name, kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
/** A 1080x1920 30 fps project: video tracks v1..vN (bottom first), one clip per entry of `clips`. */
export function videoDoc(clips: { id: string; track?: string; from?: number; to?: number; trim?: number; sourceDuration?: number; details?: Record<string, unknown>; properties?: Record<string, unknown>; effects?: unknown[] }[], extra: Record<string, unknown> = {}) {
  const ids = [...new Set(['v1', ...clips.map(c => c.track ?? 'v1')])].sort(), tracks = ids.map(id => track(id, id.toUpperCase(), 'video'));
  const end = Math.max(...clips.map(c => c.to ?? 10000));
  return {
    schemaVersion: 4, rev: 0, groups: {}, duration: end, fps: 30, size: { width: 1080, height: 1920 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })),
    items: clips.map(c => ({
      id: c.id, type: 'video', trackId: c.track ?? 'v1', display: { from: c.from ?? 0, to: c.to ?? 10000 }, trim: { from: c.trim ?? 0, to: (c.trim ?? 0) + (c.to ?? 10000) - (c.from ?? 0) },
      sourceDuration: c.sourceDuration ?? 10000, details: { name: c.id, ...c.details }, ...(c.properties ? { properties: c.properties } : {}), ...(c.effects ? { effects: c.effects } : {}),
    })),
    ...extra,
  };
}
/** Stores `bytes` as an asset attached to the project; returns its id. */
export async function uploadAsset(page: Page, projectId: string, bytes: Buffer, name: string, type: string) {
  return page.evaluate(async ({ projectId, name, type, b64 }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    const bin = atob(b64), data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const asset = await projectStore.upload(new File([data], name, { type })); await projectStore.attach(projectId, asset.id); return asset.id as string;
  }, { projectId, name, type, b64: bytes.toString('base64') });
}
/** Creates the project, uploads one video per clip id ({clip: file}) and opens the editor with the stage mounted. */
export async function openWithVideos(page: Page, doc: any, files: Record<string, { path: string; type?: string }>, title = 'T15 fixture') {
  const id = await createProject(page, doc, title), byFile = new Map<string, string>();
  for (const [clipId, f] of Object.entries(files)) {
    let assetId = byFile.get(f.path);
    if (!assetId) { assetId = await uploadAsset(page, id, readFileSync(f.path), path.basename(f.path), f.type ?? 'video/mp4'); byFile.set(f.path, assetId); }
    await linkClip(page, id, assetId, clipId);
  }
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return id;
}

/** The stage canvas of preview run i. */
export const runCanvas = (page: Page, i = 0) => page.locator(`canvas.run[data-run="${i}"]`);
/** Waits until the paused canvas shows `frame` exactly (data-frame is set together with data-exact="true" when the render lands). */
export async function shown(page: Page, frame: number, i = 0, timeout = 15000) {
  await expect(runCanvas(page, i)).toHaveAttribute('data-frame', String(frame), { timeout });
  await expect(runCanvas(page, i)).toHaveAttribute('data-exact', 'true', { timeout });
}
export const seekMs = (page: Page, ms: number) => page.evaluate(async ms => { const p = '/src/editor/view.ts'; (await import(p)).setView({ playheadMs: ms }); }, ms);
/** RGBA bytes of a canvas rectangle (unpremultiplied, as getImageData returns them). */
export async function crop(page: Page, x: number, y: number, w: number, h: number, i = 0): Promise<Uint8Array> {
  const b64 = await page.evaluate(({ x, y, w, h, i }) => {
    const c = document.querySelector(`canvas.run[data-run="${i}"]`) as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(x, y, w, h).data;
    let s = ''; for (let k = 0; k < d.length; k += 0x8000) s += String.fromCharCode(...d.subarray(k, k + 0x8000)); return btoa(s);
  }, { x, y, w, h, i });
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}
export const canvasSizeOf = (page: Page, i = 0) => runCanvas(page, i).evaluate((c: HTMLCanvasElement) => ({ width: c.width, height: c.height }));
/** Mean absolute difference over the RGB channels of an RGBA buffer and an RGB buffer of the same pixel count. */
export function meanAbsDiff(rgba: Uint8Array, rgb: Uint8Array) {
  let sum = 0; const n = rgb.length / 3;
  for (let p = 0; p < n; p++) for (let k = 0; k < 3; k++) sum += Math.abs(rgba[p * 4 + k] - rgb[p * 3 + k]);
  return sum / (n * 3);
}
/** A small H.264 clip made by ffmpeg at test time (cached per machine run): testsrc2, 30 fps, keyframe every 15 frames, no audio. */
export function makeClip(seconds: number, w = 320, h = 180): string {
  const dir = path.join(tmpdir(), 'cutframe-t15-media'); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `testsrc2-${w}x${h}-${seconds}s.mp4`);
  if (!existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', out]);
    expect(r.status, `ffmpeg: ${r.stderr?.toString().slice(-300)}`).toBe(0);
  }
  return out;
}
/** Like makeClip, plus a 440 Hz sine tone as AAC audio (so the asset has an audio track and the stage mounts a sound for it). */
export function makeAudioClip(seconds: number, w = 320, h = 180): string {
  const dir = path.join(tmpdir(), 'cutframe-t15-media'); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `testsrc2-sine-${w}x${h}-${seconds}s.mp4`);
  if (!existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
    expect(r.status, `ffmpeg: ${r.stderr?.toString().slice(-300)}`).toBe(0);
  }
  return out;
}
/** SHA-256 of a canvas's pixels (RGBA from getImageData). */
export const canvasHash = (page: Page, i = 0) => page.evaluate(async i => {
  const c = document.querySelector(`canvas.run[data-run="${i}"]`) as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', d))].map(b => b.toString(16).padStart(2, '0')).join('');
}, i);
/** Expected playing canvas size from the model formula with the display as measured now (no hard-coded sizes). */
export const expectedPlayingSize = (page: Page, i = 0) => page.evaluate(async i => {
  const m = '/src/render/model.ts', v = '/src/editor/view.ts', e = '/src/editor.tsx', { canvasSize, projectSize } = await import(m), { view } = await import(v), { activeSession } = await import(e);
  const r = (document.querySelector(`canvas.run[data-run="${i}"]`) as HTMLCanvasElement).getBoundingClientRect();
  return canvasSize(projectSize(activeSession.document), true, view().quality, { width: r.width, height: r.height }, devicePixelRatio || 1) as { width: number; height: number };
}, i);
/** Port 4214 is shared with the T15 implementer: callers check no listener is running before a run (see the brief). */
