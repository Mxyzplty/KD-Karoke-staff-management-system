// SPDX-License-Identifier: AGPL-3.0-only
// The project template document (T22; findings §22, Cutframe spec line): a local document with a named palette, examples,
// reusable assets, the three default fonts, a caption template id, preset ids, written guidance for the agent, the learning
// switch and the preferences notes. A template is data only (plan P9): it names fonts, sounds, elements, library assets and
// presets by reference and never carries code.
// Cutframe readings (§22 gives the list names, not their entries): an entry is `{name, ref}` with the ref kinds of REF_KINDS;
// a default font is a name the font registry resolves (a family or a face name such as "Manrope-Bold"), checked at use.
import type { RecordData } from '../store/model';

/** What each list may refer to. `font:<family>`, `sound:<slug>` and `element:<id>` are our catalogues, `asset:<id>` is a file
 *  of the user's library, `preset:<id>` a style or motion-graphic preset. */
export const REF_KINDS = {
  examples: ['preset', 'asset', 'element', 'sound'], fonts: ['font'], audio: ['sound', 'asset'], images: ['element', 'asset'],
} as const;
export type TemplateRef = { name: string; ref: string };
export type Swatch = { name: string; hex: string };
export type FontDefaults = { captionsFont: string; titlesFont: string; accentFont: string };
export type Template = {
  id: string; name: string;
  /** The label above the name on the preview page ("<family> TEMPLATE"). */
  family: string; author: string;
  palette: Swatch[]; examples: TemplateRef[];
  assets: { fonts: TemplateRef[]; audio: TemplateRef[]; images: TemplateRef[] };
  defaults: FontDefaults;
  captionTemplateId?: string; presetIds: string[];
  guidance: string; learning: boolean; preferences: string;
  version: number; savedAt: string;
  /** Set on the personal copy of a built-in template (it has the built-in's id). */
  basedOn?: string;
};
export const TEMPLATE_VERSION = 1, BUILT_IN_FAMILY = 'Cutframe', PERSONAL_FAMILY = 'Personal';
/** The document key new items read (plan P3). */
export type TemplateDefaults = FontDefaults & { templateId: string; epoch: number; palette: Swatch[] };
/** A bound project's default font for new titles or captions (plan P4), or undefined in a project without a template. */
export const defaultFont = (doc: Record<string, unknown>, key: 'titlesFont' | 'captionsFont'): string | undefined => {
  const name = (doc.templateDefaults as RecordData | undefined)?.[key];
  return typeof name === 'string' && name.trim() ? name : undefined;
};
export const defaultsOf = (t: Template, epoch: number): TemplateDefaults => ({ templateId: t.id, epoch, ...t.defaults, palette: t.palette.map(s => ({ ...s })) });

const KEYS = ['id', 'name', 'family', 'author', 'palette', 'examples', 'assets', 'defaults', 'captionTemplateId', 'presetIds', 'guidance', 'learning', 'preferences', 'version', 'savedAt', 'basedOn'];
const OPTIONAL = ['captionTemplateId', 'basedOn'];
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const plain = (v: unknown): v is RecordData => !!v && typeof v === 'object' && !Array.isArray(v);
/** The keys of `o` outside `allowed`, or the missing ones, as a reason; null when the keys are exactly right. */
function keysProblem(o: RecordData, allowed: readonly string[], optional: readonly string[] = []): string | null {
  const extra = Object.keys(o).find(k => !allowed.includes(k));
  if (extra !== undefined) return `unknown field ${extra}`;
  const missing = allowed.find(k => !optional.includes(k) && o[k] === undefined);
  return missing ? `${missing} is missing` : null;
}
export const refKind = (ref: string) => ref.slice(0, Math.max(0, ref.indexOf(':')));
function refsProblem(list: unknown, kinds: readonly string[], where: string): string | null {
  if (!Array.isArray(list)) return `${where} is not a list`;
  for (const [n, r] of list.entries()) {
    if (!plain(r)) return `${where}[${n}] is not an object`;
    const keys = keysProblem(r, ['name', 'ref']);
    if (keys) return `${where}[${n}]: ${keys}`;
    if (!text(r.name)) return `${where}[${n}]: name is missing`;
    if (typeof r.ref !== 'string' || !kinds.includes(refKind(r.ref)) || r.ref.endsWith(':')) return `${where}[${n}]: ref must be ${kinds.map(k => `${k}:<id>`).join(' or ')}`;
  }
  return null;
}
/** The reason a record is not a template, or null. The schema is closed: an unknown field is a reason. */
export function templateProblem(r: unknown): string | null {
  if (!plain(r)) return 'not an object';
  const keys = keysProblem(r, KEYS, OPTIONAL);
  if (keys) return keys;
  if (!text(r.id) || !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) return 'id must be lower-case letters, digits and hyphens';
  for (const k of ['name', 'family', 'author', 'savedAt']) if (!text(r[k])) return `${k} is missing`;
  for (const k of ['guidance', 'preferences']) if (typeof r[k] !== 'string') return `${k} is not text`;
  if (typeof r.learning !== 'boolean') return 'learning must be true or false';
  if (r.version !== TEMPLATE_VERSION) return `version must be ${TEMPLATE_VERSION}`;
  if (!Array.isArray(r.palette)) return 'palette is not a list';
  for (const [n, s] of r.palette.entries()) {
    if (!plain(s)) return `palette[${n}] is not an object`;
    const k = keysProblem(s, ['name', 'hex']);
    if (k) return `palette[${n}]: ${k}`;
    if (!text(s.name)) return `palette[${n}]: name is missing`;
    if (typeof s.hex !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(s.hex)) return `palette[${n}]: hex must be #RRGGBB`;
  }
  if (!plain(r.assets)) return 'assets is not an object';
  if (!plain(r.defaults)) return 'defaults is not an object';
  const fonts = ['captionsFont', 'titlesFont', 'accentFont'], lists = ['fonts', 'audio', 'images'] as const;
  const d = keysProblem(r.defaults, fonts), blank = fonts.find(f => !text(r.defaults[f]));
  if (d || blank) return d ? `defaults: ${d}` : `defaults.${blank} is missing`;
  const a = keysProblem(r.assets, lists);
  if (a) return `assets: ${a}`;
  const refs = refsProblem(r.examples, REF_KINDS.examples, 'examples') ?? lists.map(l => refsProblem(r.assets[l], REF_KINDS[l], `assets.${l}`)).find(Boolean);
  if (refs) return refs;
  if (r.captionTemplateId !== undefined && !text(r.captionTemplateId)) return 'captionTemplateId is not text';
  if (!Array.isArray(r.presetIds) || r.presetIds.some((p: unknown) => !text(p))) return 'presetIds is not a list of ids';
  if (r.basedOn !== undefined && r.basedOn !== r.id) return 'basedOn must equal id';
  return null;
}
/** Every `{name, ref}` of a template, examples first. */
export const templateRefs = (t: Template): TemplateRef[] => [...t.examples, ...t.assets.fonts, ...t.assets.audio, ...t.assets.images];
