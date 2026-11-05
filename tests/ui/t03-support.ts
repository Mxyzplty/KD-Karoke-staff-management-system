// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the T03 browser specs: undo stack, live / stored document and journal rows read from the real editor session.
import { expect, type Page } from '@playwright/test';

export type Entry = { label: string; source: string };
/** The runtime's undo stack (label + source per entry), oldest first. */
export const undoEntries = (page: Page) => page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); return activeRuntime.bus.undoStack.map((e: any) => ({ label: e.label, source: e.source })) as Entry[]; });
export const undoLabels = async (page: Page) => (await undoEntries(page)).map(e => e.label);
/** The live (in-memory) document of the open session. */
export const liveDoc = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); return JSON.parse(JSON.stringify(activeSession.document)) as any; });
/** The document as persisted in the project store. */
export const storedDoc = (page: Page, id: string) => page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return JSON.parse(JSON.stringify((await projectStore.read(id)).document)) as any; }, id);
/** Journal rows (settings rows `journal:<projectId>:<sessionId>:<seq>`) written so far for this project, by seq. */
export const journalRows = (page: Page, id: string) => page.evaluate(async id => {
  const p = '/src/store/database.ts'; const { projectStore } = await import(p); const rows = await projectStore.rows('settings') as any[];
  return rows.filter(r => typeof r.id === 'string' && r.id.startsWith(`journal:${id}:`)).sort((a, b) => a.seq - b.seq) as any[];
}, id);
/** Items by id from a document. */
export const itemById = (doc: any, id: string) => doc.items.find((i: any) => i.id === id);
/** (from, to) of an item. */
export const spanOf = (doc: any, id: string) => { const i = itemById(doc, id); return i ? [i.display.from, i.display.to] : undefined; };
/** Waits until the session has saved the edit (the 3 s autosave) and returns the stored document. */
export async function savedDoc(page: Page, id: string) { await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 10000 }); return storedDoc(page, id); }
