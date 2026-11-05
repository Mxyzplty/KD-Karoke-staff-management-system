// SPDX-License-Identifier: AGPL-3.0-only
// Shared editor controls: relative-drag slider row and slider card (part 3 §46.6, W3-ED-24), colour picker (§46.4, §46.7),
// context menu and popovers. Controlled: they report values; the owner of the property decides what is stored.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FINE_FACTOR, format as formatStep, FULL_RANGE_PX, quantise, typedValue } from './slider';
import type { Range } from './slider';
import { DEFAULT_GRADIENT, formatColour, gradientCss, hsvToRgb, parseColour, parseGradient, RADIAL_POSITIONS, rgbToHsv } from './colour';
import type { Gradient, Hsva } from './colour';

/** One slider row. A plain click changes nothing; a drag is relative (Shift = fine); double-click types a number.
 *  perStep (read at pointer-down): the drag commits every value change instead of once on release (parity mode).
 *  disabled: greyed out; no drag, key or typed edit (T04: Speed while Time Remap is on).
 *  digits: shown decimals when they differ from the step's (T10 Color card: Black Point 0.00 on a 0.005 step). */
export function Slider({ label, value, range, unit = '', onChange, onCommit, perStep, disabled = false, digits }: { label: string; value: number; range: Range; unit?: string; onChange?: (v: number) => void; onCommit: (v: number) => void; perStep?: () => boolean; disabled?: boolean; digits?: number }) {
  const [live, setLive] = useState<number | null>(null), [typing, setTyping] = useState(false);
  const drag = useRef<{ start: number; acc: number; x: number; moved: boolean; step: boolean; last: number } | null>(null);
  const shown = live ?? value, percent = ((shown - range.min) / (range.max - range.min)) * 100;
  const format = (n: number, step: number) => digits === undefined ? formatStep(n, step) : n.toFixed(digits);
  const rate = (range.max - range.min) / FULL_RANGE_PX;
  const commitKey = (v: number) => { const next = quantise(v, range); if (next !== value) onCommit(next); };
  if (disabled) return <div className="slider-row disabled" data-slider={label}>
    <span className="slider-label">{label}</span>
    <div className="slider-track" role="slider" aria-disabled="true" aria-label={label} aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={value} aria-valuetext={`${format(value, range.step)}${unit}`}><span className="slider-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div>
    <span className="slider-value">{format(value, range.step)}{unit}</span>
  </div>;
  return <div className="slider-row" data-slider={label}>
    <span className="slider-label">{label}</span>
    <div className="slider-track" role="slider" tabIndex={0} aria-label={label} aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={shown} aria-valuetext={`${format(shown, range.step)}${unit}`}
      onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { start: value, acc: value, x: e.clientX, moved: false, step: !!perStep?.(), last: value }; }}
      onPointerMove={e => {
        const d = drag.current; if (!d || e.clientX === d.x) return;
        d.acc = Math.min(range.max, Math.max(range.min, d.acc + (e.clientX - d.x) * rate * (e.shiftKey ? FINE_FACTOR : 1))); d.x = e.clientX; d.moved = true;
        const v = quantise(d.acc, range); setLive(v); onChange?.(v);
        if (d.step && v !== d.last) { d.last = v; onCommit(v); }
      }}
      onPointerUp={() => { const d = drag.current; drag.current = null; if (d?.moved) { const v = quantise(d.acc, range); setLive(null); if (!d.step && v !== d.start) onCommit(v); } }}
      onPointerCancel={() => { drag.current = null; setLive(null); }}
      onDoubleClick={() => setTyping(true)}
      onKeyDown={e => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (step) { e.preventDefault(); commitKey(value + step * range.step); } else if (e.key === 'Enter') { e.preventDefault(); setTyping(true); }
      }}>
      <span className="slider-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
    {typing ? <input className="slider-input" autoFocus aria-label={`${label} value`} defaultValue={format(value, range.step)} onFocus={e => e.target.select()}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setTyping(false); }
        if (e.key === 'Enter') { e.preventDefault(); const v = typedValue(e.currentTarget.value, range); setTyping(false); if (v !== null && v !== value) onCommit(v); }
      }} onBlur={() => setTyping(false)} />
      : <span className="slider-value" onDoubleClick={() => setTyping(true)}>{format(shown, range.step)}{unit}</span>}
  </div>;
}
export type SliderSpec = { key: string; label: string; range: Range; unit?: string };
/** A card of slider rows with one card-level reset arrow, shown once any row differs from its default; it resets every row. */
export function SliderCard({ title, rows, values, defaults, onCommit }: { title: string; rows: SliderSpec[]; values: Record<string, number>; defaults: Record<string, number>; onCommit: (change: Record<string, number>) => void }) {
  const changed = rows.some(r => (values[r.key] ?? defaults[r.key]) !== defaults[r.key]);
  return <section className="slider-card" aria-label={title}>
    <div className="card-heading"><h4>{title}</h4>{changed && <button className="reset" aria-label={`Reset ${title}`} title={`Reset ${title}`} onClick={() => onCommit(Object.fromEntries(rows.map(r => [r.key, defaults[r.key]])))}>↺</button>}</div>
    {rows.map(r => <Slider key={r.key} label={r.label} value={values[r.key] ?? defaults[r.key]} range={r.range} unit={r.unit} onCommit={v => onCommit({ [r.key]: v })} />)}
  </section>;
}

/** 2-D or 1-D pointer area reporting 0…1 positions; drags commit on release. */
function Pad({ label, x, y, onMove, onRelease, className, children }: { label: string; x: number; y?: number; onMove: (x: number, y: number) => void; onRelease: () => void; className: string; children?: ReactNode }) {
  const at = (e: React.PointerEvent<HTMLDivElement>) => { const b = e.currentTarget.getBoundingClientRect(); onMove(Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))); };
  return <div className={className} role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(x * 100)} aria-valuetext={y === undefined ? `${Math.round(x * 100)}%` : `${Math.round(x * 100)}%, ${Math.round((1 - y) * 100)}%`}
    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); at(e); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e); }} onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) onRelease(); }}
    onKeyDown={e => {
      const d = e.shiftKey ? 0.1 : 0.01, dx = e.key === 'ArrowRight' ? d : e.key === 'ArrowLeft' ? -d : 0, dy = e.key === 'ArrowDown' ? d : e.key === 'ArrowUp' ? -d : 0;
      if (dx || (dy && y !== undefined)) { e.preventDefault(); onMove(Math.min(1, Math.max(0, x + dx)), Math.min(1, Math.max(0, (y ?? 0) + dy))); onRelease(); }
    }}>{children}<span className="pad-thumb" style={{ left: `${x * 100}%`, top: y === undefined ? '50%' : `${y * 100}%` }} /></div>;
}
type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };
/** Solid picker body: SV square, hue, alpha, format, hex, opacity %, eyedropper. */
function SolidPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = parseColour(value) ?? { r: 0, g: 0, b: 0, a: 1 };
  const [hsva, setHsva] = useState<Hsva>(() => rgbToHsv(parsed)), latest = useRef(hsva);
  useEffect(() => { const next = parseColour(value); if (next && formatColour(hsvToRgb(latest.current)) !== formatColour(next)) { const h = rgbToHsv(next); latest.current = { ...h, h: next.r === next.g && next.g === next.b ? latest.current.h : h.h }; setHsva(latest.current); } }, [value]);
  const set = (patch: Partial<Hsva>) => { latest.current = { ...latest.current, ...patch }; setHsva(latest.current); };
  const emit = () => onChange(formatColour(hsvToRgb(latest.current)));
  const hex = formatColour(hsvToRgb({ ...hsva, a: 1 })), Dropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
  return <div className="solid-picker">
    <Pad label="Saturation and brightness" className="sv-square" x={hsva.s} y={1 - hsva.v} onMove={(x, y) => set({ s: x, v: 1 - y })} onRelease={emit}><span className="sv-hue" style={{ background: `hsl(${hsva.h}, 100%, 50%)` }} /></Pad>
    <Pad label="Hue" className="hue-bar" x={hsva.h / 360} onMove={x => set({ h: Math.min(359.999, x * 360) })} onRelease={emit} />
    <Pad label="Alpha" className="alpha-bar" x={hsva.a} onMove={x => set({ a: x })} onRelease={emit}><span style={{ background: `linear-gradient(90deg, transparent, ${hex})` }} /></Pad>
    <div className="picker-fields">
      <label>Format<select aria-label="Colour format" value="hex" onChange={() => {}}><option value="hex">Hex</option></select></label>
      <input aria-label="Hex" key={hex} defaultValue={hex.toUpperCase()} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={e => {
        const c = parseColour(e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`);
        if (c && c.a === 1) { const h = rgbToHsv(c); set({ h: h.s ? h.h : latest.current.h, s: h.s, v: h.v }); emit(); } else e.target.value = hex.toUpperCase();
      }} />
      <label>Opacity<input aria-label="Opacity" type="number" min={0} max={100} key={`a${Math.round(hsva.a * 100)}`} defaultValue={Math.round(hsva.a * 100)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        onBlur={e => { const n = Number(e.target.value); if (e.target.value.trim() !== '' && Number.isFinite(n)) { set({ a: Math.min(100, Math.max(0, n)) / 100 }); emit(); } else e.target.value = String(Math.round(latest.current.a * 100)); }} />%</label>
      <button aria-label="Eyedropper" disabled={!Dropper} title={Dropper ? 'Pick a colour from the screen' : 'This browser has no eyedropper'} onClick={() => { if (Dropper) void new Dropper().open().then(r => { const c = parseColour(r.sRGBHex); if (c) { const h = rgbToHsv(c); set({ h: h.h, s: h.s, v: h.v }); emit(); } }).catch(() => {}); }}>◉</button>
    </div>
  </div>;
}
/** Shared colour picker: a swatch that opens Solid (and, where gradients are allowed, Gradient) tabs. */
export function ColourPicker({ label, value, onChange, gradient = false }: { label: string; value: string; onChange: (v: string) => void; gradient?: boolean }) {
  const [open, setOpen] = useState(false), current = parseGradient(value), [tab, setTab] = useState<'solid' | 'gradient'>(current ? 'gradient' : 'solid');
  const [g, setG] = useState<Gradient>(current ?? DEFAULT_GRADIENT), [stop, setStop] = useState(0), [epoch, setEpoch] = useState(0), bar = useRef<HTMLDivElement>(null);
  // Reconcile policy (review R1): the controlled value is authoritative. A value this picker did not just emit (another
  // item's value, an external change) resets the tab, gradient and selected stop in the same render. Remounting the solid
  // picker cancels any captured pad gesture, so its stale draft cannot commit on release. The picker's own echo keeps it.
  // The pending echo is used once (review R11): the next changed value consumes it, whether it is the echo or not, so an
  // older emission never exempts a later external value that happens to equal it.
  const [seen, setSeen] = useState(value), [echo, setEcho] = useState<string | null>(null);
  if (value !== seen) {
    setSeen(value); setEcho(null);
    if (value !== echo) { setTab(current ? 'gradient' : 'solid'); setG(current ?? DEFAULT_GRADIENT); setStop(0); setEpoch(n => n + 1); }
  }
  const emit = (v: string) => { setEcho(v); onChange(v); };
  const emitGradient = (next: Gradient) => { setG(next); emit(gradientCss(next)); };
  return <div className="colour-field">
    <button className="swatch" aria-label={`${label}: ${value}`} aria-expanded={open} onClick={() => setOpen(!open)}><span style={{ background: value }} /></button>
    {open && <Popover label={`${label} colour`} close={() => setOpen(false)}>
      {gradient && <div role="tablist" aria-label="Colour kind"><button role="tab" aria-selected={tab === 'solid'} onClick={() => setTab('solid')}>Solid</button><button role="tab" aria-selected={tab === 'gradient'} onClick={() => { setTab('gradient'); emitGradient(g); }}>Gradient</button></div>}
      {tab === 'solid' || !gradient ? <SolidPicker key={`solid:${epoch}`} value={current ? '#000000' : value} onChange={emit} /> : <>
        <SolidPicker key={`${epoch}:${stop}`} value={g.stops[stop]?.colour ?? '#000000'} onChange={c => emitGradient({ ...g, stops: g.stops.map((s, i) => i === stop ? { ...s, colour: c } : s) })} />
        <div className="gradient-preview" aria-label="Gradient preview" style={{ background: gradientCss(g) }} />
        <div role="group" aria-label="Gradient type"><button aria-pressed={g.kind === 'linear'} onClick={() => emitGradient({ ...g, kind: 'linear' })}>Linear</button><button aria-pressed={g.kind === 'radial'} onClick={() => emitGradient({ ...g, kind: 'radial' })}>Radial</button></div>
        {g.kind === 'linear' ? <label>Angle<input aria-label="Angle" type="number" min={0} max={360} key={`${epoch}:${g.angle}`} defaultValue={g.angle} onBlur={e => { const n = Number(e.target.value); if (Number.isFinite(n)) emitGradient({ ...g, angle: ((n % 360) + 360) % 360 }); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />°</label>
          : <div className="position-grid" role="group" aria-label="Gradient position">{RADIAL_POSITIONS.map(p => <button key={p} aria-label={`Position ${p}`} aria-pressed={g.position === p} onClick={() => emitGradient({ ...g, position: p })} />)}</div>}
        <div ref={bar} className="stop-bar" aria-label="Gradient stops" style={{ background: gradientCss({ ...g, kind: 'linear', angle: 90 }) }} onClick={e => {
          if (e.target !== e.currentTarget) return;
          const b = e.currentTarget.getBoundingClientRect(), at = Math.round(((e.clientX - b.left) / b.width) * 100);
          const stops = [...g.stops, { colour: g.stops[stop]?.colour ?? '#000000', at }]; setStop(stops.length - 1); emitGradient({ ...g, stops });
        }}>{g.stops.map((s, i) => <button key={i} className="stop" aria-label={`Stop ${i + 1} at ${s.at}%`} aria-pressed={i === stop} style={{ left: `${s.at}%`, background: s.colour }} onClick={() => setStop(i)} />)}</div>
      </>}
    </Popover>}
  </div>;
}

export type MenuItem = { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; checked?: boolean };
/** A menu at a screen position (context menus) or under an anchor; Escape, an outside press or a choice closes it.
 *  Focus goes to the first enabled item, or to the menu itself when none is enabled (review R5). Escape is handled for the
 *  whole window while the menu is open, unless a modal dialog that does not contain the menu owns the key. A press on the
 *  `anchor` (the trigger) is not "outside": the trigger itself toggles the menu closed. */
export function Menu({ label, x, y, items, close, header, anchor }: { label: string; x: number; y: number; items: MenuItem[]; close: () => void; header?: ReactNode; anchor?: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null), [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    setPos({ x: Math.max(4, Math.min(x, innerWidth - el.offsetWidth - 4)), y: Math.max(4, Math.min(y, innerHeight - el.offsetHeight - 4)) });
    (el.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? el).focus();
  }, [x, y]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !anchor?.contains(t)) close(); };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const modal = (e.target as Element | null)?.closest?.('dialog');
      if (modal && !modal.contains(ref.current)) return;
      e.preventDefault(); e.stopPropagation(); close();
    };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); };
  }, [close, anchor]);
  return <div ref={ref} role="menu" tabIndex={-1} aria-label={label} className="context-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={e => e.preventDefault()}
    onKeyDown={e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault(); const list = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? []), i = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    }}>
    {header}
    {items.map(item => <button key={item.label} role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked} className={item.danger ? 'danger' : undefined} disabled={item.disabled} onClick={() => { close(); item.onSelect(); }}>{item.label}</button>)}
  </div>;
}
/** A button that opens a Menu under itself. */
export function MenuButton({ label, children, items, header, className, disabled }: { label: string; children: ReactNode; items: MenuItem[]; header?: ReactNode; className?: string; disabled?: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number }>(), ref = useRef<HTMLButtonElement>(null);
  return <><button ref={ref} className={className} aria-label={label} aria-haspopup="menu" aria-expanded={!!at} disabled={disabled} onClick={() => { const b = ref.current!.getBoundingClientRect(); setAt(at ? undefined : { x: b.left, y: b.bottom + 4 }); }}>{children}</button>
    {at && <Menu label={label} x={at.x} y={at.y} items={items} header={header} anchor={ref.current} close={() => { setAt(undefined); ref.current?.focus(); }} />}</>;
}
/** A non-modal popover panel (cloud backup, agent badge, colour picker); Escape or an outside press closes it. */
export function Popover({ label, close, children, className = '' }: { label: string; close: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A modal dialog opened from inside the popover owns its Escape; otherwise the popover closes first.
      const target = e.target as Element | null, modal = target?.closest?.('dialog');
      if (modal && !modal.contains(ref.current)) return;
      e.preventDefault(); e.stopPropagation(); close();
    };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); };
  }, [close]);
  return <div ref={ref} role="dialog" aria-label={label} className={`popover ${className}`}>{children}</div>;
}
