// SPDX-License-Identifier: AGPL-3.0-only
// T23 other projects' overviews (findings part 2 §42: `workspace` opens other projects' overviews): one generated,
// read-only file per project of this browser except the open one, `projects/<id>/overview.md` under the guides root.
// Demo projects are not listed (ProjectStore.list leaves them out).
import type { ProjectStore } from '../../store/database';
import type { ProjectRecord } from '../../store/model';
import { findTemplate } from '../../templates/library';

export const PROJECTS_FOLDER = 'projects';
export const projectOverviewPath = (id: string) => `${PROJECTS_FOLDER}/${id}/overview.md`;
export const PROJECT_DESCRIPTION = (title: string) => `Overview of the project "${title}".`;

/** The other projects, newest first (as the home page lists them). */
export async function otherProjects(store: ProjectStore, openId: string): Promise<ProjectRecord[]> {
  return (await store.list()).filter(p => p.id !== openId);
}
const seconds = (ms: number) => `${Math.round(ms) / 1000} s`;
/** The overview text of one project, or undefined when it is gone. */
export async function projectOverview(store: ProjectStore, id: string): Promise<string | undefined> {
  const read = await store.read(id).catch(() => null);
  if (!read || read.record.is_demo) return undefined;
  const { record, document: doc } = read, template = record.template_id ? await findTemplate(store, record.template_id) : undefined;
  const kinds = new Map<string, number>();
  for (const i of doc.items) kinds.set(String(i.type), (kinds.get(String(i.type)) ?? 0) + 1);
  return [
    `# ${record.title}`, '',
    `- Project id: ${record.id}`,
    `- Canvas: ${doc.size.width} × ${doc.size.height} px at ${doc.fps} fps`,
    `- Duration: ${seconds(doc.duration)}`,
    `- Template: ${!record.template_id ? 'none' : template ? `${template.name} (${template.id})` : `missing (${record.template_id})`}`,
    `- Items: ${doc.items.length ? [...kinds].map(([k, n]) => `${n} ${k}`).join(', ') : 'none'}`,
    `- Last changed: ${record.updated_at}`, '',
  ].join('\n');
}
