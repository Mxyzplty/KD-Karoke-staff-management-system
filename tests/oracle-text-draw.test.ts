// SPDX-License-Identifier: AGPL-3.0-only
// Text draws through the frame renderer: text-animation channels in the box transform (§53.4.2 step 6, §56.3);
// draws rasterised by deps.text through m at the final resolution and never resampled (§53.4.1, §53.4.5 quirk 4);
// overflow drawn on the direct path (§53.7.3); one fade and blend per draw call (step 9, §58.4); §56.6 / §57.2 states.
import { it, expect } from 'vitest';
import { apply, invert, type Item, type Project } from '../parity/oracle/item';
import { renderFrame, type Deps, type TextTarget } from '../parity/oracle/render';
import { createImage, type Image } from '../parity/oracle/image';

const props = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }]));
const item = (type: string, p: Record<string, any>, details: Record<string, any> = {}, extra: Partial<Item> = {}): Item =>
  ({ id: 't', type, trackId: 'O1', display: { from: 0, to: 10000 }, trim: { from: 0 }, properties: props(p), details, ...extra });
const text = (p: Record<string, any>, details: Record<string, any> = {}) => item('text', p, details);
const project = (w: number, h: number, items: Item[]): Project =>
  ({ size: { width: w, height: h }, fps: 30, tracks: [{ id: 'O1', kind: 'overlay' }], items, layerOrder: [{ type: 'track', id: 'O1' }], groups: {} });
const WHITE = [255, 255, 255], RED = [255, 0, 0], BLUE = [0, 0, 255];
// A stand-in rasteriser that honours the deps.text contract: box-local rects [x, y, w, h] in an RGB colour, mapped
// through target.m into target.size; coverage = n × n samples per target pixel.
function paint(at: TextTarget, rects: [number[], number[]][], n = 16): Image {
  const out = createImage(at.size.width, at.size.height), inv = invert(at.m);
  for (let py = 0; py < out.height; py++) for (let px = 0; px < out.width; px++) for (const [[x, y, w, h], c] of rects) {
    let hit = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const [u, v] = apply(inv, px + (i + .5) / n, py + (j + .5) / n); if (u >= x && u < x + w && v >= y && v < y + h) hit++; }
    if (hit) out.data.set([c[0] / 255, c[1] / 255, c[2] / 255, hit / (n * n)], (py * out.width + px) * 4);
  }
  return out;
}
const deps = (draw: (at: TextTarget) => Image[]): Deps => ({ effects: {}, cssFilters: {}, source: () => null, text: (_, at) => draw(at) });
const rgb = (img: Image, x: number, y: number) => [0, 1, 2].map(k => Math.round(img.data[(y * img.width + x) * 4 + k] * 255));
const red = (img: Image, x: number, y: number) => rgb(img, x, y)[0];
const lsb = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1); // §58.3 l.1493: ±1 LSB
const near = (actual: number, printed: string) => expect(Math.abs(actual - Number(printed)), `${actual} vs ${printed}`).toBeLessThanOrEqual(.5 * 10 ** -(printed.split('.')[1]?.length ?? 0) + 1e-12);

it('repro (a): pop at τ = 100 ms scales the 4 × 4 box about its centre and fades it', () => {
  // §56.5: q = 100/650; scale = 0.45 + 0.73·smooth(q/0.34) = 0.7631, opacity = 5q = 0.769 → 0.769 × 255 = 196.
  // Box half-size 2 × 0.7631 = 1.526 about (2, 2) → covers 0.474…3.526: the centre pixels are fully covered,
  // a corner pixel 0.277 of its area (the stub's 16 × 16 samples see 0.25), an edge pixel 0.526 (0.5).
  const f = renderFrame(project(4, 4, [text({ width: 4, height: 4 }, { textAnimation: { version: 1, preset: 'pop' } })]), 100, deps(at => [paint(at, [[[0, 0, 4, 4], WHITE]])]));
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) lsb(red(f, x, y), 196);
  const corners = [[0, 0], [3, 0], [0, 3], [3, 3]].map(([x, y]) => red(f, x, y));
  expect(new Set(corners).size).toBe(1); // symmetric about the box centre
  expect(corners[0]).toBeGreaterThan(0); expect(corners[0]).toBeLessThan(196 / 2); // partly uncovered
  for (const [x, y] of [[0, 1], [1, 0]]) { expect(red(f, x, y)).toBeGreaterThan(corners[0]); expect(red(f, x, y)).toBeLessThan(196); }
});

it('repro (b): line 2 of a 4 × 4 text box is drawn below the box on the direct path', () => {
  const f = renderFrame(project(4, 8, [text({ width: 4, height: 4 })]), 0, deps(at => [paint(at, [[[0, 0, 4, 4], RED], [[0, 4, 4, 4], BLUE]])]));
  expect([rgb(f, 1, 0), rgb(f, 1, 3), rgb(f, 1, 4), rgb(f, 1, 7)]).toEqual([RED, RED, BLUE, BLUE]);
});

it('repro (c): opacity 0.5, red stroke under white fill over black: each draw faded and blended on its own', () => {
  // §58.4 l.1507–1512: text without effects is not isolated; each draw blends on its own. §58.3 l.1492–1493: storage is
  // 8 bit per channel, results rounded, ±1 LSB. Stroke: 0.5 × 255 = 127.5 → 128. Fill: G = B = 127.5 → 128;
  // R = 127.5 + 0.5 × 128 = 191.5 → 192 (191.25 unquantised). As a group the pixel would be 128.
  const f = renderFrame(project(1, 1, [text({ width: 1, height: 1, opacity: 0.5 })]), 0, deps(at => [paint(at, [[[0, 0, 1, 1], RED]]), paint(at, [[[0, 0, 1, 1], WHITE]])]));
  const [r, g, b] = rgb(f, 0, 0);
  lsb(r, 192); lsb(g, 128); lsb(b, 128);
});

it('speedy at τ = 100 ms: translate and the horizontal skew feed the box transform', () => {
  // §56.5: tx 0.5544, r −0.7479°, σ −14.5043°, o 6q = 0.769 → 196. A 20 × 20 box at (0, 0) moves 0.5544 × 20 = 11.09 px
  // right: centre (21.09, 10). §53.2.2: a′ = a + tan σ · b, tan σ = −0.2587, so the top leans right, the bottom left.
  // By hand (rotation included), at the row centres: row 1 spans x 13.20…33.14, row 18 x 9.04…28.97 (each ±0.13 across the row).
  const f = renderFrame(project(40, 20, [text({ width: 20, height: 20 }, { textAnimation: { version: 1, preset: 'speedy' } })]), 100, deps(at => [paint(at, [[[0, 0, 20, 20], WHITE]])]));
  expect([red(f, 11, 1), red(f, 30, 18), red(f, 2, 10)]).toEqual([0, 0, 0]);
  lsb(red(f, 31, 1), 196); lsb(red(f, 11, 18), 196);
});

it('jump at τ = 168 ms: the rotation channel turns the box (r −8°, ty −0.15, k 1.03, o 1)', () => {
  // Box 40 × 10 at (10, 10): x 10 − 0.6, y 10 − 0.15 − 1.5, scale 1.03 → centre (30, 13.5), half-size 20.6 × 5.15, θ −8°.
  // By hand: column 47 spans y 5.77…16.31 (edges 5.77–5.91 and 16.17–16.31 across it), column 12 y 10.69…21.23.
  // Without the rotation every column spans y 8.35…18.65.
  const f = renderFrame(project(60, 30, [text({ positionX: 10, positionY: 10, width: 40, height: 10 }, { textAnimation: { version: 1, preset: 'jump' } })]), 168, deps(at => [paint(at, [[[0, 0, 40, 10], WHITE]])]));
  expect([red(f, 47, 6), red(f, 47, 17), red(f, 12, 9), red(f, 12, 20)]).toEqual([255, 0, 0, 255]);
});

it('P1-B: a 1-px glyph in a 4 × 4 project exported at 8 × 8 is a sharp 2 × 2 block (no resampling)', () => {
  const f = renderFrame(project(4, 4, [text({ width: 4, height: 4 })]), 0, deps(at => [paint(at, [[[1, 1, 1, 1], WHITE]])]), { width: 8, height: 8 });
  expect([[2, 2], [3, 2], [2, 3], [3, 3]].map(([x, y]) => red(f, x, y))).toEqual([255, 255, 255, 255]);
  expect([[1, 2], [4, 2], [2, 1], [2, 4], [1, 1], [4, 4]].map(([x, y]) => red(f, x, y))).toEqual([0, 0, 0, 0, 0, 0]);
});

it('P2-A: deps.text receives the §56.6 grapheme states and §57.2 word states at item-local τ', () => {
  // Item at display 2000 with trim 1000: τ = t − 2000 (trim ignored, §56.1 / §57.1).
  const states = (type: string, details: Record<string, any>, tau: number): TextTarget => {
    const seen: TextTarget[] = [];
    renderFrame(project(4, 4, [item(type, { width: 4, height: 4 }, details, { display: { from: 2000, to: 9000 }, trim: { from: 1000 } })]), 2000 + tau, deps(at => { seen.push(at); return []; }));
    return seen[0];
  };
  const typewriter = { text: 'World', textAnimation: { version: 1, preset: 'typewriter', speed: 2 } };
  const shown = [0, 33, 67, 100, 133, 167, 200].map(t => states('text', typewriter, t).graphemes!.filter(g => g.visible).map(g => g.grapheme).join(''));
  expect(shown).toEqual(['', '', 'W', 'Wo', 'Wor', 'Worl', 'World']);
  const scramble = (details: Record<string, any>, c: number) => states(details.words ? 'caption' : 'text', { ...details, textAnimation: { version: 1, preset: 'scramble' } }, c).graphemes!.map(g => g.shown).join('');
  expect([0, 45, 100, 250].map(c => scramble({ text: 'World' }, c))).toEqual(['Ipcrq', 'Rsnkh', 'Woihi', 'World']);
  expect(scramble({ words: [{ text: 'Hi', startMs: 0, endMs: 500 }, { text: '42', startMs: 500, endMs: 900 }] }, 0)).toBe('Do 47'); // words joined by single spaces
  const fade = states('text', { text: 'World', textAnimation: { version: 1, preset: 'step-fade' } }, 100).graphemes!;
  near(fade[0].opacity, '0.8015'); near(fade[0].drop, '0.0437'); near(fade[1].opacity, '0.4636'); near(fade[1].drop, '0.1180');
  for (const g of fade.slice(2)) { near(g.opacity, '0'); near(g.drop, '0.22'); }
  expect(states('text', { text: 'World', textAnimation: { version: 1, preset: 'pop' } }, 100).graphemes).toBeNull();
  // §57.2, word [500, 900) with the defaults.
  const word = (renderMode: string, tau: number) => states('caption', { words: [{ text: 'word', startMs: 500, endMs: 900 }], renderMode }, tau).words![0];
  const up = word('slide-up', 530); near(up.opacity, '0.3859'); near(up.dy, '12.28');
  near(word('word-by-word', 530).opacity, '0.55');
  expect([word('highlight', 500).color, word('highlight', 500).scale, word('highlight', 900).color]).toEqual(['#FFD700', 1.05, null]);
  expect(states('caption', { text: 'no words' }, 0).words).toBeNull();
});

it('P2-A: with a deps.text that honours the states, typewriter at t = 0 draws nothing', () => {
  // One 1 × 1 block per visible grapheme at its place in the full-text layout (x = grapheme index).
  const T = text({ width: 5, height: 1 }, { text: 'World', textAnimation: { version: 1, preset: 'typewriter', speed: 2 } });
  const d = deps(at => [paint(at, at.graphemes!.map((g, i): [number[], number[]] | null => g.visible ? [[i, 0, 1, 1], WHITE] : null).filter((r): r is [number[], number[]] => r !== null), 1)]);
  const at0 = renderFrame(project(5, 1, [T]), 0, d), at200 = renderFrame(project(5, 1, [T]), 200, d);
  expect([0, 1, 2, 3, 4].map(x => red(at0, x, 0))).toEqual([0, 0, 0, 0, 0]);
  expect([0, 1, 2, 3, 4].map(x => red(at200, x, 0))).toEqual([255, 255, 255, 255, 255]);
});

it('textAnimation on a motionGraphic throws, as on the other non-text types (§56.1)', () => {
  const mg = item('motionGraphic', {}, { textAnimation: { version: 1, preset: 'pop' } });
  expect(() => renderFrame(project(4, 4, [mg]), 100, { ...deps(() => []), source: () => createImage(4, 4) })).toThrow('textAnimation is defined for text and caption items only');
});
