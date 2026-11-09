// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 9, PT-FE-04 (beat-plan goldens, §28b.3.2): pure, no pack and no browser. Written from the ticket and the
// findings' worked example, not from the code. PT-FE-04 (i) says "the 23 boundaries of §3.2"; the worked example lists 24
// boundary values (0 … 20000 ms), which are the 23 cuts it names. The test pins the listed values and the 23 cuts.
import { describe, expect, test } from 'vitest';
import { analyse, buildPlan, cutBoundaries, SYNTHETIC } from '../apps/web/src/settings/first-edit/plan';
import type { DemoAsset, RhythmData } from '../apps/web/src/settings/first-edit/plan';

const WORKED = [0, 2000, 4000, 5000, 6000, 6500, 7000, 7500, 8000, 8500, 9000, 10000, 10500, 11000, 13000, 13500, 14000, 15000, 15500, 16000, 18000, 18500, 19000, 20000];
/** A beat every `step` seconds, `count` of them from 0. */
const grid = (count: number, step = 0.5) => Array.from({ length: count }, (_, n) => n * step);
const music = (rhythm: RhythmData, segments?: DemoAsset['segments']) => ({ rhythm_data: rhythm, segments });

describe('PT-FE-04 · beat-plan goldens', () => {
  test('PT-FE-04 (i): the synthetic grid gives exactly the boundaries of the worked example, 23 cuts, the drop at 8 s', () => {
    expect(SYNTHETIC.beats).toHaveLength(41);
    expect({ interval: SYNTHETIC.interval, end: SYNTHETIC.end, drop: SYNTHETIC.drop, bpm: SYNTHETIC.bpm }).toEqual({ interval: 500, end: 20_500, drop: 8_000, bpm: null });
    const { times, intro, afterDrop } = cutBoundaries(SYNTHETIC);
    expect(times).toEqual(WORKED);
    expect(times.length - 1).toBe(23);
    expect(times[times.length - 1]).toBe(20_000); // the music is trimmed to 0–20 s
    expect(times.slice(0, intro + 1)).toEqual([0, 2000, 4000, 5000, 6000]); // scenic: 2 s, 2 s, 1 s, 1 s
    expect(times.slice(intro, afterDrop + 1)).toEqual([6000, 6500, 7000, 7500, 8000]); // build
    expect(times[afterDrop]).toBe(8_000);
  });

  test('PT-FE-04 (i): with no analysable song the plan falls back to that grid, so the same boundaries and a source range of 0–20 s', () => {
    const plan = buildPlan([{ id: 'v', type: 'video', name: 'action.webm', durationMs: 30_000 }]);
    expect(plan.analysis).toBe(SYNTHETIC);
    expect(plan.boundaries).toEqual(WORKED);
    expect(plan.sourceEnd).toBe(20_000);
  });

  test('PT-FE-04 (ii): a labelled drop segment gives the drop, wherever the onsets and beats are', () => {
    const rhythm = { beats: grid(41), bpm: 120, onsets: [[12, 1], [5, .2]] as [number, number][] };
    expect(analyse(music(rhythm, [{ start_time: 0, label: 'intro' }, { start_time: 9.25, label: 'The DROP' }, { start_time: 14, description: 'second drop' }]))!.drop).toBe(9_250);
    expect(analyse(music(rhythm, [{ start_time: 7, description: 'the beat drops here' }]))!.drop).toBe(7_000); // the description counts, any case
    expect(analyse(music(rhythm, [{ start_time: 0, label: 'drop' }]))!.drop).not.toBe(0); // a segment at 0 does not count
  });

  test('PT-FE-04 (iii): without segments, the strongest onset between 25 % and 80 % of the track end', () => {
    const rhythm = { beats: grid(41), onsets: [[1, 9], [6, .4], [10.5, .9], [15, .6], [19, 9]] as [number, number][] };
    const got = analyse(music(rhythm))!;
    expect(got.end).toBe(20_500);
    expect(got.drop).toBe(10_500); // 1 s and 19 s are outside 5.125–16.4 s however strong
  });

  test('PT-FE-04 (iv): without onsets, the first beat at or after 40 % of the track end', () => {
    const got = analyse(music({ beats: grid(41) }))!;
    expect(got.drop).toBe(8_500); // 0.4 × 20 500 = 8 200
    expect(analyse(music({ beats: grid(41), onsets: [[1, 9]] }))!.drop).toBe(8_500); // an onset outside the window is no onset
  });

  test('PT-FE-04 (v): fewer than 8 beats is no analysis, so the plan is the synthetic grid; exactly 8 is analysed', () => {
    expect(analyse(music({ beats: grid(7) }))).toBeNull();
    expect(analyse(music({ beats: grid(8) }))).not.toBeNull();
    const song: DemoAsset = { id: 'song', type: 'audio', name: 'fever.mp3', durationMs: 30_000, rhythm_data: { beats: grid(7), bpm: 90 } };
    const plan = buildPlan([song, { id: 'v', type: 'video', name: 'a.webm', durationMs: 30_000 }]);
    expect(plan.music).toBe(song);
    expect(plan.analysis).toBe(SYNTHETIC);
    expect(plan.analysis.bpm).toBeNull();
  });

  test('PT-FE-04 (vi): a record with only pulseBeats and averageBpm is read (documented improvement; Xapp falls back to synthetic)', () => {
    const pulse = analyse(music({ pulseBeats: grid(41, .6), averageBpm: 100 }))!;
    expect(pulse).not.toBeNull();
    expect(pulse.beats).toHaveLength(41);
    expect(pulse.interval).toBe(600);
    expect(pulse.bpm).toBe(100); // the record's own figure is the one shown
    expect(pulse.end).toBe(24_600);
    const song: DemoAsset = { id: 'song', type: 'audio', name: 'other.mp3', durationMs: 30_000, rhythm_data: { pulseBeats: grid(41, .6), averageBpm: 100 } };
    const plan = buildPlan([song, { id: 'v', type: 'video', name: 'a.webm', durationMs: 30_000 }]);
    expect(plan.analysis).not.toBe(SYNTHETIC);
    expect(plan.analysis.bpm).toBe(100);
    expect(plan.boundaries).not.toEqual(WORKED); // cut on the song's beats, not on the 0.5 s grid
    for (const t of plan.boundaries) expect(t % 600, `${t} is on a 600 ms beat`).toBe(0);
    expect(buildPlan([song]).music).toBe(song); // pickMusic treats a pulseBeats-only song as having beats
  });

  test('PT-FE-04: beat entries may be numbers, pairs or objects with time/t and strength/s; negative and non-numeric ones are dropped', () => {
    const mixed = [0, [.5, 1], { time: 1 }, { t: 1.5, s: 2 }, 2, 2.5, 3, 3.5, -1, 'x', { time: 'y' }] as unknown as RhythmData['beats'];
    const got = analyse(music({ beats: mixed }))!;
    expect(got.beats).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
  });
});
