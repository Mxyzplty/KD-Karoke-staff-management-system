// SPDX-License-Identifier: AGPL-3.0-only
// Upload rules (findings part 2 §25) and the allowed-folder path validator (tool contracts §3i item 57).
import { mediaError } from './codes';
import type { Asset } from '../store/model';

const VIDEO = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v'];
const IMAGE = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.svg', '.bmp', '.tiff'];
// §25 says "audio types also accepted" without a list: these are the common audio containers (stated assumption).
const AUDIO = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.weba', '.ac3', '.eac3'];
const RAW = ['.cr2', '.cr3', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw', '.x3f', '.3fr', '.iiq', '.erf', '.kdc', '.mrw', '.raw'];
export const extension = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i).toLowerCase() : ''; };
/** Kind by extension, else by MIME type; null when not video/image/audio. */
export function mediaKind(name: string, mimeType = ''): Asset['type'] | null {
  const ext = extension(name);
  if (VIDEO.includes(ext)) return 'video';
  if (IMAGE.includes(ext)) return 'image';
  if (AUDIO.includes(ext)) return 'audio';
  const kind = mimeType.split('/')[0];
  return kind === 'video' || kind === 'image' || kind === 'audio' ? kind : null;
}
export const isAllowedUpload = (name: string) => [...VIDEO, ...IMAGE, ...AUDIO].includes(extension(name));
export const acceptAttribute = [...VIDEO, ...IMAGE, ...AUDIO].join(',');
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.weba': 'audio/webm', '.ac3': 'audio/ac3', '.eac3': 'audio/eac3' };
export const mimeFor = (name: string, given = '') => given || MIME[extension(name)] || 'application/octet-stream';
/** Refusals raised before any bytes are stored. The 1-byte read proves the picked file is still readable (§13). */
export async function checkUploadable(file: File): Promise<Asset['type']> {
  if (RAW.includes(extension(file.name))) throw mediaError('UNSUPPORTED_RAW');
  const kind = isAllowedUpload(file.name) ? mediaKind(file.name, file.type) : null;
  if (!kind) throw mediaError('UNSUPPORTED_FORMAT');
  if (file.size === 0) throw mediaError('EMPTY_OBJECT');
  try { await file.slice(0, 1).arrayBuffer(); } catch { throw mediaError('SOURCE_FILE_UNREADABLE'); }
  return kind;
}
/** `<base>_<n><ext>` with the smallest free n ≥ 1, extension kept (§25). */
export function renamedName(name: string, taken: Set<string>): string {
  const ext = extension(name), base = ext ? name.slice(0, -ext.length) : name, keep = ext ? name.slice(-ext.length) : '';
  for (let n = 1; ; n++) if (!taken.has(`${base}_${n}${keep}`)) return `${base}_${n}${keep}`;
}
export type ParsedPath = { folder: string; segments: string[] };
export type PathError = { error: 'path_traversal_blocked'; message: string };
/** `<folder-name>/<sub/path>`: forward slashes only, relative, no `.` or `..` segment. Messages are §11's. */
export function parseAllowedPath(path: string): ParsedPath | PathError {
  if (path.includes('\\')) return { error: 'path_traversal_blocked', message: 'Use forward slashes only.' };
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) return { error: 'path_traversal_blocked', message: 'Path must be relative to the allowed directory.' };
  const parts = path.split('/');
  if (parts.some(p => p === '.' || p === '..')) return { error: 'path_traversal_blocked', message: 'Path cannot contain `..` or `.`.' };
  const clean = parts.filter(Boolean);
  return { folder: clean[0] ?? '', segments: clean.slice(1) };
}
