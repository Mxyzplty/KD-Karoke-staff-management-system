// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 10 (the First Edit demo pack, FX-3): the records in vendor/demo-pack/pack.json against the files beside them
// and the T00 manifest (every file's size, SHA-256, licence and source), and what the plan makes of the real records, including
// the song that carries only `pulseBeats` / `averageBpm`. Reads local files only; the first-use download is in tests/ui/t21-pack.spec.ts.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildPlan, clipPools, SYNTHETIC } from '../apps/web/src/settings/first-edit/plan';
import type { DemoAsset } from '../apps/web/src/settings/first-edit/plan';
import type { Pack } from '../apps/web/src/settings/first-edit/pack';

const ROOT = join(__dirname, '..'), DIR = join(ROOT, 'vendor', 'demo-pack');
const pack = JSON.parse(readFileSync(join(DIR, 'pack.json'), 'utf8')) as Pack & { files: (Pack['files'][number] & { modified?: string })[] };
const manifest = JSON.parse(readFileSync(join(ROOT, 'vendor', 'manifest.json'), 'utf8')) as { components?: Component[]; entries?: Component[] } & Record<string, unknown>;
type Component = { name: string; license: string; licenseEvidence?: string; source?: { page?: string; download?: string }; files?: { path: string; bytes: number; sha256: string }[] };
const components: Component[] = (Object.values(manifest).find(v => Array.isArray(v) && v.some((c: Component) => c?.files?.some(f => f.path.startsWith('vendor/demo-pack/')))) ?? []) as Component[];
const asAssets = (files = pack.files): DemoAsset[] => files.map(f => ({ id: f.file, type: f.type, name: f.file, durationMs: f.durationMs, rhythm_data: f.rhythm_data, segments: f.segments }));
const songs = pack.files.filter(f => f.type === 'audio');

describe('row 10 · pack records', () => {
  test('row 10: the index is version 1 titled "First Edit" and every record is complete', () => {
    expect(pack.version).toBe(1); expect(pack.title).toBe('First Edit');
    expect(pack.files.length).toBeGreaterThanOrEqual(13);
    expect(new Set(pack.files.map(f => f.file)).size).toBe(pack.files.length);
    for (const f of pack.files) {
      expect(f.type, f.file).toMatch(/^(video|audio)$/);
      expect(f.file.split('.').pop(), f.file).toBe(f.type === 'video' ? 'webm' : 'mp3');
      expect(f.sha256, f.file).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(f.bytes) && f.bytes > 0, f.file).toBe(true);
      expect(f.durationMs, f.file).toBeGreaterThan(0);
      expect(f.licence, f.file).toMatch(/^[A-Za-z0-9.+-]+$/);
      expect(f.author.length, f.file).toBeGreaterThan(0);
      expect(f.pageUrl, f.file).toMatch(/^https:\/\//);
    }
  });

  test('row 10: each record matches its file on disk — size and SHA-256 — and no stray file sits in the folder', () => {
    for (const f of pack.files) {
      const path = join(DIR, f.file);
      expect(existsSync(path), `${f.file} exists`).toBe(true);
      expect(statSync(path).size, `${f.file} bytes`).toBe(f.bytes);
      expect(createHash('sha256').update(readFileSync(path)).digest('hex'), `${f.file} sha256`).toBe(f.sha256);
    }
    expect(readdirSync(DIR).filter(n => n !== 'pack.json').sort()).toEqual(pack.files.map(f => f.file).sort());
  });

  test('row 10: every file is in the T00 manifest with the same size, hash and licence, and carries its source page', () => {
    expect(components.length, 'the manifest lists the demo pack').toBeGreaterThanOrEqual(pack.files.length - 1);
    for (const f of pack.files) {
      const c = components.find(x => x.files?.some(y => y.path === `vendor/demo-pack/${f.file}`));
      expect(c, `${f.file} in the manifest`).toBeDefined();
      const entry = c!.files!.find(y => y.path === `vendor/demo-pack/${f.file}`)!;
      expect({ bytes: entry.bytes, sha256: entry.sha256, license: c!.license }, f.file).toEqual({ bytes: f.bytes, sha256: f.sha256, license: f.licence });
      expect(c!.licenseEvidence?.length ?? 0, `${f.file} licence evidence`).toBeGreaterThan(20);
      expect(JSON.stringify(c!.source ?? {}), f.file).toContain('https://');
    }
  });

  test('row 10: the pack holds footage for every pool (scenic, action, slow motion) and two songs', () => {
    const pools = clipPools(asAssets());
    expect(pools.videos.length).toBe(pack.files.filter(f => f.type === 'video').length); // every video has a duration
    expect(pools.scenic.length).toBeGreaterThanOrEqual(2);
    expect(pools.action.length).toBeGreaterThanOrEqual(2);
    expect(pools.slowmo.length).toBeGreaterThanOrEqual(1);
    expect(songs).toHaveLength(2);
  });

  test('row 10: one song has `beats`, `bpm`, onsets and a labelled drop segment; the other only `pulseBeats` and `averageBpm`', () => {
    const named = songs.find(s => s.file.includes('fever'))!, pulse = songs.find(s => !s.file.includes('fever'))!;
    expect(named.rhythm_data).toMatchObject({ bpm: 128 });
    expect(named.rhythm_data!.beats!.length).toBeGreaterThanOrEqual(8);
    expect(named.rhythm_data!.onsets!.length).toBeGreaterThan(0);
    expect(named.segments!.some(s => s.start_time > 0 && /drop/i.test(`${s.label} ${s.description}`))).toBe(true);
    expect(pulse.rhythm_data!.pulseBeats!.length).toBeGreaterThanOrEqual(8);
    expect(pulse.rhythm_data!.averageBpm).toBeGreaterThan(0);
    expect(pulse.rhythm_data).not.toHaveProperty('beats');
    expect(pulse.rhythm_data).not.toHaveProperty('bpm');
    for (const s of songs) { // beat times sit inside the song and ascend
      const list = (s.rhythm_data!.beats ?? s.rhythm_data!.pulseBeats!) as unknown[];
      const times = list.map(b => Array.isArray(b) ? b[0] as number : typeof b === 'number' ? b : (b as { time: number }).time);
      expect(times, s.file).toEqual([...times].sort((a, b) => a - b));
      expect(times[times.length - 1] * 1000, s.file).toBeLessThanOrEqual(s.durationMs);
    }
  });
});

describe('row 10 · the plan the real records give', () => {
  test('row 10: the pack as shipped plans on the "fever" song’s own beat and drop, with every cut filled from the pack', () => {
    const plan = buildPlan(asAssets());
    expect(plan.music?.name).toBe('fever-temple.mp3');
    expect(plan.analysis).not.toBe(SYNTHETIC);
    expect(plan.analysis.bpm).toBe(128);
    expect(plan.analysis.drop).toBe(Math.round(songs[0].segments!.find(s => /drop/i.test(s.label ?? ''))!.start_time * 1000));
    expect(plan.skipped).toBe(0);
    expect(plan.cuts.length).toBeGreaterThanOrEqual(15);
    expect(plan.cuts.length).toBe(plan.boundaries.length - 1);
    expect(plan.sourceEnd).toBeLessThanOrEqual(songs[0].durationMs);
    for (const c of plan.cuts) expect(pack.files.find(f => f.file === c.assetId)?.type).toBe('video');
  });

  test('row 10: without the "fever" song the pulseBeats-only song is read: its averageBpm shows and the cuts follow its beats, not the synthetic grid', () => {
    const only = pack.files.filter(f => !f.file.includes('fever')), pulse = songs.find(s => !s.file.includes('fever'))!;
    const plan = buildPlan(asAssets(only));
    expect(plan.music?.name).toBe(pulse.file);
    expect(plan.analysis).not.toBe(SYNTHETIC);
    expect(plan.analysis.bpm).toBe(pulse.rhythm_data!.averageBpm);
    expect(plan.analysis.beats).toHaveLength(pulse.rhythm_data!.pulseBeats!.length);
    const onBeat = new Set(plan.analysis.beats);
    for (const t of plan.boundaries.slice(1)) expect(onBeat.has(t), `${t} is a beat of the record`).toBe(true);
    expect(plan.boundaries[0]).toBe(0);
    expect(plan.skipped).toBe(0);
  });
});
