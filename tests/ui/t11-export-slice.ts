// SPDX-License-Identifier: AGPL-3.0-only
// Run by tests/ui/t11-export.spec.ts through tsx (Playwright's loader cannot import parity/ot6-fade: it reaches a JSON module and import.meta):
// prints the OT-6 fade slice (parity/ot6-fade.ts ot6FadeSlice) and the transitions of the slice without the fade as JSON. argv: <store>.
import { ot6FadeSlice } from '../../parity/ot6-fade';

const fade = await ot6FadeSlice(process.argv[2]);
const cut = await ot6FadeSlice(process.argv[2], { transition: false });
process.stdout.write(JSON.stringify({ fade, cutTransitions: cut.doc.transitions }));
