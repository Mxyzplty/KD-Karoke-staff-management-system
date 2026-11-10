// SPDX-License-Identifier: AGPL-3.0-only
// T21 Settings "AI and services" (ticket "Providers"): model connections with Test and Remove, the default model and one
// optional model per job, speech-to-text, stock keys and the local models. Each no-key state says what still works.
import { useEffect, useState } from 'react';
import type { Provider } from '../media/stock';
import { readKeys, saveKey } from '../media/stock';
import { CAPABILITY_MODELS, UNAVAILABLE } from '../analysis/availability';
import type { Availability, Capability } from '../analysis/availability';
import { analysisService } from '../analysis/service';
import { projectStore } from '../store/database';
import { notify, reportError } from '../ui';
import { formatBytes } from './local';
import { modelLine, readUsage, requestsLine } from './meter';
import { billingOf, connectProviders, ELEVENLABS, JOBS, keyId, PRESETS, readProviders, removeConnection, saveConnection, saveProviders, SPEECH_KEY, targetOf } from './providers';
import type { Connection, Job, ModelChoice, ProviderSettings } from './providers';
import { testTarget } from './protocols';
import type { Protocol, TestResult } from './protocols';
import { hasSecret, putSecret, removeSecret } from './secrets';

const PROTOCOLS: { protocol: Protocol; label: string }[] = [{ protocol: 'openai', label: 'OpenAI-compatible' }, { protocol: 'anthropic', label: 'Anthropic Messages' }, { protocol: 'gemini', label: 'Google Gemini' }];
const STOCK: { provider: Provider; label: string; keys: string; note?: string }[] = [
  { provider: 'pexels', label: 'Pexels', keys: 'https://www.pexels.com/api/', note: 'Pexels says new API keys are paused as of 4 Nov 2026. A key you already have still works.' },
  { provider: 'unsplash', label: 'Unsplash', keys: 'https://unsplash.com/developers' },
  { provider: 'freesound', label: 'Freesound', keys: 'https://freesound.org/apiv2/apply/' },
];
/** Download sizes rounded from datasets/manifest.json (the files that actually fetch), in MB. Shared models count in each
 *  capability that needs them; `beats` is the beat_this_fold0 download, `speaker` the wespeaker verification model. */
const MODEL_MB: Record<string, number> = { vision: 594, clip: 150, sound: 87, vad: 6, whisper: 563, aligner: 303, speaker: 25, embedding: 23, beats: 160 };
const CAPABILITIES: { capability: Capability; label: string }[] = [{ capability: 'transcription', label: 'Transcription' }, { capability: 'analysis', label: 'Visual analysis' }, { capability: 'embeddings', label: 'Search' }, { capability: 'beats', label: 'Beat detection' }];
export const capabilityBytes = (c: Capability) => CAPABILITY_MODELS[c].reduce((sum, key) => sum + (MODEL_MB[key] ?? 0), 0) * 2 ** 20;

function ConnectionForm({ initial, saved, cancel }: { initial?: Connection; saved: (s: ProviderSettings) => void; cancel?: () => void }) {
  const [label, setLabel] = useState(initial?.label ?? ''), [protocol, setProtocol] = useState<Protocol>(initial?.protocol ?? 'openai'), [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? ''), [key, setKey] = useState('');
  const preset = (name: string) => { const p = PRESETS.find(x => x.label === name); if (p) { setLabel(p.label); setProtocol(p.protocol); setBaseUrl(p.baseUrl); } };
  const valid = (() => { try { return label.trim() && /^https?:$/.test(new URL(baseUrl).protocol); } catch { return false; } })();
  const submit = async () => {
    const next = await saveConnection(projectStore, { id: initial?.id ?? crypto.randomUUID(), label: label.trim(), protocol, baseUrl: baseUrl.trim() }, key);
    setKey(''); if (!initial) { setLabel(''); setBaseUrl(''); }
    await connectProviders(projectStore); saved(next);
  };
  return <form className="settings-form" aria-label={initial ? `Edit ${initial.label}` : 'Add a model connection'} onSubmit={e => { e.preventDefault(); void submit().catch(reportError); }}>
    {!initial && <label>Preset <select aria-label="Preset" value="" onChange={e => preset(e.target.value)}><option value="">Choose…</option>{PRESETS.map(p => <option key={p.label}>{p.label}</option>)}</select></label>}
    <label>Name <input value={label} onChange={e => setLabel(e.target.value)} /></label>
    <label>Protocol <select value={protocol} onChange={e => setProtocol(e.target.value as Protocol)}>{PROTOCOLS.map(p => <option key={p.protocol} value={p.protocol}>{p.label}</option>)}</select></label>
    <label>Base URL <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://…" /></label>
    <label>API key <input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={initial ? 'Unchanged' : 'Not needed for a local server'} /></label>
    <div className="row"><button className="primary" type="submit" disabled={!valid}>{initial ? 'Save' : 'Add connection'}</button>{cancel && <button type="button" onClick={cancel}>Cancel</button>}</div>
    {initial && <p><small>Changing the base URL to another site removes the saved key.</small></p>}
  </form>;
}
function ConnectionRow({ connection, changed }: { connection: Connection; changed: (s: ProviderSettings) => void }) {
  const billing = billingOf(connection), used = readUsage().models[connection.id], [editing, setEditing] = useState(false), [keyed, setKeyed] = useState<boolean>(), [model, setModel] = useState(''), [result, setResult] = useState<TestResult>(), [testing, setTesting] = useState(false);
  useEffect(() => { void hasSecret(keyId(connection.id)).then(setKeyed).catch(reportError); }, [connection, editing]);
  const test = async () => {
    setTesting(true); setResult(undefined);
    try { setResult(await testTarget(await targetOf({ connection, model }))); } catch (e) { reportError(e); } finally { setTesting(false); }
  };
  const remove = () => removeConnection(projectStore, connection.id).then(async next => { await connectProviders(projectStore); changed(next); notify(`${connection.label} and its key were removed.`); }).catch(reportError);
  if (editing) return <li><ConnectionForm initial={connection} cancel={() => setEditing(false)} saved={next => { setEditing(false); changed(next); }} /></li>;
  return <li data-connection={connection.label}>
    <div className="row spread"><strong>{connection.label}</strong><span className="row"><button onClick={() => setEditing(true)}>Edit</button><button className="danger" onClick={() => void remove()}>Remove</button></span></div>
    <p><small>{PROTOCOLS.find(p => p.protocol === connection.protocol)?.label} · {connection.baseUrl} · {keyed ? 'Key saved' : 'No key'}</small></p>
    <p><small>{billing.billedBy ? <>Billed by {billing.billedBy}{billing.pricing && <> · <a href={billing.pricing} target="_blank" rel="noreferrer">Pricing</a></>}</> : 'Runs on your machine. No provider bills it.'}{billing.keys && <> · <a href={billing.keys} target="_blank" rel="noreferrer">Get a key</a></>}</small></p>
    {used && <p><small>On this device: {modelLine(used)}.</small></p>}
    <div className="row"><input aria-label={`Model to test on ${connection.label}`} placeholder="Model name" value={model} onChange={e => setModel(e.target.value)} /><button disabled={!model.trim() || testing} onClick={() => void test()}>{testing ? 'Testing…' : 'Test'}</button></div>
    {result && <p role="status" data-testid="connection-test">{result.ok ? `Works. Model ${result.model}. Tool calls ${result.tools ? 'work' : 'were not used'}.${result.contextWindow ? ` Context window ${result.contextWindow.toLocaleString('en-US')}.` : ''}` : result.message}</p>}
  </li>;
}
function ModelPicker({ label, value, settings, change, none }: { label: string; value?: ModelChoice | null; settings: ProviderSettings; change: (choice: ModelChoice | null) => void; none: string }) {
  return <div className="row" role="group" aria-label={label}><span className="picker-label">{label}</span>
    <select aria-label={`${label} connection`} value={value?.connection ?? ''} onChange={e => change(e.target.value ? { connection: e.target.value, model: value?.model ?? '' } : null)}><option value="">{none}</option>{settings.connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
    {value && <input aria-label={`${label} model`} placeholder="Model name" value={value.model} onChange={e => change({ ...value, model: e.target.value })} />}
  </div>;
}
function Models({ settings, changed }: { settings: ProviderSettings; changed: (s: ProviderSettings) => void }) {
  const save = (next: ProviderSettings) => { changed(next); void saveProviders(projectStore, next).then(() => connectProviders(projectStore)).catch(reportError); };
  const setJob = (job: Job, choice: ModelChoice | null) => { const jobs = { ...settings.jobs }; if (choice) jobs[job] = choice; else delete jobs[job]; save({ ...settings, jobs }); };
  return <><h3>Models</h3>
    {!settings.fallback && <p className="unavailable">No default model. Editing, export and every manual feature work without one. Built-in chat, motion-graphic repair and generated titles stay off until you choose one.</p>}
    <ModelPicker label="Default model" value={settings.fallback} settings={settings} none="None" change={fallback => save({ ...settings, fallback })} />
    {settings.fallback && <details><summary>Use another model for a job</summary>{JOBS.map(j => <ModelPicker key={j.job} label={j.label} value={settings.jobs[j.job]} settings={settings} none="Default model" change={choice => setJob(j.job, choice)} />)}</details>}
  </>;
}
function Speech({ settings, changed }: { settings: ProviderSettings; changed: (s: ProviderSettings) => void }) {
  const [keyed, setKeyed] = useState<boolean>(), [key, setKey] = useState('');
  useEffect(() => { void hasSecret(SPEECH_KEY).then(setKeyed).catch(reportError); }, []);
  const use = (speech: ProviderSettings['speech']) => { const next = { ...settings, speech }; changed(next); void saveProviders(projectStore, next).catch(reportError); };
  const saveSpeechKey = () => putSecret(SPEECH_KEY, key.trim(), ELEVENLABS.origin).then(() => { setKey(''); setKeyed(true); notify('ElevenLabs key saved.'); }).catch(reportError);
  const remove = () => removeSecret(SPEECH_KEY).then(() => { setKeyed(false); use('local'); notify('ElevenLabs key removed.'); }).catch(reportError);
  return <><h3>Speech to text</h3>
    <label className="row">Transcribe with <select aria-label="Transcribe with" value={settings.speech} onChange={e => use(e.target.value as ProviderSettings['speech'])}><option value="local">This device (free)</option><option value="elevenlabs">ElevenLabs (your key)</option></select></label>
    {settings.speech === 'elevenlabs' && <>
      <p><small>The audio of each clip you transcribe goes to ElevenLabs, billed by ElevenLabs. <a href={ELEVENLABS.pricing} target="_blank" rel="noreferrer">Pricing</a> · <a href={ELEVENLABS.keys} target="_blank" rel="noreferrer">Get a key</a></small></p>
      {!keyed && <p className="unavailable">No ElevenLabs key. Transcription stays on this device until you add one.</p>}
      <form className="row" onSubmit={e => { e.preventDefault(); void saveSpeechKey(); }}><input aria-label="ElevenLabs API key" type="password" autoComplete="off" value={key} placeholder={keyed ? 'Key saved' : 'API key'} onChange={e => setKey(e.target.value)} /><button type="submit" disabled={!key.trim()}>Save key</button>{keyed && <button type="button" className="danger" onClick={() => void remove()}>Remove</button>}</form>
    </>}
  </>;
}
function StockKeys() {
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({}), [drafts, setDrafts] = useState<Partial<Record<Provider, string>>>({}), used = readUsage().requests;
  useEffect(() => { void readKeys(projectStore).then(setKeys).catch(reportError); }, []);
  const save = (provider: Provider, value: string) => saveKey(projectStore, provider, value).then(next => { setKeys(next); setDrafts(d => ({ ...d, [provider]: '' })); }).catch(reportError);
  return <><h3>Stock media keys</h3><p><small>Free keys from each library. They stay encrypted in this browser and go only to that library. Without one, that library’s tab asks for a key and everything else works.</small></p>
    <ul className="settings-list">{STOCK.map(s => <li key={s.provider}>
      <form className="row" onSubmit={e => { e.preventDefault(); void save(s.provider, drafts[s.provider] ?? ''); }}><span className="picker-label">{s.label}</span><input aria-label={`${s.label} API key`} type="password" autoComplete="off" value={drafts[s.provider] ?? ''} placeholder={keys[s.provider] ? 'Key saved' : 'API key'} onChange={e => setDrafts(d => ({ ...d, [s.provider]: e.target.value }))} /><button type="submit" disabled={!drafts[s.provider]?.trim()}>Save</button>{keys[s.provider] && <button type="button" className="danger" onClick={() => void save(s.provider, '')}>Remove</button>}<a href={s.keys} target="_blank" rel="noreferrer">Get a key</a></form>
      {s.note && <p><small>{s.note}</small></p>}
      {!!used[s.provider] && <p><small>On this device: {requestsLine(used[s.provider])}.</small></p>}
    </li>)}</ul>
  </>;
}
function LocalModels() {
  const [available, setAvailable] = useState<Availability>(), [free, setFree] = useState<number>();
  useEffect(() => {
    void analysisService.available().then(setAvailable).catch(reportError);
    void navigator.storage.estimate().then(e => setFree((e.quota ?? 0) - (e.usage ?? 0))).catch(reportError);
  }, []);
  return <><h3>Local models</h3><p><small>These run on this device and cost nothing. They are not hosted anywhere yet, so a missing one is not offered for download.</small></p>
    <ul className="settings-list" aria-label="Local models">{CAPABILITIES.map(({ capability, label }) => {
      const size = capabilityBytes(capability), enough = free === undefined || free >= size;
      return <li key={capability} data-capability={capability}><strong>{label}</strong> <span>{available?.[capability] ? 'Ready' : available ? 'Not installed' : 'Checking…'}</span>
        {available && !available[capability] && <p><small>{UNAVAILABLE[capability]} About {formatBytes(size)} on disk. {free !== undefined && `This browser has ${formatBytes(free)} free${enough ? '.' : ', which is not enough.'}`}</small></p>}</li>;
    })}</ul>
  </>;
}
export function Services() {
  const [settings, setSettings] = useState<ProviderSettings>(), [adding, setAdding] = useState(false), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  // One read per attempt. A rejection, or 10 s without an answer, offers Try again; an answer that comes later still shows the section.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => setFailed(true), 10_000);
    void readProviders(projectStore).then(s => { if (live) setSettings(s); }).catch(e => { if (live) { setFailed(true); reportError(e); } }).finally(() => clearTimeout(timer));
    return () => { live = false; clearTimeout(timer); };
  }, [attempt]);
  return <section aria-labelledby="ai-services"><h2 id="ai-services">AI and services</h2>
    <p>Everything here is optional. Cutframe adds no fee, and each provider bills you directly. <small>Hosted providers are called from this browser. A local server has to allow this page: see <a href="/help/local-model-servers">Local model servers</a>.</small></p>
    <h3>Model connections</h3>
    {settings ? <>
      {settings.connections.length ? <ul className="settings-list" aria-label="Model connections">{settings.connections.map(c => <ConnectionRow key={c.id} connection={c} changed={setSettings} />)}</ul> : <p className="empty">No model connections.</p>}
      {adding ? <ConnectionForm saved={next => { setSettings(next); setAdding(false); }} cancel={() => setAdding(false)} /> : <button onClick={() => setAdding(true)}>＋ Add connection</button>}
      <Models settings={settings} changed={setSettings} />
      <Speech settings={settings} changed={setSettings} />
    </> : failed ? <p role="alert" className="unavailable">Couldn’t read your model connections from this browser’s storage. <button onClick={() => { setFailed(false); setAttempt(a => a + 1); }}>Try again</button></p>
      : <p className="empty">Loading your model connections…</p>}
    <StockKeys />
    <LocalModels />
  </section>;
}
