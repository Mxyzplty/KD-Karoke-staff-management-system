// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const allowed = new Set(['MIT', 'MIT-0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'ISC', 'MPL-2.0', 'LGPL-2.0-only', 'LGPL-2.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Zlib']);
/** T05 (coordinator ruling Q6, 3 Nov): OFL-1.1 font files are allowed as vendored components only, never as npm packages. */
/** FX-3: CC0-1.0 demo-pack media (footage, music) is allowed as a vendored component only, never as an npm package. */
const vendorAllowed = new Set([...allowed, 'OFL-1.1', 'CC0-1.0']);
export function compatible(expression: string, set: Set<string> = allowed): boolean {
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let index = 0;
  function atom(): boolean {
    if (tokens[index] === '(') { index++; const v = or(); if (tokens[index++] !== ')') throw Error('Unbalanced SPDX expression'); return v; }
    const token = tokens[index++];
    if (!token || token === 'AND' || token === 'OR') throw Error('Invalid SPDX expression');
    return set.has(token);
  }
  function and(): boolean { let result = atom(); while (tokens[index] === 'AND') { index++; const rhs = atom(); result = result && rhs; } return result; }
  function or(): boolean { let result = and(); while (tokens[index] === 'OR') { index++; const rhs = and(); result = result || rhs; } return result; }
  try { const result = or(); return index === tokens.length && result; } catch { return false; }
}
export function checkPackages(packages: Record<string, { license?: string; resolved?: string }>): string[] {
  return Object.entries(packages).flatMap(([name, pkg]) => {
    if (/remotion|(?:^|\/)packages\//i.test(name) || (pkg.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(pkg.resolved))) return [`Forbidden dependency: ${name}`];
    return compatible(pkg.license ?? '') ? [] : [`Incompatible or unknown license: ${name || '(root)'} (${pkg.license ?? 'missing'})`];
  });
}
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.filter(e => e.name !== '__pycache__').map(async e => e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : /\.(ts|tsx|css|html|py|yml|txt)$/.test(e.name) ? [path.join(dir, e.name)] : []))).flat();
}
/** T14: vendored builds (vendor/manifest.json): allowed licence, every file present with its recorded SHA-256. */
export async function checkVendor(): Promise<{ errors: string[]; effective: Record<string, { license: string }>; count: number }> {
  const manifest = JSON.parse(await readFile('vendor/manifest.json', 'utf8')), errors: string[] = [];
  for (const c of manifest.components) {
    if (!compatible(c.license, vendorAllowed)) errors.push(`Incompatible vendored licence: ${c.name} (${c.license})`);
    for (const f of c.files) {
      const bytes = await readFile(f.path).catch(() => null);
      if (!bytes) { errors.push(`Missing vendored file: ${f.path}`); continue; }
      if (bytes.length !== f.bytes || createHash('sha256').update(bytes).digest('hex') !== f.sha256) errors.push(`Vendored file differs from vendor/manifest.json: ${f.path}`);
    }
  }
  return { errors, effective: manifest.effectiveLicenses ?? {}, count: manifest.components.length };
}
export async function checkLicenses(): Promise<number> {
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8')), vendor = await checkVendor();
  // A package whose declared licence omits embedded code is checked against its effective licence (T14 finding).
  for (const [key, row] of Object.entries(vendor.effective)) if (lock.packages[key]) lock.packages[key] = { ...lock.packages[key], license: row.license };
  const errors = [...checkPackages(lock.packages), ...vendor.errors];
  // Every authored source, tool, CI and config file; JSON data files (fixtures, manifests, package.json) are exempt.
  const rootConfigs = (await readdir('.')).filter(f => /\.config\.ts$|^tsconfig\.json$/.test(f));
  for (const file of [...rootConfigs, ...(await Promise.all(['apps', 'parity', 'scripts', 'tests', 'fixtures', 'datasets', '.github'].map(sourceFiles))).flat()]) {
    const text = await readFile(file, 'utf8');
    if (!text.slice(0, 300).includes('SPDX-License-Identifier: AGPL-3.0-only')) errors.push(`Missing SPDX: ${file}`);
    if (/from\s*['"][^'"]*(?:remotion|packages\/)/.test(text)) errors.push(`Forbidden source import: ${file}`);
  }
  if (!(await readFile('LICENSE', 'utf8')).includes('13. Remote Network Interaction')) errors.push('Full AGPL-3.0 license is missing');
  if (errors.length) throw Error(errors.join('\n'));
  return Object.keys(lock.packages).length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    if (process.argv.includes('--negative-test')) {
      // BSD-4-Clause's advertising clause is incompatible with the GPL family, so it must fail too; OFL-1.1 (T05, Q6) and
      // CC0-1.0 (FX-3) are allowed for vendored components only, so an npm package under either must fail.
      const failures = checkPackages({ 'node_modules/planted-proprietary': { license: 'LicenseRef-Proprietary' }, 'node_modules/planted-bsd4': { license: 'BSD-4-Clause' }, 'node_modules/planted-ofl': { license: 'OFL-1.1' }, 'node_modules/planted-cc0': { license: 'CC0-1.0' } });
      if (failures.length !== 4 || !failures[0].includes('planted-proprietary') || !failures[1].includes('planted-bsd4') || !failures[2].includes('planted-ofl') || !failures[3].includes('planted-cc0')) throw Error('Negative licence test did not reject all four planted dependencies');
      for (const failure of failures) console.log(`Expected failure: ${failure}`);
    } else console.log(`Verified ${await checkLicenses()} dependency licenses and authored source headers`);
  })().catch(e => { console.error(e.message); process.exitCode = 1; });
}
