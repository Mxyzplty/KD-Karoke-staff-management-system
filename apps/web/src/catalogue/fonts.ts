// SPDX-License-Identifier: AGPL-3.0-only
// T22 font lists (findings part 2 §33): a priority list per caption template plus a general list; each font has a role
// (caption / text / both). A font picker shows the template's list first, then the general list, without repeating a
// family; this browser's uploads come last (our addition: the spec names only the two lists). The lists and their notes
// are our own picks from the T05 registry; the spec gives their shape, not their content. Pure data and lookups.
import { TEMPLATES } from '../captions/templates';
import { findFont, fontFamilies, FONT_REGISTRY } from '../text/font-registry';
import type { FontCategory, FontFamilyEntry } from '../text/font-registry';

export type FontRole = 'caption' | 'text' | 'both';
export type FontPick = { family: string; role: FontRole; note: string };

const p = (family: string, role: FontRole, note: string): FontPick => ({ family, role, note });
/** The general list's role and note of a family, by its category: display and handwriting faces are for titles. */
const BY_CATEGORY: Record<FontCategory, [FontRole, string]> = {
  'sans-serif': ['both', 'Sans-serif: clear at any size.'], serif: ['both', 'Serif: calm and formal.'], monospace: ['both', 'Monospace: code and data.'],
  display: ['text', 'Display: short titles only.'], handwriting: ['text', 'Handwriting: short, personal lines.'],
};

/** Keyed by caption template id (captions/templates.ts), plus `general`: every registry family in its rank order. */
export const FONT_LISTS: Readonly<Record<string, readonly FontPick[]>> = {
  default: [p('Open Sans', 'both', 'The plain default: even and easy to read.'), p('Roboto', 'both', 'Neutral and compact.'), p('Lato', 'both', 'Soft and friendly.'), p('Nunito', 'caption', 'Rounded and gentle.')],
  cinema: [p('Roboto', 'both', 'Quiet and neutral under a picture.'), p('Barlow', 'caption', 'Narrow: long lines stay short.'), p('Work Sans', 'both', 'Wide and steady.'), p('Lora', 'both', 'A serif for a film look.')],
  editorial: [p('Cormorant', 'both', 'Fine, high-contrast serif.'), p('Playfair Display', 'both', 'Strong serif for headings.'), p('EB Garamond', 'both', 'Classic book serif.'), p('Libre Baskerville', 'caption', 'Sturdy serif at small sizes.')],
  handwritten: [p('Satisfy', 'both', 'Flowing brush script.'), p('Caveat', 'both', 'Quick pen handwriting.'), p('Kaushan Script', 'text', 'Bold brush strokes.'), p('Shadows Into Light', 'caption', 'Light, neat handwriting.')],
  'karaoke-pop': [p('Anton', 'both', 'Tall and heavy: made for capitals.'), p('Bebas Neue', 'both', 'Narrow capitals.'), p('Oswald', 'both', 'Condensed with several weights.'), p('Archivo Black', 'caption', 'Wide and very heavy.')],
  punch: [p('Bebas Neue', 'both', 'Narrow capitals for one big word.'), p('Anton', 'both', 'Tall and heavy.'), p('Teko', 'caption', 'Square and tight.'), p('Russo One', 'text', 'Blocky and loud.')],
  subtitle: [p('Open Sans', 'both', 'Bold and plain: the subtitle standard.'), p('Roboto', 'both', 'Neutral and compact.'), p('Source Sans Pro', 'caption', 'Made for reading on screens.'), p('Fira Sans', 'caption', 'Clear letter shapes.')],
  tiktok: [p('Inter', 'both', 'Bold, tight and modern.'), p('TikTok Sans', 'both', 'The short-video look.'), p('Poppins', 'both', 'Round and geometric.'), p('Montserrat', 'both', 'Wide and confident.')],
  '8-bit': [p('Press Start 2P', 'both', 'Pixel type.'), p('Jersey 10', 'both', 'Small pixel type.'), p('Space Mono', 'caption', 'Monospace with a retro feel.'), p('Orbitron', 'text', 'Square, science-fiction letters.')],
  general: FONT_REGISTRY.map(f => p(f.family, ...BY_CATEGORY[f.category as FontCategory])),
};

/** A font picker's families: the caption template's list, then the general list (the registry in rank order) without a
 *  family twice, then this browser's uploads. No template, or one without a list: the registry, then the uploads. */
export function fontPickerOrder(templateId?: string): FontFamilyEntry[] {
  const all = fontFamilies(), listed = (templateId && Object.hasOwn(FONT_LISTS, templateId) ? FONT_LISTS[templateId] : [])
    .flatMap(x => all.filter(f => f.source === 'google' && f.family === x.family));
  return [...listed, ...all.filter(f => !listed.includes(f))];
}

type InputError = { path: string; code: string; message: string };
type Result = { success: true; data: Record<string, unknown> } | { success: false; error: string; code?: string; message?: string; details?: { errors: InputError[] } };
const MAX_PICKS = 12;
const ROLES: Record<string, FontRole> = { titles: 'text', captions: 'caption' };
/** The agent's `fonts` tool (contracts "fonts"; read-only). With `familyName`: that family's faces, or a failure without a
 *  code (results document, code-less failures). Without: the ranked picks, the `videoStyle` caption template's list (its
 *  id or name, any case; an unknown value is ignored) before the general list, narrowed by `role` (titles: text or both;
 *  captions: caption or both). `total` counts every family that can be asked for by name. A `role` outside the two values
 *  and a `familyName` or `videoStyle` that is not text are refused in the helper's INVALID_TOOL_INPUT shape (as presets/tools.ts). */
export function fonts(args: { familyName?: unknown; role?: unknown; videoStyle?: unknown } = {}): Result {
  const text = (key: 'familyName' | 'videoStyle'): InputError[] => args[key] === undefined || typeof args[key] === 'string' ? [] : [{ path: `$.${key}`, code: 'TYPE', message: 'must be string' }];
  const errors: InputError[] = [
    ...text('familyName'),
    ...(args.role === undefined || typeof args.role === 'string' && Object.hasOwn(ROLES, args.role) ? [] : [{ path: '$.role', code: 'ENUM', message: 'must be equal to one of the allowed values' }]),
    ...text('videoStyle'),
  ];
  if (errors.length) return { success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for fonts', message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors } };
  if (typeof args.familyName === 'string') {
    const entry = findFont(args.familyName)?.entry;
    if (!entry) return { success: false, error: `Font '${args.familyName}' was not found. Call fonts without familyName for the fonts you can use.` };
    return { success: true, data: { family: entry.family, category: entry.category, variants: entry.variants.map(v => ({ weight: v.weight, italic: v.italic, label: v.label })) } };
  }
  const style = typeof args.videoStyle === 'string' ? args.videoStyle.trim().toLowerCase() : '', template = style ? TEMPLATES.find(t => t.id === style || t.name.toLowerCase() === style) : undefined;
  const role = typeof args.role === 'string' && Object.hasOwn(ROLES, args.role) ? ROLES[args.role] : undefined, seen = new Set<string>();
  const picks = [...template ? FONT_LISTS[template.id] ?? [] : [], ...FONT_LISTS.general].filter(x => (!role || x.role === role || x.role === 'both') && !seen.has(x.family) && !!seen.add(x.family))
    .slice(0, MAX_PICKS).map(x => { const e = findFont(x.family)!.entry; return { family: x.family, role: x.role, category: e.category, styles: e.variants.map(v => v.label), note: x.note }; });
  return { success: true, data: { picks, total: fontFamilies().length, hint: 'These are picks, not the whole catalogue. Pass familyName to get the styles of any family, also one that is not listed here.' } };
}
