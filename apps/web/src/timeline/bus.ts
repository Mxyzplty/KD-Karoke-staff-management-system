// SPDX-License-Identifier: AGPL-3.0-only
// The one command bus for UI and agent (findings §4, §10; part 3 §45.1/§45.3). A command runs on a draft copy of the
// document: it either completes (one undo entry, one journal record) or throws and leaves the document untouched.
// Nested commands run inside the outer draft and add no entry of their own.
import type { ProjectDocument } from '../store/model';
import { reconcileCaptions } from '../captions/links';
import { contentEnd } from './model';
import { repairTransitions } from './transitions';

/** The 52 undo labels of Xapp's editor (part 3 §45.1). */
export const LABELS = [
  'Add transition', 'Change transition', 'Edit transition', 'Remove transition',
  'Add items', 'Edit items', 'Delete items', 'Split item', 'Split items', 'Move item', 'Move items', 'Slip item', 'Duplicate items', 'Insert items', 'Change speed', 'Move to new track',
  'Add track', 'Create track', 'Delete track', 'Rename track', 'Set track flag', 'Set track volume', 'Resize track', 'Move track layer', 'Move item out of group',
  'Group tracks', 'Rename group', 'Edit group', 'Change group tracks', 'Reorder group', 'Move group', 'Set group flag', 'Ungroup tracks', 'Delete group',
  'Ripple trim', 'Ripple group trim', 'Ripple delete', 'Ripple group delete', 'Ripple reorder',
  'Resize canvas', 'Set duration', 'Set fps', 'Set background',
  'Add marker', 'Update marker', 'Remove marker', 'Clear markers', 'Edit markers',
  'Add captions', 'Regenerate captions', 'Add media', 'Consolidate tracks',
] as const;
export type Label = typeof LABELS[number];
export type Source = 'user' | 'agent';
/** A snapshot = the timeline plus the settings (findings §4): the ten parts an undo restores. */
export const SNAPSHOT_KEYS = ['items', 'tracks', 'transitions', 'markers', 'layerOrder', 'groups', 'duration', 'fps', 'size', 'background'] as const;
export type Snapshot = Pick<ProjectDocument, typeof SNAPSHOT_KEYS[number]>;
/** `source` is Cutframe's user/agent tag (documented improvement; Xapp keeps it only in the journal). 'Restore checkpoint'
 *  is T17's undoable restore step (Cutframe default, SR-16); no command writes it. */
export type HistoryEntry = { label: Label | 'Restore checkpoint'; source: Source; before: Snapshot; after: Snapshot; timestamp: number };
export type JournalInput = { source: Source; label: Label | 'Undo' | 'Redo'; items_before: number; items_after: number };
export type Host = { get(): ProjectDocument; set(doc: ProjectDocument): void };
/** label may be changed by the command once it knows its kind (e.g. "Ripple group delete"); noop marks a command that wrote nothing. */
export type Tx = { label: Label; source: Source; noop: boolean };
export type BusOptions = {
  limit?: number;
  /** 'content' (default, improvement): skip an entry when the snapshot is unchanged. 'reference' (parity mode): Xapp skips
   *  only when nothing was written, so a command that writes an equal value still gets an entry. */
  noOp?: 'content' | 'reference';
  /** 'drag' (default, improvement; tickets "command labels + grouping"): a slider drag is one entry, written on release.
   *  'step' (parity mode): the sliders Xapp commits on every pointer step (clip Speed, part 3 §45.3; text-animation Speed,
   *  T05) write one entry per value change. A plain click writes nothing in both modes. Read by the slider at pointer-down. */
  sliderEntries?: 'drag' | 'step';
  /** 'enter' (default, improvement; part 2 §36): M entering mask edit adds no marker. 'both' (parity mode): it also adds one. */
  maskMarker?: 'enter' | 'both';
  journal?: (record: JournalInput) => void;
  now?: () => number;
};

export const snapshot = (doc: ProjectDocument): Snapshot => structuredClone(Object.fromEntries(SNAPSHOT_KEYS.map(k => [k, doc[k]])) as Snapshot);
export const applySnapshot = (doc: ProjectDocument, s: Snapshot): ProjectDocument => ({ ...doc, ...structuredClone(s) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class CommandBus {
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  private draft?: ProjectDocument;
  private tx?: Tx;
  private listeners = new Set<() => void>();
  constructor(private host: Host, public options: BusOptions = {}) {}
  /** The document as a running command sees it (its draft), else the host's. */
  get doc(): ProjectDocument { return this.draft ?? this.host.get(); }
  get running() { return !!this.draft; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const l of this.listeners) l(); }
  run<T>(label: Label, source: Source, op: (doc: ProjectDocument, tx: Tx) => T): T {
    if (this.draft) return op(this.draft, this.tx!);
    const base = this.host.get(), draft = structuredClone(base), tx: Tx = { label, source, noop: false };
    this.draft = draft; this.tx = tx;
    let result: T;
    try { result = op(draft, tx); } finally { this.draft = undefined; this.tx = undefined; }
    // Linked captions follow the items the command moved, and a locked or overlapping dependency refuses the whole edit
    // (T09, caption contract §3/§6): this runs after the op, so a throw here leaves the host document untouched.
    reconcileCaptions(base, draft);
    // Duration follows the content after every item edit (G-01); transitions are repaired then (T11, part 5 §55.1).
    if (!same(draft.items, base.items)) { draft.duration = contentEnd(draft); repairTransitions(draft); }
    const before = snapshot(base), after = snapshot(draft);
    if (this.options.noOp === 'reference' ? tx.noop : same(before, after)) return result;
    this.undoStack.push({ label: tx.label, source, before, after, timestamp: (this.options.now ?? Date.now)() });
    if (this.undoStack.length > (this.options.limit ?? 100)) this.undoStack.shift();
    this.redoStack = [];
    this.host.set(draft);
    this.options.journal?.({ source, label: tx.label, items_before: before.items.length, items_after: after.items.length });
    this.emit();
    return result;
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo(source: Source = 'user'): HistoryEntry | null { return this.step('Undo', source); }
  redo(source: Source = 'user'): HistoryEntry | null { return this.step('Redo', source); }
  private step(kind: 'Undo' | 'Redo', source: Source): HistoryEntry | null {
    if (this.draft) return null;
    const from = kind === 'Undo' ? this.undoStack : this.redoStack, to = kind === 'Undo' ? this.redoStack : this.undoStack;
    const entry = from.pop(); if (!entry) return null;
    const current = this.host.get(), target = kind === 'Undo' ? entry.before : entry.after;
    this.host.set(applySnapshot(current, target)); to.push(entry);
    this.options.journal?.({ source, label: kind, items_before: current.items.length, items_after: target.items.length });
    this.emit();
    return entry;
  }
  clear() { this.undoStack = []; this.redoStack = []; this.emit(); }
  restore(undo: HistoryEntry[], redo: HistoryEntry[]) { this.undoStack = undo.slice(-(this.options.limit ?? 100)); this.redoStack = redo; this.emit(); }
  labels() { return this.undoStack.map(e => e.label); }
}
