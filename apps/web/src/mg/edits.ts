// SPDX-License-Identifier: AGPL-3.0-only
import { MotionGraphicError } from './errors';
export type CodePatch = { old_string: string; new_string: string };
export function validateSummary(input: unknown): { valid: boolean; summary: string; reason?: 'required' | 'too-long'; message?: string } {
  const summary = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (!summary) return { valid: false, summary, reason: 'required', message: 'Motion graphic summary is required. Describe what the graphic visually represents in 1 sentence, or up to 3 short sentences for complex graphics.' };
  if (summary.length > 400) return { valid: false, summary, reason: 'too-long', message: 'Motion graphic summary must be 400 characters or less.' };
  return { valid: true, summary };
}
function missing(part: string, details?: unknown): never {
  throw new MotionGraphicError('STRING_NOT_FOUND', `The text to replace was not found in the ${part}. Make sure old_string matches exactly (character-for-character).`, details);
}
export function patchCode(code: string, patches: CodePatch[]): { code: string; patches: string[] } {
  const statuses: string[] = []; let result = code, failed = false;
  for (const patch of patches) {
    if (!result.includes(patch.old_string)) { statuses.push(`NOT FOUND: "${patch.old_string.slice(0, 60)}..."`); failed = true; }
    else { result = result.replace(patch.old_string, () => patch.new_string); statuses.push(`OK: replaced "${patch.old_string.slice(0, 40)}..."`); }
  }
  if (failed) missing('code', { patches: statuses });
  return { code: result, patches: statuses };
}
// The caller supplies the named section's text; this pure function never guesses section delimiters.
export function editMotionGraphicCode(code: string, patch: CodePatch & { section?: string }): string {
  if (!code.includes(patch.old_string)) missing(patch.section ?? 'code');
  return code.replace(patch.old_string, () => patch.new_string);
}
