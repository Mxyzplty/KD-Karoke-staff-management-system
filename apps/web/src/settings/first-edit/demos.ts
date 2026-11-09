// SPDX-License-Identifier: AGPL-3.0-only
// T21 First Edit: removing the demo (our improvement). Kept apart from the pack and the page because start-up needs it: a demo a
// closed or crashed tab left behind goes before anything reads the Library or the Settings counts.
import type { ProjectStore } from '../../store/database';
import type { Asset, ProjectRecord } from '../../store/model';

const LOCK = 'cutframe:demo';
/** Caller holds LOCK: removes abandoned/owned demo rows and media. A user's own file reused by name keeps its source. */
export async function removeDemos(store: ProjectStore) {
  const ids = (await store.rows<ProjectRecord>('projects')).filter(p => p.is_demo).map(p => p.id);
  for (const id of ids) await store.deleteProject(id);
  if (ids.length) {
    const left = (await store.rows<{ id: string }>('settings')).filter(r => ids.some(id => r.id === `history:${id}` || r.id.startsWith(`journal:${id}:`)));
    for (const row of left) await store.deleteRow('settings', row.id);
  }
  const assets = (await store.rows<Asset>('assets')).filter(a => a.source?.kind === 'demo');
  if (assets.length) await store.deleteAssets(assets.map(a => a.id));
}
let running: Promise<unknown> = Promise.resolve();
/** One at a time: a quick Back then re-entry gets its own new project once the first has finished, and leaving waits out a setup still running, or its project would stay behind. */
export function queued<T>(job: () => Promise<T>) { const run = running.catch(() => {}).then(job); running = run; return run; }
let releaseDemo: (() => void) | undefined, heldDemo: Promise<void> | undefined;
export const leaveDemos = (store: ProjectStore) => queued(async () => {
  if (!releaseDemo) return; // A refused second tab owns nothing and cannot clean another tab's demo.
  try { await removeDemos(store); }
  finally {
    const held = heldDemo;
    releaseDemo(); releaseDemo = undefined; heldDemo = undefined;
    await held;
  }
});
/** Acquire before setup, retain through use and leave cleanup. Closing/crashing releases it in the browser. */
export function holdDemo(): Promise<void> {
  if (releaseDemo) return Promise.resolve();
  return new Promise((resolve, reject) => {
    heldDemo = navigator.locks.request(LOCK, { ifAvailable: true }, lock => {
      if (!lock) { reject(new Error('Another tab is using the demo.')); return; }
      return new Promise<void>(done => { releaseDemo = done; resolve(); });
    });
    void heldDemo.catch(reject);
  });
}
/** Start-up: a demo no tab is showing. No database yet means nothing to sweep, and no open for a storage failure to be spent on. */
export async function sweepDemos(store: ProjectStore) {
  if (!(await indexedDB.databases()).some(d => d.name === store.name)) return;
  await navigator.locks.request(LOCK, { ifAvailable: true }, lock => lock ? queued(() => removeDemos(store)) : undefined);
}
