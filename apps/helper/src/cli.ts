// SPDX-License-Identifier: AGPL-3.0-only
// `npx cutframe-connect` (Contract A). Terminal mode: starts the helper, prints its port, MCP endpoint and pairing code, and
// reads commands (an editor-shown 6-digit code, code, status, revoke, quit). --stdio mode (an agent starts the helper itself):
// MCP on stdin/stdout; when a helper already answers /hello on 47820–47829 the call is relayed to its /mcp, otherwise the
// helper starts inside this process and its lines go to stderr.
import { createInterface } from 'node:readline';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { APP, DEFAULT_PORT, PORT_RANGE } from '../../web/src/agent/protocol';
import { DEFAULT_TOOL_TIMEOUT_MS, startHelper, VERSION } from './helper';
import type { Helper } from './helper';
import { createMcpSession } from './mcp';
import { defaultConfigDir, TokenStore } from './store';

export const HELP = `Usage: cutframe-connect [options]

Starts the Cutframe helper on 127.0.0.1 so an MCP client (Claude Code, Codex, ...) can edit the project open in the
Cutframe editor. The helper never reaches beyond this computer.

  --port <n>            first port to try (default ${DEFAULT_PORT}, env CUTFRAME_HELPER_PORT); the next free of ${PORT_RANGE} is used
  --stdio               serve MCP on stdin/stdout (for clients that start the helper themselves)
  --allow-origin <url>  also accept this editor origin (repeatable); needed for any page outside ports 5173 and 4173
  --config-dir <dir>    where pairing tokens are kept (env CUTFRAME_HELPER_CONFIG_DIR; default ${defaultConfigDir()})
  --tool-timeout <ms>   per-call timeout (default ${DEFAULT_TOOL_TIMEOUT_MS}, env CUTFRAME_HELPER_TOOL_TIMEOUT_MS)
  --revoke-all          forget every paired tab, then exit
  --version, --help`;
const COMMANDS = 'Commands: a 6-digit code shown in the editor, code (new pairing code), status, revoke (unpair every tab), quit.';

export type Args = { port: number; stdio: boolean; allowOrigins: string[]; configDir: string; toolTimeoutMs: number; revokeAll: boolean; help: boolean; version: boolean };
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  const int = (v: string | undefined, name: string, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  const args: Args = { port: env.CUTFRAME_HELPER_PORT ? int(env.CUTFRAME_HELPER_PORT, 'CUTFRAME_HELPER_PORT', 0, 65535) : DEFAULT_PORT, stdio: false, allowOrigins: [],
    configDir: env.CUTFRAME_HELPER_CONFIG_DIR || defaultConfigDir(), revokeAll: false, help: false, version: false,
    toolTimeoutMs: env.CUTFRAME_HELPER_TOOL_TIMEOUT_MS ? int(env.CUTFRAME_HELPER_TOOL_TIMEOUT_MS, 'CUTFRAME_HELPER_TOOL_TIMEOUT_MS', 1, 3_600_000) : DEFAULT_TOOL_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value.`); return v; };
    if (a === '--port') args.port = int(value(), '--port', 0, 65535);
    else if (a === '--stdio') args.stdio = true;
    else if (a === '--allow-origin') { const v = value(); try { args.allowOrigins.push(new URL(v).origin); } catch { throw new Error(`--allow-origin needs an origin such as https://editor.example, not '${v}'.`); } }
    else if (a === '--config-dir') args.configDir = value();
    else if (a === '--tool-timeout') args.toolTimeoutMs = int(value(), '--tool-timeout', 1, 3_600_000);
    else if (a === '--revoke-all') args.revokeAll = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else throw new Error(`Unknown option '${a}'. Run with --help for the options.`);
  }
  return args;
}

/** A helper already answering /hello in the port range (loopback only). */
async function findRunning(first: number): Promise<number | undefined> {
  if (first === 0) return undefined;
  for (let port = first; port < first + PORT_RANGE && port <= 65535; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/hello`, { signal: AbortSignal.timeout(500) });
      if (r.ok && (await r.json() as { app?: string }).app === APP) return port;
    } catch { /* nothing there */ }
  }
  return undefined;
}

/** Relays raw MCP messages between stdin/stdout and the running helper's /mcp. */
async function relay(port: number) {
  const up = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)), down = new StdioServerTransport();
  const fail = (e: unknown) => process.stderr.write(`cutframe-connect: ${(e as Error)?.message ?? e}\n`);
  down.onmessage = m => { up.send(m).catch(fail); };
  up.onmessage = m => { down.send(m).catch(fail); };
  up.onerror = fail;
  up.onclose = () => process.exit(0);
  await up.start(); await down.start();
  process.stdin.once('end', () => { void up.terminateSession().catch(() => {}).finally(() => process.exit(0)); });
  process.stderr.write(`cutframe-connect: relaying MCP to the helper on http://127.0.0.1:${port}/mcp\n`);
}

function greet(helper: Helper, log: (line: string) => void) {
  log(`Cutframe helper ${VERSION} listening on http://127.0.0.1:${helper.port}`);
  log(`MCP endpoint (Streamable HTTP): http://127.0.0.1:${helper.port}/mcp`);
  if (helper.store.count() === 0) helper.newCode();
  else log('Paired editor tabs reconnect on their own. Type `code` for a new pairing code.');
}

export async function main(argv: string[]): Promise<void> {
  let args: Args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(`cutframe-connect: ${(e as Error).message}\n`); process.exit(2); }
  if (args.help) return void process.stdout.write(HELP + '\n');
  if (args.version) return void process.stdout.write(VERSION + '\n');
  if (args.revokeAll) { const store = new TokenStore(args.configDir); store.revokeAll(); return void process.stdout.write(`Every paired tab was forgotten (${store.file}).\n`); }

  if (args.stdio) {
    const running = await findRunning(args.port);
    if (running !== undefined) return relay(running);
  }
  const log = args.stdio ? (line: string) => void process.stderr.write(line + '\n') : (line: string) => void process.stdout.write(line + '\n');
  let helper: Helper;
  try { helper = await startHelper({ port: args.port, allowOrigins: args.allowOrigins, configDir: args.configDir, toolTimeoutMs: args.toolTimeoutMs, log }); }
  catch (e) { process.stderr.write(`cutframe-connect: ${(e as Error).message}\n`); process.exit(1); }
  const stop = () => { void helper.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  greet(helper, log);

  if (args.stdio) {
    const mcp = createMcpSession(helper, VERSION, () => 'stdio');
    helper.attach(mcp);
    await mcp.server.connect(new StdioServerTransport());
    process.stdin.once('end', stop);
    return;
  }
  log(COMMANDS);
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', raw => {
    const line = raw.trim().toLowerCase();
    if (!line) return;
    if (/^\d{6}$/.test(line)) log(helper.confirmOffer(line) ? 'Paired.' : 'No editor tab is waiting with that code.');
    else if (line === 'code') helper.newCode();
    else if (line === 'status') helper.status().forEach(l => log(l));
    else if (line === 'revoke') { helper.revokeAll(); log('Every paired tab was unpaired and disconnected.'); }
    else if (line === 'quit' || line === 'exit') stop();
    else log(COMMANDS);
  });
}
