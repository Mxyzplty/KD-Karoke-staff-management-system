// SPDX-License-Identifier: AGPL-3.0-only
// Caption collection for T05's font loader. Export must finish loading every caption face before its first frame.
import type { ProjectDocument } from '../store/model';
import { exportedItems } from '../export/prep';
import type { Range } from '../export/prep';
import { itemFonts, loadChainFonts, loadFont, loadUserFonts } from '../text/fonts';
import { isCaption } from '../timeline/model';

export async function loadCaptionFonts(doc: ProjectDocument, range?: Range): Promise<string[]> {
  const captions = exportedItems(doc).filter(item => isCaption(item) && (!range || item.display.from < range.endS * 1000 && item.display.to > range.startS * 1000));
  if (!captions.length) return [];
  await loadUserFonts();
  const notices = new Set<string>();
  for (const item of captions) {
    const text = typeof item.details?.text === 'string' ? item.details.text : '';
    for (const face of itemFonts(item)) await loadFont(face, text || ' ');
    for (const notice of await loadChainFonts(text)) notices.add(notice);
  }
  return [...notices];
}
