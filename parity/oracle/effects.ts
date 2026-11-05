// SPDX-License-Identifier: AGPL-3.0-only
// The oracle's effect registry (findings part 4): WebGL-chain effects and the
// CSS-chain filters, keyed by effect id. The renderer runs every enabled GPU
// effect in stack order first, then the CSS chain (§48.3).
import type { Effect } from './image';
import * as colour from './colour';
import * as stylize from './stylize';
import * as distort from './distort';

function merge(...records: Record<string, Effect>[]): Record<string, Effect> {
  const out: Record<string, Effect> = {};
  for (const record of records) for (const [id, effect] of Object.entries(record)) {
    if (id in out) throw Error(`Duplicate oracle effect id: ${id}`);
    out[id] = effect;
  }
  return out;
}
export const effects = merge(colour.effects, stylize.effects, distort.effects);
export const cssFilters = merge(colour.cssFilters, distort.cssFilters);
