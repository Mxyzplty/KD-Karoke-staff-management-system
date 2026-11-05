// SPDX-License-Identifier: AGPL-3.0-only
// The error panel a broken motion graphic shows on the preview canvas (findings part 3 §43.17): the renderer's error and a
// "Fix automatically" button (busy label while running; disabled with a "connect a model" line when no model is connected).
// Success: toast "Motion graphic fixed"; failure: toast "Motion graphic repair failed" and the reason in red under the button.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { dispatch } from '../editor/commands';
import { framePlan } from '../render/model';
import type { Draw } from '../render/model';
import { projectStore } from '../store/database';
import type { ProjectDocument } from '../store/model';
import { activeRuntime } from '../timeline/runtime';
import { notify } from '../ui';
import { nativeMediaRefusal } from './agent-checks';
import { renderGraphic, useGraphicErrors } from './frames';
import { CONNECT_A_MODEL, repairGraphic, useRepairModel } from './repair';
import type { RepairDeps } from './repair';

const PANEL: CSSProperties = { position: 'absolute', left: '.4rem', bottom: '.4rem', maxWidth: '80%', margin: 0, padding: '.4rem', fontSize: '.75rem', background: 'rgb(0 0 0 / .75)', color: '#eee' };

/** Compiles and renders the candidate at the draw's frame and box: its error, or null. */
async function validate(d: Draw, code: string): Promise<string | null> {
  const refusal = nativeMediaRefusal(code);
  if (refusal) return refusal;
  try { (await renderGraphic(projectStore, { ...d, graphic: { ...d.graphic!, code } })).close(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
export function GraphicErrorPanel({ doc, t }: { doc: ProjectDocument; t: number }) {
  const errors = useGraphicErrors(s => s.errors), model = useRepairModel(s => s.model);
  const [busy, setBusy] = useState<Record<string, boolean>>({}), [failed, setFailed] = useState<Record<string, string>>({});
  // The frame plan is needed only while some graphic has an error (review m1).
  const broken = Object.keys(errors).length ? framePlan(doc, t).draws.filter(d => d.kind === 'motionGraphic' && errors[d.item.id]) : [];
  const fix = async (d: Draw) => {
    const id = d.item.id;
    setBusy(b => ({ ...b, [id]: true })); setFailed(f => { const { [id]: _, ...rest } = f; return rest; });
    const deps: RepairDeps = { model, validate: code => validate(d, code), current: () => activeRuntime?.bus.doc.items.find(i => i.id === id),
      save: code => { const o = dispatch({ type: 'repairMotionGraphic', itemId: id, code }); return o.ok ? null : o.message; } };
    const r = await repairGraphic(d.item, errors[id], { width: d.box.W, height: d.box.H }, deps);
    setBusy(b => ({ ...b, [id]: false }));
    if (r.ok) notify('Motion graphic fixed');
    else { notify('Motion graphic repair failed'); setFailed(f => ({ ...f, [id]: r.message })); }
  };
  return <>{broken.map(d => <div key={d.item.id} role="group" aria-label="Motion graphic error" className="mg-error" style={PANEL}>
    <p style={{ margin: 0 }}>{String(d.item.details?.name ?? 'Motion graphic')}: {errors[d.item.id]}</p>
    <button type="button" disabled={!model || busy[d.item.id]} onClick={() => void fix(d)}>{busy[d.item.id] ? 'Fixing…' : 'Fix automatically'}</button>
    {!model && <p style={{ margin: 0 }}>{CONNECT_A_MODEL}</p>}
    {failed[d.item.id] && <p role="alert" style={{ margin: 0, color: '#ff6b6b' }}>{failed[d.item.id]}</p>}
  </div>)}</>;
}
