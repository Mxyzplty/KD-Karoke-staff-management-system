// SPDX-License-Identifier: AGPL-3.0-only
// Direct-call harness: the T03 runtime on an in-memory document, with no browser or store. Tests (and the parity
// sequences) drive the same ops through `intent` (UI path, `user`) and `call` (agent tools, `agent`), and read the
// document, the undo stacks and the journal records.
import { emptyDocument } from '../store/model';
import type { Asset, AssetLink, ProjectDocument, RecordData } from '../store/model';
import type { Intent, Outcome } from '../editor/commands';
import type { JournalInput } from './bus';
import { createRuntime } from './runtime';
import type { RuntimeOptions } from './runtime';
import type { ToolResult } from './tools';

export type EditorHarness = ReturnType<typeof createEditor>;
export function createEditor(initial: ProjectDocument = emptyDocument(), setup: { assets?: Asset[]; links?: AssetLink[]; options?: RuntimeOptions } = {}) {
  let doc = structuredClone(initial);
  const journal: JournalInput[] = [];
  const runtime = createRuntime({ get: () => doc, set: d => { doc = d; } }, { ...setup.options, journal: r => { journal.push(r); setup.options?.journal?.(r); } });
  runtime.setAssets(setup.assets ?? [], setup.links ?? []);
  return {
    runtime, bus: runtime.bus, journal,
    get doc() { return doc; },
    intent: (i: Intent): Outcome | undefined => runtime.handle(i),
    call: (name: string, args: RecordData = {}): ToolResult => runtime.call(name, args),
    labels: () => runtime.bus.labels(),
  };
}
