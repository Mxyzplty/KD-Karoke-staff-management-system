// SPDX-License-Identifier: AGPL-3.0-only
// Item render model of findings part 5 §53 (export path = reference) as pure functions.
// Project px with y DOWN. A matrix maps item-local px (u right, v down, origin = the
// unscaled box's top-left) to frame px: X = m0·u + m1·v + m4, Y = m2·u + m3·v + m5.
export type Vec = { x: number; y: number };
export type Keyframe = { time: number; value: any; easing?: any; inHandle?: any; outHandle?: any };
export type Prop = { defaultValue?: any; keyframes?: Keyframe[] };
// Stored item (findings (C).md:37): display / trim in ms, playbackRate a number, timeRemap {defaultValue, keyframes[]}.
export type Item = { id: string; type: string; trackId: string; display: { from: number; to: number }; trim?: { from?: number; to?: number }; playbackRate?: number; timeRemap?: Prop | null; sourceDuration?: number; details?: Record<string, any>; properties?: Record<string, Prop>; effects?: any[]; masks?: any[]; [key: string]: any };
// Stored track (part 2 §29): {id, name, kind, muted, solo, locked, hidden, volume, height?}; schema 4 keeps no order (layerOrder does).
export type Track = { id: string; kind?: string; hidden?: boolean; muted?: boolean; solo?: boolean; locked?: boolean; order?: number; [key: string]: any };
export type Entry = { type: 'track' | 'group'; id: string };
export type Project = { fps?: number; size?: { width: number; height: number }; duration?: number; background?: unknown; tracks: Track[]; items: Item[]; layerOrder?: Entry[]; groups?: Record<string, { children?: Entry[]; hidden?: boolean }>; [key: string]: any };
export type Ease = (a: Keyframe, b: Keyframe, p: number) => number;
export type Rect = { x: number; y: number; w: number; h: number };
export type Mat = [number, number, number, number, number, number];
export type Box = { x: number; y: number; W: number; H: number; sx: number; sy: number; rotation: number; skew: number; flipX: boolean; flipY: boolean };
export type Size = { width: number; height: number };
export type EffectRef = { kind: string; params: Record<string, any> };

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const projectSize = (p: Project): Size => ({ width: p.size?.width ?? 1080, height: p.size?.height ?? 1920 });

// ---- keyframes (findings part 2 §38). Only the linear curve is built in; named easings and
// bezier handles (part 2 §40) need an injected Ease.
export const linear: Ease = (a, b, p) => {
  if ((a.easing ?? 'linear') !== 'linear' || a.outHandle || b.inHandle) throw Error(`easing ${JSON.stringify(a.easing)} needs an injected ease function`);
  return p;
};
export function keyframed(keyframes: Keyframe[] | undefined, fallback: any, t: number, ease: Ease = linear): any {
  if (!keyframes?.length) return fallback;
  const k = [...keyframes].sort((a, b) => a.time - b.time), last = k[k.length - 1];
  if (t <= k[0].time) return k[0].value;
  if (t >= last.time) return last.value;
  const i = k.findIndex(f => f.time > t), a = k[i - 1], b = k[i];
  if (t === a.time) return a.value;
  const e = ease(a, b, (t - a.time) / (b.time - a.time));
  return typeof a.value === 'number' && typeof b.value === 'number' ? a.value + (b.value - a.value) * e : a.value;
}
// The keyframes of a stored animatable value {defaultValue, keyframes[]} (findings (C).md:38; keyframe {id, time, value,
// easing}), or none for a missing value. Any other shape (a bare value or a bare array) is not the stored one and throws.
export function keyList(k: any): Keyframe[] | undefined {
  if (k == null) return undefined;
  if (typeof k !== 'object' || Array.isArray(k) || !(k.keyframes === undefined || Array.isArray(k.keyframes))) throw Error(`not a stored {defaultValue, keyframes[]} value: ${JSON.stringify(k)}`);
  return k.keyframes;
}

// ---- clocks: item-local time, property time (part 2 §38), source time (§53.3.1).
const stored = (item: Item, key: string) => { const v = item[key]; if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) throw Error(`item ${item.id}: ${key} ${JSON.stringify(v)} is not a stored number`); return v as number | undefined; };
const rate = (item: Item) => { const r = stored(item, 'playbackRate') ?? 1; return r > 0 ? r : 1; };
export const localTime = (item: Item, t: number) => t - item.display.from;
export const propertyTime = (item: Item, local: number) => (item.trim?.from ?? 0) + local * rate(item);
// item.timeRemap (normalise.v1.json items.*.timeRemap.keyframes): values in source ms, evaluated at item-local time.
export function sourceTime(item: Item, local: number, ease: Ease = linear): number {
  const remap = keyList(item.timeRemap);
  const s = remap?.length ? keyframed(remap, 0, local, ease) : propertyTime(item, local);
  return Math.min(Math.max(s, 0), stored(item, 'sourceDuration') ?? Infinity);
}

// A box or paint field: the property (static or keyframed), then details, then the registry fallback (§53.1.1).
export function field(item: Item, key: string, t: number, fallback: any, ease: Ease = linear): any {
  const p = item.properties?.[key];
  if (p === null) throw Error(`item ${item.id}: property ${key} is null, not a stored {defaultValue, keyframes[]} value`);
  const v = p !== undefined ? keyframed(keyList(p), p.defaultValue, t, ease) : undefined;
  return v ?? item.details?.[key] ?? fallback;
}

// ---- §53.1 box geometry and §53.2.1 effective scale. t = property time.
export function itemBox(project: Project, item: Item, t: number, ease: Ease = linear): Box {
  const { width: Wp, height: Hp } = projectSize(project), caption = item.type === 'caption';
  const f = (key: string, d: any) => field(item, key, t, d, ease), scale = f('scale', 1);
  return {
    x: f('positionX', 0), y: f('positionY', 0),
    W: f('width', caption ? 800 : 0) || Wp, H: f('height', caption ? 100 : 0) || Hp,
    sx: scale !== 1 ? scale : f('scaleX', 1), sy: scale !== 1 ? scale : f('scaleY', 1),
    // The item has no skew property; text animations add σ in the renderer (§53.2.2 step 3, §56.3).
    rotation: f('rotation', 0), skew: 0, flipX: !!f('flipX', false), flipY: !!f('flipY', false),
  };
}

// ---- §53.2.2 box matrix: centre, rotate θ, skew σ, scale (sx·fx, sy·fy), move by (−W/2, −H/2).
export function boxMatrix(b: Box): Mat {
  const r = b.rotation * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), k = Math.tan(b.skew * Math.PI / 180);
  const ax = b.sx * (b.flipX ? -1 : 1), ay = b.sy * (b.flipY ? -1 : 1);
  const cx = b.x + Math.abs(b.W * b.sx) / 2, cy = b.y + Math.abs(b.H * b.sy) / 2;
  const m0 = ax * c, m1 = ay * (k * c - s), m2 = ax * s, m3 = ay * (k * s + c);
  return [m0, m1, m2, m3, cx - m0 * b.W / 2 - m1 * b.H / 2, cy - m2 * b.W / 2 - m3 * b.H / 2];
}
// The frame scale (Wo / Wp, Ho / Hp) applied after the box matrix (§53.8.1 step 3).
export function frameScale(project: Project, out: Size, m: Mat): Mat {
  const p = projectSize(project), kx = out.width / p.width, ky = out.height / p.height;
  return [m[0] * kx, m[1] * kx, m[2] * ky, m[3] * ky, m[4] * kx, m[5] * ky];
}
export const apply = (m: Mat, u: number, v: number): [number, number] => [m[0] * u + m[1] * v + m[4], m[2] * u + m[3] * v + m[5]];
export function invert(m: Mat): Mat {
  const d = m[0] * m[3] - m[1] * m[2];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[1] * m[5] - m[3] * m[4]) / d, (m[2] * m[4] - m[0] * m[5]) / d];
}
export function bounds(m: Mat, W: number, H: number) {
  const p = [apply(m, 0, 0), apply(m, W, 0), apply(m, W, H), apply(m, 0, H)];
  return { x0: Math.min(...p.map(q => q[0])), x1: Math.max(...p.map(q => q[0])), y0: Math.min(...p.map(q => q[1])), y1: Math.max(...p.map(q => q[1])) };
}
// Canvas point → item-local px through the item's transform (§54.2 1.1, createMask); handles use the linear part only.
export const canvasToItem = (b: Box, p: Vec): Vec => { const [x, y] = apply(invert(boxMatrix(b)), p.x, p.y); return { x, y }; };
export const handleToItem = (b: Box, h: Vec): Vec => { const i = invert(boxMatrix(b)); return { x: i[0] * h.x + i[1] * h.y, y: i[2] * h.x + i[3] * h.y }; };

// ---- §53.1.3 placement of new media and the inspector align buttons. Rendered size = natural size × static scale.
export function addMedia(w: number, h: number, Wp: number, Hp: number, mode: 'fit' | 'fill' = 'fit', b?: { x: number; y: number; width?: number; height?: number }) {
  if (b) {
    if (b.width == null && b.height == null) throw Error('bounds need a width or a height');
    const scale = b.width != null && b.height != null ? Math.min(b.width / w, b.height / h) : b.width != null ? b.width / w : b.height! / h;
    return { scale, positionX: b.x, positionY: b.y };
  }
  const scale = (mode === 'fill' ? Math.max : Math.min)(Wp / w, Hp / h);
  return { scale, positionX: (Wp - w * scale) / 2, positionY: (Hp - h * scale) / 2 };
}
export const centreX = (Wp: number, renderedW: number) => (Wp - renderedW) / 2;
export const centreY = (Hp: number, renderedH: number) => (Hp - renderedH) / 2;
export const alignBottom = (Wp: number, Hp: number, renderedW: number) => ({ positionX: centreX(Wp, renderedW), positionY: Math.round(0.7 * Hp) });
export const alignTop = (Wp: number, Hp: number, renderedW: number, renderedH: number) => ({ positionX: centreX(Wp, renderedW), positionY: Math.max(0, Math.round(0.3 * Hp) - renderedH) });

// ---- §53.3 media fitting (rects in item-local px).
export function cover(srcW: number, srcH: number, W: number, H: number): Rect | null {
  if (srcW < 2 || srcH < 2) return null;
  const a = srcW / srcH;
  return a > W / H ? { x: (W - H * a) / 2, y: 0, w: H * a, h: H } : { x: 0, y: (H - W / a) / 2, w: W, h: W / a };
}
export const stretch = (W: number, H: number): Rect => ({ x: 0, y: 0, w: W, h: H });
export const cellRect = (b: { x: number; y: number; width: number; height: number }, W: number, H: number, gap = 0): Rect =>
  ({ x: b.x * W + gap / 2, y: b.y * H + gap / 2, w: b.width * W - gap, h: b.height * H - gap });
export function cellMedia(kind: 'video' | 'image', fillMode: string | undefined, srcW: number, srcH: number, c: Rect, zoom = 100, panX = 0, panY = 0): Rect {
  const z = zoom / 100, a = srcW / srcH, A = c.w / c.h, coverFit = kind === 'image' || fillMode === 'fill';
  const heightLed = coverFit ? a > A : a < A, h = heightLed ? c.h * z : c.w * z / a, w = heightLed ? h * a : c.w * z;
  return { x: c.x + (c.w - w) / 2 + panX / 200 * c.w, y: c.y + (c.h - h) / 2 + panY / 200 * c.h, w, h };
}
export const cellAlpha = (cell: any, opacity: number) => typeof cell.opacity === 'number' ? cell.opacity / 100 * opacity : opacity;
export const cellSourceTime = (cell: any, local: number) => local + (cell.source?.trim?.from ?? 0);
export const EMPTY_CELL: [number, number, number, number] = [1, 1, 1, 0.06];
export const MISSING_MEDIA: [number, number, number, number] = [0x37 / 255, 0x41 / 255, 0x51 / 255, 1];
// Export decoder: the last frame whose timestamp ≤ request + 0.1 ms; before the first frame, the first (§53.3.1).
export function pickFrame(timestampsMs: number[], requestMs: number): number {
  let k = 0;
  for (let i = 0; i < timestampsMs.length; i++) if (timestampsMs[i] <= requestMs + 0.1) k = i;
  return k;
}
// Client-path motion-graphic frame index (§53.3.4), clamped to the captured range.
export const mgClientFrame = (n: number, fromMs: number, fps: number, firstCaptured: number, count: number) =>
  Math.min(Math.max(n - Math.round(fromMs / 1000 * fps) - firstCaptured, 0), count - 1);
// §53.4.3: the canvas fits a uniform corner radius to the box.
export const effectiveRadius = (r: number, W: number, H: number) => Math.min(r, W / 2, H / 2);

// ---- §53.4.1 path choice, part 4 §48.3 points 1–2 (chains). isCss: does this effect kind render as a CSS filter?
// recolor: element data that triggers the hidden recolor pass, put first in the GPU chain (part 4 §49.19).
// Stored effect instance (findings (C).md:65, runtime W3-RT-03; normalise.v1.json items.*.effects.*.parameters.*):
// {id, effectId, enabled, order, parameters: {<key>: {defaultValue, keyframes[]}}}. Any other shape throws.
export function effectKind(e: any): string {
  if (!e || typeof e.effectId !== 'string' || !e.parameters || typeof e.parameters !== 'object' || Array.isArray(e.parameters)) throw Error(`effect ${JSON.stringify(e)}: not a stored effect instance {id, effectId, enabled, order, parameters}`);
  return e.effectId;
}
// enabled false skips the instance; the rest run by ascending order (part 4 §48.3 point 1).
export function effectStack(item: Item): any[] {
  return (item.effects ?? []).map((e, i) => [e, i] as const).filter(([e]) => e.enabled !== false)
    .sort((a, b) => (a[0].order ?? a[1]) - (b[0].order ?? b[1]) || a[1] - b[1]).map(([e]) => e);
}
// Each stored parameter at property time t with the item's keyframe rules (part 4 §48.3 point 2); missing keys take the effect's defaults.
export function effectParams(e: any, t: number, ease: Ease = linear): Record<string, any> {
  effectKind(e);
  return Object.fromEntries(Object.entries(e.parameters).map(([k, v]: [string, any]) => [k, keyframed(keyList(v), v.defaultValue, t, ease)]));
}
export function chains(item: Item, t: number, isCss: (kind: string) => boolean, ease: Ease = linear, recolor: Record<string, any> | null = null) {
  const stack = effectStack(item), ref = (e: any): EffectRef => ({ kind: effectKind(e), params: effectParams(e, t, ease) });
  const media = item.type === 'video' || item.type === 'image';
  const gpu = [...(recolor ? [{ kind: 'recolor', params: recolor }] : []), ...(media ? stack.filter(e => !isCss(effectKind(e))).map(ref) : [])];
  const blur = field(item, 'blur', t, 0, ease), brightness = field(item, 'brightness', t, 1, ease);
  const css: EffectRef[] = [...(blur > 0 ? [{ kind: 'blur', params: { value: blur } }] : []), ...(brightness !== 1 ? [{ kind: 'brightness', params: { value: brightness } }] : []), ...stack.filter(e => isCss(effectKind(e))).map(ref)];
  const masks = (item.masks ?? []).filter(m => m.enabled !== false);
  return { gpu, css, masks, path: gpu.length || css.length || masks.length ? 'effect' as const : 'direct' as const };
}

// ---- §53.5 stacking. Flattened layer list, bottom first, with the repair and legacy rules.
const TRACK_KINDS = ['video', 'audio', 'caption', 'overlay'];
const trackType = (t: Track) => { if (!TRACK_KINDS.includes(t.kind as string)) throw Error(`track ${t.id}: kind ${JSON.stringify(t.kind)} is not a stored track kind (video, audio, caption, overlay; part 2 §29)`); return t.kind; };
export function layerEntries(project: Project): Entry[] {
  const groups = project.groups ?? {};
  if (!project.layerOrder) {
    const byOrder = (list: Track[]) => list.map((t, i) => [t, i] as const).sort((a, b) => (a[0].order ?? a[1]) - (b[0].order ?? b[1]) || a[1] - b[1]).map(([t]) => ({ type: 'track' as const, id: t.id }));
    return [...byOrder(project.tracks.filter(t => trackType(t) !== 'caption')), ...byOrder(project.tracks.filter(t => trackType(t) === 'caption'))];
  }
  const entries = [...project.layerOrder], seen = new Set<string>();
  const holdsCaption = (e: Entry): boolean => { if (e.type === 'group') return (groups[e.id]?.children ?? []).some(holdsCaption); const t = project.tracks.find(x => x.id === e.id); return !!t && trackType(t) === 'caption'; };
  const walk = (list: Entry[]) => list.forEach(e => e.type === 'group' ? walk(groups[e.id]?.children ?? []) : seen.add(e.id));
  walk(entries);
  for (const t of project.tracks) if (!seen.has(t.id)) {
    const e: Entry = { type: 'track', id: t.id }, at = entries.findIndex(holdsCaption);
    if (trackType(t) === 'audio') entries.unshift(e); else if (trackType(t) === 'caption' || at < 0) entries.push(e); else entries.splice(at, 0, e);
  }
  return entries;
}
export function flattenLayers(project: Project): { track: Track; hidden: boolean }[] {
  const tracks = new Map(project.tracks.map(t => [t.id, t])), groups = project.groups ?? {}, out: { track: Track; hidden: boolean }[] = [];
  const walk = (list: Entry[], hidden: boolean) => {
    for (const e of list) {
      if (e.type === 'group') { const g = groups[e.id]; if (g) walk(g.children ?? [], hidden || !!g.hidden); continue; }
      const t = tracks.get(e.id); if (t) out.push({ track: t, hidden: hidden || !!t.hidden });
    }
  };
  walk(layerEntries(project), false);
  return out;
}
// Tracks that draw, bottom first: hidden tracks (or groups) skipped; audio tracks hold no picture. Muted, solo and locked do not matter.
export const drawTracks = (project: Project): Track[] => flattenLayers(project).filter(l => !l.hidden && trackType(l.track) !== 'audio').map(l => l.track);
// Items of one track in draw order: stable sort by display.from (zIndex ignored by the export).
export const trackItems = (project: Project, trackId: string): Item[] => project.items.filter(i => i.trackId === trackId).sort((a, b) => a.display.from - b.display.from);
export const isVisible = (item: Item, t: number) => item.display.from <= t && t < item.display.to;

// ---- §53.8.2 frame range and timing.
export const fpsOf = (p: Project) => p.fps || 30;
export const syncedDuration = (p: Project) => p.items.length ? Math.max(...p.items.map(i => i.display.to)) : 1000;
export const frameTime = (n: number, fps: number) => n / fps * 1000;
export function exportPlan(p: Project, range?: { startS: number; endS: number }) {
  const fps = fpsOf(p);
  if (range) { const first = Math.floor(range.startS * fps); return { fps, first, count: Math.ceil(range.endS * fps) - first, shiftMs: 0 }; }
  const exported = new Set(flattenLayers(p).filter(l => !l.hidden).map(l => l.track.id));
  const starts = p.items.filter(i => exported.has(i.trackId)).map(i => i.display.from);
  const earliest = starts.length ? Math.min(...starts) : 0, shiftMs = earliest > 1 ? earliest : 0;
  return { fps, first: 0, count: Math.ceil(((p.duration ?? 8000) - shiftMs) / 1000 * fps), shiftMs };
}
export type Plan = ReturnType<typeof exportPlan>;
// Export frame n (a frame index of the plan) shows the timeline at this time; its encoded timestamp in s.
export const planTime = (plan: Plan, n: number) => frameTime(n, plan.fps) + plan.shiftMs;
export const encodedTime = (plan: Plan, n: number) => (n - plan.first) / plan.fps;
