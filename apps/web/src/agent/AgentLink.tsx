// SPDX-License-Identifier: AGPL-3.0-only
// The "Connect tab" badge and panel of the agent link (T18a). Shown on project pages only; inline styles, because the
// stylesheet belongs to T02 (a request to wire the shell's agent badge to this link is in the T18a notes).
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { agentLink, LABELS, MOVED_TEXT, MOVED_TITLE } from './link';
import { DEFAULT_PORT } from './protocol';

const PROJECT = /^\/project\/([^/]+)$/;
const box: CSSProperties = { position: 'fixed', left: '1rem', bottom: '1rem', zIndex: 55, fontSize: '.8rem', display: 'flex', flexDirection: 'column-reverse', alignItems: 'flex-start', gap: '.4rem' };
const badge: CSSProperties = { display: 'flex', alignItems: 'center', gap: '.4rem', borderRadius: '999px', padding: '.25rem .7rem', background: 'var(--surface)', border: '1px solid var(--line)', color: 'inherit', boxShadow: '0 4px 16px #0002' };
const panel: CSSProperties = { width: 'min(340px, calc(100vw - 2rem))', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', padding: '.7rem .8rem', boxShadow: '0 12px 40px #0003', display: 'grid', gap: '.5rem' };
const row: CSSProperties = { display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'center' };
const DOT: Record<string, string> = { connected: '#2e9d5b', moved: '#d08a1e', lost: '#c62828' };

export function AgentLink({ path }: { path: string }) {
  const projectId = PROJECT.exec(path)?.[1] ?? null;
  const state = useSyncExternalStore(l => agentLink.subscribe(l), () => agentLink.state);
  const [open, setOpen] = useState(false), [code, setCode] = useState(''), [port, setPort] = useState(''), [lift, setLift] = useState(0);
  useEffect(() => { agentLink.setProject(projectId); }, [projectId]);
  // The compact layout's tab bar (T02, `.bottom-tabs`) spans the bottom edge: keep the badge above it so it never covers
  // a tab. Measured in an animation frame after DOM changes and resizes, when layout is computed for the paint anyway.
  useEffect(() => {
    if (!projectId) return;
    let frame = 0;
    const measure = () => { frame = 0; const bar = document.querySelector('.bottom-tabs'); setLift(bar ? Math.max(0, Math.round(innerHeight - bar.getBoundingClientRect().top)) : 0); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const watch = new MutationObserver(schedule);
    watch.observe(document.body, { childList: true, subtree: true }); addEventListener('resize', schedule); schedule();
    return () => { watch.disconnect(); removeEventListener('resize', schedule); cancelAnimationFrame(frame); };
  }, [projectId]);
  useEffect(() => { if (open && (state.status === 'idle' || state.status === 'lost')) void agentLink.probe(Number(port) || undefined); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!projectId) return null;
  const s = state.status, helperPort = state.port ?? state.helper?.port;
  const portNumber = () => { const n = Number(port); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined; };
  return <div style={lift ? { ...box, bottom: `calc(${lift}px + .5rem)` } : box} data-testid="agent-link">
    <button style={badge} aria-expanded={open} aria-label={`Agent link: ${LABELS[s]}`} data-status={s} data-testid="agent-link-badge" onClick={() => setOpen(!open)}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: DOT[s] ?? 'var(--muted)' }} />{LABELS[s]}
    </button>
    {open && <section style={panel} role="dialog" aria-label="Agent link" data-testid="agent-link-panel">
      {(s === 'idle' || s === 'lost') && <>
        <p style={{ margin: 0 }}>{s === 'lost' ? 'The connection to the helper was lost.' : 'Let an MCP client (Claude Code, Codex, …) edit this project through the local helper.'}</p>
        <p style={{ margin: 0, color: 'var(--muted)' }} data-testid="agent-link-helper">{state.probing ? 'Looking for the helper…' : state.helper ? `Helper ${state.helper.version} found on port ${state.helper.port}.` : state.helper === null ? 'No helper is running. Start it with npx cutframe-connect.' : ''}</p>
        <div style={row}>
          <button className="primary" data-testid="agent-link-connect" onClick={() => void agentLink.connect(portNumber())}>Connect tab</button>
          <label style={row}>Port <input data-testid="agent-link-port" inputMode="numeric" placeholder={String(DEFAULT_PORT)} value={port} onChange={e => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} style={{ width: '5.5em' }} /></label>
        </div>
      </>}
      {(s === 'connecting' || s === 'reconnecting') && <div style={row}><span>{LABELS[s]}{helperPort ? ` (port ${helperPort})` : ''}</span><button onClick={() => agentLink.cancel()}>Cancel</button></div>}
      {s === 'pairing' && <>
        <p style={{ margin: 0 }}>Enter the 6-digit pairing code the helper printed.</p>
        <form style={row} onSubmit={e => { e.preventDefault(); agentLink.pair(code); setCode(''); }}>
          <input data-testid="agent-link-code" aria-label="Pairing code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} style={{ width: '7em', letterSpacing: '.2em' }} />
          <button className="primary" type="submit" disabled={code.length !== 6}>Pair</button>
          <button type="button" onClick={() => agentLink.cancel()}>Cancel</button>
        </form>
        {state.offerCode && <p style={{ margin: 0, color: 'var(--muted)' }}>Or type <strong data-testid="agent-link-offer">{state.offerCode}</strong> in the helper’s terminal.</p>}
      </>}
      {s === 'confirm' && <>
        <p style={{ margin: 0 }}>Another tab holds the MCP connection. Take it over in this tab?</p>
        <div style={row}><button className="primary" onClick={() => agentLink.takeOver()}>Take over</button><button onClick={() => agentLink.cancel()}>Cancel</button></div>
      </>}
      {s === 'connected' && <>
        <p style={{ margin: 0 }}>Connected to the helper on port {helperPort}. MCP clients use <code>http://127.0.0.1:{helperPort}/mcp</code>.</p>
        <div style={row}><button onClick={() => agentLink.disconnect()}>Disconnect</button><button onClick={() => void agentLink.revoke()}>Unpair this tab</button></div>
      </>}
      {s === 'moved' && <>
        <p style={{ margin: 0 }}><strong>{MOVED_TITLE}</strong> — {MOVED_TEXT}</p>
        <div style={row}><button className="primary" onClick={() => agentLink.takeOver()}>Reconnect here</button></div>
      </>}
      {state.error && <p role="alert" style={{ margin: 0, color: '#c62828' }} data-testid="agent-link-error">{state.error}</p>}
    </section>}
  </div>;
}
