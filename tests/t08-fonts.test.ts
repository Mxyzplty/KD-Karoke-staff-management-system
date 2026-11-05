// SPDX-License-Identifier: AGPL-3.0-only
// T08 bundled fonts: the faces the sandbox draws, their vendored licence record, and the warning catalogue that must follow them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SANDBOX_FAMILIES } from '../apps/web/src/mg/agent-checks';
import { SANDBOX_FONTS } from '../apps/web/src/mg/fonts';
import { checkVendor } from '../scripts/licenses';

const ROBOTO_FILES = [
  { path: 'vendor/roboto/Roboto-Regular.ttf', bytes: 129584, sha256: 'e294f7580d272f024161c6e5c744278f90d45ee67846f66d4083f7aef61c979e' },
  { path: 'vendor/roboto/Roboto-Bold.ttf', bytes: 167336, sha256: 'baf44ce81636cc927fc27768437e5da853bac699e8aaf832d042f0dfed29b4b4' },
  { path: 'vendor/roboto/LICENSE-2.0.txt', bytes: 11358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
];

describe('SANDBOX_FONTS', () => {
  it('is exactly Roboto 400 and Roboto 700', () => {
    expect(SANDBOX_FONTS.map(f => [f.family, f.weight])).toEqual([['Roboto', 400], ['Roboto', 700]]);
  });
  it('carries each face as a TTF data URL', () => {
    for (const f of SANDBOX_FONTS) {
      expect(f.src.startsWith('data:font/ttf;base64,'), `${f.family} ${f.weight}`).toBe(true);
      expect(f.src.length).toBeGreaterThan(100_000);
    }
  });
});

describe('vendored Roboto', () => {
  it('checkVendor() reports no errors', async () => { expect((await checkVendor()).errors).toEqual([]); });
  it('the manifest holds one Apache-2.0 component with exactly the three Roboto files, sizes and hashes', () => {
    const manifest = JSON.parse(readFileSync('vendor/manifest.json', 'utf8')) as { components: { name: string; license: string; files: { path: string; bytes: number; sha256: string }[] }[] };
    const roboto = manifest.components.filter(c => c.files.some(f => f.path.startsWith('vendor/roboto/')));
    expect(roboto).toHaveLength(1);
    expect(roboto[0].license).toBe('Apache-2.0');
    expect(roboto[0].files).toEqual(ROBOTO_FILES);
  });
});

describe('SANDBOX_FAMILIES', () => {
  it('equals the lowercase families in SANDBOX_FONTS, so the warning catalogue cannot drift from the bundle', () => {
    expect([...SANDBOX_FAMILIES].sort()).toEqual([...new Set(SANDBOX_FONTS.map(f => f.family.toLowerCase()))].sort());
  });
});
