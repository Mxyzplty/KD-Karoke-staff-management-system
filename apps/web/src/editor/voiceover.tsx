// SPDX-License-Identifier: AGPL-3.0-only
// Voice Over panel (T13, findings §30). States: idle → requesting access → blocked ("Try again") or a 3 s countdown → recording
// (the timeline plays; the take starts when its clock runs, so the narration stays in sync) → finalizing → idle. Stop
// pauses playback; playback stopping (the timeline's end, a pause) stops the take. The take is stored and attached to the
// project (uploadToProject, which also starts its transcription, T19) and placed by the addVoiceover intent (one
// "Add items"). The recording lives in this module, not in the panel, so switching rail tools does not end it.
// Provisional (not in §30): the Record and Finalizing labels, the explanation wording (§30 paraphrases it), a pause during
// the take stopping it, an empty timeline recording without playback until Stop, and the save-failure toast (Cutframe
// stores the take locally; there is no separate upload).
import { useEffect } from 'react';
import { create } from 'zustand';
import { projectStore } from '../store/database';
import { uploadToProject } from '../media/ingest';
import { probeMedia } from '../media/probe';
import { usePlayback } from '../render/playback';
import { activeRuntime } from '../timeline/runtime';
import { closeMic, listMics, Meter, openMic, saveMic, savedMic, Take, takeExtension, takeName, timer } from '../audio/recorder';
import type { Mic } from '../audio/recorder';
import { notify } from '../ui';
import { dispatch } from './commands';
import { view } from './view';

export const COUNTDOWN_S = 3;
type Phase = 'idle' | 'requesting' | 'blocked' | 'countdown' | 'recording' | 'finalizing';
type State = { phase: Phase; reason: string; left: number; ms: number; testing: boolean; levels: number[]; mics: Mic[]; mic: string };
export const useVoiceover = create<State>(() => ({ phase: 'idle', reason: '', left: COUNTDOWN_S, ms: 0, testing: false, levels: [], mics: [], mic: savedMic() }));
const set = (patch: Partial<State>) => useVoiceover.setState(patch), get = () => useVoiceover.getState();

let stream: MediaStream | null = null, meter: Meter | null = null, take: Take | null = null, raf = 0, tick: ReturnType<typeof setInterval> | undefined;
let project = '', startMs = 0, last: 'test' | 'record' = 'test', off: (() => void) | null = null;
const playing = () => usePlayback.getState().playing;

export async function refreshMics() { try { set({ mics: await listMics() }); } catch { /* no device list */ } }
function loop() {
  raf = requestAnimationFrame(loop);
  if (meter) set({ levels: Array.from(meter.update()), ...take && get().phase === 'recording' ? { ms: take.elapsed() } : {} });
}
function release() {
  cancelAnimationFrame(raf); raf = 0; meter?.close(); meter = null; closeMic(stream); stream = null;
  set({ levels: [] });
}
/** Opens the chosen microphone (once) and runs the meter; false when access is blocked. */
async function access(): Promise<boolean> {
  if (stream) return true;
  set({ phase: 'requesting' });
  try { stream = await openMic(get().mic); } catch (e) {
    set({ phase: 'blocked', reason: (e as Error).message || (e as Error).name || 'The microphone could not be opened.' });
    return false;
  }
  meter = new Meter(stream); loop(); void refreshMics(); // device names appear once access was granted
  set({ phase: 'idle' });
  return true;
}
export async function startTest() { last = 'test'; if (await access()) set({ testing: true }); }
export function stopTest() { set({ testing: false }); if (get().phase === 'idle') release(); }
export async function chooseMic(id: string) {
  saveMic(id); set({ mic: id });
  if (!stream || get().phase !== 'idle') return;
  release(); if (get().testing && !await access()) set({ testing: false });
}
export async function record(projectId: string) {
  if (get().phase !== 'idle' && get().phase !== 'blocked') return;
  last = 'record'; project = projectId;
  if (!await access()) return;
  set({ phase: 'countdown', left: COUNTDOWN_S });
  tick = setInterval(() => { const left = get().left - 1; if (left > 0) set({ left }); else { clearInterval(tick); begin(); } }, 1000);
}
export const tryAgain = () => { set({ phase: 'idle', reason: '' }); void (last === 'record' ? record(project) : startTest()); };
export function cancel() { clearInterval(tick); set({ phase: 'idle' }); if (!get().testing) release(); }
/** The timeline plays from the playhead (play at the end starts from 0); the take starts when the clock runs. */
function begin() {
  take = new Take(stream!);
  const go = () => {
    off?.(); take!.start(); set({ phase: 'recording', ms: 0 });
    off = usePlayback.subscribe(s => { if (!s.playing) void stop(); });
  };
  // An empty timeline has nothing to play (its end is 0): the take runs until Stop.
  const empty = !((activeRuntime?.bus.doc.duration ?? 0) > 0);
  if (!playing() && (empty || !dispatch({ type: 'togglePlayback' }).ok)) { startMs = view().playheadMs; go(); return; }
  startMs = view().playheadMs;
  if (usePlayback.getState().running) { go(); return; }
  off = usePlayback.subscribe(s => { if (s.running) go(); else if (!s.playing) discard(); });
}
export async function stop() {
  if (get().phase !== 'recording' || !take) return;
  off?.(); off = null;
  const current = take; take = null;
  set({ phase: 'finalizing' });
  if (playing()) dispatch({ type: 'togglePlayback' });
  try { const { blob, durationMs } = await current.stop(); await commit(blob, durationMs); }
  catch (e) { notify(`Voiceover failed to save — ${(e as Error).message}`); }
  set({ phase: 'idle', ms: 0 }); if (!get().testing) release();
}
export function discard() {
  off?.(); off = null; take?.discard(); take = null;
  if (playing()) dispatch({ type: 'togglePlayback' });
  set({ phase: 'idle', ms: 0 }); if (!get().testing) release();
}
/** The item is as long as the stored take (its container's duration, T14's probe); the recorder's timer only when the
 *  take cannot be probed. */
async function commit(blob: Blob, timedMs: number) {
  const name = takeName(new Date()), file = new File([blob], name + takeExtension(blob.type), { type: blob.type.split(';')[0] });
  const durationMs = await probeMedia(file, file.name, 'audio').then(i => i.durationMs, () => null) ?? timedMs;
  const r = await uploadToProject(projectStore, project, [file]), asset = r.assets[0];
  if (!asset) throw r.failed[0]?.error ?? new Error('The recording was not stored.');
  const link = (await projectStore.projectAssets(project)).find(l => l.assetId === asset.id && l.deleted_at === null);
  if (!link) throw new Error('The recording was not added to the project.');
  dispatch({ type: 'addVoiceover', assetId: asset.id, agentId: link.agent_id, name, atMs: startMs, durationMs });
}

export function VoiceoverPanel({ projectId }: { projectId: string | null }) {
  const s = useVoiceover(), busy = s.phase !== 'idle' && s.phase !== 'blocked';
  useEffect(() => {
    void refreshMics();
    const devices = navigator.mediaDevices;
    devices?.addEventListener?.('devicechange', refreshMics);
    return () => devices?.removeEventListener?.('devicechange', refreshMics);
  }, []);
  const unnamed = !s.mics.length || s.mics.some(m => !m.label);
  return <section aria-label="Voice Over" className="tool-panel voiceover"><h3>Voice Over</h3>
    <p>The timeline plays while you record, so your narration stays in sync. When you stop, the clip is added at the playhead position where recording started.</p>
    <label className="row">Microphone<select aria-label="Microphone" value={s.mic} disabled={busy} onChange={e => void chooseMic(e.target.value)}>
      <option value="">System default</option>
      {s.mics.map((m, i) => <option key={m.id} value={m.id}>{m.label || `Microphone ${i + 1}`}</option>)}
    </select></label>
    {unnamed && <p className="hint">Grant mic access once to see device names</p>}
    {s.phase === 'idle' && <button onClick={() => s.testing ? stopTest() : void startTest()}>{s.testing ? 'Stop test' : 'Test microphone'}</button>}
    {s.phase === 'requesting' && <p role="status">Requesting microphone access…</p>}
    {s.phase === 'blocked' && <div role="alert"><strong>Microphone access blocked</strong><p>{s.reason}</p><button onClick={tryAgain}>Try again</button></div>}
    {s.phase === 'countdown' && <div role="status"><strong>Get ready…</strong> <span className="vo-count">{s.left}</span> <button onClick={cancel}>Cancel</button></div>}
    {s.phase === 'recording' && <div className="row" role="status"><span className="vo-dot" aria-hidden="true" /><span aria-label="Recording time">{timer(s.ms)}</span>
      <button onClick={() => void stop()}>Stop</button><button onClick={discard}>Discard</button></div>}
    {s.phase === 'finalizing' && <p role="status">Finalizing…</p>}
    {s.levels.length > 0 && <div className="vo-meter" role="img" aria-label="Microphone level" data-peak={Math.max(...s.levels).toFixed(3)}>{s.levels.map((l, i) => <span key={i} style={{ height: `${Math.round(l * 100)}%` }} />)}</div>}
    {projectId ? s.phase === 'idle' && <button onClick={() => void record(projectId)}>Record</button> : <p>Open a project to enable recording.</p>}
  </section>;
}
