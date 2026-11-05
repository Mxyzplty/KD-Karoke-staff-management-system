// SPDX-License-Identifier: AGPL-3.0-only
// Snapshot of every error the runtime constructs. The sandbox trusts a thrown value's code only through this registry,
// so user code cannot forge a code by throwing a look-alike object or by editing a caught runtime error.
type Issued = { code: string; message: string; details?: unknown };
const issued = new WeakMap<object, Issued>(), remember = WeakMap.prototype.set.bind(issued), recall = WeakMap.prototype.get.bind(issued);
const TRUSTED_CODES: Readonly<Record<string, true>> = Object.freeze(Object.assign(Object.create(null), { MG_WATCHDOG: true, MG_MEMORY_LIMIT: true, MG_SANDBOX_DENIED: true, VALIDATION_ERROR: true, UNSUPPORTED_OPTION: true, COMPILATION_ERROR: true, MG_RENDER_FAILED: true }));
export class MotionGraphicError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'MotionGraphicError'; remember(this, { code, message, details }); }
}
export const isTrustedCode = (code: unknown): code is string => typeof code === 'string' && TRUSTED_CODES[code] === true;
export function trustedError(value: unknown): Issued | undefined {
  const known = typeof value === 'object' && value !== null ? recall(value) : undefined;
  return known && isTrustedCode(known.code) ? known : undefined;
}
export function compilationError(error: unknown): MotionGraphicError {
  if (error instanceof MotionGraphicError) return error;
  return new MotionGraphicError('COMPILATION_ERROR', `compilation error: ${error instanceof Error ? error.message : String(error)}`);
}
/** Failures a second render cannot change (the code, its options, the sandbox's limits): they fail at once (review m3). */
export const STATIC_RENDER_CODES: readonly string[] = ['COMPILATION_ERROR', 'VALIDATION_ERROR', 'MG_SANDBOX_DENIED', 'MG_MEMORY_LIMIT', 'UNSUPPORTED_OPTION'];
/** Whether a render that just failed (`attempt` 0 for the first) is asked once more. Every caller that renders an exact
 *  picture shares this rule: mg/frames.ts graphicPicture for the app, mg/adapter.ts frame() for a parity run (FU-m1), so
 *  one load timeout costs an attempt and not the run. MG_WATCHDOG is static on a preview frame only — a runaway graphic
 *  holds the editor's thread for one budget, not two; capture, export and a parity run ask again. */
export const renderAgain = (code: string | undefined, attempt: number, purpose: 'preview' | 'capture' = 'capture'): boolean =>
  attempt < 1 && !(code !== undefined && (STATIC_RENDER_CODES.includes(code) || (code === 'MG_WATCHDOG' && purpose === 'preview')));
/** `render` under that rule; the last failure is rethrown. The loop lives here so a caller inside a page callback holds
 *  only an anonymous argument: a named function there is rewritten to esbuild's `__name` helper, which the page lacks. */
export async function renderWithRetry<T>(render: () => Promise<T>, purpose?: 'preview' | 'capture'): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await render(); }
    catch (error) { if (!renderAgain((error as { code?: string })?.code, attempt, purpose)) throw error; }
  }
}
export function supportedOptions(name: string, options: object | undefined, allowed: readonly string[]): void {
  for (const key of Object.keys(options ?? {})) if (!allowed.includes(key)) throw new MotionGraphicError('UNSUPPORTED_OPTION', `${name}: unsupported option '${key}' (API pinned to 4.0.427).`);
}
