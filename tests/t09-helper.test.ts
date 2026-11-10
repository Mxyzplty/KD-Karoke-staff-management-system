// SPDX-License-Identifier: AGPL-3.0-only
// M5: production MCP HTTP helper -> paired WebSocket tab -> real Executor -> real caption bus and readback.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { startHelper } from '../apps/helper/src/helper';
import { newToken } from '../apps/helper/src/store';
import { Executor } from '../apps/web/src/agent/executor';
import { PROTOCOL } from '../apps/web/src/agent/protocol';
import { createEditor } from '../apps/web/src/timeline/harness';
import { callTool } from '../apps/web/src/timeline/tools';
import { build, mkTrack, video } from './t03-fixtures';

it('M5 connected caption templates/read/write/flat restyle/applyToAll and undo reach the real caption runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't09-helper-'));
  const helper = await startHelper({ port: 0, configDir: dir, log: () => {} });
  const e = createEditor(build({ tracks: [mkTrack('V1', 'video'), mkTrack('C1', 'caption')], items: [video('v1', 'V1', 0, 4000, 0, 4000)] }));
  const transcript = { language: 'en', languages: ['en'], total_duration: 4, segments: [{ id: 0, start: .2, end: 2.4, speaker: 0, text: 'hello world', words: [{ word: 'hello', start: .2, end: .6 }, { word: 'world', start: 2, end: 2.4 }] }] };
  expect(callTool({ bus: e.bus, asset: () => undefined, captionData: () => ({ status: 'complete', transcript, music: false }) }, 'addCaptions', { trackId: 'C1', maxWords: 1 }).success).toBe(true);
  const initial = structuredClone(e.doc), id = e.doc.items.find(i => i.type === 'caption')!.id;
  const store = new Map<string, string>();
  const ex = new Executor({ storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } }, current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
  const token = newToken(); helper.store.add(token, 't09-tab');
  const ws = new WebSocket(`ws://127.0.0.1:${helper.port}/tab`, { origin: 'http://127.0.0.1:4173' });
  const client = new Client({ name: 't09', version: '1' });
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const hello = new Promise<void>((resolve, reject) => ws.on('message', async raw => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hello') { if (msg.active && msg.paired) resolve(); else reject(new Error(JSON.stringify(msg))); }
      if (msg.type === 'call') ws.send(JSON.stringify({ type: 'result', callId: msg.callId, result: await ex.execute(msg) }));
    }));
    ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 't09-tab', token })); await hello;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
    const call = async (name: string, args = {}) => { const response = await client.callTool({ name, arguments: args }); const r = JSON.parse((response.content as { text: string }[])[0].text); expect(r.success, JSON.stringify(r)).toBe(true); return r; };
    expect((await call('listCaptionTemplates')).data.templates).toHaveLength(9);
    await call('context');
    await call('editProperties', { itemId: id, properties: { text: 'HELLO', color: '#123456' }, applyToAll: true });
    expect(e.doc.items.filter(i => i.type === 'caption').map(i => i.properties.color.defaultValue)).toEqual(['#123456', '#123456']);
    expect(e.doc.items.find(i => i.id === id)!.details.text).toBe('HELLO');
    expect((await call('viewItemDetails', { itemId: id })).data.caption).toMatchObject({ mode: 'linked', wordCount: 1 });
    const corrected = structuredClone(e.doc);
    expect((await call('editAllCaptionStyles', { trackId: 'C1', renderMode: 'highlight', highlightColor: '#00FF00' })).data.updatedCount).toBe(2);
    expect(e.doc.items.filter(i => i.type === 'caption').every(i => i.details.renderMode === 'highlight' && i.details.renderConfig.highlightColor === '#00FF00')).toBe(true);
    expect((await call('viewItemDetails', { itemId: id })).data.caption).toMatchObject({ renderMode: 'highlight', renderConfig: { highlightColor: '#00FF00' } });
    e.bus.undo('user'); expect(e.doc).toEqual(corrected);
    e.bus.undo('user'); expect(e.doc).toEqual(initial);
    expect((await call('viewItemDetails', { itemId: id })).data.caption.renderMode).toBe('default');
    expect(e.labels()).toEqual(['Add captions']);
  } finally { await client.close(); ws.terminate(); await helper.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);
