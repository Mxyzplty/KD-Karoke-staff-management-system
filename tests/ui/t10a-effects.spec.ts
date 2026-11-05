// SPDX-License-Identifier: AGPL-3.0-only
// T10a render parity: every deterministic WebGL effect, GPU (WebGL2, and WebGPU where the browser grants a device) vs the CPU
// float oracle (parity/oracle). Inputs: S3a/S3c stand-ins (generated here, labelled `*`) always; the real S3a/S3b/S3c PNGs from
// $CUTFRAME_FIXTURES when the store exists (T00 rule: store cases skip on CI).
// Sizes: store stills run defaults at the full 1080×1920 and min/max at 270×480. Stand-ins (S3a*, S3c*) run everything at 270×480 except
// one defaults case per registry category at 1080×1920 (FULL below: power-window, radial-blur, kaleidoscope; film-grain is in the noise
// spec). The oracle-heavy effects (sharpen, glow, box-blur) run every variant at a reduced size (HEAVY below) because the CPU oracle
// needs minutes at 1080×1920.
// Tolerance (master plan §4 row J has SSIM ≥ 0.98; Part 4 gives no per-block number, verified by grep) - rule 6, one rule for every
// single-effect deterministic comparison: fraction of channels > 1 code ≤ 0.001, max error ≤ 4 codes, SSIM ≥ 0.98.
// ASCII (matrix cases only) is compared tie-aware (rule 4b, see buildTieSet in t10a-support.ts): the oracle variants are every
// combination of {-2^-20, 0, +2^-20} relative on each quantity (input RGB, cellSize, contrast), 3^3 - 1 = 26. Pixels where any variant
// differs from the base by > 1 code must equal one variant within 1 code; all other pixels go through rule 6. The tie fraction under
// rule 4 (one quantity at a time) and rule 4b is annotated and logged per case; a case where 4b more than doubles rule 4 is flagged.
// One test per backend; WebGPU tests are explicit skips ('no WebGPU adapter') when the browser grants no device.
import { test, expect, type Page } from '@playwright/test';
import { EFFECTS } from '../../apps/web/src/effects/registry';
import { effectById } from '../../apps/web/src/effects/registry';
import { CONTEXT, buildTieSet, compare, ensureInput, expectRule6, log, memo1, oracleBytes, oracleWith, perBackend, rule6Note, setupPage, stillAt, STILLS, STILLS_ALL, tieCompare, variantParams, renderInPage, type Backend, type PageInfo, type StillId, type TieSet, type Variant } from './t10a-support';

test.use({ channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } });
test.setTimeout(600_000);
test.describe.configure({ mode: 'parallel' });

const STAT = new Set(['glitch', 'vhs', 'film-grain']);          // random: spec t10a-statistical
const SEPARATE = new Set(['recolor', 'bg-removal', 'halftone']); // need context / select sweeps: other specs
const HEAVY: Record<string, [number, number]> = { sharpen: [270, 480], glow: [270, 480], 'box-blur': [90, 160] }; // reduced-size effects (all variants)
const FULL = new Set(['power-window/S3c*', 'radial-blur/S3c*', 'kaleidoscope/S3c*']); // stand-in defaults cases kept at 1080×1920
const IDS = EFFECTS.filter(e => e.renderType === 'webgl' && !STAT.has(e.id) && !SEPARATE.has(e.id)).map(e => e.id);

let page: Page, info: PageInfo;
test.beforeAll(async ({ browser }) => { test.setTimeout(120_000); page = await browser.newPage(); info = await setupPage(page); });
test.afterAll(async () => { await page?.close(); });

const expectedOnce = memo1<Uint8Array>(), tiesOnce = memo1<TieSet>();
async function check(backend: Backend, id: string, variant: Variant, still: StillId, [w, h]: [number, number]) {
  const raw = stillAt(still, w, h), key = `${still}@${w}x${h}`, params = variantParams(id, variant), caseKey = `${id}/${variant}/${key}`;
  await ensureInput(page, key, raw);
  const label = `${id}/${variant}/${still}/${backend}`;
  const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: id, params }], context: CONTEXT });
  if (id === 'ascii') {
    const ts = await tiesOnce(caseKey, () => buildTieSet(id, raw, params, CONTEXT, 'combined')), r = tieCompare(out.data, ts, w, h);
    const f4 = ts.tiePixelsSingle / ts.pixels, f4b = r.tieFraction, doubled = ts.tiePixelsSingle > 0 ? ts.tiePixels > 2 * ts.tiePixelsSingle : ts.tiePixels > 0;
    log({ spec: 'effects', id, variant, still, size: `${w}x${h}`, backend, tie: true, tiePixels: r.tiePixels, tieFraction: f4b, tiePixelsRule4: ts.tiePixelsSingle, tieFractionRule4: f4, tieFractionRule4b: f4b, tie4bMoreThanDoubled: doubled, tieViolations: r.tieViolations, tieMaxErr: r.tieMaxErr, offenders: r.offenders, variants: ts.variantCount, variantsRule4: ts.variantCountSingle, ...r.nonTie });
    test.info().annotations.push({ type: `${backend} tie`, description: `tie rule 4 ${(f4 * 100).toFixed(3)}% (${ts.tiePixelsSingle} px, ${ts.variantCountSingle} variants); rule 4b ${(f4b * 100).toFixed(3)}% (${r.tiePixels}/${ts.pixels} px, ${ts.variantCount} variants)${doubled ? ' FLAG: 4b more than doubles rule-4 ties' : ''}; tie violations ${r.tieViolations} (max ${r.tieMaxErr}); non-tie ${rule6Note(r.nonTie)}` });
    expect.soft(r.tieViolations, `${label} tie pixels matching no oracle variant within 1 code`).toBe(0);
    expectRule6(r.nonTie, `${label} non-tie`);
    return;
  }
  const expected = await expectedOnce(caseKey, () => oracleBytes(id, raw, key, params));
  const d = compare(out.data, expected, w, h);
  log({ spec: 'effects', id, variant, still, size: `${w}x${h}`, backend, ...d });
  test.info().annotations.push({ type: `${backend}`, description: rule6Note(d) });
  expectRule6(d, label);
}

test('the matrix covers the registry: ids list and WebGPU status', () => {
  const all = EFFECTS.filter(e => e.renderType === 'webgl').map(e => e.id);
  expect(IDS.length + STAT.size + SEPARATE.size).toBe(all.length);
  test.info().annotations.push({ type: 'webgl-effects', description: `${all.length}: ${all.join(', ')}` });
  test.info().annotations.push({ type: 'webgpu', description: info.webgpuError ? `ERROR: ${info.webgpuError}` : info.webgpu ?? 'none (skipped)' });
  test.info().annotations.push({ type: 'stills', description: STILLS.join(', ') });
});

for (const id of IDS) {
  const heavy = HEAVY[id];
  for (const still of STILLS_ALL) {
    const real = !still.endsWith('*');
    for (const variant of ['defaults', 'min', 'max'] as Variant[]) {
      // full size at defaults only for store stills and the FULL stand-in cases
      const size: [number, number] = heavy ?? (variant === 'defaults' && (real || FULL.has(`${id}/${still}`)) ? [1080, 1920] : [270, 480]);
      perBackend(`${id} ${variant} ${still} ${size[0]}×${size[1]}`, () => info, async backend => {
        await check(backend, id, variant, still, size);
      }, { store: real });
    }
  }
}

// Parameters that are valid inputs but select no-op branches must still match the oracle: a few edge values per effect.
const EDGE: { id: string; name: string; params: Record<string, unknown> }[] = [
  { id: 'levels', name: 'inputBlack = inputWhite', params: { inputBlack: 50, inputWhite: 50 } },
  { id: 'posterize', name: 'levels 2', params: { levels: 2 } },
  { id: 'threshold', name: 'level 0', params: { level: 0 } },
  { id: 'threshold', name: 'level 100', params: { level: 100 } },
  { id: 'grayscale', name: 'amount 0', params: { amount: 0 } },
  { id: 'lens-distortion', name: 'mirrorEdges off, strong barrel', params: { distortion: 80, mirrorEdges: false } },
  { id: 'mirror', name: 'both axes', params: { horizontal: true, vertical: true } },
  { id: 'mirror', name: 'neither axis', params: { horizontal: false, vertical: false } },
  { id: 'twirl', name: 'negative amount, small radius', params: { amount: -80, radius: 15 } },
  { id: 'kaleidoscope', name: '2 segments rotated', params: { segments: 2, rotation: 123 } },
  { id: 'pixelate', name: 'blockSize 100', params: { blockSize: 100 } },
  { id: 'ascii', name: 'blocks ramp, source colour', params: { ramp: 'blocks', colorMode: 'source' } },
  { id: 'ascii', name: 'dots ramp, mono', params: { ramp: 'dots', colorMode: 'mono', monoColor: 'rgba(255,128,0,1)', bgColor: 'rgba(0,0,64,1)' } },
  { id: 'scanlines', name: 'moving (speed 200)', params: { speed: 200, density: 12.5 } },
  { id: 'color-key', name: 'blue key, full spill', params: { keyColor: '#0000ff', spillReduction: 100, similarity: 70 } },
  { id: 'luma-key', name: 'bright key', params: { keyType: 'bright', threshold: 60 } },
  { id: 'secondary-qualifier', name: 'showMask', params: { showMask: true } },
  { id: 'edge-detection', name: 'mix 50, threshold 30', params: { mix: 50, threshold: 30 } },
];
for (const e of EDGE) for (const still of ['S3a*', 'S3c*'] as StillId[]) {
  perBackend(`edge ${e.id}: ${e.name} ${still} 270×480`, () => info, async backend => {
    const raw = stillAt(still, 270, 480), key = `${still}@270x480`, params = { ...variantParams(e.id, 'defaults'), ...e.params };
    // validate through the registry resolver so a typo cannot silently fall back to defaults
    expect(Object.keys(e.params).every(k => effectById(e.id)!.params.some(p => p.key === k))).toBe(true);
    await ensureInput(page, key, raw);
    const expected = await expectedOnce(`edge/${e.id}/${e.name}/${key}`, () => oracleBytes(e.id, raw, key, params));
    const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: e.id, params }], context: CONTEXT });
    const d = compare(out.data, expected, 270, 480);
    log({ spec: 'effects-edge', id: e.id, name: e.name, still, backend, ...d });
    test.info().annotations.push({ type: backend, description: rule6Note(d) });
    expectRule6(d, `${e.id} ${e.name} ${still} ${backend}`);
  });
}

// Long item time (review finding 2): scanlines at the registry maxima (density 20, speed 100; opacity 100 so the lines show) at
// T = 500 s, where the f32 phase 100·D·(y + T·speed/200) loses the line period unless the CPU reduces it first, and T = 9.5 s as a
// control. S3a* 270×480, seed CONTEXT.seed, rule 6 against the oracle at the same time.
for (const timeS of [500, 9.5]) {
  perBackend(`long time scanlines: density 20, speed 100, T ${timeS} s S3a* 270×480`, () => info, async backend => {
    const raw = stillAt('S3a*', 270, 480), key = 'S3a*@270x480', ctx = { timeS, seed: CONTEXT.seed };
    const params = { ...variantParams('scanlines', 'defaults'), density: 20, opacity: 100, speed: 100 };
    await ensureInput(page, key, raw);
    const expected = await expectedOnce(`long/scanlines/${timeS}/${key}`, () => oracleWith('scanlines', raw, params, ctx));
    const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: 'scanlines', params }], context: ctx });
    const d = compare(out.data, expected, 270, 480);
    log({ spec: 'effects-long-time', id: 'scanlines', timeS, still: 'S3a*', backend, ...d });
    test.info().annotations.push({ type: backend, description: rule6Note(d) });
    expectRule6(d, `scanlines T ${timeS} s ${backend}`);
  });
}
