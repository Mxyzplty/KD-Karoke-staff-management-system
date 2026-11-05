// SPDX-License-Identifier: AGPL-3.0-only
// T10 W3-ED-09 on the real cards: every number slider of the 36 picker effects and of the Color card (Basic + Advanced) shows its
// registry default, clamps to its registry min / max for a drag past either end and for a typed +9999 / -9999 (stored value too);
// the 11 select lists carry the registry options in order; Curves values are per channel; the reset arrows restore new-instance
// values. The registry is the oracle (apps/web/src/effects/registry.ts, part 3 §46.9 / part 4 §49.1 labels).
import { test, expect, type Locator, type Page } from '@playwright/test';
import { clip, openEditor, richDoc, setViewState, skipTour } from './t02-support';
import { itemById, liveDoc, undoEntries } from './t03-support';
import { EFFECTS, effectById } from '../../apps/web/src/effects/registry';
import type { EffectDefinition, NumberParam, SelectParam } from '../../apps/web/src/effects/schema';

test.describe.configure({ mode: 'parallel' });
test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1400, height: 900 }); });

const BLOCK = ['color-wheels', 'curves', 'lut'];
const PICKER = EFFECTS.filter(e => e.visibility === 'discoverable' && !BLOCK.includes(e.id));
/** The labels that differ from the registry (part 3 §46.9); curves and hsl drop the channel / band prefix. */
const OVERRIDES: Record<string, Record<string, string>> = {
  'power-window': { sizeX: 'Width', sizeY: 'Height' }, 'lens-distortion': { mirrorEdges: 'Extend Edges' }, scanlines: { speed: 'Scroll Speed' },
  wave: { amplitudeX: 'Horizontal Amp', amplitudeY: 'Vertical Amp', frequencyX: 'Horizontal Freq', frequencyY: 'Vertical Freq' },
  'drop-shadow': { x: 'Offset X', y: 'Offset Y' }, ascii: { monoColor: 'Mono Color', bgColor: 'Background' },
  halftone: { colorFront: 'Front Color', colorBack: 'Back Color' }, 'luma-key': { keyType: 'Key Out' }, 'color-wheels': { hue: 'Hue Shift', colorBoost: 'Vibrance' },
};
const labelOf = (d: EffectDefinition, key: string) => {
  const p = d.params.find(x => x.key === key)!; return OVERRIDES[d.id]?.[key] ?? (d.id === 'curves' || d.id === 'hsl' ? p.label.replace(/^\S+ /, '') : p.label);
};
const numbers = (d: EffectDefinition) => d.params.filter((p): p is NumberParam => p.type === 'number' && !p.hidden);
const selects = (d: EffectDefinition) => d.params.filter((p): p is SelectParam => p.type === 'select' && !p.hidden);
const fresh = (p: NumberParam) => p.newInstance ?? p.default;

/** The cards of `itemId` with the playhead parked past clipA's end, where the paused stage does not draw clipA: no test here
 *  looks at the stage, and drawn on software GL a stack blocks the page per edit (halftone alone ~45 s per 1920 × 1080 frame
 *  on 2 CPUs; CI fix 1). */
async function openEffects(page: Page, itemId = 'clipA') {
  await openEditor(page, richDoc()); await setViewState(page, { playheadMs: 9000 }); await clip(page, itemId).click();
  const panel = page.getByRole('complementary', { name: 'Inspector and tools' }); await panel.getByRole('tab', { name: 'Effects' }).click(); return panel;
}
const agent = (page: Page, name: string, args: unknown) => page.evaluate(async ({ name, args }) => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); return activeRuntime.call(name, args); }, { name, args });
const fx = async (page: Page, itemId = 'clipA') => (itemById(await liveDoc(page), itemId).effects ?? []) as any[];
const param = (instance: any, key: string) => instance.parameters[key]?.defaultValue;
async function drag(page: Page, l: Locator, dx: number, moves = 3) {
  await l.evaluate(el => el.scrollIntoView({ block: 'center' })); const b = (await l.boundingBox())!; const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); for (let n = 1; n <= moves; n++) await page.mouse.move(Math.round(x + dx * n / moves), y); await page.mouse.up();
}
/** One slider: shown default, aria range, drag past both ends, typed +9999 / -9999. It ends at the minimum. */
async function exercise(page: Page, scope: Locator, label: string, p: NumberParam, shownDefault: number, where: string) {
  const track = scope.getByRole('slider', { name: label, exact: true }), field = scope.getByLabel(`${label} value`, { exact: true }); const at = (v: number) => expect(track, `${where} ${label} → ${v}`).toHaveAttribute('aria-valuenow', String(v));
  await track.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await expect(track, `${where} ${label} range`).toHaveAttribute('aria-valuemin', String(p.min)); await expect(track).toHaveAttribute('aria-valuemax', String(p.max)); await at(shownDefault);
  await drag(page, track, 2400); await at(p.max); await drag(page, track, -2400); await at(p.min);
  await track.focus(); await page.keyboard.press('Enter'); await field.fill('9999'); await field.press('Enter'); await at(p.max); // Enter opens the typed field, as a double-click does
  await track.focus(); await page.keyboard.press('Enter'); await field.fill('-9999'); await field.press('Enter'); await at(p.min);
}

// The 36 effects in eight parallel groups, each added through the agent path in one call (the playhead is parked: see openEffects).
const addAll = async (page: Page, ids: string[]) => {
  expect(await agent(page, 'writeEffects', { itemId: 'clipA', add: ids.map(effectId => ({ effectId })) })).toMatchObject({ success: true });
};
const BINS = 8, GROUPS = (() => { // greedy by slider count, so the parallel tests are about the same size
  const bins = Array.from({ length: BINS }, () => ({ size: 0, list: [] as EffectDefinition[] }));
  for (const d of [...PICKER].sort((a, b) => numbers(b).length - numbers(a).length)) { const bin = bins.reduce((m, b) => b.size < m.size ? b : m); bin.list.push(d); bin.size += numbers(d).length; }
  return bins.map(b => b.list.sort((x, y) => PICKER.indexOf(x) - PICKER.indexOf(y)));
})();
test('the picker lists exactly the 36 registry effects', () => { expect(PICKER).toHaveLength(36); expect(GROUPS.flat()).toHaveLength(36); });

for (const [g, group] of GROUPS.entries()) {
  test(`W3-ED-09 sliders and selects, group ${g + 1} of ${BINS}: ${group.map(d => d.id).join(', ')}`, async ({ page }) => {
    test.setTimeout(150000);
    const panel = await openEffects(page);
    await addAll(page, group.map(d => d.id));
    for (const d of group) {
      const card = panel.getByRole('region', { name: d.name, exact: true }); await expect(card, d.id).toBeVisible();
      const instance = (await card.getAttribute('data-instance'))!; const where = d.id;
      // selects: registry options in order, default selected
      for (const s of selects(d)) {
        const sel = card.locator(`select[aria-label="${labelOf(d, s.key)}"]`); await expect(sel, `${where} ${s.key}`).toHaveCount(1);
        expect(await sel.locator('option').evaluateAll(os => os.map(o => ({ value: (o as HTMLOptionElement).value, label: o.textContent }))), `${where} ${s.key} options`).toEqual(s.options.map(o => ({ value: o.value, label: o.label })));
        await expect(sel).toHaveValue(s.default);
      }
      // sliders: HSL bands and Curves channels are opened one by one; the others sit in the card
      const list = numbers(d);
      if (d.id === 'hsl') {
        const bands = [...new Set(list.map(p => p.group!))]; await expect(card.locator('details.band')).toHaveCount(bands.length);
        for (const [i, band] of bands.entries()) {
          const details = card.locator('details.band').nth(i); await details.locator('summary').click();
          for (const p of list.filter(x => x.group === band)) await exercise(page, details, labelOf(d, p.key), p, fresh(p), `${where}/${band}`);
        }
      } else {
        const labels = list.map(p => labelOf(d, p.key)); expect((await card.locator('.slider-label').allTextContents()).sort(), `${where} slider labels`).toEqual([...labels].sort());
        for (const p of list) await exercise(page, card, labelOf(d, p.key), p, fresh(p), where);
      }
      const stored = (await fx(page)).find(e => e.id === instance)!; expect(stored, `${where} stored`).toBeTruthy();
      for (const p of list) expect(param(stored, p.key), `${where} stored ${p.key}`).toBe(p.min);
    }
  });
}

test('W3-ED-09 the Color card: Basic + Advanced sliders show the registry defaults, clamp at both ends and store the clamped value', async ({ page }) => {
  test.setTimeout(150000);
  const panel = await openEffects(page); await addAll(page, ['color-wheels', 'curves']); // the card edits the first instances
  const card = panel.getByRole('region', { name: 'Color', exact: true }); const cw = effectById('color-wheels')!, curves = effectById('curves')!;
  const basic = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'colorBoost'].map(k => cw.params.find(p => p.key === k) as NumberParam);
  await expect(card.locator('.slider-label')).toHaveText(basic.map(p => labelOf(cw, p.key)));
  for (const p of basic) await exercise(page, card, labelOf(cw, p.key), p, p.default, 'Basic');
  await card.locator('details.advanced summary').click();
  const adv = ['lift', 'gamma', 'gain', 'offset', 'pivot', 'blackPoint', 'whitePoint', 'midDetail', 'shadows', 'highlights', 'hue', 'lumMix'].map(k => cw.params.find(p => p.key === k) as NumberParam);
  for (const p of adv) {
    const label = labelOf(cw, p.key); const digits = ['blackPoint', 'whitePoint', 'offset'].includes(p.key) ? 2 : undefined;
    if (digits) await expect(card.locator(`[data-slider="${label}"] .slider-value`)).toHaveText(p.default.toFixed(2)); // 0.00 / 1.00 though the step is 0.005 / 0.0025
    await exercise(page, card, label, p, p.default, 'Advanced');
  }
  for (const channel of ['Master', 'Red', 'Green', 'Blue']) {
    await card.getByRole('tab', { name: channel, exact: true }).click(); await expect(card.getByRole('tab', { name: channel, exact: true })).toHaveAttribute('aria-selected', 'true');
    for (const k of ['ShadowX', 'ShadowY', 'HighlightX', 'HighlightY']) {
      const p = curves.params.find(x => x.key === `${channel.toLowerCase()}${k}`) as NumberParam; const label = labelOf(curves, p.key);
      await expect(card.locator(`[data-slider="${label}"] .slider-value`)).toHaveText(p.default.toFixed(2));
      await exercise(page, card, label, p, p.default, `Curves ${channel}`);
    }
  }
  const [wheels] = (await fx(page)).filter(e => e.effectId === 'color-wheels'), [cv] = (await fx(page)).filter(e => e.effectId === 'curves');
  for (const p of [...basic, ...adv]) expect(param(wheels, p.key), `stored ${p.key}`).toBe(p.min);
  for (const ch of ['master', 'red', 'green', 'blue']) for (const k of ['ShadowX', 'ShadowY', 'HighlightX', 'HighlightY']) expect(param(cv, `${ch}${k}`), `stored ${ch}${k}`).toBe(0);
});

test('W3-ED-09 Curves values are per channel: editing Red Shadow X stores redShadowX only', async ({ page }) => {
  const panel = await openEffects(page); const card = panel.getByRole('region', { name: 'Color', exact: true }); await card.locator('details.advanced summary').click();
  const curves = effectById('curves')!; await card.getByRole('tab', { name: 'Red', exact: true }).click();
  const field = card.getByLabel('Shadow X value'), red = card.getByRole('slider', { name: 'Shadow X', exact: true });
  await red.dblclick(); await field.fill('0.4'); await field.press('Enter'); await expect(red).toHaveAttribute('aria-valuenow', '0.4');
  const [cv] = (await fx(page)).filter(e => e.effectId === 'curves'); expect(cv).toBeTruthy();
  for (const p of curves.params) { if (p.hidden || p.type === 'data') continue; const stored = param(cv, p.key); if (p.key === 'redShadowX') expect(stored).toBe(0.4); else if (stored !== undefined) expect(stored, p.key).toEqual(p.default); }
  expect(param(cv, 'masterShadowX')).not.toBe(0.4);
  await card.getByRole('tab', { name: 'Master', exact: true }).click(); await expect(card.getByRole('slider', { name: 'Shadow X', exact: true })).toHaveAttribute('aria-valuenow', '0.25');
  await card.getByRole('tab', { name: 'Green', exact: true }).click(); await expect(card.getByRole('slider', { name: 'Shadow X', exact: true })).toHaveAttribute('aria-valuenow', '0.25');
  await card.getByRole('tab', { name: 'Red', exact: true }).click(); await expect(card.getByRole('slider', { name: 'Shadow X', exact: true })).toHaveAttribute('aria-valuenow', '0.4');
  expect((await fx(page)).map(e => e.effectId)).toEqual(['curves']); // the first edit made the curves instance, not a color-wheels one
});

test('W3-ED-09 the reset arrows: Reset <effect> shows after an edit and restores the new-instance values; Reset Color clears the grade', async ({ page }) => {
  const panel = await openEffects(page);
  expect(await agent(page, 'writeEffects', { itemId: 'clipA', add: [{ effectId: 'vignette' }] })).toMatchObject({ success: true });
  const card = panel.getByRole('region', { name: 'Vignette', exact: true }), reset = card.getByRole('button', { name: 'Reset Vignette' }); const v = effectById('vignette')!;
  await expect(reset).toHaveCount(0);
  await card.getByRole('slider', { name: 'Amount', exact: true }).dblclick(); await card.getByLabel('Amount value').fill('90'); await card.getByLabel('Amount value').press('Enter');
  await card.getByRole('slider', { name: 'Feather', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(reset).toBeVisible(); const before = (await undoEntries(page)).length; await reset.click();
  await expect(reset).toHaveCount(0); expect((await undoEntries(page)).length).toBe(before + 1);
  for (const p of numbers(v)) await expect(card.getByRole('slider', { name: labelOf(v, p.key), exact: true })).toHaveAttribute('aria-valuenow', String(fresh(p)));
  const [stored] = await fx(page); for (const p of numbers(v)) expect(param(stored, p.key)).toBe(fresh(p));

  const color = panel.getByRole('region', { name: 'Color', exact: true }), resetColor = color.getByRole('button', { name: 'Reset Color' }); await expect(resetColor).toHaveCount(0);
  const contrast = color.getByRole('slider', { name: 'Contrast', exact: true }); await contrast.focus(); await page.keyboard.press('ArrowRight');
  await expect(resetColor).toBeVisible(); await expect(contrast).toHaveAttribute('aria-valuenow', '1.01');
  await resetColor.click(); await expect(resetColor).toHaveCount(0); await expect(contrast).toHaveAttribute('aria-valuenow', '1');
  expect((await fx(page)).map(e => e.effectId)).toEqual(['vignette']); // the grade's instances are gone, the other effect stays
});
