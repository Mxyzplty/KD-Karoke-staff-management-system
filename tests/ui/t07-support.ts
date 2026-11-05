// SPDX-License-Identifier: AGPL-3.0-only
// Shared helpers for the T07 layout browser specs (panel and inspector: t07-panel.spec.ts; pixels and export: t07-render.spec.ts).
import { expect, type Locator, type Page } from '@playwright/test';
import { layoutRecord, type LayoutType } from '../../apps/web/src/timeline/layouts';
import { liveDoc } from './t03-support';

export const panel = (page: Page) => page.getByRole('complementary', { name: 'Inspector and tools' });
export const openLayouts = (page: Page) => page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Layouts' }).click();
export const layoutsIn = async (page: Page) => (await liveDoc(page)).items.filter((i: any) => i.type === 'layout') as any[];
/** An inspector section (a <details> with that summary text) and its opening: sections start closed. */
export const section = (scope: Locator, title: string | RegExp) => scope.locator('details.inspector-section').filter({ has: scope.page().locator('summary', { hasText: title }) });
export async function openSection(scope: Locator, title: string | RegExp) {
  const d = section(scope, title);
  if (!(await d.evaluate(e => (e as HTMLDetailsElement).open))) await d.locator('summary').click();
  await expect(d).toHaveJSProperty('open', true);
  return d;
}
/** Type into a Slider row the way a person does: double-click its value, fill "<label> value", Enter (the value is clamped to the row's range). */
export async function typeInto(scope: Locator, label: string, text: string) {
  await scope.locator(`[data-slider="${label}"] .slider-value`).dblclick();
  const input = scope.getByRole('textbox', { name: `${label} value` }); await input.fill(text); await input.press('Enter');
}
/** A video asset the library knows (ready, with a duration) without any decodable bytes: the panel and drop rows need no picture. */
export async function videoAsset(page: Page, projectId: string, name: string, durationMs: number) {
  return page.evaluate(async ({ projectId, name, durationMs }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    const asset = await projectStore.upload(new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], name, { type: 'video/mp4' }));
    await projectStore.updateAsset(asset.id, (a: any) => ({ ...a, durationMs, processing_status: 'ready', processing_steps: { ...a.processing_steps, probe: 'complete', thumbnails: 'complete' } }));
    await projectStore.attach(projectId, asset.id); return asset.id as string;
  }, { projectId, name, durationMs });
}
/** A layout item seeded into a document (the record layoutRecord builds), with optional property overrides stored as static values. */
export function seedLayout(id: string, layoutType: LayoutType, o: { trackId?: string; from?: number; to?: number; width?: number; height?: number; props?: Record<string, number>; details?: Record<string, unknown> } = {}) {
  const r: any = layoutRecord({ id, trackId: o.trackId ?? 'o3', display: { from: o.from ?? 0, to: o.to ?? 10000 }, layoutType, width: o.width ?? 1920, height: o.height ?? 1080 });
  for (const [k, v] of Object.entries(o.props ?? {})) r.properties[k] = { defaultValue: v, keyframes: [] };
  Object.assign(r.details, o.details);
  return r;
}
/** Dispatches a footage drag (dragover then drop) on the preview stage at a fraction of the stage box; payload = the dnd.ts DragPayload. */
export function dropOnStage(page: Page, fx: number, fy: number, payload: unknown) {
  return page.evaluate(({ fx, fy, payload }) => {
    const stage = document.querySelector('.layout-drop')!.parentElement!, b = stage.getBoundingClientRect(), data = new DataTransfer();
    data.setData('application/x-cutframe-timeline', JSON.stringify(payload));
    const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: b.left + b.width * fx, clientY: b.top + b.height * fy };
    stage.dispatchEvent(new DragEvent('dragover', init)); stage.dispatchEvent(new DragEvent('drop', init));
  }, { fx, fy, payload });
}
