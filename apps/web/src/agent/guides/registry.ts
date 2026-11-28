// SPDX-License-Identifier: AGPL-3.0-only
// T23 skill registry (findings part 2 §42; T23 notes "Guide files"): our own guides, `library/<topic>.editor.markdown`
// (mechanics) and `library/<topic>.creative.markdown` (creative defaults), each opening with a front-matter block
// (topic, kind, summary, related). D37's public copy drops every .md, so the files are .markdown, imported raw.
// Ids follow Xapp's where sensible (contracts loadSkill, §3h #44); the table is lane F's default until lane R's RC B1.

export type GuideKind = 'technical' | 'creative';
export type Guide = { topic: string; kind: GuideKind; summary: string; related: string[]; body: string; path: string };
/** One registered id: the mechanics topic it loads (with that guide's `related` bundle), then its creative default, if any. */
export type Skill = { id: string; mechanics: string; creative?: string; technicalOnly?: boolean; aliases: string[] };
/** A guide as a file of the workspace's `cutframe/` root (I2); `path` is relative to that root. */
export type GuideFile = { path: string; text: string; summary: string; kind: GuideKind };

const sources = import.meta.glob('./library/*.markdown', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const FILE = /^\.\/library\/([a-z0-9-]+)\.(editor|creative)\.markdown$/;
const HEAD = /^---\n([\s\S]*?)\n---\n?/;

/** The front-matter block's fields and the text after it, or null when the text has no block. */
export function frontMatter(text: string): { fields: Record<string, string>; body: string } | null {
  const t = text.replace(/\r\n/g, '\n'), head = HEAD.exec(t);
  if (!head) return null;
  const fields: Record<string, string> = {};
  for (const line of head[1].split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { fields, body: t.slice(head[0].length).replace(/^\n+/, '') };
}
/** A guide's path inside the workspace's `cutframe/` root (I2's ROOTS table adds the root): a mechanics guide sits under its
 *  id's folder, `<mechanicsId>.editor.md`, as Xapp's `xapp/<id>.editor.md` (RC 11.2 B3, 11.3 C1). */
export const guidePath = (topic: string, kind: GuideKind) => kind === 'technical' ? `${mechanicsId(topic)}.editor.md` : `creative/${topic}.md`;

/** Parses one library file; a file whose name and block disagree is a build fault, so it throws. */
export function parseGuide(file: string, text: string): Guide {
  const name = FILE.exec(file), parsed = frontMatter(text);
  if (!name) throw new Error(`Guide file ${file}: name is not <topic>.editor|creative.markdown`);
  if (!parsed) throw new Error(`Guide file ${file}: no front-matter block`);
  const { fields, body } = parsed, kind: GuideKind = name[2] === 'editor' ? 'technical' : 'creative';
  if (fields.topic !== name[1]) throw new Error(`Guide file ${file}: topic is ${fields.topic ?? 'missing'}, expected ${name[1]}`);
  if (fields.kind !== kind) throw new Error(`Guide file ${file}: kind is ${fields.kind ?? 'missing'}, expected ${kind}`);
  if (!fields.summary) throw new Error(`Guide file ${file}: summary is missing`);
  const related = (fields.related ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return { topic: name[1], kind, summary: fields.summary, related, body, path: guidePath(name[1], kind) };
}

const key = (topic: string, kind: GuideKind) => `${kind}:${topic}`;
const GUIDES = new Map<string, Guide>(); // filled below SKILLS: a guide's path needs its mechanics id
export const guide = (topic: string, kind: GuideKind): Guide | undefined => GUIDES.get(key(topic, kind));
export const guides = (): Guide[] => [...GUIDES.values()];
/** The orientation text (getAgentOverview block 1), without a front-matter block if it has one. */
export const ORIENTATION = (() => {
  const text = sources['./library/orientation.markdown'] ?? '';
  return frontMatter(text)?.body ?? text.replace(/\r\n/g, '\n');
})();

/** Registry order: the tie-break of the closest-id list (RC B5). Aliases include Xapp's ids that map onto one of our guides
 *  (RC 11.2 B1), so replayed Xapp calls load; ids with no guide of ours (sound-design, creative-direction, art-direction,
 *  shapes, text-looks, elements, overlays, image-generation, output/platforms) stay unregistered. */
export const SKILLS: Skill[] = [
  { id: 'assembly/timeline', mechanics: 'timeline', aliases: [] },
  { id: 'assembly/short-form', mechanics: 'timeline', creative: 'short-form', aliases: [] },
  { id: 'assembly/long-form', mechanics: 'timeline', creative: 'long-form', aliases: [] },
  { id: 'vlog', mechanics: 'timeline', creative: 'vlog', aliases: [] },
  { id: 'assembly/finding-media', mechanics: 'finding-media', aliases: [] },
  { id: 'assembly/layouts', mechanics: 'layouts', aliases: [] },
  { id: 'assembly/multi-cam', mechanics: 'multi-cam', creative: 'multi-cam', aliases: [] },
  { id: 'reframe', mechanics: 'reframe', aliases: [] }, // a Cutframe addition (RF-P02)
  { id: 'audio/mixing', mechanics: 'audio', aliases: [] },
  { id: 'audio/music-sync', mechanics: 'music-sync', aliases: [] },
  { id: 'audio/transcript-cleanup', mechanics: 'transcript-cleanup', aliases: [] },
  { id: 'audio/voice-over', mechanics: 'voice-over', aliases: [] },
  { id: 'export', mechanics: 'export', aliases: [] },
  { id: 'text/captioning', mechanics: 'captions', aliases: [] },
  { id: 'text/text-placement', mechanics: 'text-placement', aliases: [] },
  { id: 'keyframing', mechanics: 'keyframing', aliases: [] },
  { id: 'time-remapping', mechanics: 'time-remapping', aliases: [] },
  { id: 'transitions', mechanics: 'transitions', aliases: ['visuals/transitions'] },
  { id: 'effects', mechanics: 'effects', aliases: [] },
  { id: 'masking', mechanics: 'masks', aliases: ['masking-and-shapes/masking', 'masking-and-shapes/mask-shape-animation'] },
  { id: 'masking-and-shapes/smart-masking', mechanics: 'smart-masking', aliases: [] },
  { id: 'motion-graphics', mechanics: 'motion-graphics', aliases: ['motion-graphics/charts'] },
];
/** The id a mechanics guide is known by: the first registered id that loads it with no creative layer of its own. */
export const mechanicsId = (topic: string): string => (SKILLS.find(s => s.mechanics === topic && !s.creative) ?? SKILLS.find(s => s.mechanics === topic))?.id ?? topic;

/** Xapp's `.editor` ids that are not ours, by the mechanics topic they map onto (RC 11.2 B1). */
const EDITOR_ALIASES: Record<string, string[]> = {
  audio: ['audio/audio.editor'], 'voice-over': ['audio/voiceover.editor'], captions: ['text/captions.editor'],
  masks: ['masking-and-shapes/masks.editor'], effects: ['visuals/effects.editor'], transitions: ['visuals/transitions.editor'],
  'motion-graphics': ['3d', 'charts', 'media', 'renderer', 'sequencing', 'spring-physics', 'transitions', 'typography'].map(t => `motion-graphics/${t}.editor`),
};
/** `<mechanicsId>.editor`, one per mechanics guide: that guide and its related bundle, no creative layer (RC 11.2 B5). Our
 *  documents carry these ids as `skillId`, so the model can call one back. After SKILLS in registry order. */
export const EDITOR_SKILLS: Skill[] = [...new Set(SKILLS.map(s => s.mechanics))]
  .map(topic => ({ id: `${mechanicsId(topic)}.editor`, mechanics: topic, technicalOnly: true, aliases: EDITOR_ALIASES[topic] ?? [] }));
const REGISTERED = [...SKILLS, ...EDITOR_SKILLS];
const BY_NAME = new Map<string, Skill>(REGISTERED.flatMap(s => [[s.id, s], ...s.aliases.map(a => [a, s] as [string, Skill])]));
/** The registered skill for an id or alias (case-sensitive), or undefined. */
export const resolveSkill = (name: string): Skill | undefined => BY_NAME.get(name);

for (const [file, text] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
  if (!FILE.test(file)) continue; // orientation.markdown is read by overview.ts
  const g = parseGuide(file, text);
  GUIDES.set(key(g.topic, g.kind), g);
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
/** The not-registered error's list (RC 11.2 B5): every registered name under `<name>/` when there is one (registry order),
 *  else the `count` registered ids nearest to `name` by edit distance, ties in registry order. */
export function closestSkills(name: string, count = 3): string[] {
  const under = [...BY_NAME.keys()].filter(n => n.startsWith(`${name}/`));
  if (under.length) return under;
  return REGISTERED.map((s, n) => ({ id: s.id, n, d: distance(name, s.id) })).sort((a, b) => a.d - b.d || a.n - b.n).slice(0, count).map(s => s.id);
}

/** Every guide as a `cutframe/` workspace file, mechanics first, each group by topic. */
export function guideFiles(): GuideFile[] {
  const rank = (g: Guide) => g.kind === 'technical' ? 0 : 1;
  return guides().sort((a, b) => rank(a) - rank(b) || a.topic.localeCompare(b.topic)).map(g => ({ path: g.path, text: g.body, summary: g.summary, kind: g.kind }));
}
