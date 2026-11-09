// SPDX-License-Identifier: AGPL-3.0-only
// T21 First Edit beat plan (§28b.3.2): the pure analysis, cut boundaries, clip pools and plan, with no pack and no browser.
import { describe, expect, test } from 'vitest';
import { analyse, buildPlan, clipPools, clock, cutBoundaries, pickMusic, SYNTHETIC } from '../apps/web/src/settings/first-edit/plan';
import type { DemoAsset, RhythmData } from '../apps/web/src/settings/first-edit/plan';

/** A beat every `step` seconds, `count` of them from 0. */
const grid = (count: number, step = 0.5) => Array.from({ length: count }, (_, n) => n * step);
const song = (name: string, rhythm?: RhythmData, extra: Partial<DemoAsset> = {}): DemoAsset => ({ id: name, type: 'audio', name, durationMs: 30_000, rhythm_data: rhythm, ...extra });
const video = (name: string, durationMs = 10_000): DemoAsset => ({ id: name, type: 'video', name, durationMs });
const deltas = (times: number[]) => times.slice(1).map((t, n) => t - times[n]);

describe('SYNTHETIC', () => {
  test('41 beats every 500 ms (120 BPM), the drop at 8 s, and no BPM to show', () => {
    expect(SYNTHETIC.beats).toHaveLength(41);
    expect(SYNTHETIC.beats[0]).toBe(0);
    expect(SYNTHETIC.beats[40]).toBe(20_000);
    expect(deltas(SYNTHETIC.beats).every(d => d === 500)).toBe(true);
    expect(SYNTHETIC.interval).toBe(500);
    expect(60_000 / SYNTHETIC.interval).toBe(120);
    expect(SYNTHETIC.bpm).toBeNull();
    expect(SYNTHETIC.drop).toBe(8_000);
    expect(SYNTHETIC.end).toBe(20_500);
  });
});

describe('pickMusic', () => {
  test('prefers a beat-analysed asset with "fever" in its name', () => {
    const rhythm = { beats: grid(10) };
    const a = song('Calm.mp3', rhythm), fever = song('Night Fever.mp3', rhythm);
    expect(pickMusic([a, fever])).toBe(fever);
    expect(pickMusic([fever, a])).toBe(fever);
  });
  test('else the first with beats, else the first audio, else nothing', () => {
    const plain = song('Plain.mp3'), beaten = song('Beaten.mp3', { beats: grid(10) });
    expect(pickMusic([plain, beaten])).toBe(beaten);
    expect(pickMusic([plain])).toBe(plain);
    expect(pickMusic([video('clip.webm')])).toBeUndefined();
    expect(pickMusic([])).toBeUndefined();
  });
  test('a "fever" track without beats loses to a beaten one', () => {
    const fever = song('Fever.mp3'), beaten = song('Other.mp3', { pulseBeats: grid(10) });
    expect(pickMusic([fever, beaten])).toBe(beaten);
  });
});

describe('analyse', () => {
  test('null for fewer than 8 beats, a plan for exactly 8', () => {
    expect(analyse({ rhythm_data: { beats: grid(7) } })).toBeNull();
    expect(analyse({ rhythm_data: {} })).toBeNull();
    expect(analyse({})).toBeNull();
    expect(analyse({ rhythm_data: { beats: grid(8) } })).not.toBeNull();
  });
  test('the median interval, the BPM from it, and an end one interval past the last beat', () => {
    const a = analyse({ rhythm_data: { beats: grid(20) } })!;
    expect(a.beats).toHaveLength(20);
    expect(a.beats[1]).toBe(500);
    expect(a.interval).toBe(500);
    expect(a.bpm).toBe(120);
    expect(a.end).toBe(9_500 + 500);
  });
  test('the median ignores a stray long gap', () => {
    const beats = [...grid(10), 20, 20.5, 21, 21.5];
    expect(analyse({ rhythm_data: { beats } })!.interval).toBe(500);
  });
  test('a stored bpm / averageBpm wins over the one derived from the interval', () => {
    expect(analyse({ rhythm_data: { beats: grid(10), bpm: 118 } })!.bpm).toBe(118);
    expect(analyse({ rhythm_data: { pulseBeats: grid(10), averageBpm: 121.5 } })!.bpm).toBe(121.5);
    expect(analyse({ rhythm_data: { beats: grid(10), bpm: 0, averageBpm: null } })!.bpm).toBe(120);
  });
  test('reads number, [time, strength], and {time|t} beat shapes, sorted, in milliseconds', () => {
    const beats = [[0.5, 1], { t: 1 }, 1.5, { time: 2 }, [2.5, 0.2], 3, 3.5, { time: 0, strength: 1 }, -1, 'bad' as unknown as number];
    expect(analyse({ rhythm_data: { beats: beats as never } })!.beats).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
  });
  test('the drop: a segment named drop, else the strongest onset in the middle, else the beat past 40 %', () => {
    const rhythm = { beats: grid(41) }; // 0 … 20 s, end 20.5 s
    expect(analyse({ rhythm_data: rhythm, segments: [{ start_time: 0, label: 'Drop' }, { start_time: 9.2, description: 'the DROP hits' }, { start_time: 5, label: 'verse' }] })!.drop).toBe(9_200);
    const onsets = [[2, 9], [10.5, 3], [12, 5], [19, 8]] as [number, number][]; // 2 s and 19 s are outside 25–80 % of the end
    expect(analyse({ rhythm_data: { ...rhythm, onsets } })!.drop).toBe(12_000);
    expect(analyse({ rhythm_data: rhythm })!.drop).toBe(8_500); // first beat at or past 0.4 × 20 500 = 8 200
  });
});

describe('cutBoundaries', () => {
  const synthetic = cutBoundaries(SYNTHETIC);
  test('starts at 0, and the intro runs two four-beat cuts, then two-beat cuts, then the build in single beats up to the drop', () => {
    expect(synthetic.times[0]).toBe(0);
    expect(synthetic.times.slice(0, synthetic.intro + 1)).toEqual([0, 2_000, 4_000, 5_000, 6_000]); // dropIndex 16, intro ends at beat 12
    expect(synthetic.intro).toBe(4);
    expect(synthetic.times.slice(synthetic.intro, synthetic.afterDrop + 1)).toEqual([6_000, 6_500, 7_000, 7_500, 8_000]);
    expect(synthetic.times[synthetic.afterDrop]).toBe(SYNTHETIC.drop);
  });
  test('after the drop the 1,1,2,1,1,4 beat pattern repeats inside the 20 s window', () => {
    const after = deltas(synthetic.times.slice(synthetic.afterDrop));
    expect(after.slice(0, 6)).toEqual([500, 500, 1_000, 500, 500, 2_000]);
    expect(after.slice(6, 8)).toEqual([500, 500]);
    expect(synthetic.times[synthetic.times.length - 1]).toBeLessThanOrEqual(20_500);
  });
  test('boundaries strictly increase, SYNTHETIC stays within 28 segments, and post-drop cuts are never closer than 200 ms', () => {
    expect(synthetic.times.length - 1).toBeLessThanOrEqual(28);
    expect(deltas(synthetic.times).every(d => d > 0)).toBe(true);
    const fast = cutBoundaries({ beats: Array.from({ length: 60 }, (_, n) => n * 100), interval: 100, bpm: 600, end: 6_000, drop: 1_000 });
    expect(deltas(fast.times).every(d => d > 0)).toBe(true);
    const post = deltas(fast.times.slice(fast.afterDrop));
    expect(post.length).toBeGreaterThan(1);
    expect(Math.min(...post)).toBeGreaterThanOrEqual(200);
  });
  test('a drop near the start leaves no intro and still begins at 0', () => {
    const early = cutBoundaries({ ...SYNTHETIC, drop: 1_000 });
    expect(early.intro).toBe(0);
    expect(early.times[0]).toBe(0);
    expect(early.times.length).toBeGreaterThan(2);
  });
});

describe('clipPools', () => {
  const mountain = video('Mountain top.webm', 12_000), hiking = video('hiking_trail.webm', 9_000), skate = video('skate trick.webm', 6_000), slow = video('slowmo flip.webm', 5_000);
  test('scenic by name, action is the rest, slowmo by name', () => {
    const p = clipPools([mountain, hiking, skate, slow, song('s.mp3')]);
    expect(p.videos).toHaveLength(4);
    expect(p.scenic).toEqual([mountain, hiking]);
    expect(p.action).toEqual([skate, slow]);
    expect(p.slowmo).toEqual([slow]);
  });
  test('with no scenic name the longest half is scenic', () => {
    const a = video('a.webm', 4_000), b = video('b.webm', 9_000), c = video('c.webm', 6_000), d = video('d.webm', 2_000);
    const p = clipPools([a, b, c, d]);
    expect(p.scenic).toEqual([b, c]);
    expect(p.action).toEqual([a, d]);
    expect(p.slowmo).toEqual([]);
  });
  test('videos without a duration are ignored; with one pool empty action falls back to every video', () => {
    expect(clipPools([video('x.webm', 0)]).videos).toEqual([]);
    const only = clipPools([mountain]);
    expect(only.scenic).toEqual([mountain]);
    expect(only.action).toEqual([mountain]);
  });
});

describe('buildPlan', () => {
  const music = song('Night Fever.mp3', { beats: grid(41) }, { segments: [{ start_time: 8, label: 'Drop' }] });
  const videos = [video('Mountain top.webm', 12_000), video('hiking.webm', 12_000), video('skate.webm', 12_000), video('bike.webm', 12_000), video('slowmo flip.webm', 12_000)];
  const plan = buildPlan([...videos, music]);
  test('picks the music, analyses it and cuts at the boundaries', () => {
    expect(plan.music).toBe(music);
    expect(plan.analysis.bpm).toBe(120);
    expect(plan.analysis.drop).toBe(8_000);
    expect(plan.boundaries).toEqual(cutBoundaries(plan.analysis).times);
    expect(plan.cuts).toHaveLength(plan.boundaries.length - 1 - plan.skipped);
    expect(plan.skipped).toBe(0);
    expect(plan.sourceEnd).toBe(plan.boundaries[plan.boundaries.length - 1]);
  });
  test('every cut is as long as its boundary gap, uses a real video, and fits inside it', () => {
    const lengths = deltas(plan.boundaries);
    plan.cuts.forEach((c, n) => {
      const clip = videos.find(v => v.id === c.assetId)!;
      expect(clip, c.assetId).toBeDefined();
      expect(c.trimEnd - c.trimStart).toBe(lengths[n]);
      expect(c.trimStart).toBeGreaterThanOrEqual(0);
      expect(c.trimEnd).toBeLessThanOrEqual(clip.durationMs);
    });
  });
  test('the intro cuts use scenic clips and no clip repeats back to back before the drop', () => {
    const scenic = new Set(['Mountain top.webm', 'hiking.webm']), { intro } = cutBoundaries(plan.analysis);
    plan.cuts.slice(0, intro).forEach(c => expect(scenic.has(c.assetId), c.assetId).toBe(true));
    const { afterDrop } = cutBoundaries(plan.analysis), before = plan.cuts.slice(0, afterDrop); // a one-clip slow-motion pool may repeat
    before.slice(1).forEach((c, n) => expect(c.assetId).not.toBe(before[n].assetId));
  });
  test('with no usable song it falls back to SYNTHETIC; with no video the cuts are empty but the source range stays', () => {
    const noSong = buildPlan(videos);
    expect(noSong.music).toBeUndefined();
    expect(noSong.analysis).toBe(SYNTHETIC);
    expect(noSong.cuts.length).toBeGreaterThan(0);
    const noVideo = buildPlan([music]);
    expect(noVideo.cuts).toEqual([]);
    expect(noVideo.skipped).toBe(0);
    expect(noVideo.sourceEnd).toBe(noVideo.boundaries[noVideo.boundaries.length - 1]);
    expect(buildPlan([]).cuts).toEqual([]);
  });
  test('a song with under 8 beats is replaced by SYNTHETIC but stays the chosen music', () => {
    const short = song('Fever short.mp3', { beats: grid(5) });
    const p = buildPlan([short, ...videos]);
    expect(p.music).toBe(short);
    expect(p.analysis).toBe(SYNTHETIC);
  });
  test('clips too short for a cut are counted as skipped', () => {
    const p = buildPlan([music, video('tiny.webm', 300)]);
    expect(p.cuts).toEqual([]);
    expect(p.skipped).toBe(p.boundaries.length - 1);
  });
  // Findings part 2 line 399: re-pack the remaining cuts on the beat grid when a segment is skipped; line 275 is the defect it fixes.
  describe('a skipped segment re-packs the later cuts onto the beat grid', () => {
    const short = [video('Mountain top.webm', 1_000), video('hiking.webm', 1_000), video('skate.webm', 1_000), video('bike.webm', 1_000)];
    const repacked = buildPlan([...short, music]), plain = cutBoundaries(repacked.analysis).times;
    test('something was skipped, and the montage is shorter than the first plan', () => {
      expect(repacked.skipped).toBeGreaterThan(0);
      expect(repacked.cuts.length).toBeGreaterThan(0);
      expect(repacked.boundaries).not.toEqual(plain);
      expect(repacked.boundaries[repacked.boundaries.length - 1]).toBeLessThan(plain[plain.length - 1]);
    });
    test('the cuts are gapless from 0, one per boundary gap, each as long as its gap', () => {
      expect(repacked.boundaries[0]).toBe(0);
      expect(repacked.boundaries).toHaveLength(repacked.cuts.length + 1);
      expect(repacked.cuts.map(c => c.trimEnd - c.trimStart)).toEqual(deltas(repacked.boundaries));
    });
    test('every boundary sits on a beat of the song, at least the minimum gap apart', () => {
      for (const b of repacked.boundaries) expect(repacked.analysis.beats, String(b)).toContain(b);
      expect(Math.min(...deltas(repacked.boundaries))).toBeGreaterThanOrEqual(200);
    });
    test('every clip fits its cut with the 80 ms margin', () => {
      for (const [n, c] of repacked.cuts.entries()) expect(c.trimEnd - c.trimStart + 80, `cut ${n}`).toBeLessThanOrEqual(1_000);
    });
    test('the music stops where the montage does', () => {
      expect(repacked.sourceEnd).toBe(repacked.boundaries[repacked.boundaries.length - 1]);
    });
    test('a skip in the middle leaves the cuts before it where they were, and the ones after it on the beat', () => {
      // The drop at 1.5 s leaves no intro; 1.2 s clips fit the 500 ms and 1 s cuts, and the first 2 s post-drop cut is skipped.
      const early = song('Night Fever.mp3', { beats: grid(41) }, { segments: [{ start_time: 1.5, label: 'Drop' }] });
      const mixed = buildPlan([video('Mountain top.webm', 1_200), video('hiking.webm', 1_200), video('skate.webm', 1_200), video('bike.webm', 1_200), early]);
      const first = cutBoundaries(mixed.analysis).times, moved = first.findIndex((t, n) => t !== mixed.boundaries[n]);
      expect(mixed.skipped).toBeGreaterThan(0);
      expect(moved).toBeGreaterThan(1);
      expect(mixed.boundaries.slice(0, moved)).toEqual(first.slice(0, moved));
      for (const b of mixed.boundaries) expect(mixed.analysis.beats).toContain(b);
      expect(mixed.cuts.map(c => c.trimEnd - c.trimStart)).toEqual(deltas(mixed.boundaries));
    });
  });
});

describe('clock', () => {
  test('m:ss, seconds padded', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(999)).toBe('0:00');
    expect(clock(8_000)).toBe('0:08');
    expect(clock(59_999)).toBe('0:59');
    expect(clock(60_000)).toBe('1:00');
    expect(clock(125_400)).toBe('2:05');
    expect(clock(3_600_000)).toBe('60:00');
  });
});
