// SPDX-License-Identifier: AGPL-3.0-only
// T09 caption styles (findings part 3 §44.3; agent tool results §12): the panel and agent defaults and the nine templates.
// Values are the portrait table of §44.3 plus the landscape overrides it states; any other landscape value and every
// description, tag and accent colour is ours (unmeasured; notes, Q4 and Q5). Ids: the eight slugs of the tickets plus a
// stable `8-bit` (Xapp serves that one under a generated id). Pure data: no DOM, no font files.
import type { RecordData } from '../store/model';
import type { ChunkOptions } from './chunker';
import { CHUNK_DEFAULTS } from './chunker';

export type Shadow = { color: string; x: number; y: number; blur: number };
/** One look a caption can start from. fontWeight is stored as a string (W3-RF-04: "400"). */
export type StyleSpec = {
  family: string; fontWeight: string; fontStyle: string; fontSize: number; color: string; backgroundColor: string;
  textTransform: string; textDecoration?: string; letterSpacing: string; borderWidth: number; borderColor: string; boxShadow: Shadow;
  renderMode: string; renderConfig: RecordData; textAnimation?: RecordData; position: 'bottom' | 'centre';
};
const NO_SHADOW: Shadow = { color: 'transparent', x: 0, y: 0, blur: 0 };
const ZERO_SHADOW: Shadow = { color: '#000000', x: 0, y: 0, blur: 0 };
const shadow = (x: number, y: number, blur: number, alpha: number): Shadow => ({ color: `rgba(0, 0, 0, ${alpha})`, x, y, blur });
const BASE = { fontWeight: '400', fontStyle: 'normal', color: '#FFFFFF', backgroundColor: 'transparent', textTransform: 'none', letterSpacing: 'normal',
  borderWidth: 0, borderColor: '#000000', boxShadow: NO_SHADOW, renderMode: 'default', renderConfig: {}, position: 'bottom' as const };
/** The MANUAL CAPTIONS defaults (§46.5); a generated item stores exactly these (W3-RF-04). */
export const PANEL_STYLE: StyleSpec = { ...BASE, family: 'Open Sans', fontSize: 65, borderWidth: 3, boxShadow: ZERO_SHADOW };
/** addCaptions with no style arguments (G-18, results §12). */
export const AGENT_STYLE: StyleSpec = { ...BASE, family: 'Roboto', fontWeight: '700', fontSize: 65, borderWidth: 3, boxShadow: ZERO_SHADOW };

export type Template = { id: string; name: string; description: string; tags: string[]; accentColors: string[]; limits: Pick<ChunkOptions, 'maxWords' | 'maxCharacters'>;
  style: Partial<StyleSpec> & { family: string; fontSize: number }; landscape?: { limits?: Template['limits']; style?: Partial<StyleSpec> } };
const limits = (maxWords: number, maxCharacters: number) => ({ maxWords, maxCharacters });
export const TEMPLATES: Template[] = [
  { id: 'default', name: 'Default', description: 'Clean bold captions with a soft shadow.', tags: ['clean', 'bold'], accentColors: ['#FFFFFF'], limits: limits(3, 20),
    style: { family: 'Roboto', fontWeight: '900', fontSize: 65, boxShadow: shadow(0, 2, 12, 0.75), renderConfig: { animationDurationMs: 100, slideDistance: 14 } } },
  { id: 'cinema', name: 'Cinema', description: 'Wide-spaced gold serif titles.', tags: ['serif', 'film'], accentColors: ['#E6C069'], limits: limits(4, 15),
    style: { family: 'Cormorant', fontWeight: '700', fontSize: 65, color: '#E6C069', letterSpacing: '0.35em' }, landscape: { style: { textTransform: 'uppercase', fontSize: 52 } } },
  { id: 'editorial', name: 'Editorial', description: 'Large italic serif that slides up word by word.', tags: ['serif', 'italic'], accentColors: ['#FFFFFF'], limits: limits(3, 10),
    style: { family: 'Playfair Display', fontStyle: 'italic', fontSize: 85, boxShadow: shadow(0, 2, 6, 0.5), renderMode: 'slide-up', renderConfig: { animationDurationMs: 50, slideDistance: 20 } },
    landscape: { limits: limits(5, 22), style: { fontSize: 70 } } },
  { id: 'handwritten', name: 'Handwritten', description: 'Relaxed script that slides up gently.', tags: ['script', 'soft'], accentColors: ['#FFFFFF'], limits: limits(3, 15),
    style: { family: 'Satisfy', fontSize: 75, boxShadow: shadow(0, 6, 20, 0.25), renderMode: 'slide-up', renderConfig: { animationDurationMs: 100, slideDistance: 10 } }, landscape: { limits: limits(5, 30) } },
  { id: 'karaoke-pop', name: 'Karaoke Pop', description: 'Uppercase display type with a yellow active word.', tags: ['uppercase', 'highlight'], accentColors: ['#FFFFFF', '#FFE600'], limits: limits(3, 15),
    style: { family: 'Anton', fontSize: 90, textTransform: 'uppercase', letterSpacing: '0.02em', boxShadow: shadow(0, 4, 14, 0.6), renderMode: 'highlight', renderConfig: { highlightColor: '#FFE600', highlightScale: 1.08 } },
    landscape: { style: { fontSize: 80 } } },
  { id: 'punch', name: 'Punch', description: 'One huge word at a time, centred.', tags: ['uppercase', 'centre'], accentColors: ['#FFFFFF', '#000000'], limits: limits(1, 14),
    style: { family: 'Bebas Neue', fontSize: 160, textTransform: 'uppercase', letterSpacing: '0.04em', borderWidth: 4, position: 'centre' } },
  { id: 'subtitle', name: 'Subtitle', description: 'Plain bold subtitles.', tags: ['clean', 'subtitle'], accentColors: ['#FFFFFF'], limits: limits(5, 22),
    style: { family: 'Open Sans', fontWeight: '700', fontSize: 56, boxShadow: shadow(0, 2, 6, 0.85) } },
  { id: 'tiktok', name: 'TikTok', description: 'Bold white with a heavy black outline.', tags: ['bold', 'outline'], accentColors: ['#FFFFFF', '#000000'], limits: limits(5, 22),
    style: { family: 'Inter', fontWeight: '700', fontSize: 60, borderWidth: 12 } },
  { id: '8-bit', name: '8-bit', description: 'Pixel type typed out with a hard shadow.', tags: ['pixel', 'retro'], accentColors: ['#E5987D', '#2E334D'], limits: limits(3, 15),
    style: { family: 'Press Start 2P', fontSize: 50, color: '#E5987D', boxShadow: { color: '#2E334D', x: 6, y: 10, blur: 0 }, renderConfig: { animationDurationMs: 100, slideDistance: 14 }, textAnimation: { preset: 'typewriter', speed: 3.25 } },
    landscape: { limits: limits(3, 20), style: { boxShadow: { color: '#4C5274', x: 7, y: 7, blur: 0 }, textAnimation: { preset: 'typewriter', speed: 3 } } } },
];
export const findTemplate = (id: unknown) => TEMPLATES.find(t => t.id === id);
export const isLandscape = (size: { width: number; height: number }) => size.width > size.height;
/** A template's look on a canvas. */
export const templateStyle = (t: Template, size: { width: number; height: number }): StyleSpec => ({ ...BASE, ...t.style, ...isLandscape(size) ? t.landscape?.style : {} });
/** A template's chunk options: its own limits, both breaks on (§44.3: the request carries no options). */
export const templateOptions = (t: Template, size: { width: number; height: number }): ChunkOptions => ({ ...CHUNK_DEFAULTS, ...isLandscape(size) && t.landscape?.limits || t.limits });
/** Top of the box (§44.3 position rule): bottom third 0.70 × height; centre H/2 − 0.6 × font size. */
export const styleTop = (s: Pick<StyleSpec, 'position' | 'fontSize'>, height: number) => Math.round(s.position === 'centre' ? height / 2 - 0.6 * s.fontSize : 0.7 * height);
