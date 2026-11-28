// SPDX-License-Identifier: AGPL-3.0-only
// T02 owned acceptance A1–A2, B1–B5, C1–C4, H1–H4, I1 in real Chromium with real IndexedDB. Stubs must stay visible: after every stub
// dispatch the stored document is byte-identical, the revision is unchanged, the session is still "saved" and a notice names the owner.
import { test, expect } from '@playwright/test';
import { liveDoc, savedDoc, undoEntries } from './t03-support';
import { addAsset, blurAll, clearIntents, clip, createProject, expectUntouched, guard, intents, notices, openEditor, richDoc, sessionState, setViewState, skipTour, stored, TINY_PNG, typesDoc, viewState, watchIntents } from './t02-support';

test.beforeEach(async ({ page }) => { await skipTour(page); });

test('A2/B1 Create Project from the wizard opens the editor shell of that project (placeholder replaced)', async ({ page }) => {
  const leaks = guard(page);
  await page.goto('/'); await page.getByRole('button', { name: '＋ New Video', exact: true }).click(); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create Project', exact: true }).click(); await expect(page).toHaveURL(/\/project\/[^/]+$/);
  const id = page.url().split('/').pop()!;
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled Project' })).toBeVisible(); await expect(page.getByRole('status')).toHaveText('Saved locally');
  for (const region of ['Left panel', 'Preview', 'Timeline', 'Inspector and tools', 'Tools']) await expect(page.getByRole(region === 'Preview' || region === 'Timeline' ? 'region' : region === 'Tools' ? 'navigation' : 'complementary', { name: region, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to home' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  // The project it opened is the one just created, saved untouched.
  expect((await stored(page, id)).rev).toBe(0); expect(leaks).toEqual([]);
});

test('A1 T01 routes unchanged: missing id is the full-screen failure, the editor keeps the conflict state and save line', async ({ page, context }) => {
  await page.goto('/project/missing-id'); await expect(page.getByRole('heading', { name: 'Failed to load project' })).toBeVisible(); await expect(page.locator('header')).toHaveCount(0);
  const id = await openEditor(page, richDoc()); const other = await context.newPage(); await skipTour(other); await other.goto(`/project/${id}`); await expect(other.getByRole('status')).toHaveText('Saved locally');
  // T17: a clean tab now refetches another tab's save (cross-tab channel), so tab B has an unsaved change before tab A saves.
  await other.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); activeSession.update({ ...activeSession.document, fps: 60 }); });
  await page.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); activeSession.update({ ...activeSession.document, fps: 24 }); await activeSession.flush(); });
  await other.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); activeSession.update({ ...activeSession.document, fps: 60 }); await activeSession.flush(); });
  await expect(other.getByRole('group', { name: 'Resolve project conflict' })).toBeVisible();
  await expect(page.getByTestId('project-rev')).toHaveText('Saved revision: 1'); await expect(page.getByText('1920 × 1080 · 24 fps · 5 items')).toBeVisible();
  await other.getByRole('button', { name: 'Reload', exact: true }).click(); await expect(other.getByTestId('project-rev')).toHaveText('Saved revision: 1');
});

test('B1 wide layout: left Footage (Uploads / Reference) and AI, preview, timeline, inspector or tool panel, the 11-tool rail in order; rail tool → panel; clip → Properties / Effects', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id);
  const left = page.getByRole('complementary', { name: 'Left panel' });
  await expect(left.getByRole('tablist', { name: 'Left panel' }).getByRole('tab')).toHaveText(['Footage', 'AI']); await expect(left.getByRole('tablist', { name: 'Footage' }).getByRole('tab')).toHaveText(['Uploads', 'Reference']);
  await left.getByRole('tab', { name: 'AI' }).click(); await expect(left.getByText('No AI provider connected.')).toBeVisible(); await expect(left).toContainText('not yet implemented (T20)');
  await left.getByRole('tab', { name: 'Footage', exact: true }).click(); await left.getByRole('tab', { name: 'Reference' }).click(); await expect(left.getByRole('heading', { name: 'Reference videos' })).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await expect(rail.getByRole('tab')).toHaveText(['Text', 'Motion graphics', 'Shapes', 'Layouts', 'Captions', 'Effects', 'Style presets', 'Videos', 'Photos', 'Sounds', 'Voice-over']);
  const panel = page.getByRole('complementary', { name: 'Inspector and tools' });
  // T10 (C8 assertion-only edit): the Effects panel is built now, so it no longer names an owner; its heading is checked below.
  // T06 (C8 assertion-only edit): the Shapes panel is built too; its Draw button is checked below.
  // T05 (assertion edit): the Text panel is real now (Add text; see ui/t05-text.spec.ts:43). T07 (C8): the Layouts panel is built (11 cards checked below). Neither is a stub.
  // T09 (C8 assertion-only edit): the Captions panel is built now (see ui/t09-captions.spec.ts) — positive check replaces the stub.
  // T22 (C8 assertion-only edit): the Style presets panel is built now (see ui/t22-presets.spec.ts); its All chip replaces the stub line. No rail panel is a stub any more.
  await rail.getByRole('tab', { name: 'Style presets', exact: true }).click(); await expect(rail.getByRole('tab', { name: 'Style presets', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('heading', { name: 'Style presets', exact: true })).toBeVisible(); await expect(panel.getByRole('button', { name: 'All', exact: true })).toBeVisible(); await expect(panel).not.toContainText('not yet implemented (T22)');
  await rail.getByRole('tab', { name: 'Captions', exact: true }).click(); await expect(rail.getByRole('tab', { name: 'Captions', exact: true })).toHaveAttribute('aria-selected', 'true'); // T09 (C8 assertion-only edit)
  await expect(panel.getByRole('heading', { name: 'Captions', exact: true })).toBeVisible(); await expect(panel.getByRole('radiogroup', { name: 'Caption source' })).toBeVisible(); await expect(panel).not.toContainText('not yet implemented (T09)');
  // T13: the Voice-over tool opens the working Voice Over panel (was: "The Voice-over panel is not yet implemented (T13).").
  await rail.getByRole('tab', { name: 'Voice-over', exact: true }).click(); await expect(panel.getByRole('heading', { name: 'Voice Over', exact: true })).toBeVisible(); await expect(panel.getByRole('button', { name: 'Record' })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Effects' })).toHaveCount(0); await rail.getByRole('tab', { name: 'Effects' }).click(); await expect(panel.getByRole('heading', { name: 'Effects', exact: true })).toBeVisible(); await expect(panel.getByRole('listitem')).toHaveCount(39);
  await rail.getByRole('tab', { name: 'Shapes' }).click(); await expect(panel.getByRole('heading', { name: 'Shapes', exact: true })).toBeVisible(); await expect(panel.getByRole('button', { name: 'Draw', exact: true })).toBeVisible(); // T06 (C8)
  await rail.getByRole('tab', { name: 'Layouts' }).click(); await expect(panel.getByRole('heading', { name: 'Layouts', exact: true })).toBeVisible(); await expect(panel.getByRole('list', { name: 'Layout presets' }).getByRole('button')).toHaveCount(11); // T07 (C8)
  await rail.getByRole('tab', { name: 'Videos' }).click(); await expect(panel.getByRole('group', { name: 'Stock keys' })).toBeVisible(); // T14's working stock panel (no key saved yet)
  await rail.getByRole('tab', { name: 'Photos' }).click(); await expect(panel.getByRole('group', { name: 'Stock keys' })).toBeVisible();
  await rail.getByRole('tab', { name: 'Sounds' }).click(); await expect(panel.getByRole('group', { name: 'Stock keys' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible(); await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  // Selecting a clip shows Properties / Effects in the inspector area.
  await clip(page, 'clipA').click(); await expect(panel.getByRole('tab')).toHaveText(['Properties', 'Effects']); await expect(panel.getByRole('heading', { name: 'Video' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Keyframes graph' })).toBeVisible(); await expect(panel.locator('strong', { hasText: 'Remove Background' })).toBeVisible();
  await panel.getByRole('tab', { name: 'Effects' }).click(); await expect(panel.getByRole('region', { name: 'Color' })).toBeVisible(); await expect(panel.getByRole('button', { name: '+ Add Effect' })).toBeVisible();
  expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before);
});

test('B5 inspector shells per type: header, Keyframes graph (not for layouts) opens the Keyframe Graph (T04), Remove Background → T12 (real), sections name their owners; nothing changes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id); const panel = page.getByRole('complementary', { name: 'Inspector and tools' });
  await clip(page, 'clipA').click();
  await expect(panel.locator('summary')).toHaveText(['Basic', 'Speed & Time Remap', 'Transform', 'Appearance', 'Mask', 'Shadow']);
  await panel.getByRole('button', { name: 'Keyframes graph' }).click(); const graph = page.getByRole('dialog', { name: 'Keyframe Graph' }); await expect(graph).toContainText('No keyframes yet'); await page.keyboard.press('Escape'); await expect(graph).toHaveCount(0);
  // T12 (C8 assertion-only edit): background removal is real now; clipA has no asset, so it refuses rather than queuing a job.
  await panel.getByRole('button', { name: 'Apply' }).click(); await expect(notices(page)).toContainText('REMOVE_BG_FAILED: Failed to remove background');
  await panel.locator('summary', { hasText: 'Mask' }).click(); await expect(panel.getByRole('button', { name: 'Add Mask' })).toBeVisible(); await expect(panel).not.toContainText('The Mask section is not yet implemented');
  await panel.locator('summary', { hasText: 'Transform' }).click(); await expect(panel.getByRole('slider', { name: 'Scale' })).toBeVisible(); await expect(panel).not.toContainText('The Transform section is not yet implemented');
  await clip(page, 'title').click(); await expect(panel.getByRole('heading', { name: 'Text' })).toBeVisible(); await expect(panel.locator('summary')).toHaveText(['Preset', 'Text', 'Animation', 'Basic', 'Transform', 'Font Stroke', 'Font Shadow']);
  await expect(panel.getByText('Remove Background')).toHaveCount(0);
  await clip(page, 'photo').click(); await expect(panel.getByRole('heading', { name: 'Image' })).toBeVisible(); await expect(panel.locator('summary')).toHaveText(['Basic', 'Transform', 'Appearance', 'Mask', 'Shadow']);
  const log = await intents(page); expect(log.map(l => [l.intent.type, l.outcome.code, l.outcome.owner])).toEqual([['removeBackground', 'REMOVE_BG_FAILED', undefined]]);
  await expectUntouched(page, id, before);
});

test('B5 inspector headers by type: layouts have no Keyframes graph; shape, motion graphic, caption and audio list their own sections and owners', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); const id = await openEditor(page, typesDoc()); await watchIntents(page); const before = await stored(page, id); const panel = page.getByRole('complementary', { name: 'Inspector and tools' });
  const sections: [string, string, string[]][] = [['i-layout', 'Layout', ['Cells (0)', 'Style', 'Transform']], /* T07 (C8): the cell count shows */ ['i-shape', 'Shape', ['Fill', 'Stroke', 'Basic', 'Transform', 'Shape Path']], ['i-motionGraphic', 'Motion graphic', ['Basic', 'Transform']],
    ['i-caption', 'Caption', ['Text animation', 'Word behavior', 'Caption Text', 'Text', 'Transform', 'Basic', 'Font Stroke', 'Font Shadow']], ['i-audio', 'Audio', ['Speed', 'Volume']]];
  for (const [id, heading, titles] of sections) {
    await clip(page, id).click(); await expect(panel.getByRole('heading', { level: 3 })).toHaveText(heading); await expect(panel.locator('summary'), id).toHaveText(titles);
    await expect(panel.getByRole('button', { name: 'Keyframes graph' }), id).toHaveCount(heading === 'Layout' ? 0 : 1); await expect(panel.getByText('Remove Background')).toHaveCount(0);
  }
  await clip(page, 'i-audio').click(); await panel.getByRole('tab', { name: 'Effects' }).click(); await expect(panel.getByText('Visual effects apply to visual items.')).toBeVisible(); await expect(panel.getByRole('region', { name: 'Color' })).toHaveCount(0);
  expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before);
});

test('B2 top row: Back, name, template chip → T22, local-only cloud popover, Help (3 → T21 + shortcuts), agent badge never claims a connection, Export → T16', async ({ page }) => {
  const leaks = guard(page); await page.setViewportSize({ width: 1280, height: 800 }); const id = await createProject(page, richDoc(), 'My edit'); await addAsset(page, id, 'tiny.png');
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); await watchIntents(page); const before = await stored(page, id);
  await expect(page.getByRole('heading', { level: 1, name: 'My edit' })).toBeVisible();
  // Template chip: "No template" → View details / Change template / Save as template.
  // T22 (C8 assertion-only edit): the three items open T22's dialogs now (see ui/t22-templates.spec.ts); they are no longer stubs and dispatch no feature intent.
  await page.getByRole('button', { name: 'Template: No template' }).click(); await expect(page.getByRole('menu', { name: 'Template: No template' })).toContainText('Project template');
  await expect(page.getByRole('menuitem')).toHaveText(['View details', 'Change template', 'Save as template']);
  for (const [label, dialog] of [['View details', 'Current template'], ['Change template', 'Choose a Template'], ['Save as template', 'Save as template']]) { await page.getByRole('menuitem', { name: label }).click(); await expect(page.getByRole('dialog', { name: dialog })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await page.getByRole('button', { name: 'Template: No template' }).click(); }
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
  // Cloud backup: local only, Auto off (T21 made it live), per-asset "Local only", a cost line.
  await page.getByRole('button', { name: 'Cloud backup: local only' }).click(); const cloud = page.getByRole('dialog', { name: 'Cloud backup' });
  await expect(cloud).toContainText('Off. This project and its media are kept only in this browser'); const auto = cloud.getByRole('switch'); await expect(auto).toBeEnabled(); await expect(auto).not.toBeChecked();
  await expect(cloud.getByRole('list', { name: 'Project assets' }).getByRole('listitem')).toHaveCount(1); await expect(cloud.getByRole('listitem')).toContainText('tiny.png'); await expect(cloud.getByRole('listitem')).toContainText('Local only');
  await expect(cloud).toContainText('No media leaves this device'); await expect(cloud).toContainText('any storage cost comes from the provider you choose'); await expect(cloud).not.toContainText('not yet implemented');
  await page.mouse.click(5, 400); await expect(cloud).toHaveCount(0); // outside press closes it (Escape is a separate test)
  // Help: three guides (T21: two corpus pages, Community has no destination yet) and the shortcut list.
  await page.getByRole('button', { name: 'Help', exact: true }).click(); await expect(page.getByRole('menuitem')).toHaveText(['Getting-started guide', 'Agent-setup guide', 'Community', 'Keyboard shortcuts']);
  await page.getByRole('menuitem', { name: 'Community' }).click(); await expect(notices(page)).toContainText('No community space has been set up yet.');
  expect((await intents(page)).map(l => l.outcome.owner)).toEqual([]); // T22 (C8 assertion-only edit): the chip items dispatch nothing now
  await page.getByRole('button', { name: 'Help', exact: true }).click(); await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click(); await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  // Agent badge: never "Connected"; T18a's connect panel, no Disconnect before a connection; allowed-folder count; Set up → the External Agent card.
  await page.getByRole('button', { name: 'Agent: not connected' }).click(); const agent = page.getByRole('dialog', { name: 'Agent connection' });
  await expect(agent.getByText('Not connected', { exact: true })).toBeVisible(); await expect(agent.getByText('Connected', { exact: true })).toHaveCount(0); await expect(agent.getByRole('button', { name: 'Disconnect' })).toHaveCount(0); await expect(agent.getByTestId('agent-link-panel')).toBeVisible();
  await expect(agent).toContainText('No allowed folders on this device'); await expect(agent).not.toContainText('not yet implemented');
  await agent.getByRole('link', { name: 'Set up →' }).click(); await expect(page).toHaveURL(/\/settings#external-agent$/);
  await page.goBack(); await expect(page.getByRole('status')).toHaveText('Saved locally');
  // Export → T16; Back → home.
  await page.getByRole('button', { name: 'Export', exact: true }).click(); await expect(notices(page)).toContainText('Export is not yet implemented (T16).');
  const log = await intents(page); expect(log.map(l => [l.outcome.code, l.outcome.owner])).toEqual([['NOT_IMPLEMENTED', 'T16']]); // T22 (C8 assertion-only edit): only Export is a stub here
  await expectUntouched(page, id, before);
  await page.getByRole('button', { name: 'Back to home' }).click(); await expect(page).toHaveURL(/\/$/); expect(leaks).toEqual([]);
});

test('B2 Escape closes the cloud-backup and agent popovers (Popover contract: "Escape or an outside press closes it")', async ({ page }) => {
  await openEditor(page, richDoc());
  await page.getByRole('button', { name: 'Cloud backup: local only' }).click(); await expect(page.getByRole('dialog', { name: 'Cloud backup' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Cloud backup' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Agent: not connected' }).click(); await expect(page.getByRole('dialog', { name: 'Agent connection' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Agent connection' })).toHaveCount(0);
});

test('B2 Escape with focus on the trigger closes only the popover: no group-selection exit, no selection change, no intent; with focus on the page it closes too', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id);
  await clip(page, 'clipA').click(); await page.locator('.track-row').filter({ has: page.locator('.track-name', { hasText: /^V2$/ }) }).locator('.track-name').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Group tracks…' }).click();
  await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toBeVisible();
  for (const trigger of ['Cloud backup: local only', 'Agent: not connected']) {
    await page.getByRole('button', { name: trigger }).click(); const popover = page.getByRole('dialog', { name: trigger.startsWith('Cloud') ? 'Cloud backup' : 'Agent connection' }); await expect(popover).toBeVisible();
    await page.keyboard.press('Escape'); await expect(popover).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toBeVisible(); expect(await viewState(page, v => v.selection)).toEqual(['clipA']); expect(await viewState(page, v => v.groupSelection !== null)).toBe(true);
  }
  await page.getByRole('button', { name: 'Cloud backup: local only' }).click(); await blurAll(page); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Cloud backup' })).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toBeVisible(); // the same press did not also leave the mode
  await page.keyboard.press('Escape'); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0); // the next one does
  expect(await viewState(page, v => v.selection)).toEqual(['clipA']); expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before);
});

test('E2 editor keys never act from inside a popover, a menu or the tour card (an overlay owns its keys); the same key on the page does act', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(); const id = await createProject(page, richDoc()); await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); await watchIntents(page);
  const tour = page.getByRole('dialog', { name: 'Editor tour' }); await expect(tour).toBeVisible({ timeout: 10000 });
  const send = (selector: string, key: string, init: object = {}) => page.evaluate(({ selector, key, init }) => { document.querySelector(selector)!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); }, { selector, key, init });
  const state = () => Promise.all([viewState(page, v => v.playheadMs as number), viewState(page, v => v.zoom as number), intents(page)]);
  const [p0, z0] = await state();
  // The tour card may cover these buttons, so open them with a click event rather than a pointer press.
  await page.getByRole('button', { name: 'Cloud backup: local only' }).dispatchEvent('click'); await expect(page.getByRole('dialog', { name: 'Cloud backup' })).toBeVisible();
  await page.getByRole('button', { name: 'Resize', exact: true }).dispatchEvent('click'); await expect(page.getByRole('menu', { name: 'Resize' })).toBeVisible();
  for (const target of ['section[aria-label="Editor tour"] h3', '[role="dialog"][aria-label="Cloud backup"] h3', '[role="menu"][aria-label="Resize"]'])
    for (const [key, init] of [['ArrowRight', {}], ['ArrowLeft', { ctrlKey: true }], ['+', {}], ['m', {}], [' ', {}], ['Delete', {}]] as [string, object][]) await send(target, key, init);
  const [p1, z1, log] = await state(); expect(p1).toBe(p0); expect(z1).toBe(z0); expect(log).toEqual([]);
  await send('body', 'ArrowRight'); expect((await state())[0]).toBeGreaterThan(p0); // the same event on the page body is handled
  await context.close();
});

test('B2 agent popover counts the allowed folders of this device', async ({ page }) => {
  const id = await openEditor(page, richDoc());
  await page.evaluate(async () => {
    const f = '/src/media/folders.ts', s = '/src/store/database.ts'; const { addFolder } = await import(f), { projectStore } = await import(s);
    await addFolder(projectStore, await (await navigator.storage.getDirectory()).getDirectoryHandle('T02Clips', { create: true }));
  });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await page.getByRole('button', { name: 'Agent: not connected' }).click(); await expect(page.getByRole('dialog', { name: 'Agent connection' })).toContainText('1 allowed folder on this device');
  expect(id).toBeTruthy();
});

test('B3 second row: Undo/Redo disabled with an empty history, Resize menu (current checked) → T03, Save flushes for real then T17, Restore Checkpoint is empty', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id);
  for (const name of ['Undo', 'Redo']) { const buttons = page.getByRole('button', { name, exact: true }); await expect(buttons).toHaveCount(2); await expect(buttons.first()).toBeDisabled(); await expect(buttons.last()).toBeDisabled(); }
  await page.getByRole('button', { name: 'Resize', exact: true }).click();
  await page.getByRole('button', { name: 'Resize', exact: true }).click(); await expect(page.getByRole('menu', { name: 'Resize' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Resize', exact: true }).click();
  await expect(page.getByRole('menuitemradio')).toHaveText(['16:9 Landscape', '9:16 Portrait', '1:1 Square']);
  await expect(page.getByRole('menuitemradio', { name: '16:9 Landscape' })).toHaveAttribute('aria-checked', 'true'); await expect(page.getByRole('menuitemradio', { name: '9:16 Portrait' })).toHaveAttribute('aria-checked', 'false');
  // T03 (was: NOT_IMPLEMENTED notice, canvas unchanged): the menu choice is ok:true, resizes the stored canvas to 1080 × 1920 and is one "Resize canvas" step.
  await page.getByRole('menuitemradio', { name: '9:16 Portrait' }).click();
  await expect(page.getByText('1080 × 1920 · 30 fps · 5 items')).toBeVisible(); expect((await liveDoc(page)).size).toEqual({ width: 1080, height: 1920 }); expect(await undoEntries(page)).toEqual([{ label: 'Resize canvas', source: 'user' }]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeEnabled();
  await page.getByRole('button', { name: 'Checkpoints' }).click(); const menu = page.getByRole('menu', { name: 'Checkpoints' });
  await expect(menu).toContainText('Restore Checkpoint'); await expect(menu).toContainText('No checkpoints saved yet'); await expect(menu.getByRole('menuitem')).toHaveCount(0); await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  const log = await intents(page); expect(log).toHaveLength(1); expect(log[0].intent).toEqual({ type: 'resizeCanvas', aspectRatio: '9:16' }); expect(log[0].outcome).toEqual({ ok: true });
  const saved = await savedDoc(page, id); expect(saved.size).toEqual({ width: 1080, height: 1920 }); expect(saved.rev).toBeGreaterThan(before.rev); expect(JSON.parse(before.json).size).toEqual({ width: 1920, height: 1080 });
});

test('B3 Save is a real flush (a pending change is persisted) followed by the T17 checkpoint', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page);
  // Test setup only: leave one pending change in the session (as the T01 tests do) so the flush is observable.
  await page.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); activeSession.update({ ...activeSession.document, fps: 24 }); });
  await expect(page.getByRole('status')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // T17 (was: notice "Saving a checkpoint is not yet implemented (T17)." and outcome feature / T17 / NOT_IMPLEMENTED): Save writes one checkpoint of the flushed document.
  await expect.poll(() => page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return ((await projectStore.row('settings', `checkpoints:${id}`))?.checkpoints ?? []).map((c: any) => c.editorState.fps); }, id)).toEqual([24]);
  await expect(page.getByRole('status')).toHaveText('Saved locally');
  expect(JSON.parse((await stored(page, id)).json).fps).toBe(24); expect((await stored(page, id)).rev).toBe(1);
  expect((await intents(page)).map(l => [l.intent.type, l.outcome.ok])).toEqual([['saveCheckpoint', true]]);
});

test('B4 preview: stage at the project aspect, empty-project upload target is real, non-empty shows the T15 frame, Reset view, quality Full / 1/2 / 1/4 per browser', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); const id = await openEditor(page, richDoc()); const stage = page.locator('.stage');
  await expect(stage).toHaveCSS('aspect-ratio', '1920 / 1080'); await expect(stage.locator('canvas.run').first()).toHaveAttribute('data-frame', '0'); await expect(stage.locator('canvas.run').first()).toHaveAttribute('data-exact', 'false'); await expect(page.getByRole('button', { name: 'Add media' })).toHaveCount(0); // T15 (was: "Preview rendering is not yet implemented (T15)." visible; then data-exact true). richDoc() has video and image items with no media, so each source is 'failed' and draws grey MISSING_MEDIA: a failed or placeholder frame is never data-exact="true" (P23), so wait for the paused render (data-frame 0) and expect "false"
  // Reset view (fit) returns the preview zoom to 1.
  const preview = page.getByRole('region', { name: 'Preview' }); const box = (await preview.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control');
  await expect.poll(async () => Number(await stage.getAttribute('data-scale'))).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Reset view (fit)' }).click(); await expect(stage).toHaveAttribute('data-scale', '1');
  // Quality: default Full; choose 1/2 → stored, survives reload, applies to another project too.
  const quality = page.getByRole('button', { name: /^Preview quality:/ }); await expect(quality).toHaveAccessibleName('Preview quality: Full'); await quality.click();
  await expect(page.getByRole('menuitemradio')).toHaveText(['Full', '1/2 (smoother on slow machines)', '1/4 (smoothest)']); await expect(page.getByRole('menuitemradio', { name: 'Full' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: /^1\/2/ }).click(); await expect(quality).toHaveAccessibleName('Preview quality: 1/2');
  expect(await page.evaluate(() => localStorage.getItem('cutframe:preview-quality'))).toBe('half');
  await page.reload(); await expect(page.getByRole('button', { name: 'Preview quality: 1/2' })).toBeVisible();
  const other = await openEditor(page, undefined, 'Empty one'); await expect(page.getByRole('button', { name: 'Preview quality: 1/2' })).toBeVisible();
  // Empty project: portrait stage and a real "+" upload (a valid PNG through the file input).
  await expect(page.locator('.stage')).toHaveCSS('aspect-ratio', '1080 / 1920'); await expect(page.getByText('Click to upload, or drag and drop media here.')).toBeVisible();
  const before = await stored(page, other);
  await page.getByLabel('Upload media to this project').setInputFiles({ name: 'drop.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await expect.poll(() => page.evaluate(async id => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.projectAssets(id)).length; }, other)).toBe(1);
  expect((await stored(page, other)).json).toBe(before.json); expect(id).toBeTruthy();
});

test('B4 a fresh browser starts with Preview quality Full', async ({ page }) => {
  await openEditor(page, richDoc()); expect(await page.evaluate(() => localStorage.getItem('cutframe:preview-quality'))).toBeNull(); await expect(page.getByRole('button', { name: 'Preview quality: Full' })).toBeVisible();
});

test('C1/C2/C3 compact layout at 1023 px, wide at 1024; tabs follow the selection; video tab → sheet with one section; Escape and backdrop close it and keep the selection', async ({ page }) => {
  await page.setViewportSize({ width: 1023, height: 800 }); await openEditor(page, richDoc());
  await expect(page.getByRole('complementary')).toHaveCount(0); await expect(page.getByRole('navigation', { name: 'Tools' })).toHaveCount(0);
  const tabs = page.getByRole('navigation', { name: 'Editor panels' }).getByRole('tab');
  await expect(tabs).toHaveText(['Uploads', 'Texts', 'Motion', 'Shapes', 'Captions', 'Effects']);
  await clip(page, 'clipA').click(); await expect(tabs).toHaveText(['Basic', 'Speed', 'Transform', 'Appearance', 'Mask', 'Shadow']);
  for (const [tab, section] of [['Basic', 'Basic'], ['Speed', 'Speed & Time Remap'], ['Transform', 'Transform'], ['Appearance', 'Appearance'], ['Mask', 'Mask'], ['Shadow', 'Shadow']]) {
    await tabs.filter({ hasText: new RegExp(`^${tab}$`) }).click(); const drawer = page.getByRole('dialog', { name: tab });
    await expect(drawer.locator('details')).toHaveCount(1); await expect(drawer.locator('details[open] > summary')).toHaveText(section); await expect(drawer.getByRole('button', { name: 'Keyframes graph' })).toBeVisible(); await expect(drawer.locator('strong', { hasText: 'Remove Background' })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(clip(page, 'clipA')).toHaveAttribute('aria-selected', 'true');
  }
  await tabs.filter({ hasText: /^Basic$/ }).click(); await expect(page.getByRole('dialog', { name: 'Basic' })).toBeVisible();
  await page.mouse.click(8, 8); await expect(page.getByRole('dialog')).toHaveCount(0); expect(await viewState(page, v => v.selection)).toEqual(['clipA']); // backdrop tap
  await clip(page, 'title').click(); await expect(tabs).toHaveText(['Preset', 'Text', 'Animation', 'Basic', 'Transform', 'Stroke', 'Shadow']);
  await tabs.filter({ hasText: /^Stroke$/ }).click(); await expect(page.getByRole('dialog', { name: 'Stroke' }).locator('details[open] > summary')).toHaveText('Font Stroke'); await page.keyboard.press('Escape');
  // Nothing-selected tabs: Uploads is the Footage tab; Effects lists the 39 effects with the hint.
  await page.locator('.lane').first().click({ position: { x: 600, y: 10 } });
  await tabs.filter({ hasText: /^Uploads$/ }).click(); await expect(page.getByRole('dialog', { name: 'Uploads' }).getByRole('region', { name: 'Footage' })).toBeVisible(); await page.keyboard.press('Escape');
  await tabs.filter({ hasText: /^Effects$/ }).click(); await expect(page.getByRole('dialog', { name: 'Effects' }).getByRole('listitem')).toHaveCount(39); await expect(page.getByRole('dialog', { name: 'Effects' })).toContainText('Select a timeline item first'); await page.keyboard.press('Escape');
  // T06 (C8 assertion-only edit): the Shapes tab opens the built Shapes panel.
  await tabs.filter({ hasText: /^Shapes$/ }).click(); await expect(page.getByRole('dialog', { name: 'Shapes' }).getByRole('button', { name: 'Draw', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  // 1024 px: the same page switches to the wide layout without a reload.
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(page.getByRole('complementary', { name: 'Left panel' })).toBeVisible(); await expect(page.getByRole('navigation', { name: 'Tools' })).toBeVisible(); await expect(page.getByRole('navigation', { name: 'Editor panels' })).toHaveCount(0);
  await page.setViewportSize({ width: 1023, height: 800 }); await expect(page.getByRole('navigation', { name: 'Editor panels' })).toBeVisible(); await expect(page.getByRole('complementary', { name: 'Left panel' })).toHaveCount(0);
});

test('C1 compact tabs for a selected video are the same with the other widths (the threshold is the width, not the selection)', async ({ page }) => {
  for (const [width, compact] of [[1023, true], [1024, false], [600, true], [1400, false]] as const) {
    await page.setViewportSize({ width, height: 800 }); await openEditor(page, richDoc()); await clip(page, 'clipA').click();
    await expect(page.getByRole('navigation', { name: 'Editor panels' })).toHaveCount(compact ? 1 : 0); await expect(page.getByRole('complementary', { name: 'Left panel' })).toHaveCount(compact ? 0 : 1);
  }
});

test('C4 an empty-lane click deselects; Escape does not', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); await openEditor(page, richDoc());
  await clip(page, 'clipA').click(); expect(await viewState(page, v => v.selection)).toEqual(['clipA']);
  await blurAll(page); await clip(page, 'clipA').focus(); await page.keyboard.press('Escape'); expect(await viewState(page, v => v.selection)).toEqual(['clipA']); await expect(clip(page, 'clipA')).toHaveAttribute('aria-selected', 'true');
  const lane = page.locator('.lane[data-track-id="o3"]'), box = (await lane.boundingBox())!; await page.mouse.click(box.x + 60, box.y + 10); // empty lane
  expect(await viewState(page, v => v.selection)).toEqual([]); await expect(clip(page, 'clipA')).toHaveAttribute('aria-selected', 'false');
  await clip(page, 'clipB').click(); await page.locator('.drop-below').click({ position: { x: 50, y: 5 } }); expect(await viewState(page, v => v.selection)).toEqual([]);
});

test('H1 editor tour: first visit shows "1 of N", Next advances, Skip stores the seen flag; not shown again after reload', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(); const id = await createProject(page, richDoc());
  await page.goto(`/project/${id}`); const tour = page.getByRole('dialog', { name: 'Editor tour' }); await expect(tour).toBeVisible({ timeout: 10000 });
  await expect(tour.getByText('1 of 4')).toBeVisible(); await expect(tour.getByRole('heading')).toHaveText('Your footage');
  // The highlighted anchor exists for each step (data-tour anchors).
  for (const anchor of ['footage', 'reference-tab', 'timeline', 'agent-badge']) await expect(page.locator(`[data-tour="${anchor}"]`)).toHaveCount(1);
  await tour.getByRole('button', { name: 'Next' }).click(); await expect(tour.getByText('2 of 4')).toBeVisible(); await expect(tour.getByRole('heading')).toHaveText('Reference videos');
  await tour.getByRole('button', { name: 'Next' }).click(); await tour.getByRole('button', { name: 'Next' }).click(); await expect(tour.getByText('4 of 4')).toBeVisible(); await expect(tour.getByRole('button', { name: 'Done' })).toBeVisible();
  await tour.getByRole('button', { name: 'Skip tour' }).click(); await expect(tour).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('cutframe:tour:editor'))).toBe('skipped');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally'); await page.waitForTimeout(1500); await expect(page.getByRole('dialog', { name: 'Editor tour' })).toHaveCount(0);
  await context.close();
});

test('H1 finishing the tour with Done stores "done"', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(); const id = await createProject(page, richDoc());
  await page.goto(`/project/${id}`); const tour = page.getByRole('dialog', { name: 'Editor tour' }); await expect(tour).toBeVisible({ timeout: 10000 });
  for (let n = 0; n < 3; n++) await tour.getByRole('button', { name: 'Next' }).click();
  await tour.getByRole('button', { name: 'Done' }).click(); await expect(tour).toHaveCount(0); expect(await page.evaluate(() => localStorage.getItem('cutframe:tour:editor'))).toBe('done'); await context.close();
});

test('H2 Background Jobs: count badge, collapse, "No active jobs", failed preparation row with Retry and Dismiss', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); const id = await createProject(page, richDoc()); await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  const jobs = page.getByRole('region', { name: 'Background Jobs' }), header = jobs.getByRole('button', { name: /^Background Jobs/ });
  await expect(header).toHaveAttribute('aria-expanded', 'false'); await expect(jobs.getByLabel('0 jobs')).toHaveText('0'); await header.click(); await expect(jobs.getByText('No active jobs')).toBeVisible(); await header.click(); await expect(jobs.getByText('No active jobs')).toHaveCount(0);
  const asset = await addAsset(page, id, 'broken.png', { failed: true });
  await expect(jobs.getByLabel('1 jobs, some failed')).toBeVisible({ timeout: 10000 }); await header.click();
  const row = jobs.getByRole('listitem'); await expect(row).toHaveCount(1); await expect(row).toContainText('Preparing broken.png'); await expect(row).toContainText('PREPARATION_FAILED'); await expect(row).toHaveAttribute('data-state', 'failed');
  await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible(); await expect(row.getByRole('button', { name: 'Dismiss' })).toBeVisible(); await expect(row.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Dismiss' }).click(); await expect(jobs.getByText('No active jobs')).toBeVisible(); await expect(jobs.getByLabel('0 jobs')).toBeVisible();
  // Retry starts a real preparation attempt for the asset (the tiny image has no decoder step that can fail offline).
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally'); await header.click(); await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => page.evaluate(async id => { const p = '/src/store/database.ts'; const a = (await (await import(p)).projectStore.library()).assets.find((x: any) => x.id === id); return `${a.processing_status}:${a.preparationAttempts ?? 0}`; }, asset), { timeout: 20000 }).not.toBe('failed:0');
});

test('H2 a running preparation is a row with progress and no Retry; the badge counts it as running', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); const id = await createProject(page, richDoc());
  const asset = await page.evaluate(async ({ id, png }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p); const a = await projectStore.upload(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'busy.png', { type: 'image/png' }));
    // A user-cancelled record holds the asset (review R12), so the load-time resume of the second tab cannot claim it with
    // default steps before the held attempt below (CI run 41222498482); that attempt claims it as an explicit Retry.
    await projectStore.swapRow('preparations', a.id, () => ({ id: a.id, attemptId: 'seed', phase: 'cancelled', startedAt: 0, updatedAt: 0, sourceRevision: null, budgetMs: 0, code: 'CLIENT_PREPARATION_CANCELLED', cancelledBy: 'user' }));
    await projectStore.updateAsset(a.id, (x: any) => ({ ...x, processing_status: 'processing', processing_steps: { upload: 'complete', probe: 'complete', thumbnails: 'processing' } })); await projectStore.attach(id, a.id); return a.id as string;
  }, { id, png: TINY_PNG });
  const other = await page.context().newPage(); await other.goto('/');
  await other.evaluate(async asset => { const db = '/src/store/database.ts', prep = '/src/media/prepare.ts'; const { projectStore } = await import(db); (window as any).__busy = (await import(prep)).prepareAsset(projectStore, asset, { manual: true, steps: { probe: () => new Promise(() => {}) } }); }, asset);
  // Wait for the other tab's last write (probe → processing, after phase → running) so the overwrite below cannot race it (CI run 41222498482).
  await expect.poll(() => other.evaluate(async asset => { const db = '/src/store/database.ts'; const { projectStore } = await import(db); const a = (await projectStore.library()).assets.find((x: any) => x.id === asset); return `${(await projectStore.row('preparations', asset))?.phase}:${a?.processing_steps?.probe}`; }, asset)).toBe('running:processing');
  await page.evaluate(async asset => { const db = '/src/store/database.ts'; await (await import(db)).projectStore.updateAsset(asset, (a: any) => ({ ...a, processing_steps: { upload: 'complete', probe: 'complete', thumbnails: 'processing' } })); }, asset);
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); const jobs = page.getByRole('region', { name: 'Background Jobs' });
  await expect(jobs.locator('.count')).toHaveClass(/running/, { timeout: 10000 }); await jobs.getByRole('button', { name: /^Background Jobs/ }).click(); const row = jobs.getByRole('listitem').first();
  await expect(row).toContainText('Preparing busy.png'); await expect(row).toHaveAttribute('data-state', 'running'); await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0); await expect(row.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  const progress = row.getByRole('progressbar', { name: 'Preparing busy.png progress' }); await expect(progress).toHaveAttribute('value', String(2 / 3)); await expect(progress).toHaveAttribute('max', '1');
  await expect(row.getByRole('button', { name: 'Cancel' })).toHaveCount(0); // another tab's attempt
  await page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); await projectStore.updateAsset(id, (a: any) => ({ ...a, processing_steps: { ...a.processing_steps, probe: 'processing' } })); }, asset);
  await expect(progress).toHaveAttribute('value', String(1 / 3), { timeout: 10000 });
  await other.evaluate(async asset => { const p = '/src/media/prepare.ts'; (await import(p)).cancelPreparation(asset); await (window as any).__busy; }, asset); await other.close();
});

test('R2 stage physically fits landscape, portrait and square at both breakpoint widths, including reset', async ({ page }) => {
  for (const width of [1023, 1024]) for (const size of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
    await page.setViewportSize({ width, height: 800 }); await openEditor(page, richDoc({ size }));
    const stage = page.locator('.stage'), preview = page.getByRole('region', { name: 'Preview' });
    const check = async () => {
      const s = (await stage.boundingBox())!, p = (await preview.boundingBox())!;
      expect(s.width / s.height, `${width} ${size.width}x${size.height}`).toBeCloseTo(size.width / size.height, 2);
      expect(s.x).toBeGreaterThanOrEqual(p.x - 1); expect(s.y).toBeGreaterThanOrEqual(p.y - 1);
      expect(s.x + s.width).toBeLessThanOrEqual(p.x + p.width + 1); expect(s.y + s.height).toBeLessThanOrEqual(p.y + p.height + 1);
    };
    await check(); const p = (await preview.boundingBox())!; await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control');
    await expect.poll(async () => Number(await stage.getAttribute('data-scale'))).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Reset view (fit)' }).click(); await expect(stage).toHaveAttribute('data-scale', '1'); await check();
  }
});

test('R7 guard rejects both live in-place mutation and a pending session update', async ({ page }) => {
  const id = await openEditor(page, richDoc()), before = await stored(page, id);
  await page.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); activeSession.document.fps = 24; });
  await expect(expectUntouched(page, id, before)).rejects.toThrow();
  await page.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); activeSession.document.fps = 30; activeSession.update({ ...activeSession.document, fps: 24 }); });
  await expect(expectUntouched(page, id, before)).rejects.toThrow();
});

test('R8 a short project fits at a maximum zoom of 1 in a wide viewport', async ({ page }) => {
  await page.setViewportSize({ width: 4096, height: 1000 }); await openEditor(page);
  await page.getByRole('button', { name: 'Zoom to fit', exact: true }).click(); expect(await viewState(page, v => v.zoom)).toBeLessThanOrEqual(1);
  const before = await viewState(page, v => v.zoom); await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); expect(await viewState(page, v => v.zoom)).toBeGreaterThanOrEqual(before);
});

test('R4 Cancel stops this tab preparation without budget use or auto-resume; Retry starts a new attempt', async ({ page }) => {
  const id = await openEditor(page, richDoc()); const asset = await addAsset(page, id, 'cancel-me.png');
  await page.evaluate(async asset => {
    const db = '/src/store/database.ts', prep = '/src/media/prepare.ts'; const { projectStore } = await import(db); const { prepareAsset } = await import(prep);
    let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    const preparation = prepareAsset(projectStore, asset, { steps: { probe: () => { enter(); return new Promise(() => {}); } } });
    (window as any).__preparation = preparation;
    await Promise.race([entered, preparation.then((result: string) => { throw new Error(`test preparation ended before probe: ${result}`); })]);
    await projectStore.updateAsset(asset, (a: any) => ({ ...a, processing_status: 'processing' }));
  }, asset);
  const read = () => page.evaluate(async asset => { const db = '/src/store/database.ts'; const { projectStore } = await import(db); return { asset: await projectStore.row('assets', asset), record: await projectStore.row('preparations', asset) } as any; }, asset);
  await expect.poll(async () => (await read()).record?.phase).toBe('running'); const initial = await read(); expect(initial.asset.processing_status).toBe('processing');
  const jobs = page.getByRole('region', { name: 'Background Jobs' }); await expect(jobs.getByLabel('1 jobs')).toBeVisible({ timeout: 10000 }); await jobs.getByRole('button', { name: /^Background Jobs/ }).click(); const row = jobs.getByRole('listitem').filter({ hasText: 'cancel-me.png' });
  await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible({ timeout: 10000 }); await row.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__preparation)).toBe('failed'); await expect(row).toHaveAttribute('data-state', 'cancelled', { timeout: 10000 }); await expect(row).toContainText('Cancelled');
  const cancelled = await read(); expect(cancelled.record).toMatchObject({ phase: 'cancelled', cancelledBy: 'user', attemptId: initial.record.attemptId }); expect(cancelled.asset.last_error_code).toBe('CLIENT_PREPARATION_CANCELLED'); expect(cancelled.asset.preparationAttempts ?? 0).toBe(initial.asset.preparationAttempts ?? 0);
  const probes = await page.evaluate(async () => { const db = '/src/store/database.ts', prep = '/src/media/prepare.ts'; const { projectStore } = await import(db); let calls = 0; await (await import(prep)).resumePreparations(projectStore, { steps: { probe: async () => { calls++; throw new Error('unexpected auto-resume'); } } }); return calls; });
  expect(probes).toBe(0); expect((await read()).record.attemptId).toBe(initial.record.attemptId); await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible();
  await row.getByRole('button', { name: 'Retry' }).click(); await expect.poll(async () => (await read()).record.attemptId, { timeout: 20000 }).not.toBe(initial.record.attemptId);
});

// R12: a user's Cancel committed while an automatic rescan is mid-flight must stay cancelled. The proxy only schedules the rescan's two reads; the store,
// native locks and preparation service are real, and the held probe supplies the controlled running interval.
for (const boundary of ['before-preparations-read', 'assets-query-start', 'assets-query-end', 'claim'] as const) {
  test(`R12 an automatic rescan cannot restart an asset the user cancelled (cancel at ${boundary}); explicit Retry is still allowed`, async ({ page }) => {
    const id = await openEditor(page, richDoc()), assetId = await addAsset(page, id, 'scan-cancel.png');
    const result = await page.evaluate(async ({ assetId, boundary }) => {
      const db = '/src/store/database.ts', prep = '/src/media/prepare.ts';
      const { projectStore } = await import(db), { prepareAsset, cancelPreparation, resumePreparations } = await import(prep);
      let entered!: () => void; const probeEntered = new Promise<void>(r => { entered = r; });
      const original = prepareAsset(projectStore, assetId, { steps: { probe: () => { entered(); return new Promise(() => {}); } } });
      // Claim while ready, before startup recovery can nominate this fixture for automatic preparation.
      await Promise.race([probeEntered, original.then((result: string) => { throw new Error(`test preparation ended before probe: ${result}`); })]);
      await projectStore.updateAsset(assetId, (a: any) => ({ ...a, processing_status: 'processing' }));
      const initial: any = await projectStore.row('preparations', assetId);
      let reached!: () => void, release!: () => void; const atBoundary = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { release = r; });
      const rescanStore = new Proxy(projectStore, { get(target, key) {
        if (key === 'rows') return async (name: any) => {
          if (boundary === 'before-preparations-read' && name === 'preparations') { reached(); await gate; return target.rows(name); }
          if (name !== 'assets') return target.rows(name);
          if (boundary === 'assets-query-start') { reached(); await gate; return target.rows(name); }
          const rows = await target.rows(name); if (boundary === 'assets-query-end') { reached(); await gate; } return rows;
        };
        // 'claim': the scan has read both snapshots and is inside prepareAsset's claim transaction when the cancel commits.
        if (key === 'swapRow' && boundary === 'claim') return async (...args: any[]) => { reached(); await gate; return (target as any).swapRow(...args); };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      let rescanProbes = 0;
      const scan = resumePreparations(rescanStore, { steps: { probe: async () => { rescanProbes++; throw new Error('automatic rescan restarted the cancelled asset'); } } });
      await atBoundary;
      const accepted = cancelPreparation(assetId); const originalResult = await original;
      const cancelled: any = await projectStore.row('preparations', assetId), cancelledAsset: any = await projectStore.row('assets', assetId);
      release(); await scan;
      const after: any = await projectStore.row('preparations', assetId), afterAsset: any = await projectStore.row('assets', assetId);
      // Explicit manual Retry may replace the cancelled record.
      let retryEntered!: () => void; const retryStarted = new Promise<void>(r => { retryEntered = r; });
      const retry = prepareAsset(projectStore, assetId, { manual: true, steps: { probe: () => { retryEntered(); return new Promise(() => {}); } } });
      await Promise.race([retryStarted, retry.then((result: string) => { throw new Error(`manual retry ended before probe: ${result}`); })]); const retrying: any = await projectStore.row('preparations', assetId); cancelPreparation(assetId); await retry;
      return { accepted, originalResult, initial, cancelled, cancelledAsset, after, afterAsset, rescanProbes, retrying };
    }, { assetId, boundary });
    expect(result.accepted).toBe(true); expect(result.originalResult).toBe('failed');
    expect(result.cancelled).toMatchObject({ phase: 'cancelled', cancelledBy: 'user', attemptId: result.initial.attemptId }); expect(result.cancelledAsset.preparationAttempts ?? 0).toBe(0);
    expect(result.rescanProbes).toBe(0); // no automatic probe, so no new attempt and no budget use
    expect(result.after).toMatchObject({ phase: 'cancelled', cancelledBy: 'user', attemptId: result.initial.attemptId }); expect(result.afterAsset.preparationAttempts ?? 0).toBe(0);
    expect(result.retrying.phase).toBe('running'); expect(result.retrying.attemptId).not.toBe(result.initial.attemptId);
  });
}

// R14: the Background Jobs row follows the real manual-Retry attempt, not the stale failed asset status.
test('R14 Cancel → manual Retry (held local attempt) shows Running with Cancel and no Retry/Dismiss; a second Cancel settles the record, state and budget', async ({ page }) => {
  const id = await openEditor(page, richDoc()), assetId = await addAsset(page, id, 'retry-cancel.png');
  const read = () => page.evaluate(async assetId => { const db = '/src/store/database.ts'; const { projectStore } = await import(db); return { asset: await projectStore.row('assets', assetId), record: await projectStore.row('preparations', assetId) } as any; }, assetId);
  await page.evaluate(async assetId => {
    const db = '/src/store/database.ts', prep = '/src/media/prepare.ts';
    const { projectStore } = await import(db), { prepareAsset, cancelPreparation } = await import(prep);
    let enter!: () => void; const firstEntered = new Promise<void>(r => { enter = r; });
    const first = prepareAsset(projectStore, assetId, { steps: { probe: () => { enter(); return new Promise(() => {}); } } });
    await Promise.race([firstEntered, first.then((result: string) => { throw new Error(`test preparation ended before probe: ${result}`); })]);
    await projectStore.updateAsset(assetId, (a: any) => ({ ...a, processing_status: 'processing' }));
    cancelPreparation(assetId); await first;
  }, assetId);
  const cancelledOnce = await read(); expect(cancelledOnce.record).toMatchObject({ phase: 'cancelled', cancelledBy: 'user' });
  await page.evaluate(async assetId => {
    const db = '/src/store/database.ts', prep = '/src/media/prepare.ts'; const { projectStore } = await import(db), { prepareAsset } = await import(prep);
    let retryEnter!: () => void; const retryEntered = new Promise<void>(r => { retryEnter = r; });
    const retry = prepareAsset(projectStore, assetId, { manual: true, steps: { probe: () => { retryEnter(); return new Promise(() => {}); } } });
    (window as any).__r14retry = retry;
    await Promise.race([retryEntered, retry.then((result: string) => { throw new Error(`manual retry ended before probe: ${result}`); })]);
  }, assetId);
  const running = await read(); expect(running.record.phase).toBe('running'); expect(running.record.attemptId).not.toBe(cancelledOnce.record.attemptId);
  const jobs = page.getByRole('region', { name: 'Background Jobs' }); await jobs.getByRole('button', { name: /^Background Jobs/ }).click();
  const row = jobs.getByRole('listitem').filter({ hasText: 'retry-cancel.png' }); await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-state', 'running'); await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0); await expect(row.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__r14retry)).toBe('failed');
  await expect(row).toHaveAttribute('data-state', 'cancelled', { timeout: 10000 }); await expect(row.getByRole('button', { name: 'Retry', exact: true })).toBeVisible(); await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  const settled = await read();
  expect(settled.record).toMatchObject({ phase: 'cancelled', cancelledBy: 'user', attemptId: running.record.attemptId });
  expect(settled.asset.processing_status).toBe('failed'); expect(settled.asset.last_error_code).toBe('CLIENT_PREPARATION_CANCELLED');
  expect(settled.asset.preparationAttempts ?? 0).toBe(cancelledOnce.asset.preparationAttempts ?? 0); // cancellation consumes no budget
  const probes = await page.evaluate(async () => { const db = '/src/store/database.ts', prep = '/src/media/prepare.ts'; const { projectStore } = await import(db); let calls = 0; await (await import(prep)).resumePreparations(projectStore, { steps: { probe: async () => { calls++; throw new Error('unexpected auto-resume'); } } }); return calls; });
  expect(probes).toBe(0); expect((await read()).record.attemptId).toBe(running.record.attemptId); // the second cancel also stays cancelled for an automatic rescan
});

// A lifecycle-only cancel (pagehide, no user Cancel) is not a user's Cancel: the visible rescan resumes it with a new attempt (T14 F11/F19 behaviour retained).
test('R12 a lifecycle-only cancel (pagehide → visible again) still auto-resumes with a new attempt', async ({ page }) => {
  const id = await openEditor(page, richDoc()), assetId = await addAsset(page, id, 'lifecycle.png');
  const read = () => page.evaluate(async assetId => { const db = '/src/store/database.ts'; const { projectStore } = await import(db); return { asset: await projectStore.row('assets', assetId), record: await projectStore.row('preparations', assetId) } as any; }, assetId);
  await page.evaluate(async assetId => {
    const db = '/src/store/database.ts', prep = '/src/media/prepare.ts'; const { projectStore } = await import(db), { prepareAsset } = await import(prep);
    let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    const preparation = prepareAsset(projectStore, assetId, { steps: { probe: () => { enter(); return new Promise(() => {}); } } });
    (window as any).__lifecycle = preparation;
    await Promise.race([entered, preparation.then((result: string) => { throw new Error(`test preparation ended before probe: ${result}`); })]);
    await projectStore.updateAsset(assetId, (a: any) => ({ ...a, processing_status: 'processing' }));
  }, assetId);
  const initial = await read(); expect(initial.record.phase).toBe('running');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => (window as any).__lifecycle)).toBe('failed');
  const hidden = await read(); expect(hidden.record.phase).toBe('cancelled'); expect(hidden.record.cancelledBy).toBeUndefined(); expect(hidden.asset.preparationAttempts ?? 0).toBe(0);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // the page is visible again: the app's bound rescan runs
  await expect.poll(async () => (await read()).record.attemptId, { timeout: 20000 }).not.toBe(initial.record.attemptId);
});

test('H3 Ctrl+Shift+P performance overlay: FPS, memory, Videos = the number of <video> elements; collapses; toggles off', async ({ page }) => {
  await openEditor(page, richDoc()); await blurAll(page);
  await expect(page.getByRole('complementary', { name: 'Performance' })).toHaveCount(0);
  await page.keyboard.press('Control+Shift+P'); const overlay = page.getByRole('complementary', { name: 'Performance' }); await expect(overlay).toBeVisible();
  await expect(overlay.locator('dt')).toHaveText(['FPS', 'Memory', 'Videos']); await expect.poll(async () => Number(await overlay.locator('[data-stat="fps"]').textContent()), { timeout: 5000 }).toBeGreaterThan(0);
  await expect(overlay.locator('[data-stat="videos"]')).toHaveText('0');
  await page.evaluate(() => { for (let n = 0; n < 3; n++) document.body.append(document.createElement('video')); });
  await expect(overlay.locator('[data-stat="videos"]')).toHaveText('3', { timeout: 3000 });
  await page.evaluate(() => { document.getElementsByTagName('video')[0].remove(); }); await expect(overlay.locator('[data-stat="videos"]')).toHaveText('2', { timeout: 3000 });
  expect(await overlay.locator('[data-stat="memory"]').textContent()).toMatch(/^(n\/a|\d+\.\d MB)$/);
  await overlay.getByRole('button', { name: 'Collapse performance' }).click(); await expect(overlay.locator('dl')).toHaveCount(0); await overlay.getByRole('button', { name: 'Expand performance' }).click(); await expect(overlay.locator('dl')).toBeVisible();
  await blurAll(page); await page.keyboard.press('Control+Shift+P'); await expect(overlay).toHaveCount(0);
});

test('H4 our shortcut overlay opens with ? and from Help → Keyboard shortcuts, lists the map, closes with Escape', async ({ page }) => {
  await openEditor(page, richDoc()); await blurAll(page); await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' }); await expect(dialog).toBeVisible();
  for (const text of ['Play / pause', 'Step one frame', 'Split at the playhead', 'Add a marker', 'Show or hide markers', 'Clear all markers', 'Performance overlay', 'Zoom in', 'Zoom out']) await expect(dialog).toContainText(text);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Help', exact: true }).click(); await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click(); await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: 'Close Keyboard shortcuts' }).click(); await expect(dialog).toHaveCount(0);
});

test('I1 no provider and no remote request: a full tour of the shell makes only localhost requests and changes no document', async ({ page }) => {
  const leaks = guard(page); await page.setViewportSize({ width: 1280, height: 800 }); const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id);
  const rail = page.getByRole('navigation', { name: 'Tools' });
  for (const tool of ['Text', 'Motion graphics', 'Shapes', 'Layouts', 'Captions', 'Effects', 'Style presets', 'Voice-over']) await rail.getByRole('tab', { name: tool, exact: true }).click();
  await clip(page, 'clipA').click(); await page.getByRole('button', { name: 'Play', exact: true }).click(); await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible(); await expect(notices(page)).toContainText('Export is not yet implemented (T16).'); // T15 (was: notice "Playback is not yet implemented (T15).")
  const log = await intents(page); expect(log.length).toBeGreaterThan(1); expect(log.filter(l => l.intent.type === 'togglePlayback').map(l => l.outcome)).toEqual([{ ok: true }]); // T15: Play is real
  for (const l of log.filter(l => l.intent.type !== 'togglePlayback')) { expect(l.outcome.ok).toBe(false); expect(l.outcome.code).toBe('NOT_IMPLEMENTED'); expect(l.outcome.owner).toMatch(/^T\d\d$/); }
  await expectUntouched(page, id, before); expect(await sessionState(page)).toBe('saved'); expect(leaks).toEqual([]);
  await clearIntents(page); await setViewState(page, { playheadMs: 0 });
});
