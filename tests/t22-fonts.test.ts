// SPDX-License-Identifier: AGPL-3.0-only
// T22 steps 12–13 / A14 and the fonts tool: findings part 2 §33 and lane A's 12 Nov validation rulings.
// Oracle: the declared lists/registry data and the written priority, role, result-shape and purity rules, not tool output.
// Native upload registry on fake-indexeddb with in-memory name-table fonts; no DOM loader, skipped cases or author runs.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FONT_LISTS, fontPickerOrder, fonts } from '../apps/web/src/catalogue/fonts';
import type { FontPick } from '../apps/web/src/catalogue/fonts';
import { TEMPLATES } from '../apps/web/src/captions/templates';
import { addUserFont, FONT_REGISTRY, fontFamilies, loadUserFonts, removeUserFont, userBlob, userFonts } from '../apps/web/src/text/font-registry';
import type { FontFamilyEntry, FontVariant } from '../apps/web/src/text/font-registry';

type Args = NonNullable<Parameters<typeof fonts>[0]>;
type ToolPick = FontPick & { category: FontFamilyEntry['category']; styles: string[] };
type PicksData = { picks: ToolPick[]; total: number; hint: string };
type FamilyData = Pick<FontFamilyEntry, 'family' | 'category'> & { variants: Pick<FontVariant, 'weight' | 'italic' | 'label'>[] };
type Role = 'titles' | 'captions';
type InputError = { path: string; code: string; message: string };
const ENUM_MESSAGE = 'must be equal to one of the allowed values';
// The current implementation's upper bound, confirmed in the handoff; never an exact count or a spec number.
const CURRENT_PICK_CAP = 12;
let initialFonts = new Set<string>();
beforeEach(async () => { await loadUserFonts(true); initialFonts = new Set(userFonts().map(font => font.sha256)); });
afterEach(async () => { for (const font of [...userFonts()]) if (!initialFonts.has(font.sha256)) await removeUserFont(font.sha256); });

// The minimal sfnt name-table fixture from t22-library: registry data only, not a glyph-rendering font in Node.
function fontBytes(family: string) {
  const names = [family, `${family.replace(/\s/g, '')}-Regular`], encoded = names.map(name => Uint8Array.from([...name].flatMap(c => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255])));
  const tableSize = 30 + encoded.reduce((sum, bytes) => sum + bytes.length, 0), bytes = new Uint8Array(28 + tableSize), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, 1); view.setUint16(6, 16); view.setUint32(12, 0x6e616d65); view.setUint32(20, 28); view.setUint32(24, tableSize);
  view.setUint16(30, 2); view.setUint16(32, 30); let offset = 0;
  encoded.forEach((value, k) => { const at = 34 + k * 12; view.setUint16(at, 3); view.setUint16(at + 2, 1); view.setUint16(at + 4, 0x409);
    view.setUint16(at + 6, k === 0 ? 1 : 6); view.setUint16(at + 8, value.length); view.setUint16(at + 10, offset); bytes.set(value, 58 + offset); offset += value.length; });
  return bytes;
}
async function uploadFont(family: string) {
  const bytes = fontBytes(family), meta = await addUserFont(new File([bytes], `${family.replace(/\s/g, '-')}.ttf`, { type: 'font/ttf' })); return { meta, bytes };
}
async function uploadTwo() { await uploadFont('T22 Zulu Upload'); await uploadFont('T22 Alpha Upload'); }
const names = (entries: readonly { family: string }[]) => entries.map(entry => entry.family);
const rankedRegistry = () => [...FONT_REGISTRY].sort((a, b) => a.rank! - b.rank!);
const snapshot = () => structuredClone({ lists: FONT_LISTS, registry: FONT_REGISTRY, users: userFonts(), families: fontFamilies() });
function success<T>(result: ReturnType<typeof fonts>): T {
  expect(result.success).toBe(true); if (!result.success) throw new Error(result.error); return result.data as unknown as T;
}
const matches = (pick: FontPick, role?: Role) => role === 'titles' ? pick.role === 'text' || pick.role === 'both' : role === 'captions' ? pick.role === 'caption' || pick.role === 'both' : true;
// A first-eligible-entry map models the contract independently of the tool's ranking implementation.
function rankedPicks(templateId?: string, role?: Role): FontPick[] {
  const byFamily = new Map<string, FontPick>();
  for (const list of [templateId ? FONT_LISTS[templateId] : [], FONT_LISTS.general]) for (const pick of list) {
    if (matches(pick, role) && !byFamily.has(pick.family)) byFamily.set(pick.family, pick);
  }
  return [...byFamily.values()];
}
function toolPick(pick: FontPick): ToolPick {
  const entry = FONT_REGISTRY.find(font => font.family === pick.family)!;
  return { family: pick.family, role: pick.role, category: entry.category, styles: entry.variants.map(v => v.label), note: pick.note };
}
function listing(args: Args = {}, templateId?: string, role?: Role): PicksData {
  const data = success<PicksData>(fonts(args)), preferred = (templateId ? FONT_LISTS[templateId] : []).filter(pick => matches(pick, role));
  expect(Array.isArray(data.picks)).toBe(true); expect(data.picks.length).toBeGreaterThanOrEqual(Math.max(1, preferred.length)); expect(data.picks.length).toBe(Math.min(CURRENT_PICK_CAP, rankedPicks(templateId, role).length));
  expect(data.picks).toEqual(rankedPicks(templateId, role).slice(0, data.picks.length).map(toolPick)); expect(names(data.picks.slice(0, preferred.length))).toEqual(names(preferred));
  expect(new Set(names(data.picks)).size).toBe(data.picks.length); expect(data.total).toBe(fontFamilies().length); expect(typeof data.hint).toBe('string'); expect(data.hint).toContain('familyName');
  return data;
}
function familyData(entry: FontFamilyEntry, familyName = entry.family): FamilyData {
  const data = success<FamilyData>(fonts({ familyName, videoStyle: 'Punch', role: 'captions' }));
  expect(data).toEqual({ family: entry.family, category: entry.category, variants: entry.variants.map(v => ({ weight: v.weight, italic: v.italic, label: v.label })) });
  for (const variant of data.variants) expect(Object.keys(variant).sort()).toEqual(['italic', 'label', 'weight']); return data;
}
function failure(familyName: string) {
  const before = snapshot(), args = { familyName }, input = structuredClone(args), result = fonts(args);
  expect(result.success).toBe(false); expect(result).not.toHaveProperty('code'); expect(Object.keys(result).sort()).toEqual(['error', 'success']);
  if (result.success) throw new Error('Expected a code-less fonts failure.'); expect(typeof result.error).toBe('string'); expect(result.error.trim().length).toBeGreaterThan(0);
  expect(args).toEqual(input); expect(snapshot()).toEqual(before); return result.error;
}
function refused(args: Args, errors: InputError[]) {
  const before = snapshot(), input = structuredClone(args);
  expect(fonts(args)).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for fonts',
    message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors } });
  expect(args).toEqual(input); expect(snapshot()).toEqual(before);
}
function objects(value: unknown, found = new Set<object>()): Set<object> {
  if (value !== null && typeof value === 'object' && !found.has(value)) { found.add(value); for (const child of Object.values(value)) objects(child, found); }
  return found;
}
function detached(value: unknown) {
  const sourceObjects = objects(FONT_LISTS); objects(FONT_REGISTRY, sourceObjects); objects(userFonts(), sourceObjects);
  // Check identity before mutating a result, so a faulty sharing implementation cannot poison later tests.
  for (const object of objects(value)) expect(sourceObjects.has(object), 'tool results share no object with the lists or registry').toBe(false);
}

describe('A14: nine caption-template font lists and general', () => {
  it('every one of the nine caption ids and general has its own list', () => {
    expect(TEMPLATES).toHaveLength(9); expect(new Set(TEMPLATES.map(t => t.id)).size).toBe(9);
    for (const id of [...TEMPLATES.map(t => t.id), 'general']) expect(Object.hasOwn(FONT_LISTS, id), id).toBe(true);
  });
  it.each([...TEMPLATES.map(t => t.id), 'general'])('%s has non-empty, unique, known-family picks with valid roles and notes', id => {
    const list = FONT_LISTS[id]; expect(Array.isArray(list)).toBe(true); expect(list.length).toBeGreaterThan(0); expect(new Set(names(list)).size).toBe(list.length);
    for (const pick of list) {
      expect(Object.keys(pick).sort()).toEqual(['family', 'note', 'role']); expect(typeof pick.family).toBe('string'); expect(FONT_REGISTRY.some(font => font.family === pick.family), pick.family).toBe(true);
      expect(['caption', 'text', 'both']).toContain(pick.role); expect(typeof pick.note).toBe('string'); expect(pick.note.trim().length).toBeGreaterThan(0);
    }
  });
  it('general contains every registry family exactly once in registry rank order', () => {
    expect(names(FONT_LISTS.general)).toEqual(names(rankedRegistry())); expect(FONT_LISTS.general).toHaveLength(FONT_REGISTRY.length);
  });
});

describe('fontPickerOrder: priority is not a role filter; uploads are last', () => {
  it.each(TEMPLATES)('$id puts its complete list first, then the other ranked families, then uploads, without omissions or repeats', async ({ id }) => {
    await uploadTwo(); const all = fontFamilies(), preferred = names(FONT_LISTS[id]), registry = names(rankedRegistry()), uploads = names(userFonts());
    const expected = [...preferred, ...registry.filter(family => !preferred.includes(family)), ...uploads], actual = fontPickerOrder(id);
    expect(names(actual)).toEqual(expected); expect(actual).toEqual(expected.map(family => all.find(font => font.family === family)!)); expect(actual).toHaveLength(all.length);
    expect(new Set(names(actual)).size).toBe(actual.length); expect([...new Set(names(actual))].sort()).toEqual([...new Set(names(all))].sort());
    expect(names(actual.filter(font => font.source === 'google'))).toHaveLength(FONT_REGISTRY.length); expect(names(actual.slice(-uploads.length))).toEqual(uploads);
    for (const pick of FONT_LISTS[id]) expect(names(actual), `picker retains ${pick.role} family ${pick.family}`).toContain(pick.family);
  });
  it.each([
    { label: 'no id', id: undefined }, { label: 'empty id', id: '' }, { label: 'general', id: 'general' }, { label: 'unknown id', id: 'not-a-caption-template' },
    { label: '__proto__', id: '__proto__' }, { label: 'constructor', id: 'constructor' }, { label: 'toString', id: 'toString' },
  ])('$label is exactly fontFamilies order, uploads included', async ({ id }) => {
    await uploadTwo(); expect(fontPickerOrder(id)).toEqual(fontFamilies()); if (id === undefined) expect(fontPickerOrder()).toEqual(fontFamilies());
  });
});

describe('fonts without familyName: bounded, ranked recommendations and metadata', () => {
  it('no args, empty args and an undefined familyName all give general picks, their metadata, total and familyName hint', () => {
    const general = listing(); expect(success<PicksData>(fonts())).toEqual(general); expect(success<PicksData>(fonts({ familyName: undefined }))).toEqual(general);
  });
  it.each(TEMPLATES)('$id accepts the caption id or name in any case, keeping that list ahead of general', ({ id, name }) => {
    const mixed = (text: string) => [...text].map((c, i) => i % 2 ? c.toUpperCase() : c.toLowerCase()).join('');
    const forms = new Set([id, id.toUpperCase(), mixed(id), name, name.toUpperCase(), name.toLowerCase(), mixed(name)]), expected = listing({ videoStyle: id }, id);
    for (const videoStyle of forms) expect(listing({ videoStyle }, id)).toEqual(expected);
  });
  it.each(['titles', 'captions'] as const)('%s narrows pick roles, preserves every matching template entry first, and does not narrow total', role => {
    for (const id of [undefined, ...TEMPLATES.map(t => t.id)]) {
      const data = listing({ videoStyle: id, role }, id, role); for (const pick of data.picks) expect(matches(pick, role)).toBe(true);
    }
  });
  it('every role other than titles, captions or undefined is refused with the exact ENUM envelope, including inherited names and non-text values', () => {
    for (const role of ['', 'caption', 'text', 'both', 'Titles', 'CAPTIONS', 'unknown-role', '__proto__', 'constructor', 'toString', null, 42, true, [], ['titles'], {}, { toString: null }]) {
      refused({ videoStyle: 'Handwritten', role }, [{ path: '$.role', code: 'ENUM', message: ENUM_MESSAGE }]);
    }
  });
  it('unknown text videoStyle is ignored and gives exactly the general recommendations', () => {
    const expected = listing();
    for (const videoStyle of ['', 'not-a-template', 'general', '__proto__', 'constructor', 'toString']) expect(listing({ videoStyle })).toEqual(expected);
  });
  it.each<{ label: string; value: unknown }>([
    { label: 'null', value: null }, { label: 'number', value: 42 }, { label: 'boolean', value: true }, { label: 'empty array', value: [] },
    { label: 'array naming Cinema', value: ['cinema'] }, { label: 'object', value: {} }, { label: 'non-callable toString object', value: { toString: null } },
  ])('non-text videoStyle ($label) is refused with the exact TYPE envelope', ({ value }) => {
    refused({ videoStyle: value }, [{ path: '$.videoStyle', code: 'TYPE', message: 'must be string' }]);
  });
  it('undefined role and videoStyle are absent in both recommendation and family-detail modes', () => {
    expect(listing({ role: undefined, videoStyle: undefined })).toEqual(listing());
    const entry = FONT_REGISTRY.find(font => font.family === 'Roboto')!;
    expect(success<FamilyData>(fonts({ familyName: 'Roboto', role: undefined, videoStyle: undefined }))).toEqual(familyData(entry));
  });
  it('bad role and videoStyle report both errors, role first, even when input key order is reversed', () => {
    refused({ videoStyle: 42, role: 'body' }, [{ path: '$.role', code: 'ENUM', message: ENUM_MESSAGE }, { path: '$.videoStyle', code: 'TYPE', message: 'must be string' }]);
  });
  it('three invalid fields report familyName, role, videoStyle in that order with the exact joined message', () => {
    refused({ videoStyle: [], role: 'body', familyName: { toString: null } }, [
      { path: '$.familyName', code: 'TYPE', message: 'must be string' }, { path: '$.role', code: 'ENUM', message: ENUM_MESSAGE }, { path: '$.videoStyle', code: 'TYPE', message: 'must be string' },
    ]);
  });
  it.each(['Roboto', 'No such T22 font family'])('familyName=%j cannot bypass role or videoStyle validation', familyName => {
    refused({ familyName, role: 'body' }, [{ path: '$.role', code: 'ENUM', message: ENUM_MESSAGE }]);
    refused({ familyName, videoStyle: 42 }, [{ path: '$.videoStyle', code: 'TYPE', message: 'must be string' }]);
    refused({ familyName, videoStyle: 42, role: 'body' }, [{ path: '$.role', code: 'ENUM', message: ENUM_MESSAGE }, { path: '$.videoStyle', code: 'TYPE', message: 'must be string' }]);
  });
  it('total counts uploaded families too, and families beyond the bounded picks remain queryable by name', async () => {
    const before = fontFamilies().length; await uploadTwo(); const data = listing({ videoStyle: 'Cinema', role: 'captions' }, 'cinema', 'captions');
    expect(data.total).toBe(before + 2); expect(data.total).toBeGreaterThan(data.picks.length);
    const unlisted = fontFamilies().find(font => !data.picks.some(pick => pick.family === font.family))!; expect(unlisted).toBeDefined(); familyData(unlisted);
    for (const upload of userFonts()) familyData(fontFamilies().find(font => font.family === upload.family)!);
  });
});

describe('fonts with familyName: detail, code-less unknown text, or schema refusal; no writes', () => {
  it('every registry family exposes all its variants and only weight, italic and label per variant, regardless of listing modifiers', () => {
    for (const entry of FONT_REGISTRY) familyData(entry);
  });
  it('known registry family names obey findFont case and surrounding-whitespace rules', () => {
    for (const entry of FONT_REGISTRY) for (const familyName of [entry.family.toUpperCase(), ` ${entry.family.toLowerCase()} `]) familyData(entry, familyName);
  });
  it('uploaded families are queryable by name in any case, with user category and the same restricted variant shape', async () => {
    await uploadTwo();
    for (const upload of userFonts()) {
      const entry = fontFamilies().find(font => font.source === 'user' && font.family === upload.family)!;
      for (const familyName of [upload.family, upload.family.toUpperCase(), ` ${upload.family.toLowerCase()} `]) {
        expect(familyData(entry, familyName)).toEqual({ family: upload.family, category: 'user', variants: [{ weight: 400, italic: false, label: 'Regular' }] });
      }
    }
  });
  it.each(['No such T22 font family', '', '   ', '__proto__', 'constructor'])('unknown text family %j fails without a code or side effect', familyName => {
    expect(failure(familyName)).toContain(familyName);
  });
  it.each<{ label: string; value: unknown }>([
    { label: 'a number', value: 42 }, { label: 'null', value: null }, { label: 'a boolean', value: true }, { label: 'an array naming a real font', value: ['Roboto'] },
    { label: 'an object', value: { family: 'Roboto' } }, { label: 'an object with non-callable toString', value: { toString: null } },
  ])('$label is a non-text familyName: return the exact INVALID_TOOL_INPUT TYPE refusal', ({ value }) => {
    refused({ familyName: value }, [{ path: '$.familyName', code: 'TYPE', message: 'must be string' }]);
  });
});

describe('fonts is pure: deterministic calls and caller-owned results', () => {
  it('identical arguments give equal results and successes/failures change no arguments, lists, registry, upload metadata or stored font bytes', async () => {
    const upload = await uploadFont('T22 Read Only Upload'), before = snapshot();
    const args: Args[] = [{}, { videoStyle: 'Karaoke Pop', role: 'titles' }, { videoStyle: '8-BIT', role: 'captions' }, { familyName: 'Roboto' },
      { familyName: upload.meta.family }, { familyName: 'No such T22 font family' }, { familyName: { toString: null } }], inputs = structuredClone(args);
    for (const input of args) expect(fonts(input)).toEqual(fonts(input)); expect(args).toEqual(inputs); expect(snapshot()).toEqual(before);
    expect(new Uint8Array(await (await userBlob(upload.meta.sha256)).arrayBuffer())).toEqual(upload.bytes);
  });
  it('ranked pick objects, styles arrays and the outer result data are detached; caller mutations cannot change the next result', () => {
    const args = { videoStyle: 'Handwritten', role: 'captions' } as const, before = snapshot(), data = listing(args, 'handwritten', 'captions'), pristine = structuredClone(data); detached(data);
    data.picks[0].family = 'Caller family'; data.picks[0].role = 'text'; data.picks[0].note = 'Caller note'; data.picks[0].styles[0] = 'Caller style'; data.picks[0].styles.push('Caller extra');
    data.picks.reverse(); data.picks.pop(); data.total = -1; data.hint = 'Caller hint';
    expect(listing(args, 'handwritten', 'captions')).toEqual(pristine); expect(snapshot()).toEqual(before);
  });
  it.each(['registry', 'upload'] as const)('%s family detail and nested variants are detached; caller mutations cannot change a later lookup', async kind => {
    if (kind === 'upload') await uploadFont('T22 Detached Upload'); const entry = fontFamilies().find(font => font.family === (kind === 'upload' ? 'T22 Detached Upload' : 'Roboto'))!;
    const before = snapshot(), data = familyData(entry), pristine = structuredClone(data); detached(data);
    data.family = 'Caller family'; data.category = 'user'; data.variants[0].weight = 999; data.variants[0].italic = !data.variants[0].italic; data.variants[0].label = 'Caller label';
    data.variants.push({ weight: 100, italic: true, label: 'Caller extra' }); data.variants.reverse();
    expect(familyData(entry)).toEqual(pristine); expect(snapshot()).toEqual(before);
  });
});
