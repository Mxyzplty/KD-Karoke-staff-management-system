// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the T04 browser specs (inspector, graph editor, remap cache, UI ↔ tool parity). Written-spec tests: expected values
// come from findings part 3 §46.6 / §46.10 / §46.11 and the T04 ticket, never from the product code.
import { expect, type Locator, type Page } from '@playwright/test';
import { clip, setViewState } from './t02-support';

export const panel = (page: Page) => page.getByRole('complementary', { name: 'Inspector and tools' });

/** Fixture: video `vid` on the timeline at 1–5 s (trim 0–4 s of a 10 s source), image `img`, motion graphic `mg`, audio `aud`. fps 30, canvas 1920×1080. */
export function t04Doc(patch: { vid?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  const track = (id: string, name: string, kind: string) => ({ id, name, kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
  const tracks = [track('a1', 'A1', 'audio'), track('v1', 'V1', 'video'), track('o1', 'O1', 'overlay'), track('o2', 'O2', 'overlay')];
  return {
    schemaVersion: 4, rev: 0, groups: {}, duration: 6000, fps: 30, size: { width: 1920, height: 1080 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })),
    items: [
      { id: 'vid', type: 'video', trackId: 'v1', display: { from: 1000, to: 5000 }, trim: { from: 0, to: 4000 }, sourceDuration: 10000, details: { name: 'Vid' }, ...patch.vid },
      { id: 'img', type: 'image', trackId: 'o1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, details: { name: 'Img' } },
      { id: 'mg', type: 'motionGraphic', trackId: 'o2', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, details: { name: 'Mg' } },
      { id: 'aud', type: 'audio', trackId: 'a1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 8000, details: { name: 'Aud' } },
    ],
    ...patch.extra,
  };
}
export const kf = (id: string, time: number, value: unknown, easing: unknown = 'linear', extra: Record<string, unknown> = {}) => ({ id, time, value, easing, ...extra });
export const prop = (defaultValue: unknown, keyframes: unknown[] = []) => ({ defaultValue, keyframes });

/** Clicks a clip so the inspector shows it. */
export async function pick(page: Page, id: string) { await clip(page, id).click(); await expect(panel(page).getByRole('heading').first()).toBeVisible(); }
/** The inspector section `<details>` with that summary, expanded. */
export async function section(page: Page, title: string): Promise<Locator> {
  const d = panel(page).locator('details.inspector-section').filter({ has: page.locator('summary').filter({ hasText: new RegExp(`^${title.replace(/[&]/g, '\\$&')}$`) }) });
  await expect(d).toHaveCount(1);
  if (!(await d.evaluate((e: HTMLDetailsElement) => e.open))) await d.locator('summary').click();
  return d;
}
export const sliderIn = (scope: Locator, name: string) => scope.getByRole('slider', { name, exact: true });
export const rowOf = (scope: Locator, name: string) => scope.locator(`[data-slider="${name}"]`);
/** Double-click the value, type, Enter (the typed path of a slider row, §46.6 / W3-ED-24). */
export async function typeValue(scope: Locator, name: string, text: string) {
  const row = rowOf(scope, name); await row.locator('.slider-value').dblclick();
  const input = row.getByLabel(`${name} value`); await input.fill(text); await input.press('Enter');
}
/** A relative pointer drag on a slider track, `dx` CSS px in `steps` moves (a plain drag; mouse events carry pointer ids). */
export async function dragSlider(page: Page, scope: Locator, name: string, dx: number, steps = 4) {
  const box = (await sliderIn(scope, name).boundingBox())!, y = box.y + box.height / 2, x0 = box.x + box.width / 2;
  await page.mouse.move(x0, y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + (dx * i) / steps, y);
  await page.mouse.up();
}
export const valueNow = async (scope: Locator, name: string) => Number(await sliderIn(scope, name).getAttribute('aria-valuenow'));

/** Runtime access in the page. */
export const runtimeCall = (page: Page, tool: string, args: Record<string, unknown>) => page.evaluate(async ({ tool, args }) => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); return activeRuntime.call(tool, args); }, { tool, args });
export const runtimeHandle = (page: Page, intent: Record<string, unknown>) => page.evaluate(async intent => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); return activeRuntime.handle(intent); }, intent);
export const setBusOption = (page: Page, patch: Record<string, unknown>) => page.evaluate(async patch => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); Object.assign(activeRuntime.bus.options, patch); }, patch);
export const playhead = (page: Page, ms: number) => setViewState(page, { playheadMs: ms });
export const props = async (page: Page, id: string, doc: () => Promise<any>) => (await doc()).items.find((i: any) => i.id === id);

/** Walks a document and renames every keyframe id that was not in `known` to `kf#<order of appearance>` (ids are random per session); rev zeroed. */
export function normal(doc: any, known: Set<string>) {
  const map = new Map<string, string>(); const walk = (v: any, key?: string): any => {
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'id' && typeof x === 'string' && key === 'kf' ? rename(x) : walk(x, k === 'keyframes' ? 'kf' : undefined)]));
    return v;
  };
  const rename = (id: string) => known.has(id) ? id : map.get(id) ?? (map.set(id, `kf#${map.size + 1}`), map.get(id)!);
  const out = walk(doc); out.rev = 0; return out;
}
export const keyframeIds = (doc: any): Set<string> => {
  const ids = new Set<string>(); for (const i of doc.items) { for (const p of Object.values<any>(i.properties ?? {})) for (const k of p?.keyframes ?? []) ids.add(k.id); for (const k of i.timeRemap?.keyframes ?? []) ids.add(k.id); }
  return ids;
};

/** Graph editor pointer helpers. */
/** Screen point a fraction of the way along the curve's hit path (a point certain to be on the stroke), then a real double-click there. */
export const dblclickOnCurve = async (page: Page, curve: Locator, frac: number) => {
  const pt = await curve.evaluate((el: SVGPathElement, f) => { const p = el.getPointAtLength(el.getTotalLength() * f), m = el.getScreenCTM()!; return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }; }, frac);
  await page.mouse.dblclick(pt.x, pt.y);
};
export const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
export async function dragTo(page: Page, from: { x: number; y: number }, dx: number, dy: number, steps = 5) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
  await page.mouse.up();
}
