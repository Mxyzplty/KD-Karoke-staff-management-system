// SPDX-License-Identifier: AGPL-3.0-only
// Default wiring of the frame renderer: the effect registry, transition pairs from the project's
// transition records (part 5 §55) and a fixture-store media source decoded with ffmpeg.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createImage, type Image } from './image';
import { pickFrame, type Item, type Project } from './item';
import type { Deps, TransitionDraw } from './render';
import { effects, cssFilters } from './effects';
import { chainParts, meets, progressAt, transitionWindow, transitions, windowParts, type TransitionRecord } from './transitions';

const span = (i: Item) => ({ trackId: i.trackId, type: i.type, startMs: i.display.from, endMs: i.display.to });
const find = (p: Project, id: string) => { const i = p.items.find(x => x.id === id); if (!i) throw Error(`Transition references missing item ${id}`); return i; };

// §55.2 window of one record; a clip carrying a transition at both ends shares its length (chainParts).
export function recordWindow(project: Project, r: TransitionRecord) {
  const records = (project.transitions ?? []) as TransitionRecord[], parts = windowParts(r.durationMs, r.alignment);
  const outgoing = find(project, r.fromId), incoming = find(project, r.toId), length = (i: Item) => i.display.to - i.display.from;
  const before = records.find(q => q.toId === r.fromId), after = records.find(q => q.fromId === r.toId);
  if (before) parts.preMs = chainParts(length(outgoing), windowParts(before.durationMs, before.alignment).postMs, parts.preMs)[1];
  if (after) parts.postMs = chainParts(length(incoming), parts.postMs, windowParts(after.durationMs, after.alignment).preMs)[0];
  return transitionWindow(incoming.display.from, r.durationMs, r.alignment, project.fps || 30, parts);
}

// §55.3–§55.4: inside the window both clips render (extended past their own range: sourceTime keeps
// playing handles, then clamps = freezes) onto transparent canvases; the kind combines them.
export function transitionPairs(project: Project, timeMs: number, renderLayer: (item: Item, timeMs: number) => Image): TransitionDraw[] {
  const draws: TransitionDraw[] = [];
  for (const r of (project.transitions ?? []) as TransitionRecord[]) {
    const outgoing = find(project, r.fromId), incoming = find(project, r.toId);
    if (!meets(span(outgoing), span(incoming))) throw Error(`Transition ${r.id} does not join two adjacent video/image clips`);
    const p = progressAt(timeMs, recordWindow(project, r));
    if (p === null) continue;
    const combine = transitions[r.kind];
    if (!combine) throw Error(`Transition kind ${r.kind}: no implementation`);
    draws.push({ itemIds: [outgoing.id, incoming.id], image: combine(renderLayer(outgoing, timeMs), renderLayer(incoming, timeMs), p, { ...r.params, direction: r.direction }) });
  }
  return draws;
}

// §53.3.1 source size = the decoded frame's display size, rounded to whole px: the rotation
// side data turns it (±90° swaps the sides) and display width = coded width × SAR.
export function displaySize(stream: { width: number; height: number; sample_aspect_ratio?: string; side_data_list?: { rotation?: number }[] }) {
  const [n, d] = (stream.sample_aspect_ratio ?? '1:1').split(':').map(Number), sar = n > 0 && d > 0 ? n / d : 1;
  const rotation = stream.side_data_list?.find(s => typeof s.rotation === 'number')?.rotation ?? 0;
  if (rotation % 90 !== 0) throw Error(`Rotation ${rotation}° is not a multiple of 90°`);
  const width = Math.round(stream.width * sar), height = stream.height, quarter = Math.abs(rotation / 90) % 2 === 1;
  return { width: quarter ? height : width, height: quarter ? width : height, sar, rotation };
}

// Media from the fixture store (`fixture://<store-relative path>`), decoded by ffmpeg to RGBA.
// The frame shown is the export decoder's pick (§53.3.1): the last frame whose timestamp is at or
// before the request + 0.1 ms. ffmpeg applies the rotation itself (autorotate); a non-square SAR is
// resampled to the display width bilinearly (the browser's resampler is not specified: open point).
// Browser YUV→RGB conversion can differ from ffmpeg's by a few codes, so a comparison with a
// browser export uses inputs decoded the same way.
export function fixtureSource(store = process.env.CUTFRAME_FIXTURES): Deps['source'] {
  if (!store) throw Error('CUTFRAME_FIXTURES must name the fixture store');
  const probe = new Map<string, { width: number; height: number; sar: number; timestampsMs: number[] }>();
  const resolve = (item: Item) => {
    const src = String(item.details?.src ?? '');
    if (!src.startsWith('fixture://')) throw Error(`Item ${item.id}: only fixture:// sources are supported`);
    const relative = src.slice('fixture://'.length);
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error(`Unsafe fixture source: ${src}`);
    return path.join(store, relative);
  };
  return (item, sourceTimeMs) => {
    const file = resolve(item);
    if (!probe.has(file)) {
      const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio:stream_side_data=rotation:frame=best_effort_timestamp_time', '-of', 'json', file], { maxBuffer: 1 << 28 }).toString();
      const json = JSON.parse(out);
      probe.set(file, { ...displaySize(json.streams[0]), timestampsMs: (json.frames ?? []).map((f: any) => Number(f.best_effort_timestamp_time) * 1000) });
    }
    const { width, height, sar, timestampsMs } = probe.get(file)!;
    const index = timestampsMs.length > 1 ? pickFrame(timestampsMs, sourceTimeMs) : 0;
    const filter = `select=eq(n\\,${index})` + (sar !== 1 ? `,scale=${width}:${height}:flags=bilinear,setsar=1` : '');
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 28 });
    if (raw.length !== width * height * 4) throw Error(`Decoded frame of ${file} has the wrong size`);
    const image = createImage(width, height);
    for (let i = 0; i < raw.length; i++) image.data[i] = raw[i] / 255;
    return image;
  };
}

// Everything renderFrame needs except text/shape rasters (owned by T05/T06/T09) and raster masks (T12).
export const oracleDeps = (source: Deps['source'], extra: Partial<Deps> = {}): Deps => ({ effects, cssFilters, source, transition: transitionPairs, ...extra });
