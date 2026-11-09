// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 8 with the real embedding model (T19's all-MiniLM-L6-v2, served from the fixture store): every answer here
// comes from the embedder, never the lexical fallback, because the test counts the vectors it hands back.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { skipTour } from './t02-support';
import { QUESTIONS } from '../t21-help-questions';

const STORE = process.env.CUTFRAME_FIXTURES;
test.skip(!STORE, 'needs $CUTFRAME_FIXTURES fixture store');
test.setTimeout(180_000);

type Answer = { found: boolean; sections: { section_id: string; similarity: number }[] };
const PARAPHRASES: [string, string][] = [['turn speech into subtitles automatically', 'captions'], ['make the footage look black and white', 'effects'], ['send the finished film to a file', 'export']];

test('paraphrases and the 20 scripted questions find their sections through the embedder; nonsense finds nothing', async ({ page }) => {
  const { models } = JSON.parse(readFileSync('datasets/manifest.json', 'utf8')) as { models: { id: string; files: { path: string }[] }[] };
  const files = new Map(models.find(m => m.id === 'T19a-embedding')!.files.map(f => [f.path.replace(/^models\/t19a\//, ''), path.join(STORE!, f.path)]));
  await page.route('**/models/**', route => {
    const file = files.get(decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/models\//, '')));
    return file ? route.fulfill({ path: file }) : route.abort();
  });
  await skipTour(page);
  await page.goto('/');
  const { answers, vectors } = await page.evaluate(async queries => {
    const h = '/src/settings/help.ts', { helpTool, localEmbed } = await import(h);
    let vectors = 0;
    const embed = async (texts: string[]) => { const v = await localEmbed(texts); if (!v) throw new Error('no embedder'); vectors += v.length; return v; };
    const answers: Record<string, Answer> = {};
    await embed(['load the model']); // help waits 10 s for the embedder; a model load on a busy test machine is not what is under test
    for (const query of queries) answers[query] = await helpTool('searchHelpDocs', { query }, embed) as Answer;
    return { answers, vectors };
  }, [...PARAPHRASES.map(q => q[0]), ...QUESTIONS.map(q => q[0]), 'zebra quantum pancake']);
  expect(vectors, 'section vectors, then one per query').toBeGreaterThan(PARAPHRASES.length + QUESTIONS.length);
  for (const [query, id] of [...PARAPHRASES, ...QUESTIONS]) {
    expect(answers[query].found, query).toBe(true);
    expect(answers[query].sections.map(s => s.section_id), query).toContain(id);
    for (const s of answers[query].sections) { expect(s.similarity).toBeGreaterThanOrEqual(30); expect(s.similarity).toBeLessThanOrEqual(65); }
    expect(answers[query].sections.length).toBeLessThanOrEqual(5);
  }
  expect(answers['zebra quantum pancake'].found).toBe(false);
});
