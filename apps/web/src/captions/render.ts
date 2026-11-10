// SPDX-License-Identifier: AGPL-3.0-only
// T09 caption render modes (findings part 5 §57.1–§57.2; golden capture G-18, agent tool results §12). Pure: the per-word
// state (alpha, scale, slide offset, highlight colour) a render mode gives at one item-local time. The line layout and the
// drawing are captions/draw.ts; the whole-box transform is the shared render model. No DOM.
import type { RecordData } from '../store/model';

// §57.3: the first letter determines the line's word order.
const RTL = /\p{Script=Arabic}|\p{Script=Hebrew}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Adlam}|\p{Script=Samaritan}|\p{Script=Mandaic}/u;
export const isRtl = (text: string) => { const first = text.match(/\p{L}/u); return !!first && RTL.test(first[0]); };

/** The five render modes (results §2 editAllCaptionStyles). */
export const RENDER_MODES = ['default', 'highlight', 'word-by-word', 'slide-up', 'slide-left'] as const;
export type RenderMode = typeof RENDER_MODES[number];

/** Resolved render settings (§57.1): renderConfig with the fallbacks. 0 / missing → fallback for the two numeric animation
 *  keys; only a missing value → fallback for the rest. `animationDurationMs` has a different fallback per mode. */
export type RenderConfig = { highlightColor: string; highlightScale: number; baseOpacity: number; durWordByWord: number; durSlide: number; slideDistance: number };
const numOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : d);
export function renderConfig(item: RecordData): RenderConfig {
  const c = (item.details?.renderConfig ?? {}) as RecordData, dur = c.animationDurationMs;
  return {
    highlightColor: typeof c.highlightColor === 'string' && c.highlightColor ? c.highlightColor : '#FFD700',
    highlightScale: typeof c.highlightScale === 'number' && Number.isFinite(c.highlightScale) ? c.highlightScale : 1.05,
    baseOpacity: typeof c.baseOpacity === 'number' && Number.isFinite(c.baseOpacity) ? c.baseOpacity : 0.4,
    durWordByWord: numOr(dur, 120), durSlide: numOr(dur, 200), slideDistance: numOr(c.slideDistance, 20),
  };
}

const clamp01 = (t: number) => t < 0 ? 0 : t > 1 ? 1 : t;
/** easeOutCubic: 1 − (1 − t)³ (§57.2 slide modes). */
const outCubic = (t: number) => { const u = 1 - clamp01(t); return 1 - u * u * u; };

/** The state a word is drawn with at item-local ms τ. `color` null = the item's own colour; offsets are project canvas px
 *  about the word's centre. */
export type WordState = { alpha: number; scale: number; dx: number; dy: number; color: string | null };
export function wordState(mode: RenderMode, cfg: RenderConfig, word: { startMs: number; endMs: number }, tau: number): WordState {
  const rest: WordState = { alpha: 1, scale: 1, dx: 0, dy: 0, color: null };
  const started = tau >= word.startMs;
  switch (mode) {
    case 'highlight':
      return tau >= word.startMs && tau < word.endMs ? { alpha: 1, scale: cfg.highlightScale, dx: 0, dy: 0, color: cfg.highlightColor } : rest;
    case 'word-by-word': {
      const o = cfg.baseOpacity + (1 - cfg.baseOpacity) * clamp01((tau - word.startMs) / cfg.durWordByWord);
      return { ...rest, alpha: started ? o : cfg.baseOpacity };
    }
    case 'slide-up': {
      if (!started) return { ...rest, alpha: 0, dy: cfg.slideDistance };
      const e = outCubic((tau - word.startMs) / cfg.durSlide);
      return { ...rest, alpha: e, dy: (1 - e) * cfg.slideDistance };
    }
    case 'slide-left': {
      if (!started) return { ...rest, alpha: 0, dx: cfg.slideDistance };
      const e = outCubic((tau - word.startMs) / cfg.durSlide);
      return { ...rest, alpha: e, dx: (1 - e) * cfg.slideDistance };
    }
    default:
      return rest;
  }
}
/** The mode an item stores, defaulting to `default` for an unknown value (the drawer never throws on stored data). */
export const modeOf = (item: RecordData): RenderMode => {
  const m = item.details?.renderMode;
  return (RENDER_MODES as readonly string[]).includes(m) ? m as RenderMode : 'default';
};
