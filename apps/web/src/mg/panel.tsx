// SPDX-License-Identifier: AGPL-3.0-only
// The Motion Graphics rail panel (findings part 3 §46.3): info icon, My Presets (n), Add Blank with start / end fields (0 to
// 5 s, step 0.1, min 0) and Add Blank Motion Graphic (a whole-canvas graphic on a new overlay track, one "Add items" step,
// toast "Motion graphic added"). No code or prompt field: generation is agent-only (§44.9). A preset click places it at 0 s
// (findings part 2 §31); Xapp's optional "customise" dialog sends text to the AI chat, which is T20's (not shown here).
import { useEffect, useState } from 'react';
import { dispatch } from '../editor/commands';
import { projectStore } from '../store/database';
import { notify } from '../ui';
import { userGraphicPresets } from './presets';
import type { GraphicPreset } from './presets';

const INFO = 'Motion graphics are written by the AI agent. Add a blank one here, or one of your presets.';
const seconds = (s: string) => s.trim() === '' ? NaN : Number(s);

export function MotionGraphicsPanel() {
  const [start, setStart] = useState('0'), [end, setEnd] = useState('5'), [presets, setPresets] = useState<GraphicPreset[]>([]);
  useEffect(() => { let live = true; void userGraphicPresets(projectStore).then(r => { if (live) setPresets(r.presets); }, () => {}); return () => { live = false; }; }, []);
  const from = seconds(start), to = seconds(end), valid = from >= 0 && to > from;
  const add = () => { if (dispatch({ type: 'addBlankMotionGraphic', startMs: Math.round(from * 1000), endMs: Math.round(to * 1000) }).ok) notify('Motion graphic added'); };
  const apply = (p: GraphicPreset) => { if (dispatch({ type: 'addGraphicPreset', preset: p }).ok) notify(`Applied "${p.name}" — 1 item(s)`); };
  return <section aria-label="Motion graphics" className="tool-panel">
    <h3>Motion graphics <span role="img" aria-label="About motion graphics" title={INFO}>ⓘ</span></h3>
    <h4 id="mg-presets">My Presets ({presets.length})</h4>
    {presets.length ? <ul aria-labelledby="mg-presets">{presets.map(p => <li key={p.id}><button type="button" onClick={() => apply(p)}>{p.name}</button></li>)}</ul> : <p>No presets yet.</p>}
    <fieldset aria-label="Add Blank"><legend>Add Blank</legend>
      <label>Start (s) <input type="number" aria-label="Start" min={0} step={0.1} value={start} onChange={e => setStart(e.target.value)} /></label>
      <label>End (s) <input type="number" aria-label="End" min={0} step={0.1} value={end} onChange={e => setEnd(e.target.value)} /></label>
    </fieldset>
    <button type="button" disabled={!valid} onClick={add}>Add Blank Motion Graphic</button>
  </section>;
}
