// SPDX-License-Identifier: AGPL-3.0-only
// T23 memory store (contracts §1 "memory discipline"; findings part 2 §42: a local, user-visible notes store the agent may
// write to, off by default). Two rows of the IndexedDB `settings` store, so T21's Delete local data wipes both: the switch
// and the files. Paths are relative to the memory root (`overview.md`, `projects/next.md`); the workspace tool adds the
// root's name. The switch only limits the agent: the user may always write, delete and clear from Settings.
// Every change is one row swap, so a file's version grows by exactly one per write, also across tabs.
import { projectStore } from '../../store/database';
import type { ProjectStore } from '../../store/database';
import { sha256Text, utf8Bytes } from './meta';
import { pathProblem } from './paths';

export type MemoryFile = { path: string; text: string; version: number; bytes: number; sha256: string; updatedAt: string };
export type MemoryStore = Pick<ProjectStore, 'row' | 'swapRow'>;
export const MEMORY_SWITCH_ROW = 'memory_enabled', MEMORY_FILES_ROW = 'memory_files';
/** The longest text one memory file may hold (our own limit: memory is notes, not media). */
export const MEMORY_MAX_CHARS = 200_000;
/** The index file the agent's overview returns (contracts §1). */
export const MEMORY_INDEX = 'overview.md';

type SwitchRow = { id: typeof MEMORY_SWITCH_ROW; enabled: boolean };
type FilesRow = { id: typeof MEMORY_FILES_ROW; files: MemoryFile[] };

export class MemoryError extends Error {
  constructor(public code: 'INVALID_TOOL_INPUT', message: string) { super(message); this.name = 'MemoryError'; }
}
const valid = (f: unknown): f is MemoryFile => !!f && typeof f === 'object' && typeof (f as MemoryFile).path === 'string' && typeof (f as MemoryFile).text === 'string' && Number.isInteger((f as MemoryFile).version);
const filesOf = (row: FilesRow | undefined): MemoryFile[] => (Array.isArray(row?.files) ? row!.files : []).filter(valid);
/** The path without a trailing slash, after the path rules; a bad path throws INVALID_TOOL_INPUT. */
function checkedPath(path: string): string {
  const why = typeof path !== 'string' || !path.trim() ? 'it is empty' : pathProblem(path) ?? (path.endsWith('/') ? 'it names a folder, not a file' : null);
  if (why) throw new MemoryError('INVALID_TOOL_INPUT', `The memory path ${JSON.stringify(path)} is not valid: ${why}.`);
  return path;
}

/** The switch that lets the agent write memory (Settings). Off until the user turns it on. */
export async function memoryEnabled(store: MemoryStore = projectStore): Promise<boolean> {
  return (await store.row<SwitchRow>('settings', MEMORY_SWITCH_ROW))?.enabled === true;
}
export async function setMemoryEnabled(on: boolean, store: MemoryStore = projectStore): Promise<void> {
  await store.swapRow<SwitchRow>('settings', MEMORY_SWITCH_ROW, () => ({ id: MEMORY_SWITCH_ROW, enabled: on }));
}
/** Every memory file, by path. */
export async function listMemory(store: MemoryStore = projectStore): Promise<MemoryFile[]> {
  return filesOf(await store.row<FilesRow>('settings', MEMORY_FILES_ROW)).sort((a, b) => a.path.localeCompare(b.path));
}
export async function readMemory(path: string, store: MemoryStore = projectStore): Promise<MemoryFile | undefined> {
  return (await listMemory(store)).find(f => f.path === path);
}
/** Writes the whole file (creates it at version 1, or replaces it at version + 1). Not limited by the switch: the agent's
 *  writes are checked by the workspace tool before they reach here. */
export async function writeMemory(path: string, text: string, store: MemoryStore = projectStore, now = new Date()): Promise<MemoryFile> {
  const at = checkedPath(path);
  if (typeof text !== 'string') throw new MemoryError('INVALID_TOOL_INPUT', 'The memory text must be text.');
  if (text.length > MEMORY_MAX_CHARS) throw new MemoryError('INVALID_TOOL_INPUT', `The text for ${at} is longer than ${MEMORY_MAX_CHARS} characters.`);
  const sha256 = await sha256Text(text), bytes = utf8Bytes(text), updatedAt = now.toISOString();
  let written: MemoryFile | undefined;
  await store.swapRow<FilesRow>('settings', MEMORY_FILES_ROW, row => {
    const files = filesOf(row), before = files.find(f => f.path === at);
    written = { path: at, text, version: (before?.version ?? 0) + 1, bytes, sha256, updatedAt };
    return { id: MEMORY_FILES_ROW, files: [...files.filter(f => f.path !== at), written] };
  });
  return written!;
}
/** Removes one file; true when it was there. */
export async function deleteMemory(path: string, store: MemoryStore = projectStore): Promise<boolean> {
  let found = false;
  await store.swapRow<FilesRow>('settings', MEMORY_FILES_ROW, row => {
    const files = filesOf(row);
    if (!(found = files.some(f => f.path === path))) return null;
    return { id: MEMORY_FILES_ROW, files: files.filter(f => f.path !== path) };
  });
  return found;
}
/** Removes every memory file. The switch keeps its value. */
export async function clearMemory(store: MemoryStore = projectStore): Promise<void> {
  await store.swapRow<FilesRow>('settings', MEMORY_FILES_ROW, () => ({ id: MEMORY_FILES_ROW, files: [] }));
}
