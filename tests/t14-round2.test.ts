// SPDX-License-Identifier: AGPL-3.0-only
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { failedTakeover, freshHeartbeat, recoverySuccessor, staleProxy } from './t14-round2-cases';
import { svgSize } from '../apps/web/src/media/probe';
it('F16 late old writer cannot change the published proxy bytes or pointer; recovery removes only unowned objects', async () => {
  const r = await staleProxy(false); expect(r.before).toBe('NEW'); expect(r.final).toBe('NEW'); expect(r.width).toBe(8);
  expect(r.key).not.toBe(r.assetId); expect(r.remaining).toEqual([r.key]); expect(r.winner).toBe('prepared'); expect(r.oldResult).toBe('failed');
});
it('F16 deletion during a paused proxy write leaves no row or bytes after the writer drains', async () => {
  const r = await staleProxy(false, true); expect(r.row).toBeUndefined(); expect(r.remaining).toEqual([]);
});
for (const automatic of [false, true]) it(`F17 failed stale takeover permits ${automatic ? 'automatic' : 'manual'} retry with simultaneous callers`, async () => {
  expect(await failedTakeover(false, automatic)).toEqual({ replacement: 'failed', probes: 1, phase: 'finished', status: 'ready' });
});
for (const successor of [false, true]) it(`F18 recovery rechecks ${successor ? 'successor generation' : 'latest heartbeat'} atomically`, async () => {
  const r = await freshHeartbeat(false, successor); expect(r.found).toEqual([]); expect(r.record?.phase).toBe('running'); expect(r.asset?.last_error_code).toBeNull();
});
it('F18 a successor published after the interruption commit keeps its ready asset and error state', async () => {
  const r = await recoverySuccessor(false); expect(r.record?.attemptId).toBe('successor'); expect(r.asset?.processing_status).toBe('ready'); expect(r.asset?.last_error_code).toBeNull();
});
it('F23 the Node header probe retains absolute physical dimensions and viewBox aspect ratio', () => {
  for (const attrs of ['width="1in" height="1in"', 'width="2.54cm" height="25.4mm"', 'width="72pt" height="6pc"']) expect(svgSize(`<svg ${attrs}/>`)).toEqual({ width: 96, height: 96 });
  expect(svgSize('<svg width="96" viewBox="0 0 2 1"/>')).toEqual({ width: 96, height: 48 });
  expect(svgSize('<svg height="48" viewBox="0 0 2 1"/>')).toEqual({ width: 96, height: 48 });
  expect(svgSize('<svg/>')).toEqual({ width: 300, height: 150 });
});
