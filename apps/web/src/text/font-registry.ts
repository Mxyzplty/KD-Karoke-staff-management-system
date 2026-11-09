// SPDX-License-Identifier: AGPL-3.0-only
// T05 font registry and resolution (findings part 2 §33, part 3 §46.7, CAP-07). The picker registry: Xapp's 87 ranked
// families in its rank order, with open substitutes for the two non-Google fonts; categories and variants are Google Fonts'
// metadata (ours: the findings give only Xapp's category totals). Face names as Xapp stores them ("Roboto-Bold"). User
// uploads kept in this browser (IndexedDB). Pure data and lookups (no asset imports, no DOM font API), so the timeline
// tools and the Node scripts can import it; text/fonts.ts loads the faces.
import type { RecordData } from '../store/model';
import { prop } from '../timeline/properties';
import { PARITY } from './parity-switches';

export type FontCategory = 'sans-serif' | 'display' | 'serif' | 'handwriting' | 'monospace';
export type FontVariant = { weight: number; italic: boolean; label: string; face: string };
/** One picker family. rank: Xapp's picker rank (1-based), null for a user upload. substituteFor: the Xapp font it replaces. */
export type FontFamilyEntry = {
  family: string; category: FontCategory | 'user'; rank: number | null; source: 'google' | 'user'; variants: FontVariant[];
  substituteFor?: string; sha256?: string; postScriptName?: string;
};
export type UserFont = { sha256: string; family: string; postScriptName: string; fileName: string; bytes: number; url: string; addedAt: number };
export type FontCode = 'FONT_NOT_FOUND' | 'FONT_LOAD_FAILED' | 'FONT_DELIVERY_FAILED' | 'FONT_TOO_LARGE' | 'FONT_NAME_REQUIRED';
/** A font failure with its error code (error codes l.127–129, l.415–417). */
export class FontError extends Error {
  constructor(readonly code: FontCode, message: string) { super(message); this.name = 'FontError'; }
}

const S = 'sans-serif', D = 'display', R = 'serif', H = 'handwriting', M = 'monospace';
/** [family, category, weights ("a-b" = every 100 from a to b), italics for every weight, the Xapp font it substitutes]. */
type Row = [string, FontCategory, string, 0 | 1, string?];
const ROWS: Row[] = [
  ['Leckerli One', H, '400', 0, 'Mister Firley'], ['Lilita One', D, '400', 0, 'Audio Nugget'], ['TikTok Sans', S, '300-900', 0],
  ['Roboto', S, '100-900', 1], ['Aguafina Script', H, '400', 0], ['Bebas Neue', S, '400', 0], ['Bangers', D, '400', 0],
  ['Bungee Shade', D, '400', 0], ['Cabin', S, '400-700', 1], ['Barlow', S, '100-900', 1], ['Alfa Slab One', D, '400', 0],
  ['Amatic SC', H, '400 700', 0], ['Arvo', R, '400 700', 1], ['Cinzel', R, '400-900', 0], ['Gloria Hallelujah', H, '400', 0],
  ['Archivo Black', S, '400', 0], ['Audiowide', D, '400', 0], ['Comfortaa', D, '300-700', 0], ['Creepster', D, '400', 0],
  ['Anton', S, '400', 0], ['Dancing Script', H, '400-700', 0], ['Fira Sans', S, '100-900', 1], ['Lobster', D, '400', 0],
  ['Orbitron', S, '400-900', 0], ['Lexend Deca', S, '100-900', 0], ['Merriweather', R, '300-900', 1], ['Libre Baskerville', R, '400-700', 1],
  ['Oswald', S, '200-700', 0], ['Montserrat', S, '100-900', 1], ['Inconsolata', M, '200-900', 0], ['Lato', S, '100 300 400 700 900', 1],
  ['Lora', R, '400-700', 1], ['Noto Serif', R, '100-900', 1], ['Iceland', D, '400', 0], ['Kaushan Script', H, '400', 0],
  ['Josefin Sans', S, '100-700', 1], ['Kanit', S, '100-900', 1], ['Luckiest Guy', D, '400', 0], ['Nunito', S, '200-1000', 1],
  ['Open Sans', S, '300-800', 1], ['Pacifico', H, '400', 0], ['Press Start 2P', D, '400', 0], ['Quicksand', S, '300-700', 0],
  ['Roboto Condensed', S, '100-900', 1], ['Roboto Slab', R, '100-900', 0], ['Teko', S, '300-700', 0], ['Shadows Into Light', H, '400', 0],
  ['Poppins', S, '100-900', 1], ['Special Elite', D, '400', 0], ['Raleway', S, '100-900', 1], ['Satisfy', H, '400', 0],
  ['Permanent Marker', H, '400', 0], ['Righteous', D, '400', 0], ['Work Sans', S, '100-900', 1], ['Playfair Display', R, '400-900', 1],
  ['Russo One', S, '400', 0], ['Source Sans Pro', S, '200 300 400 600 700 900', 1], ['Inter', S, '100-900', 1], ['DM Sans', S, '100-1000', 1],
  ['DM Serif Display', R, '400', 1], ['Plus Jakarta Sans', S, '200-800', 1], ['Urbanist', S, '100-900', 1], ['Outfit', S, '100-900', 0],
  ['Sora', S, '100-800', 0], ['Figtree', S, '300-900', 1], ['Space Grotesk', S, '300-700', 0], ['Manrope', S, '200-800', 0],
  ['EB Garamond', R, '400-800', 1], ['Instrument Serif', R, '400', 1], ['Abril Fatface', D, '400', 0], ['Caveat', H, '400-700', 0],
  ['Sacramento', H, '400', 0], ['Great Vibes', H, '400', 0], ['Yesteryear', H, '400', 0], ['Space Mono', M, '400 700', 1],
  ['JetBrains Mono', M, '100-800', 1], ['Rubik', S, '300-900', 1], ['Fredoka', S, '300-700', 0], ['Titan One', D, '400', 0],
  ['Black Ops One', D, '400', 0], ['Bowlby One SC', D, '400', 0], ['Bungee', D, '400', 0], ['Cormorant', R, '300-700', 1],
  ['Unbounded', S, '200-900', 0], ['Sniglet', D, '400 800', 0], ['Jersey 10', D, '400', 0], ['Racing Sans One', D, '400', 0],
];
/** Roboto's weight list as Xapp's picker shows it (findings part 3 §46.7, observed); every other list is Google's. */
const OBSERVED: Record<string, string[]> = { Roboto: ['700', '300', '500', '900', '400', '400i'] };
const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black', 1000: 'ExtraBlack' };
const compact = (family: string) => family.replace(/\s+/g, '');
/** A face's picker label and stored name: "Bold", "Bold Italic", "Italic" (400 italic); "Roboto-BoldItalic". */
export function variant(family: string, weight: number, italic: boolean, face = ''): FontVariant {
  const name = WEIGHT_NAMES[weight] ?? String(weight), suffix = italic ? weight === 400 ? 'Italic' : `${name}Italic` : name;
  return { weight, italic, label: italic ? weight === 400 ? 'Italic' : `${name} Italic` : name, face: face || `${compact(family)}-${suffix}` };
}
const weightList = (spec: string) => spec.split(' ').flatMap(t => {
  const [a, b] = t.split('-').map(Number);
  return b ? Array.from({ length: (b - a) / 100 + 1 }, (_, i) => a + 100 * i) : [a];
});
export const FONT_REGISTRY: readonly FontFamilyEntry[] = ROWS.map(([family, category, weights, italic, substituteFor], i) => {
  const list = OBSERVED[family] ?? [...weightList(weights).map(String), ...italic ? weightList(weights).map(w => `${w}i`) : []];
  return { family, category, rank: i + 1, source: 'google' as const, variants: list.map(v => variant(family, parseInt(v, 10), v.endsWith('i'))), ...substituteFor ? { substituteFor } : {} };
});

// ---- User fonts (stored in this browser; Xapp keeps them per account on its server) ----
const DB = 'cutframe-fonts', STORE = 'fonts';
export const MAX_FONT_BYTES = 8 * 1024 * 1024;
let users: UserFont[] = [];
const memory = new Map<string, { meta: UserFont; blob: Blob }>(); // no IndexedDB (Node): kept for this session only
const userEntry = (u: UserFont): FontFamilyEntry => ({
  family: u.family, category: 'user', rank: null, source: 'user', sha256: u.sha256, postScriptName: u.postScriptName, variants: [variant(u.family, 400, false, u.postScriptName)],
});
/** Every family the picker and the agent may use: the registry in rank order, then this browser's uploads. Plain data for a
 *  future `fonts` tool (T18 / T22 request in the notes). */
export const fontFamilies = (): FontFamilyEntry[] => [...FONT_REGISTRY, ...users.map(userEntry)];

function request<T>(r: IDBRequest<T>): Promise<T> { return new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); }); }
let opened: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  opened ??= new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'meta.sha256' });
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); opened = null; listed = null; users = []; }; ok(r.result); };
    r.onerror = () => { opened = null; fail(r.error); };
  });
  return opened;
}
async function records(): Promise<{ meta: UserFont; blob: Blob }[]> {
  const db = await database();
  return db ? request(db.transaction(STORE).objectStore(STORE).getAll()) : [...memory.values()];
}
/** Reads this browser's uploaded fonts (once per session unless `refresh`). */
let listed: Promise<UserFont[]> | null = null;
export function loadUserFonts(refresh = false): Promise<UserFont[]> {
  if (refresh || !listed) listed = records().then(r => (users = r.map(x => x.meta).sort((a, b) => a.addedAt - b.addedAt))).catch(() => { listed = null; return users; });
  return listed;
}
export const userFonts = (): readonly UserFont[] => users;

/** sfnt name table (TrueType / OpenType, the first font of a collection): typographic family (ID 16) else family (ID 1), and
 *  the PostScript name (ID 6); Windows UTF-16 records first, then Mac Roman. */
export function fontNames(buffer: ArrayBuffer): { family: string; postScriptName: string } {
  const none = { family: '', postScriptName: '' };
  try {
    const v = new DataView(buffer), tag = v.getUint32(0);
    const base = tag === 0x74746366 ? v.getUint32(12) : 0; // 'ttcf'
    if (![0x00010000, 0x4f54544f, 0x74727565].includes(v.getUint32(base))) return none; // 1.0, 'OTTO', 'true'
    let name = -1;
    for (let i = 0, n = v.getUint16(base + 4); i < n; i++) if (v.getUint32(base + 12 + 16 * i) === 0x6e616d65) name = v.getUint32(base + 12 + 16 * i + 8);
    if (name < 0) return none;
    const count = v.getUint16(name + 2), strings = name + v.getUint16(name + 4), found: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      const r = name + 6 + 12 * i, platform = v.getUint16(r), id = v.getUint16(r + 6), len = v.getUint16(r + 8), at = strings + v.getUint16(r + 10);
      if (![1, 6, 16].includes(id) || (platform !== 3 && platform !== 1) || found[`${platform}:${id}`]) continue;
      let s = '';
      for (let k = 0; k < len; k += platform === 3 ? 2 : 1) s += String.fromCharCode(platform === 3 ? v.getUint16(at + k) : v.getUint8(at + k));
      found[`${platform}:${id}`] = s.trim();
    }
    const get = (id: number) => found[`3:${id}`] || found[`1:${id}`] || '';
    return { family: get(16) || get(1), postScriptName: get(6) };
  } catch { return none; }
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
/** Validates and stores one uploaded font file: ≤ 8 MiB (FONT_TOO_LARGE), a readable family or PostScript name
 *  (FONT_NAME_REQUIRED), a face the browser can load (FONT_LOAD_FAILED). The same file twice is stored once (SHA-256). */
export async function addUserFont(file: Blob & { name?: string }): Promise<UserFont> {
  if (file.size > MAX_FONT_BYTES) throw new FontError('FONT_TOO_LARGE', `The font file is ${(file.size / 1048576).toFixed(1)} MiB; font files can be at most 8 MiB.`);
  const buffer = await file.arrayBuffer(), names = fontNames(buffer);
  if (!names.family && !names.postScriptName) throw new FontError('FONT_NAME_REQUIRED', 'Cutframe could not read a family or PostScript name from this file. Upload a .ttf or .otf font.');
  if (typeof FontFace !== 'undefined') await new FontFace('cutframe-upload-check', buffer).load().catch(() => { throw new FontError('FONT_LOAD_FAILED', 'This file is not a font the browser can load.'); });
  const sha256 = hex(await crypto.subtle.digest('SHA-256', buffer)), family = names.family || names.postScriptName;
  const meta: UserFont = { sha256, family, postScriptName: names.postScriptName || compact(family), fileName: file.name ?? '', bytes: file.size, url: `user-font:${sha256}`, addedAt: Date.now() };
  const blob = new Blob([buffer], { type: file.type || 'font/ttf' }), db = await database();
  if (db) await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put({ meta, blob })); else memory.set(sha256, { meta, blob });
  await loadUserFonts(true);
  fontsChanged();
  return users.find(u => u.sha256 === sha256) ?? meta;
}
/** Removes an upload from this browser (items that use it then fail with FONT_NOT_FOUND in export). */
export async function removeUserFont(sha256: string): Promise<void> {
  const db = await database();
  if (db) await request(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(sha256)); else memory.delete(sha256);
  await loadUserFonts(true);
  fontsChanged();
}
export async function userBlob(sha256: string): Promise<Blob> {
  const db = await database();
  const r = db ? await request(db.transaction(STORE).objectStore(STORE).get(sha256)) as { blob: Blob } | undefined : memory.get(sha256);
  if (!r) throw new FontError('FONT_DELIVERY_FAILED', 'The uploaded font file is no longer stored in this browser.');
  return r.blob;
}

// ---- Resolution ----
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** The family a name refers to: a family, a substituted Xapp family, a face name ("Roboto-Bold") or an upload's PostScript
 *  name; `variant` is set when the name was a face. Registry first, then uploads. */
export function findFont(name: string): { entry: FontFamilyEntry; variant?: FontVariant } | null {
  if (!name.trim()) return null;
  for (const entry of fontFamilies()) {
    if (same(entry.family, name) || entry.substituteFor && same(entry.substituteFor, name)) return { entry };
    const v = entry.variants.find(x => same(x.face, name));
    if (v) return { entry, variant: v };
  }
  return null;
}
/** CSS weight value → number: normal 400, bold 700, a number 1–1000; anything else 400. */
export function weightNumber(value: unknown): number {
  if (value === 'bold' || value === 'bolder') return 700;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 400;
}
/** The family's face nearest to the weight, italic when asked and the family has italics. */
export function pickVariant(entry: FontFamilyEntry, weight: number, italic: boolean): FontVariant {
  const pool = entry.variants.filter(v => v.italic === italic), list = pool.length ? pool : entry.variants;
  return list.reduce((best, v) => Math.abs(v.weight - weight) < Math.abs(best.weight - weight) || Math.abs(v.weight - weight) === Math.abs(best.weight - weight) && v.weight > best.weight ? v : best);
}
export type ResolvedFont = { entry: FontFamilyEntry; variant: FontVariant; url: string };
export const cssFamily = (family: string) => encodeURIComponent(family).replace(/%20/g, '+');
/** The Google Fonts stylesheet URL of one face (Roboto 400 / 700 included: the bundled files are the same version). */
export const googleUrl = (family: string, v: FontVariant) => `https://fonts.googleapis.com/css2?family=${cssFamily(family)}:ital,wght@${v.italic ? 1 : 0},${v.weight}&display=block`;
/** A font name with an optional weight and style → the face to store and load, or null (FONT_NOT_FOUND). */
export function resolveFont(name: string, weight?: unknown, style?: unknown): ResolvedFont | null {
  const m = findFont(name);
  if (!m) return null;
  const v = weight === undefined && style === undefined && m.variant ? m.variant
    : pickVariant(m.entry, weight === undefined ? m.variant?.weight ?? 400 : weightNumber(weight), style === undefined ? m.variant?.italic ?? false : style === 'italic' || style === 'oblique');
  return { entry: m.entry, variant: v, url: m.entry.source === 'user' ? `user-font:${m.entry.sha256}` : googleUrl(m.entry.family, v) };
}

// ---- Change listeners and load failures (written by the loader in text/fonts.ts) ----
const listeners = new Set<() => void>();
/** Called after a face, the emoji or the CJK font finishes loading or the uploads change (layout caches, preview redraw). */
export function onFontChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function fontsChanged() { for (const l of listeners) l(); }
export const failures = new Map<string, FontError>();
export const keyOf = (r: ResolvedFont) => `${r.entry.source}:${r.entry.sha256 ?? r.entry.family}:${r.variant.face}:${PARITY.weightFace}`;
/** The last load failure of a face (sync, for handlers and the inspector), or null. */
export const fontFailure = (r: ResolvedFont): FontError | null => failures.get(keyOf(r)) ?? null;

/** Every value a style key takes on an item: the property's default and keyframes, else details. */
function values(item: RecordData, key: string): unknown[] {
  const p = prop(item, key);
  return p ? [p.defaultValue, ...p.keyframes.map(k => k.value)] : [item.details?.[key]];
}
/** The faces one text item draws with: its family's faces for every weight × style it takes (one face, the stored one, when
 *  PARITY.weightFace does not switch). [] for a text with no font (drawn in the chain); FONT_NOT_FOUND for an unknown one. */
export function itemFonts(item: RecordData): ResolvedFont[] {
  const d = item.details ?? {}, face = typeof d.fontFamily === 'string' ? d.fontFamily : '', display = typeof d.fontFamilyDisplay === 'string' ? d.fontFamilyDisplay : '';
  const name = PARITY.weightFace === 'switch' ? display || face : face || display;
  if (!name.trim()) return [];
  const m = findFont(name) ?? findFont(face);
  if (!m) throw new FontError('FONT_NOT_FOUND', `Font '${name}' is unavailable.`);
  if (PARITY.weightFace !== 'switch') return [resolveFont(m.variant?.face ?? name)!];
  const out = new Map<string, ResolvedFont>();
  for (const w of values(item, 'fontWeight')) for (const s of values(item, 'fontStyle')) {
    const r = resolveFont(m.entry.family, weightNumber(w ?? 'normal'), s ?? 'normal')!;
    out.set(r.variant.face, r);
  }
  return [...out.values()];
}
