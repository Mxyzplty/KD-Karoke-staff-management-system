// SPDX-License-Identifier: AGPL-3.0-only
// Codec negotiation (findings §7): the container is MP4; the video codec is probed at the real width, height, frame rate and
// bitrate. Fallbacks in order H.264 High → Main → Constrained Baseline (the final fallback stays H.264/MP4); each fallback
// is reported as a message. Audio: AAC-LC, 2 channels, 48 kHz, 192 kb/s (§44.8); when this browser cannot encode AAC-LC,
// Opus 48 kHz stereo in the MP4 with a message (Q-F, provisional); neither → the caller fails with AUDIO_FAILED.
export const AUDIO = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 } as const;
export const OPUS = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 } as const;
export const OPUS_MESSAGE = 'AAC-LC 48 kHz stereo is not supported by this browser, so the audio is Opus 48 kHz stereo in the MP4.';
export const DEFAULT_BITRATE = 20_000_000;

// H.264 Table A-1: [level_idc, max macroblocks per second, max frame size in macroblocks, max bitrate (kb/s, Baseline/Main)].
const LEVELS: [number, number, number, number][] = [
  [10, 1485, 99, 64], [11, 3000, 396, 192], [12, 6000, 396, 384], [13, 11880, 396, 768], [20, 11880, 396, 2000],
  [21, 19800, 792, 4000], [22, 20250, 1620, 4000], [30, 40500, 1620, 10000], [31, 108000, 3600, 14000], [32, 216000, 5120, 20000],
  [40, 245760, 8192, 20000], [41, 245760, 8192, 50000], [42, 522240, 8704, 50000], [50, 589824, 22080, 135000], [51, 983040, 36864, 240000],
  [52, 2073600, 36864, 240000], [60, 4177920, 139264, 240000], [61, 8355840, 139264, 480000], [62, 16711680, 139264, 800000],
];
export const PROFILES = [
  { name: 'High', idc: 0x64, constraints: 0x00, brFactor: 1.25 },
  { name: 'Main', idc: 0x4d, constraints: 0x40, brFactor: 1 },
  { name: 'Constrained Baseline', idc: 0x42, constraints: 0xe0, brFactor: 1 },
] as const;
const hex = (n: number) => n.toString(16).padStart(2, '0');
/** The lowest level that holds the frame size, macroblock rate and bitrate (the encoder's level). */
export function avcLevel(width: number, height: number, fps: number, bitrate: number, brFactor = 1.25): number {
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16), mbps = fs * fps;
  return (LEVELS.find(([, maxMbps, maxFs, maxBr]) => fs <= maxFs && mbps <= maxMbps && bitrate <= maxBr * 1000 * brFactor) ?? LEVELS[LEVELS.length - 1])[0];
}
export const avcCodec = (p: (typeof PROFILES)[number], level: number) => `avc1.${hex(p.idc)}${hex(p.constraints)}${hex(level)}`;

export type VideoTarget = { width: number; height: number; fps: number; bitrate: number };
export type Negotiated = { config: VideoEncoderConfig; profile: string; messages: string[] };
/** The first supported H.264 profile at the real settings; throws ENCODE_ERROR text when none is supported. */
export async function negotiateVideo(t: VideoTarget, supported: (c: VideoEncoderConfig) => Promise<boolean> = async c => !!(await VideoEncoder.isConfigSupported(c)).supported): Promise<Negotiated> {
  const messages: string[] = [];
  for (const p of PROFILES) {
    const config: VideoEncoderConfig = {
      codec: avcCodec(p, avcLevel(t.width, t.height, t.fps, t.bitrate, p.brFactor)), width: t.width, height: t.height, framerate: t.fps,
      bitrate: t.bitrate, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' },
    };
    if (await supported(config).catch(() => false)) return { config, profile: p.name, messages };
    messages.push(`H.264 ${p.name} is not supported by this browser at ${t.width}×${t.height}, ${t.fps} fps, ${t.bitrate / 1e6} Mb/s; trying the next profile.`);
  }
  throw new Error(`VideoEncoder: H.264 cannot be encoded at ${t.width}×${t.height} in this browser.`);
}
const encodes = async (c: AudioEncoderConfig) => typeof AudioEncoder !== 'undefined' && !!(await AudioEncoder.isConfigSupported({ ...c }).catch(() => ({ supported: false }))).supported;
/** AAC-LC stereo 48 kHz support (the audio probe). */
export const audioSupported = () => encodes(AUDIO);
/** Opus stereo 48 kHz support (the fallback probe). */
export const opusSupported = () => encodes(OPUS);
export type AudioChoice = { codec: 'aac' | 'opus'; message: string | null };
/** AAC-LC when it encodes, else Opus with OPUS_MESSAGE, else null. */
export async function negotiateAudio(aac: () => Promise<boolean> = audioSupported): Promise<AudioChoice | null> {
  if (await aac()) return { codec: 'aac', message: null };
  return await opusSupported() ? { codec: 'opus', message: OPUS_MESSAGE } : null;
}
