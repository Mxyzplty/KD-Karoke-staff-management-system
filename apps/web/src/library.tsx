// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { projectStore } from './store/database';
import { queryAssets } from './store/model';
import type { Asset, Folder, LibrarySnapshot } from './store/model';
import { Dialog, InlineName, notify, reportError } from './ui';
import { relinkOriginal, scanMissing, uploadReusing, uploadToLibrary } from './media/ingest';
import type { IngestResult } from './media/ingest';
import { prepareAsset } from './media/prepare';
import { acceptAttribute } from './media/files';
import { AssetPoster, analysisFailed, useDuplicateChoice, useFilePick } from './media-ui';
import { clipRange, isRange, searchFootage } from './analysis/footage';
import type { SearchResponse, SearchRow } from './analysis/types';
import { TemplateLibrary } from './templates/ui';

/** One notice per batch: stored / reused / skipped counts and each failure's code. */
export function reportIngest(r: IngestResult) {
  const parts = [r.uploaded.length && `${r.uploaded.length} stored`, r.reused.length && `${r.reused.length} reused`, r.skipped.length && `${r.skipped.length} skipped`].filter(Boolean);
  if (parts.length) notify(`Media stored locally (${parts.join(', ')}). Thumbnails, waveforms, proxies and analysis are prepared in the background.`);
  for (const f of r.failed) reportError(f.error);
}

/** Footage search (T19, FS-P08): one request per submit and none while typing; a new submit cancels the previous one;
 *  an empty query clears. The Library sends no `projectId`, the editor's Footage panel its project's (part 3 §44.6). */
export function useFootageSearch(projectId?: string) {
  const [state, setState] = useState<{ query: string; busy?: boolean; response?: SearchResponse; error?: string }>({ query: '' });
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  function submit(text: string) {
    pending.current?.abort(); pending.current = undefined;
    const query = text.trim();
    if (!query) return setState({ query: '' });
    const controller = pending.current = new AbortController();
    setState({ query, busy: true });
    searchFootage(query, { projectId }, controller.signal).then(
      response => { if (!controller.signal.aborted) setState({ query, response }); },
      (e: Error) => { if (!controller.signal.aborted) setState({ query, error: e.message }); });
  }
  return { ...state, submit };
}
/** m:ss of a source time in seconds (clip tiles and their ranges). */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** The [start, end] s a result row stands for: its range, or the whole asset. */
export const rowRange = (row: SearchRow, asset: Asset): [number, number] => isRange(row) ? [row.startTime, row.endTime] : [0, (asset.durationMs ?? 0) / 1000];
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** "Download clip": a range row is cut to its own file; a whole-asset row downloads the file. */
export async function downloadClip(row: SearchRow, asset: Asset) {
  try {
    if (!isRange(row)) return downloadBlob(await projectStore.media.read(asset.id), asset.name);
    const clip = await clipRange(projectStore, asset, row.startTime, row.endTime);
    downloadBlob(clip.blob, clip.filename);
  } catch (e) { reportError(e); }
}

type Menu = { kind: 'asset' | 'folder' | 'canvas'; id?: string; x: number; y: number };
type Filters = { from: string; to: string; location: string };
const noFilters: Filters = { from: '', to: '', location: '' };
function folderPath(id: string, folders: Folder[]): string {
  const f = folders.find(f => f.id === id); return f ? `${f.parentId ? `${folderPath(f.parentId, folders)} / ` : ''}${f.name}` : '';
}
export function Library({ navigate }: { navigate: (path: string) => void }) {
  const [tab, setTab] = useState('assets');
  return <><p className="eyebrow">YOUR MEDIA</p><h1>Library</h1><p>Keep your media organised in this browser.</p><div role="tablist" aria-label="Library"><button role="tab" aria-selected={tab === 'assets'} onClick={() => setTab('assets')}>Assets</button><button role="tab" aria-selected={tab === 'templates'} onClick={() => setTab('templates')}>Templates</button></div>
    {tab === 'assets' ? <LibraryBrowser /> : <TemplateLibrary navigate={navigate} />}</>;
}
export function LibraryBrowser({ picker = false, selected: supplied, onSelected }: { picker?: boolean; selected?: string[]; onSelected?: (ids: string[]) => void }) {
  const [data, setData] = useState<LibrarySnapshot>({ assets: [], folders: [], links: [] }), [loading, setLoading] = useState(true), [failed, setFailed] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null), [subtab, setSubtab] = useState('assets'), [type, setType] = useState('all');
  const [sort, setSort] = useState<'uploaded' | 'recorded'>('uploaded'), [direction, setDirection] = useState<'DESC' | 'ASC'>('DESC'), [view, setView] = useState('grid');
  const [search, setSearch] = useState(''), found = useFootageSearch(), query = found.query, [clips, setClips] = useState(false), [filterOpen, setFilterOpen] = useState(false), [draft, setDraft] = useState(noFilters), [filters, setFilters] = useState(noFilters);
  const [localSelected, setLocalSelected] = useState<string[]>([]), [selectedFolder, setSelectedFolder] = useState<string>();
  const selected = supplied ?? localSelected, select = onSelected ?? setLocalSelected;
  const [newFolder, setNewFolder] = useState(false), [menu, setMenu] = useState<Menu>(), [rename, setRename] = useState<{ kind: 'asset' | 'folder'; id: string }>(), [move, setMove] = useState(false);
  const [newDestination, setNewDestination] = useState(false);
  const [deleteAssets, setDeleteAssets] = useState<{ ids: string[]; usage: number }>(), [deleteFolder, setDeleteFolder] = useState<Folder>(), [busy, setBusy] = useState(false), [preview, setPreview] = useState<Asset>();
  const [clipPreview, setClipPreview] = useState<{ asset: Asset; start: number }>();
  const [undoMove, setUndoMove] = useState<{ id: string; folderId: string | null }[]>();
  const upload = useRef<HTMLInputElement>(null), grid = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; base: string[] } | null>(null);
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number }>();
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const duplicates = useDuplicateChoice(), relinkPick = useFilePick();
  async function refresh() { try { setMissing(new Set(await scanMissing(projectStore))); setData(await projectStore.library()); setFailed(false); } catch (e) { setFailed(true); reportError(e); } finally { setLoading(false); } }
  useEffect(() => { void refresh(); }, []);
  // Preparation runs in the background: refresh while anything is still uploading or processing.
  const working = data.assets.some(a => a.processing_status === 'uploading' || a.processing_status === 'processing');
  useEffect(() => { if (!working) return; const t = setTimeout(() => void refresh(), 1500); return () => clearTimeout(t); }, [data, working]);
  async function relink(asset: Asset) {
    const picked = await relinkPick.pick(); if (!picked) return;
    try { await relinkOriginal(projectStore, asset.id, picked); notify(`“${asset.name}” is linked to its original again.`); } catch (e) { reportError(e); }
    await refresh();
  }
  async function retry(asset: Asset) { await prepareAsset(projectStore, asset.id, { manual: true }).catch(reportError); await refresh(); }
  useEffect(() => { const close = () => setMenu(undefined); window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, []);
  const assets = queryAssets(data.assets, { folderId, type, sort, direction, ...filters });
  const folders = data.folders.filter(f => f.parentId === folderId).sort((a, b) => a.name.localeCompare(b.name));
  // Search results: Show files = one tile per asset in the order of its best row; Show clips = one tile per row (FS-P08).
  const byId = new Map(data.assets.map(a => [a.id, a])), rows = (found.response?.results ?? []).filter(r => byId.has(r.assetId));
  const searching = !!query && subtab === 'assets', showClips = searching && clips && !picker;
  const tiles = searching ? [...new Set(rows.map(r => r.assetId))].map(id => byId.get(id)!) : assets, shownFolders = searching ? [] : folders;
  const ids = tiles.map(a => a.id), activeFilters = Object.values(filters).some(Boolean);
  const toggle = (id: string) => { setSelectedFolder(undefined); select(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]); };
  async function perform(action: () => Promise<unknown>) { try { await action(); await refresh(); } catch (e) { reportError(e); } }
  async function ingest(files: FileList | File[]) {
    setBusy(true);
    try {
      // The picker (wizard) reuses silently by name + size; the Library page asks about duplicate names (part 2 §25, §26).
      const result = picker ? await uploadReusing(projectStore, Array.from(files), { folderId }) : await uploadToLibrary(projectStore, Array.from(files), duplicates.ask, { folderId });
      if (picker) select([...new Set([...selected, ...result.assets.map(a => a.id)])]);
      reportIngest(result); await refresh();
      void Promise.all(result.preparing).then(refresh);
    } catch (e) { reportError(e); await refresh(); } finally { setBusy(false); }
  }
  async function download(ids: string[]) {
    try {
      for (const id of ids) {
        const asset = data.assets.find(a => a.id === id); if (!asset) continue;
        const url = URL.createObjectURL(await projectStore.media.read(id)), link = document.createElement('a');
        link.href = url; link.download = asset.name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { reportError(e); }
  }
  async function askDelete(ids: string[]) { try { setDeleteAssets({ ids, usage: await projectStore.usage(ids) }); } catch (e) { reportError(e); } }
  function showMenu(event: React.MouseEvent, kind: Menu['kind'], id?: string) {
    event.preventDefault(); event.stopPropagation();
    if (kind === 'asset' && id && !selected.includes(id)) select([id]);
    if (kind === 'folder') setSelectedFolder(id);
    setMenu({ kind, id, x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 260) });
  }
  async function moveTo(destination: string | null, moving = selected) {
    const previous = data.assets.filter(a => moving.includes(a.id)).map(a => ({ id: a.id, folderId: a.folderId }));
    await perform(async () => { await projectStore.moveAssets(moving, destination); setUndoMove(previous); setMove(false); select([]); notify('Assets moved.'); });
  }
  const folderTree = new Set(deleteFolder ? [deleteFolder.id] : []);
  for (let before = -1; before !== folderTree.size;) { before = folderTree.size; for (const f of data.folders) if (f.parentId && folderTree.has(f.parentId)) folderTree.add(f.id); }
  const folderAssetCount = data.assets.filter(a => a.folderId && folderTree.has(a.folderId)).length;
  return <section className="library-browser" onDragOver={e => e.preventDefault()} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void ingest(e.dataTransfer.files); } }}>
    {!picker && <><div className="section-heading"><div role="tablist" aria-label="Media collections"><button role="tab" aria-selected={subtab === 'assets'} onClick={() => setSubtab('assets')}>Assets ({data.assets.length})</button><button role="tab" aria-selected={subtab === 'exports'} onClick={() => setSubtab('exports')}>Exports</button></div><button disabled={busy} onClick={() => upload.current?.click()}>{busy ? 'Storing…' : 'Upload'}</button></div>
      <div className="stats"><div>Storage<strong>{(data.assets.reduce((n, a) => n + a.sizeBytes, 0) / 1e9).toFixed(2)} GB</strong></div><div>Total assets<strong>{data.assets.length}</strong></div></div></>}
    <input ref={upload} type="file" multiple accept={`${acceptAttribute},video/*,image/*,audio/*`} hidden aria-label="Upload media" onChange={e => { if (e.target.files) void ingest(Array.from(e.target.files)); e.target.value = ''; }} />
    {relinkPick.element}{duplicates.dialog}
    <div className="toolbar">
      <form onSubmit={e => { e.preventDefault(); if (subtab === 'assets') found.submit(search); }}><input aria-label={subtab === 'exports' ? 'Search exports' : 'Search media'} placeholder={subtab === 'exports' ? 'Search exports…' : 'Search media…'} value={search} onChange={e => { setSearch(e.target.value); if (!e.target.value.trim() && query) found.submit(''); }} /></form>
      {subtab === 'assets' && <><div role="group" aria-label="Media type">{(['all', 'video', 'image', 'audio'] as const).map(t => <button key={t} aria-pressed={type === t} onClick={() => setType(t)}>{({ all: 'All', video: 'Video', image: 'Images', audio: 'Audio' })[t]}</button>)}</div>
        <label>Sort <select aria-label="Sort field" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="uploaded">Uploaded</option><option value="recorded">Recorded</option></select></label><button title={direction === 'DESC' ? 'Newest first' : 'Oldest first'} onClick={() => setDirection(direction === 'DESC' ? 'ASC' : 'DESC')}>{direction}</button><button aria-expanded={filterOpen} aria-label={activeFilters ? 'Filters active' : 'Filters'} onClick={() => setFilterOpen(!filterOpen)}>Filters{activeFilters ? ' •' : ''}</button></>}
      <div role="group" aria-label="View"><button aria-pressed={view === 'grid'} onClick={() => setView('grid')}>Grid</button><button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button></div>
    </div>
    {filterOpen && subtab === 'assets' && <form className="filters" onSubmit={e => { e.preventDefault(); setFilters({ ...draft }); setFilterOpen(false); }}><label>Date from<input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label><label>Date to<input type="date" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label><label>Location<input value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} /></label><button type="submit">Apply Filters</button></form>}
    {activeFilters && <button onClick={() => { setFilters(noFilters); setDraft(noFilters); }}>Clear</button>}
    {searching && <div role="group" aria-label="Search results">{!picker && <><button aria-pressed={!clips} onClick={() => setClips(false)}>Show files</button><button aria-pressed={clips} onClick={() => setClips(true)}>Show clips</button></>}<button onClick={() => { found.submit(''); setSearch(''); }}>Clear search</button></div>}
    {subtab === 'exports' ? <div className="empty"><h2>No exports yet</h2><p>Finished exports will appear here. Export records are not yet implemented (T16).</p></div>
      : searching && found.busy ? <p role="status">Searching…</p>
      : searching && found.error ? <div className="empty" role="alert"><h2>Search couldn’t run</h2><p>{found.error}</p></div>
      : showClips ? <div className={`asset-grid ${view}`} aria-label="Clip results">
        {rows.map((row, i) => { const a = byId.get(row.assetId)!, [start, end] = rowRange(row, a); return <article key={i} className="asset" data-asset-id={a.id}>
          <div style={{ position: 'relative' }}><AssetPoster asset={a} />{isRange(row) && <span className="badge range" style={{ left: '.3rem', bottom: '.3rem' }}>{clock(start)}–{clock(end)}</span>}</div>
          <strong>{a.name}</strong><small>{a.type.toUpperCase()} · {clock(start)}–{clock(end)}</small>
          <div className="asset-actions"><button aria-label={`Preview ${a.name} from ${clock(start)}`} onClick={() => setClipPreview({ asset: a, start })}>Preview</button><button aria-label={`Download clip ${a.name} ${clock(start)}–${clock(end)}`} onClick={() => void downloadClip(row, a)}>Download clip</button></div>
        </article>; })}
        {!rows.length && <div className="empty"><h2>No clips match your search</h2><p>Try a different search term</p></div>}
      </div> : <>
      {!searching && <><nav className="breadcrumbs" aria-label="Library location"><button onClick={() => { setFolderId(null); select([]); }}>All assets</button>{folderId && <><span>›</span><span>{folderPath(folderId, data.folders)}</span>{data.folders.find(f => f.id === folderId)?.parentId && <button onClick={() => { setFolderId(data.folders.find(f => f.id === folderId)?.parentId ?? null); select([]); }}>Up one folder</button>}</>}</nav>
      {newFolder ? <input autoFocus aria-label="Folder name" placeholder="Folder name" onKeyDown={e => { if (e.key === 'Escape') setNewFolder(false); if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={e => { const name = e.target.value.trim(); setNewFolder(false); if (name) void perform(() => projectStore.createFolder(name, folderId)); }} /> : <button onClick={() => setNewFolder(true)}>New folder</button>}</>}
      {loading ? <p>Loading library…</p> : failed ? <button onClick={() => void refresh()}>Retry loading library</button> : <div ref={grid} className={`asset-grid ${view}`} onContextMenu={e => showMenu(e, 'canvas')} onPointerDown={e => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('article,button,input')) return;
        drag.current = { x: e.clientX, y: e.clientY, base: e.ctrlKey || e.shiftKey ? selected : [] }; e.currentTarget.setPointerCapture(e.pointerId);
      }} onPointerMove={e => {
        if (!drag.current) return;
        const r = { x: Math.min(e.clientX, drag.current.x), y: Math.min(e.clientY, drag.current.y), w: Math.abs(e.clientX - drag.current.x), h: Math.abs(e.clientY - drag.current.y) }; setBand(r);
        const touched = Array.from(grid.current?.querySelectorAll<HTMLElement>('[data-asset-id]') ?? []).filter(el => { const b = el.getBoundingClientRect(); return b.left < r.x + r.w && b.right > r.x && b.top < r.y + r.h && b.bottom > r.y; }).map(el => el.dataset.assetId!);
        select([...new Set([...drag.current.base, ...touched])]);
      }} onPointerUp={() => { drag.current = null; setBand(undefined); }}>
        {shownFolders.map(f => <article key={f.id} className={`folder ${selectedFolder === f.id ? 'selected' : ''}`} onClick={() => setSelectedFolder(f.id)} onDoubleClick={() => { setFolderId(f.id); select([]); setSelectedFolder(undefined); }} onContextMenu={e => showMenu(e, 'folder', f.id)} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { const moved = e.dataTransfer.getData('application/x-cutframe-assets'); if (moved) { e.preventDefault(); e.stopPropagation(); try { const ids = JSON.parse(moved) as string[]; void moveTo(f.id, ids); } catch (error) { reportError(error); } } }}>
          <span aria-hidden="true">▰</span>{rename?.id === f.id ? <InlineName initial={f.name} label="Folder title" cancel={() => setRename(undefined)} commit={name => { setRename(undefined); void perform(() => projectStore.rename('folder', f.id, name)); }} /> : <strong>{f.name}</strong>}<small>{data.assets.filter(a => a.folderId === f.id).length + data.folders.filter(x => x.parentId === f.id).length} items</small><button aria-label={`Open folder ${f.name}`} onClick={() => { setFolderId(f.id); select([]); }}>Open</button><button aria-label={`Actions for folder ${f.name}`} onClick={e => showMenu(e, 'folder', f.id)}>…</button>
        </article>)}
        {tiles.map(a => <article data-asset-id={a.id} key={a.id} className={`asset ${selected.includes(a.id) ? 'selected' : ''}`} draggable onDragStart={e => e.dataTransfer.setData('application/x-cutframe-assets', JSON.stringify(selected.includes(a.id) ? selected : [a.id]))} onClick={() => toggle(a.id)} onContextMenu={e => showMenu(e, 'asset', a.id)}>
          <AssetPoster asset={a} missing={missing.has(a.id)} /><input aria-label={`Select ${a.name}`} type="checkbox" checked={selected.includes(a.id)} onClick={e => e.stopPropagation()} onChange={() => toggle(a.id)} />
          {rename?.id === a.id ? <InlineName initial={a.name} label="Asset name" cancel={() => setRename(undefined)} commit={name => { setRename(undefined); void perform(() => projectStore.rename('asset', a.id, name)); }} /> : <strong onDoubleClick={e => { e.stopPropagation(); setRename({ kind: 'asset', id: a.id }); }}>{a.name}</strong>}
          <small>{a.type.toUpperCase()} · {(a.sizeBytes / 1e6).toFixed(2)} MB{a.durationMs !== null ? ` · ${(a.durationMs / 1000).toFixed(1)}s` : ''}</small>
          {picker ? <button aria-label={`Add ${a.name}`} onClick={e => { e.stopPropagation(); if (!selected.includes(a.id)) select([...selected, a.id]); }}>＋</button> : <div className="asset-actions" onClick={e => e.stopPropagation()}><button aria-label={`Preview ${a.name}`} onClick={() => setPreview(a)}>Preview</button><button aria-label={`Rename ${a.name}`} onClick={() => setRename({ kind: 'asset', id: a.id })}>Rename</button><button aria-label={`Download ${a.name}`} onClick={() => void download([a.id])}>Download</button><button aria-label={`Delete ${a.name}`} onClick={() => void askDelete([a.id])}>Delete</button>
            {missing.has(a.id) && <button aria-label={`Relink ${a.name}`} onClick={() => void relink(a)}>Relink</button>}
            {!missing.has(a.id) && ((a.processing_status === 'failed' && a.last_error_code !== 'UPLOAD_INTERRUPTED') || analysisFailed(a)) && <button aria-label={`Retry ${a.name}`} onClick={() => void retry(a)}>Retry</button>}</div>}
        </article>)}
        {searching && !tiles.length && <div className="empty"><h2>No assets match your search</h2><p>Try a different search term</p></div>}
        {!searching && !assets.length && !folders.length && <div className="empty"><h2>{folderId ? 'This folder is empty' : 'No assets yet'}</h2><p>Upload media to get started.</p><button onClick={() => upload.current?.click()}>Upload files</button></div>}
      </div>}
    </>}
    {selected.length > 0 && <div className="selection-bar" role="group" aria-label="Selected assets"><strong>{selected.length} selected</strong><button onClick={() => select(ids.every(id => selected.includes(id)) ? [] : ids)}>{ids.every(id => selected.includes(id)) ? 'None' : 'All'}</button><button onClick={() => void download(selected)}>Download ({selected.length})</button>{!picker && <><button onClick={() => setMove(!move)}>Move</button><button className="danger" onClick={() => void askDelete(selected)}>Delete ({selected.length})</button></>}<button aria-label="Clear selection" onClick={() => select([])}>×</button></div>}
    {undoMove && <div className="move-undo">Assets moved. <button onClick={() => void perform(async () => { for (const row of undoMove) await projectStore.moveAssets([row.id], row.folderId); setUndoMove(undefined); })}>Undo move</button><button aria-label="Dismiss move undo" onClick={() => setUndoMove(undefined)}>×</button></div>}
    {move && <div className="move-menu" role="group" aria-label="Move to"><h3>Move to</h3>{[{ id: null, name: 'All assets' }, ...data.folders.map(f => ({ id: f.id, name: folderPath(f.id, data.folders) }))].map(f => <button key={f.id ?? 'root'} disabled={selected.length > 0 && selected.every(id => data.assets.find(a => a.id === id)?.folderId === f.id)} onClick={() => void moveTo(f.id)}>{f.name}</button>)}{newDestination ? <input autoFocus aria-label="Destination folder name" placeholder="Folder name" onKeyDown={e => { if (e.key === 'Escape') setNewDestination(false); if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={e => { const name = e.target.value.trim(); setNewDestination(false); if (name) void perform(() => projectStore.createFolder(name, folderId)); }} /> : <button onClick={() => setNewDestination(true)}>New folder…</button>}<button onClick={() => setMove(false)}>Cancel</button></div>}
    {menu && <div role="menu" className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') setMenu(undefined); }}>
      {menu.kind === 'canvas' ? <><button role="menuitem" onClick={() => { setNewFolder(true); setMenu(undefined); }}>New folder</button><button role="menuitem" onClick={() => { upload.current?.click(); setMenu(undefined); }}>Upload files</button></> : menu.kind === 'folder' ? <><button role="menuitem" onClick={() => { setFolderId(menu.id!); select([]); setMenu(undefined); }}>Open</button><button role="menuitem" onClick={() => { setRename({ kind: 'folder', id: menu.id! }); setMenu(undefined); }}>Rename</button><button role="menuitem" onClick={() => { setDeleteFolder(data.folders.find(f => f.id === menu.id)); setMenu(undefined); }}>Delete folder</button></> : <>
        {selected.length === 1 && <button role="menuitem" onClick={() => { setPreview(data.assets.find(a => a.id === menu.id)); setMenu(undefined); }}>Preview</button>}<button role="menuitem" onClick={() => { void download(selected); setMenu(undefined); }}>Download ({selected.length})</button>{selected.length === 1 && <button role="menuitem" onClick={() => { setRename({ kind: 'asset', id: menu.id! }); setMenu(undefined); }}>Rename</button>}<button role="menuitem" onClick={() => { setMove(true); setMenu(undefined); }}>Move to ▸</button><button role="menuitem" onClick={() => { void askDelete(selected); setMenu(undefined); }}>Delete ({selected.length})</button>
      </>}
    </div>}
    {band && <div className="selection-band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }} />}
    {deleteAssets && <Dialog title={`Delete ${deleteAssets.ids.length} asset(s)`} close={() => !busy && setDeleteAssets(undefined)}><p>This deletion is permanent and cannot be undone.</p><p>Used in {deleteAssets.usage} project(s). Deleting removes these assets from those projects’ timelines.</p><div className="dialog-actions"><button disabled={busy} onClick={() => setDeleteAssets(undefined)}>Cancel</button><button disabled={busy} className="danger" onClick={() => { setBusy(true); void perform(async () => { await projectStore.deleteAssets(deleteAssets.ids); select(selected.filter(id => !deleteAssets.ids.includes(id))); setDeleteAssets(undefined); }).finally(() => setBusy(false)); }}>Delete</button></div></Dialog>}
    {deleteFolder && <Dialog title="Delete folder" close={() => !busy && setDeleteFolder(undefined)}><p>Delete “{deleteFolder.name}”? {folderAssetCount === 0 && folderTree.size === 1 ? 'It is empty.' : `${folderAssetCount} assets and ${folderTree.size - 1} subfolders are inside.`}</p><p>Delete folder only moves its contents up. Delete everything permanently removes the entire folder tree.</p><div className="dialog-actions"><button disabled={busy} onClick={() => setDeleteFolder(undefined)}>Cancel</button>{[false, true].map(everything => <button key={String(everything)} disabled={busy} className={everything ? 'danger' : ''} onClick={() => { setBusy(true); void perform(async () => { await projectStore.deleteFolder(deleteFolder.id, everything); setDeleteFolder(undefined); select([]); }).finally(() => setBusy(false)); }}>{everything ? 'Delete everything' : 'Delete folder only'}</button>)}</div></Dialog>}
    {preview && <Preview asset={preview} close={() => setPreview(undefined)} />}
    {clipPreview && <Preview asset={clipPreview.asset} start={clipPreview.start} close={() => setClipPreview(undefined)} />}
  </section>;
}
/** `start` (s): a clip result's preview opens at its range start. */
export function Preview({ asset, start = 0, close }: { asset: Asset; start?: number; close: () => void }) {
  const [url, setUrl] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true, objectUrl = '';
    void projectStore.media.read(asset.id).then(blob => { if (alive) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(e => { if (alive) { setFailed(true); reportError(e); } });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [asset.id]);
  return <Dialog title={asset.name} close={close}>{failed ? <p>Couldn’t read this local file.</p> : !url ? <p>Opening preview…</p> : asset.type === 'image' ? <img className="media-preview" src={url} alt={asset.name} /> : asset.type === 'video' ? <video className="media-preview" src={url} controls autoPlay onLoadedMetadata={e => { if (start) e.currentTarget.currentTime = start; }} /> : <audio src={url} controls autoPlay onLoadedMetadata={e => { if (start) e.currentTarget.currentTime = start; }} />}</Dialog>;
}
