// SPDX-License-Identifier: AGPL-3.0-only
// Static text checks the agent tools run before compiling (reference compares §1.4). Pure string scans, as in Xapp: a
// match inside a string or comment counts.
import { MEDIA_REFUSALS } from './policy';
export { MEDIA_REFUSALS } from './policy';

/** A lowercase native media tag followed by whitespace or `>`; `<video/>` and `<Video>` are left to the compiler. */
export function nativeMediaRefusal(code: string): string | null {
  const m = /<(img|video|audio)[\s>]/.exec(code);
  return m ? MEDIA_REFUSALS[m[1] as keyof typeof MEDIA_REFUSALS] : null;
}

/** Every `getAssetUrl("…")` / `getAssetUrl('…')` id written as a literal, de-duplicated. */
export const assetIds = (code: string): string[] => [...new Set(Array.from(code.matchAll(/getAssetUrl\(\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)')\s*\)/g), m => m[1] ?? m[2]))];
/** Every literal getAssetUrl id that is not an asset's agentId, one part each. */
export function assetIdRefusal(code: string, assets: readonly { agentId: string; id: string }[]): string | null {
  const parts = assetIds(code).flatMap(id => {
    if (assets.some(a => a.agentId === id)) return [];
    const internal = assets.find(a => a.id === id);
    return [internal ? `'${id}' is asset '${internal.agentId}': use getAssetUrl('${internal.agentId}').` : `'${id}' is not an asset attached to this project.`];
  });
  return parts.length ? `getAssetUrl() takes a project asset's agentId. ${parts.join(' ')}` : null;
}

// ---- Fonts. The catalogue is the faces the sandbox draws (fonts.ts); anything else falls back to a system font.
export const FONT_WARNING = (name: string) => `Font "${name}" is not in the font catalog — it will fall back to a system font when rendered (editor preview may differ from the export). Use a catalog font.`;
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset']);
/** The catalogue's family names as shown (the inspector's font select); SANDBOX_FAMILIES is the lowercase lookup. */
export const SANDBOX_FAMILY_NAMES: readonly string[] = ['Roboto'];
export const SANDBOX_FAMILIES: ReadonlySet<string> = new Set(SANDBOX_FAMILY_NAMES.map(f => f.toLowerCase()));
/** The first family of each `fontFamily` written as a literal, read from the source text (a template literal is not
 *  evaluated, so `${font}` stays as written). */
export function fontNames(code: string): string[] {
  const values = Array.from(code.matchAll(/fontFamily\s*(?::|=)\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`)/g), m => m[1] ?? m[2] ?? m[3]);
  return [...new Set(values.map(v => v.split(',')[0].trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean))];
}
export function fontWarnings(code: string, catalog: ReadonlySet<string> = SANDBOX_FAMILIES): string[] {
  return fontNames(code).filter(name => !GENERIC.has(name.toLowerCase()) && !catalog.has(name.toLowerCase())).map(FONT_WARNING);
}
