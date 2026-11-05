// SPDX-License-Identifier: AGPL-3.0-only
// Test support (imported only by browser tests, never by the app): mounts a shared control as a controlled component whose
// owner stores every committed value, so tests can drive the real component and read back what it reported.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ColourPicker, MenuButton, Slider, SliderCard } from './controls';
import type { SliderSpec } from './controls';
import type { Range } from './slider';

export type Mounted = { commits: unknown[]; changes: unknown[]; value: () => unknown; setValue: (value: unknown) => void; unmount: () => void };
type Options =
  | { kind: 'slider'; label: string; range: Range; initial: number }
  | { kind: 'card'; title: string; rows: SliderSpec[]; defaults: Record<string, number>; initial?: Record<string, number> }
  | { kind: 'colour'; label: string; initial: string; gradient?: boolean }
  | { kind: 'menu'; disabled?: boolean; nested?: boolean };
export function mountControl(container: HTMLElement, options: Options): Mounted {
  const commits: unknown[] = [], changes: unknown[] = []; let current: unknown, update: (value: unknown) => void = () => {};
  function MenuOwner() {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { if (options.kind === 'menu' && options.nested) dialog.current?.showModal(); }, []);
    const menu = <MenuButton label="Harness menu" items={options.kind === 'menu' && options.disabled ? [{ label: 'Disabled action', disabled: true, onSelect: () => commits.push('disabled') }] : []}>Harness menu</MenuButton>;
    return options.kind === 'menu' && options.nested ? <dialog ref={dialog} aria-label="Harness dialog"><button onClick={() => dialog.current?.close()}>Close dialog</button>{menu}</dialog> : menu;
  }
  function Owner() {
    const [value, setValue] = useState<unknown>(options.kind === 'card' ? { ...options.defaults, ...options.initial } : options.kind === 'menu' ? null : options.initial);
    current = value; update = setValue;
    const commit = (v: unknown) => { commits.push(v); setValue((prev: unknown) => options.kind === 'card' ? { ...(prev as object), ...(v as object) } : v); };
    if (options.kind === 'slider') return <Slider label={options.label} range={options.range} value={value as number} onChange={v => changes.push(v)} onCommit={commit} />;
    if (options.kind === 'card') return <SliderCard title={options.title} rows={options.rows} defaults={options.defaults} values={value as Record<string, number>} onCommit={commit} />;
    if (options.kind === 'menu') return <MenuOwner />;
    return <ColourPicker label={options.label} gradient={options.gradient} value={value as string} onChange={commit} />;
  }
  const root = createRoot(container); root.render(<Owner />);
  return { commits, changes, value: () => current, setValue: value => update(value), unmount: () => root.unmount() };
}
