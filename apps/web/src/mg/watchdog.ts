// SPDX-License-Identifier: AGPL-3.0-only
// Host per-frame watchdog (T08 notes, watchdog): one budget per phase of a frame, charged to whichever phase is open.
// `compute` is the graphic's own work (fonts, compile, dry run, render) and keeps its computeMs limit. The phases around
// it run no graphic code and have their own budgets, so a slow one no longer eats the graphic's (item 4): `boot` is the
// sandbox starting up (srcdoc parse and eval of the bundle, until mg:ready), `media` is time with a media load open
// (Img, OffthreadVideo) as reported by mg:hold, and `output` is the frame being measured and serialised, from mg:out.
// The execution clock pauses while the sandbox reports a hold and that time is charged to the media budget, so repeated
// holds still end the frame. Sandbox execution during a hold stays under its own step limit, and rasterise ticks it too.
import { MotionGraphicError } from './errors';
// boot is our own bundle and output is the sandbox serialising the frame, so both are generous: a cold start or a
// 1080x1920 frame with video panels on a loaded machine must not fail a frame. The sandbox's own output cap is 8 s, so
// it reports a stuck serialisation first and this one only catches a sandbox that stopped answering.
export const COMPUTE_MS = 2000, MEDIA_BUDGET_MS = 4000, BOOT_MS = 4000, OUTPUT_MS = 10_000;
type Phase = 'boot' | 'compute' | 'media' | 'output';
const MESSAGE: Record<Phase, (seconds: number) => string> = {
  boot: s => `Motion graphic sandbox did not start within the ${s} second boot budget.`,
  compute: s => `Motion graphic exceeded the ${s} second per-frame watchdog.`,
  media: s => `Motion graphic media loads exceeded the ${s} second per-frame media budget.`,
  output: s => `Motion graphic frame did not serialise within the ${s} second budget.`,
};
export function frameWatchdog(fire: (error: MotionGraphicError) => void, computeMs = COMPUTE_MS, mediaMs = MEDIA_BUDGET_MS, bootMs = BOOT_MS, outputMs = OUTPUT_MS) {
  const budget: Record<Phase, number> = { boot: bootMs, compute: computeMs, media: mediaMs, output: outputMs };
  const left = { ...budget };
  // The clock starts on the graphic's own phase, so a caller that never reports the phases around it gets exactly the
  // compute-and-media behaviour this had before.
  let timer: ReturnType<typeof setTimeout> | undefined, open: Phase = 'compute', base: Phase = 'compute', since = 0, blown = false;
  const blow = (phase: Phase) => { blown = true; fire(new MotionGraphicError('MG_WATCHDOG', MESSAGE[phase](budget[phase] / 1000))); };
  const arm = () => {
    clearTimeout(timer); since = performance.now();
    timer = setTimeout(() => blow(open), Math.max(0, left[open]));
  };
  // The sandbox shares this thread, so while it blocks, our timer cannot fire: a phase can run out of budget in there
  // and only be seen when the sandbox speaks again. The open phase is charged then (check), because a frame must not be
  // accepted after an overrun this thread was too blocked to report - a single native call of ours with no checkpoint
  // after it (toDataURL on a large frame) is the one shape the sandbox's own output cap can also miss (FU2-B1).
  // A *leaving* phase is not charged that way, and the measured reason is item 4: the pre-output block of a legitimate
  // 1080x1920 frame with three video panels at 3x throttle is 3.6-5.5 s in one stretch (measured ledger
  // compute+5486 / compute+3640, mg:hold only reaching us at the end), which is the same window, length and shape as a
  // hostile burn. The host cannot tell the two apart; the sandbox can, and after this round it checks both caps at every
  // checkpoint of its own including post (mg/sandbox-entry.tsx), so a frame over its caps can no longer be reported good.
  const overdue = () => !blown && left[open] - (performance.now() - since) <= 0;
  const enter = (next: Phase) => { if (next === open) return; left[open] -= performance.now() - since; open = next; arm(); };
  arm();
  return {
    hold(value: boolean) { enter(value ? 'media' : base); },
    /** The phase the frame is in when no media load is open; a hold is released back into it. */
    phase(next: Exclude<Phase, 'media'>) { base = next; if (open !== 'media') enter(next); },
    /** The sandbox's answer arrived: fire if the open phase outlasted its budget while this thread was blocked. */
    check() { if (overdue()) blow(open); },
    stop() { clearTimeout(timer); },
  };
}
