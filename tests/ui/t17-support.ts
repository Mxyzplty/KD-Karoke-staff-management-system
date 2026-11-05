// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the T17 browser specs: parity switch, checkpoint rows, intents, the two-tab setup. Builds on t02-support.
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { createProject, richDoc, skipTour } from './t02-support';

export type Cp = { id: string; timestamp: string; editorState: any; name?: string; label?: string; rev?: number };
export const RECOVERY = 'Automatic recovery before large deletion';
export const norev = (d: any) => ({ ...d, rev: 0 });
const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
/** Keys sorted, `rev` dropped: the comparison form of the byte-identical normalised JSON check. */
export const normJson = (d: any) => JSON.stringify(sorted(norev(d)));

/** richDoc() keeping only the listed items (clipA clipB clipC title photo). */
export function docWith(ids: string[]) { const d = richDoc(); return { ...d, items: d.items.filter(i => ids.includes(i.id)) }; }

/** The parity switch is read once per editor open: put the row BEFORE opening the editor (the page must be on the app origin). */
export const setParity = (page: Page) => page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); await projectStore.putRow('settings', { id: 'parity-mode', enabled: true }); });
/** Creates a project and opens its editor, in parity mode when asked. */
export async function openProject(page: Page, doc: unknown, parity: boolean, title = 'T17 fixture') {
  const id = await createProject(page, doc, title);
  if (parity) await setParity(page);
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return id;
}
export const reopen = async (page: Page, id: string) => { await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); };

export const cpRow = (page: Page, id: string) => page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.row('settings', `checkpoints:${id}`)) as { id: string; project_id: string; checkpoints: Cp[]; updated_at: string } | undefined; }, id);
export const cpList = async (page: Page, id: string) => (await cpRow(page, id))?.checkpoints ?? [];
export const historyRow = (page: Page, id: string) => page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.row('settings', `history:${id}`)) as { id: string; at: string; undo: { label: string; source: string }[]; redo: unknown[] } | undefined; }, id);
export const journalCount = (page: Page, id: string) => page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return ((await projectStore.rows('settings')) as any[]).filter(r => typeof r.id === 'string' && r.id.startsWith(`journal:${id}:`)).length; }, id);
export const storedOf = (page: Page, id: string) => page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return JSON.parse(JSON.stringify((await projectStore.read(id)).document)) as any; }, id);
export const liveOf = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); return JSON.parse(JSON.stringify(activeSession.document)) as any; });
export const liveIds = async (page: Page) => (await liveOf(page)).items.map((i: any) => i.id) as string[];
export const flushNow = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; await (await import(p)).activeSession.flush(); });
/** Dispatches an intent through the real handler chain (what a click or a shortcut does). */
export const run = (page: Page, intent: Record<string, unknown>) => page.evaluate(async intent => { const p = '/src/editor/commands.ts'; return (await import(p)).dispatch(intent); }, intent);
export const undoStack = (page: Page) => page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); return activeRuntime.bus.undoStack.map((e: any) => ({ label: e.label, source: e.source })) as { label: string; source: string }[]; });

export const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true });
export const chevron = (page: Page) => page.getByRole('button', { name: 'Checkpoints', exact: true });
export const menu = (page: Page) => page.getByRole('menu', { name: 'Checkpoints' });
export const rows = (page: Page) => menu(page).getByRole('menuitem');
export const undoButton = (page: Page) => page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Undo', exact: true });
export const openMenu = async (page: Page) => { await chevron(page).click(); await expect(menu(page)).toBeVisible(); };
export const conflictGroup = (page: Page) => page.getByRole('group', { name: 'Resolve project conflict' });
export const sessionRev = (page: Page) => liveOf(page).then(d => d.rev as number);

/** Two real pages of ONE browser context (same storage and BroadcastChannel), both on the project's editor. */
export async function twoTabs(context: BrowserContext, a: Page, doc: unknown, parity = false) {
  await skipTour(a);
  const id = await openProject(a, doc, parity);
  const b = await context.newPage(); await skipTour(b); await b.setViewportSize({ width: 1600, height: 900 });
  await reopen(b, id);
  return { a, b, id };
}
/** Tab B stops hearing and announcing (the closed `activeChannel` simulates a lost message). */
export const makeDeaf = (page: Page) => page.evaluate(async () => { const p = '/src/versions/crosstab.ts'; const { activeChannel } = await import(p); activeChannel.close(); });
