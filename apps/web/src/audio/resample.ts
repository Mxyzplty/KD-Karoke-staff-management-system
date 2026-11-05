// SPDX-License-Identifier: AGPL-3.0-only
// Sources not at 48 kHz are converted to the mix rate first, as Xapp's export does (decodeAudioData into a 48 kHz
// OfflineAudioContext, findings §7), then read along the clip's speed / remap curve with linear interpolation (the buffer
// source's own reading). The converter: a Blackman-windowed sinc, 32 taps at unity (more when downsampling, cut at the
// lower Nyquist), from a table of 512 phases interpolated linearly. Provisional quality choice, not measured against Chromium.
const HALF = 16, PHASES = 512;
const tables = new Map<number, { half: number; table: Float32Array }>();
function kernel(cut: number) {
  let k = tables.get(cut);
  if (k) return k;
  const half = Math.ceil(HALF / cut), width = 2 * half, table = new Float32Array((PHASES + 1) * width);
  for (let p = 0; p <= PHASES; p++) for (let j = 0; j < width; j++) {
    const x = j - half + 1 - p / PHASES, z = x * cut, w = Math.abs(x) >= half ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x / half) + 0.08 * Math.cos(2 * Math.PI * x / half);
    table[p * width + j] = cut * (z === 0 ? 1 : Math.sin(Math.PI * z) / (Math.PI * z)) * w;
  }
  tables.set(cut, k = { half, table });
  return k;
}
/** Planar PCM at `from` Hz → `to` Hz: output frame j sits at input position offset + j × from / to (0 outside the input). */
export function resamplePlanar(data: Float32Array[], from: number, to = 48000, offset = 0, length = Math.floor(((data[0]?.length ?? 0) - offset) * to / from)): Float32Array[] {
  const ratio = from / to, { half, table } = kernel(Math.min(1, to / from)), width = 2 * half;
  if (from === to && Number.isInteger(offset)) return data.map(x => { const out = new Float32Array(Math.max(0, length)); out.set(x.subarray(Math.max(0, offset), Math.max(0, offset + length)), Math.max(0, -offset)); return out; });
  return data.map(x => {
    const out = new Float32Array(Math.max(0, length)), n = x.length;
    for (let j = 0; j < length; j++) {
      const pos = offset + j * ratio, i = Math.floor(pos), f = (pos - i) * PHASES, p = Math.floor(f), w = f - p, a = p * width, b = a + width;
      let s = 0;
      for (let t = 0, k = i - half + 1; t < width; t++, k++) if (k >= 0 && k < n) s += x[k] * (table[a + t] + (table[b + t] - table[a + t]) * w);
      out[j] = s;
    }
    return out;
  });
}
