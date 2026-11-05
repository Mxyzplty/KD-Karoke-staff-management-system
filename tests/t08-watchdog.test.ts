// SPDX-License-Identifier: AGPL-3.0-only
// T08 per-frame watchdog: frameWatchdog(fire, computeMs = 2000, mediaMs = 4000, bootMs = 4000, outputMs = 10000)
// -> { hold(waiting), phase(next), check(), stop() }.
// Execution clock = computeMs; time spent in holds (media loads open) is charged to a separate mediaMs budget and pauses
// the execution clock, so repeated holds cannot keep a frame alive. phase() reports the phases around the graphic's own
// work — 'boot' (the sandbox starting) and 'output' (the frame being measured and serialised) — which have their own
// budgets, so neither spends the graphic's (item 4). The clock starts in 'compute', so a caller that never reports a
// phase gets exactly the compute-and-media behaviour of the first nine cases below.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameWatchdog } from '../apps/web/src/mg/watchdog';

const COMPUTE_MSG = 'Motion graphic exceeded the 2 second per-frame watchdog.';
const MEDIA_MSG = 'Motion graphic media loads exceeded the 4 second per-frame media budget.';
const BOOT_MSG = 'Motion graphic sandbox did not start within the 4 second boot budget.';
const OUTPUT_MSG = 'Motion graphic frame did not serialise within the 10 second budget.';

type Fired = { code: string; message: string; at: number }[];
function setup(computeMs?: number, mediaMs?: number, bootMs?: number, outputMs?: number) {
  const fired: Fired = [];
  const started = performance.now();
  const wd = frameWatchdog(e => fired.push({ code: (e as { code: string }).code, message: e.message, at: performance.now() - started }), computeMs, mediaMs, bootMs, outputMs);
  return { wd, fired };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('frameWatchdog', () => {
  it('with no holds fires MG_WATCHDOG after 2000 ms (not at 1999)', () => {
    const { fired } = setup();
    vi.advanceTimersByTime(1999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
    expect(fired[0].code).toBe('MG_WATCHDOG');
    expect(fired[0].message).toBe(COMPUTE_MSG);
    expect(fired[0].at).toBe(2000);
    vi.advanceTimersByTime(10_000);
    expect(fired).toHaveLength(1);
  });

  it('1500 ms compute, hold for 3000 ms, release: fires 500 ms later with the execution message, never the media one', () => {
    const { wd, fired } = setup();
    vi.advanceTimersByTime(1500);
    wd.hold(true);
    vi.advanceTimersByTime(3000);
    expect(fired).toHaveLength(0);
    wd.hold(false);
    vi.advanceTimersByTime(499);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
    expect(fired[0].code).toBe('MG_WATCHDOG');
    expect(fired[0].message).toBe(COMPUTE_MSG);
    expect(fired[0].at).toBe(5000);
    expect(fired.some(f => f.message === MEDIA_MSG)).toBe(false);
  });

  it('a single hold longer than 4000 ms fires the media-budget error', () => {
    const { wd, fired } = setup();
    wd.hold(true);
    vi.advanceTimersByTime(3999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
    expect(fired[0].code).toBe('MG_WATCHDOG');
    expect(fired[0].message).toBe(MEDIA_MSG);
    expect(fired[0].at).toBe(4000);
  });

  it('a hold that starts after some compute is still limited to the 4000 ms media budget', () => {
    const { wd, fired } = setup();
    vi.advanceTimersByTime(1000);
    wd.hold(true);
    vi.advanceTimersByTime(3999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired.map(f => f.message)).toEqual([MEDIA_MSG]);
    expect(fired[0].at).toBe(5000);
  });

  it('repeated holds (1000 ms on, 100 ms off) cannot keep the frame alive: the media error fires once the held time sums to 4000 ms, within 6000 ms of wall time', () => {
    const { wd, fired } = setup();
    for (let i = 0; i < 20 && fired.length === 0; i++) {
      wd.hold(true);
      vi.advanceTimersByTime(1000);
      if (fired.length) break;
      wd.hold(false);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(10_000);
    expect(fired).toHaveLength(1);
    expect(fired[0].code).toBe('MG_WATCHDOG');
    expect(fired[0].message).toBe(MEDIA_MSG);
    expect(fired[0].at).toBeGreaterThanOrEqual(4000);
    expect(fired[0].at).toBeLessThanOrEqual(6000);
    // Not the execution message: the execution clock only ran 100 ms per cycle.
    expect(fired.some(f => f.message === COMPUTE_MSG)).toBe(false);
  });

  it('repeated hold(true) while already waiting does not reset the media clock', () => {
    const { wd, fired } = setup();
    wd.hold(true);
    for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(1000); wd.hold(true); }
    vi.advanceTimersByTime(999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired.map(f => f.message)).toEqual([MEDIA_MSG]);
    expect(fired[0].at).toBe(4000);
  });

  it('hold(false) while not waiting does not reset the execution clock', () => {
    const { wd, fired } = setup();
    vi.advanceTimersByTime(1000);
    wd.hold(false);
    vi.advanceTimersByTime(500);
    wd.hold(false);
    vi.advanceTimersByTime(499);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired.map(f => f.message)).toEqual([COMPUTE_MSG]);
    expect(fired[0].at).toBe(2000);
  });

  it('execution time before and after a hold adds up to the 2000 ms budget (the hold itself is not charged to it)', () => {
    const { wd, fired } = setup();
    vi.advanceTimersByTime(1000);
    wd.hold(true);
    vi.advanceTimersByTime(1500);
    wd.hold(false);
    vi.advanceTimersByTime(999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired.map(f => f.message)).toEqual([COMPUTE_MSG]);
    expect(fired[0].at).toBe(3500);
  });

  it('stop() prevents firing, in both the executing and the held state', () => {
    const a = setup();
    a.wd.stop();
    vi.advanceTimersByTime(20_000);
    expect(a.fired).toHaveLength(0);
    const b = setup();
    b.wd.hold(true);
    vi.advanceTimersByTime(1000);
    b.wd.stop();
    vi.advanceTimersByTime(20_000);
    expect(b.fired).toHaveLength(0);
  });

  it('custom budgets appear in the messages ("0.1 second", "0.2 second")', () => {
    const a = setup(100, 200);
    vi.advanceTimersByTime(100);
    expect(a.fired.map(f => [f.code, f.message])).toEqual([['MG_WATCHDOG', 'Motion graphic exceeded the 0.1 second per-frame watchdog.']]);
    const b = setup(100, 200);
    b.wd.hold(true);
    vi.advanceTimersByTime(199);
    expect(b.fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(b.fired.map(f => [f.code, f.message])).toEqual([['MG_WATCHDOG', 'Motion graphic media loads exceeded the 0.2 second per-frame media budget.']]);
  });

  it('boot has its own budget: a slow sandbox start does not spend the compute one', () => {
    const { wd, fired } = setup();
    wd.phase('boot');
    vi.advanceTimersByTime(1500);
    wd.phase('compute');
    vi.advanceTimersByTime(1999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired.map(f => f.message)).toEqual([COMPUTE_MSG]);
    expect(fired[0].at).toBe(3500);
  });

  it('a sandbox that never reports ready fires the boot message at 4000 ms', () => {
    const { wd, fired } = setup();
    wd.phase('boot');
    vi.advanceTimersByTime(3999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired.map(f => [f.code, f.message])).toEqual([['MG_WATCHDOG', BOOT_MSG]]);
    expect(fired[0].at).toBe(4000);
  });

  it('output has its own budget: serialising does not spend the compute one', () => {
    const { wd, fired } = setup();
    vi.advanceTimersByTime(1900);
    wd.phase('output');
    vi.advanceTimersByTime(9999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired.map(f => [f.code, f.message])).toEqual([['MG_WATCHDOG', OUTPUT_MSG]]);
    expect(fired[0].at).toBe(11_900);
  });

  it('a hold during output is charged to media and released back into output', () => {
    const { wd, fired } = setup();
    wd.phase('output');
    vi.advanceTimersByTime(4000);
    wd.hold(true);
    vi.advanceTimersByTime(3000);
    wd.hold(false);
    vi.advanceTimersByTime(5999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired.map(f => f.message)).toEqual([OUTPUT_MSG]);
    expect(fired[0].at).toBe(13_000);
  });

  it('phase() while a hold is open does not end the hold', () => {
    const { wd, fired } = setup();
    wd.hold(true);
    wd.phase('output');
    vi.advanceTimersByTime(3999);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired.map(f => f.message)).toEqual([MEDIA_MSG]);
    expect(fired[0].at).toBe(4000);
  });

  it('custom boot and output budgets appear in their messages ("0.3 second", "0.4 second")', () => {
    const a = setup(100, 200, 300, 400);
    a.wd.phase('boot');
    vi.advanceTimersByTime(300);
    expect(a.fired.map(f => [f.code, f.message])).toEqual([['MG_WATCHDOG', 'Motion graphic sandbox did not start within the 0.3 second boot budget.']]);
    const b = setup(100, 200, 300, 400);
    b.wd.phase('output');
    vi.advanceTimersByTime(399);
    expect(b.fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(b.fired.map(f => [f.code, f.message])).toEqual([['MG_WATCHDOG', 'Motion graphic frame did not serialise within the 0.4 second budget.']]);
  });

  // The sandbox shares the host's main thread, so while it blocks, the open phase's timer cannot fire. These three cases
  // need real timers and a busy wait to reproduce that: advancing a fake clock runs the timer, which is the whole point.
  it('a leaving phase that ran out of budget while the thread was blocked is not charged at the switch (item 4)', () => {
    vi.useRealTimers();
    const { wd, fired } = setup(30, 200, 300, 400);
    const end = performance.now() + 90; while (performance.now() < end) { /* the sandbox has the thread */ }
    wd.phase('output');
    wd.stop();
    // The pre-output block of a legitimate frame has exactly this shape and more than this much of it: item 4 measures
    // 3.6-5.5 s of React commit and video decodes in one stretch, with mg:hold only reaching the host at the end. The
    // host cannot tell that from a hostile burn, so the leaving phase is the sandbox's to judge, not ours.
    expect(fired).toEqual([]);
  });

  it('check() fires for an open phase that outlasted its budget while the thread was blocked (FU2-B1)', () => {
    vi.useRealTimers();
    const { wd, fired } = setup(30, 200, 300, 40);
    wd.phase('output');
    const end = performance.now() + 120; while (performance.now() < end) { /* the sandbox has the thread */ }
    wd.check();
    wd.stop();
    expect(fired.map(f => [f.code, f.message])).toEqual([['MG_WATCHDOG', 'Motion graphic frame did not serialise within the 0.04 second budget.']]);
  });

  it('check() is silent while the open phase is inside its budget, and fires at most once with the timer', () => {
    const { wd, fired } = setup();
    wd.phase('output');
    vi.advanceTimersByTime(9999);
    wd.check();
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    wd.check();
    wd.phase('compute');
    expect(fired.map(f => f.message)).toEqual([OUTPUT_MSG]);
  });
});
