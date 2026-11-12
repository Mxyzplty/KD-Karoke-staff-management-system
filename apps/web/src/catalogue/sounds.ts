// SPDX-License-Identifier: AGPL-3.0-only
// T22 sound catalogue: the CC0 sound effects of vendor/t22/sounds (sources and licences in vendor/manifest.json), used as
// downloaded. The agent id is `sound:<slug>`. durationMs is the decoded length, rounded to the millisecond.

export interface CatalogueSound { slug: string; name: string; file: string; durationMs: number; tags: string[] }

const s = (slug: string, name: string, ext: 'wav' | 'ogg' | 'oga', durationMs: number, tags: string[]): CatalogueSound =>
  ({ slug, name, file: `vendor/t22/sounds/${slug}.${ext}`, durationMs, tags });

export const SOUNDS: readonly CatalogueSound[] = [
  s('bicycle-bell', 'Bicycle bell', 'wav', 552, ['bell', 'ring', 'notification']),
  s('cabin-chime', 'Cabin chime', 'ogg', 2934, ['chime', 'announcement', 'notification']),
  s('camera-focus', 'Camera focus', 'oga', 357, ['camera', 'beep', 'photo']),
  s('clicker', 'Clicker', 'ogg', 2321, ['click', 'button']),
  s('happy-beep', 'Happy beep', 'ogg', 1149, ['beep', 'notification', 'success']),
  s('keyboard-typing', 'Keyboard typing', 'ogg', 12009, ['typing', 'keyboard', 'computer']),
  s('latch-click', 'Latch click', 'wav', 1158, ['click', 'latch', 'metal']),
  s('mouse-click', 'Mouse click', 'wav', 570, ['click', 'mouse', 'computer']),
  s('short-beep', 'Short beep', 'ogg', 192, ['beep', 'tone']),
  s('soft-chime', 'Soft chime', 'wav', 2255, ['chime', 'bell', 'transition']),
  s('typewriter-ding', 'Typewriter ding', 'wav', 1056, ['ding', 'typewriter', 'bell']),
];

export const findSound = (slug: string): CatalogueSound | undefined => SOUNDS.find(x => x.slug === slug);
