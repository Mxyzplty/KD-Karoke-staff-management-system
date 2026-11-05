// SPDX-License-Identifier: AGPL-3.0-only
// Export failure classes (error codes §12, findings §7 l.110): a known code wins (our texts hold user-chosen names), except
// that OOM's engine texts win over a code ranked after OOM; the text decides only when the code is missing or not in the
// table, first match in the table's order. Category is stored with the failure; kind decides the dialog (retry and
// user_fixable allow a retry, our_bug does not). Quoted texts are the documented dialog texts; rows the table only
// paraphrases ("says …") carry our own wording of that paraphrase, with Cutframe for Xapp.
import { StoreError } from '../store/model';

export type ExportCategory = 'precondition' | 'user_error' | 'system_error' | 'timeout' | 'unknown';
export type ExportKind = 'retry' | 'user_fixable' | 'our_bug';
type Row = { code: string; category: ExportCategory; kind: ExportKind; text: string; match?: (name: string, text: string) => boolean };

const has = (re: RegExp) => (_: string, text: string) => re.test(text);
export const EXPORT_FAILURES: Row[] = [
  { code: 'UNRESOLVED_MEDIA', category: 'precondition', kind: 'user_fixable', text: 'Reconnect or re-add the media before exporting.' },
  // T05 font codes (error codes l.127–129, l.415–417): set by the export's font preload, matched by code only.
  { code: 'FONT_NOT_FOUND', category: 'precondition', kind: 'user_fixable', text: 'A text uses a font that is not available. Choose another font for it, then export again.' },
  { code: 'FONT_LOAD_FAILED', category: 'system_error', kind: 'retry', text: 'A font used by a text could not be loaded. Check the connection and export again.' },
  { code: 'FONT_DELIVERY_FAILED', category: 'system_error', kind: 'retry', text: 'A font file could not be downloaded. Check the connection and export again.' },
  { code: 'FONT_TOO_LARGE', category: 'user_error', kind: 'user_fixable', text: 'An uploaded font file is over 8 MiB. Use a smaller font file, then export again.' },
  { code: 'FONT_NAME_REQUIRED', category: 'user_error', kind: 'user_fixable', text: 'An uploaded font has no name Cutframe can read. Upload it again or choose another font.' },
  { code: 'LOCAL_STORAGE_UNAVAILABLE', category: 'precondition', kind: 'retry', text: 'Browser storage could not read some files. Reopen the project and retry before relinking these files.' },
  { code: 'USER_CANCELLED', category: 'user_error', kind: 'retry', text: 'You stopped this export.', match: (name, text) => name === 'AbortError' || /^(export cancelled|cancelled by user)/i.test(text) },
  { code: 'SUPERSEDED', category: 'user_error', kind: 'retry', text: 'This export was replaced by a newer one.', match: has(/superseded by/i) },
  { code: 'MISSING_LOCAL_FILES', category: 'precondition', kind: 'user_fixable', text: 'Some files are not on this device — re-add them and export again.', match: has(/^MISSING_LOCAL_FILES:/) },
  { code: 'INVALID_MEDIA_TIMING', category: 'system_error', kind: 'our_bug', text: 'A clip is trimmed past the end of its own footage. That is a Cutframe bug; it has been logged.', match: has(/invalid media timing|trim\.to after source duration/i) },
  { code: 'NATIVE_RENDERER_CRASHED', category: 'system_error', kind: 'our_bug', text: 'The renderer crashed on this timeline. That is our bug; it has been logged.', match: has(/native renderer exited/i) },
  { code: 'CLIENT_DISCONNECTED', category: 'system_error', kind: 'retry', text: 'The tab running this export went away before it finished. Try it again.', match: has(/client_disconnected/i) },
  { code: 'CANVAS_TAINTED', category: 'system_error', kind: 'our_bug', text: 'The frames could not be read back from the canvas. That is a Cutframe bug; it has been logged.', match: (name, text) => /tainted/i.test(text) || name === 'SecurityError' && /canvas|getImageData/i.test(text) },
  { code: 'CONTAINER_CODEC_MISMATCH', category: 'user_error', kind: 'user_fixable', text: 'The chosen file format cannot hold this video codec. Export as MP4 instead.', match: has(/cannot be contained within/i) },
  { code: 'ASSETS_STILL_UPLOADING', category: 'precondition', kind: 'retry', text: 'Some clips are still uploading. This will work in a moment — try again shortly.', match: has(/^SYNCING_ASSETS:/) },
  { code: 'PROXY_TIMEOUT', category: 'timeout', kind: 'retry', text: 'Preparing the footage for export timed out. Try it again in a moment.', match: has(/(proxy|preparation|normali[sz]ed video).*timed? ?out/i) },
  { code: 'TIMEOUT', category: 'timeout', kind: 'retry', text: 'The export took longer than it is allowed to. Try it again.', match: (name, text) => name === 'TimeoutError' || /timed? ?out/i.test(text) },
  { code: 'OOM', category: 'system_error', kind: 'user_fixable', text: 'The browser ran out of memory. Close other tabs or lower the resolution, then export again.', match: has(/out of memory|allocation failed|array buffer allocation|exceeded maximum size of/i) },
  { code: 'MG_RENDER_FAILED', category: 'system_error', kind: 'our_bug', text: 'A motion graphic in this cut failed to render. That is our bug, and it has been logged.', match: has(/motion.?graphic/i) },
  { code: 'AUDIO_FAILED', category: 'system_error', kind: 'our_bug', text: 'The audio mix failed on this timeline. That is our bug; it has been logged.', match: has(/audio/i) },
  { code: 'ENCODE_ERROR', category: 'system_error', kind: 'our_bug', text: 'The finished video could not be encoded with the chosen settings.', match: (name, text) => name === 'EncodingError' || /EncodingError|VideoEncoder|error during flush/i.test(text) },
  { code: 'DECODE_ERROR', category: 'system_error', kind: 'our_bug', text: 'Cutframe could not read one of the source clips. That is on us to fix; it has been logged.', match: has(/decod|demux|no video track|unsupported (codec|config)/i) },
  { code: 'UNSUPPORTED_INPUT', category: 'system_error', kind: 'our_bug', text: 'Cutframe could not read one of the source clips. That is on us to fix; it has been logged.', match: has(/unsupported or unrecognizable format|invalid container/i) },
  { code: 'CODEC_RECLAIMED', category: 'system_error', kind: 'user_fixable', text: 'The browser took the video decoder back while the tab was in the background. Keep this tab in front while it exports.', match: has(/codec reclaimed/i) },
  { code: 'WEBGL_UNSUPPORTED', category: 'precondition', kind: 'user_fixable', text: 'WebGL is not available. Use a current Chrome, Edge or Safari with hardware acceleration on.', match: has(/webgl/i) },
  { code: 'WORKSPACE_FILE_MISSING', category: 'system_error', kind: 'our_bug', text: 'A working file was lost part-way through the export.', match: (name, text) => name === 'NotFoundError' || /indexeddb.*clos|connection is closing|file changed since|could not be found/i.test(text) },
  { code: 'STORAGE_QUOTA', category: 'system_error', kind: 'user_fixable', text: 'The disk filled up. Free about twice the estimated file size, or lower the quality, then export again.', match: (name, text) => name === 'QuotaExceededError' || name === 'NoModificationAllowedError' || /quota|NoModificationAllowedError/i.test(text) },
  { code: 'OUTPUT_STREAM_FAILED', category: 'system_error', kind: 'user_fixable', text: 'The file could not be written, almost always because the disk is full. Free some space, then export again.', match: has(/writable stream|stream (is )?errored|errored stream/i) },
  { code: 'NETWORK', category: 'system_error', kind: 'retry', text: 'The connection dropped part-way through. Try the export again.', match: has(/failed to fetch|network|cors|load failed|http [45]\d\d/i) },
  { code: 'UPLOAD_FAILED', category: 'system_error', kind: 'retry', text: 'The finished video could not be uploaded. Try the export again.', match: has(/upload failed/i) },
  { code: 'CLIENT_BUG', category: 'system_error', kind: 'our_bug', text: 'The export hit a bug in Cutframe. It has been logged.', match: has(/is not a function|is not defined|cannot read propert|assertion failed|disposed|lock broken/i) },
];
const UNKNOWN: Row = { code: 'UNKNOWN', category: 'unknown', kind: 'our_bug', text: 'The reason for this failure is not recognised yet. It has been logged and a person will look at it.' };

export type ExportFailure = { code: string; category: ExportCategory; kind: ExportKind; message: string; detail: string };
/** An export error with a known code (prechecks, timing, sinks); `detail` is the specific text (file names, issues). */
export class ExportError extends StoreError {
  constructor(code: string, public detail: string, public data?: Record<string, unknown>) {
    const row = EXPORT_FAILURES.find(r => r.code === code) ?? UNKNOWN;
    super(code, detail, row.category, row.kind);
  }
}
const OOM = EXPORT_FAILURES.findIndex(r => r.code === 'OOM');
/** A known code wins over every row's text, except that OOM's engine texts win over a code ranked after OOM (the table's
 *  order already gave them that); a missing or unknown code: the first row whose text matches, in the table's order. */
export function classifyExportError(error: unknown): ExportFailure {
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | null, code = typeof e?.code === 'string' ? e.code : '';
  const name = typeof e?.name === 'string' ? e.name : '', text = typeof e?.message === 'string' ? e.message : String(error);
  const i = EXPORT_FAILURES.findIndex(r => r.code === code);
  const row = i < 0 ? EXPORT_FAILURES.find(r => r.match?.(name, text)) ?? UNKNOWN : EXPORT_FAILURES[i > OOM && EXPORT_FAILURES[OOM].match!(name, text) ? OOM : i];
  return { code: row.code, category: row.category, kind: row.kind, message: row.text, detail: text };
}
