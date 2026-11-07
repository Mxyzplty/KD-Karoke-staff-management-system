// SPDX-License-Identifier: AGPL-3.0-only
// T12 smart-mask strokes, pure (findings §19, part 3 §44.7, part 2 §42). Points are fractions of the source frame, the radius a fraction
// of its shorter side. The UI resamples a drawn stroke to 64 points and stops at 32 strokes; the transport takes 1–64 strokes with an
// include among them and 4,096 points; the model prompt keeps 12 points of a stroke and drops a point within 4 source px of a kept
// point of its label.
export type Stroke = { label: 0 | 1; points: [number, number][]; radius: number };
export const STROKE_LIMITS = { uiStrokes: 32, strokes: 64, points: 4096, uiPoints: 64, promptPoints: 12, spacingPx: 4, radius: 0.25 };

/** 24 px on a 534 px short side → 0.0224719. */
export const brushRadius = (diameterPx: number, shortSide: number) => diameterPx / 2 / shortSide;
/** At most `limit` entries, evenly along the list, its first and last among them. */
export function evenly<T>(list: T[], limit: number): T[] {
  if (list.length <= limit) return list;
  return Array.from({ length: limit }, (_, k) => list[Math.round(k * (list.length - 1) / (limit - 1))]);
}
export const drawnStroke = (label: 0 | 1, points: [number, number][], radius: number): Stroke => ({ label, radius, points: evenly(points, STROKE_LIMITS.uiPoints) });
/** The model prompt's strokes for a frame of width × height. A stroke with no point left goes. */
export function thinStrokes(strokes: Stroke[], width: number, height: number): Stroke[] {
  const kept: [number, number][][] = [[], []], gap = STROKE_LIMITS.spacingPx ** 2;
  return strokes.map(s => ({ ...s, points: evenly(s.points, STROKE_LIMITS.promptPoints).filter(p => {
    const x = p[0] * width, y = p[1] * height;
    if (kept[s.label].some(([a, b]) => (a - x) ** 2 + (b - y) ** 2 < gap)) return false;
    kept[s.label].push([x, y]);
    return true;
  }) })).filter(s => s.points.length);
}
/** The transport's rules: the first one broken, or null. */
export function strokeProblem(strokes: Stroke[]): string | null {
  const { strokes: most, points, radius } = STROKE_LIMITS;
  if (!strokes.length || strokes.length > most) return `A selection has 1 to ${most} strokes.`;
  if (!strokes.some(s => s.label === 1)) return 'A selection needs at least one include stroke.';
  if (strokes.some(s => !(s.radius >= 0 && s.radius <= radius))) return `A stroke radius is at most ${radius} of the shorter side.`;
  if (strokes.some(s => !s.points.length || s.points.some(p => !(p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1)))) return 'Stroke points are fractions of the frame, from 0 to 1.';
  if (strokes.reduce((n, s) => n + s.points.length, 0) > points) return `A selection has at most ${points} points.`;
  return null;
}
