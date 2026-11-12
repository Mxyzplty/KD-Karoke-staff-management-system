// SPDX-License-Identifier: AGPL-3.0-only
// T22 agent tool handlers: applyPreset (one 'Add items' command) and browsePresets (read-only). applyPreset's success shape
// is Cutframe's own (no captured success row): the addMedia / addLayout family.
import type { RecordData } from '../store/model';
import type { ToolContext, ToolResult } from '../timeline/tools';
import { fail, toMs } from '../timeline/model';
import { applyStylePreset } from './apply';
import { browsePresets as browse, findStylePreset } from './browse';
import { CATEGORIES } from './model';

type Handler = (ctx: ToolContext, args: RecordData) => ToolResult;
type InputError = { path: string; code: string; message: string };
/** The helper's schema rule for callers that skip the helper, in its exact INVALID_TOOL_INPUT shape (as mg/tools.ts
 *  `numbers`): `details` at the top level, returned, not thrown. The reasons are the helper's (apps/helper/src/schemas.ts). */
function refusal(tool: string, errors: InputError[]): ToolResult | undefined {
  if (errors.length) return { success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}`, message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors } };
}
const typed = (args: RecordData, key: string, type: 'string' | 'number'): InputError[] =>
  args[key] === undefined || typeof args[key] === type && (type === 'string' || Number.isFinite(args[key])) ? [] : [{ path: `$.${key}`, code: 'TYPE', message: `must be ${type}` }];

export const applyPreset: Handler = (ctx, args) => refusal('applyPreset', [
  ...(args.presetId === undefined ? [{ path: '$.presetId', code: 'REQUIRED', message: "must have required property 'presetId'" }] : typed(args, 'presetId', 'string')),
  ...typed(args, 'timelineStart', 'number'),
]) ?? ctx.bus.run('Add items', 'agent', doc => {
  const p = findStylePreset(args.presetId);
  if (!p) fail('PRESET_NOT_FOUND', `Preset '${args.presetId}' not found. Use browsePresets to list the presets.`);
  const items = applyStylePreset(doc, p!, toMs(args.timelineStart ?? 0));
  return { success: true, message: `Applied "${p!.name}" — ${items.length} item(s)`, data: { presetId: p!.id, itemIds: items.map(i => i.id), trackIds: items.map(i => i.trackId) } };
}) as ToolResult;
export const browsePresets: Handler = (_ctx, args) => refusal('browsePresets', [
  ...typed(args, 'category', 'string'),
  ...(typeof args.category === 'string' && !CATEGORIES.some(c => c.slug === args.category) ? [{ path: '$.category', code: 'ENUM', message: 'must be equal to one of the allowed values' }] : []),
  ...typed(args, 'query', 'string'),
]) ?? browse(args);
