// SPDX-License-Identifier: AGPL-3.0-only
// The preview stage's frames (part 5 §53.5.4, §53.8): one canvas per preview run, bottom first. Paused: a project-size canvas
// shows the exact frame round(t × fps) from the decoder pool, redrawn after every change. Playing: playback.ts paints each new
// frame index with what is ready, at the §53.8.3 canvas size. What T15 does not render is listed on the stage, never drawn wrong.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { projectStore } from '../store/database';
import type { Asset, ProjectDocument } from '../store/model';
import { complete, composite } from '../render/compositor';
import { GL_RETRY_MS, onEffectsBackendChange } from '../render/effects';
import { canvasSize, fpsOf, framePlan, previewFrame, previewRuns, projectSize, snapTime } from '../render/model';
import type { Pending, Size } from '../render/model';
import { attachPlayback, livePicture, usePlayback } from '../render/playback';
import { clearSources, picture } from '../render/sources';
import { onRasterFrame } from '../masks/raster';
import { GraphicErrorPanel } from '../mg/repair-panel';
import { onFontChange } from '../text/font-registry';
import { useView, view } from './view';

/** §53.8.3: the on-screen size is re-read at most every 500 ms while playing. */
const ONSCREEN_MS = 500;
/** §53.8.1: the stage shows the stored background as CSS (an image as a centred cover); transparent or missing is black. */
export function stageBackground(doc: ProjectDocument): CSSProperties {
  const bg = doc.background, value = typeof bg?.value === 'string' ? bg.value : '';
  if (bg?.type === 'image' && value) return { background: `#000 url(${JSON.stringify(value)}) center / cover no-repeat` };
  return { background: bg?.type === 'color' && value && value !== 'transparent' ? value : '#000' };
}
export function PreviewFrames({ doc, assets }: { doc: ProjectDocument; assets: Asset[] }) {
  const v = useView(), playing = usePlayback(p => p.playing), runs = useMemo(() => previewRuns(doc), [doc]), fps = fpsOf(doc), t = snapTime(v.playheadMs, fps);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]), live = useRef({ doc, runs, assets: new Map<string, Asset>() }), generation = useRef(0);
  live.current = { doc, runs, assets: new Map(assets.map(a => [a.id, a])) };
  const pending = useMemo(() => [...new Set(framePlan(doc, t).pending.map(p => `${p.what} (${p.owner})`))], [doc, t]);
  // Items the effect stage could not draw, per run (T10 B3): shown as an error on the stage, never drawn without their effects.
  const failed = useRef<string[][]>([]), [errors, setErrors] = useState('');
  const report = (i: number, list: Pending[]) => {
    failed.current[i] = list.map(p => `Effects not drawn (${p.code}): ${p.message}`);
    failed.current.length = live.current.runs.length;
    setErrors([...new Set(failed.current.flat().filter(Boolean))].join(' '));
    return list;
  };
  // N5: a frame drawn between a WebGPU device loss and its report is blank; the paused frame is drawn again when the backend
  // changes (playback's next paint already uses the new one), and again GL_RETRY_MS after a frame without any GPU backend.
  const [gpuChange, setGpuChange] = useState(0);
  useEffect(() => onEffectsBackendChange(() => setGpuChange(n => n + 1)), []);
  // T05: a text frame drawn before its face arrived used the fallback metrics; the paused frame is drawn again when a font
  // (or the emoji / CJK chain font) loads or fails. Only the registry is imported here, never the font files.
  const [fontChange, setFontChange] = useState(0);
  useEffect(() => onFontChange(() => setFontChange(n => n + 1)), []);
  // T12: a raster mask frame that lands after the paint draws the paused frame again.
  useEffect(() => onRasterFrame(() => setGpuChange(n => n + 1)), []);
  // Playback paints straight into the run canvases; it stays attached while the editor is open.
  useEffect(() => {
    let onscreen: { at: number; size: Size } | null = null;
    const detach = attachPlayback({
      store: projectStore, doc: () => live.current.doc, asset: id => live.current.assets.get(id),
      paint: tMs => {
        const { doc: d, runs: rs } = live.current, first = canvases.current.find(Boolean), now = performance.now();
        if (!first) return;
        if (!onscreen || now - onscreen.at >= ONSCREEN_MS) { const r = first.getBoundingClientRect(); onscreen = { at: now, size: { width: r.width, height: r.height } }; }
        const project = projectSize(d), size = canvasSize(project, true, view().quality, onscreen.size, devicePixelRatio || 1);
        rs.forEach((run, i) => {
          const c = canvases.current[i];
          if (!c) return;
          if (c.width !== size.width || c.height !== size.height) { c.width = size.width; c.height = size.height; }
          // §53.9 row 20 (T10): CSS blur and shadow lengths follow the reduced canvas, so playing looks like the paused frame.
          const plan = framePlan(d, tMs, size, run.trackIds, { cssScale: size.width / project.width });
          report(i, composite(c.getContext('2d')!, plan.draws, plan.draws.map(livePicture), size, 'clear'));
          c.dataset.frame = String(previewFrame(tMs, fpsOf(d))); c.dataset.exact = 'false';
        });
      },
    });
    return () => { detach(); clearSources(); };
  }, []);
  // Paused: the exact frame at the project size. A newer change discards an older render that finishes late. data-exact says
  // what was drawn: 'true' only when every draw has its picture (a failed source's grey fill is not the frame) and the effect
  // stage drew every item.
  useEffect(() => {
    if (playing) return;
    const g = ++generation.current, size = projectSize(doc), frame = String(previewFrame(t, fps));
    let retry: number | undefined;
    runs.forEach((run, i) => {
      const c = canvases.current[i];
      if (!c) return;
      c.dataset.exact = 'false';
      const plan = framePlan(doc, t, size, run.trackIds), asset = live.current.assets;
      void Promise.all(plan.draws.map(d => picture(projectStore, d, asset.get(String(d.item.metadata?.assetId)), 'preview', id => asset.get(id)))).then(sources => {
        if (g !== generation.current) return;
        if (c.width !== size.width || c.height !== size.height) { c.width = size.width; c.height = size.height; }
        const failures = report(i, composite(c.getContext('2d')!, plan.draws, sources, size, 'clear'));
        c.dataset.frame = frame; c.dataset.exact = String(!failures.length && sources.every((s, k) => complete(s, plan.draws[k]) || plan.draws[k].kind === 'text'));
        if (failures.some(f => f.code === 'WEBGL_UNSUPPORTED')) retry ??= window.setTimeout(() => setGpuChange(n => n + 1), GL_RETRY_MS);
      });
    });
    return () => clearTimeout(retry);
  }, [doc, t, fps, playing, runs, assets, gpuChange, fontChange]);
  return <>
    {runs.map((run, i) => <canvas key={run.trackIds.join()} ref={el => { canvases.current[i] = el; }} className="run" aria-hidden="true" data-run={i} data-tracks={run.trackIds.join(' ')} />)}
    {pending.length > 0 && <p className="unavailable pending-render" role="note">Not rendered yet: {pending.join(', ')}.</p>}
    {errors && <p className="unavailable render-error" role="alert">{errors}</p>}
    <GraphicErrorPanel doc={doc} t={t} />
  </>;
}
