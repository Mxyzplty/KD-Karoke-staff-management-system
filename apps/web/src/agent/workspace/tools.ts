// SPDX-License-Identifier: AGPL-3.0-only
// T23 the `workspace` tool (contracts `workspace` and §1; results §2 `workspace`; G-13 row `workspace`). Three roots of
// text files: memory/ (memory.ts), template/ (template.ts) and cutframe/ (I1's guides, the catalogues, other projects'
// overviews; read-only). Without an open project every command is WORKSPACE_UNAVAILABLE (ticket; RC C3).
// - ls lists every file under a path as one flat list sorted by path (RC 11.3 C1; without a path, root by root), `limit`
//   per page (default 50) from `offset`.
// - cat / view read a slice of `maxChars` characters from `offset`. The text is not in the JSON: on MCP it is a second
//   text block of `content[]`, on the chat path a `text` field (RC C2). The workspace holds text only, so view is cat.
// - grep: case-insensitive literal search, one match per line, `limit` lines (default 50).
// - write replaces a whole file; edit replaces one exact passage (none or several matches are refused); copy duplicates a
//   file; delete removes one. A missing file is WORKSPACE_FILE_NOT_FOUND, a write to a read-only path WORKSPACE_READ_ONLY.
import type { GuideContext } from '../guides/tools';
import { guideFiles } from '../guides/registry';
import { WORKSPACE_COMMANDS } from '../guides/schemas';
import type { ToolResult } from '../protocol';
import { CATALOGUE_DESCRIPTIONS, CATALOGUE_FILES, elementsMarkdown, soundsMarkdown } from './catalogue';
import { MemoryError, listMemory, memoryEnabled, deleteMemory, writeMemory, MEMORY_MAX_CHARS } from './memory';
import { fileMeta, type FileMeta } from './meta';
import { CODES, MESSAGES, ROOT_ORDER, commandProblem, fail, folderTarget, inside, isFailure, parsePath, rootPath, type Parsed, type Root } from './paths';
import { otherProjects, projectOverview, projectOverviewPath, PROJECT_DESCRIPTION } from './projects';
import {
  fontsText, lessonTarget, overviewText, templatePlace, templateFiles, templateState, writeTemplateFile,
  FONTS_FILE, OVERVIEW_FILE, SKILLS_FOLDER, TEMPLATE_FILE_MAX_CHARS, type TemplateState,
} from './template';

type Command = typeof WORKSPACE_COMMANDS[number];
/** Defaults (ours where the contracts give none): ls page and grep lines 50 (contracts), cat slice 20,000 characters. */
export const LS_LIMIT = 50, GREP_LIMIT = 50, CAT_MAX_CHARS = 20_000, GREP_LINE_CHARS = 500;

type Entry = { path: string; root: Root; rest: string; readOnly: boolean; version: number; metadata: FileMeta['metadata']; text: () => Promise<string> };
type Scope = { ctx: GuideContext; projectId: string; template: TemplateState };

const constant = (s: string) => () => Promise.resolve(s);
/** Every entry's metadata has `{origin, description}` (RC 11.3 C1); memory and template files keep `updatedAt` as well. */
const MEMORY_DESCRIPTION = 'A memory note saved by an agent.';
const templateFileDescription = (path: string) => path.startsWith(`${SKILLS_FOLDER}/`)
  ? `The template's creative skill ${path.slice(SKILLS_FOLDER.length + 1, -3)}.` : 'An example saved in the template.';
/** Path order by code unit, the same on every machine (RC 11.3 C1: ls is one flat list sorted by path). */
const byPath = (a: Entry, b: Entry) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
/** Every file of one root, in a stable order. */
async function rootEntries(scope: Scope, root: Root): Promise<Entry[]> {
  const { ctx, projectId, template } = scope;
  const entry = (rest: string, e: Omit<Entry, 'path' | 'root' | 'rest'>): Entry => ({ path: rootPath(root, rest), root, rest, ...e });
  if (root === 'memory') {
    const on = await memoryEnabled(ctx.store);
    return (await listMemory(ctx.store)).map(f => entry(f.path, { readOnly: !on, version: f.version, metadata: { origin: 'memory', description: MEMORY_DESCRIPTION, updatedAt: f.updatedAt }, text: constant(f.text) }));
  }
  if (root === 'template') {
    const t = template.active, files: Entry[] = [entry(OVERVIEW_FILE, { readOnly: true, version: 1, metadata: { origin: 'template', description: 'Overview of this project\'s template.' }, text: constant(overviewText(template)) })];
    if (!t) return files;
    files.push(entry(FONTS_FILE, { readOnly: true, version: 1, metadata: { origin: 'template', description: 'The template\'s fonts.' }, text: constant(fontsText(t)) }));
    for (const f of templateFiles(t))
      files.push(entry(f.path, { readOnly: !template.learning, version: f.version, metadata: { origin: 'template', description: templateFileDescription(f.path), updatedAt: f.updatedAt }, text: constant(f.text) }));
    return files;
  }
  const guides = guideFiles().map(g => entry(g.path, { readOnly: true, version: 1, metadata: { origin: 'cutframe', description: g.summary }, text: constant(g.text) }));
  const catalogue = [[CATALOGUE_FILES.elements, elementsMarkdown], [CATALOGUE_FILES.sounds, soundsMarkdown]] as const;
  const projects = (await otherProjects(ctx.store, projectId)).map(p => entry(projectOverviewPath(p.id), { readOnly: true, version: 1,
    metadata: { origin: 'cutframe_project', projectId: p.id, description: PROJECT_DESCRIPTION(p.title) }, text: async () => await projectOverview(ctx.store, p.id) ?? '' }));
  return [...guides, ...catalogue.map(([path, make]) => entry(path, { readOnly: true, version: 1, metadata: { origin: 'cutframe_catalogue', description: CATALOGUE_DESCRIPTIONS[path] }, text: () => Promise.resolve(make()) })), ...projects];
}
/** The files at or under a path (a file path gives that one file); every root when no path is given. */
async function under(scope: Scope, at?: Parsed): Promise<Entry[]> {
  const roots = at ? [at.root] : ROOT_ORDER;
  // Sorted by path inside each root; without a path the roots keep ROOT_ORDER (RC 11.3 captured ls of a folder only).
  const all = (await Promise.all(roots.map(async r => (await rootEntries(scope, r)).sort(byPath)))).flat();
  return at ? all.filter(e => inside(e.rest, at.rest)) : all;
}
const find = async (scope: Scope, at: Parsed) => (await rootEntries(scope, at.root)).find(e => e.rest === at.rest);
const meta = async (e: Entry, text?: string) => fileMeta(e.path, text ?? await e.text(), { version: e.version, readOnly: e.readOnly, metadata: e.metadata });

/** A whole number ≥ min, or the default; anything else is refused. */
function count(input: Record<string, unknown>, key: string, fallback: number, min: number): number | ReturnType<typeof fail> {
  const v = input[key];
  if (v === undefined) return fallback;
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : fail(CODES.invalid, `${key} must be a whole number of at least ${min}.`);
}
const text = (input: Record<string, unknown>, key: string, command: string) =>
  typeof input[key] === 'string' ? input[key] as string : fail(CODES.invalid, MESSAGES.missing(`${key} (text)`, command));

/** Why the agent may not write `at` now (with `size`: text of that many characters), or null. A template write in a
 *  project with no template and Learn on is allowed: save() makes the template first (D99). */
async function refusal(scope: Scope, at: Parsed, size?: number): Promise<ReturnType<typeof fail> | null> {
  if (!at.rest) return fail(CODES.invalid, MESSAGES.rootWrite(at.path));
  if (at.root === 'cutframe') return fail(CODES.readOnly, MESSAGES.guides);
  if (at.root === 'memory') {
    if (!await memoryEnabled(scope.ctx.store)) return fail(CODES.readOnly, MESSAGES.memoryOff(at.path));
    return size !== undefined && size > MEMORY_MAX_CHARS ? fail(CODES.invalid, MESSAGES.tooLarge(at.path, MEMORY_MAX_CHARS)) : null;
  }
  const t = scope.template, place = templatePlace(at.rest);
  if (t.missing) return fail(CODES.readOnly, MESSAGES.missingTemplate(at.path, t.missing));
  if (place === 'generated') return fail(CODES.readOnly, MESSAGES.generated(at.path));
  if (!t.learning) return fail(CODES.readOnly, MESSAGES.learnOff(at.path));
  if (place === 'other') return fail(CODES.invalid, MESSAGES.templatePlace(at.path));
  return size !== undefined && size > TEMPLATE_FILE_MAX_CHARS ? fail(CODES.invalid, MESSAGES.tooLarge(at.path, TEMPLATE_FILE_MAX_CHARS)) : null;
}
/** Stores `body` at `at` (already allowed by refusal), or removes the file when `body` is null. */
async function save(scope: Scope, at: Parsed, body: string | null): Promise<FileMeta | null> {
  const { ctx, projectId } = scope;
  if (at.root === 'memory') {
    if (body === null) { await deleteMemory(at.rest, ctx.store); return null; }
    const f = await writeMemory(at.rest, body, ctx.store);
    return fileMeta(at.path, body, { version: f.version, readOnly: false, metadata: { origin: 'memory', description: MEMORY_DESCRIPTION, updatedAt: f.updatedAt } });
  }
  // D99: the first write in a project with no template makes its own template first (Learn is on: refusal checked it).
  const target = await lessonTarget(ctx.store, projectId, scope.template, () => ctx.doc?.());
  const f = await writeTemplateFile(ctx.store, target.id, at.rest, body);
  return f && fileMeta(at.path, f.text, { version: f.version, readOnly: false, metadata: { origin: 'template', description: templateFileDescription(f.path), updatedAt: f.updatedAt } });
}

async function run(scope: Scope, command: Command, input: Record<string, unknown>): Promise<ToolResult & { text?: string }> {
  const path = input.path === undefined || command === 'grep' && input.path === '' ? undefined : parsePath(input.path);
  if (isFailure(path)) return path;
  const needPath = () => path ?? fail(CODES.invalid, MESSAGES.missing('path', command));

  if (command === 'ls') {
    const limit = count(input, 'limit', LS_LIMIT, 1), offset = count(input, 'offset', 0, 0);
    if (isFailure(limit)) return limit;
    if (isFailure(offset)) return offset;
    const files = await under(scope, path);
    if (path?.rest && !files.length) return fail(CODES.notFound, MESSAGES.notFound);
    const page = files.slice(offset, offset + limit);
    return { success: true, files: await Promise.all(page.map(e => meta(e))), nextOffset: offset + limit < files.length ? offset + limit : null };
  }
  if (command === 'cat' || command === 'view') {
    const at = needPath();
    if (isFailure(at)) return at;
    const maxChars = count(input, 'maxChars', CAT_MAX_CHARS, 1), offset = count(input, 'offset', 0, 0);
    if (isFailure(maxChars)) return maxChars;
    if (isFailure(offset)) return offset;
    const e = await find(scope, at);
    if (!e) return fail(CODES.notFound, MESSAGES.notFound);
    const body = await e.text(), slice = body.slice(offset, offset + maxChars);
    return { success: true, file: await meta(e, body), offset, nextOffset: offset + maxChars < body.length ? offset + maxChars : null, text: slice };
  }
  if (command === 'grep') {
    const pattern = text(input, 'pattern', 'grep');
    if (isFailure(pattern)) return pattern;
    if (!pattern) return fail(CODES.invalid, MESSAGES.missing('pattern', 'grep'));
    const limit = count(input, 'limit', GREP_LIMIT, 1);
    if (isFailure(limit)) return limit;
    const files = await under(scope, path);
    if (path?.rest && !files.length) return fail(CODES.notFound, MESSAGES.notFound);
    const needle = pattern.toLowerCase(), matches: { path: string; line: number; text: string }[] = [];
    let truncated = false;
    for (const e of files) {
      const lines = (await e.text()).split(/\r?\n/);
      for (const [n, line] of lines.entries()) if (line.toLowerCase().includes(needle)) {
        if (matches.length === limit) { truncated = true; break; }
        matches.push({ path: e.path, line: n + 1, text: line.length > GREP_LINE_CHARS ? `${line.slice(0, GREP_LINE_CHARS)}…` : line });
      }
      if (truncated) break;
    }
    return { success: true, pattern, path: path?.path ?? '', matches, filesSearched: files.length, truncated };
  }
  if (command === 'write') {
    const at = needPath();
    if (isFailure(at)) return at;
    const slash = folderTarget(at);
    if (slash) return slash;
    const body = text(input, 'text', 'write');
    if (isFailure(body)) return body;
    const refused = await refusal(scope, at, body.length);
    if (refused) return refused;
    return { success: true, file: await save(scope, at, body) };
  }
  if (command === 'edit') {
    const at = needPath();
    if (isFailure(at)) return at;
    const slash = folderTarget(at);
    if (slash) return slash;
    const old = text(input, 'old', 'edit'), replacement = text(input, 'new', 'edit');
    if (isFailure(old)) return old;
    if (isFailure(replacement)) return replacement;
    if (!old) return fail(CODES.invalid, MESSAGES.missing('old', 'edit'));
    const e = await find(scope, at);
    if (!e) return fail(CODES.notFound, MESSAGES.notFound);
    const body = await e.text(), first = body.indexOf(old);
    const refused = await refusal(scope, at);
    if (refused) return refused;
    if (first < 0) return fail(CODES.noMatch, MESSAGES.noMatch(at.path));
    const n = body.split(old).length - 1;
    if (n > 1) return fail(CODES.invalid, MESSAGES.manyMatches(at.path, n));
    const next = body.slice(0, first) + replacement + body.slice(first + old.length), size = await refusal(scope, at, next.length);
    if (size) return size;
    return { success: true, file: await save(scope, at, next) };
  }
  if (command === 'copy') {
    const from = parsePath(input.from, 'from'), to = parsePath(input.to, 'to');
    if (isFailure(from)) return input.from === undefined ? fail(CODES.invalid, MESSAGES.missing('from', 'copy')) : from;
    if (isFailure(to)) return input.to === undefined ? fail(CODES.invalid, MESSAGES.missing('to', 'copy')) : to;
    const slash = folderTarget(to);
    if (slash) return slash;
    if (from.path === to.path) return fail(CODES.invalid, MESSAGES.sameFile);
    const e = await find(scope, from);
    if (!e) return fail(CODES.notFound, MESSAGES.notFound);
    const body = await e.text(), refused = await refusal(scope, to, body.length);
    if (refused) return refused;
    return { success: true, file: await save(scope, to, body) };
  }
  // delete
  const at = needPath();
  if (isFailure(at)) return at;
  if (!await find(scope, at)) return fail(CODES.notFound, MESSAGES.notFound);
  const refused = await refusal(scope, at);
  if (refused) return refused;
  await save(scope, at, null);
  return { success: true, path: at.path };
}

/** A storage or template failure as a result: its own code when it has one. */
function thrown(e: unknown): ToolResult {
  const err = e as { code?: unknown; message?: unknown };
  if (e instanceof MemoryError) return fail(e.code, e.message);
  return fail(typeof err?.code === 'string' && err.code ? err.code : 'PROJECT_UNAVAILABLE', typeof err?.message === 'string' && err.message ? err.message : 'The workspace could not be read.');
}

/** The tool. MCP (the default): cat / view put the text slice in a second text block; chat: a `text` field. */
export async function workspaceTool(input: Record<string, unknown>, ctx: GuideContext): Promise<ToolResult> {
  // The command is a schema check, so it comes before the project check (RC 11.3 C2).
  const bad = commandProblem(input.command, WORKSPACE_COMMANDS);
  if (bad) return bad;
  if (!ctx.projectId) return fail(CODES.unavailable, MESSAGES.unavailable);
  const command = input.command as Command;
  let result: ToolResult & { text?: string };
  try {
    const template = await templateState(ctx.store, ctx.projectId);
    // A demo project names what it lacks (RC 11.3 C3); a project that is gone counts as none open.
    if (!template) return fail(CODES.unavailable, (await ctx.store.row<{ is_demo?: boolean }>('projects', ctx.projectId))?.is_demo ? MESSAGES.demo : MESSAGES.unavailable);
    result = await run({ ctx, projectId: ctx.projectId, template }, command, input);
  } catch (e) { return thrown(e); }
  if (!result.success || result.text === undefined || ctx.channel === 'chat') return result;
  const { text: slice, ...json } = result;
  return { success: true, content: [{ type: 'text', text: JSON.stringify(json) }, { type: 'text', text: slice }] };
}
