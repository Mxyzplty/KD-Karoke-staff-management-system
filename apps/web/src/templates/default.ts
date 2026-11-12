// SPDX-License-Identifier: AGPL-3.0-only
// Cutframe's own default project template (T22; findings §22: own name, own palette, OFL fonts, CC0 sound effects). Every
// file it names is in vendor/t22 and in vendor/manifest.json. Nothing here is taken from Xapp's default template.
import { BUILT_IN_FAMILY, TEMPLATE_VERSION, type Template } from './model';

export const DEFAULT_TEMPLATE: Template = {
  id: 'daylight', name: 'Daylight', family: BUILT_IN_FAMILY, author: 'Cutframe',
  palette: [{ name: 'Chalk', hex: '#FAFAF7' }, { name: 'Ink', hex: '#15171C' }, { name: 'Cobalt', hex: '#2F6BFF' }, { name: 'Sun', hex: '#FFD23F' }],
  examples: [
    { name: 'Big Headline', ref: 'preset:text/big-headline' }, { name: 'Serif Quote', ref: 'preset:text/serif-quote' },
    { name: 'Name Bar', ref: 'preset:lower-thirds/name-bar' }, { name: 'Fact Card', ref: 'preset:info-cards/fact-card' },
  ],
  assets: {
    fonts: [{ name: 'Manrope', ref: 'font:Manrope' }, { name: 'Sora', ref: 'font:Sora' }, { name: 'Instrument Serif', ref: 'font:Instrument Serif' }],
    audio: [
      { name: 'Soft chime', ref: 'sound:soft-chime' }, { name: 'Short beep', ref: 'sound:short-beep' }, { name: 'Happy beep', ref: 'sound:happy-beep' },
      { name: 'Mouse click', ref: 'sound:mouse-click' }, { name: 'Clicker', ref: 'sound:clicker' }, { name: 'Camera focus', ref: 'sound:camera-focus' },
      { name: 'Typewriter ding', ref: 'sound:typewriter-ding' }, { name: 'Latch click', ref: 'sound:latch-click' },
    ],
    images: [
      { name: 'Sparkles', ref: 'element:sparkles' }, { name: 'Scribble underline', ref: 'element:underline-scribble' },
      { name: 'Swoop arrow', ref: 'element:arrow-swoop' }, { name: 'Label tag', ref: 'element:label-tag' },
    ],
  },
  defaults: { captionsFont: 'Manrope-Bold', titlesFont: 'Sora-ExtraBold', accentFont: 'InstrumentSerif-Regular' },
  captionTemplateId: 'default',
  presetIds: ['text/big-headline', 'text/serif-quote', 'lower-thirds/name-bar', 'info-cards/fact-card'],
  guidance: 'Clean and bright. Titles in Sora, large and short. Captions in Manrope, easy to read on any footage. Use Instrument Serif for one accent word or a quote, not for body text. Keep to the palette: Chalk or Ink for text, Cobalt for emphasis, Sun for one highlight per scene. Sound effects are short and quiet: one per cut at most.',
  learning: true, preferences: '', version: TEMPLATE_VERSION, savedAt: '2026-11-11T00:00:00.000Z',
};

const f = (path: string, sha256: string) => ({ path: `vendor/t22/${path}`, sha256 });
/** The bundled files Daylight needs, with the SHA-256 each must have (the same values as vendor/manifest.json; a unit test
 *  compares them). A missing file or another hash means the default template is not available (DEFAULT_UNAVAILABLE). */
export const DEFAULT_FILES: readonly { path: string; sha256: string }[] = [
  f('fonts/Manrope-latin.woff2', '8c2def024c1bf31aacf3624ae3c4d701269b4ec3dc765c04830839f0d36b2d9e'),
  f('fonts/Sora-latin.woff2', 'fa26406eeda9a3c6ec3d9ea8813c3045d6dc755e30c716d5c094e8ef43be5a7f'),
  f('fonts/InstrumentSerif-Regular-latin.woff2', '5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31'),
  f('fonts/InstrumentSerif-Italic-latin.woff2', '5a51946dfffa82972bc98745359c46761515641fda557c25116459a9f83da4a7'),
  f('sounds/soft-chime.wav', '243799f22130bc987bb57b80b3ca89643851077ed8743a3cae644a6a3ee804bf'),
  f('sounds/short-beep.ogg', '5ff9635260b97e5ef583ac52ba9510a81285008633db95387f05724310bf33df'),
  f('sounds/happy-beep.ogg', '637fed64a1d1ac8fb9ea30fc4fc3d72e20f427da4b50a2ac5a5522be3aebb404'),
  f('sounds/mouse-click.wav', '37f45ec5b02166f951bd73a28a4a27486d6cc727a09b8a3c1aac82d6ce0583d9'),
  f('sounds/clicker.ogg', '109abfa5f24bd0b37c96398baa79956d2f3ed64fa110dc5845151c7ade49fb47'),
  f('sounds/camera-focus.oga', '2f63442c58feda821e6e5d1c6f06fa36fdd2bb42be5f457a6b4d2c455e053c0b'),
  f('sounds/typewriter-ding.wav', '7e86d269c13cff5d8651718b39da728e612f22e58187780d6b098f9329d713eb'),
  f('sounds/latch-click.wav', '0f80a63afb93490fce6cf7eac0a672123f735fbe227c68a94659145dedbd354a'),
  f('elements/sparkles.svg', 'd9ce7c9da965e8ac9fdfeaa2495d39bde5ac804604c132b3067b4e16ee66f77b'),
  f('elements/underline-scribble.svg', '290fa568cf3622b8553894fea6c503d970ba8aaea76b336cb88a04edc9535fba'),
  f('elements/arrow-swoop.svg', '86e261c9fb05aa3b1c6947f4efad152b8c4455782e4a63dd6e2cb3dad4f32a55'),
  f('elements/label-tag.svg', '00b209fbc1eba9895a9fd9300aa127d9925162b0e43034586c1aec4462e377dd'),
];
