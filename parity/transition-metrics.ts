// SPDX-License-Identifier: AGPL-3.0-only
// The frame metrics of the T11 export checks (T11 integration round, coordinator decision QE2): the G-08 export comparison
// (parity/g08-export.ts), the OT-6 fade slice (parity/ot6-fade.ts) and tests/ui/t11-export.spec.ts. Kept apart from
// g08-export.ts so Playwright's loader can import them (g08-export.ts reaches the runner's JSON import).
import { dipColour, dipOverlay, fadeAlpha } from '../apps/web/src/render/transitions';

/** QE2 (coordinator, D26): per-frame SSIM floor; fade / dip alpha tolerance, the ticket's ±0.06 (implementation tickets l.154)
 *  for the runs against Xapp's export frames (`--golden G-08 --export`, `--ot6-fade`). Checks against the formula oracle keep
 *  their own, stricter tolerance (tests/ui/t11-export.spec.ts FIT_TOL). */
export const MIN_SSIM = 0.98, ALPHA_TOLERANCE = 0.06;

const luma = (d: Uint8Array, i: number) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
/** Mean SSIM over non-overlapping 8 × 8 windows of Rec. 709 luma (k1 .01, k2 .03, L 255): the same metric as T16a's export checks (tests/ui/t10a-support.ts). */
export function ssim(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2, B = Math.min(8, width, height); let total = 0, count = 0;
  for (let by = 0; by + B <= height; by += B) for (let bx = 0; bx + B <= width; bx += B) {
    let ma = 0, mb = 0, saa = 0, sbb = 0, sab = 0; const n = B * B;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const i = ((by + y) * width + bx + x) * 4, la = luma(a, i), lb = luma(b, i); ma += la; mb += lb; saa += la * la; sbb += lb * lb; sab += la * lb; }
    ma /= n; mb /= n; const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cv = sab / n - ma * mb;
    total += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); count++;
  }
  return count ? total / count : 1;
}
/** QE2: the formula alpha of a fade or dip frame and the least-squares alpha of `theirs`, with `ours` (Cutframe at the formula
 *  alpha) as the reference over all RGB values. Fade (the clip over black at a = fadeAlpha(p)): theirs ≈ (â / a) · ours. Dip
 *  (the colour c over the clip at a = dipOverlay(p)): theirs − c ≈ ((1 − â) / (1 − a)) · (ours − c). null for other kinds and
 *  where the formula leaves too little picture to fit (fade a < 0.1, dip a > 0.9). */
export function alphaFit(kind: string, p: number, params: unknown, theirs: Uint8Array, ours: Uint8Array): { alpha: number; fitted: number } | null {
  const fade = kind === 'fade', a = fade ? fadeAlpha(p) : kind === 'dipToColorDissolve' ? dipOverlay(p) : NaN;
  if (Number.isNaN(a) || (fade ? a < 0.1 : a > 0.9)) return null;
  const c = fade ? [0, 0, 0] : dipColour((params as { color?: unknown } | undefined)?.color);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < ours.length; i += 4) for (let k = 0; k < 3; k++) { const x = ours[i + k] - c[k]; sxy += (theirs[i + k] - c[k]) * x; sxx += x * x; }
  if (!sxx) return null;
  return { alpha: a, fitted: fade ? a * sxy / sxx : 1 - (1 - a) * sxy / sxx };
}
