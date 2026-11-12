// SPDX-License-Identifier: AGPL-3.0-only
// The font files bundled for the default project template (T22; vendor/t22/fonts, OFL, in vendor/manifest.json), so its
// three families load without the network. Each file is Google Fonts' Latin subset: Sora and Manrope are variable (one file
// for every weight), Instrument Serif has a regular and an italic file. A text with a character outside the subset still
// gets Google's other subset files when Google answers (text/fonts.ts).
const files = import.meta.glob('../../../../vendor/t22/fonts/*.woff2', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const file = (name: string): string | undefined => files[`../../../../vendor/t22/fonts/${name}-latin.woff2`];
const BUNDLED: Record<string, (italic: boolean) => string | undefined> = {
  Sora: italic => italic ? undefined : file('Sora'),
  Manrope: italic => italic ? undefined : file('Manrope'),
  'Instrument Serif': italic => file(italic ? 'InstrumentSerif-Italic' : 'InstrumentSerif-Regular'),
};
/** The unicode-range of the bundled files: the `latin` block of each family's Google Fonts stylesheet, read on 11 Nov 2026
 *  (the three families give the same range, and the block's file is the bundled one):
 *    https://fonts.googleapis.com/css2?family=Sora:wght@100..800&display=block
 *    https://fonts.googleapis.com/css2?family=Manrope:wght@200..800&display=block
 *    https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=block */
export const LATIN_RANGE = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
/** A CSS unicode-range as sorted [from, to] pairs (wildcards are not used by the ranges compared here). */
const pairs = (range: string): number[][] => range.split(',').map(t => t.trim().replace(/^U\+/i, '').split('-').map(h => parseInt(h, 16))).filter(p => Number.isFinite(p[0])).map(p => [p[0], p[1] ?? p[0]]).sort((a, b) => a[0] - b[0]);
const LATIN = pairs(LATIN_RANGE), key = (p: number[][]) => p.map(x => x.join('-')).join(',');
export type BundledFont = { url: string; unicodeRange: string };
/** The bundled file of a family's upright or italic face, or undefined when the family is not bundled. */
export function bundledFont(family: string, italic: boolean): BundledFont | undefined {
  const url = BUNDLED[family]?.(italic);
  return url ? { url, unicodeRange: LATIN_RANGE } : undefined;
}
/** Whether every character of the text is in the bundled files' range. */
export const bundledCovers = (text: string): boolean => [...text].every(c => { const n = c.codePointAt(0)!; return LATIN.some(([a, b]) => n >= a && n <= b); });
/** Whether a face's unicode-range is the bundled files' range (Google's own copy of the bundled file). */
export const isBundledRange = (range: unknown): boolean => typeof range === 'string' && key(pairs(range)) === key(LATIN);
