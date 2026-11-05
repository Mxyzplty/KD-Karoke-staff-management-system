// SPDX-License-Identifier: AGPL-3.0-only
import { StoreError, storageError } from './model';
import type { ProjectDocument } from './model';
import type { ProjectStore } from './database';

export type SaveState = 'saved' | 'pending' | 'saving' | 'conflict' | 'blocked' | 'error';
type Options = {
  fullyLoaded?: boolean;
  // T17 installs recovery checkpoints; T03 installs media timing repair/validation.
  beforeLargeDeletion?: (previous: ProjectDocument) => Promise<void>;
  prepareSave?: (document: ProjectDocument) => ProjectDocument;
};
const fingerprint = (d: ProjectDocument) => JSON.stringify({ ...d, rev: 0 });
export class AutosaveSession {
  document: ProjectDocument;
  state: SaveState = 'saved';
  error?: Error;
  private saved: ProjectDocument;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private saveRequested = false;
  private forced = false;
  private editGeneration = 0;
  private listeners = new Set<() => void>();
  constructor(private store: Pick<ProjectStore, 'save' | 'read'>, public projectId: string, document: ProjectDocument, private options: Options = {}) {
    this.document = structuredClone(document); this.saved = structuredClone(document);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  private markSaved() {
    clearTimeout(this.timer); this.timer = undefined; this.saveRequested = false; this.forced = false;
    this.state = 'saved'; this.error = undefined; this.emit();
  }
  update(document: ProjectDocument) {
    this.editGeneration++;
    this.document = structuredClone({ ...document, rev: this.saved.rev });
    clearTimeout(this.timer); this.timer = undefined; this.saveRequested = false;
    if (this.state !== 'conflict' && this.state !== 'blocked') {
      this.state = !this.running && fingerprint(this.document) === fingerprint(this.saved) ? 'saved' : 'pending'; this.error = undefined;
      if (this.state === 'pending') this.timer = setTimeout(() => { this.timer = undefined; void this.requestSave(false); }, 3000);
    }
    this.emit();
  }
  flush(): Promise<void> {
    return this.requestSave(true);
  }
  private requestSave(forced: boolean): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.state === 'conflict' || this.state === 'blocked') return this.running ?? Promise.resolve();
    if (!this.running && fingerprint(this.document) === fingerprint(this.saved)) { this.markSaved(); return Promise.resolve(); }
    if (forced) this.forced = true; else this.saveRequested = true;
    if (this.running) return this.running;
    let complete!: () => void;
    const running = new Promise<void>(resolve => { complete = resolve; });
    this.running = running;
    void this.drain(complete);
    return running;
  }
  private async drain(complete: () => void) {
    try {
      while (this.forced || this.saveRequested) {
        this.forced = false; this.saveRequested = false;
        if (fingerprint(this.document) === fingerprint(this.saved)) { this.markSaved(); continue; }
        const candidate = structuredClone(this.document), before = this.saved.items.length, after = candidate.items.length;
        const candidateFingerprint = fingerprint(candidate);
        this.state = 'saving'; this.emit();
        try {
          // Even a never-loaded empty state must read storage before it can overwrite content.
          if ((before > after && (after === 0 || before - after >= 5 || after <= before / 2)) || (this.options.fullyLoaded === false && after === 0)) {
            const stored = await this.store.read(this.projectId);
            if (!stored) throw new StoreError('PROJECT_NOT_FOUND', 'This project no longer exists.');
            if (this.options.fullyLoaded === false && after === 0 && stored.document.items.length > 0) {
              throw new StoreError('SAVE_PAUSED', 'Saving is paused because this project did not finish loading. Reload before saving.');
            }
            if (stored.document.rev !== this.saved.rev) throw new StoreError('CONFLICT', 'Another tab changed this project.');
            await this.options.beforeLargeDeletion?.(stored.document);
          }
          const prepared = this.options.prepareSave?.(candidate) ?? candidate;
          const saved = await this.store.save(this.projectId, prepared, this.saved.rev);
          this.saved = structuredClone(saved);
          // Compare with the original edit, even when preparation repairs candidate in place.
          this.document = fingerprint(this.document) === candidateFingerprint ? structuredClone(saved) : { ...this.document, rev: saved.rev };
          this.error = undefined;
          if (fingerprint(this.document) === fingerprint(this.saved)) this.markSaved();
          else { this.state = 'pending'; this.emit(); }
          // New edits can reset timer requests, but cannot revoke a queued explicit flush.
        } catch (e) {
          this.forced = false; this.saveRequested = false;
          this.error = storageError(e);
          this.state = e instanceof StoreError && e.code === 'CONFLICT' ? 'conflict' : e instanceof StoreError && e.code === 'SAVE_PAUSED' ? 'blocked' : 'error';
          this.emit();
        }
      }
    } finally {
      // No await between the last queue check and releasing ownership/settling callers.
      this.running = undefined; complete();
    }
  }
  async reload() {
    const generation = this.editGeneration;
    while (this.running) await this.running;
    clearTimeout(this.timer); this.timer = undefined; this.saveRequested = false; this.forced = false;
    let complete!: () => void;
    const running = new Promise<void>(resolve => { complete = resolve; });
    this.running = running;
    try {
      const latest = await this.store.read(this.projectId);
      if (!latest) throw new StoreError('PROJECT_NOT_FOUND', 'This project no longer exists.');
      this.saved = structuredClone(latest.document); this.options.fullyLoaded = true;
      if (this.editGeneration === generation) { this.document = structuredClone(latest.document); this.markSaved(); }
      else {
        // Edits made on the old base need an explicit choice before using the freshly read rev.
        clearTimeout(this.timer); this.timer = undefined; this.saveRequested = false; this.forced = false;
        this.state = 'conflict'; this.error = new StoreError('CONFLICT', 'This project was edited while reloading. Reload or keep your changes.'); this.emit();
      }
    } catch (e) {
      clearTimeout(this.timer); this.timer = undefined; this.saveRequested = false; this.forced = false;
      this.state = 'error'; this.error = storageError(e); this.emit(); throw this.error;
    } finally {
      // A subscriber can request a save after the read is installed; retain the same ownership.
      if (this.forced || this.saveRequested) void this.drain(complete);
      else { this.running = undefined; complete(); }
    }
    await running;
  }
  async keepMine() {
    this.editGeneration++;
    const latest = await this.store.read(this.projectId);
    if (!latest) throw new StoreError('PROJECT_NOT_FOUND', 'This project no longer exists.');
    this.saved = latest.document; this.document = { ...this.document, rev: latest.document.rev };
    this.options.fullyLoaded = true; this.state = 'pending'; this.error = undefined;
    await this.flush();
  }
  bindLifecycle(targetDocument: Document = document, targetWindow: Window = window) {
    const hide = () => { if (targetDocument.visibilityState === 'hidden') void this.flush(); };
    const leave = () => { void this.flush(); };
    targetDocument.addEventListener('visibilitychange', hide); targetWindow.addEventListener('pagehide', leave);
    return () => { targetDocument.removeEventListener('visibilitychange', hide); targetWindow.removeEventListener('pagehide', leave); clearTimeout(this.timer); };
  }
}
