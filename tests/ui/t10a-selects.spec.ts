// SPDX-License-Identifier: AGPL-3.0-only
// T10a render parity for the effects with select parameters that change the algorithm: every option of Halftone (grid, type,
// original colours, inverted) and Dither (pattern, mode, style, shape, palette) at least once, against the CPU oracle.
// Halftone is compared per pixel with grainMixer = grainOverlay = 0 (the grain is a hash: see t10a-noise.spec.ts) at the reduced
// size 135×240, because the CPU oracle needs ~0.8 ms per pixel for it (≈25 s per case; ≈45 minutes at 1080×1920).
// Dither runs at 270×480. Tolerance (rule 6, one rule for every single-effect deterministic comparison): fraction of channels
// > 1 code ≤ 0.001, max error ≤ 4 codes, SSIM ≥ 0.98. One test per backend; WebGPU tests are explicit skips without an adapter.
import { test, expect, type Page } from '@playwright/test';
import { effectById } from '../../apps/web/src/effects/registry';
import { compare, CONTEXT, ensureInput, expectRule6, log, memo1, oracleBytes, perBackend, renderInPage, rule6Note, setupPage, standInDark, stillAt, STILLS_ALL, variantParams, type Backend, type PageInfo, type Raw, type StillId } from './t10a-support';

test.use({ channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } });
test.setTimeout(600_000);
test.describe.configure({ mode: 'parallel' });

let page: Page, info: PageInfo;
test.beforeAll(async ({ browser }) => { test.setTimeout(120_000); page = await browser.newPage(); info = await setupPage(page); });
test.afterAll(async () => { await page?.close(); });

const expectedOnce = memo1<Uint8Array>();
async function checkRaw(backend: Backend, id: string, label: string, params: Record<string, unknown>, still: string, raw: Raw) {
  const w = raw.width, h = raw.height, key = `${still}@${w}x${h}`;
  await ensureInput(page, key, raw);
  const expected = await expectedOnce(`${id}/${label}/${key}`, () => oracleBytes(id, raw, key, params));
  const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: id, params }], context: CONTEXT });
  const d = compare(out.data, expected, w, h);
  log({ spec: 'selects', id, label, still, size: `${w}x${h}`, backend, ...d });
  test.info().annotations.push({ type: backend, description: rule6Note(d) });
  expectRule6(d, `${label} ${still} ${backend}`);
}
const check = (backend: Backend, id: string, label: string, params: Record<string, unknown>, still: StillId, [w, h]: [number, number]) =>
  checkRaw(backend, id, label, params, still, stillAt(still, w, h));
const real = (s: StillId) => !s.endsWith('*');
const NOGRAIN = { grainMixer: 0, grainOverlay: 0 };

test('every select option is exercised: coverage of the registry option lists', () => {
  const ht = effectById('halftone')!, di = effectById('dither')!;
  const opts = (e: typeof ht, key: string) => (e.params.find(p => p.key === key) as { options: { value: string }[] }).options.map(o => o.value);
  expect(opts(ht, 'grid')).toEqual(['hex', 'square']);
  expect(opts(ht, 'type')).toEqual(['classic', 'gooey', 'holes', 'soft']);
  expect(opts(di, 'pattern')).toHaveLength(9);
  expect(opts(di, 'mode')).toHaveLength(3);
  expect(opts(di, 'style')).toHaveLength(2);
  expect(opts(di, 'shape')).toHaveLength(3);
  expect(opts(di, 'palette')).toHaveLength(4);
});

for (const still of STILLS_ALL) {
  const store = real(still);
  const ht = (title: string, label: string, params: Record<string, unknown>) =>
    perBackend(`halftone ${title} ${still} 135×240 (no grain)`, () => info, async backend => { await check(backend, 'halftone', label, params, still, [135, 240]); }, { store });
  for (const grid of ['hex', 'square']) for (const type of ['classic', 'gooey', 'holes', 'soft']) {
    ht(`${grid} ${type}`, `${grid}-${type}`, { ...variantParams('halftone', 'defaults'), ...NOGRAIN, grid, type });
    ht(`${grid} ${type} originalColors`, `${grid}-${type}-original`, { ...variantParams('halftone', 'defaults'), ...NOGRAIN, grid, type, originalColors: true });
  }
  ht('inverted', 'inverted', { ...variantParams('halftone', 'defaults'), ...NOGRAIN, inverted: true, type: 'classic' });
  for (const v of ['min', 'max'] as const) ht(v, v, { ...variantParams('halftone', v), ...NOGRAIN });

  const di = effectById('dither')!, values = (key: string) => (di.params.find(p => p.key === key) as { options: { value: string }[] }).options.map(o => o.value);
  for (const key of ['pattern', 'mode', 'style', 'shape', 'palette']) for (const value of values(key)) {
    perBackend(`dither ${key}=${value} ${still} 270×480`, () => info, async backend => { await check(backend, 'dither', `${key}=${value}`, { ...variantParams('dither', 'defaults'), [key]: value }, still, [270, 480]); }, { store });
  }
}

// Dither threshold τ is exactly 1 at the cell corners of halftone, dots and scales; on an opaque black cell (b = 0 exactly) q = 0.25 sits on
// the palette boundary, so a one-ulp error in τ flips the palette entry. Neither S3a* nor S3c* has opaque black cells, so this case needs its
// own generated stand-in (DARK*: opaque black + a band of codes 0–40, 270×480); it runs everywhere, store or not.
for (const pattern of ['halftone', 'dots', 'scales']) {
  perBackend(`dither pattern=${pattern} DARK* 270×480`, () => info, async backend => {
    await checkRaw(backend, 'dither', `pattern=${pattern}`, { ...variantParams('dither', 'defaults'), pattern }, 'DARK*', standInDark());
  });
}
