// SPDX-License-Identifier: AGPL-3.0-only
// T21 First Edit beat plan (§28b.3.2), computed in the browser from the pack's rhythm records. Pure, so the goldens run
// without one. Times are milliseconds unless a field says otherwise; rhythm records and song segments keep their seconds.
export type Beat = number | [number, number] | { time?: number; t?: number; strength?: number; s?: number };
/** Both name pairs are read (§28b.2.4): a record may carry only `pulseBeats` / `averageBpm`. */
export type RhythmData = { beats?: Beat[]; bpm?: number | null; pulseBeats?: Beat[]; averageBpm?: number | null; onsets?: Beat[] };
export type SongSegment = { start_time: number; label?: string; description?: string };
export type DemoAsset = { id: string; type: string; name: string; durationMs: number; rhythm_data?: RhythmData; segments?: SongSegment[] };
export type Analysis = { beats: number[]; interval: number; bpm: number | null; end: number; drop: number };
export type Cut = { assetId: string; trimStart: number; trimEnd: number };
export type Plan = { music?: DemoAsset; analysis: Analysis; boundaries: number[]; cuts: Cut[]; skipped: number; sourceEnd: number };

const SCENIC = ['mountain', 'looking', 'hiking', 'silhouette', 'aerial'], PATTERN = [1, 1, 2, 1, 1, 4];
const MAX_SEGMENTS = 28, MIN_GAP_MS = 200, WINDOW_MS = 20_000, CLIP_MARGIN_MS = 80, SLOWMO_BEATS = 1.8;
/** No usable analysis: a beat every 500 ms from 0 to 20 s, the drop at 8 s and no BPM to show. */
export const SYNTHETIC: Analysis = { beats: Array.from({ length: 41 }, (_, n) => n * 500), interval: 500, bpm: null, end: 20_500, drop: 8_000 };

const beatList = (r?: RhythmData) => r?.beats?.length ? r.beats : r?.pulseBeats ?? [];
/** A number, a [time, strength] pair, or an object with time/t and strength/s. Times stay in seconds. */
function entries(list: Beat[]) {
  return list.map(b => typeof b === 'number' ? { time: b, strength: 0 } : Array.isArray(b) ? { time: b[0], strength: b[1] ?? 0 } : { time: b.time ?? b.t, strength: b.strength ?? b.s ?? 0 })
    .filter((b): b is { time: number; strength: number } => typeof b.time === 'number' && Number.isFinite(b.time) && b.time >= 0).sort((a, b) => a.time - b.time);
}
export function pickMusic(assets: DemoAsset[]) {
  const audio = assets.filter(a => a.type === 'audio'), beaten = audio.filter(a => beatList(a.rhythm_data).length);
  return beaten.find(a => a.name.toLowerCase().includes('fever')) ?? beaten[0] ?? audio[0];
}
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** Null with fewer than 8 beats. */
export function analyse(music: Pick<DemoAsset, 'rhythm_data' | 'segments'>): Analysis | null {
  const rhythm = music.rhythm_data, beats = entries(beatList(rhythm)).map(b => Math.round(b.time * 1000));
  if (beats.length < 8) return null;
  const known = [rhythm?.bpm, rhythm?.averageBpm].find((v): v is number => typeof v === 'number' && v > 0) ?? null;
  const gaps = beats.slice(1).map((b, n) => b - beats[n]).filter(g => g > 0), interval = gaps.length ? median(gaps) : known ? 60_000 / known : 500;
  const end = beats[beats.length - 1] + interval;
  return { beats, interval, bpm: known ?? 60_000 / interval, end, drop: dropOf(music, beats, end) };
}
function dropOf(music: Pick<DemoAsset, 'rhythm_data' | 'segments'>, beats: number[], end: number) {
  const named = (music.segments ?? []).filter(s => s.start_time > 0 && /drop/i.test(`${s.label ?? ''} ${s.description ?? ''}`)).sort((a, b) => a.start_time - b.start_time)[0];
  if (named) return Math.round(named.start_time * 1000);
  const strongest = entries(music.rhythm_data?.onsets ?? []).filter(o => o.time * 1000 >= end * .25 && o.time * 1000 <= end * .8).reduce<{ time: number; strength: number } | undefined>((best, o) => !best || o.strength > best.strength ? o : best, undefined);
  if (strongest) return Math.round(strongest.time * 1000);
  return beats.find(b => b >= end * .4) ?? beats[beats.length >> 1];
}
/** The cut boundaries in the song's own time, so the timeline and the music share a clock; the first boundary is always 0. */
export function cutBoundaries({ beats, interval, drop, end }: Analysis) {
  const at = (index: number) => index === 0 ? 0 : beats[index];
  const dropIndex = beats.reduce((best, b, n) => Math.abs(b - drop) < Math.abs(beats[best] - drop) ? n : best, 0), introEnd = Math.max(0, dropIndex - 4);
  const indices = [0];
  let i = 0;
  for (let n = 0; n < 2 && i + 4 <= introEnd; n++) indices.push(i += 4);
  while (i + 2 <= introEnd) indices.push(i += 2);
  if (i < introEnd) { if (indices.length > 1) indices[indices.length - 1] = introEnd; else indices.push(introEnd); }
  const intro = indices.length - 1;
  for (let n = introEnd + 1; n <= dropIndex; n++) indices.push(n);
  const times = indices.map(at), windowEnd = Math.min(WINDOW_MS + interval, end), afterDrop = times.length - 1;
  for (let step = 0, n = dropIndex; times.length - 1 < MAX_SEGMENTS; step++) {
    n += PATTERN[step % PATTERN.length];
    if (n >= beats.length || beats[n] > windowEnd) break;
    if (beats[n] - times[times.length - 1] >= MIN_GAP_MS) times.push(beats[n]);
  }
  return { times, intro, afterDrop };
}
/** Pools come from the file names: at least one video must have a duration. */
export function clipPools(assets: DemoAsset[]) {
  const videos = assets.filter(a => a.type === 'video' && a.durationMs > 0), has = (a: DemoAsset, words: string[]) => words.some(w => a.name.toLowerCase().includes(w));
  const named = videos.filter(a => has(a, SCENIC)), longest = [...videos].sort((a, b) => b.durationMs - a.durationMs).slice(0, Math.ceil(videos.length / 2));
  const scenic = named.length ? named : longest, others = videos.filter(a => !scenic.includes(a));
  return { videos, scenic, action: others.length ? others : videos, slowmo: videos.filter(a => has(a, ['slowmo'])) };
}
function cutsFor(assets: DemoAsset[], { times, intro, afterDrop }: ReturnType<typeof cutBoundaries>, { beats, interval }: Analysis) {
  const { videos, scenic, action, slowmo } = clipPools(assets), rounds = new Map<DemoAsset[], number>(), reads = new Map<string, number>(), cuts: Cut[] = [], boundaries = [0];
  let last: string | undefined, skipped = 0, at = 0;
  /** After a skip the cuts move up, so each end is the beat nearest the planned length, at least MIN_GAP_MS on. */
  const onBeat = (ms: number) => beats.filter(b => b - at >= MIN_GAP_MS).reduce((best, b) => Math.abs(b - ms) < Math.abs(best - ms) ? b : best, Infinity);
  const pick = (pool: DemoAsset[], need: number) => {
    const start = rounds.get(pool) ?? 0;
    for (const repeat of [false, true]) for (let n = 0; n < pool.length; n++) {
      const clip = pool[(start + n) % pool.length];
      if (clip.durationMs >= need && (repeat || pool.length === 1 || clip.id !== last)) { rounds.set(pool, (start + n + 1) % pool.length); return clip; }
    }
    return [...videos].sort((a, b) => b.durationMs - a.durationMs).find(c => c.durationMs >= need);
  };
  for (let n = 0; n + 1 < times.length; n++) {
    const end = skipped ? onBeat(at + times[n + 1] - times[n]) : times[n + 1], length = end - at, pool = n < intro ? scenic : n >= afterDrop && length / interval >= SLOWMO_BEATS && slowmo.length ? slowmo : action;
    const clip = pick(pool, length + CLIP_MARGIN_MS);
    if (!clip) { skipped++; continue; }
    const read = reads.get(clip.id) ?? 0, from = clip.durationMs - read >= length + CLIP_MARGIN_MS ? read : 0;
    cuts.push({ assetId: clip.id, trimStart: from, trimEnd: from + length }); reads.set(clip.id, from + length); last = clip.id;
    boundaries.push(end); at = end;
  }
  return { cuts, skipped, boundaries };
}
/** Always a plan: `cuts` is empty when there is no video or no boundary to cut on, and step 1 still has its source range. */
export function buildPlan(assets: DemoAsset[]): Plan {
  const music = pickMusic(assets), analysis = (music && analyse(music)) || SYNTHETIC, planned = cutBoundaries(analysis), times = planned.times;
  const usable = times.length >= 2 && clipPools(assets).videos.length > 0, { cuts, skipped, boundaries: packed } = usable ? cutsFor(assets, planned, analysis) : { cuts: [], skipped: 0, boundaries: times };
  const boundaries = cuts.length ? packed : times;
  return { music, analysis, boundaries, cuts, skipped, sourceEnd: boundaries.length >= 2 ? boundaries[boundaries.length - 1] : analysis.end };
}
export const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
