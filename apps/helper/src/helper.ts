// SPDX-License-Identifier: AGPL-3.0-only
// The Cutframe helper (T18a; master plan §1a Contract A). One process on 127.0.0.1 that
//  - answers GET /hello {app, version, pairing},
//  - serves MCP over Streamable HTTP at /mcp (and over stdio through cli.ts),
//  - holds the one editor tab link at ws://127.0.0.1:<port>/tab (pairing, takeover, calls, events).
// Every MCP tool call is checked against our schemas, then forwarded to the active tab; mutating calls run strictly one at
// a time in arrival order (agent tool results §4 rule 5), read-only calls go straight through.
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer } from 'ws';
import { APP, CLOSE, CODE_TTL_MS, DEFAULT_PORT, DISCONNECTED_ERROR, LINK_ERRORS, NOT_CONNECTED_ERROR, PING_MS, PORT_RANGE, PROTOCOL, READ_ONLY, RESOURCE_QUIET_MS,
  SERVED_TOOLS, STALL_MS, TIMEOUT_ERROR } from '../../web/src/agent/protocol';
import type { HelperMessage, LinkError, ToolResult } from '../../web/src/agent/protocol';
import { createMcpSession } from './mcp';
import type { Link, McpSession } from './mcp';
import { validate } from './schemas';
import { defaultConfigDir, hashToken, newToken, TokenStore } from './store';

export const VERSION: string = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
/** Wrong codes in a row (over every socket) that cancel the helper's pairing code and lock pairing by code until the user
 *  asks for a new one. */
export const MAX_CODE_MISSES = 5;

export type HelperOptions = {
  /** First port to try (default 47820); the next free one of `range` ports is used. 0 = any free port (tests). */
  port?: number; range?: number;
  configDir?: string;
  /** Extra page origins allowed to open /tab and read /hello (loopback http(s) origins are always allowed). */
  allowOrigins?: string[];
  toolTimeoutMs?: number;
  /** User-facing lines (pairing code, status). Default: stdout. */
  log?: (line: string) => void;
  // Test knobs; the defaults are Contract A's values.
  pingMs?: number; stallMs?: number; quietMs?: number; codeTtlMs?: number;
};

type Tab = { ws: WebSocket; origin: string; tabId?: string; projectId?: string | null; connId?: string; tokenHash?: string; paired: boolean; takeover: boolean;
  offer?: { code: string; expires: number }; lastSeen: number };
type Pending = { callId: string; toolName: string; input: unknown; session?: string; resource?: boolean; connId?: string; executionKey?: string;
  resolve: (r: ToolResult) => void; timer?: ReturnType<typeof setTimeout> };

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const RESOURCE_PARTS = new Set(['items', 'tracks', 'transitions']);
const SERVED = new Set<string>(SERVED_TOOLS);

/** A Cutframe page origin: loopback http(s) on any port, or one passed with --allow-origin. */
export function originAllowed(origin: string | undefined, extra: Iterable<string> = []): boolean {
  if (!origin) return false;
  for (const o of extra) if (o === origin) return true;
  try { const u = new URL(origin); return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_NAMES.has(u.hostname) && u.origin === origin; } catch { return false; }
}
export const loopbackAddress = (addr: string | undefined) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
/** Host header names a loopback host (DNS-rebinding guard). */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK_NAMES.has(name.toLowerCase());
}
const notConnected = (): ToolResult => ({ success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR });
const linkError = (code: LinkError, message?: string): HelperMessage => ({ type: 'error', code, message: message ?? LINK_ERRORS[code] });
const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });
// An incoming tab message before its fields are checked.
type Msg = Record<string, any>;

export class Helper implements Link {
  port = 0;
  readonly store: TokenStore;
  readonly log: (line: string) => void;
  private readonly allow: string[];
  private readonly http = createServer((req, res) => void this.onRequest(req, res));
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private readonly tabs = new Set<Tab>();
  private active?: Tab;
  /** A takeover waiting for the active tab's running calls to finish (never take the link mid-call). */
  private waiting?: Tab;
  private readonly connIds = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  private chain: Promise<unknown> = Promise.resolve();
  private code?: { value: string; expires: number };
  /** Wrong codes since the user last asked for a code or a tab paired, helper-wide: a new socket does not start over. */
  private misses = 0;
  private readonly sessions = new Set<McpSession>();
  private readonly httpSessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpSession }>();
  private quiet?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;

  constructor(private readonly options: HelperOptions = {}) {
    this.store = new TokenStore(options.configDir ?? defaultConfigDir());
    this.allow = options.allowOrigins ?? [];
    this.log = options.log ?? (line => console.log(line));
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  async listen(): Promise<number> {
    const first = this.options.port ?? DEFAULT_PORT, count = first === 0 ? 1 : this.options.range ?? PORT_RANGE;
    for (let port = first; port < first + count; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const fail = (e: Error) => { this.http.off('listening', ok); reject(e); }, ok = () => { this.http.off('error', fail); resolve(); };
          this.http.once('error', fail); this.http.once('listening', ok); this.http.listen(port, '127.0.0.1');
        });
        this.port = (this.http.address() as AddressInfo).port;
        this.ticker = setInterval(() => this.tick(), this.options.pingMs ?? PING_MS);
        return this.port;
      } catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e; } // EACCES: a Windows exclusion, or a socket held exclusively
    }
    throw Object.assign(new Error(`Ports ${first}–${first + count - 1} on 127.0.0.1 are all in use. Stop the other program or pass --port <n>.`), { code: 'PORTS_BUSY' });
  }

  async close() {
    clearInterval(this.ticker); clearTimeout(this.quiet);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(notConnected()); }
    this.pending.clear();
    for (const t of this.tabs) t.ws.close(CLOSE.shutdown, 'helper stopped');
    for (const s of this.httpSessions.values()) await s.transport.close().catch(() => {});
    for (const s of this.sessions) await s.server.close().catch(() => {});
    this.wss.close();
    await new Promise<void>(resolve => { this.http.close(() => resolve()); this.http.closeAllConnections(); });
  }

  // ---- Pairing (Contract A: 6 digits, valid 5 minutes; the code is single-use).
  get pairing() { return !!this.code && this.code.expires > Date.now(); }
  get pairingCode() { return this.pairing ? this.code!.value : undefined; }
  /** After MAX_CODE_MISSES wrong codes no code is minted for a tab and none is accepted, until newCode(). */
  get locked() { return this.misses >= MAX_CODE_MISSES; }
  /** A code the user asked for (the terminal `code` command, or the helper starting with nothing paired); lifts the lock. */
  newCode(): string { this.misses = 0; return this.mint(); }
  private mint(): string {
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.code = { value, expires: Date.now() + (this.options.codeTtlMs ?? CODE_TTL_MS) };
    this.log(`Pairing code: ${value} (valid 5 minutes). In the Cutframe editor press Connect tab and enter it.`);
    return value;
  }
  /** The editor-shown code typed into the helper's terminal (Contract A, "or the reverse"). A code offered by more than one
   *  tab pairs none of them: a page that floods offers can block this way, but never ride along on the user's code. */
  confirmOffer(code: string): boolean {
    const offers = [...this.tabs].filter(t => t.offer?.code === code);
    for (const t of offers) if (t.offer!.expires <= Date.now()) { t.offer = undefined; this.send(t, linkError('PAIRING_CODE_EXPIRED')); }
    const live = offers.filter(t => t.offer);
    if (live.length > 1) this.log('More than one tab shows that code, so none was paired. Press Connect tab in the editor again for a new code.');
    if (live.length !== 1) return false;
    this.issue(live[0]);
    return true;
  }
  /** Revoke every pairing: the file is emptied and every paired tab is disconnected. */
  revokeAll() { this.store.revokeAll(); for (const t of this.tabs) this.checkToken(t); }
  status(): string[] {
    const a = this.active;
    return [`Cutframe helper ${VERSION} on http://127.0.0.1:${this.port} (MCP: /mcp)`, `Paired tabs on file: ${this.store.count()} (${this.store.file})`,
      `Connected tabs: ${this.tabs.size}; active: ${a ? `project ${a.projectId ?? '(none)'}` : 'none'}`, `MCP sessions: ${this.sessions.size}`,
      this.locked ? `Pairing by code is locked after ${MAX_CODE_MISSES} wrong codes (type \`code\` for a new one).`
        : this.pairing ? `Pairing code ${this.code!.value} is waiting.` : 'No pairing code is waiting (type `code` for one).'];
  }
  /** Adds an MCP session that is not served over HTTP (stdio); returns its removal. */
  attach(session: McpSession) { this.sessions.add(session); return () => { this.sessions.delete(session); }; }

  // ---- Tool calls (Link).
  async call(tool: string, input: unknown, session: string | undefined, opts: { resource?: boolean } = {}): Promise<ToolResult> {
    if (!SERVED.has(tool)) return { success: false, error: `Unknown tool '${tool}'`, code: 'UNKNOWN_TOOL' };
    const invalid = validate(tool, input ?? {});
    if (invalid) return invalid as ToolResult;
    if (READ_ONLY.has(tool)) return this.dispatch(tool, input ?? {}, session, opts.resource);
    const run = this.chain.then(() => this.dispatch(tool, input ?? {}, session));
    this.chain = run.catch(() => {});
    return run;
  }
  private dispatch(toolName: string, input: unknown, session?: string, resource?: boolean): Promise<ToolResult> {
    const target = this.active;
    if (!target) return Promise.resolve(notConnected());
    return new Promise(resolve => {
      const p: Pending = { callId: randomUUID(), toolName, input, session, resource, resolve };
      this.pending.set(p.callId, p);
      if (this.waiting) p.timer = setTimeout(() => this.expire(p), this.toolTimeout); // held for the tab that takes over
      else this.transmit(p, target);
    });
  }
  private get toolTimeout() { return this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS; }
  /** Sends (or re-sends after a reconnect of the same tab) a call; the execution key stays the same, so the tab's ledger
   *  answers a duplicate delivery with the stored result (A0.2). */
  private transmit(p: Pending, tab: Tab) {
    p.connId = tab.connId; p.executionKey ??= `mcp:${tab.connId}:${p.callId}`;
    this.send(tab, { type: 'call', callId: p.callId, executionKey: p.executionKey, toolName: p.toolName, input: p.input as Record<string, unknown>,
      ...(p.session ? { session: p.session } : {}), ...(p.resource ? { resource: true } : {}) });
    p.timer ??= setTimeout(() => this.expire(p), this.toolTimeout);
  }
  private settle(p: Pending, result: ToolResult) { clearTimeout(p.timer); this.pending.delete(p.callId); p.resolve(result); this.maybeSwitch(); }
  private expire(p: Pending) {
    const gone = p.connId !== undefined && this.active?.connId !== p.connId;
    this.settle(p, gone ? { success: false, code: 'TAB_NOT_CONNECTED', error: DISCONNECTED_ERROR, operationMayHaveRun: true }
      : { success: false, code: 'TOOL_TIMEOUT', error: TIMEOUT_ERROR, operationMayHaveRun: p.connId !== undefined });
  }
  private busy(tab: Tab) { for (const p of this.pending.values()) if (p.connId === tab.connId) return true; return false; }

  // ---- HTTP.
  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname, origin = req.headers.origin;
    if (!hostAllowed(req.headers.host)) return void res.writeHead(403).end('Forbidden host');
    if (path === '/hello') {
      const ok = originAllowed(origin, this.allow);
      if (ok) res.setHeader('Access-Control-Allow-Origin', origin!), res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        if (ok) res.setHeader('Access-Control-Allow-Methods', 'GET'), res.setHeader('Access-Control-Allow-Private-Network', 'true');
        return void res.writeHead(204).end();
      }
      if (req.method !== 'GET') return void res.writeHead(405, { Allow: 'GET' }).end();
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ app: APP, version: VERSION, pairing: this.pairing }));
    }
    if (path === '/mcp') {
      if (origin && !originAllowed(origin, this.allow)) return void res.writeHead(403).end('Forbidden origin');
      return this.onMcp(req, res);
    }
    res.writeHead(404).end('Not found');
  }
  private async onMcp(req: IncomingMessage, res: ServerResponse) {
    const json = (status: number, body: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    try {
      const sid = req.headers['mcp-session-id'];
      if (typeof sid === 'string') {
        const s = this.httpSessions.get(sid);
        return s ? await s.transport.handleRequest(req, res) : json(404, rpcError(-32001, 'Session not found'));
      }
      if (req.method !== 'POST') return json(400, rpcError(-32000, 'Bad Request: no valid session ID provided'));
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); } catch { return json(400, rpcError(-32700, 'Parse error')); }
      if (!(Array.isArray(body) ? body.some(m => isInitializeRequest(m)) : isInitializeRequest(body))) return json(400, rpcError(-32000, 'Bad Request: no valid session ID provided'));
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => { this.httpSessions.set(id, { transport, mcp }); } });
      const mcp = createMcpSession(this, VERSION, () => transport.sessionId);
      transport.onclose = () => { if (transport.sessionId) this.httpSessions.delete(transport.sessionId); this.sessions.delete(mcp); };
      this.sessions.add(mcp);
      await mcp.server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) json(500, rpcError(-32603, 'Internal error'));
      this.log(`MCP request failed: ${(e as Error).message}`);
    }
  }

  // ---- The tab link.
  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname, origin = req.headers.origin;
    if (path !== '/tab' || !hostAllowed(req.headers.host) || !loopbackAddress(req.socket.remoteAddress) || !originAllowed(origin, this.allow)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, ws => this.onTab(ws, origin!));
  }
  private onTab(ws: WebSocket, origin: string) {
    const tab: Tab = { ws, origin, paired: false, takeover: false, lastSeen: Date.now() };
    this.tabs.add(tab);
    ws.on('message', (data, binary) => {
      tab.lastSeen = Date.now();
      let m: unknown = null;
      try { if (!binary) m = JSON.parse(String(data)); } catch { /* answered below */ }
      if (!m || typeof m !== 'object') return this.send(tab, linkError('INVALID_MESSAGE', 'Messages must be JSON objects with a type.'));
      this.onMessage(tab, m as Msg);
    });
    ws.on('close', () => this.onClose(tab));
    ws.on('error', () => {});
  }
  private send(tab: Tab, message: HelperMessage) { if (tab.ws.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify(message)); }
  private onMessage(tab: Tab, m: Msg) {
    if (m.type === 'hello') return this.onHello(tab, m);
    if (m.type === 'ping') { this.checkToken(tab); return this.send(tab, { type: 'pong' }); }
    if (m.type === 'pong') return;
    if (!tab.tabId) return this.send(tab, linkError('INVALID_MESSAGE', 'Send hello first.'));
    if (m.type === 'pair') return this.onPair(tab, m);
    if (m.type === 'result') {
      const p = this.pending.get(String(m.callId));
      if (!p || p.connId !== tab.connId) return;
      return this.settle(p, m.error ? { success: false, code: String(m.error.code), error: String(m.error.message) }
        : m.result && typeof m.result === 'object' ? m.result : { success: false, code: 'PROJECT_UNAVAILABLE', error: 'Tool execution failed', operationMayHaveRun: true });
    }
    if (m.type === 'event') return this.onEvent(tab, m.name, m.data);
    if (m.type === 'revoke') {
      if (tab.tokenHash) this.store.revokeHash(tab.tokenHash);
      tab.paired = false; tab.tokenHash = undefined;
      return tab.ws.close(CLOSE.unauthorized, 'revoked');
    }
    this.send(tab, linkError('INVALID_MESSAGE', `Unknown message type '${String(m.type)}'.`));
  }
  private onHello(tab: Tab, m: Msg) {
    if (m.protocol !== PROTOCOL) { this.send(tab, linkError('PROTOCOL_UNSUPPORTED')); return tab.ws.close(CLOSE.protocol, 'protocol'); }
    if (typeof m.tabId !== 'string' || !m.tabId) return this.send(tab, linkError('INVALID_MESSAGE', 'hello needs a tabId.'));
    tab.tabId = m.tabId; tab.projectId = typeof m.projectId === 'string' ? m.projectId : null; tab.takeover = m.takeover === true;
    if (!tab.connId) {
      tab.connId = typeof m.connId === 'string' && this.connIds.get(m.connId) === m.tabId ? m.connId : randomUUID();
      this.connIds.set(tab.connId, m.tabId);
    }
    if (typeof m.token === 'string') {
      if (this.store.has(m.token)) { tab.paired = true; tab.tokenHash = hashToken(m.token); }
      else { tab.paired = false; tab.tokenHash = undefined; this.send(tab, linkError('TOKEN_INVALID')); }
    }
    if (this.waiting === tab && !(tab.paired && tab.takeover)) this.withdraw(); // a waiter that no longer asks (or may) take over
    if (!tab.paired) {
      // The socket stays open while locked: the reverse path (the user types this tab's code into the helper) still works.
      if (!this.pairing && !this.locked) this.mint();
      this.ack(tab, false);
      if (this.locked) this.send(tab, linkError('PAIRING_LOCKED'));
      return;
    }
    this.claim(tab);
  }
  private ack(tab: Tab, active: boolean) { this.send(tab, { type: 'hello', protocol: PROTOCOL, version: VERSION, connId: tab.connId!, paired: tab.paired, active }); }
  /** §10b.2: the same tab reclaims silently; another tab takes over only with takeover:true, and never mid-call. */
  private claim(tab: Tab) {
    const cur = this.active;
    if (cur === tab) return this.ack(tab, true);
    if (!cur) return this.activate(tab);
    if (cur.tabId === tab.tabId) { cur.ws.close(CLOSE.replaced, 'replaced by a newer connection of the same tab'); return this.activate(tab); }
    if (!tab.takeover) return this.send(tab, linkError('TAB_ACTIVE_ELSEWHERE'));
    if (this.busy(cur)) {
      if (this.waiting && this.waiting !== tab) this.send(this.waiting, linkError('TAB_ACTIVE_ELSEWHERE'));
      this.waiting = tab;
      return;
    }
    this.supersede(cur, tab);
    this.activate(tab);
  }
  private activate(tab: Tab) {
    if (this.waiting && this.waiting !== tab) this.send(this.waiting, linkError('TAB_ACTIVE_ELSEWHERE')); // the same tab reclaimed
    this.active = tab; this.waiting = undefined;
    this.ack(tab, true);
    for (const p of [...this.pending.values()]) {
      if (p.connId === undefined || p.connId === tab.connId) this.transmit(p, tab);
      else this.settle(p, { success: false, code: 'TAB_NOT_CONNECTED', error: DISCONNECTED_ERROR, operationMayHaveRun: true });
    }
  }
  private supersede(old: Tab, by: Tab) {
    this.send(old, { type: 'takeover', ...(by.tabId ? { byTabId: by.tabId } : {}) });
    old.ws.close(CLOSE.superseded, 'superseded');
    if (this.active === old) this.active = undefined;
  }
  private maybeSwitch() {
    if (!this.waiting || !this.active || this.busy(this.active)) return;
    if (!this.live(this.waiting)) return this.withdraw();
    const next = this.waiting;
    this.supersede(this.active, next);
    this.activate(next);
  }
  /** A tab the helper can still hand calls to: paired, and its socket not closing. */
  private live(tab: Tab | undefined): tab is Tab { return !!tab && tab.paired && tab.ws.readyState === WebSocket.OPEN; }
  /** The takeover will not happen: calls held for it go to the tab that keeps the link at once. */
  private withdraw() { this.waiting = undefined; this.release(); }
  /** Calls held for a takeover, once none waits: sent to the active tab, or refused at once when no tab is left. */
  private release() {
    if (this.waiting) return;
    const to = this.live(this.active) ? this.active : undefined;
    for (const p of [...this.pending.values()]) if (p.connId === undefined) to ? this.transmit(p, to) : this.settle(p, notConnected());
  }
  private onClose(tab: Tab) {
    this.tabs.delete(tab);
    if (this.waiting === tab) this.waiting = undefined;
    if (this.active === tab) {
      this.active = undefined;
      if (this.live(this.waiting)) return this.activate(this.waiting);
      this.waiting = undefined;
    }
    this.release();
  }
  private onPair(tab: Tab, m: Msg) {
    const code = typeof m.code === 'string' ? m.code : '';
    if (!/^\d{6}$/.test(code)) return this.send(tab, linkError('PAIRING_CODE_INVALID'));
    if (m.offer === true) {
      tab.offer = { code, expires: Date.now() + (this.options.codeTtlMs ?? CODE_TTL_MS) };
      return this.log('An editor tab is waiting to pair: type the 6-digit code the editor shows, then Enter.');
    }
    if (this.locked) return this.lockOut(tab);
    const c = this.code;
    if (c && c.value === code) {
      this.code = undefined;
      return c.expires <= Date.now() ? this.send(tab, linkError('PAIRING_CODE_EXPIRED')) : this.issue(tab);
    }
    if (++this.misses < MAX_CODE_MISSES) return this.send(tab, linkError('PAIRING_CODE_INVALID'));
    this.code = undefined;
    this.log('Too many wrong pairing codes: the code was cancelled. Type `code` for a new one.');
    this.lockOut(tab);
  }
  private lockOut(tab: Tab) { this.send(tab, linkError('PAIRING_LOCKED')); tab.ws.close(CLOSE.unauthorized, 'pairing locked'); }
  private issue(tab: Tab) {
    const token = newToken();
    this.store.add(token, tab.tabId);
    this.misses = 0;
    tab.paired = true; tab.tokenHash = hashToken(token); tab.offer = undefined;
    this.send(tab, { type: 'paired', token });
    this.log('A tab was paired.');
    this.claim(tab);
  }
  private checkToken(tab: Tab) {
    if (!tab.paired || !tab.tokenHash || this.store.hasHash(tab.tokenHash)) return;
    tab.paired = false; tab.tokenHash = undefined;
    this.send(tab, linkError('TOKEN_REVOKED'));
    tab.ws.close(CLOSE.unauthorized, 'revoked');
  }
  /** Resource notifications: only the active tab's item / track / transition changes, after a quiet period (Contract A). */
  private onEvent(tab: Tab, name: unknown, data: unknown) {
    const parts = (data as { parts?: unknown })?.parts;
    if (tab !== this.active || name !== 'stateChanged' || !Array.isArray(parts) || !parts.some(p => RESOURCE_PARTS.has(p))) return;
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => { this.quiet = undefined; for (const s of this.sessions) s.changed(); }, this.options.quietMs ?? RESOURCE_QUIET_MS);
  }
  private tick() {
    const stall = this.options.stallMs ?? STALL_MS;
    for (const t of this.tabs) { if (Date.now() - t.lastSeen > stall) t.ws.terminate(); else this.checkToken(t); }
  }
}

function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startHelper(options: HelperOptions = {}): Promise<Helper> {
  const helper = new Helper(options);
  await helper.listen();
  return helper;
}
