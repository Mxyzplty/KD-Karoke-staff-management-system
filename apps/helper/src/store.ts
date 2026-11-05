// SPDX-License-Identifier: AGPL-3.0-only
// Pairing tokens in the helper's user-only config file (Contract A). Cutframe keeps a SHA-256 hash of each 32-byte token,
// never the token itself (improvement: a copied config file cannot pair a tab). The file is read again on every check, so a
// revoke from another helper process or by deleting the file takes effect on the next ping.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TokenRecord = { hash: string; createdAt: string; tabId?: string };
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

/** %APPDATA%\cutframe on Windows, else $XDG_CONFIG_HOME/cutframe or ~/.config/cutframe. */
export function defaultConfigDir(): string {
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'cutframe');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cutframe');
}

/** User-only on Windows: grant the process's own account (by SID, from its token; %USERNAME% can be stale), then drop
 *  the inherited entries. Best effort: if the grant fails, inheritance stays and the file stays readable. The tools come
 *  from System32, not PATH (under Git Bash, `whoami` is GNU coreutils' and rejects /user). */
function userOnlyWindows(file: string) {
  const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const run = (cmd: string, args: string[]) => execFileSync(join(sys, `${cmd}.exe`), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try {
    const sid = /"(S-1-[\d-]+)"/.exec(run('whoami', ['/user', '/fo', 'csv', '/nh']))?.[1];
    if (!sid) return;
    run('icacls', [file, '/grant:r', `*${sid}:F`]);
    run('icacls', [file, '/inheritance:r']);
  } catch { /* best effort */ }
}

export class TokenStore {
  readonly file: string;
  constructor(readonly dir: string) { this.file = join(dir, 'helper.json'); }
  read(): TokenRecord[] {
    try { const data = JSON.parse(readFileSync(this.file, 'utf8')); return Array.isArray(data?.tokens) ? data.tokens.filter((t: TokenRecord) => typeof t?.hash === 'string') : []; } catch { return []; }
  }
  private write(tokens: TokenRecord[]) {
    const created = !existsSync(this.file);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ version: 1, tokens }, null, 2) + '\n', { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(this.file, 0o600);
    else if (created) userOnlyWindows(this.file);
  }
  add(token: string, tabId?: string) { this.write([...this.read(), { hash: hashToken(token), createdAt: new Date().toISOString(), ...(tabId ? { tabId } : {}) }]); }
  has(token: string) { return this.hasHash(hashToken(token)); }
  hasHash(hash: string) { return this.read().some(t => t.hash === hash); }
  count() { return this.read().length; }
  revokeHash(hash: string) { const all = this.read(), kept = all.filter(t => t.hash !== hash); if (kept.length !== all.length) this.write(kept); return kept.length !== all.length; }
  revokeAll() { if (existsSync(this.file)) this.write([]); }
}
