// SPDX-License-Identifier: AGPL-3.0-only
// Effect definition schema (T10a). Data only: no DOM or GPU access.

export type ItemType = 'video' | 'image' | 'text' | 'shape' | 'motionGraphic' | 'layout' | 'caption';
export type Category = 'color' | 'stylize' | 'distort' | 'generate';
export type RenderType = 'webgl' | 'css';
/** discoverable: listed and addable; hidden: applied from element data only; retired: existing instances stay editable. */
export type Visibility = 'discoverable' | 'hidden' | 'retired';

export interface Wheel { angle: number; distance: number }

interface ParamBase {
  key: string;
  label: string;
  /** UI grouping (curves channel, HSL band, wheel block); absent = ungrouped. */
  group?: string;
  animatable: boolean;
  /** Hidden keys are accepted but never listed (color-wheels `toneCurve`). */
  hidden?: boolean;
}
export interface NumberParam extends ParamBase {
  type: 'number'; default: number; min: number; max: number; step: number; unit?: string;
  /** Value written into a newly created instance when it differs from the definition default. */
  newInstance?: number;
}
export interface BooleanParam extends ParamBase { type: 'boolean'; default: boolean }
export interface SelectOption { value: string; label: string }
export interface SelectParam extends ParamBase { type: 'select'; default: string; options: SelectOption[] }
export interface ColorParam extends ParamBase { type: 'color'; default: string }
export interface ColorWheelParam extends ParamBase { type: 'colorWheel'; default: Wheel }
export interface DataParam extends ParamBase { type: 'data'; default: string }
export type ParamDef = NumberParam | BooleanParam | SelectParam | ColorParam | ColorWheelParam | DataParam;

/** One shader uniform slot range: params live in a vec4 array, scalar slot `slot` .. `slot + size - 1`. */
export interface UniformSlot { key: string; slot: number; size: number }

export interface EffectDefinition {
  id: string;
  name: string;
  category: Category;
  description: string;
  renderType: RenderType;
  visibility: Visibility;
  tags: string[];
  itemTypes: ItemType[];
  params: ParamDef[];
  /** WebGL uniform mapping (empty for CSS effects). */
  uniforms: UniformSlot[];
  /** Retired effects only: what to use instead. */
  replacement?: string;
}

/** Internal pipeline stages that never appear in the effect stack (part 4 §48 0.1). */
export interface TransportStage { id: 'video-input-709' | 'stacked-alpha'; name: string; description: string }

/** Value shapes after validation/resolution. Data params carry strings; recolor/bg-removal inputs come from element data. */
export type ParamValue = number | boolean | string | Wheel;
export type ParamValues = Record<string, ParamValue>;

/** Scalar slot 0..7 are reserved for frame constants; parameter slots start here. */
export const FIRST_PARAM_SLOT = 8;
