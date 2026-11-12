// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger rows 5 (e2e retransmit), 6 (schemas), 7 (envelopes, serialization), 8 (resource) and the helper side of 9 (takeover codes):
// the helper's call path, driven by raw ws tabs and a real MCP client over Streamable HTTP, plus one tab simulator that runs the
// real Executor + Ledger over a real T03 runtime.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Helper, startHelper } from '../apps/helper/src/helper';
import { validate } from '../apps/helper/src/schemas';
import { newToken } from '../apps/helper/src/store';
import { Executor } from '../apps/web/src/agent/executor';
import { Ledger } from '../apps/web/src/agent/ledger';
import { DISCONNECTED_ERROR, EASING_NAMES, LINK_ERRORS, NOT_CONNECTED_ERROR, PROTOCOL, RESOURCE_URI, SERVED_TOOLS, TIMEOUT_ERROR } from '../apps/web/src/agent/protocol';
import { createEditor } from '../apps/web/src/timeline/harness';
import { EASINGS } from '../apps/web/src/timeline/properties';
import { writeSyntheticG02 } from '../parity/g02-synthetic';
import { fixture } from './t03-fixtures';

const ORIGIN = 'http://127.0.0.1:4173';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 't18a-calls-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
async function start(options: ConstructorParameters<typeof Helper>[0] = {}) {
  const lines: string[] = [];
  const helper = await startHelper({ port: 0, log: l => lines.push(l), configDir: tmp(), ...options });
  cleanups.push(() => helper.close());
  return { helper, lines };
}

/** A raw tab: a ws client with an ordered inbox. */
class RawTab {
  inbox: any[] = [];
  closed: Promise<{ code: number; reason: string }>;
  private wake?: () => void;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', d => { this.inbox.push(JSON.parse(String(d))); this.wake?.(); });
    this.closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('error', () => {});
  }
  static async open(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tab`, { origin: ORIGIN });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const tab = new RawTab(ws);
    cleanups.push(() => ws.terminate());
    return tab;
  }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  async next(type?: string, ms = 2000): Promise<any> {
    const end = Date.now() + ms;
    while (!this.inbox.length) {
      if (Date.now() > end) throw new Error(`no ${type ?? 'message'} within ${ms} ms`);
      await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, 20); });
    }
    const m = this.inbox.shift();
    if (type) expect(m.type, JSON.stringify(m)).toBe(type);
    return m;
  }
  async quiet(ms = 80) { await sleep(ms); expect(this.inbox).toEqual([]); }
  drop() { this.ws.terminate(); return this.closed; }
}
/** Opens a tab, pairs it by seeding the token file, and sends hello. Returns the hello answer (not yet read for takeover tabs). */
async function tabOf(helper: Helper, tabId: string, extra: Record<string, unknown> = {}, token = newToken()) {
  helper.store.add(token, tabId);
  const tab = await RawTab.open(helper.port);
  tab.send({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId, token, ...extra });
  return { tab, token };
}
/** A tab that is active and has read its hello. */
async function activeTab(helper: Helper, tabId = 'tab-a', extra: Record<string, unknown> = {}) {
  const { tab, token } = await tabOf(helper, tabId, extra);
  const ack = await tab.next('hello');
  expect(ack).toMatchObject({ paired: true, active: true });
  return { tab, token, connId: ack.connId as string };
}

async function mcpClient(helper: Helper) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`));
  const client = new Client({ name: 't18a', version: '0' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return { client, transport };
}
const textOf = (r: any) => JSON.parse(r.content[0].text);

const invalid = (tool: string, errors: { path: string; code: string; message: string }[]) => ({
  success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}`, message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors },
});
const REQUIRED = (name: string) => `must have required property '${name}'`;
const ENUM_MSG = 'must be equal to one of the allowed values';

describe('t18a schemas (row 6)', () => {
  // [tool, input, detail errors] — one refusal per served tool, in Xapp's INVALID_TOOL_INPUT shape.
  const TABLE: [string, unknown, { path: string; code: string; message: string }[]][] = [
    // T09 (C8 assertion-only edit): addCaptions, editAllCaptionStyles and listCaptionTemplates are served; their rows are schema refusals like the others, in SERVED_TOOLS order.
    ['addCaptions', { maxWords: '5' }, [{ path: '$.maxWords', code: 'TYPE', message: 'must be number' }]],
    ['addLayout', { layoutType: 'grid-3x3' }, [{ path: '$.layoutType', code: 'ENUM', message: ENUM_MSG }]], // T07 (C8)
    ['addMedia', { assetId: 5 }, [{ path: '$.assetId', code: 'TYPE', message: 'must be string' }]],
    ['addMotionGraphic', { width: 100, height: 100, x: 0, y: 0, animationDuration: '5' }, [{ path: '$.animationDuration', code: 'TYPE', message: 'must be number' }]],
    // T06 (C8 assertion-only edit): addShape and writeShapePoints are served; their rows are schema refusals like the others.
    ['addShape', { shape: 'hexagon', bounds: { width: 10, height: 10 } }, [{ path: '$.shape', code: 'ENUM', message: ENUM_MSG }]],
    // T05 (assertion-only edit): addText is served; a number for textContent and a missing duration are schema refusals.
    ['addText', { textContent: 5 }, [{ path: '$.duration', code: 'REQUIRED', message: REQUIRED('duration') }, { path: '$.textContent', code: 'TYPE', message: 'must be string' }]],
    // T22 (C8 assertion-only edit): applyPreset, browsePresets and fonts are served; their rows are schema refusals like the others, in SERVED_TOOLS order.
    ['applyPreset', { timelineStart: -1 }, [{ path: '$.presetId', code: 'REQUIRED', message: REQUIRED('presetId') }, { path: '$.timelineStart', code: 'MINIMUM', message: 'must be >= 0' }]],
    // T11 (C8 assertion-only edit): applyTransition is served; its row is a schema refusal like the others.
    ['applyTransition', { action: 'add', betweenItems: ['a', 'b'], kind: 'zoom' }, [{ path: '$.kind', code: 'ENUM', message: ENUM_MSG }]],
    ['browsePresets', { category: 'stickers' }, [{ path: '$.category', code: 'ENUM', message: ENUM_MSG }]], // T22 (C8)
    ['changeTrack', {}, [{ path: '$.itemId', code: 'REQUIRED', message: REQUIRED('itemId') }, { path: '$.trackId', code: 'REQUIRED', message: REQUIRED('trackId') }]],
    ['cloneItem', { itemId: 'v1' }, [{ path: '$.trackId', code: 'REQUIRED', message: REQUIRED('trackId') }]],
    ['consolidateTracks', { trackIds: [] }, [{ path: '$.trackIds', code: 'MINITEMS', message: 'must NOT have fewer than 1 items' }]],
    ['context', { startSeconds: '1' }, [{ path: '$.startSeconds', code: 'TYPE', message: 'must be number' }]],
    // T12 (C8 assertion-only edit): createMask, editMaskProperties, removeMask and writeMaskPoints are served; their rows are schema refusals like the others.
    ['createMask', { itemId: 'v1', timelineSeconds: '1' }, [{ path: '$.timelineSeconds', code: 'TYPE', message: 'must be number' }]],
    ['deleteItems', { itemIds: [] }, [{ path: '$.itemIds', code: 'MINITEMS', message: 'must NOT have fewer than 1 items' }]],
    ['editAllCaptionStyles', {}, [{ path: '$.trackId', code: 'REQUIRED', message: REQUIRED('trackId') }]], // T09 (C8 assertion-only edit)
    ['editLayout', {}, [{ path: '$.itemId', code: 'REQUIRED', message: REQUIRED('itemId') }]], // T07 (C8)
    ['editMaskProperties', { itemId: 'v1', maskIndex: 0 }, [{ path: '$.properties', code: 'REQUIRED', message: REQUIRED('properties') }]],
    ['editMotionGraphic', {}, [{ path: '$.itemId', code: 'REQUIRED', message: REQUIRED('itemId') }]],
    ['editProperties', { itemId: 'v1', properties: { opacity: '1' } }, [{ path: '$.properties.opacity', code: 'TYPE', message: 'must be number' }]],
    ['fonts', { role: 'body' }, [{ path: '$.role', code: 'ENUM', message: ENUM_MSG }]], // T22 (C8): read-only
    // T21 help tools (contracts getHelpSection, searchHelpDocs): served, so each gets a schema-refusal row like the others.
    ['getHelpSection', { section_id: 5 }, [{ path: '$.section_id', code: 'TYPE', message: 'must be string' }]],
    ['listCaptionTemplates', { bogus: 1 }, [{ path: '$.bogus', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }]], // T09 (C8 assertion-only edit): read-only, empty closed object
    ['manageMarkers', { actions: [{ action: 'zap' }] }, [{ path: '$.actions.0.action', code: 'ENUM', message: ENUM_MSG }]],
    ['manageTrack', { action: 'volume', volume: 2 }, [{ path: '$.volume', code: 'MAXIMUM', message: 'must be <= 1' }]],
    ['manageTrackGroup', { action: 'create', trackIds: ['a'] }, [{ path: '$.trackIds', code: 'INVALID_COMBINATION', message: 'provide distinct member track IDs (at least two when creating)' }]],
    ['moveItem', { itemId: 'v1', itemIds: ['v2'] }, [{ path: '$.itemId', code: 'INVALID_COMBINATION', message: 'cannot be combined with itemIds' }]],
    ['removeMask', { itemId: 'v1' }, [{ path: '$.maskIndex', code: 'REQUIRED', message: REQUIRED('maskIndex') }]],
    ['reorderItems', { itemIds: ['a'], beforeItemId: 'b', afterItemId: 'c' }, [{ path: '$.beforeItemId', code: 'INVALID_COMBINATION', message: 'cannot be combined with afterItemId' }]],
    ['resizeCanvas', { aspectRatio: '4:3' }, [{ path: '$.aspectRatio', code: 'ENUM', message: ENUM_MSG }]],
    ['searchHelpDocs', { query: 'how do I export', match_count: 9 }, [{ path: '$.match_count', code: 'MAXIMUM', message: 'must be <= 5' }]], // T21
    ['setTimeRemap', { itemId: 'v1', keyframes: [] }, [{ path: '$.keyframes', code: 'MINITEMS', message: 'must NOT have fewer than 1 items' }]],
    ['slipItem', { itemId: 'v1', slipSeconds: '1' }, [{ path: '$.slipSeconds', code: 'TYPE', message: 'must be number' }]],
    ['splitItem', { itemId: 'v1', timestampS: null }, [{ path: '$.timestampS', code: 'TYPE', message: 'must be number' }]],
    ['syncAndSwap', { sourceAssetId: 'a', targetItemId: 'v1', trackId: 't', from: 0 }, [{ path: '$.to', code: 'REQUIRED', message: REQUIRED('to') }]],
    ['transformItem', { itemId: 'v1', rotation: 400 }, [{ path: '$.rotation', code: 'MAXIMUM', message: 'must be <= 360' }]],
    ['trimItem', { itemId: 'v1', handle: 'middle', deltaSeconds: 1 }, [{ path: '$.handle', code: 'ENUM', message: ENUM_MSG }]],
    ['viewItemDetails', { itemId: 'v1', subdivisionsPerBeat: 5 }, [{ path: '$.subdivisionsPerBeat', code: 'ENUM', message: ENUM_MSG }]],
    // T10 (C8 assertion-only edit): writeEffects is served; its row is a schema refusal like the others.
    ['writeEffects', { itemId: 'v1', effects: { grayscale_1: { enabled: 'yes' } } }, [{ path: '$.effects.grayscale_1.enabled', code: 'TYPE', message: 'must be boolean' }]],
    ['writeKeyframes', { itemId: 'v1', payload: { opacity: {} } }, [{ path: '$.payload.opacity', code: 'MINPROPERTIES', message: 'must NOT have fewer than 1 properties' }]],
    ['writeMaskPoints', { itemId: 'v1', maskIndex: '0' }, [{ path: '$.maskIndex', code: 'TYPE', message: 'must be integer' }]],
    ['writeShapePoints', { update: [] }, [{ path: '$.itemId', code: 'REQUIRED', message: REQUIRED('itemId') }]],
    // T12 smart masks (C8 assertion-only edit): viewMaskFrame, previewSmartMask, trackSmartMask and removeBackground are served.
    ['viewMaskFrame', { itemId: 'v1', timelineSeconds: '1' }, [{ path: '$.timelineSeconds', code: 'TYPE', message: 'must be number' }]],
    ['previewSmartMask', { frameRef: 'r1', strokes: [] }, [{ path: '$.strokes', code: 'MINITEMS', message: 'must NOT have fewer than 1 items' }]],
    ['trackSmartMask', { sourceStartSeconds: 0, sourceEndSeconds: 1 }, [{ path: '$.selectionId', code: 'REQUIRED', message: REQUIRED('selectionId') }]],
    ['removeBackground', { name: 'x' }, [{ path: '$.itemId', code: 'REQUIRED', message: REQUIRED('itemId') }]],
  ];

  it('row 6: the table covers exactly the 46 served tools', () => { // T09 (C8 assertion-only edit): 40 → 43; T22 (C8): 43 → 46
    expect(TABLE.map(r => r[0])).toEqual([...SERVED_TOOLS]);
  });

  it('row 6: the schemas\' easing names are T04\'s EASINGS', () => {
    expect([...EASING_NAMES]).toEqual(EASINGS);
  });

  it.each(TABLE)('row 6: %s refuses bad input with INVALID_TOOL_INPUT and the exact detail shape', async (tool, input, errors) => {
    const { helper } = await start();
    expect(await helper.call(tool, input, undefined)).toEqual(invalid(tool, errors));
  });

  it('row 6: every tool\'s object is closed — an unknown field is ADDITIONALPROPERTIES on $.<field>', async () => {
    const { helper } = await start();
    for (const tool of SERVED_TOOLS) {
      const result: any = await helper.call(tool, { zz_unknown: 1 }, undefined);
      expect(result.code, tool).toBe('INVALID_TOOL_INPUT');
      expect(result.details.errors, tool).toContainEqual({ path: '$.zz_unknown', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' });
    }
  });

  it('row 6: nested paths use Xapp\'s stored form ($.items.0.assetId, $.actions.0.bogus)', async () => {
    const { helper } = await start();
    expect(await helper.call('addMedia', { items: [{ trackId: 'x' }] }, undefined)).toEqual(invalid('addMedia', [
      { path: '$.items.0.assetId', code: 'REQUIRED', message: REQUIRED('assetId') },
      { path: '$.items.0.trackId', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' },
    ]));
    expect(await helper.call('manageMarkers', { actions: [{ action: 'add', bogus: 1 }] }, undefined)).toEqual(invalid('manageMarkers', [
      { path: '$.actions.0.bogus', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' },
    ]));
  });

  it('row 6: several violations are all reported, in order, and joined with "; " in message', async () => {
    const { helper } = await start();
    const result: any = await helper.call('trimItem', { handle: 'x', deltaSeconds: 'y', ripple: 1 }, undefined);
    expect(result).toEqual(invalid('trimItem', [
      { path: '$.itemId', code: 'REQUIRED', message: REQUIRED('itemId') },
      { path: '$.handle', code: 'ENUM', message: ENUM_MSG },
      { path: '$.deltaSeconds', code: 'TYPE', message: 'must be number' },
      { path: '$.ripple', code: 'TYPE', message: 'must be boolean' },
    ]));
    expect(result.message).toBe([
      `$.itemId: ${REQUIRED('itemId')}`, `$.handle: ${ENUM_MSG}`, '$.deltaSeconds: must be number', '$.ripple: must be boolean'].join('; '));
  });

  it('row 6: minimum/maximum/integer limits — rotation -361, volume -0.1, toIndex -1 and 1.5', async () => {
    const { helper } = await start();
    expect(await helper.call('transformItem', { itemId: 'v1', rotation: -361 }, undefined)).toEqual(invalid('transformItem', [{ path: '$.rotation', code: 'MINIMUM', message: 'must be >= -360' }]));
    expect(await helper.call('manageTrack', { action: 'volume', volume: -0.1 }, undefined)).toEqual(invalid('manageTrack', [{ path: '$.volume', code: 'MINIMUM', message: 'must be >= 0' }]));
    expect(await helper.call('manageTrack', { action: 'reorder', toIndex: -1 }, undefined)).toEqual(invalid('manageTrack', [{ path: '$.toIndex', code: 'MINIMUM', message: 'must be >= 0' }]));
    expect(await helper.call('manageTrackGroup', { action: 'reorder', toIndex: 1.5 }, undefined)).toEqual(invalid('manageTrackGroup', [{ path: '$.toIndex', code: 'TYPE', message: 'must be integer' }]));
  });

  it('row 6: a non-object input is refused at the root ($) — arrays and scalars; null/undefined count as {}', async () => {
    const { helper } = await start();
    for (const input of [5, 'x', true, [], [1]]) {
      expect(await helper.call('moveItem', input, undefined), JSON.stringify(input)).toEqual(invalid('moveItem', [{ path: '$', code: 'TYPE', message: 'must be object' }]));
    }
    expect(await helper.call('changeTrack', null, undefined)).toEqual(invalid('changeTrack', [
      { path: '$.itemId', code: 'REQUIRED', message: REQUIRED('itemId') }, { path: '$.trackId', code: 'REQUIRED', message: REQUIRED('trackId') }]));
    expect(await helper.call('changeTrack', undefined, undefined)).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
    expect(await helper.call('moveItem', null, undefined)).toEqual({ success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR }); // {} is a valid moveItem input
  });

  it('row 6: INVALID_COMBINATION rules — addMedia, moveItem (all four pairs, clash list in field order), reorderItems, manageTrackGroup distinct ids', async () => {
    const { helper } = await start();
    const comb = (tool: string, path: string, message: string) => invalid(tool, [{ path, code: 'INVALID_COMBINATION', message }]);
    expect(await helper.call('addMedia', { assetId: 'a', insertAfterItemId: 'v1', trackId: 't', timelineStart: 1 }, undefined)).toEqual(comb('addMedia', '$.insertAfterItemId', 'cannot be combined with trackId, timelineStart'));
    expect(await helper.call('moveItem', { itemId: 'v1', beforeItemId: 'a', afterItemId: 'b' }, undefined)).toEqual(comb('moveItem', '$.beforeItemId', 'cannot be combined with afterItemId'));
    expect(await helper.call('moveItem', { groupId: 'g', by: 1, itemId: 'v1', to: 2, trackId: 't', beforeItemId: 'a' }, undefined)).toEqual(
      comb('moveItem', '$.groupId', 'cannot be combined with itemId, to, trackId, beforeItemId'));
    expect(await helper.call('manageTrackGroup', { action: 'setTracks', groupId: 'g', trackIds: ['a', 'a'] }, undefined)).toEqual(
      comb('manageTrackGroup', '$.trackIds', 'provide distinct member track IDs (at least two when creating)'));
    // The combinations that are allowed pass the schema (and then hit TAB_NOT_CONNECTED).
    const open = { success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR };
    expect(await helper.call('moveItem', { groupId: 'g', by: 1 }, undefined)).toEqual(open);
    expect(await helper.call('manageTrackGroup', { action: 'create', trackIds: ['a', 'b'] }, undefined)).toEqual(open);
    expect(await helper.call('addMedia', { assetId: 'a', trackId: 't', timelineStart: 1 }, undefined)).toEqual(open);
  });

  it('row 6: valid minimal input for all 46 tools passes the schema (and only then meets the tab)', async () => { // T09 (C8 assertion-only edit): 40 → 43; T22 (C8): 43 → 46
    const { helper } = await start();
    const valid: Record<string, unknown> = {
      addCaptions: { trackId: 'C1' } /* T09 (C8) */, addLayout: { layoutType: 'grid-2x2' } /* T07 (C8) */, addMedia: { assetId: 'video_1' }, addMotionGraphic: { code: 'export const G = () => null;', summary: 'A graphic.', width: 100, height: 100, x: 0, y: 0, trackId: 't' },
      addShape: { shape: 'star', bounds: { width: 100, height: 100 }, trackId: 't' }, // T06 (C8)
      addText: { textContent: 'Hi', duration: 3 }, // T05
      applyPreset: { presetId: 'title-card-1' }, // T22 (C8)
      applyTransition: { action: 'remove', atSeconds: 2 }, // T11 (C8)
      browsePresets: {}, // T22 (C8)
      changeTrack: { itemId: 'v1', trackId: 't' }, cloneItem: { itemId: 'v1', trackId: 't' }, consolidateTracks: {}, context: {},
      createMask: { itemId: 'v1', shape: 'rectangle', bounds: { width: 10, height: 10 } }, // T12 (C8)
      deleteItems: { itemIds: ['v1'] }, editAllCaptionStyles: { trackId: 'C1' } /* T09 (C8) */, editLayout: { itemId: 'l1' } /* T07 (C8) */,
      editMaskProperties: { itemId: 'v1', maskIndex: 0, properties: { opacity: 50 } }, // T12 (C8)
      editMotionGraphic: { itemId: 'mg1' }, editProperties: { itemId: 'v1', properties: { opacity: 0.5 } }, fonts: {} /* T22 (C8) */, getHelpSection: { section_id: 'getting-started' } /* T21 */, listCaptionTemplates: {} /* T09 (C8) */, manageMarkers: { actions: [{ action: 'clear' }] }, manageTrack: { action: 'create' },
      manageTrackGroup: { action: 'ungroup', groupId: 'g' }, moveItem: { itemId: 'v1', by: 1 },
      removeMask: { itemId: 'v1', maskIndex: 0 }, // T12 (C8)
      reorderItems: { itemIds: ['v1'], afterItemId: 'v2' }, resizeCanvas: { aspectRatio: '9:16' }, searchHelpDocs: { query: 'how do I export' } /* T21 */,
      setTimeRemap: { itemId: 'v1', keyframes: [{ time: 0, value: 0 }] }, slipItem: { itemId: 'v1', slipSeconds: -1 }, splitItem: { itemId: 'v1', timestampS: 2 },
      syncAndSwap: { sourceAssetId: 'video_2', targetItemId: 'v1', trackId: 't', from: 0, to: 4 },
      transformItem: { itemId: 'v1', rotation: -360 }, trimItem: { itemId: 'v1', handle: 'end', deltaSeconds: -0.5 },
      viewItemDetails: { itemIds: ['v1'], include: ['transcript', 'beats'], subdivisionsPerBeat: 4 }, writeEffects: { itemId: 'v1', add: [{ effectId: 'grayscale' }] },
      writeKeyframes: { itemId: 'v1', payload: { opacity: { add: [{ time: 1, value: 0.5 }] } } },
      writeMaskPoints: { itemId: 'v1', remove: [0] }, // T12 (C8)
      writeShapePoints: { itemId: 's1', remove: [0] }, // T06 (C8)
      // T12 smart masks (C8 assertion-only edit): viewMaskFrame, previewSmartMask, trackSmartMask, removeBackground.
      viewMaskFrame: { itemId: 'v1', timelineSeconds: 1 },
      previewSmartMask: { frameRef: 'r1', strokes: [{ label: 1, points: [[0.5, 0.5]], radius: 0.1 }] },
      trackSmartMask: { selectionId: 's1', sourceStartSeconds: 0, sourceEndSeconds: 1 },
      removeBackground: { itemId: 'v1' },
    };
    expect(Object.keys(valid)).toEqual([...SERVED_TOOLS]);
    for (const tool of SERVED_TOOLS) expect(await helper.call(tool, valid[tool], undefined), tool).toEqual({ success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR });
  });

  it('row 6: the G-02 schema refusals of results §6 — writeKeyframes MINPROPERTIES / NOT / ENUM, setTimeRemap MINITEMS / MINIMUM / MINIMUM / ENUM + TYPE + ONEOF', async () => {
    const { helper } = await start();
    const errors = async (tool: string, input: unknown) => {
      const result: any = await helper.call(tool, input, undefined);
      expect(result.code, JSON.stringify(input)).toBe('INVALID_TOOL_INPUT');
      return result.details.errors.map((e: any) => [e.path, e.code]);
    };
    const add = (entry: Record<string, unknown>) => ({ itemId: 'v1', payload: { opacity: { add: [{ time: 1, ...entry }] } } });
    expect(await errors('writeKeyframes', { itemId: 'v1', payload: { opacity: {} } })).toEqual([['$.payload.opacity', 'MINPROPERTIES']]);
    expect(await errors('writeKeyframes', add({ value: 1, factor: 2 }))).toEqual([['$.payload.opacity.add.0', 'NOT']]);
    expect(await errors('writeKeyframes', add({ value: 1, delta: 2 }))).toEqual([['$.payload.opacity.add.0', 'NOT']]);
    // Stored: ENUM. The contract's bezier object form adds TYPE + ONEOF on the same path (Author question in the notes).
    expect(await errors('writeKeyframes', add({ value: 1, easing: 'wobble' }))).toEqual([['$.payload.opacity.add.0.easing', 'ENUM'], ['$.payload.opacity.add.0.easing', 'TYPE'], ['$.payload.opacity.add.0.easing', 'ONEOF']]);
    expect(await errors('setTimeRemap', { itemId: 'v1', keyframes: [] })).toEqual([['$.keyframes', 'MINITEMS']]);
    expect(await errors('setTimeRemap', { itemId: 'v1', keyframes: [{ time: -1, value: 0 }] })).toEqual([['$.keyframes.0.time', 'MINIMUM']]);
    expect(await errors('setTimeRemap', { itemId: 'v1', keyframes: [{ time: 0, value: -100 }] })).toEqual([['$.keyframes.0.value', 'MINIMUM']]);
    expect(await errors('setTimeRemap', { itemId: 'v1', keyframes: [{ time: 0, value: 0, easing: 'wobble' }] })).toEqual([['$.keyframes.0.easing', 'ENUM'], ['$.keyframes.0.easing', 'TYPE'], ['$.keyframes.0.easing', 'ONEOF']]);
    // Inputs G-02 saw answered by the handler pass the schema: INVALID_BEZIER_HANDLE, TIME_OUT_OF_BOUNDS (both tools), the
    // 15 easing names and a bezier easing, editProperties with an empty properties object (the handler's own refusal).
    const open = { success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR };
    expect(await helper.call('writeKeyframes', add({ value: 5, outHandle: [1.5, 0] }), undefined)).toEqual(open);
    expect(await helper.call('writeKeyframes', { itemId: 'v1', payload: { blur: { add: [{ time: 12, value: 5 }] }, timeRemap: { replace: [] } } }, undefined)).toEqual(open);
    expect(await helper.call('setTimeRemap', { itemId: 'v1', keyframes: [{ time: 15, value: 5000 }] }, undefined)).toEqual(open);
    for (const easing of [...EASING_NAMES, { type: 'bezier', points: [0.25, 0.1, 0.25, 1] }])
      expect(await helper.call('setTimeRemap', { itemId: 'v1', keyframes: [{ time: 0, value: 0, easing }] }, undefined), JSON.stringify(easing)).toEqual(open);
    expect(await helper.call('editProperties', { itemIds: ['v1', 'v2'], properties: {} }, undefined)).toEqual(open);
    expect(await helper.call('editProperties', { itemId: 'v1', itemIds: ['v2'], properties: { opacity: 1 } }, undefined)).toEqual(
      invalid('editProperties', [{ path: '$.itemId', code: 'INVALID_COMBINATION', message: 'cannot be combined with itemIds' }]));
  });

  it('row 6: the synthetic G-02 oracle (parity/g02-synthetic.ts, read without edits) — its INVALID_TOOL_INPUT steps K70, K72 and T06 get the stored code, paths and detail codes; every other writeKeyframes / setTimeRemap input passes the schema', async () => {
    const dir = tmp();
    await writeSyntheticG02(dir);
    const steps: [string, string, unknown, any][] = [];
    for (const file of readdirSync(join(dir, 'results')).sort()) {
      const record = JSON.parse(readFileSync(join(dir, 'results', file), 'utf8'));
      if (record.tool_name !== 'writeKeyframes' && record.tool_name !== 'setTimeRemap') continue;
      const blocks = record.result_blocks ?? record.result_text.split('\n<<<BLOCK>>>\n');
      steps.push([file.replace(/\.json$/, ''), record.tool_name, typeof record.tool_input === 'string' ? JSON.parse(record.tool_input) : record.tool_input, JSON.parse(blocks[1])]);
    }
    expect(steps).toHaveLength(28); // 22 writeKeyframes + 6 setTimeRemap steps
    expect(steps.filter(s => s[3].code === 'INVALID_TOOL_INPUT').map(s => s[0])).toEqual(['K70', 'K72', 'T06']);
    const shape = (r: any) => ({ code: r.code, error: r.error, errors: r.details.errors.map((e: any) => ({ path: e.path, code: e.code })) });
    for (const [id, tool, input, stored] of steps) {
      if (stored.code === 'INVALID_TOOL_INPUT') expect(shape(validate(tool, input)), id).toEqual(shape(stored));
      else expect(validate(tool, input), id).toBeNull();
    }
  });

  it('row 6: UNKNOWN_TOOL for names the helper does not serve (including T18 tools), before any schema check', async () => {
    const { helper } = await start();
    for (const name of ['searchProjectAssets', 'searchUserLibrary', 'captureFrame', 'bogus', '', 'MoveItem']) { // T09 (C8 assertion-only edit): addCaptions is now served, dropped from the unserved list; T22 (C8): fonts is served now
      expect(await helper.call(name, { anything: true }, undefined), name).toEqual({ success: false, error: `Unknown tool '${name}'`, code: 'UNKNOWN_TOOL' });
    }
  });

  it('row 6: refused calls never reach the tab; the next valid call does', async () => {
    const { helper } = await start();
    const { tab } = await activeTab(helper);
    await helper.call('moveItem', { itemId: 1 }, undefined);
    await helper.call('nope', {}, undefined);
    await tab.quiet();
    const pending = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    expect(await tab.next('call')).toMatchObject({ toolName: 'moveItem', input: { itemId: 'v1', by: 1 } });
    void pending;
  });

  it('row 6: over MCP a refusal is a tool result with isError:true and the envelope as one JSON text block; UNKNOWN_TOOL the same', async () => {
    const { helper } = await start();
    const { client } = await mcpClient(helper);
    const bad = await client.callTool({ name: 'splitItem', arguments: { itemId: 'v1' } });
    expect(bad).toEqual({ content: [{ type: 'text', text: JSON.stringify(invalid('splitItem', [{ path: '$.timestampS', code: 'REQUIRED', message: REQUIRED('timestampS') }])) }], isError: true });
    const unknown = await client.callTool({ name: 'searchProjectAssets', arguments: {} }); // T22 (C8 assertion-only edit): fonts is served now; searchProjectAssets is still unserved
    expect(unknown).toEqual({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: "Unknown tool 'searchProjectAssets'", code: 'UNKNOWN_TOOL' }) }], isError: true });
  });

  it('row 6: a successful MCP result has no isError key', async () => {
    const { helper } = await start();
    const { tab } = await activeTab(helper);
    const { client } = await mcpClient(helper);
    const result = client.callTool({ name: 'context', arguments: {} });
    const msg = await tab.next('call');
    tab.send({ type: 'result', callId: msg.callId, result: { success: true, data: { duration: 3 } } });
    expect(await result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ success: true, data: { duration: 3 } }) }] });
  });
});

describe('t18a envelopes and serialization (row 7)', () => {
  it('row 7: no tab → TAB_NOT_CONNECTED with the exact text, for mutating and read-only tools', async () => {
    const { helper } = await start();
    const expected = { success: false, code: 'TAB_NOT_CONNECTED', error: 'No editor tab is connected to the helper. Open a project in Cutframe, press Connect tab, then retry.' };
    expect(await helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined)).toEqual(expected);
    expect(await helper.call('context', {}, undefined)).toEqual(expected);
  });

  it('row 7: an unpaired tab is not a tab: still TAB_NOT_CONNECTED', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    tab.send({ type: 'hello', protocol: PROTOCOL, projectId: null, tabId: 'tab-x' });
    await tab.next('hello');
    expect(await helper.call('context', {}, undefined)).toMatchObject({ code: 'TAB_NOT_CONNECTED' });
  });

  it('row 7: the tab gets one call message {type, callId, executionKey: mcp:<connId>:<callId>, toolName, input}; session and resource only when set', async () => {
    const { helper } = await start();
    const { tab, connId } = await activeTab(helper);
    void helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const plain = await tab.next('call');
    expect(plain).toEqual({ type: 'call', callId: expect.stringMatching(UUID), executionKey: `mcp:${connId}:${plain.callId}`, toolName: 'moveItem', input: { itemId: 'v1', by: 1 } });
    tab.send({ type: 'result', callId: plain.callId, result: { success: true } });
    void helper.call('context', {}, 'sess-7', { resource: true });
    const full = await tab.next('call');
    expect(full).toEqual({ type: 'call', callId: expect.stringMatching(UUID), executionKey: `mcp:${connId}:${full.callId}`, toolName: 'context', input: {}, session: 'sess-7', resource: true });
  });

  it('row 7: over MCP the call carries the HTTP session id', async () => {
    const { helper } = await start();
    const { tab } = await activeTab(helper);
    const { client, transport } = await mcpClient(helper);
    const pending = client.callTool({ name: 'context', arguments: {} });
    const msg = await tab.next('call');
    expect(transport.sessionId).toMatch(UUID);
    expect(msg.session).toBe(transport.sessionId);
    expect(msg.resource).toBeUndefined();
    tab.send({ type: 'result', callId: msg.callId, result: { success: true } });
    await pending;
  });

  it('row 7: the tab\'s result object is returned unchanged; an error {code, message} becomes {success:false, code, error}', async () => {
    const { helper } = await start();
    const { tab } = await activeTab(helper);
    const ok = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const a = await tab.next('call');
    tab.send({ type: 'result', callId: a.callId, result: { success: true, data: { moved: 'v1' }, timelineChanges: { updated: [] } } });
    expect(await ok).toEqual({ success: true, data: { moved: 'v1' }, timelineChanges: { updated: [] } });

    const bad = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const b = await tab.next('call');
    tab.send({ type: 'result', callId: b.callId, error: { code: 'ITEM_NOT_FOUND', message: 'No such item' } });
    expect(await bad).toEqual({ success: false, code: 'ITEM_NOT_FOUND', error: 'No such item' });

    const none = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const c = await tab.next('call');
    tab.send({ type: 'result', callId: c.callId });
    expect(await none).toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'Tool execution failed', operationMayHaveRun: true });
  });

  it('row 7: a result for an unknown call, or from a tab that is not the call\'s, is ignored', async () => {
    const { helper } = await start();
    const { tab } = await activeTab(helper);
    const { tab: other } = await tabOf(helper, 'tab-b'); // paired, but not active: TAB_ACTIVE_ELSEWHERE
    expect(await other.next('error')).toMatchObject({ code: 'TAB_ACTIVE_ELSEWHERE' });
    const call = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const msg = await tab.next('call');
    other.send({ type: 'result', callId: msg.callId, result: { success: true, data: 'forged' } });
    tab.send({ type: 'result', callId: 'no-such-call', result: { success: true } });
    await sleep(60);
    tab.send({ type: 'result', callId: msg.callId, result: { success: true, data: 'real' } });
    expect(await call).toEqual({ success: true, data: 'real' });
  });

  it('row 7: TOOL_TIMEOUT after toolTimeoutMs, operationMayHaveRun true because the call was sent; a late result is ignored and the helper keeps working', async () => {
    const { helper } = await start({ toolTimeoutMs: 80 });
    const { tab } = await activeTab(helper);
    const first = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const msg = await tab.next('call');
    expect(await first).toEqual({ success: false, code: 'TOOL_TIMEOUT', error: TIMEOUT_ERROR, operationMayHaveRun: true });
    tab.send({ type: 'result', callId: msg.callId, result: { success: true } }); // too late
    const second = helper.call('moveItem', { itemId: 'v1', by: 2 }, undefined);
    const next = await tab.next('call');
    expect(next.callId).not.toBe(msg.callId);
    tab.send({ type: 'result', callId: next.callId, result: { success: true, data: 2 } });
    expect(await second).toEqual({ success: true, data: 2 });
  });

  it('row 7: the default tool timeout is 60 s (the spec\'s MCP timeout)', async () => {
    const { DEFAULT_TOOL_TIMEOUT_MS } = await import('../apps/helper/src/helper');
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(60_000);
  });

  it('row 7: the tab drops mid-call and nobody returns → at the timeout the answer is TAB_NOT_CONNECTED + DISCONNECTED_ERROR, operationMayHaveRun true', async () => {
    const { helper } = await start({ toolTimeoutMs: 120 });
    const { tab } = await activeTab(helper);
    const call = helper.call('deleteItems', { itemIds: ['v1'] }, undefined);
    await tab.next('call');
    await tab.drop();
    expect(await call).toEqual({ success: false, code: 'TAB_NOT_CONNECTED', error: DISCONNECTED_ERROR, operationMayHaveRun: true });
    expect(DISCONNECTED_ERROR).toBe('The editor tab disconnected while the call was running, so its result is unknown. Read context before retrying.');
  });

  it('row 7: a different tab becoming active settles the dead tab\'s call at once (DISCONNECTED_ERROR) and does not run it twice', async () => {
    const { helper } = await start({ toolTimeoutMs: 5000 });
    const { tab } = await activeTab(helper, 'tab-a');
    const call = helper.call('deleteItems', { itemIds: ['v1'] }, undefined);
    await tab.next('call');
    await tab.drop();
    const { tab: b } = await tabOf(helper, 'tab-b');
    expect(await b.next('hello')).toMatchObject({ paired: true, active: true });
    expect(await call).toEqual({ success: false, code: 'TAB_NOT_CONNECTED', error: DISCONNECTED_ERROR, operationMayHaveRun: true });
    await b.quiet(); // tab-b never saw the call
  });

  it('row 7: the same tab back with a new connection (no connId) is a different connection: the old call settles DISCONNECTED, nothing is resent', async () => {
    const { helper } = await start({ toolTimeoutMs: 5000 });
    const { tab, token } = await activeTab(helper, 'tab-a');
    const call = helper.call('deleteItems', { itemIds: ['v1'] }, undefined);
    await tab.next('call');
    await tab.drop();
    const again = await RawTab.open(helper.port);
    again.send({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-a', token });
    await again.next('hello');
    expect(await call).toEqual({ success: false, code: 'TAB_NOT_CONNECTED', error: DISCONNECTED_ERROR, operationMayHaveRun: true });
    await again.quiet();
  });

  it('row 7: closing the helper answers pending calls TAB_NOT_CONNECTED', async () => {
    const { helper } = await start({ toolTimeoutMs: 5000 });
    const { tab } = await activeTab(helper);
    const call = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    await tab.next('call');
    await helper.close();
    expect(await call).toEqual({ success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR });
  });

  it('row 7: mutating calls are serialized — the second is sent only after the first is answered; context goes straight through', async () => {
    const { helper } = await start();
    const { tab } = await activeTab(helper);
    const first = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const second = helper.call('trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: 1 }, undefined);
    const third = helper.call('manageMarkers', { actions: [{ action: 'clear' }] }, undefined);
    const a = await tab.next('call');
    expect(a.toolName).toBe('moveItem');
    const read = helper.call('context', {}, undefined);
    const r = await tab.next('call'); // overtakes the queued mutating calls
    expect(r.toolName).toBe('context');
    await tab.quiet(60);
    tab.send({ type: 'result', callId: r.callId, result: { success: true, data: 'ctx' } });
    expect(await read).toEqual({ success: true, data: 'ctx' });
    tab.send({ type: 'result', callId: a.callId, result: { success: true, data: 1 } });
    expect(await first).toEqual({ success: true, data: 1 });
    const b = await tab.next('call');
    expect(b.toolName).toBe('trimItem');
    await tab.quiet(60);
    tab.send({ type: 'result', callId: b.callId, error: { code: 'ITEM_NOT_FOUND', message: 'gone' } });
    expect(await second).toEqual({ success: false, code: 'ITEM_NOT_FOUND', error: 'gone' });
    const c = await tab.next('call');
    expect(c.toolName).toBe('manageMarkers');
    tab.send({ type: 'result', callId: c.callId, result: { success: true } });
    expect(await third).toEqual({ success: true });
  });

  it('row 7: a timed-out call does not block the queue behind it', async () => {
    const { helper } = await start({ toolTimeoutMs: 80 });
    const { tab } = await activeTab(helper);
    const first = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const second = helper.call('moveItem', { itemId: 'v1', by: 2 }, undefined);
    const a = await tab.next('call');
    expect(await first).toMatchObject({ code: 'TOOL_TIMEOUT' });
    const b = await tab.next('call');
    expect(b.input).toEqual({ itemId: 'v1', by: 2 });
    tab.send({ type: 'result', callId: b.callId, result: { success: true } });
    expect(await second).toEqual({ success: true });
    expect(a.callId).not.toBe(b.callId);
  });

  it('row 7: serialization holds across MCP sessions (two clients, one tab)', async () => {
    const { helper } = await start();
    const { tab } = await activeTab(helper);
    const one = await mcpClient(helper), two = await mcpClient(helper);
    const p1 = one.client.callTool({ name: 'moveItem', arguments: { itemId: 'v1', by: 1 } });
    const a = await tab.next('call');
    const p2 = two.client.callTool({ name: 'moveItem', arguments: { itemId: 'v2', by: 1 } });
    await tab.quiet(80);
    tab.send({ type: 'result', callId: a.callId, result: { success: true, data: 'one' } });
    const b = await tab.next('call');
    expect(b.input).toEqual({ itemId: 'v2', by: 1 });
    expect(b.session).not.toBe(a.session);
    tab.send({ type: 'result', callId: b.callId, result: { success: true, data: 'two' } });
    expect(textOf(await p1)).toEqual({ success: true, data: 'one' });
    expect(textOf(await p2)).toEqual({ success: true, data: 'two' });
  });
});

describe('t18a retransmit after reconnect (row 5, e2e)', () => {
  it('row 5: the same tab reconnecting with its connId gets the same call again — same callId, same executionKey — and the original caller gets the answer', async () => {
    const { helper } = await start({ toolTimeoutMs: 5000 });
    const { tab, token, connId } = await activeTab(helper);
    const call = helper.call('moveItem', { itemId: 'v1', by: 1 }, 'sess-1');
    const first = await tab.next('call');
    await tab.drop();
    const again = await RawTab.open(helper.port);
    again.send({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-a', token, connId });
    expect(await again.next('hello')).toEqual({ type: 'hello', protocol: 1, version: expect.any(String), connId, paired: true, active: true });
    const resent = await again.next('call');
    expect(resent).toEqual(first);
    expect(resent.executionKey).toBe(`mcp:${connId}:${first.callId}`);
    again.send({ type: 'result', callId: resent.callId, result: { success: true, data: 'once' } });
    expect(await call).toEqual({ success: true, data: 'once' });
  });

  it('row 5: with the real Executor + Ledger a retransmitted mutating call runs once — the stored result answers the duplicate', async () => {
    const { helper } = await start({ toolTimeoutMs: 5000 });
    const editor = createEditor(fixture());
    const store = new Map<string, string>();
    const executor = new Executor({ storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } }, current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    const v3 = () => editor.doc.items.find(i => i.id === 'v3')!.display;

    // A first connection reads the timeline (so the gate is open), then sends a move and loses the link before it answers.
    const { tab, token, connId } = await activeTab(helper);
    const read = helper.call('context', {}, 'sess-1');
    const readMsg = await tab.next('call');
    tab.send({ type: 'result', callId: readMsg.callId, result: await executor.execute(readMsg) });
    expect(await read).toMatchObject({ success: true });

    const move = helper.call('moveItem', { itemId: 'v3', by: 1 }, 'sess-1');
    const moveMsg = await tab.next('call');
    const firstResult = await executor.execute(moveMsg); // the tab ran it...
    expect(firstResult).toMatchObject({ success: true });
    expect(v3()).toEqual({ from: 11000, to: 13000 });
    await tab.drop(); // ...but the answer never left

    const again = await RawTab.open(helper.port);
    again.send({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-a', token, connId });
    await again.next('hello');
    const resent = await again.next('call');
    expect(resent.executionKey).toBe(moveMsg.executionKey);
    const secondResult = await executor.execute(resent);
    expect(secondResult).toEqual(firstResult); // the ledger's stored result
    expect(v3()).toEqual({ from: 11000, to: 13000 }); // not moved a second time
    again.send({ type: 'result', callId: resent.callId, result: secondResult });
    expect(await move).toEqual(firstResult);
  });
});

describe('t18a resource cutframe://project/state (row 8)', () => {
  it('row 8: listResources has exactly one resource, subscribable, JSON', async () => {
    const { helper } = await start();
    const { client } = await mcpClient(helper);
    expect(client.getServerCapabilities()?.resources).toEqual({ subscribe: true });
    expect(await client.listResources()).toEqual({ resources: [{
      uri: 'cutframe://project/state', name: 'project-state', title: 'Project state', mimeType: 'application/json',
      description: "The open project's timeline as the context tool returns it without parameters. Subscribe to be told when items, tracks or transitions change.",
    }] });
    expect(RESOURCE_URI).toBe('cutframe://project/state');
  });

  it('row 8: read asks the tab for context with resource:true and returns its result as one JSON content', async () => {
    const { helper } = await start();
    const { tab } = await activeTab(helper);
    const { client, transport } = await mcpClient(helper);
    const read = client.readResource({ uri: RESOURCE_URI });
    const msg = await tab.next('call');
    expect(msg).toEqual({ type: 'call', callId: expect.stringMatching(UUID), executionKey: `mcp:${msg.executionKey.split(':')[1]}:${msg.callId}`, toolName: 'context', input: {}, session: transport.sessionId, resource: true });
    const light = { success: true, data: { duration: 4, fps: 30 } };
    tab.send({ type: 'result', callId: msg.callId, result: light });
    expect(await read).toEqual({ contents: [{ uri: RESOURCE_URI, mimeType: 'application/json', text: JSON.stringify(light) }] });
  });

  it('row 8: read without a tab is not an error — the TAB_NOT_CONNECTED envelope is the content', async () => {
    const { helper } = await start();
    const { client } = await mcpClient(helper);
    const r = await client.readResource({ uri: RESOURCE_URI });
    expect(r.contents).toEqual([{ uri: RESOURCE_URI, mimeType: 'application/json', text: JSON.stringify({ success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR }) }]);
  });

  it('row 8: reading another URI → MCP error -32602 "Unknown resource: <uri>"', async () => {
    const { helper } = await start();
    const { client } = await mcpClient(helper);
    await expect(client.readResource({ uri: 'cutframe://project/other' })).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('Unknown resource: cutframe://project/other') });
  });

  async function subscribed(options: ConstructorParameters<typeof Helper>[0] = { quietMs: 80 }) {
    const { helper } = await start(options);
    const { tab, token } = await activeTab(helper);
    const { client } = await mcpClient(helper);
    const got: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { got.push(n.params.uri); });
    await client.subscribeResource({ uri: RESOURCE_URI });
    return { helper, tab, token, client, got };
  }
  const changed = (tab: RawTab, parts: string[], name = 'stateChanged') => tab.send({ type: 'event', name, data: { parts } });

  it('row 8: a burst of item/track/transition changes → exactly one notification after the quiet period (debounce)', async () => {
    const { tab, got } = await subscribed();
    changed(tab, ['items']); await sleep(30); changed(tab, ['tracks']); await sleep(30); changed(tab, ['transitions']);
    await sleep(40);
    expect(got).toEqual([]); // still inside the quiet window of the last event
    await sleep(160);
    expect(got).toEqual([RESOURCE_URI]);
    await sleep(160);
    expect(got).toEqual([RESOURCE_URI]); // and only one
    changed(tab, ['items']); await sleep(200);
    expect(got).toEqual([RESOURCE_URI, RESOURCE_URI]);
  });

  it('row 8: each of items, tracks, transitions alone notifies', async () => {
    const { tab, got } = await subscribed();
    for (const part of ['items', 'tracks', 'transitions']) { changed(tab, [part]); await sleep(200); }
    expect(got).toHaveLength(3);
  });

  it('row 8: markers-only, duration-only, unknown parts and other event names do not notify', async () => {
    const { tab, got } = await subscribed();
    changed(tab, ['markers']); changed(tab, ['duration']); changed(tab, ['canvas', 'fps']); changed(tab, []); changed(tab, ['items'], 'somethingElse');
    tab.send({ type: 'event', name: 'stateChanged' }); tab.send({ type: 'event', name: 'stateChanged', data: { parts: 'items' } }); tab.send({ type: 'event', name: 'stateChanged', data: null });
    await sleep(300);
    expect(got).toEqual([]);
  });

  it('row 8: a mixed change (markers + items) notifies', async () => {
    const { tab, got } = await subscribed();
    changed(tab, ['markers', 'items']); await sleep(200);
    expect(got).toEqual([RESOURCE_URI]);
  });

  it('row 8: changes from a tab that is not the active one do not notify', async () => {
    const { helper, got } = await subscribed();
    const { tab: other } = await tabOf(helper, 'tab-b');
    expect(await other.next('error')).toMatchObject({ code: 'TAB_ACTIVE_ELSEWHERE' });
    changed(other, ['items']);
    await sleep(300);
    expect(got).toEqual([]);
  });

  it('row 8: without subscribe, and after unsubscribe, nothing is sent', async () => {
    const { helper } = await start({ quietMs: 60 });
    const { tab } = await activeTab(helper);
    const { client } = await mcpClient(helper);
    const got: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { got.push(n.params.uri); });
    changed(tab, ['items']); await sleep(200);
    expect(got).toEqual([]); // never subscribed
    await client.subscribeResource({ uri: RESOURCE_URI });
    changed(tab, ['items']); await sleep(200);
    expect(got).toEqual([RESOURCE_URI]);
    await client.unsubscribeResource({ uri: RESOURCE_URI });
    changed(tab, ['items']); await sleep(200);
    expect(got).toEqual([RESOURCE_URI]); // unchanged
  });

  it('row 8: subscribing to some other URI does not subscribe to the state resource', async () => {
    const { helper } = await start({ quietMs: 60 });
    const { tab } = await activeTab(helper);
    const { client } = await mcpClient(helper);
    const got: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { got.push(n.params.uri); });
    await client.subscribeResource({ uri: 'cutframe://project/other' });
    changed(tab, ['items']); await sleep(200);
    expect(got).toEqual([]);
  });

  it('row 8: with two MCP sessions only the subscribed one is told', async () => {
    const { helper } = await start({ quietMs: 60 });
    const { tab } = await activeTab(helper);
    const a = await mcpClient(helper), b = await mcpClient(helper);
    const gotA: string[] = [], gotB: string[] = [];
    a.client.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { gotA.push(n.params.uri); });
    b.client.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { gotB.push(n.params.uri); });
    await a.client.subscribeResource({ uri: RESOURCE_URI });
    changed(tab, ['tracks']); await sleep(220);
    expect([gotA, gotB]).toEqual([[RESOURCE_URI], []]);
  });
});

describe('t18a takeover at the helper (row 9, helper side)', () => {
  it('row 9: a second paired tab without takeover → TAB_ACTIVE_ELSEWHERE, no hello ack, the first stays active and connected', async () => {
    const { helper } = await start();
    const { tab: a } = await activeTab(helper, 'tab-a');
    const { tab: b } = await tabOf(helper, 'tab-b');
    expect(await b.next('error')).toEqual({ type: 'error', code: 'TAB_ACTIVE_ELSEWHERE', message: LINK_ERRORS.TAB_ACTIVE_ELSEWHERE });
    await b.quiet();
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    const call = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    expect(await a.next('call')).toMatchObject({ toolName: 'moveItem' });
    void call;
  });

  it('row 9: takeover:true on an idle link → the old tab gets {type:"takeover", byTabId} then close 4409 "superseded"; the new tab is active', async () => {
    const { helper } = await start();
    const { tab: a } = await activeTab(helper, 'tab-a');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    expect(await a.next('takeover')).toEqual({ type: 'takeover', byTabId: 'tab-b' });
    expect(await a.closed).toEqual({ code: 4409, reason: 'superseded' });
    expect(await b.next('hello')).toMatchObject({ paired: true, active: true });
    void helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    expect(await b.next('call')).toMatchObject({ toolName: 'moveItem' });
  });

  it('row 9: the same tab opening a second connection replaces the first silently — close 4410, no takeover message', async () => {
    const { helper } = await start();
    const { tab: old, token } = await activeTab(helper, 'tab-a');
    const fresh = await RawTab.open(helper.port);
    fresh.send({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-a', token });
    expect(await old.closed).toEqual({ code: 4410, reason: 'replaced by a newer connection of the same tab' });
    expect(old.inbox).toEqual([]);
    expect(await fresh.next('hello')).toMatchObject({ paired: true, active: true });
  });

  it('row 9: a takeover while a call is running waits — the call finishes on the old tab, then the switch happens', async () => {
    const { helper } = await start();
    const { tab: a } = await activeTab(helper, 'tab-a');
    const call = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const msg = await a.next('call');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    await sleep(100);
    expect(b.inbox).toEqual([]); // no hello yet: waiting
    expect(a.inbox).toEqual([]); // not told, not closed
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.send({ type: 'result', callId: msg.callId, result: { success: true, data: 'finished on A' } });
    expect(await call).toEqual({ success: true, data: 'finished on A' });
    expect(await a.next('takeover')).toEqual({ type: 'takeover', byTabId: 'tab-b' });
    expect(await a.closed).toMatchObject({ code: 4409 });
    expect(await b.next('hello')).toMatchObject({ paired: true, active: true });
  });

  it('row 9: a read-only call held during a waiting takeover is delivered to the tab that takes over, not to the old one', async () => {
    const { helper } = await start();
    const { tab: a } = await activeTab(helper, 'tab-a');
    const busy = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const msg = await a.next('call');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    await sleep(60);
    const held = helper.call('context', {}, undefined);
    await sleep(60);
    expect(a.inbox).toEqual([]);
    a.send({ type: 'result', callId: msg.callId, result: { success: true } });
    await busy;
    await b.next('hello');
    const forB = await b.next('call');
    expect(forB.toolName).toBe('context');
    b.send({ type: 'result', callId: forB.callId, result: { success: true, data: 'from B' } });
    expect(await held).toEqual({ success: true, data: 'from B' });
  });

  it('row 9: a newer waiting takeover replaces the older waiter, which is told TAB_ACTIVE_ELSEWHERE', async () => {
    const { helper } = await start();
    const { tab: a } = await activeTab(helper, 'tab-a');
    const busy = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const msg = await a.next('call');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    await sleep(60);
    const { tab: c } = await tabOf(helper, 'tab-c', { takeover: true });
    expect(await b.next('error')).toMatchObject({ code: 'TAB_ACTIVE_ELSEWHERE' });
    a.send({ type: 'result', callId: msg.callId, result: { success: true } });
    await busy;
    expect(await a.next('takeover')).toEqual({ type: 'takeover', byTabId: 'tab-c' });
    expect(await c.next('hello')).toMatchObject({ active: true });
    await b.quiet();
  });

  it('row 9: if the waiting tab goes away the old tab keeps the link', async () => {
    const { helper } = await start();
    const { tab: a } = await activeTab(helper, 'tab-a');
    const busy = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const msg = await a.next('call');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    await sleep(60);
    await b.drop();
    a.send({ type: 'result', callId: msg.callId, result: { success: true } });
    await busy;
    await a.quiet(100);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('row 9: a call held for a waiting takeover goes to the old tab as soon as the waiting tab closes — answered by A well before the timeout (review B2 repro)', async () => {
    const { helper } = await start({ toolTimeoutMs: 3000 });
    const { tab: a } = await activeTab(helper, 'tab-a');
    const busy = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const move = await a.next('call');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    await sleep(60);
    const t0 = Date.now();
    const held = helper.call('context', {}, undefined);
    await sleep(60);
    expect(a.inbox).toEqual([]); // held while B waits
    await b.drop();
    const ctx = await a.next('call', 1000);
    expect(ctx).toMatchObject({ toolName: 'context' });
    a.send({ type: 'result', callId: move.callId, result: { success: true } });
    expect(await busy).toEqual({ success: true });
    a.send({ type: 'result', callId: ctx.callId, result: { success: true, data: 'from A' } });
    expect(await held).toEqual({ success: true, data: 'from A' });
    expect(Date.now() - t0).toBeLessThan(1500);
    await a.quiet(100); // A keeps the link
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('row 9: Cancel on the waiting tab (§36: its link closes with 1000) sends a held mutating call to the old tab at once, under A\'s connection', async () => {
    const { helper } = await start({ toolTimeoutMs: 3000 });
    const { tab: a, connId } = await activeTab(helper, 'tab-a');
    const reading = helper.call('context', {}, undefined);
    const read = await a.next('call');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    await sleep(60);
    const held = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    await sleep(60);
    expect(a.inbox).toEqual([]);
    const t0 = Date.now();
    b.ws.close(1000); await b.closed;
    const move = await a.next('call', 1000);
    expect(move).toMatchObject({ toolName: 'moveItem', executionKey: `mcp:${connId}:${move.callId}` });
    a.send({ type: 'result', callId: move.callId, result: { success: true, data: 'moved by A' } });
    expect(await held).toEqual({ success: true, data: 'moved by A' });
    expect(Date.now() - t0).toBeLessThan(1000);
    a.send({ type: 'result', callId: read.callId, result: { success: true } });
    await reading;
    await a.quiet(100);
  });

  it('row 9: a held call with no tab left to take it (every pairing revoked while a takeover waits) is refused at once with TAB_NOT_CONNECTED and never sent', async () => {
    const { helper } = await start({ toolTimeoutMs: 3000 });
    const { tab: a } = await activeTab(helper, 'tab-a');
    void helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    await a.next('call');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    await sleep(60);
    const held = helper.call('context', {}, undefined);
    await sleep(60);
    const t0 = Date.now();
    helper.revokeAll();
    expect(await held).toEqual({ success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await a.closed).code).toBe(4401);
    expect((await b.closed).code).toBe(4401);
    expect([...a.inbox, ...b.inbox].filter(m => m.type === 'call')).toEqual([]);
  });

  it('row 9: a waiting tab that says hello again without takeover, or with a token the helper does not know, stops waiting; held calls go to the old tab at once', async () => {
    for (const again of [{}, { token: newToken() }]) {
      const { helper } = await start({ toolTimeoutMs: 3000 });
      const { tab: a } = await activeTab(helper, 'tab-a');
      const busy = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
      const move = await a.next('call');
      const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
      await sleep(60);
      const held = helper.call('context', {}, undefined);
      await sleep(60);
      b.send({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-b', ...again });
      const ctx = await a.next('call', 1000);
      expect(ctx.toolName, JSON.stringify(again)).toBe('context');
      a.send({ type: 'result', callId: ctx.callId, result: { success: true } });
      expect(await held).toEqual({ success: true });
      a.send({ type: 'result', callId: move.callId, result: { success: true } });
      await busy;
      await a.quiet(100); // no takeover once A is idle: B no longer waits
      expect(a.ws.readyState).toBe(WebSocket.OPEN);
    }
  });

  it('row 9: the old tab reconnecting as itself while a takeover waits reclaims the link — its running call is re-sent, held calls follow, the waiter is told TAB_ACTIVE_ELSEWHERE', async () => {
    const { helper } = await start({ toolTimeoutMs: 3000 });
    const { tab: a, token, connId } = await activeTab(helper, 'tab-a');
    const busy = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const move = await a.next('call');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    await sleep(60);
    const held = helper.call('context', {}, undefined);
    await sleep(60);
    const fresh = await RawTab.open(helper.port);
    fresh.send({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-a', token, connId });
    expect(await b.next('error')).toEqual({ type: 'error', code: 'TAB_ACTIVE_ELSEWHERE', message: LINK_ERRORS.TAB_ACTIVE_ELSEWHERE });
    expect(await fresh.next('hello')).toMatchObject({ paired: true, active: true, connId });
    expect(await fresh.next('call')).toMatchObject({ callId: move.callId, executionKey: move.executionKey });
    const ctx = await fresh.next('call');
    expect(ctx.toolName).toBe('context');
    fresh.send({ type: 'result', callId: move.callId, result: { success: true } });
    fresh.send({ type: 'result', callId: ctx.callId, result: { success: true, data: 'reclaimed' } });
    expect(await busy).toEqual({ success: true });
    expect(await held).toEqual({ success: true, data: 'reclaimed' });
    expect((await a.closed).code).toBe(4410);
  });

  it('row 9: if the active tab goes away while a takeover waits, the waiter becomes active at once and gets the held calls', async () => {
    const { helper } = await start({ toolTimeoutMs: 5000 });
    const { tab: a } = await activeTab(helper, 'tab-a');
    const busy = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    await a.next('call');
    const { tab: b } = await tabOf(helper, 'tab-b', { takeover: true });
    await sleep(60);
    const held = helper.call('context', {}, undefined);
    await sleep(60);
    await a.drop();
    expect(await b.next('hello')).toMatchObject({ paired: true, active: true });
    expect(await busy).toEqual({ success: false, code: 'TAB_NOT_CONNECTED', error: DISCONNECTED_ERROR, operationMayHaveRun: true });
    const ctx = await b.next('call', 1000);
    expect(ctx.toolName).toBe('context');
    b.send({ type: 'result', callId: ctx.callId, result: { success: true, data: 'from B' } });
    expect(await held).toEqual({ success: true, data: 'from B' });
  });

  it('row 9: a takeover with a tab that is not paired is not honoured', async () => {
    const { helper } = await start();
    const { tab: a } = await activeTab(helper, 'tab-a');
    const intruder = await RawTab.open(helper.port);
    intruder.send({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-z', takeover: true });
    expect(await intruder.next('hello')).toMatchObject({ paired: false, active: false });
    await a.quiet(80);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });
});
