// SPDX-License-Identifier: AGPL-3.0-only
// T21 "AI and services": the three model protocols (request shapes, answer reading, errors), connection settings (modelFor, billingOf,
// saveConnection / removeConnection with their keys) and the ElevenLabs transcript mapping. No network: every call uses a fake fetch.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, test } from 'vitest';
import { toTranscript } from '../apps/web/src/settings/elevenlabs';
import { contextWindow, originOf, ProviderError, readAnswer, runTurn, testTarget, turnRequest } from '../apps/web/src/settings/protocols';
import type { Target } from '../apps/web/src/settings/protocols';
import { billingOf, ELEVENLABS, isLocal, JOBS, keyId, modelFor, PRESETS, readProviders, removeConnection, saveConnection, saveProviders, targetOf } from '../apps/web/src/settings/providers';
import type { Connection, ProviderSettings } from '../apps/web/src/settings/providers';
import { getSecret, hasSecret } from '../apps/web/src/settings/secrets';

const clearSecrets = () => new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('cutframe-secrets'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
const openai: Target = { protocol: 'openai', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-x', key: 'sk-1' };
const anthropic: Target = { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x', key: 'ak-1' };
const gemini: Target = { protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gem/x', key: 'gk-1' };
const ollama: Target = { protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama' };
const body = (t: Target, turn: Parameters<typeof turnRequest>[1]) => JSON.parse(turnRequest(t, turn).init.body as string);
const headers = (t: Target) => turnRequest(t, { user: 'hi' }).init.headers as Record<string, string>;
const reply = (json: unknown, status = 200) => async () => new Response(JSON.stringify(json), { status });

describe('protocol requests', () => {
  test('OpenAI-compatible: /chat/completions under the base URL, bearer key, system then user message', () => {
    const r = turnRequest(openai, { system: 'be brief', user: 'hi' });
    expect(r.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headers(openai)).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-1' });
    expect(body(openai, { system: 'be brief', user: 'hi' })).toEqual({ model: 'gpt-x', stream: false, messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] });
  });
  test('Anthropic Messages: /v1/messages, x-api-key and version headers, max_tokens always present', () => {
    expect(turnRequest(anthropic, { user: 'hi' }).url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers(anthropic)).toMatchObject({ 'x-api-key': 'ak-1', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
    expect(body(anthropic, { system: 's', user: 'hi', maxTokens: 64 })).toEqual({ model: 'claude-x', max_tokens: 64, system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(body(anthropic, { user: 'hi' }).max_tokens).toBe(4096);
  });
  test('Gemini: generateContent with the model URL-encoded and x-goog-api-key', () => {
    expect(turnRequest(gemini, { user: 'hi' }).url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gem%2Fx:generateContent');
    expect(headers(gemini)).toMatchObject({ 'x-goog-api-key': 'gk-1' });
    expect(body(gemini, { system: 's', user: 'hi' })).toEqual({ systemInstruction: { parts: [{ text: 's' }] }, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
  });
  test('Ollama and other local servers: the same OpenAI shape with no authorization header', () => {
    expect(turnRequest(ollama, { user: 'hi' }).url).toBe('http://localhost:11434/v1/chat/completions');
    expect(headers(ollama)).toEqual({ 'content-type': 'application/json' });
  });
  test('the Test tool is added to each protocol in that protocol’s shape', () => {
    expect(body(openai, { user: 'x', tool: true }).tools[0]).toMatchObject({ type: 'function', function: { name: 'ping' } });
    expect(body(anthropic, { user: 'x', tool: true }).tools[0]).toMatchObject({ name: 'ping', input_schema: { type: 'object' } });
    expect(body(gemini, { user: 'x', tool: true }).tools[0].functionDeclarations[0].name).toBe('ping');
    expect(body(openai, { user: 'x' }).tools).toBeUndefined();
  });
  test('originOf keeps scheme, host and port only', () => {
    expect(originOf('https://api.openai.com/v1')).toBe('https://api.openai.com');
    expect(originOf('http://localhost:11434/v1')).toBe('http://localhost:11434');
  });
});

describe('protocol answers', () => {
  test('OpenAI: text, tool call and token counts', () => {
    expect(readAnswer(openai, { model: 'm', choices: [{ message: { content: 'yo' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } })).toEqual({ text: 'yo', toolCalled: false, model: 'm', input: 3, output: 4 });
    expect(readAnswer(openai, { choices: [{ message: { content: null, tool_calls: [{}] } }] })).toMatchObject({ text: '', toolCalled: true, model: 'gpt-x', input: 0, output: 0 });
  });
  test('Anthropic: joins text blocks, sees tool_use, reads usage', () => {
    expect(readAnswer(anthropic, { content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }], usage: { input_tokens: 5, output_tokens: 6 } })).toMatchObject({ text: 'ab', toolCalled: true, input: 5, output: 6 });
  });
  test('Gemini: joins text parts, sees functionCall, reads usageMetadata', () => {
    expect(readAnswer(gemini, { candidates: [{ content: { parts: [{ text: 'x' }, { functionCall: {} }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 } })).toMatchObject({ text: 'x', toolCalled: true, input: 7, output: 8 });
  });
  test('an empty or malformed body reads as an empty answer instead of throwing', () => {
    for (const t of [openai, anthropic, gemini]) expect(readAnswer(t, {})).toMatchObject({ text: '', toolCalled: false });
    expect(readAnswer(openai, null)).toMatchObject({ text: '' });
  });
});

describe('runTurn and testTarget', () => {
  test('runTurn returns the read answer', async () => {
    expect((await runTurn(openai, { user: 'hi' }, reply({ choices: [{ message: { content: 'ok' } }] }))).text).toBe('ok');
  });
  test('an HTTP error names the origin, the status and the provider’s message (truncated to 200)', async () => {
    const error = await runTurn(openai, { user: 'hi' }, reply({ error: { message: 'x'.repeat(300) } }, 401)).catch(e => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(401);
    expect(error.message).toBe(`https://api.openai.com answered 401: ${'x'.repeat(200)}`);
  });
  test('a rejected fetch is "could not reach", pointing to the CORS help section; an abort is rethrown as is', async () => {
    const down = async () => { throw new TypeError('Failed to fetch'); };
    const error = await runTurn(ollama, { user: 'hi' }, down).catch(e => e);
    expect(error.message).toContain('Could not reach http://localhost:11434');
    expect(error.message).toContain('Local model servers');
    const controller = new AbortController(); controller.abort();
    await expect(runTurn(ollama, { user: 'hi' }, down, controller.signal)).rejects.toBeInstanceOf(TypeError);
  });
  test('testTarget reports the model, whether the tool was called and the context window', async () => {
    const fetcher = (async (url: string) => String(url).endsWith('/chat/completions')
      ? new Response(JSON.stringify({ model: 'llama-3', choices: [{ message: { tool_calls: [{}] } }] }))
      : new Response(JSON.stringify({ data: [{ id: 'llama', context_length: 32768 }] }))) as unknown as typeof fetch;
    expect(await testTarget(ollama, fetcher)).toEqual({ ok: true, model: 'llama-3', tools: true, contextWindow: 32768 });
    expect(await testTarget(ollama, reply({}, 500) as unknown as typeof fetch)).toMatchObject({ ok: false });
  });
  test('contextWindow is null when the server does not report one or fails', async () => {
    expect(await contextWindow(openai, reply({ data: [{ id: 'gpt-x' }] }) as unknown as typeof fetch)).toBeNull();
    expect(await contextWindow(openai, reply({}, 404) as unknown as typeof fetch)).toBeNull();
    expect(await contextWindow(gemini, reply({ inputTokenLimit: 1_000_000 }) as unknown as typeof fetch)).toBe(1_000_000);
  });
});

describe('presets, billing and modelFor', () => {
  const conn = (id: string, baseUrl: string, label = id, protocol: Connection['protocol'] = 'openai'): Connection => ({ id, label, protocol, baseUrl });
  test('presets cover the three protocols and the local servers', () => {
    expect(new Set(PRESETS.map(p => p.protocol))).toEqual(new Set(['openai', 'anthropic', 'gemini']));
    expect(PRESETS.map(p => p.label)).toEqual(expect.arrayContaining(['OpenAI', 'Anthropic', 'Google Gemini', 'OpenRouter', 'Ollama', 'LM Studio', 'llama.cpp server', 'vLLM']));
    for (const p of PRESETS) expect(p.billedBy === null, p.label).toBe(isLocal(p.baseUrl));
    for (const p of PRESETS.filter(p => p.billedBy)) { expect(p.pricing, p.label).toMatch(/^https:/); expect(p.keys, p.label).toMatch(/^https:/); }
    expect(ELEVENLABS.origin).toBe('https://api.elevenlabs.io');
  });
  test('isLocal: localhost, 127.0.0.1 and [::1] only', () => {
    expect(isLocal('http://localhost:1')).toBe(true);
    expect(isLocal('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLocal('http://[::1]:1/v1')).toBe(true);
    expect(isLocal('https://localhost.evil.com/v1')).toBe(false);
    expect(isLocal('https://api.openai.com/v1')).toBe(false);
  });
  test('billingOf: a preset names its biller and pricing page, a local URL nobody, a custom host its own label', () => {
    expect(billingOf(conn('a', 'https://api.anthropic.com', 'Mine', 'anthropic'))).toMatchObject({ billedBy: 'Anthropic', pricing: 'https://claude.com/pricing' });
    expect(billingOf(conn('b', 'http://localhost:11434/v1'))).toMatchObject({ billedBy: null });
    expect(billingOf(conn('c', 'http://localhost:9999/v1'))).toEqual({ billedBy: null, pricing: undefined, keys: undefined });
    expect(billingOf(conn('d', 'https://llm.example.com/v1', 'Example'))).toEqual({ billedBy: 'Example', pricing: undefined, keys: undefined });
  });
  test('modelFor: the job’s own model, else the default, else null', () => {
    const a = conn('a', 'https://api.openai.com/v1'), b = conn('b', 'http://localhost:11434/v1');
    const settings: ProviderSettings = { connections: [a, b], fallback: { connection: 'a', model: 'big' }, jobs: { repair: { connection: 'b', model: 'small' } }, speech: 'local' };
    expect(modelFor(settings, 'repair')).toEqual({ connection: b, model: 'small' });
    expect(modelFor(settings, 'chat')).toEqual({ connection: a, model: 'big' });
    expect(modelFor({ ...settings, fallback: null }, 'title')).toBeNull();
    expect(modelFor({ ...settings, connections: [b] }, 'chat')).toBeNull(); // the default's connection is gone
    expect(JOBS.map(j => j.job)).toEqual(['chat', 'repair', 'title', 'reframe']);
  });
});

describe('connections and their keys', () => {
  const rows = new Map<string, any>();
  const store = { row: async (_t: string, id: string) => rows.get(id), putRow: async (_t: string, row: { id: string }) => { rows.set(row.id, row); } } as any;
  const openaiConn: Connection = { id: 'c1', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' };
  beforeEach(async () => { rows.clear(); await clearSecrets(); });

  test('nothing saved reads as empty settings', async () => {
    expect(await readProviders(store)).toEqual({ connections: [], fallback: null, jobs: {}, speech: 'local' });
  });
  test('saveConnection stores the connection in the row and the key only in the secrets database', async () => {
    await saveConnection(store, openaiConn, ' sk-secret ');
    expect(JSON.stringify([...rows.values()])).not.toContain('sk-secret');
    expect((await readProviders(store)).connections).toEqual([openaiConn]);
    expect(await getSecret(keyId('c1'), 'https://api.openai.com')).toBe('sk-secret');
    expect((await targetOf({ connection: openaiConn, model: 'm' })).key).toBe('sk-secret');
  });
  test('editing a connection without a key keeps its key; another origin drops it', async () => {
    await saveConnection(store, openaiConn, 'sk-secret');
    await saveConnection(store, { ...openaiConn, label: 'Renamed' });
    expect(await hasSecret(keyId('c1'))).toBe(true);
    expect((await readProviders(store)).connections).toEqual([{ ...openaiConn, label: 'Renamed' }]);
    await saveConnection(store, { ...openaiConn, baseUrl: 'https://evil.example.com/v1' });
    expect(await hasSecret(keyId('c1'))).toBe(false);
    expect(await getSecret(keyId('c1'), 'https://evil.example.com')).toBeUndefined();
  });
  test('removeConnection drops the connection, its key and every model choice that used it', async () => {
    const other: Connection = { id: 'c2', label: 'Ollama', protocol: 'openai', baseUrl: 'http://localhost:11434/v1' };
    await saveConnection(store, openaiConn, 'sk-secret'); await saveConnection(store, other);
    await saveProviders(store, { ...(await readProviders(store)), fallback: { connection: 'c1', model: 'big' }, jobs: { repair: { connection: 'c1', model: 'x' }, title: { connection: 'c2', model: 'y' } } });
    const next = await removeConnection(store, 'c1');
    expect(next.connections).toEqual([other]);
    expect(next.fallback).toBeNull();
    expect(next.jobs).toEqual({ title: { connection: 'c2', model: 'y' } });
    expect(await hasSecret(keyId('c1'))).toBe(false);
  });
});

describe('ElevenLabs transcript mapping', () => {
  test('words become segments split on speaker, sentence end and a 1 s gap, speakers numbered by first appearance', () => {
    const w = (text: string, start: number, end: number, speaker_id = 'speaker_9') => ({ text, start, end, type: 'word' as const, speaker_id });
    const space = { text: ' ', type: 'spacing' as const };
    const t = toTranscript({ language_code: 'en', words: [w('Hello', 0, .4), space, w('there.', .5, .9), space, w('Next', 1, 1.3), space, w('one', 1.4, 1.6, 'speaker_2'), space, w('later', 5, 5.3, 'speaker_2')] }, 6);
    expect(t.language).toBe('en');
    expect(t.total_duration).toBe(6);
    expect(t.segments.map(s => [s.text, s.speaker])).toEqual([['Hello there.', 0], ['Next', 0], ['one', 1], ['later', 1]]);
    expect(t.segments[0].words.map(x => x.word)).toEqual(['Hello', 'there.']);
    expect(toTranscript({}, 1)).toMatchObject({ language: 'und', segments: [] });
  });
});
