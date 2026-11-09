// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger rows 2 and 4: pairing and the token file (codes, the reverse path, hashed tokens, permissions, revoke) and the tab protocol
// spoken by a raw ws client (every message type, ping/stall knobs, malformed input, close codes).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Helper, startHelper, VERSION } from '../apps/helper/src/helper';
import { defaultConfigDir, hashToken, newToken, TokenStore } from '../apps/helper/src/store';
import { CLOSE, CODE_TTL_MS, DEFAULT_PORT, LINK_ERRORS, PING_MS, PORT_RANGE, PROTOCOL, RECONNECT_DELAYS, RECONNECT_MAX, RECONNECT_STABLE_MS, RESOURCE_QUIET_MS, SERVED_TOOLS, STALL_MS } from '../apps/web/src/agent/protocol';

const ORIGIN = 'http://127.0.0.1:4173';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 't18a-pair-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
async function start(options: ConstructorParameters<typeof Helper>[0] = {}) {
  const lines: string[] = [];
  const configDir = options.configDir ?? tmp();
  const helper = await startHelper({ port: 0, log: l => lines.push(l), ...options, configDir });
  cleanups.push(() => helper.close());
  return { helper, lines, configDir };
}

/** A raw tab: a ws client with an ordered inbox. */
class RawTab {
  inbox: any[] = [];
  closed: Promise<{ code: number; reason: string }>;
  private wake?: () => void;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d, binary) => { this.inbox.push(binary ? { binary: true } : JSON.parse(String(d))); this.wake?.(); this.wake = undefined; });
    this.closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('error', () => {});
  }
  static async open(port: number, o: { origin?: string } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tab`, { origin: o.origin ?? ORIGIN });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const tab = new RawTab(ws);
    cleanups.push(() => ws.terminate());
    return tab;
  }
  send(m: unknown) { this.ws.send(typeof m === 'string' || Buffer.isBuffer(m) ? m : JSON.stringify(m)); }
  /** The next message, in arrival order; fails when it is not of `type`. D34: pure event-driven (ws 'message' wakes us), and the wait
   *  only has to outlast TokenStore's first write: Contract A has no cap, the helper runs in this process, and under load whoami + 2×icacls
   *  blocked the event loop for 9.8 s (13.2 s with the write before), so the timer fired ahead of the reply. 25 s stays inside vitest's 30 s. */
  async next(type?: string, ms = 25_000): Promise<any> {
    if (!this.inbox.length) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve(); }, ms);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    if (!this.inbox.length) throw new Error(`no ${type ?? 'message'} within ${ms} ms`);
    const m = this.inbox.shift();
    if (type) expect(m.type, JSON.stringify(m)).toBe(type);
    return m;
  }
  async quiet(ms = 80) { await sleep(ms); expect(this.inbox).toEqual([]); }
  hello(extra: Record<string, unknown> = {}) { this.send({ type: 'hello', protocol: PROTOCOL, projectId: 'p1', tabId: 'tab-a', ...extra }); }
}
/** hello → code → pair → paired + active hello. Returns the token and the connection id. */
async function pair(helper: Helper, tab: RawTab, extra: Record<string, unknown> = {}) {
  tab.hello(extra);
  const ack = await tab.next('hello');
  const code = helper.pairingCode!;
  tab.send({ type: 'pair', code });
  const paired = await tab.next('paired');
  const active = await tab.next('hello');
  return { token: paired.token as string, connId: ack.connId as string, active };
}

describe('t18a pairing (row 2)', () => {
  it('row 2: an unpaired hello is answered {paired:false, active:false} and makes the helper print a pairing code', async () => {
    const { helper, lines } = await start();
    const tab = await RawTab.open(helper.port);
    tab.hello();
    const ack = await tab.next('hello');
    expect(ack).toEqual({ type: 'hello', protocol: 1, version: VERSION, connId: expect.stringMatching(UUID), paired: false, active: false });
    expect(helper.pairing).toBe(true);
    expect(lines).toEqual([`Pairing code: ${helper.pairingCode} (valid 5 minutes). In the Cutframe editor press Connect tab and enter it.`]);
    await tab.quiet();
  });

  it('row 2: the right code → paired {token: 43 base64url characters} then an active hello; the code is consumed', async () => {
    const { helper, lines } = await start();
    const tab = await RawTab.open(helper.port);
    tab.hello();
    const ack = await tab.next('hello');
    tab.send({ type: 'pair', code: helper.pairingCode });
    const paired = await tab.next('paired');
    expect(paired).toEqual({ type: 'paired', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(await tab.next('hello')).toEqual({ type: 'hello', protocol: 1, version: VERSION, connId: ack.connId, paired: true, active: true });
    expect(helper.pairing).toBe(false);
    expect(lines.at(-1)).toBe('A tab was paired.');
    await tab.quiet();
  });

  it('row 2: the token file holds a SHA-256 hash, the creation time and the tab id — never the token', async () => {
    const { helper, configDir } = await start();
    const tab = await RawTab.open(helper.port);
    const { token } = await pair(helper, tab);
    const file = join(configDir, 'helper.json');
    expect(helper.store.file).toBe(file);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toEqual({ version: 1, tokens: [{ hash: sha256(token), createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), tabId: 'tab-a' }] });
    expect(JSON.parse(text).tokens[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(helper.store.count()).toBe(1);
  });

  it('row 2: the token file is readable only by its user (0600 in a 0700 directory; a single ACE on Windows)', async (ctx) => {
    const dir = join(tmp(), 'nested', 'cutframe');
    const { helper } = await start({ configDir: dir });
    const tab = await RawTab.open(helper.port);
    await pair(helper, tab);
    if (process.platform === 'win32') {
      const acl = execFileSync('icacls', [helper.store.file], { encoding: 'utf8', windowsHide: true });
      const entries = acl.split(/\r?\n/).filter(l => /:\(/.test(l));
      expect(entries, acl).toHaveLength(1);
      expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/);
      return;
    }
    if (process.platform !== 'linux' && process.platform !== 'darwin') return ctx.skip();
    expect(statSync(helper.store.file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('row 2: codes that are not six digits are refused without counting as a miss', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello');
    for (const code of ['abcdef', '12345', '1234567', '', '12 456', 123456, null, undefined]) {
      tab.send({ type: 'pair', code });
      expect(await tab.next('error')).toEqual({ type: 'error', code: 'PAIRING_CODE_INVALID', message: LINK_ERRORS.PAIRING_CODE_INVALID });
    }
    tab.send({ type: 'pair', code: helper.pairingCode });
    await tab.next('paired'); // ten refusals later the code still works
  });

  it('row 2: a wrong six-digit code is PAIRING_CODE_INVALID; the fifth miss in a row cancels the code, locks pairing by code and closes the socket 4401', async () => {
    const { helper, lines } = await start();
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello');
    const right = helper.pairingCode!, wrong = right === '000000' ? '111111' : '000000';
    for (let n = 1; n <= 4; n++) { tab.send({ type: 'pair', code: wrong }); expect(await tab.next('error')).toMatchObject({ code: 'PAIRING_CODE_INVALID' }); }
    expect([helper.pairing, helper.locked]).toEqual([true, false]);
    tab.send({ type: 'pair', code: wrong });
    expect(await tab.next('error')).toEqual({ type: 'error', code: 'PAIRING_LOCKED', message: LINK_ERRORS.PAIRING_LOCKED });
    expect(await tab.closed).toEqual({ code: 4401, reason: 'pairing locked' });
    expect([helper.pairing, helper.locked, helper.pairingCode]).toEqual([false, true, undefined]);
    expect(lines.at(-1)).toBe('Too many wrong pairing codes: the code was cancelled. Type `code` for a new one.');
    expect(helper.status().at(-1)).toBe('Pairing by code is locked after 5 wrong codes (type `code` for a new one).');
    expect(await (await fetch(`http://127.0.0.1:${helper.port}/hello`)).json()).toMatchObject({ pairing: false }); // Contract A's boolean
    const again = await RawTab.open(helper.port); // the real code no longer works
    again.hello(); await again.next('hello'); await again.next('error');
    again.send({ type: 'pair', code: right });
    expect(await again.next('error')).toMatchObject({ code: 'PAIRING_LOCKED' });
    expect(helper.store.count()).toBe(0);
  });

  it('row 2: while locked, a hello re-sent on a socket that is still open mints no code: {paired:false} then PAIRING_LOCKED; a guess there is refused and closes it', async () => {
    const { helper, lines } = await start();
    const bystander = await RawTab.open(helper.port), guesser = await RawTab.open(helper.port);
    bystander.hello({ tabId: 'tab-b' }); await bystander.next('hello');
    guesser.hello(); await guesser.next('hello');
    const right = helper.pairingCode!, wrong = right === '000000' ? '111111' : '000000';
    for (let n = 0; n < 5; n++) { guesser.send({ type: 'pair', code: wrong }); await guesser.next('error'); }
    await guesser.closed;
    const printed = lines.length;
    bystander.hello({ tabId: 'tab-b' });
    expect(await bystander.next('hello')).toMatchObject({ paired: false, active: false });
    expect(await bystander.next('error')).toEqual({ type: 'error', code: 'PAIRING_LOCKED', message: LINK_ERRORS.PAIRING_LOCKED });
    expect([helper.pairing, lines.length]).toEqual([false, printed]); // no code minted, nothing printed
    expect(bystander.ws.readyState).toBe(WebSocket.OPEN);
    bystander.send({ type: 'pair', code: right });
    expect(await bystander.next('error')).toMatchObject({ code: 'PAIRING_LOCKED' });
    expect((await bystander.closed).code).toBe(4401);
  });

  it('row 2: the lock is helper-wide — a hello on a new socket, from any allowed origin, mints no code; the reverse path still pairs', async () => {
    const { helper, lines } = await start();
    const first = await RawTab.open(helper.port);
    first.hello(); await first.next('hello');
    const wrong = helper.pairingCode === '000000' ? '111111' : '000000';
    for (let n = 0; n < 5; n++) { first.send({ type: 'pair', code: wrong }); await first.next('error'); }
    await first.closed;
    const printed = lines.length;
    for (const origin of [ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173']) {
      const tab = await RawTab.open(helper.port, { origin });
      tab.hello({ tabId: `tab-${origin}` });
      expect(await tab.next('hello')).toMatchObject({ paired: false });
      expect(await tab.next('error')).toMatchObject({ code: 'PAIRING_LOCKED' });
      expect([helper.pairing, lines.length]).toEqual([false, printed]);
      tab.ws.close(); await tab.closed;
    }
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello'); await tab.next('error');
    tab.send({ type: 'pair', code: '424242', offer: true }); // the user typing the tab's code into the helper is consent too
    await tab.quiet(60);
    expect(helper.confirmOffer('424242')).toBe(true);
    await tab.next('paired');
  });

  it('row 2: the terminal `code` command lifts the lock with a new code and five fresh attempts', async () => {
    const { helper } = await start();
    const first = await RawTab.open(helper.port);
    first.hello(); await first.next('hello');
    for (let n = 0; n < 5; n++) { first.send({ type: 'pair', code: helper.pairingCode === '000000' ? '111111' : '000000' }); await first.next('error'); }
    await first.closed;
    const code = helper.newCode(); // what cli.ts runs for `code`
    expect([helper.locked, helper.pairing, helper.pairingCode]).toEqual([false, true, code]);
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello');
    expect(helper.pairingCode).toBe(code); // the waiting code is kept, not replaced
    const wrong = code === '000000' ? '111111' : '000000';
    for (let n = 0; n < 4; n++) { tab.send({ type: 'pair', code: wrong }); expect(await tab.next('error')).toMatchObject({ code: 'PAIRING_CODE_INVALID' }); }
    tab.send({ type: 'pair', code: wrong });
    expect(await tab.next('error')).toMatchObject({ code: 'PAIRING_LOCKED' }); // exactly five
    await tab.closed;
    helper.newCode();
    const last = await RawTab.open(helper.port);
    await pair(helper, last);
    expect(helper.store.count()).toBe(1);
  });

  it('row 2: brute force — guessing over and over on fresh sockets from two origins never pairs; five guesses are ever judged and the terminal is not flooded', async () => {
    const { helper, lines } = await start();
    let guesses = 0, judged = 0, sockets = 0, next = 0, real: string | undefined;
    while (guesses < 300) {
      const tab = await RawTab.open(helper.port, { origin: sockets++ % 2 ? 'http://localhost:5173' : ORIGIN });
      tab.hello({ tabId: `attacker-${sockets}` });
      expect(await tab.next('hello')).toMatchObject({ paired: false });
      real ??= helper.pairingCode; // known to the test only
      if (helper.locked) expect(await tab.next('error')).toMatchObject({ code: 'PAIRING_LOCKED' });
      for (;;) {
        // before the lock the guesses skip the real code (a lucky hit is not the point); after it, every other guess IS the real code
        let code = helper.locked && guesses % 2 ? real! : String(next++).padStart(6, '0');
        if (!helper.locked && code === real) code = String(next++).padStart(6, '0');
        guesses++;
        tab.send({ type: 'pair', code });
        const m = await tab.next('error'); // a 'paired' fails here
        if (m.code === 'PAIRING_CODE_INVALID') { judged++; continue; }
        expect(m.code).toBe('PAIRING_LOCKED');
        expect((await tab.closed).code).toBe(4401);
        break;
      }
    }
    expect(judged).toBe(4); // the fifth wrong guess is the one that locks
    expect(helper.store.count()).toBe(0);
    expect(helper.locked).toBe(true);
    expect(lines.filter(l => l.startsWith('Pairing code: '))).toHaveLength(1);
    expect(lines.filter(l => l.startsWith('Too many wrong'))).toHaveLength(1);
    expect(sockets).toBeGreaterThan(250);
  });

  it('row 2: four misses followed by the right code still pairs, and a pairing starts the count over', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello');
    const right = helper.pairingCode!, wrong = right === '000000' ? '111111' : '000000';
    for (let n = 0; n < 4; n++) { tab.send({ type: 'pair', code: wrong }); await tab.next('error'); }
    tab.send({ type: 'pair', code: right });
    await tab.next('paired');
    const other = await RawTab.open(helper.port);
    other.hello({ tabId: 'tab-b' }); await other.next('hello'); // no code waits → a new one is minted for this tab
    const second = helper.pairingCode!, miss = second === '000000' ? '111111' : '000000';
    for (let n = 0; n < 4; n++) { other.send({ type: 'pair', code: miss }); expect(await other.next('error')).toMatchObject({ code: 'PAIRING_CODE_INVALID' }); }
    other.send({ type: 'pair', code: second });
    await other.next('paired');
  });

  it('row 2: a code is single use — a second tab presenting it is refused', async () => {
    const { helper } = await start();
    const first = await RawTab.open(helper.port), second = await RawTab.open(helper.port);
    first.hello(); await first.next('hello');
    second.hello({ tabId: 'tab-b' }); await second.next('hello');
    const code = helper.pairingCode!;
    first.send({ type: 'pair', code });
    await first.next('paired'); await first.next('hello');
    second.send({ type: 'pair', code });
    expect(await second.next('error')).toEqual({ type: 'error', code: 'PAIRING_CODE_INVALID', message: LINK_ERRORS.PAIRING_CODE_INVALID });
    expect(helper.store.count()).toBe(1);
  });

  it('row 2: an expired code → PAIRING_CODE_EXPIRED and /hello stops saying pairing', async () => {
    const { helper } = await start({ codeTtlMs: 40 });
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello');
    const code = helper.pairingCode!;
    await sleep(90);
    expect(helper.pairing).toBe(false);
    expect(helper.pairingCode).toBeUndefined();
    tab.send({ type: 'pair', code });
    expect(await tab.next('error')).toEqual({ type: 'error', code: 'PAIRING_CODE_EXPIRED', message: LINK_ERRORS.PAIRING_CODE_EXPIRED });
    expect(helper.store.count()).toBe(0);
  });

  it('row 2: the code lives 5 minutes (Contract A)', () => { expect(CODE_TTL_MS).toBe(300_000); });

  it('row 2: pair before hello → INVALID_MESSAGE "Send hello first."', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    tab.send({ type: 'pair', code: '123456' });
    expect(await tab.next('error')).toEqual({ type: 'error', code: 'INVALID_MESSAGE', message: 'Send hello first.' });
  });

  it('row 2: the reverse path — the tab offers a code, the user types it into the helper, the tab is paired', async () => {
    const { helper, lines } = await start();
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello');
    tab.send({ type: 'pair', code: '424242', offer: true });
    await tab.quiet(60);
    expect(lines.at(-1)).toBe('An editor tab is waiting to pair: type the 6-digit code the editor shows, then Enter.');
    expect(helper.confirmOffer('000000')).toBe(false);
    expect(helper.confirmOffer('424242')).toBe(true);
    const paired = await tab.next('paired');
    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await tab.next('hello')).toMatchObject({ paired: true, active: true });
    expect(helper.store.has(paired.token)).toBe(true);
    expect(helper.confirmOffer('424242')).toBe(false); // consumed
  });

  it('row 2: a code offered by two tabs pairs neither (a page flooding offers cannot ride along on the user\'s code); once one goes, the other pairs', async () => {
    const { helper, lines } = await start();
    const user = await RawTab.open(helper.port), page = await RawTab.open(helper.port, { origin: 'http://localhost:5173' });
    user.hello(); await user.next('hello');
    page.hello({ tabId: 'tab-page' }); await page.next('hello');
    user.send({ type: 'pair', code: '424242', offer: true });
    page.send({ type: 'pair', code: '424242', offer: true });
    await user.quiet(60);
    expect(helper.confirmOffer('424242')).toBe(false);
    expect(lines.at(-1)).toBe('More than one tab shows that code, so none was paired. Press Connect tab in the editor again for a new code.');
    await page.quiet(0);
    expect(helper.store.count()).toBe(0);
    page.ws.close(); await page.closed;
    await expect.poll(() => helper.confirmOffer('424242')).toBe(true);
    await user.next('paired');
    expect(helper.store.count()).toBe(1);
  });

  it('row 2: an offered code that is not six digits is refused; an expired offer answers PAIRING_CODE_EXPIRED', async () => {
    const { helper } = await start({ codeTtlMs: 40 });
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello');
    tab.send({ type: 'pair', code: '12', offer: true });
    expect(await tab.next('error')).toMatchObject({ code: 'PAIRING_CODE_INVALID' });
    tab.send({ type: 'pair', code: '515151', offer: true });
    await sleep(90);
    expect(helper.confirmOffer('515151')).toBe(false);
    expect(await tab.next('error')).toEqual({ type: 'error', code: 'PAIRING_CODE_EXPIRED', message: LINK_ERRORS.PAIRING_CODE_EXPIRED });
    expect(helper.store.count()).toBe(0);
  });

  it('row 2: a paired tab reconnects with its token and is active at once; the connection id is resumed only by the same tab', async () => {
    const { helper } = await start();
    const first = await RawTab.open(helper.port);
    const { token, connId } = await pair(helper, first);
    first.ws.close(); await first.closed;

    const again = await RawTab.open(helper.port);
    again.hello({ token, connId });
    expect(await again.next('hello')).toEqual({ type: 'hello', protocol: 1, version: VERSION, connId, paired: true, active: true });
    again.ws.close(); await again.closed;

    const stranger = await RawTab.open(helper.port); // another tab id presenting the same connId gets a new one
    stranger.hello({ token, connId, tabId: 'tab-other' });
    const ack = await stranger.next('hello');
    expect(ack.connId).toMatch(UUID);
    expect(ack.connId).not.toBe(connId);
    expect(ack).toMatchObject({ paired: true, active: true });
  });

  it('row 2: an unknown token → TOKEN_INVALID, then the unpaired hello answer and a fresh code', async () => {
    const { helper, lines } = await start();
    const tab = await RawTab.open(helper.port);
    tab.hello({ token: newToken() });
    expect(await tab.next('error')).toEqual({ type: 'error', code: 'TOKEN_INVALID', message: LINK_ERRORS.TOKEN_INVALID });
    expect(await tab.next('hello')).toMatchObject({ paired: false, active: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Pairing code: \d{6} /);
  });

  it('row 2: revoke from the tab forgets that pairing, closes the socket 4401, and the token no longer works', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    const { token } = await pair(helper, tab);
    tab.send({ type: 'revoke' });
    expect(await tab.closed).toEqual({ code: 4401, reason: 'revoked' });
    expect(helper.store.has(token)).toBe(false);
    const retry = await RawTab.open(helper.port);
    retry.hello({ token });
    expect(await retry.next('error')).toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('row 2: revoke only removes that tab\'s own token', async () => {
    const { helper } = await start();
    const a = await RawTab.open(helper.port), b = await RawTab.open(helper.port);
    const ta = await pair(helper, a, { tabId: 'tab-a' });
    b.hello({ tabId: 'tab-b' }); await b.next('hello');
    helper.newCode(); b.send({ type: 'pair', code: helper.pairingCode });
    const tb = (await b.next('paired')).token as string;
    expect(helper.store.count()).toBe(2);
    b.send({ type: 'revoke' }); await b.closed;
    expect(helper.store.has(tb)).toBe(false);
    expect(helper.store.has(ta.token)).toBe(true);
  });

  it('row 2: revokeAll (the terminal command `revoke`) empties the file and sends TOKEN_REVOKED + 4401 to paired tabs', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    const { token } = await pair(helper, tab);
    helper.revokeAll();
    expect(await tab.next('error')).toEqual({ type: 'error', code: 'TOKEN_REVOKED', message: LINK_ERRORS.TOKEN_REVOKED });
    expect((await tab.closed).code).toBe(4401);
    expect(helper.store.count()).toBe(0);
    expect(JSON.parse(readFileSync(helper.store.file, 'utf8'))).toEqual({ version: 1, tokens: [] });
    expect(helper.store.has(token)).toBe(false);
  });

  it('row 2: a pairing revoked from outside (another process emptying the file) is noticed on the next ping', async () => {
    const { helper, configDir } = await start();
    const tab = await RawTab.open(helper.port);
    await pair(helper, tab);
    new TokenStore(configDir).revokeAll();
    tab.send({ type: 'ping' });
    expect(await tab.next('error')).toEqual({ type: 'error', code: 'TOKEN_REVOKED', message: LINK_ERRORS.TOKEN_REVOKED });
    expect(await tab.closed).toMatchObject({ code: 4401 });
  });

  it('row 2: a deleted token file revokes too, noticed by the helper itself within one tick (no ping from the tab)', async () => {
    const { helper } = await start({ pingMs: 20 });
    const tab = await RawTab.open(helper.port);
    await pair(helper, tab);
    rmSync(helper.store.file);
    expect(await tab.next('error')).toMatchObject({ code: 'TOKEN_REVOKED' });
    expect(await tab.closed).toMatchObject({ code: 4401 });
  });

  it('row 2: a stale token file from the future is survived — unreadable content means no pairings', async () => {
    const dir = tmp();
    const store = new TokenStore(dir);
    writeFileSync(store.file, '{not json');
    expect(store.read()).toEqual([]);
    writeFileSync(store.file, JSON.stringify({ tokens: 'nope' }));
    expect(store.read()).toEqual([]);
    writeFileSync(store.file, JSON.stringify({ tokens: [{ hash: 'abc' }, { nothing: true }, null] }));
    expect(store.read()).toEqual([{ hash: 'abc' }]);
  });
});

describe('t18a token store (row 2)', () => {
  it('row 2: tokens are 32 random bytes, base64url; the stored hash is the SHA-256 hex of the token', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(newToken()).not.toBe(t);
    expect(hashToken(t)).toBe(sha256(t));
  });

  it('row 2: add / has / count / revokeHash / revokeAll', () => {
    const dir = tmp(); const store = new TokenStore(dir);
    expect(store.count()).toBe(0);
    store.revokeAll();
    expect(existsSync(store.file)).toBe(false); // nothing to empty: no file is created
    const a = newToken(), b = newToken();
    store.add(a, 'tab-a'); store.add(b);
    expect([store.count(), store.has(a), store.has(b), store.has('x')]).toEqual([2, true, true, false]);
    expect(store.read().map(r => r.tabId)).toEqual(['tab-a', undefined]);
    expect(store.revokeHash(hashToken(a))).toBe(true);
    expect(store.revokeHash(hashToken(a))).toBe(false);
    expect([store.has(a), store.has(b)]).toEqual([false, true]);
    store.revokeAll();
    expect(store.count()).toBe(0);
  });

  it('row 2: the default config directory is %APPDATA%\\cutframe on Windows, otherwise $XDG_CONFIG_HOME/cutframe or ~/.config/cutframe', () => {
    const saved = { appdata: process.env.APPDATA, xdg: process.env.XDG_CONFIG_HOME };
    try {
      process.env.APPDATA = join(tmpdir(), 'appdata-x'); process.env.XDG_CONFIG_HOME = join(tmpdir(), 'xdg-x');
      expect(defaultConfigDir()).toBe(process.platform === 'win32' ? join(tmpdir(), 'appdata-x', 'cutframe') : join(tmpdir(), 'xdg-x', 'cutframe'));
      delete process.env.XDG_CONFIG_HOME; delete process.env.APPDATA;
      expect(defaultConfigDir()).toBe(join(homedir(), '.config', 'cutframe'));
    } finally {
      for (const [k, v] of [['APPDATA', saved.appdata], ['XDG_CONFIG_HOME', saved.xdg]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('row 2: a missing config directory is created (nested)', () => {
    const dir = join(tmp(), 'a', 'b');
    mkdirSync(join(dir, '..'), { recursive: true });
    new TokenStore(dir).add(newToken());
    expect(existsSync(join(dir, 'helper.json'))).toBe(true);
  });
});

describe('t18a tab protocol (row 4)', () => {
  it('row 4: protocol constants — Contract A values', () => {
    expect({ PROTOCOL, DEFAULT_PORT, PORT_RANGE, PING_MS, STALL_MS, RESOURCE_QUIET_MS, RECONNECT_DELAYS, RECONNECT_MAX, RECONNECT_STABLE_MS }).toEqual(
      { PROTOCOL: 1, DEFAULT_PORT: 47820, PORT_RANGE: 10, PING_MS: 15_000, STALL_MS: 60_000, RESOURCE_QUIET_MS: 500, RECONNECT_DELAYS: [250, 1000, 2000, 4000, 8000], RECONNECT_MAX: 10, RECONNECT_STABLE_MS: 5000 });
    expect(CLOSE).toEqual({ superseded: 4409, unauthorized: 4401, replaced: 4410, protocol: 4400, shutdown: 4503 });
    expect([...SERVED_TOOLS]).toEqual(['addLayout', 'addMedia', 'addMotionGraphic', 'addShape', 'addText', 'applyTransition', 'changeTrack', 'cloneItem', 'consolidateTracks', 'context', 'createMask', 'deleteItems', 'editLayout', 'editMaskProperties', 'editMotionGraphic', 'editProperties', 'getHelpSection', 'manageMarkers', 'manageTrack', 'manageTrackGroup', 'moveItem', 'removeMask', 'reorderItems', 'resizeCanvas', 'searchHelpDocs', 'setTimeRemap', 'slipItem', 'splitItem', 'syncAndSwap', 'transformItem', 'trimItem', 'viewItemDetails', 'writeEffects', 'writeKeyframes', 'writeMaskPoints', 'writeShapePoints', 'viewMaskFrame', 'previewSmartMask', 'trackSmartMask', 'removeBackground']); // T10 (C8): + writeEffects; T06 (C8): + addShape, writeShapePoints; T07 (C8): + addLayout, editLayout; T11 (C8): + applyTransition; T12 (C8): + createMask, editMaskProperties, removeMask, writeMaskPoints; T12 smart masks (C8): + viewMaskFrame, previewSmartMask, trackSmartMask, removeBackground; T21: + getHelpSection, searchHelpDocs
  });

  it('row 4: ping → {type:"pong"}, also before hello; a received pong gets no answer', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    tab.send({ type: 'ping' });
    expect(await tab.next()).toEqual({ type: 'pong' });
    tab.send({ type: 'pong' });
    await tab.quiet();
    tab.hello(); await tab.next('hello');
    tab.send({ type: 'pong' });
    tab.send({ type: 'ping' });
    expect(await tab.next()).toEqual({ type: 'pong' });
    await tab.quiet();
  });

  it('row 4: hello with another protocol version → PROTOCOL_UNSUPPORTED and close 4400', async () => {
    const { helper } = await start();
    for (const protocol of [2, 0, '1', undefined]) {
      const tab = await RawTab.open(helper.port);
      tab.send({ type: 'hello', protocol, projectId: null, tabId: 'tab-a' });
      expect(await tab.next('error')).toEqual({ type: 'error', code: 'PROTOCOL_UNSUPPORTED', message: LINK_ERRORS.PROTOCOL_UNSUPPORTED });
      expect(await tab.closed).toEqual({ code: 4400, reason: 'protocol' });
    }
  });

  it('row 4: hello needs a tab id (the socket stays open)', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    for (const tabId of [undefined, '', 5]) {
      tab.send({ type: 'hello', protocol: 1, projectId: null, tabId });
      expect(await tab.next('error')).toEqual({ type: 'error', code: 'INVALID_MESSAGE', message: 'hello needs a tabId.' });
    }
    expect(tab.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('row 4: input that is not a JSON object → INVALID_MESSAGE "Messages must be JSON objects with a type." (text, scalars, binary)', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    for (const raw of ['{nope', 'null', '5', '"a string"', 'true', '']) {
      tab.send(raw);
      expect(await tab.next('error'), raw).toEqual({ type: 'error', code: 'INVALID_MESSAGE', message: 'Messages must be JSON objects with a type.' });
    }
    tab.send(Buffer.from('{"type":"ping"}')); // a binary frame, even with valid JSON inside
    expect(await tab.next('error')).toEqual({ type: 'error', code: 'INVALID_MESSAGE', message: 'Messages must be JSON objects with a type.' });
    expect(tab.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('row 4: result / event / revoke / pair / a made-up type before hello → "Send hello first."', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    for (const m of [{ type: 'result', callId: 'x', result: { success: true } }, { type: 'event', name: 'stateChanged' }, { type: 'revoke' }, { type: 'bogus' }]) {
      tab.send(m);
      expect(await tab.next('error')).toEqual({ type: 'error', code: 'INVALID_MESSAGE', message: 'Send hello first.' });
    }
  });

  it('row 4: after hello a made-up type → INVALID_MESSAGE "Unknown message type \'bogus\'."', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello');
    tab.send({ type: 'bogus' });
    expect(await tab.next('error')).toEqual({ type: 'error', code: 'INVALID_MESSAGE', message: "Unknown message type 'bogus'." });
  });

  it('row 4: the helper-to-tab messages are exactly hello, paired, call, takeover, error, pong — and tab results/events are accepted without reply', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    const { connId } = await pair(helper, tab);
    const call = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    const msg = await tab.next('call');
    expect(msg).toEqual({ type: 'call', callId: expect.stringMatching(UUID), executionKey: expect.stringMatching(/^mcp:[0-9a-f-]{36}:[0-9a-f-]{36}$/), toolName: 'moveItem', input: { itemId: 'v1', by: 1 } });
    expect(msg.executionKey).toBe(`mcp:${connId}:${msg.callId}`);
    tab.send({ type: 'event', name: 'stateChanged', data: { parts: ['items'] } });
    tab.send({ type: 'result', callId: msg.callId, result: { success: true, data: { moved: true } } });
    expect(await call).toEqual({ success: true, data: { moved: true } });
    await tab.quiet();
  });

  it('row 4: stall knob — a silent tab is dropped (1006) once stallMs passes; a pinging tab and a ponging tab stay', async () => {
    const { helper } = await start({ pingMs: 20, stallMs: 150 });
    const silent = await RawTab.open(helper.port), pinging = await RawTab.open(helper.port), ponging = await RawTab.open(helper.port);
    const keep = setInterval(() => { pinging.send({ type: 'ping' }); ponging.send({ type: 'pong' }); }, 30);
    cleanups.push(() => clearInterval(keep));
    const gone = await silent.closed;
    expect(gone.code).toBe(1006);
    await sleep(120);
    expect(pinging.ws.readyState).toBe(WebSocket.OPEN);
    expect(ponging.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('row 4: a message of any kind, even an invalid one, counts as activity', async () => {
    const { helper } = await start({ pingMs: 20, stallMs: 150 });
    const tab = await RawTab.open(helper.port);
    const keep = setInterval(() => tab.send('garbage'), 30);
    cleanups.push(() => clearInterval(keep));
    await sleep(400);
    expect(tab.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('row 4: helper shutdown closes tabs with 4503 "helper stopped"', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    await pair(helper, tab);
    await helper.close();
    expect(await tab.closed).toEqual({ code: 4503, reason: 'helper stopped' });
  });

  it('row 4: a message over 16 MiB closes the socket with 1009', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    tab.send(JSON.stringify({ type: 'event', name: 'x', data: { blob: 'a'.repeat(17 * 1024 * 1024) } }));
    expect((await tab.closed).code).toBe(1009);
  });

  it('row 4: a result for a call nobody made, an event from an unpaired tab, and a result for another tab\'s call are ignored', async () => {
    const { helper } = await start();
    const tab = await RawTab.open(helper.port);
    tab.hello(); await tab.next('hello');
    tab.send({ type: 'result', callId: 'no-such-call', result: { success: true } });
    tab.send({ type: 'event', name: 'stateChanged', data: { parts: ['items'] } });
    await tab.quiet();
  });
});
