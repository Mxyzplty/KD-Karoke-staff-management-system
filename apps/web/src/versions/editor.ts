// SPDX-License-Identifier: AGPL-3.0-only
// T17 in the open editor: the cross-tab channel wraps the store the autosave session writes through, the large-deletion
// guard writes its recovery checkpoint, and the checkpoint intents are installed once the session exists.
import type { ProjectStore } from '../store/database';
import type { AutosaveSession } from '../store/autosave';
import type { ProjectDocument } from '../store/model';
import { Checkpoints, installCheckpoints } from './checkpoints';
import type { Mode } from './checkpoints';
import { SaveChannel } from './crosstab';

export type Versions = {
  checkpoints: Checkpoints;
  /** The store the autosave session saves through (each save is announced to the project's other tabs). */
  store: Pick<ProjectStore, 'save' | 'read'>;
  beforeLargeDeletion: (previous: ProjectDocument) => Promise<void>;
  /** Binds the channel and the T17 intents to the session; returns the teardown, which stops listening at once and closes
   *  the channel only after the editor's final save (`final`) has settled, so that save is still announced (§45.2). */
  attach: (session: AutosaveSession) => (final?: Promise<unknown>) => void;
};
export function openVersions(store: ProjectStore, projectId: string, mode: Mode, reopen: (job: () => Promise<void>) => void): Versions {
  const channel = new SaveChannel(projectId), saves = channel.wrap(store), checkpoints = new Checkpoints(store, projectId, mode);
  return {
    checkpoints, store: saves,
    beforeLargeDeletion: async previous => { await checkpoints.add(previous, { recovery: true }); },
    attach: session => {
      const unlisten = channel.listen(session);
      const uninstall = installCheckpoints(session, { ...saves, putRow: (s, v) => store.putRow(s, v), deleteRow: (s, k) => store.deleteRow(s, k) }, checkpoints, reopen);
      return final => { uninstall(); unlisten(); void Promise.resolve(final).catch(() => {}).then(() => channel.close()); };
    },
  };
}
