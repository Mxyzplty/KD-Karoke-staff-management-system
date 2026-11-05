// SPDX-License-Identifier: AGPL-3.0-only
// T04 inspector property sheets in real Chromium (written-spec oracle: findings part 3 §46.6 sheet table l.383–391, §46.10 keyframe row,
// §46.11 speed & time remap, §45.1 undo labels; T04 ticket batch-2b brief). The intent names and undo labels come from the brief:
//   changeSpeed "Change speed" · toggleTimeRemap / addKeyframe / editKeyframe / deleteKeyframe / editProperty "Edit items".
// Items marked "provisional choice, not Xapp parity" pin Cutframe's own choice where the docs are silent.
import { test, expect } from '@playwright/test';
import { clearIntents, expectUntouched, intents, openEditor, setViewState, skipTour, stored, watchIntents } from './t02-support';
import { liveDoc, undoLabels } from './t03-support';
import { dragSlider, kf, panel, pick, playhead, prop, section, setBusOption, sliderIn, t04Doc, typeValue, valueNow } from './t04-support';

test.beforeEach(async ({ page }) => { await skipTour(page); });
const itemOf = (doc: any, id: string) => doc.items.find((i: any) => i.id === id);
const last = async (page: any) => { const log = await intents(page); return log[log.length - 1]; };

test.describe('sheet structure and accessible names (§46.6 l.383–391)', () => {
  test('video: section order and the sliders of each section by accessible name', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid');
    const titles = await panel(page).locator('details.inspector-section > summary').allTextContents();
    expect(titles).toEqual(['Basic', 'Speed & Time Remap', 'Transform', 'Appearance', 'Mask', 'Shadow']);
    const basic = await section(page, 'Basic'); for (const n of ['Opacity', 'Volume']) await expect(sliderIn(basic, n)).toBeVisible();
    await expect(sliderIn(basic, 'Bright')).toHaveCount(0);
    const speed = await section(page, 'Speed & Time Remap'); await expect(sliderIn(speed, 'Speed')).toBeVisible();
    const tf = await section(page, 'Transform'); for (const n of ['Scale', 'Rotation', 'X', 'Y']) await expect(sliderIn(tf, n)).toBeVisible();
    const ap = await section(page, 'Appearance'); for (const n of ['Radius', 'Outline Size']) await expect(sliderIn(ap, n)).toBeVisible();
    const sh = await section(page, 'Shadow'); for (const n of ['X', 'Y', 'Blur']) await expect(sliderIn(sh, n)).toBeVisible();
  });
  test('slider ranges: Opacity 0–100 %, Volume 0–300 % (§46.6), Speed 0.1–4 (§46.11); Scale 0–500 % is provisional choice, not Xapp parity', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid');
    const basic = await section(page, 'Basic'), speed = await section(page, 'Speed & Time Remap'), tf = await section(page, 'Transform');
    const range = async (s: any, n: string) => [Number(await sliderIn(s, n).getAttribute('aria-valuemin')), Number(await sliderIn(s, n).getAttribute('aria-valuemax'))];
    expect(await range(basic, 'Opacity')).toEqual([0, 100]); expect(await range(basic, 'Volume')).toEqual([0, 300]); expect(await range(speed, 'Speed')).toEqual([0.1, 4]);
    expect(await range(tf, 'Scale')).toEqual([0, 500]);
    expect(await valueNow(basic, 'Opacity')).toBe(100); expect(await valueNow(basic, 'Volume')).toBe(100); expect(await valueNow(speed, 'Speed')).toBe(1);
  });
  test('motion graphic: Basic has Opacity and Bright (0–200); Transform has Scale, X, Y, Flip and no Rotation (§46.6 l.389)', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'mg');
    const basic = await section(page, 'Basic'); await expect(sliderIn(basic, 'Opacity')).toBeVisible(); await expect(sliderIn(basic, 'Bright')).toBeVisible();
    expect(await valueNow(basic, 'Bright')).toBe(100); expect(await sliderIn(basic, 'Bright').getAttribute('aria-valuemax')).toBe('200');
    const tf = await section(page, 'Transform'); for (const n of ['Scale', 'X', 'Y']) await expect(sliderIn(tf, n)).toBeVisible();
    await expect(sliderIn(tf, 'Rotation')).toHaveCount(0); await expect(tf.getByRole('button', { name: 'Flip X' })).toBeVisible();
    expect(await panel(page).locator('details.inspector-section > summary').allTextContents()).toEqual(['Basic', 'Transform']);
  });
  test('audio: only the Speed and Volume sections, no time-remap UI (§46.6 Audio row)', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'aud');
    expect(await panel(page).locator('details.inspector-section > summary').allTextContents()).toEqual(['Speed', 'Volume']);
    const speed = await section(page, 'Speed'); await expect(sliderIn(speed, 'Speed')).toBeVisible();
    await expect(panel(page).getByRole('switch', { name: 'Time Remap' })).toHaveCount(0);
    const vol = await section(page, 'Volume'); await expect(sliderIn(vol, 'Volume')).toBeVisible();
  });
  test('Basic: Lock Ratio group with Yes / No is view-only; Blend Mode lists the 16 modes in Title Case, in the documented order', async ({ page }) => {
    const id = await openEditor(page, t04Doc()); await pick(page, 'vid'); const before = await stored(page, id), basic = await section(page, 'Basic');
    const lock = basic.getByRole('group', { name: 'Lock Ratio' });
    await expect(lock.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true');
    await lock.getByRole('button', { name: 'No' }).click(); await expect(lock.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true');
    await expect(lock.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'false');
    expect(await undoLabels(page)).toEqual([]); await expectUntouched(page, id, before);
    const options = await basic.getByLabel('Blend Mode', { exact: true }).locator('option').allTextContents();
    expect(options).toEqual(['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'Color Dodge', 'Color Burn', 'Hard Light', 'Soft Light', 'Difference', 'Exclusion', 'Hue', 'Saturation', 'Color', 'Luminosity']);
  });
  test('Use Proxy switch stores details.useProxy (T15): one "Edit items" entry', async ({ page }) => {
    const id = await openEditor(page, t04Doc()); await pick(page, 'vid'); await watchIntents(page); const before = await stored(page, id);
    const basic = await section(page, 'Basic'); await basic.getByRole('switch', { name: 'Use Proxy' }).click();
    expect((await last(page))).toMatchObject({ intent: { type: 'setUseProxy', itemId: 'vid', on: false }, outcome: { ok: true } }); // T15 (was: NOT_IMPLEMENTED, owner T15)
    expect(itemOf(await liveDoc(page), 'vid').details.useProxy).toBe(false); expect(await undoLabels(page)).toEqual(['Edit items']);
    await expect.poll(async () => { const s = await stored(page, id); return s.rev > before.rev ? itemOf(JSON.parse(s.json), 'vid').details.useProxy : 'not saved'; }).toBe(false); // T15 (was: notice "Use Proxy is not yet implemented (T15)." and expectUntouched)
  });
});

test.describe('dispatch and undo labels (brief §1)', () => {
  test('Blend Mode "Color Dodge" stores color-dodge: editProperty, one "Edit items" entry', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); await watchIntents(page); const basic = await section(page, 'Basic');
    await basic.getByLabel('Blend Mode', { exact: true }).selectOption({ label: 'Color Dodge' });
    expect(await undoLabels(page)).toEqual(['Edit items']); expect((await last(page)).intent).toMatchObject({ type: 'editProperty', owner: 'T04', key: 'blendMode', itemIds: ['vid'] });
    expect(itemOf(await liveDoc(page), 'vid').properties.blendMode.defaultValue).toBe('color-dodge');
    await expect(basic.getByLabel('Blend Mode', { exact: true })).toHaveValue('color-dodge');
  });
  test('Flip X toggles with aria-pressed and stores flipX; a second press clears it', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); const tf = await section(page, 'Transform'), flip = tf.getByRole('group', { name: 'Flip' }).getByRole('button', { name: 'Flip X' });
    await expect(flip).toHaveAttribute('aria-pressed', 'false'); await flip.click(); await expect(flip).toHaveAttribute('aria-pressed', 'true');
    expect(itemOf(await liveDoc(page), 'vid').properties.flipX.defaultValue).toBe(true); expect(await undoLabels(page)).toEqual(['Edit items']);
    await flip.click(); await expect(flip).toHaveAttribute('aria-pressed', 'false'); expect(itemOf(await liveDoc(page), 'vid').properties.flipX.defaultValue).toBe(false);
    await expect(tf.getByRole('button', { name: 'Flip Y' })).toHaveAttribute('aria-pressed', 'false');
  });
  test('Opacity typed 50 with no keyframes: editProperty on the property value (stored 0.5), "Edit items"', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); await watchIntents(page); const basic = await section(page, 'Basic');
    await typeValue(basic, 'Opacity', '50');
    expect((await last(page)).intent).toMatchObject({ type: 'editProperty', key: 'opacity', value: 0.5, label: 'Opacity' });
    const p = itemOf(await liveDoc(page), 'vid').properties.opacity; expect(p.defaultValue).toBe(0.5); expect(p.keyframes).toEqual([]);
    expect(await undoLabels(page)).toEqual(['Edit items']); expect(await valueNow(basic, 'Opacity')).toBe(50);
  });
  test('Speed 2×: changeSpeed {rate 2, ripple false}, "Change speed"; in ripple tool mode ripple is true', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); await watchIntents(page); const speed = await section(page, 'Speed & Time Remap');
    await typeValue(speed, 'Speed', '2');
    expect((await last(page)).intent).toMatchObject({ type: 'changeSpeed', itemId: 'vid', rate: 2, ripple: false });
    expect(await undoLabels(page)).toEqual(['Change speed']); expect(itemOf(await liveDoc(page), 'vid').playbackRate).toBe(2);
    await setViewState(page, { toolMode: 'ripple' }); await typeValue(speed, 'Speed', '3');
    expect((await last(page)).intent).toMatchObject({ type: 'changeSpeed', itemId: 'vid', rate: 3, ripple: true }); expect(await undoLabels(page)).toEqual(['Change speed', 'Change speed']);
  });
  // Wave-3 runtime fixtures (1) and (2), ticket T04, findings part 3 §45.5: the typed Speed field end to end on V1 = 0–20 | 20–50 | 50–90 s.
  // Written-spec oracle: ripple off changes only the clip's rate (display span and trim as stated by the ticket); ripple on stretches the clip to 40 s and shifts later clips by +20 s.
  const speedTrack = () => {
    const v = (id: string, from: number, to: number, trimTo: number) => ({ id, type: 'video', trackId: 'v1', display: { from, to }, trim: { from: 0, to: trimTo }, sourceDuration: 60000, details: { name: id.toUpperCase() } });
    return t04Doc({ extra: { duration: 120000, items: [v('c1', 0, 20000, 19999.78), v('c2', 20000, 50000, 30000), v('c3', 50000, 90000, 40000)] } });
  };
  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(1);
  test('wave-3 fixture (1): typed Speed 0.5 with ripple off: changeSpeed {rate 0.5, ripple false}, "Change speed", clip 1 rate 0.5 over 0–20 s, trim unchanged, clips 2 and 3 untouched', async ({ page }) => {
    await openEditor(page, speedTrack()); await pick(page, 'c1'); await watchIntents(page); const before = await liveDoc(page); const speed = await section(page, 'Speed & Time Remap');
    await typeValue(speed, 'Speed', '0.5');
    expect((await last(page)).intent).toMatchObject({ type: 'changeSpeed', itemId: 'c1', rate: 0.5, ripple: false }); expect(await undoLabels(page)).toEqual(['Change speed']);
    const doc = await liveDoc(page), c1 = itemOf(doc, 'c1');
    expect(c1.playbackRate).toBe(0.5); near(c1.display.from, 0); near(c1.display.to, 20000); expect(c1.trim).toEqual({ from: 0, to: 19999.78 });
    expect(itemOf(doc, 'c2')).toEqual(itemOf(before, 'c2')); expect(itemOf(doc, 'c3')).toEqual(itemOf(before, 'c3'));
  });
  test('wave-3 fixture (2): typed Speed 0.5 in the ripple tool: clip 1 is 0–40 s, clips 2 and 3 move to 40–70 s and 70–110 s, one "Change speed" entry', async ({ page }) => {
    await openEditor(page, speedTrack()); await pick(page, 'c1'); await watchIntents(page); await setViewState(page, { toolMode: 'ripple' }); const speed = await section(page, 'Speed & Time Remap');
    await typeValue(speed, 'Speed', '0.5');
    expect((await last(page)).intent).toMatchObject({ type: 'changeSpeed', itemId: 'c1', rate: 0.5, ripple: true }); expect(await undoLabels(page)).toEqual(['Change speed']);
    const doc = await liveDoc(page), c1 = itemOf(doc, 'c1'), c2 = itemOf(doc, 'c2'), c3 = itemOf(doc, 'c3');
    expect(c1.playbackRate).toBe(0.5); near(c1.display.from, 0); near(c1.display.to, 40000);
    near(c2.display.from, 40000); near(c2.display.to, 70000); near(c3.display.from, 70000); near(c3.display.to, 110000);
  });
  test('Time Remap switch on then off: toggleTimeRemap, "Edit items"; Speed is aria-disabled while on and returns with its previous value', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); await watchIntents(page); const speed = await section(page, 'Speed & Time Remap');
    await typeValue(speed, 'Speed', '2'); await clearIntents(page);
    const sw = speed.getByRole('switch', { name: 'Time Remap' }); await expect(sw).toHaveAttribute('aria-checked', 'false'); await sw.click();
    expect((await last(page)).intent).toEqual({ type: 'toggleTimeRemap', itemId: 'vid', on: true });
    await expect(sw).toHaveAttribute('aria-checked', 'true'); await expect(sliderIn(speed, 'Speed')).toHaveAttribute('aria-disabled', 'true');
    expect(await undoLabels(page)).toEqual(['Change speed', 'Edit items']);
    const remap = itemOf(await liveDoc(page), 'vid').timeRemap; expect(remap.keyframes).toHaveLength(2);
    expect(remap.keyframes.map((k: any) => [k.time, k.value])).toEqual([[0, 0], [2000, 4000]]); // 0 s → source start, clip end → source end (rate 2: 4 s of timeline = 8 s of source; trim 0–4 s)
    await sw.click(); expect((await last(page)).intent).toEqual({ type: 'toggleTimeRemap', itemId: 'vid', on: false });
    await expect(sliderIn(speed, 'Speed')).not.toHaveAttribute('aria-disabled', 'true'); expect(await valueNow(speed, 'Speed')).toBe(2);
    const doc = itemOf(await liveDoc(page), 'vid'); expect(doc.timeRemap ?? null).toBeNull(); expect(doc.playbackRate).toBe(2); expect(await undoLabels(page)).toEqual(['Change speed', 'Edit items', 'Edit items']);
  });
  test('Shadow colour, X and Blur merge into boxShadow and keep the other fields (editProperty, "Edit items")', async ({ page }) => {
    const shadow = { color: '#112233', x: 1, y: 2, blur: 3 };
    await openEditor(page, t04Doc({ vid: { properties: { boxShadow: prop(shadow) } } })); await pick(page, 'vid'); await watchIntents(page); const sh = await section(page, 'Shadow');
    await typeValue(sh, 'X', '7'); expect(itemOf(await liveDoc(page), 'vid').properties.boxShadow.defaultValue).toEqual({ ...shadow, x: 7 });
    await typeValue(sh, 'Blur', '9'); expect(itemOf(await liveDoc(page), 'vid').properties.boxShadow.defaultValue).toEqual({ ...shadow, x: 7, blur: 9 });
    await sh.getByRole('button', { name: /^Shadow colour:/ }).click(); await page.getByLabel('Hex', { exact: true }).fill('445566'); await page.getByLabel('Hex', { exact: true }).press('Enter');
    const v = itemOf(await liveDoc(page), 'vid').properties.boxShadow.defaultValue; expect(v).toMatchObject({ x: 7, y: 2, blur: 9 }); expect(String(v.color).toLowerCase()).toBe('#445566');
    expect(await undoLabels(page)).toEqual(['Edit items', 'Edit items', 'Edit items']);
    expect((await intents(page)).map(l => l.intent).every(i => i.type === 'editProperty' && i.key === 'boxShadow')).toBe(true);
  });
});

test.describe('typed input clamps (brief §5; §46.6 / W3-ED-24)', () => {
  test('Opacity 150 → 100 % (stored 1); Scale 900 → 500 % (stored 5); Rotation -999 → -360', async ({ page }) => {
    await openEditor(page, t04Doc({ vid: { properties: { opacity: prop(0.5), scale: prop(1), rotation: prop(10) } } })); await pick(page, 'vid');
    const basic = await section(page, 'Basic'), tf = await section(page, 'Transform');
    await typeValue(basic, 'Opacity', '150'); await typeValue(tf, 'Scale', '900'); await typeValue(tf, 'Rotation', '-999');
    const p = itemOf(await liveDoc(page), 'vid').properties; expect(p.opacity.defaultValue).toBe(1); expect(p.scale.defaultValue).toBe(5); expect(p.rotation.defaultValue).toBe(-360);
    expect(await valueNow(basic, 'Opacity')).toBe(100); expect(await valueNow(tf, 'Scale')).toBe(500); expect(await valueNow(tf, 'Rotation')).toBe(-360);
  });
  test('a typed non-number is ignored: no entry', async ({ page }) => {
    const id = await openEditor(page, t04Doc({ vid: { properties: { opacity: prop(0.5) } } })); await pick(page, 'vid'); const before = await stored(page, id), basic = await section(page, 'Basic');
    await typeValue(basic, 'Opacity', 'abc'); expect(await undoLabels(page)).toEqual([]); await expectUntouched(page, id, before);
  });
});

test.describe('keyframe diamond, time row, delete link (brief §1, §7; §46.10)', () => {
  const clipDoc = () => t04Doc({ vid: { properties: { opacity: prop(1) } } });
  test('the diamond is disabled while the playhead is outside the clip (provisional choice, not Xapp parity)', async ({ page }) => {
    await openEditor(page, clipDoc()); await pick(page, 'vid'); const basic = await section(page, 'Basic');
    await playhead(page, 500); await expect(basic.getByRole('button', { name: 'Add Opacity keyframe' })).toBeDisabled();
    await playhead(page, 6500); await expect(basic.getByRole('button', { name: 'Add Opacity keyframe' })).toBeDisabled();
    await playhead(page, 3000); await expect(basic.getByRole('button', { name: 'Add Opacity keyframe' })).toBeEnabled();
  });
  test('add at the playhead, edit it with the slider, show a clip-relative time (provisional choice), delete: four "Edit items" entries', async ({ page }) => {
    await openEditor(page, clipDoc()); await pick(page, 'vid'); await watchIntents(page); const basic = await section(page, 'Basic'); await playhead(page, 3000);
    await basic.getByRole('button', { name: 'Add Opacity keyframe' }).click();
    expect((await last(page)).intent).toEqual({ type: 'addKeyframe', itemId: 'vid', key: 'opacity', atMs: 3000 });
    const on = basic.getByRole('button', { name: 'Opacity keyframe at playhead' }); await expect(on).toHaveAttribute('aria-pressed', 'true');
    await expect(basic.locator('.kf-time')).toContainText('2.00s'); // clip-relative: playhead 3.000 s − clip start 1.000 s
    let p = itemOf(await liveDoc(page), 'vid').properties.opacity; expect(p.keyframes).toHaveLength(1); expect(p.keyframes[0]).toMatchObject({ time: 2000, value: 1, easing: 'linear' });
    await typeValue(basic, 'Opacity', '40'); const edit = (await last(page)).intent;
    expect(edit).toMatchObject({ type: 'editKeyframe', target: { itemId: 'vid', key: 'opacity', keyframeId: p.keyframes[0].id }, patch: { value: 0.4 } });
    p = itemOf(await liveDoc(page), 'vid').properties.opacity; expect(p.keyframes).toHaveLength(1); expect(p.keyframes[0].value).toBe(0.4); expect(p.defaultValue).toBe(1);
    await basic.getByRole('button', { name: 'Delete Opacity keyframe' }).click(); expect((await last(page)).intent).toMatchObject({ type: 'deleteKeyframe', target: { keyframeId: p.keyframes[0].id } });
    expect(itemOf(await liveDoc(page), 'vid').properties.opacity.keyframes).toEqual([]); await expect(basic.getByRole('button', { name: 'Add Opacity keyframe' })).toBeVisible();
    expect(await undoLabels(page)).toEqual(['Edit items', 'Edit items', 'Edit items']);
  });
  test('deleteKeyframe with no target is a no-op: {ok:true}, no entry', async ({ page }) => {
    const id = await openEditor(page, clipDoc()); await pick(page, 'vid'); const before = await stored(page, id);
    const r = await page.evaluate(async () => { const p = '/src/editor/commands.ts'; return (await import(p)).dispatch({ type: 'deleteKeyframe' }); });
    expect(r).toMatchObject({ ok: true }); expect(await undoLabels(page)).toEqual([]); await expectUntouched(page, id, before);
  });
});

test.describe('the eye is view-only (Q3, W3-ED-11)', () => {
  const kfDoc = () => t04Doc({ vid: { properties: { opacity: prop(1, [kf('k1', 1000, 1), kf('k2', 3000, 0.5)]) } } });
  test('the eye is disabled while the property has no keyframes', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); const basic = await section(page, 'Basic');
    await expect(basic.getByRole('button', { name: 'Show Opacity keyframes on the timeline' })).toBeDisabled();
  });
  test('clicking the eye flips aria-pressed and hides the clip diamonds; no undo entry, document untouched', async ({ page }) => {
    const id = await openEditor(page, kfDoc()); await pick(page, 'vid'); const before = await stored(page, id), basic = await section(page, 'Basic');
    const eye = basic.getByRole('button', { name: 'Show Opacity keyframes on the timeline' }), diamonds = page.locator('[data-item-id="vid"] .clip-kf[data-kf-key="opacity"]');
    await expect(eye).toBeEnabled(); await expect(eye).toHaveAttribute('aria-pressed', 'true'); await expect(diamonds).toHaveCount(2);
    await eye.click(); await expect(eye).toHaveAttribute('aria-pressed', 'false'); await expect(diamonds).toHaveCount(0);
    expect(await undoLabels(page)).toEqual([]); await expectUntouched(page, id, before);
    await eye.click(); await expect(eye).toHaveAttribute('aria-pressed', 'true'); await expect(diamonds).toHaveCount(2);
  });
  test('Time Remap eye: off shows the badge "1" on the clip, on shows the timeRemap diamonds (provisional choice, not Xapp parity)', async ({ page }) => {
    await openEditor(page, t04Doc({ vid: { timeRemap: { defaultValue: 0, keyframes: [kf('r1', 0, 0), kf('r2', 4000, 4000)] } } })); await pick(page, 'vid'); const speed = await section(page, 'Speed & Time Remap');
    const eye = speed.getByRole('button', { name: 'Time Remap visibility' }), item = page.locator('[data-item-id="vid"]');
    await expect(eye).toBeEnabled(); await expect(eye).toHaveAttribute('aria-pressed', 'true'); await expect(item.locator('.clip-kf[data-kf-key="timeRemap"]')).toHaveCount(2);
    await eye.click(); await expect(eye).toHaveAttribute('aria-pressed', 'false');
    await expect(item.locator('.clip-kf-badge')).toHaveText('1'); await expect(item.locator('.clip-kf[data-kf-key="timeRemap"]')).toHaveCount(0);
    expect(await undoLabels(page)).toEqual([]);
  });
  test('the Time Remap eye is disabled while remap is off', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); const speed = await section(page, 'Speed & Time Remap');
    await expect(speed.getByRole('button', { name: 'Time Remap visibility' })).toBeDisabled();
  });
});

test.describe('Parity-mode sliders (brief §3)', () => {
  test('default "drag": one Opacity drag commits exactly one entry, on release', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); const basic = await section(page, 'Basic');
    await dragSlider(page, basic, 'Opacity', -60, 6);
    expect(await undoLabels(page)).toEqual(['Edit items']); expect(await valueNow(basic, 'Opacity')).toBeLessThan(100);
  });
  // Coordinator correction A: the same drag gives 1 entry by default and per-step entries in parity mode, and the stored playbackRate is the same in both (a fresh editor per mode).
  test('Speed: the same drag gives 1 "Change speed" entry in "drag" and several in "step", and the stored playbackRate is equal in both', async ({ page }) => {
    const dragSpeed = async (mode: 'drag' | 'step') => {
      await openEditor(page, t04Doc()); await pick(page, 'vid'); const speed = await section(page, 'Speed & Time Remap');
      if (mode === 'step') await setBusOption(page, { sliderEntries: 'step' });
      await dragSlider(page, speed, 'Speed', 40, 6);
      return { labels: await undoLabels(page), rate: itemOf(await liveDoc(page), 'vid').playbackRate, shown: await valueNow(speed, 'Speed') };
    };
    const drag = await dragSpeed('drag'), step = await dragSpeed('step');
    expect(drag.labels).toEqual(['Change speed']); expect(drag.rate).not.toBe(1);
    expect(step.labels.length).toBeGreaterThan(1); expect(new Set(step.labels)).toEqual(new Set(['Change speed']));
    expect(step.rate).toBe(drag.rate);
  });
  test('"step": the same drag commits one entry per step value', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); const basic = await section(page, 'Basic');
    await setBusOption(page, { sliderEntries: 'step' }); await dragSlider(page, basic, 'Opacity', -60, 6);
    const labels = await undoLabels(page); expect(labels.length).toBeGreaterThan(1); expect(new Set(labels)).toEqual(new Set(['Edit items']));
    const final = Math.round(Number(await sliderIn(basic, 'Opacity').getAttribute('aria-valuenow')));
    expect(itemOf(await liveDoc(page), 'vid').properties.opacity.defaultValue).toBeCloseTo(final / 100, 6);
  });
});
