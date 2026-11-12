// SPDX-License-Identifier: AGPL-3.0-only
// T22 the element fields of editProperties (agent tool results §2 editProperties; error codes NOT_AN_ELEMENT,
// ELEMENT_HAS_NO_MEDIA): `colors` sets palette slots, `media` fills or empties the openings, `width` / `height` size the
// element box. One target that is no element is refused; in a batch it is only listed as ignored. The caller runs inside
// one bus command, so a throw here changes nothing. Pure. Also the text-slot refit (reference compares part 6 §6.1 to
// §6.3), which runs after an agent edit and after an inline text commit, never after an inspector edit.
import type { Asset, RecordData } from '../store/model';
import { hasSource } from '../timeline/items';
import { cellsOf, cellSource } from '../timeline/layouts';
import { fail } from '../timeline/model';
import { setStatic, staticValue } from '../timeline/properties';
import { findElement } from './elements';
import { measureText } from '../text/tools';
import { textSlot } from './graphic';

export const isElement = (i: RecordData) => typeof i.details?.element?.id === 'string';
const SIZE = ['width', 'height'], HEX = /^#[0-9a-f]{6}$/i, NOT_ELEMENT = 'not a built-in element';
const PROPORTIONS = 'keeps its proportions: height follows width', SELF_SIZED = 'the text sizes itself to its bubble; resize the bubble to change it';
/** The keys of a call this module handles for item `i`: colors and media always, width / height on an element. */
export const elementKeys = (i: RecordData, keys: string[]) => keys.filter(k => k === 'colors' || k === 'media' || SIZE.includes(k) && isElement(i));
const bad = (text: string): never => fail('INVALID_PROPERTY_VALUE', text);

export function editElements(items: RecordData[], props: RecordData, asset: (id: string) => Asset | undefined): { results: RecordData[]; notes: string[] } {
  const results: RecordData[] = [], notes: string[] = [], single = items.length === 1;
  for (const i of items) {
    const keys = elementKeys(i, Object.keys(props)), applied: RecordData = {}, ignored: RecordData = {};
    if (!keys.length) continue;
    if (!isElement(i)) {
      if (single) fail('NOT_AN_ELEMENT', `Item '${i.id}' is not a built-in element; colors, media and element size apply to elements only.${keys.includes('colors') && i.type === 'text' ? ' Text colour is `color`.' : ''}`);
      for (const k of keys) ignored[k] = NOT_ELEMENT;
      results.push({ itemId: i.id, applied, ignored });
      continue;
    }
    const data = i.details.element as RecordData, el = findElement(data.id), name = el?.name ?? data.id;
    if ('colors' in props) {
      const given = props.colors, palette: { name: string; base: string }[] = Array.isArray(data.palette) ? data.palette : [];
      if (!Array.isArray(given)) bad('colors must be an array of #rrggbb colours (null keeps a slot).');
      given.forEach((c: unknown, n: number) => { if (c !== null && c !== undefined && !(typeof c === 'string' && HEX.test(c))) bad(`colors[${n}] must be a #rrggbb colour or null.`); });
      const set: Record<string, string> = {};
      data.colors = palette.map((slot, n) => {
        if (typeof given[n] === 'string') return set[slot.name] = given[n].toUpperCase();
        return typeof data.colors?.[n] === 'string' ? data.colors[n] : slot.base;
      });
      applied.colors = set;
      if (Object.keys(set).length) notes.push(`${name}: set ${Object.entries(set).map(([slot, hex]) => `${slot} to ${hex}`).join(', ')}.`);
      if (given.length > palette.length) notes.push(`${name} has ${palette.length} colour slot${palette.length === 1 ? '' : 's'}; ${given.length - palette.length} extra value${given.length - palette.length === 1 ? ' was' : 's were'} ignored.`);
    }
    if ('media' in props) {
      const given = props.media, cells = data.slot === 'media' ? cellsOf(i) : [];
      if (!cells.length) {
        const why = data.slot === 'text' ? `${name} holds text, not media. Set its text instead.` : `${name} has no openings for media.`;
        if (single) fail('ELEMENT_HAS_NO_MEDIA', why);
        ignored.media = why;
      } else {
        if (!Array.isArray(given)) bad('media must be an array of asset ids (null empties an opening).');
        let filled = 0, emptied = 0;
        const touched: (string | null)[] = [];
        cells.forEach((cell, n) => {
          const id = given[n];
          if (id === undefined) return;
          if (id === null) { if (cell.source) emptied++; cell.source = null; touched.push(null); return; }
          if (typeof id !== 'string') bad(`media[${n}] must be an asset id or null.`);
          const a = asset(id);
          if (!a) fail('MEDIA_NOT_FOUND', 'Media asset not found', { message: `'${id}' is not in this project.` });
          if (a.type !== 'video' && a.type !== 'image') bad(`media[${n}] must be a video or an image; '${id}' is ${a.type}.`);
          if (!hasSource(a)) fail('INVALID_ASSET_URL', `Asset '${id}' does not have a valid source URL.`);
          cell.source = cellSource(a); filled++; touched.push(id);
        });
        applied.media = touched;
        if (filled || emptied) notes.push(`${name}: ${[filled ? `filled ${filled} opening${filled === 1 ? '' : 's'}` : '', emptied ? `emptied ${emptied}` : ''].filter(Boolean).join(', ')}.`);
        if (given.length > cells.length) notes.push(`${name} has ${cells.length} opening${cells.length === 1 ? '' : 's'}; ${given.length - cells.length} extra value${given.length - cells.length === 1 ? ' was' : 's were'} ignored.`);
      }
    }
    if (SIZE.some(k => k in props)) {
      for (const k of SIZE) if (k in props && !(typeof props[k] === 'number' && Number.isFinite(props[k]) && props[k] > 0)) bad("An element's width and height must be positive.");
      const now = { width: staticValue(i, 'width') as number, height: staticValue(i, 'height') as number }, stretch = data.stretch === true;
      let { width, height } = now;
      if (stretch) { width = props.width ?? width; height = props.height ?? height; }
      else {
        // A fixed element keeps its proportions: the ratio of its box now, the element's own only when that box is empty. A
        // given width sets the height; an asked height more than 0.5 away from it is listed as ignored (no message sentence).
        const ratio = now.width > 0 && now.height > 0 ? now.height / now.width : (el?.height ?? 1) / (el?.width ?? 1);
        if ('width' in props) { width = props.width; height = width * ratio; if ('height' in props && Math.abs(props.height - height) > 0.5) ignored.height = PROPORTIONS; }
        else { height = props.height; width = height / ratio; }
      }
      setStatic(i, 'width', width); setStatic(i, 'height', height);
      applied.width = width; applied.height = height;
    }
    results.push({ itemId: i.id, applied, ...(Object.keys(ignored).length ? { ignored } : {}) });
  }
  return { results, notes };
}

/** True for an item a refit acts on: a text-slot element of the catalogue whose text is not blank. */
export const refits = (i: RecordData) => i.type === 'text' && !!textSlot(i, 1, 1) && typeof i.details.text === 'string' && !!i.details.text.trim();
/** The font-size limits of a text slot's refit; the 48 of the insert does not apply. */
export const REFIT = { min: 8, max: 400 } as const;
/** Refits the font size of a text-slot element item to its slot (reference compares part 6 §6.1 point 2): the largest whole
 *  size from 8 to min(400, floor(slot height)) at which the text, wrapped at the slot width, is no higher than the slot; 8
 *  when none fits. Writes it and returns it. null = nothing done: not a text-slot element, or no text yet (the insert's
 *  size holds while the text is empty). */
export function refitSlotText(i: RecordData): number | null {
  const slot = refits(i) ? textSlot(i, staticValue(i, 'width') as number, staticValue(i, 'height') as number) : null;
  if (!slot) return null;
  let size = Math.min(REFIT.max, Math.floor(slot.H));
  for (; size > REFIT.min; size--) { setStatic(i, 'fontSize', size); if (measureText(i, slot.W).height <= slot.H) return size; }
  setStatic(i, 'fontSize', REFIT.min);
  return REFIT.min;
}

/** The keys of an edit after which a text-slot element's text is refitted (§6.1 point 2). */
export const REFIT_KEYS = ['text', 'fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'letterSpacing', 'lineHeight', 'wordSpacing', 'textTransform', 'look', 'width', 'height'];
/** The refit step of an edit (§6.2 question 1): runs after the edit's own writes, on every target that is a text-slot
 *  element with text. The fitted size goes to the item (keyframes kept) and to `applied.fontSize` of its `results` entry,
 *  which is made when the call had no element field. Returns one message sentence per refitted item; a different size the
 *  call asked for is also listed as ignored. It never refuses. */
export function refitElements(items: RecordData[], props: RecordData, results: RecordData[]): string[] {
  const notes: string[] = [];
  if (!REFIT_KEYS.some(k => k in props)) return notes;
  for (const i of items) {
    const fitted = refitSlotText(i);
    if (fitted === null) continue;
    let entry = results.find(r => r.itemId === i.id);
    if (!entry) results.push(entry = { itemId: i.id, applied: {} });
    entry.applied.fontSize = fitted;
    if ('fontSize' in props && Number(props.fontSize) !== fitted) {
      entry.ignored = { ...entry.ignored, fontSize: SELF_SIZED };
      notes.push(`${i.id}'s text sizes itself to its bubble: fontSize ${fitted}, not ${props.fontSize}. Resize the bubble to change it.`);
    } else notes.push(`${i.id}'s text fits its bubble at fontSize ${fitted}.`); // our own wording (the reference gives none)
  }
  return notes;
}
