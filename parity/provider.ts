// SPDX-License-Identifier: AGPL-3.0-only
export type ProviderEvent = { type: 'text'; text: string } | { type: 'tool'; id: string; name: string; input: unknown };
export type ProviderRequest = { messages: unknown[]; tools?: unknown[]; purpose?: string };
export interface ModelProvider { stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent> }
export class NoProvider implements ModelProvider {
  async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> { throw Object.assign(Error('No AI provider connected'), { code: 'NO_PROVIDER' }); }
}
export const fixedScript: readonly ProviderEvent[] = Object.freeze([
  { type: 'text', text: 'I will inspect ' }, { type: 'text', text: 'the current project.' },
  { type: 'tool', id: 'mock-call-1', name: 'context', input: {} },
  { type: 'text', text: ' The fixture is ready for the requested action.' }
]);
export class MockProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  constructor(readonly script: readonly ProviderEvent[] = fixedScript) {}
  async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    for (const event of this.script) {
      signal?.throwIfAborted();
      await Promise.resolve();
      yield structuredClone(event);
    }
  }
}
