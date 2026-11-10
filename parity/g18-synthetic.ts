// SPDX-License-Identifier: AGPL-3.0-only
// A synthetic G-18 stored-reference folder for testing the replay support (parity/g18.ts) without Xapp captures, and a standalone
// self-test of the replay and the export-frame comparator. It is NOT the G-18 reference and says nothing about Xapp parity: it is a
// written-spec oracle for one tiny block — create a video track, place the speech clip, create a caption track, addCaptions (no
// style), one editAllCaptionStyles {renderMode}, then a context read and a viewItemDetails read — with every stored result written
// by hand from the agent tool contracts (addCaptions / editAllCaptionStyles / manageTrack / addMedia / context / viewItemDetails),
// not produced by Cutframe. The plan gives four speech words (2.96–4.34 s) → exactly one caption, so the context read's one caption
// item is the oracle. No private data: the clip is only an asset id and word times, and the frame checks run on in-memory pixels
// and temp files. Run standalone (`npx tsx parity/g18-synthetic.ts`): it drives runG18 with no --export (so no Chromium), checks the
// base replay passes with the documented viewItemDetails difference and that three seeded faults fail, then checks the SSIM metric
// detects a one-pixel change and that matchExportFrames / modeFolders refuse a tampered name, a frame collision, an empty folder and
// a wrong set of render-mode subfolders.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from './normalise';
import type { G01Step } from './g01';
import { SYNTHETIC_FIELDS } from './g01-synthetic';
import { matchExportFrames, MIN_SSIM, ssim } from './g08-export';
import { runG18, type G18Plan } from './g18';
import { modeFolders } from './g18-export';

type Rec = { [key: string]: Json };
/** Which fault to seed, driving the negative variants: a wrong context item count, a stored call failure, or a leaked render
 *  setting on a stored caption detail. Undefined writes the clean block. */
type Fault = 'context-count' | 'call-success' | 'leaked-render';
const VID = 'vid-speech', VTRACK = 'vtrack', VITEM = 'vitem', CTRACK = 'ctrack', CAP = 'cap1';

/** Writes `<dir>/results/*`, `<dir>/calls.json`, `<dir>/assets.json` and `<dir>/plan.json`; returns the options runG18 takes.
 *  The replay learns the Cutframe track / item ids from the manageTrack / addMedia results, so the later trackId inputs remap. */
export async function writeSyntheticG18(dir: string, o: { fault?: Fault } = {}) {
  const assets = { [VID]: 'speech' };
  const plan: G18Plan = { sources: { [VID]: { segments: [{ speaker: 0, words: [
    { word: 'This', start: 2.96, end: 3.20 }, { word: 'is', start: 3.20, end: 3.50 }, { word: 'pretty', start: 3.50, end: 3.90 }, { word: 'freaky.', start: 3.90, end: 4.34 },
  ] }] } } };
  const files = new Map<string, Rec>(), steps: G01Step[] = [];
  const text = (blocks: string[]) => blocks.join('\n<<<BLOCK>>>\n');
  const store = (id: string, tool: string, input: Rec, result: Rec) => {
    files.set(id, { tool_name: tool, tool_input: input, result_text: text([`${tool} result`, JSON.stringify(result, null, 2)]), notes: '' });
    steps.push(id);
  };

  store('S00', 'manageTrack', { action: 'create', kind: 'video' }, { success: true, data: { track: { id: VTRACK, kind: 'video' } } });
  store('S01', 'addMedia', { trackId: VTRACK, items: [{ assetId: VID }] }, { success: true, data: { addedItemIds: [VITEM] } });
  store('S02', 'manageTrack', { action: 'create', kind: 'caption' }, { success: true, data: { track: { id: CTRACK, kind: 'caption' } } });
  // addCaptions: Xapp stores no result envelope (notes Q4), so the replay runs it and does not compare the envelope.
  store('A00', 'addCaptions', { trackId: CTRACK, source: 'speech' }, { success: true });
  // editAllCaptionStyles: the pass-fail parity (§12 accepted all five render modes). renderMode goes inside `properties` (schema).
  store('E00', 'editAllCaptionStyles', { trackId: CTRACK, properties: { renderMode: 'highlight' } },
    o.fault === 'call-success' ? { success: false, error: 'seeded failure', code: 'SEEDED' } : { success: true });
  // context: one caption track with one caption item (four words → one chunk). 'context-count' seeds a second, phantom item.
  store('R00', 'context', {}, { success: true, data: {
    tracks: { [CTRACK]: { kind: 'caption', itemCount: o.fault === 'context-count' ? 2 : 1 }, [VTRACK]: { kind: 'video' } },
    layerOrder: [{ id: CTRACK, type: 'track' }, { id: VTRACK, type: 'track' }],
  } });
  // viewItemDetails: §12 decision 2 — Xapp returns no renderMode. 'leaked-render' seeds one, which contradicts §12 and must fail.
  store('V00', 'viewItemDetails', { itemId: CAP }, { success: true, data: {
    id: CAP, type: 'caption', startTime: 2.96, endTime: 4.84, layer: CTRACK, ...(o.fault === 'leaked-render' ? { renderMode: 'highlight' } : {}),
  } });

  const calls = [steps];
  await mkdir(path.join(dir, 'results'), { recursive: true });
  for (const [id, record] of files) await writeFile(path.join(dir, 'results', `${id}.json`), JSON.stringify(record, null, 2));
  await writeFile(path.join(dir, 'calls.json'), JSON.stringify(calls, null, 2));
  await writeFile(path.join(dir, 'assets.json'), JSON.stringify(assets, null, 2));
  await writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  return { calls, assets, plan, ...SYNTHETIC_FIELDS };
}

// ---- Standalone self-test (no --export, so no Chromium; the frame checks use in-memory pixels and temp files, no ffmpeg).
const FRAME = '^E-(\\d+)\\.png$';
const assert = (cond: unknown, msg: string) => { if (!cond) throw Error(`assertion failed: ${msg}`); };
const throws = (fn: () => unknown, msg: string) => { try { fn(); } catch { return; } throw Error(`expected a throw: ${msg}`); };
const rejects = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); } catch { return; } throw Error(`expected a rejection: ${msg}`); };

async function replay(root: string, name: string, fault?: Fault) {
  const dir = path.join(root, name);
  const w = await writeSyntheticG18(dir, fault ? { fault } : {});
  return runG18(dir, { calls: w.calls, assets: w.assets, plan: w.plan, toolField: w.toolField, inputField: w.inputField, output: path.join(root, `${name}-out`) });
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g18-self-'));
  try {
    // 1. The base replay has no failed step: the call results and the one-item caption track match, and the viewItemDetails
    // difference is recorded. The overall status is 'uncompared', not 'passed', because addCaptions carries no comparable envelope.
    const pass = await replay(root, 'base');
    assert(pass.failed === 0, `base replay has no failed step (${pass.failed}: ${pass.summary})`);
    assert(pass.status === 'uncompared', `base replay is uncompared, as addCaptions has no envelope (got ${pass.status})`);
    assert(pass.passed >= 5, `the call, context and viewItemDetails comparisons passed (${pass.passed})`);
    assert(pass.documented >= 1, 'the viewItemDetails documented difference is recorded');
    const steps = pass.parts.flatMap(p => p.steps);
    assert(steps.find(s => s.tool === 'editAllCaptionStyles')?.status === 'passed', 'editAllCaptionStyles comparison passed');
    assert(steps.find(s => s.tool === 'context')?.status === 'passed', 'context caption-track comparison passed');
    assert(steps.find(s => s.tool === 'addCaptions')?.status === 'uncompared', 'addCaptions is uncompared (Xapp stores no envelope)');

    // 2. Each seeded fault is caught.
    for (const f of ['context-count', 'call-success', 'leaked-render'] as const) {
      const r = await replay(root, f, f);
      assert(r.status === 'failed', `the '${f}' fault is detected (got ${r.status})`);
    }

    // 3. The SSIM metric detects a one-pixel change and the 0.98 floor rejects it.
    const W = 8, H = 8, gray = new Uint8Array(W * H * 4);
    for (let i = 0; i < gray.length; i += 4) { gray[i] = gray[i + 1] = gray[i + 2] = 128; gray[i + 3] = 255; }
    const flip = gray.slice(); flip[0] = flip[1] = flip[2] = 255;
    assert(ssim(gray, gray, W, H) >= MIN_SSIM, 'identical frames clear the SSIM floor');
    assert(ssim(gray, flip, W, H) < MIN_SSIM, 'a one-pixel change drops below the SSIM floor');

    // 4. Stored frame names: a clean set parses; a tampered name, a frame collision and an empty folder are refused.
    assert(matchExportFrames(['E-0.png', 'E-100.png'], FRAME, 'ms', 30).length === 2, 'two frame names parse');
    throws(() => matchExportFrames(['E-0.png', 'tampered.png'], FRAME, 'ms', 30), 'a name that gives no frame time is refused');
    throws(() => matchExportFrames(['E-100.png', 'E-110.png'], FRAME, 'ms', 30), 'two names on the same frame index are refused');
    throws(() => matchExportFrames([], FRAME, 'ms', 30), 'an empty frame folder is refused');

    // 5. The render-mode subfolders must be exactly --modes.
    const exportDir = path.join(root, 'frames', 'export');
    await mkdir(path.join(exportDir, 'default'), { recursive: true });
    await mkdir(path.join(exportDir, 'highlight'), { recursive: true });
    await modeFolders(exportDir, ['default', 'highlight']);
    await rejects(() => modeFolders(exportDir, ['default']), 'an unlisted subfolder is refused');
    await rejects(() => modeFolders(exportDir, ['default', 'highlight', 'slide-up']), 'a missing subfolder is refused');

    console.log(JSON.stringify({ selfCheck: 'g18', replay: 'passed', faultsDetected: 3, ssim: 'one-pixel change detected', frameNames: 'validated', modeFolders: 'validated' }, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
