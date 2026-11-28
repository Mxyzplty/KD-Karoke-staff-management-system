// SPDX-License-Identifier: AGPL-3.0-only
// T23 catalogue files under the guides root (T22's request; findings part 2 §42): `catalogue/elements.md` and
// `catalogue/sounds.md`, generated from T22's ELEMENTS and SOUNDS, so they never drift from what addMedia accepts.
// Read-only. Our own text around the data.
import { ELEMENTS } from '../../catalogue/elements';
import { SOUNDS } from '../../catalogue/sounds';

/** Paths relative to the guides root. */
export const CATALOGUE_FILES = { elements: 'catalogue/elements.md', sounds: 'catalogue/sounds.md' } as const;
export const CATALOGUE_DESCRIPTIONS: Record<string, string> = {
  [CATALOGUE_FILES.elements]: 'Built-in graphic elements (stickers, bubbles, labels, frames) and their agent ids.',
  [CATALOGUE_FILES.sounds]: 'Built-in sound effects, their lengths and their agent ids.',
};

const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;
export function elementsMarkdown(): string {
  const rows = ELEMENTS.map(e => {
    const slot = !e.slot ? '—' : e.slot.kind === 'text' ? `text (${e.slot.fontFamily} ${e.slot.fontWeight})` : `media, ${e.slot.openings.length} opening${e.slot.openings.length === 1 ? '' : 's'}`;
    const colours = e.palette.map(p => `${p.name} ${p.base}${p.kind === 'neutral' ? ' (neutral)' : ''}`).join(', ');
    const extra = [e.pieces ? `${e.pieces.length} pieces` : '', e.stretch ? 'stretches' : ''].filter(Boolean).join(', ') || '—';
    return `| \`element:${e.id}\` | ${e.name} | ${e.group} | ${e.width} × ${e.height} | ${colours} | ${slot} | ${extra} |`;
  });
  const openings = ELEMENTS.flatMap(e => e.slot?.kind === 'media' ? e.slot.openings.map((o, n) => `- \`element:${e.id}\` opening ${n + 1}: x ${pct(o.x)}, y ${pct(o.y)}, width ${pct(o.width)}, height ${pct(o.height)} of the element.`) : []);
  return [
    '# Built-in elements', '',
    'Ready-made graphics. Add one with addMedia, with its agent id as `assetId`. An element with a text slot becomes a text item; one with a media slot becomes a layout item whose cells are its openings. Colours lists the recolourable parts with their base colour.', '',
    '| Agent id | Name | Group | Size (px) | Colours | Slot | Notes |', '|---|---|---|---|---|---|---|', ...rows, '',
    '## Media openings', '', ...openings, '',
  ].join('\n');
}
export function soundsMarkdown(): string {
  const rows = SOUNDS.map(s => `| \`sound:${s.slug}\` | ${s.name} | ${(s.durationMs / 1000).toFixed(3)} | ${s.tags.join(', ')} |`);
  return [
    '# Built-in sounds', '',
    'Sound effects (CC0). Add one with addMedia, with its agent id as `assetId`.', '',
    '| Agent id | Name | Length (s) | Tags |', '|---|---|---|---|', ...rows, '',
  ].join('\n');
}
