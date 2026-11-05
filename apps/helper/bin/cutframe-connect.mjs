#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// `npx cutframe-connect`: runs the TypeScript helper through tsx (a devDependency of this repository; a published package
// would ship a compiled build instead).
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
await main(process.argv.slice(2));
