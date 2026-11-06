// SPDX-License-Identifier: AGPL-3.0-only
// Independent D34/D35 formula oracle: input on video and graphics, output on every composited pixel.
import type { Image } from './image';

export const inputCode = (code: number): number => {
  const v = code / 255, L = v < .081 ? v / 4.5 : ((v + .099) / 1.099) ** (1 / .45);
  return Math.round(255 * (L <= .0031308 ? 12.92 * L : 1.055 * L ** (1 / 2.4) - .055));
};
export const outputCode = (code: number): number => {
  const v = code / 255, L = v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  return Math.round(255 * (L < .018 ? 4.5 * L : 1.099 * L ** .45 - .099));
};
const inputTable = Uint8Array.from({ length: 256 }, (_, i) => inputCode(i));
const outputTable = Uint8Array.from({ length: 256 }, (_, i) => outputCode(i));
export function transferImage(image: Image, direction: 'input' | 'output'): Image {
  const data = image.data.slice(), table = direction === 'input' ? inputTable : outputTable;
  for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k++) data[i + k] = table[Math.round(Math.min(1, Math.max(0, data[i + k])) * 255)] / 255;
  return { ...image, data };
}
export const videoInput = (image: Image): Image => image.transfer === 'iec61966-2-1' || image.transfer === 'linear' ? image : transferImage(image, 'input');
/** Output-only expectations for shape/text/image preview captures, or decoded export RGB back to the blend domain. */
export function transferBytes(rgba: Uint8Array, direction: 'input' | 'output'): Uint8Array {
  const out = rgba.slice(), table = direction === 'input' ? inputTable : outputTable;
  for (let i = 0; i < out.length; i += 4) for (let k = 0; k < 3; k++) out[i + k] = table[out[i + k]];
  return out;
}
