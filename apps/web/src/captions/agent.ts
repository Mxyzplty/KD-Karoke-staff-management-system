// SPDX-License-Identifier: AGPL-3.0-only
// T09 the agent path's async prep for addCaptions (the sync handler cannot await). First the sources' transcripts and music
// state are read from the store into `ctx.captionData` (the generator reads them synchronously), then the faces the new
// captions would draw with are loaded (a face that cannot load refuses the call with nothing changed, like addText —
// coordinator T05 ruling Q5). Apart from captions/tools.ts because the font loader imports font files (Vite only).
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import type { ProjectStore } from '../store/database';
import { importTranscript } from '../analysis/read';
import type { RhythmRow, TranscriptRow } from '../analysis/service';
import { isCaption, item } from '../timeline/model';
import { editProperties } from '../timeline/edits';
import type { ToolContext, ToolResult } from '../timeline/tools';
import { FontError, itemFonts, loadChainFonts, loadFont, loadUserFonts } from '../text/fonts';
import type { ResolvedFont } from '../text/fonts';
import type { SourceData } from './generation';
import { addCaptionsIn, NO_CAPTION_DATA } from './tools';
import { editAllCaptionStyles } from './properties';

type Store = Pick<ProjectStore, 'row'>;
/** addCaptions is the only caption tool that loads source data first (editAllCaptionStyles / listCaptionTemplates do not). */
export const needsCaptionPrep = (tool: string) => tool === 'addCaptions';

const FONT_KEYS = ['fontFamily', 'fontWeight', 'fontStyle'];
export function needsCaptionFontLoad(doc: ProjectDocument, tool: string, args: RecordData): boolean {
  const props = tool === 'editAllCaptionStyles' ? args.properties ?? args : args.properties;
  if (!props || !FONT_KEYS.some(k => k in props)) return false;
  return tool === 'editAllCaptionStyles' || tool === 'editProperties' && (args.itemIds ?? [args.itemId]).some((id: string) => { const i = item(doc, id); return !!i && isCaption(i); });
}

/** Validate the actual style draft, load every affected face, then commit only against the document that was measured.
 *  This owns caption edits without changing T05's text-only preflight. The discovery transaction always rolls back. */
export async function callCaptionStyleTool(ctx: ToolContext, tool: string, args: RecordData, options: { run: () => ToolResult | Promise<ToolResult> }): Promise<ToolResult> {
  const before = ctx.bus.doc;
  let items: RecordData[] = [];
  try {
    ctx.bus.run('Edit items', 'agent', doc => {
      const ids = tool === 'editAllCaptionStyles' ? editAllCaptionStyles(doc, args.trackId, args.properties ?? args).updatedIds : editProperties(doc, args).data.itemIds;
      throw new Would(doc.items.filter(i => (isCaption(i) || i.type === 'text') && (ids.includes(i.id) || JSON.stringify(i) !== JSON.stringify(item(before, i.id)))));
    });
  } catch (e) { if (e instanceof Would) items = e.items; }
  try {
    await loadUserFonts();
    for (const i of items) {
      const text = typeof i.details?.text === 'string' ? i.details.text : '';
      for (const face of itemFonts(i)) await loadFont(face, text || ' ');
      await loadChainFonts(text);
    }
  } catch (e) {
    if (!(e instanceof FontError)) throw e;
    return { success: false, error: 'The selected font could not be loaded. No items were changed.', code: e.code.startsWith('FONT_') ? e.code : 'FONT_LOAD_FAILED' };
  }
  if (ctx.bus.doc !== before) return { success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: 'The document changed while caption fonts loaded. Read context and retry.' };
  return options.run();
}

/** One asset's caption-source state from the stored rows (no analysis is run here): `complete` once transcription ran (a
 *  silent asset is complete with a null transcript), `pending` while it is still being prepared, else `none`. `music` is the
 *  classifier flag, the music-without-vocals skip, or a stored beat row. */
async function sourceData(store: Store, asset: Asset | undefined, assetId: string): Promise<SourceData> {
  const [row, rhythm] = await Promise.all([store.row<TranscriptRow>('transcripts', assetId), store.row<RhythmRow>('rhythms', assetId)]);
  const music = row?.music === true || row?.status === 'skipped' || rhythm?.analysis != null;
  if (row?.status === 'complete') return { status: 'complete', transcript: importTranscript(row.transcript), music };
  if (row?.status === 'skipped') return { status: 'complete', transcript: null, music: true };
  const step = asset?.processing_steps?.transcription, busy = asset?.processing_status === 'uploading' || asset?.processing_status === 'processing';
  if (step === 'pending' || step === 'processing' || busy) return { status: 'pending', transcript: null, music };
  return { status: 'none', transcript: null, music };
}

/** A provider over every timed source asset in the document: addCaptions reads each asset's transcript and music state from it. */
export async function captionData(store: Store, doc: ProjectDocument, asset: (id: string) => Asset | undefined): Promise<(assetId: string) => SourceData> {
  const ids = [...new Set(doc.items.filter(i => i.type === 'video' || i.type === 'audio').map(i => i.metadata?.assetId as string).filter(Boolean))];
  const map = new Map<string, SourceData>();
  await Promise.all(ids.map(async id => { map.set(id, await sourceData(store, asset(id), id)); }));
  return id => map.get(id) ?? NO_CAPTION_DATA;
}

class Would { constructor(readonly items: RecordData[]) {} }
/** The caption items addCaptions would create (on a draft the bus then discards), so their faces can be loaded; none on a
 *  refusal, which `run` then reports from the real call. */
function wouldCreate(ctx: ToolContext, args: RecordData): RecordData[] {
  try {
    ctx.bus.run('Add captions', 'agent', doc => {
      const r = addCaptionsIn(doc, args, ctx.captionData ?? (() => NO_CAPTION_DATA));
      const ids: string[] = r.success && r.data && Array.isArray((r.data as RecordData).captionIds) ? (r.data as RecordData).captionIds : [];
      throw new Would(ids.map(id => item(doc, id)).filter((i): i is RecordData => i?.type === 'caption'));
    });
  } catch (e) { if (e instanceof Would) return e.items; }
  return [];
}
const facesOf = (i: RecordData): ResolvedFont[] => { try { return itemFonts(i); } catch { return []; } };

/** Loads the sources' transcripts and the new captions' faces, then `run` (the real call through the caller's agent
 *  wrapper, which repeats the checks on the current document). A face that cannot load returns FONT_LOAD_FAILED and runs
 *  nothing; a chain font (emoji, CJK) that cannot load only falls back. */
export async function callCaptionTool(ctx: ToolContext, args: RecordData, options: { store: Store; asset: (id: string) => Asset | undefined; run: () => ToolResult | Promise<ToolResult> }): Promise<ToolResult> {
  await loadUserFonts();
  ctx.captionData = await captionData(options.store, ctx.bus.doc, options.asset);
  try {
    for (const i of wouldCreate(ctx, args ?? {})) {
      const text = typeof i.details?.text === 'string' ? i.details.text : '';
      for (const r of facesOf(i)) await loadFont(r, text || ' ');
      await loadChainFonts(text);
    }
  } catch (e) {
    if (!(e instanceof FontError)) throw e;
    return { success: false, error: 'The selected font could not be loaded. No captions were added.', code: e.code.startsWith('FONT_') ? e.code : 'FONT_LOAD_FAILED' };
  }
  return options.run();
}
