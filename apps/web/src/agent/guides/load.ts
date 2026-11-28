// SPDX-License-Identifier: AGPL-3.0-only
// T23 loadSkill (contracts loadSkill, §3h #44; results §2 loadSkill; T23 notes "loadSkill"). A bare id returns its mechanics
// guide and that guide's `related` bundle, then the creative layer: the template's skills/<id> when it has one, else our
// creative default (RC B3). The chat form is one JSON envelope; the MCP form is a header block and a text block per document.
// Ids are case-sensitive; surrounding whitespace is ignored.
import type { ToolResult } from '../protocol';
import { rootPath } from '../workspace/paths';
import { templateSkill, templateState } from '../workspace/template';
import { closestSkills, guide, mechanicsId, resolveSkill } from './registry';
import type { Guide, GuideKind } from './registry';
import type { GuideContext } from './tools';

export type SkillDocument = { skillId: string; kind: GuideKind; path: string; content: string; readOnly: boolean };
type Source = 'cutframe' | 'template';
const HEADER: Record<`${GuideKind}:${Source}`, string> = {
  'technical:cutframe': 'Cutframe technical guide', 'technical:template': 'Cutframe technical guide',
  'creative:cutframe': 'Cutframe creative default', 'creative:template': 'Template creative guide',
};
export const notRegistered = (name: string): ToolResult => ({ success: false, code: 'CREATIVE_SKILL_NOT_REGISTERED',
  error: `CREATIVE_SKILL_NOT_REGISTERED: ${name}. Closest registered skills: ${closestSkills(name).join(', ')}` });

export async function loadSkill(input: Record<string, unknown>, ctx: GuideContext): Promise<ToolResult> {
  const name = typeof input.skillName === 'string' ? input.skillName.trim() : String(input.skillName ?? '');
  const skill = resolveSkill(name);
  if (!skill) return notRegistered(name);
  // `label` names a document in its MCP header: without `.editor`, and the requested id for the main guide (RC 11.2 B4).
  const docs: (SkillDocument & { source: Source; label: string })[] = [];
  const technical = (g: Guide, label = mechanicsId(g.topic)) => docs.push({ skillId: `${mechanicsId(g.topic)}.editor`, kind: 'technical', path: rootPath('cutframe', g.path), content: g.body, readOnly: true, source: 'cutframe', label });
  const main = guide(skill.mechanics, 'technical');
  if (main) {
    technical(main, name);
    for (const topic of main.related) {
      const g = guide(topic, 'technical');
      if (g && !docs.some(d => d.path === g.path)) technical(g);
    }
  }
  // RC B6: with no project open, the mechanics and our creative defaults still load.
  // A `.editor` id loads the mechanics guide and its related bundle, no creative layer (ours; RC 11.2 B4: not tested).
  const own = ctx.projectId && !skill.technicalOnly ? await templateSkill(ctx.store, ctx.projectId, skill.id) : undefined;
  const fallback = skill.creative ? guide(skill.creative, 'creative') : undefined;
  if (own !== undefined) {
    // Template skills are writable only while Learn is on (RC C4); I2's templateState holds the one Learn value (D92).
    const learning = (await templateState(ctx.store, ctx.projectId!))?.learning ?? false;
    docs.push({ skillId: skill.id, kind: 'creative', path: rootPath('template', `skills/${skill.id}.md`), content: own, readOnly: !learning, source: 'template', label: skill.id });
  } else if (fallback) docs.push({ skillId: skill.id, kind: 'creative', path: rootPath('cutframe', fallback.path), content: fallback.body, readOnly: true, source: 'cutframe', label: skill.id });
  if (ctx.channel === 'mcp')
    return { success: true, content: docs.flatMap(d => [{ type: 'text', text: `${HEADER[`${d.kind}:${d.source}`]}: ${d.label}` }, { type: 'text', text: d.content }]) };
  const documents = docs.map(({ source: _, label: __, ...d }) => d);
  return { success: true, skillName: name, resolvedSkillIds: [skill.id], content: documents.map(d => `## ${d.skillId}\n\n${d.content}`).join('\n\n'),
    documents, _completeCreativeContent: true, inlineImageCount: 0 };
}
