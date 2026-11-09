// SPDX-License-Identifier: AGPL-3.0-only
// T21 the three model protocols (ticket "Providers" (1)): OpenAI-compatible chat completions, Anthropic Messages, Gemini.
// One non-streaming turn each, with or without the Test tool. The streaming chat of T20 is built on the same request shapes.
export type Protocol = 'openai' | 'anthropic' | 'gemini';
export type Target = { protocol: Protocol; baseUrl: string; model: string; key?: string };
export type Turn = { system?: string; user: string; maxTokens?: number; tool?: boolean };
export type Answer = { text: string; toolCalled: boolean; model: string; input: number; output: number };

/** The Test tool: one optional parameter, because Gemini refuses an object schema with no properties. */
const PING = { name: 'ping', description: 'Reports that tool calling works.', parameters: { type: 'object', properties: { ok: { type: 'boolean', description: 'Always true.' } } } };
const base = (url: string) => url.trim().replace(/\/+$/, '');
export const originOf = (url: string) => new URL(url).origin;
const headers = (t: Target): Record<string, string> => {
  const json = { 'content-type': 'application/json' };
  if (t.protocol === 'anthropic') return { ...json, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', ...(t.key ? { 'x-api-key': t.key } : {}) };
  if (t.protocol === 'gemini') return { ...json, ...(t.key ? { 'x-goog-api-key': t.key } : {}) };
  return { ...json, ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) };
};
export function turnRequest(t: Target, turn: Turn): { url: string; init: RequestInit } {
  const send = (url: string, body: unknown) => ({ url, init: { method: 'POST', headers: headers(t), body: JSON.stringify(body) } });
  if (t.protocol === 'anthropic') return send(`${base(t.baseUrl)}/v1/messages`, {
    model: t.model, max_tokens: turn.maxTokens ?? 4096, ...(turn.system ? { system: turn.system } : {}), messages: [{ role: 'user', content: turn.user }],
    ...(turn.tool ? { tools: [{ name: PING.name, description: PING.description, input_schema: PING.parameters }] } : {}) });
  if (t.protocol === 'gemini') return send(`${base(t.baseUrl)}/v1beta/models/${encodeURIComponent(t.model)}:generateContent`, {
    ...(turn.system ? { systemInstruction: { parts: [{ text: turn.system }] } } : {}), contents: [{ role: 'user', parts: [{ text: turn.user }] }],
    ...(turn.tool ? { tools: [{ functionDeclarations: [PING] }] } : {}) });
  return send(`${base(t.baseUrl)}/chat/completions`, {
    model: t.model, stream: false, messages: [...(turn.system ? [{ role: 'system', content: turn.system }] : []), { role: 'user', content: turn.user }],
    ...(turn.tool ? { tools: [{ type: 'function', function: PING }] } : {}) });
}
export function readAnswer(t: Target, json: any): Answer {
  if (t.protocol === 'anthropic') {
    const blocks: any[] = json?.content ?? [];
    return { text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''), toolCalled: blocks.some(b => b.type === 'tool_use'), model: json?.model ?? t.model, input: json?.usage?.input_tokens ?? 0, output: json?.usage?.output_tokens ?? 0 };
  }
  if (t.protocol === 'gemini') {
    const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
    return { text: parts.filter(p => typeof p.text === 'string').map(p => p.text).join(''), toolCalled: parts.some(p => p.functionCall), model: json?.modelVersion ?? t.model, input: json?.usageMetadata?.promptTokenCount ?? 0, output: json?.usageMetadata?.candidatesTokenCount ?? 0 };
  }
  const message = json?.choices?.[0]?.message;
  return { text: typeof message?.content === 'string' ? message.content : '', toolCalled: !!message?.tool_calls?.length, model: json?.model ?? t.model, input: json?.usage?.prompt_tokens ?? 0, output: json?.usage?.completion_tokens ?? 0 };
}
/** The model-listing request and where each server reports the context window (OpenRouter, vLLM, LM Studio, llama.cpp, Anthropic, Gemini). */
const windowRequest = (t: Target) => t.protocol === 'gemini' ? `${base(t.baseUrl)}/v1beta/models/${encodeURIComponent(t.model)}`
  : t.protocol === 'anthropic' ? `${base(t.baseUrl)}/v1/models/${encodeURIComponent(t.model)}` : `${base(t.baseUrl)}/models`;
const windowOf = (entry: any): number | null => {
  const found = entry?.inputTokenLimit ?? entry?.max_input_tokens ?? entry?.context_window ?? entry?.context_length ?? entry?.top_provider?.context_length ?? entry?.max_model_len ?? entry?.max_context_length ?? entry?.meta?.n_ctx_train;
  return typeof found === 'number' ? found : null;
};
/** Null when the server does not report one: OpenAI's own listing has no such field. */
export async function contextWindow(t: Target, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<number | null> {
  try {
    const response = await fetcher(windowRequest(t), { headers: headers(t), signal });
    if (!response.ok) return null;
    const json = await response.json();
    return windowOf(t.protocol === 'openai' ? (json?.data ?? json?.models ?? []).find((m: any) => m.id === t.model || m.model === t.model) : json);
  } catch { return null; }
}
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'ProviderError'; }
}
/** One turn. A rejected fetch has no status: the browser blocked it (CORS, private network) or nothing answered. */
export async function runTurn(t: Target, turn: Turn, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Answer> {
  const { url, init } = turnRequest(t, turn);
  let response: Response;
  try { response = await fetcher(url, { ...init, signal }); }
  catch (e) { if (signal?.aborted) throw e; throw new ProviderError(`Could not reach ${originOf(url)}. A local server must allow this page's origin (CORS); see the help section "Local model servers".`); }
  if (!response.ok) {
    const detail = await response.json().then((j: any) => j?.error?.message ?? j?.message ?? '', () => '');
    throw new ProviderError(`${originOf(url)} answered ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`, response.status);
  }
  return readAnswer(t, await response.json());
}
export type TestResult = { ok: true; model: string; tools: boolean; contextWindow: number | null } | { ok: false; message: string };
/** The Test button: one minimal tool-calling request, then the model name, whether tools work and the context window. */
export async function testTarget(t: Target, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<TestResult> {
  try {
    const answer = await runTurn(t, { user: 'Call the ping tool.', maxTokens: 64, tool: true }, fetcher, signal);
    return { ok: true, model: answer.model, tools: answer.toolCalled, contextWindow: await contextWindow(t, fetcher, signal) };
  } catch (e) { return { ok: false, message: (e as Error).message }; }
}
