// SPDX-License-Identifier: AGPL-3.0-only
// Voice-over recorder (T13, findings §30): the microphone list (remembered choice), the mic opened with every browser
// processing step off, the 64-bar level meter (peak per band, decay ×0.85 per frame) and a MediaRecorder take at 128 kbps
// in the first supported of the §30 codec order.
export const MIC_KEY = 'cutframe:voiceover-mic', BARS = 64, DECAY = 0.85, BITRATE = 128_000;
export const MIME_ORDER = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];

export type Mic = { id: string; label: string };
/** The remembered microphone ('' = System default). */
export function savedMic(): string { try { return localStorage.getItem(MIC_KEY) ?? ''; } catch { return ''; } }
export function saveMic(id: string) { try { if (id) localStorage.setItem(MIC_KEY, id); else localStorage.removeItem(MIC_KEY); } catch { /* not remembered */ } }
/** Audio inputs; labels are empty until the page was granted the microphone once. */
export async function listMics(): Promise<Mic[]> {
  const devices = await navigator.mediaDevices?.enumerateDevices?.() ?? [];
  return devices.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default').map(d => ({ id: d.deviceId, label: d.label }));
}
/** The microphone with echo cancellation, noise suppression and auto gain off; `id` '' is the system default. */
export function openMic(id: string): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (id) audio.deviceId = { exact: id };
  return navigator.mediaDevices.getUserMedia({ audio });
}
export const closeMic = (stream: MediaStream | null) => { for (const t of stream?.getTracks() ?? []) t.stop(); };
/** The first supported type of the codec order ('' when MediaRecorder supports none of them: its own default). */
export function recordingType(supported = (t: string) => MediaRecorder.isTypeSupported(t)): string { return MIME_ORDER.find(supported) ?? ''; }
/** The take's file extension: .m4a for MP4 audio, else .weba (WebM audio; files.ts reads .webm as video). */
export const takeExtension = (type: string) => type.startsWith('audio/mp4') ? '.m4a' : '.weba';
const pad = (n: number) => String(n).padStart(2, '0');
/** "Voiceover YYYY-MM-DD HH:MM:SS" in local time. */
export const takeName = (d: Date) => `Voiceover ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
/** mm:ss of a running take. */
export const timer = (ms: number) => `${pad(Math.floor(ms / 60_000))}:${pad(Math.floor(ms / 1000) % 60)}`;

/** Live level of a stream: BARS bands of the analyser's spectrum, each its peak (0–1), falling by DECAY per frame. */
export class Meter {
  readonly levels = new Float32Array(BARS);
  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly bins: Uint8Array<ArrayBuffer>;
  constructor(stream: MediaStream) {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = BARS * 4; // BARS × 2 bins
    this.analyser.smoothingTimeConstant = 0;
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    this.ctx.createMediaStreamSource(stream).connect(this.analyser);
  }
  /** One animation frame: the new levels. */
  update(): Float32Array {
    this.analyser.getByteFrequencyData(this.bins);
    const per = this.bins.length / BARS;
    for (let b = 0; b < BARS; b++) {
      let peak = 0;
      for (let i = b * per; i < (b + 1) * per; i++) peak = Math.max(peak, this.bins[i] / 255);
      this.levels[b] = Math.max(peak, this.levels[b] * DECAY);
    }
    return this.levels;
  }
  close() { void this.ctx.close().catch(() => {}); }
}

/** One take: MediaRecorder at BITRATE; `stop` resolves to the recording and its duration (from the recorder's start). */
export class Take {
  private readonly recorder: MediaRecorder;
  private readonly parts: Blob[] = [];
  private started = NaN;
  readonly type: string;
  constructor(stream: MediaStream) {
    const type = recordingType();
    this.recorder = new MediaRecorder(stream, { ...type ? { mimeType: type } : {}, audioBitsPerSecond: BITRATE });
    this.type = this.recorder.mimeType || type || 'audio/webm';
    this.recorder.ondataavailable = e => { if (e.data.size) this.parts.push(e.data); };
  }
  start() { this.recorder.start(); this.started = performance.now(); }
  /** Milliseconds since the start. */
  elapsed() { return Number.isNaN(this.started) ? 0 : performance.now() - this.started; }
  stop(): Promise<{ blob: Blob; durationMs: number }> {
    const durationMs = this.elapsed();
    return new Promise((resolve, reject) => {
      this.recorder.onstop = () => resolve({ blob: new Blob(this.parts, { type: this.type }), durationMs });
      this.recorder.onerror = () => reject(new Error('The recording failed.'));
      if (this.recorder.state === 'inactive') resolve({ blob: new Blob(this.parts, { type: this.type }), durationMs });
      else this.recorder.stop();
    });
  }
  /** Throws the take away. */
  discard() { this.recorder.ondataavailable = null; this.recorder.onstop = null; if (this.recorder.state !== 'inactive') this.recorder.stop(); this.parts.length = 0; }
}
