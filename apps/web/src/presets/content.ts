// SPDX-License-Identifier: AGPL-3.0-only
// Cutframe's own style presets (T22; the data shape is findings part 2 §31's, the content is ours). Direct presets are
// authored here in px on 1080 × 1920 and stored normalised (0…1 of the width for left / width / fontSize, of the height for
// top / height). Fonts are the bundled families, so every preset works offline. Motion-graphic presets: ./mg-style.ts.
import type { RecordData } from '../store/model';
import type { DirectPreset, PresetItem, PresetKeyframe, StylePreset } from './model';
import { GRAPHIC_STYLE_PRESETS } from './mg-style';

const W = 1080, H = 1920;
type Px = { x: number; y: number; w: number; h: number };
type Timing = { start?: number; duration?: number };
type Motion = Record<string, PresetKeyframe[]>;
const box = (b: Px) => ({ left: b.x / W, top: b.y / H, width: b.w / W, height: b.h / H });
const text = (value: string, b: Px, fontSize: number, style: RecordData = {}, motion?: Motion, t: Timing = {}): PresetItem =>
  ({ type: 'text', relativeStart: t.start ?? 0, duration: t.duration ?? 4000, details: { text: value, ...box(b), fontSize: fontSize / W, fontFamily: 'Manrope', fontWeight: 700, color: '#ffffff', textAlign: 'center', wordWrap: 'break-word', ...style }, ...(motion ? { properties: motion } : {}) });
const shape = (shapeType: string, b: Px, style: RecordData = {}, motion?: Motion, t: Timing = {}): PresetItem =>
  ({ type: 'shape', relativeStart: t.start ?? 0, duration: t.duration ?? 4000, details: { shapeType, ...box(b), ...style }, ...(motion ? { properties: motion } : {}) });
/** Fade in over `ms` from `at` (item time). */
const fadeIn = (ms = 400, at = 0): PresetKeyframe[] => [{ time: at, value: 0, easing: 'linear' }, { time: at + ms, value: 1, easing: 'linear' }];
/** Move along x or y from an offset (px on the authoring canvas) to the resting place. */
const slideX = (b: Px, from: number, ms = 500): PresetKeyframe[] => [{ time: 0, value: (b.x + from) / W, easing: 'easeOutCubic' }, { time: ms, value: b.x / W, easing: 'linear' }];
const slideY = (b: Px, from: number, ms = 500): PresetKeyframe[] => [{ time: 0, value: (b.y + from) / H, easing: 'easeOutCubic' }, { time: ms, value: b.y / H, easing: 'linear' }];

const headline: Px = { x: 90, y: 520, w: 900, h: 300 };
const quote: Px = { x: 110, y: 640, w: 860, h: 420 }, quoteBy: Px = { x: 110, y: 1090, w: 860, h: 60 };
const kicker: Px = { x: 120, y: 700, w: 840, h: 50 }, kickerBar: Px = { x: 120, y: 770, w: 120, h: 8 }, kickerTitle: Px = { x: 120, y: 800, w: 840, h: 260 };
const stack = [0, 1, 2].map(n => ({ x: 90, y: 620 + n * 190, w: 900, h: 180 }));
const nameBar: Px = { x: 60, y: 1500, w: 640, h: 150 }, nameBarName: Px = { x: 90, y: 1515, w: 580, h: 70 }, nameBarRole: Px = { x: 90, y: 1590, w: 580, h: 45 };
const pill: Px = { x: 240, y: 1560, w: 600, h: 110 }, pillName: Px = { x: 270, y: 1585, w: 540, h: 60 };
const line: Px = { x: 80, y: 1480, w: 10, h: 170 }, lineName: Px = { x: 120, y: 1485, w: 800, h: 85 }, lineRole: Px = { x: 120, y: 1580, w: 800, h: 55 };
const card: Px = { x: 110, y: 660, w: 860, h: 600 }, cardHead: Px = { x: 170, y: 720, w: 740, h: 90 }, cardRule: Px = { x: 170, y: 830, w: 90, h: 6 }, cardBody: Px = { x: 170, y: 870, w: 740, h: 330 };
const stat: Px = { x: 190, y: 700, w: 700, h: 520 }, statNumber: Px = { x: 190, y: 760, w: 700, h: 260 }, statLabel: Px = { x: 250, y: 1050, w: 580, h: 110 };
const badge: Px = { x: 760, y: 140, w: 240, h: 240 }, badgeWord: Px = { x: 780, y: 225, w: 200, h: 70 };

const DIRECT: DirectPreset[] = [
  { id: 'text/big-headline', name: 'Big Headline',
    description: 'One heavy headline in Sora, white and centred in the upper half of the frame. It fades in while it rises a short way into place. Use it to open a video or to name a new section in a few words.',
    items: [text('Your headline here', headline, 120, { fontFamily: 'Sora', fontWeight: 800 }, { opacity: fadeIn(450), positionY: slideY(headline, 60) })] },
  { id: 'text/serif-quote', name: 'Serif Quote',
    description: 'A quotation set large in Instrument Serif with the speaker credited underneath in small spaced capitals. The quote fades in first and the credit follows half a second later. Good for testimonials and pulled lines.',
    items: [
      text('“Say the one line people should remember.”', quote, 84, { fontFamily: 'Instrument Serif', fontWeight: 400 }, { opacity: fadeIn(600) }, { duration: 5000 }),
      text('NAME SURNAME', quoteBy, 34, { fontWeight: 600, letterSpacing: '0.18em', color: '#d7d7d7' }, { opacity: fadeIn(400) }, { start: 500, duration: 4500 }),
    ] },
  { id: 'text/kicker-and-title', name: 'Kicker and Title',
    description: 'A small spaced kicker line, a short yellow rule and a bold title, all aligned to the left. The three parts arrive one after another from the top down. Use it for chapter openers and topic changes.',
    items: [
      text('CHAPTER ONE', kicker, 34, { fontWeight: 700, textAlign: 'left', letterSpacing: '0.24em', color: '#ffd23f' }, { opacity: fadeIn(300) }),
      shape('rectangle', kickerBar, { fillColor: '#ffd23f' }, { opacity: fadeIn(300) }, { start: 150, duration: 3850 }),
      text('The title goes on two lines', kickerTitle, 92, { fontFamily: 'Sora', fontWeight: 800, textAlign: 'left' }, { opacity: fadeIn(400), positionY: slideY(kickerTitle, 40) }, { start: 300, duration: 3700 }),
    ] },
  { id: 'text/stacked-words', name: 'Stacked Words',
    description: 'Three short words stacked down the middle of the frame, each on its own line. They appear one at a time, a third of a second apart, and the last word is yellow. Use it for a three-beat message.',
    items: ['Plan.', 'Shoot.', 'Share.'].map((word, n) =>
      text(word, stack[n], 140, { fontFamily: 'Sora', fontWeight: 800, ...(n === 2 ? { color: '#ffd23f' } : {}) }, { opacity: fadeIn(250), positionY: slideY(stack[n], 50, 350) }, { start: n * 330, duration: 4000 - n * 330 })) },
  { id: 'lower-thirds/name-bar', name: 'Name Bar',
    description: 'A solid blue bar in the lower left with a name in bold white and a role underneath. The bar slides in from the left edge and the two lines fade in on top of it. The standard way to introduce a speaker.',
    items: [
      shape('rectangle', nameBar, { fillColor: '#2f6bff', roundness: 12 }, { positionX: slideX(nameBar, -700) }),
      text('Name Surname', nameBarName, 52, { textAlign: 'left', fontWeight: 800 }, { opacity: fadeIn(300) }, { start: 300, duration: 3700 }),
      text('Role or company', nameBarRole, 32, { textAlign: 'left', fontWeight: 500, color: '#dce6ff' }, { opacity: fadeIn(300) }, { start: 450, duration: 3550 }),
    ] },
  { id: 'lower-thirds/soft-pill', name: 'Soft Pill',
    description: 'A white pill with fully rounded ends, centred near the bottom, holding one line of dark text. The pill and its text fade in together and rise a little. Use it for a name, a place or a short label over footage.',
    items: [
      shape('rectangle', pill, { fillColor: '#ffffff', roundness: 100 }, { opacity: fadeIn(350), positionY: slideY(pill, 40, 450) }),
      text('Name Surname', pillName, 44, { color: '#111111', fontWeight: 700 }, { opacity: fadeIn(350), positionY: slideY(pillName, 40, 450) }),
    ] },
  { id: 'lower-thirds/accent-line', name: 'Accent Line',
    description: 'A thin yellow vertical line with a name and a role set to its right, with no background. The line appears first and the two text lines slide out from behind it. A quiet lower third for interviews and documentaries.',
    items: [
      shape('rectangle', line, { fillColor: '#ffd23f' }, { opacity: fadeIn(250) }),
      text('Name Surname', lineName, 60, { textAlign: 'left', fontFamily: 'Sora', fontWeight: 700 }, { opacity: fadeIn(300), positionX: slideX(lineName, -40, 400) }, { start: 200, duration: 3800 }),
      text('Role or company', lineRole, 36, { textAlign: 'left', fontWeight: 500, color: '#d7d7d7' }, { opacity: fadeIn(300), positionX: slideX(lineRole, -40, 400) }, { start: 350, duration: 3650 }),
    ] },
  { id: 'info-cards/fact-card', name: 'Fact Card',
    description: 'A dark rounded card in the middle of the frame with a heading, a short blue rule and a paragraph of body text. The card fades in and the text follows. Use it to explain a term, list a fact or give context.',
    items: [
      shape('rectangle', card, { fillColor: '#15171c', fillOpacity: 0.92, roundness: 10 }, { opacity: fadeIn(350) }, { duration: 6000 }),
      text('Did you know?', cardHead, 64, { textAlign: 'left', fontFamily: 'Sora', fontWeight: 700 }, { opacity: fadeIn(300) }, { start: 250, duration: 5750 }),
      shape('rectangle', cardRule, { fillColor: '#2f6bff' }, { opacity: fadeIn(300) }, { start: 350, duration: 5650 }),
      text('Write two or three short sentences here. Keep each line easy to read at a glance.', cardBody, 42, { textAlign: 'left', fontWeight: 500, color: '#e6e6e6' }, { opacity: fadeIn(400) }, { start: 450, duration: 5550 }),
    ] },
  { id: 'info-cards/big-number', name: 'Big Number',
    description: 'A white rounded card with one very large blue figure and a short dark label below it. The card rises into place and the figure fades in after it. Use it for a statistic, a price or a count.',
    items: [
      shape('rectangle', stat, { fillColor: '#ffffff', roundness: 14 }, { opacity: fadeIn(300), positionY: slideY(stat, 80) }, { duration: 5000 }),
      text('87%', statNumber, 220, { fontFamily: 'Sora', fontWeight: 800, color: '#2f6bff' }, { opacity: fadeIn(350) }, { start: 350, duration: 4650 }),
      text('of viewers watch without sound', statLabel, 40, { color: '#111111', fontWeight: 600 }, { opacity: fadeIn(350) }, { start: 550, duration: 4450 }),
    ] },
  { id: 'misc/corner-badge', name: 'Corner Badge',
    description: 'A yellow star badge in the top right corner with one short dark word on it. The badge fades in and stays for the length of the item. Use it to mark something as new, live or on sale.',
    items: [
      shape('star', badge, { fillColor: '#ffd23f', roundness: 20 }, { opacity: fadeIn(300) }),
      text('NEW', badgeWord, 48, { fontFamily: 'Sora', fontWeight: 800, color: '#111111' }, { opacity: fadeIn(300) }, { start: 150, duration: 3850 }),
    ] },
];

export const STYLE_PRESETS: StylePreset[] = [...DIRECT, ...GRAPHIC_STYLE_PRESETS];
