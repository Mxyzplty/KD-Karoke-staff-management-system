// SPDX-License-Identifier: AGPL-3.0-only
// T05 text measurement (findings part 5 §53.7.3; part 3 §46.7 (d)): the cached line layout the drawer uses, and the
// measured box size the Add text preset, addText's resolvedBounds and the inspector store. No font loading here (that is
// text/fonts.ts), so the timeline tools and Node scripts can import it.
import { onFontChange } from './font-registry';
import { layoutText } from './layout';
import type { TextLayout } from './layout';
import { canvasSpacing } from './style';
import type { TextStyle } from './style';

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const layouts = new Map<string, TextLayout>();
/** The layout of a style at wrap width W, measured on ctx (cached; the font, spacing and wrap settings are the key). */
export function measuredLayout(ctx: Ctx, s: TextStyle, W: number): TextLayout {
  const key = JSON.stringify([s.text, s.font, s.letterSpacing, s.wordSpacing, s.transform, s.wrap, W]);
  let l = layouts.get(key);
  if (!l) {
    setTextFont(ctx, s);
    l = layoutText(s.text, s.transform, W, s.wrap, t => ctx.measureText(t).width);
    if (layouts.size > 500) layouts.clear();
    layouts.set(key, l);
  }
  return l;
}
/** Forgets measured layouts (a font face finished loading, so the widths changed). */
export const clearLayouts = () => layouts.clear();
onFontChange(clearLayouts);
export function setTextFont(ctx: Ctx, s: TextStyle) {
  ctx.font = s.font;
  ctx.letterSpacing = canvasSpacing(s.letterSpacing) as never;
  ctx.wordSpacing = canvasSpacing(s.wordSpacing) as never;
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
}
/** Measured size of a text: the widest line, and lines × pitch where "normal" is the font's ascent and descent each
 *  rounded, as a DOM line box sums them (Roboto Bold 150 → 157 + 41 = 198 px, part 3 §46.7 (d); 120 → 159, G-03). */
export function measuredSize(ctx: Ctx, s: TextStyle, W: number): { width: number; height: number; lines: number } {
  const l = measuredLayout(ctx, s, W);
  setTextFont(ctx, s);
  const m = ctx.measureText('Hg'), normal = Math.round(m.fontBoundingBoxAscent ?? s.F) + Math.round(m.fontBoundingBoxDescent ?? 0);
  const pitch = s.lineHeight === undefined || s.lineHeight === null || s.lineHeight === 'normal' ? normal : s.pitch;
  return { width: Math.max(0, ...l.lines.map(x => x.width)), height: l.lines.length * pitch, lines: l.lines.length };
}

/** Without a canvas (Node: unit tests, scripts) sizes are approximate: 0.55 em per character and Roboto's vertical metrics
 *  (usWinAscent 2146 / usWinDescent 555 per 2048 units). The browser always measures on a real canvas. */
const approximate = (): Ctx => {
  let F = 16;
  return {
    set font(v: string) { F = Number(/([\d.]+)px/.exec(v)?.[1] ?? 16); }, get font() { return `${F}px sans-serif`; },
    letterSpacing: '0px', wordSpacing: '0px', textBaseline: 'top', textAlign: 'left',
    measureText: (t: string) => ({ width: [...t].length * 0.55 * F, fontBoundingBoxAscent: F * 2146 / 2048, fontBoundingBoxDescent: F * 555 / 2048 }),
  } as unknown as Ctx;
};
let shared: Ctx | null = null;
/** A context to measure on outside a draw: an OffscreenCanvas, else the approximation. */
export function measureContext(): Ctx {
  shared ??= typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d') ?? approximate() : approximate();
  return shared;
}
