// SPDX-License-Identifier: AGPL-3.0-only
// The templates UI (T22; findings §22, part 3 §46.1): the picker (wizard, editor chip, Library tab), the preview page with
// its Included assets and Your preferences tabs, the top-bar chip with its three dialogs, and Save as template.
// The control labels are the ones the findings name; every longer line is Cutframe's own wording.
// Cutframe's own (each in one place, so a ruling changes one thing):
// - LOADING: the "Current template" loading line shows while the template is read; there is no fixed wait.
// - NoTemplate (RC 6.5): its wording under the switch. The button, the switch and the alert are the reference's.
// - The preview page's notices after Save to / Remove from My templates.
// - Extras: export (with what the file carries), import, delete, and discarding a built-in's personal copy.
// - Saving preferences changes the template only: a project already bound keeps its `templateDefaults`.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TabBinding } from '../versions/checkpoints';
import { bundledFile } from '../catalogue/assets';
import { findElement } from '../catalogue/elements';
import { findSound } from '../catalogue/sounds';
import { MenuButton } from '../editor/controls';
import { downloadBlob, LibraryBrowser } from '../library';
import { STYLE_PRESETS } from '../presets/content';
import type { AutosaveSession } from '../store/autosave';
import { projectStore } from '../store/database';
import type { Asset, ProjectRecord } from '../store/model';
import { fontFamilies, loadFont, loadUserFonts, resolveFont } from '../text/fonts';
import { Dialog, notify, reportError } from '../ui';
import { Wizard } from '../wizard';
import { bindProject, projectLearning, setProjectLearning, writeDefaults } from './binding';
import { templateErrorText } from './errors';
import { BUILT_IN_TEMPLATES, deleteTemplate, exportTemplate, findTemplate, importTemplate, listTemplates, projectDefaults, projectTemplate, removeFromMyTemplates, saveProjectTemplate, saveTemplate, saveToMyTemplates, templateFromProject, updateTemplate } from './library';
import { refKind, type FontDefaults, type Swatch, type Template, type TemplateRef } from './model';

const isBuiltIn = (id: string) => BUILT_IN_TEMPLATES.some(t => t.id === id);
const FONT_ROWS: [keyof FontDefaults, string][] = [['captionsFont', 'Captions'], ['titlesFont', 'Titles'], ['accentFont', 'Accent']];
const LOADING = 'Loading template…';
/** What a template is, under the picker. */
const ABOUT = 'A template holds fonts, colours, reusable assets and guidance for the agent.';
export const EDITOR_HINT = 'Changing the template guides the next edits. Items already in the project keep their look.';
const NEW_VIDEO = 'New video with this template';
const CARRY_FORWARD = 'The look, the pacing and the tone of this project.';

/** The default fonts of a template that this browser cannot resolve (R9-3: new items then get the standard font). */
export const missingFonts = (t: Template): string[] => [...new Set(FONT_ROWS.map(([k]) => t.defaults[k]).filter(f => !resolveFont(f)))];
export const missingFontsText = (names: string[]) => `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} not available in this browser. The standard font is used in ${names.length > 1 ? 'their' : 'its'} place.`;
/** Uploaded fonts are read once, so a template that names one resolves. */
function useUserFonts() {
  const [, render] = useState(0);
  useEffect(() => { let alive = true; void loadUserFonts().then(() => { if (alive) render(n => n + 1); }).catch(() => {}); return () => { alive = false; }; }, []);
}
function useObjectUrl(load: () => Promise<Blob>): { url?: string; failed?: true } {
  const [state, setState] = useState<{ url?: string; failed?: true }>({});
  useEffect(() => {
    let alive = true, url: string | undefined;
    load().then(blob => { if (alive) { url = URL.createObjectURL(blob); setState({ url }); } }, () => { if (alive) setState({ failed: true }); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// ---- Previews of what a template names ----
function FontSample({ name }: { name: string }) {
  const r = resolveFont(name), [ready, setReady] = useState(false);
  useEffect(() => { let alive = true; if (r) void loadFont(r).then(() => { if (alive) setReady(true); }, () => {}); return () => { alive = false; }; }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return <p className="hint">{missingFontsText([name])}</p>;
  return <p className="template-sample" data-ready={ready} style={{ fontFamily: `'${r.variant.face}', '${r.entry.family}'`, fontWeight: r.variant.weight, fontStyle: r.variant.italic ? 'italic' : 'normal' }}>The quick brown fox 0123</p>;
}
function Media({ kind, name, load }: { kind: 'video' | 'image' | 'audio'; name: string; load: () => Promise<Blob> }) {
  const { url, failed } = useObjectUrl(load);
  if (failed) return <p className="hint">This file could not be read.</p>;
  if (!url) return <p className="hint">Loading…</p>;
  return kind === 'image' ? <img src={url} alt={name} /> : kind === 'audio' ? <audio src={url} controls autoPlay aria-label={name} /> : <video src={url} controls autoPlay muted aria-label={name} />;
}
function LibraryMedia({ id, name }: { id: string; name: string }) {
  const [asset, setAsset] = useState<Asset | null>();
  useEffect(() => { let alive = true; void projectStore.library().then(l => { if (alive) setAsset(l.assets.find(a => a.id === id) ?? null); }, () => { if (alive) setAsset(null); }); return () => { alive = false; }; }, [id]);
  if (asset === undefined) return <p className="hint">Loading…</p>;
  if (!asset) return <p className="hint">This file is no longer in the library.</p>;
  return <Media kind={asset.type} name={name} load={() => projectStore.media.read(id)} />;
}
function RefPreview({ entry }: { entry: TemplateRef }) {
  const kind = refKind(entry.ref), id = entry.ref.slice(kind.length + 1);
  if (kind === 'font') return <FontSample name={id} />;
  if (kind === 'asset') return <LibraryMedia id={id} name={entry.name} />;
  if (kind === 'sound' || kind === 'element') {
    const file = kind === 'sound' ? findSound(id)?.file : findElement(id)?.file;
    return file ? <Media kind={kind === 'sound' ? 'audio' : 'image'} name={entry.name} load={() => bundledFile(file)} /> : <p className="hint">This item is not in the built-in catalogue.</p>;
  }
  const preset = STYLE_PRESETS.find(p => p.id === id);
  return <p className="hint">{preset ? `Style preset “${preset.name}”. Add it from the Style presets panel in the editor.` : 'This preset is not in the built-in list.'}</p>;
}
function RefList({ label, entries }: { label: string; entries: TemplateRef[] }) {
  const [open, setOpen] = useState<string>();
  if (!entries.length) return null;
  return <section aria-label={label}><h4>{label}</h4><ul className="template-refs">{entries.map(e => <li key={e.ref}>
    <div className="row spread"><span>{e.name}</span><button type="button" aria-label={`Preview ${e.name}`} aria-expanded={open === e.ref} onClick={() => setOpen(open === e.ref ? undefined : e.ref)}>Preview</button></div>
    {open === e.ref && <div className="template-preview" aria-label={`${e.name} preview`} role="group"><RefPreview entry={e} /></div>}
  </li>)}</ul></section>;
}

// ---- Your preferences ----
/** The learning switch (saved at once) and the fonts and colours form. A built-in gets its personal copy at the first save. */
function PreferencesForm({ template, changed }: { template: Template; changed: () => void }) {
  useUserFonts();
  const [fonts, setFonts] = useState<FontDefaults>(template.defaults), [palette, setPalette] = useState<Swatch[]>(template.palette), [busy, setBusy] = useState(false);
  const save = (change: (t: Template) => Template, done: string) => {
    setBusy(true);
    void updateTemplate(projectStore, template.id, change).then(() => { notify(done); changed(); }, reportError).finally(() => setBusy(false));
  };
  const options = fontFamilies().flatMap(f => f.variants.map(v => ({ value: v.face, label: `${f.family} ${v.label}` })));
  const swatch = (n: number, s: Partial<Swatch>) => setPalette(palette.map((x, i) => i === n ? { ...x, ...s } : x));
  const missing = missingFonts({ ...template, defaults: fonts });
  return <form className="template-form" aria-label="Your preferences" onSubmit={e => { e.preventDefault(); save(t => ({ ...t, defaults: fonts, palette }), 'Fonts and colours saved.'); }}>
    <label className="row"><input type="checkbox" role="switch" aria-label="Learn and update this template" checked={template.learning} disabled={busy} onChange={e => { const on = e.target.checked; save(t => ({ ...t, learning: on }), on ? 'Learning is on for this template.' : 'Learning is off for this template.'); }} /> Learn and update this template</label>
    <p className="hint">What the agent learns from your feedback is written to your own copy of this template. Turn this off to keep feedback inside its project.</p>
    <p className="hint">Projects that already use this template keep their look.</p>
    {template.preferences && <><h4>Learned so far</h4><p className="template-notes">{template.preferences}</p></>}
    {FONT_ROWS.map(([key, label]) => {
      const known = options.some(o => o.value === fonts[key]) ? options : [{ value: fonts[key], label: resolveFont(fonts[key]) ? fonts[key] : `${fonts[key]} (not available)` }, ...options];
      return <label key={key} className="row spread">{label}<select aria-label={`${label} font`} value={fonts[key]} onChange={e => setFonts({ ...fonts, [key]: e.target.value })}>{known.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
    })}
    {missing.length > 0 && <p className="hint" role="note">{missingFontsText(missing)}</p>}
    <ul className="template-colours" aria-label="Colours">{palette.map((s, n) => <li key={n}>
      <input type="color" aria-label={`Colour ${n + 1}`} value={s.hex.toLowerCase()} onChange={e => swatch(n, { hex: e.target.value.toUpperCase() })} />
      <input aria-label={`Colour ${n + 1} name`} value={s.name} onChange={e => swatch(n, { name: e.target.value })} /><code>{s.hex}</code>
    </li>)}</ul>
    <div className="dialog-actions"><button type="submit" className="primary" disabled={busy}>Save fonts &amp; colors</button></div>
  </form>;
}

// ---- The preview page ----
type Action = { label: string; run: (t: Template) => void };
/** The file a template is shared as: shown with what it carries before it is downloaded. */
function ExportTemplate({ template }: { template: Template }) {
  const [ready, setReady] = useState<Awaited<ReturnType<typeof exportTemplate>>>();
  const names = (list: string[]) => list.length ? list.join(', ') : 'none';
  return <>
    <button type="button" onClick={() => void exportTemplate(projectStore, template.id).then(setReady, reportError)}>Export template file</button>
    {ready && <div className="template-export" role="group" aria-label="Template file">
      <p>This file carries the template and a copy of the files it uses. Anyone you give it to gets them.</p>
      <p>Media: {names(ready.carries.media)}</p><p>Uploaded fonts: {names(ready.carries.fonts)}</p>
      <div className="row"><button type="button" onClick={() => setReady(undefined)}>Cancel</button><button type="button" onClick={() => { downloadBlob(new Blob([JSON.stringify(ready.file)], { type: 'application/json' }), `${template.id}.cutframe-template.json`); setReady(undefined); }}>Download file</button></div>
    </div>}
  </>;
}
/** One template in full. `action` is the page's main button (Use template, Change template, New video with this template). */
export function TemplateDetails({ id, back, action, gone }: { id: string; back?: () => void; action?: Action; gone?: () => void }) {
  useUserFonts();
  const [template, setTemplate] = useState<Template | null>(), [saved, setSaved] = useState(false), [tab, setTab] = useState<'assets' | 'preferences'>('assets'), [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    void Promise.all([findTemplate(projectStore, id), listTemplates(projectStore)]).then(([t, lists]) => { if (alive) { setTemplate(t ?? null); setSaved(lists.mine.some(m => m.id === id)); } }).catch(e => { if (alive) { setTemplate(null); reportError(e); } });
    return () => { alive = false; };
  }, [id, version]);
  const reload = () => setVersion(v => v + 1);
  if (template === undefined) return <p role="status">{LOADING}</p>;
  if (!template) return <>{back && <button type="button" onClick={back}>‹ Back</button>}<p>{templateErrorText('TEMPLATE_NOT_FOUND')}</p></>;
  const builtIn = isBuiltIn(id), missing = missingFonts(template);
  const remove = () => void deleteTemplate(projectStore, id).then(() => { notify(builtIn ? `${template.name} is back to its built-in values.` : `${template.name} was deleted.`); if (builtIn) reload(); else (gone ?? back)?.(); }, reportError);
  return <div className="template-details">
    {back && <button type="button" onClick={back}>‹ Back</button>}
    <p className="eyebrow">{template.family.toUpperCase()} TEMPLATE</p><h3>{template.name}</h3><p className="hint">By {template.author}</p>
    <div className="row">
      {action && <button type="button" className="primary" onClick={() => action.run(template)}>{action.label}</button>}
      <button type="button" onClick={() => void (saved ? removeFromMyTemplates : saveToMyTemplates)(projectStore, id).then(() => { notify(saved ? `${template.name} is no longer in My templates.` : `${template.name} is in My templates.`); reload(); }, reportError)}>{saved ? 'Remove from My templates' : 'Save to My templates'}</button>
      <ExportTemplate template={template} />
      {!builtIn && <button type="button" className="danger" onClick={remove}>Delete</button>}
      {builtIn && template.basedOn && <button type="button" onClick={remove}>Discard my changes</button>}
    </div>
    {missing.length > 0 && <p className="hint" role="note">{missingFontsText(missing)}</p>}
    {template.guidance && <p>{template.guidance}</p>}
    <section aria-label="Colors"><h4>Colors</h4><ul className="template-swatches">{template.palette.map((s, n) => <li key={n}><i style={{ background: s.hex }} /><span>{s.name}</span><code>{s.hex}</code></li>)}</ul></section>
    <RefList label="Examples" entries={template.examples} />
    <div role="tablist" aria-label="Template contents"><button type="button" role="tab" aria-selected={tab === 'assets'} onClick={() => setTab('assets')}>Included assets</button><button type="button" role="tab" aria-selected={tab === 'preferences'} onClick={() => setTab('preferences')}>Your preferences</button></div>
    {tab === 'assets' ? <div role="tabpanel" aria-label="Included assets"><RefList label="Fonts" entries={template.assets.fonts} /><RefList label="Audio" entries={template.assets.audio} /><RefList label="Images" entries={template.assets.images} /></div>
      : <div role="tabpanel" aria-label="Your preferences"><PreferencesForm key={template.savedAt} template={template} changed={reload} /></div>}
  </div>;
}

// ---- The picker ----
/** The shared picker body: two tabs, live search on the name, rows, and the preview page. `action` names the main button
 *  once a row is picked (the wizard and the editor: "Use <name>"; the Library tab: "New video with this template") and
 *  `previewAction` the preview page's. */
export function TemplateBrowser({ action, previewAction, use, hint }: { action: (t: Template) => string; previewAction: string; use: (t: Template) => void; hint?: string }) {
  const [lists, setLists] = useState<{ builtIn: Template[]; mine: Template[] }>(), [tab, setTab] = useState<'builtIn' | 'mine'>('builtIn'), [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string>(), [preview, setPreview] = useState<string>(), [version, setVersion] = useState(0), file = useRef<HTMLInputElement>(null);
  useEffect(() => { let alive = true; void listTemplates(projectStore).then(l => { if (alive) setLists(l); }).catch(reportError); return () => { alive = false; }; }, [version, preview]);
  const all = lists ? [...lists.builtIn, ...lists.mine] : [], chosen = all.find(t => t.id === picked);
  async function load(f: File | undefined) {
    if (!f) return;
    try {
      const t = await importTemplate(projectStore, await f.text().then(JSON.parse, () => null));
      notify(`${t.name} was added to My templates.`); setTab('mine'); setVersion(v => v + 1);
    } catch (e) { reportError(e); }
  }
  if (preview) return <TemplateDetails id={preview} back={() => setPreview(undefined)} action={{ label: previewAction, run: use }} />;
  const q = query.trim().toLowerCase(), rows = (lists?.[tab] ?? []).filter(t => t.name.toLowerCase().includes(q));
  return <div className="template-browser">
    <div role="tablist" aria-label="Templates"><button type="button" role="tab" aria-selected={tab === 'builtIn'} onClick={() => setTab('builtIn')}>Built-in templates</button><button type="button" role="tab" aria-selected={tab === 'mine'} onClick={() => setTab('mine')}>My templates</button></div>
    <input type="search" aria-label="Find a template" placeholder="Find a template" value={query} onChange={e => setQuery(e.target.value)} />
    {tab === 'mine' && lists && !lists.mine.length ? <div className="template-empty"><h4>No templates of your own yet</h4><p>Open a built-in template and choose Save to My templates, or save a project as a template from the template menu in the editor.</p></div>
      : <ul className="template-rows" aria-label={tab === 'builtIn' ? 'Built-in templates' : 'My templates'}>{rows.map(t => <li key={t.id}>
        <button type="button" className="template-row" aria-pressed={picked === t.id} onClick={() => setPicked(t.id)}><i style={{ background: t.palette[0]?.hex }} /><span><strong>{t.name}</strong><small>{t.author}</small></span>{picked === t.id && <b aria-hidden="true">✓</b>}</button>
        {picked === t.id && <button type="button" aria-label={`Preview ${t.name}`} onClick={() => setPreview(t.id)}>Preview</button>}
        {picked === t.id && lists?.mine.some(m => m.id === t.id) && <small>Saved in My templates</small>}
      </li>)}</ul>}
    {tab === 'mine' && <><button type="button" onClick={() => file.current?.click()}>Import template file</button><input ref={file} type="file" hidden accept=".json,application/json" aria-label="Template file" onChange={e => { void load(e.target.files?.[0]); e.target.value = ''; }} /></>}
    <div className="template-footer"><p className="hint">{ABOUT}{hint ? ` ${hint}` : ''}</p><button type="button" className="primary" disabled={!chosen} onClick={() => chosen && use(chosen)}>{chosen ? action(chosen) : 'Choose a template'}</button></div>
  </div>;
}
export function TemplatePicker({ close, use, hint }: { close: () => void; use: (t: Template) => void; hint?: string }) {
  return <Dialog title="Choose a Template" close={close}><TemplateBrowser action={t => `Use ${t.name}`} previewAction="Use template" use={use} hint={hint} /></Dialog>;
}
/** The Library's Templates tab: the same picker body, the editor's hint included (findings §22); its action starts the
 *  wizard with the template picked. */
export function TemplateLibrary({ navigate }: { navigate: (path: string) => void }) {
  const [template, setTemplate] = useState<Template>();
  return <section role="tabpanel" aria-label="Templates"><h2>Templates</h2>
    <TemplateBrowser action={() => NEW_VIDEO} previewAction={NEW_VIDEO} use={setTemplate} hint={EDITOR_HINT} />
    {template && <Wizard template={template} close={() => setTemplate(undefined)} navigate={navigate} />}
  </section>;
}

// ---- Save as template ----
export function SaveAsTemplateDialog({ session, title, base, close }: { session: AutosaveSession; title: string; base?: Template; close: () => void }) {
  useUserFonts();
  const [name, setName] = useState(`${title} template`), [guidance, setGuidance] = useState(CARRY_FORWARD), [ids, setIds] = useState<string[]>([]), [library, setLibrary] = useState<Asset[]>([]), [adding, setAdding] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; void projectStore.library().then(l => { if (alive) setLibrary(l.assets); }).catch(reportError); return () => { alive = false; }; }, [adding]);
  const { defaults, palette } = projectDefaults(session.document), assets = ids.map(id => library.find(a => a.id === id)).filter((a): a is Asset => !!a);
  async function save() {
    setBusy(true);
    try {
      const t = await saveTemplate(projectStore, templateFromProject(session.document, { name, guidance, assets, base }));
      notify(`${t.name} is in My templates.`); close();
    } catch (e) { reportError(e); setBusy(false); }
  }
  return <Dialog title="Save as template" close={close}>
    <p>This makes a template of your own from this project. The project itself does not change.</p>
    <label>Template name <input aria-label="Template name" value={name} onChange={e => setName(e.target.value)} /></label>
    <label>What should it carry forward? <textarea aria-label="What should it carry forward?" rows={3} value={guidance} onChange={e => setGuidance(e.target.value)} /></label>
    <section aria-label="Reusable assets"><h4>Reusable assets</h4>
      <p className="hint">Fonts and colours come along by themselves. Your footage is never picked for you: add only the files the template should reuse.</p>
      <ul className="template-refs">
        <li className="row spread" data-locked="true"><span>Fonts: {FONT_ROWS.map(([k, label]) => `${label} ${defaults[k]}`).join(', ')}</span><small>Automatic</small></li>
        <li className="row spread" data-locked="true"><span>Colours: {palette.length ? palette.map(s => s.hex).join(', ') : 'none in this project'}</span><small>Automatic</small></li>
        {assets.map(a => <li key={a.id} className="row spread"><span>{a.name}</span><button type="button" aria-label={`Remove ${a.name}`} onClick={() => setIds(ids.filter(i => i !== a.id))}>×</button></li>)}
      </ul>
      <button type="button" onClick={() => setAdding(true)}>Add from library</button>
    </section>
    <p className="hint" role="note">Learning starts on for the new template. You can turn it off under Your preferences.</p>
    <div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void save()}>Save new template</button></div>
    {adding && <Dialog title="Add from library" close={() => setAdding(false)}><LibraryBrowser picker selected={ids} onSelected={setIds} /><div className="dialog-actions"><button type="button" onClick={() => setAdding(false)}>Done</button></div></Dialog>}
  </Dialog>;
}

// ---- The top-bar chip ----
/** The details of a project without a template (part 3 §46.1, RC 6.5). The button makes the project's own template with
 *  no dialog and no notice, then reads "Remove from My templates"; the project stays without a template. One busy flag
 *  holds the button and the switch. A failure is an alert at the top; its "Try again" only reads the details again. */
function NoTemplate({ session }: { session: AutosaveSession }) {
  const [tab, setTab] = useState<'assets' | 'preferences'>('assets'), [busy, setBusy] = useState(true), [error, setError] = useState<string>(), [version, setVersion] = useState(0);
  const [state, setState] = useState<{ own?: Template; learning: boolean }>({ learning: true });
  useEffect(() => {
    let alive = true;
    void Promise.all([projectStore.row<ProjectRecord>('projects', session.projectId), projectTemplate(projectStore, session.projectId)])
      .then(([record, own]) => { if (alive) { if (record) setState({ own, learning: projectLearning(record, own) }); setBusy(false); } }, e => { if (alive) { setError((e as Error).message); setBusy(false); } });
    return () => { alive = false; };
  }, [session.projectId, version]);
  const listed = !!state.own && state.own.saved !== false;
  const act = (run: () => Promise<unknown>) => { setBusy(true); setError(undefined); void run().then(() => setVersion(v => v + 1), e => { setError((e as Error).message); setBusy(false); }); };
  return <div className="template-details">
    {error !== undefined && <div role="alert" className="row spread"><span>{error}</span><button type="button" onClick={() => { setError(undefined); setBusy(true); setVersion(v => v + 1); }}>Try again</button></div>}
    <p className="eyebrow">PERSONAL TEMPLATE</p><h3>No template</h3>
    <div className="row"><button type="button" disabled={busy} onClick={() => act(() => listed ? removeFromMyTemplates(projectStore, state.own!.id) : saveProjectTemplate(projectStore, session.projectId, session.document))}>{listed ? 'Remove from My templates' : 'Save to My templates'}</button></div>
    <div role="tablist" aria-label="Template contents"><button type="button" role="tab" aria-selected={tab === 'assets'} onClick={() => setTab('assets')}>Included assets</button><button type="button" role="tab" aria-selected={tab === 'preferences'} onClick={() => setTab('preferences')}>Your preferences</button></div>
    {tab === 'assets' ? <div role="tabpanel" aria-label="Included assets"><p>This template holds creative guidance but no media.</p></div>
      : <div role="tabpanel" aria-label="Your preferences">
        <label className="row"><input type="checkbox" role="switch" aria-label="Learn and update this template" checked={state.learning} disabled={busy} onChange={e => { const on = e.target.checked; act(() => setProjectLearning(projectStore, session.projectId, on)); }} /> Learn and update this template</label>
        <p className="hint">When this is on, what the agent learns from your feedback can update this project's own template. Turn it off to keep feedback inside the project.</p>
        <p className="hint" role="note">Font and colour controls are not available for this template.</p>
      </div>}
  </div>;
}
type Open = 'details' | 'picker' | 'save';
/** The chip of the editor's top row: the bound template's name, and the menu View details / Change template / Save as
 *  template. A change is refused when the project's binding moved since this editor read it (a stale epoch). */
export function TemplateChip({ session, record, binding, onBind }: { session: AutosaveSession; record: ProjectRecord; binding: TabBinding; onBind: (binding: TabBinding) => void }) {
  const [template, setTemplate] = useState<Template | null>(), [open, setOpen] = useState<Open>();
  useEffect(() => {
    let alive = true;
    if (!binding.id) { setTemplate(undefined); return; }
    void findTemplate(projectStore, binding.id).then(t => { if (alive) setTemplate(t ?? null); }).catch(reportError);
    return () => { alive = false; };
  }, [binding.id, open]);
  const name = !binding.id ? 'No template' : template ? template.name : template === null ? 'Missing template' : 'Template';
  async function use(t: Template) {
    try {
      const bound = await bindProject(projectStore, session.projectId, t, binding.epoch), stored = await findTemplate(projectStore, t.id) ?? t;
      session.update(writeDefaults(session.document, stored, bound.epoch));
      onBind({ id: bound.templateId, epoch: bound.epoch }); setOpen(undefined);
      notify(`This project now uses ${t.name}. ${EDITOR_HINT}`);
      const missing = missingFonts(t);
      if (missing.length) notify(missingFontsText(missing));
    } catch (e) { reportError(e); }
  }
  const item = (label: string, target: Open) => ({ label, onSelect: () => setOpen(target) });
  let details: ReactNode = null;
  if (open === 'details') details = <Dialog title="Current template" close={() => setOpen(undefined)}>
    {!binding.id ? <NoTemplate session={session} />
      : template === null ? <><p>{templateErrorText('TEMPLATE_NOT_FOUND')}</p><p className="hint">This project keeps the fonts it got from that template.</p><div className="dialog-actions"><button type="button" onClick={() => setOpen('picker')}>Change template</button></div></>
        : <TemplateDetails id={binding.id} action={{ label: 'Change template', run: () => setOpen('picker') }} gone={() => setOpen(undefined)} />}
  </Dialog>;
  return <>
    <MenuButton className="chip" label={`Template: ${name}`} header={<div className="menu-header"><small>Project template</small><strong>{name}</strong></div>}
      items={[item('View details', 'details'), item('Change template', 'picker'), item('Save as template', 'save')]}>{name}</MenuButton>
    {details}
    {open === 'picker' && <TemplatePicker close={() => setOpen(undefined)} use={t => void use(t)} hint={EDITOR_HINT} />}
    {open === 'save' && <SaveAsTemplateDialog session={session} title={record.title} base={template ?? undefined} close={() => setOpen(undefined)} />}
  </>;
}
