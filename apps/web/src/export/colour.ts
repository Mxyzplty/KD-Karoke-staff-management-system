// SPDX-License-Identifier: AGPL-3.0-only
// D34/D35: export video and graphics enter the sRGB blend domain; the completed canvas leaves it before I420.
import { halves } from '../render/merge-pool';

const srgbEncode = (x: number) => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
const srgbDecode = (x: number) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const bt709Encode = (x: number) => x < 0.018 ? 4.5 * x : 1.099 * x ** 0.45 - 0.099;
const bt709Decode = (x: number) => x < 0.081 ? x / 4.5 : ((x + 0.099) / 1.099) ** (1 / 0.45);
export const BT709_TO_SRGB = Uint8Array.from({ length: 256 }, (_, code) => Math.round(255 * srgbEncode(bt709Decode(code / 255))));
export const SRGB_TO_BT709 = Uint8Array.from({ length: 256 }, (_, code) => Math.round(255 * bt709Encode(srgbDecode(code / 255))));

/** Input-stage fix only for export video. PQ/HLG have already become SDR BT.709 in frameToRgba (D26 default).
 *  An untagged decoder defaults to BT.709; explicit sRGB and linear frames keep their values. Stacked alpha's
 *  right half is data, not colour: use the same packing offsets as its merge, leaving all alpha bytes intact. */
export function applyExportInputTransfer(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, transfer: string, stackedAlpha = false): void {
  if (transfer === 'iec61966-2-1' || transfer === 'linear') return;
  const x0 = stackedAlpha ? halves(width).colourX : 0, w = stackedAlpha ? width >> 1 : width;
  for (let y = 0; y < height; y++) for (let x = x0; x < x0 + w; x++) {
    const p = (y * width + x) * 4;
    rgba[p] = BT709_TO_SRGB[rgba[p]]; rgba[p + 1] = BT709_TO_SRGB[rgba[p + 1]]; rgba[p + 2] = BT709_TO_SRGB[rgba[p + 2]];
  }
}
