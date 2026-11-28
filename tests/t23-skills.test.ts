// SPDX-License-Identifier: AGPL-3.0-only
// T23 loadSkill and getAgentOverview (contracts loadSkill / getAgentOverview, §3h #41 / #44; results §2; T23 notes "loadSkill",
// "getAgentOverview"). Oracles: the guide files on disk (front matter `related`), the T23 notes' id table and literal texts,
// and the T22 template records written through T22's own functions. Native stores on fake-indexeddb; no mocks.
import 'fake-indexeddb/auto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSkill } from '../apps/web/src/agent/guides/load';
import { MEMORY_AFTER, MEMORY_BEFORE, MEMORY_CLOSE, MEMORY_OPEN, NO_PROJECT_TEMPLATE, PROJECT_FORBIDDEN, getAgentOverview, memoryBlock } from '../apps/web/src/agent/guides/overview';
import { overviewText, templateState } from '../apps/web/src/agent/workspace/template';
import { EDITOR_SKILLS, ORIENTATION, SKILLS } from '../apps/web/src/agent/guides/registry';
import { guideTool } from '../apps/web/src/agent/guides/tools';
import type { GuideContext } from '../apps/web/src/agent/guides/tools';
import { writeMemory } from '../apps/web/src/agent/workspace/memory';
import { ProjectStore } from '../apps/web/src/store/database';
import type { MediaStore } from '../apps/web/src/store/media';
import type { ProjectRecord } from '../apps/web/src/store/model';
import { setProjectLearning } from '../apps/web/src/templates/binding';
import { lessonTemplate, saveProjectTemplate, updateTemplate } from '../apps/web/src/templates/library';
import type { Template } from '../apps/web/src/templates/model';

type Rec = Record<string, any>;
const NOW = new Date('2026-11-15T03:00:00.000Z'), opened: ProjectStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });
function setup() {
  let tick = NOW.getTime();
  const media: MediaStore = { write: vi.fn(async () => {}), read: vi.fn(async () => { throw new Error('unused'); }), remove: vi.fn(async () => {}) };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return store;
}
const ctx = (store: ProjectStore, projectId: string | null, channel: 'chat' | 'mcp' = 'chat'): GuideContext => ({ store, projectId, channel });
const LIBRARY = fileURLToPath(new URL('../apps/web/src/agent/guides/library/', import.meta.url));
const read = (f: string) => readFileSync(LIBRARY + f, 'utf8').replace(/\r\n/g, '\n');
const head = (t: string) => Object.fromEntries((/^---\n([\s\S]*?)\n---/.exec(t)?.[1] ?? '').split('\n').map(l => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
const bodyOf = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\n+/, '');
const relatedOf = (topic: string) => (head(read(`${topic}.editor.markdown`)).related ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
const exists = (f: string) => readdirSync(LIBRARY).includes(f);

/** The T23 notes' id table (lane F's defaults), plus I1's reframe skill after assembly/multi-cam: id → mechanics topic, creative topic, aliases. */
const TABLE: [string, string, string?][] = [
  ['assembly/timeline', 'timeline'], ['assembly/short-form', 'timeline', 'short-form'], ['assembly/long-form', 'timeline', 'long-form'], ['vlog', 'timeline', 'vlog'],
  ['assembly/finding-media', 'finding-media'], ['assembly/layouts', 'layouts'], ['assembly/multi-cam', 'multi-cam', 'multi-cam'], ['reframe', 'reframe'], ['audio/mixing', 'audio'],
  ['audio/music-sync', 'music-sync'], ['audio/transcript-cleanup', 'transcript-cleanup'], ['audio/voice-over', 'voice-over'], ['export', 'export'],
  ['text/captioning', 'captions'], ['text/text-placement', 'text-placement'], ['keyframing', 'keyframing'], ['time-remapping', 'time-remapping'],
  ['transitions', 'transitions'], ['effects', 'effects'], ['masking', 'masks'], ['masking-and-shapes/smart-masking', 'smart-masking'], ['motion-graphics', 'motion-graphics'],
];
const ALIASES: Record<string, string> = { 'visuals/transitions': 'transitions' };
/** The id a mechanics guide's document is known by: the first id loading it with no creative layer, else the first. */
const mechanicsId = (topic: string) => (SKILLS.find(s => s.mechanics === topic && !s.creative) ?? SKILLS.find(s => s.mechanics === topic))!.id;
const REGISTERED = [...SKILLS, ...EDITOR_SKILLS];
const techPath = (topic: string) => `cutframe/${mechanicsId(topic)}.editor.md`;
function expectedDocs(id: string): { skillId: string; kind: string; path: string; content: string }[] {
  const s = REGISTERED.find(k => k.id === id)!, topics = [s.mechanics];
  for (const t of relatedOf(s.mechanics)) if (!topics.includes(t) && exists(`${t}.editor.markdown`)) topics.push(t); // one level deep
  const docs = topics.map(t => ({ skillId: `${mechanicsId(t)}.editor`, kind: 'technical', path: techPath(t), content: bodyOf(read(`${t}.editor.markdown`)) }));
  if (s.creative && !s.technicalOnly) docs.push({ skillId: id, kind: 'creative', path: `cutframe/creative/${s.creative}.md`, content: bodyOf(read(`${s.creative}.creative.markdown`)) });
  return docs;
}
function levenshtein(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
async function project(store: ProjectStore, title = 'Trip') { const p = await store.create(title); return { id: p.id, doc: (await store.read(p.id))!.document }; }
const skillFile = (path: string, text: string) => ({ path, text, version: 1, updatedAt: NOW.toISOString() });

describe('T23 loadSkill: the registry', () => {
  it('registers exactly the id table, in order, with the transitions alias', () => {
    const ids = SKILLS.map(s => s.id);
    expect(ids).toEqual(TABLE.map(([id]) => id));
    for (const [id, mechanics, creative] of TABLE) expect(SKILLS.find(s => s.id === id), id).toMatchObject({ mechanics, ...(creative ? { creative } : {}) });
    expect(SKILLS.find(s => s.id === 'transitions')!.aliases).toEqual(['visuals/transitions']);
    expect(SKILLS.find(s => s.id === 'masking')!.aliases).toEqual(['masking-and-shapes/masking', 'masking-and-shapes/mask-shape-animation']);
    expect(SKILLS.find(s => s.id === 'motion-graphics')!.aliases).toEqual(['motion-graphics/charts']);
  });
  it('EDITOR_SKILLS: one technical-only <mechanicsId>.editor per distinct mechanics topic, with Xapp\'s .editor aliases', () => {
    const topics = [...new Set(SKILLS.map(s => s.mechanics))];
    expect(EDITOR_SKILLS.map(s => s.id)).toEqual(topics.map(t => `${mechanicsId(t)}.editor`));
    for (const s of EDITOR_SKILLS) expect(s.technicalOnly, s.id).toBe(true);
    const aliases = Object.fromEntries(EDITOR_SKILLS.filter(s => s.aliases.length).map(s => [s.mechanics, s.aliases]));
    expect(aliases).toEqual({ audio: ['audio/audio.editor'], 'voice-over': ['audio/voiceover.editor'], captions: ['text/captions.editor'], masks: ['masking-and-shapes/masks.editor'],
      effects: ['visuals/effects.editor'], transitions: ['visuals/transitions.editor'],
      'motion-graphics': ['3d', 'charts', 'media', 'renderer', 'sequencing', 'spring-physics', 'transitions', 'typography'].map(t => `motion-graphics/${t}.editor`) });
  });
  it('a reframe skill is registered with its guide', () => {
    expect(exists('reframe.editor.markdown')).toBe(true);
    expect(SKILLS.some(s => s.mechanics === 'reframe'), 'no registered id loads reframe.editor').toBe(true);
  });
});

describe('T23 loadSkill: every id and alias loads, in both forms', () => {
  const names = [...REGISTERED.flatMap(s => [s.id, ...s.aliases])];
  for (const name of names) it(`${name}`, async () => {
    const store = setup(), id = REGISTERED.find(s => s.id === name || s.aliases.includes(name))!.id, want = expectedDocs(id);
    const chat = await loadSkill({ skillName: name }, ctx(store, null, 'chat')) as Rec;
    expect(chat).toMatchObject({ success: true, skillName: name, resolvedSkillIds: [id], _completeCreativeContent: true, inlineImageCount: 0 });
    expect(chat.documents).toEqual(want.map(d => ({ ...d, readOnly: true })));
    expect(chat.content).toBe(want.map(d => `## ${d.skillId}\n\n${d.content}`).join('\n\n'));
    // RC 11.2 B3: every chat load is complete with no images; every technical document is read-only.
    for (const d of chat.documents.filter((d: Rec) => d.kind === 'technical')) expect(d, d.path).toMatchObject({ kind: 'technical', readOnly: true });
    const mcp = await loadSkill({ skillName: name }, ctx(store, null, 'mcp')) as Rec;
    expect(Object.keys(mcp).sort()).toEqual(['content', 'success']);
    // RC 11.2 B4: the header names the requested id for the main guide, mechanicsId(topic) for a related one, never `.editor`.
    const label = (d: { skillId: string; kind: string }, n: number) => d.kind === 'creative' ? d.skillId : n === 0 ? name : d.skillId.replace(/\.editor$/, '');
    expect(mcp.content).toEqual(want.flatMap((d, n) => [{ type: 'text', text: `${d.kind === 'technical' ? 'Cutframe technical guide' : 'Cutframe creative default'}: ${label(d, n)}` }, { type: 'text', text: d.content }]));
    // A `.editor` request names itself in the first header; every other header has no `.editor`.
    for (const b of mcp.content.filter((_: Rec, n: number) => n % 2 === 0).slice(name.endsWith('.editor') ? 1 : 0)) expect(b.text).not.toContain('.editor');
  });
  it('bundle order: mechanics, then its related guides one level deep (not theirs), then the creative layer', async () => {
    const store = setup();
    for (const s of REGISTERED) {
      const docs = (await loadSkill({ skillName: s.id }, ctx(store, null)) as Rec).documents as Rec[];
      expect(docs[0].path).toBe(techPath(s.mechanics));
      for (const d of docs.filter(d => d.kind === 'technical')) expect(d.path, d.skillId).toBe(`cutframe/${d.skillId}.md`);
      const kinds = docs.map(d => d.kind);
      expect(kinds.indexOf('creative') === -1 || kinds.indexOf('creative') === kinds.length - 1, s.id).toBe(true);
      const second = relatedOf(s.mechanics).flatMap(t => exists(`${t}.editor.markdown`) ? relatedOf(t) : []).filter(t => t !== s.mechanics && !relatedOf(s.mechanics).includes(t));
      for (const t of second) expect(docs.map(d => d.path), `${s.id} must not pull ${t}`).not.toContain(techPath(t));
    }
  });
  it('W1\'s bundles: finding-media loads finding-media then timeline; timeline and its creatives load timeline only', async () => {
    const store = setup(), techs = async (n: string) => ((await loadSkill({ skillName: n }, ctx(store, null)) as Rec).documents as Rec[]).filter(d => d.kind === 'technical').map(d => d.skillId);
    expect(await techs('assembly/finding-media')).toEqual(['assembly/finding-media.editor', 'assembly/timeline.editor']);
    for (const n of ['assembly/timeline', 'assembly/short-form', 'assembly/long-form', 'vlog']) expect(await techs(n), n).toEqual(['assembly/timeline.editor']);
  });
  it('.editor ids: the mechanics bundle only, no creative layer even with a template skill, resolvedSkillIds the .editor id', async () => {
    const store = setup(), p = await project(store), own = await lessonTemplate(store, p.id, p.doc, NOW);
    await updateTemplate(store, own.id, t => ({ ...t, files: SKILLS.map(s => skillFile(`skills/${s.id}.md`, 'Template text.')) }), NOW);
    // The base id loads the template skill; its `.editor` id ignores it.
    expect(((await loadSkill({ skillName: 'keyframing' }, ctx(store, p.id)) as Rec).documents as Rec[]).at(-1)).toMatchObject({ kind: 'creative', path: 'template/skills/keyframing.md' });
    for (const e of EDITOR_SKILLS) for (const name of [e.id, ...e.aliases]) {
      const r = await loadSkill({ skillName: name }, ctx(store, p.id)) as Rec;
      expect(r, name).toMatchObject({ success: true, resolvedSkillIds: [e.id] });
      expect(r.documents.every((d: Rec) => d.kind === 'technical'), name).toBe(true);
      expect(r.documents.map((d: Rec) => d.path), name).toEqual(expectedDocs(e.id).map(d => d.path));
    }
  });
  it('round trip: every document skillId of vlog loads', async () => {
    const store = setup();
    for (const d of (await loadSkill({ skillName: 'vlog' }, ctx(store, null)) as Rec).documents as Rec[])
      expect(await loadSkill({ skillName: d.skillId }, ctx(store, null)), d.skillId).toMatchObject({ success: true });
  });
  it('the new aliases load the same documents as their ids', async () => {
    const store = setup(), docs = async (n: string) => (await loadSkill({ skillName: n }, ctx(store, null)) as Rec).documents;
    for (const [id, alias] of [['masking', 'masking-and-shapes/masking'], ['masking', 'masking-and-shapes/mask-shape-animation'], ['motion-graphics', 'motion-graphics/charts']])
      expect(await docs(alias), alias).toEqual(await docs(id));
  });
  it('surrounding whitespace is ignored; ids are case-sensitive', async () => {
    const store = setup();
    expect(await loadSkill({ skillName: '  transitions ' }, ctx(store, null))).toMatchObject({ success: true, resolvedSkillIds: ['transitions'] });
    expect(await loadSkill({ skillName: 'Transitions' }, ctx(store, null))).toMatchObject({ success: false, code: 'CREATIVE_SKILL_NOT_REGISTERED' });
  });
});

describe('T23 loadSkill: unknown ids', () => {
  const NAMES = REGISTERED.flatMap(s => [s.id, ...s.aliases]), under = (name: string) => NAMES.filter(n => n.startsWith(`${name}/`));
  const refusal = (name: string, list: string[]) => ({ success: false, code: 'CREATIVE_SKILL_NOT_REGISTERED', error: `CREATIVE_SKILL_NOT_REGISTERED: ${name}. Closest registered skills: ${list.join(', ')}` });
  for (const name of ['transition', 'captions', 'zzz', 'masking-and-shapes/masks', 'audio/']) it(`${name} → code, exact text, the 3 closest ids`, async () => {
    expect(under(name)).toEqual([]);
    const ids = REGISTERED.map(s => s.id), closest = ids.map((id, n) => ({ id, n, d: levenshtein(name, id) })).sort((a, b) => a.d - b.d || a.n - b.n).slice(0, 3).map(c => c.id);
    for (const channel of ['chat', 'mcp'] as const) expect(await loadSkill({ skillName: name }, ctx(setup(), null, channel))).toEqual(refusal(name, closest));
  });
  // RC 11.2 B5: a name that prefixes registered ids lists every one of them under `<name>/`, in registry order.
  for (const name of ['audio', 'text', 'assembly', 'masking-and-shapes', 'visuals']) it(`${name} → every registered id under ${name}/`, async () => {
    expect(under(name).length, name).toBeGreaterThan(0);
    for (const channel of ['chat', 'mcp'] as const) expect(await loadSkill({ skillName: name }, ctx(setup(), null, channel))).toEqual(refusal(name, under(name)));
  });
  it('the prefix lists, literally (lane F\'s expected lists)', () => {
    expect(under('audio')).toEqual(['audio/mixing', 'audio/music-sync', 'audio/transcript-cleanup', 'audio/voice-over', 'audio/mixing.editor', 'audio/audio.editor', 'audio/music-sync.editor', 'audio/transcript-cleanup.editor', 'audio/voice-over.editor', 'audio/voiceover.editor']);
    expect(under('text')).toEqual(['text/captioning', 'text/text-placement', 'text/captioning.editor', 'text/captions.editor', 'text/text-placement.editor']);
    expect(under('visuals')).toEqual(['visuals/transitions', 'visuals/transitions.editor', 'visuals/effects.editor']);
    expect(under('masking-and-shapes')).toEqual(['masking-and-shapes/masking', 'masking-and-shapes/mask-shape-animation', 'masking-and-shapes/smart-masking', 'masking-and-shapes/masks.editor', 'masking-and-shapes/smart-masking.editor']);
  });
  it('transition names transitions first', async () => {
    expect((await loadSkill({ skillName: 'transition' }, ctx(setup(), null)) as Rec).error).toMatch(/Closest registered skills: transitions, /);
  });
});

describe('T23 loadSkill: id forms in the MCP header (RC 11.2 B4)', () => {
  const headers = async (name: string) => ((await loadSkill({ skillName: name }, ctx(setup(), null, 'mcp')) as Rec).content as Rec[]).filter((_, n) => n % 2 === 0).map(b => b.text as string);
  it('assembly/multi-cam names itself, then its related assembly/timeline', async () => {
    const h = await headers('assembly/multi-cam');
    expect(h[0]).toBe('Cutframe technical guide: assembly/multi-cam');
    expect(h).toContain('Cutframe technical guide: assembly/timeline');
  });
  it('an alias is named as typed; whitespace is trimmed', async () => {
    expect((await headers('visuals/transitions'))[0]).toBe('Cutframe technical guide: visuals/transitions');
    expect((await headers('  keyframing '))[0]).toBe('Cutframe technical guide: keyframing');
  });
});

describe('T23 loadSkill: project and template', () => {
  it('with no project, the mechanics guides and the creative defaults still load', async () => {
    const r = await loadSkill({ skillName: 'vlog' }, ctx(setup(), null)) as Rec;
    expect(r.documents.map((d: Rec) => [d.kind, d.path])).toEqual(expectedDocs('vlog').map(d => [d.kind, d.path]));
    expect(r.documents.at(-1)).toMatchObject({ kind: 'creative', path: 'cutframe/creative/vlog.md', readOnly: true });
  });
  it('a project with no template gets our creative default', async () => {
    const store = setup(), p = await project(store);
    expect((await loadSkill({ skillName: 'assembly/short-form' }, ctx(store, p.id)) as Rec).documents).toEqual(expectedDocs('assembly/short-form').map(d => ({ ...d, readOnly: true })));
  });
  it('the template\'s skills/<id>.md replaces the default; readOnly follows Learn', async () => {
    const store = setup(), p = await project(store), own = await lessonTemplate(store, p.id, p.doc, NOW);
    await updateTemplate(store, own.id, t => ({ ...t, files: [skillFile('skills/vlog.md', 'Our own vlog rules.'), skillFile('skills/assembly/short-form.md', 'Short rules.')] }), NOW);
    const on = await loadSkill({ skillName: 'vlog' }, ctx(store, p.id)) as Rec;
    expect(on.documents.at(-1)).toEqual({ skillId: 'vlog', kind: 'creative', path: 'template/skills/vlog.md', content: 'Our own vlog rules.', readOnly: false });
    expect(on.documents.filter((d: Rec) => d.kind === 'creative')).toHaveLength(1);
    const mcp = await loadSkill({ skillName: 'vlog' }, ctx(store, p.id, 'mcp')) as Rec;
    expect(mcp.content.slice(-2)).toEqual([{ type: 'text', text: 'Template creative guide: vlog' }, { type: 'text', text: 'Our own vlog rules.' }]);
    expect((await loadSkill({ skillName: 'assembly/short-form' }, ctx(store, p.id)) as Rec).documents.at(-1)).toMatchObject({ path: 'template/skills/assembly/short-form.md', content: 'Short rules.' });
    await setProjectLearning(store, p.id, false);
    expect((await loadSkill({ skillName: 'vlog' }, ctx(store, p.id)) as Rec).documents.at(-1)).toMatchObject({ path: 'template/skills/vlog.md', readOnly: true });
    // A skill the template does not supply keeps our default.
    expect((await loadSkill({ skillName: 'assembly/long-form' }, ctx(store, p.id)) as Rec).documents.at(-1)).toMatchObject({ path: 'cutframe/creative/long-form.md' });
  });
  it('a template skill for an id with no creative default is added after the mechanics', async () => {
    const store = setup(), p = await project(store), own = await lessonTemplate(store, p.id, p.doc, NOW);
    await updateTemplate(store, own.id, t => ({ ...t, files: [skillFile('skills/transitions.md', 'Only dissolves.')] }), NOW);
    const docs = (await loadSkill({ skillName: 'transitions' }, ctx(store, p.id)) as Rec).documents;
    expect(docs.map((d: Rec) => d.path)).toEqual([...expectedDocs('transitions').map(d => d.path), 'template/skills/transitions.md']);
  });
});

describe('T23 getAgentOverview: separate text blocks (G-07)', () => {
  const B = (...texts: string[]) => ({ success: true, content: texts.map(text => ({ type: 'text', text })) });
  const O = ORIENTATION;
  const M = (m: string) => memoryBlock(m);
  const GONE = 'This project\'s template (gone-template) is no longer in the library: loadSkill gives Cutframe\'s creative defaults.';
  const call = async (store: ProjectStore, id: string, input: Rec = {}) => await getAgentOverview(input, ctx(store, id)) as Rec;
  const stateText = async (store: ProjectStore, id: string) => overviewText((await templateState(store, id))!);
  it('0: memoryBlock is open, newline, the trimmed-end memory, a blank line, close', () => {
    expect([MEMORY_OPEN, MEMORY_BEFORE, MEMORY_AFTER, MEMORY_CLOSE]).toEqual(['<memory_overview>', '\n', '\n\n', '</memory_overview>']);
    for (const m of ['note', '# Memory\n\n- x\n', '  lead\n\n'])
      expect(M(m), JSON.stringify(m)).toBe('<memory_overview>' + '\n' + m.trimEnd() + '\n\n' + '</memory_overview>');
  });
  it('1: with no project, PROJECT_FORBIDDEN on both channels', async () => {
    for (const channel of ['chat', 'mcp'] as const)
      expect(await getAgentOverview({}, ctx(setup(), null, channel))).toEqual({ success: false, code: 'PROJECT_FORBIDDEN', error: 'Open a project owned by your signed-in account.' });
    expect(PROJECT_FORBIDDEN).toBe('Open a project owned by your signed-in account.');
  });
  it('2: own project, no template, memory saved: orientation, then the memory block (literal bytes)', async () => {
    const store = setup(), p = await project(store);
    await writeMemory('overview.md', '# Memory\n\n- Prefers lower-case captions.\n', store);
    expect(await call(store, p.id)).toEqual(B(O, '<memory_overview>\n# Memory\n\n- Prefers lower-case captions.\n\n</memory_overview>'));
  });
  it('2b: own project, no template, empty memory (missing, empty, whitespace): orientation alone', async () => {
    const store = setup(), p = await project(store);
    expect(await call(store, p.id)).toEqual(B(O));
    for (const m of ['', '   \n']) { await writeMemory('overview.md', m, store); expect(await call(store, p.id), JSON.stringify(m)).toEqual(B(O)); }
  });
  it('3: a template: orientation, memory, then the template block; without memory, orientation then the template', async () => {
    const store = setup(), p = await project(store, 'Beach day'), made = await saveProjectTemplate(store, p.id, p.doc, NOW);
    await updateTemplate(store, made.id, t => ({ ...t, guidance: 'Warm and calm.', preferences: 'No emoji.', captionTemplateId: 'cap-1', files: [skillFile('skills/vlog.md', 'x'), skillFile('examples/intro.txt', 'y')] }), NOW);
    expect(await call(store, p.id)).toEqual(B(O, await stateText(store, p.id)));
    await writeMemory('overview.md', 'note', store);
    const r = await call(store, p.id);
    expect(r).toEqual(B(O, M('note'), await stateText(store, p.id)));
    const last = r.content.at(-1).text as string, t = (await store.row<{ templates: Template[] }>('settings', 'templates'))!.templates[0];
    for (const part of [`# Template: Beach day template`, `${t.family} template by ${t.author}.`, '## Guidance', 'Warm and calm.', '## Defaults',
      `- Titles font: ${t.defaults.titlesFont}`, `- Captions font: ${t.defaults.captionsFont}`, `- Accent font: ${t.defaults.accentFont}`, '- Caption template: cap-1',
      '## Learned preferences', 'No emoji.', '## Learn', 'On: ', '## Creative skills', '`vlog` (template/skills/vlog.md)', 'template/examples/intro.txt'])
      expect(last, part).toContain(part);
    await setProjectLearning(store, p.id, false);
    expect((await call(store, p.id)).content.at(-1).text).toContain('Off: template/ is read-only.');
  });
  it('4: a bound template that is gone: its notice as the last block', async () => {
    const store = setup(), p = await project(store);
    await store.swapRow<ProjectRecord>('projects', p.id, r => ({ ...r!, template_id: 'gone-template' }));
    expect(await call(store, p.id)).toEqual(B(O, GONE));
    await writeMemory('overview.md', 'note', store);
    expect(await call(store, p.id)).toEqual(B(O, M('note'), GONE));
  });
  it('5: a demo project: orientation and memory when saved, no template block', async () => {
    const store = setup(), p = await project(store);
    await store.swapRow<ProjectRecord>('projects', p.id, r => ({ ...r!, is_demo: true }));
    expect(await call(store, p.id)).toEqual(B(O));
    await writeMemory('overview.md', 'Private note.', store);
    expect(await call(store, p.id)).toEqual(B(O, '<memory_overview>\nPrivate note.\n\n</memory_overview>'));
  });
  it('6: a project id with no row: orientation, memory when saved, then the stored notice', async () => {
    const store = setup();
    expect(NO_PROJECT_TEMPLATE).toBe('Open and connect a project to load its template.');
    expect(await call(store, 'no-such-project')).toEqual(B(O, 'Open and connect a project to load its template.'));
    await writeMemory('overview.md', 'note', store);
    expect(await call(store, 'no-such-project')).toEqual(B(O, M('note'), 'Open and connect a project to load its template.'));
  });
  it('7: reads fresh on every call; refresh changes nothing; only memory/overview.md counts', async () => {
    const store = setup(), p = await project(store);
    expect((await call(store, p.id)).content).toHaveLength(1);
    await writeMemory('overview.md', 'note', store);
    expect((await call(store, p.id)).content).toHaveLength(2);
    await saveProjectTemplate(store, p.id, p.doc, NOW);
    const after = await call(store, p.id);
    expect(after.content).toHaveLength(3);
    expect(await call(store, p.id, { refresh: true })).toEqual(after);
    await writeMemory('notes.md', 'Not the index.', store);
    expect(await call(store, p.id, { refresh: true })).toEqual(after);
  });
});

describe('T23 round 1: store failures (R7d)', () => {
  for (const [tool, input] of [['loadSkill', { skillName: 'vlog' }], ['getAgentOverview', {}]] as const)
    it(`R7d: ${tool} answers success:false with a code when the store rejects`, async () => {
      const store = setup(), p = await project(store);
      vi.spyOn(store, 'row').mockRejectedValue(new Error('IndexedDB is broken.'));
      vi.spyOn(store, 'read').mockRejectedValue(new Error('IndexedDB is broken.'));
      expect(await guideTool(tool, input, ctx(store, p.id))).toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'IndexedDB is broken.' });
      vi.spyOn(store, 'row').mockRejectedValue(Object.assign(new Error('Quota.'), { code: 'STORAGE_FULL' }));
      expect(await guideTool(tool, input, ctx(store, p.id))).toMatchObject({ success: false, code: 'STORAGE_FULL', error: 'Quota.' });
    });
});
