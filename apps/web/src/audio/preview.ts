// SPDX-License-Identifier: AGPL-3.0-only
// Preview sound (T13: preview follows the export's rule through Web Audio, an improvement on Xapp's <audio> elements): the
// export's mix and limiter (mix.ts, limiter.ts) rendered CHUNK_MS at a time, at least AHEAD_MS ahead of the context clock,
// each chunk an AudioBufferSourceNode at its place on one mapping (timeline frame F sounds at context time
// base + (F − first) / 48 000). Chunks start on the same absolute grid as the export's, so a preview chunk equals the
// export's samples (the limiter's state aside, which starts at 1 where playback starts). The first chunk is rendered before
// the clock starts (prime) and starts LEAD_MS after it, its first LEAD_MS dropped; a chunk rendered late plays from the
// clock's place in it. The mapping is set once the context runs (a context made for this play may still be starting), and
// while no sound is playing or scheduled it follows the picture's clock (follow: performance.now and the context clock
// drift apart), so a sound that starts later is heard where the picture is. An edit while playing re-renders the chunks
// not yet started. Silent chunks make no node; a chunk that fails is silent. Keep-pitch clips carry their chain from one
// chunk to the next (mix.ts `chains`), so a chunk does not replay it from the restart.
// Provisional, not Xapp parity: CHUNK_MS, AHEAD_MS, LEAD_MS, HOLD_MS; the output latency is not compensated.
import type { ProjectDocument } from '../store/model';
import { Limiter } from './limiter';
import { MIX_RATE, PER_MS, mixFrames } from './mix';
import type { AudioSource } from './mix';
import type { Chain } from './stretch';

export const CHUNK_MS = 250, AHEAD_MS = 1000, LEAD_MS = 20, HOLD_MS = 10_000;
const N = CHUNK_MS * PER_MS;
/** One rendered chunk: timeline frames [frame, frame + frames) (frames = N but at the end), sounding from context
 *  seconds `when`; buffer null when silent; g: the limiter's gain after it. */
type Chunk = { k: number; frame: number; frames: number; buffer: AudioBuffer | null; g: number; node: AudioBufferSourceNode | null; when: number };
export type PreviewHooks = { sound?: (itemId: string) => void; buffer?: () => void; late?: () => void; failed?: () => void };

export class PreviewAudio {
  private first = 0;
  private begun: number | null = null; // performance.now() when the clock started (null before)
  private base: number | null = null; // context seconds of frame `first` (null until the context runs after the start)
  private chunks: Chunk[] = [];
  private heardEnd = -Infinity; // context seconds at which the latest forgotten chunk with sound ended
  private rendering: Promise<void> | null = null;
  private doc: ProjectDocument | null = null;
  private stopped = false;
  private readonly limiter = new Limiter(MIX_RATE);
  private readonly chains = new Map<string, Chain>();
  private readonly source: AudioSource;
  constructor(private readonly ctx: AudioContext, source: AudioSource, private readonly live: () => ProjectDocument, private readonly hooks: PreviewHooks = {}) {
    // The clips whose sound the mix read (playbackStats.sounds).
    this.source = (item, a, b) => source(item, a, b).then(pcm => { if (pcm) hooks.sound?.(item.id); return pcm; });
  }
  /** Renders the first chunk from timeline ms t (the clock has not started); resolves once it is ready. */
  prime(t: number): Promise<void> {
    if (this.begun === null && !this.chunks.length && !this.rendering) { this.first = Math.round(t * PER_MS); this.limiter.reset(); }
    this.pump();
    return this.rendering ?? Promise.resolve();
  }
  get primed() { return this.chunks.length > 0; }
  /** The clock starts at timeline ms t (= frame `first`). */
  begin() {
    this.begun = performance.now();
    this.pump();
  }
  /** The mapping is fixed once the context runs (a context made for this play is still starting): frame `first` at the
   *  context time the clock started, counted back from now by the time since, on the context's frame grid (Chromium
   *  interpolates a buffer started between frames, and performance.now() steps by 0.1 ms = 4.8 frames). */
  private settle() {
    if (this.base !== null || this.begun === null || this.ctx.state !== 'running') return;
    this.base = Math.round((this.ctx.currentTime - (performance.now() - this.begun) / 1000) * MIX_RATE) / MIX_RATE;
    for (const c of this.chunks) this.schedule(c);
  }
  /** The picture's clock is at timeline ms t: while no sound is playing or scheduled, the mapping moves to put frame t at
   *  the context's now, rounded to a frame so the mapping stays on the grid (a node already made keeps its place, so
   *  chunks stay joined). */
  follow(t: number) {
    if (this.base === null || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (this.chunks.some(c => c.node && c.when + c.frames / MIX_RATE > now)) return;
    this.base = now - (Math.round(t * PER_MS) - this.first) / MIX_RATE;
    for (const c of this.chunks) if (!c.node) c.when = this.base + (c.frame - this.first) / MIX_RATE;
  }
  /** Called on every animation frame while playing: re-renders after an edit, renders ahead. */
  pump() {
    if (this.stopped) return;
    this.settle();
    if (this.rendering) return;
    const doc = this.live(), now = this.base === null ? null : this.ctx.currentTime;
    if (this.doc && doc !== this.doc) this.rewind();
    if (now !== null) this.forget(now);
    const end = Math.round((doc.duration ?? 0) * PER_MS), k = this.chunks.length ? this.chunks[this.chunks.length - 1].k + 1 : 0, frame = this.first + k * N;
    if (frame >= end) return;
    if (now !== null && this.base! + k * N / MIX_RATE > now + AHEAD_MS / 1000) return;
    if (now === null && k > 0) return; // before the mapping is fixed only the first chunk is rendered
    this.doc = doc;
    const n = Math.min(N, end - frame);
    this.rendering = this.render(doc, k, frame, n)
      .catch(() => { this.hooks.failed?.(); this.chunks.push({ k, frame, frames: n, buffer: null, g: this.limiter.g, node: null, when: NaN }); }) // skipped, silent
      .finally(() => { this.rendering = null; this.pump(); });
  }
  /** Drops the chunks that have finished playing, but the latest (its limiter gain and index carry on). */
  private forget(now: number) {
    let i = 0;
    for (; i < this.chunks.length - 1; i++) {
      const c = this.chunks[i], ends = c.when + c.frames / MIX_RATE;
      if (!(ends <= now)) break;
      if (c.node) { this.heardEnd = Math.max(this.heardEnd, ends); c.node.disconnect(); }
    }
    if (i) this.chunks.splice(0, i);
  }
  private async render(doc: ProjectDocument, k: number, frame: number, n: number) {
    const prev = this.chunks[this.chunks.length - 1];
    this.limiter.g = prev ? prev.g : 1;
    const [L, R] = await mixFrames(doc, frame, n + this.limiter.look, { source: this.source, end: frame + n, chains: this.chains });
    if (this.stopped || doc !== this.live()) return; // stopped, or edited while rendering: pump renders it again
    this.limiter.process(L, R, n);
    let loud = false;
    for (let i = 0; i < n && !loud; i++) loud = L[i] !== 0 || R[i] !== 0;
    let buffer: AudioBuffer | null = null;
    if (loud) {
      buffer = this.ctx.createBuffer(2, n, MIX_RATE);
      buffer.copyToChannel(L.subarray(0, n) as Float32Array<ArrayBuffer>, 0); buffer.copyToChannel(R.subarray(0, n) as Float32Array<ArrayBuffer>, 1);
      this.hooks.buffer?.();
    }
    const chunk: Chunk = { k, frame, frames: n, buffer, g: this.limiter.g, node: null, when: NaN };
    this.chunks.push(chunk);
    if (this.base !== null) this.schedule(chunk);
  }
  private schedule(c: Chunk) {
    c.when = this.base! + (c.frame - this.first) / MIX_RATE;
    if (!c.buffer || c.node) return;
    const lead = c.k === 0 ? LEAD_MS / 1000 : 0, now = this.ctx.currentTime, at = Math.max(c.when + lead, now), offset = at - c.when;
    if (offset >= c.buffer.duration) { this.hooks.late?.(); return; }
    if (offset > lead + 1e-6) this.hooks.late?.();
    const node = this.ctx.createBufferSource();
    node.buffer = c.buffer; node.connect(this.ctx.destination); node.start(at, offset);
    c.node = node;
  }
  /** Drops the chunks not yet started (an edit): they render again from the live document. */
  private rewind() {
    const now = this.base === null ? -Infinity : this.ctx.currentTime;
    this.chains.clear(); // the edited clips' chains are kept under their old keys: drop them
    const keep = this.chunks.findIndex(c => this.base === null || c.when > now);
    if (keep < 0) return;
    for (const c of this.chunks.splice(keep)) stopNode(c.node);
  }
  /** Audible at context seconds `now`: a chunk with sound has started and the latest started one ended under HOLD_MS ago. */
  audible(): boolean {
    if (this.base === null || this.ctx.state !== 'running') return false;
    const now = this.ctx.currentTime;
    let end = this.heardEnd;
    for (const c of this.chunks) if (c.node && c.when <= now) end = Math.max(end, c.when + c.frames / MIX_RATE);
    return now < end + HOLD_MS / 1000;
  }
  /** Stops every node; the scheduler is not used again. */
  stop() {
    this.stopped = true;
    for (const c of this.chunks) stopNode(c.node);
    this.chunks = [];
  }
}
function stopNode(node: AudioBufferSourceNode | null) {
  if (!node) return;
  try { node.stop(); } catch { /* not started */ }
  node.disconnect();
}
