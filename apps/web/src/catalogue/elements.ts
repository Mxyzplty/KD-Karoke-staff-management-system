// SPDX-License-Identifier: AGPL-3.0-only
// T22 element catalogue (findings part 2 §33): Cutframe's own ready-made graphics, one entry per file of vendor/t22/elements.
// An element has a size, a palette of recolourable colours (the recolor effect reads two), optional pieces, an optional
// stretch flag and an optional slot: a text slot makes it a text item, a media slot a layout item whose cells are the
// openings. Pure data: the file bytes are resolved in catalogue/assets.ts.

/** A box as fractions (0..1) of the element box. */
export type Frac = { x: number; y: number; width: number; height: number };
export type ElementSlot =
  | { kind: 'text'; box: Frac; fontFamily: string; fontWeight: number; color?: string; textAlign?: 'left' | 'center' | 'right' }
  | { kind: 'media'; openings: Frac[] };
export interface CatalogueElement {
  /** The agent id is `element:<id>`. */
  id: string;
  name: string;
  group: 'sticker' | 'bubble' | 'label' | 'frame';
  /** Repo path of the SVG. */
  file: string;
  width: number;
  height: number;
  palette: { name: string; base: string; kind: 'color' | 'neutral' }[];
  /** Boxes of the parts of a multi-part element. */
  pieces?: Frac[];
  stretch?: true;
  slot?: ElementSlot;
}

const f = (x: number, y: number, width: number, height: number, W: number, H: number): Frac => ({ x: x / W, y: y / H, width: width / W, height: height / H });
const file = (id: string) => `vendor/t22/elements/${id}.svg`;
const INK = '#1B1B1F', WHITE = '#FFFFFF', YELLOW = '#FFC83D';
const text = (box: Frac, color?: string): ElementSlot => ({ kind: 'text', box, fontFamily: 'Manrope', fontWeight: 700, ...(color ? { color } : {}) });

export const ELEMENTS: readonly CatalogueElement[] = [
  { id: 'arrow-swoop', name: 'Swoop arrow', group: 'sticker', file: file('arrow-swoop'), width: 640, height: 320, palette: [{ name: 'Line', base: INK, kind: 'neutral' }] },
  { id: 'browser-window', name: 'Browser window', group: 'frame', file: file('browser-window'), width: 1280, height: 800, palette: [{ name: 'Frame', base: '#ECECF1', kind: 'neutral' }],
    slot: { kind: 'media', openings: [f(16, 80, 1248, 704, 1280, 800)] } },
  { id: 'burst-badge', name: 'Burst badge', group: 'sticker', file: file('burst-badge'), width: 512, height: 512,
    palette: [{ name: 'Burst', base: '#FF6B35', kind: 'color' }, { name: 'Centre', base: WHITE, kind: 'neutral' }] },
  { id: 'corner-brackets', name: 'Corner brackets', group: 'sticker', file: file('corner-brackets'), width: 1000, height: 600, palette: [{ name: 'Line', base: WHITE, kind: 'neutral' }],
    pieces: [f(0, 0, 144, 144, 1000, 600), f(856, 0, 144, 144, 1000, 600), f(856, 456, 144, 144, 1000, 600), f(0, 456, 144, 144, 1000, 600)] },
  { id: 'label-tag', name: 'Label tag', group: 'label', file: file('label-tag'), width: 720, height: 240,
    palette: [{ name: 'Fill', base: YELLOW, kind: 'color' }, { name: 'Outline', base: INK, kind: 'neutral' }], slot: text(f(60, 40, 600, 160, 720, 240)) },
  { id: 'phone-frame', name: 'Phone frame', group: 'frame', file: file('phone-frame'), width: 540, height: 1080,
    palette: [{ name: 'Body', base: INK, kind: 'neutral' }, { name: 'Detail', base: '#3A3A44', kind: 'neutral' }], slot: { kind: 'media', openings: [f(30, 90, 480, 900, 540, 1080)] } },
  { id: 'polaroid-frame', name: 'Instant photo frame', group: 'frame', file: file('polaroid-frame'), width: 720, height: 860, palette: [{ name: 'Paper', base: '#FAF7F0', kind: 'neutral' }],
    slot: { kind: 'media', openings: [f(50, 50, 620, 620, 720, 860)] } },
  { id: 'ribbon-banner', name: 'Ribbon banner', group: 'label', file: file('ribbon-banner'), width: 900, height: 260,
    palette: [{ name: 'Ribbon', base: '#E63946', kind: 'color' }, { name: 'Fold', base: '#A4161A', kind: 'color' }], slot: text(f(130, 40, 640, 140, 900, 260), WHITE) },
  { id: 'sparkles', name: 'Sparkles', group: 'sticker', file: file('sparkles'), width: 476, height: 376, palette: [{ name: 'Sparkle', base: YELLOW, kind: 'color' }],
    pieces: [f(0, 20, 220, 220, 476, 376), f(344, 0, 132, 132, 476, 376), f(272, 200, 176, 176, 476, 376)] },
  { id: 'speech-bubble', name: 'Speech bubble', group: 'bubble', file: file('speech-bubble'), width: 800, height: 480,
    palette: [{ name: 'Fill', base: WHITE, kind: 'neutral' }, { name: 'Outline', base: INK, kind: 'neutral' }], slot: text(f(70, 50, 660, 290, 800, 480)) },
  { id: 'split-frame', name: 'Split frame', group: 'frame', file: file('split-frame'), width: 1280, height: 720, palette: [{ name: 'Frame', base: WHITE, kind: 'neutral' }],
    slot: { kind: 'media', openings: [f(24, 24, 604, 672, 1280, 720), f(652, 24, 604, 672, 1280, 720)] } },
  { id: 'sticker-heart', name: 'Heart sticker', group: 'sticker', file: file('sticker-heart'), width: 512, height: 512,
    palette: [{ name: 'Heart', base: '#FF4D6D', kind: 'color' }, { name: 'Outline', base: INK, kind: 'neutral' }] },
  { id: 'sticker-star', name: 'Star sticker', group: 'sticker', file: file('sticker-star'), width: 512, height: 512,
    palette: [{ name: 'Star', base: YELLOW, kind: 'color' }, { name: 'Outline', base: INK, kind: 'neutral' }] },
  { id: 'underline-scribble', name: 'Scribble underline', group: 'sticker', file: file('underline-scribble'), width: 800, height: 120, palette: [{ name: 'Line', base: YELLOW, kind: 'color' }], stretch: true },
];

export const findElement = (id: string): CatalogueElement | undefined => ELEMENTS.find(e => e.id === id);
