// SPDX-License-Identifier: AGPL-3.0-only
// T23 workspace file metadata (results §2 `workspace`, FileMeta): every command describes a file this way. `version` starts
// at 1 and grows by one per write; a generated file is always version 1. `metadata.origin` names where the file comes from.

export type Origin = 'memory' | 'template' | 'cutframe' | 'cutframe_project' | 'cutframe_catalogue';
export type FileMeta = {
  path: string; version: number; mimeType: string; bytes: number; sha256: string; readOnly: boolean;
  metadata: { origin: Origin; description: string; projectId?: string; updatedAt?: string };
};
/** A file as the tool sees it: its metadata and its text. */
export type WorkspaceFile = { meta: FileMeta; text: string };

const encoder = new TextEncoder();
export const utf8Bytes = (text: string) => encoder.encode(text).length;
/** SHA-256 of the text's UTF-8 bytes, lower-case hex. */
export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
const MIME: Record<string, string> = { md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv' };
/** The workspace holds text only; an unknown extension is plain text. */
export const mimeOf = (path: string) => MIME[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''] ?? 'text/plain';

export async function fileMeta(path: string, text: string, info: { version?: number; readOnly: boolean; metadata: FileMeta['metadata'] }): Promise<FileMeta> {
  return { path, version: info.version ?? 1, mimeType: mimeOf(path), bytes: utf8Bytes(text), sha256: await sha256Text(text), readOnly: info.readOnly, metadata: info.metadata };
}
