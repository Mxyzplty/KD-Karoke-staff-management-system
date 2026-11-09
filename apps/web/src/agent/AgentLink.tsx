// SPDX-License-Identifier: AGPL-3.0-only
// The agent link's connect and pairing panel (T18a), shown in the editor's agent badge popover and the Settings External
// Agent card, and the route binding: the link follows the open project. Inline styles, as T18a wrote them.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { agentLink, LABELS, MOVED_TEXT, MOVED_TITLE } from './link';
import { DEFAULT_PORT } from './protocol';

const PROJECT = /^\/project\/([^/]+)$/;
const panel: CSSProperties = { display: 'grid', gap: '.5rem', fontSize: '.8rem' };
const row: CSSProperties = { display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'center' };

export const useLink = () => useSyncExternalStore(l => agentLink.subscribe(l), () => agentLink.state);
/** W3-ED-25: the time since this tab connected. */
export function connectedAge(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}
export function AgentLink({ path }: { path: string }) {
  const projectId = PROJECT.exec(path)?.[1] ?? null;
  useEffect(() => { agentLink.setProject(projectId); }, [projectId]);
  return null;
}
export function AgentPanel() {
  const state = useLink(), [code, setCode] = useState(''), [port, setPort] = useState('');
  // Contract A: discovery runs when the user opens this panel, never in the background.
  useEffect(() => { if ((state.status === 'idle' || state.status === 'lost') && !agentLink.state.probing) void agentLink.probe(Number(port) || undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = state.status, helperPort = state.port ?? state.helper?.port;
  useEffect(() => { agentLink.refreshClients(); }, [s]);
  const portNumber = () => { const n = Number(port); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined; };
  return <section style={panel} aria-label="Agent link" data-testid="agent-link-panel">
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
      {state.clients.length > 0 && <ul aria-label="Connected clients" style={{ margin: 0, paddingLeft: '1rem' }}>{state.clients.map((c, i) => <li key={i}>{c.name} {c.version}</li>)}</ul>}
      {state.recent.length > 0 && <p style={{ margin: 0, color: 'var(--muted)' }} aria-label="Recent tool calls">Recent: {state.recent.join(', ')}</p>}
      <div style={row}><button onClick={() => agentLink.disconnect()}>Disconnect</button><button onClick={() => void agentLink.revoke()}>Unpair this tab</button></div>
    </>}
    {s === 'moved' && <>
      <p style={{ margin: 0 }}><strong>{MOVED_TITLE}</strong> — {MOVED_TEXT}</p>
      <div style={row}><button className="primary" onClick={() => agentLink.takeOver()}>Reconnect here</button></div>
    </>}
    {state.error && <p role="alert" style={{ margin: 0, color: '#c62828' }} data-testid="agent-link-error">{state.error}</p>}
  </section>;
}
