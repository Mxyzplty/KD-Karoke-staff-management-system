// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test('sandbox dry run reports the thrown message, invalid component and unknown asset', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const errors = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer();
    const messages = [];
    for (const code of [
      `export const Graphic = () => { throw Error('authored dry-run failure'); };`,
      `export const Graphic = 123;`,
      `export const Graphic = () => <div>{getAssetUrl('missing')}</div>;`,
    ]) {
      try { await renderer.compile(code); messages.push(null); }
      catch (e) { const error = e as Error & { code?: string }; messages.push({ code: error.code, message: error.message }); }
    }
    renderer.dispose(); return messages;
  });
  expect(errors[0]).toMatchObject({ code: 'COMPILATION_ERROR', message: 'compilation error: authored dry-run failure' });
  expect(errors[1]).toMatchObject({ code: 'COMPILATION_ERROR', message: 'compilation error: Compiled code did not produce a valid React component' });
  expect(errors[2]).toMatchObject({ code: 'VALIDATION_ERROR', message: "getAssetUrl() takes a project asset's agentId. 'missing' is not an asset attached to this project." });
});

test('a forged window message cannot complete a render or substitute its image', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer();
    const pending = renderer.render({ code: `export const Graphic = () => <AbsoluteFill style={{backgroundColor:'#00ff00'}} />;`, frame: 0, width: 16, height: 16 });
    for (let i = 0; i < 10; i++) {
      window.postMessage({ type: 'mg:ready' }, '*');
      window.postMessage({ ok: true, image: 'data:image/png;base64,ZmFrZQ==', width: 16, height: 16, boxes: [] }, '*');
    }
    const frame = await pending; renderer.dispose();
    const image = new Image(); image.src = frame.image; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return Array.from(ctx.getImageData(8, 8, 1, 1).data);
  });
  expect(result).toEqual([0, 255, 0, 255]);
});

test('network and storage escape attempts cannot succeed', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('t08a-probe.invalid')) requests.push(request.url()); });
  await page.goto('/src/mg/harness.html');
  const outcomes = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer(); const outcomes: string[] = [];
    await renderer.compile('export const Graphic = () => <div>safe</div>;');
    const attempts = [
      `fetch('https://t08a-probe.invalid/fetch')`, `new XMLHttpRequest()`, `new WebSocket('wss://t08a-probe.invalid/ws')`,
      `new EventSource('https://t08a-probe.invalid/events')`, `localStorage.setItem('escape','1')`,
      `sessionStorage.setItem('escape','1')`, `indexedDB.open('escape')`, `caches.open('escape')`,
      `window.parent.document.body`, `window.top.document.body`, `document.cookie`, `navigator.storage.getDirectory()`,
      `setTimeout('fetch("https://t08a-probe.invalid/timer")',0)`,
      `({})?.['constructor']`, `({})['con'+'structor']`,
    ];
    for (const attempt of attempts) {
      const code = `export const Graphic = () => { ${attempt}; return <div>escaped</div>; };`;
      try { await renderer.compile(code); outcomes.push('escaped'); }
      catch (e) { outcomes.push((e as Error & { code?: string }).code ?? 'blocked'); }
    }
    renderer.dispose(); return outcomes;
  });
  expect(outcomes).toHaveLength(15);
  expect(outcomes).not.toContain('escaped');
  expect(outcomes).not.toContain('MG_WATCHDOG');
  expect(requests).toEqual([]);
});

test('DOM image, script and CSS cannot load external resources', async ({ page }) => {
  const requests: string[] = [];
  const failures: string[] = [];
  page.on('request', request => { if (request.url().includes('t08a-probe.invalid')) requests.push(request.url()); });
  page.on('requestfailed', request => { if (request.url().includes('t08a-probe.invalid')) failures.push(request.failure()?.errorText ?? 'unknown'); });
  await page.goto('/src/mg/harness.html');
  const outcomes = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer(); const results = [];
    for (const code of [
      `export const Graphic = () => <svg><image href="https://t08a-probe.invalid/image" width="10" height="10" /></svg>;`,
      `export const Graphic = () => <div style={{backgroundImage:'url(https://t08a-probe.invalid/css)'}}>safe</div>;`,
      `export const Graphic = () => <script src="https://t08a-probe.invalid/script" />;`,
    ]) {
      try { await renderer.render({ code, frame: 0, width: 16, height: 16 }); results.push('rendered'); }
      catch (e) { results.push((e as Error & { code?: string }).code ?? 'rejected'); }
    }
    renderer.dispose(); return results;
  });
  expect(outcomes[2]).not.toBe('rendered');
  expect(outcomes).not.toContain('MG_WATCHDOG');
  expect(failures).toHaveLength(requests.length);
  expect(failures).toEqual(Array(failures.length).fill('csp'));
});

test('oversized sandbox allocation is rejected with a memory error', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const code = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer();
    try { await renderer.compile('export const Graphic = () => { const x = new Uint8Array(2000000); return <div>{x.length}</div>; };'); return 'escaped'; }
    catch (e) { return (e as Error & { code?: string }).code; }
    finally { renderer.dispose(); }
  });
  expect(code).toBe('MG_MEMORY_LIMIT');
});

test('extreme spring fps is rejected promptly while the host stays responsive', async ({ page }) => {
  test.setTimeout(10_000);
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer(); let ticks = 0; const heartbeat = setInterval(() => ticks++, 5); const start = performance.now();
    let error = '';
    try { await renderer.compile('export const Graphic = () => <div>{spring({frame:1,fps:1e12})}</div>;'); }
    catch (e) { error = String(e); }
    const elapsed = performance.now() - start; clearInterval(heartbeat); renderer.dispose();
    return { error, elapsed, ticks };
  });
  expect(result.error).toMatch(/fps/i);
  expect(result.elapsed).toBeLessThan(3000);
  expect(result.ticks).toBeGreaterThan(0);
});
