// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger rows 1 and 3: the helper process (ports, /hello, CLI, MCP over HTTP and stdio) and its refusals (Host, Origin, loopback, path).
// Every test starts its own helper on a free port with its own temporary config directory.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { HELP, parseArgs } from '../apps/helper/src/cli';
import { Helper, hostAllowed, loopbackAddress, originAllowed, startHelper, VERSION } from '../apps/helper/src/helper';
import { defaultConfigDir } from '../apps/helper/src/store';
import { LINK_ERRORS, NOT_CONNECTED_ERROR } from '../apps/web/src/agent/protocol';

const ORIGIN = 'http://127.0.0.1:4173';
const BIN = fileURLToPath(new URL('../apps/helper/bin/cutframe-connect.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Server order follows TOOL_LIST's declaration order in schemas.ts, not SERVED_TOOLS's; T12's vector-mask tools, then its
// smart-mask tools, are declared last there, in two trailing blocks.
const SERVED = ['addCaptions', 'addLayout', 'addMedia', 'addMotionGraphic', 'addShape', 'addText', 'applyTransition', 'changeTrack', 'cloneItem', 'consolidateTracks', 'context', 'deleteItems', 'editAllCaptionStyles', 'editLayout', 'editMotionGraphic', 'editProperties', 'getHelpSection', 'listCaptionTemplates', 'manageMarkers', 'manageTrack', 'manageTrackGroup', 'moveItem', 'reorderItems',
  'resizeCanvas', 'searchHelpDocs', 'setTimeRemap', 'slipItem', 'splitItem', 'syncAndSwap', 'transformItem', 'trimItem', 'viewItemDetails', 'writeEffects', 'writeKeyframes', 'writeShapePoints', // T10 (C8): + writeEffects; T06 (C8): + addShape, writeShapePoints; T07 (C8): + addLayout, editLayout; T11 (C8): + applyTransition; T05: + addText; T09 (C8 assertion-only edit): + addCaptions, editAllCaptionStyles, listCaptionTemplates
  'createMask', 'editMaskProperties', 'removeMask', 'writeMaskPoints', // T12 (C8): declared last in schemas.ts
  'viewMaskFrame', 'previewSmartMask', 'trackSmartMask', 'removeBackground']; // T12 smart masks (C8): declared last of all

// ---- Per-test resources, released in afterEach.
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 't18a-helper-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
async function start(options: ConstructorParameters<typeof Helper>[0] = {}) {
  const lines: string[] = [];
  const helper = await startHelper({ port: 0, configDir: tmp(), log: l => lines.push(l), ...options });
  cleanups.push(() => helper.close());
  return { helper, lines, url: `http://127.0.0.1:${helper.port}` };
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
/** node:http, because fetch cannot set Host or Origin freely. */
function http(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: o.headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}
/** The HTTP status a WebSocket upgrade is answered with when it is refused. */
function wsStatus(url: string, opts: ConstructorParameters<typeof WebSocket>[2] = {}): Promise<number | 'open'> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); ws.terminate(); });
    ws.on('open', () => { resolve('open'); ws.close(); });
    ws.on('error', e => { if (!/Unexpected server response/.test(e.message)) reject(e); });
  });
}
/** A helper that touches no real port: its server's listen() refuses with `codes` in order, then succeeds on the port it was given. */
function refusing(codes: string[], options: ConstructorParameters<typeof Helper>[0]) {
  const helper = new Helper({ configDir: tmp(), log: () => {}, ...options }), server = helper['http'], tried: number[] = [];
  server.listen = ((port: number) => {
    tried.push(port);
    const code = codes[tried.length - 1];
    queueMicrotask(() => code ? server.emit('error', Object.assign(new Error(`listen ${code}`), { code })) : server.emit('listening'));
    return server;
  }) as typeof server.listen;
  server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: tried.at(-1)! });
  cleanups.push(() => helper.close());
  return { helper, tried };
}
/** A helper with `port + 1` seen free, both below every default dynamic range (49152+ on Windows and macOS, 32768+ on Linux): no bind(0) or
 *  outbound connection gets a port there, so nothing takes `port + 1` before the test binds it (D34: in the dynamic range another process
 *  took it about 1 run in 15). */
async function startLow() {
  let held: Awaited<ReturnType<typeof start>>;
  do held = await start({ port: 20_000 + randomInt(10_000), range: 100 });
  while (!await startHelper({ port: held.helper.port + 1, range: 1, configDir: tmp(), log: () => {} }).then(next => next.close().then(() => true), () => false));
  return held;
}

describe('t18a helper process (row 1)', () => {
  it('row 1: /hello answers {app, version, pairing} with the package version; pairing follows the code', async () => {
    const { helper } = await start();
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    const first = await http(helper.port, { path: '/hello' });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('application/json');
    expect(JSON.parse(first.body)).toEqual({ app: 'cutframe-helper', version: pkg.version, pairing: false });
    expect(first.headers['access-control-allow-origin']).toBeUndefined(); // no Origin → no CORS grant
    helper.newCode();
    expect(JSON.parse((await http(helper.port, { path: '/hello' })).body)).toEqual({ app: 'cutframe-helper', version: pkg.version, pairing: true });
  });

  it('row 1: a pairing code is 6 digits, is announced in the log, and is the one /hello reports', async () => {
    const { helper, lines } = await start();
    const code = helper.newCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(helper.pairingCode).toBe(code);
    expect(lines).toEqual([`Pairing code: ${code} (valid 5 minutes). In the Cutframe editor press Connect tab and enter it.`]);
  });

  it('row 1: with the first port taken the next one in the range is used', async () => {
    const a = await startLow();
    const b = await start({ port: a.helper.port, range: 2 });
    expect(b.helper.port).toBe(a.helper.port + 1);
    expect(JSON.parse((await http(a.helper.port, { path: '/hello' })).body).app).toBe('cutframe-helper');
    expect(JSON.parse((await http(b.helper.port, { path: '/hello' })).body).app).toBe('cutframe-helper');
  });

  it('row 1: a port refused with EACCES does not stop the walk any more than one with EADDRINUSE: exactly the next free port is used', async () => {
    const { helper, tried } = refusing(['EACCES', 'EADDRINUSE'], { port: 47820 });
    expect(await helper.listen()).toBe(47822);
    expect(tried).toEqual([47820, 47821, 47822]);
  });

  it('row 1: any other listen error stops the walk and is thrown', async () => {
    const { helper, tried } = refusing(['EADDRNOTAVAIL'], { port: 47820 });
    await expect(helper.listen()).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
    expect(tried).toEqual([47820]);
  });

  it('row 1: every port in the range refused, with either code → PORTS_BUSY', async () => {
    const { helper, tried } = refusing(['EACCES', 'EADDRINUSE'], { port: 47820, range: 2 });
    await expect(helper.listen()).rejects.toMatchObject({ code: 'PORTS_BUSY' });
    expect(tried).toEqual([47820, 47821]);
  });

  it('row 1: every port in the range busy → PORTS_BUSY with the fixed sentence', async () => {
    const a = await start();
    const port = a.helper.port;
    const error = await startHelper({ port, range: 1, configDir: tmp(), log: () => {} }).then(() => undefined, (e: Error & { code?: string }) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error!.code).toBe('PORTS_BUSY');
    expect(error!.message).toBe(`Ports ${port}–${port} on 127.0.0.1 are all in use. Stop the other program or pass --port <n>.`);
  });

  it('row 1: the real range — with no port given the helper listens on 47820–47829 (the only test that uses it)', async () => {
    const lines: string[] = [];
    const helper = await startHelper({ configDir: tmp(), log: l => lines.push(l) });
    cleanups.push(() => helper.close());
    expect(helper.port).toBeGreaterThanOrEqual(47820);
    expect(helper.port).toBeLessThanOrEqual(47829);
    expect(JSON.parse((await http(helper.port, { path: '/hello' })).body)).toMatchObject({ app: 'cutframe-helper' });
  });

  it('row 1: close() frees the port', async () => {
    const helper = await startHelper({ port: 0, configDir: tmp(), log: () => {} });
    const { port } = helper;
    await helper.close();
    await expect(http(port, { path: '/hello' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('row 1: the helper listens on loopback only (a non-loopback address of this machine refuses the connection)', async (ctx) => {
    const { helper } = await start();
    const external = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!external) return ctx.skip();
    const outcome = await new Promise<string>(resolve => {
      const socket = connect({ host: external, port: helper.port, timeout: 1000 });
      socket.on('connect', () => { socket.destroy(); resolve('connected'); });
      socket.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
      socket.on('timeout', () => { socket.destroy(); resolve('timeout'); });
    });
    expect(outcome).not.toBe('connected'); // refused (Linux, macOS) or dropped by the firewall (Windows): never accepted
  });

  it('row 1: status() reports the version, the pairings on file, the connected tabs and the MCP sessions', async () => {
    const { helper, url } = await start();
    const lines = helper.status();
    expect(lines[0]).toBe(`Cutframe helper ${VERSION} on ${url} (MCP: /mcp)`);
    expect(lines[1]).toBe(`Paired tabs on file: 0 (${helper.store.file})`);
    expect(lines.slice(2)).toEqual(['Connected tabs: 0; active: none', 'MCP sessions: 0', 'No pairing code is waiting (type `code` for one).']);
    helper.newCode();
    expect(helper.status()[4]).toBe(`Pairing code ${helper.pairingCode} is waiting.`);
  });
});

describe('t18a CLI arguments (row 1)', () => {
  const baseDir = defaultConfigDir();
  it('row 1: defaults — port 47820, no stdio, default config dir, 60 s call timeout', () => {
    expect(parseArgs([], {})).toEqual({ port: 47820, stdio: false, allowOrigins: [], configDir: baseDir, toolTimeoutMs: 60_000, revokeAll: false, help: false, version: false });
  });
  it('row 1: environment variables set the port, the config directory and the timeout; flags win', () => {
    const env = { CUTFRAME_HELPER_PORT: '47825', CUTFRAME_HELPER_CONFIG_DIR: '/tmp/x', CUTFRAME_HELPER_TOOL_TIMEOUT_MS: '1234' };
    expect(parseArgs([], env)).toMatchObject({ port: 47825, configDir: '/tmp/x', toolTimeoutMs: 1234 });
    expect(parseArgs(['--port', '1', '--config-dir', '/y', '--tool-timeout', '9'], env)).toMatchObject({ port: 1, configDir: '/y', toolTimeoutMs: 9 });
  });
  it('row 1: flags — --stdio, --revoke-all, --help/-h, --version/-v, repeatable --allow-origin reduced to its origin', () => {
    expect(parseArgs(['--stdio', '--revoke-all'], {})).toMatchObject({ stdio: true, revokeAll: true });
    expect(parseArgs(['-h'], {}).help).toBe(true);
    expect(parseArgs(['--help'], {}).help).toBe(true);
    expect(parseArgs(['-v'], {}).version).toBe(true);
    expect(parseArgs(['--version'], {}).version).toBe(true);
    expect(parseArgs(['--allow-origin', 'https://editor.example/some/path?x=1', '--allow-origin', 'http://10.0.0.2:8080'], {}).allowOrigins).toEqual(['https://editor.example', 'http://10.0.0.2:8080']);
  });
  it('row 1: bad arguments throw the fixed sentences', () => {
    expect(() => parseArgs(['--port', 'abc'], {})).toThrow('--port must be a whole number from 0 to 65535.');
    expect(() => parseArgs(['--port', '70000'], {})).toThrow('--port must be a whole number from 0 to 65535.');
    expect(() => parseArgs(['--port'], {})).toThrow('--port needs a value.');
    expect(() => parseArgs(['--tool-timeout', '0'], {})).toThrow('--tool-timeout must be a whole number from 1 to 3600000.');
    expect(() => parseArgs([], { CUTFRAME_HELPER_PORT: 'x' })).toThrow('CUTFRAME_HELPER_PORT must be a whole number from 0 to 65535.');
    expect(() => parseArgs(['--allow-origin', 'not a url'], {})).toThrow("--allow-origin needs an origin such as https://editor.example, not 'not a url'.");
    expect(() => parseArgs(['--bogus'], {})).toThrow("Unknown option '--bogus'. Run with --help for the options.");
  });
  it('row 1: the help text names every option', () => {
    for (const flag of ['--port <n>', '--stdio', '--allow-origin <url>', '--config-dir <dir>', '--tool-timeout <ms>', '--revoke-all', '--version, --help']) expect(HELP).toContain(flag);
    expect(HELP.startsWith('Usage: cutframe-connect [options]')).toBe(true);
  });
});

// ---- Child processes: the real bin script.
type Child = { proc: ChildProcess; stdout: string[]; stderr: string[]; exited: Promise<number | null>; waitFor(re: RegExp, ms?: number): Promise<string> };
function run(args: string[]): Child {
  const proc = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  cleanups.push(() => { if (proc.exitCode === null) proc.kill(); });
  const stdout: string[] = [], stderr: string[] = [], watchers: (() => void)[] = [];
  const lines = (into: string[]) => { let rest = ''; return (c: Buffer) => { const parts = (rest + c.toString('utf8')).split(/\r?\n/); rest = parts.pop()!; into.push(...parts); watchers.forEach(w => w()); }; };
  proc.stdout!.on('data', lines(stdout)); proc.stderr!.on('data', lines(stderr));
  const exited = new Promise<number | null>(resolve => proc.on('exit', code => resolve(code)));
  const waitFor = (re: RegExp, ms = 20_000) => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${re} in output after ${ms} ms:\n${[...stdout, ...stderr].join('\n')}`)), ms);
    const check = () => { const hit = [...stdout, ...stderr].find(l => re.test(l)); if (hit) { clearTimeout(timer); resolve(hit); } };
    watchers.push(check); check();
  });
  return { proc, stdout, stderr, exited, waitFor };
}

describe('t18a CLI process (row 1)', () => {
  it('row 1: --version prints the package version and exits 0', async () => {
    const child = run(['--version']);
    expect(await child.exited).toBe(0);
    expect(child.stdout).toEqual([VERSION]);
  }, 30_000);

  it('row 1: --help prints the usage and exits 0', async () => {
    const child = run(['--help']);
    expect(await child.exited).toBe(0);
    expect(child.stdout.join('\n')).toBe(HELP);
  }, 30_000);

  it('row 1: a bad option exits 2 with the sentence on stderr', async () => {
    const child = run(['--port', 'abc']);
    expect(await child.exited).toBe(2);
    expect(child.stderr).toEqual(['cutframe-connect: --port must be a whole number from 0 to 65535.']);
  }, 30_000);

  it('row 1: --revoke-all forgets every pairing in the config directory and exits 0', async () => {
    const dir = tmp();
    const seeded = new Helper({ configDir: dir, log: () => {} });
    seeded.store.add('t'.repeat(43), 'tab-a');
    expect(seeded.store.count()).toBe(1);
    const child = run(['--revoke-all', '--config-dir', dir]);
    expect(await child.exited).toBe(0);
    expect(child.stdout).toEqual([`Every paired tab was forgotten (${seeded.store.file}).`]);
    expect(seeded.store.count()).toBe(0);
  }, 30_000);

  it('row 1: terminal mode prints the port, the MCP endpoint and a pairing code; /hello agrees; status and quit work', async () => {
    const dir = tmp();
    const child = run(['--port', '0', '--config-dir', dir]);
    const listening = await child.waitFor(/listening on/);
    const port = Number(/:(\d+)$/.exec(listening)![1]);
    expect(listening).toBe(`Cutframe helper ${VERSION} listening on http://127.0.0.1:${port}`);
    expect(await child.waitFor(/MCP endpoint/)).toBe(`MCP endpoint (Streamable HTTP): http://127.0.0.1:${port}/mcp`);
    const codeLine = await child.waitFor(/^Pairing code: /);
    const code = /^Pairing code: (\d{6}) \(valid 5 minutes\)\. In the Cutframe editor press Connect tab and enter it\.$/.exec(codeLine)?.[1];
    expect(code).toBeDefined();
    await child.waitFor(/^Commands: /);
    expect(JSON.parse((await http(port, { path: '/hello' })).body)).toEqual({ app: 'cutframe-helper', version: VERSION, pairing: true });

    child.proc.stdin!.write('status\n');
    await child.waitFor(/^Pairing code \d{6} is waiting\.$/);
    child.proc.stdin!.write('000000\n'); // not an offered code
    await child.waitFor(/^No editor tab is waiting with that code\.$/);
    child.proc.stdin!.write('quit\n');
    expect(await child.exited).toBe(0);
  }, 40_000);

  it('row 1: the second terminal-mode helper moves to the next port instead of failing', async () => {
    const { port } = (await startLow()).helper;
    const second = run(['--port', String(port), '--config-dir', tmp()]);
    expect(await second.waitFor(/listening on/)).toBe(`Cutframe helper ${VERSION} listening on http://127.0.0.1:${port + 1}`);
    second.proc.stdin!.write('quit\n');
    expect(await second.exited).toBe(0);
  }, 60_000);
});

describe('t18a MCP (row 1)', () => {
  async function httpClient(port: number) {
    const client = new Client({ name: 't18a', version: '0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    cleanups.push(() => client.close());
    return { client, transport };
  }

  it('row 1: MCP over Streamable HTTP — server info, capabilities, instructions and the 43 tools', async () => {
    const { helper } = await start();
    const { client } = await httpClient(helper.port);
    expect(client.getServerVersion()).toMatchObject({ name: 'cutframe-helper', version: VERSION });
    expect(client.getServerCapabilities()).toEqual({ tools: {}, resources: { subscribe: true } });
    expect(client.getInstructions()).toBe('Edits the timeline of the project open in the connected Cutframe editor tab. Call context first and again after the user edits; times are seconds. Every edit lands in the editor\'s undo history, so the user can undo it there.');
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(SERVED);
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/\S/);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('row 1: a tool call with no editor tab → the TAB_NOT_CONNECTED envelope as an MCP error', async () => {
    const { helper } = await start();
    const { client } = await httpClient(helper.port);
    const result = await client.callTool({ name: 'context', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR }) }]);
  });

  it('row 1: each HTTP client is its own session (the helper counts them and forgets closed ones)', async () => {
    const { helper } = await start();
    const a = await httpClient(helper.port), b = await httpClient(helper.port);
    expect(helper.status()[3]).toBe('MCP sessions: 2');
    await a.transport.terminateSession(); // DELETE /mcp with the session id
    await new Promise(r => setTimeout(r, 100));
    expect(helper.status()[3]).toBe('MCP sessions: 1');
    void b;
  });

  it('row 1: /mcp without a session — POST of anything but initialize, bad JSON, GET, unknown session', async () => {
    const { helper } = await start();
    const rpc = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });
    const post = (body: string, headers: Record<string, string> = {}) => http(helper.port, { method: 'POST', path: '/mcp', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });
    const notInit = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect([notInit.status, JSON.parse(notInit.body)]).toEqual([400, rpc(-32000, 'Bad Request: no valid session ID provided')]);
    const bad = await post('{nope');
    expect([bad.status, JSON.parse(bad.body)]).toEqual([400, rpc(-32700, 'Parse error')]);
    const get = await http(helper.port, { path: '/mcp' });
    expect([get.status, JSON.parse(get.body)]).toEqual([400, rpc(-32000, 'Bad Request: no valid session ID provided')]);
    const unknown = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { 'mcp-session-id': 'no-such-session' });
    expect([unknown.status, JSON.parse(unknown.body)]).toEqual([404, rpc(-32001, 'Session not found')]);
  });

  it('row 1: MCP over stdio — a helper started by the client serves the 43 tools and logs to stderr', async () => {
    const dir = tmp();
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, '--stdio', '--port', '0', '--config-dir', dir], cwd: ROOT, stderr: 'pipe' });
    const err: string[] = [];
    transport.stderr!.on('data', c => err.push(String(c)));
    const client = new Client({ name: 't18a', version: '0' }, { capabilities: {} });
    await client.connect(transport);
    cleanups.push(() => client.close());
    expect(client.getServerVersion()).toMatchObject({ name: 'cutframe-helper', version: VERSION });
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(SERVED);
    const result = await client.callTool({ name: 'context', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR });
    const log = err.join('');
    expect(log).toMatch(new RegExp(`Cutframe helper ${VERSION.replace(/\./g, '\\.')} listening on http://127\\.0\\.0\\.1:\\d+`));
    expect(log).toMatch(/Pairing code: \d{6} \(valid 5 minutes\)\./); // stdout carries MCP only: the lines went to stderr
  }, 40_000);

  it('row 1: --stdio with a helper already running relays to it (the call reaches that helper\'s tab)', async () => {
    const { helper } = await start();
    helper.store.add('r'.repeat(43), 'tab-relay');
    const ws = new WebSocket(`ws://127.0.0.1:${helper.port}/tab`, { origin: ORIGIN });
    cleanups.push(() => ws.terminate());
    await new Promise<void>(resolve => ws.on('open', () => resolve()));
    const inbox: any[] = [];
    ws.on('message', d => {
      const m = JSON.parse(String(d));
      inbox.push(m);
      if (m.type === 'call') ws.send(JSON.stringify({ type: 'result', callId: m.callId, result: { success: true, data: { relayed: m.toolName } } }));
    });
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, projectId: 'p1', tabId: 'tab-relay', token: 'r'.repeat(43), takeover: true }));
    await new Promise<void>(resolve => { const t = setInterval(() => { if (inbox.some(m => m.type === 'hello' && m.active)) { clearInterval(t); resolve(); } }, 10); });

    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, '--stdio', '--port', String(helper.port), '--config-dir', tmp()], cwd: ROOT, stderr: 'pipe' });
    const err: string[] = [];
    transport.stderr!.on('data', c => err.push(String(c)));
    const client = new Client({ name: 't18a', version: '0' }, { capabilities: {} });
    await client.connect(transport);
    cleanups.push(() => client.close());
    const result = await client.callTool({ name: 'context', arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ success: true, data: { relayed: 'context' } });
    expect(err.join('')).toContain(`cutframe-connect: relaying MCP to the helper on http://127.0.0.1:${helper.port}/mcp`);
  }, 40_000);
});

describe('t18a refusals (row 3)', () => {
  it('row 3: unit table — loopbackAddress', () => {
    const table: [string | undefined, boolean][] = [['127.0.0.1', true], ['::1', true], ['::ffff:127.0.0.1', true], ['127.0.0.2', false], ['::ffff:127.0.0.2', false], ['0.0.0.0', false],
      ['192.168.1.5', false], ['10.0.0.1', false], ['::', false], ['localhost', false], ['', false], [undefined, false]];
    for (const [addr, expected] of table) expect(loopbackAddress(addr), String(addr)).toBe(expected);
  });

  it('row 3: unit table — hostAllowed (DNS-rebinding guard)', () => {
    const table: [string | undefined, boolean][] = [['127.0.0.1', true], ['127.0.0.1:47820', true], ['localhost', true], ['localhost:5173', true], ['LOCALHOST:5173', true], ['[::1]', true], ['[::1]:47820', true],
      ['evil.example', false], ['evil.example:47820', false], ['127.0.0.1.evil.example', false], ['localhost.evil.example', false], ['10.0.0.2:47820', false], ['0.0.0.0:47820', false], ['', false], [undefined, false]];
    for (const [host, expected] of table) expect(hostAllowed(host), String(host)).toBe(expected);
  });

  it('row 3: unit table — originAllowed (the own served origins; --allow-origin extras by exact match; D34)', () => {
    const table: [string | undefined, string[], boolean][] = [
      ['http://127.0.0.1:4173', [], true], ['http://localhost:4173', [], true], ['http://127.0.0.1:5173', [], true], ['http://localhost:5173', [], true],
      ['https://localhost', [], false], ['http://[::1]:3000', [], false], ['http://[::1]:5173', [], false], ['https://127.0.0.1:8443', [], false], ['http://127.0.0.1:5174', [], false], ['http://localhost:4256', [], false],
      ['http://127.0.0.1:5174', ['http://127.0.0.1:5174'], true], ['http://127.0.0.1:5175', ['http://127.0.0.1:5174'], false],
      ['https://evil.example', [], false], ['http://127.0.0.1.evil.example', [], false], ['http://localhost.evil.example:80', [], false], ['http://10.0.0.2:4173', [], false],
      ['ftp://127.0.0.1', [], false], ['file://', [], false], ['null', [], false], ['http://127.0.0.1:4173/', [], false], ['http://127.0.0.1:4173/path', [], false], ['not an origin', [], false], ['', [], false], [undefined, [], false],
      ['https://editor.example', ['https://editor.example'], true], ['https://editor.example:8443', ['https://editor.example'], false], ['http://editor.example', ['https://editor.example'], false],
    ];
    for (const [origin, extra, expected] of table) expect(originAllowed(origin, extra), `${origin} + ${extra}`).toBe(expected);
  });

  it('row 3: /tab upgrade is refused with 403 for a missing or foreign Origin, a foreign Host, and any other path', async () => {
    const { helper } = await start();
    const url = `ws://127.0.0.1:${helper.port}/tab`;
    expect(await wsStatus(url)).toBe(403);                                            // no Origin header
    expect(await wsStatus(url, { origin: 'https://evil.example' })).toBe(403);
    expect(await wsStatus(url, { origin: 'http://127.0.0.1.evil.example' })).toBe(403);
    expect(await wsStatus(url, { origin: 'null' })).toBe(403);
    expect(await wsStatus(url, { origin: ORIGIN, headers: { Host: 'evil.example' } })).toBe(403);
    expect(await wsStatus(url, { origin: ORIGIN, headers: { Host: `evil.example:${helper.port}` } })).toBe(403);
    expect(await wsStatus(`ws://127.0.0.1:${helper.port}/other`, { origin: ORIGIN })).toBe(403);
    expect(await wsStatus(`ws://127.0.0.1:${helper.port}/`, { origin: ORIGIN })).toBe(403);
    expect(await wsStatus(`ws://127.0.0.1:${helper.port}/mcp`, { origin: ORIGIN })).toBe(403);
    expect(await wsStatus(url, { origin: ORIGIN })).toBe('open');                       // control: the same request from a loopback page works
    expect(await wsStatus(url, { origin: 'https://localhost:9' })).toBe(403);            // D34: a loopback page on another port
    expect(await wsStatus(url, { origin: 'http://[::1]:5173' })).toBe(403);
  });

  it('row 3: --allow-origin admits that exact origin on /tab and nothing broader', async () => {
    const { helper } = await start({ allowOrigins: ['https://editor.example'] });
    const url = `ws://127.0.0.1:${helper.port}/tab`;
    expect(await wsStatus(url, { origin: 'https://editor.example' })).toBe('open');
    expect(await wsStatus(url, { origin: 'https://editor.example:8443' })).toBe(403);
    expect(await wsStatus(url, { origin: 'https://other.example' })).toBe(403);
  });

  it('row 3: /hello with a foreign Host → 403 "Forbidden host" (also for /mcp and unknown paths)', async () => {
    const { helper } = await start();
    for (const path of ['/hello', '/mcp', '/nothing']) {
      const reply = await http(helper.port, { path, headers: { Host: 'evil.example' } });
      expect([reply.status, reply.body], path).toEqual([403, 'Forbidden host']);
    }
    const rebinding = await http(helper.port, { path: '/hello', headers: { Host: `127.0.0.1.evil.example:${helper.port}` } });
    expect(rebinding.status).toBe(403);
  });

  it('row 3: /hello grants CORS (with Vary) only to an allowed origin; others still get the plain answer without the header', async () => {
    const { helper } = await start({ allowOrigins: ['https://editor.example'] });
    const ok = await http(helper.port, { path: '/hello', headers: { Origin: ORIGIN } });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers.vary).toBe('Origin');
    expect((await http(helper.port, { path: '/hello', headers: { Origin: 'https://editor.example' } })).headers['access-control-allow-origin']).toBe('https://editor.example');
    const foreign = await http(helper.port, { path: '/hello', headers: { Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(200);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('row 3: /hello preflight — 204 with the methods and private-network grant for an allowed origin, a bare 204 otherwise; other methods → 405', async () => {
    const { helper } = await start();
    const ok = await http(helper.port, { method: 'OPTIONS', path: '/hello', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-methods']).toBe('GET');
    expect(ok.headers['access-control-allow-private-network']).toBe('true');
    const foreign = await http(helper.port, { method: 'OPTIONS', path: '/hello', headers: { Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(204);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect(foreign.headers['access-control-allow-methods']).toBeUndefined();
    const post = await http(helper.port, { method: 'POST', path: '/hello' });
    expect([post.status, post.headers.allow]).toEqual([405, 'GET']);
  });

  it('row 3: /mcp with a foreign Origin → 403 "Forbidden origin"; without an Origin (a native MCP client) it is served; unknown path → 404', async () => {
    const { helper } = await start({ allowOrigins: ['https://editor.example'] });
    const foreign = await http(helper.port, { path: '/mcp', headers: { Origin: 'https://evil.example' } });
    expect([foreign.status, foreign.body]).toEqual([403, 'Forbidden origin']);
    expect((await http(helper.port, { method: 'POST', path: '/mcp', headers: { Origin: 'null' }, body: '{}' })).status).toBe(403);
    expect((await http(helper.port, { path: '/mcp' })).status).toBe(400); // reached the MCP handler (no session)
    expect((await http(helper.port, { path: '/mcp', headers: { Origin: 'https://editor.example' } })).status).toBe(400);
    const missing = await http(helper.port, { path: '/nothing' });
    expect([missing.status, missing.body]).toEqual([404, 'Not found']);
  });

  it('row 3: the refusal sentences of the link are the fixed table', () => {
    expect(LINK_ERRORS).toEqual({
      PAIRING_REQUIRED: 'This tab is not paired with the helper. Enter the 6-digit code the helper printed.',
      PAIRING_CODE_INVALID: 'That pairing code is not valid. Check the code the helper printed and try again.',
      PAIRING_CODE_EXPIRED: 'That pairing code has expired. Ask the helper for a new code and try again.',
      PAIRING_LOCKED: 'Too many wrong pairing codes, so the helper stopped taking codes. Type “code” in the helper’s terminal for a new one, or type the code this tab shows into the helper.',
      TOKEN_INVALID: 'This tab’s pairing is unknown to the helper or was revoked. Pair again.',
      TOKEN_REVOKED: 'This tab’s pairing was revoked. Pair again to reconnect.',
      TAB_ACTIVE_ELSEWHERE: 'Another tab holds the MCP connection.',
      PROTOCOL_UNSUPPORTED: 'This helper speaks a different tab protocol version. Update the helper or the editor.',
      INVALID_MESSAGE: 'The helper could not read that message.',
    });
  });
});
