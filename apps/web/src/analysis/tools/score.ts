// SPDX-License-Identifier: AGPL-3.0-only
/** Local acceptance runner. It never downloads or reads a private reference by default. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { verifyFixtures, sha256 } from '../../../../../parity/fixtures';
import { AnalysisEngine, syncOffset, snapCuts, planSilenceRemoval, wordsOf, type Pcm, type Frame, type Transcript, type TranscriptionResult, type VisualAnalysis, type SearchResponse, type BeatAnalysis, type Word } from '../engine';
import { detectBeats } from '../beats';
import { median } from '../audio';
import { wordAlignment, normalizedWer, timingScore, speakerAgreement, beatScore, MIN_SPEAKER_CUES, ASR_CONDITIONS, asrTotals, asrSummary, asrVerdict, rejudgeAsrRow, type AsrCondition, type AsrSummary } from './metrics';
import { MODEL_IDS } from '../models';
import { FootageIndex, SEARCH_THRESHOLDS, VISUAL_THRESHOLD, visualCalibration } from '../search';
import { cosine, resample } from '../audio';

const flags = process.argv.slice(2), option = (name: string, fallback?: string) => { const i = flags.indexOf(name); return i < 0 ? fallback : flags[i + 1]; };
const store = process.env.CUTFRAME_FIXTURES, part = option('--part', 'all')!, output = path.resolve(option('--output', 'parity-reports/t19a')!);
const command = `npx tsx apps/web/src/analysis/tools/score.ts ${flags.join(' ')}`.trim();
const json = async <T = any>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8'));
type Row = { item: string; measured: unknown; gate: string; status: 'pass' | 'fail' | 'uncompared'; command: string };
const rows: Row[] = [], rtf: { engine: string; file: string; seconds: number; mediaSeconds: number; rtf: number }[] = [];
async function save(name: string, value: unknown) { await mkdir(output, { recursive: true }); await writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n'); }
function row(item: string, measured: unknown, gate: string, pass: boolean | null) { const result: Row = { item, measured, gate, status: pass === null ? 'uncompared' : pass ? 'pass' : 'fail', command }; rows.push(result); console.log(JSON.stringify(result)); }
async function timed<T>(engine: string, file: string, duration: number, run: () => Promise<T>): Promise<T> {
  const start = performance.now(), value = await run(), seconds = (performance.now() - start) / 1000;
  rtf.push({ engine, file, seconds, mediaSeconds: duration, rtf: seconds / duration }); return value;
}
/** Independent fixture decoder for Node scoring; browser-check uses T14 decoders. `native` keeps the
 * file's sample rate, as production passes it to beat detection (review m2). */
function pcm(file: string, native = false, range?: [start: number, seconds: number]): Pcm {
  const sampleRate = native ? Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'json', file], { encoding: 'utf8' })).streams[0].sample_rate) : 16000;
  const bytes = execFileSync('ffmpeg', ['-v', 'error', ...(range ? ['-ss', String(range[0]), '-t', String(range[1])] : []), '-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'], { maxBuffer: 512 * 1024 * 1024 });
  const data = new Float32Array(bytes.length / 4);
  for (let i = 0; i < data.length; i++) data[i] = bytes.readFloatLE(i * 4);
  return { sampleRate, channels: 1, data: [data] };
}
const lengthOf = (audio: Pcm) => audio.data[0].length / audio.sampleRate;
function frames(file: string, duration: number): Frame[] {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8' })).streams[0];
  const result: Frame[] = [];
  for (let t = 0.5; t < duration; t += 2) {
    const data = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });
    result.push({ timestamp: t, width: probe.width, height: probe.height, data: new Uint8ClampedArray(data) });
  }
  return result;
}
/** Only the rows the engine actually loads: a row kept as the record of a rejected attempt is not a dependency,
 * nor is a row only the Groove validation loads (T19q B4's held-out BeatThis folds; checked there by id). */
const VALIDATION_ONLY = ['T19a-beat-this-cv'];
const wiredModel = (m: any) => !VALIDATION_ONLY.includes(m.id) && m.files?.some((f: any) => Object.values(MODEL_IDS).some(id => String(f.path).includes(id)));
async function verifyModels(root: string, only?: string) {
  const manifest = await json('datasets/manifest.json'), selected = manifest.models.filter((m: any) => only ? m.id === only : m.id?.startsWith('T19a-') && wiredModel(m));
  if (only && !selected.length) throw Error(`Register ${only} before use`);
  for (const model of selected) for (const f of model.files) {
    const file = path.join(root, f.path.replace(/^models\/t19a\//, ''));
    if ((await stat(file)).size !== f.bytes || await sha256(file) !== f.sha256) throw Error(`T19a model mismatch: ${f.path}`);
  }
}
const clips = ['tos-speech-45s', 'tos-action-30s', 'tos-credits-music-40s'];
const transcripts = new Map<string, TranscriptionResult>();
let engine: AnalysisEngine;
const musicBeats = (audio: Pcm, name?: string) => engine.musicBeats(audio, name);
async function getTranscript(clip: string) {
  let result = transcripts.get(clip);
  // No language is passed: the engine detects it, so TR-P05 measures detection (review m7).
  if (!result) { const audio = pcm(path.join(store!, 'corpus', clip + '.mp4')); result = await timed('transcription', clip, lengthOf(audio), () => engine.transcribe(audio)); transcripts.set(clip, result); await save(clip + '-transcript.json', result); }
  return result;
}
/** TR-P06 dialogue cut (Q1): public Tears of Steel 05:54-07:13, labelled by T00's OT-2/OT-1 code unchanged and
 * frozen 2 Nov 06:02, before any diarization candidate ran on it. Registered as manifest row T19-dialogue-cut.
 * Reported, not gated (D28). */
const DIALOGUE = 'tos-dialogue-79s', DIALOGUE_DIR = 'datasets/t19/dialogue';
const DIALOGUE_GATE = 'report-only (D28): one-to-one agreement over the frozen OT-1 consensus of the dialogue cut';
const POOLED_DIALOGUE_GATE = 'report-only (D28): one-to-one agreement over the two corpus clips and the dialogue cut';
/** D28: a per-clip TR-P06 row below the cue floor is reported, not gated; at or above it the gate is >= .90. */
const PER_CLIP_SPEAKER_GATE = `>=.90 one-to-one agreement over scorable reference units; below ${MIN_SPEAKER_CUES} scorable cues: reported, not gated (D28)`;
const perClipSpeakers = (scored: { agreement: number; evidenced: boolean }) => scored.evidenced ? scored.agreement >= 0.9 : null;
type SpeakerCounts = { correct: number; units: number; scorableCues: number };
/** Labels are per clip, so pooling sums each clip's best permutation. */
function pool(scores: SpeakerCounts[]) {
  const pooled = { correct: scores.reduce((s, v) => s + v.correct, 0), units: scores.reduce((s, v) => s + v.units, 0), scorableCues: scores.reduce((s, v) => s + v.scorableCues, 0) };
  return { ...pooled, agreement: pooled.units ? pooled.correct / pooled.units : 0, evidenced: pooled.scorableCues >= MIN_SPEAKER_CUES };
}
async function dialogueSpeakers(): Promise<SpeakerCounts> {
  const entry = (await json('datasets/manifest.json')).datasets.find((d: any) => d.id === 'T19-dialogue-cut');
  if (!entry) throw Error('Manifest row T19-dialogue-cut is missing');
  for (const f of entry.files) {
    const file = path.join(store!, f.path), bytes = await stat(file).then(s => s.size, () => null);
    if (bytes === null) throw Error(`Dialogue cut file missing from the fixture store: ${f.path}`);
    if (bytes !== f.bytes || await sha256(file) !== f.sha256) throw Error(`Dialogue cut file differs from its frozen hash: ${f.path}`);
  }
  const dir = path.join(store!, DIALOGUE_DIR), audio = pcm(path.join(dir, DIALOGUE + '.mp4')), result = await timed('transcription', DIALOGUE, lengthOf(audio), () => engine.transcribe(audio));
  await save(DIALOGUE + '-transcript.json', result);
  if (result.status !== 'complete') throw Error(`Speech was skipped: ${DIALOGUE}`);
  const truth = await json(path.join(dir, DIALOGUE + '-aligned.json')), consensus = await json(path.join(dir, DIALOGUE + '-consensus.json'));
  const scored = speakerAgreement(consensus.intervals, result.transcript, truth.utterances.map((u: any) => ({ startMs: u.subtitleMs[0], endMs: u.subtitleMs[1] })));
  row(`TR-P06 ${DIALOGUE}`, scored, DIALOGUE_GATE, null);
  return scored;
}
/** "TR-P06 pooled incl. dialogue cut" (Q1, Q7): per-clip best permutations summed, as in TR-P06 combined. */
function pooledWithDialogue(scores: SpeakerCounts[]) {
  row('TR-P06 pooled incl. dialogue cut', pool(scores), POOLED_DIALOGUE_GATE, null);
}
/** The dialogue rows in their own guard: a missing or changed dialogue file is reported in both rows, naming the cause. */
async function guardedDialogueRows(corpus: SpeakerCounts[]) {
  let dialogue: SpeakerCounts;
  try { dialogue = await dialogueSpeakers(); } catch (error) {
    const cause = (error as Error).message;
    row(`TR-P06 ${DIALOGUE}`, { error: cause }, DIALOGUE_GATE, null);
    row('TR-P06 pooled incl. dialogue cut', { error: `no dialogue cut score: ${cause}` }, POOLED_DIALOGUE_GATE, null);
    return;
  }
  pooledWithDialogue([...corpus, dialogue]);
}
/** The dialogue rows alone, pooled with the corpus TR-P06 rows of `--pool <report.json>` (same code state). */
async function dialogueChecks() {
  const report = option('--pool');
  if (!report) throw Error('--pool <report.json> names the run whose corpus TR-P06 rows are pooled');
  const rows = (await json<{ rows: Row[] }>(report)).rows, corpus = clips.slice(0, 2).map(clip => rows.find(r => r.item === `TR-P06 ${clip}`)!.measured as SpeakerCounts);
  await guardedDialogueRows(corpus);
}
/** One meeting's AMI manual word times (CC BY 4.0) and T19's window rule (T19 notes, 13:24:11): 120 s windows starting
 * every 60 s; a window qualifies with >= 10 speaker changes among held (non-overlapped) word units and >= 10 held
 * cues. Returns the first `count` qualifying windows that do not overlap. */
async function amiExcerpts(root: string, files: string[], count: number) {
  const attr = (tag: string, name: string) => Number(tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]);
  const units: { startMs: number; endMs: number; speaker: string; scorable: boolean }[] = [], cues: { startMs: number; endMs: number }[] = [];
  for (const file of files.filter(f => f.endsWith('.words.xml'))) for (const [tag] of (await readFile(path.join(root, file), 'utf8')).matchAll(/<w\b[^>]*>/g)) {
    const start = attr(tag, 'starttime'), end = attr(tag, 'endtime');
    if (!/\bpunc="true"/.test(tag) && end > start) units.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), speaker: path.basename(file).split('.')[1], scorable: true });
  }
  for (const file of files.filter(f => f.endsWith('.segments.xml'))) for (const [tag] of (await readFile(path.join(root, file), 'utf8')).matchAll(/<segment\b[^>]*>/g)) {
    const start = attr(tag, 'transcriber_start'), end = attr(tag, 'transcriber_end');
    if (end > start) cues.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
  }
  // A unit overlapping another speaker's unit is not scorable.
  units.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length && units[j].startMs < units[i].endMs; j++) if (units[j].speaker !== units[i].speaker) units[i].scorable = units[j].scorable = false;
  const window = (from: number) => {
    const shift = <T extends { startMs: number; endMs: number }>(s: T) => ({ ...s, startMs: s.startMs - from * 1000, endMs: s.endMs - from * 1000 });
    const reference = units.filter(u => u.startMs >= from * 1000 && u.endMs <= (from + 120) * 1000).map(shift), held = reference.filter(u => u.scorable);
    const inside = cues.filter(c => c.endMs > from * 1000 && c.startMs < (from + 120) * 1000).map(shift);
    return { from, reference, cues: inside, changes: held.filter((u, i) => i && u.speaker !== held[i - 1].speaker).length, heldCues: inside.filter(c => held.some(u => u.endMs > c.startMs && u.startMs < c.endMs)).length };
  };
  const wav = path.join(root, files.find(f => f.endsWith('.Mix-Headset.wav'))!);
  const duration = Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', wav], { encoding: 'utf8' })).format.duration);
  const chosen: ReturnType<typeof window>[] = [];
  for (let from = 0; from + 120 <= duration && chosen.length < count; from += 60) {
    if (chosen.length && from < chosen.at(-1)!.from + 120) continue;
    const w = window(from);
    if (w.changes >= 10 && w.heldCues >= 10) chosen.push(w);
  }
  return { wav, meeting: path.basename(wav, '.Mix-Headset.wav'), chosen };
}
/** The 120 s headset-mix excerpt of EN2001a picked by T19's rule: 0-120 s. Its per-clip row follows D28's per-clip
 * rule; the gated row pools it (below). */
async function amiSpeakers(): Promise<SpeakerCounts> {
  const root = option('--cache', path.join(process.env.LOCALAPPDATA!, 'Cutframe/analysis-cache'))!;
  const entry = (await json('datasets/manifest.json')).datasets.find((d: any) => d.id === 'T19-AMI-report-only');
  if (!entry) throw Error('Register T19-AMI-report-only before use');
  const files: string[] = entry.files.map((f: any) => f.path);
  for (const f of entry.files) { const file = path.join(root, f.path); if ((await stat(file)).size !== f.bytes || await sha256(file) !== f.sha256) throw Error(`AMI file mismatch: ${f.path}`); }
  const { wav, meeting, chosen: [chosen] } = await amiExcerpts(root, files, 1);
  if (!chosen) throw Error('No 120 s window with >= 10 speaker changes and >= 10 held cues');
  const audio = pcm(wav, false, [chosen.from, 120]), name = `${meeting}-${chosen.from}s-120s`;
  const result = await timed('transcription', name, lengthOf(audio), () => engine.transcribe(audio));
  await save(name + '-transcript.json', result);
  if (result.status !== 'complete') throw Error(`Speech was skipped: ${name}`);
  const scored = speakerAgreement(chosen.reference, result.transcript, chosen.cues);
  row(`TR-P06 ${name}`, { excerpt: name, windowS: [chosen.from, chosen.from + 120], speakerChanges: chosen.changes, ...scored }, PER_CLIP_SPEAKER_GATE, perClipSpeakers(scored));
  return scored;
}
/** D28: the gated TR-P06 row pools the corpus clips with AMI EN2001a 0-120 s. A missing or changed AMI file fails it, naming the cause. */
const POOLED_AMI_GATE = `>=.90 one-to-one agreement over the two corpus clips and AMI EN2001a 0-120 s (D28); below ${MIN_SPEAKER_CUES} scorable cues: fail on low evidence`;
async function pooledWithAmi(corpus: SpeakerCounts[]) {
  let ami: SpeakerCounts;
  try { ami = await amiSpeakers(); } catch (error) { row('TR-P06 pooled with AMI', { error: (error as Error).message }, POOLED_AMI_GATE, false); return; }
  const pooled = pool([...corpus, ami]);
  row('TR-P06 pooled with AMI', pooled, POOLED_AMI_GATE, pooled.evidenced && pooled.agreement >= 0.9);
}
/** The TR-P02 rows of a run: per clip, then combined. WER is under the normaliser (D31 Q8); Xapp agreement is not. */
function werRows(reference: any) {
  let allErrors = 0, allWords = 0, xappErrors = 0, xappWords = 0;
  return {
    clip(i: number, clip: string, words: Word[], truth: any) {
      const wer = normalizedWer(truth.words.map((w: any) => w.text), words.map(w => w.word));
      allErrors += wer.errors; allWords += wer.referenceWords;
      const xapp = reference.wordList.filter((w: any) => w.sourceItem === `i${i + 1}`).map((w: any) => w.text), agreement = wordAlignment(xapp, words.map(w => w.word));
      xappErrors += agreement.errors; xappWords += agreement.referenceWords;
      // D28: WER against the human reference (OT-2) decides; Xapp word agreement is reported, not gated.
      row(`TR-P02 ${clip}`, { wer: wer.wer, errors: wer.errors, referenceWords: wer.referenceWords, xappAgreement: Math.max(0, 1 - agreement.wer), textDisputedIncluded: truth.words.filter((w: any) => w.textDisputed).length }, 'WER <= .10 including disputed words; Xapp word agreement reported, not gated (D28)', wer.wer <= 0.1);
    },
    combined() { row('TR-P02 combined', { wer: allErrors / allWords, xappAgreement: 1 - xappErrors / xappWords, referenceWords: allWords, xappWords }, '<=.10 WER; Xapp agreement reported, not gated (D28)', allErrors / allWords <= 0.1); },
  };
}
const ot7Reference = async () => (await json('fixtures/OT-7 caption chunk cases (C).json')).cases.find((c: any) => c.id === 'W2-M01');
/** No model (T19q Q8): the TR-P02 rows from the stored transcripts of `--report-dir <dir>`. */
async function trRejudge() {
  const dir = option('--report-dir');
  if (!dir) throw Error('--report-dir <dir> names the run whose stored transcripts are re-scored');
  await verifyFixtures(store);
  const wer = werRows(await ot7Reference());
  for (const [i, clip] of clips.slice(0, 2).entries()) {
    const result = await json<TranscriptionResult>(path.join(dir, clip + '-transcript.json'));
    if (result.status !== 'complete') throw Error(`Speech was skipped: ${clip}`);
    wer.clip(i, clip, wordsOf(result.transcript), await json(path.join(store!, 'datasets/speech', clip + '-aligned.json')));
  }
  wer.combined();
}
async function transcriptChecks() {
  const wer = werRows(await ot7Reference());
  const speakers: ReturnType<typeof speakerAgreement>[] = [];
  const onGrid = (n: number) => Number.isFinite(n) && Math.abs(n * 50 - Math.round(n * 50)) < 1e-7;
  // M3: the transcript never runs backwards: words and segments in time order, none overlapping the one before.
  const inOrder = (spans: { start: number; end: number }[]) => spans.every((s, i) => s.start <= s.end && (i === 0 || s.start >= spans[i - 1].end));
  const monotonic = (t: Transcript) => inOrder(wordsOf(t)) && inOrder(t.segments);
  for (const [i, clip] of clips.slice(0, 2).entries()) {
    const result = await getTranscript(clip);
    if (result.status !== 'complete') throw Error(`Speech was skipped: ${clip}`);
    const t = result.transcript, words = wordsOf(t), truth = await json(path.join(store!, 'datasets/speech', clip + '-aligned.json'));
    const shape = Object.keys(t).sort().join() === ['language', 'languages', 'segments', 'total_duration'].sort().join() && onGrid(t.total_duration) && t.segments.every(s => Number.isInteger(s.speaker) && Number.isInteger(s.id) && s.words.every(w => typeof w.word === 'string' && onGrid(w.start) && onGrid(w.end)));
    row(`TR-P01 ${clip}`, { words: words.length, segments: t.segments.length, total_duration: t.total_duration, monotonic: monotonic(t) }, 'exact transcript schema; 20 ms grid for words and total_duration; integer segment speakers; words and segments in time order without overlap', shape && monotonic(t));
    wer.clip(i, clip, words, truth);
    const ts = timingScore(truth.words, t);
    row(`TR-P03 ${clip}`, ts, 'median <=60 ms; p95 <=200 ms; gate on the worse boundary per correctly matched timing-scorable word (start/end reported)', ts.medianMs <= 60 && ts.p95Ms <= 200);
    row(`TR-P05 ${clip}`, { language: t.language, languages: t.languages, requested: null }, 'en, detected (no language passed)', t.language === 'en' && t.languages.includes('en'));
    const consensus = await json(path.join(store!, 'datasets/speakers', clip + '-consensus.json'));
    const scored = speakerAgreement(consensus.intervals, t, truth.utterances.map((u: any) => ({ startMs: u.subtitleMs[0], endMs: u.subtitleMs[1] })));
    speakers.push(scored);
    row(`TR-P06 ${clip}`, scored, PER_CLIP_SPEAKER_GATE, perClipSpeakers(scored));
  }
  wer.combined();
  // CUT-P01: silence removal on clip 2 outside the 7.74-19.18 s story pause, defaults (pause .75 s, kept gap .35 s).
  // Findings part 3 §44.9: "removed 4.38 s ±1 frame per cut" for Xapp's redo, which "removed 4 pauses". Xapp's per-cut
  // times are not in the allowed docs, so the tolerance is on the total: Xapp's 4 cuts × 1 frame at the 30 fps
  // timeline (the stricter reading; the clip is 24 fps; notes Q11). The public OT-2 aligned words are a reference
  // check on the planner, not gated. Captions following the cuts are T09's.
  const action = transcripts.get(clips[1])!, actionTruth = await json(path.join(store!, 'datasets/speech', clips[1] + '-aligned.json'));
  const XAPP_CUTS = 4, tolerance = XAPP_CUTS / 30;
  const plan = (words: Word[]) => {
    const cuts = planSilenceRemoval(words, [[0, 7.74], [19.18, 30]]), removed = cuts.reduce((s, [a, b]) => s + b - a, 0);
    return { cuts, removed, wordShortened: cuts.some(([a, b]) => words.some(w => w.start < b && w.end > a)) };
  };
  const ours = action.status === 'complete' ? plan(wordsOf(action.transcript)) : null, aligned = plan(actionTruth.words.map((w: any) => ({ word: w.text, start: w.startMs / 1000, end: w.endMs / 1000 })));
  row('CUT-P01 tos-action-30s', { ...ours, xappRemoved: 4.38, xappCuts: XAPP_CUTS, tolerance, alignedWordsCheck: aligned }, 'removed 4.38 s within 1 frame per Xapp cut on the total (4 x 1/30 s); no word shortened', !!ours && Math.abs(ours.removed - 4.38) <= tolerance + 1e-9 && !ours.wordShortened);
  row('TR-P06 combined', pool(speakers), 'report-only (D28): the two corpus clips alone; the gated row is "TR-P06 pooled with AMI"', null);
  await pooledWithAmi(speakers);
  const music = await getTranscript(clips[2]);
  row('TR-P04 instrumental', music.status === 'skipped' ? music : { status: music.status, words: wordsOf(music.transcript).length }, 'skipped, no transcript, MUSIC_WITHOUT_VOCALS reason', music.status === 'skipped' && music.transcript === null);
  const song = await getTranscript('song-eternity-arcade-lost-in-a-dream-60s');
  const songWords = song.status === 'complete' ? wordsOf(song.transcript) : [];
  if (song.status === 'complete') row('TR-P01 song-eternity-arcade-lost-in-a-dream-60s', { words: songWords.length, segments: song.transcript.segments.length, monotonic: monotonic(song.transcript) }, 'words and segments in time order without overlap (M3)', monotonic(song.transcript));
  row('TR-P04 sung pipeline', { status: song.status, words: songWords.length, firstWord: songWords[0]?.start ?? null }, 'normal transcriber, not skipped; first word 2.70 +/- .20 s', song.status === 'complete' && !!songWords.length && Math.abs(songWords[0].start - 2.7) <= 0.2);
  const songRef = option('--song-reference');
  if (songRef) {
    const ref = await json(songRef), words = ref.segments ? wordsOf(ref) : ref.words ?? ref;
    const score = wordAlignment(words.map((w: any) => w.word ?? w.text), songWords.map(w => w.word));
    // referenceWords/ourWords make a truncated or mis-shaped reference visible instead of reading as a low score.
    row('TR-P04 song agreement (Author-run)', { agreement: 1 - score.wer, referenceWords: words.length, ourWords: songWords.length }, '>=.90 word agreement; reference expected 53 words', score.wer <= 0.1);
  } else row('TR-P04 song agreement', 'awaiting reference — clean-room research agent (D24 Q5); OT-7 masks do not preserve word identity', '>=.90 vs 53 unmasked Xapp words; --song-reference <json>', null);
  await guardedDialogueRows(speakers);
  const audio = pcm(path.join(store!, 'corpus', clips[0] + '.mp4'));
  const second = await engine.transcribe(audio);
  row('Determinism transcription', { identical: JSON.stringify(second) === JSON.stringify(transcripts.get(clips[0])) }, 'two analyses identical', JSON.stringify(second) === JSON.stringify(transcripts.get(clips[0])));
}
async function syntheticBeatChecks() {
  const synthetic = ['click-90', 'drum-120', 'drum-128', 'drum-129.2-noise', 'drum-140-3-4', 'drum-tempo-change'];
  for (const name of synthetic) {
    const truth = await json(path.join(store!, 'prerequisites', `OT-5-${name}.json`)), audio = pcm(path.join(store!, 'prerequisites', `OT-5-${name}.wav`), true);
    const start = performance.now(), result = await musicBeats(audio), again = await musicBeats(audio), each = (performance.now() - start) / 2000;
    rtf.push({ engine: `beats ${audio.sampleRate} Hz`, file: name, seconds: each, mediaSeconds: lengthOf(audio), rtf: each / lengthOf(audio) });
    const beats = truth.beats.map((b: any) => b.timeMs / 1000), downbeats = truth.beats.filter((b: any) => b.downbeat).map((b: any) => b.timeMs / 1000);
    const score70 = beatScore(beats, result.stored.beats.map(b => b[0]), 0.07), score20 = beatScore(beats, result.stored.beats.map(b => b[0]), 0.02), down = beatScore(downbeats, result.stored.downbeats.map(b => b[0]), 0.07);
    const trueBpm = 60 / median(beats.slice(1).map((b: number, i: number) => b - beats[i])), bpmError = result.stored.bpm === null ? Infinity : Math.abs(result.stored.bpm / trueBpm - 1), firstError = Math.abs((result.stored.downbeats[0]?.[0] ?? Infinity) - downbeats[0]);
    row(`BEAT-P01 ${name}`, { bpm: result.stored.bpm, truthBpmFromMedian: trueBpm, bpmError, f70: score70.f, f20: score20.f, downbeatF: down.f, firstDownbeatError: firstError, deterministic: JSON.stringify(result) === JSON.stringify(again) }, 'BPM +/-1%; F70>=.95; F20>=.85; downbeatF>=.85; first +/-50ms; deterministic', bpmError <= 0.01 && score70.f >= 0.95 && score20.f >= 0.85 && down.f >= 0.85 && firstError <= 0.05 && JSON.stringify(result) === JSON.stringify(again));
    await save(`OT-5-${name}-beats.json`, result);
  }
}
async function beatChecks() {
  await syntheticBeatChecks();
  const groove = await json(path.join(store!, 'datasets/groove/test-subset.json'));
  for (const performance of groove.performances) {
    const audio = pcm(path.join(store!, 'datasets/groove', performance.audio_filename), true), result = await musicBeats(audio), times = performance.beats.map((b: any) => b.timeMs / 1000);
    const score = beatScore(times, result.stored.beats.map(b => b[0]), 0.07), bpmError = result.stored.bpm === null ? Infinity : Math.abs(result.stored.bpm / Number(performance.bpm) - 1);
    row(`BEAT-P02 ${performance.id}`, { ...score, bpm: result.stored.bpm, bpmError }, 'F>=.85 at70ms; BPM +/-1%', score.f >= 0.85 && bpmError <= 0.01);
    await save(`groove-${performance.id.replaceAll('/', '-')}-beats.json`, result);
  }
  const creditAudio = pcm(path.join(store!, 'corpus', clips[2] + '.mp4'), true), creditStart = performance.now(), credits = await musicBeats(creditAudio), creditSeconds = (performance.now() - creditStart) / 1000;
  rtf.push({ engine: `beats ${creditAudio.sampleRate} Hz`, file: clips[2], seconds: creditSeconds, mediaSeconds: lengthOf(creditAudio), rtf: creditSeconds / lengthOf(creditAudio) });
  await save('credits-beats.json', credits);
  const documented = [0.418, 3.808, 4.342, 4.876, 5.410, 5.944, 6.478, 7.036, 7.570, 8.104, 8.638, 9.172, 9.706];
  // D24 (Q9): Xapp's empty 0.418-3.808 s credits intro is not copied. Our intro beats stay, as a
  // documented difference and with no suppression anywhere in the engine, and the stored prefix is
  // scored from exactly 3.8 s on both sides. Both intros are reported in the row, not scored.
  const from = 3.8;
  const short = beatScore(documented.filter(t => t >= from), credits.stored.beats.filter(b => b[0] >= from && b[0] < 10).map(b => b[0]), 0.07);
  row('BEAT-P02 Xapp 3.8-10s (repo numbers, D24 Q9)', { ...short, from, droppedXappBeats: documented.filter(t => t < from), ourIntroBeats: credits.stored.beats.filter(b => b[0] < from).map(b => b[0]) }, 'report-only (D31 Q6): an open parity gap, not a pass; the old gate was F>=.90 at70ms over 3.8-10 s; our intro beats are a documented difference, not suppressed', null);
  const reference = option('--beat-reference');
  if (reference) {
    const ref = await json(reference), beats = ref.beats ?? ref.data?.beats?.beats ?? ref;
    const all = beats.map((b: any) => Array.isArray(b) ? b[0] : b.time), times = all.filter((t: number) => t >= from);
    const score = beatScore(times, credits.stored.beats.filter(b => b[0] >= from).map(b => b[0]), 0.07);
    // Times are read as seconds and never converted. referenceSpan/clipSeconds make a millisecond-valued
    // file or a reference covering a longer source obvious instead of reading as a near-zero F.
    const clipSeconds = lengthOf(creditAudio);
    row('BEAT-P02 whole-file reference (from 3.8 s, D24 Q9)', { ...score, from, referenceBeats: beats.length, scoredReferenceBeats: times.length, referenceSpan: [Math.min(...all), Math.max(...all)], clipSeconds, unitsLookLikeMilliseconds: Math.max(...all) > clipSeconds * 10 }, 'F>=.85 at70ms; reference in seconds for this 40 s asset', score.f >= 0.85);
  } else row('BEAT-P02 whole-file Xapp', 'awaiting reference — clean-room research agent (D24 Q5)', 'F>=.85 at70ms from 3.8 s (D24 Q9) vs the stored whole-file beats; --beat-reference <json>', null);
  let refusal = '';
  try { detectBeats(creditAudio, 'video', true); } catch (e) { refusal = (e as { code: string }).code; }
  row('BEAT-P03', refusal, 'BEATS_NOT_AUDIO', refusal === 'BEATS_NOT_AUDIO');
  // SYNC-P01 on engine output (review M1; plan pre-registered in the T19a notes): the cut plan is
  // fixed lengths from the first detected downbeat, snapped with the detected rhythm only; the truth
  // is used for scoring alone.
  const drum = await json(path.join(store!, 'prerequisites', 'OT-5-drum-120.json')), drumBeats = (await musicBeats(pcm(path.join(store!, 'prerequisites', 'OT-5-drum-120.wav'), true))).stored;
  const lengths = [1.07, 0.93, 1.31, 0.68, 1.22, 0.97, 0.84, 0.98], frame = 1 / 30, expectedTotal = 8;
  const plan = lengths.reduce((b, l) => [...b, b.at(-1)! + l], [drumBeats.downbeats[0]?.[0] ?? drumBeats.beats[0]?.[0] ?? 0]);
  const snapped = plan.slice();
  if (drumBeats.bpm) for (const m of snapCuts(plan, drumBeats, 60 / drumBeats.bpm / 4, 4)) snapped[m.index] = m.to;
  const trueBeats: number[] = drum.beats.map((b: any) => b.timeMs / 1000), trueGrid = trueBeats.flatMap((b, i) => i + 1 < trueBeats.length ? [0, 1, 2, 3].map(k => b + k * (trueBeats[i + 1] - b) / 4) : [b]);
  const gridError = (t: number) => trueGrid.reduce((best, g) => Math.min(best, Math.abs(g - t)), Infinity);
  const internal = snapped.slice(1, -1).map(gridError), clipLengths = snapped.slice(1).map((t, i) => t - snapped[i]), total = clipLengths.reduce((a, b) => a + b, 0);
  row('SYNC-P01', { detectedBpm: drumBeats.bpm, plannedBoundaries: plan, snappedBoundaries: snapped, internalCutErrorsFrames: internal.map(e => e / frame), clipLengths, total, expectedTotal, totalErrorFrames: Math.abs(total - expectedTotal) / frame }, '8 clips from detected beats: every internal cut within 1 frame (1/30 s) of a true beat/quarter subdivision; summed clip lengths within 1 frame of 8 s', internal.every(e => e <= frame + 1e-9) && Math.abs(total - expectedTotal) <= frame + 1e-9 && clipLengths.every(l => l > 0));
  const creditsAgain = await musicBeats(creditAudio);
  row('Determinism beats corpus', { identical: JSON.stringify(credits) === JSON.stringify(creditsAgain) }, 'two analyses identical', JSON.stringify(credits) === JSON.stringify(creditsAgain));
}
async function footageChecks() {
  const analyses = new Map<string, VisualAnalysis>();
  for (const [index, clip] of clips.entries()) {
    const duration = [45, 30, 40][index], input = frames(path.join(store!, 'corpus', clip + '.mp4'), duration);
    const analysis = await timed('footage descriptions', clip, duration, () => engine.describe(input, duration));
    analyses.set(clip, analysis); await save(clip + '-analysis.json', analysis);
    const transcript = await getTranscript(clip);
    await engine.footage.add({ id: clip, filename: clip + '.mp4', type: 'video', duration, projectIds: ['corpus'] }, analysis, transcript.transcript);
    const contiguous = analysis.segments[0]?.start === 0 && analysis.segments.at(-1)?.end === duration && analysis.segments.every((s, i) => s.end > s.start && (i === 0 || analysis.segments[i - 1].end === s.start));
    row(`TR-P07 ${clip}`, { width: analysis.width, height: analysis.height, aspectRatio: analysis.aspectRatio, tags: analysis.tags, segments: analysis.segments.length, contiguous }, 'contiguous timed descriptions, tags and summary; aspect ratio from1280x534 pixels', contiguous && analysis.aspectRatio === 1280 / 534 && !!analysis.summary && analysis.tags.length >= 5 && analysis.tags.length <= 6);
  }
  const request = (query: string, threshold: 'low' | 'medium' | 'high' = 'medium') => ({ query, projectId: 'corpus', mode: 'general' as const, options: { threshold, limit: 30 } });
  const key = await json('fixtures/OT-3 search relevance key (C).json'), latencies: number[] = [], recalls: number[] = [], searches: Record<string, SearchResponse> = {};
  let notWorse = true, noMatch = true, monotone = true;
  // D24 (Q11): the FS-P03/FS-P04 gates count only tags/summary/description hits. The transcript channel
  // is reported in its own ungated rows below, so it can move neither gate.
  const gatedRows = (response: SearchResponse) => response.results.filter(r => r.embeddingType !== 'transcript');
  const transcriptRecalls: number[] = [], excluded: string[] = [];
  // Xapp's results per query exist only as the key's `xappReference` text, which names the clip of
  // every returned row (clip n = the key's n-th clip). Recall uses our own definition (review m3).
  if (Object.keys(key.clips).join() !== clips.map(c => c + '.mp4').join()) throw Error('OT-3 clip order changed; Xapp clip numbers cannot be mapped');
  const xappOf = (q: any) => {
    const wave = Number(q.id.slice(1)) <= 20 ? 'wave 2' : 'W3-RF-10', text = String(q.xappReference).split(';').map(s => s.trim()).find(s => s.startsWith(wave)) ?? '';
    return { source: text, filenames: [...new Set([...text.matchAll(/clip (\d)/g)].map(m => clips[Number(m[1]) - 1] + '.mp4'))] };
  };
  for (const q of key.queries) {
    const start = performance.now(), result = await engine.footage.search(request(q.query)); latencies.push((performance.now() - start) / 1000); searches[q.id] = result;
    const gated = gatedRows(result);
    const relevant = Object.keys(q.clipGrade).filter(name => q.clipGrade[name] > 0), found = new Set(gated.slice(0, 5).map(r => r.filename));
    const recall = relevant.length ? relevant.filter(name => found.has(name)).length / relevant.length : Number(gated.length === 0);
    // D24 (Q12): FS-P03 scores only the first-20 queries that should find something; a no-match query is
    // scored in FS-P04 alone and is excluded from the mean and from the per-query comparison with Xapp.
    const scorable = Number(q.id.slice(1)) <= 20 && !q.noMatch && relevant.length > 0;
    if (scorable) recalls.push(recall); else if (Number(q.id.slice(1)) <= 20) excluded.push(q.id);
    const xapp = xappOf(q), xappFound = new Set(xapp.filenames.slice(0, 5));
    const xappRecall = relevant.length ? relevant.filter(name => xappFound.has(name)).length / relevant.length : Number(xapp.filenames.length === 0);
    if (scorable && recall < xappRecall) notWorse = false;
    if (q.noMatch && gated.length) noMatch = false;
    // Ungated transcript-channel report: the rows the gates now ignore, and the recall the old
    // all-channel rule would have given for this query.
    if (Number(q.id.slice(1)) <= 20) {
      const all = new Set(result.results.slice(0, 5).map(r => r.filename));
      const allRecall = relevant.length ? relevant.filter(name => all.has(name)).length / relevant.length : Number(result.results.length === 0);
      if (scorable) transcriptRecalls.push(allRecall);
      row(`FS-P03 transcript-channel ${q.id}`, { query: q.query, transcriptRows: result.results.length - gated.length, recallAt5AllChannels: allRecall, recallAt5Gated: recall, scoredInFsP03: scorable }, 'report only (D24 Q11): transcript hits cannot move FS-P03 or FS-P04', null);
    }
    const low = await engine.footage.search(request(q.query, 'low')), high = await engine.footage.search(request(q.query, 'high'));
    const identity = (r: SearchResponse['results'][number]) => JSON.stringify([r.assetId, r.source, r.embeddingType, r.chunkText, r.startTime, r.endTime]);
    const l = new Set(low.results.map(identity)), m = new Set(result.results.map(identity));
    if (!result.results.every(r => l.has(identity(r))) || !high.results.every(r => m.has(identity(r)))) monotone = false;
    row(`FS-P03 ${q.id}`, { query: q.query, recallAt5: recall, relevantAssets: relevant.length, rows: gated.length, xappRecall, xappSource: xapp.source, noMatch: !!q.noMatch }, 'first20 that should find something: per-query recall>=Xapp; mean>=.8; OT-3 asset-level clipGrade>0; tags/summary/description channels only; Q21+ and no-match report only (D24 Q11/Q12)', scorable ? recall >= xappRecall : null);
  }
  await save('searches.json', searches);
  const mean = recalls.reduce((a, b) => a + b, 0) / recalls.length;
  row('FS-P03 mean', { meanRecallAt5: mean, queriesScored: recalls.length, queriesExcluded: excluded, notWorsePerQuery: notWorse }, 'mean>=.8 and per-query>=Xapp over the scored first20 (no-match excluded, D24 Q12); no dedup before top5', mean >= 0.8 && notWorse);
  row('FS-P03 transcript-channel mean', { meanRecallAt5AllChannels: transcriptRecalls.reduce((a, b) => a + b, 0) / transcriptRecalls.length, queries: transcriptRecalls.length }, 'report only (D24 Q11): the mean the old all-channel rule would have given over the same scored queries', null);
  row('FS-P04', { noMatchQueries: key.queries.filter((q: any) => q.noMatch).map((q: any) => ({ query: q.query, count: gatedRows(searches[q.id]).length, transcriptRows: searches[q.id].results.length - gatedRows(searches[q.id]).length })) }, 'every no-match query returns0 in the tags/summary/description channels (D24 Q11)', noMatch);
  const one = searches.Q11;
  row('FS-P01', { keys: Object.keys(one), metadata: one.metadata }, 'request/response fields, local row shape, no exposed vectors', one.query === 'This is pretty freaky' && one.results.every(r => !('vector' in r) && ['filename', 'embedding'].includes(r.source) && Array.isArray(r.surroundingContext)));
  const red = await engine.footage.search(request('red')), upper = await engine.footage.search(request('TOS-ACTION')), absent = await engine.footage.search(request('nonexistent-qzxfilename'));
  row('FS-P02', { red: red.results.filter(r => r.source === 'filename').map(r => r.assetId), uppercase: upper.results.filter(r => r.source === 'filename').map(r => r.assetId), absent: absent.results.filter(r => r.source === 'filename').length }, 'filename exact substring, any case, listed first', red.results[0]?.source === 'filename' && red.results[0]?.assetId === clips[2] && upper.results[0]?.assetId === clips[1] && absent.results.filter(r => r.source === 'filename').length === 0);
  let phrasePass = true;
  for (const [query, clip, from, to] of [['This is pretty freaky', clips[0], 2.96, 4.34], ['awesome in space', clips[1], 6.8, 7.74], ['robot', clips[1], 29.3, 29.64]] as const) {
    const result = await engine.footage.search(request(query)), hit = result.results.some(r => r.assetId === clip && r.startTime !== undefined && r.endTime !== undefined && Math.abs(r.startTime - from) <= 0.5 && Math.abs(r.endTime - to) <= 0.5);
    phrasePass &&= hit; row(`FS-P05 ${query}`, { hit, ranges: result.results.filter(r => r.assetId === clip).map(r => [r.startTime, r.endTime]) }, 'spoken hit within+/-0.5s of reference range', hit);
  }
  row('FS-P06', { medianSeconds: median(latencies), maxSeconds: Math.max(...latencies) }, 'median<=1s; max<=3s (prepared index)', median(latencies) <= 1 && Math.max(...latencies) <= 3);
  row('FS-P07', { monotone }, 'low contains medium contains high', monotone);
  const duration = 45, repeat = await engine.describe(frames(path.join(store!, 'corpus', clips[0] + '.mp4'), duration).slice(0, 1), duration);
  const repeat2 = await engine.describe(frames(path.join(store!, 'corpus', clips[0] + '.mp4'), duration).slice(0, 1), duration);
  row('Determinism footage', { identical: JSON.stringify(repeat) === JSON.stringify(repeat2) }, 'two analyses of one frame identical', JSON.stringify(repeat) === JSON.stringify(repeat2));
}
async function syncChecks() {
  const original = await getTranscript(clips[0]);
  const recutFile = path.join(output, 'known-offset-reencoded.mp4'); await mkdir(output, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1.234', '-i', path.join(store!, 'corpus', clips[0] + '.mp4'), '-filter_complex', '[0:a]volume=0.5011872336[a];anoisesrc=color=white:amplitude=0.001:seed=1901:r=44100[n];[a][n]amix=inputs=2:duration=first:normalize=0[out]', '-map', '0:v:0', '-map', '[out]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', recutFile], { stdio: 'pipe' });
  const audio = pcm(recutFile), recut = await timed('sync transcript preparation', 'recut1.234s', audio.data[0].length / audio.sampleRate, () => engine.transcribe(audio));
  await save('known-offset-transcript.json', recut);
  if (original.status !== 'complete' || recut.status !== 'complete') throw Error('Known speech pair unexpectedly skipped');
  const sync = await timed('sync offset', 'known pair', audio.data[0].length / audio.sampleRate, async () => syncOffset(recut.transcript, original.transcript));
  row('MC-P01 known pair', { offset: sync.offset, errorSeconds: Math.abs(sync.offset + 1.234), confidence: sync.confidence, matches: sync.matches.length, gainDb: -6, addedWhiteNoiseAmplitude: 0.001 }, 'offset=-1.234 +/-1/24s; confidence>=.5', Math.abs(sync.offset + 1.234) <= 1 / 24 && sync.confidence >= 0.5);
  const music = await getTranscript(clips[2]);
  let code = '', message = '';
  try { syncOffset(original.transcript, music.transcript ?? { language: 'en', languages: ['en'], total_duration: 40, segments: [] }); }
  catch (error) { code = (error as { code: string }).code; message = (error as Error).message; }
  row('MC-P01 unrelated pair', { code, message }, 'SYNC_LOW_CONFIDENCE (<.5)', code === 'SYNC_LOW_CONFIDENCE');
  row('Determinism sync', { identical: JSON.stringify(sync) === JSON.stringify(syncOffset(recut.transcript, original.transcript)) }, 'two analyses identical', JSON.stringify(sync) === JSON.stringify(syncOffset(recut.transcript, original.transcript)));
}
/** T19q B4: the BeatThis fold that held out each Groove validation performance, pre-registered in the notes and
 * checked against BeatThis's own split file. */
const VALIDATION_FOLDS: Record<string, number> = {
  'drummer1/session1/38': 0, 'drummer3/session2/25': 1, 'drummer3/session2/5': 1, 'drummer4/session1/2': 1, 'drummer1/session1/145': 2,
  'drummer3/session1/15': 2, 'drummer7/session2/14': 2, 'drummer7/session2/46': 2, 'drummer7/session2/113': 3, 'drummer6/session3/1': 4,
  'drummer4/session1/5': 5, 'drummer7/session1/14': 5, 'drummer7/session2/100': 5, 'drummer7/session3/22': 6, 'drummer3/session1/7': 7,
};
/** Beat-tracker changes are judged here first: Groove performances outside the scored subset plus the
 * BEAT-P01 synthetics, each performance scored with the BeatThis fold that never trained on it (T19q B4).
 * `--baseline <report.json>` applies the adoption rule pre-registered in the notes. */
async function beatValidation() {
  const root = option('--cache', path.join(process.env.LOCALAPPDATA!, 'Cutframe/analysis-cache'))!, manifest = await json('datasets/manifest.json');
  for (const id of ['T19a-Groove-validation', 'T19q-beat-this-split']) {
    const dataset = manifest.datasets.find((d: any) => d.id === id);
    if (!dataset) throw Error(`Register ${id} before use`);
    for (const f of dataset.files) { const file = path.join(root, f.path); if ((await stat(file)).size !== f.bytes || await sha256(file) !== f.sha256) throw Error(`${id} mismatch: ${f.path}`); }
  }
  const models = option('--models', path.join(store!, 'models/t19a'))!;
  await verifyModels(models, 'T19a-beat-this-cv');
  const split = new Map((await readFile(path.join(root, 'datasets/t19q/beat-this/8-folds.split'), 'utf8')).trim().split(/\r?\n/).map(line => line.split('\t')).map(([name, fold]) => [name, Number(fold)]));
  await syntheticBeatChecks();
  const set = await json(path.join(root, 'datasets/t19a/groove-validation/validation-set.json')), scores: Record<string, { f70: number; bpmError: number }> = {};
  if (set.performances.map((p: any) => p.id).sort().join() !== Object.keys(VALIDATION_FOLDS).sort().join()) throw Error('The Groove validation set differs from the pre-registered fold map');
  for (const p of set.performances) {
    const fold = split.get(p.audio_filename.replace(/\.wav$/, '').replaceAll('/', '_'));
    if (fold !== VALIDATION_FOLDS[p.id]) throw Error(`Split file puts ${p.id} in fold ${fold}, not the pre-registered ${VALIDATION_FOLDS[p.id]}`);
    const audio = pcm(path.join(root, 'datasets/t19a/groove-validation', p.audio_filename), true), truth = p.beats.map((b: any) => b.timeMs / 1000);
    const result = (await engine.musicBeats(audio, undefined, `beat_this_fold${fold}.onnx`)).stored, f70 = beatScore(truth, result.beats.map(x => x[0]), 0.07).f, bpmError = result.bpm === null ? Infinity : Math.abs(result.bpm / Number(p.bpm) - 1);
    scores[p.id] = { f70, bpmError };
    row(`Groove validation ${p.id}`, { style: p.style, bpm: Number(p.bpm), sampleRate: audio.sampleRate, fold, f70, detectedBpm: result.bpm, bpmError }, 'report only (adoption rule below)', null);
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length, ids = Object.keys(scores);
  // A missing BPM is saved as null (JSON has no Infinity) and counts as a tempo error.
  const tempoErrors = (s: typeof scores) => ids.filter(id => !(typeof s[id].bpmError === 'number' && s[id].bpmError <= 0.01)).length;
  const summary = { performances: ids.length, meanF70: mean(ids.map(id => scores[id].f70)), atLeast085: ids.filter(id => scores[id].f70 >= 0.85).length, bpmErrorsOver1pct: tempoErrors(scores), beatP01Pass: rows.filter(r => r.item.startsWith('BEAT-P01')).every(r => r.status === 'pass') };
  const baselineFile = option('--baseline');
  if (!baselineFile) { row('Groove validation summary', summary, 'report only; pass --baseline <report.json> to apply the adoption rule', null); return; }
  const base: typeof scores = Object.fromEntries((await json<{ rows: Row[] }>(baselineFile)).rows.filter(r => r.item.startsWith('Groove validation ') && r.item !== 'Groove validation summary').map(r => [r.item.slice('Groove validation '.length), r.measured as { f70: number; bpmError: number }]));
  if (ids.join() !== Object.keys(base).join()) throw Error('Baseline covers a different validation set');
  const regressions = ids.filter(id => base[id].f70 >= 0.85 && scores[id].f70 < 0.85), baseMean = mean(ids.map(id => base[id].f70)), baseTempoErrors = tempoErrors(base);
  // T19 Q3 replaced T19a's "mean F70 does not fall" (>=) rule; the strict rule has its own row name so old and new
  // reports never share one name under two rules (review nit 8). Report only, outside --part all: no gate changes.
  row('Groove validation adoption, strict gain (T19 Q3)', { ...summary, baseline: baselineFile, baselineMeanF70: baseMean, baselineBpmErrorsOver1pct: baseTempoErrors, regressionsBelow085: regressions, adopt: summary.meanF70 > baseMean && regressions.length === 0 && summary.bpmErrorsOver1pct <= baseTempoErrors && summary.beatP01Pass }, 'pre-registered (T19, strict gain Q3; replaces the T19a row "Groove validation adoption", whose mean rule was >=): adopt only if mean F70 strictly rises, no performance falls from >=.85 to <.85, tempo errors (>1% BPM) do not rise, and BEAT-P01 passes all six at the native rate', null);
}
/** Search changes are judged here first (T19 round F): the frozen V-FS key over eight open-movie clips
 * outside the corpus. Descriptions are cached by clip hash and captioner, so every embedder sees the same
 * text; transcripts are not indexed (the gated channels never use them). `--baseline <report.json>`
 * applies the validation rule pre-registered in the notes. */
const VFS_KEY_SHA256 = 'b2a62a904eea2def69b75c1698374090ff605532c1f05074c2def3a6cb11a372';
async function footageValidation() {
  const root = path.join(option('--cache', path.join(process.env.LOCALAPPDATA!, 'Cutframe/analysis-cache'))!, 'datasets/t19/vfs'), keyFile = path.join(root, 'vfs-key.json');
  if (await sha256(keyFile) !== VFS_KEY_SHA256) throw Error('V-FS key changed after its freeze');
  const key = await json(keyFile), duration = 30, open = { low: -1, medium: -1, high: -1 };
  // Calibration (QF) needs every similarity, so a second index over the same chunks keeps them all.
  const calibration = new FootageIndex(texts => engine.models.embed(texts), open), images: number[][] = [];
  for (const [name, clip] of Object.entries<any>(key.clips)) {
    const file = path.join(root, name);
    if (await sha256(file) !== clip.sha256) throw Error(`V-FS clip mismatch: ${name}`);
    const cache = path.join(root, 'descriptions', `${name}.${clip.sha256.slice(0, 16)}.${MODEL_IDS.vision.replace('/', '_')}.json`);
    let analysis: VisualAnalysis;
    try { analysis = await json(cache); } catch {
      analysis = await timed('footage descriptions', name, duration, () => engine.describe(frames(file, duration), duration));
      await mkdir(path.dirname(cache), { recursive: true }); await writeFile(cache, JSON.stringify(analysis, null, 2) + '\n');
    }
    // Round F8 (T19's F2): cached descriptions predate the frame vectors; the same frames give them.
    if (analysis.segments.some(s => !s.vector)) await engine.attachImageVectors(frames(file, duration), analysis);
    images.push(...analysis.segments.map(s => s.vector!));
    const asset = { id: name, filename: name, type: 'video' as const, duration, projectIds: ['vfs'] };
    await engine.footage.add(asset, analysis, null); await calibration.add(asset, analysis, null);
  }
  const request = (query: string, threshold: 'low' | 'medium' | 'high' = 'medium', limit = 30) => ({ query, projectId: 'vfs', mode: 'general' as const, options: { threshold, limit } });
  const gated = (response: SearchResponse) => response.results.filter(r => r.embeddingType !== 'transcript');
  const identity = (r: SearchResponse['results'][number]) => JSON.stringify([r.assetId, r.source, r.embeddingType, r.chunkText, r.startTime, r.endTime]);
  const recalls: number[] = [], latencies: number[] = [], noMatchRows: Record<string, number> = {};
  let monotone = true, worst = -1, worstVisual = -1;
  for (const q of key.queries) {
    const start = performance.now(), result = await engine.footage.search(request(q.query)); latencies.push((performance.now() - start) / 1000);
    const hits = gated(result), relevant = Object.keys(q.clipGrade).filter(n => q.clipGrade[n] > 0), found = new Set(hits.slice(0, 5).map(r => r.filename));
    const low = await engine.footage.search(request(q.query, 'low')), high = await engine.footage.search(request(q.query, 'high'));
    const l = new Set(low.results.map(identity)), m = new Set(result.results.map(identity));
    if (!result.results.every(r => l.has(identity(r))) || !high.results.every(r => m.has(identity(r)))) monotone = false;
    const recall = q.noMatch ? null : relevant.filter(n => found.has(n)).length / relevant.length;
    if (q.noMatch) {
      noMatchRows[q.id] = hits.length;
      worst = Math.max(worst, ...gated(await calibration.search(request(q.query, 'low', 1e6))).map(r => r.similarity));
      const [text] = await engine.models.clipText([`a photo of ${q.query}.`]);
      worstVisual = Math.max(worstVisual, ...images.map(v => cosine(text, v)));
    } else recalls.push(recall!);
    row(`V-FS ${q.id}`, { query: q.query, type: q.type, recallAt5: recall, relevant, rows: hits.length, top5: hits.slice(0, 5).map(r => [r.filename, r.embeddingType, Number(r.similarity.toFixed(4))]) }, 'report only (round F validation)', null);
  }
  // QF: medium = the smallest grid value at which every no-match query returns no gated row (the value
  // itself is kept, so it must lie above the best no-match similarity); low/high = medium -/+ 0.15.
  const step = (k: number) => Math.round(k * 100) / 100, medium = Array.from({ length: 13 }, (_, i) => step(0.3 + 0.05 * i)).find(g => g > worst) ?? null;
  const calibrated = medium === null ? null : { low: step(medium - 0.15), medium, high: step(medium + 0.15) };
  // F8 (T19's F2): the visual medium is calibrated the same way, on its own grid.
  const calibratedVisual = visualCalibration(worstVisual);
  const mean = recalls.reduce((a, b) => a + b, 0) / recalls.length;
  const summary = { queries: key.queries.length, shouldFind: recalls.length, meanRecallAt5: mean, noMatchRows, noMatchZero: Object.values(noMatchRows).every(n => n === 0), monotone, medianLatencySeconds: median(latencies), bestNoMatchSimilarity: worst, calibrated, productThresholds: SEARCH_THRESHOLDS, embedder: MODEL_IDS.embedding, bestNoMatchFrameSimilarity: worstVisual, calibratedVisual, productVisual: VISUAL_THRESHOLD, visual: MODEL_IDS.clip };
  const baselineFile = option('--baseline');
  if (!baselineFile) { row('V-FS summary', summary, 'report only; pass --baseline <report.json> to apply the validation rule', null); return; }
  const base = (await json<{ rows: Row[] }>(baselineFile)).rows.find(r => r.item === 'V-FS summary' || r.item === 'V-FS validation')!.measured as typeof summary;
  const thresholdsCalibrated = JSON.stringify(calibrated) === JSON.stringify(SEARCH_THRESHOLDS) && calibratedVisual === VISUAL_THRESHOLD;
  row('V-FS validation', { ...summary, baseline: baselineFile, baselineMeanRecallAt5: base.meanRecallAt5, thresholdsCalibrated, pass: mean > base.meanRecallAt5 && summary.noMatchZero && monotone && summary.medianLatencySeconds <= 1 && thresholdsCalibrated }, 'pre-registered (T19 round F): V-FS mean recall@5 strictly rises over the baseline; every no-match query returns 0 gated rows; low contains medium contains high; median latency <= 1 s; product thresholds = the V-FS calibration (QF; round F8: VISUAL_THRESHOLD too)', null);
}
/** Diarization changes are judged here first (T19 round S): V-SPK, synthetic LibriSpeech conversations with
 * exact turns, clean and under drums. Diarization is the transcript's last stage, so the product transcript
 * is cached per file and each candidate re-runs only the product diarizer on a copy. `--baseline <report.json>`
 * applies the rule. */
const VSPK_TRUTH_SHA256 = '8c97eff66c5868e85f68e63effbac8bf447c03eff30bba670b89d403929f7f5b';
async function speakerValidation() {
  const root = path.join(option('--cache', path.join(process.env.LOCALAPPDATA!, 'Cutframe/analysis-cache'))!, 'datasets/t19/vspk'), truthFile = path.join(root, 'vspk-truth.json');
  if (await sha256(truthFile) !== VSPK_TRUTH_SHA256) throw Error('V-SPK truth changed after its freeze');
  const truth = await json(truthFile);
  const scores: { snrDb: number | null; agreement: number }[] = [];
  for (const [name, file] of Object.entries<any>(truth.files)) {
    const wav = path.join(root, name);
    if (await sha256(wav) !== file.sha256) throw Error(`V-SPK file mismatch: ${name}`);
    const turns = truth.conversations.find((c: any) => c.id === file.conversation).turns;
    const reference = turns.map((u: any) => ({ startMs: u.start * 1000, endMs: u.end * 1000, speaker: u.speaker, scorable: true }));
    const cache = path.join(root, 'transcripts', `${name}.${file.sha256.slice(0, 16)}.json`), audio = pcm(wav);
    let result: TranscriptionResult;
    try { result = await json(cache); } catch {
      result = await timed('transcription', name, 60, () => engine.transcribe(audio));
      await mkdir(path.dirname(cache), { recursive: true }); await writeFile(cache, JSON.stringify(result) + '\n');
    }
    if (result.status !== 'complete') { scores.push({ snrDb: file.snrDb, agreement: 0 }); row(`V-SPK ${name}`, { status: result.status, agreement: 0 }, 'report only (round S validation)', null); continue; }
    const samples = resample(audio), transcript = structuredClone(result.transcript);
    await engine.models.diarize(samples, transcript);
    const scored = speakerAgreement(reference, transcript, reference), measured: Record<string, unknown> = { agreement: scored.agreement, purity: scored.purity, coverage: scored.coverage, referenceSpeakers: scored.referenceSpeakers, predictedLabels: scored.predictedLabels, units: scored.units, segments: transcript.segments.length };
    scores.push({ snrDb: file.snrDb, agreement: scored.agreement });
    row(`V-SPK ${name}`, measured, 'report only (round S validation)', null);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length, bySnr = (snr: number | null) => mean(scores.filter(s => s.snrDb === snr).map(s => s.agreement));
  const summary = { files: scores.length, meanAgreement: mean(scores.map(s => s.agreement)), clean: bySnr(null), snr10: bySnr(10), snr5: bySnr(5), speakerModel: MODEL_IDS.speaker };
  const baselineFile = option('--baseline');
  if (!baselineFile) { row('V-SPK summary', summary, 'report only; pass --baseline <report.json> to apply the validation rule', null); return; }
  const base = (await json<{ rows: Row[] }>(baselineFile)).rows.find(r => r.item === 'V-SPK summary' || r.item === 'V-SPK validation')!.measured as typeof summary;
  row('V-SPK validation', { ...summary, baseline: baselineFile, baselineMeanAgreement: base.meanAgreement, pass: summary.meanAgreement >= base.meanAgreement + 0.05 }, 'pre-registered (T19 round S): V-SPK mean agreement >= baseline + 0.05', null);
}
/** V-AMI (T19q round S, pre-registered 3 Nov 02:23): the first meeting of each AMI series that shares no participant
 * with EN2001a, up to three excerpts each by T19's window rule. Cached like V-SPK: each candidate re-runs only the
 * product diarizer. `--baseline <report.json>` applies the V-AMI half of the round S rule. */
const VAMI_MEETINGS = ['ES2002a', 'IS1000a', 'TS3003a', 'IB4001', 'IN1001'];
async function amiValidation() {
  const root = option('--cache', path.join(process.env.LOCALAPPDATA!, 'Cutframe/analysis-cache'))!;
  const entry = (await json('datasets/manifest.json')).datasets.find((d: any) => d.id === 'T19q-AMI-validation');
  if (!entry) throw Error('Register T19q-AMI-validation before use');
  for (const f of entry.files) { const file = path.join(root, f.path); if ((await stat(file)).size !== f.bytes || await sha256(file) !== f.sha256) throw Error(`V-AMI file mismatch: ${f.path}`); }
  const scores: (SpeakerCounts & { meeting: string; agreement: number; ceilingCorrect: number })[] = [];
  for (const meeting of VAMI_MEETINGS) {
    const files = entry.files.filter((f: any) => path.basename(f.path).startsWith(meeting + '.'));
    const { wav, chosen } = await amiExcerpts(root, files.map((f: any) => f.path), 3), hash = files.find((f: any) => f.path.endsWith('.wav')).sha256;
    for (const w of chosen) {
      const name = `${meeting}-${w.from}s-120s`, cache = path.join(root, 'datasets/t19q/vami/transcripts', `${name}.${hash.slice(0, 16)}.json`), audio = pcm(wav, false, [w.from, 120]);
      let result: TranscriptionResult;
      try { result = await json(cache); } catch {
        result = await timed('transcription', name, 120, () => engine.transcribe(audio));
        await mkdir(path.dirname(cache), { recursive: true }); await writeFile(cache, JSON.stringify(result) + '\n');
      }
      const transcript = result.status === 'complete' ? structuredClone(result.transcript) : { language: 'en', languages: ['en'], total_duration: 120, segments: [] };
      if (result.status === 'complete') await engine.models.diarize(resample(audio), transcript);
      const scored = speakerAgreement(w.reference, transcript, w.cues);
      // Diagnostic (V-AMI only): each segment labelled with the reference speaker it overlaps most, i.e. the
      // agreement any clustering of these segments could reach.
      const speakerIds = [...new Set(w.reference.map(u => u.speaker))], oracle = structuredClone(transcript);
      for (const s of oracle.segments) {
        const overlap = speakerIds.map(id => w.reference.filter(u => u.speaker === id).reduce((sum, u) => sum + Math.max(0, Math.min(u.endMs, s.end * 1000) - Math.max(u.startMs, s.start * 1000)), 0));
        s.speaker = overlap.indexOf(Math.max(...overlap));
      }
      const ceiling = speakerAgreement(w.reference, oracle, w.cues);
      scores.push({ meeting, agreement: scored.agreement, correct: scored.correct, units: scored.units, scorableCues: scored.scorableCues, ceilingCorrect: ceiling.correct });
      row(`V-AMI ${name}`, { status: result.status, speakerChanges: w.changes, agreement: scored.agreement, correct: scored.correct, units: scored.units, purity: scored.purity, coverage: scored.coverage, referenceSpeakers: scored.referenceSpeakers, predictedLabels: scored.predictedLabels, scorableCues: scored.scorableCues, segments: transcript.segments.length, segmentCeiling: ceiling.agreement }, 'report only (T19q round S validation)', null);
    }
  }
  const pooledOf = (xs: typeof scores) => pool(xs).agreement;
  const summary = { excerpts: scores.length, pooledAgreement: pooledOf(scores), meanAgreement: scores.reduce((s, v) => s + v.agreement, 0) / scores.length, bySeries: Object.fromEntries(VAMI_MEETINGS.map(m => [m, pooledOf(scores.filter(s => s.meeting === m))])), pooledSegmentCeiling: scores.reduce((s, v) => s + v.ceilingCorrect, 0) / scores.reduce((s, v) => s + v.units, 0), speakerModel: MODEL_IDS.speaker };
  const baselineFile = option('--baseline');
  if (!baselineFile) { row('V-AMI summary', summary, 'report only; pass --baseline <report.json> to apply the validation rule', null); return; }
  const base = (await json<{ rows: Row[] }>(baselineFile)).rows.find(r => r.item === 'V-AMI summary' || r.item === 'V-AMI validation')!.measured as typeof summary;
  row('V-AMI validation', { ...summary, baseline: baselineFile, baselinePooledAgreement: base.pooledAgreement, pass: summary.pooledAgreement >= base.pooledAgreement + 0.02 }, 'pre-registered (T19q round S): V-AMI pooled agreement >= baseline + .02 (with V-SPK mean agreement >= its baseline, part spk-validation)', null);
}
async function libriChecks() {
  const root = option('--libri-cache', path.join(process.env.LOCALAPPDATA!, 'Cutframe/analysis-cache'))!, manifest = await json('datasets/manifest.json');
  const dataset = manifest.datasets.find((d: any) => d.id === 'T19a-LibriSpeech');
  if (!dataset) throw Error('Register the downloaded LibriSpeech subset before use');
  for (const f of dataset.files) { const file = path.join(root, f.path); if ((await stat(file)).size !== f.bytes || await sha256(file) !== f.sha256) throw Error(`LibriSpeech mismatch: ${f.path}`); }
  let errors = 0, referenceWords = 0;
  for (const f of dataset.files.filter((f: any) => f.path.endsWith('.flac'))) {
    const file = path.join(root, f.path), id = path.basename(file, '.flac'), chapter = id.split('-').slice(0, 2).join('-');
    const truth = (await readFile(path.join(path.dirname(file), chapter + '.trans.txt'), 'utf8')).split(/\r?\n/).find(line => line.startsWith(id + ' '))!.slice(id.length + 1).split(' ');
    const audio = pcm(file), result = await timed('LibriSpeech ASR', id, audio.data[0].length / audio.sampleRate, () => engine.transcribe(audio, 'en'));
    const score = normalizedWer(truth, result.status === 'complete' ? wordsOf(result.transcript).map(w => w.word) : []);
    errors += score.errors; referenceWords += score.referenceWords;
    row(`LibriSpeech ${id}`, { wer: score.wer, errors: score.errors, referenceWords: score.referenceWords }, 'report WER, no numeric gate specified', true);
  }
  row('LibriSpeech subset WER', { utterances: dataset.files.filter((f: any) => f.path.endsWith('.flac')).length, errors, referenceWords, wer: errors / referenceWords }, 'report, deterministic ten-speaker subset (not full test-clean)', true);
}
/** T3 music bed: Big Buck Bunny film audio (CC BY 3.0, Blender Foundation), the V-FS source download. */
const BBB_SHA256 = '738e2f999860553d056dd79c952f58f63cbb73892a57c72342ce9e5330d9d2d7', BBB_BYTES = 121283919;
const ASR_ROW_GATE = 'report only (round T validation)';
async function verifyCached(root: string, manifest: any, ids: string[]) {
  for (const id of ids) {
    const dataset = manifest.datasets.find((d: any) => d.id === id);
    if (!dataset) throw Error(`Register ${id} before use`);
    for (const f of dataset.files) { const file = path.join(root, f.path); if ((await stat(file)).size !== f.bytes || await sha256(file) !== f.sha256) throw Error(`${id} mismatch: ${f.path}`); }
  }
}
/** The registered utterances in V-ASR's order. */
const libriFiles = (root: string, manifest: any): string[] => manifest.datasets.find((d: any) => d.id === 'T19a-LibriSpeech').files.map((f: any) => path.join(root, f.path)).filter((f: string) => f.endsWith('.flac')).sort((a: string, b: string) => path.basename(a).localeCompare(path.basename(b)));
async function libriTruth(file: string) {
  const id = path.basename(file, '.flac'), chapter = id.split('-').slice(0, 2).join('-');
  return (await readFile(path.join(path.dirname(file), chapter + '.trans.txt'), 'utf8')).split(/\r?\n/).find(line => line.startsWith(id + ' '))!.slice(id.length + 1).split(' ');
}
/** `V-ASR summary`, or with `--baseline <report.json>` the pre-registered rule. */
async function asrVerdictRow(summary: AsrSummary) {
  const baselineFile = option('--baseline');
  if (!baselineFile) { row('V-ASR summary', summary, 'report only; pass --baseline <report.json> to apply the validation rule', null); return; }
  const base = (await json<{ rows: Row[] }>(baselineFile)).rows.find(r => r.item === 'V-ASR summary' || r.item === 'V-ASR validation')!.measured as AsrSummary;
  row('V-ASR validation', asrVerdict(summary, baselineFile, base), 'pre-registered (T19 round T3): V-ASR WER strictly falls on at least one of snr5, music5 and music0 and rises on none of clean, snr5, music5 and music0; every hypothesis word count within 10 % of the reference', null);
}
/** No model (T19q Q8): every stored `V-ASR <id>` row of `--report <report.json>` re-scored from its stored text. The stored
 * word counts, gates and summary fields stay; the rows and the rule are V-ASR's. */
async function asrRejudge() {
  const reportFile = option('--report');
  if (!reportFile) throw Error('--report <report.json> names the stored V-ASR run');
  const root = option('--cache', path.join(process.env.LOCALAPPDATA!, 'Cutframe/analysis-cache'))!, manifest = await json('datasets/manifest.json');
  await verifyCached(root, manifest, ['T19a-LibriSpeech']);
  const stored = (await json<{ rows: Row[] }>(reportFile)).rows, files = libriFiles(root, manifest), totals = asrTotals();
  for (const file of files) {
    const id = path.basename(file, '.flac'), storedRow = stored.find(r => r.item === `V-ASR ${id}`);
    if (!storedRow) throw Error(`The stored report has no row for ${id}`);
    row(`V-ASR ${id}`, rejudgeAsrRow(storedRow.measured as Record<string, any>, await libriTruth(file), totals), ASR_ROW_GATE, null);
  }
  const { gateFired, noRepetition, asrModel } = stored.find(r => r.item === 'V-ASR summary' || r.item === 'V-ASR validation')!.measured as AsrSummary;
  await asrVerdictRow(asrSummary(files.length, totals, gateFired, noRepetition, asrModel));
}
/** ASR changes are judged here first (T19 round T): V-ASR, the registered LibriSpeech subset clean and mixed
 * in memory at 5 dB SNR with Groove validation drums (utterance i takes performance i, both sorted by id),
 * and (T3) at 5 and 0 dB with the Big Buck Bunny score (utterance i takes the bed from 60·i s, tiled).
 * `--baseline <report.json>` applies the pre-registered rule. */
async function asrValidation() {
  const root = option('--cache', path.join(process.env.LOCALAPPDATA!, 'Cutframe/analysis-cache'))!, manifest = await json('datasets/manifest.json');
  await verifyCached(root, manifest, ['T19a-LibriSpeech', 'T19a-Groove-validation']);
  const files = libriFiles(root, manifest);
  const drumDir = path.join(root, 'datasets/t19a/groove-validation'), drums = (await json(path.join(drumDir, 'validation-set.json'))).performances.sort((a: any, b: any) => a.id.localeCompare(b.id));
  const bbbFile = path.join(root, 'datasets/t19/sources/bbb/extract/BigBuckBunny_640x360.m4v');
  if ((await stat(bbbFile)).size !== BBB_BYTES || await sha256(bbbFile) !== BBB_SHA256) throw Error('Big Buck Bunny source mismatch');
  const bed = resample(pcm(bbbFile, true));
  const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  // Noise at `snr` dB by whole-utterance RMS; a mix that clips is scaled to 0.999 peak.
  const mixAt = (speech: Float32Array, noise: Float32Array, snr: number) => {
    const gain = rms(speech) / (rms(noise) * 10 ** (snr / 20)), mix = speech.map((v, k) => v + gain * noise[k]), peak = mix.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (peak > 1) mix.forEach((v, k) => { mix[k] = v * 0.999 / peak; });
    return { mix, scaled: peak > 1 };
  };
  const totals = asrTotals(), gateFired = Object.fromEntries(ASR_CONDITIONS.map(c => [c, 0])) as Record<AsrCondition, number>;
  let noRepetition = true;
  for (const [i, file] of files.entries()) {
    const id = path.basename(file, '.flac'), truth = await libriTruth(file);
    const speech = pcm(file).data[0], drum = resample(pcm(path.join(drumDir, drums[i].audio_filename), true)), noise = new Float32Array(speech.length).map((_, k) => drum[k % drum.length]);
    const music = new Float32Array(speech.length).map((_, k) => bed[(60 * 16000 * i + k) % bed.length]);
    const mixes = { clean: { mix: speech, scaled: false }, snr5: mixAt(speech, noise, 5), music5: mixAt(speech, music, 5), music0: mixAt(speech, music, 0) };
    const measured: Record<string, unknown> = { drums: drums[i].id, musicFrom: 60 * i, referenceWords: truth.length };
    for (const name of ASR_CONDITIONS) {
      const samples = mixes[name].mix, fired = (await engine.models.classify(samples)).isMusic;
      const result = await timed('V-ASR', `${id} ${name}`, samples.length / 16000, () => engine.transcribe({ sampleRate: 16000, channels: 1, data: [samples] }, 'en'));
      const words = result.status === 'complete' ? wordsOf(result.transcript).map(w => w.word) : [], score = normalizedWer(truth, words);
      const repeats = Math.abs(words.length - truth.length) > 0.1 * truth.length;
      if (repeats) noRepetition = false;
      if (fired) gateFired[name]++;
      totals[name].errors += score.errors; totals[name].words += score.referenceWords;
      measured[name] = { wer: score.wer, errors: score.errors, words: words.length, withinTenPercent: !repeats, musicGate: fired, scaled: mixes[name].scaled, text: words.join(' ') };
    }
    row(`V-ASR ${id}`, measured, ASR_ROW_GATE, null);
  }
  await asrVerdictRow(asrSummary(files.length, totals, gateFired, noRepetition, MODEL_IDS.whisper));
}
/** Parts that read stored reports only: no engine is constructed and no model loads. */
const REJUDGE_PARTS = new Map([['asr-rejudge', asrRejudge], ['tr-rejudge', trRejudge]]);
async function rejudgePart(action: () => Promise<void>) {
  console.log(`Starting ${part}`);
  try { await action(); } catch (error) { row(`${part} runner`, { error: (error as Error).message, stack: (error as Error).stack }, 'stored reports and required data read', false); }
  await save('report.json', { command, rows, rtf, backends: {} });
}
async function engineParts() {
  if (!store) throw Error('CUTFRAME_FIXTURES absent; store-only tests must skip in CI, this explicit scorer requires it');
  await verifyFixtures(store);
  const root = option('--models', path.join(store, 'models/t19a'))!;
  // The beat parts load only BeatThis fold0 (T19q B4); the validation part also checks its held-out folds.
  await verifyModels(root, part === 'beats' || part === 'validation' ? 'T19a-beat-this-fold0' : undefined);
  engine = new AnalysisEngine({ modelRoot: root, device: 'cpu' });
  try {
    const classificationChecks = async () => {
      // D24 (Q10): the gates stay as they are, with Author's label.
      console.log(JSON.stringify({ classificationGates: { isMusic: 'music >= 0.2', hasVocals: 'speech >= 0.1 || singing >= 0.05' }, label: 'set with the fixtures in view; re-check on new clips later' }));
      for (const clip of [...clips, 'song-eternity-arcade-lost-in-a-dream-60s']) {
        const audio = pcm(path.join(store!, 'corpus', clip + '.mp4')), result = await engine.models.classify(audio.data[0]);
        console.log(JSON.stringify({ clip, isMusic: result.isMusic, hasVocals: result.hasVocals, labels: result.labels.slice(0, 12), vocalLabels: result.labels.filter(r => /speech|singing|vocal|choir|rapping|conversation/i.test(r.label)).slice(0, 10) }));
      }
    };
    for (const [name, action] of [['transcript', transcriptChecks], ['beats', beatChecks], ['footage', footageChecks], ['sync', syncChecks], ['libri', libriChecks], ['classify', classificationChecks], ['validation', beatValidation], ['fs-validation', footageValidation], ['spk-validation', speakerValidation], ['ami-validation', amiValidation], ['asr-validation', asrValidation], ['dialogue', dialogueChecks], ['human-speakers', amiSpeakers]] as const) if (part === name || (part === 'all' && !['classify', 'validation', 'fs-validation', 'spk-validation', 'ami-validation', 'asr-validation', 'dialogue', 'human-speakers'].includes(name))) {
      console.log(`Starting ${name}`);
      try { await action(); } catch (error) { row(`${name} runner`, { error: (error as Error).message, stack: (error as Error).stack }, 'engine and required data execute', false); }
      await save('report.json', { command, rows, rtf, backends: engine.models.backends });
    }
  } finally { await engine.models.dispose(); }
  await save('report.json', { command, rows, rtf, backends: engine.models.backends });
}
async function main() {
  const rejudge = REJUDGE_PARTS.get(part);
  await (rejudge ? rejudgePart(rejudge) : engineParts());
  console.log(`T19a: ${rows.filter(r => r.status === 'pass').length} pass, ${rows.filter(r => r.status === 'fail').length} fail, ${rows.filter(r => r.status === 'uncompared').length} uncompared`);
  if (rows.some(r => r.status === 'fail')) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
