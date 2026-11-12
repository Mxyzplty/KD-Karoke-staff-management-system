// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { projectStore } from './store/database';
import { AutosaveSession } from './store/autosave';
import type { ProjectRecord } from './store/model';
import { notify, reportError } from './ui';
import { EditorShell } from './editor/shell';
import { resetView } from './editor/view';
import { installRuntime } from './timeline/runtime';
import { migrateRemovals } from './masks/jobs';
import { installMasks } from './masks/smart-tools';
import { addStockToProject } from './media/stock';
import { ensureCatalogueAsset } from './catalogue/assets';
import { readMode } from './versions/checkpoints';
import { openVersions } from './versions/editor';
import type { Checkpoints } from './versions/checkpoints';
import { watchTitle } from './analysis/title';
// The editor routes every document change through this session (T03's command bus installs its intent handler on top).
export let activeSession: AutosaveSession | undefined;
export function EditorRoute({ id, navigate, demo }: { id: string; navigate: (path: string) => void; demo?: ReactNode }) {
  const [load, setLoad] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading'), [record, setRecord] = useState<ProjectRecord>(), [retry, setRetry] = useState(0), [, render] = useState(0);
  const [session, setSession] = useState<AutosaveSession>(), [checkpoints, setCheckpoints] = useState<Checkpoints>();
  // T17 restore: the job runs after this editor is torn down and before the project is opened again (once, under StrictMode too).
  const restart = useRef<{ job: () => Promise<void>; done?: Promise<void> } | undefined>(undefined);
  useEffect(() => {
    let alive = true, unbind: (() => void) | undefined, unsubscribe: (() => void) | undefined, uninstall: (() => void) | undefined, local: AutosaveSession | undefined, detach: ((final?: Promise<unknown>) => void) | undefined, untitle: (() => void) | undefined, unmask: (() => void) | undefined;
    setLoad('loading'); resetView();
    const pending = restart.current, open = () => { if (restart.current === pending) restart.current = undefined; return Promise.all([projectStore.openProject(id), readMode(projectStore)]); };
    void (pending ? (pending.done ??= pending.job()).then(open) : open()).then(([result, mode]) => {
      if (!alive) return;
      if (!result) { setLoad('missing'); return; }
      const versions = openVersions(projectStore, id, mode, job => { restart.current = { job }; setRetry(n => n + 1); });
      local = new AutosaveSession(versions.store, id, result.document, { beforeLargeDeletion: versions.beforeLargeDeletion }); activeSession = local;
      detach = versions.attach(local); setCheckpoints(versions.checkpoints);
      let lastErrorToast = -Infinity;
      unsubscribe = local.subscribe(() => {
        if (local?.state === 'error' && Date.now() - lastErrorToast >= 30000) {
          const error = local.error!;
          notify(`${'code' in error ? `${error.code}: ` : ''}${error.message} The latest change may not be saved. Saving will retry after the next change.`);
          lastErrorToast = Date.now();
        }
        render(n => n + 1);
      }); unbind = local.bindLifecycle();
      unmask = installMasks(projectStore.media, id);
      uninstall = installRuntime(local, projectStore, id, { maskMarker: mode === 'parity' ? 'both' : 'enter', addStock: async item => (await addStockToProject(projectStore, id, item)).asset, addCatalogue: cid => ensureCatalogueAsset(projectStore, id, cid), onAssets: tools => migrateRemovals({ ...tools, origin: 'user' }), ...(mode === 'parity' ? { noOp: 'reference', sliderEntries: 'step' } as const : {}) });
      setSession(local); setRecord(result.record); setLoad('ready');
      // T19 auto title while the project is still "Untitled Project" (parity: once per editor open).
      untitle = watchTitle(projectStore, id, { parity: mode === 'parity', onTitle: title => setRecord(r => r && { ...r, title, title_source: 'generated' }) });
    }).catch(e => { if (alive) { setLoad('error'); reportError(e); } });
    return () => { alive = false; untitle?.(); unmask?.(); uninstall?.(); const final = local?.flush(); detach?.(final); unbind?.(); unsubscribe?.(); if (activeSession === local) activeSession = undefined; };
  }, [id, retry]);
  if (load === 'loading') return <main><p>Opening project…</p></main>;
  if (load === 'missing' || load === 'error') return <main className="load-failure"><h1>Failed to load project</h1><p>{load === 'missing' ? 'Project not found.' : 'Couldn’t open this project. Browser storage could not be read.'}</p><button onClick={() => navigate('/')}>‹ Back to home</button>{load === 'error' && <button onClick={() => setRetry(n => n + 1)}>Retry</button>}</main>;
  return <EditorShell session={session!} record={record!} navigate={navigate} checkpoints={checkpoints!} demo={demo} />;
}
