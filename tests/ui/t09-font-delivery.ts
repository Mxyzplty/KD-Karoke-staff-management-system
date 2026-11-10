// SPDX-License-Identifier: AGPL-3.0-only
// T09-only positive delivery: byte-identical official Open Sans 3.003 (OFL-1.1), with correct normal weight descriptors.
// The source licence/provenance and stored/decoded hashes are in vendor/manifest.json. Refusal tests never install this route.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
const bytes = Buffer.from(readFileSync(new URL('../../vendor/open-sans/OpenSans.ttf.b64', import.meta.url), 'ascii'), 'base64');
if (bytes.length !== 532636 || createHash('sha256').update(bytes).digest('hex') !== '36643644f318a812aab2d2ed3bb98f8cf0872527f835fe9398d95fe6b9adb878') throw new Error('T09 Open Sans original font bytes differ');
export async function positiveOpenSans(page: Page) {
  await page.route(/https:\/\/fonts\.googleapis\.com\/css2\?family=Open\+Sans:/, async route => {
    const family = new URL(route.request().url()).searchParams.get('family') ?? '', match = /^Open Sans:ital,wght@0,(\d+)$/.exec(family);
    if (!match || +match[1] < 300 || +match[1] > 800) return route.fallback();
    const fontUrl = new URL('/__t09-open-sans.ttf', page.url()).href;
    await route.fulfill({ contentType: 'text/css', body: `@font-face{font-family:'Open Sans';font-style:normal;font-weight:${match[1]};src:url(${fontUrl}) format('truetype');}` });
  });
  await page.route('**/__t09-open-sans.ttf', route => route.fulfill({ contentType: 'font/ttf', body: bytes }));
}
