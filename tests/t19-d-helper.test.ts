// SPDX-License-Identifier: AGPL-3.0-only
// T19 D: the T19 tools through the real helper (ws tab + MCP client) into a tab backed by the real Executor + Ledger over a real T03
// runtime. Store rows, rhythm and sync offset are faked via the `analysis` option. Synthetic data only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startHelper } from '../apps/helper/src/helper';
import type { Helper } from '../apps/helper/src/helper';
import { newToken } from '../apps/helper/src/store';
import { Executor } from '../apps/web/src/agent/executor';
import { PROTOCOL, SERVED_TOOLS } from '../apps/web/src/agent/protocol';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, fixture, links } from './t03-fixtures';

type Rec = Record<string, any>;
const ORIGIN = 'http://127.0.0.1:4173';
const REQUIRED = (name: string) => `must have required property '${name}'`;
const invalid = (tool: string, errors: { path: string; code: string; message: string }[]) => ({
  success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}`, message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors },
});

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const word = (w: string, start: number) => ({ word: w, start, end: start + 0.4 });
const ONE = 'alpha beta gamma delta epsilon zeta'.split(' ').map((w, i) => word(w, i * 0.5)); // asset-vid1 (video_1)
const TWO = 'red orange yellow green'.split(' ').map((w, i) => word(w, i * 0.5)); // asset-vid2 (video_2)
const rowOf = (id: string, words: Rec[]) => ({ id, status: 'complete', transcript: { words }, created_at: 'x' });
const BEAT_LIST: [number, number][] = Array.from({ length: 16 }, (_, i) => [0.5 * (i + 1), i % 2 === 0 ? 0.9 : 0.4]);
const RHYTHM = { bpm: 120, averageBpm: 118, beats: BEAT_LIST, downbeats: [[0.5, 0.9], [2.5, 0.9], [4.5, 0.9], [6.5, 0.9]], silences: [] };
const rhythmRow = (id: string) => ({ id, analysis: { stored: RHYTHM, tab: { bpm: 120, beats: BEAT_LIST, onsets: [], silences: [], firstBeat: 0.5, tempoType: 'constant' } }, created_at: '2026-11-02T00:00:00Z' });

/** The real helper, one paired + active ws tab that answers every call with the real Executor, and the calls it received. */
async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 't19-d-helper-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const helper: Helper = await startHelper({ port: 0, log: () => {}, configDir: dir, toolTimeoutMs: 5000 });
  cleanups.push(() => helper.close());

  const rows: Rec = { transcripts: { 'asset-vid1': rowOf('asset-vid1', ONE), 'asset-vid2': rowOf('asset-vid2', TWO) } };
  const service = { rhythm: vi.fn(async (_s: unknown, a: { id: string }) => rhythmRow(a.id)), syncOffset: vi.fn(async (..._a: unknown[]) => ({ offset: 1, confidence: 0.8, matches: [{}, {}, {}, {}] })) };
  const store = { row: vi.fn(async (s: string, id: string) => rows[s]?.[id]), putRow: async () => {}, media: {} };
  const editor = createEditor(fixture(), { assets: assets(), links: links() });
  const data = new Map<string, string>();
  const executor = new Executor({ storage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } }, current: () => editor.runtime,
    ui: () => ({ selection: [], playheadMs: 0 }), analysis: (async () => ({ store, service })) as never });

  const received: Rec[] = [];
  const token = newToken();
  helper.store.add(token, 'tab-a');
  const ws = new WebSocket(`ws://127.0.0.1:${helper.port}/tab`, { origin: ORIGIN });
  cleanups.push(() => ws.terminate());
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const hello = new Promise<Rec>(resolve => ws.on('message', function first(d) { const m = JSON.parse(String(d)); if (m.type === 'hello') { ws.off('message', first); resolve(m); } }));
  ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-a', token }));
  expect(await hello).toMatchObject({ paired: true, active: true });
  ws.on('message', async d => {
    const m = JSON.parse(String(d));
    if (m.type !== 'call') return;
    received.push(m);
    ws.send(JSON.stringify({ type: 'result', callId: m.callId, result: await executor.execute(m) }));
  });

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`));
  const client = new Client({ name: 't19-d', version: '0' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  const mcp = async (name: string, args: Rec) => JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text) as Rec;
  const onTrack = (id: string) => editor.runtime.bus.doc.items.filter(i => i.trackId === id);
  return { helper, editor, service, store, received, mcp, onTrack, call: (tool: string, input: Rec, session = 'sess-1') => helper.call(tool, input, session) as Promise<Rec> };
}

describe('T19 D through the helper: viewItemDetails', () => {
  it('include transcript for a timeline item: the item\'s words in timeline seconds; the call reaches the tab as it was sent', async () => {
    const r = await rig();
    const res = await r.call('viewItemDetails', { itemId: 'v1', include: ['transcript'] });
    expect(res).toMatchObject({ success: true });
    expect(res.data.id).toBe('v1');
    expect(res.data.transcription).toBeDefined();
    expect(r.received).toHaveLength(1);
    expect(r.received[0]).toMatchObject({ toolName: 'viewItemDetails', input: { itemId: 'v1', include: ['transcript'] }, session: 'sess-1' });
  });
  it('include as a comma string, for an asset id', async () => {
    const r = await rig();
    const res = await r.call('viewItemDetails', { assetId: 'video_1', include: 'transcript' });
    expect(res).toMatchObject({ success: true });
    expect(res.data.transcription).toBeDefined();
  });
  it('include beats: bpm and first downbeat; with beatsFrom/beatsTo the window with beats, downbeats and subdivisions', async () => {
    const r = await rig();
    expect(await r.call('viewItemDetails', { assetId: 'audio_1', include: ['beats'] })).toEqual({ success: true, data: { beats: { bpm: 120, firstDownbeat: 0.5 } } });
    const win = await r.call('viewItemDetails', { assetId: 'audio_1', include: ['beats'], beatsFrom: 2, beatsTo: 4, subdivisionsPerBeat: 2 });
    expect(win.success).toBe(true);
    expect(win.data.beats).toMatchObject({ bpm: 120, firstDownbeat: 0.5 });
    expect(win.data.beats.subdivisions.divisionsPerBeat).toBe(2);
    expect(r.service.rhythm).toHaveBeenCalled();
  });
  it('a successful view marks the timeline as read: a gated tool passes afterwards in the same session, not in another', async () => {
    const r = await rig();
    expect(await r.call('moveItem', { itemId: 'v3', by: 1 })).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED' }); // the refusal counts as a read
    const fresh = await rig();
    expect(await fresh.call('viewItemDetails', { itemId: 'v1', include: ['transcript'] }, 'sess-2')).toMatchObject({ success: true });
    expect(await fresh.call('moveItem', { itemId: 'v3', by: 1 }, 'sess-2')).toMatchObject({ success: true });
    expect(await fresh.call('moveItem', { itemId: 'v3', by: 1 }, 'sess-3')).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED' });
  });
  it('an unknown item is the tool\'s own failure result, passed through the helper unchanged', async () => {
    const r = await rig();
    expect(await r.call('viewItemDetails', { itemId: 'no-such-item', include: ['transcript'] })).toMatchObject({ success: false });
  });
  it('through MCP: the result is the same JSON as one text content', async () => {
    const r = await rig();
    expect(await r.mcp('viewItemDetails', { assetId: 'audio_1', include: ['beats'] })).toEqual({ success: true, data: { beats: { bpm: 120, firstDownbeat: 0.5 } } });
  });
});

describe('T19 D through the helper: syncAndSwap', () => {
  const INPUT = { sourceAssetId: 'video_2', targetItemId: 'v1', trackId: 'V2', from: 0, to: 4 };
  it('success without a prior read: sync fields on the envelope, one item on the track, the sync computed once', async () => {
    const r = await rig();
    const res = await r.call('syncAndSwap', INPUT);
    expect(res).toMatchObject({ success: true, syncOffset: 1, syncConfidence: 0.8, syncMatches: 4 });
    expect(res.data.addedItemIds).toHaveLength(1);
    expect(r.onTrack('V2')).toHaveLength(1);
    expect(r.onTrack('V2')[0]).toMatchObject({ display: { from: 0, to: 4000 }, trim: { from: 1000, to: 5000 }, metadata: { assetId: 'asset-vid2' } });
    expect(r.service.syncOffset).toHaveBeenCalledTimes(1);
    expect(r.editor.runtime.bus.undoStack.map(e => e.label)).toEqual(['Add media']);
  });
  it('a refusal from the tool (unknown target item) changes nothing', async () => {
    const r = await rig();
    const res = await r.call('syncAndSwap', { ...INPUT, targetItemId: 'no-such-item' });
    expect(res).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
    expect(r.onTrack('V2')).toHaveLength(0); expect(r.editor.runtime.bus.undoStack).toHaveLength(0);
    expect(r.service.syncOffset).not.toHaveBeenCalled();
  });
  it('through MCP: sync fields and the placed item', async () => {
    const r = await rig();
    expect(await r.mcp('syncAndSwap', INPUT)).toMatchObject({ success: true, syncOffset: 1, syncConfidence: 0.8, syncMatches: 4 });
    expect(r.onTrack('V2')).toHaveLength(1);
  });
});

describe('T19 D through the helper: addMedia transcriptRange', () => {
  const ADD = { trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma delta' } };
  it('the read gate applies: refused with STALE_READ_REFRESHED before the first read; after a context read the range resolves and is placed', async () => {
    const r = await rig();
    expect(await r.call('addMedia', ADD)).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', scope: 'timeline' });
    expect(r.store.row).not.toHaveBeenCalled(); expect(r.onTrack('V2')).toHaveLength(0);
    const range = { trimStart: 1, trimEnd: 1.9, duration: 0.9, wordCount: 2, matchedText: 'gamma delta' };
    const res = await r.call('addMedia', ADD);
    expect(res).toMatchObject({ success: true, message: 'Successfully added 1 media item to timeline' });
    expect(res.data.resolvedTranscriptRanges).toEqual([range]);
    expect(res.data.results[0]).toMatchObject({ resolvedTrim: { start: 1, end: 1.9, duration: 0.9 }, resolvedTranscriptRange: range });
    expect(r.onTrack('V2')[0]).toMatchObject({ display: { from: 0, to: 900 }, trim: { from: 1000, to: 1900 } });
  });
  it('a batch of items, ranges and plain trims', async () => {
    const r = await rig();
    await r.call('context', {});
    const res = await r.call('addMedia', { trackId: 'V2', timelineStart: 0, items: [{ assetId: 'video_1', transcriptRange: { startText: 'beta', endText: 'delta' } }, { assetId: 'video_2', trimStart: 1, trimEnd: 3 }] });
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(res.data.resolvedTranscriptRanges).toHaveLength(1);
    expect(res.data.resolvedTranscriptRanges[0]).toMatchObject({ trimStart: 0.5, trimEnd: 1.9, wordCount: 3, matchedText: 'beta gamma delta' });
    expect(r.onTrack('V2').map(i => [i.display.from, i.display.to])).toEqual([[0, 1400], [1400, 3400]]);
    expect(r.editor.runtime.bus.undoStack.filter(e => e.label === 'Add media')).toHaveLength(1);
  });
  it('range failures come through the helper with the registry code and details; the document is unchanged', async () => {
    const r = await rig();
    await r.call('context', {});
    expect(await r.call('addMedia', { ...ADD, transcriptRange: { text: 'gamma epsilon' } })).toMatchObject({ success: false, code: 'TRANSCRIPT_RANGE_NOT_FOUND', details: { assetId: 'video_1' } });
    expect(await r.call('addMedia', { ...ADD, assetId: 'audio_1' })).toMatchObject({ success: false, code: 'TRANSCRIPT_UNAVAILABLE' });
    expect(await r.call('addMedia', { ...ADD, trimStart: 1 })).toMatchObject({ success: false, code: 'INVALID_COMBINATION' });
    expect(r.onTrack('V2')).toHaveLength(0); expect(r.editor.runtime.bus.undoStack).toHaveLength(0);
  });
  it('the call reaches the tab with an mcp: executionKey and adds exactly one item', async () => {
    const r = await rig();
    await r.call('context', {});
    const first = await r.call('addMedia', ADD);
    expect(first.success).toBe(true);
    const sent = r.received.at(-1)!;
    expect(sent.executionKey).toMatch(/^mcp:/);
    expect(r.onTrack('V2')).toHaveLength(1);
  });
});

describe('T19 D through the helper: schema refusals (INVALID_TOOL_INPUT) never reach the tab', () => {
  const ENUM_MSG = 'must be equal to one of the allowed values';
  // T10 (C8 assertion-only edit): writeEffects is served too, so the list has 24. T06 (C8): + addShape, writeShapePoints = 26. T07 (C8): + addLayout, editLayout = 28. T11 (C8): + applyTransition = 29. T05: + addText = 30. T12 (C8): + createMask, editMaskProperties, removeMask, writeMaskPoints = 34. T12 smart masks (C8): + viewMaskFrame, previewSmartMask, trackSmartMask, removeBackground = 38. T21: + getHelpSection, searchHelpDocs = 40.
  it('the 40 served tools include the two new ones, in the retained protocol list', () => {
    expect(SERVED_TOOLS).toHaveLength(40);
    expect(SERVED_TOOLS).toContain('syncAndSwap'); expect(SERVED_TOOLS).toContain('viewItemDetails');
  });
  const TABLE: [string, Rec, { path: string; code: string; message: string }[]][] = [
    ['viewItemDetails', { itemId: 'v1', subdivisionsPerBeat: 5 }, [{ path: '$.subdivisionsPerBeat', code: 'ENUM', message: ENUM_MSG }]],
    ['viewItemDetails', { itemId: 'v1', minStrength: 2 }, [{ path: '$.minStrength', code: 'MAXIMUM', message: 'must be <= 1' }]],
    ['viewItemDetails', { itemId: 'v1', beatsFrom: '1' }, [{ path: '$.beatsFrom', code: 'TYPE', message: 'must be number' }]],
    ['viewItemDetails', { itemId: 'v1', extra: true }, [{ path: '$.extra', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }]],
    ['syncAndSwap', { sourceAssetId: 'video_2', targetItemId: 'v1', trackId: 'V2', from: 0 }, [{ path: '$.to', code: 'REQUIRED', message: REQUIRED('to') }]],
    ['syncAndSwap', { sourceAssetId: 'video_2', targetItemId: 'v1', trackId: 'V2', from: '0', to: 4 }, [{ path: '$.from', code: 'TYPE', message: 'must be number' }]],
    ['syncAndSwap', {}, ['sourceAssetId', 'targetItemId', 'trackId', 'from', 'to'].map(n => ({ path: `$.${n}`, code: 'REQUIRED', message: REQUIRED(n) }))],
    ['addMedia', { assetId: 'video_1', transcriptRange: { text: 5 } }, [{ path: '$.transcriptRange.text', code: 'TYPE', message: 'must be string' }]],
    ['addMedia', { assetId: 'video_1', transcriptRange: { words: 'x' } }, [{ path: '$.transcriptRange.words', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }]],
  ];
  it.each(TABLE)('%s %j → the exact detail shape; the tab sees no call', async (tool, input, errors) => {
    const r = await rig();
    expect(await r.call(tool, input)).toEqual(invalid(tool, errors));
    expect(await r.mcp(tool, input)).toEqual(invalid(tool, errors));
    expect(r.received).toHaveLength(0);
  });
  it('valid input to the new tools is not refused by the schema (it reaches the tab)', async () => {
    const r = await rig();
    await r.call('viewItemDetails', { itemId: 'v1', include: ['beats'], beatsFrom: 0, beatsTo: 1, minStrength: 0.5, subdivisionsPerBeat: 3 });
    await r.call('syncAndSwap', { sourceAssetId: 'video_2', targetItemId: 'v1', trackId: 'V2', from: 0, to: 4 });
    await r.call('addMedia', { assetId: 'video_1', transcriptRange: { startText: 'a', endText: 'b' } });
    expect(r.received.map(m => m.toolName)).toEqual(['viewItemDetails', 'syncAndSwap', 'addMedia']);
  });
});
