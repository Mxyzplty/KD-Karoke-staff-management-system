// SPDX-License-Identifier: AGPL-3.0-only
// T19 C12: which analysis capabilities have their local models. Probes each model's config file on the same-origin model
// root, so a browser without models shows "unavailable" steps instead of failing (or faking) them. Nothing is loaded here.
import { MODEL_IDS } from './model-ids';
import { AnalysisError } from './types';

export type Capability = 'analysis' | 'transcription' | 'embeddings' | 'beats';
export type Availability = Record<Capability, boolean>;
/** C12: what the user (or the agent) is told when a capability has no local models. Nothing is faked or half-done. */
export const UNAVAILABLE: Record<Capability, string> = {
  analysis: 'Visual analysis needs the local vision model, which is not installed in this browser.',
  transcription: 'Transcription needs the local speech models, which are not installed in this browser.',
  embeddings: 'Search needs the local search model, which is not installed in this browser. Nothing was searched.',
  beats: 'Beat detection needs the local sound model, which is not installed in this browser.',
};
export const unavailableError = (capability: Capability) => new AnalysisError('ANALYSIS_UNAVAILABLE', UNAVAILABLE[capability]);
/** The MODEL_IDS keys each capability loads (models.ts). Keys missing from MODEL_IDS are ignored, so a model round that
 *  adds a key must list it here. Beats need the sound classifier (music gate) and BeatThis (dense music, T19q B4).
 *  Visual analysis also needs CLIP (T19q round F8), which gives each description segment its frame vector. */
export const CAPABILITY_MODELS: Record<Capability, string[]> = {
  analysis: ['vision', 'clip'],
  transcription: ['sound', 'vad', 'whisper', 'aligner', 'speaker'],
  embeddings: ['embedding'],
  beats: ['sound', 'beats'],
};
/** BeatThis ships no config.json: its weights file is probed instead, by HEAD so the 82 MB file is not downloaded. */
const PROBE_FILE: Record<string, string> = { beats: 'beat_this_fold0.onnx' };
export async function modelAvailability(modelRoot: string, ids: Record<string, string> = MODEL_IDS, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<Availability> {
  const base = typeof location === 'undefined' ? null : new URL(modelRoot.endsWith('/') ? modelRoot : `${modelRoot}/`, location.href);
  const present = new Map<string, Promise<boolean>>();
  const probe = (key: string) => {
    const file = `${ids[key]}/${PROBE_FILE[key] ?? 'config.json'}`;
    let found = present.get(file);
    if (!found) {
      // Remote models stay disabled: a root on another origin has no models.
      if (!base || base.origin !== location.origin) found = Promise.resolve(false);
      // A static host may answer a missing file with its index page: an HTML answer counts as missing.
      else if (PROBE_FILE[key]) found = fetcher(new URL(file, base).href, { method: 'HEAD' }).then(r => r.ok && !(r.headers.get('content-type') ?? '').includes('text/html'), () => false);
      else found = fetcher(new URL(file, base).href).then(async r => {
        if (!r.ok) return false;
        // Likewise, only a JSON object counts as a config.
        try { const json: unknown = await r.json(); return !!json && typeof json === 'object'; } catch { return false; }
      }, () => false);
      present.set(file, found);
    }
    return found;
  };
  const result = {} as Availability;
  for (const [capability, keys] of Object.entries(CAPABILITY_MODELS) as [Capability, string[]][]) {
    const wanted = keys.filter(key => Object.hasOwn(ids, key));
    result[capability] = wanted.length > 0 && (await Promise.all(wanted.map(probe))).every(Boolean);
  }
  return result;
}
