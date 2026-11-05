// SPDX-License-Identifier: AGPL-3.0-only
// T15's formula-oracle frame tolerance, in one place: a preview pixel matches when every channel is within this many 8-bit levels
// of the expected value (the §53 check rows in tests/ui/t15-ledger.spec.ts). The G-02 F1 / F2 preview frame check (tickets l.69,
// G-02 item (3): "within the frame tolerance T15 / T16 use for the formula oracle") uses the same constant (parity/g02-frames.ts).
export const FRAME_LEVEL_TOLERANCE = 1;
