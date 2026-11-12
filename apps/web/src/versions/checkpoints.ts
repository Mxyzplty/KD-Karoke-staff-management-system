// SPDX-License-Identifier: AGPL-3.0-only
// T17 checkpoints (findings §4; part 3 §45.2, §45.7, §46.1). Save flushes the pending autosave, then puts a checkpoint
// `{id: checkpoint_<epoch ms>, timestamp, editorState}` first in the project's list. The large-deletion guard adds
// "Automatic recovery before large deletion" checkpoints (the state before the drop, with label and rev). Restore writes
// the checkpoint's document as the new stored document (conditional write, rev + 1, no journal record) and reopens the
// editor through the normal open path; the list is unchanged.
// Parity mode keeps Xapp's 3 unnamed slots shared by both kinds and leaves the history empty after a restore. The Cutframe
// default (documented improvements): optional names, a longer list, recovery checkpoints in their own slots, and the
// restore as one undoable step back to the pre-restore state (SR-16).
import { StoreError } from '../store/model';
import type { ProjectDocument, ProjectRecord } from '../store/model';
import type { ProjectStore } from '../store/database';
import type { AutosaveSession } from '../store/autosave';
import { installIntentHandler } from '../editor/commands';
import type { Intent, Outcome } from '../editor/commands';
import { reportError } from '../ui';
import { projectLearning } from '../templates/binding';
import { projectTemplate } from '../templates/library';
import { snapshot } from '../timeline/bus';
import type { HistoryEntry } from '../timeline/bus';
import { fingerprint, historyKey } from '../timeline/runtime';

export type Mode = 'parity' | 'default';
export const RECOVERY_LABEL = 'Automatic recovery before large deletion';
/** Label of the undoable restore step (Cutframe default, SR-16). Provisional: Xapp has no such step. */
export const RESTORE_LABEL = 'Restore checkpoint';
/** Parity: the 3 newest of both kinds. Default: each kind keeps its own newest (manual 20, recovery 3; provisional sizes). */
export const LIMITS = { parity: 3, manual: 20, recovery: 3 } as const;
export type Checkpoint = { id: string; timestamp: string; editorState: ProjectDocument; name?: string; label?: typeof RECOVERY_LABEL; rev?: number };
/** One settings row per project, the local form of Xapp's upsert `{project_id, user_id, checkpoints[...], updated_at}`. */
export type CheckpointRow = { id: string; project_id: string; checkpoints: Checkpoint[]; updated_at: string };
export const checkpointKey = (projectId: string) => `checkpoints:${projectId}`;
export const isRecovery = (c: Checkpoint) => c.label === RECOVERY_LABEL;
/** The settings row that switches the editor to parity mode (provisional; read once per editor open). */
export const PARITY_KEY = 'parity-mode';
export async function readMode(store: Pick<ProjectStore, 'row'>): Promise<Mode> {
  return (await store.row<{ enabled?: boolean }>('settings', PARITY_KEY))?.enabled ? 'parity' : 'default';
}

/** Puts `checkpoint` first and trims the list to the mode's slots. */
export function insert(list: Checkpoint[], checkpoint: Checkpoint, mode: Mode): Checkpoint[] {
  const next = [checkpoint, ...list];
  if (mode === 'parity') return next.slice(0, LIMITS.parity);
  let manual = 0, recovery = 0;
  return next.filter(c => isRecovery(c) ? ++recovery <= LIMITS.recovery : ++manual <= LIMITS.manual);
}

/** What changed the list: parity mode's open menu follows only the user's own Save / delete (Xapp's list is stale until a reload). */
export type Cause = 'save' | 'recovery' | 'delete' | 'rename';
export class Checkpoints {
  private listeners = new Set<(list: Checkpoint[], cause: Cause) => void>();
  constructor(private store: Pick<ProjectStore, 'row' | 'swapRow'>, public projectId: string, public mode: Mode, private clock = () => Date.now()) {}
  subscribe(listener: (list: Checkpoint[], cause: Cause) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async list(): Promise<Checkpoint[]> { return (await this.store.row<CheckpointRow>('settings', checkpointKey(this.projectId)))?.checkpoints ?? []; }
  /** Read-modify-write of the stored list in one transaction (Save re-reads the stored list, §45.2). */
  private async change(cause: Cause, edit: (list: Checkpoint[]) => Checkpoint[]): Promise<Checkpoint[]> {
    const key = checkpointKey(this.projectId);
    const row = await this.store.swapRow<CheckpointRow>('settings', key, current => ({ id: key, project_id: this.projectId, checkpoints: edit(current?.checkpoints ?? []), updated_at: new Date(this.clock()).toISOString() }));
    const list = row!.checkpoints;
    for (const listener of this.listeners) listener(list, cause);
    return list;
  }
  /** A manual checkpoint carries no name (parity) and no rev; a recovery checkpoint carries its label and the stored rev. */
  add(editorState: ProjectDocument, options: { recovery?: boolean; name?: string } = {}): Promise<Checkpoint[]> {
    return this.change(options.recovery ? 'recovery' : 'save', list => {
      // Two checkpoints in one millisecond (a Save right before a guarded save) keep distinct ids.
      let ms = this.clock(); while (list.some(c => c.id === `checkpoint_${ms}`)) ms++;
      const checkpoint: Checkpoint = { id: `checkpoint_${ms}`, timestamp: new Date(ms).toISOString(), editorState: structuredClone(editorState) };
      if (options.recovery) Object.assign(checkpoint, { label: RECOVERY_LABEL, rev: editorState.rev });
      const name = options.name?.trim();
      if (name && this.mode === 'default') checkpoint.name = name;
      return insert(list, checkpoint, this.mode);
    });
  }
  remove(id: string) { return this.change('delete', list => list.filter(c => c.id !== id)); }
  /** Default mode only (names are a documented improvement); an empty name clears it. */
  rename(id: string, name: string) {
    return this.change('rename', list => list.map(c => {
      if (c.id !== id || this.mode !== 'default') return c;
      const { name: _old, ...rest } = c, trimmed = name.trim();
      return trimmed ? { ...rest, name: trimmed } : rest;
    }));
  }
}

/** Save (§45.2): flush the pending autosave, then checkpoint the stored document. A save that cannot complete (conflict,
 *  paused, failed) writes no checkpoint. */
export async function saveCheckpoint(session: AutosaveSession, store: Pick<ProjectStore, 'read'>, checkpoints: Checkpoints, name?: string): Promise<Checkpoint[]> {
  await session.flush();
  if (session.state === 'conflict' || session.state === 'blocked' || session.state === 'error') throw session.error ?? new StoreError('CONFLICT', 'Another tab changed this project.');
  const stored = await store.read(session.projectId);
  if (!stored) throw new StoreError('PROJECT_NOT_FOUND', 'This project no longer exists.');
  return checkpoints.add(stored.document, { name });
}

type Reopen = (job: () => Promise<void>) => void;
/** Restore (§45.7, W3-RT-07): flush, then write the checkpoint's document as the new stored document with the conditional
 *  write (rev + 1; no command runs, so no journal record), then reopen the editor. `job` runs after the old editor is torn
 *  down and before the project is opened again; it leaves the history empty (parity) or one restore step (default). */
export async function restoreCheckpoint(session: AutosaveSession, store: Pick<ProjectStore, 'save' | 'putRow' | 'deleteRow'>, checkpoint: Checkpoint, mode: Mode, reopen: Reopen, clock = () => Date.now()): Promise<ProjectDocument> {
  await session.flush();
  if (session.state === 'conflict' || session.state === 'blocked' || session.state === 'error') throw session.error ?? new StoreError('CONFLICT', 'Another tab changed this project.');
  const before = structuredClone(session.document), projectId = session.projectId;
  const restored = await store.save(projectId, checkpoint.editorState, before.rev);
  reopen(async () => {
    if (mode === 'parity') { await store.deleteRow('settings', historyKey(projectId)); return; }
    const step: HistoryEntry = { label: RESTORE_LABEL, source: 'user', before: snapshot(before), after: snapshot(restored), timestamp: clock() };
    await store.putRow('settings', { id: historyKey(projectId), at: fingerprint(restored), undo: [step], redo: [] });
  });
  return restored;
}

/** The template binding a tab shows in its chip. */
export type TabBinding = { id: string | null; epoch: number };
/** Conflict screen "Save as copy": this tab's version becomes a new project (with this project's media links); the stored
 *  version stays untouched, so neither version is lost. Title and destination are provisional.
 *  T22 (D93, D100): the copy is this tab's version, template included. Its binding is the one this tab's template chip
 *  shows (`binding`: the record as this tab loaded it, replaced by any bind this tab made), never the stored record at
 *  copy time. A binding with a template: the copy's record gets that id and epoch (a deleted template shows "Missing
 *  template", as the original). No template: the copy is unbound and its Learn switch starts at the value the original's
 *  switch shows now, on the copy's record; the copy has no template of its own. The document is copied as it is: its
 *  defaults key is not rewritten, the copy's open repairs it when it is behind. If the record cannot be written, the
 *  copy is deleted again. */
export async function saveAsCopy(session: AutosaveSession, store: ProjectStore, record: ProjectRecord, binding: TabBinding): Promise<ProjectRecord> {
  let copy = await store.create(`${record.title} (copy)`, { ...structuredClone(session.document), rev: 0 });
  try {
    const fields: Partial<ProjectRecord> = binding.id ? { template_id: binding.id, template_epoch: binding.epoch }
      : { template_learning: projectLearning(await store.row<ProjectRecord>('projects', session.projectId) ?? record, await projectTemplate(store, session.projectId)) };
    const written = await store.swapRow<ProjectRecord>('projects', copy.id, row => row ? { ...row, ...fields } : null);
    if (!written) throw new StoreError('PROJECT_NOT_FOUND', 'This project no longer exists.');
    copy = written;
  } catch (e) { await store.deleteProject(copy.id).catch(() => {}); throw e; }
  for (const link of await store.projectAssets(session.projectId)) await store.attach(copy.id, link.assetId);
  return copy;
}

/** The T17 intent handler: Save, restore, delete and rename run asynchronously; a failure is reported as a notice. */
export function installCheckpoints(session: AutosaveSession, store: Pick<ProjectStore, 'read' | 'save' | 'putRow' | 'deleteRow'>, checkpoints: Checkpoints, reopen: Reopen): () => void {
  const later = (work: Promise<unknown>): Outcome => { void work.catch(reportError); return { ok: true }; };
  const find = async (id: string) => {
    const checkpoint = (await checkpoints.list()).find(c => c.id === id);
    if (!checkpoint) throw new StoreError('CHECKPOINT_NOT_FOUND', 'This checkpoint no longer exists.');
    return checkpoint;
  };
  return installIntentHandler((intent: Intent) => {
    switch (intent.type) {
      case 'saveCheckpoint': return later(saveCheckpoint(session, store, checkpoints, intent.name));
      case 'restoreCheckpoint': return later(find(intent.checkpointId).then(c => restoreCheckpoint(session, store, c, checkpoints.mode, reopen)));
      case 'deleteCheckpoint': return later(checkpoints.remove(intent.checkpointId));
      case 'renameCheckpoint': return later(checkpoints.rename(intent.checkpointId, intent.name));
      default: return undefined;
    }
  });
}
