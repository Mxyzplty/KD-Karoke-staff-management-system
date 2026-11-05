// SPDX-License-Identifier: AGPL-3.0-only
// CSS-rendered effects (part 4 §49.15, §51.5, §51.6): canvas filter functions that run after every WebGL effect,
// in stack order. The item's own blur/brightness filters go first in that chain; they are T15's, not here.
import { parseColour } from './colour-math';
import { effectById } from './registry';
import { resolveParams } from './validate';

export interface CssFilter { effectId: string; filter: string; /** px the filter reads past a pixel */ reach: number }

const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6);
const blurReach = (sigma: number) => Math.ceil(3 * Math.max(sigma, 0));
const DEFAULT_SHADOW = 'rgba(0,0,0,0.5)';

/** The filter function one CSS effect adds, or null when it adds nothing (invert 0 %, blur radius 0). */
export function cssFilterFor(effectId: string, values: Record<string, unknown> = {}): CssFilter | null {
  const p = resolveParams(effectId, values);
  switch (effectId) {
    case 'invert': {
      const amount = Math.min(Math.max(p.amount as number, 0), 100);
      return amount > 0 ? { effectId, filter: `invert(${fmt(amount)}%)`, reach: 0 } : null;
    }
    case 'gaussian-blur': {
      const sigma = p.radius as number;
      return sigma > 0 ? { effectId, filter: `blur(${fmt(sigma)}px)`, reach: blurReach(sigma) } : null;
    }
    case 'drop-shadow': {
      // Always added, even at 0/0/0. An unparsable colour would void the whole filter string, so it falls back to the default.
      const x = p.x as number, y = p.y as number, b = Math.max(p.blur as number, 0);
      const [r, g, bl, a] = parseColour(p.color, DEFAULT_SHADOW);
      const colour = `rgba(${fmt(r * 255)}, ${fmt(g * 255)}, ${fmt(bl * 255)}, ${fmt(a)})`;
      return { effectId, filter: `drop-shadow(${fmt(x)}px ${fmt(y)}px ${fmt(b)}px ${colour})`, reach: Math.ceil(Math.max(Math.abs(x), Math.abs(y))) + 1 + blurReach(b) };
    }
  }
  throw new Error(`'${effectId}' is not a CSS-rendered effect`);
}

export const isCssEffect = (effectId: string) => effectById(effectId)?.renderType === 'css';

/** The CSS chain of a stack: enabled CSS effects in stack order, those that add nothing left out. */
export function cssChain(stack: { effectId: string; params?: Record<string, unknown>; enabled?: boolean }[]): CssFilter[] {
  return stack.filter(e => e.enabled !== false && isCssEffect(e.effectId))
    .map(e => cssFilterFor(e.effectId, e.params)).filter((f): f is CssFilter => f !== null);
}

/** `ctx.filter` value of a chain ('none' when empty). */
export const cssFilterString = (chain: CssFilter[]) => chain.length ? chain.map(f => f.filter).join(' ') : 'none';

/**
 * Draw `source` (width × height) through a CSS chain. The layer is padded by the summed reach so blur and shadow
 * see transparent surroundings, then cropped back to width × height.
 */
export function applyCssChain(source: CanvasImageSource, width: number, height: number, chain: CssFilter[]): OffscreenCanvas {
  const pad = chain.reduce((s, f) => s + f.reach, 0);
  const big = new OffscreenCanvas(width + 2 * pad, height + 2 * pad), bctx = big.getContext('2d')!;
  bctx.filter = cssFilterString(chain);
  bctx.drawImage(source, pad, pad, width, height);
  const out = new OffscreenCanvas(width, height);
  out.getContext('2d')!.drawImage(big, pad, pad, width, height, 0, 0, width, height);
  return out;
}
