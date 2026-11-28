// SPDX-License-Identifier: AGPL-3.0-only
// T23 the workspace's template root (contracts §1 and `workspace`; T22 notes "A template made by a first lesson"; D92, D99).
// The root shows the open project's template: the one it is bound to, else its own template (made by "Save to My
// templates" or by a first lesson, D85 / D99), else nothing but the overview's notice.
// - `overview.md` and `fonts.md` are generated from the template record and read-only.
// - `skills/<id>.md` and `examples/<name>` are the template's own text files, writable only while Learn is on (RC C4).
//   Learn is the bound template's `learning`; in a project with no template it is projectLearning (D92: one value).
// - D99: the agent's first write under the root, in a project with no template and Learn on, first makes the project's own
//   template with T22's lessonTemplate, then applies the write. A read or a switch change makes nothing.
// The template's text files are the record's `files` list (T22's model; lane F's ruling of 15 Nov).
import type { ProjectStore } from '../../store/database';
import type { ProjectDocument, ProjectRecord } from '../../store/model';
import { FONT_LISTS } from '../../catalogue/fonts';
import { findFont } from '../../text/font-registry';
import { projectLearning } from '../../templates/binding';
import { findTemplate, lessonTemplate, projectTemplate, updateTemplate } from '../../templates/library';
import { defaultsOf, TEMPLATE_FILE_MAX_CHARS, TEMPLATE_FILE_PATH, type Template, type TemplateTextFile } from '../../templates/model';

export { TEMPLATE_FILE_MAX_CHARS, type TemplateTextFile };
/** The template's text files. */
export const templateFiles = (t: Template): TemplateTextFile[] => t.files ?? [];

export const OVERVIEW_FILE = 'overview.md', FONTS_FILE = 'fonts.md', SKILLS_FOLDER = 'skills', EXAMPLES_FOLDER = 'examples';
export const SKILL_PATH = /^skills\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*\.md$/;
export const EXAMPLE_PATH = /^examples\/[A-Za-z0-9][A-Za-z0-9._ -]*$/;
export const skillFile = (id: string) => `${SKILLS_FOLDER}/${id}.md`;
/** What a path under the template root is. */
export const templatePlace = (rest: string): 'generated' | 'file' | 'other' =>
  rest === OVERVIEW_FILE || rest === FONTS_FILE ? 'generated' : TEMPLATE_FILE_PATH.test(rest) ? 'file' : 'other';

/** Our one-line notices (RC A1). */
export const NO_TEMPLATE = 'This project has no template: loadSkill gives Cutframe\'s creative defaults, and nothing project-specific applies.';
export const MISSING_TEMPLATE = (id: string) => `This project's template (${id}) is no longer in the library: loadSkill gives Cutframe's creative defaults.`;

export type TemplateState = {
  record: ProjectRecord;
  /** The template the project is bound to (its chip). */
  bound?: Template;
  /** The project's own template, listed or not (D85, D99). */
  own?: Template;
  /** What the template root shows: the bound template, else (unbound) the project's own. */
  active?: Template;
  /** The bound template's id when the project is bound to a template that is gone. */
  missing?: string;
  /** The Learn switch the root obeys. */
  learning: boolean;
};
/** The open project's template state, read fresh; undefined when the project is gone or a demo. */
export async function templateState(store: ProjectStore, projectId: string): Promise<TemplateState | undefined> {
  const record = await store.row<ProjectRecord>('projects', projectId);
  if (!record || record.is_demo) return undefined;
  const own = await projectTemplate(store, projectId), bound = record.template_id ? await findTemplate(store, record.template_id) : undefined;
  if (record.template_id && !bound) return { record, own, missing: record.template_id, learning: false };
  return { record, bound, own, active: bound ?? own, learning: bound ? bound.learning : projectLearning(record, own) };
}

const list = (items: string[], none: string) => items.length ? items.map(i => `- ${i}`) : [none];
/** The skill ids a template supplies (its `skills/<id>.md` files), in path order. */
export const templateSkillIds = (t: Template): string[] =>
  templateFiles(t).filter(f => SKILL_PATH.test(f.path)).map(f => f.path.slice(SKILLS_FOLDER.length + 1, -3)).sort();

/** `template/overview.md`, which is also getAgentOverview's third block (T23 notes "getAgentOverview"). */
export function overviewText(state: TemplateState): string {
  const t = state.active;
  if (!t) return state.missing ? MISSING_TEMPLATE(state.missing) : NO_TEMPLATE;
  const d = defaultsOf(t, state.record.template_epoch ?? 0), skills = templateSkillIds(t);
  const examples = templateFiles(t).filter(f => EXAMPLE_PATH.test(f.path)).map(f => `template/${f.path}`);
  return [
    `# Template: ${t.name}`, '',
    `${t.family} template by ${t.author}.${state.bound ? '' : ' The project shows "No template": this is its own template, which keeps what is learned from feedback.'}`, '',
    '## Guidance', '', t.guidance.trim() || 'None.', '',
    '## Defaults', '',
    `- Titles font: ${d.titlesFont}`, `- Captions font: ${d.captionsFont}`, `- Accent font: ${d.accentFont}`,
    `- Caption template: ${t.captionTemplateId ?? 'none'}`,
    `- Colours: ${d.palette.length ? d.palette.map(s => `${s.name} ${s.hex}`).join(', ') : 'none'}`,
    `- Presets: ${t.presetIds.length ? t.presetIds.join(', ') : 'none'}`, '',
    '## Learned preferences', '', t.preferences.trim() || 'None yet.', '',
    '## Learn', '',
    state.learning ? 'On: lessons from the user\'s feedback may be saved under template/skills/ and template/examples/.'
      : 'Off: template/ is read-only. Keep feedback inside this project.', '',
    '## Creative skills', '',
    ...list(skills.map(id => `\`${id}\` (template/${skillFile(id)})`), 'None: loadSkill gives Cutframe\'s creative defaults.'), '',
    '## Examples', '',
    ...list([...t.examples.map(r => `${r.name} (\`${r.ref}\`)`), ...examples], 'None.'), '',
  ].join('\n');
}

/** `template/fonts.md`: the template's three default fonts with their styles, its font list and its caption template's picks. */
export function fontsText(t: Template): string {
  const styles = (name: string) => { const e = findFont(name)?.entry; return e ? `${e.family} | ${e.variants.map(v => v.label).join(', ')}` : 'not installed | —'; };
  const picks = t.captionTemplateId ? FONT_LISTS[t.captionTemplateId] ?? [] : [];
  return [
    `# Fonts of ${t.name}`, '',
    '| Use | Font | Family | Styles |', '|---|---|---|---|',
    `| Titles | ${t.defaults.titlesFont} | ${styles(t.defaults.titlesFont)} |`,
    `| Captions | ${t.defaults.captionsFont} | ${styles(t.defaults.captionsFont)} |`,
    `| Accent | ${t.defaults.accentFont} | ${styles(t.defaults.accentFont)} |`, '',
    '## Template fonts', '', ...list(t.assets.fonts.map(r => `${r.name} (\`${r.ref}\`)`), 'None.'), '',
    `## Caption template picks${t.captionTemplateId ? ` (${t.captionTemplateId})` : ''}`, '',
    ...list(picks.map(p => `${p.family} (${p.role}): ${p.note}`), 'None.'), '',
  ].join('\n');
}

/** The text of `template/overview.md`, or our one-line notice when the project has no template (I1's block 3). */
export async function templateOverview(store: ProjectStore, projectId: string): Promise<string> {
  const state = await templateState(store, projectId);
  return state ? overviewText(state) : NO_TEMPLATE;
}
/** The text of `template/skills/<id>.md` (loadSkill's creative layer), or undefined. `id` is the bare skill id. */
export async function templateSkill(store: ProjectStore, projectId: string, id: string): Promise<string | undefined> {
  const t = (await templateState(store, projectId))?.active;
  return t && templateFiles(t).find(f => f.path === skillFile(id))?.text;
}

/** The template that a write goes into: the active one, or (D99) the project's own, made now by a first lesson. */
export async function lessonTarget(store: ProjectStore, projectId: string, state: TemplateState, doc: () => ProjectDocument | undefined): Promise<Template> {
  if (state.active) return state.active;
  const document = doc() ?? (await store.read(projectId))?.document;
  if (!document) throw new Error('This project no longer exists.');
  return lessonTemplate(store, projectId, document);
}
/** Writes, replaces or (text null) removes one text file of a template, in one step. Returns the file, or null when removed. */
export async function writeTemplateFile(store: ProjectStore, id: string, path: string, text: string | null, now = new Date()): Promise<TemplateTextFile | null> {
  let written: TemplateTextFile | null = null;
  await updateTemplate(store, id, t => {
    const files = templateFiles(t), before = files.find(f => f.path === path), rest = files.filter(f => f.path !== path);
    written = text === null ? null : { path, text, version: (before?.version ?? 0) + 1, updatedAt: now.toISOString() };
    return { ...t, files: written ? [...rest, written] : rest };
  }, now);
  return written;
}
