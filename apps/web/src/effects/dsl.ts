// SPDX-License-Identifier: AGPL-3.0-only
// Kernel source language. Every kernel is written once in a small WGSL subset and translated to GLSL ES 3.00 by
// regex, so the WebGL2 and WebGPU programs run the same maths. Writing rules (the translator relies on them):
// - every `let` / `var` / `const` carries a type; float literals contain '.' (GLSL ES has no int→float promotion);
// - braces on every `if`; no ternary, `select`, arrays, structs, `%`, overloads or multi-component assignment;
// - helpers are declared before use (GLSL needs it); `&&` and `||` are never mixed without parentheses (WGSL needs it).
// Parameter references, expanded per effect before translation:
//   $key            the resolved value: f32 (number, boolean 0/1, select option index), vec2f (wheel), vec4f (colour)
//   $key == 'opt'   compare a select against an option by name ($key != 'opt' too)
//   $?key           a boolean as bool
//   $W $H $T $SEED $AW $AH $SW   output size, item time (s), seed, aux size, source width
//   $xN             per-frame extra N (CPU-precomputed setup such as palettes)
import type { EffectDefinition } from './schema';

export type Lang = 'glsl' | 'wgsl';

/** Scalar uniform slots of the frame constants (vec4 array, slot s = component s & 3 of vector s >> 2). */
export const FRAME_SLOTS = { W: 0, H: 1, T: 2, SEED: 3, AW: 4, AH: 5, FINAL: 6, SW: 7 } as const;
/** First scalar slot of the per-frame extras. */
export const EXTRA_SLOT = 128;
/** Size of the uniform array in vec4s (256 scalars). */
export const UNIFORM_VEC4S = 64;

/** Source text of one scalar uniform slot. */
export function slotRef(lang: Lang, slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= UNIFORM_VEC4S * 4) throw new Error(`uniform slot ${slot} out of range`);
  return `${lang === 'wgsl' ? 'fxu.p' : 'fxP'}[${slot >> 2}].${'xyzw'[slot & 3]}`;
}

const FRAME_REF = /\$(W|H|T|SEED|AW|AH|SW)(?!\w)/g;
const EXTRA_REF = /\$x(\d+)(?!\w)/g;
const SELECT_REF = /\$([A-Za-z]\w*)\s*(==|!=)\s*'([^']*)'/g;
const BOOL_REF = /\$\?([A-Za-z]\w*)/g;
const PARAM_REF = /\$([A-Za-z]\w*)/g;

/** Replace every `$` reference with uniform reads for `effect` (frame constants and extras need no effect). */
export function expand(source: string, effect: EffectDefinition | undefined, lang: Lang): string {
  const ref = (s: number) => slotRef(lang, s);
  const vec = (n: number) => lang === 'wgsl' ? `vec${n}f` : `vec${n}`;
  const slotOf = (key: string) => {
    const u = effect?.uniforms.find(x => x.key === key);
    if (!u) throw new Error(`kernel ${effect?.id ?? '(common)'}: no uniform for '$${key}'`);
    return u;
  };
  return source
    .replace(FRAME_REF, (_, k: keyof typeof FRAME_SLOTS) => ref(FRAME_SLOTS[k]))
    .replace(EXTRA_REF, (_, n: string) => ref(EXTRA_SLOT + Number(n)))
    .replace(SELECT_REF, (_, key: string, op: string, opt: string) => {
      const p = effect?.params.find(x => x.key === key);
      const i = p?.type === 'select' ? p.options.findIndex(o => o.value === opt) : -1;
      if (i < 0) throw new Error(`kernel ${effect?.id}: '${key}' has no option '${opt}'`);
      return `(${ref(slotOf(key).slot)} ${op} ${i}.0)`;
    })
    .replace(BOOL_REF, (_, key: string) => `(${ref(slotOf(key).slot)} > 0.5)`)
    .replace(PARAM_REF, (_, key: string) => {
      const u = slotOf(key);
      if (u.size === 1) return ref(u.slot);
      return `${vec(u.size)}(${Array.from({ length: u.size }, (_, i) => ref(u.slot + i)).join(', ')})`;
    });
}

const TYPE = '[A-Za-z]\\w*';

/** WGSL subset → GLSL ES 3.00 (function signatures, typed declarations, type names, atan2). */
export function toGlsl(wgsl: string): string {
  const untyped = wgsl.match(/\b(let|var|const)\s+\w+\s*=/);
  if (untyped) throw new Error(`kernel source: untyped declaration '${untyped[0]}'`);
  return wgsl
    .replace(new RegExp(`\\bfn\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*->\\s*(${TYPE})\\s*\\{`, 'g'), (_, name: string, params: string, ret: string) => {
      const list = params.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const [n, t] = s.split(':').map(v => v.trim());
        if (!n || !t) throw new Error(`kernel source: untyped parameter '${s}' of ${name}`);
        return `${t} ${n}`;
      });
      return `${ret} ${name}(${list.join(', ')}) {`;
    })
    .replace(new RegExp(`\\b(let|var|const)\\s+(\\w+)\\s*:\\s*(${TYPE})`, 'g'), (_, kw: string, name: string, type: string) =>
      `${kw === 'const' ? 'const ' : ''}${type} ${name}`)
    .replace(/\bvec([234])f\b/g, 'vec$1')
    .replace(/\bvec([234])i\b/g, 'ivec$1')
    .replace(/\bf32\b/g, 'float')
    .replace(/\bi32\b/g, 'int')
    .replace(/\batan2\(/g, 'atan(');
}
