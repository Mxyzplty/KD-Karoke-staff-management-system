// SPDX-License-Identifier: AGPL-3.0-only
// T17 ledger rows 10 and 11 (findings part 2 §36) with TWO real pages of ONE browser context: BroadcastChannel refetch, the conflict screen, lost-message cases.
import { test, expect, type Page } from '@playwright/test';
import { clip } from './t02-support';
import { conflictGroup, docWith, flushNow, liveIds, makeDeaf, norev, run, sessionRev, storedOf, twoTabs } from './t17-support';

test.use({ viewport: { width: 1600, height: 900 } });
const ALL = ['clipA', 'clipB', 'clipC', 'title', 'photo'];
const rev = (p: Page, id: string) => storedOf(p, id).then(d => d.rev as number);
const projectRows = (p: Page) => p.evaluate(async () => { const s = '/src/store/database.ts'; const { projectStore } = await import(s); return ((await projectStore.list()) as any[]).map(r => ({ id: r.id as string, title: r.title as string })); });
const readDoc = (p: Page, id: string) => storedOf(p, id);

/** A (saves) and B (stays on the old version), with B dirty and in the conflict state (reached through the BroadcastChannel message). */
async function conflict(a: Page, b: Page, id: string) {
  await run(b, { type: 'deleteItems', itemIds: ['clipC'], ripple: false }); // B's unsaved edit
  await run(a, { type: 'deleteItems', itemIds: ['clipA'], ripple: false }); await flushNow(a); // A's saved edit
  await expect(conflictGroup(b)).toBeVisible({ timeout: 10000 });
}

test('L11 clean tab B refetches when A saves (no reload, new revision shown)', async ({ page: a, context }) => {
  const { b, id } = await twoTabs(context, a, docWith(ALL));
  const r0 = await rev(a, id); expect(await sessionRev(b)).toBe(r0);
  await run(a, { type: 'deleteItems', itemIds: ['clipA'], ripple: false }); await flushNow(a);
  const r1 = await rev(a, id); expect(r1).toBe(r0 + 1);
  await expect(clip(b, 'clipA')).toHaveCount(0, { timeout: 5000 }); expect(await liveIds(b)).toEqual(['clipB', 'clipC', 'title', 'photo']);
  await expect(b.getByTestId('project-rev')).toHaveText(`Saved revision: ${r1}`); await expect(b.getByRole('status')).toHaveText('Saved locally');
  await expect(conflictGroup(b)).toHaveCount(0);
  expect(await sessionRev(a)).toBe(r1); // A did not react to its own message
  // And back: B saves, A (clean) follows.
  await run(b, { type: 'deleteItems', itemIds: ['clipB'], ripple: false }); await flushNow(b);
  await expect(clip(a, 'clipB')).toHaveCount(0, { timeout: 5000 }); await expect(a.getByTestId('project-rev')).toHaveText(`Saved revision: ${r1 + 1}`);
});

test('L11 dirty tab B meets A\'s save as a conflict: the stored document stays A\'s, B keeps its edit', async ({ page: a, context }) => {
  const { b, id } = await twoTabs(context, a, docWith(ALL));
  await run(b, { type: 'deleteItems', itemIds: ['clipC'], ripple: false }); // dirty, not yet flushed
  await run(a, { type: 'deleteItems', itemIds: ['clipA'], ripple: false }); await flushNow(a);
  const stored = await storedOf(a, id);
  await expect(conflictGroup(b)).toBeVisible({ timeout: 10000 });
  await expect(conflictGroup(b).getByRole('button')).toHaveText(['Reload', 'Keep mine', 'Save as copy']);
  expect(await rev(b, id)).toBe(stored.rev); expect(norev(await storedOf(b, id))).toEqual(norev(stored)); // nothing of B's reached the store
  expect(stored.items.map((i: any) => i.id)).toEqual(['clipB', 'clipC', 'title', 'photo']);
  expect(await liveIds(b)).toEqual(['clipA', 'clipB', 'title', 'photo']); // B's own version, intact
});

test('L10 conflict -> Reload takes the stored version and drops B\'s edit', async ({ page: a, context }) => {
  const { b, id } = await twoTabs(context, a, docWith(ALL));
  await conflict(a, b, id);
  const stored = await storedOf(a, id);
  await conflictGroup(b).getByRole('button', { name: 'Reload' }).click();
  await expect(conflictGroup(b)).toHaveCount(0); await expect(clip(b, 'clipA')).toHaveCount(0);
  expect(await liveIds(b)).toEqual(['clipB', 'clipC', 'title', 'photo']); expect(await sessionRev(b)).toBe(stored.rev);
  expect(norev(await storedOf(b, id))).toEqual(norev(stored));
});

test('L10 conflict -> Keep mine overwrites the store with B\'s version (rev = A\'s + 1)', async ({ page: a, context }) => {
  const { b, id } = await twoTabs(context, a, docWith(ALL));
  await conflict(a, b, id);
  const aRev = await rev(a, id), mine = await b.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); });
  await conflictGroup(b).getByRole('button', { name: 'Keep mine' }).click();
  await expect(conflictGroup(b)).toHaveCount(0); await expect(b.getByRole('status')).toHaveText('Saved locally');
  const stored = await storedOf(a, id);
  expect(stored.rev).toBe(aRev + 1); expect(norev(stored)).toEqual(norev(mine)); expect(stored.items.map((i: any) => i.id)).toEqual(['clipA', 'clipB', 'title', 'photo']);
  await expect(clip(a, 'clipC')).toHaveCount(0, { timeout: 5000 }); // A (clean again) follows B's overwrite
});

test('L10 conflict -> Save as copy keeps both: the copy holds B\'s version, the original keeps A\'s', async ({ page: a, context }) => {
  const { b, id } = await twoTabs(context, a, docWith(ALL));
  await conflict(a, b, id);
  const aStored = await storedOf(a, id), mine = await b.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); });
  await conflictGroup(b).getByRole('button', { name: 'Save as copy' }).click();
  await b.waitForURL(u => /\/project\//.test(u.pathname) && !u.pathname.endsWith(`/${id}`), { timeout: 10000 });
  const copyId = new URL(b.url()).pathname.split('/').pop()!;
  const rows = await projectRows(b); const copy = rows.find(r => r.id === copyId)!; expect(copy.title).toBe('T17 fixture (copy)');
  const copyDoc = await readDoc(b, copyId); expect(copyDoc.rev).toBe(0); expect(norev(copyDoc)).toEqual(norev(mine));
  expect(norev(await storedOf(a, id))).toEqual(norev(aStored)); expect((await storedOf(a, id)).rev).toBe(aStored.rev);
});

test('REQUIRED (a) message not delivered: B is dirty and deaf, A saves, B flushes -> conflict; stored doc is still A\'s, B\'s version is still in memory, Save as copy keeps B\'s', async ({ page: a, context }) => {
  const { b, id } = await twoTabs(context, a, docWith(ALL));
  await makeDeaf(b);
  await run(b, { type: 'deleteItems', itemIds: ['clipC'], ripple: false });
  await run(a, { type: 'deleteItems', itemIds: ['clipA'], ripple: false }); await flushNow(a);
  await b.waitForTimeout(1200); await expect(conflictGroup(b)).toHaveCount(0); expect(await liveIds(b)).toEqual(['clipA', 'clipB', 'title', 'photo']); // no message: B has not noticed
  const aStored = await storedOf(a, id);
  const stateOf = () => b.evaluate(async () => { const p = '/src/editor.tsx'; const s = (await import(p)).activeSession; return { state: s.state as string, code: s.error?.code as string | undefined }; });
  expect((await stateOf()).state).toBe('pending'); // no message arrived: B is still just dirty
  // flush() never rejects: drain() catches the StoreError and sets the state. clipC is a 1-of-5 deletion, so the large-deletion pre-read does not run; the CONFLICT comes from ProjectStore.save's expectedRev check, i.e. from B's own conditional write.
  const flushed = await b.evaluate(async () => { const p = '/src/editor.tsx'; try { await (await import(p)).activeSession.flush(); return 'ok'; } catch (e: any) { return e?.code ?? String(e); } });
  expect(flushed).toBe('ok'); expect(await stateOf()).toEqual({ state: 'conflict', code: 'CONFLICT' });
  await expect(conflictGroup(b)).toBeVisible({ timeout: 10000 });
  const after = await storedOf(a, id); expect(after.rev).toBe(aStored.rev); expect(norev(after)).toEqual(norev(aStored)); expect(after.items.map((i: any) => i.id)).toEqual(['clipB', 'clipC', 'title', 'photo']); // still A's
  const mine = await b.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); });
  expect(mine.items.map((i: any) => i.id)).toEqual(['clipA', 'clipB', 'title', 'photo']); // B's version is still in B's memory
  await conflictGroup(b).getByRole('button', { name: 'Save as copy' }).click();
  await b.waitForURL(u => !u.pathname.endsWith(`/${id}`), { timeout: 10000 });
  const copyId = new URL(b.url()).pathname.split('/').pop()!;
  const copy = await readDoc(b, copyId); expect(norev(copy)).toEqual(norev(mine)); expect(copy.items.map((i: any) => i.id)).toEqual(['clipA', 'clipB', 'title', 'photo']);
  const original = await storedOf(a, id); expect(norev(original)).toEqual(norev(aStored)); expect(original.rev).toBe(aStored.rev);
});

test('REQUIRED (b) reverse order: B is clean at rev r; rev r+1 is written out of band with no broadcast; a stale message (rev <= r) is ignored, then rev r+1 makes B refetch', async ({ page: a, context }) => {
  const { b, id } = await twoTabs(context, a, docWith(ALL));
  const r = await sessionRev(b); expect(r).toBe(await rev(a, id));
  // Out of band: written through the store in B's page, bypassing the SaveChannel wrapper, so nothing is broadcast.
  const next = await b.evaluate(async id => {
    const s = '/src/store/database.ts'; const { projectStore } = await import(s);
    const cur = (await projectStore.read(id)).document; const doc = { ...cur, items: cur.items.filter((i: any) => i.id !== 'clipA') };
    return (await projectStore.save(id, doc, cur.rev)).rev as number;
  }, id);
  expect(next).toBe(r + 1);
  const post = (p: Page, message: unknown) => p.evaluate(async ([id, m]) => { const c = new BroadcastChannel(`cutframe-project-${id}`); c.postMessage(m); c.close(); }, [id, message] as const);
  await post(a, { type: 'cutframe-save', rev: r, senderId: 'x' }); await post(a, { type: 'cutframe-save', rev: r - 1, senderId: 'x' });
  await b.waitForTimeout(1200);
  expect(await sessionRev(b)).toBe(r); expect(await liveIds(b)).toEqual(ALL); await expect(clip(b, 'clipA')).toBeVisible(); await expect(conflictGroup(b)).toHaveCount(0); // ignored
  await post(a, { type: 'cutframe-save', rev: r + 1, senderId: 'x' });
  await expect(clip(b, 'clipA')).toHaveCount(0, { timeout: 5000 }); expect(await sessionRev(b)).toBe(r + 1);
  await expect(b.getByTestId('project-rev')).toHaveText(`Saved revision: ${r + 1}`); expect(await liveIds(b)).toEqual(['clipB', 'clipC', 'title', 'photo']);
});

test('L11 A leaves the editor ("Back to home") inside the 3 s debounce: the final save is still announced, clean tab B refetches and is not stale', async ({ page: a, context }) => {
  const { b, id } = await twoTabs(context, a, docWith(ALL));
  const r = await rev(a, id); expect(await sessionRev(b)).toBe(r);
  await run(a, { type: 'deleteItems', itemIds: ['clipA'], ripple: false }); // dirty; no flushNow, the 3 s debounce has not fired
  await a.getByRole('button', { name: 'Back to home' }).click();
  await a.waitForURL(u => u.pathname === '/', { timeout: 10000 });
  await expect.poll(() => rev(a, id), { timeout: 10000 }).toBe(r + 1);
  expect((await storedOf(a, id)).items.map((i: any) => i.id)).toEqual(['clipB', 'clipC', 'title', 'photo']); // A's edit
  await expect(clip(b, 'clipA')).toHaveCount(0, { timeout: 5000 }); expect(await liveIds(b)).toEqual(['clipB', 'clipC', 'title', 'photo']);
  await expect(b.getByTestId('project-rev')).toHaveText(`Saved revision: ${r + 1}`); await expect(b.getByRole('status')).toHaveText('Saved locally');
  await expect(conflictGroup(b)).toHaveCount(0);
  await run(b, { type: 'deleteItems', itemIds: ['clipB'], ripple: false }); await flushNow(b); // B was not left on a stale rev
  await expect(conflictGroup(b)).toHaveCount(0); expect(await rev(b, id)).toBe(r + 2); expect(await sessionRev(b)).toBe(r + 2);
  expect((await storedOf(b, id)).items.map((i: any) => i.id)).toEqual(['clipC', 'title', 'photo']);
});
