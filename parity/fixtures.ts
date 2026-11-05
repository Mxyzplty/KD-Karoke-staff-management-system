// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export type FixtureFile = { name: string; relative: string; sha256: string; bytes: number; location: 'store' | 'repo' };
export async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function manifestFiles(markdown: string): FixtureFile[] {
  let section = '';
  const files: FixtureFile[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) section = line;
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const name = cells[0].replaceAll('`', '');
    const hashCell = cells.find(c => /^`[0-9a-f]{64}`$/.test(c));
    if (!hashCell) continue;
    const bytes = cells.find(c => /^\d+$/.test(c));
    if (!bytes) throw Error(`Manifest has no byte length: ${name}`);
    const folder = section.includes('Synthetic') ? 'synthetic' : section.includes('Fonts') ? 'fonts' : 'corpus';
    const isRepo = /^OT-[367] /.test(name);
    const relative = isRepo ? `fixtures/${name}` : name.includes('/') ? name : `${folder}/${name}`;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(s => s === '..' || s === '.')) throw Error(`Unsafe fixture path: ${name}`);
    files.push({ name, relative, sha256: hashCell.slice(1, -1), bytes: Number(bytes), location: isRepo ? 'repo' : 'store' });
  }
  if (!files.length) throw Error('Fixture manifest contains no checksums');
  if (new Set(files.map(f => f.relative)).size !== files.length) throw Error('Duplicate fixture manifest path');
  return files;
}
export async function fixturePath(file: FixtureFile, store: string, repo = process.cwd()): Promise<string> {
  let base: string;
  try { base = await realpath(file.location === 'repo' ? repo : store); }
  catch { throw Error(`Fixture missing: ${file.relative}; fixture root unavailable`); }
  let resolved: string;
  try { resolved = await realpath(path.resolve(base, file.relative)); }
  catch { throw Error(`Fixture missing: ${file.relative}`); }
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error(`Fixture escapes store: ${file.relative}`);
  return resolved;
}
export async function verifyFixtures(store = process.env.CUTFRAME_FIXTURES, repo = process.cwd()): Promise<FixtureFile[]> {
  if (!store) throw Error('CUTFRAME_FIXTURES must name the openly licensed fixture store');
  const files = manifestFiles(await readFile(path.join(repo, 'fixtures/Cutframe test fixtures (C).md'), 'utf8'));
  for (const file of files) {
    const resolved = await fixturePath(file, store, repo);
    const actual = await sha256(resolved);
    if (actual !== file.sha256 || (await stat(resolved)).size !== file.bytes) throw Error(`Fixture mismatch: ${file.relative}; expected SHA-256 ${file.sha256}, actual ${actual}`);
  }
  return files;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyFixtures().then(files => console.log(`Verified ${files.length} manifest files`)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
