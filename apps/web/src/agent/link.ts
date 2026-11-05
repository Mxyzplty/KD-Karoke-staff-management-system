// SPDX-License-Identifier: AGPL-3.0-only
// The editor tab's link to the local helper (master plan §1a Contract A; connect / takeover / reconnect as Xapp, findings
// §10b.2). Nothing goes out until the user presses Connect tab or opens the panel, or a link stored by an earlier connect
// exists: then opening a project, focusing the tab or showing it dials the stored port's /tab only (no port scan).
import { Executor } from './executor';
import { APP, CLOSE, DEFAULT_PORT, LINK_ERRORS, PING_MS, PORT_RANGE, PROTOCOL, RECONNECT_DELAYS, RECONNECT_MAX, RECONNECT_STABLE_MS, STALL_MS } from './protocol';
import type { HelperMessage, TabMessage } from './protocol';

export type Status = 'idle' | 'connecting' | 'pairing' | 'confirm' | 'connected' | 'reconnecting' | 'moved' | 'lost';
/** Badge text by state (findings §10b.2); pairing and the takeover question are still "Connecting…". */
export const LABELS: Record<Status, string> = { idle: 'Connect tab', connecting: 'Connecting…', pairing: 'Connecting…', confirm: 'Connecting…', connected: 'Connected',
  reconnecting: 'Reconnecting…', moved: 'Moved', lost: 'Connection lost' };
export const MOVED_TITLE = 'Moved to another tab';
export const MOVED_TEXT = 'Another tab took over the MCP connection. Reconnect here to take it back.';
export const NO_HELPER = `No helper answered on 127.0.0.1:${DEFAULT_PORT}–${DEFAULT_PORT + PORT_RANGE - 1}. Run npx cutframe-connect in a terminal, then press Connect tab.`;
export const LINK_KEY = 'cutframe:agent-link:v1';
export const TAB_KEY = 'cutframe:agent-tab:v1';
export const TOKEN_DB = 'cutframe-agent';
const STORE = 'kv', TOKEN = 'token';

export type HelperInfo = { port: number; version: string; pairing: boolean };
export type LinkState = { status: Status; port?: number; error?: string; helper?: HelperInfo | null; probing: boolean; offerCode?: string; projectId: string | null };
type Stored = { port: number; auto: boolean };

const read = <T>(storage: () => Storage, key: string): T | undefined => { try { const v = storage().getItem(key); return v ? JSON.parse(v) as T : undefined; } catch { return undefined; } };
const write = (storage: () => Storage, key: string, value: unknown) => { try { if (value === undefined) storage().removeItem(key); else storage().setItem(key, JSON.stringify(value)); } catch { /* blocked */ } };
const local = () => localStorage, session = () => sessionStorage;

/** The pairing token lives in IndexedDB (Contract A); a blocked database just means pairing again. */
function tokenDb<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return new Promise(resolve => {
    let open: IDBOpenDBRequest;
    try { open = indexedDB.open(TOKEN_DB, 1); } catch { return resolve(undefined); }
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(STORE, mode), req = op(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T); req.onerror = () => resolve(undefined);
        tx.oncomplete = tx.onabort = () => db.close();
      } catch { db.close(); resolve(undefined); }
    };
  });
}
export const loadToken = () => tokenDb<string>('readonly', s => s.get(TOKEN));
const saveToken = (token: string) => tokenDb('readwrite', s => s.put(token, TOKEN));
const dropToken = () => tokenDb('readwrite', s => s.delete(TOKEN));

/** Inaudible audio (a constant source through gain 0) while connected, so a background tab is not throttled (§10b.2). */
class KeepAlive {
  private ctx?: AudioContext;
  start() {
    if (this.ctx) return;
    try {
      const ctx = new AudioContext(), source = ctx.createConstantSource(), gain = ctx.createGain();
      gain.gain.value = 0; source.connect(gain).connect(ctx.destination); source.start();
      this.ctx = ctx; void ctx.resume().catch(() => {});
    } catch { /* no audio: throttling stays possible */ }
  }
  stop() { void this.ctx?.close().catch(() => {}); this.ctx = undefined; }
}

export class AgentLink {
  state: LinkState = { status: 'idle', probing: false, projectId: null };
  readonly executor: Executor;
  private listeners = new Set<() => void>();
  private ws?: WebSocket;
  private port?: number;
  private takeover = false;
  private manual = false;
  private attempts = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private stable?: ReturnType<typeof setTimeout>;
  private pinger?: ReturnType<typeof setInterval>;
  private lastSeen = 0;
  private keepAlive = new KeepAlive();
  private bound = false;
  constructor() { this.executor = new Executor({ onState: parts => this.send({ type: 'event', name: 'stateChanged', data: { parts } }) }); }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private set(patch: Partial<LinkState>) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }
  private tab(): { tabId: string; connId?: string } {
    const t = read<{ tabId: string; connId?: string }>(session, TAB_KEY);
    if (t?.tabId) return t;
    const fresh = { tabId: crypto.randomUUID() };
    write(session, TAB_KEY, fresh);
    return fresh;
  }
  stored = () => read<Stored>(local, LINK_KEY);

  /** The editor route changed. Opening a project with a stored link connects with takeover (§10b.2). */
  setProject(projectId: string | null) {
    if (projectId === this.state.projectId) return;
    this.set({ projectId });
    this.bind();
    if (this.state.status === 'connected') return void this.hello(false);
    const s = this.stored();
    if (projectId && s?.auto && !this.busy()) this.dial(s.port, true, false);
  }
  /** Focus / visibility: a tab that is not connected takes the link back when a stored link exists (the last focused wins). */
  private bind() {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;
    const wake = () => {
      const s = this.stored();
      if (document.visibilityState !== 'visible' || !this.state.projectId || !s?.auto || this.busy() || this.state.status === 'connected') return;
      this.dial(s.port, true, false);
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
  }
  private busy() { return ['connecting', 'pairing', 'confirm', 'reconnecting'].includes(this.state.status) && (!!this.ws || !!this.retry); }

  /** GET /hello on the given port, else the stored one and the range (panel open, Connect). */
  async probe(first?: number): Promise<HelperInfo | null> {
    const ports = [...new Set([first, this.stored()?.port, ...Array.from({ length: PORT_RANGE }, (_, i) => DEFAULT_PORT + i)].filter((p): p is number => Number.isInteger(p) && p! > 0 && p! <= 65535))];
    this.set({ probing: true });
    const answers = await Promise.all(ports.map(async port => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/hello`, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
        const body = r.ok ? await r.json() as { app?: string; version?: string; pairing?: boolean } : undefined;
        return body?.app === APP ? { port, version: String(body.version ?? ''), pairing: !!body.pairing } : null;
      } catch { return null; }
    }));
    const helper = answers.find(Boolean) ?? null;
    this.set({ probing: false, helper });
    return helper;
  }
  /** The Connect tab button: find the helper, then connect without takeover (another tab's link → the Take over prompt). */
  async connect(port?: number) {
    this.stopRetry();
    this.set({ status: 'connecting', error: undefined });
    const helper = await this.probe(port);
    if (!helper) return this.set({ status: 'idle', error: NO_HELPER });
    this.attempts = 0;
    this.dial(helper.port, false, true);
  }
  /** Take over (the prompt) or Reconnect here (Moved). */
  takeOver() {
    this.stopRetry();
    if (this.ws?.readyState === WebSocket.OPEN) { this.takeover = true; this.set({ status: 'connecting', error: undefined }); return void this.hello(true); }
    const port = this.port ?? this.stored()?.port;
    if (port) { this.attempts = 0; this.dial(port, true, true); }
  }
  pair(code: string) { this.set({ error: undefined }); this.send({ type: 'pair', code: code.trim() }); }
  /** Cancel a connect, the pairing or the takeover question. */
  cancel() { this.stopRetry(); this.close(); this.set({ status: 'idle', offerCode: undefined, error: undefined }); }
  /** Disconnect: the saved link is cleared, so nothing reconnects on its own; the pairing stays. */
  disconnect() { write(local, LINK_KEY, undefined); this.cancel(); this.executor.watcher.stop(); }
  /** Unpair this tab: the helper forgets its token and closes the link. */
  async revoke() {
    this.send({ type: 'revoke' });
    write(local, LINK_KEY, undefined); await dropToken();
    this.cancel(); this.executor.watcher.stop();
  }

  private stopRetry() { clearTimeout(this.retry); this.retry = undefined; }
  private close(code = 1000) {
    const ws = this.ws; this.ws = undefined;
    clearInterval(this.pinger); clearTimeout(this.stable); this.keepAlive.stop();
    if (ws && ws.readyState <= WebSocket.OPEN) try { ws.close(code); } catch { /* already closing */ }
  }
  private send(m: TabMessage) { if (this.ws?.readyState === WebSocket.OPEN && (m.type !== 'event' || this.state.status === 'connected')) this.ws.send(JSON.stringify(m)); }
  private async hello(takeover: boolean) {
    const t = this.tab(), token = await loadToken();
    this.takeover = takeover;
    this.send({ type: 'hello', protocol: PROTOCOL, projectId: this.state.projectId, tabId: t.tabId, ...(token ? { token } : {}), ...(t.connId ? { connId: t.connId } : {}), takeover });
  }
  private dial(port: number, takeover: boolean, manual: boolean) {
    this.stopRetry(); this.close();
    this.port = port; this.manual = manual; this.takeover = takeover;
    this.executor.watcher.start();
    if (this.state.status !== 'reconnecting') this.set({ status: 'connecting', port, error: undefined });
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://127.0.0.1:${port}/tab`); } catch { return this.schedule(); }
    this.ws = ws;
    ws.onopen = () => { this.lastSeen = Date.now(); void this.hello(takeover); this.startPing(); };
    ws.onmessage = e => { if (this.ws === ws) { this.lastSeen = Date.now(); this.onMessage(e.data); } };
    ws.onclose = e => { if (this.ws === ws) this.onClose(e.code); };
  }
  private startPing() {
    clearInterval(this.pinger);
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastSeen > STALL_MS) { if (this.ws) { this.close(4000); this.schedule(); } return; }
      this.send({ type: 'ping' });
    }, PING_MS);
  }
  /** Xapp's schedule: 250 ms, 1 s, 2 s, 4 s, then 8 s; "Reconnecting…" from the 2nd attempt; 10 attempts, then lost. */
  private schedule() {
    if (this.attempts >= RECONNECT_MAX || !this.port) return this.set({ status: 'lost' });
    const delay = RECONNECT_DELAYS[Math.min(this.attempts, RECONNECT_DELAYS.length - 1)];
    this.attempts++;
    this.set({ status: this.attempts >= 2 ? 'reconnecting' : 'connecting' });
    const port = this.port;
    this.retry = setTimeout(() => { this.retry = undefined; this.dial(port, false, false); }, delay);
  }
  private onClose(code: number) {
    this.close();
    if (code === CLOSE.superseded || code === CLOSE.replaced) return this.set({ status: 'moved', offerCode: undefined });
    if (code === CLOSE.unauthorized) {
      write(local, LINK_KEY, undefined); void dropToken();
      return this.set({ status: 'idle', offerCode: undefined, error: this.state.error ?? LINK_ERRORS.TOKEN_REVOKED });
    }
    if (code === CLOSE.protocol) return this.set({ status: 'idle', error: this.state.error ?? LINK_ERRORS.PROTOCOL_UNSUPPORTED });
    this.schedule();
  }
  private onMessage(raw: unknown) {
    let m: HelperMessage;
    try { m = JSON.parse(String(raw)); } catch { return; }
    switch (m.type) {
      case 'ping': return this.send({ type: 'pong' });
      case 'hello': {
        write(session, TAB_KEY, { ...this.tab(), connId: m.connId });
        if (!m.paired) return this.offer();
        if (!m.active) return;
        this.manual = false;
        this.set({ status: 'connected', port: this.port, error: undefined, offerCode: undefined });
        write(local, LINK_KEY, { port: this.port, auto: true });
        this.keepAlive.start();
        clearTimeout(this.stable);
        this.stable = setTimeout(() => { this.attempts = 0; }, RECONNECT_STABLE_MS);
        return;
      }
      case 'paired': void saveToken(m.token); return;
      case 'takeover': return this.set({ status: 'moved' });
      // The result goes on whichever socket is open by then; after a reconnect the helper re-sends the call with the same
      // execution key, and the ledger answers it with the stored result.
      case 'call': void this.executor.execute(m).then(result => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'result', callId: m.callId, result })); }); return;
      case 'error':
        if (m.code === 'TAB_ACTIVE_ELSEWHERE') return this.set(this.manual && !this.takeover ? { status: 'confirm', error: undefined } : { status: 'moved' });
        if (m.code === 'TOKEN_INVALID') void dropToken();
        return this.set({ error: m.message });
    }
  }
  /** The helper does not know this tab: show the code entry, and offer a code the user can type into the helper instead. */
  private offer() {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
    this.set({ status: 'pairing', offerCode: code });
    this.send({ type: 'pair', code, offer: true });
  }
}

/** The one link of this tab. */
export const agentLink = new AgentLink();
