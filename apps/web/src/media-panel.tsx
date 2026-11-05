// SPDX-License-Identifier: AGPL-3.0-only
// Footage (Uploads / Reference) and allowed-folder panels; the editor shell (T02) places them in the left panel.
import { useEffect, useRef, useState } from 'react';
import { projectStore } from './store/database';
import type { Asset, AssetLink } from './store/model';
import { Dialog, notify, reportError } from './ui';
import { uploadToProject } from './media/ingest';
import { acceptAttribute } from './media/files';
import { attachReference, deleteReference, detachReference, listReferences, retryReference, uploadReference } from './media/references';
import type { ReferenceVideo } from './media/references';
import { canPickFolders, connectFolder, folders, importFromAllowedDir, listAllowedDir } from './media/folders';
import type { Entry } from './media/folders';
import { AssetPoster, formatDuration, placeOnTimeline } from './media-ui';
import { LibraryBrowser, Preview, clock, reportIngest, rowRange, useFootageSearch } from './library';
import { setDragPayload } from './editor/dnd';

/** Footage → Uploads (part 3 §46.16): search on Enter, the library picker (folder button), upload, the "In project" grid;
 *  a thumbnail click asks T03 to append the clip; hover × removes the asset from the project at once (timeline clips stay);
 *  the eye previews without adding anything; thumbnails drag as the timeline data type (kind "assets").
 *  T19: a search lists one tile per result row with its [start–end] range in place of the grid (FS-P08). */
export function FootagePanel({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<{ link: AssetLink; asset: Asset }[]>([]), upload = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(''), [picker, setPicker] = useState<string[]>(), [preview, setPreview] = useState<{ asset: Asset; start?: number }>();
  const found = useFootageSearch(projectId), linked = new Map(rows.map(r => [r.asset.id, r])), hits = (found.response?.results ?? []).filter(r => linked.has(r.assetId));
  async function refresh() {
    const [links, library] = await Promise.all([projectStore.projectAssets(projectId), projectStore.library()]);
    setRows(links.flatMap(link => { const asset = library.assets.find(a => a.id === link.assetId); return asset ? [{ link, asset }] : []; }));
  }
  useEffect(() => { void refresh().catch(reportError); }, [projectId]);
  const working = rows.some(r => r.asset.processing_status === 'uploading' || r.asset.processing_status === 'processing');
  useEffect(() => { const t = setTimeout(() => void refresh().catch(reportError), working ? 1500 : 4000); return () => clearTimeout(t); }, [rows, working]);
  async function add(files: File[]) {
    try { const r = await uploadToProject(projectStore, projectId, files); reportIngest(r); await refresh(); void Promise.all(r.preparing).then(refresh); } catch (e) { reportError(e); }
  }
  /** Done in the library picker adds every checked asset that is not in the project yet (removal stays with ×). */
  async function addPicked(ids: string[]) {
    const linked = new Set(rows.map(r => r.asset.id)), added = ids.filter(id => !linked.has(id));
    try { for (const id of added) await projectStore.attach(projectId, id); if (added.length) notify(`Added ${added.length} ${added.length === 1 ? 'asset' : 'assets'} from your library to this project.`); } catch (e) { reportError(e); }
    setPicker(undefined); await refresh().catch(reportError);
  }
  return <section aria-label="Footage" data-tour="footage" onDragOver={e => e.preventDefault()} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void add(Array.from(e.dataTransfer.files)); } }}>
    <div className="footage-tools">
      <form role="search" onSubmit={e => { e.preventDefault(); found.submit(search); }}><input aria-label="Search footage" placeholder="Search footage…" value={search} onChange={e => { setSearch(e.target.value); if (!e.target.value.trim() && found.query) found.submit(''); }} /></form>
      <button aria-label="Add from your library" title="Your library" onClick={() => setPicker(rows.map(r => r.asset.id))}>▤</button>
      <button aria-label="Upload" onClick={() => upload.current?.click()}>Upload</button>
    </div>
    <input ref={upload} type="file" multiple hidden accept={`${acceptAttribute},video/*,image/*,audio/*`} aria-label="Upload footage to this project" onChange={e => { void add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
    {found.query ? <><h3>Search results</h3>{found.busy ? <p role="status">Searching…</p> : found.error ? <p role="alert">{found.error}</p>
      : !hits.length ? <div className="empty"><p><strong>No clips match your search</strong></p><p>Try a different search term</p></div>
      : <ul className="footage" aria-label="Search results">{hits.map((hit, i) => { const { link, asset } = linked.get(hit.assetId)!, [start, end] = rowRange(hit, asset); return <li key={i} data-agent-id={link.agent_id}>
        <button className="thumb" aria-label={`Add ${asset.name} to the timeline`} onClick={() => placeOnTimeline(asset.name, [asset.id])} draggable onDragStart={e => setDragPayload(e.dataTransfer, { kind: 'assets', items: [{ assetId: asset.id, type: asset.type, name: asset.name }] })}><AssetPoster asset={asset} /></button>
        <span>{asset.name}</span><small>[{clock(start)}–{clock(end)}]</small>
        <div className="thumb-actions"><button aria-label={`Preview ${asset.name} from ${clock(start)}`} onClick={() => setPreview({ asset, start })}>&#128065;</button></div>
      </li>; })}</ul>}</>
    : <><h3>In project</h3>
    {!rows.length ? <p>No footage in this project yet.</p> : <ul className="footage" aria-label="In project">{rows.map(({ link, asset }) => <li key={link.id} data-agent-id={link.agent_id}>
      <button className="thumb" aria-label={`Add ${asset.name} to the timeline`} onClick={() => placeOnTimeline(asset.name, [asset.id])} draggable onDragStart={e => setDragPayload(e.dataTransfer, { kind: 'assets', items: [{ assetId: asset.id, type: asset.type, name: asset.name }] })}><AssetPoster asset={asset} /></button>
      <span>{asset.name}</span><small>{link.agent_id}{asset.source?.attribution ? ` · ${asset.source.attribution}` : ''}</small>
      <div className="thumb-actions">
        <button aria-label={`Preview ${asset.name}`} onClick={() => setPreview({ asset })}>&#128065;</button>
        <button aria-label={`Remove ${asset.name} from this project`} onClick={() => void projectStore.detach(projectId, asset.id).then(refresh).then(() => notify(`${asset.name} removed from this project.`)).catch(reportError)}>×</button>
      </div>
    </li>)}</ul>}</>}
    <details className="allowed-folders"><summary>Allowed folders on this device</summary><FoldersPanel projectId={projectId} /></details>
    {picker && <Dialog title="Your Assets" close={() => setPicker(undefined)}><LibraryBrowser picker selected={picker} onSelected={setPicker} /><div className="dialog-actions"><button className="primary" onClick={() => void addPicked(picker)}>Done</button></div></Dialog>}
    {preview && <Preview asset={preview.asset} start={preview.start} close={() => setPreview(undefined)} />}
  </section>;
}
export const analysisLabel = (r: ReferenceVideo) => r.analysis.status === 'no-provider' ? 'Not analysed — no AI provider connected' : r.analysis.status === 'failed' ? `Analysis failed${r.analysis.error ? `: ${r.analysis.error}` : ''}` : r.analysis.status === 'complete' ? 'Analysed' : 'Analysing…';
/** Footage → Reference (findings part 2 §36): list, upload (hash reuse), attach/detach, retry, delete with confirmation. */
export function ReferencePanel({ projectId }: { projectId: string }) {
  const [refs, setRefs] = useState<ReferenceVideo[]>([]), input = useRef<HTMLInputElement>(null);
  const refresh = () => listReferences(projectStore).then(setRefs).catch(reportError);
  useEffect(() => { void refresh(); }, []);
  async function upload(file?: File) {
    if (!file) return;
    try { const r = await uploadReference(projectStore, file); notify(r.reused ? `Reused your saved reference “${r.reference.name}”.` : `Saved reference “${r.reference.name}”.`); await refresh(); } catch (e) { reportError(e); }
  }
  async function act(fn: () => Promise<unknown>) { try { await fn(); } catch (e) { reportError(e); } await refresh(); }
  return <section aria-label="Reference videos">
    <div className="section-heading"><h3>Reference videos</h3><span className="chip">{refs.length} saved</span><button onClick={() => input.current?.click()}>Upload reference video</button></div>
    <input ref={input} type="file" hidden accept="video/*,.mp4,.mov,.webm,.mkv,.m4v" aria-label="Upload a reference video" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
    {!refs.length ? <p>No reference videos yet.</p> : <ul className="reference-list" aria-label="Saved references">{refs.map(r => {
      const attached = r.projects.includes(projectId);
      return <li key={r.id}><strong>{r.name}</strong><small>{r.durationMs !== null ? formatDuration(r.durationMs) : '—'} · {analysisLabel(r)}</small>
        <button onClick={() => void act(() => (attached ? detachReference : attachReference)(projectStore, projectId, r.id))}>{attached ? 'Detach' : 'Attach'}</button>
        {r.analysis.status !== 'complete' && <button aria-label={`Retry analysis of ${r.name}`} onClick={() => void act(async () => { const x = await retryReference(projectStore, r.id); if (x.analysis.status === 'no-provider') notify('Reference analysis needs an AI provider (T19). Nothing was analysed.'); })}>Retry</button>}
        <button aria-label={`Delete reference ${r.name}`} onClick={() => { if (confirm(`Delete “${r.name}”? It is removed from every project it is attached to.`)) void act(() => deleteReference(projectStore, r.id)); }}>×</button>
      </li>;
    })}</ul>}
  </section>;
}
/** Allowed folders: connect a folder (read-only handle), browse one level, import files as project footage. */
export function FoldersPanel({ projectId }: { projectId: string }) {
  const [names, setNames] = useState<string[]>([]), [path, setPath] = useState(''), [entries, setEntries] = useState<Entry[]>([]), [note, setNote] = useState(''), fallback = useRef<HTMLInputElement>(null);
  const refresh = async (at = path) => {
    setNames((await folders(projectStore)).map(f => f.name));
    if (!at) { setEntries([]); return; }
    const r = await listAllowedDir(projectStore, at);
    if (r.success) { setEntries(r.entries); setNote(r.truncated ? 'Only the first 500 entries are shown.' : ''); } else { setEntries([]); setNote(`${r.error}: ${r.message}`); }
  };
  useEffect(() => { void refresh().catch(reportError); }, [path]);
  async function importFile(entry: Entry) {
    const r = await importFromAllowedDir(projectStore, projectId, [entry.path]);
    if (!r.success) notify(`${r.error}: ${r.message}`); else { for (const f of r.failed) notify(`${f.error}: ${f.message}`); if (r.imported.length) notify(`Imported ${entry.name} into this project.`); }
  }
  return <section aria-label="Folders">
    <h3>Allowed folders</h3>
    {canPickFolders() ? <button onClick={() => void connectFolder(projectStore).then(() => refresh()).catch(e => { if ((e as DOMException).name !== 'AbortError') reportError(e); })}>Connect a folder</button>
      : <><p>This browser cannot connect folders. Pick or drop files instead.</p><button onClick={() => fallback.current?.click()}>Choose files</button>
        <input ref={fallback} type="file" multiple hidden aria-label="Choose files to import" onChange={e => { void uploadToProject(projectStore, projectId, Array.from(e.target.files ?? [])).then(reportIngest).catch(reportError); e.target.value = ''; }} /></>}
    <ul className="dir-list" aria-label="Connected folders">{names.map(n => <li key={n}><button onClick={() => setPath(n)}>{n}</button></li>)}</ul>
    {path && <><nav aria-label="Folder path">{path} {path.includes('/') && <button onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>Up</button>}</nav>
      {note && <p>{note}</p>}
      <ul className="dir-list" aria-label="Folder entries">{entries.map(e => <li key={e.path}>{e.kind === 'directory' ? <button onClick={() => setPath(e.path)}>{e.name}/</button> : <><span>{e.name}</span><small>{e.type}</small><button aria-label={`Import ${e.name}`} onClick={() => void importFile(e).catch(reportError)}>Import</button></>}</li>)}</ul></>}
  </section>;
}
