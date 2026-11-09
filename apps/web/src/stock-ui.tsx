// SPDX-License-Identifier: AGPL-3.0-only
// Stock panels (findings part 3 §46.3): Photos (curated on open, 20 per page), Videos (15, duration badge), Sounds (15,
// Enter to search, Clear, play previews at volume 0.5 one at a time). Placement on the timeline is T03's seam.
import { useEffect, useRef, useState } from 'react';
import { projectStore } from './store/database';
import { notify, reportError } from './ui';
import { addStockToProject, readKeys, saveKey, searchPhotos, searchSounds, searchVideos, soundDuration } from './media/stock';
import type { Provider, StockItem, StockKeys, StockPage } from './media/stock';
import { formatDuration, placeOnTimeline } from './media-ui';

const NAMES: Record<Provider, string> = { pexels: 'Pexels', unsplash: 'Unsplash', freesound: 'Freesound' };
/** The cost/limit line (review F14): shown at every point of use, before and after a key is saved. */
const CostLine = () => <p className="cost-line">Keys are free from each provider; the provider’s own request limits apply. Keys stay encrypted in this browser and are sent only to that provider. You can also manage them in Settings.</p>;
function KeyForms({ providers, keys, saved }: { providers: Provider[]; keys: StockKeys; saved: (k: StockKeys) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  return <>{providers.map(p => <form key={p} onSubmit={e => { e.preventDefault(); void saveKey(projectStore, p, draft[p] ?? '').then(k => { setDraft({ ...draft, [p]: '' }); saved(k); }).catch(reportError); }}>
    <label>{NAMES[p]} key {keys[p] ? '(saved)' : ''}<input type="password" autoComplete="off" value={draft[p] ?? ''} onChange={e => setDraft({ ...draft, [p]: e.target.value })} aria-label={`${NAMES[p]} API key`} /></label>
    <button type="submit">Save {NAMES[p]} key</button>
  </form>)}</>;
}
/** "Add a free key" state with the cost/limit line and an inline key field. */
function KeyState({ providers, keys, saved }: { providers: Provider[]; keys: StockKeys; saved: (k: StockKeys) => void }) {
  return <div className="key-state" role="group" aria-label="Stock keys">
    <p><strong>Add a free key</strong> to search {providers.map(p => NAMES[p]).join(' and ')}.</p>
    <CostLine /><KeyForms providers={providers} keys={keys} saved={saved} />
  </div>;
}
/** Once a panel is searchable: the cost line, plus a disclosure to add or replace any of its keys (review F10). */
function ActiveKeys({ providers, keys, saved }: { providers: Provider[]; keys: StockKeys; saved: (k: StockKeys) => void }) {
  return <><CostLine /><details className="manage-keys"><summary>Manage stock keys</summary><KeyForms providers={providers} keys={keys} saved={saved} /></details></>;
}
function useKeys() { const [keys, setKeys] = useState<StockKeys>(); useEffect(() => { void readKeys(projectStore).then(setKeys).catch(reportError); }, []); return [keys, setKeys] as const; }
function usePaged(load: (query: string, page: number) => Promise<StockPage>) {
  const [items, setItems] = useState<StockItem[]>([]), [page, setPage] = useState(0), [more, setMore] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function run(query: string, next: number) {
    setBusy(true); setError('');
    try { const r = await load(query, next); setItems(list => next === 1 ? r.results : [...list, ...r.results]); setPage(next); setMore(r.has_next_page); }
    catch (e) { setError(`The stock search failed: ${(e as Error).message}`); } finally { setBusy(false); }
  }
  return { items, page, more, busy, error, run, clear: () => { setItems([]); setPage(0); setMore(false); } };
}
async function add(projectId: string, item: StockItem) {
  try {
    const r = await addStockToProject(projectStore, projectId, item);
    notify(r.alreadyInProject ? `Already in project: ${r.asset.name}` : `${item.type === 'audio' ? 'Sound' : 'Video'} added to the project footage.`);
    placeOnTimeline(r.asset.name, [r.asset.id]);
  } catch (e) { reportError(e); }
}
export function PhotosPanel() {
  const [keys, setKeys] = useKeys(), [query, setQuery] = useState('');
  const paged = usePaged((q, p) => searchPhotos(keys!, q, p));
  useEffect(() => { if (keys?.pexels || keys?.unsplash) void paged.run('', 1); }, [keys]);
  if (!keys) return <p>Loading…</p>;
  if (!keys.pexels && !keys.unsplash) return <section aria-label="Photos"><h3>Photos</h3><KeyState providers={['pexels', 'unsplash']} keys={keys} saved={setKeys} /></section>;
  return <section aria-label="Photos"><h3>Photos</h3>
    <form onSubmit={e => { e.preventDefault(); void paged.run(query, 1); }}><input aria-label="Search photos" placeholder="Search photos" value={query} onChange={e => setQuery(e.target.value)} /></form>
    <ActiveKeys providers={['pexels', 'unsplash']} keys={keys} saved={setKeys} />
    {paged.error && <p role="alert">{paged.error}</p>}
    <ul className="stock-grid" aria-label="Photo results">{paged.items.map(item => <li key={`${item.provider}:${item.provider_id}`} data-provider={item.provider}>
      {/* A click adds nothing (findings part 2 §32); a drag carries the stock item to the timeline (T03 places it). */}
      <img src={item.thumbnail_url} alt={item.name} draggable onDragStart={e => e.dataTransfer.setData('application/x-cutframe-timeline', JSON.stringify({ kind: 'stock', item }))} />
      <small>{item.attribution}</small>
    </li>)}</ul>
    {paged.more && <button disabled={paged.busy} onClick={() => void paged.run(query, paged.page + 1)}>Load More</button>}
  </section>;
}
export function VideosPanel({ projectId }: { projectId: string }) {
  const [keys, setKeys] = useKeys(), [query, setQuery] = useState(''), paged = usePaged((q, p) => searchVideos(keys!, q, p));
  if (!keys) return <p>Loading…</p>;
  if (!keys.pexels) return <section aria-label="Videos"><h3>Videos</h3><KeyState providers={['pexels']} keys={keys} saved={setKeys} /></section>;
  return <section aria-label="Videos"><h3>Videos</h3>
    <form onSubmit={e => { e.preventDefault(); if (query.trim()) void paged.run(query, 1); }}><input aria-label="Search videos" placeholder="Search videos" value={query} onChange={e => setQuery(e.target.value)} /></form>
    <ActiveKeys providers={['pexels']} keys={keys} saved={setKeys} />
    {paged.error && <p role="alert">{paged.error}</p>}
    {!paged.items.length && !paged.busy && <p>Search Pexels for stock videos.</p>}
    <ul className="stock-grid" aria-label="Video results">{paged.items.map(item => <li key={item.provider_id}>
      <button className="stock-tile" aria-label={`Add video ${item.name}`} onClick={() => void add(projectId, item)} draggable onDragStart={e => e.dataTransfer.setData('application/x-cutframe-timeline', JSON.stringify({ kind: 'stock', item }))}>
        <img src={item.thumbnail_url} alt="" /><span className="badge duration">{formatDuration(item.duration_ms ?? 0)}</span>
      </button><small>{item.attribution}</small>
    </li>)}</ul>
    {paged.more && <button disabled={paged.busy} onClick={() => void paged.run(query, paged.page + 1)}>Load More</button>}
  </section>;
}
export function SoundsPanel({ projectId }: { projectId: string }) {
  const [keys, setKeys] = useKeys(), [query, setQuery] = useState(''), [playing, setPlaying] = useState<string>(), audio = useRef<HTMLAudioElement | null>(null);
  const paged = usePaged((q, p) => searchSounds(keys!, q, p));
  useEffect(() => () => { audio.current?.pause(); }, []);
  /** Preview only: volume 0.5, one at a time, a second click stops; nothing is added. */
  function toggle(item: StockItem) {
    audio.current?.pause();
    if (playing === item.provider_id) { setPlaying(undefined); audio.current = null; return; }
    const a = new Audio(item.preview_url); a.volume = 0.5; a.onended = () => setPlaying(p => p === item.provider_id ? undefined : p);
    audio.current = a; setPlaying(item.provider_id); void a.play().catch(() => setPlaying(undefined));
  }
  if (!keys) return <p>Loading…</p>;
  if (!keys.freesound) return <section aria-label="Sounds"><h3>Sound effects</h3><KeyState providers={['freesound']} keys={keys} saved={setKeys} /></section>;
  return <section aria-label="Sounds"><h3>Sound effects</h3>
    <div className="toolbar"><input aria-label="Search sounds" placeholder="Search sounds" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && query.trim()) void paged.run(query, 1); }} />
      {query && <button onClick={() => { setQuery(''); paged.clear(); audio.current?.pause(); setPlaying(undefined); }}>Clear</button>}</div>
    <ActiveKeys providers={['freesound']} keys={keys} saved={setKeys} />
    {paged.error && <p role="alert">{paged.error}</p>}
    {!paged.items.length && !paged.busy && <p>Search Freesound for sound effects.</p>}
    <ul className="sound-list" aria-label="Sound results">{paged.items.map(item => <li key={item.provider_id}>
      <button aria-label={`${playing === item.provider_id ? 'Stop' : 'Play'} ${item.name}`} onClick={() => toggle(item)}>{playing === item.provider_id ? '■' : '▶'}</button>
      <button className="link" aria-label={`Add sound ${item.name}`} onClick={() => void add(projectId, item)}>{item.name}</button>
      <span>{soundDuration(item.duration_ms)}</span><span>by {item.author}</span>{item.tags.map(t => <span key={t} className="tag">{t}</span>)}
    </li>)}</ul>
    {paged.more && <button disabled={paged.busy} onClick={() => void paged.run(query, paged.page + 1)}>Load More</button>}
  </section>;
}
