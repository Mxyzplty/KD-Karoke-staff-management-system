// SPDX-License-Identifier: AGPL-3.0-only
// T21 usage counters of this device (ticket "Providers" (5), §39 Local usage): tokens per model turn, requests per stock
// provider, exports made. Information only: nothing reads them to block an action. No key or request text is ever stored.
const KEY = 'cutframe:usage:v1';
export type ModelUsage = { requests: number; input: number; output: number; lastTurn: number };
export type Usage = { models: Record<string, ModelUsage>; requests: Record<string, number>; exports: number };
export function readUsage(): Usage {
  try { return { models: {}, requests: {}, exports: 0, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { models: {}, requests: {}, exports: 0 }; }
}
const change = (edit: (usage: Usage) => void) => { const usage = readUsage(); edit(usage); try { localStorage.setItem(KEY, JSON.stringify(usage)); } catch { /* not counted: the counter is information only */ } };
export const countTurn = (connection: string, input: number, output: number) => change(u => {
  const m = u.models[connection] ??= { requests: 0, input: 0, output: 0, lastTurn: 0 };
  m.requests++; m.input += input; m.output += output; m.lastTurn = input + output;
});
export const countRequest = (provider: string) => change(u => { u.requests[provider] = (u.requests[provider] ?? 0) + 1; });
export const countExport = () => change(u => { u.exports++; });
export const requestsLine = (n: number) => `${n} request${n === 1 ? '' : 's'}`;
export const modelLine = (m: ModelUsage) => `${requestsLine(m.requests)}, ${m.input.toLocaleString('en-US')} tokens in, ${m.output.toLocaleString('en-US')} out`;
