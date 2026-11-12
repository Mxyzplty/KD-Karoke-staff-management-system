// SPDX-License-Identifier: AGPL-3.0-only
// The project's template binding (T22; findings §22, plan P2 / P3). The binding is on the project record: `template_id`, an
// epoch that grows by one with each change (optimistic concurrency: a stale `expectedEpoch` is refused) and the request key
// of the last change (the same key again returns the stored binding: an idempotent retry). An unbound project has epoch 0.
// There is no unbind: nothing in §22 has that action. The document key `templateDefaults` carries the bound template's fonts
// and palette to new items; it is outside the undo snapshot, so Undo never reverts a binding.
import type { ProjectStore } from '../store/database';
import { StoreError, type ProjectDocument, type ProjectRecord } from '../store/model';
import { templateError } from './errors';
import { findTemplate } from './library';
import { defaultsOf, type Template, type TemplateDefaults } from './model';

export type Binding = { epoch: number; templateId: string };
export async function bindTemplate(store: ProjectStore, projectId: string, request: { templateId: string; expectedEpoch: number; requestKey: string }): Promise<Binding> {
  if (!await findTemplate(store, request.templateId)) throw templateError('TEMPLATE_NOT_FOUND');
  let result: Binding | undefined, found = false;
  await store.swapRow<ProjectRecord>('projects', projectId, row => {
    if (!row) return null;
    found = true;
    const epoch = row.template_epoch ?? 0;
    if (row.template_request === request.requestKey && row.template_id) { result = { epoch, templateId: row.template_id }; return null; }
    if (epoch !== request.expectedEpoch) return null;
    result = { epoch: epoch + 1, templateId: request.templateId };
    return { ...row, template_id: request.templateId, template_epoch: epoch + 1, template_request: request.requestKey };
  });
  if (!found) throw new StoreError('PROJECT_NOT_FOUND', 'This project no longer exists.');
  if (!result) throw templateError('TEMPLATE_SELECTION_STALE');
  return result;
}

/** The document with the template's defaults for new items (the caller saves it). */
export const writeDefaults = (doc: ProjectDocument, template: Template, epoch: number): ProjectDocument => ({ ...doc, templateDefaults: defaultsOf(template, epoch) });
export const readDefaults = (doc: ProjectDocument): TemplateDefaults | undefined => doc.templateDefaults as TemplateDefaults | undefined;
/** On open: the document with `templateDefaults` re-derived when it is behind the record's binding, or null when nothing
 *  is to do. An unbound record clears the key. A bound template that was deleted leaves the document alone: existing
 *  projects keep their treatment. */
export async function repairDefaults(store: ProjectStore, record: ProjectRecord, doc: ProjectDocument): Promise<ProjectDocument | null> {
  const stored = readDefaults(doc), epoch = record.template_epoch ?? 0;
  if (!record.template_id) {
    if (!stored) return null;
    const { templateDefaults: _, ...rest } = doc;
    return rest as ProjectDocument;
  }
  if (stored?.epoch === epoch && stored.templateId === record.template_id) return null;
  const template = await findTemplate(store, record.template_id);
  return template ? writeDefaults(doc, template, epoch) : null;
}
