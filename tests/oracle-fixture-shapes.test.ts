// SPDX-License-Identifier: AGPL-3.0-only
// T00's own schema-4 prerequisite projects are written in the stored shapes, so the oracle reads them.
import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../parity/oracle/item';
import { drawTracks } from '../parity/oracle/item';
import { renderFrame } from '../parity/oracle/render';
import { fixtureSource, oracleDeps } from '../parity/oracle/frame';

const store = process.env.CUTFRAME_FIXTURES;
it.skipIf(!store)('FX-2 30-minute project: stored track and property shapes render (letterboxed first clip at a reduced output size)', async () => {
  const project: Project = JSON.parse(await readFile(path.join(store!, 'prerequisites/FX-2-30min-1080p.json'), 'utf8'));
  expect(drawTracks(project).map(t => t.id)).toEqual(['video-main']);
  // tos-speech-45s (1280×534) scaled 1.5 → 1920×801 at y 139.5 in 1920×1080; at 192×108 rows 0–12 stay black.
  const frame = renderFrame(project, 1000, oracleDeps(fixtureSource(store)), { width: 192, height: 108 });
  const row = (y: number) => Array.from(frame.data.subarray(y * 192 * 4, (y + 1) * 192 * 4)).filter((_, i) => i % 4 !== 3);
  expect(Math.max(...row(5).map(v => Math.round(v * 255)))).toBe(0);
  expect(Math.max(...row(54).map(v => Math.round(v * 255)))).toBeGreaterThan(20);
  // The pre-fix FX-2 track shape (legacy `type`) is refused. Positions written as `x`/`y` would not throw: a
  // missing positionX/Y takes the registry default 0 (§53.1.1), which the black rows 0–12 above rule out.
  const legacyTracks = { ...project, tracks: project.tracks.map(({ kind, ...t }: any) => ({ ...t, type: kind })) };
  expect(() => renderFrame(legacyTracks, 1000, oracleDeps(fixtureSource(store)), { width: 192, height: 108 })).toThrow();
});

it.skipIf(!store)('FX-2 three.js projects: stored track kinds are read', async () => {
  for (const name of ['FX-2-1-threejs-60s.json', 'FX-2-5-threejs-60s.json']) {
    const project: Project = JSON.parse(await readFile(path.join(store!, 'prerequisites', name), 'utf8'));
    expect(drawTracks(project).length).toBe(project.tracks.length);
  }
});
