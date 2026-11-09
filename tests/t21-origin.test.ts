// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 14 (D34, T18a Q17): the helper allows the editor's own served origins and --allow-origin extras, by exact match.
import { describe, expect, test } from 'vitest';
import { OWN_ORIGINS, originAllowed } from '../apps/helper/src/helper';

describe('OWN_ORIGINS', () => {
  test('the four dev and preview origins, loopback only', () => {
    expect([...OWN_ORIGINS].sort()).toEqual(['http://127.0.0.1:4173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://localhost:5173']);
  });
});

describe('originAllowed', () => {
  test.each(OWN_ORIGINS)('%s is allowed', origin => expect(originAllowed(origin)).toBe(true));
  test('another origin is refused', () => {
    expect(originAllowed('http://evil.com')).toBe(false);
    expect(originAllowed('https://evil.com')).toBe(false);
  });
  test('exact match only: other ports, schemes, hosts, paths and look-alikes are refused', () => {
    for (const o of ['http://127.0.0.1:5174', 'http://127.0.0.1', 'https://127.0.0.1:5173', 'http://[::1]:5173', 'http://127.0.0.1:5173/', 'http://127.0.0.1:5173.evil.com',
      'http://evil.com:5173', 'http://localhost:5173@evil.com', 'HTTP://127.0.0.1:5173', 'null', '']) expect(originAllowed(o), o).toBe(false);
  });
  test('extra origins are allowed by exact match, and only for that call', () => {
    expect(originAllowed('http://evil.com', ['http://evil.com'])).toBe(true);
    expect(originAllowed('http://127.0.0.1:5175', new Set(['http://127.0.0.1:5175']))).toBe(true);
    expect(originAllowed('http://evil.com:81', ['http://evil.com'])).toBe(false);
    expect(originAllowed('http://evil.com')).toBe(false);
    expect(originAllowed('http://127.0.0.1:5173', ['http://evil.com'])).toBe(true);
  });
  test('a missing origin is refused, with or without extras', () => {
    expect(originAllowed(undefined)).toBe(false);
    expect(originAllowed(undefined, ['http://evil.com'])).toBe(false);
  });
});
