// SPDX-License-Identifier: AGPL-3.0-only
// T04 UI <-> tool parity (ticket T04 acceptance, product contract promise 2; T03 two-path pattern). Each pair starts from the SAME document in two fresh editor
// sessions: the UI path drives the REAL inspector / graph controls, the tool path calls `activeRuntime.call(tool, args)` (source 'agent'). Both must give identical
// project JSON (new keyframe ids mapped by order of appearance, `rev` ignored), the same undo label, exactly one undo entry, and an undo that restores the original.
// Written-spec oracle: tools speak timeline seconds (findings part 2 tool results, writeKeyframes / setTimeRemap / editProperties); labels from part 3 §45.1
// (changeSpeed "Change speed", every other keyframe / property edit "Edit items"; editProperties {playbackRate} is "Change speed").
// The tool arguments are written by hand from those tool contracts, never read back from product output, except where the UI result is a pointer drag whose exact
// time / value cannot be known in advance (the pair says so).
// provisional choice, not Xapp parity: there is no changeSpeed tool and no tool carries ripple, so the ripple-mode speed pair compares the UI in ripple mode with the
// plain editProperties {playbackRate} call on a clip that has nothing after it (ripple has nothing to move).
import { test, expect, type Page } from '@playwright/test';
import { openEditor, setViewState, skipTour } from './t02-support';
import { liveDoc, undoEntries, type Entry } from './t03-support';
import { centre, dblclickOnCurve, dragTo, keyframeIds, kf, normal, panel, pick, playhead, prop, runtimeCall, section, t04Doc, typeValue } from './t04-support';

test.beforeEach(async ({ page }) => { await skipTour(page); });

type Result = { original: any; entries: Entry[]; after: any; restored: any };
type Pair = {
  name: string; doc: () => any; label: string; toolLabel?: string; note?: string;
  ui: (page: Page) => Promise<void>;
  tool: (ui: Result) => [string, Record<string, unknown>];
  /** Compare keyframes by time with ids dropped (a drag keeps the keyframe id; the tool path removes and adds). */
  byTime?: boolean;
};
const norev = (d: any) => ({ ...d, rev: 0 });
const vid = (d: any) => d.items.find((i: any) => i.id === 'vid');
const undoWith = (page: Page, source: 'user' | 'agent') => page.evaluate(async source => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); activeRuntime.bus.undo(source); }, source);

async function runUi(page: Page, pair: Pair): Promise<Result> {
  await openEditor(page, pair.doc()); await pick(page, 'vid');
  const original = await liveDoc(page);
  await pair.ui(page);
  await expect.poll(async () => (await undoEntries(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
  const entries = await undoEntries(page), after = await liveDoc(page);
  await undoWith(page, 'user');
  return { original, entries, after, restored: await liveDoc(page) };
}
async function runTool(page: Page, pair: Pair, ui: Result): Promise<Result> {
  await openEditor(page, pair.doc());
  const original = await liveDoc(page), [name, args] = pair.tool(ui);
  const out = await runtimeCall(page, name, args); expect(out?.success !== false, `tool result ${JSON.stringify(out)}`).toBe(true);
  const entries = await undoEntries(page), after = await liveDoc(page);
  await undoWith(page, 'agent');
  return { original, entries, after, restored: await liveDoc(page) };
}
/** Keyframe lists sorted by time with ids dropped (only for `byTime` pairs). */
const canon = (doc: any) => {
  const walk = (v: any, key?: string): any => Array.isArray(v) ? (key === 'keyframes' ? [...v].sort((a, b) => a.time - b.time).map(({ id, ...rest }) => walk(rest)) : v.map(x => walk(x)))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)])) : v;
  return { ...walk(doc), rev: 0 };
};

// ---- fixtures and UI drivers.
const OPACITY = () => [kf('k1', 0, 1), kf('k2', 2000, 0.5), kf('k3', 4000, 0)];
const opacityDoc = (list: unknown[] = OPACITY()) => t04Doc({ vid: { properties: { opacity: prop(1, list) } } });
const remapDoc = () => t04Doc({ vid: { timeRemap: { defaultValue: 0, keyframes: [kf('r1', 0, 0), kf('r2', 4000, 4000)] } } });
const SHADOW = { x: 3, y: 2, blur: 4, color: '#112233' };
const shadowDoc = () => t04Doc({ vid: { properties: { boxShadow: prop(SHADOW) } } });
const gdialog = (page: Page, name: string) => page.getByRole('dialog', { name });
const openGraph = async (page: Page, name: string) => { await panel(page).getByRole('button', { name: 'Keyframes graph' }).click(); await expect(gdialog(page, name)).toBeVisible(); return gdialog(page, name); };
const editProps = (properties: Record<string, unknown>): [string, Record<string, unknown>] => ['editProperties', { itemId: 'vid', properties }];
/** Timeline seconds of a stored clip-relative keyframe time on the fixture clip (display from 1 s, trim from 0, rate 1). */
const tl = (ms: number) => (1000 + ms) / 1000;

const PAIRS: Pair[] = [
  // 1. Opacity slider commit with no keyframes.
  { name: 'Opacity slider commit, no keyframes <-> editProperties {opacity}', doc: () => t04Doc(), label: 'Edit items',
    ui: async page => { await typeValue(await section(page, 'Basic'), 'Opacity', '50'); }, tool: () => editProps({ opacity: 0.5 }) },
  // 2. Diamond adds a linear keyframe at the playhead holding the value there.
  { name: 'diamond "Add Opacity keyframe" at the playhead <-> writeKeyframes add (same time, linear, held value)', doc: () => opacityDoc([kf('k1', 0, 1), kf('k3', 4000, 0)]), label: 'Edit items',
    ui: async page => { await playhead(page, 3000); await (await section(page, 'Basic')).getByRole('button', { name: 'Add Opacity keyframe' }).click(); },
    tool: () => ['writeKeyframes', { itemId: 'vid', payload: { opacity: { add: [{ time: 3 }] } } }] },
  // 3. Slider change while the playhead is on a keyframe rewrites that keyframe's value.
  { name: 'Opacity slider while the playhead is on a keyframe <-> writeKeyframes update (value)', doc: () => opacityDoc(), label: 'Edit items',
    ui: async page => { await playhead(page, 3000); await typeValue(await section(page, 'Basic'), 'Opacity', '40'); },
    tool: () => ['writeKeyframes', { itemId: 'vid', payload: { opacity: { update: [{ time: 3, value: 0.4 }] } } }] },
  // 4. Delete link.
  { name: '"Delete Opacity keyframe" <-> writeKeyframes remove', doc: () => opacityDoc(), label: 'Edit items',
    ui: async page => { await playhead(page, 3000); await (await section(page, 'Basic')).getByRole('button', { name: 'Delete Opacity keyframe' }).click(); },
    tool: () => ['writeKeyframes', { itemId: 'vid', payload: { opacity: { remove: [3] } } }] },
  // 5. Speed 2x, ripple mode and not.
  { name: 'Speed 2x <-> editProperties {playbackRate: 2} (the speed tool)', doc: () => t04Doc(), label: 'Change speed',
    ui: async page => { await typeValue(await section(page, 'Speed & Time Remap'), 'Speed', '2'); }, tool: () => editProps({ playbackRate: 2 }) },
  { name: 'Speed 2x in ripple mode <-> editProperties {playbackRate: 2} on a clip with nothing after it (no tool carries ripple: provisional pairing)', doc: () => t04Doc(), label: 'Change speed',
    ui: async page => { await setViewState(page, { toolMode: 'ripple' }); await typeValue(await section(page, 'Speed & Time Remap'), 'Speed', '2'); }, tool: () => editProps({ playbackRate: 2 }) },
  // 6. Time Remap on and off.
  { name: 'Time Remap switch on <-> setTimeRemap (two linear keyframes: clip start -> trim start, clip end -> trim end)', doc: () => t04Doc(), label: 'Edit items',
    ui: async page => { await (await section(page, 'Speed & Time Remap')).getByRole('switch', { name: 'Time Remap' }).click(); },
    tool: () => ['setTimeRemap', { itemId: 'vid', keyframes: [{ time: 1, value: 0 }, { time: 5, value: 4000 }] }] },
  { name: 'Time Remap switch off <-> writeKeyframes {timeRemap: {replace: []}} (clears the curve)', doc: remapDoc, label: 'Edit items',
    ui: async page => { await (await section(page, 'Speed & Time Remap')).getByRole('switch', { name: 'Time Remap' }).click(); },
    tool: () => ['writeKeyframes', { itemId: 'vid', payload: { timeRemap: { replace: [] } } }] },
  // 7. Graph actions.
  { name: 'graph Easing Preset "Ease In" <-> writeKeyframes update easing easeIn (outgoing handle cleared)', doc: () => opacityDoc([kf('k1', 0, 1), kf('k2', 2000, 0.5, 'linear', { outHandle: [0.3, 0.2] }), kf('k3', 4000, 0)]), label: 'Edit items',
    ui: async page => {
      const d = await openGraph(page, 'Opacity Graph Editor'); await d.getByRole('button', { name: 'Opacity keyframe at 2.00s', exact: true }).click(); await d.getByRole('button', { name: 'Easing Preset' }).click();
      const menu = page.getByRole('menu', { name: 'Easing Preset' }); await menu.getByRole('menuitemradio', { name: 'Ease In' }).or(menu.getByRole('menuitem', { name: 'Ease In' })).first().click();
    },
    tool: () => ['writeKeyframes', { itemId: 'vid', payload: { opacity: { update: [{ time: 3, easing: 'easeIn' }] } } }] },
  { name: 'graph "Add Bezier" <-> writeKeyframes update easing {type: bezier, points: [0.42, 0, 0.58, 1]}', doc: () => opacityDoc(), label: 'Edit items',
    ui: async page => { const d = await openGraph(page, 'Opacity Graph Editor'); await d.getByRole('button', { name: 'Opacity keyframe at 2.00s', exact: true }).click(); await d.getByRole('button', { name: 'Add Bezier' }).click(); },
    tool: () => ['writeKeyframes', { itemId: 'vid', payload: { opacity: { update: [{ time: 3, easing: { type: 'bezier', points: [0.42, 0, 0.58, 1] } }] } } }] },
  { name: 'graph diamond drag <-> writeKeyframes remove + add at the dropped time / value (the UI result fixes the time and value; keyframes compared by time, ids dropped)', doc: () => opacityDoc(), label: 'Edit items', byTime: true,
    note: 'the drop point comes from the UI run; the tool pair is remove old + add new, which stores in a different list order',
    ui: async page => {
      const d = await openGraph(page, 'Opacity Graph Editor'), key = d.getByRole('button', { name: 'Opacity keyframe at 2.00s', exact: true }), svg = d.getByRole('group', { name: 'Opacity curve' });
      const scale = (await svg.boundingBox())!.width / 600; await dragTo(page, await centre(key), 60 * scale, -40 * scale);
    },
    tool: ui => { const k = vid(ui.after).properties.opacity.keyframes.find((x: any) => x.id === 'k2'); return ['writeKeyframes', { itemId: 'vid', payload: { opacity: { add: [{ time: tl(k.time), value: k.value }], remove: [3] } } }]; } },
  { name: 'graph double-click on the Time Remap curve <-> setTimeRemap merge at that instant (replace: false)', doc: remapDoc, label: 'Edit items',
    note: 'the click point comes from the UI run',
    ui: async page => { const d = await openGraph(page, 'Time Remap Graph Editor'); await dblclickOnCurve(page, d.getByLabel('Curve', { exact: true }), 0.35); },
    tool: ui => { const k = vid(ui.after).timeRemap.keyframes.find((x: any) => !['r1', 'r2'].includes(x.id)); return ['setTimeRemap', { itemId: 'vid', keyframes: [{ time: tl(k.time), value: k.value }], replace: false }]; } },
  // 8. Shadow partial merge.
  { name: 'Shadow X <-> editProperties boxShadow {x} (other fields kept)', doc: shadowDoc, label: 'Edit items',
    ui: async page => { await typeValue(await section(page, 'Shadow'), 'X', '7'); }, tool: () => editProps({ boxShadow: { x: 7 } }) },
  { name: 'Shadow Blur <-> editProperties boxShadow {blur} (other fields kept)', doc: shadowDoc, label: 'Edit items',
    ui: async page => { await typeValue(await section(page, 'Shadow'), 'Blur', '9'); }, tool: () => editProps({ boxShadow: { blur: 9 } }) },
  { name: 'Shadow colour <-> editProperties boxShadow {color} (other fields kept)', doc: shadowDoc, label: 'Edit items',
    ui: async page => {
      await (await section(page, 'Shadow')).getByRole('button', { name: /^Shadow colour:/ }).click();
      const hex = page.getByLabel('Hex', { exact: true }); await hex.fill('445566'); await hex.press('Enter');
    },
    tool: () => editProps({ boxShadow: { color: '#445566' } }) },
  // 9. Flip X and Blend Mode.
  { name: 'Flip X <-> editProperties {flipX: true}', doc: () => t04Doc(), label: 'Edit items',
    ui: async page => { await (await section(page, 'Transform')).getByRole('group', { name: 'Flip' }).getByRole('button', { name: 'Flip X' }).click(); }, tool: () => editProps({ flipX: true }) },
  { name: 'Blend Mode "Color Dodge" <-> editProperties {blendMode: "color-dodge"}', doc: () => t04Doc(), label: 'Edit items',
    ui: async page => { await (await section(page, 'Basic')).getByLabel('Blend Mode', { exact: true }).selectOption({ label: 'Color Dodge' }); }, tool: () => editProps({ blendMode: 'color-dodge' }) },
];

for (const pair of PAIRS) {
  test(`parity: ${pair.name}`, async ({ page, context }) => {
    const other = await context.newPage(); await skipTour(other);
    const ui = await runUi(page, pair), tool = await runTool(other, pair, ui);
    expect(norev(ui.original), 'both sessions start from the same document').toEqual(norev(tool.original));
    // 1. identical project JSON.
    if (pair.byTime) expect(canon(tool.after), 'agent-path project JSON equals the UI path').toEqual(canon(ui.after));
    else expect(normal(tool.after, keyframeIds(tool.original)), 'agent-path project JSON equals the UI path').toEqual(normal(ui.after, keyframeIds(ui.original)));
    expect(norev(ui.after), 'the operation changed the document').not.toEqual(norev(ui.original));
    // 2. exactly one undo entry on each path, the oracle label, tagged user / agent.
    expect(ui.entries, 'UI entry').toEqual([{ label: pair.label, source: 'user' }]);
    expect.soft(tool.entries, `tool entry (${pair.note ?? 'label parity'})`).toEqual([{ label: pair.toolLabel ?? pair.label, source: 'agent' }]);
    expect.soft(tool.entries.map(e => e.label), 'identical undo labels on both paths').toEqual(ui.entries.map(e => e.label));
    // 3. identical undo snapshots: undo returns each session to the original document.
    expect(norev(ui.restored), 'UI undo restores the original').toEqual(norev(ui.original));
    expect(norev(tool.restored), 'tool undo restores the original').toEqual(norev(tool.original));
    await other.close();
  });
}
