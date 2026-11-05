// SPDX-License-Identifier: AGPL-3.0-only
// T17 Save chevron menu (part 3 §46.1, §45.7): "Restore Checkpoint", newest first, empty state "No checkpoints saved yet".
// A row restores its checkpoint; the row's delete icon removes it at once, with no confirmation. Parity mode keeps Xapp's
// stale list: it is read when the editor opens and only this tab's Save and delete change it (automatic checkpoints and
// other tabs' Saves appear after a reload; provisional, see the T17 notes). The Cutframe default re-reads the list when the
// menu opens, follows every change while it is open and lets each checkpoint carry an optional name.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from '../editor/controls';
import { dispatch } from '../editor/commands';
import { reportError } from '../ui';
import { isRecovery, RECOVERY_LABEL } from './checkpoints';
import type { Checkpoint, Checkpoints } from './checkpoints';

export const checkpointTitle = (c: Checkpoint) => c.name ?? (isRecovery(c) ? RECOVERY_LABEL : 'Checkpoint');

export function CheckpointMenu({ checkpoints }: { checkpoints: Checkpoints }) {
  const parity = checkpoints.mode === 'parity', ref = useRef<HTMLButtonElement>(null);
  const [list, setList] = useState<Checkpoint[]>([]), [at, setAt] = useState<{ x: number; y: number }>(), [renaming, setRenaming] = useState<string>();
  const load = () => void checkpoints.list().then(setList).catch(reportError);
  useEffect(() => { load(); return checkpoints.subscribe((next, cause) => { if (!parity || cause !== 'recovery') setList(next); }); }, [checkpoints]);
  const close = useCallback(() => { setAt(undefined); setRenaming(undefined); ref.current?.focus(); }, []);
  const toggle = () => {
    if (at) { close(); return; }
    if (!parity) load();
    const b = ref.current!.getBoundingClientRect(); setAt({ x: b.left, y: b.bottom + 4 });
  };
  const rows = <>
    <div className="menu-header"><strong>Restore Checkpoint</strong>{!list.length && <small>No checkpoints saved yet</small>}</div>
    {list.map(c => {
      const title = checkpointTitle(c), time = new Date(c.timestamp).toLocaleString();
      return <div key={c.id} className="checkpoint-row">
        {renaming === c.id
          ? <input aria-label={`Name for ${title}`} defaultValue={c.name ?? ''} autoFocus onKeyDown={e => {
            if (e.key !== 'Enter') return;
            e.preventDefault(); dispatch({ type: 'renameCheckpoint', checkpointId: c.id, name: e.currentTarget.value }); setRenaming(undefined);
          }} />
          : <button role="menuitem" title={`Restore ${title}, ${time}`} onClick={() => { close(); dispatch({ type: 'restoreCheckpoint', checkpointId: c.id }); }}>
            <span>{title}</span><small>{time}</small>
          </button>}
        {!parity && renaming !== c.id && <button className="icon" aria-label={`Rename ${title}, ${time}`} onClick={() => setRenaming(c.id)}>✎</button>}
        <button className="icon" aria-label={`Delete ${title}, ${time}`} onClick={() => dispatch({ type: 'deleteCheckpoint', checkpointId: c.id })}>🗑</button>
      </div>;
    })}
  </>;
  return <><button ref={ref} aria-label="Checkpoints" aria-haspopup="menu" aria-expanded={!!at} onClick={toggle}>▾</button>
    {at && <Menu label="Checkpoints" x={at.x} y={at.y} items={[]} header={rows} anchor={ref.current} close={close} />}</>;
}
