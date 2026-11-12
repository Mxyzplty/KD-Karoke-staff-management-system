// SPDX-License-Identifier: AGPL-3.0-only
// Template error codes → the text the UI shows (error codes §14). The authoring-limit codes are mapped only: the local
// library has no limits, so nothing here raises them. TEMPLATE_SELECTION_STALE, TEMPLATE_NOT_FOUND and TEMPLATE_INVALID are
// Cutframe's own codes (plan Q4); the stale one takes its text from §14's CONFLICT / STALE / CHANGED group.
import { StoreError } from '../store/model';

const TEXT: Record<string, string> = {
  TEMPLATE_AUTHORING_BILLING_UNAVAILABLE: 'We couldn’t check your template allowance. Please try again.',
  TEMPLATE_AUTHORING_QUOTA_EXCEEDED: 'Your personal-template allowance is in use. Wait for pending saves to finish or check your plan.',
  TEMPLATE_AUTHORING_MONTHLY_LIMIT: 'You’ve reached your plan’s monthly template limit. Check your plan or wait for your allowance to reset.',
  TEMPLATE_RATE_LIMITED: 'Too many template requests. Wait a moment, then try again.',
  TEMPLATE_NOT_FOUND: 'This template is no longer in your library.',
  TEMPLATE_INVALID: 'This is not a valid Cutframe template file.',
};
export const TEMPLATE_FALLBACK = 'We couldn’t complete that request. Please try again.';
/** §14's pattern groups, in the order they are tried after the exact codes. */
const GROUPS: [RegExp, string][] = [
  [/DEFAULT_UNAVAILABLE/, 'The built-in templates aren’t available yet. Please try again later.'],
  [/CONFLICT|STALE|CHANGED/, 'This project or template changed. Refresh it and review your choice again.'],
  [/FORGOTTEN|CORRECTED|SUPERSEDED/, 'The source has changed or was removed. Start a new review to use the current project.'],
  [/(^|_)(AUTH|UNAUTHORIZED|FORBIDDEN)(_|$)/, 'You don’t have access to this template.'],
];
/** The UI text of a template failure; a failure without a known code gets TEMPLATE_UNAVAILABLE's text. */
export function templateErrorText(code: unknown): string {
  if (typeof code !== 'string') return TEMPLATE_FALLBACK;
  return TEXT[code] ?? GROUPS.find(([pattern]) => pattern.test(code))?.[1] ?? TEMPLATE_FALLBACK;
}
/** A template failure with its code and UI text; `detail` (why a file was refused) is added after the text. */
export const templateError = (code: string, detail?: string) => new StoreError(code, detail ? `${templateErrorText(code)} ${detail}` : templateErrorText(code));
