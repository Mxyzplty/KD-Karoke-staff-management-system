// SPDX-License-Identifier: AGPL-3.0-only
// The Style presets rail panel (T22; findings part 3 §46.3, part 2 §31): heading, an All chip plus one chip per category that
// has presets, a 3-column grid. One click places a direct preset at 0 s (each item on its own new overlay track, one "Add
// items" step), closes the panel and shows `Applied "<name>" — n item(s)`. A motion-graphic preset opens a dialog with an
// optional customise text first; with text, the AI chat is to receive a message naming the graphic (the chat is T20's: until
// then a notice names T20). Cutframe's own (plan Q7): My style presets, export / import, and the Save as preset dialog.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { dispatch } from '../editor/commands';
import { setView } from '../editor/view';
import { downloadBlob } from '../library';
import { userGraphicPresets, type GraphicPreset } from '../mg/presets';
import { projectStore } from '../store/database';
import { projectSize } from '../render/model';
import type { ProjectDocument, RecordData } from '../store/model';
import { Dialog, notify, reportError } from '../ui';
import { STYLE_PRESETS } from './content';
import { CATEGORIES, categoryOf, customiseMessage, isDirect, type Category, type StylePreset } from './model';
import { exportPresets, importPresets, notKept, savable, savedDirect, savedGraphic, storePresets, userStylePresets, type UserDirect } from './user';

const count = (p: StylePreset | GraphicPreset) => isDirect(p) ? p.items.length : 1;
/** Places a preset at 0 s; true when it was placed (the toast is §46.3's). */
export function applyPreset(p: StylePreset | GraphicPreset): boolean {
  if (!dispatch({ type: 'applyStylePreset', preset: p }).ok) return false;
  notify(`Applied "${p.name}" — ${count(p)} item(s)`);
  return true;
}

/** §31's dialog for a motion-graphic preset: Add places it; with customise text the chat gets the message (T20). */
export function CustomiseDialog({ preset, close, done }: { preset: GraphicPreset; close: () => void; done?: () => void }) {
  const [text, setText] = useState('');
  const add = () => {
    close();
    if (!applyPreset(preset)) return;
    if (text.trim()) dispatch({ type: 'feature', owner: 'T20', label: `Sending "${customiseMessage(preset.name, text)}" to the AI chat` });
    done?.();
  };
  return <Dialog title={`Add "${preset.name}"`} close={close}>
    <label>Customise (optional) <textarea aria-label="Customise" rows={3} value={text} placeholder="What should the AI change in this graphic?" onChange={e => setText(e.target.value)} /></label>
    <div className="row"><button type="button" onClick={close}>Cancel</button><button type="button" onClick={add}>Add</button></div>
  </Dialog>;
}

export function StylePresetsPanel() {
  const [chip, setChip] = useState<'all' | Category>('all'), [mine, setMine] = useState<UserDirect[]>([]), [custom, setCustom] = useState<GraphicPreset>();
  const file = useRef<HTMLInputElement>(null);
  const load = () => userStylePresets(projectStore).then(r => setMine(r.presets), () => {});
  useEffect(() => { void load(); }, []);
  const closePanel = () => setView({ right: { kind: 'none' } });
  const pick = (p: StylePreset) => { if (!isDirect(p)) setCustom(p); else if (applyPreset(p)) closePanel(); };
  const present = CATEGORIES.filter(c => STYLE_PRESETS.some(p => categoryOf(p.id) === c.slug));
  const exportAll = async () => {
    try { downloadBlob(new Blob([JSON.stringify(exportPresets([...(await userGraphicPresets(projectStore)).presets, ...(await userStylePresets(projectStore)).presets]), null, 2)], { type: 'application/json' }), 'cutframe-presets.json'); }
    catch (e) { reportError(e); }
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const r = importPresets(JSON.parse(await f.text()));
      await storePresets(projectStore, r.presets); await load();
      notify(`Imported ${r.presets.length} preset(s)${r.skipped.length ? `. Skipped ${r.skipped.length}: ${r.skipped.map(s => `#${s.index + 1} ${s.reason}`).join('; ')}` : ''}`);
    } catch (e) { notify(e instanceof SyntaxError ? 'INVALID_PRESET_FILE: This is not a Cutframe presets file.' : `${(e as RecordData).code ?? 'IMPORT_FAILED'}: ${(e as Error).message}`); }
  };
  return <section aria-label="Style presets" className="tool-panel">
    <h3>Style presets</h3>
    <div className="row" role="group" aria-label="Categories">
      {[{ slug: 'all' as const, label: 'All' }, ...present].map(c => <button key={c.slug} type="button" className="chip" aria-pressed={chip === c.slug} onClick={() => setChip(c.slug)}>{c.label}</button>)}
    </div>
    <div className="preset-grid" role="group" aria-label="Presets">
      {STYLE_PRESETS.filter(p => chip === 'all' || categoryOf(p.id) === chip).map(p => <button key={p.id} type="button" title={p.description} onClick={() => pick(p)}>{p.name}</button>)}
    </div>
    <h4 id="my-style-presets">My style presets ({mine.length})</h4>
    {mine.length ? <ul aria-labelledby="my-style-presets">{mine.map(p => <li key={p.id}><button type="button" onClick={() => pick(p)}>{p.name}</button></li>)}</ul> : <p>No presets yet. Select text or shape items and choose Save as preset.</p>}
    <div className="row"><button type="button" onClick={() => void exportAll()}>Export presets</button><button type="button" onClick={() => file.current?.click()}>Import presets</button>
      <input ref={file} type="file" accept="application/json,.json" aria-label="Presets file" hidden onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></div>
    {custom && <CustomiseDialog preset={custom} close={() => setCustom(undefined)} done={closePanel} />}
  </section>;
}

/** GFX-10 Save as preset: a name, then the selection goes to My Presets (one motion graphic) or My style presets (text and
 *  shape items). The notice names what the preset does not keep. */
function SavePresetDialog({ items, canvas, close }: { items: RecordData[]; canvas: { width: number; height: number }; close: () => void }) {
  const kind = savable(items), [name, setName] = useState(''), lost = notKept(items);
  const save = async () => {
    close();
    try {
      await storePresets(projectStore, [kind === 'graphic' ? savedGraphic(items[0], canvas, name) : savedDirect(items, canvas, name)]);
      notify(`Saved "${name.trim()}" to ${kind === 'graphic' ? 'My Presets' : 'My style presets'}${lost.length ? `. Not kept: ${lost.join(', ')}` : ''}`);
    } catch (e) { reportError(e); }
  };
  return <Dialog title="Save as preset" close={close}>
    <form onSubmit={e => { e.preventDefault(); if (name.trim()) void save(); }}>
      <label>Name <input autoFocus aria-label="Preset name" value={name} onChange={e => setName(e.target.value)} /></label>
      {lost.length > 0 && <p className="hint">Not kept in the preset: {lost.join(', ')}.</p>}
      <div className="row"><button type="button" onClick={close}>Cancel</button><button type="submit" disabled={!name.trim()}>Save</button></div>
    </form>
  </Dialog>;
}
/** The Save as preset action of a selection (the inspector, the clip menu), or null when it does not apply (presets/user.ts
 *  savable). The dialog gets its own root, so it opens wherever the action was chosen. */
export function savePresetAction(doc: ProjectDocument, ids: readonly string[]): (() => void) | null {
  const items = doc.items.filter(i => ids.includes(i.id));
  return savable(items) ? () => openSavePreset(items, projectSize(doc)) : null;
}
function openSavePreset(items: RecordData[], canvas: { width: number; height: number }) {
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host);
  root.render(<SavePresetDialog items={items} canvas={canvas} close={() => { root.unmount(); host.remove(); }} />);
}
