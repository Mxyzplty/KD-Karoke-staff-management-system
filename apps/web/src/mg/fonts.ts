// SPDX-License-Identifier: AGPL-3.0-only
// Faces the motion-graphic sandbox draws (vendor/roboto, Apache-2.0, checked by scripts/licenses.ts). Every G-06 snippet
// asks for `Roboto, Arial, sans-serif`; Xapp's export draws Roboto from its font catalogue. Passed to the sandbox as data
// URLs (CSP font-src data:) and embedded in each rasterised frame. agent-checks.ts SANDBOX_FAMILIES lists the families.
import regular from '../../../../vendor/roboto/Roboto-Regular.ttf?inline';
import bold from '../../../../vendor/roboto/Roboto-Bold.ttf?inline';
export type SandboxFont = { family: string; weight: number; src: string };
export const SANDBOX_FONTS: readonly SandboxFont[] = [{ family: 'Roboto', weight: 400, src: regular }, { family: 'Roboto', weight: 700, src: bold }];
