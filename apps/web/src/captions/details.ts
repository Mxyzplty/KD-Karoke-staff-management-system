// SPDX-License-Identifier: AGPL-3.0-only
// T09 the caption-specific part of viewItemDetails `general` (coordinator ruling Q3: analysis/details.ts stays analysis-owned
// and makes one additive call into this captions-owned projection). It carries what the always-present item fields cannot:
// the render mode and its config, where the caption comes from (linked to a source item, detached, or bare), and the source
// coverage behind a linked caption. There is no Xapp ground-truth for a caption here (agent tool results §2 has no stored
// caption viewItemDetails), so the field shape is Cutframe's — provisional, notes Q3, pending Author.
import type { ProjectDocument, RecordData } from '../store/model';
import { item as itemOf } from '../timeline/model';
import { bindingOf, isDetached, isLinked, wordsOf } from './model';

const s3 = (ms: number) => Math.round(ms) / 1000; // source ms → s (the rest of the details object is in s)

/** The `caption` block merged into a caption's `general` result; {} for any non-caption item (so a mixed batch stays correct,
 *  the way shapeDetails returns the shape block). */
export function captionDetails(doc: ProjectDocument, item: RecordData): RecordData {
  if (item.type !== 'caption') return {};
  const d = item.details ?? {}, linked = isLinked(item);
  const source = linked ? itemOf(doc, item.captionSourceItemId!) : undefined;
  const binding = source ? bindingOf(source, item.metadata?.captionBindingId) : undefined;
  const config = d.renderConfig && typeof d.renderConfig === 'object' && Object.keys(d.renderConfig).length ? { renderConfig: d.renderConfig } : {};
  return { caption: {
    mode: linked ? 'linked' : isDetached(item) ? 'detached' : 'bare',
    renderMode: typeof d.renderMode === 'string' ? d.renderMode : 'default', ...config,
    wordCount: wordsOf(item).length,
    ...linked ? { sourceItemId: item.captionSourceItemId } : {},
    ...binding ? { speaker: binding.speaker, coverage: binding.coverage.map(c => ({ from: s3(c.fromMs), to: s3(c.toMs), state: c.state })) } : {},
    ...binding && binding.conflicts.length ? { conflicts: binding.conflicts.length } : {},
  } };
}
