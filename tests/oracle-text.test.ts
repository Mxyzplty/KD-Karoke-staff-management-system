// SPDX-License-Identifier: AGPL-3.0-only
// Findings part 5 §56 test values, computed through the oracle. Tolerance: half a unit of the last printed digit;
// a value printed as an integer (key values, holds, "exactly") is compared exactly, up to float noise (1e-9).
import { it, expect } from 'vitest';
import { textChannels, animationClock, graphemeStates, scrambleSeed, type TextAnimation } from '../parity/oracle/text';

const near = (actual: number, printed: string) => { const d = printed.split('.')[1]?.length; expect(Math.abs(actual - Number(printed)), `${actual} vs ${printed}`).toBeLessThanOrEqual(d === undefined ? 1e-9 : .5 * 10 ** -d + 1e-12); };
const anim = (preset: string, speed?: number): TextAnimation => ({ version: 1, preset, ...(speed === undefined ? {} : { speed }) });
const at = (preset: string, t: number, speed?: number) => textChannels(anim(preset, speed), t);
const exact = (actual: number, value: number) => expect(Math.abs(actual - value), `${actual} vs ${value}`).toBeLessThanOrEqual(1e-9); // up to float noise

it('§56 text animation test values', () => {
  near(at('pop', 100).scale, '0.7631'); near(at('pop', 100).opacity, '0.769');
  near(at('pop', 221).scale, '1.1800'); near(at('pop', 325).scale, '0.9381');
  near(at('pop', 67, 2).scale, '0.9297'); near(at('pop', 100, 2).scale, '1.1615'); near(at('pop', 133, 2).scale, '1.1053');
  exact(at('jump', 168).ty, -0.15); exact(at('jump', 168).rotation, -8); exact(at('jump', 168).scale, 1.03); // "exactly" (§56.5 l.1293)
  near(at('jump', 350).ty, '-0.2469'); near(at('jump', 350).rotation, '5.4375'); near(at('jump', 350).scale, '0.9983');
  near(at('fade', 100).opacity, '0.5781'); near(at('fade', 200).opacity, '0.8750');
  near(at('zoom', 112.5).scale, '0.8523'); near(at('zoom', 112.5).opacity, '0.5'); near(at('zoom', 225).scale, '0.9563'); near(at('zoom', 225).opacity, '1');
  const flicker = [.10, .15, .25, .50, .65, .80, .90].map(q => at('flicker', q * 650).opacity), printed = ['0', '0.72', '0.08', '0.18', '0.42', '0.68', '1'];
  flicker.forEach((o, i) => near(o, printed[i]));
  const l144 = at('loud', 144); near(l144.scale, '1.30'); near(l144.tx, '0'); near(l144.rotation, '0'); near(l144.ty, '0.0056');
  const l302 = at('loud', 302.4); near(l302.tx, '-0.035'); near(l302.ty, '0.012'); near(l302.rotation, '-4'); near(l302.scale, '1.1294');
  near(at('fall', 200).ty, '-0.1670'); near(at('fall', 200).scale, '0.9757'); near(at('fall', 349.6).ty, '0.10'); near(at('fall', 349.6).scale, '0.96');
  const s100 = at('speedy', 100); near(s100.tx, '0.5544'); near(s100.rotation, '-0.7479'); near(s100.skew, '-14.5043'); near(s100.opacity, '0.769');
  const s335 = at('speedy', 335.4); near(s335.tx, '-0.055'); near(s335.rotation, '-3.5'); near(s335.skew, '-9');
  near(at('stamped', 100).scale, '1.8309'); near(at('stamped', 218.4).scale, '0.84');
  near(at('slide-right', 125).tx, '-0.1477'); near(at('slide-right', 125).opacity, '0.5'); near(at('slide-right', 250).tx, '-0.0437'); near(at('slide-right', 250).opacity, '1');
});

it('§56.2 override example (durationMs 1000 at speed 2 → 500 ms real)', () => {
  expect(animationClock({ version: 1, preset: 'pop', speed: 2, durationMs: 1000 }, 0).realMs).toBe(500);
  expect(animationClock({ version: 1, preset: 'step-fade' }, 0, 5).T).toBe(460);
});

it('§56.6 typewriter test values ("World", speed 2)', () => {
  const shown = (t: number) => graphemeStates(anim('typewriter', 2), 'World', t).filter(s => s.visible).map(s => s.grapheme).join('');
  expect([0, 33, 67, 100, 133, 167, 200, 400].map(shown)).toEqual(['', '', 'W', 'Wo', 'Wor', 'Worl', 'World', 'World']);
});

it('§56.6 scramble test vectors', () => {
  expect(scrambleSeed('World')).toBe(-580850381);
  const shown = (text: string, c: number) => graphemeStates(anim('scramble'), text, c).map(s => s.shown).join('');
  expect([0, 30, 45, 100, 200, 249, 250, 400].map(c => shown('World', c))).toEqual(['Ipcrq', 'Ipcrq', 'Rsnkh', 'Woihi', 'Worlw', 'Worlh', 'World', 'World']);
  expect([shown('Hi 42', 0), shown('Hi 42', 45)]).toEqual(['Do 47', 'En 76']);
});

it('§56.6 step-fade test values ("World", t 100)', () => {
  const s = graphemeStates(anim('step-fade'), 'World', 100);
  near(s[0].opacity, '0.8015'); near(s[0].drop, '0.0437'); near(s[1].opacity, '0.4636'); near(s[1].drop, '0.1180');
  for (const g of s.slice(2)) { near(g.opacity, '0'); near(g.drop, '0.22'); }
});
