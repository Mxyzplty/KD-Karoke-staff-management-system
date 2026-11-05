// SPDX-License-Identifier: AGPL-3.0-only
// T05 the agent path's font load (coordinator ruling Q5, 3 Nov): addText, and editProperties with a font key, first load the
// faces the call would draw with, so addText measures with the real face and a face that cannot load refuses the call with
// nothing changed (error codes FONT_LOAD_FAILED: the loader's own FONT_* code, else FONT_LOAD_FAILED; R2). Every other call
// keeps the sync path. Apart from text/tools.ts because the loader imports font files (Vite only).
import type { RecordData } from '../store/model';
import { editProperties } from '../timeline/edits';
import { item } from '../timeline/model';
import type { ToolContext, ToolResult } from '../timeline/tools';
import { FontError, itemFonts, loadChainFonts, loadFont, loadUserFonts } from './fonts';
import type { ResolvedFont } from './fonts';
import { FONT_KEYS } from './properties';
import { addTextIn } from './tools';

const isObj = (v: unknown): v is RecordData => !!v && typeof v === 'object' && !Array.isArray(v);
/** Calls that load a face before they run: addText, and editProperties whose properties hold a font key. */
export const needsFontLoad = (tool: string, input: RecordData | undefined) =>
  tool === 'addText' || tool === 'editProperties' && isObj(input?.properties) && FONT_KEYS.some(k => k in input!.properties);

class Would { constructor(readonly items: RecordData[]) {} }
/** The text items the call would write once every check passes (on a draft the bus then discards), else null: a refusal,
 *  which `run` reports. */
function wouldWrite(ctx: ToolContext, name: string, args: RecordData): RecordData[] | null {
  try {
    ctx.bus.run('Edit items', 'agent', doc => {
      const r = name === 'addText' ? addTextIn(doc, args) : editProperties(doc, args);
      const ids: string[] = !r.success ? [] : name === 'addText' ? [r.data.itemId] : r.data.itemIds;
      throw new Would(ids.map(id => item(doc, id)).filter((i): i is RecordData => i?.type === 'text'));
    });
  } catch (e) { if (e instanceof Would) return e.items; }
  return null;
}
/** The faces an item draws with; none for a stored family that is no longer listed (the drawing falls back). */
const facesOf = (i: RecordData): ResolvedFont[] => { try { return itemFonts(i); } catch { return []; } };

/** Loads what the call needs, then `run` (the real call through the caller's agent wrapper, which repeats the checks on the
 *  current document). A refused call loads nothing; a face that cannot load returns FONT_LOAD_FAILED and runs nothing. A
 *  chain font (emoji, CJK) that cannot load only falls back (its notice is in the editor and the export result). */
export async function callTextTool(ctx: ToolContext, name: string, args: RecordData, options: { run: () => ToolResult | Promise<ToolResult> }): Promise<ToolResult> {
  await loadUserFonts();
  try {
    for (const i of wouldWrite(ctx, name, args ?? {}) ?? []) {
      const text = typeof i.details?.text === 'string' ? i.details.text : '';
      for (const r of facesOf(i)) await loadFont(r, text || ' ');
      await loadChainFonts(text);
    }
  } catch (e) {
    if (!(e instanceof FontError)) throw e;
    return { success: false, error: `The selected font could not be loaded. No items were ${name === 'addText' ? 'added' : 'changed'}.`, code: e.code.startsWith('FONT_') ? e.code : 'FONT_LOAD_FAILED' };
  }
  return options.run();
}
