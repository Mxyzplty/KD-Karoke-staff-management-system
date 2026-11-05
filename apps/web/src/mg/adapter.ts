// SPDX-License-Identifier: AGPL-3.0-only
// Node-side parity adapter. No private reference is opened here; Author owns stored-reference runs.
// Two kinds of call (T08 notes, adapter): the T08a runtime calls `mg.add` / `mg.patchCode` (graphics on one implicit layer,
// pre-trimmed pieces, `{success, code, message, details}`), and the agent tools by name (`addMotionGraphic`,
// `editMotionGraphic`, `trimItem`, `splitItem`, …) on a real T03 timeline (timeline/harness.ts): the same handlers, sandbox
// dry run, result envelopes, tracks and TRACK_OVERLAP as the tab. A frame draws the mg.add graphics, then the timeline's
// frame plan through the shared compositor (render/model.ts framePlan + render/compositor.ts, the export path).
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { ParityAdapter, Frame } from '../../../../parity/runner';
import type { Json } from '../../../../parity/normalise';
import { framePlan } from '../render/model';
import { emptyDocument } from '../store/model';
import type { Asset, AssetLink } from '../store/model';
import { createEditor } from '../timeline/harness';
import { setIdSource } from '../timeline/model';
import type { EditorHarness } from '../timeline/harness';
import { assetIds } from './agent-checks';
import { graphicFrame } from './clock';
import { patchCode, validateSummary } from './edits';
import { MotionGraphicError } from './errors';
import { callMotionGraphicTool, MOTION_GRAPHIC_TOOLS } from './tools';
type Graphic = { id: string; code: string; summary?: string; startMs?: number; durationMs?: number; trimStartMs?: number; designedLengthMs?: number; fieldValues?: Record<string, Json>; assetMap?: Record<string, string>; itemBox?: { x: number; y: number; width: number; height: number }; frameOverrides?: Record<string, number> };
/** assets: agent id → URL (a data URL in a scenario) that timeline graphics reach with getAssetUrl. itemFrameOverrides: item id →
 *  sample time (ms) → the graphic frame a stored frame prints, as a graphic's frameOverrides (ticket T08 golden suite). */
type Project = { width: number; height: number; fps: number; graphics: Graphic[]; assets?: Record<string, string>; itemFrameOverrides?: Record<string, Record<string, number>> };
export class MotionGraphicParityAdapter implements ParityAdapter {
  name = 'cutframe-motion-graphic-runtime'; private server?: ViteDevServer; private browser?: Browser; private page?: Page; private state!: Project; private url = '';
  private editor!: EditorHarness; private timeline = false;
  async open(project: Json): Promise<void> {
    this.state = structuredClone(project) as unknown as Project;
    if (!this.state || !Number.isInteger(this.state.width) || !Number.isInteger(this.state.height) || !(this.state.fps > 0) || !Array.isArray(this.state.graphics)) throw Error('MG adapter project needs width, height, fps and graphics[].');
    const assets = Object.keys(this.state.assets ?? {});
    // Ids as parity/g01.ts: counted from 1 (track O1, item_000001, …), so a scenario's later steps can name what it added.
    let n = 0; setIdSource(() => String(++n).padStart(6, '0'));
    this.editor = createEditor({ ...emptyDocument(), size: { width: this.state.width, height: this.state.height }, fps: this.state.fps }, {
      assets: assets.map(id => ({ id: `asset-${id}`, type: 'image' }) as Asset),
      links: assets.map(id => ({ id: `link-${id}`, projectId: 'parity', assetId: `asset-${id}`, agent_id: id, content_type: 'image', added_at: '', deleted_at: null }) as AssetLink) });
    // T08 notes, 101-frame abort: a content change to a watched module mid-run made Vite full-reload the harness page and
    // the next evaluate died with "Execution context was destroyed". A parity run serves a fixed snapshot: no watcher, no HMR.
    this.server = await createServer({ configFile: false, root: 'apps/web', server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, logLevel: 'error', optimizeDeps: { include: ['@babel/standalone','react','react-dom','react-dom/client','@react-three/fiber','three','lottie-web','svg-path-properties','simplex-noise'] } });
    await this.server.listen(); const address = this.server.httpServer!.address(); if (!address || typeof address === 'string') throw Error('MG parity server did not bind.');
    this.browser = await chromium.launch({ headless: true }); this.page = await this.browser.newPage({ deviceScaleFactor: 1 });
    this.url = `http://127.0.0.1:${address.port}/src/mg/harness.html`; await this.load();
  }
  private async load(): Promise<void> { await this.page!.goto(this.url); await this.page!.waitForFunction(() => !!(window as any).mg); }
  /** One retry if the page navigated under an evaluate (any reload left despite the snapshot server). The context dies
   *  when the new document commits, so let that navigation finish; navigate again only if it left the harness. */
  private async evaluate<T, A>(fn: (arg: A) => Promise<T>, arg: A): Promise<T> {
    const run = () => this.page!.evaluate(fn as (arg: unknown) => Promise<T>, arg as unknown);
    try { return await run(); }
    catch (error) {
      if (!/Execution context was destroyed|navigat/i.test(String((error as Error)?.message))) throw error;
      await this.page!.waitForLoadState('load');
      if (this.page!.url() !== this.url) await this.page!.goto(this.url);
      await this.page!.waitForFunction(() => !!(window as any).mg);
      return run();
    }
  }
  async execute(tool: string, input: Json): Promise<Json> {
    const value = input as any;
    if (tool === 'mg.add') {
      if (this.state.graphics.some(g => g.id === value.id)) throw Error('Duplicate graphic id.');
      const result = validateSummary(value.summary); if (!result.valid) return { success: false, code: 'MISSING_PARAM', message: result.message! };
      const validation = await this.evaluate(async (graphic: any) => { const r = (window as any).mg.createMotionGraphicRenderer(); try { await r.compile(graphic.code, graphic.assetMap); return null; } catch (e) { const error = e as any; return { success: false, code: error.code, message: error.message, details: error.details ?? null }; } finally { r.dispose(); } }, value);
      if (validation) return validation;
      this.state.graphics.push({ ...value, summary: result.summary }); return { success: true };
    }
    if (tool === 'mg.patchCode') { const graphic = this.state.graphics.find(g => g.id === value.id); if (!graphic) return { success: false, code: 'NOT_FOUND' }; try { const result = patchCode(graphic.code, value.patches); await this.evaluate(async (json: string) => { const graphic = JSON.parse(json); const r = (window as any).mg.createMotionGraphicRenderer(); try { await r.compile(graphic.code, graphic.assetMap); } finally { r.dispose(); } }, JSON.stringify({ ...graphic, code: result.code })); graphic.code = result.code; return { success: true, patches: result.patches }; } catch (e) { const error = e as any; return { success: false, code: error.code ?? 'COMPILATION_ERROR', message: error.message, details: error.details ?? null }; } }
    // An agent tool on the timeline: the motion-graphic tools through the executor's path (checks, sandbox dry run, then
    // the call), every other tool straight through callTool (an unknown name is its UNKNOWN_TOOL result).
    this.timeline = true;
    const { runtime } = this.editor;
    const result = MOTION_GRAPHIC_TOOLS.has(tool)
      ? await callMotionGraphicTool(runtime.tools, tool, value, { dryRun: (code, assetMap) => this.dryRun(code, assetMap), run: () => this.editor.call(tool, value) })
      : this.editor.call(tool, value);
    return JSON.parse(JSON.stringify(result));
  }
  /** The executor's sandbox dry run (agent/executor.ts sandboxDryRun), in the page; its refusal comes back as the
   *  MotionGraphicError callMotionGraphicTool reports. */
  private async dryRun(code: string, assetMap: Record<string, string>): Promise<void> {
    const error = await this.evaluate(async ({ code, assetMap }: { code: string; assetMap: Record<string, string> }) => {
      const r = (window as any).mg.createMotionGraphicRenderer();
      // Only the renderer's coded errors are refusals; anything else fails the call, as the executor passes it on.
      try { await r.compile(code, assetMap); return null; } catch (e) { const error = e as any; if (typeof error?.code !== 'string') throw e; return { code: error.code, message: String(error.message), details: error.details ?? undefined }; } finally { r.dispose(); }
    }, { code, assetMap });
    if (error) throw new MotionGraphicError(error.code, error.message, error.details);
  }
  async project(): Promise<Json> { return structuredClone(this.timeline ? { ...this.state, document: this.editor.doc } : this.state) as unknown as Json; }
  async frame(timeMs: number): Promise<Frame> {
    const project = this.state;
    const graphics = project.graphics.filter(g => timeMs >= (g.startMs ?? 0) && timeMs < (g.startMs ?? 0) + (g.durationMs ?? 5000)).map(g => ({ ...g, frame: g.frameOverrides?.[String(timeMs)] ?? graphicFrame({ timelineTimeMs: timeMs, clipStartMs: g.startMs ?? 0, trimStartMs: g.trimStartMs ?? 0, designedLengthMs: g.designedLengthMs, fps: project.fps }) }));
    const plan = framePlan(this.editor.doc, timeMs);
    const other = plan.draws.find(d => d.kind !== 'motionGraphic') ?? plan.pending[0];
    if (other) throw Error(`MG adapter draws motion graphics only; item ${'item' in other ? other.item.id : other.itemId} is not one.`);
    // Each timeline graphic gets only the asset URLs its code names (as mg/frames.ts assetMap).
    const draws = plan.draws.map(d => ({ ...d, graphic: { ...d.graphic!, frame: project.itemFrameOverrides?.[d.item.id]?.[String(timeMs)] ?? d.graphic!.frame }, assetMap:Object.fromEntries(assetIds(d.graphic!.code).filter(id => project.assets?.[id] !== undefined).map(id => [id, project.assets![id]])) }));
    // RGBA bytes cross the page boundary as base64 (a 1080×1920 frame as a JSON number array is ~8.3M entries).
    const { width, height, base64 } = await this.evaluate(async (json: string) => {
      const { project, graphics, draws } = JSON.parse(json);
      // renderWithRetry: the rule the app's exact pictures use (mg/errors.ts, through mg/frames.ts graphicPicture), so a
      // render that fails is asked once more unless the failure is static and one load timeout costs an attempt rather
      // than the run (FU-m1). The import is built at run time for the reason the compositor one below is; nothing here is
      // a named function, which esbuild would rewrite to its __name helper, absent in the page.
      // resolve: an id the code does not name as a literal, asked for by the render (mg/frames.ts attachedUrl in the app).
      const { renderWithRetry } = await new Function('p', 'return import(p)')('/src/mg/errors.ts');
      const canvas = document.createElement('canvas'); canvas.width = project.width; canvas.height = project.height; const ctx = canvas.getContext('2d')!;
      for (const g of graphics) {
        const result = await renderWithRetry(() => (window as any).mg.renderMotionGraphic({ code: g.code, frame: g.frame, width: project.width, height: project.height, fps: project.fps, durationInFrames: Math.round((g.durationMs ?? 5000) * project.fps / 1000), fieldValues: g.fieldValues, assetMap: g.assetMap, itemBox: g.itemBox }, async (id: string) => project.assets?.[id]));
        const image = new Image(); image.src = result.image; await image.decode(); ctx.drawImage(image, 0, 0);
      }
      if (draws.length) {
        // As mg/frames.ts renderGraphic: the graphic frame at the item box size (D25), then the compositor places it.
        // The import is built at run time: vite-node (vitest) rewrites a literal import() even inside this page callback.
        const { composite } = await new Function('p', 'return import(p)')('/src/render/compositor.ts'), sources = [];
        for (const d of draws) {
          const g = d.graphic, result = await renderWithRetry(() => (window as any).mg.renderMotionGraphic({ code: g.code, frame: g.frame, width: g.canvas.width, height: g.canvas.height, fps: g.fps, durationInFrames: g.durationInFrames, fieldValues: g.fieldValues, assetMap: d.assetMap, itemSize: { width: d.box.W, height: d.box.H } }, async (id: string) => project.assets?.[id]));
          const image = new Image(); image.src = result.image; await image.decode(); sources.push({ image, width: image.width, height: image.height });
        }
        // composite clears its canvas first, so the timeline is composited apart and drawn over the mg.add graphics.
        const layer = document.createElement('canvas'); layer.width = canvas.width; layer.height = canvas.height;
        composite(layer.getContext('2d')!, draws, sources, { width: canvas.width, height: canvas.height }, 'clear'); ctx.drawImage(layer, 0, 0);
      }
      const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { width: canvas.width, height: canvas.height, base64: btoa(binary) };
    }, JSON.stringify({ project, graphics, draws }));
    const bytes = Buffer.from(base64, 'base64'), rgba = new Float64Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) rgba[i] = bytes[i] / 255;
    return { width, height, rgba };
  }
  async exportMetadata(): Promise<Json> { return { kind: 'motion-graphic-runtime-frames', width: this.state.width, height: this.state.height, fps: this.state.fps }; }
  async close(): Promise<void> { setIdSource(null); await this.browser?.close(); await this.server?.close(); }
}
export function createAdapter(): ParityAdapter { return new MotionGraphicParityAdapter(); }
