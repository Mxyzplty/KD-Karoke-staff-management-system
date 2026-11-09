// SPDX-License-Identifier: AGPL-3.0-only
// T21 Settings, one page in the §39 order: Profile · Local usage · AI and services · Storage · External Agent with Allowed
// directories nested · Danger Zone. Notifications and Security are left out: Cutframe has no notification channel and no accounts.
import { useEffect, useState } from 'react';
import { agentLink } from '../agent/link';
import { AgentPanel, connectedAge, useLink } from '../agent/AgentLink';
import { canPickFolders, connectFolder, folders, folderPermission, reconnectFolder, removeFolder } from '../media/folders';
import type { DirRecord } from '../media/folders';
import { projectStore } from '../store/database';
import { Dialog, notify, reportError } from '../ui';
import { backupGranted, canBackup, chooseBackupFolder, readBackup, reconnectBackup, turnBackup } from './backup';
import type { Backup } from './backup';
import { ClientGuide, CopyLine, GUIDES, HELPER_COMMAND, Troubleshooting } from './guides';
import { deleteLocalData, formatBytes, localUsage, readParity, readProfile, saveParity, saveProfile } from './local';
import type { LocalUsage as Figures } from './local';
import { modelLine } from './meter';
import { resetOnboarding } from './onboarding';
import { billingOf, modelFor, readProviders } from './providers';
import type { ProviderSettings } from './providers';
import { Services } from './Services';

function Profile({ navigate }: { navigate: (path: string) => void }) {
  const [name, setName] = useState<string>(), [parity, setParity] = useState<boolean>();
  // Both controls open once their stored value is read: a read that lands late would wipe the change.
  useEffect(() => {
    void readProfile(projectStore).then(p => setName(p.name)).catch(reportError);
    void readParity(projectStore).then(setParity).catch(reportError);
  }, []);
  const initial = name?.trim().charAt(0).toUpperCase() || '?';
  const changeParity = (enabled: boolean) => { setParity(enabled); void saveParity(projectStore, enabled).catch(reportError); };
  return <section aria-labelledby="profile"><h2 id="profile">Profile</h2>
    <div className="row"><span className="avatar" aria-hidden="true">{initial}</span>
      <label>Name <input aria-label="Name" value={name ?? ''} disabled={name === undefined} onChange={e => setName(e.target.value)} onBlur={() => void saveProfile(projectStore, { name: name?.trim() ?? '' }).catch(reportError)} /></label></div>
    <p><small>Stored only in this browser.</small></p>
    <label className="switch"><input type="checkbox" role="switch" aria-label="Reference behaviour" checked={!!parity} disabled={parity === undefined} onChange={e => changeParity(e.target.checked)} /> Reference behaviour</label>
    <p><small>For side-by-side comparison: the editor follows the reference product’s history limits, no-op handling and slider undo steps. Applies the next time a project opens.</small></p>
    <button onClick={() => { resetOnboarding(); navigate('/onboarding'); }}>Run setup again</button>
  </section>;
}
function aiRow(settings: ProviderSettings | undefined, figures: Figures) {
  const choice = settings && modelFor(settings, 'chat');
  if (!choice) return 'No provider connected';
  const billed = billingOf(choice.connection).billedBy, used = figures.meter.models[choice.connection.id];
  return `${choice.connection.label} · ${choice.model}${used ? ` · ${modelLine(used)}` : ''}${billed ? `, billed by ${billed}` : ', on your machine'}`;
}
function LocalUsage({ navigate }: { navigate: (path: string) => void }) {
  const [figures, setFigures] = useState<Figures>(), [settings, setSettings] = useState<ProviderSettings>(), [granted, setGranted] = useState<boolean>();
  const refresh = () => { void localUsage(projectStore).then(setFigures).catch(reportError); void readProviders(projectStore).then(setSettings).catch(reportError); };
  useEffect(refresh, []);
  const ask = () => navigator.storage.persist().then(ok => { setGranted(ok); if (!ok) notify('This browser did not grant persistent storage.'); refresh(); }).catch(reportError);
  return <section aria-labelledby="local-usage"><h2 id="local-usage">Local usage</h2>
    <p>Plan: free and open source (AGPL-3.0). <a href="/costs" onClick={e => { e.preventDefault(); navigate('/costs'); }}>Costs</a></p>
    {figures && <dl className="usage" data-testid="local-usage">
      <dt>Storage</dt><dd data-testid="usage-storage" data-used={figures.used}>{formatBytes(figures.used)} of {formatBytes(figures.quota)}{figures.quota > 0 && <meter min={0} max={figures.quota} value={figures.used} aria-label="Storage used" />}</dd>
      <dt>Persistent storage</dt><dd data-testid="usage-persist">{figures.persisted || granted ? 'On' : <>Off. The browser may clear this data under pressure. <button onClick={() => void ask()}>Request persistent storage</button></>}</dd>
      <dt>Projects</dt><dd data-testid="usage-projects">{figures.projects}</dd>
      <dt>Library assets</dt><dd data-testid="usage-assets">{figures.assets} ({formatBytes(figures.assetBytes)})</dd>
      <dt>Exports made</dt><dd data-testid="usage-exports">{figures.meter.exports}</dd>
      <dt>AI provider</dt><dd data-testid="usage-ai">{aiRow(settings, figures)}</dd>
    </dl>}
    <button onClick={refresh}>Refresh</button>
    <p><small>Cutframe sets no limits. These figures only report, and the browser’s quota is the one real limit.</small></p>
  </section>;
}
function Storage() {
  const [backup, set] = useState<Backup>(), [needs, setNeeds] = useState(false);
  useEffect(() => { void readBackup(projectStore).then(async b => { set(b); setNeeds(!!b.enabled && !!b.handle && !await backupGranted(b.handle)); }).catch(reportError); }, []);
  const turn = (on: boolean) => void turnBackup(projectStore, on, backup).then(set).catch(e => { if ((e as DOMException).name !== 'AbortError') reportError(e); });
  const choose = () => void chooseBackupFolder(projectStore).then(b => { set(b); setNeeds(false); }).catch(e => { if ((e as DOMException).name !== 'AbortError') reportError(e); });
  return <section aria-labelledby="storage"><h2 id="storage">Storage</h2>
    <label className="switch"><input type="checkbox" role="switch" aria-label="Auto backup" disabled={!canBackup()} checked={!!backup?.enabled} onChange={e => turn(e.target.checked)} /> Auto backup</label>
    <p><small>Off by default. When on, a project’s media is copied to a folder you pick when it is added to a project. Pick a folder your own sync client watches for an off-device copy; any storage cost comes from that provider.</small></p>
    {!canBackup() && <p className="unavailable">Use Chrome, Edge, or another Chromium browser to back up to a folder.</p>}
    {backup?.folder && <p className="row">Backup folder: <strong data-testid="backup-folder">{backup.folder}</strong><button onClick={choose}>Change</button>{needs && <button onClick={() => void reconnectBackup(backup.handle!).then(ok => setNeeds(!ok)).catch(reportError)}>Reconnect</button>}</p>}
  </section>;
}
const PERMISSION: Record<PermissionState, string> = { granted: 'Allowed', prompt: 'Needs permission', denied: 'Blocked' };
function AllowedDirectories() {
  const [dirs, setDirs] = useState<(DirRecord & { state: PermissionState })[]>();
  const refresh = () => folders(projectStore).then(list => Promise.all(list.map(async d => ({ ...d, state: await folderPermission(d.handle) })))).then(setDirs).catch(reportError);
  useEffect(() => { void refresh(); }, []);
  const add = () => void connectFolder(projectStore).then(refresh).catch(e => { if ((e as DOMException).name !== 'AbortError') reportError(e); });
  return <div className="nested" aria-labelledby="allowed-directories"><h3 id="allowed-directories">Allowed directories</h3>
    <p>Agents may list and import from folders you allow here. Your files stay on disk. Folders are connected per device, so every computer needs its own.</p>
    {!canPickFolders() ? <p className="unavailable">Use Chrome, Edge, or another Chromium browser.</p> : <>
      {dirs?.length ? <ul className="settings-list" aria-label="Allowed directories">{dirs.map(d => <li key={d.id} data-folder={d.name} className="row spread"><span>{d.name} <small>{PERMISSION[d.state]}</small></span><span className="row">{d.state !== 'granted' && <button onClick={() => void reconnectFolder(d.handle).then(refresh).catch(reportError)}>Reconnect</button>}<button className="danger" onClick={() => void removeFolder(projectStore, d.name).then(refresh).catch(reportError)}>Remove</button></span></li>)}</ul> : <p className="empty">No folders connected on this device</p>}
      <button onClick={add}>＋ Add folder</button></>}
  </div>;
}
function ExternalAgent() {
  const state = useLink(), connected = state.status === 'connected', [client, setClient] = useState(GUIDES[0].client);
  const guide = GUIDES.find(g => g.client === client)!;
  return <section id="external-agent" aria-labelledby="external-agent-title"><h2 id="external-agent-title">External Agent (MCP)</h2>
    <p>Connect an agent you already run, such as Claude Code or Codex. It edits the project open in a connected tab, with the same tools the editor uses. Connections are per device, so every computer needs its own.</p>
    <CopyLine text={HELPER_COMMAND} />
    <div role="tablist" aria-label="Client">{GUIDES.map(g => <button key={g.client} role="tab" aria-selected={g.client === client} onClick={() => setClient(g.client)}>{g.label}</button>)}</div>
    <ClientGuide guide={guide} />
    <h3>Connections</h3>
    {connected ? <ul className="settings-list" aria-label="Agent connections"><li>This browser, helper port {state.port}{state.connectedAt && <small> · connected {connectedAge(state.connectedAt)}</small>}</li>{state.clients.map((c, i) => <li key={i}>{c.name} {c.version}</li>)}</ul> : <p className="empty">No active agent connections</p>}
    {connected && <button className="danger" onClick={() => void agentLink.revoke()}>Revoke all</button>}
    <AgentPanel />
    <Troubleshooting guide={guide} />
    <AllowedDirectories />
  </section>;
}
function DangerZone() {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await deleteLocalData(); location.assign('/'); } catch (e) { setBusy(false); reportError(e); }
  };
  return <section aria-labelledby="danger-zone" className="danger-zone"><h2 id="danger-zone">Danger Zone</h2>
    <p>Deletes every project, all media, exports, keys, agent pairings and settings in this browser. This cannot be undone. Files in your allowed folders and backup folder stay on disk.</p>
    <button className="danger" onClick={() => setConfirm(true)}>Delete local data</button>
    {confirm && <Dialog title="Delete local data" close={() => setConfirm(false)}><p>Delete all Cutframe data in this browser? This permanently removes your projects and media.</p><div className="dialog-actions"><button onClick={() => setConfirm(false)}>Cancel</button><button className="danger" disabled={busy} onClick={() => void run()}>{busy ? 'Deleting…' : 'Delete everything'}</button></div></Dialog>}
  </section>;
}
export function SettingsPage({ navigate }: { navigate: (path: string) => void }) {
  useEffect(() => { if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, []);
  return <div className="settings"><h1>Settings</h1><Profile navigate={navigate} /><LocalUsage navigate={navigate} /><Services /><Storage /><ExternalAgent /><DangerZone /></div>;
}
