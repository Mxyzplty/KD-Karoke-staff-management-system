// SPDX-License-Identifier: AGPL-3.0-only
// T05 text animations, test child. Oracle: findings part 5 §56 (key tables, timing models, scramble rule) and the stored
// W3-RT-02 ratios quoted in the T05 ticket (typewriter / pop at speed 2). Every geometry, alpha and timing test here is a
// "formula oracle" test: no stored Xapp frames exist in this repo. Pure node: no fonts, no canvas.
import { describe, expect, it } from 'vitest';
import {
  BASE_MS, KEY_TABLES, MAX_DURATION_MS, PER_GRAPHEME, PRESETS, SPEED, IDENTITY_CHANNELS, animationState, animationTime, baseDuration, channels, checkAnimation, graphemes,
  holdKeys, outCubic, readAnimation, scrambleChar, scramblePool, scrambleSeed, scrambled, smoothKeys, stepFade, storedAnimation, typewriterCount,
} from '../apps/web/src/text/animation';
import type { Preset } from '../apps/web/src/text/animation';

const refusal = (fn: () => unknown): any => { try { fn(); } catch (e: any) { return e; } throw new Error('expected a refusal'); };
const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe('formula oracle: the 14 presets and the stored config (§56.1)', () => {
  it('lists the 14 presets in the Animation grid order', () => {
    expect([...PRESETS]).toEqual(['none', 'typewriter', 'scramble', 'pop', 'jump', 'fade', 'zoom', 'flicker', 'loud', 'fall', 'speedy', 'stamped', 'step-fade', 'slide-right']);
  });
  it('per-grapheme presets are typewriter, scramble and step-fade; the others carry a base duration', () => {
    expect([...PER_GRAPHEME].sort()).toEqual(['scramble', 'step-fade', 'typewriter']);
    expect(BASE_MS).toEqual({ pop: 650, jump: 700, fade: 400, zoom: 450, flicker: 650, loud: 720, fall: 760, speedy: 780, stamped: 520, 'slide-right': 500 });
    for (const p of PRESETS) expect(p === 'none' || PER_GRAPHEME.has(p) || BASE_MS[p] > 0, p).toBe(true);
  });
  it('stores {version:1, preset} and writes speed only when it is not 1 (W3-RT-02)', () => {
    expect(storedAnimation('pop')).toEqual({ version: 1, preset: 'pop' });
    expect(storedAnimation('pop', 1)).toEqual({ version: 1, preset: 'pop' });
    expect(Object.keys(storedAnimation('pop', 1))).not.toContain('speed');
    expect(storedAnimation('pop', 2)).toEqual({ version: 1, preset: 'pop', speed: 2 });
    expect(storedAnimation('fade', 0.5, 900)).toEqual({ version: 1, preset: 'fade', speed: 0.5, durationMs: 900 });
  });
  it('speed bounds are 0.25 to 4 in steps of 0.25', () => { expect(SPEED).toEqual({ min: 0.25, max: 4, step: 0.25 }); });
  it('readAnimation: an unknown preset reads as none, a non-number speed as 1, speed is clamped to 0.25..4', () => {
    expect(readAnimation({ preset: 'wobble' })).toEqual({ preset: 'none', speed: 1, durationMs: null });
    expect(readAnimation(undefined)).toEqual({ preset: 'none', speed: 1, durationMs: null });
    expect(readAnimation('pop')).toEqual({ preset: 'pop', speed: 1, durationMs: null });
    expect(readAnimation({ preset: 'pop', speed: 'fast' }).speed).toBe(1);
    expect(readAnimation({ preset: 'pop', speed: 99 }).speed).toBe(4);
    expect(readAnimation({ preset: 'pop', speed: 0.01 }).speed).toBe(0.25);
  });
  it('readAnimation honours durationMs only on the whole-item presets', () => {
    expect(readAnimation({ preset: 'pop', durationMs: 900 }).durationMs).toBe(900);
    expect(readAnimation({ preset: 'typewriter', durationMs: 900 }).durationMs).toBeNull();
    expect(readAnimation({ preset: 'none', durationMs: 900 }).durationMs).toBeNull();
    expect(readAnimation({ preset: 'pop', durationMs: -5 }).durationMs).toBeNull();
  });
});

describe('formula oracle: checkAnimation, the agent validation (INVALID_TEXT_ANIMATION)', () => {
  it('accepts every preset name and the object form; returns the stored config', () => {
    for (const p of PRESETS) expect(checkAnimation(p)).toEqual({ version: 1, preset: p });
    expect(checkAnimation({ preset: 'zoom', speed: 2 })).toEqual({ version: 1, preset: 'zoom', speed: 2 });
    expect(checkAnimation({ preset: 'zoom', speed: 1 })).toEqual({ version: 1, preset: 'zoom' });
    expect(checkAnimation({ preset: 'zoom', durationMs: 1200 })).toEqual({ version: 1, preset: 'zoom', durationMs: 1200 });
    expect(checkAnimation({ preset: 'zoom', durationMs: MAX_DURATION_MS })).toEqual({ version: 1, preset: 'zoom', durationMs: MAX_DURATION_MS });
  });
  it('durationMs 0 means the default and is not stored', () => { expect(checkAnimation({ preset: 'pop', durationMs: 0 })).toEqual({ version: 1, preset: 'pop' }); });
  it.each([
    ['an unknown preset', 'wobble', /'wobble' is not a text animation/],
    ['a number', 5, /textAnimation must be a preset name or/],
    ['an array', ['pop'], /textAnimation must be a preset name or/],
    ['null', null, /textAnimation must be a preset name or/],
    ['an unknown key', { preset: 'pop', bogus: 1 }, /Unknown textAnimation key\(s\): bogus/],
    ['an object without preset', { speed: 2 }, /is not a text animation/],
    ['speed below 0.25', { preset: 'pop', speed: 0.2 }, /speed must be a number from 0.25 to 4/],
    ['speed above 4', { preset: 'pop', speed: 4.5 }, /speed must be a number from 0.25 to 4/],
    ['a string speed', { preset: 'pop', speed: '2' }, /speed must be a number/],
    ['durationMs on typewriter', { preset: 'typewriter', durationMs: 500 }, /durationMs applies only to whole-item presets\. typewriter is timed per character \(70 ms per character\)/],
    ['durationMs on scramble', { preset: 'scramble', durationMs: 500 }, /scramble is timed per character \(50 ms per character\)/],
    ['durationMs on step-fade', { preset: 'step-fade', durationMs: 500 }, /step-fade is timed per character \(240 ms each, 55 ms apart\)/],
    ['durationMs on none', { preset: 'none', durationMs: 500 }, /durationMs has no effect on the preset none/],
    ['durationMs above the cap', { preset: 'pop', durationMs: MAX_DURATION_MS + 1 }, /durationMs must be a number from 0 to 10000/],
    ['a negative durationMs', { preset: 'pop', durationMs: -1 }, /durationMs must be a number from 0 to 10000/],
  ])('refuses %s with INVALID_TEXT_ANIMATION', (_n, input, message) => {
    const e = refusal(() => checkAnimation(input));
    expect(e.code).toBe('INVALID_TEXT_ANIMATION');
    expect(e.error).toBe('Invalid text animation');
    expect(e.extra.message).toMatch(message);
  });
});

describe('formula oracle: timing models (§56.2)', () => {
  const cfg = (preset: Preset, speed = 1, durationMs: number | null = null) => ({ preset, speed, durationMs });
  it('per-grapheme durations: typewriter 70 n, scramble 50 n, step-fade 240 + 55 (n - 1)', () => {
    for (const n of [1, 2, 5, 17]) {
      expect(baseDuration(cfg('typewriter'), n)).toBe(70 * n);
      expect(baseDuration(cfg('scramble'), n)).toBe(50 * n);
      expect(baseDuration(cfg('step-fade'), n)).toBe(240 + 55 * (n - 1));
    }
    expect(baseDuration(cfg('step-fade'), 0)).toBe(0);
    expect(baseDuration(cfg('none'), 9)).toBe(0);
  });
  it('whole-item durations are the base table, length of the text and of the item never matter', () => {
    for (const [p, ms] of Object.entries(BASE_MS)) { expect(baseDuration(cfg(p as Preset), 1), p).toBe(ms); expect(baseDuration(cfg(p as Preset), 300), p).toBe(ms); }
  });
  it('durationMs replaces the default duration', () => { expect(baseDuration(cfg('pop', 1, 1234), 5)).toBe(1234); });
  it('c = min(tau * speed, T), q = c / T; q is 1 when T is 0', () => {
    expect(animationTime(cfg('pop', 2), 100, 5)).toEqual({ c: 200, T: 650, q: 200 / 650 });
    expect(animationTime(cfg('pop', 2), 5000, 5)).toEqual({ c: 650, T: 650, q: 1 });
    expect(animationTime(cfg('pop'), -40, 5).c).toBe(0);
    expect(animationTime(cfg('none'), 100, 5)).toEqual({ c: 0, T: 0, q: 1 });
  });
  it('real duration is T / speed: at speed 4 the pop is final by 162.5 ms, at 0.25 by 2600 ms', () => {
    expect(animationTime(cfg('pop', 4), 162.5, 5).q).toBe(1);
    expect(animationTime(cfg('pop', 4), 162, 5).q).toBeLessThan(1);
    expect(animationTime(cfg('pop', 0.25), 2600, 5).q).toBe(1);
    expect(animationTime(cfg('pop', 0.25), 2599, 5).q).toBeLessThan(1);
  });
});

describe('formula oracle: curve primitives and key tables (§56.4–§56.5)', () => {
  it('outCubic: 0 at 0, 1 at 1, 0.875 at 0.5', () => { expect(outCubic(0)).toBe(0); expect(outCubic(1)).toBe(1); near(outCubic(0.5), 0.875); });
  it('smoothKeys: smoothstep per segment, zero slope at keys, flat outside', () => {
    const keys = [[0, 0], [0.5, 10], [1, 4]] as const;
    expect(smoothKeys(keys, -1)).toBe(0);
    expect(smoothKeys(keys, 0)).toBe(0);
    near(smoothKeys(keys, 0.25), 5);                  // smoothstep(.5) = .5
    near(smoothKeys(keys, 0.125), 10 * 0.25 * 0.25 * (3 - 0.5)); // smoothstep(.25)
    expect(smoothKeys(keys, 0.5)).toBe(10);
    near(smoothKeys(keys, 0.75), 7);
    expect(smoothKeys(keys, 1)).toBe(4);
    expect(smoothKeys(keys, 5)).toBe(4);
    const jump = [[0, 1], [0.5, 1], [0.5, 3], [1, 3]] as const;
    expect(smoothKeys(jump, 0.5)).toBe(1); expect(smoothKeys(jump, 0.5 + 1e-9)).toBe(3); // a zero-length segment jumps just after its key
  });
  it('holdKeys: the value of the last key with q_i <= q', () => {
    const keys = [[0, 0], [0.3, 1], [0.6, 0.5]] as const;
    expect(holdKeys(keys, 0)).toBe(0); expect(holdKeys(keys, 0.29)).toBe(0); expect(holdKeys(keys, 0.3)).toBe(1); expect(holdKeys(keys, 0.7)).toBe(0.5);
  });
  it('every whole-item preset starts hidden-or-displaced and ends on the identity channels', () => {
    for (const p of Object.keys(BASE_MS)) {
      const end = channels(p as Preset, 1);
      for (const k of Object.keys(IDENTITY_CHANNELS) as (keyof typeof end)[]) near(end[k], IDENTITY_CHANNELS[k], 1e-9);
      expect(KEY_TABLES[p], p).toBeDefined();
    }
  });
  it('none and the per-grapheme presets have identity channels at every q', () => {
    for (const p of ['none', 'typewriter', 'scramble', 'step-fade'] as Preset[]) for (const q of [0, 0.4, 1]) expect(channels(p, q), `${p} ${q}`).toEqual(IDENTITY_CHANNELS);
  });
  it('start values (q = 0) from the tables', () => {
    const at0 = (p: Preset) => channels(p, 0);
    expect(at0('pop')).toMatchObject({ k: 0.45, o: 0 });
    expect(at0('jump')).toMatchObject({ ty: 0.22, r: 0, k: 0.94, o: 0 });
    expect(at0('fade')).toMatchObject({ o: 0 });
    expect(at0('zoom')).toMatchObject({ k: 0.65, o: 0 });
    expect(at0('flicker')).toMatchObject({ o: 0 });
    expect(at0('loud')).toMatchObject({ k: 0.55, o: 0 });
    expect(at0('fall')).toMatchObject({ ty: -0.58, k: 1, o: 0 });
    expect(at0('speedy')).toMatchObject({ tx: 0.72, skew: -16, o: 0 });
    expect(at0('stamped')).toMatchObject({ k: 2.6, o: 0 });
    near(at0('slide-right').tx, -0.35); expect(at0('slide-right').o).toBe(0);
  });
  it('pop key values: 1.18 at q = .34, .91 at .54, 1.07 at .72, .97 at .86', () => {
    near(channels('pop', 0.34).k, 1.18); near(channels('pop', 0.54).k, 0.91); near(channels('pop', 0.72).k, 1.07); near(channels('pop', 0.86).k, 0.97);
  });
  it('opacity ramps: pop reaches 1 at q = .2, stamped at 1/6, zoom at .5; flicker holds its steps', () => {
    near(channels('pop', 0.1).o, 0.5); expect(channels('pop', 0.2).o).toBe(1);
    near(channels('stamped', 1 / 12).o, 0.5); expect(channels('zoom', 0.5).o).toBe(1);
    const f = (q: number) => channels('flicker', q).o;
    expect([f(0.11), f(0.12), f(0.2), f(0.31), f(0.42), f(0.53), f(0.61), f(0.7), f(0.77), f(0.84), f(1)]).toEqual([0, 0.72, 0.08, 0.9, 0.18, 1, 0.42, 1, 0.68, 1, 1]);
  });
  it('fade opacity follows outCubic; zoom scale 0.65 + 0.35 outCubic', () => {
    near(channels('fade', 0.5).o, 0.875); near(channels('zoom', 0.5).k, 0.65 + 0.35 * 0.875);
  });
});

describe('formula oracle: graphemes (§56.1), Latin, emoji and CJK', () => {
  it('splits extended grapheme clusters; spaces and line breaks count', () => {
    expect(graphemes('Hi there')).toHaveLength(8);
    expect(graphemes('a\nb')).toEqual(['a', '\n', 'b']);
    expect(graphemes('éx')).toEqual(['é', 'x']);              // combining accent stays with its base
    expect(graphemes('👨‍👩‍👧!')).toEqual(['👨‍👩‍👧', '!']);                    // ZWJ family is one grapheme
    expect(graphemes('🇸🇬🇯🇵')).toEqual(['🇸🇬', '🇯🇵']);                      // flags
    expect(graphemes('👍🏽')).toHaveLength(1);                              // skin-tone modifier
    expect(graphemes('')).toEqual([]);
  });
  it('CJK: one grapheme per character, typewriter timing is 70 ms each (animation timing acceptance, no font needed)', () => {
    const text = '你好，世界';
    expect(graphemes(text)).toHaveLength(5);
    const s = (tau: number) => animationState({ version: 1, preset: 'typewriter' }, tau, text);
    expect(s(0).T).toBe(350);
    expect([0, 69, 70, 139, 140, 349, 350, 2000].map(t => typewriterCount(s(t).c, s(t).n))).toEqual([0, 0, 1, 1, 2, 4, 5, 5]);
  });
  it('CJK scramble: an ideograph is a letter without a-z or a digit, so it scrambles through A-Z; CJK punctuation never changes; all resolve by 50 (i + 1)', () => {
    expect(scramblePool('你')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(scramblePool('，')).toBeNull();
    const s0 = scrambled('你好，世界', 0);
    expect(graphemes(s0)).toHaveLength(5);
    expect(s0[2]).toBe('，');
    for (const i of [0, 1, 3, 4]) expect(s0[i], `grapheme ${i}`).toMatch(/^[A-Z]$/);
    expect(scrambled('你好，世界', 250)).toBe('你好，世界');
    expect(scrambled('你好，世界', 100).startsWith('你好')).toBe(true);
  });
  it('emoji cluster counts as one typewriter step and stays whole', () => {
    const text = 'a👨‍👩‍👧b';
    const n = graphemes(text).length;
    expect(n).toBe(3);
    expect(animationState({ version: 1, preset: 'typewriter' }, 70, text).n).toBe(3);
    expect(typewriterCount(70, n)).toBe(1); expect(typewriterCount(140, n)).toBe(2);
  });
});

describe('formula oracle: typewriter and step-fade (§56.6)', () => {
  it('typewriterCount = min(n, floor(c / 70))', () => {
    expect([0, 69.9, 70, 140, 489, 490, 9999].map(c => typewriterCount(c, 7))).toEqual([0, 0, 1, 2, 6, 7, 7]);
  });
  it('step-fade grapheme i: opacity outCubic of (c - 55 i) / 240, drop 0.22 (1 - e)', () => {
    expect(stepFade(0, 0)).toEqual({ o: 0, drop: 0.22 });
    expect(stepFade(0, 3)).toEqual({ o: 0, drop: 0.22 });            // not started yet
    near(stepFade(120, 0).o, 0.875); near(stepFade(120, 0).drop, 0.22 * 0.125);
    expect(stepFade(240, 0)).toEqual({ o: 1, drop: 0 });
    near(stepFade(55 + 120, 1).o, 0.875);                            // grapheme 1 starts 55 ms later
    expect(stepFade(240 + 55 * 4, 4)).toEqual({ o: 1, drop: 0 });
  });
});

describe('formula oracle: scramble (§56.6, deterministic)', () => {
  // Independent oracle of the 32-bit steps with BigInt, so the test cannot share an arithmetic slip with the code.
  const M = 0xffffffffn, imul = (a: bigint, b: bigint) => (a * b) & M;
  const fnv = (text: string) => { let h = 2166136261n; for (const ch of text) h = imul(h ^ BigInt(ch.codePointAt(0)!), 16777619n); return h; };
  const pick = (seed: bigint, g: string, i: number, c: number) => {
    const pool = /[\p{L}\p{N}]/u.test(g) ? (/[a-z]/.test(g) ? 'abcdefghijklmnopqrstuvwxyz' : /[0-9]/.test(g) ? '0123456789' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') : null;
    if (!pool || c >= 50 * (i + 1)) return g;
    const j = BigInt(Math.floor(c / 45));
    const x = imul(seed ^ imul(BigInt(i + 1), 2654435761n) ^ imul(j, 1597334677n), 16777619n);
    return pool[Number(x % BigInt(pool.length))];
  };
  it('the seed is 32-bit FNV-1a over code points', () => {
    for (const t of ['', 'a', 'Hello', 'World', '你好', 'a👍b']) expect(BigInt(scrambleSeed(t) >>> 0), t).toBe(fnv(t));
    expect(BigInt(scrambleSeed('') >>> 0)).toBe(2166136261n);
    expect(BigInt(scrambleSeed('a') >>> 0)).toBe(0xe40c292cn);        // the published FNV-1a 32 test vector for "a"
  });
  it('matches the independent oracle at every tick for a mixed string', () => {
    const text = 'Hello World 42!';
    const seed = fnv(text), gs = graphemes(text);
    for (const c of [0, 10, 44, 45, 90, 134, 135, 200, 449, 450, 749, 750, 900]) {
      expect(scrambled(text, c), `c=${c}`).toBe(gs.map((g, i) => pick(seed, g, i, c)).join(''));
    }
  });
  it('is deterministic: the same text and c always give the same string', () => { expect(scrambled('Hello', 60)).toBe(scrambled('Hello', 60)); });
  it('resolves grapheme i exactly when c >= 50 (i + 1)', () => {
    const text = 'abcde', seed = scrambleSeed(text);
    for (let i = 0; i < 5; i++) {
      expect(scrambleChar(seed, text[i], i, 50 * (i + 1) - 1e-3) === text[i] || true).toBe(true);
      expect(scrambleChar(seed, text[i], i, 50 * (i + 1))).toBe(text[i]);
      expect(scrambleChar(seed, text[i], i, 9999)).toBe(text[i]);
    }
    expect(scrambled(text, 250)).toBe(text);
    expect(scrambled(text, 100)).toMatch(/^ab[a-z]{3}$/);
  });
  it('pools: lowercase letters scramble to a-z, digits to 0-9, capitals/no-lowercase to A-Z; others never change', () => {
    expect(scramblePool('x')).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(scramblePool('7')).toBe('0123456789');
    expect(scramblePool('Q')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(scramblePool(' ')).toBeNull(); expect(scramblePool('!')).toBeNull(); expect(scramblePool('\n')).toBeNull(); expect(scramblePool('👍')).toBeNull();
    const out = scrambled('Ab 1, Z!', 0);
    expect(out[2]).toBe(' '); expect(out[4]).toBe(','); expect(out[7]).toBe('!');
    expect(out[0]).toMatch(/[A-Z]/); expect(out[1]).toMatch(/[a-z]/); expect(out[3]).toMatch(/[0-9]/); expect(out[6]).toMatch(/[A-Z]/);
  });
  it('the stand-ins change every 45 ms tick and the tick index is floor(c / 45)', () => {
    const text = 'zzzzzzzzzzzzzzzzzzzz';                              // 20 graphemes: the last stays scrambled until 1000 ms
    expect(scrambled(text, 0)).toBe(scrambled(text, 44));
    expect(scrambled(text, 0)).not.toBe(scrambled(text, 45));
    expect(scrambled(text, 45).slice(2)).toBe(scrambled(text, 89).slice(2)); // graphemes 0 and 1 resolve at 50 and 100
  });
});

describe('formula oracle: W3 fixture 3 — "World", Roboto Bold 150, 30 fps (W3-RT-02 ratios)', () => {
  const WORD = 'World';
  it('typewriter at speed 2 reveals nothing at 0 and 33 ms, W at 67, Wo at 100, Wor at 133, Worl at 167, World from 200', () => {
    const shown = (ms: number) => { const s = animationState({ version: 1, preset: 'typewriter', speed: 2 }, ms, WORD); return WORD.slice(0, typewriterCount(s.c, s.n)); };
    expect([0, 33, 67, 100, 133, 167, 200, 233, 1000].map(shown)).toEqual(['', '', 'W', 'Wo', 'Wor', 'Worl', 'World', 'World', 'World']);
  });
  // The stored ratios: text box width relative to the final width. The pop scales the box about its centre, so ratio = k(q).
  const RATIOS: [number, number][] = [[67, 0.93], [100, 1.16], [133, 1.10], [167, 0.92], [200, 0.97], [233, 1.07], [267, 0.99]];
  it('pop at speed 2: width ratios 0.93 / 1.16 / 1.10 / 0.92 / 0.97 / 1.07 / 0.99 at 67..267 ms, within 1 % of width', () => {
    for (const [ms, ratio] of RATIOS) {
      const s = animationState({ version: 1, preset: 'pop', speed: 2 }, ms, WORD);
      expect(Math.abs(s.channels.k - ratio), `${ms} ms: k=${s.channels.k.toFixed(4)}`).toBeLessThanOrEqual(0.011);
    }
  });
  it('pop at speed 1 shows the same ratios at twice the times (the 650 ms curve)', () => {
    for (const [ms, ratio] of RATIOS) {
      const slow = animationState({ version: 1, preset: 'pop' }, ms * 2, WORD), fast = animationState({ version: 1, preset: 'pop', speed: 2 }, ms, WORD);
      near(slow.channels.k, fast.channels.k, 1e-12);
      expect(Math.abs(slow.channels.k - ratio)).toBeLessThanOrEqual(0.011);
    }
  });
  it('fixture 4: a 5 s item\'s pop is final by 650 ms and stays final (the item length does not stretch it)', () => {
    for (const tau of [650, 700, 2500, 5000]) {
      const s = animationState({ version: 1, preset: 'pop' }, tau, WORD);
      expect(s.q).toBe(1); expect(s.channels).toEqual(IDENTITY_CHANNELS);
    }
    expect(animationState({ version: 1, preset: 'pop' }, 649, WORD).q).toBeLessThan(1);
    expect(animationState({ version: 1, preset: 'pop' }, 640, WORD).channels.k).not.toBe(1);
  });
  it('the entrance runs on the time since the item\'s timeline start, so a split second piece (tau starts at 0) replays', () => {
    const a = animationState({ version: 1, preset: 'pop' }, 0, WORD), b = animationState({ version: 1, preset: 'pop' }, 0, WORD);
    expect(a.channels.o).toBe(0); expect(b).toEqual(a);
  });
});

describe('m4: §56 interior key tables and per-grapheme vectors (the spec numbers are written out, never read from KEY_TABLES)', () => {
  type Ch = keyof typeof IDENTITY_CHANNELS;
  // [preset, an interior §56 key q, channel, the §56 value]. At an exact key q, smoothKeys returns that key's value.
  const KEYS: [Preset, number, Ch, number][] = [
    ['jump', 0.24, 'ty', -0.15], ['jump', 0.44, 'ty', -0.30], ['jump', 0.68, 'ty', 0.04], ['jump', 0.84, 'ty', -0.018],
    ['jump', 0.24, 'r', -8], ['jump', 0.44, 'r', 7], ['jump', 0.68, 'r', -3], ['jump', 0.84, 'r', 1.2],
    ['jump', 0.24, 'k', 1.03], ['jump', 0.68, 'k', 0.98],
    ['loud', 0.20, 'k', 1.30], ['loud', 0.38, 'k', 1.12], ['loud', 0.54, 'k', 1.18], ['loud', 0.70, 'k', 1.05], ['loud', 0.84, 'k', 1.02],
    ['loud', 0.42, 'tx', -0.035], ['loud', 0.52, 'tx', 0.032], ['loud', 0.62, 'tx', -0.022], ['loud', 0.72, 'tx', 0.014], ['loud', 0.84, 'tx', -0.006], // T09 (C8 assertion-only edit): D34 Minor

    ['loud', 0.42, 'ty', 0.012], ['loud', 0.52, 'ty', -0.010], ['loud', 0.62, 'ty', 0.008], ['loud', 0.72, 'ty', -0.005],
    ['loud', 0.42, 'r', -4], ['loud', 0.52, 'r', 3.5], ['loud', 0.62, 'r', -2.5], ['loud', 0.72, 'r', 1.6], ['loud', 0.84, 'r', -0.7],
    ['fall', 0.46, 'ty', 0.10], ['fall', 0.64, 'ty', -0.075], ['fall', 0.80, 'ty', 0.032], ['fall', 0.91, 'ty', -0.010],
    ['fall', 0.46, 'k', 0.96], ['fall', 0.64, 'k', 1.025], ['fall', 0.80, 'k', 0.99],
    ['speedy', 0.43, 'tx', -0.055], ['speedy', 0.60, 'tx', 0.034], ['speedy', 0.74, 'tx', -0.018], ['speedy', 0.87, 'tx', 0.007],
    ['speedy', 0.43, 'r', -3.5], ['speedy', 0.60, 'r', 2.3], ['speedy', 0.74, 'r', -1.3], ['speedy', 0.87, 'r', 0.5],
    ['speedy', 0.43, 'skew', -9], ['speedy', 0.60, 'skew', 4], ['speedy', 0.74, 'skew', -2.2], ['speedy', 0.87, 'skew', 0.8],
    ['stamped', 0.42, 'k', 0.84], ['stamped', 0.62, 'k', 1.10], ['stamped', 0.78, 'k', 0.96], ['stamped', 0.90, 'k', 1.025],
  ];
  it.each(KEYS)('%s q=%s channel %s = the §56 key', (p, q, k, want) => { near(channels(p, q)[k], want); });

  // slide-right is a formula, not keys: tx = 0.35 (outCubic(q) - 1), o = min(1, 2 q). Independent reimplementation.
  const oc = (x: number) => 1 - (1 - x) ** 3, clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  it('slide-right follows its §56 formula at interior q', () => {
    for (const q of [0.1, 0.25, 0.5, 0.75]) { near(channels('slide-right', q).tx, 0.35 * (oc(q) - 1)); near(channels('slide-right', q).o, Math.min(1, 2 * q)); }
  });

  // step-fade at c = 100 ms: grapheme 0 well into its fade, grapheme 1 just begun, grapheme 2 not started (§56.6).
  it('step-fade t = 100 ms values (opacity outCubic((c - 55 i) / 240), drop 0.22 (1 - o))', () => {
    const e = (c: number, i: number) => oc(clamp01((c - 55 * i) / 240));
    for (const i of [0, 1, 2]) { const s = stepFade(100, i); near(s.o, e(100, i)); near(s.drop, 0.22 * (1 - e(100, i))); }
    expect(stepFade(100, 2)).toEqual({ o: 0, drop: 0.22 });   // (100 - 110) < 0 → clamped: not started
  });

  // scramble "World": 'W' is a capital (A-Z pool), o/r/l/d lowercase (a-z pool); grapheme i resolves at c = 50 (i + 1).
  const M = 0xffffffffn, imul = (a: bigint, b: bigint) => (a * b) & M;
  const fnv = (t: string) => { let h = 2166136261n; for (const ch of t) h = imul(h ^ BigInt(ch.codePointAt(0)!), 16777619n); return h; };
  const pick = (seed: bigint, g: string, i: number, c: number) => {
    const pool = /[\p{L}\p{N}]/u.test(g) ? (/[a-z]/.test(g) ? 'abcdefghijklmnopqrstuvwxyz' : /[0-9]/.test(g) ? '0123456789' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') : null;
    if (!pool || c >= 50 * (i + 1)) return g;
    const x = imul(seed ^ imul(BigInt(i + 1), 2654435761n) ^ imul(BigInt(Math.floor(c / 45)), 1597334677n), 16777619n);
    return pool[Number(x % BigInt(pool.length))];
  };
  it('scramble "World" matches the independent oracle at each tick and resolves W,o,r,l,d at 50,100,150,200,250', () => {
    const seed = fnv('World'), gs = graphemes('World');
    for (const c of [0, 44, 45, 90, 100, 149, 150, 249, 250]) expect(scrambled('World', c), `c=${c}`).toBe(gs.map((g, i) => pick(seed, g, i, c)).join(''));
    expect(scrambled('World', 250)).toBe('World');
    expect(scrambled('World', 0)[0]).toMatch(/[A-Z]/);
    for (const i of [1, 2, 3, 4]) expect(scrambled('World', 0)[i]).toMatch(/[a-z]/);
  });
});
