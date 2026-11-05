// SPDX-License-Identifier: AGPL-3.0-only
// T16a export failure classes (apps/web/src/export/errors.ts). Oracle: "written-spec oracle" = error codes §12 / findings §7 l.110:
// the failure is classified from the error's code, or from its text when the code is missing or not in the table (a known code wins
// over any row's text match; among text matches the first in the table's order wins); category and kind are stored
// with it (retry and user_fixable allow a retry, our_bug does not). Classes that have a real trigger in the browser are exercised
// end to end in tests/ui/t16a-failures.spec.ts; the classes below have none in T16a, each title says why. MG_RENDER_FAILED is in
// tests/ui/t16a-render.spec.ts. Exception: the T10 Pending rows (WEBGL_UNSUPPORTED, CANVAS_TAINTED) do have a trigger since cdc5af4
// (the Pending returned by composite() fails the export with that code); they are checked by classifier only here, because the test
// browser has WebGL2 and every source is a local blob.
import { describe, expect, it } from 'vitest';
import { classifyExportError, EXPORT_FAILURES, ExportError } from '../apps/web/src/export/errors';

const err = (message: string, name = 'Error', code?: string) => Object.assign(new Error(message), { name, ...(code ? { code } : {}) });
const of = (e: unknown) => classifyExportError(e).code;

describe('T16a classifier-only classes (no browser path in T16a)', () => {
  it('NATIVE_RENDERER_CRASHED: no native renderer in T16a, classified from "native renderer exited"', () => {
    expect(classifyExportError(err('The native renderer exited with code 139.'))).toMatchObject({ code: 'NATIVE_RENDERER_CRASHED', category: 'system_error', kind: 'our_bug' });
  });
  it('CLIENT_DISCONNECTED: no server session in T16a, classified from "client_disconnected"', () => {
    expect(classifyExportError(err('CLIENT_DISCONNECTED while rendering'))).toMatchObject({ code: 'CLIENT_DISCONNECTED', category: 'system_error', kind: 'retry' });
  });
  it('UPLOAD_FAILED: no upload in T16a, classified from its code (its text "upload failed" contains "load failed", which the earlier NETWORK row takes: reported to the coordinator)', () => {
    expect(classifyExportError(err('x', 'Error', 'UPLOAD_FAILED'))).toMatchObject({ code: 'UPLOAD_FAILED', category: 'system_error', kind: 'retry' });
  });
  it('documented order effect (§12, first match wins, NETWORK before UPLOAD_FAILED): the message upload failed alone classifies as NETWORK, because it contains the Safari text load failed', () => {
    expect(of(err('Upload failed'))).toBe('NETWORK');
  });
  it('NETWORK: no server in T16a, classified from "failed to fetch"', () => {
    expect(classifyExportError(err('Failed to fetch', 'TypeError'))).toMatchObject({ code: 'NETWORK', category: 'system_error', kind: 'retry' });
    expect(of(err('net::ERR_FAILED CORS policy'))).toBe('NETWORK');
    expect(of(err('HTTP 503 from upstream'))).toBe('NETWORK');
  });
  it('CANVAS_TAINTED: the export\'s own getImageData read-back cannot taint (every source is a local blob); T10\'s effect-stage CANVAS_TAINTED is the row below; classified from "tainted" and from a SecurityError on getImageData', () => {
    expect(classifyExportError(err('The canvas has been tainted by cross-origin data.'))).toMatchObject({ code: 'CANVAS_TAINTED', kind: 'our_bug' });
    expect(of(err('Failed to execute getImageData on OffscreenCanvasRenderingContext2D', 'SecurityError'))).toBe('CANVAS_TAINTED');
    expect(of(err('Blocked a frame with origin', 'SecurityError'))).not.toBe('CANVAS_TAINTED');
  });
  it('CONTAINER_CODEC_MISMATCH: MP4 with H.264 only in T16a, classified from "cannot be contained within"', () => {
    expect(classifyExportError(err('Codec vp9 cannot be contained within the mp4 format.'))).toMatchObject({ code: 'CONTAINER_CODEC_MISMATCH', category: 'user_error', kind: 'user_fixable' });
  });
  it('PROXY_TIMEOUT: the export reads originals and never waits for a proxy; classified before TIMEOUT', () => {
    expect(classifyExportError(err('Proxy generation timed out'))).toMatchObject({ code: 'PROXY_TIMEOUT', category: 'timeout', kind: 'retry' });
    expect(of(err('Normalized video preparation timed out.'))).toBe('PROXY_TIMEOUT');
    expect(of(err('Frame decoding timed out after 30 s.'))).toBe('TIMEOUT');
  });
  it('OOM: cannot be forced reliably in a browser, classified from the engine texts', () => {
    expect(classifyExportError(err('Out of memory'))).toMatchObject({ code: 'OOM', kind: 'user_fixable' });
    expect(of(err('Array buffer allocation failed', 'RangeError'))).toBe('OOM');
    expect(of(err('Invalid typed array length: exceeded maximum size of 2 GB', 'RangeError'))).toBe('OOM');
  });
  it('CODEC_RECLAIMED: the browser takes the decoder when the tab is in the background; cannot be forced reliably', () => {
    expect(classifyExportError(err('Codec reclaimed due to inactivity.', 'QuotaExceededError'))).toMatchObject({ code: 'CODEC_RECLAIMED', kind: 'user_fixable' });
  });
  it('WEBGL_UNSUPPORTED: the 2D path needs no WebGL; the export raises it only through T10\'s effect stage (row below); classified from "webgl"', () => {
    expect(classifyExportError(err('WebGL2 is not supported'))).toMatchObject({ code: 'WEBGL_UNSUPPORTED', category: 'precondition', kind: 'user_fixable' });
  });
  // Fix round 1 (b): the pipeline fails the export with T10's Pending code and T10's message (render/effects.ts EFFECT_FAILURES) as an
  // ExportError. The test browser has WebGL2, so only the classifier is checked: the code must survive T10's own text, whichever row's
  // regex could match it first.
  it('T10 Pending WEBGL_UNSUPPORTED: an ExportError carrying T10\'s message classifies as WEBGL_UNSUPPORTED / precondition / user_fixable', () => {
    const t10 = 'This browser has neither WebGL2 nor WebGPU. Use a current Chrome, Edge or Safari with hardware acceleration on. (item it_1)';
    const f = classifyExportError(new ExportError('WEBGL_UNSUPPORTED', t10));
    expect(f).toMatchObject({ code: 'WEBGL_UNSUPPORTED', category: 'precondition', kind: 'user_fixable', detail: t10 });
  });
  it('T10 Pending CANVAS_TAINTED: an ExportError carrying T10\'s message classifies as CANVAS_TAINTED / system_error / our_bug', () => {
    const t10 = 'The frame could not be read back: a cross-origin picture tainted the canvas. That is our bug. (item it_1)';
    const f = classifyExportError(new ExportError('CANVAS_TAINTED', t10));
    expect(f).toMatchObject({ code: 'CANVAS_TAINTED', category: 'system_error', kind: 'our_bug', detail: t10 });
  });
  it('UNKNOWN: the fallback for anything no row matches (also for non-Error values)', () => {
    expect(classifyExportError(err('something nobody has seen'))).toMatchObject({ code: 'UNKNOWN', category: 'unknown', kind: 'our_bug' });
    for (const v of ['a plain string', null, undefined, 42, {}]) expect(of(v)).toBe('UNKNOWN');
  });
});

describe('T16a classification of the classes that have a real trigger (the unit side; the trigger itself is in t16a-failures.spec.ts)', () => {
  it('USER_CANCELLED from an AbortError or "Export cancelled by user"; SUPERSEDED from "superseded by"', () => {
    expect(of(err('aborted', 'AbortError'))).toBe('USER_CANCELLED');
    expect(of(err('Export cancelled by user'))).toBe('USER_CANCELLED');
    expect(of(err('Export superseded by a newer export render_1'))).toBe('SUPERSEDED');
  });
  it('an error with a known code is classified by the code (the text decides only when the code is missing or not in the table)', () => {
    expect(of(err('x', 'Error', 'STORAGE_QUOTA'))).toBe('STORAGE_QUOTA');
    expect(of(new ExportError('MISSING_LOCAL_FILES', 'x'))).toBe('MISSING_LOCAL_FILES');
  });
  // Fix round 3 (freeze 7): a known code wins over an earlier row's text match. The names in the texts are user data (a graphic or a file
  // called "Time out", "tainted network.mp4") and must not change the class.
  it('a known code beats an earlier row\'s text match: a motion graphic named "Time out" is MG_RENDER_FAILED, not TIMEOUT', () => {
    const t = (name: string) => `Motion graphic '${name}' (mg_1) could not be rendered: COMPILATION_ERROR: compilation error: Unexpected token (3:4)`;
    expect(of(new ExportError('MG_RENDER_FAILED', t('Time out')))).toBe('MG_RENDER_FAILED');
  });
  it('a known code beats an earlier row\'s text match: a motion graphic named "Tainted love" is MG_RENDER_FAILED, not CANVAS_TAINTED', () => {
    const t = (name: string) => `Motion graphic '${name}' (mg_1) could not be rendered: COMPILATION_ERROR: compilation error: Unexpected token (3:4)`;
    expect(of(new ExportError('MG_RENDER_FAILED', t('Tainted love')))).toBe('MG_RENDER_FAILED');
  });
  it('a known code beats an earlier row\'s text match: ASSETS_STILL_UPLOADING for a file named "tainted network.mp4" (CANVAS_TAINTED\'s row is earlier)', () => {
    expect(of(new ExportError('ASSETS_STILL_UPLOADING', "SYNCING_ASSETS: 'tainted network.mp4'"))).toBe('ASSETS_STILL_UPLOADING');
  });
  it('a known code beats an earlier row\'s text match: MISSING_LOCAL_FILES for a file named "superseded by v2.mp4" (SUPERSEDED\'s row is earlier)', () => {
    expect(of(new ExportError('MISSING_LOCAL_FILES', "MISSING_LOCAL_FILES: 'superseded by v2.mp4' isn't on this device — re-add it and export again."))).toBe('MISSING_LOCAL_FILES');
  });
  // Freeze 7 round 2: OOM's text rule still wins over a code ranked after OOM in EXPORT_FAILURES (as the table's order gave it), because
  // the engine's out-of-memory text is the real cause whichever stage wrapped it; a code ranked before OOM still wins over an OOM text.
  it('OOM exception: a coded DECODE_ERROR whose text is an allocation failure is OOM', () => {
    expect(of(new ExportError('DECODE_ERROR', 'Array buffer allocation failed'))).toBe('OOM');
  });
  it('OOM exception: a coded AUDIO_FAILED whose text is an allocation failure is OOM', () => {
    expect(of(new ExportError('AUDIO_FAILED', 'Audio mix failed: Array buffer allocation failed'))).toBe('OOM');
  });
  it('OOM does not beat every code: UNRESOLVED_MEDIA for a file named "out of memory.mp4" stays UNRESOLVED_MEDIA (a user\'s file name must not win over a precheck code)', () => {
    expect(of(new ExportError('UNRESOLVED_MEDIA', "Reconnect or re-add the media for 'out of memory.mp4' before exporting."))).toBe('UNRESOLVED_MEDIA');
  });
  it('without a code, or with a code that is not in the table, the text decides: first match in the table\'s order', () => {
    expect(of(err("Motion graphic 'Time out' could not be rendered"))).toBe('TIMEOUT');
    expect(of(err('Frame decoding timed out after 30 s.', 'Error', 'NOT_A_CLASS'))).toBe('TIMEOUT');
  });
  it('MISSING_LOCAL_FILES / ASSETS_STILL_UPLOADING from their prefixes', () => {
    expect(of(err('MISSING_LOCAL_FILES: a.mp4 isn\'t on this device'))).toBe('MISSING_LOCAL_FILES');
    expect(of(err('SYNCING_ASSETS: a.mp4'))).toBe('ASSETS_STILL_UPLOADING');
  });
  it('INVALID_MEDIA_TIMING from the texts "invalid media timing" and "trim.to after source duration"', () => {
    expect(of(err('Invalid media timing: x has trim.to before trim.from'))).toBe('INVALID_MEDIA_TIMING');
    expect(of(err('x has trim.to after source duration (5ms > 4ms)'))).toBe('INVALID_MEDIA_TIMING');
  });
  it('TIMEOUT from a TimeoutError or "timed out"', () => {
    expect(of(err('x', 'TimeoutError'))).toBe('TIMEOUT');
    expect(of(err('Frame decoding timed out after 30 s.'))).toBe('TIMEOUT');
  });
  it('AUDIO_FAILED, ENCODE_ERROR, DECODE_ERROR, UNSUPPORTED_INPUT from their texts', () => {
    expect(of(err('Audio mix failed: boom'))).toBe('AUDIO_FAILED');
    expect(of(err('VideoEncoder error: x'))).toBe('ENCODE_ERROR');
    expect(of(err('x', 'EncodingError'))).toBe('ENCODE_ERROR');
    expect(of(err('VideoEncoder: H.264 cannot be encoded at 64×36 in this browser.'))).toBe('ENCODE_ERROR');
    expect(of(err('No video track found in this file'))).toBe('DECODE_ERROR');
    expect(of(err('Unsupported or unrecognizable format'))).toBe('UNSUPPORTED_INPUT');
  });
  it('WORKSPACE_FILE_MISSING from a NotFoundError; STORAGE_QUOTA from a QuotaExceededError; OUTPUT_STREAM_FAILED from a writable-stream error', () => {
    expect(of(err('x', 'NotFoundError'))).toBe('WORKSPACE_FILE_MISSING');
    expect(of(err('x', 'QuotaExceededError'))).toBe('STORAGE_QUOTA');
    expect(of(err('Writing the export failed (errored writable stream): x'))).toBe('OUTPUT_STREAM_FAILED');
  });
  it('CLIENT_BUG from "is not a function" and similar', () => {
    expect(of(err('x is not a function', 'TypeError'))).toBe('CLIENT_BUG');
    expect(of(err('The export has no frames (empty composition).', 'Error', 'CLIENT_BUG'))).toBe('CLIENT_BUG');
  });
  it('first match wins, in the table\'s order: audio text beats decode text, timeout beats decode', () => {
    expect(of(err('audio decode failed'))).toBe('AUDIO_FAILED');
    expect(of(err('decoder timed out'))).toBe('TIMEOUT');
  });
});

describe('T16a failure table shape', () => {
  it('every class appears once, with a category, a kind and a dialog text', () => {
    const codes = EXPORT_FAILURES.map(r => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of EXPORT_FAILURES) {
      expect(['precondition', 'user_error', 'system_error', 'timeout', 'unknown']).toContain(r.category);
      expect(['retry', 'user_fixable', 'our_bug']).toContain(r.kind);
      expect(r.text.length).toBeGreaterThan(10);
    }
  });
  it('the §12 classes of the ticket are all present', () => {
    const want = ['UNRESOLVED_MEDIA', 'LOCAL_STORAGE_UNAVAILABLE', 'USER_CANCELLED', 'SUPERSEDED', 'MISSING_LOCAL_FILES', 'INVALID_MEDIA_TIMING', 'NATIVE_RENDERER_CRASHED',
      'CLIENT_DISCONNECTED', 'CANVAS_TAINTED', 'CONTAINER_CODEC_MISMATCH', 'ASSETS_STILL_UPLOADING', 'PROXY_TIMEOUT', 'TIMEOUT', 'OOM', 'AUDIO_FAILED', 'ENCODE_ERROR',
      'DECODE_ERROR', 'UNSUPPORTED_INPUT', 'CODEC_RECLAIMED', 'WEBGL_UNSUPPORTED', 'WORKSPACE_FILE_MISSING', 'STORAGE_QUOTA', 'OUTPUT_STREAM_FAILED', 'NETWORK', 'UPLOAD_FAILED', 'CLIENT_BUG'];
    for (const c of want) expect(EXPORT_FAILURES.map(r => r.code), c).toContain(c);
  });
  it('an ExportError carries its class category and kind, and the specific text as detail; an unknown code becomes UNKNOWN\'s class', () => {
    const e = new ExportError('MISSING_LOCAL_FILES', 'a.mp4 gone', { x: 1 });
    expect(e).toMatchObject({ code: 'MISSING_LOCAL_FILES', category: 'precondition', recovery: 'user_fixable', detail: 'a.mp4 gone', data: { x: 1 } });
    expect(e.message).toBe('a.mp4 gone');
    expect(new ExportError('NOT_A_CLASS', 'x')).toMatchObject({ category: 'unknown', recovery: 'our_bug' });
  });
  it('classifyExportError returns the dialog text as message and the original text as detail', () => {
    const f = classifyExportError(err('Export cancelled by user'));
    expect(f.message).toBe('You stopped this export.');
    expect(f.detail).toBe('Export cancelled by user');
  });
});
