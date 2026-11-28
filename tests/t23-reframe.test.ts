// SPDX-License-Identifier: AGPL-3.0-only
// T23 RF-P02's starting state (round 1 R1, lane A's order): clip 2 placed the way the app places it (addMedia → mediaItem →
// fitProperties) can be panned after resizeCanvas 9:16 and transformItem fillCanvas, so every annotated SUBJ point can sit in
// the middle 30 % of the width inside the clamp [W − D, 0]. Geometry is the app's own (render/model.ts framePlan and cover),
// the mapping the RF-P02 scorer uses (tests/ui/t23-model-runs.spec.ts scoreReframe). Oracle: fixtures/SUBJ clip 2 subject centre.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cover, framePlan } from '../apps/web/src/render/model';
import type { Asset, AssetLink, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { build, mkTrack, video } from './t03-fixtures';

type Subj = { clip: { width: number; height: number; duration: number }; shot: { start_s: number; end_s: number }; points: { t_s: number; x: number | null; y: number | null }[] };
const SUBJ = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/SUBJ clip 2 subject centre.json', import.meta.url)), 'utf8')) as Subj;
const { width: SW, height: SH } = SUBJ.clip;
const CLIP2 = { id: 'asset-clip2', name: 'tos-action-30s.mp4', type: 'video', sizeBytes: 1000, mimeType: 'video/mp4', folderId: null, created_at: '2026-10-01T00:00:00Z', recorded_at: null,
  location: 'local://asset-clip2', durationMs: SUBJ.clip.duration * 1000, media: { video: { displayWidth: SW, displayHeight: SH }, durationMs: SUBJ.clip.duration * 1000 } } as unknown as Asset;
const LINK = { id: 'link-video_1', projectId: 'p1', assetId: CLIP2.id, agent_id: 'video_1', content_type: 'video', added_at: '2026-10-01T00:00:00Z', deleted_at: null } as unknown as AssetLink;
const doc1080p = (items: RecordData[] = []) => build({ tracks: [mkTrack('V1', 'video')], items, extra: { size: { width: 1920, height: 1080 } } });
type Res = { success: boolean; code?: string; data?: any };

function reframed(editor: ReturnType<typeof createEditor>, itemId: string) {
  expect((editor.runtime.call('resizeCanvas', { aspectRatio: '9:16' }) as Res).success).toBe(true);
  expect(editor.doc.size).toEqual({ width: 1080, height: 1920 });
  const r = editor.runtime.call('transformItem', { itemId, fillCanvas: true }) as Res;
  expect(r.success).toBe(true);
  return r.data.drawnBox as { x: number; y: number; width: number; height: number };
}
/** The subject's canvas x at one SUBJ point, with the box at left edge x: the scorer's mapping (cover rectangle → draw matrix). */
function subjectX(editor: ReturnType<typeof createEditor>, itemId: string, x: number, p: { t_s: number; x: number; y: number }) {
  expect((editor.runtime.call('transformItem', { itemId, x }) as Res).success).toBe(true);
  const i = editor.doc.items.find(k => k.id === itemId)!, t = p.t_s * 1000 - i.trim.from + i.display.from;
  const d = framePlan(editor.doc, t).draws.find(k => k.kind === 'video' && k.item.id === itemId)!;
  expect(Math.abs(d.sourceMs - p.t_s * 1000), `source time at ${p.t_s} s`).toBeLessThanOrEqual(50);
  const r = cover(SW, SH, d.box.W, d.box.H)!, m = d.matrix, u = r.x + p.x * r.w / SW, v = r.y + p.y * r.h / SH;
  return m[0] * u + m[2] * v + m[4];
}

describe('T23 RF-P02 start state: clip 2 as the app places it', () => {
  it('addMedia stores the clip\'s size, and fillCanvas on 9:16 gives a box wider than the canvas', () => {
    const editor = createEditor(doc1080p(), { assets: [CLIP2], links: [LINK] });
    const placed = editor.runtime.call('addMedia', { assetId: 'video_1', trackId: 'V1', trimStart: SUBJ.shot.start_s, trimEnd: SUBJ.shot.end_s }) as Res;
    expect(placed.success).toBe(true);
    const item = editor.doc.items.find(i => i.metadata?.assetId === CLIP2.id)!;
    expect(item.properties.width).toBeDefined(); expect(item.properties.height).toBeDefined();
    const box = reframed(editor, item.id), W = editor.doc.size.width;
    expect(box.width).toBeGreaterThan(W);
  });
  const scored = SUBJ.points.filter((p): p is { t_s: number; x: number; y: number } => p.x !== null && p.y !== null);
  it('the SUBJ file has the 12 annotated points RF-P02 scores', () => expect(scored).toHaveLength(12));
  for (const p of scored) it(`at ${p.t_s} s a positionX inside [W − D, 0] puts the subject in the middle 30 %`, () => {
    const editor = createEditor(doc1080p(), { assets: [CLIP2], links: [LINK] });
    editor.runtime.call('addMedia', { assetId: 'video_1', trackId: 'V1', trimStart: SUBJ.shot.start_s, trimEnd: SUBJ.shot.end_s });
    const id = editor.doc.items[0].id, D = reframed(editor, id).width, W = editor.doc.size.width, lo = W - D;
    // The mapping is affine in x: solve for the centre, clamp, then check the result through the app again.
    const at0 = subjectX(editor, id, 0, p), atLo = subjectX(editor, id, lo, p), slope = (at0 - atLo) / -lo;
    const x = Math.min(0, Math.max(lo, (W / 2 - at0) / slope));
    expect(x).toBeGreaterThanOrEqual(lo); expect(x).toBeLessThanOrEqual(0);
    expect(Math.abs(subjectX(editor, id, x, p) - W / 2)).toBeLessThanOrEqual(0.15 * W);
  });
  it('negative: the old harness item with no stored properties is drawn 1080 wide, so it cannot pan', () => {
    const len = (SUBJ.shot.end_s - SUBJ.shot.start_s) * 1000;
    const editor = createEditor(doc1080p([video('c', 'V1', 0, len, SUBJ.shot.start_s * 1000, SUBJ.clip.duration * 1000, { metadata: { assetId: CLIP2.id } })]), { assets: [CLIP2], links: [LINK] });
    expect(reframed(editor, 'c').width).toBe(1080);
  });
});
