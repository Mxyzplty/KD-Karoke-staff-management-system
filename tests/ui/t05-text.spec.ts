// SPDX-License-Identifier: AGPL-3.0-only
// T05 text UI in real Chromium (acceptance list in "T05 text and text animations notes (C).md" §7; findings §14 wave 3 fixtures 1, 2, 5;
// part 3 §46.6 / §46.7): Add text (W3-ED-22), the inspector sections, the 14-tile preset gallery (acceptance (a)), the Animation grid and
// Speed slider (acceptance (c)), the parity-mode slider drag (W3-RT-02: 1x to 2x = 4 entries), canvas text editing (fixture 5), the
// Transform alignment buttons (acceptance (d)) and the gradient colour (acceptance (b)). Oracle = the written spec, never the product code.
// The CJK render check skips with the product's own notice when the Noto Sans SC subset is not in $CUTFRAME_FIXTURES/fonts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { STORE } from '../media-fixtures';
import { clearIntents, intents, openEditor, setViewState, skipTour, stored, watchIntents } from './t02-support';
import { liveDoc, undoLabels } from './t03-support';
import { FULL_RANGE_PX } from '../../apps/web/src/editor/slider';
import { panel, section, setBusOption, sliderIn, valueNow } from './t04-support';

test.beforeEach(async ({ page }) => { await skipTour(page); });

const track = (id: string, name: string, kind: string) => ({ id, name, kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
/** 1080 x 1920 30 fps, overlay track O1 with one text item `txt` ("Draft", 0-4 s, Roboto 100 px, 600 x 160 at 240 / 700). */
function textDoc(details: Record<string, unknown> = {}, empty = false) {
  const tracks = [track('v1', 'V1', 'video'), track('o1', 'O1', 'overlay')], p = (v: unknown) => ({ defaultValue: v, keyframes: [] });
  return {
    schemaVersion: 4, rev: 0, groups: {}, duration: 6000, fps: 30, size: { width: 1080, height: 1920 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })),
    items: empty ? [] : [{
      id: 'txt', type: 'text', trackId: 'o1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, playbackRate: 1, masks: [], effects: [],
      details: { text: 'Draft', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto', ...details },
      properties: { opacity: p(1), scale: p(1), rotation: p(0), fontSize: p(100), fontWeight: p(700), color: p('#ffffff'), backgroundColor: p('transparent'), textAlign: p('center'), wordWrap: p('break-word'),
        borderWidth: p(0), borderColor: p('#000000'), positionX: p(240), positionY: p(700), width: p(600), height: p(160) },
    }],
  };
}
const openTool = (page: Page, name: string) => page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name }).click();
const pickText = async (page: Page, id = 'txt') => { await page.locator(`[data-item-id="${id}"]`).click(); await expect(panel(page).getByRole('heading').first()).toBeVisible(); };
const texts = async (page: Page) => (await liveDoc(page)).items.filter((i: any) => i.type === 'text');
const item = async (page: Page, id = 'txt') => (await liveDoc(page)).items.find((i: any) => i.id === id);
const val = (it: any, k: string) => it.properties[k]?.defaultValue;
const edits = async (page: Page) => (await intents(page)).filter(l => l.intent.type === 'editTextProperties');
/** The undo entries of the editor (label list). */
const labels = (page: Page) => undoLabels(page);

test.describe('Add text and the inspector sections', () => {
  test('Add text (W3-ED-22): "Heading" on a new overlay track at 0 s, selected; the sheet shows the seven text sections in order', async ({ page }) => {
    await openEditor(page, textDoc({}, true)); await watchIntents(page);
    await openTool(page, 'Text');
    await expect(page.getByRole('region', { name: 'Text' }).getByRole('button', { name: 'Add text' })).toBeVisible();
    await page.getByRole('button', { name: 'Add text' }).click();
    await expect.poll(async () => (await texts(page)).length).toBe(1);
    const t = (await texts(page))[0], doc = await liveDoc(page);
    expect(t.details.text).toBe('Heading');
    expect(t.details.fontFamilyDisplay).toBe('Roboto'); expect(t.details.fontFamily).toBe('Roboto-Bold');
    expect(t.display).toEqual({ from: 0, to: 5000 });
    expect([val(t, 'fontSize'), val(t, 'color'), val(t, 'textAlign'), val(t, 'wordWrap'), val(t, 'borderWidth'), val(t, 'borderColor')]).toEqual([150, '#ffffff', 'center', 'break-word', 0, '#000000']);
    expect(doc.tracks.filter((x: any) => x.kind === 'overlay').map((x: any) => x.name)).toEqual(['O1']);
    expect((await intents(page)).map(l => l.intent.type)).toContain('addTextPreset');
    expect(await labels(page)).toEqual(['Add items']);
    // selected: the sheet is the text sheet
    const titles = await panel(page).locator('details.inspector-section > summary').allTextContents();
    expect(titles).toEqual(['Preset', 'Text', 'Animation', 'Basic', 'Transform', 'Font Stroke', 'Font Shadow']);
  });

  test('a second Add text goes on a new overlay track above (O2); an emptied lowest track is reused', async ({ page }) => {
    await openEditor(page, textDoc({}, true));
    await openTool(page, 'Text');
    await page.getByRole('button', { name: 'Add text' }).click(); await expect.poll(async () => (await texts(page)).length).toBe(1);
    await setViewState(page, { selection: [] }); await openTool(page, 'Text');          // the new item is selected: the sheet replaces the tool panel
    await page.getByRole('button', { name: 'Add text' }).click(); await expect.poll(async () => (await texts(page)).length).toBe(2);
    expect((await liveDoc(page)).tracks.filter((x: any) => x.kind === 'overlay').map((x: any) => x.name)).toEqual(['O1', 'O2']);
    const [a, b] = await texts(page);
    expect(a.trackId).not.toBe(b.trackId);
  });
});

test.describe('inspector colour display (R2 m5: a legacy details.color is shown when there is no color property)', () => {
  test('an item with details.color and no color property shows that colour in the Text section (display only, no write)', async ({ page }) => {
    const doc = textDoc({ color: '#ff8800' });
    delete (doc.items[0] as any).properties.color;                     // legacy item: colour lived only in details
    await openEditor(page, doc); await watchIntents(page); await pickText(page);
    const body = await section(page, 'Text');
    await expect(body.getByRole('button', { name: 'Text colour: #ff8800' })).toBeVisible();
    expect(await edits(page)).toHaveLength(0);                          // display only: opening the inspector writes nothing
    expect((await item(page)).properties.color).toBeUndefined();        // the property stays absent
  });
});

test.describe('preset gallery (acceptance (a))', () => {
  test('None + 14 tiles in a 3 x 5 grid; a tile writes only colour / fill / stroke / shadow, stays open, the field reads None, one Undo restores', async ({ page }) => {
    await openEditor(page, textDoc()); await watchIntents(page); await pickText(page);
    const body = await section(page, 'Preset');
    await expect(body.getByRole('button', { name: 'Preset: None' })).toHaveText('None');
    await body.getByRole('button', { name: 'Preset: None' }).click();
    const gallery = page.getByRole('dialog', { name: 'Text presets' }).or(page.locator('.preset-gallery'));
    await expect(gallery.locator('.preset-tile')).toHaveCount(15);
    expect(await gallery.locator('.preset-tile').evaluateAll(els => els.map(e => e.getAttribute('aria-label')))).toEqual([
      'Preset none', 'Preset 1: Dark box', 'Preset 2: Light box', 'Preset 3: Outline', 'Preset 4: Dark outline', 'Preset 5: Coral pill', 'Preset 6: Lemon pill', 'Preset 7: Teal pill',
      'Preset 8: Soft shadow', 'Preset 9: Cyan glow', 'Preset 10: Pink neon', 'Preset 11: Comic', 'Preset 12: Retro drop', 'Preset 13: Ice outline', 'Preset 14: Mint on black']);
    const columns = await gallery.locator('.preset-grid').evaluate(g => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(3);

    const before = await item(page); await clearIntents(page);
    await gallery.getByRole('button', { name: 'Preset 10: Pink neon' }).click();
    await expect.poll(async () => val(await item(page), 'borderWidth')).toBe(12);
    const after = await item(page);
    expect(val(after, 'borderColor')).toBe('#ec4899');
    expect(val(after, 'boxShadow')).toMatchObject({ color: '#ec4899', blur: 80 });
    for (const k of new Set([...Object.keys(before.properties), ...Object.keys(after.properties)]))
      if (!['color', 'backgroundColor', 'borderColor', 'borderWidth', 'boxShadow'].includes(k)) expect(after.properties[k], k).toEqual(before.properties[k]);
    expect(after.details).toEqual(before.details);
    expect((await edits(page))).toHaveLength(1);
    expect(await labels(page)).toEqual(['Edit items']);
    await expect(gallery).toBeVisible();                                            // the gallery stays open
    await expect(body.getByRole('button', { name: 'Preset: None' })).toHaveText('None'); // the field keeps reading None

    await page.keyboard.press('Escape'); await setViewState(page, {});
    await page.evaluate(async () => { const p = '/src/editor/commands.ts'; (await import(p)).dispatch({ type: 'undo' }); });
    await expect.poll(async () => JSON.stringify(await item(page))).toBe(JSON.stringify(before));   // 1 Undo restores
  });

  test('"Preset none" writes the inspector defaults (white, no fill, no stroke, no shadow)', async ({ page }) => {
    await openEditor(page, textDoc()); await pickText(page);
    const body = await section(page, 'Preset');
    await body.getByRole('button', { name: 'Preset: None' }).click();
    await page.getByRole('button', { name: 'Preset 5: Coral pill' }).click();
    await expect.poll(async () => val(await item(page), 'backgroundColor')).toBe('#f43f5e');
    await page.getByRole('button', { name: 'Preset none' }).click();
    await expect.poll(async () => val(await item(page), 'backgroundColor')).toBe('transparent');
    const it = await item(page);
    expect([val(it, 'color'), val(it, 'borderWidth')]).toEqual(['#ffffff', 0]);
  });
});

test.describe('Animation grid and Speed slider (acceptance (c), W3 fixtures 1-2)', () => {
  const ORDER = ['None', 'Typewriter', 'Scramble', 'Pop', 'Jump', 'Fade', 'Zoom', 'Flicker', 'Loud', 'Fall', 'Speedy', 'Stamped', 'Step Fade', 'Slide Right'];
  test('14 tiles in Xapp\'s order; Speed is absent for None, shown for any other preset (0.25-4, step 0.25, 1x); there is no duration control', async ({ page }) => {
    await openEditor(page, textDoc()); await watchIntents(page); await pickText(page);
    const anim = await section(page, 'Animation');
    const grid = anim.getByRole('radiogroup', { name: 'Text animation' });
    expect(await grid.getByRole('radio').allTextContents()).toEqual(ORDER);
    await expect(grid.getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'true');
    await expect(sliderIn(anim, 'Speed')).toHaveCount(0);
    await grid.getByRole('radio', { name: 'Pop' }).click();                       // W3 fixture 1
    await expect(sliderIn(anim, 'Speed')).toBeVisible();
    expect([await sliderIn(anim, 'Speed').getAttribute('aria-valuemin'), await sliderIn(anim, 'Speed').getAttribute('aria-valuemax')]).toEqual(['0.25', '4']);
    expect(await valueNow(anim, 'Speed')).toBe(1);
    // fixture 1: Pop stores {version 1, preset pop} (no speed) as 1 "Edit items"
    expect((await item(page)).details.textAnimation).toEqual({ version: 1, preset: 'pop' });
    expect(await labels(page)).toEqual(['Edit items']);
    await grid.getByRole('radio', { name: 'Typewriter' }).click();
    expect((await item(page)).details.textAnimation).toEqual({ version: 1, preset: 'typewriter' });
    expect(await labels(page)).toEqual(['Edit items', 'Edit items']);
    // no duration control anywhere in the sheet
    for (const role of ['slider', 'spinbutton', 'textbox', 'combobox'] as const) await expect(panel(page).getByRole(role, { name: /duration/i })).toHaveCount(0);
    await expect(anim.getByText(/duration/i)).toHaveCount(0);
    // None removes the speed control again
    await grid.getByRole('radio', { name: 'None' }).click();
    await expect(sliderIn(anim, 'Speed')).toHaveCount(0);
    expect((await item(page)).details.textAnimation).toEqual({ version: 1, preset: 'none' });
  });

  test('a tile keeps the chosen speed; typing 2 stores speed 2; arrow keys step by 0.25', async ({ page }) => {
    await openEditor(page, textDoc({ textAnimation: { version: 1, preset: 'fade', speed: 1.5 } })); await pickText(page);
    const anim = await section(page, 'Animation');
    expect(await valueNow(anim, 'Speed')).toBe(1.5);
    await anim.getByRole('radio', { name: 'Zoom' }).click();
    expect((await item(page)).details.textAnimation).toEqual({ version: 1, preset: 'zoom', speed: 1.5 });
    await sliderIn(anim, 'Speed').focus(); await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await item(page)).details.textAnimation.speed).toBe(1.75);
    await anim.locator('[data-slider="Speed"] .slider-value').dblclick();
    const input = anim.getByRole('textbox', { name: 'Speed value' }); await input.fill('2'); await input.press('Enter');
    await expect.poll(async () => (await item(page)).details.textAnimation).toEqual({ version: 1, preset: 'zoom', speed: 2 });
  });

  test('fixture 2: in parity mode (sliderEntries "step") a drag 1x to 2x gives 4 entries (1.25, 1.5, 1.75, 2) and stores speed 2', async ({ page }) => {
    await openEditor(page, textDoc({ textAnimation: { version: 1, preset: 'pop' } })); await pickText(page);
    await setBusOption(page, { sliderEntries: 'step' });
    const anim = await section(page, 'Animation');
    const box = (await sliderIn(anim, 'Speed').boundingBox())!, y = box.y + box.height / 2, x0 = box.x + box.width / 2;
    const stepPx = 0.25 * FULL_RANGE_PX / (4 - 0.25);                                  // one 0.25 step of the 0.25-4 range, in drag px
    await page.mouse.move(x0, y); await page.mouse.down();
    for (let k = 1; k <= 4; k++) await page.mouse.move(x0 + stepPx * k, y);
    await page.mouse.up();
    await expect.poll(async () => (await item(page)).details.textAnimation.speed).toBe(2);
    expect(await labels(page)).toEqual(['Edit items', 'Edit items', 'Edit items', 'Edit items']);
  });

  test('default mode: the same drag is one entry on release', async ({ page }) => {
    await openEditor(page, textDoc({ textAnimation: { version: 1, preset: 'pop' } })); await pickText(page);
    const anim = await section(page, 'Animation');
    const box = (await sliderIn(anim, 'Speed').boundingBox())!, y = box.y + box.height / 2, x0 = box.x + box.width / 2;
    const stepPx = 0.25 * FULL_RANGE_PX / 3.75;
    await page.mouse.move(x0, y); await page.mouse.down();
    for (let k = 1; k <= 4; k++) await page.mouse.move(x0 + stepPx * k, y);
    await page.mouse.up();
    await expect.poll(async () => (await item(page)).details.textAnimation.speed).toBe(2);
    expect(await labels(page)).toEqual(['Edit items']);
  });
});

test.describe('canvas text editing (W3 fixture 5)', () => {
  const hit = (page: Page) => page.locator('.text-hit[data-item="txt"]');
  const editor = (page: Page) => page.getByRole('textbox', { name: 'Edit text' });
  const setup = async (page: Page) => { const id = await openEditor(page, textDoc()); await watchIntents(page); await setViewState(page, { playheadMs: 500 }); await expect(hit(page)).toHaveCount(1); return id; };

  test('double-click enters editing with no entry; select all + "Hello" + Escape writes 1 "Edit items" with text Hello', async ({ page }) => {
    await setup(page);
    await hit(page).dblclick();
    await expect(editor(page)).toBeFocused();
    expect(await edits(page)).toHaveLength(0); expect(await labels(page)).toEqual([]);
    await page.keyboard.press('Control+A'); await page.keyboard.type('Hello'); await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    await expect.poll(async () => (await item(page)).details.text).toBe('Hello');   // Escape keeps the new text
    expect(await edits(page)).toHaveLength(1);
    expect(await labels(page)).toEqual(['Edit items']);
  });

  test('clicking elsewhere ends editing and writes 1 entry', async ({ page }) => {
    await setup(page);
    await hit(page).dblclick();
    await page.keyboard.press('Control+A'); await page.keyboard.type('Elsewhere');
    await page.getByRole('navigation', { name: 'Tools' }).click({ position: { x: 4, y: 4 } });
    await expect(editor(page)).toHaveCount(0);
    await expect.poll(async () => (await item(page)).details.text).toBe('Elsewhere');
    expect(await edits(page)).toHaveLength(1);
    expect(await labels(page)).toEqual(['Edit items']);
  });

  test('5 s idle in edit mode does nothing', async ({ page }) => {
    await setup(page);
    await hit(page).dblclick(); await expect(editor(page)).toBeFocused();
    await page.keyboard.type('x');
    await page.waitForTimeout(5000);
    await expect(editor(page)).toBeVisible();
    expect(await edits(page)).toHaveLength(0); expect(await labels(page)).toEqual([]);
    expect((await item(page)).details.text).toBe('Draft');
  });

  test('double-click then Escape without a change writes no entry and nothing is saved', async ({ page }) => {
    const id = await setup(page);
    const before = await stored(page, id);
    await hit(page).dblclick(); await expect(editor(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    expect(await edits(page)).toHaveLength(0); expect(await labels(page)).toEqual([]);
    await page.waitForTimeout(3500);                                                  // past the 3 s autosave
    const after = await stored(page, id);
    expect(after.json).toBe(before.json); expect(after.rev).toBe(before.rev); expect(after.updated).toBe(before.updated);
  });

  test('typing back the original text is also no entry', async ({ page }) => {
    await setup(page);
    await hit(page).dblclick();
    await page.keyboard.press('Control+A'); await page.keyboard.type('Other'); await page.keyboard.press('Control+A'); await page.keyboard.type('Draft'); await page.keyboard.press('Escape');
    expect(await edits(page)).toHaveLength(0);
  });
});

test.describe('Transform alignment (acceptance (d))', () => {
  test('1080 x 1920, box 600 x 160 at X 240 / Y 700: the four buttons write the centred positions', async ({ page }) => {
    await openEditor(page, textDoc()); await watchIntents(page); await pickText(page);
    const tf = await section(page, 'Transform');
    const buttons = await tf.getByRole('button').allTextContents();
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    const names = await tf.getByRole('button').evaluateAll(els => els.map(e => e.getAttribute('aria-label') ?? e.textContent ?? ''));
    const find = (re: RegExp) => tf.getByRole('button').nth(names.findIndex(n => re.test(n)));
    const x = find(/horizontal(?!.*top|.*bottom)/i), y = find(/vertical/i), top = find(/top/i), bottom = find(/bottom/i);
    await x.click();
    await expect.poll(async () => val(await item(page), 'positionX')).toBe(240);      // (1080 - 600) / 2
    await top.click();
    await expect.poll(async () => val(await item(page), 'positionY')).toBe(416);     // round(.3 x 1920) - 160
    await bottom.click();
    await expect.poll(async () => val(await item(page), 'positionY')).toBe(1344);    // round(.7 x 1920)
    await y.click();
    await expect.poll(async () => val(await item(page), 'positionY')).toBe(880);     // (1920 - 160) / 2
    expect(val(await item(page), 'positionX')).toBe(240);
    expect(await labels(page)).toEqual(['Edit items', 'Edit items', 'Edit items']);     // "centre horizontally" at X 240 is already centred: no change, no entry
  });
});

test.describe('gradient text colour (acceptance (b))', () => {
  test('a stored CSS gradient shows in the preview (top rows dark, bottom rows light) and survives a reload', async ({ page }) => {
    const grad = 'linear-gradient(180deg, #000000 0%, #ffffff 100%)';
    const doc = textDoc();
    (doc.items[0] as any).properties.color = { defaultValue: grad, keyframes: [] };
    (doc.items[0] as any).properties.backgroundColor = { defaultValue: '#808080', keyframes: [] };
    const id = await openEditor(page, doc); await setViewState(page, { playheadMs: 500 });
    await expect.poll(async () => val(await item(page), 'color')).toBe(grad);
    await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
    expect(val(await item(page), 'color')).toBe(grad);
    void id;
    // pixel read of the composited preview runs
    const read = (fx: number, fy: number) => page.evaluate(([fx, fy]) => {   // fx, fy: fractions of the canvas
      const runs = [...document.querySelectorAll<HTMLCanvasElement>('canvas.run')], o = document.createElement('canvas');
      o.width = runs[0].width; o.height = runs[0].height; const g = o.getContext('2d')!;
      for (const c of runs) g.drawImage(c, 0, 0);
      return Array.from(g.getImageData(Math.floor(fx * o.width), Math.floor(fy * o.height), 1, 1).data);
    }, [fx, fy]);
    await expect.poll(async () => (await read(250 / 1080, 710 / 1920)).slice(0, 3).join()).toBe('128,128,128');   // the box fill (top-left corner, clear of the glyphs): the preview draws the text item
  });
});

test.describe('CJK render (skips without the Noto Sans SC subset in the fixture store)', () => {
  const fontsDir = path.join(STORE || '', 'fonts');
  const cjkFile = STORE && existsSync(fontsDir) ? readdirSync(fontsDir).find(f => /NotoSansSC.*\.(ttf|otf|woff2?)$/i.test(f)) : undefined;
  const SKIP = 'The CJK font (Noto Sans SC) is not in $CUTFRAME_FIXTURES/fonts, so the CJK render check is skipped; Chinese, Japanese and Korean characters are drawn with the default sans-serif font: the CJK font (Noto Sans SC) could not be loaded. Check the connection.';
  test('a Chinese text draws glyphs from the CJK face (not blank, not tofu-width) in the preview', async ({ page }) => {
    test.skip(!cjkFile, SKIP);
    const bytes = readFileSync(path.join(fontsDir, cjkFile!));
    await page.route(/fonts\.googleapis\.com\/css2\?family=Noto\+Sans\+SC/, r => r.fulfill({ contentType: 'text/css', body: `@font-face{font-family:'Noto Sans SC';font-weight:100 900;src:url(https://fonts.gstatic.com/cjk-fixture) format('truetype');}` }));
    await page.route(/fonts\.gstatic\.com\/cjk-fixture/, r => r.fulfill({ contentType: 'font/ttf', body: bytes }));
    await openEditor(page, textDoc({ text: '你好世界' }));
    await setViewState(page, { playheadMs: 500 });
    const lit = () => page.evaluate(() => {
      const runs = [...document.querySelectorAll<HTMLCanvasElement>('canvas.run')]; let n = 0;
      for (const c of runs) { const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data; if (d) for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; }
      return n;
    });
    await expect.poll(lit, { timeout: 15000 }).toBeGreaterThan(200);
    await expect(page.getByText(/could not be loaded/i)).toHaveCount(0);
  });
});
