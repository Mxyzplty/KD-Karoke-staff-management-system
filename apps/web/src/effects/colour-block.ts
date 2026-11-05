// SPDX-License-Identifier: AGPL-3.0-only
// Base Colour block maths (findings part 2 §39, part 4 §49.1). The Color card is a front end over the FIRST
// `color-wheels`, `curves` and `lut` instances of an item's stack; it owns no renderer. The card UI and the stack
// writes (create on first edit, bypass, reset) are T10.
import type { Wheel } from './schema';

export const COLOUR_BLOCK_EFFECTS = ['color-wheels', 'curves', 'lut'] as const;
export type ColourBlockEffect = typeof COLOUR_BLOCK_EFFECTS[number];

/** Basic sliders → color-wheels keys (Vibrance edits `colorBoost`). */
export const BASIC_SLIDERS: { label: string; key: string }[] = [
  { label: 'Exposure', key: 'exposure' }, { label: 'Contrast', key: 'contrast' }, { label: 'Saturation', key: 'saturation' },
  { label: 'Temperature', key: 'temperature' }, { label: 'Tint', key: 'tint' }, { label: 'Vibrance', key: 'colorBoost' },
];

/** Advanced groups → color-wheels keys (`hue` is labelled "Hue Shift"). */
export const ADVANCED_GROUPS: Record<'wheels' | 'primaries' | 'tone', string[]> = {
  wheels: ['shadowsWheel', 'midtonesWheel', 'highlightsWheel', 'offsetWheel'],
  primaries: ['lift', 'gamma', 'gain', 'offset'],
  tone: ['pivot', 'blackPoint', 'whitePoint', 'midDetail', 'shadows', 'highlights', 'hue', 'lumMix'],
};

/** Stack index of the first instance of each block effect (array order = stack order), -1 when absent. */
export function blockInstances(stack: { effectId: string }[]): Record<ColourBlockEffect, number> {
  const at = (id: string) => stack.findIndex(e => e.effectId === id);
  return { 'color-wheels': at('color-wheels'), curves: at('curves'), lut: at('lut') };
}

/** Double-click value. */
export const NEUTRAL_WHEEL: Wheel = { angle: 0, distance: 0 };

/** Ring radius of a wheel widget `size` px across. */
export const ringRadius = (size: number) => size / 2 - 2;

/**
 * Pointer → wheel value. `dx` right and `dyDown` down are screen px from the widget centre. Angle = pointer direction
 * counter-clockwise from "right", whole degrees, normalised to 0…359; distance = min(r / (0.7 · ring), 1) to 0.01.
 */
export function wheelFromPointer(dx: number, dyDown: number, size: number): Wheel {
  const angle = Math.round(Math.atan2(-dyDown, dx) * 180 / Math.PI);
  const distance = Math.round(Math.min(Math.hypot(dx, dyDown) / (0.7 * ringRadius(size)), 1) * 100) / 100;
  return { angle: ((angle % 360) + 360) % 360, distance };
}

/** Wheel value → puck offset from the centre in screen px (inverse of `wheelFromPointer`, before rounding). */
export function puckOffset(w: Wheel, size: number): { dx: number; dyDown: number } {
  const r = Math.min(Math.max(w.distance, 0), 1) * 0.7 * ringRadius(size), a = w.angle * Math.PI / 180;
  return { dx: r * Math.cos(a), dyDown: -r * Math.sin(a) };
}

/** The ring shows hue h at screen angle h clockwise, so the puck sits over hue (360 − angle): the tint hue Color Wheels applies. */
export const puckHue = (w: Wheel) => (360 - (((w.angle % 360) + 360) % 360)) % 360;
