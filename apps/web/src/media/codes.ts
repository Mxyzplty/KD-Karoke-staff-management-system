// SPDX-License-Identifier: AGPL-3.0-only
// T14 error codes (error codes §12 ingest forms, §13). Messages in quotes are interface facts from our docs.
import { StoreError } from '../store/model';

export type Category = 'precondition' | 'user_error' | 'system_error' | 'timeout';
type Row = { category: Category; message: string; recovery?: 'retry' | 'user_fixable' | 'our_bug' };
export const MEDIA_CODES = {
  // §12 categories are documented; their ingest forms are raised here (export forms are T16).
  UNSUPPORTED_INPUT: { category: 'system_error', message: 'This file’s format could not be recognised.', recovery: 'our_bug' },
  DECODE_ERROR: { category: 'system_error', message: 'Cutframe could not read one of the source clips.', recovery: 'our_bug' },
  PROXY_TIMEOUT: { category: 'timeout', message: 'Preparing the footage timed out. Try it again in a moment.', recovery: 'retry' },
  WORKSPACE_FILE_MISSING: { category: 'system_error', message: 'A working file was lost part-way.', recovery: 'our_bug' },
  UPLOAD_FAILED: { category: 'system_error', message: 'The file could not be stored. Try the upload again.', recovery: 'retry' },
  // §13 has no category column: the categories below are our stated choice (notes, error-code table).
  UPLOAD_INTERRUPTED: { category: 'system_error', message: 'Upload was interrupted before it finished. Re-upload this file.', recovery: 'user_fixable' },
  SOURCE_FILE_UNREADABLE: { category: 'user_error', message: 'A file could no longer be read. Pick it again.', recovery: 'user_fixable' },
  UPLOAD_CANCELLED: { category: 'user_error', message: 'Upload cancelled', recovery: 'retry' },
  PROJECT_NOT_FOUND: { category: 'precondition', message: 'The project for this upload was deleted', recovery: 'user_fixable' },
  CLIENT_PREPARATION_TIMEOUT: { category: 'timeout', message: 'Video preparation took too long. Retry this file to continue.', recovery: 'retry' },
  CLIENT_PREPARATION_CANCELLED: { category: 'user_error', message: 'Video preparation was interrupted. Retry this file to continue.', recovery: 'retry' },
  CLIENT_PREPARATION_INTERRUPTED: { category: 'system_error', message: 'Preparation stopped on your device. Retry using the original file.', recovery: 'retry' },
  LOCAL_PREPARATION_CONTROL_FAILED: { category: 'system_error', message: 'The preparation progress record could not be written.', recovery: 'retry' },
  LOCAL_PREPARATION_PUBLICATION_FAILED: { category: 'system_error', message: 'The prepared files could not be recorded.', recovery: 'retry' },
  LOCAL_PREPARATION_SOURCE_CHANGED: { category: 'precondition', message: 'This original changed in another session. Preparation was stopped; retry the current original.', recovery: 'retry' },
  LOCAL_PREPARATION_ATTEMPT_CHANGED: { category: 'system_error', message: 'Another preparation attempt took over this file.', recovery: 'retry' },
  LOCAL_PREPARATION_ATTEMPT_FINISHED: { category: 'system_error', message: 'This preparation attempt was already closed.', recovery: 'retry' },
  LOCAL_PREPARATION_ALREADY_ACTIVE: { category: 'precondition', message: 'Another preparation is already running for this file.', recovery: 'retry' },
  UPLOAD_NETWORK_ERROR: { category: 'system_error', message: 'The download failed because of a network error.', recovery: 'retry' },
  DEMUX_UNSUPPORTED: { category: 'system_error', message: 'The container could not be read.', recovery: 'user_fixable' },
  DECODE_UNSUPPORTED: { category: 'system_error', message: 'The codec cannot be decoded in this browser.', recovery: 'user_fixable' },
  ENCODE_FAILED: { category: 'system_error', message: 'The on-device proxy encode failed.', recovery: 'retry' },
  EXTRACTION_FAILED: { category: 'system_error', message: 'Preparation failed; the original file is used instead.', recovery: 'retry' },
  WORKSPACE_ORIGINAL_MISMATCH: { category: 'user_error', message: 'This file has different contents from the original. Select the original file, or import it as a new asset.', recovery: 'user_fixable' },
  CORRUPT_FILE: { category: 'user_error', message: 'Corrupt or incomplete file — re-export and re-upload.', recovery: 'user_fixable' },
  OBJECT_MISSING: { category: 'system_error', message: 'Original file is missing from storage.', recovery: 'user_fixable' },
  SOURCE_MISSING: { category: 'system_error', message: 'Upload never finished — please re-upload this file.', recovery: 'user_fixable' },
  EMPTY_OBJECT: { category: 'user_error', message: 'File is empty or was cut off during upload.', recovery: 'user_fixable' },
  UNSUPPORTED_RAW: { category: 'user_error', message: 'RAW photos aren’t supported — export to JPEG or PNG.', recovery: 'user_fixable' },
  UNSUPPORTED_FORMAT: { category: 'user_error', message: 'Format not supported — export to MP4, MOV, or a standard image/audio file.', recovery: 'user_fixable' },
  RETRY_LIMIT_EXCEEDED: { category: 'system_error', message: 'Processing failed after several attempts.', recovery: 'our_bug' },
  GEMINI_FAILED: { category: 'system_error', message: 'Media analysis failed — retry to try again.', recovery: 'retry' },
  TRANSCRIPTION_FAILED: { category: 'system_error', message: 'Transcription failed — retry to try again.', recovery: 'retry' },
  // T19's search-index step (Cutframe's own; no Xapp counterpart). The engine raises EMBEDDING_FAILED with this same text.
  EMBEDDING_FAILED: { category: 'system_error', message: 'Search indexing failed — retry to try again.', recovery: 'retry' },
} satisfies Record<string, Row>;
export type MediaCode = keyof typeof MEDIA_CODES;
export class MediaError extends StoreError {
  constructor(code: MediaCode, message?: string, public details?: Record<string, unknown>) {
    const row: Row = MEDIA_CODES[code];
    super(code, message ?? row.message, row.category, row.recovery);
  }
}
export const mediaError = (code: MediaCode, message?: string, details?: Record<string, unknown>) => new MediaError(code, message, details);
/** Upload-failure classifier (§13): maps a preparation failure to the code written into last_error_code. */
export function classifyPreparation(error: unknown): MediaCode {
  const code = (error as { code?: string })?.code;
  if (code && code in MEDIA_CODES) {
    if (code === 'UNSUPPORTED_INPUT') return 'DEMUX_UNSUPPORTED';
    if (code === 'DECODE_ERROR') return 'DECODE_UNSUPPORTED';
    return code as MediaCode;
  }
  const e = error as { name?: string; message?: string };
  if (e?.name === 'AbortError') return 'CLIENT_PREPARATION_CANCELLED';
  const text = e?.message ?? String(error);
  if (/network error|failed to fetch/i.test(text)) return 'UPLOAD_NETWORK_ERROR';
  if (/moov|invalid data|unsupported or unrecognizable format|video load error/i.test(text)) return 'DEMUX_UNSUPPORTED';
  if (/codec not supported|cannot decode|unsupported codec/i.test(text)) return 'DECODE_UNSUPPORTED';
  if (/encod/i.test(text)) return 'ENCODE_FAILED';
  return 'EXTRACTION_FAILED';
}
