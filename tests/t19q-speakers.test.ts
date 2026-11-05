// SPDX-License-Identifier: AGPL-3.0-only
// T19q round S2: the offline speaker clustering (average linkage on cosine distance) behind LocalModels.diarize.
import { describe, expect, it, vi, type Mock } from 'vitest';
import { averageLinkage } from '../apps/web/src/analysis/speakers';
import type { Transcript } from '../apps/web/src/analysis/types';

vi.mock('@huggingface/transformers', async orig => ({
  ...(await orig<object>()),
  AutoModel: { from_pretrained: vi.fn() },
  AutoProcessor: { from_pretrained: vi.fn() },
}));

/** A unit vector at `degrees`; the cosine distance between two of them is 1 - cos(angle between). */
const at = (degrees: number) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)];

describe('speakers.ts: averageLinkage', () => {
  it('returns no labels for no vectors and one label for one vector', () => {
    expect(averageLinkage([], 0.6)).toEqual([]);
    expect(averageLinkage([at(0)], 0.6)).toEqual([0]);
  });

  it('groups close vectors and keeps distant groups apart', () => {
    expect(averageLinkage([at(0), at(10), at(90), at(100)], 0.6)).toEqual([0, 0, 1, 1]);
  });

  it('numbers labels by first appearance in segment order', () => {
    expect(averageLinkage([at(90), at(0), at(95), at(5)], 0.6)).toEqual([0, 1, 0, 1]);
  });

  it('merges while the mean pairwise distance is within the threshold', () => {
    // 60 degrees apart: distance .5.
    expect(averageLinkage([at(0), at(60)], 0.55)).toEqual([0, 0]);
    expect(averageLinkage([at(0), at(60)], 0.45)).toEqual([0, 1]);
    // Orthogonal: distance exactly 1, which is within a threshold of 1.
    expect(averageLinkage([[1, 0], [0, 1]], 1)).toEqual([0, 0]);
  });

  it('uses the mean distance to a merged cluster, not the nearest member (no chaining)', () => {
    // 0-60 and 60-120 are each .5 apart; 0-120 is 1.5. After {0, 60} merges, its mean distance to 120 is 1.0.
    expect(averageLinkage([at(0), at(60), at(120)], 0.6)).toEqual([0, 0, 1]);
  });

  it('uses the mean distance, not the farthest member (complete linkage)', () => {
    // {0, 30} to 65: distances .577 and .181, mean .379 <= .4; the farthest member alone (.577) would not merge.
    expect(averageLinkage([at(0), at(30), at(65)], 0.4)).toEqual([0, 0, 0]);
  });

  it('weights the merged mean by cluster size (UPGMA, not WPGMA)', () => {
    // {0, 5, 10} to 50: the mean over all three members is .295 <= .3; halving at each merge can give .310.
    expect(averageLinkage([at(0), at(5), at(10), at(50)], 0.3)).toEqual([0, 0, 0, 0]);
  });

  it('breaks distance ties at the lowest index pair', () => {
    // (0, 1) and (1, 2) are both at distance 1: merging 0 with 1 first leaves 2 at a mean distance of 1.5.
    expect(averageLinkage([[1, 0], [0, 1], [-1, 0]], 1)).toEqual([0, 0, 1]);
  });
});

describe('models.ts: diarize with WeSpeaker vectors', () => {
  const words = (start: number) => [{ word: 'w', start, end: start + 1 }];
  const transcript = (starts: number[]): Transcript => ({ language: 'en', languages: ['en'], total_duration: 10, segments: starts.map((start, id) => ({ id, start, end: start + 1, text: 'w', speaker: -1, words: words(start) })) });

  it('loads nothing for an empty transcript and gives one integer label per segment otherwise', async () => {
    const { AutoModel, AutoProcessor } = await import('@huggingface/transformers');
    // The fake embedder points each clip at 0 or 90 degrees by the sign of its audio.
    const model = vi.fn(async ({ clip }: { clip: Float32Array }) => ({ last_hidden_state: { data: Float32Array.from(clip.reduce((s, v) => s + v, 0) > 0 ? [1, 0] : [0, 1]) } }));
    (AutoModel.from_pretrained as unknown as Mock).mockResolvedValue(model);
    (AutoProcessor.from_pretrained as unknown as Mock).mockResolvedValue(async (clip: Float32Array) => ({ clip }));
    const { LocalModels } = await import('../apps/web/src/analysis/models');
    const models = new LocalModels({ modelRoot: 'x', device: 'cpu' });

    const samples = new Float32Array(16000 * 10);
    const empty = transcript([]);
    await models.diarize(samples, empty);
    expect(AutoModel.from_pretrained).not.toHaveBeenCalled();

    for (const [start, value] of [[0, 1], [2, -1], [4, 1], [6, -1]]) samples.fill(value, start * 16000, (start + 1) * 16000);
    const four = transcript([0, 2, 4, 6]);
    await models.diarize(samples, four);
    expect(four.segments.map(s => s.speaker)).toEqual([0, 1, 0, 1]);
    expect(model).toHaveBeenCalledTimes(4);
    expect(AutoModel.from_pretrained).toHaveBeenCalledWith('onnx-community/wespeaker-voxceleb-resnet34-LM', expect.objectContaining({ device: 'cpu', dtype: 'fp32', local_files_only: true }));
  });
});
