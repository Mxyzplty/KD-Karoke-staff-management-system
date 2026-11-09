// SPDX-License-Identifier: AGPL-3.0-only
// Export jobs (agent tool contracts exportProject / getExportStatus): startExport returns a render id at once and runs the
// export in the background; the status is rendering → completed (with a download URL) or failed (with the §12 class).
// cancelExport stops a run as USER_CANCELLED; a new export of the same project stops the older one as SUPERSEDED.
// MP4 only in T16a (WebM, presets and the dialog are T16).
import { countExport } from '../settings/meter';
import { StoreError } from '../store/model';
import { classifyExportError, ExportError } from './errors';
import type { ExportFailure } from './errors';
import { runExport } from './pipeline';
import type { ExportOptions, ExportResult, Progress } from './pipeline';

export type ExportFormat = 'mp4' | 'webm';
export type ExportStatus = {
  status: 'rendering' | 'completed' | 'failed'; downloadUrl?: string; error?: ExportFailure; progress: Progress | null; result?: ExportResult;
};
type Job = { id: string; projectKey: string; controller: AbortController; state: ExportStatus; done: Promise<ExportStatus> };
const jobs = new Map<string, Job>();
const active = new Map<string, string>();

/** Starts an export; the project key (default: the document id) decides which older export it supersedes. */
export function startExport(options: ExportOptions & { format?: ExportFormat; projectKey?: string }): string {
  if (options.format && options.format !== 'mp4') throw new StoreError('NOT_IMPLEMENTED', `Export as ${options.format} is not available yet; export as MP4.`);
  const id = `render_${crypto.randomUUID()}`, projectKey = options.projectKey ?? String(options.doc?.id ?? 'project');
  const older = active.get(projectKey);
  if (older) jobs.get(older)?.controller.abort(new ExportError('SUPERSEDED', `Export superseded by a newer export ${id}`));
  active.set(projectKey, id);
  const controller = new AbortController();
  // A signal already aborted never fires 'abort': the export is cancelled at once.
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener('abort', () => controller.abort(options.signal!.reason), { once: true });
  const state: ExportStatus = { status: 'rendering', progress: null };
  const done = runExport({ ...options, signal: controller.signal, onProgress: p => { state.progress = p; options.onProgress?.(p); } }).then(
    result => { state.status = 'completed'; state.result = result; state.downloadUrl = URL.createObjectURL(result.blob); countExport(); return state; },
    // An aborted job fails as its abort reason (USER_CANCELLED, SUPERSEDED), also when a hung decode then times out.
    e => { state.status = 'failed'; state.error = classifyExportError(controller.signal.aborted ? controller.signal.reason : e); return state; },
  ).finally(() => { if (active.get(projectKey) === id) active.delete(projectKey); });
  jobs.set(id, { id, projectKey, controller, state, done });
  return id;
}
export function getExportStatus(id: string): ExportStatus {
  const job = jobs.get(id);
  if (!job) throw new StoreError('NOT_FOUND', `No export ${id}.`);
  return job.state;
}
export function cancelExport(id: string) {
  const job = jobs.get(id);
  if (job && job.state.status === 'rendering') job.controller.abort(new ExportError('USER_CANCELLED', 'Export cancelled by user'));
}
/** Resolves once the export has completed or failed. */
export function awaitExport(id: string): Promise<ExportStatus> {
  const job = jobs.get(id);
  if (!job) return Promise.reject(new StoreError('NOT_FOUND', `No export ${id}.`));
  return job.done;
}
/** Forgets a finished export and revokes its download URL. */
export function releaseExport(id: string) {
  const job = jobs.get(id);
  if (!job || job.state.status === 'rendering') return;
  if (job.state.downloadUrl) URL.revokeObjectURL(job.state.downloadUrl);
  jobs.delete(id);
}
export { runExport, classifyExportError };
export type { ExportOptions, ExportResult, Progress };
