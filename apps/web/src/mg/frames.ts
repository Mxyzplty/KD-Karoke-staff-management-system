// SPDX-License-Identifier: AGPL-3.0-only
// Motion-graphic pictures for T15's render model. The paused preview, frame capture and the export draw the same graphic
// frame (render/model.ts graphicDraw) rendered at the item box size (D25); export applies its own D35 colour decode. The
// renderer (index.ts, which carries the sandbox bundle) loads on first use. While playing, a frame takes about 250 ms at
// 1080 × 1920 (T08 notes), so the latest finished frame stays up and the next one is asked for where the clock will be when
// it is done (provisional, not Xapp parity: Xapp's preview is a live DOM render).
import type { Source } from '../render/compositor';
import type { Draw } from '../render/model';
import type { ProjectStore } from '../store/database';
import { create } from 'zustand';
import { assetIds } from './agent-checks';
import { renderWithRetry } from './errors';

type Renderer = ReturnType<typeof import('./index').createMotionGraphicRenderer>;
let renderer: Promise<Renderer> | null = null, links: readonly { agentId: string; id: string }[] = [];
const urls = new Map<string, Promise<string>>();
/** The project's live asset links (agentId → asset id), for getAssetUrl. */
export const graphicAssets = (list: readonly { agentId: string; id: string }[]) => { links = list; };

/** The blob URL of the asset attached under this agent id, or undefined when the project has no such link (the compile then
 *  refuses the id as on the add: VALIDATION_ERROR). */
async function attachedUrl(store: ProjectStore, agentId: string): Promise<string | undefined> {
  const link = links.find(l => l.agentId === agentId);
  if (!link) return undefined;
  let url = urls.get(link.id);
  if (!url) { url = store.media.read(link.id).then(blob => URL.createObjectURL(blob)); urls.set(link.id, url); url.catch(() => urls.delete(link.id)); }
  return url;
}
/** Only the ids the code names as literals: the sandbox embeds every map entry for every frame. An id the code reaches
 *  through a constant comes back from the render as a refusal naming it, and renderGraphic's resolve looks it up then. */
async function assetMap(store: ProjectStore, code: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const agentId of assetIds(code)) { const url = await attachedUrl(store, agentId); if (url !== undefined) out[agentId] = url; }
  return out;
}
/** The frame of one motion-graphic draw as a bitmap of the item box size; throws the renderer's MotionGraphicError. The frame
 *  is already on the graphic clock, so no trim start is passed (T08a: a frame or a frame + trim, never both).
 *  decode lets export table straight PNG bytes; omitting it keeps the shared preview/capture bitmap path. */
export async function renderGraphic(store: ProjectStore, d: Draw, frame = d.graphic!.frame, decode?: (png: string) => Promise<ImageBitmap>): Promise<ImageBitmap> {
  const g = d.graphic!, r = await (renderer ??= import('./index').then(m => m.createMotionGraphicRenderer()));
  const result = await r.render({ code: g.code, frame, width: g.canvas.width, height: g.canvas.height, fps: g.fps, durationInFrames: g.durationInFrames,
    fieldValues: g.fieldValues, assetMap: await assetMap(store, g.code), itemSize: { width: d.box.W, height: d.box.H } },
    // One rule for the paused preview, playback, capture and the export: an id the code does not name as a literal is
    // looked up when the render asks for it (index.ts render).
    id => attachedUrl(store, id));
  // Export can consume the straight PNG bytes; shared preview/capture keep their original bitmap decode.
  if (decode) return decode(result.image);
  const image = new Image(); image.src = result.image; await image.decode();
  return createImageBitmap(image);
}
const declared = new Map<string, Promise<unknown[]>>();
/** The editable fields the code declares (the sandbox dry run's list, unchecked), one compile per code; throws as compile. */
export function graphicFields(store: ProjectStore, code: string): Promise<unknown[]> {
  if (!code.trim()) return Promise.resolve([]); // no code declares nothing: the renderer chunks are not loaded for it (review m4)
  const known = declared.get(code);
  if (known) return known;
  // Every attached id, as the add's dry run does (tools.ts): the dry run reads no media, so an id the code reaches through a
  // constant only needs to be in the map to compile. The ids named as literals keep their real URL.
  const fields = (async () => (await (await (renderer ??= import('./index').then(m => m.createMotionGraphicRenderer()))).compile(code,
    { ...Object.fromEntries(links.map(l => [l.agentId, ''])), ...await assetMap(store, code) })).fields)();
  declared.set(code, fields); fields.catch(() => { if (declared.get(code) === fields) declared.delete(code); });
  return fields;
}
/** The last render error of each graphic by item id, for the preview's error panel (repair-panel.tsx). */
export const useGraphicErrors = create<{ errors: Record<string, string> }>(() => ({ errors: {} }));
/** Bumped by clearGraphics: a render the disposal cut short is not the graphic's error. */
let epoch = 0;
function setError(id: string, message: string | null, from: number) {
  if (from !== epoch) return;
  const errors = useGraphicErrors.getState().errors;
  if ((errors[id] ?? null) === message) return;
  const next = { ...errors };
  if (message === null) delete next[id]; else next[id] = message;
  useGraphicErrors.setState({ errors: next });
}
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);
const codeOf = (e: unknown) => { const code = (e as { code?: unknown })?.code; return typeof code === 'string' ? code : undefined; };
/* The rule itself lives in errors.ts (renderAgain), so the parity adapter's frame() applies the same one (FU-m1). */
/** The exact picture (paused preview, seek, capture, export). A graphic that fails to render is asked once more, unless the
 *  failure is static, or MG_WATCHDOG on a preview frame (a runaway graphic holds the editor's thread for one budget, not two;
 *  capture asks again). If it fails again, nothing is drawn and the failure names the graphic, for the caller to report
 *  (capture: notRendered). */
export async function graphicPicture(store: ProjectStore, d: Draw, purpose: 'preview' | 'capture' = 'preview', decode?: (png: string) => Promise<ImageBitmap>): Promise<Source> {
  const from = epoch; let error: unknown;
  try { const b = await renderWithRetry(() => renderGraphic(store, d, d.graphic!.frame, decode), purpose); setError(d.item.id, null, from); return { image: b, width: b.width, height: b.height }; }
  catch (e) { error = e; }
  const code = codeOf(error), message = messageOf(error);
  setError(d.item.id, message, from);
  return { itemId: d.item.id, error: `Motion graphic '${String(d.item.details?.name ?? 'Motion graphic')}' (${d.item.id}) could not be rendered: ${code ? `${code}: ` : ''}${message}` };
}

type Live = { key: string; frame: number; bitmap: ImageBitmap | null; busy: boolean; failed: boolean; costMs: number };
const live = new Map<string, Live>();
/** The picture while playing: what is ready now. exact: it is this paint's frame. The first request is the paint's own frame
 *  (usually in the renderer's cache from the paused preview); later ones aim the measured render time ahead. */
export function liveGraphic(store: ProjectStore, d: Draw): { source: Source; exact: boolean; failed: boolean } {
  const g = d.graphic!, id = d.item.id, key = JSON.stringify([g.code, g.canvas, g.fps, g.durationInFrames, g.fieldValues, Math.round(d.box.W), Math.round(d.box.H)]);
  let s = live.get(id);
  if (!s || s.key !== key) { s?.bitmap?.close(); live.set(id, s = { key, frame: -1, bitmap: null, busy: false, failed: false, costMs: 0 }); }
  if (!s.busy && !s.failed && s.frame !== g.frame) {
    const state = s, started = performance.now(), target = Math.min(g.lastFrame, g.frame + Math.ceil(state.costMs * g.fps / 1000)), from = epoch;
    state.busy = true;
    renderGraphic(store, d, target).then(b => {
      state.busy = false; state.costMs = performance.now() - started;
      if (live.get(id) !== state) { b.close(); return; }
      state.bitmap?.close(); state.bitmap = b; state.frame = target;
    }, e => { state.busy = false; state.failed = true; setError(id, messageOf(e), from); });
  }
  return { source: s.bitmap ? { image: s.bitmap, width: s.bitmap.width, height: s.bitmap.height } : null, exact: !!s.bitmap && s.frame === g.frame, failed: s.failed };
}
/** Playback stopped: the frames kept for it are released. */
export function clearLiveGraphics() { for (const s of live.values()) s.bitmap?.close(); live.clear(); }
/** Project close: the renderer, its frame cache and the asset URLs go too. */
export function clearGraphics() {
  clearLiveGraphics(); epoch++;
  void renderer?.then(r => { r.clearLearnedAssets(); r.dispose(); }).catch(() => {}); renderer = null;
  for (const u of urls.values()) void u.then(URL.revokeObjectURL, () => {});
  urls.clear(); declared.clear(); useGraphicErrors.setState({ errors: {} });
}
