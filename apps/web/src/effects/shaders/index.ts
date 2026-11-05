// SPDX-License-Identifier: AGPL-3.0-only
// Kernel lookup: every WebGL effect, the two transport stages (part 4 §48 0.1) and an identity copy.
import type { Lang } from '../dsl';
import { effectById } from '../registry';
import { COLOUR_KERNELS } from './colour';
import { DISTORT_KERNELS } from './distort';
import { STYLIZE_KERNELS } from './stylize';
import { fragmentSource } from './common';

export { GLSL_VERTEX } from './common';

export const KERNELS: Record<string, string> = { ...COLOUR_KERNELS, ...STYLIZE_KERNELS, ...DISTORT_KERNELS };

/** Programs that are not effects. Aux for video-input-709 = the 256 × 1 bt709Table (code in .x). */
export const STAGE_KERNELS: Record<string, string> = {
  identity: `
fn fx(x: f32, y: f32) -> vec4f { return here(x, y); }
`,
  'video-input-709': `
fn fx(x: f32, y: f32) -> vec4f {
  let c: vec4f = here(x, y);
  let i: vec3f = floor(c013(c.xyz) * 255.0 + 0.5);
  return vec4f(tab(i.x, 0.0).x, tab(i.y, 0.0).x, tab(i.z, 0.0).x, c.w);
}
`,
  // Source is $SW wide: straight RGB in columns 0…$W − 1, alpha in the R channel of the right half (offset $SW − $W).
  'stacked-alpha': `
fn fx(x: f32, y: f32) -> vec4f {
  let col: f32 = floor(x * $W);
  let rfb: f32 = floor(y * $H);
  return vec4f(texel(col, rfb).xyz, texel(col + $SW - $W, rfb).x);
}
`,
};

export const hasKernel = (id: string) => id in KERNELS || id in STAGE_KERNELS;

/** Fragment source of one program (an effect id, a transport stage id or `identity`). */
export function programSource(id: string, lang: Lang): string {
  const effect = effectById(id);
  if (effect && effect.renderType === 'webgl' && KERNELS[id]) return fragmentSource(KERNELS[id], effect, lang);
  if (STAGE_KERNELS[id]) return fragmentSource(STAGE_KERNELS[id], undefined, lang);
  throw new Error(`no shader program for '${id}'`);
}
