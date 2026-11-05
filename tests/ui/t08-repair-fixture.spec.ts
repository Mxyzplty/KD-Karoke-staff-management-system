// SPDX-License-Identifier: AGPL-3.0-only
// T08 repair run, F27 (b): the 10-snippet fixture (scripts/t08-repair-fixture.ts) through repairGraphic with the real renderer as validate.
// Without CUTFRAME_REPAIR_* the model is a mock that answers each snippet's reference fix: 10 of 10 repaired on attempt 1.
// With them (Author's run) the user's own OpenAI-compatible model is asked: >= 8 of 10 repaired and valid, every failure reported, none saved broken:
//   CUTFRAME_REPAIR_ENDPOINT=<private> CUTFRAME_REPAIR_MODEL=<private> CUTFRAME_REPAIR_KEY=<private> npx playwright test tests/ui/t08-repair-fixture.spec.ts
// Oracle: ticket T08 "Repair tests" (b), findings part 2 §33 (2 attempts, the second carries the first's code and error), F27.
import { test, expect, type Page } from '@playwright/test';
import { FRAMES, ITEM, SNIPPETS, apiNames, callModel, modelEnv, systemPrompt } from '../../scripts/t08-repair-fixture';
import type { RepairRequest } from '../../apps/web/src/mg/repair';

const env = modelEnv();
test.setTimeout(env ? 600_000 : 120_000);
const REPAIR_FAILED = 'Could not repair this motion graphic';
const SIZE = { width: ITEM.width, height: ITEM.height };

type Answer = { code: string } | { error: string };
type Validation = { code: string; error: string | null };
type Outcome = { ok: boolean; attempts: number; reason?: string; message?: string; saved: string | null; startError: string; validations: Validation[] };

async function runSnippet(page: Page, id: string, code: string, error: string | undefined) {
  return page.evaluate(async ({ id, code, error, frames, item, size }) => {
    const idx = '/src/mg/index.ts', rep = '/src/mg/repair.ts', chk = '/src/mg/agent-checks.ts';
    const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ idx), { repairGraphic } = await import(/* @vite-ignore */ rep), { nativeMediaRefusal } = await import(/* @vite-ignore */ chk);
    const w = window as any, renderer = createMotionGraphicRenderer();
    const renderError = async (c: string): Promise<string | null> => {
      for (const frame of frames) {
        try { await renderer.render({ code: c, frame, width: item.width, height: item.height, fps: item.fps, durationInFrames: item.durationInFrames, itemSize: size }); }
        catch (e) { return e instanceof Error ? e.message : String(e); }
      }
      return null;
    };
    const validations: { code: string; error: string | null }[] = [];
    const validate = async (c: string) => {
      const problem = nativeMediaRefusal(c) ?? await renderError(c) ?? await w.fixtureCheck(id, c);
      validations.push({ code: c, error: problem });
      return problem as string | null;
    };
    const startError = error ?? nativeMediaRefusal(code) ?? await renderError(code) ?? 'no error';
    let saved: string | null = null;
    const record = { id, type: 'motionGraphic', trackId: 'o1', display: { from: 0, to: 3000 }, trim: { from: 0, to: 3000 }, playbackRate: 1, sourceDuration: 3000, details: { name: id, code }, metadata: {}, properties: {}, masks: [], effects: [] };
    const result = await repairGraphic(record, startError, size, { model: w.repairModel, validate, current: () => record, save: (c: string) => { saved = c; return null; } });
    renderer.dispose();
    return { ...result, saved, startError, validations };
  }, { id, code, error, frames: FRAMES, item: ITEM, size: SIZE }) as Promise<Outcome & { reason?: string; message?: string }>;
}
/** A fresh renderer: does the saved code render at every frame, and pass the snippet's check? */
async function revalidate(page: Page, id: string, code: string) {
  return page.evaluate(async ({ id, code, frames, item, size }) => {
    const idx = '/src/mg/index.ts', chk = '/src/mg/agent-checks.ts';
    const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ idx), { nativeMediaRefusal } = await import(/* @vite-ignore */ chk);
    const renderer = createMotionGraphicRenderer(), problems: string[] = [];
    const refusal = nativeMediaRefusal(code); if (refusal) problems.push(refusal);
    for (const frame of frames) {
      try { await renderer.render({ code, frame, width: item.width, height: item.height, fps: item.fps, durationInFrames: item.durationInFrames, itemSize: size }); }
      catch (e) { problems.push(`frame ${frame}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    renderer.dispose();
    const check = await (window as any).fixtureCheck(id, code); if (check) problems.push(check);
    return problems;
  }, { id, code, frames: FRAMES, item: ITEM, size: SIZE });
}

test('F27 (b): the 10 defective snippets through repairGraphic with the real renderer as validate', async ({ page }) => {
  let current = SNIPPETS[0];
  const requests: RepairRequest[] = [], answers: Answer[] = [];
  const system = systemPrompt(apiNames());
  await page.exposeFunction('repairModel', async (request: RepairRequest) => {
    requests.push(structuredClone(request));
    const answer: Answer = env ? await callModel(env, system, request).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })) : { code: current.fixed };
    answers.push(answer);
    return answer;
  });
  await page.exposeFunction('fixtureCheck', (id: string, code: string) => SNIPPETS.find(s => s.id === id)?.check?.(code) ?? null);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/src/mg/harness.html');

  type Row = { id: string; ok: boolean; attempts: number; message: string; outcome: Outcome; requests: RepairRequest[]; answers: Answer[]; after: string[] };
  const rows: Row[] = [];
  for (const snippet of SNIPPETS) {
    current = snippet; requests.length = 0; answers.length = 0;
    const outcome = await runSnippet(page, snippet.id, snippet.code, snippet.error);
    const after = outcome.saved === null ? [] : await revalidate(page, snippet.id, outcome.saved);
    rows.push({ id: snippet.id, ok: outcome.ok, attempts: outcome.attempts, message: outcome.ok ? '' : outcome.message ?? '', outcome, requests: [...requests], answers: [...answers], after });
  }

  const table = ['| snippet | repaired | attempts | message |', '|---|---|---|---|', ...rows.map(r => `| ${r.id} | ${r.ok ? 'yes' : 'NO'} | ${r.attempts} | ${r.message.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '', `${rows.filter(r => r.ok).length} of ${rows.length} repaired (${env ? `model ${env.model}` : 'mock model: the reference fixes'}).`].join('\n');
  await test.info().attach('repair-results.md', { body: table, contentType: 'text/markdown' });
  await test.info().attach('repair-results.json', { body: JSON.stringify(rows.map(({ id, ok, attempts, message }) => ({ id, ok, attempts, message })), null, 2), contentType: 'application/json' });
  console.log(`\n${table}\n`);

  expect(errors, 'errors thrown in the page').toEqual([]);
  expect(rows.map(r => r.id)).toEqual(SNIPPETS.map(s => s.id));
  expect(SNIPPETS).toHaveLength(10);

  // Both: the requests carry {code, error, itemWidth, itemHeight}; the first starts from the snippet's code and the start error; the second carries the first attempt's result.
  for (const r of rows) {
    const snippet = SNIPPETS.find(s => s.id === r.id)!;
    expect(r.requests.length, `${r.id}: at most 2 model calls`).toBeLessThanOrEqual(2);
    expect(r.requests.length, `${r.id}: at least one model call`).toBeGreaterThanOrEqual(1);
    for (const q of r.requests) {
      expect(Object.keys(q).sort(), `${r.id}: request keys`).toEqual(['code', 'error', 'itemHeight', 'itemWidth']);
      expect(q.itemWidth).toBe(540); expect(q.itemHeight).toBe(960);
      expect(typeof q.code).toBe('string'); expect(q.error.length, `${r.id}: the request carries an error`).toBeGreaterThan(0);
    }
    expect(r.requests[0], `${r.id}: request 1`).toEqual({ code: snippet.code, error: r.outcome.startError, itemWidth: 540, itemHeight: 960 });
    if (snippet.error) expect(r.outcome.startError).toBe(snippet.error);
    if (r.requests.length === 2) { // attempt 2 carries attempt 1's code and the error that code got (or, when the model gave no code, the previous code and error)
      const first = r.answers[0], firstCode = 'code' in first ? first.code : undefined, validated = firstCode === undefined ? undefined : r.outcome.validations.find(v => v.code === firstCode);
      if (validated) expect(r.requests[1], `${r.id}: request 2`).toEqual({ code: firstCode, error: validated.error, itemWidth: 540, itemHeight: 960 });
      else expect(r.requests[1], `${r.id}: request 2 after an answer without usable code`).toEqual(r.requests[0]);
    }
    // Every saved code is the repaired one, renders at FRAMES in a fresh renderer and passes the check; a failure saved nothing.
    if (r.ok) {
      expect(r.outcome.saved, `${r.id}: saved`).not.toBeNull();
      expect(r.after, `${r.id}: the saved code re-validates clean`).toEqual([]);
      expect(r.answers[r.attempts - 1], `${r.id}: the saved code is the model's answer`).toEqual({ code: r.outcome.saved });
    } else {
      expect(r.outcome.saved, `${r.id}: nothing saved for a failed repair`).toBeNull();
      expect(r.outcome.reason, `${r.id}: reason`).toBe('failed');
      expect(r.message.startsWith(REPAIR_FAILED), `${r.id}: "${r.message}" starts with the failure text`).toBe(true);
    }
  }

  const repaired = rows.filter(r => r.ok).length;
  if (env) expect(repaired, `repaired by ${env.model}\n${table}`).toBeGreaterThanOrEqual(8);
  else {
    expect(repaired).toBe(10);
    for (const r of rows) { expect(r.attempts, `${r.id}: attempts`).toBe(1); expect(r.requests, `${r.id}: one request`).toHaveLength(1); expect(r.outcome.saved).toBe(SNIPPETS.find(s => s.id === r.id)!.fixed); }
  }
});
