// SPDX-License-Identifier: AGPL-3.0-only
// T05 Preset gallery (findings part 3 §46.7, W3-ED-13): Cutframe's own 14 styles + None. A tile is an action, not a stored
// choice: it writes text Color, Fill, Font Stroke (colour, size 12 when set) and Font Shadow (colour, X, Y, Blur) and
// nothing else, as one "Edit items"; the Preset field keeps showing None. Every tile writes all five fields, so a tile
// looks the same whatever was applied before it; None writes the inspector defaults (white, no fill, stroke, shadow).
import type { RecordData } from '../store/model';

export type TextPreset = { name: string; color: string; fill: string; stroke?: string; shadow?: { color: string; x: number; y: number; blur: number } };
export const STROKE_SIZE = 12;
/** The 14 styles in gallery order (tile 0 is None). Values are Cutframe's own (Xapp's tile values are a reference only). */
export const TEXT_PRESETS: TextPreset[] = [
  { name: 'Dark box', color: '#ffffff', fill: '#111111' },
  { name: 'Light box', color: '#111111', fill: '#ffffff' },
  { name: 'Outline', color: '#ffffff', fill: 'transparent', stroke: '#111111' },
  { name: 'Dark outline', color: '#111111', fill: 'transparent', stroke: '#ffffff' },
  { name: 'Coral pill', color: '#ffffff', fill: '#f43f5e' },
  { name: 'Lemon pill', color: '#1f2937', fill: '#fde047' },
  { name: 'Teal pill', color: '#ffffff', fill: '#0d9488' },
  { name: 'Soft shadow', color: '#ffffff', fill: 'transparent', shadow: { color: 'rgba(0, 0, 0, 0.6)', x: 0, y: 6, blur: 18 } },
  { name: 'Cyan glow', color: '#ffffff', fill: 'transparent', shadow: { color: '#22d3ee', x: 0, y: 0, blur: 60 } },
  { name: 'Pink neon', color: '#ffffff', fill: 'transparent', stroke: '#ec4899', shadow: { color: '#ec4899', x: 0, y: 0, blur: 80 } },
  { name: 'Comic', color: '#fde047', fill: 'transparent', stroke: '#111111', shadow: { color: '#111111', x: -10, y: 10, blur: 0 } },
  { name: 'Retro drop', color: '#fbbf24', fill: 'transparent', shadow: { color: '#b91c1c', x: 8, y: 8, blur: 0 } },
  { name: 'Ice outline', color: '#e0f2fe', fill: 'transparent', stroke: '#1d4ed8', shadow: { color: '#1d4ed8', x: -8, y: 8, blur: 0 } },
  { name: 'Mint on black', color: '#86efac', fill: '#0a0a0a' },
];
export const NO_PRESET: TextPreset = { name: 'None', color: '#ffffff', fill: 'transparent' };
/** The editProperties input of one tile: exactly color, backgroundColor, borderColor, borderWidth and boxShadow. */
export function presetProperties(p: TextPreset): RecordData {
  return {
    color: p.color, backgroundColor: p.fill, borderColor: p.stroke ?? 'transparent', borderWidth: p.stroke ? STROKE_SIZE : 0,
    boxShadow: p.shadow ?? { color: 'transparent', x: 0, y: 0, blur: 0 },
  };
}
