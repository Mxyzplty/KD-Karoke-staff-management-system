// SPDX-License-Identifier: AGPL-3.0-only
// T05 font loader (findings part 2 §33, CAP-07); the registry and resolution live in text/font-registry.ts (re-exported
// here). Roboto 400 / 700 bundled (vendor/roboto), every other face from Google Fonts by family, Noto Color Emoji vendored
// and loaded lazily, an open CJK font (Noto Sans SC) from Google Fonts on demand, user uploads from this browser. The
// export preloads every face its texts use and fails on a missing one (never a silent fallback); a chain font (emoji, CJK)
// that cannot load is a notice only (Author question, that default). Every DOM font API is guarded; the font file imports
// need Vite, so code that Node scripts load (timeline tools, parity) imports text/font-registry.ts instead.
import emojiUrl from '../../../../vendor/noto-emoji/Noto-COLRv1.ttf?url';
import { SANDBOX_FONTS } from '../mg/fonts';
import { bundledCovers, bundledFont, isBundledRange } from '../catalogue/bundled-fonts';
import type { ProjectDocument, RecordData } from '../store/model';
import { isCaption } from '../timeline/model';
import { exportedItems } from '../export/prep';
import type { Range } from '../export/prep';
import { PARITY } from './parity-switches';
import { CJK_FAMILY, EMOJI_FAMILY } from './style';
import { cssFamily, failures, FontError, fontsChanged, googleUrl, itemFonts, keyOf, loadUserFonts, MAX_FONT_BYTES, userBlob } from './font-registry';
import type { ResolvedFont } from './font-registry';

export * from './font-registry';

// ---- Loading ----
const fontSet = (): FontFaceSet | null => typeof document !== 'undefined' && document.fonts && typeof FontFace !== 'undefined' ? document.fonts : null;
/** The CSS family a face is registered under (style.ts itemFamily): the family when PARITY.weightFace switches faces (each
 *  face with its own weight and style), else the stored face name with every weight mapped to it (Xapp's look: no switch). */
const register = (r: ResolvedFont) => PARITY.weightFace === 'switch'
  ? { name: r.entry.family, descriptors: { weight: String(r.variant.weight), style: r.variant.italic ? 'italic' : 'normal' } }
  : { name: r.variant.face, descriptors: { weight: '1 1000' } };
const BLOCK = /@font-face\s*{([^}]*)}/g;
/** A Google Fonts stylesheet → one FontFace per subset (src url + unicode-range); FONT_DELIVERY_FAILED when it cannot be had. */
async function googleFaces(url: string, name: string, descriptors: FontFaceDescriptors): Promise<FontFace[]> {
  const css = await fetch(url).then(r => r.ok ? r.text() : Promise.reject(Error(`HTTP ${r.status}`)))
    .catch(e => { throw new FontError('FONT_DELIVERY_FAILED', `The font stylesheet could not be downloaded (${(e as Error).message}).`); });
  const faces = [...css.matchAll(BLOCK)].flatMap(([, b]) => {
    const src = /src:\s*url\(([^)]+)\)/.exec(b)?.[1], range = /unicode-range:\s*([^;]+);?/.exec(b)?.[1]?.trim(), weight = /font-weight:\s*([^;]+);/.exec(b)?.[1]?.trim();
    return src ? [new FontFace(name, `url(${src.replace(/^['"]|['"]$/g, '')})`, { ...descriptors, ...range ? { unicodeRange: range } : {}, ...descriptors.weight === undefined && weight ? { weight } : {} })] : [];
  });
  if (!faces.length) throw new FontError('FONT_DELIVERY_FAILED', 'The font stylesheet lists no font files.');
  return faces;
}
type Registration = { faces: Promise<FontFace[]>; name: string; spec: string; extended?: true | 'failed' };
const loadedCount = (faces: FontFace[]) => faces.filter(f => f.status === 'loaded').length;
const registered = new Map<string, Registration>();
async function facesFor(r: ResolvedFont, name: string, descriptors: FontFaceDescriptors): Promise<FontFace[]> {
  if (r.entry.source === 'user') {
    const blob = await userBlob(r.entry.sha256!);
    if (blob.size > MAX_FONT_BYTES) throw new FontError('FONT_TOO_LARGE', 'The uploaded font file is over 8 MiB.');
    return [new FontFace(name, await blob.arrayBuffer(), descriptors)];
  }
  // T22: the default template's families are bundled as their Latin subset (no request); extendBundled adds the rest.
  const local = bundledFont(r.entry.family, r.variant.italic);
  if (local) return [new FontFace(name, `url(${local.url})`, { ...descriptors, unicodeRange: local.unicodeRange })];
  const bundled = r.entry.family === 'Roboto' && !r.variant.italic && SANDBOX_FONTS.find(f => f.weight === r.variant.weight);
  return bundled ? [new FontFace(name, `url(${bundled.src})`, descriptors)] : googleFaces(googleUrl(r.entry.family, r.variant), name, descriptors);
}
/** T22: whether a bundled family's face still lacks Google's other subsets for this text. */
const lacksSubsets = (reg: Registration, r: ResolvedFont, text: string) => reg.extended !== true && r.entry.source !== 'user' && !!bundledFont(r.entry.family, r.variant.italic) && !bundledCovers(text);
/** T22: the first time a text has a character outside a bundled family's Latin file, Google's other subset faces are added
 *  (its own copy of the Latin file is left out). When Google does not answer, the bundled face stays and the error is
 *  returned: the caller reports it as any failed Google family, after the Latin part has loaded. */
async function extendBundled(reg: Registration, r: ResolvedFont, text: string, set: FontFaceSet): Promise<FontError | null> {
  if (!lacksSubsets(reg, r, text)) return null;
  reg.extended = true;
  try {
    const { name, descriptors } = register(r), more = (await googleFaces(googleUrl(r.entry.family, r.variant), name, descriptors)).filter(f => !isBundledRange(f.unicodeRange));
    const faces = await reg.faces;
    for (const f of more) { set.add(f); faces.push(f); }
    return null;
  } catch (e) {
    reg.extended = 'failed';
    return e instanceof FontError ? e : new FontError('FONT_DELIVERY_FAILED', 'The font stylesheet could not be downloaded.');
  }
}
/** Loads one face for `text` (only the subsets the text needs; the whole face without text). Throws a FontError: the
 *  loader's own code (FONT_DELIVERY_FAILED, FONT_TOO_LARGE) or FONT_LOAD_FAILED. A failure is remembered (fontFailure) and
 *  the next call tries again. Without DOM fonts (Node) it does nothing. */
export async function loadFont(r: ResolvedFont, text = ''): Promise<void> {
  const set = fontSet();
  if (!set) return;
  const key = keyOf(r);
  let reg = registered.get(key);
  if (!reg) {
    const { name, descriptors } = register(r);
    reg = { name, spec: `${r.variant.italic ? 'italic' : 'normal'} ${r.variant.weight} 16px '${name.replace(/'/g, "\\'")}'`, faces: facesFor(r, name, descriptors).then(f => { for (const x of f) set.add(x); return f; }) };
    registered.set(key, reg);
  }
  let partial: FontError | null = null;
  try {
    partial = await extendBundled(reg, r, text, set);
    const faces = await reg.faces, before = loadedCount(faces);
    if (text) await set.load(reg.spec, text); else await Promise.all(faces.map(f => f.load()));
    if (faces.some(f => f.status === 'error')) throw Error('a face failed');
    if (failures.delete(key) || loadedCount(faces) > before) fontsChanged();
  } catch (e) {
    const error = e instanceof FontError ? e : new FontError('FONT_LOAD_FAILED', `The font '${r.variant.face}' could not be loaded.`);
    const faces = await reg.faces.catch(() => [] as FontFace[]);
    for (const f of faces) set.delete(f);
    registered.delete(key); failures.set(key, error);
    throw error;
  }
  // T22: the bundled Latin face is loaded and stays; the subsets this text needs are not.
  if (partial) { failures.set(key, partial); throw partial; }
}


const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u, CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
export const CJK_NOTICE = `Chinese, Japanese and Korean characters are drawn with the default sans-serif font: the CJK font (${CJK_FAMILY}) could not be loaded. Check the connection.`;
export const EMOJI_NOTICE = `Emoji are drawn with the system font: the emoji font (${EMOJI_FAMILY}) could not be loaded.`;
const notices = new Set<string>();
/** Notices for the editor (a chain font that could not load); the same texts go into the export result. */
export const fontNotices = (): string[] => [...notices];
const chain = new Map<'emoji' | 'cjk', Promise<FontFace[]>>();
// A chain font that failed to load is remembered for the session (as `failures` does for faces), so the preview does not
// re-fetch it on every frame; coming back online (or a page reload, which resets this module) clears it and the next
// redraw retries. The export's loadChainFonts does not consult this: an export is a one-shot that always re-attempts.
const chainFailed = new Set<'emoji' | 'cjk'>();
if (typeof window !== 'undefined') window.addEventListener('online', () => { if (chainFailed.size) { chainFailed.clear(); fontsChanged(); } });
/** The emoji font (vendored, registered on first need) or the CJK font (Google Fonts, all weights in one variable face):
 *  true when loaded for `text`; a failure adds its notice, is remembered in chainFailed, and is tried again next time. */
async function chainFont(kind: 'emoji' | 'cjk', text: string): Promise<boolean> {
  const set = fontSet();
  if (!set) return true;
  const family = kind === 'emoji' ? EMOJI_FAMILY : CJK_FAMILY, notice = kind === 'emoji' ? EMOJI_NOTICE : CJK_NOTICE;
  let faces = chain.get(kind);
  if (!faces) {
    faces = (kind === 'emoji' ? Promise.resolve([new FontFace(family, `url(${emojiUrl})`)])
      : googleFaces(`https://fonts.googleapis.com/css2?family=${cssFamily(family)}:wght@100..900&display=block`, family, {})).then(f => { for (const x of f) set.add(x); return f; });
    chain.set(kind, faces);
  }
  try {
    const f = await faces, before = loadedCount(f);
    await set.load(`16px '${family}'`, text);
    if (f.some(x => x.status === 'error')) throw Error('failed');
    chainFailed.delete(kind);
    if (notices.delete(notice) || loadedCount(f) > before) fontsChanged();
    return true;
  } catch {
    for (const x of await faces.catch(() => [] as FontFace[])) set.delete(x);
    chain.delete(kind); chainFailed.add(kind);
    if (!notices.has(notice)) { notices.add(notice); fontsChanged(); }
    return false;
  }
}
const chainText = (text: string, re: RegExp) => [...text].filter(c => re.test(c)).join('');
/** Loads the chain fonts a text needs (PARITY.fontChain 'bundled' only for CJK); returns the notices of those that failed. */
export async function loadChainFonts(text: string): Promise<string[]> {
  const out: string[] = [], emoji = chainText(text, EMOJI), cjk = PARITY.fontChain === 'bundled' ? chainText(text, CJK) : '';
  if (emoji && !await chainFont('emoji', emoji)) out.push(EMOJI_NOTICE);
  if (cjk && !await chainFont('cjk', cjk)) out.push(CJK_NOTICE);
  return out;
}

/** Preview: starts loading what a drawn text needs (no wait); the drawing redraws through onFontChange. */
export function requestFonts(item: RecordData, text: string): void {
  if (!fontSet()) return;
  try { for (const r of itemFonts(item)) { const reg = registered.get(keyOf(r)); if ((!reg || reg.extended === undefined && lacksSubsets(reg, r, text)) && !failures.has(keyOf(r))) loadFont(r, text).catch(() => undefined); } } catch { /* unknown family: the inspector shows it */ }
  if (EMOJI.test(text) && !chain.has('emoji') && !chainFailed.has('emoji') || CJK.test(text) && PARITY.fontChain === 'bundled' && !chain.has('cjk') && !chainFailed.has('cjk')) void loadChainFonts(text);
}
/** Export preload (pipeline.ts): every exported text's faces for its text, then its chain fonts — only the texts the export
 *  draws (on a shown track, and within `range` when one is set, as exportPlan does). Throws the first FontError (the export
 *  fails with that code); returns the chain notices for the export result. */
export async function loadTextFonts(doc: ProjectDocument, range?: Range): Promise<string[]> {
  await loadUserFonts();
  const out = new Set<string>();
  const inRange = (i: RecordData) => !range || (i.display.from < range.endS * 1000 && i.display.to > range.startS * 1000);
  for (const item of exportedItems(doc)) {
    if (item.type !== 'text' || isCaption(item) || !inRange(item)) continue;
    const text = typeof item.details?.text === 'string' ? item.details.text : '';
    for (const r of itemFonts(item)) await loadFont(r, text || ' ');
    for (const n of await loadChainFonts(text)) out.add(n);
  }
  return [...out];
}
