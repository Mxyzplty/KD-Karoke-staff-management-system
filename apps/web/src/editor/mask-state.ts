// SPDX-License-Identifier: AGPL-3.0-only
// T12: the mask editor's view state (part 3 §46.13, part 2 §36): which item and mask the stage overlay edits, and its tool. Never in
// the document. Apart from mask-ui.tsx so the key actions can enter the editor without importing the inspector.
import { create } from 'zustand';
import { masksOf } from '../masks/model';
import type { ProjectDocument } from '../store/model';
import type { ShapeType } from '../timeline/shapes';
import { setView } from './view';

export type MaskTool = 'path' | 'shape' | 'pen' | 'smart';
/** index null: no mask yet (Add Mask, "+"), so the path tool shows nothing and a drag creates nothing (wave-3 fixture 1). */
export type MaskUi = { itemId: string | null; index: number | null; tool: MaskTool; shape: ShapeType };
export const useMaskUi = create<MaskUi>(() => ({ itemId: null, index: null, tool: 'path', shape: 'ellipse' }));
export function setMaskTool(tool: MaskTool) {
  useMaskUi.setState({ tool });
  setView(s => ({ modes: { ...s.modes, smartMask: tool === 'smart' } }));
}
export function openMaskEditor(itemId: string, index: number | null) {
  useMaskUi.setState({ itemId, index });
  setMaskTool('path');
}
/** M and the Mask header: the last hand-drawn mask, else none yet. */
export function enterMaskEdit(doc: ProjectDocument, itemId: string) {
  const i = doc.items.find(x => x.id === itemId), last = i ? masksOf(i).map(m => m.source !== 'smart').lastIndexOf(true) : -1;
  openMaskEditor(itemId, last < 0 ? null : last);
}
export function leaveMaskEdit() {
  useMaskUi.setState({ itemId: null, index: null });
  setMaskTool('path');
}
/** After a delete the later masks move down one index. */
export function maskDeleted(index: number) {
  useMaskUi.setState(s => ({ index: s.index === null || s.index === index ? null : s.index > index ? s.index - 1 : s.index }));
}
