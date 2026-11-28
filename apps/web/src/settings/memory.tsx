// SPDX-License-Identifier: AGPL-3.0-only
// T23 agent memory in Settings: the save switch (off by default), the memory files, and view, edit, delete and clear all.
// The user may always edit or delete, whatever the switch; the switch only governs the agent's writes.
import { useEffect, useState } from 'react';
import { clearMemory, deleteMemory, listMemory, memoryEnabled, readMemory, setMemoryEnabled, writeMemory } from '../agent/workspace/memory';
import type { MemoryFile } from '../agent/workspace/memory';
import { Dialog, notify, reportError } from '../ui';

const CHANGED = 'This file changed after you opened it. Close it and view it again to edit the latest text.';

// Notes are small, so the size reads in B or KB; the shared formatBytes always shows MB.
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 2 ** 20 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 2 ** 20).toFixed(1)} MB`;

export function Memory() {
  const [enabled, setEnabled] = useState<boolean>(), [files, setFiles] = useState<MemoryFile[]>();
  const [open, setOpen] = useState<string>(), [draft, setDraft] = useState(''), [version, setVersion] = useState<number>(), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const refresh = () => listMemory().then(setFiles).catch(reportError);
  useEffect(() => { void memoryEnabled().then(setEnabled).catch(reportError); void refresh(); }, []);
  const turn = (on: boolean) => { setEnabled(on); void Promise.resolve(setMemoryEnabled(on)).catch(e => { setEnabled(!on); reportError(e); }); };
  const view = (f: MemoryFile) => { setOpen(f.path); setDraft(f.text); setVersion(f.version); };
  // An agent may write the file while it is open here: a Save over a newer version is refused and the stored text stays.
  const save = (path: string) => {
    setBusy(true);
    void readMemory(path).then(async stored => {
      if (stored?.version !== version) { notify(CHANGED); await refresh(); return; }
      setVersion((await writeMemory(path, draft)).version); await refresh();
    }).catch(reportError).finally(() => setBusy(false));
  };
  const remove = (path: string) => { if (open === path) setOpen(undefined); void deleteMemory(path).then(refresh).catch(reportError); };
  const clear = () => { setBusy(true); void clearMemory().then(() => { setOpen(undefined); setConfirm(false); return refresh(); }).catch(reportError).finally(() => setBusy(false)); };
  return <section id="agent-memory" aria-labelledby="agent-memory-title"><h2 id="agent-memory-title">Agent memory</h2>
    <label className="switch"><input type="checkbox" role="switch" aria-label="Let agents save memory" checked={!!enabled} disabled={enabled === undefined} onChange={e => turn(e.target.checked)} /> Let agents save memory</label>
    <p><small>Off by default. When on, connected agents may write notes under memory/ to recall in later sessions. Stored only in this browser; you can view, edit or delete them here at any time.</small></p>
    {files?.length ? <ul className="settings-list" aria-label="Memory files">{files.map(f => <li key={f.path} data-memory={f.path} className="row spread">
      <span>{f.path} <small>{size(f.bytes)} · updated {new Date(f.updatedAt).toLocaleString()}</small></span>
      <span className="row"><button aria-label={`View ${f.path}`} aria-expanded={open === f.path} onClick={() => open === f.path ? setOpen(undefined) : view(f)}>View</button><button className="danger" aria-label={`Delete ${f.path}`} onClick={() => remove(f.path)}>Delete</button></span>
    </li>)}</ul> : files && <p className="empty">No memory saved</p>}
    {open && <div className="settings-form"><label>{open}<textarea aria-label={`Memory file ${open}`} rows={10} value={draft} onChange={e => setDraft(e.target.value)} /></label>
      <div className="row"><button disabled={busy} onClick={() => save(open)}>Save</button><button onClick={() => setOpen(undefined)}>Close</button></div></div>}
    {!!files?.length && <button className="danger" onClick={() => setConfirm(true)}>Clear all</button>}
    {confirm && <Dialog title="Clear agent memory" close={() => setConfirm(false)}><p>Delete every memory file in this browser? This cannot be undone.</p><div className="dialog-actions"><button onClick={() => setConfirm(false)}>Cancel</button><button className="danger" disabled={busy} onClick={clear}>{busy ? 'Clearing…' : 'Clear all memory'}</button></div></Dialog>}
  </section>;
}
