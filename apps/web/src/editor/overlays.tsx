// SPDX-License-Identifier: AGPL-3.0-only
// Editor overlays (findings part 2 §36, part 3 §46.17): Background Jobs panel, Ctrl+Shift+P performance overlay, our
// shortcut list (improvement) and the editor tour (data-tour anchors, seen flag in this browser).
import { useEffect, useState } from 'react';
import { projectStore } from '../store/database';
import type { Asset } from '../store/model';
import { cancelPreparation, prepareAsset, preparingHere } from '../media/prepare';
import { cancelMaskJob, dismissMaskJob, useMaskJobs } from '../masks/jobs';
import type { MaskJob } from '../masks/jobs';
import { Dialog, reportError } from '../ui';
import { SHORTCUTS } from './keymap';
import { setView, useView } from './view';

/** A background job: media preparation (T14), smart masks and background removal (T12, `maskRows`). A running preparation that this tab runs can be cancelled (T14's
 *  CLIENT_PREPARATION_CANCELLED path: no retry budget used, not resumed automatically); one running in another tab cannot. */
export type Job = { id: string; label: string; state: 'waiting' | 'running' | 'failed' | 'cancelled' | 'done'; progress: number | null; detail?: string; retry?: () => Promise<unknown>; cancel?: () => void; dismiss?: () => void };
/** T19's steps follow T14's (part 3 §44.5 names; a failed T19 step does not stop the job, so it counts as done). */
const STEPS = ['upload', 'probe', 'thumbnails', 'waveform', 'proxy'], T19_STEPS = ['analysis', 'transcription', 'embeddings_description', 'embeddings_transcript'];
export function preparationJobs(assets: Asset[], here: (id: string) => boolean = preparingHere): Job[] {
  return assets.filter(a => a.processing_status && a.processing_status !== 'ready').map(a => {
    const steps = a.processing_steps ?? {}, known = [...STEPS, ...T19_STEPS].filter(s => s in steps);
    const done = known.filter(s => steps[s] === 'complete' || steps[s] === 'unavailable' || steps[s] === 'skipped' || (T19_STEPS.includes(s) && steps[s] === 'failed')).length;
    const cancelled = a.processing_status === 'failed' && a.last_error_code === 'CLIENT_PREPARATION_CANCELLED', analysing = T19_STEPS.some(s => steps[s] === 'processing');
    return { id: a.id, label: `Preparing ${a.name}`, state: cancelled ? 'cancelled' : a.processing_status === 'failed' ? 'failed' : 'running', progress: known.length ? done / known.length : null,
      detail: cancelled ? 'Cancelled' : a.processing_status === 'failed' ? a.last_error_code ?? 'failed' : a.processing_status === 'uploading' ? 'Uploading' : analysing ? 'Analysis, transcription and search index' : 'Thumbnails, waveform and proxy',
      retry: a.processing_status === 'failed' && a.last_error_code !== 'UPLOAD_INTERRUPTED' ? () => prepareAsset(projectStore, a.id, { manual: true }) : undefined,
      cancel: a.processing_status === 'processing' && here(a.id) ? () => { cancelPreparation(a.id); } : undefined };
  });
}
/** T12's jobs: waiting, processing n %, done, failed; a job can be cancelled until it ends. */
export const maskRows = (jobs: MaskJob[]): Job[] => jobs.map(j => {
  const live = j.state === 'waiting' || j.state === 'processing';
  return { id: j.id, label: j.label, state: j.state === 'processing' ? 'running' : j.state, progress: j.state === 'processing' ? j.percent / 100 : null, detail: j.state === 'processing' ? `Processing mask ${j.percent} %` : j.detail, cancel: live ? () => cancelMaskJob(j.id) : undefined, dismiss: live ? undefined : () => dismissMaskJob(j.id) };
});
/** Background Jobs (preview corner): count badge (running / failed), collapsible list, Retry / Cancel / Dismiss. */
export function JobsPanel({ assets, refresh }: { assets: Asset[]; refresh: () => void }) {
  const [open, setOpen] = useState(false), [dismissed, setDismissed] = useState<string[]>([]);
  const masks = useMaskJobs(s => s.jobs), jobs = [...preparationJobs(assets), ...maskRows(masks)].filter(j => !dismissed.includes(`${j.id}:${j.state}`)), failed = jobs.some(j => j.state === 'failed');
  return <section className="jobs" aria-label="Background Jobs">
    <button className="jobs-header" aria-expanded={open} onClick={() => setOpen(!open)}>Background Jobs <span className={`count ${failed ? 'failed' : jobs.length ? 'running' : ''}`} aria-label={`${jobs.length} jobs${failed ? ', some failed' : ''}`}>{jobs.length}</span></button>
    {open && (jobs.length ? <ul aria-label="Jobs">{jobs.map(j => <li key={j.id} data-state={j.state}>
      <strong>{j.label}</strong><small>{j.detail}</small>
      {j.progress !== null && <progress max={1} value={j.progress} aria-label={`${j.label} progress`} />}
      {j.retry && <button onClick={() => void j.retry!().catch(reportError).finally(refresh)}>Retry</button>}
      {j.cancel && <button onClick={() => { j.cancel!(); setTimeout(refresh, 200); }}>Cancel</button>}
      {j.state !== 'running' && j.state !== 'waiting' && <button onClick={() => j.dismiss ? j.dismiss() : setDismissed(d => [...d, `${j.id}:${j.state}`])}>Dismiss</button>}
    </li>)}</ul> : <p>No active jobs</p>)}
  </section>;
}
/** Ctrl+Shift+P: live FPS, memory use and the number of video elements, with a collapse caret. */
export function PerformanceOverlay() {
  const [stats, setStats] = useState({ fps: 0, memory: null as number | null, videos: 0 }), [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    let frames = 0, last = performance.now(), raf = requestAnimationFrame(function tick(now) {
      frames++;
      if (now - last >= 500) {
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
        setStats({ fps: Math.round(frames * 1000 / (now - last)), memory: memory === undefined ? null : memory / 1048576, videos: document.getElementsByTagName('video').length });
        frames = 0; last = now;
      }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  return <aside className="performance" aria-label="Performance">
    <button aria-label={collapsed ? 'Expand performance' : 'Collapse performance'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '▴' : '▾'}</button>
    {!collapsed && <dl><dt>FPS</dt><dd data-stat="fps">{stats.fps}</dd><dt>Memory</dt><dd data-stat="memory">{stats.memory === null ? 'n/a' : `${stats.memory.toFixed(1)} MB`}</dd><dt>Videos</dt><dd data-stat="videos">{stats.videos}</dd></dl>}
  </aside>;
}
export function ShortcutOverlay() {
  return <Dialog title="Keyboard shortcuts" close={() => setView({ shortcuts: false })}>
    <p>Shortcuts work while the page, the timeline or the preview has focus, and never while you type.</p>
    <table className="shortcuts"><tbody>{SHORTCUTS.map(([key, what]) => <tr key={key}><th scope="row"><kbd>{key}</kbd></th><td>{what}</td></tr>)}</tbody></table>
  </Dialog>;
}

// ---- Editor tour (part 2 §36): first visit, waits up to 5 s for its anchors, "n of N", Next / Skip, seen flag stored.
export const TOUR_KEY = 'cutframe:tour:editor';
export const TOUR_STEPS = [
  { anchor: 'footage', title: 'Your footage', text: 'Everything you add to this project lives here. Click a thumbnail to put it on the timeline, or drag it there.' },
  { anchor: 'reference-tab', title: 'Reference videos', text: 'Keep videos whose style you want to match. They stay in this browser and can be attached to any project.' },
  { anchor: 'timeline', title: 'The timeline', text: 'Arrange, trim and split clips here. Press ? at any time to see the keyboard shortcuts.' },
  { anchor: 'agent-badge', title: 'Connect your own agent', text: 'Outside agents such as Claude Code or Codex can edit this project through the agent connection.' },
];
export type TourStep = { anchor: string; title: string; text: string };
const seen = (key: string) => { try { return !!localStorage.getItem(key); } catch { return true; } };
const remember = (key: string, value: 'done' | 'skipped') => { try { localStorage.setItem(key, value); } catch { /* not stored: the tour may show again */ } };
/** Shared tour mechanism (§36 "other tours use the same anchor mechanism"): the editor and home pass their own key, steps and
 *  label. `ready` holds a tour back (home waits until onboarding is done). The drawer guard is for the editor; home has none. */
export function Tour({ tourKey = TOUR_KEY, tourSteps = TOUR_STEPS, label = 'Editor tour', ready = true }: { tourKey?: string; tourSteps?: TourStep[]; label?: string; ready?: boolean } = {}) {
  const [steps, setSteps] = useState<TourStep[]>(), [index, setIndex] = useState(0), [box, setBox] = useState<DOMRect>(), drawer = useView(s => s.drawer);
  useEffect(() => {
    if (!ready || seen(tourKey)) return;
    const started = Date.now(), timer = setInterval(() => {
      const present = tourSteps.filter(s => document.querySelector(`[data-tour="${s.anchor}"]`));
      if (present.length === tourSteps.length || (Date.now() - started >= 5000 && present.length)) { clearInterval(timer); setSteps(present); }
      else if (Date.now() - started >= 5000) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [ready, tourKey, tourSteps]);
  const step = steps?.[index];
  useEffect(() => { if (!step) return; const update = () => setBox(document.querySelector(`[data-tour="${step.anchor}"]`)?.getBoundingClientRect()); update(); const t = setInterval(update, 250); return () => clearInterval(t); }, [step]);
  if (!steps || !step || drawer) return null;
  const finish = (value: 'done' | 'skipped') => { remember(tourKey, value); setSteps(undefined); };
  return <>
    {box && <div className="tour-highlight" aria-hidden="true" style={{ left: box.left - 4, top: box.top - 4, width: box.width + 8, height: box.height + 8 }} />}
    <section className="tour" role="dialog" aria-modal="false" aria-label={label}>
      <small>{index + 1} of {steps.length}</small><h3>{step.title}</h3><p>{step.text}</p>
      <div className="dialog-actions"><button onClick={() => finish('skipped')}>Skip tour</button><button className="primary" onClick={() => index + 1 < steps.length ? setIndex(index + 1) : finish('done')}>{index + 1 < steps.length ? 'Next' : 'Done'}</button></div>
    </section>
  </>;
}
export const HOME_TOUR_KEY = 'cutframe:tour:home';
export const HOME_TOUR_STEPS: TourStep[] = [
  { anchor: 'new-video', title: 'Start a video', text: 'New Video walks you from footage to a first cut. Everything you make stays in this browser.' },
  { anchor: 'your-projects', title: 'Your projects', text: 'Projects you create appear here, saved locally on this device.' },
];
