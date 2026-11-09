// SPDX-License-Identifier: AGPL-3.0-only
// T21 "AI and services" (ticket "Providers"): the user's model connections, one default model plus an optional model per job,
// and the optional hosted analysis provider. The settings row holds no key (settings/secrets.ts does); a key belongs to its
// connection's origin, so changing the base URL to another origin drops it. Keyed requests go only to that origin.
// connectProviders hands the chosen models to repair (T08) and auto-title (T19); T20 and T23 read modelFor.
import type { ProjectStore } from '../store/database';
import { setTitleProvider } from '../analysis/title';
import { replyCode, setRepairModel, systemPrompt, userMessage } from '../mg/repair';
import type { RepairModel } from '../mg/repair';
import { countTurn } from './meter';
import { originOf, runTurn } from './protocols';
import type { Answer, Protocol, Target, Turn } from './protocols';
import { getSecret, putSecret, removeSecret, secretOrigin } from './secrets';

export type Job = 'chat' | 'repair' | 'title' | 'reframe';
export type Connection = { id: string; label: string; protocol: Protocol; baseUrl: string };
export type ModelChoice = { connection: string; model: string };
export type ProviderSettings = { connections: Connection[]; fallback: ModelChoice | null; jobs: Partial<Record<Job, ModelChoice>>; speech: 'local' | 'elevenlabs' };
export const JOBS: { job: Job; label: string }[] = [{ job: 'chat', label: 'Built-in chat' }, { job: 'repair', label: 'Motion-graphic repair' }, { job: 'title', label: 'Project titles' }, { job: 'reframe', label: 'Reframe guide' }];
/** Connection presets. Billed by the provider, or by nobody on a local server. Pricing/key pages reached on 4 Nov 2026,
 *  except OpenAI's two, whose canonical URLs returned 403 to an automated fetch and are listed unverified (T21 open question). */
export const PRESETS: { label: string; protocol: Protocol; baseUrl: string; billedBy: string | null; pricing?: string; keys?: string }[] = [
  { label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', billedBy: 'OpenAI', pricing: 'https://openai.com/api/pricing/', keys: 'https://platform.openai.com/api-keys' },
  { label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', billedBy: 'OpenRouter', pricing: 'https://openrouter.ai/pricing', keys: 'https://openrouter.ai/keys' },
  { label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', billedBy: 'Anthropic', pricing: 'https://claude.com/pricing', keys: 'https://console.anthropic.com/settings/keys' },
  { label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', billedBy: 'Google', pricing: 'https://ai.google.dev/gemini-api/docs/pricing', keys: 'https://aistudio.google.com/apikey' },
  { label: 'Ollama', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', billedBy: null },
  { label: 'LM Studio', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', billedBy: null },
  { label: 'llama.cpp server', protocol: 'openai', baseUrl: 'http://localhost:8080/v1', billedBy: null },
  { label: 'vLLM', protocol: 'openai', baseUrl: 'http://localhost:8000/v1', billedBy: null },
];
export const ELEVENLABS = { origin: 'https://api.elevenlabs.io', pricing: 'https://elevenlabs.io/pricing/api', keys: 'https://elevenlabs.io/app/settings/api-keys' };
export const SPEECH_KEY = 'speech:elevenlabs';
export const billingOf = (c: Connection) => PRESETS.find(p => p.baseUrl === c.baseUrl) ?? { billedBy: isLocal(c.baseUrl) ? null : c.label, pricing: undefined, keys: undefined };
export const isLocal = (url: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);

type Store = Pick<ProjectStore, 'row' | 'putRow'>;
const ROW = 'providers';
const empty = (): ProviderSettings => ({ connections: [], fallback: null, jobs: {}, speech: 'local' });
export async function readProviders(store: Pick<Store, 'row'>): Promise<ProviderSettings> {
  const row = await store.row<ProviderSettings & { id: string }>('settings', ROW);
  if (!row) return empty();
  const { id: _, ...settings } = row;
  return settings;
}
export const saveProviders = (store: Pick<Store, 'putRow'>, settings: ProviderSettings) => store.putRow('settings', { id: ROW, ...settings });
export const keyId = (connection: string) => `model:${connection}`;
/** Adds or edits a connection. Another origin on the same connection drops its key (the key belongs to the origin it was entered for). */
export async function saveConnection(store: Store, connection: Connection, key?: string): Promise<ProviderSettings> {
  const settings = await readProviders(store), origin = originOf(connection.baseUrl);
  const bound = await secretOrigin(keyId(connection.id));
  if (bound && bound !== origin) await removeSecret(keyId(connection.id));
  if (key?.trim()) await putSecret(keyId(connection.id), key.trim(), origin);
  const next = { ...settings, connections: [...settings.connections.filter(c => c.id !== connection.id), connection] };
  await saveProviders(store, next);
  return next;
}
/** Remove: the connection, its key and every model choice that used it. */
export async function removeConnection(store: Store, id: string): Promise<ProviderSettings> {
  const settings = await readProviders(store);
  await removeSecret(keyId(id));
  const next: ProviderSettings = { ...settings, connections: settings.connections.filter(c => c.id !== id), fallback: settings.fallback?.connection === id ? null : settings.fallback,
    jobs: Object.fromEntries(Object.entries(settings.jobs).filter(([, choice]) => choice.connection !== id)) };
  await saveProviders(store, next);
  return next;
}
/** The job's own model, else the default model; null when neither is set (the job's no-key state). */
export function modelFor(settings: ProviderSettings, job: Job): { connection: Connection; model: string } | null {
  const choice = settings.jobs[job] ?? settings.fallback, connection = settings.connections.find(c => c.id === choice?.connection);
  return choice && connection ? { connection, model: choice.model } : null;
}
export async function targetOf(choice: { connection: Connection; model: string }): Promise<Target> {
  const { protocol, baseUrl } = choice.connection;
  return { protocol, baseUrl, model: choice.model, key: await getSecret(keyId(choice.connection.id), originOf(baseUrl)) };
}
/** One counted turn on a chosen model. */
export async function complete(choice: { connection: Connection; model: string }, turn: Turn, signal?: AbortSignal): Promise<Answer> {
  const answer = await runTurn(await targetOf(choice), turn, fetch, signal);
  countTurn(choice.connection.id, answer.input, answer.output);
  return answer;
}
/** The names a graphic may use, read from the sandbox runtime's source: the runtime itself is not loaded on the app origin. */
async function apiNames() {
  const source = (await import('../mg/runtime-components.tsx?raw')).default as string;
  return [.../export const API_NAMES = \[([^\]]*)\]/.exec(source)![1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}
const repairModel = (choice: NonNullable<ReturnType<typeof modelFor>>): RepairModel => async request => {
  try {
    const text = (await complete(choice, { system: systemPrompt(await apiNames()), user: userMessage(request) })).text;
    return text.trim() ? { code: replyCode(text) } : { error: 'The model returned no code.' };
  } catch (e) { return { error: (e as Error).message }; }
};
const titleProvider = (choice: NonNullable<ReturnType<typeof modelFor>>) => ({
  async *stream(request: { messages: unknown[] }, signal?: AbortSignal) {
    const message = request.messages[0] as { content: string };
    yield { type: 'text', text: (await complete(choice, { user: message.content, maxTokens: 64 }, signal)).text };
  },
});
let connected = false;
/** Called at start-up and after every provider change. With nothing configured it touches neither seam. */
export async function connectProviders(store: Pick<Store, 'row'>) {
  const settings = await readProviders(store), repair = modelFor(settings, 'repair'), title = modelFor(settings, 'title');
  if (!repair && !title && !connected) return;
  connected = !!repair || !!title;
  setRepairModel(repair ? repairModel(repair) : null);
  setTitleProvider(title ? titleProvider(title) : undefined);
}
