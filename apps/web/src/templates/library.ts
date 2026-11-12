// SPDX-License-Identifier: AGPL-3.0-only
// The local template library (T22; findings §22, plan P1 / P9): the built-in templates plus one settings row holding the
// user's templates and the saved list ("membership"). No authoring limits.
// A user-row template with a built-in's id (and `basedOn`) is that built-in's personal copy: lookups read the user row first.
// Cutframe difference from Xapp (mechanism only): the copy is made at the first change, not when the template is chosen;
// until then every view shows the built-in's own values. Deleting the copy gives the built-in back.
// A template file is data only: `{format, version, template, assets[]}` with the library media and the uploaded fonts the
// template uses embedded as base64, each with its SHA-256. Import checks everything before it writes anything.
import { bundledFile } from '../catalogue/assets';
import { mediaKind } from '../media/files';
import { sha256Blob } from '../media/sha256';
import type { ProjectStore } from '../store/database';
import type { RecordData } from '../store/model';
import { addUserFont, findFont, fontNames, MAX_FONT_BYTES, removeUserFont, userBlob, userFonts } from '../text/font-registry';
import { DEFAULT_FILES, DEFAULT_TEMPLATE } from './default';
import { templateError } from './errors';
import { refKind, templateProblem, templateRefs, TEMPLATE_VERSION, type Template } from './model';

export const TEMPLATES_ROW = 'templates', TEMPLATE_FORMAT = 'cutframe-template';
export const BUILT_IN_TEMPLATES: readonly Template[] = [DEFAULT_TEMPLATE];
type Row = { id: string; templates: Template[]; membership: string[] };
export type TemplateFileAsset = { id: string; name: string; kind: 'video' | 'image' | 'audio' | 'font'; mime: string; sha256: string; bytes: number; data: string };
export type TemplateFile = { format: typeof TEMPLATE_FORMAT; version: number; template: Template; assets: TemplateFileAsset[] };

const builtIn = (id: string) => BUILT_IN_TEMPLATES.find(t => t.id === id);
const clean = (row: Row | undefined): Row => ({
  id: TEMPLATES_ROW, templates: (Array.isArray(row?.templates) ? row!.templates : []).filter(t => !templateProblem(t)),
  membership: (Array.isArray(row?.membership) ? row!.membership : []).filter(m => typeof m === 'string'),
});
const readRow = async (store: ProjectStore) => clean(await store.row<Row>('settings', TEMPLATES_ROW));
/** A built-in template as its personal copy starts out. */
export const personalCopy = (t: Template): Template => ({ ...structuredClone(t), basedOn: t.id });

/** Both picker tabs. `builtIn` shows each built-in template (its personal copy once there is one); `mine` is the saved
 *  built-ins followed by the user's own templates. */
export async function listTemplates(store: ProjectStore): Promise<{ builtIn: Template[]; mine: Template[] }> {
  const row = await readRow(store), shown = BUILT_IN_TEMPLATES.map(t => row.templates.find(u => u.id === t.id) ?? t);
  return { builtIn: shown, mine: [...shown.filter(t => row.membership.includes(t.id)), ...row.templates.filter(t => !builtIn(t.id))] };
}
/** The template an id names: the user's own or personal copy first, then the built-in. */
export async function findTemplate(store: ProjectStore, id: string): Promise<Template | undefined> {
  return (await readRow(store)).templates.find(t => t.id === id) ?? builtIn(id);
}
function checked(t: Template): Template {
  const reason = templateProblem(t);
  if (reason) throw templateError('TEMPLATE_INVALID', reason);
  return builtIn(t.id) ? { ...t, basedOn: t.id } : (({ basedOn: _, ...rest }) => rest)(t);
}
/** Stores a template (the same id replaces). One with a built-in's id is stored as that built-in's personal copy. */
export async function saveTemplate(store: ProjectStore, template: Template): Promise<Template> {
  const t = checked(template);
  await store.swapRow<Row>('settings', TEMPLATES_ROW, row => { const r = clean(row); return { ...r, templates: [...r.templates.filter(u => u.id !== t.id), t] }; });
  return t;
}
/** Changes a template in one step and stamps it. A built-in without a personal copy gets its copy here. */
export async function updateTemplate(store: ProjectStore, id: string, change: (t: Template) => Template, now = new Date()): Promise<Template> {
  let result: Template | undefined, problem: string | null = null;
  await store.swapRow<Row>('settings', TEMPLATES_ROW, row => {
    const r = clean(row), b = builtIn(id), current = r.templates.find(u => u.id === id) ?? (b && personalCopy(b));
    if (!current) return null;
    const next = { ...change(structuredClone(current)), id, savedAt: now.toISOString(), ...(b ? { basedOn: id } : {}) };
    if ((problem = templateProblem(next))) return null;
    result = next;
    return { ...r, templates: [...r.templates.filter(u => u.id !== id), next] };
  });
  if (problem) throw templateError('TEMPLATE_INVALID', problem);
  if (!result) throw templateError('TEMPLATE_NOT_FOUND');
  return result;
}
/** Removes the user's template or personal copy and its place in the saved list. A built-in itself stays. */
export async function deleteTemplate(store: ProjectStore, id: string): Promise<void> {
  await store.swapRow<Row>('settings', TEMPLATES_ROW, row => { const r = clean(row); return { ...r, templates: r.templates.filter(t => t.id !== id), membership: r.membership.filter(m => m !== id) }; });
}
/** "Save to My templates": puts a built-in on the saved list (the user's own templates are always there). */
export async function saveToMyTemplates(store: ProjectStore, id: string): Promise<void> {
  if (!await findTemplate(store, id)) throw templateError('TEMPLATE_NOT_FOUND');
  if (builtIn(id)) await store.swapRow<Row>('settings', TEMPLATES_ROW, row => { const r = clean(row); return r.membership.includes(id) ? null : { ...r, membership: [...r.membership, id] }; });
}

/** Checks the bundled files of a built-in template: each must load and have its recorded SHA-256, else DEFAULT_UNAVAILABLE. */
export async function verifyBuiltIn(template: Template, load: (file: string) => Promise<Blob> = bundledFile): Promise<void> {
  for (const f of template.id === DEFAULT_TEMPLATE.id ? DEFAULT_FILES : []) {
    const hash = await load(f.path).then(sha256Blob, () => null);
    if (hash !== f.sha256) throw templateError('DEFAULT_UNAVAILABLE', hash ? `${f.path} is not the recorded file.` : `${f.path} is missing.`);
  }
}

// ---- Template files ----
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const assetIds = (t: Template) => [...new Set(templateRefs(t).filter(r => refKind(r.ref) === 'asset').map(r => r.ref.slice(6)))];
/** The uploaded fonts a template names (its three default fonts and its font list). */
function uploadedFonts(t: Template) {
  const names = [...Object.values(t.defaults), ...t.assets.fonts.map(r => r.ref.slice(5))];
  return [...new Map(names.map(n => findFont(n)?.entry).filter(e => e?.source === 'user').map(e => [e!.sha256!, e!])).values()];
}
/** The template as one file, plus what the file carries besides the template text: the names of the embedded media and of
 *  the embedded uploaded fonts (the user is shown both: a shared file hands them to someone else). */
export async function exportTemplate(store: ProjectStore, id: string): Promise<{ file: TemplateFile; carries: { media: string[]; fonts: string[] } }> {
  const template = await findTemplate(store, id);
  if (!template) throw templateError('TEMPLATE_NOT_FOUND');
  const library = (await store.library()).assets, assets: TemplateFileAsset[] = [], carries = { media: [] as string[], fonts: [] as string[] };
  const embed = async (blob: Blob, a: Omit<TemplateFileAsset, 'sha256' | 'bytes' | 'data'>) => assets.push({ ...a, sha256: await sha256Blob(blob), bytes: blob.size, data: toBase64(new Uint8Array(await blob.arrayBuffer())) });
  for (const assetId of assetIds(template)) {
    const a = library.find(x => x.id === assetId);
    if (!a) throw templateError('TEMPLATE_UNAVAILABLE', `A file this template uses (${templateRefs(template).find(r => r.ref === `asset:${assetId}`)!.name}) is no longer in the library.`);
    await embed(await store.media.read(a.id), { id: a.id, name: a.originalName ?? a.name, kind: a.type, mime: a.mimeType });
    carries.media.push(a.name);
  }
  for (const font of uploadedFonts(template)) {
    const blob = await userBlob(font.sha256!), meta = userFonts().find(u => u.sha256 === font.sha256);
    await embed(blob, { id: font.sha256!, name: meta?.fileName || font.family, kind: 'font', mime: blob.type });
    carries.fonts.push(font.family);
  }
  return { file: { format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, template, assets }, carries };
}

const ASSET_KEYS = ['id', 'name', 'kind', 'mime', 'sha256', 'bytes', 'data'], FILE_KEYS = ['format', 'version', 'template', 'assets'];
const exact = (o: RecordData, keys: string[]) => Object.keys(o).length === keys.length && keys.every(k => o[k] !== undefined);
const invalid = (detail: string) => templateError('TEMPLATE_INVALID', detail);
/** Reads a template file into the library. Every check runs first (format, version, closed schema, each asset's size and
 *  SHA-256, a file for every `asset:` reference, each font's size and name); any failure is TEMPLATE_INVALID and nothing is
 *  stored. A library asset or uploaded font with the same SHA-256 is reused. The same template id replaces. */
export async function importTemplate(store: ProjectStore, input: unknown): Promise<Template> {
  const file = input as RecordData;
  if (!file || typeof file !== 'object' || Array.isArray(file) || !exact(file, FILE_KEYS) || file.format !== TEMPLATE_FORMAT) throw invalid('The file is not a template file.');
  if (file.version !== TEMPLATE_VERSION) throw invalid(`The file has version ${String(file.version)}; this app reads version ${TEMPLATE_VERSION}.`);
  const reason = templateProblem(file.template);
  if (reason) throw invalid(`template: ${reason}`);
  if (!Array.isArray(file.assets)) throw invalid('assets is not a list.');
  const blobs = new Map<string, { asset: TemplateFileAsset; blob: Blob }>();
  for (const [n, a] of (file.assets as RecordData[]).entries()) {
    const where = `assets[${n}]`;
    if (!a || typeof a !== 'object' || !exact(a, ASSET_KEYS) || [a.id, a.name, a.kind, a.mime, a.sha256, a.data].some(v => typeof v !== 'string') || !a.id || !a.name) throw invalid(`${where} is not an asset entry.`);
    if (blobs.has(a.id)) throw invalid(`${where} repeats the id ${a.id}.`);
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = Uint8Array.from(atob(a.data), c => c.charCodeAt(0)); } catch { throw invalid(`${where}: the data is not base64.`); }
    const blob = new Blob([bytes], { type: a.mime });
    if (bytes.length !== a.bytes) throw invalid(`${where}: the size differs from the recorded ${String(a.bytes)} bytes.`);
    if (await sha256Blob(blob) !== a.sha256) throw invalid(`${where}: the content does not match its SHA-256.`);
    if (a.kind === 'font') {
      const names = fontNames(bytes.buffer);
      if (a.id !== a.sha256 || bytes.length > MAX_FONT_BYTES || !names.family && !names.postScriptName) throw invalid(`${where} is not a font this app can add.`);
    } else if (!['video', 'image', 'audio'].includes(a.kind) || mediaKind(a.name, a.mime) !== a.kind) throw invalid(`${where}: ${a.name} is not a file of the kind ${a.kind}.`);
    blobs.set(a.id, { asset: a as TemplateFileAsset, blob });
  }
  const template = file.template as Template, missing = assetIds(template).find(id => blobs.get(id)?.asset.kind === 'font' || !blobs.has(id));
  if (missing) throw invalid(`The file does not carry the asset ${missing} its template uses.`);

  const added: string[] = [], had = new Set(userFonts().map(u => u.sha256));
  try {
    for (const { asset, blob } of blobs.values()) if (asset.kind === 'font' && !had.has(asset.sha256)) { added.push(asset.sha256); await addUserFont(new File([blob], asset.name, { type: asset.mime })); }
  } catch (e) {
    for (const sha of added) await removeUserFont(sha).catch(() => {});
    throw invalid(`A font in the file could not be added: ${(e as Error).message}`);
  }
  const library = (await store.library()).assets, ids = new Map<string, string>();
  for (const { asset, blob } of blobs.values()) if (asset.kind !== 'font')
    ids.set(asset.id, (library.find(x => x.sha256 === asset.sha256) ?? await store.upload(new File([blob], asset.name, { type: asset.mime }))).id);
  const point = (r: { name: string; ref: string }) => refKind(r.ref) === 'asset' ? { ...r, ref: `asset:${ids.get(r.ref.slice(6))}` } : r;
  return saveTemplate(store, { ...template, examples: template.examples.map(point), assets: { fonts: template.assets.fonts, audio: template.assets.audio.map(point), images: template.assets.images.map(point) } });
}
