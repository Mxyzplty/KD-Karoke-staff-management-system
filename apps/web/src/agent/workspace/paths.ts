// SPDX-License-Identifier: AGPL-3.0-only
// T23 workspace paths (contracts §1 and `workspace`; findings part 2 §42). The roots, their names and every message of the
// tool live here, in one table each, so an RC answer that renames a root or rewords a message changes one line.
// A path is `<root>/<rest>`: forward slashes only, no absolute path, no `.` or `..` part, no empty part.

/** The workspace roots. Keys are what the code uses; values are the names the agent sees (RC C1 may rename them). */
export const ROOTS = { memory: 'memory', template: 'template', cutframe: 'cutframe' } as const;
export type Root = keyof typeof ROOTS;
export const ROOT_ORDER: readonly Root[] = ['memory', 'template', 'cutframe'];

/** The full workspace path of `p` (relative to the root). */
export const rootPath = (root: Root, p: string): string => p ? `${ROOTS[root]}/${p}` : ROOTS[root];

/** The tool's error codes (G-13 row `workspace`; ticket T23). */
export const CODES = {
  unavailable: 'WORKSPACE_UNAVAILABLE', notFound: 'WORKSPACE_FILE_NOT_FOUND', readOnly: 'WORKSPACE_READ_ONLY',
  invalid: 'INVALID_TOOL_INPUT', noMatch: 'STRING_NOT_FOUND',
} as const;

/** Our own wording for every refusal of the tool. RC 11.3 C2 / C3 fix three of them to Xapp's: a missing file's error is
 *  the bare code, a write under the guides root names that root, and a demo project names the files it lacks. */
export const MESSAGES = {
  unavailable: 'No project is open, so the workspace is not available. Open a project in the editor, then try again.',
  demo: 'Demo and evaluation projects have no personal memory or template files.',
  notFound: CODES.notFound,
  memoryOff: (path: string) => `${path} is read-only: memory is switched off. The user can turn on "Let agents save memory" in Settings > Agent memory.`,
  learnOff: (path: string) => `${path} is read-only: Learn is switched off for this project's template. The user can turn Learn on in the project's template view.`,
  missingTemplate: (path: string, id: string) => `${path} is read-only: this project's template (${id}) is no longer in the library.`,
  templatePlace: (path: string) => `${path} cannot be written. Under template/, write to skills/<skill id>.md (lower-case letters, digits, hyphens and /) or examples/<name>.`,
  generated: (path: string) => `${path} is generated from the project and is read-only.`,
  guides: `${ROOTS.cutframe}/ guides are read-only.`,
  rootWrite: (path: string) => `${path} is a folder, not a file. Write to a file inside it.`,
  folderTarget: (path: string) => `${path}/ ends in /, so it names a folder, not a file. Give the file's path without the trailing /.`,
  badPath: (path: string, why: string) => `The path ${JSON.stringify(path)} is not valid: ${why}.`,
  missing: (field: string, command: string) => `${command} needs ${field}.`,
  noMatch: (path: string) => `The passage in old was not found in ${path}. Read the file with cat and copy the passage exactly.`,
  manyMatches: (path: string, n: number) => `The passage in old occurs ${n} times in ${path}. Add surrounding text to old so it matches once.`,
  sameFile: 'from and to are the same file.',
  binaryView: (path: string) => `${path} is not a text file.`,
  tooLarge: (path: string, max: number) => `The text for ${path} is longer than ${max} characters.`,
} as const;

export type Failure = { success: false; code: string; error: string };
export const fail = (code: string, error: string): Failure => ({ success: false, code, error });
export const isFailure = (v: unknown): v is Failure => !!v && typeof v === 'object' && (v as Failure).success === false;
/** A missing or unknown `command`, refused in the helper's schema shape (RC 11.3 C2: Xapp's is ENUM from its schema). */
export function commandProblem(command: unknown, commands: readonly string[]): Record<string, unknown> & Failure | null {
  const e = command === undefined ? { path: '$.command', code: 'REQUIRED', message: 'must have required property \'command\'' }
    : typeof command === 'string' && commands.includes(command) ? null : { path: '$.command', code: 'ENUM', message: 'must be equal to one of the allowed values' };
  return e && { success: false, code: CODES.invalid, error: 'Invalid input for workspace', message: `${e.path}: ${e.message}`, details: { errors: [e] } };
}

/** Why `path` breaks the path rules, or null. A trailing slash is allowed (it names a folder). */
export function pathProblem(path: string): string | null {
  return path.includes('\\') ? 'use forward slashes (/)' : /^\/|^[A-Za-z]:/.test(path) ? 'start with a root such as memory/, not with / or a drive'
    : path.replace(/\/+$/, '').split('/').some(p => p === '' || p === '.' || p === '..') ? 'it has an empty, "." or ".." part'
      : /[\u0000-\u001f]/.test(path) ? 'it has a control character' : null;
}

/** `folder`: the path ended in a slash, which reads accept and write targets refuse (round-1 review R7b). */
export type Parsed = { root: Root; rest: string; path: string; folder: boolean };
/** Reads `path` into its root and the rest. A path that breaks the rules is INVALID_TOOL_INPUT; a root that does not exist is
 *  WORKSPACE_FILE_NOT_FOUND (nothing can be at it). A trailing slash names a folder: it is dropped from `path` and kept as `folder`. */
export function parsePath(path: unknown, field = 'path'): Parsed | Failure {
  if (typeof path !== 'string' || !path.trim()) return fail(CODES.invalid, MESSAGES.missing(field, 'This command'));
  const why = pathProblem(path);
  if (why) return fail(CODES.invalid, MESSAGES.badPath(path, why));
  const clean = path.replace(/\/+$/, ''), [head, ...tail] = clean.split('/');
  const root = ROOT_ORDER.find(r => ROOTS[r] === head);
  if (!root) return fail(CODES.notFound, MESSAGES.notFound);
  return { root, rest: tail.join('/'), path: clean, folder: clean !== path };
}
/** INVALID_TOOL_INPUT when a write target ends in a slash (write, edit, copy's `to`), else null. */
export const folderTarget = (at: Parsed): Failure | null => at.folder ? fail(CODES.invalid, MESSAGES.folderTarget(at.path)) : null;

/** True when `rest` is inside the folder `folder` (both relative to the same root; '' is the root itself). */
export const inside = (rest: string, folder: string) => !folder || rest === folder || rest.startsWith(`${folder}/`);
