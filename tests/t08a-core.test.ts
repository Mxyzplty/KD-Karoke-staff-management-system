// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { graphicTimeMs, graphicFrame } from '../apps/web/src/mg/clock';
import { editMotionGraphicCode, patchCode, validateSummary } from '../apps/web/src/mg/edits';
import { FrameCache } from '../apps/web/src/mg/cache';

describe('motion graphic source clock', () => {
  it('accounts for clip start, trim start, negative offsets and designed length', () => {
    const base = { clipStartMs: 82_000, trimStartMs: 1000, designedLengthMs: 6000 };
    expect(graphicTimeMs({ ...base, timelineTimeMs: 82_000 })).toBe(1000);
    expect(graphicTimeMs({ ...base, timelineTimeMs: 83_000 })).toBe(2000);
    expect(graphicTimeMs({ ...base, timelineTimeMs: 80_000 })).toBe(0);
    expect(graphicTimeMs({ ...base, timelineTimeMs: 90_000 })).toBe(6000);
    expect(graphicTimeMs({ timelineTimeMs: 0, clipStartMs: -1000, trimStartMs: 0 })).toBe(1000);
    expect(graphicFrame({ ...base, timelineTimeMs: 82_000, fps: 30 })).toBe(30);
    expect(graphicFrame({ ...base, timelineTimeMs: 83_000, fps: 30 })).toBe(60);
  });
});

describe('motion graphic source edits', () => {
  it('validates the summary boundary', () => {
    expect(validateSummary('x'.repeat(400))).toMatchObject({ valid: true, summary: 'x'.repeat(400) });
    expect(validateSummary('x'.repeat(401))).toMatchObject({ valid: false, reason: 'too-long', message: 'Motion graphic summary must be 400 characters or less.' });
    expect(validateSummary('')).toMatchObject({ valid: false, reason: 'required' });
    expect(validateSummary('  first\n   second  ')).toMatchObject({ valid: true, summary: 'first second' });
  });

  it('fails a mixed patch atomically and reports each ordered status', () => {
    const original = 'red red';
    try {
      patchCode(original, [{ old_string: 'red', new_string: 'blue' }, { old_string: 'missing', new_string: 'green' }]);
      throw Error('expected patch failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'STRING_NOT_FOUND', details: { patches: ['OK: replaced "red..."', 'NOT FOUND: "missing..."'] } });
      expect(original).toBe('red red');
    }
  });

  it('replaces exact strings, first match only, and applies patches in order', () => {
    expect(editMotionGraphicCode('foo foo', { old_string: 'foo', new_string: 'bar' })).toBe('bar foo');
    const result = patchCode('red red', [
      { old_string: 'red', new_string: 'blue' },
      { old_string: 'blue', new_string: 'green' },
    ]);
    expect(result.code).toBe('green red');
    expect(result.patches).toHaveLength(2);
    expect(() => patchCode('red', [{ old_string: 'RED', new_string: 'blue' }])).toThrow();
    expect(() => editMotionGraphicCode('red', { old_string: 'red ', new_string: 'blue' })).toThrow();
  });
});

describe('bounded frame cache', () => {
  it('evicts oldest entries at the byte limit and resets accounting on clear', () => {
    const cache = new FrameCache<string>(8);
    cache.set('first', 'A', 4);
    cache.set('second', 'B', 4);
    expect(cache.get('first')).toBe('A');
    cache.set('third', 'C', 4);
    expect(cache.get('first')).toBeUndefined();
    expect(cache.get('second')).toBe('B');
    expect(cache.get('third')).toBe('C');
    expect(cache.stats).toEqual({ bytes: 8, entries: 2 });
    cache.clear();
    expect(cache.stats).toEqual({ bytes: 0, entries: 0 });
  });

  it('does not retain a frame larger than the cache budget', () => {
    const cache = new FrameCache<string>(8);
    cache.set('oversized', 'large', 9);
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.stats.bytes).toBeLessThanOrEqual(8);
  });
});
