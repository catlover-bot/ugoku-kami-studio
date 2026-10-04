import type { ConversationMessage, ProviderResponse } from '../src/provider.js';
export type FixturePart = { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name: string; args?: Record<string, unknown>; id?: string } };
export function responseParts(parts: FixturePart[], usageMetadata?: ProviderResponse['usageMetadata']): ProviderResponse {
  return { message: { role: 'assistant', text: parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n'), calls: parts.flatMap(p => p.functionCall ? [{ ...p.functionCall, args: p.functionCall.args ?? {} }] : []) }, finishReason: 'STOP', usageMetadata };
}
export function results(history: ConversationMessage[]) { return history.flatMap(message => message.role === 'tool' ? message.results : []); }
export function toolResult(history: ConversationMessage[], index = 0): Record<string, unknown> { const item = history.at(-1); return item?.role === 'tool' ? item.results[index]!.response : {}; }
export function toolIds(history: ConversationMessage[]) { const item = history.at(-1); return item?.role === 'tool' ? item.results.map(result => result.id) : []; }
export function userText(history: ConversationMessage[]): string { const item = history[0]; if(item?.role !== 'user') throw Error('test history must begin with user'); return item.text; }
