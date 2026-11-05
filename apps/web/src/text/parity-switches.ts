// SPDX-License-Identifier: AGPL-3.0-only
// T05 choices where Cutframe deliberately differs from Xapp (tickets T05 "Decisions from G-03"; findings part 5 §53.7.2,
// §53.7.3; part 2 §34). Each choice is one switch here; the defaults are the chosen answers (documented improvements). The
// stored-reference parity run (G-03) sets the Xapp values.
export const PARITY = {
  /** G-03 decision 1. 'switch': a weight (or italic) change draws the family's face for that weight when the family has one.
   *  'keep': the item's stored face file is registered under the item's weight, as Xapp does, so a "bold" Roboto-Regular
   *  item draws regular glyphs. */
  weightFace: 'switch' as 'switch' | 'keep',
  /** G-03 decision 2. 'bundled': family → bundled Noto Color Emoji → an open CJK font loaded on demand → sans-serif.
   *  'os': family → 'Noto Color Emoji' named but never loaded → sans-serif, so emoji and CJK come from the OS (Xapp). */
  fontChain: 'bundled' as 'bundled' | 'os',
  /** §53.7.3. 'render': a CSS gradient text colour is drawn as a gradient over the text box in preview and export.
   *  'xapp': the gradient string is not a canvas fill, so the previous fill is kept (the background colour when a background
   *  box was drawn, else black). */
  gradientText: 'render' as 'render' | 'xapp',
  /** Part 2 §34. 'catalogue': looks render with Cutframe's own style / effect catalogue (text/looks.ts). 'unavailable': every
   *  look request is refused with TEXT_LOOKS_UNAVAILABLE, as Xapp's web editor does. */
  looks: 'catalogue' as 'catalogue' | 'unavailable',
};
