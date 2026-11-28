// SPDX-License-Identifier: AGPL-3.0-only
// T23 the workspace tool, the memory store and D99 (contracts `workspace` and §1; results §2 `workspace` FileMeta; G-13 row
// `workspace`; T23 notes "workspace"; ticket D99). Oracles: the written rules (codes, roots, version +1, SHA-256 of the UTF-8
// text), node's own SHA-256, T22's ELEMENTS / SOUNDS and template records. Native stores on fake-indexeddb; no mocks.
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guideFiles } from '../apps/web/src/agent/guides/registry';
import type { GuideContext } from '../apps/web/src/agent/guides/tools';
import { elementsMarkdown, soundsMarkdown } from '../apps/web/src/agent/workspace/catalogue';
import { MemoryError, listMemory, memoryEnabled, readMemory, setMemoryEnabled, writeMemory, deleteMemory, clearMemory, MEMORY_MAX_CHARS } from '../apps/web/src/agent/workspace/memory';
import { workspaceTool } from '../apps/web/src/agent/workspace/tools';
import { ELEMENTS } from '../apps/web/src/catalogue/elements';
import { SOUNDS } from '../apps/web/src/catalogue/sounds';
import { ProjectStore } from '../apps/web/src/store/database';
import type { MediaStore } from '../apps/web/src/store/media';
import type { ProjectRecord } from '../apps/web/src/store/model';
import { setProjectLearning } from '../apps/web/src/templates/binding';
import { listTemplates, lessonTemplate, projectTemplate, saveProjectTemplate } from '../apps/web/src/templates/library';

type Rec = Record<string, any>;
const NOW = new Date('2026-11-15T03:00:00.000Z'), opened: ProjectStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });
const media = (): MediaStore => ({ write: vi.fn(async () => {}), read: vi.fn(async () => { throw new Error('unused'); }), remove: vi.fn(async () => {}) });
function setup(name: string = crypto.randomUUID()) { let tick = NOW.getTime(); const s = new ProjectStore(name, () => tick++, media()); opened.push(s); return s; }
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
async function rig(channel: 'chat' | 'mcp' = 'chat') {
  const store = setup(), p = await store.create('Open one'), other = await store.create('Other one');
  const ws = (input: Rec, c: 'chat' | 'mcp' = channel) => workspaceTool(input, { store, projectId: p.id, channel: c } as GuideContext) as Promise<Rec>;
  return { store, id: p.id, otherId: other.id, ws };
}
const code = (r: Rec) => r.code;
const ALL = ['ls', 'view', 'cat', 'grep', 'write', 'edit', 'copy', 'delete'];

describe('T23 workspace: no project open', () => {
  for (const command of ALL) it(`${command} → WORKSPACE_UNAVAILABLE`, async () => {
    const r = await workspaceTool({ command, path: 'memory/overview.md', text: 'x', old: 'a', new: 'b', from: 'memory/a.md', to: 'memory/b.md', pattern: 'x' }, { store: setup(), projectId: null, channel: 'mcp' }) as Rec;
    expect(r).toEqual({ success: false, code: 'WORKSPACE_UNAVAILABLE', error: 'No project is open, so the workspace is not available. Open a project in the editor, then try again.' });
  });
  it('a project id that no longer exists is unavailable too', async () => {
    expect(code(await workspaceTool({ command: 'ls' }, { store: setup(), projectId: 'gone', channel: 'chat' }) as Rec)).toBe('WORKSPACE_UNAVAILABLE');
  });
});

describe('T23 workspace: the 3 roots and ls', () => {
  it('ls with no path lists memory/, template/ and cutframe/ in that order, with FileMeta', async () => {
    const { store, otherId, id, ws } = await rig();
    await setMemoryEnabled(true, store); await writeMemory('overview.md', 'Hello', store, NOW);
    const r = await ws({ command: 'ls', limit: 1000 });
    expect(r.success).toBe(true); expect(r.nextOffset).toBeNull();
    const paths: string[] = r.files.map((f: Rec) => f.path), roots = paths.map(p => p.split('/')[0]);
    expect([...new Set(roots)]).toEqual(['memory', 'template', 'cutframe']);
    expect(paths).toContain('memory/overview.md'); expect(paths).toContain('template/overview.md');
    for (const g of guideFiles()) expect(paths).toContain(`cutframe/${g.path}`);
    expect(paths).toContain('cutframe/catalogue/elements.md'); expect(paths).toContain('cutframe/catalogue/sounds.md');
    expect(paths).toContain(`cutframe/projects/${otherId}/overview.md`); expect(paths).not.toContain(`cutframe/projects/${id}/overview.md`);
    const mem = r.files.find((f: Rec) => f.path === 'memory/overview.md');
    expect(mem).toEqual({ path: 'memory/overview.md', version: 1, mimeType: 'text/markdown', bytes: 5, sha256: sha('Hello'), readOnly: false, metadata: { origin: 'memory', updatedAt: NOW.toISOString(), description: 'A memory note saved by an agent.' } });
    for (const f of r.files) expect(Object.keys(f).sort()).toEqual(['bytes', 'metadata', 'mimeType', 'path', 'readOnly', 'sha256', 'version']);
    for (const f of r.files.filter((f: Rec) => f.path.startsWith('cutframe/'))) expect(f.readOnly, f.path).toBe(true);
  });
  it('ls pages with limit (default 50) and offset', async () => {
    const { ws } = await rig(), all = (await ws({ command: 'ls', limit: 1000 })).files;
    const first = await ws({ command: 'ls' });
    expect(first.files).toEqual(all.slice(0, 50)); expect(first.nextOffset).toBe(all.length > 50 ? 50 : null);
    const page = await ws({ command: 'ls', limit: 3, offset: 2 });
    expect(page.files).toEqual(all.slice(2, 5)); expect(page.nextOffset).toBe(5);
    expect(code(await ws({ command: 'ls', limit: 0 }))).toBe('INVALID_TOOL_INPUT');
    expect(code(await ws({ command: 'ls', offset: -1 }))).toBe('INVALID_TOOL_INPUT');
  });
  it('ls of a root or folder, and of a missing folder', async () => {
    const { ws } = await rig();
    expect((await ws({ command: 'ls', path: 'cutframe/catalogue/' })).files.map((f: Rec) => f.path)).toEqual(['cutframe/catalogue/elements.md', 'cutframe/catalogue/sounds.md']);
    expect((await ws({ command: 'ls', path: 'memory' })).files).toEqual([]);
    expect(code(await ws({ command: 'ls', path: 'memory/none/' }))).toBe('WORKSPACE_FILE_NOT_FOUND');
    expect(code(await ws({ command: 'ls', path: 'nowhere/' }))).toBe('WORKSPACE_FILE_NOT_FOUND');
  });
});

describe('T23 workspace: cat and view', () => {
  it('MCP: JSON block then the text slice; chat: a text field', async () => {
    const { store, ws } = await rig();
    await writeMemory('a.md', 'abcdefghij', store, NOW);
    const mcp = await ws({ command: 'cat', path: 'memory/a.md', offset: 2, maxChars: 3 }, 'mcp');
    expect(Object.keys(mcp).sort()).toEqual(['content', 'success']);
    expect(mcp.content).toHaveLength(2);
    expect(JSON.parse(mcp.content[0].text)).toEqual({ success: true, file: expect.objectContaining({ path: 'memory/a.md', bytes: 10, sha256: sha('abcdefghij'), readOnly: true }), offset: 2, nextOffset: 5 });
    expect(mcp.content[1]).toEqual({ type: 'text', text: 'cde' });
    const chat = await ws({ command: 'cat', path: 'memory/a.md', offset: 8, maxChars: 5 }, 'chat');
    expect(chat).toMatchObject({ success: true, offset: 8, nextOffset: null, text: 'ij' });
    expect(chat.content).toBeUndefined();
    expect(await ws({ command: 'view', path: 'memory/a.md' }, 'chat')).toEqual(await ws({ command: 'cat', path: 'memory/a.md' }, 'chat'));
  });
  it('the guides, the catalogues and other projects read as files', async () => {
    const { ws, otherId } = await rig();
    const g = guideFiles()[0];
    expect((await ws({ command: 'cat', path: `cutframe/${g.path}`, maxChars: 10_000_000 })).text).toBe(g.text);
    const elements = (await ws({ command: 'cat', path: 'cutframe/catalogue/elements.md', maxChars: 10_000_000 })).text;
    expect(elements).toBe(elementsMarkdown());
    for (const e of ELEMENTS) expect(elements).toContain(`\`element:${e.id}\``);
    const sounds = (await ws({ command: 'cat', path: 'cutframe/catalogue/sounds.md', maxChars: 10_000_000 })).text;
    expect(sounds).toBe(soundsMarkdown());
    for (const s of SOUNDS) expect(sounds).toContain(`\`sound:${s.slug}\``);
    const other = await ws({ command: 'cat', path: `cutframe/projects/${otherId}/overview.md` });
    expect(other.text).toMatch(/^# Other one\n/); expect(other.text).toContain(`- Project id: ${otherId}`);
    expect(other.file.metadata).toEqual({ origin: 'cutframe_project', projectId: otherId, description: 'Overview of the project "Other one".' });
  });
  it('a missing file, a missing path and a bad path', async () => {
    const { ws } = await rig();
    expect(await ws({ command: 'cat', path: 'memory/none.md' })).toEqual({ success: false, code: 'WORKSPACE_FILE_NOT_FOUND', error: 'WORKSPACE_FILE_NOT_FOUND' });
    expect(code(await ws({ command: 'cat' }))).toBe('INVALID_TOOL_INPUT');
    for (const path of ['../x', 'memory/../x', 'memory\\a.md', '/memory/a.md', 'C:/a', 'memory//a.md']) expect(code(await ws({ command: 'cat', path })), path).toBe('INVALID_TOOL_INPUT');
  });
});

describe('T23 workspace: grep', () => {
  it('case-insensitive literal, one match per line, limit = lines', async () => {
    const { store, ws } = await rig();
    await writeMemory('a.md', 'Alpha\nbeta ALPHA\n(alpha)*\n', store, NOW); await writeMemory('b.md', 'nothing', store, NOW);
    const r = await ws({ command: 'grep', path: 'memory/', pattern: 'alpha' });
    expect(r).toMatchObject({ success: true, pattern: 'alpha', path: 'memory', truncated: false, filesSearched: 2 });
    expect(r.matches).toEqual([{ path: 'memory/a.md', line: 1, text: 'Alpha' }, { path: 'memory/a.md', line: 2, text: 'beta ALPHA' }, { path: 'memory/a.md', line: 3, text: '(alpha)*' }]);
    expect((await ws({ command: 'grep', path: 'memory', pattern: '(alpha)*' })).matches).toHaveLength(1);
    const cut = await ws({ command: 'grep', path: 'memory', pattern: 'alpha', limit: 2 });
    expect(cut.matches).toHaveLength(2); expect(cut.truncated).toBe(true);
    expect(code(await ws({ command: 'grep', path: 'memory' }))).toBe('INVALID_TOOL_INPUT');
  });
});

describe('T23 workspace: write, edit, copy, delete and FileMeta', () => {
  it('version +1 on each write, sha256 and bytes of the UTF-8 text', async () => {
    const { store, ws } = await rig();
    await setMemoryEnabled(true, store);
    const one = await ws({ command: 'write', path: 'memory/notes/a.md', text: 'é' });
    expect(one).toEqual({ success: true, file: { path: 'memory/notes/a.md', version: 1, mimeType: 'text/markdown', bytes: 2, sha256: sha('é'), readOnly: false, metadata: { origin: 'memory', updatedAt: expect.any(String), description: 'A memory note saved by an agent.' } } });
    const two = await ws({ command: 'write', path: 'memory/notes/a.md', text: 'second' });
    expect(two.file).toMatchObject({ version: 2, bytes: 6, sha256: sha('second') });
    const three = await ws({ command: 'edit', path: 'memory/notes/a.md', old: 'sec', new: 'SEC' });
    expect(three.file).toMatchObject({ version: 3, sha256: sha('SECond') });
    expect((await readMemory('notes/a.md', store))!.text).toBe('SECond');
  });
  it('edit replaces one exact passage; none is STRING_NOT_FOUND, several are refused', async () => {
    const { store, ws } = await rig();
    await setMemoryEnabled(true, store); await writeMemory('a.md', 'one two one', store, NOW);
    expect(await ws({ command: 'edit', path: 'memory/a.md', old: 'three', new: 'x' })).toEqual({ success: false, code: 'STRING_NOT_FOUND', error: 'The passage in old was not found in memory/a.md. Read the file with cat and copy the passage exactly.' });
    expect(await ws({ command: 'edit', path: 'memory/a.md', old: 'one', new: 'x' })).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: 'The passage in old occurs 2 times in memory/a.md. Add surrounding text to old so it matches once.' });
    expect(code(await ws({ command: 'edit', path: 'memory/a.md', old: 'two' }))).toBe('INVALID_TOOL_INPUT');
    expect(code(await ws({ command: 'edit', path: 'memory/none.md', old: 'a', new: 'b' }))).toBe('WORKSPACE_FILE_NOT_FOUND');
    expect((await readMemory('a.md', store))!).toMatchObject({ text: 'one two one', version: 1 });
  });
  it('copy duplicates a file (also from cutframe/ into memory/); delete removes one', async () => {
    const { store, ws } = await rig();
    await setMemoryEnabled(true, store); await writeMemory('a.md', 'A', store, NOW);
    expect((await ws({ command: 'copy', from: 'memory/a.md', to: 'memory/b.md' })).file).toMatchObject({ path: 'memory/b.md', version: 1, sha256: sha('A') });
    expect((await ws({ command: 'copy', from: 'cutframe/catalogue/sounds.md', to: 'memory/sounds.md' })).file).toMatchObject({ path: 'memory/sounds.md', sha256: sha(soundsMarkdown()) });
    expect(code(await ws({ command: 'copy', from: 'memory/a.md', to: 'memory/a.md' }))).toBe('INVALID_TOOL_INPUT');
    expect(code(await ws({ command: 'copy', from: 'memory/none.md', to: 'memory/c.md' }))).toBe('WORKSPACE_FILE_NOT_FOUND');
    expect(code(await ws({ command: 'copy', to: 'memory/c.md' }))).toBe('INVALID_TOOL_INPUT');
    expect(await ws({ command: 'delete', path: 'memory/b.md' })).toEqual({ success: true, path: 'memory/b.md' });
    expect(code(await ws({ command: 'cat', path: 'memory/b.md' }))).toBe('WORKSPACE_FILE_NOT_FOUND');
    expect(code(await ws({ command: 'delete', path: 'memory/b.md' }))).toBe('WORKSPACE_FILE_NOT_FOUND');
  });
  it('INVALID_TOOL_INPUT: unknown command, missing fields, a folder, a bad template place, too long', async () => {
    const { store, id, ws } = await rig();
    await setMemoryEnabled(true, store);
    expect(await ws({ command: 'rm' })).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for workspace', message: '$.command: must be equal to one of the allowed values',
      details: { errors: [{ path: '$.command', code: 'ENUM', message: 'must be equal to one of the allowed values' }] } });
    expect(await ws({})).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for workspace', message: '$.command: must have required property \'command\'',
      details: { errors: [{ path: '$.command', code: 'REQUIRED', message: 'must have required property \'command\'' }] } });
    expect(code(await ws({ command: 'write', path: 'memory/a.md' }))).toBe('INVALID_TOOL_INPUT');
    expect(code(await ws({ command: 'write', text: 'x' }))).toBe('INVALID_TOOL_INPUT');
    expect(code(await ws({ command: 'write', path: 'memory/', text: 'x' }))).toBe('INVALID_TOOL_INPUT');
    expect(code(await ws({ command: 'write', path: 'memory/a.md', text: 'x'.repeat(MEMORY_MAX_CHARS + 1) }))).toBe('INVALID_TOOL_INPUT');
    expect((await ws({ command: 'write', path: 'memory/a.md', text: 'x'.repeat(MEMORY_MAX_CHARS) })).success).toBe(true);
    expect(code(await ws({ command: 'write', path: 'template/notes.md', text: 'x' }))).toBe('INVALID_TOOL_INPUT');
    expect(await projectTemplate(store, id)).toBeUndefined();
  });
});

describe('T23 workspace: the 5 WORKSPACE_READ_ONLY cases', () => {
  it('memory/ while the memory switch is off (the default), naming the Settings switch', async () => {
    const { store, ws } = await rig();
    const r = await ws({ command: 'write', path: 'memory/a.md', text: 'x' });
    expect(r).toEqual({ success: false, code: 'WORKSPACE_READ_ONLY', error: 'memory/a.md is read-only: memory is switched off. The user can turn on "Let agents save memory" in Settings > Agent memory.' });
    await writeMemory('b.md', 'user wrote this', store, NOW);
    for (const input of [{ command: 'edit', path: 'memory/b.md', old: 'user', new: 'agent' }, { command: 'delete', path: 'memory/b.md' }, { command: 'copy', from: 'memory/b.md', to: 'memory/c.md' }])
      expect(code(await ws(input)), input.command).toBe('WORKSPACE_READ_ONLY');
    expect(await listMemory(store)).toHaveLength(1);
  });
  it('cutframe/: our guides and catalogues', async () => {
    const { ws } = await rig(), g = guideFiles()[0];
    expect(code(await ws({ command: 'write', path: `cutframe/${g.path}`, text: 'x' }))).toBe('WORKSPACE_READ_ONLY');
    expect(code(await ws({ command: 'delete', path: 'cutframe/catalogue/elements.md' }))).toBe('WORKSPACE_READ_ONLY');
    expect(code(await ws({ command: 'write', path: 'cutframe/new.md', text: 'x' }))).toBe('WORKSPACE_READ_ONLY');
  });
  it('template/overview.md and fonts.md: generated', async () => {
    const { store, id, ws } = await rig(), doc = (await store.read(id))!.document;
    await saveProjectTemplate(store, id, doc, NOW);
    for (const path of ['template/overview.md', 'template/fonts.md'])
      expect(await ws({ command: 'write', path, text: 'x' })).toEqual({ success: false, code: 'WORKSPACE_READ_ONLY', error: `${path} is generated from the project and is read-only.` });
  });
  it('template/ while Learn is off', async () => {
    const { store, id, ws } = await rig(), own = await saveProjectTemplate(store, id, (await store.read(id))!.document, NOW);
    await setProjectLearning(store, id, false);
    expect(code(await ws({ command: 'write', path: 'template/skills/vlog.md', text: 'x' }))).toBe('WORKSPACE_READ_ONLY');
    expect((await projectTemplate(store, id))!.files ?? []).toEqual([]);
    expect(own.id).toBe((await projectTemplate(store, id))!.id);
  });
  it('template/ when the bound template is gone', async () => {
    const { store, id, ws } = await rig();
    await store.swapRow<ProjectRecord>('projects', id, r => ({ ...r!, template_id: 'gone-template' }));
    expect(await ws({ command: 'write', path: 'template/skills/vlog.md', text: 'x' })).toEqual({ success: false, code: 'WORKSPACE_READ_ONLY', error: 'template/skills/vlog.md is read-only: this project\'s template (gone-template) is no longer in the library.' });
  });
});

describe('T23 workspace: template files', () => {
  it('with Learn on, skills/ and examples/ are written into the template; ls and cat show them', async () => {
    const { store, id, ws } = await rig(), own = await saveProjectTemplate(store, id, (await store.read(id))!.document, NOW);
    expect((await ws({ command: 'write', path: 'template/skills/assembly/short-form.md', text: 'Hook first.' })).file).toMatchObject({ version: 1, readOnly: false, sha256: sha('Hook first.') });
    expect((await ws({ command: 'write', path: 'template/skills/assembly/short-form.md', text: 'Hook in 2 s.' })).file).toMatchObject({ version: 2 });
    await ws({ command: 'write', path: 'template/examples/intro.txt', text: 'Example.' });
    const t = (await projectTemplate(store, id))!;
    expect(t.id).toBe(own.id);
    expect(t.files!.map(f => [f.path, f.text, f.version])).toEqual([['skills/assembly/short-form.md', 'Hook in 2 s.', 2], ['examples/intro.txt', 'Example.', 1]]);
    expect((await ws({ command: 'ls', path: 'template' })).files.map((f: Rec) => f.path)).toEqual(['template/examples/intro.txt', 'template/fonts.md', 'template/overview.md', 'template/skills/assembly/short-form.md']);
    expect((await ws({ command: 'cat', path: 'template/overview.md' })).text).toContain('`assembly/short-form` (template/skills/assembly/short-form.md)');
    expect(await ws({ command: 'delete', path: 'template/examples/intro.txt' })).toEqual({ success: true, path: 'template/examples/intro.txt' });
    expect((await projectTemplate(store, id))!.files!.map(f => f.path)).toEqual(['skills/assembly/short-form.md']);
  });
});

describe('T23 D99: a lesson in a project with no template', () => {
  it('the first write under template/ with Learn on makes the project\'s own template (saved off, neverSaved), unbound and unlisted', async () => {
    const { store, id, ws } = await rig();
    expect(await projectTemplate(store, id)).toBeUndefined();
    const r = await ws({ command: 'write', path: 'template/skills/vlog.md', text: 'Cut on the breath.' });
    expect(r.file).toMatchObject({ path: 'template/skills/vlog.md', version: 1, readOnly: false });
    const own = (await projectTemplate(store, id))!;
    expect(own).toMatchObject({ fromProject: id, saved: false, neverSaved: true, name: 'Open one template', learning: true });
    expect(own.files!.map(f => [f.path, f.text])).toEqual([['skills/vlog.md', 'Cut on the breath.']]);
    expect((await store.row<ProjectRecord>('projects', id))!.template_id).toBeNull();
    expect((await listTemplates(store)).mine).toEqual([]);
    // The same template takes the next write; nothing new is made.
    await ws({ command: 'write', path: 'template/skills/vlog.md', text: 'Second.' });
    const again = (await projectTemplate(store, id))!;
    expect(again.id).toBe(own.id); expect(again.files![0].version).toBe(2);
    expect((await store.row<{ templates: unknown[] }>('settings', 'templates'))!.templates).toHaveLength(1);
  });
  it('the lesson template is what T22\'s lessonTemplate makes (same name, fonts, colours, Learn)', async () => {
    const a = await rig(), b = await rig();
    await a.ws({ command: 'write', path: 'template/skills/vlog.md', text: 'x' });
    const viaTool = (await projectTemplate(a.store, a.id))!, direct = await lessonTemplate(b.store, b.id, (await b.store.read(b.id))!.document, NOW);
    const strip = ({ id: _i, fromProject: _f, savedAt: _s, files: _x, ...rest }: Rec) => rest;
    expect(strip(viaTool)).toEqual(strip(direct));
  });
  it('with Learn off the folder is read-only and nothing is made', async () => {
    const { store, id, ws } = await rig();
    await setProjectLearning(store, id, false);
    expect(await ws({ command: 'write', path: 'template/skills/vlog.md', text: 'x' })).toEqual({ success: false, code: 'WORKSPACE_READ_ONLY',
      error: 'template/skills/vlog.md is read-only: Learn is switched off for this project\'s template. The user can turn Learn on in the project\'s template view.' });
    expect(await projectTemplate(store, id)).toBeUndefined();
    expect(await store.row('settings', 'templates')).toBeUndefined();
  });
  it('reads and a switch change make nothing', async () => {
    const { store, id, ws } = await rig();
    expect((await ws({ command: 'ls', path: 'template' })).files.map((f: Rec) => f.path)).toEqual(['template/overview.md']);
    expect((await ws({ command: 'cat', path: 'template/overview.md' })).text).toBe('This project has no template: loadSkill gives Cutframe\'s creative defaults, and nothing project-specific applies.');
    await ws({ command: 'grep', pattern: 'template' }); await ws({ command: 'ls' });
    expect(code(await ws({ command: 'cat', path: 'template/skills/vlog.md' }))).toBe('WORKSPACE_FILE_NOT_FOUND');
    expect(code(await ws({ command: 'delete', path: 'template/skills/vlog.md' }))).toBe('WORKSPACE_FILE_NOT_FOUND');
    await setProjectLearning(store, id, false); await setProjectLearning(store, id, true);
    expect(await projectTemplate(store, id)).toBeUndefined();
    expect(await store.row('settings', 'templates')).toBeUndefined();
  });
  it('a refused write (bad place, generated file, too long) makes nothing', async () => {
    const { store, id, ws } = await rig();
    expect(code(await ws({ command: 'write', path: 'template/notes.md', text: 'x' }))).toBe('INVALID_TOOL_INPUT');
    expect(code(await ws({ command: 'write', path: 'template/overview.md', text: 'x' }))).toBe('WORKSPACE_READ_ONLY');
    expect(code(await ws({ command: 'write', path: 'template/skills/vlog.md', text: 'x'.repeat(200_001) }))).toBe('INVALID_TOOL_INPUT');
    expect(await projectTemplate(store, id)).toBeUndefined();
  });
});

describe('T23 memory store', () => {
  it('off by default; the switch and the files persist across connections', async () => {
    const name = crypto.randomUUID(), a = setup(name);
    expect(await memoryEnabled(a)).toBe(false);
    await setMemoryEnabled(true, a); await writeMemory('overview.md', 'Kept.', a, NOW);
    await a.close();
    const b = setup(name);
    expect(await memoryEnabled(b)).toBe(true);
    expect(await readMemory('overview.md', b)).toEqual({ path: 'overview.md', text: 'Kept.', version: 1, bytes: 5, sha256: sha('Kept.'), updatedAt: NOW.toISOString() });
    await setMemoryEnabled(false, b);
    expect(await memoryEnabled(b)).toBe(false);
    expect(await listMemory(b)).toHaveLength(1);
  });
  it('the 200,000-character cap', async () => {
    const s = setup();
    expect(MEMORY_MAX_CHARS).toBe(200_000);
    expect((await writeMemory('a.md', 'x'.repeat(200_000), s, NOW)).bytes).toBe(200_000);
    const error = await writeMemory('a.md', 'x'.repeat(200_001), s, NOW).catch(e => e);
    expect(error).toBeInstanceOf(MemoryError); expect(error.code).toBe('INVALID_TOOL_INPUT');
    expect((await readMemory('a.md', s))!.text).toHaveLength(200_000);
  });
  it('the user may always write; versions grow by one; delete and clear', async () => {
    const s = setup();
    await writeMemory('b.md', '1', s, NOW); await writeMemory('a.md', '1', s, NOW); await writeMemory('a.md', '2', s, NOW);
    expect((await listMemory(s)).map(f => [f.path, f.version])).toEqual([['a.md', 2], ['b.md', 1]]);
    expect(await deleteMemory('a.md', s)).toBe(true); expect(await deleteMemory('a.md', s)).toBe(false);
    await setMemoryEnabled(true, s); await clearMemory(s);
    expect(await listMemory(s)).toEqual([]); expect(await memoryEnabled(s)).toBe(true);
    for (const bad of ['', '../a.md', 'a\\b.md', 'folder/']) expect((await writeMemory(bad, 'x', s).catch(e => e)).code, bad).toBe('INVALID_TOOL_INPUT');
  });
});



describe('T23 round 1: a trailing slash names a folder (R7b)', () => {
  it('write, edit and copy.to with a trailing slash are refused, and nothing is written', async () => {
    const { store, ws } = await rig();
    await setMemoryEnabled(true, store); await writeMemory('a.md', 'one', store, NOW);
    const before = await listMemory(store);
    for (const input of [{ command: 'write', path: 'memory/notes/', text: 'x' }, { command: 'edit', path: 'memory/a.md/', old: 'one', new: 'two' }, { command: 'copy', from: 'memory/a.md', to: 'memory/notes/' }]) {
      const r = await ws(input);
      expect(r.success, input.command).toBe(false); expect(code(r), input.command).toBe('INVALID_TOOL_INPUT');
    }
    expect(await listMemory(store)).toEqual(before);
    expect((await readMemory('a.md', store))?.text).toBe('one');
  });
});

describe('T23 RC Part 11: I2 batch (Xapp parity of codes and texts)', () => {
  it('(a) an unknown root, ls of a missing folder and delete of a missing file: the error equals the code', async () => {
    const { store, ws } = await rig();
    await setMemoryEnabled(true, store);
    for (const input of [{ command: 'cat', path: 'xapp/x.md' }, { command: 'ls', path: 'memory/nope' }, { command: 'delete', path: 'memory/none.md' }]) {
      const r = await ws(input);
      expect(r.success, JSON.stringify(input)).toBe(false); expect(r.error, JSON.stringify(input)).toBe(r.code);
    }
  });
  it('(b) a write under cutframe/: the stored read-only text', async () => {
    const { ws } = await rig();
    expect(await ws({ command: 'write', path: 'cutframe/catalogue/elements.md', text: 'x' })).toEqual({ success: false, code: 'WORKSPACE_READ_ONLY', error: 'cutframe/ guides are read-only.' });
  });
  it('(c) a demo project: WORKSPACE_UNAVAILABLE with Xapp\'s text', async () => {
    const { store, id, ws } = await rig();
    await store.swapRow<ProjectRecord>('projects', id, r => ({ ...r!, is_demo: true }));
    for (const command of ALL) expect(await ws({ command, path: 'memory/overview.md', text: 'x', old: 'a', new: 'b', from: 'memory/a.md', to: 'memory/b.md', pattern: 'x' }), command)
      .toEqual({ success: false, code: 'WORKSPACE_UNAVAILABLE', error: 'Demo and evaluation projects have no personal memory or template files.' });
  });
  it('(d) an unknown command with no project open is INVALID_TOOL_INPUT (ENUM), not WORKSPACE_UNAVAILABLE', async () => {
    const r = await workspaceTool({ command: 'mv' }, { store: setup(), projectId: null, channel: 'mcp' }) as Rec;
    expect(r).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', details: { errors: [{ path: '$.command', code: 'ENUM' }] } });
  });
  it('(e) every ls entry has a non-empty metadata.description', async () => {
    const { store, id, ws } = await rig();
    await setMemoryEnabled(true, store); await writeMemory('overview.md', 'Hello', store, NOW);
    await saveProjectTemplate(store, id, (await store.read(id))!.document, NOW);
    const r = await ws({ command: 'ls', limit: 1000 });
    for (const f of r.files) { expect(typeof f.metadata.description, f.path).toBe('string'); expect(f.metadata.description.length, f.path).toBeGreaterThan(0); }
  });
  it('(f) ls cutframe and ls template are sorted by path in code-unit order; ls with no path keeps memory, template, cutframe', async () => {
    const { store, id, ws } = await rig();
    await setMemoryEnabled(true, store); await writeMemory('overview.md', 'Hello', store, NOW);
    await saveProjectTemplate(store, id, (await store.read(id))!.document, NOW);
    for (const path of ['cutframe', 'template']) {
      const paths: string[] = (await ws({ command: 'ls', path, limit: 1000 })).files.map((f: Rec) => f.path);
      expect(paths.length, path).toBeGreaterThanOrEqual(2);
      expect(paths, path).toEqual([...paths].sort());
    }
    const roots: string[] = (await ws({ command: 'ls', limit: 1000 })).files.map((f: Rec) => f.path.split('/')[0]);
    expect([...new Set(roots)]).toEqual(['memory', 'template', 'cutframe']);
  });
  it('(g) Learn off: every template/ write, edit, copy-to and delete is read-only, and every template/ entry is readOnly', async () => {
    const { store, id, ws } = await rig();
    await setMemoryEnabled(true, store); await writeMemory('a.md', 'one', store, NOW);
    await saveProjectTemplate(store, id, (await store.read(id))!.document, NOW);
    expect((await ws({ command: 'write', path: 'template/skills/vlog.md', text: 'one' })).success).toBe(true);
    await setProjectLearning(store, id, false);
    for (const input of [{ command: 'write', path: 'template/skills/vlog.md', text: 'x' }, { command: 'write', path: 'template/skills/new.md', text: 'x' },
      { command: 'edit', path: 'template/skills/vlog.md', old: 'one', new: 'two' }, { command: 'copy', from: 'memory/a.md', to: 'template/skills/copy.md' },
      { command: 'delete', path: 'template/skills/vlog.md' }])
      expect(code(await ws(input)), JSON.stringify(input)).toBe('WORKSPACE_READ_ONLY');
    const files = (await ws({ command: 'ls', path: 'template', limit: 1000 })).files as Rec[];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f.readOnly, f.path).toBe(true);
    expect((await ws({ command: 'cat', path: 'template/skills/vlog.md' })).success).toBe(true);
  });
});
