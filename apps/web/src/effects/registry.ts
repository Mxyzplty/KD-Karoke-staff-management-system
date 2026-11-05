// SPDX-License-Identifier: AGPL-3.0-only
// Effect registry data (T10a): 39 discoverable effects in inventory order, 2 hidden, 1 retired, 2 transport stages.
// Parameters, defaults, bounds, steps, units and animation flags are copied from `Xapp effect parameter inventory (C).md`;
// names, descriptions and tags are our own wording.
import type {
  BooleanParam, Category, ColorParam, ColorWheelParam, DataParam, EffectDefinition, ItemType, NumberParam, ParamDef,
  RenderType, SelectOption, SelectParam, TransportStage, UniformSlot, Visibility,
} from './schema';
import { FIRST_PARAM_SLOT } from './schema';

const label = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

function num(key: string, def: number, min: number, max: number, step: number, unit?: string, animatable = true): NumberParam {
  return { type: 'number', key, label: label(key), default: def, min, max, step, ...(unit ? { unit } : {}), animatable };
}
const bool = (key: string, def: boolean): BooleanParam => ({ type: 'boolean', key, label: label(key), default: def, animatable: false });
const select = (key: string, def: string, options: SelectOption[]): SelectParam =>
  ({ type: 'select', key, label: label(key), default: def, options, animatable: false });
const color = (key: string, def: string): ColorParam => ({ type: 'color', key, label: label(key), default: def, animatable: false });
const wheel = (key: string): ColorWheelParam =>
  ({ type: 'colorWheel', key, label: label(key), default: { angle: 0, distance: 0 }, animatable: false, group: 'Wheels' });
const data = (key: string): DataParam => ({ type: 'data', key, label: label(key), default: '', animatable: false });
const opts = (...pairs: [string, string][]): SelectOption[] => pairs.map(([value, l]) => ({ value, label: l }));
const grouped = (group: string, params: ParamDef[]) => params.map(p => ({ ...p, group }));

const VISUAL: ItemType[] = ['video', 'image'];
const ALL: ItemType[] = ['video', 'image', 'text', 'shape', 'motionGraphic', 'layout', 'caption'];
const CSS_EFFECTS = new Set(['invert', 'gaussian-blur', 'drop-shadow']);

function uniformsOf(params: ParamDef[]): UniformSlot[] {
  const slots: UniformSlot[] = [];
  let slot = FIRST_PARAM_SLOT;
  for (const p of params) {
    const size = p.type === 'color' ? 4 : p.type === 'colorWheel' ? 2 : p.type === 'data' ? 0 : 1;
    if (!size) continue;
    slots.push({ key: p.key, slot, size });
    slot += size;
  }
  return slots;
}

function def(id: string, name: string, category: Category, description: string, tags: string[], params: ParamDef[],
  extra: { itemTypes?: ItemType[]; visibility?: Visibility; replacement?: string } = {}): EffectDefinition {
  const renderType: RenderType = CSS_EFFECTS.has(id) ? 'css' : 'webgl';
  return {
    id, name, category, description, renderType, visibility: extra.visibility ?? 'discoverable', tags,
    itemTypes: extra.itemTypes ?? VISUAL, params, uniforms: renderType === 'css' ? [] : uniformsOf(params),
    ...(extra.replacement ? { replacement: extra.replacement } : {}),
  };
}

const curveChannel = (ch: string) => grouped(label(ch), [
  num(`${ch}ShadowX`, 0.25, 0, 1, 0.001), num(`${ch}ShadowY`, 0.25, 0, 1, 0.001),
  num(`${ch}HighlightX`, 0.75, 0, 1, 0.001), num(`${ch}HighlightY`, 0.75, 0, 1, 0.001),
  num(`${ch}BlackY`, 0, 0, 1, 0.001), num(`${ch}WhiteY`, 1, 0, 1, 0.001),
  bool(`${ch}MidOn`, false), num(`${ch}MidX`, 0.5, 0, 1, 0.001), num(`${ch}MidY`, 0.5, 0, 1, 0.001),
]);
const hslBand = (band: string) => grouped(label(band), [
  num(`${band}Hue`, 0, -100, 100, 1), num(`${band}Saturation`, 0, -100, 100, 1), num(`${band}Luminance`, 0, -100, 100, 1),
]);
const correction = () => [
  num('exposure', 0, -3, 3, 0.05), num('saturation', 0, -100, 100, 1), num('temperature', 0, -100, 100, 1),
  num('tint', 0, -100, 100, 1), num('strength', 100, 0, 100, 1, '%'),
];

/** Hidden color-wheels key: the definition default is the legacy curve (1); new instances get the luminance-preserving curve (2). */
export const TONE_CURVE: NumberParam = {
  type: 'number', key: 'toneCurve', label: 'Tone Curve', default: 1, min: 1, max: 2, step: 1, animatable: false, hidden: true, newInstance: 2,
};

export const EFFECTS: EffectDefinition[] = [
  def('color-wheels', 'Color Wheels', 'color', 'Primary grade: lift/gamma/gain/offset wheels, exposure, contrast, white balance and tone.', ['grade', 'wheels'], [
    wheel('shadowsWheel'), wheel('midtonesWheel'), wheel('highlightsWheel'), wheel('offsetWheel'),
    num('exposure', 0, -3, 3, 0.05), num('contrast', 1, 0, 2, 0.01), num('pivot', 0.5, 0, 1, 0.01),
    num('saturation', 0, -100, 100, 1), num('temperature', 0, -100, 100, 1), num('tint', 0, -100, 100, 1),
    num('colorBoost', 0, -100, 100, 1), num('lift', 0, -2, 2, 0.01), num('gamma', 1, 0, 4, 0.01), num('gain', 1, 0, 16, 0.01),
    num('offset', 0, -2, 2, 0.0025), num('blackPoint', 0, 0, 0.5, 0.005), num('whitePoint', 1, 0.5, 1.5, 0.005),
    num('midDetail', 0, -100, 100, 1), num('shadows', 0, -100, 100, 1), num('highlights', 0, -100, 100, 1),
    num('hue', 50, 0, 100, 1), num('lumMix', 100, 0, 100, 1), TONE_CURVE,
  ]),
  def('levels', 'Levels', 'color', 'Remap input black/white points with a gamma, then set the output range.', ['tone'], [
    num('inputBlack', 0, 0, 100, 1), num('inputWhite', 100, 0, 100, 1), num('gamma', 1, 0.1, 3, 0.01),
    num('outputBlack', 0, 0, 100, 1), num('outputWhite', 100, 0, 100, 1),
  ]),
  def('curves', 'Curves', 'color', 'Master and per-channel tone curves through shadow, highlight and optional mid points.', ['tone', 'curve'],
    ['master', 'red', 'green', 'blue'].flatMap(curveChannel)),
  def('hsl', 'HSL', 'color', 'Shift hue, saturation and luminance of eight colour bands.', ['hue', 'saturation'],
    ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'].flatMap(hslBand)),
  def('lut', 'LUT', 'color', 'Apply a 3D look-up table loaded from a .cube file.', ['look', 'cube'], [
    num('blend', 100, 0, 100, 1, '%'), data('lutName'), data('lutData'),
  ]),
  def('secondary-qualifier', 'Secondary Qualifier', 'color', 'Correct only the pixels inside a hue/saturation/luma key.', ['qualifier', 'mask'], [
    num('hueCenter', 0, 0, 360, 1, '°'), num('hueWidth', 35, 0, 180, 1, '°'), num('hueSoftness', 20, 0, 120, 1, '°'),
    num('satLow', 0, 0, 100, 1, '%'), num('satHigh', 100, 0, 100, 1, '%'), num('satSoftness', 10, 0, 100, 1, '%'),
    num('lumaLow', 0, 0, 100, 1, '%'), num('lumaHigh', 100, 0, 100, 1, '%'), num('lumaSoftness', 10, 0, 100, 1, '%'),
    bool('invertMask', false), bool('showMask', false), ...correction(),
  ]),
  def('power-window', 'Power Window', 'color', 'Correct inside a feathered ellipse or rectangle.', ['window', 'mask'], [
    select('shape', 'ellipse', opts(['ellipse', 'Ellipse'], ['rectangle', 'Rectangle'])),
    num('centerX', 50, 0, 100, 1, '%'), num('centerY', 50, 0, 100, 1, '%'), num('sizeX', 50, 2, 150, 1, '%'),
    num('sizeY', 50, 2, 150, 1, '%'), num('rotation', 0, -180, 180, 1, '°'), num('feather', 15, 0, 100, 1, '%'),
    bool('invertMask', false), bool('showMask', false), ...correction(),
  ]),
  def('retouch', 'Retouch', 'color', 'Edge-aware skin smoothing inside a skin-tone key.', ['skin', 'smooth'], [
    num('strength', 0, 0, 100, 1, '%'), num('radius', 1.5, 0.2, 5, 0.1, '%'), num('detail', 60, 0, 100, 1, '%'),
    num('edgeTolerance', 15, 0, 100, 1, '%'), num('hueCenter', 20, 0, 360, 1, '°'), num('hueWidth', 28, 0, 180, 1, '°'),
    num('hueSoftness', 24, 0, 120, 1, '°'), num('satLow', 8, 0, 100, 1, '%'), num('satHigh', 85, 0, 100, 1, '%'),
    num('satSoftness', 8, 0, 100, 1, '%'), num('lumaLow', 10, 0, 100, 1, '%'), num('lumaHigh', 92, 0, 100, 1, '%'),
    num('lumaSoftness', 10, 0, 100, 1, '%'), bool('showMask', false),
  ]),
  def('posterize', 'Posterize', 'color', 'Reduce each channel to a number of levels.', ['levels'], [num('levels', 8, 2, 64, 1)]),
  def('color-key', 'Color Key', 'color', 'Key out a colour (green screen) with spill reduction.', ['key', 'chroma', 'green screen'], [
    color('keyColor', 'rgba(0, 177, 64, 1)'), num('similarity', 40, 0, 100, 1), num('smoothness', 10, 0, 100, 1),
    num('spillReduction', 50, 0, 100, 1),
  ]),
  def('luma-key', 'Luma Key', 'color', 'Key out dark or bright areas by luminance.', ['key', 'luma'], [
    select('keyType', 'dark', opts(['dark', 'Darks'], ['bright', 'Brights'])), num('threshold', 20, 0, 100, 1), num('softness', 10, 0, 100, 1),
  ]),
  def('grayscale', 'Grayscale', 'color', 'Remove colour.', ['mono'], [num('amount', 100, 0, 100, 1, '%')]),
  def('sepia', 'Sepia', 'color', 'Warm brown vintage tone.', ['vintage'], [num('amount', 100, 0, 100, 1, '%')]),
  def('invert', 'Invert', 'color', 'Invert the colours.', ['negative'], [num('amount', 100, 0, 100, 1, '%')], { itemTypes: ALL }),
  def('vignette', 'Vignette', 'stylize', 'Darken the frame edges.', ['edges'], [
    num('amount', 50, 0, 100, 1), num('midpoint', 50, 0, 100, 1), num('roundness', 50, 0, 100, 1), num('feather', 50, 0, 100, 1),
  ]),
  def('sharpen', 'Sharpen', 'stylize', 'Unsharp-mask sharpening.', ['detail'], [num('amount', 50, 0, 300, 1), num('radius', 1, 0, 5, 0.1, 'px')]),
  def('glow', 'Glow', 'stylize', 'Bloom from the bright areas.', ['bloom', 'light'], [
    num('threshold', 70, 0, 100, 1), num('intensity', 50, 0, 100, 1), num('radius', 10, 1, 50, 1, 'px'), num('softness', 50, 10, 100, 1),
    num('rings', 4, 1, 32, 1, undefined, false), num('samplesPerRing', 16, 4, 64, 1, undefined, false),
  ]),
  def('glitch', 'Glitch', 'stylize', 'Digital block displacement and RGB split.', ['digital', 'distortion'], [
    num('intensity', 30, 0, 100, 1), num('blockSize', 50, 10, 100, 1), num('rgbSplit', 5, 0, 30, 1, 'px'),
  ]),
  def('vhs', 'VHS', 'stylize', 'Tape look: wobble, scanlines, colour bleed and noise.', ['retro', 'tape'], [
    num('scanlines', 40, 0, 100, 1), num('colorBleed', 50, 0, 100, 1), num('noise', 30, 0, 100, 1), num('distortion', 20, 0, 100, 1),
  ]),
  def('pixelate', 'Pixelate', 'stylize', 'Mosaic of square blocks.', ['mosaic'], [num('blockSize', 8, 2, 100, 1, 'px')]),
  def('ascii', 'ASCII', 'stylize', 'Render the image as text-like glyph cells.', ['text', 'retro'], [
    num('cellSize', 12, 4, 64, 1, 'px'), select('ramp', 'characters', opts(['characters', 'Characters'], ['blocks', 'Blocks'], ['dots', 'Dots'])),
    select('colorMode', 'mono', opts(['mono', 'Mono'], ['source', 'Source'])), color('monoColor', 'rgba(255,255,255,1)'),
    color('bgColor', 'rgba(0,0,0,1)'), num('contrast', 100, 0, 300, 1, '%'),
  ]),
  def('edge-detection', 'Edge Detection', 'stylize', 'Sobel edge outline.', ['outline'], [
    num('strength', 100, 0, 100, 1), num('threshold', 10, 0, 100, 1), num('mix', 100, 0, 100, 1),
  ]),
  def('box-blur', 'Box Blur', 'stylize', 'Uniform square blur.', ['blur'], [num('radius', 5, 0, 20, 1, 'px')]),
  def('motion-blur', 'Motion Blur', 'stylize', 'Directional blur.', ['blur', 'motion'], [
    num('amount', 20, 0, 100, 1), num('angle', 0, -180, 180, 1, '°'), num('samples', 24, 4, 128, 1, undefined, false),
  ]),
  def('radial-blur', 'Radial Blur', 'stylize', 'Blur radiating from a centre point.', ['blur'], [
    num('amount', 25, 0, 100, 1), num('centerX', 50, 0, 100, 1), num('centerY', 50, 0, 100, 1), num('samples', 32, 4, 256, 1, undefined, false),
  ]),
  def('zoom-blur', 'Zoom Blur', 'stylize', 'Blur zooming out from a centre point.', ['blur', 'zoom'], [
    num('amount', 30, 0, 100, 1), num('centerX', 50, 0, 100, 1), num('centerY', 50, 0, 100, 1), num('samples', 16, 4, 256, 1, undefined, false),
  ]),
  def('scanlines', 'Scanlines', 'stylize', 'Moving CRT scanlines.', ['crt', 'retro'], [
    num('density', 5, 1, 20, 0.5), num('opacity', 30, 0, 100, 1), num('speed', 0, 0, 100, 1, undefined, false),
  ]),
  def('threshold', 'Threshold', 'stylize', 'Black and white by a luminance level.', ['mono'], [num('level', 50, 0, 100, 1)]),
  def('dither', 'Dither', 'stylize', 'Ordered and pattern dithering into a retro palette.', ['retro', 'palette'], [
    select('pattern', 'bayer4', opts(['bayer2', 'Bayer 2x2'], ['bayer4', 'Bayer 4x4'], ['bayer8', 'Bayer 8x8'], ['halftone', 'Halftone'],
      ['lines', 'Lines'], ['crosses', 'Crosses'], ['dots', 'Dots'], ['grid', 'Grid'], ['scales', 'Scales'])),
    select('mode', 'image', opts(['image', 'Image'], ['linear', 'Linear'], ['radial', 'Radial'])),
    select('style', 'threshold', opts(['threshold', 'Threshold'], ['scaled', 'Scaled'])),
    select('shape', 'square', opts(['circle', 'Circle'], ['square', 'Square'], ['diamond', 'Diamond'])),
    select('palette', 'gameboy', opts(['bw', 'B&W'], ['gameboy', 'Game Boy'], ['cga', 'CGA'], ['sepia', 'Sepia'])),
    num('cellSize', 8, 2, 32, 1, 'px'), num('angle', 45, 0, 360, 1, '°'), num('scale', 100, 25, 200, 1),
    num('offsetX', 0, -100, 100, 1), num('offsetY', 0, -100, 100, 1),
  ]),
  def('halftone', 'Halftone', 'stylize', 'Print-style dot screen with paper grain.', ['print', 'dots'], [
    color('colorFront', '#2b2b2b'), color('colorBack', '#f2f1e8'), bool('originalColors', false), bool('inverted', false),
    select('grid', 'hex', opts(['hex', 'Hex'], ['square', 'Square'])),
    select('type', 'gooey', opts(['classic', 'Classic'], ['gooey', 'Gooey'], ['holes', 'Holes'], ['soft', 'Soft'])),
    num('size', 50, 0, 100, 1), num('radius', 125, 0, 200, 1), num('contrast', 40, 0, 100, 1), num('grainMixer', 20, 0, 100, 1),
    num('grainOverlay', 20, 0, 100, 1), num('grainSize', 50, 0, 100, 1),
  ]),
  def('gaussian-blur', 'Gaussian Blur', 'stylize', 'Smooth CSS blur.', ['blur'], [num('radius', 0, 0, 50, 0.5, 'px')], { itemTypes: ALL }),
  def('drop-shadow', 'Drop Shadow', 'stylize', 'Offset blurred shadow behind the item.', ['shadow'], [
    num('x', 4, -50, 50, 1, 'px'), num('y', 4, -50, 50, 1, 'px'), num('blur', 4, 0, 50, 1, 'px'), color('color', 'rgba(0,0,0,0.5)'),
  ], { itemTypes: ALL }),
  def('chromatic-aberration', 'Chromatic Aberration', 'distort', 'Offset the red and blue channels.', ['rgb', 'lens'], [
    num('amount', 5, 0, 50, 1, 'px'), num('angle', 0, -180, 180, 1),
  ]),
  def('lens-distortion', 'Lens Distortion', 'distort', 'Barrel or pincushion distortion.', ['lens', 'barrel'], [
    num('distortion', 0, -100, 100, 1), bool('mirrorEdges', true),
  ]),
  def('twirl', 'Twirl', 'distort', 'Swirl around a centre point.', ['swirl'], [
    num('amount', 10, -100, 100, 1), num('radius', 50, 10, 100, 1), num('centerX', 50, 0, 100, 1), num('centerY', 50, 0, 100, 1),
  ]),
  def('wave', 'Wave', 'distort', 'Sine-wave displacement on both axes.', ['ripple'], [
    num('amplitudeX', 20, 0, 100, 1), num('amplitudeY', 20, 0, 100, 1), num('frequencyX', 5, 1, 20, 0.5), num('frequencyY', 5, 1, 20, 0.5),
  ]),
  def('kaleidoscope', 'Kaleidoscope', 'distort', 'Mirrored radial segments.', ['mirror', 'radial'], [
    num('segments', 6, 2, 16, 1), num('rotation', 0, 0, 360, 1, '°'),
  ]),
  def('mirror', 'Mirror', 'distort', 'Mirror the left or top half.', ['symmetry'], [bool('horizontal', true), bool('vertical', false)]),
  def('film-grain', 'Film Grain', 'generate', 'Animated film grain.', ['noise', 'film'], [
    num('amount', 30, 0, 100, 1), num('size', 50, 10, 100, 1), num('speed', 100, 0, 500, 1, undefined, false),
  ]),
  // Not discoverable (part 4 §49.17-49.20). Lumetri ranges other than exposure ±4 are our assumption.
  def('lumetri-color', 'Lumetri Color', 'color', 'Legacy basic correction; kept so existing projects still render.', ['legacy'], [
    num('temperature', 0, -100, 100, 1), num('tint', 0, -100, 100, 1), num('exposure', 0, -4, 4, 0.05),
    num('contrast', 0, -100, 100, 1), num('highlights', 0, -100, 100, 1), num('shadows', 0, -100, 100, 1),
    num('whites', 0, -100, 100, 1), num('blacks', 0, -100, 100, 1), num('saturation', 100, 0, 200, 1),
    num('vibrance', 0, -100, 100, 1), wheel('shadowsWheel'), wheel('midtonesWheel'), wheel('highlightsWheel'),
  ], { visibility: 'retired', replacement: 'Use Color Wheels, Levels or Curves instead.' }),
  def('recolor', 'Element Colors', 'color', 'Recolour an element image from its palette data (OKLab).', ['element'], [], { itemTypes: ['image'], visibility: 'hidden' }),
  def('bg-removal', 'Background Removal', 'color', 'Multiply by a background-removal matte.', ['matte'], [], { visibility: 'hidden' }),
];

export const TRANSPORT_STAGES: TransportStage[] = [
  { id: 'video-input-709', name: 'BT.709 input', description: 'Re-encode BT.709 video codes to sRGB when the browser did not convert them (256-entry table).' },
  { id: 'stacked-alpha', name: 'Stacked alpha', description: 'Unpack a side-by-side frame: left half straight RGB, right half alpha (R channel).' },
];

const BY_ID = new Map(EFFECTS.map(e => [e.id, e]));
export const effectById = (id: string): EffectDefinition | undefined => BY_ID.get(id);
export const CATEGORY_ORDER: Category[] = ['color', 'stylize', 'distort', 'generate'];
