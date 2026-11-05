// SPDX-License-Identifier: AGPL-3.0-only
// T19 C9 acceptance: the auto title (cleanTitle, generateTitle, titleRequest, autoTitle, watchTitle). Fake IndexedDB,
// MockProvider / NoProvider from parity/provider.ts, a hand-rolled timer object for the polling. Synthetic rows only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TITLE, ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { TITLE_MAX, TITLE_POLL_MS, autoTitle, cleanTitle, generateTitle, setTitleProvider, titleRequest, watchTitle } from '../apps/web/src/analysis/title';
import type { TitleProvider } from '../apps/web/src/analysis/title';
import { MockProvider, NoProvider } from '../parity/provider';
import type { ProviderEvent } from '../parity/provider';

const opened: ProjectStore[] = [];
let tick = Date.parse('2026-11-02T00:00:00Z');
function setup() {
  const media: MediaStore = { write: vi.fn(async () => {}), read: vi.fn(async () => new Blob()), remove: vi.fn(async () => {}) };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return store;
}
afterEach(async () => { vi.restoreAllMocks(); setTitleProvider(undefined); for (const s of opened.splice(0)) await s.close(); });

type Status = Asset['processing_status'];
const asset = (id: string, type: Asset['type'] = 'video', status: Status = 'ready'): Asset => ({ id, name: `${id}.mp4`, type, sizeBytes: 1, mimeType: 'video/mp4', folderId: null, created_at: '2026-11-02T00:00:00.000Z', recorded_at: null, location: null, durationMs: 1000, processing_status: status, processing_steps: { upload: 'complete' } });
/** Adds an asset (ready unless `status` says otherwise) to the library and links it to the project, optionally with an
 *  analyses row carrying `summary`. */
async function add(store: ProjectStore, projectId: string, id: string, summary?: string, type: Asset['type'] = 'video', status: Status = 'ready') {
  await store.putRow('assets', asset(id, type, status)); await store.attach(projectId, id);
  if (summary !== undefined) await summary_(store, id, summary);
}
const summary_ = (store: ProjectStore, id: string, summary: string) => store.putRow('analyses', { id, analysis: { summary }, created_at: '2026-11-02T00:00:00.000Z' });
const mock = (text = 'Fixture Title') => new MockProvider([{ type: 'text', text }]);
const state = async (store: ProjectStore, id: string) => { const r = await store.row<{ title: string; title_source?: string }>('projects', id); return { title: r?.title, source: r?.title_source }; };
/** A provider whose stream throws after a text event. */
const throwing = (): TitleProvider & { calls: number } => ({ calls: 0, async *stream() { this.calls++; yield { type: 'text', text: 'partial' }; throw new Error('model down'); } });
/** A provider that waits for `gate` before answering. */
const gated = (gate: Promise<void>, text = 'Late Title'): TitleProvider & { calls: number } => ({ calls: 0, async *stream() { this.calls++; await gate; yield { type: 'text', text }; } });

describe('T19 C9 cleanTitle', () => {
  it.each<[string, string, string]>([
    ['first non-empty line', '\n  \n  Trip to Bali \nsecond line', 'Trip to Bali'],
    ['"Title:" label (any case)', 'Title: Sunset Cut', 'Sunset Cut'],
    ['TITLE label, extra space', 'TITLE:   Sunset Cut', 'Sunset Cut'],
    ['straight double quotes', '"Summer Reel"', 'Summer Reel'],
    ['straight single quotes', "'Summer Reel'", 'Summer Reel'],
    ['curly quotes', '“Summer Reel”', 'Summer Reel'],
    ['curly single quotes', '‘Summer Reel’', 'Summer Reel'],
    ['label then quotes', 'Title: "Summer Reel"', 'Summer Reel'],
    ['whitespace collapsed', '  Summer \t  Reel   Day  ', 'Summer Reel Day'],
    ['empty', '', ''],
    ['only blank lines', '\n \n\t\n', ''],
  ])('%s', (_name, input, expected) => { expect(cleanTitle(input)).toBe(expected); });
  it('cuts to TITLE_MAX characters (100) and trims what is left', () => {
    expect(TITLE_MAX).toBe(100);
    expect(cleanTitle('a'.repeat(250))).toBe('a'.repeat(100));
    expect(cleanTitle(`${'a'.repeat(99)} bbbbbb`)).toBe('a'.repeat(99));
    expect(cleanTitle('b'.repeat(100)).length).toBe(100);
  });
});

describe('T19 C9 generateTitle', () => {
  it('sends one user message "<prompt>\\n<request json>" with purpose project-title and joins the text events', async () => {
    const provider = new MockProvider([{ type: 'text', text: 'Beach ' }, { type: 'tool', id: 't', name: 'x', input: {} }, { type: 'text', text: 'Day' }]);
    const request = { message: '', assets: [{ name: 'a', type: 'video' as const }] };
    expect(await generateTitle(provider, request)).toBe('Beach Day');
    expect(provider.requests).toHaveLength(1);
    const [sent] = provider.requests; expect(sent.purpose).toBe('project-title');
    const [message] = sent.messages as { role: string; content: string }[]; expect(sent.messages).toHaveLength(1); expect(message.role).toBe('user');
    const newline = message.content.indexOf('\n');
    expect(message.content.slice(0, newline)).toMatch(/title/i);
    expect(JSON.parse(message.content.slice(newline + 1))).toEqual(request);
  });
  it('returns null for an empty or whitespace answer, no text events, and a failing stream', async () => {
    expect(await generateTitle(mock(''), { message: '', assets: [] })).toBeNull();
    expect(await generateTitle(mock(' \n '), { message: '', assets: [] })).toBeNull();
    expect(await generateTitle(new MockProvider([]), { message: '', assets: [] })).toBeNull();
    expect(await generateTitle(new NoProvider(), { message: '', assets: [] })).toBeNull();
    expect(await generateTitle(throwing(), { message: '', assets: [] })).toBeNull();
  });
  it('cleans the answer', async () => { expect(await generateTitle(mock('Title: “Road Trip”\nextra'), { message: '', assets: [] })).toBe('Road Trip'); });
  it('passes the signal on; an aborted signal makes the mock throw → null', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await generateTitle(mock(), { message: '', assets: [] }, controller.signal)).toBeNull();
  });
});

describe('T19 C9 titleRequest', () => {
  it('lists the linked assets in added_at order, each by its analysis summary (trimmed) or else its file name', async () => {
    const store = setup(), project = await store.create();
    await add(store, project.id, 'b', '  Beach at dusk  '); await add(store, project.id, 'a'); await add(store, project.id, 'c', 'Night market', 'image');
    expect(await titleRequest(store, project.id)).toEqual({
      request: { message: '', assets: [{ name: 'Beach at dusk', type: 'video' }, { name: 'a.mp4', type: 'video' }, { name: 'Night market', type: 'image' }] },
      summaries: 2, pending: false,
    });
  });
  it('pending: some linked asset is still uploading or processing (failed and ready ones are settled; detached ones do not count)', async () => {
    const store = setup(), project = await store.create();
    await add(store, project.id, 'done'); await add(store, project.id, 'broken', undefined, 'video', 'failed');
    expect((await titleRequest(store, project.id)).pending).toBe(false);
    await add(store, project.id, 'gone', undefined, 'video', 'processing'); await store.detach(project.id, 'gone');
    expect((await titleRequest(store, project.id)).pending).toBe(false);
    for (const status of ['uploading', 'processing'] as const) {
      const other = await store.create(); await add(store, other.id, `busy-${status}`, undefined, 'video', status);
      expect((await titleRequest(store, other.id)).pending).toBe(true);
    }
  });
  it('a blank summary counts as none; detached links and other projects\' links are excluded', async () => {
    const store = setup(), project = await store.create(), other = await store.create();
    await add(store, project.id, 'kept', 'Kept'); await add(store, project.id, 'blank', '   '); await add(store, project.id, 'gone', 'Gone');
    await add(store, other.id, 'elsewhere', 'Elsewhere'); await store.detach(project.id, 'gone');
    const { request, summaries } = await titleRequest(store, project.id);
    expect(request.assets).toEqual([{ name: 'Kept', type: 'video' }, { name: 'blank.mp4', type: 'video' }]); expect(summaries).toBe(1);
  });
  it('an empty project gives an empty list and 0 summaries', async () => {
    const store = setup(), project = await store.create();
    expect(await titleRequest(store, project.id)).toEqual({ request: { message: '', assets: [] }, summaries: 0, pending: false });
  });
});

describe('T19 C9 autoTitle', () => {
  it('row 1: three summarised assets → titled; one request (purpose project-title) with the exact JSON; generated source', async () => {
    const store = setup(), project = await store.create(), provider = mock('Fixture Title');
    await add(store, project.id, 'v1', 'Waves on the shore'); await add(store, project.id, 'v2', 'A crowded market'); await add(store, project.id, 'v3', 'Sunset from a hill', 'image');
    expect(await autoTitle(store, project.id, { provider })).toBe('titled');
    expect(await state(store, project.id)).toEqual({ title: 'Fixture Title', source: 'generated' });
    expect(provider.requests).toHaveLength(1); expect(provider.requests[0].purpose).toBe('project-title');
    const [message] = provider.requests[0].messages as { role: string; content: string }[];
    expect(JSON.parse(message.content.slice(message.content.indexOf('\n') + 1))).toEqual({ message: '', assets: [
      { name: 'Waves on the shore', type: 'video' }, { name: 'A crowded market', type: 'video' }, { name: 'Sunset from a hill', type: 'image' }] });
  });
  it('row 2: a failing model → failed; title stays "Untitled Project", source default', async () => {
    for (const provider of [throwing(), new NoProvider(), mock(''), new MockProvider([])]) {
      const store = setup(), project = await store.create(); await add(store, project.id, 'v1', 'Something');
      expect(await autoTitle(store, project.id, { provider })).toBe('failed');
      expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' });
    }
  });
  it('row 2: no provider → no-provider; nothing read or written', async () => {
    const store = setup(), project = await store.create(); await add(store, project.id, 'v1', 'Something');
    const row = vi.spyOn(store, 'row'), library = vi.spyOn(store, 'library'), set = vi.spyOn(store, 'setGeneratedTitle');
    expect(await autoTitle(store, project.id)).toBe('no-provider'); expect(await autoTitle(store, project.id, { provider: undefined, parity: true })).toBe('no-provider');
    expect(row).not.toHaveBeenCalled(); expect(library).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' });
  });
  it('row 3: a renamed project is never retitled (kept, 0 requests), in both modes; so is a project created with a name', async () => {
    const store = setup(), renamed = await store.create(), named = await store.create('My Own Name'), provider = mock();
    await add(store, renamed.id, 'v1', 'Summary'); await add(store, named.id, 'v2', 'Summary');
    await store.renameProject(renamed.id, 'Renamed By Me');
    expect(await state(store, renamed.id)).toEqual({ title: 'Renamed By Me', source: 'user' });
    for (const parity of [false, true]) {
      expect(await autoTitle(store, renamed.id, { provider, parity })).toBe('kept'); expect(await autoTitle(store, named.id, { provider, parity })).toBe('kept');
    }
    expect(provider.requests).toHaveLength(0);
    expect(await state(store, renamed.id)).toEqual({ title: 'Renamed By Me', source: 'user' }); expect(await state(store, named.id)).toEqual({ title: 'My Own Name', source: 'user' });
  });
  it('row 3: a user who renames to "Untitled Project" (source user) is not retitled either', async () => {
    const store = setup(), project = await store.create(), provider = mock();
    await store.renameProject(project.id, 'Other'); await store.renameProject(project.id, DEFAULT_TITLE); await add(store, project.id, 'v1', 'Summary');
    expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'user' });
    expect(await autoTitle(store, project.id, { provider })).toBe('kept'); expect(provider.requests).toHaveLength(0);
  });
  it('row 3: an unknown project is kept without a request', async () => {
    const store = setup(), provider = mock();
    expect(await autoTitle(store, 'missing', { provider })).toBe('kept'); expect(provider.requests).toHaveLength(0);
  });
  it('row 3: a rename during the model call wins — kept, the user title stays, the generated one is dropped', async () => {
    const store = setup(), project = await store.create(); await add(store, project.id, 'v1', 'Summary');
    let open!: () => void; const provider = gated(new Promise<void>(r => { open = r; }));
    const outcome = autoTitle(store, project.id, { provider });
    await vi.waitFor(() => expect(provider.calls).toBe(1));
    await store.renameProject(project.id, 'Typed While Waiting'); open();
    expect(await outcome).toBe('kept');
    expect(await state(store, project.id)).toEqual({ title: 'Typed While Waiting', source: 'user' });
  });
  it('row 3: setGeneratedTitle itself refuses once the title is not the default', async () => {
    const store = setup(), project = await store.create();
    expect(await store.setGeneratedTitle(project.id, 'First')).toBe(true); expect(await store.setGeneratedTitle(project.id, 'Second')).toBe(false);
    expect(await state(store, project.id)).toEqual({ title: 'First', source: 'generated' });
  });
  it('an aborted signal → kept, nothing written', async () => {
    const store = setup(), project = await store.create(); await add(store, project.id, 'v1', 'Summary');
    const controller = new AbortController(); let open!: () => void; const provider = gated(new Promise<void>(r => { open = r; }));
    const outcome = autoTitle(store, project.id, { provider, signal: controller.signal });
    await vi.waitFor(() => expect(provider.calls).toBe(1)); controller.abort(); open();
    expect(await outcome).toBe('kept'); expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' });
  });
  it('row 4: default mode waits while no linked asset has a summary and one is still being prepared (0 requests); deleted links do not count', async () => {
    const store = setup(), project = await store.create(), provider = mock();
    await add(store, project.id, 'v1', undefined, 'video', 'processing'); await add(store, project.id, 'v2', undefined, 'video', 'uploading'); await add(store, project.id, 'v0');
    expect(await autoTitle(store, project.id, { provider })).toBe('waiting');
    await summary_(store, 'v3', 'Only on a detached asset'); await store.putRow('assets', asset('v3')); await store.attach(project.id, 'v3'); await store.detach(project.id, 'v3');
    expect(await autoTitle(store, project.id, { provider })).toBe('waiting');
    expect(provider.requests).toHaveLength(0); expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' });
  });
  it('review 4: an empty project → empty (no request) in default mode', async () => {
    const store = setup(), project = await store.create(), provider = mock();
    expect(await autoTitle(store, project.id, { provider })).toBe('empty');
    await store.putRow('assets', asset('gone')); await store.attach(project.id, 'gone'); await store.detach(project.id, 'gone');
    expect(await autoTitle(store, project.id, { provider })).toBe('empty');
    expect(provider.requests).toHaveLength(0); expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' });
  });
  it('review 4 (Q12): an audio-only project — every asset settled with no summary — asks once with the file names (Xapp\'s fallback)', async () => {
    const store = setup(), project = await store.create(), provider = mock('Podcast Cut');
    await add(store, project.id, 'talk', undefined, 'audio'); await add(store, project.id, 'music', undefined, 'audio');
    expect(await autoTitle(store, project.id, { provider })).toBe('titled');
    const [message] = provider.requests[0].messages as { content: string }[];
    expect(JSON.parse(message.content.slice(message.content.indexOf('\n') + 1))).toEqual({ message: '', assets: [{ name: 'talk.mp4', type: 'audio' }, { name: 'music.mp4', type: 'audio' }] });
    expect(await state(store, project.id)).toEqual({ title: 'Podcast Cut', source: 'generated' }); expect(provider.requests).toHaveLength(1);
  });
  it('review 4 (Q12): vision unavailable (C12) — a ready video with no summary and a failed asset are settled → asks with the file names', async () => {
    const store = setup(), project = await store.create(), provider = mock('No Vision');
    await store.putRow('assets', { ...asset('clip'), processing_steps: { upload: 'complete', analysis: 'unavailable' } }); await store.attach(project.id, 'clip');
    await add(store, project.id, 'broken', undefined, 'image', 'failed');
    expect(await autoTitle(store, project.id, { provider })).toBe('titled');
    const [message] = provider.requests[0].messages as { content: string }[];
    expect(JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)).assets).toEqual([{ name: 'clip.mp4', type: 'video' }, { name: 'broken.mp4', type: 'image' }]);
  });
  it('row 4: a summary-less asset is sent by file name once another asset has a summary; detached assets are not sent', async () => {
    const store = setup(), project = await store.create(), provider = mock('Mixed');
    await add(store, project.id, 'plain'); await add(store, project.id, 'smart', 'A summary'); await add(store, project.id, 'gone', 'Detached summary'); await store.detach(project.id, 'gone');
    expect(await autoTitle(store, project.id, { provider })).toBe('titled');
    const [message] = provider.requests[0].messages as { content: string }[];
    expect(JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)).assets).toEqual([{ name: 'plain.mp4', type: 'video' }, { name: 'A summary', type: 'video' }]);
  });
  it('a project whose processing_status is not ready waits', async () => {
    const store = setup(), project = await store.create(), provider = mock(); await add(store, project.id, 'v1', 'Summary');
    await store.putRow('projects', { ...(await store.row<Record<string, unknown>>('projects', project.id)), processing_status: 'processing' });
    expect(await autoTitle(store, project.id, { provider })).toBe('waiting'); expect(provider.requests).toHaveLength(0);
  });
  it('row 5: parity mode asks without summaries — assets by file name, or an empty list for an empty project', async () => {
    const store = setup(), empty = await store.create(), filled = await store.create(), a = mock('Empty One'), b = mock('Named One');
    expect(await autoTitle(store, empty.id, { provider: a, parity: true })).toBe('titled');
    await add(store, filled.id, 'x'); await add(store, filled.id, 'y', undefined, 'audio');
    expect(await autoTitle(store, filled.id, { provider: b, parity: true })).toBe('titled');
    const body = (p: MockProvider) => { const [m] = p.requests[0].messages as { content: string }[]; return JSON.parse(m.content.slice(m.content.indexOf('\n') + 1)); };
    expect(body(a)).toEqual({ message: '', assets: [] }); expect(body(b)).toEqual({ message: '', assets: [{ name: 'x.mp4', type: 'video' }, { name: 'y.mp4', type: 'audio' }] });
    expect(await state(store, empty.id)).toEqual({ title: 'Empty One', source: 'generated' }); expect(await state(store, filled.id)).toEqual({ title: 'Named One', source: 'generated' });
  });
  it('row 6: the stored title is the cleaned answer; an empty answer → failed, default kept', async () => {
    const store = setup(), project = await store.create(); await add(store, project.id, 'v1', 'S');
    expect(await autoTitle(store, project.id, { provider: mock('Title: "  Spring   Clean  "\nignored') })).toBe('titled');
    expect(await state(store, project.id)).toEqual({ title: 'Spring Clean', source: 'generated' });
    const second = await store.create(); await add(store, second.id, 'v2', 'S');
    expect(await autoTitle(store, second.id, { provider: mock(' \n "" ') })).toBe('failed');
    expect(await state(store, second.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' });
  });
  it('row 6: a long answer is stored cut to 100 characters', async () => {
    const store = setup(), project = await store.create(); await add(store, project.id, 'v1', 'S');
    expect(await autoTitle(store, project.id, { provider: mock('word '.repeat(60)) })).toBe('titled');
    const { title } = await state(store, project.id); expect(title!.length).toBeLessThanOrEqual(TITLE_MAX); expect(title!.startsWith('word word')).toBe(true);
  });
  it('a title already generated is kept on the next attempt (one title per project)', async () => {
    const store = setup(), project = await store.create(), provider = mock('Once'); await add(store, project.id, 'v1', 'S');
    expect(await autoTitle(store, project.id, { provider })).toBe('titled'); expect(await autoTitle(store, project.id, { provider })).toBe('kept');
    expect(provider.requests).toHaveLength(1);
  });
});

/** A timer object that records the scheduled callbacks instead of waiting; `fire` runs the oldest live one. */
function manualTimers() {
  const scheduled: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timers = {
    setTimeout: ((fn: () => void, ms?: number) => { scheduled.push({ fn, ms: ms ?? 0, cleared: false }); return scheduled.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    clearTimeout: ((handle: number) => { const t = scheduled[handle - 1]; if (t) t.cleared = true; }) as unknown as typeof clearTimeout,
  };
  const live = () => scheduled.filter(t => !t.cleared);
  const fire = () => { const t = live()[0]; if (!t) throw new Error('no live timer'); t.cleared = true; t.fn(); };
  return { timers, scheduled, live, fire };
}
/** Lets the pending store promises settle. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

describe('T19 C9 watchTitle', () => {
  it('row 7: default mode re-checks every 5000 ms while waiting and titles once a summary appears (onTitle called)', async () => {
    const store = setup(), project = await store.create(), provider = mock('Watched'), clock = manualTimers(), onTitle = vi.fn();
    await add(store, project.id, 'v1', undefined, 'video', 'processing');
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers });
    await vi.waitFor(() => expect(clock.live()).toHaveLength(1)); expect(clock.live()[0].ms).toBe(TITLE_POLL_MS); expect(TITLE_POLL_MS).toBe(5000);
    clock.fire(); await vi.waitFor(() => expect(clock.live()).toHaveLength(1)); expect(onTitle).not.toHaveBeenCalled(); expect(provider.requests).toHaveLength(0);
    await summary_(store, 'v1', 'Now it has one');
    clock.fire(); await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('Watched'));
    expect(onTitle).toHaveBeenCalledTimes(1); expect(clock.live()).toHaveLength(0); expect(provider.requests).toHaveLength(1);
    expect(await state(store, project.id)).toEqual({ title: 'Watched', source: 'generated' }); stop();
  });
  it('row 7: with no provider yet it sets no timer, and titles once setTitleProvider connects one', async () => {
    const store = setup(), project = await store.create(), clock = manualTimers(), onTitle = vi.fn(); await add(store, project.id, 'v1', 'Summary');
    const stop = watchTitle(store, project.id, { onTitle, timers: clock.timers }); await settle();
    expect(clock.scheduled).toHaveLength(0); expect(onTitle).not.toHaveBeenCalled();
    setTitleProvider(undefined); await settle(); expect(onTitle).not.toHaveBeenCalled(); // clearing it wakes nothing
    setTitleProvider(mock('Connected Later')); await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('Connected Later')); expect(clock.scheduled).toHaveLength(0); stop();
  });
  it('row 7: the module provider (setTitleProvider) is used when no provider option is given', async () => {
    const store = setup(), project = await store.create(), clock = manualTimers(), onTitle = vi.fn(); await add(store, project.id, 'v1', 'Summary');
    setTitleProvider(mock('From Module'));
    const stop = watchTitle(store, project.id, { onTitle, timers: clock.timers }); await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('From Module')); stop();
  });
  it('row 7: stop() while waiting for a provider → a provider connected later asks nothing', async () => {
    const store = setup(), project = await store.create(), clock = manualTimers(), onTitle = vi.fn(), provider = mock(); await add(store, project.id, 'v1', 'Summary');
    const stop = watchTitle(store, project.id, { onTitle, timers: clock.timers }); await settle(); stop();
    setTitleProvider(provider); await settle();
    expect(provider.requests).toHaveLength(0); expect(onTitle).not.toHaveBeenCalled(); expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' });
  });
  it('row 7: stops after "kept" (a renamed project) without a timer or a request', async () => {
    const store = setup(), project = await store.create(), provider = mock(), clock = manualTimers(), onTitle = vi.fn();
    await add(store, project.id, 'v1', 'Summary'); await store.renameProject(project.id, 'Mine');
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers }); await settle();
    expect(clock.scheduled).toHaveLength(0); expect(provider.requests).toHaveLength(0); expect(onTitle).not.toHaveBeenCalled(); stop();
  });
  it('row 7: stops after one failure — no retry, no timer, title unchanged', async () => {
    const store = setup(), project = await store.create(), provider = throwing(), clock = manualTimers(), onTitle = vi.fn(); await add(store, project.id, 'v1', 'Summary');
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers }); await vi.waitFor(() => expect(provider.calls).toBe(1)); await settle();
    expect(clock.scheduled).toHaveLength(0); expect(provider.calls).toBe(1); expect(onTitle).not.toHaveBeenCalled(); expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' }); stop();
  });
  it('row 7: a titled project stops the watch (no timer afterwards)', async () => {
    const store = setup(), project = await store.create(), provider = mock('Done'), clock = manualTimers(), onTitle = vi.fn(); await add(store, project.id, 'v1', 'Summary');
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers }); await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('Done')); await settle();
    expect(clock.scheduled).toHaveLength(0); stop(); expect(provider.requests).toHaveLength(1);
  });
  it('row 7: parity calls the provider once, titles without summaries, and never re-checks', async () => {
    const store = setup(), project = await store.create(), provider = mock('Parity One'), clock = manualTimers(), onTitle = vi.fn(); await add(store, project.id, 'v1');
    const stop = watchTitle(store, project.id, { parity: true, provider: () => provider, onTitle, timers: clock.timers });
    await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('Parity One')); await settle();
    expect(clock.scheduled).toHaveLength(0); expect(provider.requests).toHaveLength(1); stop();
  });
  it('row 7: parity with no provider does not poll', async () => {
    const store = setup(), project = await store.create(), clock = manualTimers(); await add(store, project.id, 'v1');
    const stop = watchTitle(store, project.id, { parity: true, provider: () => undefined, timers: clock.timers }); await settle();
    expect(clock.scheduled).toHaveLength(0); stop();
  });
  it('review 4: polling stops once the last asset settles with no summary — one request by file name, then no timer', async () => {
    const store = setup(), project = await store.create(), provider = mock('Settled'), clock = manualTimers(), onTitle = vi.fn();
    await add(store, project.id, 'v1', undefined, 'audio', 'processing');
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers });
    await vi.waitFor(() => expect(clock.live()).toHaveLength(1)); expect(provider.requests).toHaveLength(0);
    await store.updateAsset('v1', a => ({ ...a, processing_status: 'ready' }));
    clock.fire(); await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('Settled')); await settle();
    expect(clock.live()).toHaveLength(0); expect(clock.scheduled).toHaveLength(1); expect(provider.requests).toHaveLength(1); stop();
  });
  it('review 4: an empty project sets no timer and re-checks on its first attach; another project\'s attach does not wake it', async () => {
    const store = setup(), project = await store.create(), other = await store.create(), provider = mock('First Asset'), clock = manualTimers(), onTitle = vi.fn();
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers }); await settle();
    expect(clock.scheduled).toHaveLength(0); expect(store.attached.size).toBe(1);
    await add(store, other.id, 'elsewhere', undefined, 'audio'); await settle();
    expect(provider.requests).toHaveLength(0); expect(store.attached.size).toBe(1);
    await add(store, project.id, 'talk', undefined, 'audio');
    await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('First Asset')); await settle();
    expect(clock.scheduled).toHaveLength(0); expect(store.attached.size).toBe(0); expect(provider.requests).toHaveLength(1); stop();
  });
  it('review 4: stop() while the project is empty removes the attach watch; a later attach asks nothing', async () => {
    const store = setup(), project = await store.create(), provider = mock(), clock = manualTimers(), onTitle = vi.fn();
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers }); await settle();
    expect(store.attached.size).toBe(1); stop(); expect(store.attached.size).toBe(0);
    await add(store, project.id, 'v1', 'Summary'); await settle();
    expect(provider.requests).toHaveLength(0); expect(onTitle).not.toHaveBeenCalled(); expect(clock.scheduled).toHaveLength(0);
  });
  it('re-review a: an attach that commits while the check reads the empty library is not missed (one re-check, no timer)', async () => {
    const store = setup(), project = await store.create(), provider = mock('Raced'), clock = manualTimers(), onTitle = vi.fn(), real = store.library.bind(store);
    // The first check reads the library before the attach and returns 'empty'; the attach commits before that read returns.
    vi.spyOn(store, 'library').mockImplementationOnce(async () => { const before = await real(); await add(store, project.id, 'late', undefined, 'audio'); return before; });
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers });
    await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('Raced')); await settle();
    expect(provider.requests).toHaveLength(1); expect(clock.scheduled).toHaveLength(0); expect(store.attached.size).toBe(0); stop();
  });
  it('review 4: parity does not wait for an attach (it asks once at open, even for an empty project)', async () => {
    const store = setup(), project = await store.create(), provider = mock('Parity Empty'), clock = manualTimers(), onTitle = vi.fn();
    const stop = watchTitle(store, project.id, { parity: true, provider: () => provider, onTitle, timers: clock.timers });
    await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('Parity Empty')); expect(store.attached.size).toBe(0); expect(clock.scheduled).toHaveLength(0); stop();
  });
  it('row 7: stop() while polling clears the timer; firing it later does nothing', async () => {
    const store = setup(), project = await store.create(), provider = mock(), clock = manualTimers(), onTitle = vi.fn(); await add(store, project.id, 'v1', undefined, 'video', 'processing');
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers });
    await vi.waitFor(() => expect(clock.live()).toHaveLength(1)); stop(); expect(clock.live()).toHaveLength(0);
    await summary_(store, 'v1', 'Summary'); await settle(); expect(provider.requests).toHaveLength(0); expect(onTitle).not.toHaveBeenCalled();
  });
  it('row 7: stop() during the model call → no onTitle, no title written, no further timer', async () => {
    const store = setup(), project = await store.create(), clock = manualTimers(), onTitle = vi.fn(); await add(store, project.id, 'v1', 'Summary');
    let open!: () => void; const provider = gated(new Promise<void>(r => { open = r; }));
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers });
    await vi.waitFor(() => expect(provider.calls).toBe(1)); stop(); open(); await settle();
    expect(onTitle).not.toHaveBeenCalled(); expect(clock.scheduled).toHaveLength(0); expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' });
  });
  it('row 7: stop() before the first check settles → nothing reported', async () => {
    const store = setup(), project = await store.create(), provider = mock(), clock = manualTimers(), onTitle = vi.fn(); await add(store, project.id, 'v1', 'Summary');
    watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers })(); await settle();
    expect(onTitle).not.toHaveBeenCalled(); expect(clock.scheduled).toHaveLength(0); expect(await state(store, project.id)).toEqual({ title: DEFAULT_TITLE, source: 'default' });
  });
  it('a store error inside a check ends it as a failure (no throw, no retry)', async () => {
    const store = setup(), project = await store.create(), provider = mock(), clock = manualTimers(), onTitle = vi.fn(); await add(store, project.id, 'v1', 'Summary');
    vi.spyOn(store, 'library').mockRejectedValue(new Error('db gone'));
    const stop = watchTitle(store, project.id, { provider: () => provider, onTitle, timers: clock.timers }); await settle();
    expect(onTitle).not.toHaveBeenCalled(); expect(clock.scheduled).toHaveLength(0); stop();
  });
});

describe('T19 C9 event types', () => {
  it('non-text events and empty text are ignored when joining the answer', async () => {
    const events: ProviderEvent[] = [{ type: 'text', text: '' }, { type: 'tool', id: '1', name: 'n', input: {} }, { type: 'text', text: 'Only Text' }];
    expect(await generateTitle(new MockProvider(events), { message: '', assets: [] })).toBe('Only Text');
  });
});
