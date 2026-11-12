// SPDX-License-Identifier: AGPL-3.0-only
// T22 the element fields of editProperties (agent tool results §2 editProperties; error codes NOT_AN_ELEMENT,
// ELEMENT_HAS_NO_MEDIA): `colors` sets palette slots, `media` fills or empties the openings, `width` / `height` size the
// element box. One target that is no element is refused; in a batch it is only listed as ignored. The caller runs inside
// one bus command, so a throw here changes nothing. Pure.
import type { Asset, RecordData } from '../store/model';
import { hasSource } from '../timeline/items';
import { cellsOf, cellSource } from '../timeline/layouts';
import { fail } from '../timeline/model';
import { setStatic, staticValue } from '../timeline/properties';
import { findElement } from './elements';
import { elementRect } from './place';

export const isElement = (i: RecordData) => typeof i.details?.element?.id === 'string';
const SIZE = ['width', 'height'], HEX = /^#[0-9a-f]{6}$/i, NOT_ELEMENT = 'not a built-in element';
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
      for (const k of SIZE) if (k in props && !(typeof props[k] === 'number' && Number.isFinite(props[k]) && props[k] > 0)) bad(`${k} must be a positive number.`);
      const now = elementRect(i, el), stretch = data.stretch === true;
      let { width, height } = now;
      if (stretch) { width = props.width ?? width; height = props.height ?? height; }
      else {
        const s = 'width' in props ? props.width / now.width : props.height / now.height;
        width *= s; height *= s;
        if ('width' in props && 'height' in props && Math.abs(height - props.height) > 1e-6) notes.push(`${name} keeps its proportions: it is now ${+width.toFixed(2)} × ${+height.toFixed(2)} (the width was used).`);
      }
      resize(i, el, now, { ...now, width, height }, stretch);
      applied.width = width; applied.height = height;
    }
    results.push({ itemId: i.id, applied, ...(Object.keys(ignored).length ? { ignored } : {}) });
  }
  return { results, notes };
}

/** Writes a new element box (same top-left corner) to the item that holds it. */
function resize(i: RecordData, el: ReturnType<typeof findElement>, from: { x: number; y: number; width: number; height: number }, to: typeof from, stretch: boolean) {
  if (i.type === 'image') {
    if (stretch) { setStatic(i, 'width', to.width); setStatic(i, 'height', to.height); setStatic(i, 'scale', 1); }
    else setStatic(i, 'scale', (staticValue(i, 'scale') as number) * to.width / from.width);
    return;
  }
  if (i.type === 'text') {
    const box = el?.slot?.kind === 'text' ? el.slot.box : { x: 0, y: 0, width: 1, height: 1 };
    setStatic(i, 'positionX', to.x + box.x * to.width); setStatic(i, 'positionY', to.y + box.y * to.height);
    setStatic(i, 'width', box.width * to.width); setStatic(i, 'height', box.height * to.height);
    return;
  }
  setStatic(i, 'width', to.width); setStatic(i, 'height', to.height);
}
