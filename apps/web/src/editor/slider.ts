// SPDX-License-Identifier: AGPL-3.0-only
// Shared slider-row maths (part 3 §46.6, W3-ED-24): relative drag at about the full range per 324 CSS px, Shift = 1/10,
// Alt/Ctrl = plain, values snap to the step and clamp to the range; typed values clamp, non-numbers are ignored.
export type Range = { min: number; max: number; step: number };
export const FULL_RANGE_PX = 324, FINE_FACTOR = 0.1;
export const decimals = (step: number) => { const s = String(step); return s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1] ?? '').length; };
export const quantise = (value: number, r: Range) => {
  const snapped = Math.round((value - r.min) / r.step) * r.step + r.min;
  return Number(Math.min(r.max, Math.max(r.min, snapped)).toFixed(decimals(r.step)));
};
/** Value after a drag of `dx` CSS px from the value at press; `fine` = Shift held. */
export const dragValue = (start: number, dx: number, r: Range, fine: boolean) => quantise(start + dx * (r.max - r.min) / FULL_RANGE_PX * (fine ? FINE_FACTOR : 1), r);
/** A typed entry: a number clamps into the range (then snaps to the step); anything else is ignored (null). */
export function typedValue(text: string, r: Range): number | null {
  const trimmed = text.trim().replace(/[−–]/g, '-');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  return quantise(Number(trimmed), r);
}
export const format = (value: number, step: number) => value.toFixed(decimals(step));
