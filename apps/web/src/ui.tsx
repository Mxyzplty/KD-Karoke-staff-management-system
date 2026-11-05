// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { storageError, StoreError } from './store/model';
type Notice = { id: number; text: string };
const useNotices = create<{ notices: Notice[]; add: (text: string) => void; dismiss: (id: number) => void }>(set => ({
  notices: [], add: text => set(s => ({ notices: [...s.notices.slice(-4), { id: Date.now() + Math.random(), text }] })),
  dismiss: id => set(s => ({ notices: s.notices.filter(n => n.id !== id) })),
}));
export const notify = (text: string) => useNotices.getState().add(text);
export function reportError(error: unknown) { const e = storageError(error); notify(`${e instanceof StoreError ? `${e.code}: ` : ''}${e.message}`); }
export const unavailable = (feature: string, owner: string) => notify(`${feature} is not yet implemented (${owner}).`);
export function Notifications() {
  const { notices, dismiss } = useNotices(), ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  return <aside ref={ref} tabIndex={-1} role="region" aria-label="Notifications" aria-live="polite" aria-relevant="additions text" aria-keyshortcuts="Alt+N" className="notifications">
    {notices.map(n => <div key={n.id}>{n.text}<button aria-label={`Dismiss ${n.text}`} onClick={() => dismiss(n.id)}>×</button></div>)}
  </aside>;
}
export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="dialog-heading"><h2>{title}</h2><button aria-label={`Close ${title}`} onClick={close}>×</button></div>{children}
  </dialog>;
}
export function InlineName({ initial, label, commit, cancel }: { initial: string; label: string; commit: (name: string) => void; cancel: () => void }) {
  return <input autoFocus defaultValue={initial} aria-label={label} onFocus={e => e.target.select()} onClick={e => e.stopPropagation()} onBlur={cancel}
    onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } if (e.key === 'Enter') { e.preventDefault(); const name = e.currentTarget.value.trim(); if (name && name !== initial) commit(name); else cancel(); } }} />;
}
