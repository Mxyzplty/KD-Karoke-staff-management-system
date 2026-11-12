// SPDX-License-Identifier: AGPL-3.0-only
// The editor shell (inventory §2; part 3 §46.1–§46.2, §46.16–§46.17): top bar rows, save state, preview, timeline, left
// panel, inspector or tool panel, the 11-tool rail, the compact layout below 1024 CSS px, overlays and the editor's
// global key handler. Local work needs no provider, no account and no network.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { projectStore } from '../store/database';
import type { Asset, ProjectRecord } from '../store/model';
import type { AutosaveSession } from '../store/autosave';
import { uploadToProject } from '../media/ingest';
import { folders } from '../media/folders';
import { AgentPanel, connectedAge, useLink } from '../agent/AgentLink';
import { LABELS } from '../agent/link';
import { backupAssets, canBackup, readBackup, turnBackup } from '../settings/backup';
import type { Backup, BackupState } from '../settings/backup';
import { HELP_LINKS, openHelpLink } from '../settings/help-links';
import { acceptAttribute } from '../media/files';
import { reportIngest } from '../library';
import { reportError } from '../ui';
import { dispatch, history } from './commands';
import { carriesPayload, readPayload } from './dnd';
import { handleKey } from './actions';
import { MenuButton, Popover } from './controls';
import { GraphEditor } from './graph';
import { CompactSheet, compactTabs, Inspector, LeftPanel, Rail, ToolPanel } from './panels';
import { clearRemapCaches, syncRemapCaches } from './remap-cache';
import { JobsPanel, PerformanceOverlay, ShortcutOverlay, Tour } from './overlays';
import { PreviewFrames, stageBackground } from './preview-stage';
import { MaskOverlay } from './mask-ui';
import { ShapeOverlay } from './shape-ui';
import { TextEditOverlay } from '../text/edit';
import { LayoutDropOverlay, ProjectFootage } from './layout-ui';
import { Timeline } from './timeline';
import { setQuality, setView, useView, view } from './view';
import { saveAsCopy } from '../versions/checkpoints';
import type { Checkpoints } from '../versions/checkpoints';
import { CheckpointMenu } from '../versions/menu';
import { TemplateChip } from '../templates/ui';

/** Below 1024 CSS px of viewport width the compact layout shows (W3-ED-01: 1023 compact, 1024 wide). */
export const COMPACT_QUERY = '(width < 1024px)';
function useCompact() {
  const [compact, setCompact] = useState(() => matchMedia(COMPACT_QUERY).matches);
  useEffect(() => { const q = matchMedia(COMPACT_QUERY), change = () => setCompact(q.matches); q.addEventListener('change', change); return () => q.removeEventListener('change', change); }, []);
  return compact;
}
/** The project's linked assets (names, sound, preparation jobs), refreshed while anything is still being prepared. */
function useProjectAssets(projectId: string) {
  const [assets, setAssets] = useState<Asset[]>([]), [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void Promise.all([projectStore.projectAssets(projectId), projectStore.library()]).then(([links, lib]) => {
      if (alive) setAssets(links.flatMap(l => lib.assets.filter(a => a.id === l.assetId)));
    }).catch(() => {});
    return () => { alive = false; };
  }, [projectId, tick]);
  const working = assets.some(a => a.processing_status === 'uploading' || a.processing_status === 'processing');
  useEffect(() => { const t = setTimeout(() => setTick(n => n + 1), working ? 1500 : 4000); return () => clearTimeout(t); }, [assets, working]);
  return { assets, refresh: () => setTick(n => n + 1) };
}
const ASPECTS: { ratio: '16:9' | '9:16' | '1:1'; label: string; size: [number, number] }[] = [
  { ratio: '16:9', label: '16:9 Landscape', size: [1920, 1080] }, { ratio: '9:16', label: '9:16 Portrait', size: [1080, 1920] }, { ratio: '1:1', label: '1:1 Square', size: [1080, 1080] }];
function Toggle({ label, children, render, className, data }: { label: string; children: ReactNode; render: (close: () => void) => ReactNode; className?: string; data?: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  return <div className={`toggle ${className ?? ''}`}><button aria-label={label} aria-expanded={open} {...data} onClick={() => setOpen(!open)}>{children}</button>{open && render(() => setOpen(false))}</div>;
}
function SaveState({ session, record, navigate }: { session: AutosaveSession; record: ProjectRecord; navigate: (path: string) => void }) {
  const copy = () => void saveAsCopy(session, projectStore, record).then(c => navigate(`/project/${c.id}`)).catch(reportError);
  const d = session.document;
  return <div className="save-state">
    <p role="status">{session.state === 'saved' ? 'Saved locally' : session.state === 'saving' ? 'Saving…' : session.state === 'pending' ? 'Unsaved changes' : session.error?.message}</p>
    <small data-testid="project-rev">Saved revision: {d.rev}</small><small>{d.size.width} × {d.size.height} · {d.fps} fps · {d.items.length} items</small>
    {session.error && <p role="alert">{'code' in session.error ? `${session.error.code}: ` : ''}{session.error.message}</p>}
    {session.state === 'conflict' && <div role="group" aria-label="Resolve project conflict"><span>Another tab changed this project.</span><button onClick={() => void session.reload().catch(reportError)}>Reload</button><button onClick={() => void session.keepMine().catch(reportError)}>Keep mine</button><button onClick={copy}>Save as copy</button></div>}
    {session.state === 'blocked' && <button onClick={() => void session.reload().catch(reportError)}>Reload</button>}
  </div>;
}
/** Agent badge popover (W3-ED-25): the link's status with its age, the connect / pair panel of agent/AgentLink.tsx, and a
 *  footer counting this device's allowed folders (T14), whose set-up link opens Settings at the External Agent card. */
function AgentPopover({ close, navigate }: { close: () => void; navigate: (path: string) => void }) {
  const [dirs, setDirs] = useState<number>(), state = useLink();
  useEffect(() => { void folders(projectStore).then(f => setDirs(f.length)).catch(() => setDirs(0)); }, []);
  return <Popover label="Agent connection" close={close}>
    <p className="agent-status"><span className={`dot ${state.status === 'connected' ? '' : 'off'}`} aria-hidden="true" /> <strong>{state.status === 'connected' ? 'Connected' : 'Not connected'}</strong> {state.status === 'connected' && state.connectedAt && <small>{connectedAge(state.connectedAt)}</small>}</p>
    <p>When an outside agent (an MCP client such as Claude Code or Codex) is connected, this tab carries out its tool calls.</p>
    <AgentPanel />
    <p className="agent-footer"><span aria-hidden="true">▤</span> {dirs ? `${dirs} allowed ${dirs === 1 ? 'folder' : 'folders'}` : 'No allowed folders'} on this device. <a href="/settings#external-agent" onClick={e => { e.preventDefault(); navigate('/settings#external-agent'); }}>Set up →</a></p>
  </Popover>;
}
/** The shell's agent badge, wired to agent/link.ts (T18a request R1). */
function AgentBadge({ navigate }: { navigate: (path: string) => void }) {
  const s = useLink().status;
  return <div data-tour="agent-badge" data-testid="agent-link"><Toggle className="agent" label={s === 'idle' ? 'Agent: not connected' : `Agent: ${LABELS[s]}`} data={{ 'data-status': s, 'data-testid': 'agent-link-badge' }} render={close => <AgentPopover close={close} navigate={navigate} />}><span className={`dot ${s === 'connected' ? '' : 'off'}`} aria-hidden="true" />{LABELS[s]}</Toggle></div>;
}
const BACKUP_TEXT: Record<BackupState, string> = { local: 'Local only', copying: 'Copying…', 'backed-up': 'Backed up', failed: 'Copy failed', 'no-permission': 'Needs permission' };
/** The storage chip (T21 Storage, §46.1 Auto switch): backup is off until turned on here or in Settings; then this project's assets are copied. */
function BackupToggle({ assets, navigate }: { assets: Asset[]; navigate: (path: string) => void }) {
  const [backup, setBackup] = useState<Backup>(), [states, setStates] = useState<Record<string, BackupState>>({}), on = !!backup?.enabled, ids = assets.map(a => a.id).join();
  useEffect(() => {
    let alive = true;
    void readBackup(projectStore).then(b => { if (alive) setBackup(b); return backupAssets(projectStore, assets, (a, state) => { if (alive) setStates(s => ({ ...s, [a.id]: state })); }); }).catch(reportError);
    return () => { alive = false; };
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const turn = (next: boolean) => void turnBackup(projectStore, next, backup).then(b => { setBackup(b); return backupAssets(projectStore, assets, (a, state) => setStates(s => ({ ...s, [a.id]: state }))); }).catch(e => { if ((e as DOMException).name !== 'AbortError') reportError(e); });
  return <Toggle label={on ? 'Backup: on' : 'Cloud backup: local only'} render={close => <Popover label="Cloud backup" close={close}>
    <h3>Backup</h3><p>{on ? `On. Media added to this project is copied to the folder “${backup?.folder}”.` : 'Off. This project and its media are kept only in this browser on this device. No media leaves this device.'}</p>
    <label className="switch"><input type="checkbox" role="switch" aria-label="Auto backup" disabled={!canBackup()} checked={on} onChange={e => turn(e.target.checked)} /> Auto</label>
    <p><a href="/settings#storage" onClick={e => { e.preventDefault(); navigate('/settings#storage'); }}>{on ? 'Change in Settings →' : 'Set up in Settings →'}</a></p>
    <p><small>{on ? 'Any' : 'If you set one up later, any'} storage cost comes from the provider you choose. Cutframe adds no charge.</small></p>
    <ul className="backup-list" aria-label="Project assets">{assets.map(a => <li key={a.id}><span>{a.name}</span><small>{BACKUP_TEXT[on ? states[a.id] ?? 'local' : 'local']}</small></li>)}{!assets.length && <li><small>No assets in this project.</small></li>}</ul>
  </Popover>}>☁ {on ? 'Backup on' : 'Local only'}</Toggle>;
}
function TopBar({ session, record, assets, navigate, checkpoints }: { session: AutosaveSession; record: ProjectRecord; assets: Asset[]; navigate: (path: string) => void; checkpoints: Checkpoints }) {
  const d = session.document;
  return <header className="editor-top">
    <div className="top-row">
      <button aria-label="Back to home" onClick={() => navigate('/')}>‹</button>
      <h1 className="project-name">{record.title}</h1>
      <TemplateChip session={session} record={record} />
      <BackupToggle assets={assets} navigate={navigate} />
      <MenuButton label="Help" items={[...HELP_LINKS.map(link => ({ label: link.label, onSelect: () => openHelpLink(link, navigate) })), { label: 'Keyboard shortcuts', onSelect: () => setView({ shortcuts: true }) }]}>Help</MenuButton>
      <AgentBadge navigate={navigate} />
      <button className="primary" onClick={() => dispatch({ type: 'feature', owner: 'T16', label: 'Export' })}>Export</button>
    </div>
    <div className="top-row second">
      <button aria-label="Undo" disabled={!history.canUndo()} onClick={() => dispatch({ type: 'undo' })}>↶</button>
      <button aria-label="Redo" disabled={!history.canRedo()} onClick={() => dispatch({ type: 'redo' })}>↷</button>
      <MenuButton label="Resize" items={ASPECTS.map(a => ({ label: a.label, checked: d.size.width === a.size[0] && d.size.height === a.size[1], onSelect: () => dispatch({ type: 'resizeCanvas', aspectRatio: a.ratio }) }))}>Resize</MenuButton>
      <span className="split-button"><button onClick={() => dispatch({ type: 'saveCheckpoint' })}>Save</button><CheckpointMenu checkpoints={checkpoints} /></span>
      <SaveState session={session} record={record} navigate={navigate} />
    </div>
  </header>;
}
/** Preview area (part 3 §46.2): stage at the project aspect, Reset view (fit), global Preview quality, the empty-project
 *  upload target, drop zone and the Background Jobs corner. The frames are T15's (preview-stage.tsx). */
function Preview({ session, projectId, assets, refresh }: { session: AutosaveSession; projectId: string; assets: Asset[]; refresh: () => void }) {
  const d = session.document, v = useView(), input = useRef<HTMLInputElement>(null), [scale, setScale] = useState(1), area = useRef<HTMLElement>(null), [fit, setFit] = useState<{ w: number; h: number }>();
  // The stage fits inside the preview in both dimensions at the project's aspect ratio (review R2).
  useLayoutEffect(() => {
    const el = area.current; if (!el) return;
    const measure = () => { const r = d.size.width / d.size.height, w = Math.max(1, Math.min(el.clientWidth * 0.92, el.clientHeight * 0.82 * r)); setFit({ w, h: w / r }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect();
  }, [d.size.width, d.size.height]);
  const upload = (files: File[]) => void uploadToProject(projectStore, projectId, files).then(r => { reportIngest(r); refresh(); }).catch(reportError);
  const qualities = [['full', 'Full', ''], ['half', '1/2', 'smoother on slow machines'], ['quarter', '1/4', 'smoothest']] as const;
  return <section ref={area} className="preview" aria-label="Preview" data-zone="preview" tabIndex={0}
    onWheel={e => { if (e.ctrlKey) { e.preventDefault(); setScale(s => Math.min(8, Math.max(0.1, s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))); } }}
    onDragOver={e => { if (carriesPayload(e.dataTransfer) || e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
    onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length) upload(Array.from(e.dataTransfer.files)); else { const payload = readPayload(e.dataTransfer); if (payload) dispatch({ type: 'drop', payload, trackId: null, timeMs: view().playheadMs, below: false }); } }}>
    <div className="preview-controls">
      <button aria-label="Reset view (fit)" onClick={() => setScale(1)}>⤢</button>
      <MenuButton label={`Preview quality: ${qualities.find(q => q[0] === v.quality)![1]}`} items={qualities.map(([id, label, hint]) => ({ label: hint ? `${label} (${hint})` : label, checked: v.quality === id, onSelect: () => setQuality(id) }))}>{qualities.find(q => q[0] === v.quality)![1]}</MenuButton>
    </div>
    <div className="stage" style={{ ...stageBackground(d), width: fit?.w, height: fit?.h, aspectRatio: `${d.size.width} / ${d.size.height}`, transform: `scale(${scale})` }} data-scale={scale}>
      <PreviewFrames doc={d} assets={assets} />
      {!d.items.length && <div className="empty-stage"><button aria-label="Add media" onClick={() => input.current?.click()}>＋</button><p>Click to upload, or drag and drop media here.</p></div>}
      {/* Canvas overlays, lowest interaction first. TextEditOverlay (text double-click to edit) must sit UNDER any tool that
          takes over the stage: ShapeOverlay draws a full inset:0 SVG while drawing or path-editing and renders nothing otherwise
          (shape-ui.tsx), so on top it owns those gestures, and underneath text editing still works when it is idle. A later
          canvas tool (crop, gizmo, mask) mounts after this pair for the same reason. */}
      <TextEditOverlay doc={d} />
      <ShapeOverlay doc={d} />
      <MaskOverlay doc={d} />
      <LayoutDropOverlay doc={d} />
    </div>
    <input ref={input} type="file" multiple hidden accept={`${acceptAttribute},video/*,image/*,audio/*`} aria-label="Upload media to this project" onChange={e => { upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
    <JobsPanel assets={assets} refresh={refresh} />
  </section>;
}
function Drawer({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className="drawer" aria-label={title} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="drawer-body"><div className="dialog-heading"><h2>{title}</h2><button aria-label={`Close ${title}`} onClick={close}>×</button></div>{children}</div>
  </dialog>;
}
export function EditorShell({ session, record, navigate, checkpoints, demo }: { session: AutosaveSession; record: ProjectRecord; navigate: (path: string) => void; checkpoints: Checkpoints; demo?: ReactNode }) {
  const compact = useCompact(), v = useView(), doc = session.document, projectId = session.projectId, { assets, refresh } = useProjectAssets(projectId);
  const docRef = useRef(doc); docRef.current = doc;
  const byId = new Map(assets.map(a => [a.id, a])), selected = doc.items.find(i => i.id === v.selection[0]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { handleKey(e, 'global', docRef.current); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  // A selection that no longer exists in the document is dropped (view state only).
  useEffect(() => { const ids = new Set(doc.items.map(i => i.id)); if (view().selection.some(id => !ids.has(id))) setView(s => ({ selection: s.selection.filter(id => ids.has(id)) })); }, [doc.items]);
  // T04 time-remap frame caches follow the document (a curve change rebuilds); leaving the editor drops them.
  useEffect(() => { syncRemapCaches(projectStore, doc); }, [doc]);
  useEffect(() => () => clearRemapCaches(projectStore), []);
  // T21 First Edit: the scripted chat replaces the left panel and the timeline is locked while the demo drives it (§28b.2.1).
  useEffect(() => { if (!demo) return; setView({ modes: { ...view().modes, timelineLocked: true } }); return () => setView({ modes: { ...view().modes, timelineLocked: false } }); }, [!demo]);
  const tabs = compactTabs(selected), drawerTab = v.drawer?.startsWith('tab:') ? tabs.find(t => `tab:${t.id}` === v.drawer) : undefined;
  return <ProjectFootage.Provider value={assets}><main className={`editor ${compact ? 'compact' : 'wide'}`}>
    {!demo && <TopBar session={session} record={record} assets={assets} navigate={navigate} checkpoints={checkpoints} />}
    {demo ?? (!compact && <LeftPanel projectId={projectId} />)}
    <div className="centre"><Preview session={session} projectId={projectId} assets={assets} refresh={refresh} /><Timeline doc={doc} assets={byId} /></div>
    {!compact && !demo && <aside className="right-panel" aria-label="Inspector and tools">{v.right.kind === 'tool' ? <ToolPanel tool={v.right.tool} projectId={projectId} /> : <Inspector doc={doc} />}</aside>}
    {!compact && !demo && <Rail />}
    {compact && <nav className="bottom-tabs" aria-label="Editor panels"><div role="tablist" aria-label="Editor panels">{tabs.map(t => <button key={t.id} role="tab" aria-selected={drawerTab?.id === t.id} onClick={() => setView({ drawer: `tab:${t.id}` })}>{t.label}</button>)}</div></nav>}
    {compact && drawerTab && <Drawer title={drawerTab.label} close={() => setView({ drawer: null })}><CompactSheet tab={drawerTab.id} item={selected} projectId={projectId} doc={doc} /></Drawer>}
    {v.graph && v.modes.graphEditorOpen && <GraphEditor doc={doc} />}
    {v.performance && <PerformanceOverlay />}
    {v.shortcuts && <ShortcutOverlay />}
    {!demo && <Tour />}
  </main></ProjectFootage.Provider>;
}
