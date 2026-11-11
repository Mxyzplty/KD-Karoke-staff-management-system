// SPDX-License-Identifier: AGPL-3.0-only
// T12 helper: toContent's image-block conversion for viewMaskFrame/previewSmartMask (mcp.ts), and LONG_TOOLS
// (trackSmartMask, removeBackground) through the real helper (ws tab): no client time-out while the tab stays
// connected, other mutating calls are not held up behind a long one, TAB_NOT_CONNECTED once the tool time-out
// passes after the tab goes, and the call keeps running when the same tab reconnects first.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startHelper } from '../apps/helper/src/helper';
import type { Helper } from '../apps/helper/src/helper';
import { toContent } from '../apps/helper/src/mcp';
import { newToken } from '../apps/helper/src/store';
import { DISCONNECTED_ERROR, PROTOCOL } from '../apps/web/src/agent/protocol';

describe('toContent (mcp.ts): image blocks for viewMaskFrame/previewSmartMask, one JSON text block otherwise', () => {
  it('no content: the whole result as one JSON text block, no isError', () => {
    expect(toContent({ success: true, data: { a: 1 } })).toEqual({ content: [{ type: 'text', text: JSON.stringify({ success: true, data: { a: 1 } }) }] });
  });
  it('no content and success:false: isError:true', () => {
    const result = { success: false, code: 'X', error: 'bad' };
    expect(toContent(result as never)).toEqual({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: true });
  });
  it('content blocks: a text block passes through, an image block becomes {type, data, mimeType}', () => {
    const result = { success: true, content: [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/jpeg', base64: 'Zm9v' }] };
    expect(toContent(result as never)).toEqual({ content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'Zm9v', mimeType: 'image/jpeg' }] });
  });
});

const ORIGIN = 'http://127.0.0.1:4173';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The real helper with one paired, active ws tab we fully control: we choose when, and whether, to answer a call. */
async function rig(toolTimeoutMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 't12-helper-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const helper: Helper = await startHelper({ port: 0, log: () => {}, configDir: dir, toolTimeoutMs });
  cleanups.push(() => helper.close());
  const token = newToken();
  helper.store.add(token, 'tab-a');

  let ws!: WebSocket, connId = '';
  const received: { callId: string; toolName: string }[] = [];
  async function connect() {
    ws = new WebSocket(`ws://127.0.0.1:${helper.port}/tab`, { origin: ORIGIN });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const hello = new Promise<{ connId: string }>(resolve => {
      // One persistent listener from the start: a re-sent call can follow the hello ack before a second
      // registration would attach, so 'call' handling must already be live when the ack arrives.
      ws.on('message', d => {
        const m = JSON.parse(String(d));
        if (m.type === 'hello') resolve(m);
        else if (m.type === 'call') received.push(m);
      });
    });
    ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-a', token, ...(connId ? { connId } : {}) }));
    const ack = await hello;
    connId = ack.connId;
    return ack;
  }
  cleanups.push(() => ws?.terminate());
  await connect();
  const answer = (callId: string, result: unknown) => ws.send(JSON.stringify({ type: 'result', callId, result }));
  const disconnect = () => new Promise<void>(resolve => { ws.once('close', () => resolve()); ws.close(); });
  return { helper, received, answer, disconnect, reconnect: connect };
}

describe('LONG_TOOLS (trackSmartMask, removeBackground) through the real helper', () => {
  it('a long tool outlasts the tool time-out while the tab stays connected, and does not hold up another mutating call', async () => {
    const r = await rig(1000);
    const longCall = r.helper.call('trackSmartMask', { selectionId: 's1', sourceStartSeconds: 0, sourceEndSeconds: 1 }, 'sess');
    await wait(20);
    expect(r.received).toHaveLength(1);
    const longCallId = r.received[0].callId;

    const moveCall = r.helper.call('moveItem', { itemId: 'v1', by: 1 }, 'sess');
    await wait(20);
    expect(r.received).toHaveLength(2); // moveItem reached the tab although trackSmartMask is still outstanding
    r.answer(r.received[1].callId, { success: true, data: {} });
    await expect(moveCall).resolves.toMatchObject({ success: true });

    await wait(1500); // well past the 1000ms tool time-out
    let settled = false;
    longCall.then(() => { settled = true; });
    await wait(0);
    expect(settled).toBe(false); // still running: nothing timed it out while the tab stayed connected

    r.answer(longCallId, { success: true, data: { itemId: 'vid', maskId: 'm1', maskIndex: 0 } });
    await expect(longCall).resolves.toMatchObject({ success: true, data: { maskId: 'm1' } });
  });

  it('a long tool left running when the tab disconnects settles TAB_NOT_CONNECTED once the tool time-out passes', async () => {
    const r = await rig(100);
    const longCall = r.helper.call('trackSmartMask', { selectionId: 's1', sourceStartSeconds: 0, sourceEndSeconds: 1 }, 'sess');
    await wait(20);
    expect(r.received).toHaveLength(1);
    await r.disconnect();
    await expect(longCall).resolves.toMatchObject({ success: false, code: 'TAB_NOT_CONNECTED', error: DISCONNECTED_ERROR, operationMayHaveRun: true });
  });

  it('a long tool left running keeps running, with no new time-out, when the same tab reconnects before the tool time-out', async () => {
    const r = await rig(1500);
    const longCall = r.helper.call('trackSmartMask', { selectionId: 's1', sourceStartSeconds: 0, sourceEndSeconds: 1 }, 'sess');
    await wait(20);
    expect(r.received).toHaveLength(1);
    const callId = r.received[0].callId;
    await r.disconnect();
    await wait(50); // well under the 1500ms tool time-out
    await r.reconnect();
    await wait(20);
    expect(r.received).toHaveLength(2); // the same call, re-sent to the reconnected tab
    expect(r.received[1].callId).toBe(callId);

    await wait(2000); // past the original tool time-out, measured from either the first send or the disconnect
    let settled = false;
    longCall.then(() => { settled = true; });
    await wait(0);
    expect(settled).toBe(false);

    r.answer(callId, { success: true, data: { itemId: 'vid', maskId: 'm1', maskIndex: 0 } });
    await expect(longCall).resolves.toMatchObject({ success: true, data: { maskId: 'm1' } });
  });
});
