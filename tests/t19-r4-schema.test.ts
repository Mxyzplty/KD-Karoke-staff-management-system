// SPDX-License-Identifier: AGPL-3.0-only
// T19 review fix R4: the helper's viewItemDetails schema accepts the contract params (granularity, sectionIds, page, limit,
// previews, timestamps), which the T19 handler ignores; subdivisionsPerBeat accepts 2/3/4 and their string forms. Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { validate } from '../apps/helper/src/schemas';
import { Executor } from '../apps/web/src/agent/executor';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, fixture, links } from './t03-fixtures';

type Rec = Record<string, any>;
const ENUM_MSG = 'must be equal to one of the allowed values';
const invalid = (errors: { path: string; code: string; message: string }[]) => ({
  success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for viewItemDetails', message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors },
});

describe('T19 R4 viewItemDetails schema: the contract params pass', () => {
  it.each<[string, Rec]>([
    ['previews false', { itemId: 'x', include: 'transcript', previews: false }],
    ['granularity sections', { itemId: 'x', include: 'transcript', granularity: 'sections' }],
    ['granularity full', { itemId: 'x', include: 'transcript', granularity: 'full' }],
    ['sectionIds', { itemId: 'x', include: 'transcript', sectionIds: [1, 2] }],
    ['page', { itemId: 'x', include: 'transcript', page: 2 }],
    ['limit 5', { itemId: 'x', include: 'transcript', limit: 5 }],
    ['limit above 10 (capped by the handler, not refused)', { itemId: 'x', include: 'transcript', limit: 50 }],
    ['timestamps', { itemId: 'x', include: 'keyframes', timestamps: [1, 2.5] }],
    ['timestamps without a maxItems (extras are dropped by the handler)', { itemId: 'x', include: 'keyframes', timestamps: Array.from({ length: 40 }, (_, i) => i) }],
    ['all of them', { assetId: 'video_1', include: ['transcript'], granularity: 'full', sectionIds: [0], page: 1, limit: 10, previews: true, timestamps: [0] }],
  ])('%s → null', (_name, input) => { expect(validate('viewItemDetails', input)).toBeNull(); });
});

describe('T19 R4 viewItemDetails schema: the contract params are typed', () => {
  it.each<[string, Rec, { path: string; code: string; message: string }[]]>([
    ['granularity "x"', { itemId: 'x', granularity: 'x' }, [{ path: '$.granularity', code: 'ENUM', message: ENUM_MSG }]],
    ['previews "no"', { itemId: 'x', previews: 'no' }, [{ path: '$.previews', code: 'TYPE', message: 'must be boolean' }]],
    ['sectionIds ["a"]', { itemId: 'x', sectionIds: ['a'] }, [{ path: '$.sectionIds.0', code: 'TYPE', message: 'must be number' }]],
    ['page "1"', { itemId: 'x', page: '1' }, [{ path: '$.page', code: 'TYPE', message: 'must be number' }]],
    ['limit "5"', { itemId: 'x', limit: '5' }, [{ path: '$.limit', code: 'TYPE', message: 'must be number' }]],
    ['timestamps ["a"]', { itemId: 'x', timestamps: ['a'] }, [{ path: '$.timestamps.0', code: 'TYPE', message: 'must be number' }]],
  ])('%s → the exact detail', (_name, input, errors) => { expect(validate('viewItemDetails', input)).toEqual(invalid(errors)); });
});

describe('T19 R4 viewItemDetails schema: subdivisionsPerBeat', () => {
  it.each([4, '4', 2, '2', 3, '3'])('%j passes', value => { expect(validate('viewItemDetails', { itemId: 'x', subdivisionsPerBeat: value })).toBeNull(); });
  it.each([5, '5', 1, '1', 0, 'x'])('%j → ENUM at $.subdivisionsPerBeat', value => {
    expect(validate('viewItemDetails', { itemId: 'x', subdivisionsPerBeat: value })).toEqual(invalid([{ path: '$.subdivisionsPerBeat', code: 'ENUM', message: ENUM_MSG }]));
  });
});

describe('T19 R4 through the executor: the params are ignored, not refused', () => {
  it('{itemId, include: "transcript", previews: false, page: 1} returns the transcript', async () => {
    const words = 'alpha beta gamma'.split(' ').map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const rows: Rec = { transcripts: { 'asset-vid1': { id: 'asset-vid1', status: 'complete', transcript: { words }, created_at: 'x' } } };
    const store = { row: vi.fn(async (s: string, id: string) => rows[s]?.[id]), putRow: async () => {}, media: {} };
    const editor = createEditor(fixture(), { assets: assets(), links: links() });
    const data = new Map<string, string>();
    const ex = new Executor({ storage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } }, current: () => editor.runtime,
      ui: () => ({ selection: [], playheadMs: 0 }), analysis: (async () => ({ store, service: {} })) as never });
    const call = (input: Rec) => ex.execute({ type: 'call', callId: 'c1', executionKey: 'mcp:conn:c1', toolName: 'viewItemDetails', input, session: 's' } as never) as Promise<Rec>;
    const plain = await call({ itemId: 'v1', include: 'transcript' });
    const extra = await call({ itemId: 'v1', include: 'transcript', previews: false, page: 1, limit: 5, granularity: 'full', sectionIds: [0], timestamps: [1] });
    expect(plain.success, JSON.stringify(plain)).toBe(true);
    expect(extra).toEqual(plain);
    expect(extra.data.transcription).toBeDefined();
  });
});
