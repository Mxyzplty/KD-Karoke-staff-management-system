// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 13 / H1–H2: agent schemas, unchanged tab forwarding, and MCP discovery/refusals over HTTP and stdio.
// Oracles are the handoff's literal schemas/error envelopes, not helper or handler results. The tab supplies fixture results.
// Small harness helpers copied from t18a-helper/t18a-calls; those files are not imported or edited. No author-run commands/tests.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Helper, startHelper } from '../apps/helper/src/helper';
import { TOOLS, validate } from '../apps/helper/src/schemas';
import { newToken } from '../apps/helper/src/store';
import { NOT_CONNECTED_ERROR, PROTOCOL, READ_ONLY, SERVED_TOOLS } from '../apps/web/src/agent/protocol';
import { fonts } from '../apps/web/src/catalogue/fonts';
import { CATEGORIES } from '../apps/web/src/presets/model';

type Rec = Record<string, any>;
type InputError = { path: string; code: string; message: string };
const ORIGIN = 'http://127.0.0.1:4173', BIN = fileURLToPath(new URL('../apps/helper/bin/cutframe-connect.mjs', import.meta.url)), ROOT = fileURLToPath(new URL('..', import.meta.url));
const NEW_TOOLS = ['applyPreset', 'browsePresets', 'fonts'] as const;
const CATEGORY_SLUGS = ['text', 'title-cards', 'lower-thirds', 'info-cards', 'slide-in-panels', 'misc', 'overlays', 'collages'];
const ENUM_MESSAGE = 'must be equal to one of the allowed values';
const invalid = (tool: string, errors: InputError[]) => ({ success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}`,
  message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors } });
const notConnected = { success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR };

// Each running test owns its ephemeral port, config directory, sockets and MCP client/process.
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 't22-helper-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
async function start() {
  const helper = await startHelper({ port: 0, configDir: tmp(), log: () => {}, toolTimeoutMs: 10_000, pingMs: 60_000 });
  cleanups.push(() => helper.close()); return helper;
}
/** Ordered inbox, as in t18a-calls. No editor implementation is substituted for the fake tab's answer. */
class RawTab {
  inbox: Rec[] = [];
  private wake?: () => void;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', data => { this.inbox.push(JSON.parse(String(data))); this.wake?.(); }); ws.on('error', () => {});
  }
  static async open(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tab`, { origin: ORIGIN }); cleanups.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); }); return new RawTab(ws);
  }
  send(message: unknown) { this.ws.send(JSON.stringify(message)); }
  async next(type: string, ms = 3000): Promise<Rec> {
    const end = Date.now() + ms;
    while (!this.inbox.length) {
      if (Date.now() > end) throw new Error(`no ${type} within ${ms} ms`);
      await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, 20); });
    }
    const message = this.inbox.shift()!; expect(message.type, JSON.stringify(message)).toBe(type); return message;
  }
  async quiet() { await new Promise(resolve => setTimeout(resolve, 80)); expect(this.inbox).toEqual([]); }
}
async function activeTab(helper: Helper) {
  const token = newToken(), tabId = 't22-tab'; helper.store.add(token, tabId); const tab = await RawTab.open(helper.port);
  tab.send({ type: 'hello', protocol: PROTOCOL, projectId: 't22-project', tabId, token }); expect(await tab.next('hello')).toMatchObject({ paired: true, active: true }); return tab;
}
async function mcpClient(helper: Helper) {
  const client = new Client({ name: 't22-tests', version: '0' }, { capabilities: {} });
  cleanups.push(() => client.close()); await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`))); return client;
}
async function stdioClient(helper?: Helper) {
  // With a helper: the real CLI's stdio relay reaches its paired fake tab. Without: the client starts a fresh helper.
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, '--stdio', '--port', String(helper?.port ?? 0), '--config-dir', tmp()], cwd: ROOT, stderr: 'pipe' });
  transport.stderr!.on('data', () => {}); const client = new Client({ name: 't22-tests', version: '0' }, { capabilities: {} });
  cleanups.push(() => client.close()); await client.connect(transport); return client;
}
const definition = (name: string) => { const tool = TOOLS.find(t => t.name === name); expect(tool, `${name} is advertised`).toBeDefined(); return tool!; };
const SHAPES: { name: string; properties: Rec; required: string[] }[] = [
  { name: 'applyPreset', properties: { presetId: { type: 'string' }, timelineStart: { type: 'number', minimum: 0 } }, required: ['presetId'] },
  { name: 'browsePresets', properties: { category: { enum: CATEGORY_SLUGS }, query: { type: 'string' } }, required: [] },
  { name: 'fonts', properties: { familyName: { type: 'string' }, role: { enum: ['titles', 'captions'] }, videoStyle: { type: 'string' } }, required: [] },
];
function schemaContract(name: string, inputSchema: unknown) {
  const expected = SHAPES.find(s => s.name === name)!, schema = inputSchema as Rec;
  expect(schema).toMatchObject({ type: 'object', additionalProperties: false }); expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(expected.properties).sort());
  expect(schema.properties).toMatchObject(expected.properties); expect(schema.required ?? []).toEqual(expected.required);
}
const VALID: { label: string; tool: string; input: Rec }[] = [
  { label: 'applyPreset with required presetId only', tool: 'applyPreset', input: { presetId: 'x' } },
  { label: 'applyPreset at zero', tool: 'applyPreset', input: { presetId: 'x', timelineStart: 0 } },
  { label: 'applyPreset at fractional seconds', tool: 'applyPreset', input: { presetId: 'x', timelineStart: 2.5 } },
  { label: 'browsePresets with no filters', tool: 'browsePresets', input: {} },
  { label: 'browsePresets with query only', tool: 'browsePresets', input: { query: 'heading' } },
  { label: 'browsePresets with both filters', tool: 'browsePresets', input: { category: 'text', query: 'heading' } },
  ...CATEGORY_SLUGS.map(category => ({ label: `browsePresets category ${category}`, tool: 'browsePresets', input: { category } })),
  { label: 'fonts with no filters', tool: 'fonts', input: {} },
  { label: 'fonts with familyName only', tool: 'fonts', input: { familyName: 'Roboto' } },
  { label: 'fonts with titles role only', tool: 'fonts', input: { role: 'titles' } },
  { label: 'fonts with captions role only', tool: 'fonts', input: { role: 'captions' } },
  { label: 'fonts with videoStyle only', tool: 'fonts', input: { videoStyle: 'Cinema' } },
  { label: 'fonts with all optional fields', tool: 'fonts', input: { familyName: 'Roboto', role: 'titles', videoStyle: 'not-a-template' } },
];
const REFUSED: { label: string; tool: string; input: Rec; errors: InputError[] }[] = [
  { label: 'applyPreset without presetId', tool: 'applyPreset', input: {}, errors: [{ path: '$.presetId', code: 'REQUIRED', message: "must have required property 'presetId'" }] },
  { label: 'applyPreset with non-text presetId', tool: 'applyPreset', input: { presetId: 5 }, errors: [{ path: '$.presetId', code: 'TYPE', message: 'must be string' }] },
  { label: 'applyPreset with negative timelineStart', tool: 'applyPreset', input: { presetId: 'x', timelineStart: -1 }, errors: [{ path: '$.timelineStart', code: 'MINIMUM', message: 'must be >= 0' }] },
  { label: 'applyPreset with non-number timelineStart', tool: 'applyPreset', input: { presetId: 'x', timelineStart: '1' }, errors: [{ path: '$.timelineStart', code: 'TYPE', message: 'must be number' }] },
  { label: 'applyPreset with an extra key', tool: 'applyPreset', input: { presetId: 'x', extra: true }, errors: [{ path: '$.extra', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }] },
  { label: 'browsePresets with unknown category', tool: 'browsePresets', input: { category: 'stickers' }, errors: [{ path: '$.category', code: 'ENUM', message: ENUM_MESSAGE }] },
  { label: 'browsePresets with non-text query', tool: 'browsePresets', input: { query: 5 }, errors: [{ path: '$.query', code: 'TYPE', message: 'must be string' }] },
  { label: 'browsePresets with an extra key', tool: 'browsePresets', input: { extra: true }, errors: [{ path: '$.extra', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }] },
  { label: 'fonts with unknown role', tool: 'fonts', input: { role: 'body' }, errors: [{ path: '$.role', code: 'ENUM', message: ENUM_MESSAGE }] },
  { label: 'fonts with non-text familyName', tool: 'fonts', input: { familyName: 5 }, errors: [{ path: '$.familyName', code: 'TYPE', message: 'must be string' }] },
  { label: 'fonts with non-text videoStyle', tool: 'fonts', input: { videoStyle: 5 }, errors: [{ path: '$.videoStyle', code: 'TYPE', message: 'must be string' }] },
  { label: 'fonts with an extra key', tool: 'fonts', input: { extra: true }, errors: [{ path: '$.extra', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }] },
];

describe('H1: T22 agent schemas and discovery metadata', () => {
  it('46 helper tools include all three T22 tools in the required served positions, also present in SERVED_TOOLS', () => {
    const names = TOOLS.map(t => t.name); expect(TOOLS).toHaveLength(46); expect(new Set(names).size).toBe(46);
    for (const tool of NEW_TOOLS) { expect(names).toContain(tool); expect(SERVED_TOOLS).toContain(tool); }
    for (const order of [names, [...SERVED_TOOLS]]) for (const [before, after] of [['addText', 'applyPreset'], ['applyTransition', 'browsePresets'], ['editProperties', 'fonts']]) {
      expect(order.indexOf(before)).toBeGreaterThanOrEqual(0); expect(order.indexOf(after)).toBe(order.indexOf(before) + 1);
    }
  });
  it('browsePresets and fonts are read-only; applyPreset is not', () => {
    expect(READ_ONLY.has('browsePresets')).toBe(true); expect(READ_ONLY.has('fonts')).toBe(true); expect(READ_ONLY.has('applyPreset')).toBe(false);
  });
  it.each(NEW_TOOLS)('%s advertises exactly its closed input fields and declared required/type/range/enum constraints', name => { schemaContract(name, definition(name).inputSchema); });
  it('the browsePresets category enum is exactly the eight written slugs and exactly CATEGORIES', () => {
    expect((definition('browsePresets').inputSchema.properties as Rec).category.enum).toEqual(CATEGORY_SLUGS); expect(CATEGORIES.map(c => c.slug)).toEqual(CATEGORY_SLUGS);
  });
  it.each(VALID)('$label passes validate unchanged', ({ tool, input }) => {
    const before = structuredClone(input); expect(validate(tool, input)).toBeNull(); expect(input).toEqual(before);
  });
  it.each(REFUSED)('$label returns the exact INVALID_TOOL_INPUT envelope without rewriting input', ({ tool, input, errors }) => {
    const before = structuredClone(input); expect(validate(tool, input)).toEqual(invalid(tool, errors)); expect(input).toEqual(before);
  });
  it('catalogue asset and element-edit descriptions name their keys, and element/sound ids plus colors/media slot arrays pass the schema', () => {
    const media = definition('addMedia').inputSchema.properties as Rec, edit = definition('editProperties').inputSchema.properties as Rec;
    expect(media.assetId.description).toContain('element:<id>'); expect(media.assetId.description).toContain('sound:<slug>');
    expect(edit.properties.description).toContain('colors'); expect(edit.properties.description).toContain('media');
    for (const assetId of ['element:x', 'sound:x']) expect(validate('addMedia', { assetId })).toBeNull();
    expect(validate('editProperties', { itemId: 'v1', properties: { colors: ['#112233', null], media: ['video_1', null] } })).toBeNull();
  });
  it('fonts handler and helper agree on single and combined invalid fields, including familyName/role/videoStyle error order', () => {
    const cases: { input: Parameters<typeof fonts>[0]; errors: InputError[] }[] = [
      { input: { familyName: 5 }, errors: [{ path: '$.familyName', code: 'TYPE', message: 'must be string' }] },
      { input: { familyName: { toString: null } }, errors: [{ path: '$.familyName', code: 'TYPE', message: 'must be string' }] },
      { input: { role: 'toString' }, errors: [{ path: '$.role', code: 'ENUM', message: ENUM_MESSAGE }] },
      { input: { videoStyle: 5 }, errors: [{ path: '$.videoStyle', code: 'TYPE', message: 'must be string' }] },
      { input: { videoStyle: [], role: null }, errors: [{ path: '$.role', code: 'ENUM', message: ENUM_MESSAGE }, { path: '$.videoStyle', code: 'TYPE', message: 'must be string' }] },
      { input: { videoStyle: {}, role: 'body', familyName: null }, errors: [{ path: '$.familyName', code: 'TYPE', message: 'must be string' }, { path: '$.role', code: 'ENUM', message: ENUM_MESSAGE }, { path: '$.videoStyle', code: 'TYPE', message: 'must be string' }] },
    ];
    for (const { input, errors } of cases) {
      const before = structuredClone(input), expected = invalid('fonts', errors); expect(fonts(input)).toEqual(expected); expect(validate('fonts', input)).toEqual(expected);
      expect(fonts(input)).toEqual(validate('fonts', input)); expect(input).toEqual(before);
    }
  });
});

const FORWARDED: { label: string; tool: string; input: Rec }[] = [
  { label: 'browsePresets text category', tool: 'browsePresets', input: { category: 'text' } },
  { label: 'applyPreset at one second', tool: 'applyPreset', input: { presetId: 'x', timelineStart: 1 } },
  { label: 'fonts titles role', tool: 'fonts', input: { role: 'titles' } },
  { label: 'addMedia element id', tool: 'addMedia', input: { assetId: 'element:x' } },
  { label: 'addMedia sound id', tool: 'addMedia', input: { assetId: 'sound:x' } },
  { label: 'editProperties colors slots', tool: 'editProperties', input: { itemId: 'v1', properties: { colors: ['#112233', null] } } },
  { label: 'editProperties media slots', tool: 'editProperties', input: { itemId: 'v1', properties: { media: ['video_1', null] } } },
];
describe.each(['Streamable HTTP', 'stdio relay'] as const)('H2: unchanged tab forwarding over %s', transport => {
  it.each(FORWARDED)('$label reaches the tab unchanged and returns its fixture result unchanged', async ({ label, tool, input }) => {
    const helper = await start(), tab = await activeTab(helper), client = transport === 'Streamable HTTP' ? await mcpClient(helper) : await stdioClient(helper), before = structuredClone(input);
    const pending = client.callTool({ name: tool, arguments: input }), message = await tab.next('call'); expect({ toolName: message.toolName, input: message.input }).toEqual({ toolName: tool, input });
    const result = { success: true, data: { fixture: label, echo: input, flags: [true, false, null] }, marker: 'from the fake tab' };
    tab.send({ type: 'result', callId: message.callId, result }); const answer = await pending;
    expect(answer.isError).toBeUndefined(); expect(answer.content).toEqual([{ type: 'text', text: JSON.stringify(result) }]); expect(input).toEqual(before); await tab.quiet();
  }, 40_000);
});
describe('H2: schema and missing-tab refusals', () => {
  it.each(NEW_TOOLS)('%s schema refusal never reaches an active tab', async tool => {
    const helper = await start(), tab = await activeTab(helper), client = await mcpClient(helper), row = REFUSED.find(r => r.tool === tool)!;
    const answer = await client.callTool({ name: tool, arguments: row.input }); expect(answer.isError).toBe(true);
    expect(answer.content).toEqual([{ type: 'text', text: JSON.stringify(invalid(tool, row.errors)) }]); await tab.quiet();
  });
  it.each(NEW_TOOLS)('%s with valid input and no tab answers TAB_NOT_CONNECTED directly and over MCP', async tool => {
    const helper = await start(), row = FORWARDED.find(r => r.tool === tool)!; expect(await helper.call(tool, row.input, undefined)).toEqual(notConnected);
    const client = await mcpClient(helper), answer = await client.callTool({ name: tool, arguments: row.input }); expect(answer.isError).toBe(true);
    expect(answer.content).toEqual([{ type: 'text', text: JSON.stringify(notConnected) }]);
  });
});
describe.each(['Streamable HTTP', 'stdio'] as const)('H2: MCP discovery and refusal over %s', transport => {
  async function client() { return transport === 'Streamable HTTP' ? mcpClient(await start()) : stdioClient(); }
  it('tools/list advertises all three T22 tools with their exact closed inputSchema', async () => {
    const connection = await client(), { tools } = await connection.listTools(); expect(tools).toHaveLength(46);
    for (const name of NEW_TOOLS) {
      const tool = tools.find(t => t.name === name); expect(tool, name).toBeDefined(); expect(tool!.inputSchema).toEqual(definition(name).inputSchema); schemaContract(name, tool!.inputSchema);
    }
    const order = tools.map(t => t.name);
    for (const [before, after] of [['addText', 'applyPreset'], ['applyTransition', 'browsePresets'], ['editProperties', 'fonts']]) expect(order.indexOf(after)).toBe(order.indexOf(before) + 1);
  }, 40_000);
  it('browsePresets stickers is isError:true with exactly one JSON-text INVALID_TOOL_INPUT block', async () => {
    const connection = await client(), answer = await connection.callTool({ name: 'browsePresets', arguments: { category: 'stickers' } });
    expect(answer.isError).toBe(true); expect(answer.content).toEqual([{ type: 'text', text: JSON.stringify(invalid('browsePresets', [{ path: '$.category', code: 'ENUM', message: ENUM_MESSAGE }])) }]);
  }, 40_000);
});
