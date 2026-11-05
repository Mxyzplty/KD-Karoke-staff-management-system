// SPDX-License-Identifier: AGPL-3.0-only
// T13: G-09 stored-reference replay (parity/g09.ts, CLI `parity --golden G-09`) on SYNTHETIC stored folders built in a temp dir.
// This is NOT Xapp parity: no real stored reference is read (the research agent runs the real one on D2). Oracle: the written spec,
// agent tool results §10 (gain law gain = track × volume²: item 0.5 → −12.04 dB, track 0.5 → −6.02 dB, both → −18.06 dB, muted track =
// digital silence; the first ≈ 9.4 ms of each clip are cut by Xapp and the comparison leaves out the 10 ms after each clip start) and the T13
// ticket (gates: lag ≤ 1 ms, RMS / peak ±0.1 dB, residual ≤ −50 dBFS). The reference WAV is computed here from the formula, never from a run.
// Layout: a 1 s test signal (0.15 sin 1 kHz + 0.15 noise, so the lag is unambiguous) on four audio tracks, one clip each at 0 / 1 / 2 / 3 s:
//   clip 1: item volume 0.5 (gain 0.25) · clip 2: track volume 0.5 (0.5) · clip 3: both (0.125) · clip 4: muted track (0).
// Provisional (marked): the stored record layout {tool, input, result_text}, the field names given to the runner, and the report's field names.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWav, runG09, wavBytes } from '../parity/g09';
import { noise, rms, db } from './t13-support';

const RATE = 48000, GAINS = [0.25, 0.5, 0.125, 0], TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const tone = (() => { const n = noise(RATE, 7), t = new Float32Array(RATE); for (let i = 0; i < RATE; i++) t[i] = 0.15 * Math.sin(2 * Math.PI * 1000 * i / RATE) + 0.15 * n[i]; return t; })();
/** The reference mix from the formula: section k = the tone × GAINS[k]. */
const refMix = (): Float32Array[] => { const ch = new Float32Array(RATE * 4); GAINS.forEach((g, k) => { for (let n = 0; n < RATE; n++) ch[k * RATE + n] = tone[n] * g; }); return [ch, ch.slice()]; };
const louder = (ch: Float32Array[], k: number, dB: number) => { const g = 10 ** (dB / 20); for (const c of ch) for (let n = k * RATE; n < (k + 1) * RATE; n++) c[n] *= g; return ch; };
const delay = (ch: Float32Array[], frames: number) => ch.map(c => { const o = new Float32Array(c.length); o.set(c.subarray(0, c.length - frames), frames); return o; });

type Step = { id: string; tool: string; input: unknown; result: unknown };
const ok = (data?: unknown) => ({ success: true, ...(data ? { data } : {}) });
const steps = (): Step[] => [
  { id: 'S01', tool: 'manageTrack', input: { action: 'create', kind: 'audio', name: 'A1' }, result: ok({ track: { id: 'xapp-t1' } }) },
  { id: 'S02', tool: 'addMedia', input: { trackId: 'xapp-t1', timelineStart: 0, items: [{ assetId: 'audio_1' }] }, result: ok({ addedItemIds: ['xapp-i1'] }) },
  { id: 'S03', tool: 'editProperties', input: { itemId: 'xapp-i1', properties: { volume: 0.5 } }, result: ok() },
  { id: 'S04', tool: 'manageTrack', input: { action: 'create', kind: 'audio', name: 'A2' }, result: ok({ track: { id: 'xapp-t2' } }) },
  { id: 'S05', tool: 'manageTrack', input: { action: 'volume', trackId: 'xapp-t2', volume: 0.5 }, result: ok() },
  { id: 'S06', tool: 'addMedia', input: { trackId: 'xapp-t2', timelineStart: 1, items: [{ assetId: 'audio_1' }] }, result: ok({ addedItemIds: ['xapp-i2'] }) },
  { id: 'S07', tool: 'manageTrack', input: { action: 'create', kind: 'audio', name: 'A3' }, result: ok({ track: { id: 'xapp-t3' } }) },
  { id: 'S08', tool: 'manageTrack', input: { action: 'volume', trackId: 'xapp-t3', volume: 0.5 }, result: ok() },
  { id: 'S09', tool: 'addMedia', input: { trackId: 'xapp-t3', timelineStart: 2, items: [{ assetId: 'audio_1' }] }, result: ok({ addedItemIds: ['xapp-i3'] }) },
  { id: 'S10', tool: 'editProperties', input: { itemId: 'xapp-i3', properties: { volume: 0.5 } }, result: ok() },
  { id: 'S11', tool: 'manageTrack', input: { action: 'create', kind: 'audio', name: 'A4' }, result: ok({ track: { id: 'xapp-t4' } }) },
  { id: 'S12', tool: 'manageTrack', input: { action: 'mute', trackId: 'xapp-t4' }, result: ok() },
  { id: 'S13', tool: 'addMedia', input: { trackId: 'xapp-t4', timelineStart: 3, items: [{ assetId: 'audio_1' }] }, result: ok({ addedItemIds: ['xapp-i4'] }) },
  { id: 'S14', tool: 'exportProject', input: {}, result: ok() },
];

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'g09-t13-')); });
// Windows can hold a just-written file for a moment (ENOTEMPTY / EBUSY under a parallel run): rm retries.
const CLEAN = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
afterEach(async () => { await rm(root, CLEAN); });

/** A synthetic stored folder: results/<id>.json, analysis/export-audio-f32.wav, media/tone.wav and the run-time JSON files. */
async function folder(o: { ref?: Float32Array[]; refRate?: number; steps?: Step[]; withWav?: boolean } = {}) {
  const dir = path.join(root, 'ref'), results = path.join(dir, 'results'), analysis = path.join(dir, 'analysis'), media = path.join(root, 'media');
  await mkdir(results, { recursive: true }); await mkdir(analysis, { recursive: true }); await mkdir(media, { recursive: true });
  const list = o.steps ?? steps();
  for (const s of list) await writeFile(path.join(results, `${s.id}.json`), JSON.stringify({ tool: s.tool, input: s.input, result_text: JSON.stringify(s.result) }));
  if (o.withWav !== false) await writeFile(path.join(analysis, 'export-audio-f32.wav'), wavBytes(o.refRate ?? RATE, o.ref ?? refMix()));
  const wav = path.join(media, 'tone.wav'); await writeFile(wav, wavBytes(RATE, [tone, tone.slice()]));
  const files = { calls: path.join(root, 'calls.json'), media: path.join(root, 'media.json'), sections: path.join(root, 'sections.json') };
  await writeFile(files.calls, JSON.stringify([list.map(s => s.id)])); await writeFile(files.media, JSON.stringify({ audio_1: wav }));
  return { dir, wav, ids: list.map(s => s.id), media: { audio_1: wav }, out: path.join(root, 'out'), files };
}
type Folder = Awaited<ReturnType<typeof folder>>;
type Sec = { name?: string; fromS: number; toS: number; excludedClipStarts: number; passed: boolean; lagMs: number; gainDb: number; peakDb: number; residualDb: number; note?: string };
type Report = Omit<Awaited<ReturnType<typeof runG09>>, 'sections'> & { sections: Sec[] };
const run = (f: Folder, extra: Partial<Parameters<typeof runG09>[1]> = {}) =>
  runG09(f.dir, { calls: [f.ids], media: f.media, toolField: 'tool', inputField: 'input', output: f.out, ...extra }) as unknown as Promise<Report>;
const failed = (r: Report) => r.sections.filter(s => !s.passed).map(s => s.name);

describe('G-09 replay: a matching reference passes (synthetic folder, formula-computed reference, not Xapp parity)', () => {
  it('1. status passed: 4 sections within the gates, 13 replayed calls passed, the exportProject record uncompared (T16); parity mode; files written', async () => {
    const r = await run(await folder());
    expect(r).toMatchObject({ golden: 'G-09', status: 'passed', mode: 'parity', blockBase: 0 });
    expect(r.sections.map(s => s.name)).toEqual(['section 1', 'section 2', 'section 3', 'section 4']);
    expect(r.sections.every(s => s.passed)).toBe(true);
    for (const s of r.sections) { expect(Math.abs(s.lagMs ?? 0)).toBeLessThan(0.05); if (Number.isFinite(s.gainDb)) expect(Math.abs(s.gainDb)).toBeLessThan(0.01); expect(s.residualDb).toBeLessThanOrEqual(-100); }
    expect(r.steps.filter(s => s.status === 'passed')).toHaveLength(13); expect(r.steps.filter(s => s.status === 'failed')).toHaveLength(0);
    const last = r.steps[13]; expect(last).toMatchObject({ id: 'S14', tool: 'exportProject', status: 'uncompared' }); expect(last.note).toMatch(/T16/);
    expect(r.summary).toMatch(/4\/4 sections/); expect(r.summary).toMatch(/13 passed, 0 failed, 1 uncompared/);
    expect(r.lengths).toEqual({ referenceS: 4, oursS: 4 }); expect(r.tracks).toHaveLength(4);
  });
  it('2. Cutframe\'s own mix (cutframe-audio-f32.wav) follows the gain law: −12.04 / −6.02 / −18.06 dB and digital silence for the muted track (±0.02 dB)', async () => {
    const f = await folder(); await run(f);
    const w = readWav(await readFile(path.join(f.out, 'cutframe-audio-f32.wav')));
    expect(w.rate).toBe(RATE); expect(w.data).toHaveLength(2); expect(w.data[0].length).toBe(RATE * 4);
    const base = rms(tone);
    [-12.0412, -6.0206, -18.0618].forEach((expected, k) => { const level = db(rms(w.data[0], k * RATE, (k + 1) * RATE) / base); expect(Math.abs(level - expected), `section ${k + 1}: ${level} dB`).toBeLessThan(0.02); });
    for (let n = 3 * RATE; n < 4 * RATE; n++) { expect(w.data[0][n]).toBe(0); expect(w.data[1][n]).toBe(0); }
    const report = JSON.parse(await readFile(path.join(f.out, 'report.json'), 'utf8')); expect(report).toMatchObject({ golden: 'G-09', status: 'passed', mode: 'parity' });
  });
  it('3. default sections are the spans between the clip edges (0–1, 1–2, 2–3, 3–4 s); each excludes the 10 ms after its own clip start', async () => {
    const r = await run(await folder());
    expect(r.sections.map(s => [s.fromS, s.toS])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    expect(r.sections.map(s => s.excludedClipStarts)).toEqual([1, 1, 1, 1]);
  });
});

describe('G-09 replay: perturbed references fail exactly what they should', () => {
  it('4. a reference 0.3 dB louder in section 2 fails section 2 only (test − reference ≈ −0.3 dB), status failed', async () => {
    const r = await run(await folder({ ref: louder(refMix(), 1, 0.3) }));
    expect(failed(r)).toEqual(['section 2']); expect(r.status).toBe('failed');
    const s = r.sections[1]; expect(s.gainDb).toBeCloseTo(-0.3, 1); expect(s.peakDb).toBeCloseTo(-0.3, 1); expect(Math.abs(s.lagMs)).toBeLessThan(0.05);
    expect(r.summary).toMatch(/3\/4 sections/);
  });
  it('5. a reference 0.05 dB louder is inside the ±0.1 dB gate: passes', async () => {
    expect((await run(await folder({ ref: louder(refMix(), 0, 0.05) }))).status).toBe('passed');
  });
  it('6. a reference 2 ms late fails the lag gate in every sounding section (|lag| ≈ 2 ms)', async () => {
    const r = await run(await folder({ ref: delay(refMix(), 96) }));
    expect(r.status).toBe('failed');
    for (const k of [0, 1, 2]) { const s = r.sections[k]; expect(s.passed, s.name).toBe(false); expect(Math.abs(s.lagMs), s.name).toBeGreaterThan(1.9); expect(Math.abs(s.lagMs), s.name).toBeLessThan(2.1); }
  });
  it('7. a reference 0.5 ms late (inside the 1 ms gate): the oracle shifts the whole-frame lag out, so the section is judged on level and residual after alignment (passes)', async () => {
    const r = await run(await folder({ ref: delay(refMix(), 24) }));
    const s = r.sections[0]; expect(Math.abs(s.lagMs)).toBeGreaterThan(0.45); expect(Math.abs(s.lagMs)).toBeLessThanOrEqual(1);
    expect(s.residualDb).toBeLessThanOrEqual(-50);
  });
  it('8. garbage in the reference during the 10 ms after each clip start is ignored (passes); the same garbage 10.4 ms after the start fails that section', async () => {
    const garbage = (offset: number) => { const ref = refMix(), n = noise(480, 3); for (let k = 0; k < 4; k++) for (const c of ref) for (let i = 0; i < 480; i++) if (k === 0 || offset === 0) c[k * RATE + offset + i] = 0.5 * n[i]; return ref; };
    const inside = await run(await folder({ ref: garbage(0) }));
    expect(inside.status, JSON.stringify(inside.sections.map(s => s.residualDb))).toBe('passed');
    const after = await run(await folder({ ref: (() => { const ref = refMix(), n = noise(480, 3); for (const c of ref) for (let i = 0; i < 480; i++) c[500 + i] = 0.5 * n[i]; return ref; })() }));
    expect(failed(after)).toEqual(['section 1']);
  });
});

describe('G-09 replay: sections and the stored call results', () => {
  it('9. --sections override: named and unnamed sections run as given (section 0.5–1.5 s contains one clip start, 2.2–2.8 s none)', async () => {
    const r = await run(await folder(), { sections: [{ name: 'mid', fromS: 0.5, toS: 1.5 }, { fromS: 2.2, toS: 2.8 }] });
    expect(r.status).toBe('passed'); expect(r.sections).toHaveLength(2);
    expect(r.sections[0]).toMatchObject({ name: 'mid', fromS: 0.5, toS: 1.5, excludedClipStarts: 1, passed: true });
    expect(r.sections[1]).toMatchObject({ fromS: 2.2, toS: 2.8, excludedClipStarts: 0, passed: true }); expect(r.sections[1].name).toBeUndefined();
  });
  it('10. a section outside the reference and the mix fails with a note; an empty section list is "uncompared"', async () => {
    const far = await run(await folder(), { sections: [{ name: 'beyond', fromS: 10, toS: 11 }] });
    expect(far.status).toBe('failed'); expect(far.sections[0]).toMatchObject({ name: 'beyond', passed: false }); expect(far.sections[0].note).toMatch(/outside/);
    expect((await run(await folder(), { sections: [] })).status).toBe('uncompared');
  });
  it('11. a stored call that succeeded in Xapp but fails here (and the reverse) is a failed step; the audio sections are unaffected', async () => {
    const list = steps(); list[2] = { ...list[2], result: { success: false, code: 'ITEM_NOT_FOUND' } };
    const r = await run(await folder({ steps: list }));
    expect(r.steps.filter(s => s.status === 'failed').map(s => s.id)).toEqual(['S03']);
    expect(r.steps[2].diffs.map(d => d.path)).toContain('success'); expect(r.status).toBe('failed'); expect(r.sections.every(s => s.passed)).toBe(true);
    expect(r.summary).toMatch(/12 passed, 1 failed, 1 uncompared/);
  });
  it('12. inline steps ({id, tool, input}) run without a stored result: "no stored call result", uncompared', async () => {
    const f = await folder({ steps: steps().slice(0, 13) });
    const r = await run(f, { calls: [f.ids.slice(0, 2), [{ id: 'X1', tool: 'manageTrack', input: { action: 'create', kind: 'audio' } }]] });
    expect(r.steps.at(-1)).toMatchObject({ id: 'X1', status: 'uncompared', note: 'no stored call result' });
    expect(r.tracks).toHaveLength(2);
  });
});

describe('G-09 replay: refusals', () => {
  it('13. missing --tool-field / --input-field, a call id with no record, a record without the field', async () => {
    const f = await folder();
    await expect(run(f, { toolField: '' })).rejects.toThrow(/--tool-field and --input-field are required/);
    await expect(run(f, { inputField: '' })).rejects.toThrow(/--tool-field and --input-field are required/);
    await expect(run(f, { calls: [[...f.ids, 'S99']] })).rejects.toThrow(/S99.*no results\/S99\.json/);
    await expect(run(f, { toolField: 'nope' })).rejects.toThrow(/has no 'nope' field.*top-level keys are: tool, input, result_text/);
  });
  it('14. no analysis/export-audio-f32.wav; a reference that is not 48 kHz', async () => {
    await expect(run(await folder({ withWav: false }))).rejects.toThrow(/No analysis\/export-audio-f32\.wav/);
    await rm(path.join(root, 'ref'), { recursive: true, force: true });
    await expect(run(await folder({ refRate: 44100 }))).rejects.toThrow(/44100 Hz/);
  });
  it('15. output directory inside, equal to, or above the reference directory is refused (nothing written into the reference)', async () => {
    const f = await folder();
    for (const out of [path.join(f.dir, 'out'), f.dir, root]) await expect(run(f, { output: out }), out).rejects.toThrow(/Output\/reference directories overlap or alias/);
  });
  it('16. a results/ folder is required', async () => {
    const f = await folder(); await rm(path.join(f.dir, 'results'), { recursive: true });
    await expect(run(f)).rejects.toThrow(/No results\/ folder/);
  });
});

describe('G-09 CLI (parity/cli.ts --golden G-09)', () => {
  const cli = (f: Folder, args: string[]) => spawnSync(process.execPath, [TSX, 'parity/cli.ts', '--golden', 'G-09', '--xapp-ref', f.dir, '--calls', f.files.calls, '--media', f.files.media, '--tool-field', 'tool', '--input-field', 'input', '--output', f.out, ...args], { encoding: 'utf8', timeout: 90_000 });
  it('17. a matching reference: exit 0 and the report on stdout; --sections and --max-lag-ms are honoured', async () => {
    const f = await folder(), r = cli(f, []);
    expect(r.status, r.stderr).toBe(0); const report = JSON.parse(r.stdout); expect(report).toMatchObject({ golden: 'G-09', status: 'passed' }); expect(report.sections).toHaveLength(4);
    await writeFile(f.files.sections, JSON.stringify([{ name: 'one', fromS: 0, toS: 2 }]));
    const s = cli(f, ['--sections', f.files.sections, '--max-lag-ms', '10', '--block-base', '0']);
    expect(s.status, s.stderr).toBe(0); expect(JSON.parse(s.stdout).sections.map((x: { name: string }) => x.name)).toEqual(['one']);
  }, 120_000);
  it('18. exit codes: 1 when a section fails, 2 when nothing was compared', async () => {
    const bad = cli(await folder({ ref: louder(refMix(), 0, 1) }), []);
    expect(bad.status).toBe(1); expect(JSON.parse(bad.stdout).status).toBe('failed');
    await rm(root, CLEAN); root = await mkdtemp(path.join(tmpdir(), 'g09-t13-')); const f = await folder(); await writeFile(f.files.sections, '[]');
    const none = cli(f, ['--sections', f.files.sections]); expect(none.status).toBe(2); expect(JSON.parse(none.stdout).status).toBe('uncompared');
  }, 120_000);
  it('19. usage errors: missing --media, missing --xapp-ref, bad --block-base, bad --max-lag-ms, a flag without its value, a wrong --golden', async () => {
    const f = await folder(), base = ['parity/cli.ts', '--golden', 'G-09'];
    const go = (args: string[]) => spawnSync(process.execPath, [TSX, ...base, ...args], { encoding: 'utf8', timeout: 60_000 });
    const full = ['--xapp-ref', f.dir, '--calls', f.files.calls, '--media', f.files.media, '--tool-field', 'tool', '--input-field', 'input', '--output', f.out];
    const without = (flag: string) => { const i = full.indexOf(flag); return [...full.slice(0, i), ...full.slice(i + 2)]; };
    for (const flag of ['--media', '--xapp-ref', '--calls']) { const r = go(without(flag)); expect(r.status, flag).toBe(1); expect(r.stderr, flag).toMatch(/Use --golden G-09/); }
    let r = go([...full, '--block-base', '2']); expect(r.status).toBe(1); expect(r.stderr).toMatch(/--block-base must be 0 or 1/);
    r = go([...full, '--max-lag-ms', '0']); expect(r.status).toBe(1); expect(r.stderr).toMatch(/--max-lag-ms must be a positive number/);
    r = go([...full, '--max-lag-ms', 'abc']); expect(r.status).toBe(1); expect(r.stderr).toMatch(/--max-lag-ms must be a positive number/);
    r = go([...full, '--sections']); expect(r.status).toBe(1); expect(r.stderr).toMatch(/Missing value for --sections/);
    r = go([...without('--tool-field')]); expect(r.status).toBe(1); expect(r.stderr).toMatch(/--tool-field and --input-field are required/);
    expect(JSON.stringify(r.stdout)).not.toMatch(/passed/);
  }, 120_000);
});

describe('readWav / wavBytes (the WAV reader of the G-09 replay)', () => {
  /** Integer PCM WAV: `samples` interleaved, written as `bits`-bit little endian; `before` is an extra chunk placed before `data`. */
  function pcm(bits: 8 | 16 | 24 | 32, channels: number, rate: number, samples: number[], before: Uint8Array = new Uint8Array(0)): Uint8Array {
    const step = bits / 8, size = samples.length * step, out = new Uint8Array(44 + before.length + size), v = new DataView(out.buffer), tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, out.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * channels * step, true); v.setUint16(32, channels * step, true); v.setUint16(34, bits, true); out.set(before, 36); const d = 36 + before.length; tag(d, 'data'); v.setUint32(d + 4, size, true);
    samples.forEach((s, i) => { const o = d + 8 + i * step; if (bits === 16) v.setInt16(o, s, true); else if (bits === 32) v.setInt32(o, s, true); else if (bits === 24) { out[o] = s & 255; out[o + 1] = (s >> 8) & 255; out[o + 2] = (s >> 16) & 255; } else out[o] = s; });
    return out;
  }
  it('20. wavBytes → readWav round-trips float32 exactly: rate, channel count, every sample (stereo and mono)', () => {
    const a = Float32Array.from([0, 0.25, -0.5, 1, -1, 1e-7]), b = a.map(x => -x), w = readWav(wavBytes(48000, [a, b]));
    expect(w.rate).toBe(48000); expect(w.data).toHaveLength(2); expect(Array.from(w.data[0])).toEqual(Array.from(a)); expect(Array.from(w.data[1])).toEqual(Array.from(b));
    const m = readWav(wavBytes(44100, [a])); expect(m.rate).toBe(44100); expect(m.data).toHaveLength(1); expect(Array.from(m.data[0])).toEqual(Array.from(a));
    expect(wavBytes(48000, [a, b])).toHaveLength(44 + 6 * 2 * 4);
  });
  it('21. 16-bit PCM: full scale −32768 → −1, 16384 → 0.5, 32767 → 32767/32768; channels are de-interleaved', () => {
    const w = readWav(pcm(16, 2, 48000, [0, 16384, -32768, 32767, 8192, -16384]));
    expect(Array.from(w.data[0])).toEqual([0, -32768 / 32768, 8192 / 32768]); expect(Array.from(w.data[1])).toEqual([0.5, 32767 / 32768, -0.5]);
    expect(w.rate).toBe(48000);
  });
  it('22. 24-bit and 32-bit integer PCM scale to ±1; 8-bit is refused', () => {
    expect(Array.from(readWav(pcm(24, 1, 48000, [0x400000, -0x400000, 0x7fffff])).data[0])).toEqual([0.5, -0.5, 0x7fffff / 0x800000]);
    expect(Array.from(readWav(pcm(32, 1, 48000, [0x40000000, -0x80000000])).data[0])).toEqual([0.5, -1]);
    expect(() => readWav(pcm(8, 1, 48000, [128, 255]))).toThrow(/Unsupported WAV encoding \(format 1, 8 bit\)/);
  });
  it('23. other chunks before `data` are skipped, including an odd-sized chunk with its pad byte', () => {
    const list = new Uint8Array([76, 73, 83, 84, 3, 0, 0, 0, 1, 2, 3, 0]); // 'LIST', size 3, three bytes, one pad byte
    expect(Array.from(readWav(pcm(16, 1, 48000, [16384, -16384], list)).data[0])).toEqual([0.5, -0.5]);
  });
  it('24. bad files: not RIFF/WAVE, no data chunk', () => {
    expect(() => readWav(new Uint8Array(100))).toThrow(/Not a RIFF\/WAVE file/); expect(() => readWav(new Uint8Array(4))).toThrow(/Not a RIFF\/WAVE file/);
    const header = wavBytes(48000, [new Float32Array(0)]).slice(0, 36); const v = new DataView(header.buffer); v.setUint32(4, 28, true);
    expect(() => readWav(header)).toThrow(/no fmt or data chunk/);
  });
});

describe('G-09 expected figures that need Xapp\'s fixture layout', () => {
  it.todo('ten easeInOut bursts (−37.25 / −11.62 / −5.80 / −2.35 / −0.10 / −2.37 / −5.45 / −10.28 / −20.91 / −20.91 dB): SKIPPED — §10 gives the curve (0 → 1 → 0.3, easeInOut) but not the keyframe times or the burst times, so the layout cannot be rebuilt without inventing it; the parity ramp law itself is covered in tests/t13-curve-gain.test.ts');
});
