// SPDX-License-Identifier: AGPL-3.0-only
// T17 cross-tab saves (findings part 2 §36): one BroadcastChannel per project. After each successful save a tab posts
// `{type, rev, senderId}`. A receiving tab ignores its own messages and revs it has already seen; a clean tab refetches
// (T01 reload), a tab with unsaved changes shows the conflict state. This adds to T01's conditional write, which still
// refuses any save based on an older rev.
import type { ProjectStore } from '../store/database';
import type { AutosaveSession } from '../store/autosave';

export const channelName = (projectId: string) => `cutframe-project-${projectId}`;
export const SAVE_MESSAGE = 'cutframe-save';
export type SaveMessage = { type: typeof SAVE_MESSAGE; rev: number; senderId: string };
/** The open editor's channel (tests close it to simulate a lost message). */
export let activeChannel: SaveChannel | undefined;

export class SaveChannel {
  readonly senderId = crypto.randomUUID();
  private channel?: BroadcastChannel;
  private lastSeen = -1;
  constructor(public projectId: string) {
    if (typeof BroadcastChannel === 'function') this.channel = new BroadcastChannel(channelName(projectId));
  }
  /** The store as the autosave session sees it: every successful save is announced to the other tabs. */
  wrap<S extends Pick<ProjectStore, 'save' | 'read'>>(store: S): Pick<ProjectStore, 'save' | 'read'> {
    return {
      read: id => store.read(id),
      save: async (id, document, expectedRev) => { const saved = await store.save(id, document, expectedRev); this.post(saved.rev); return saved; },
    };
  }
  post(rev: number) {
    this.lastSeen = Math.max(this.lastSeen, rev);
    this.channel?.postMessage({ type: SAVE_MESSAGE, rev, senderId: this.senderId } satisfies SaveMessage);
  }
  /** Binds the receiving side to the editor's session; returns the unbind function. */
  listen(session: AutosaveSession): () => void {
    const channel = this.channel; if (!channel) return () => {};
    const receive = (e: MessageEvent) => {
      const m = e.data as Partial<SaveMessage>;
      if (m?.type !== SAVE_MESSAGE || typeof m.rev !== 'number' || m.senderId === this.senderId) return;
      if (m.rev <= Math.max(this.lastSeen, session.document.rev)) return;
      this.lastSeen = m.rev;
      // Clean: refetch the stored project. Dirty: the pending save meets the newer stored rev and enters the conflict state.
      if (session.state === 'saved') void session.reload().catch(() => {});
      else if (session.state !== 'conflict' && session.state !== 'blocked') void session.flush();
    };
    channel.addEventListener('message', receive); activeChannel = this;
    return () => channel.removeEventListener('message', receive);
  }
  close() { this.channel?.close(); this.channel = undefined; if (activeChannel === this) activeChannel = undefined; }
}
