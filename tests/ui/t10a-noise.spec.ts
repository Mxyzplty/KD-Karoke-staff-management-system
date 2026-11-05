// SPDX-License-Identifier: AGPL-3.0-only
// T10a statistical parity for the effects whose output is a hash of a large float argument (glitch, vhs, film-grain, halftone
// grain): f32 sin() on the GPU and f64 in the oracle diverge, so per-pixel comparison is meaningless. Instead compare
// distributions of (output − input) against the oracle: per-channel mean and sd, the fraction of changed channels, and for glitch
// the fraction of rows that differ from the input.
// VHS, film-grain and halftone grain (one seed, the same on both sides): |Δmean| ≤ 1.0 code, |Δsd| ≤ 1.5 codes,
//   |Δchanged| ≤ 1.0 pp (smoke run at 256×192 gave mean/sd within ~0.6 code, changed fraction within 0.5 pp).
// Glitch (rule 5): one fixed list of 16 seeds in [0, 1000) (SEEDS16), the same for oracle and GPU, per backend. For each statistic
//   (changed fraction, per-channel mean RGBA, per-channel sd RGB, shifted rows) pass when |mean_GPU − mean_oracle| ≤
//   3·sqrt((SD_o² + SD_g²)/16), mean and sample SD (n−1) taken over the 16 seeds. No epsilon: if both SDs are 0 and the means
//   differ, the case fails and is flagged ZERO-SD MISMATCH. Per-seed values go to the diff log (t10a-diffs.jsonl).
// Plus: same seed twice → identical GPU bytes; a different seed changes glitch/vhs output.
// One test per backend; WebGPU tests are explicit skips ('no WebGPU adapter') when the browser grants no device.
import { test, expect, type Page } from '@playwright/test';
import { compareDistributions, deltaStats, ensureInput, log, memo1, oracleWith, perBackend, renderInPage, SEEDS16, setupPage, statVector, stillAt, STILLS_ALL, variantParams, type Backend, type PageInfo, type StatVector, type StillId, type Variant } from './t10a-support';

test.use({ channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } });
test.setTimeout(600_000);
test.describe.configure({ mode: 'parallel' });

const BOUND = { mean: 1.0, sd: 1.5, changed: 0.01 };
let page: Page, info: PageInfo;
test.beforeAll(async ({ browser }) => { test.setTimeout(120_000); page = await browser.newPage(); info = await setupPage(page); });
test.afterAll(async () => { await page?.close(); });

const expectedOnce = memo1<Uint8Array>(), oracleSeeds = memo1<StatVector[]>();

/** One seed, same on both sides (vhs, film-grain, halftone grain). */
async function statCheck(backend: Backend, id: string, params: Record<string, unknown>, still: StillId, [w, h]: [number, number], timeS: number, seed: number, label: string) {
  const raw = stillAt(still, w, h), key = `${still}@${w}x${h}`;
  await ensureInput(page, key, raw);
  const ctx = { timeS, seed };
  const expected = await expectedOnce(`${id}/${label}/${key}/${timeS}/${seed}`, () => oracleWith(id, raw, params, ctx));
  const eStats = deltaStats(expected, raw.data);
  const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: id, params }], context: ctx });
  const s = deltaStats(out.data, raw.data);
  const dMean = s.mean.map((m, k) => m - eStats.mean[k]), dSd = s.sd.map((v, k) => v - eStats.sd[k]);
  log({ spec: 'noise', label, id, still, size: `${w}x${h}`, backend, gpuChanged: s.changed, oracleChanged: eStats.changed, dChanged: s.changed - eStats.changed, dMean, dSd });
  test.info().annotations.push({ type: backend, description: `Δchanged ${((s.changed - eStats.changed) * 100).toFixed(3)}pp  Δmean ${dMean.map(v => v.toFixed(3))}  Δsd ${dSd.map(v => v.toFixed(3))}` });
  for (let k = 0; k < 3; k++) {
    expect.soft(Math.abs(s.mean[k] - eStats.mean[k]), `${backend} mean ch${k}`).toBeLessThanOrEqual(BOUND.mean);
    expect.soft(Math.abs(s.sd[k] - eStats.sd[k]), `${backend} sd ch${k}`).toBeLessThanOrEqual(BOUND.sd);
  }
  expect.soft(Math.abs(s.mean[3] - eStats.mean[3]), `${backend} alpha mean`).toBeLessThanOrEqual(BOUND.mean);
  expect.soft(Math.abs(s.changed - eStats.changed), `${backend} changed fraction`).toBeLessThanOrEqual(BOUND.changed);
}

/** Rule 5: glitch over the 16 fixed seeds, oracle vs GPU. */
async function glitchSeeds(backend: Backend, params: Record<string, unknown>, still: StillId, [w, h]: [number, number], timeS: number, label: string) {
  const raw = stillAt(still, w, h), key = `${still}@${w}x${h}`;
  await ensureInput(page, key, raw);
  const oracle = await oracleSeeds(`glitch/${label}/${key}/${timeS}`, () => SEEDS16.map(seed => statVector(oracleWith('glitch', raw, params, { timeS, seed }), raw.data, w, h, true)));
  const gpu: StatVector[] = [];
  for (const seed of SEEDS16) {
    const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: 'glitch', params }], context: { timeS, seed } });
    gpu.push(statVector(out.data, raw.data, w, h, true));
  }
  const verdicts = compareDistributions(oracle, gpu);
  log({ spec: 'noise-seeds', id: 'glitch', label, still, size: `${w}x${h}`, timeS, backend, seeds: [...SEEDS16], oracle, gpu, verdicts });
  const ok = verdicts.filter(v => v.pass).length;
  test.info().annotations.push({ type: `${backend} seeds`, description: `${ok}/${verdicts.length} statistics within bound; ` + verdicts.map(v => `${v.stat} Δ${v.delta.toExponential(2)}/≤${v.bound.toExponential(2)}${v.zeroSdMismatch ? ' ZERO-SD MISMATCH' : ''}`).join('; ') });
  for (const v of verdicts) {
    const detail = `${backend} ${v.stat}: |Δmean| over 16 seeds (oracle ${v.meanOracle.toFixed(6)} sd ${v.sdOracle.toExponential(2)}, gpu ${v.meanGpu.toFixed(6)} sd ${v.sdGpu.toExponential(2)})${v.zeroSdMismatch ? ' ZERO-SD MISMATCH' : ''}`;
    expect.soft(v.delta, detail).toBeLessThanOrEqual(v.bound);
  }
}

for (const id of ['glitch', 'vhs', 'film-grain']) for (const still of STILLS_ALL) for (const variant of ['defaults', 'min', 'max'] as Variant[]) {
  // full size at defaults only for store stills and the one kept stand-in case (film-grain S3a*, the generate category); the rest 270×480
  const size: [number, number] = variant === 'defaults' && (!still.endsWith('*') || (id === 'film-grain' && still === 'S3a*')) ? [1080, 1920] : [270, 480];
  perBackend(`${id} ${variant} ${still} ${size[0]}×${size[1]} distribution`, () => info, async backend => {
    if (id === 'glitch') await glitchSeeds(backend, variantParams(id, variant), still, size, 1.25, variant);
    else await statCheck(backend, id, variantParams(id, variant), still, size, 1.25, 321.5, variant);
  }, { store: !still.endsWith('*') });
}
// A second time for each: statistics must hold, not one lucky draw. (Glitch: the same 16 seeds at each time.)
for (const id of ['glitch', 'vhs', 'film-grain']) for (const [timeS, seed] of [[0, 7.25], [9.5, 888.125]]) {
  perBackend(`${id} defaults S3a* gradient 270×480 at t=${timeS}${id === 'glitch' ? ', 16 seeds' : `, seed=${seed}`}`, () => info, async backend => {
    if (id === 'glitch') await glitchSeeds(backend, variantParams(id, 'defaults'), 'S3a*', [270, 480], timeS, `t${timeS}`);
    else await statCheck(backend, id, variantParams(id, 'defaults'), 'S3a*', [270, 480], timeS, seed, `t${timeS}-s${seed}`);
  });
}

// Halftone grain at the default grainMixer / grainOverlay (20/20), all reduced to 144×256 (the CPU oracle is slow).
for (const still of STILLS_ALL) for (const variant of ['defaults', 'max'] as Variant[]) {
  perBackend(`halftone grain ${variant} ${still} 144×256 distribution`, () => info, async backend => {
    const params = { ...variantParams('halftone', variant), grainMixer: variant === 'max' ? 90 : 20, grainOverlay: variant === 'max' ? 90 : 20 };
    await statCheck(backend, 'halftone', params, still, [144, 256], 1.25, 321.5, `grain-${variant}`);
  }, { store: !still.endsWith('*') });
}

// Determinism and seed sensitivity of the GPU output itself.
perBackend('same seed → identical bytes; different seed → different glitch and vhs output', () => info, async backend => {
  const raw = stillAt('S3a*', 270, 480), key = 'S3a*@270x480';
  await ensureInput(page, key, raw);
  for (const id of ['glitch', 'vhs']) {
    const params = variantParams(id, 'max'), run = (seed: number) => renderInPage(page, { backend, input: key, stack: [{ effectId: id, params }], context: { timeS: 1, seed } });
    const a = await run(100.5), b = await run(100.5), c = await run(555.25);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data)), `${backend} ${id} same seed`).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(c.data)), `${backend} ${id} different seed`).toBe(false);
  }
});
perBackend('film-grain changes with time; scanlines with speed > 0 change with time', () => info, async backend => {
  const raw = stillAt('S3a*', 270, 480), key = 'S3a*@270x480';
  await ensureInput(page, key, raw);
  for (const [id, extra] of [['film-grain', {}], ['scanlines', { speed: 80 }]] as const) {
    const params = { ...variantParams(id, 'defaults'), ...extra }, run = (timeS: number) => renderInPage(page, { backend, input: key, stack: [{ effectId: id, params }], context: { timeS, seed: 1 } });
    const a = await run(0.5), b = await run(0.5), c = await run(2.75);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data)), `${backend} ${id} same time`).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(c.data)), `${backend} ${id} different time`).toBe(false);
  }
});
