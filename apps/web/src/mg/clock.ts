// SPDX-License-Identifier: AGPL-3.0-only
export type GraphicClock = { timelineTimeMs: number; clipStartMs: number; trimStartMs: number; designedLengthMs?: number };
export function graphicTimeMs(c: GraphicClock): number {
  return Math.max(0, Math.min(c.designedLengthMs ?? Infinity, c.timelineTimeMs - c.clipStartMs + c.trimStartMs));
}
export function graphicFrame(c: GraphicClock & { fps: number }): number {
  const frame = Math.round(graphicTimeMs(c) * c.fps / 1000);
  return Math.max(0, Math.min(frame, c.designedLengthMs === undefined ? Infinity : Math.max(0, Math.ceil(c.designedLengthMs * c.fps / 1000) - 1)));
}
