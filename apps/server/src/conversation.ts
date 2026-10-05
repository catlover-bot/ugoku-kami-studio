/** Provider-neutral messages. Provider-private signed/native payloads never enter this history. */
export type ToolCall = { name: string; args: Record<string, unknown>; id?: string };
export type ToolResult = { name: string; response: Record<string, unknown>; id?: string };
export type AssistantMessage = { role: 'assistant'; text: string; calls: ToolCall[] };
export type ConversationMessage = { role: 'user'; text: string } | AssistantMessage | { role: 'tool'; results: ToolResult[] };
export type UsageMetadata = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number; toolUsePromptTokenCount?: number; totalTokenCount?: number };
export type LocalTiming = { loadMs: number; promptEvalMs: number; evalMs: number; totalMs: number };
export type LocalModel = { digest: string; quantization: string; contextLength: number; runtimeVersion: string; toolMode: 'native' | 'json-actions' };
export type ModelCost = { kind: 'usage-estimate' | 'reservation'; usageEstimateUsd: number | null; reservationUsd: number };
export type ProviderResponse = { message: AssistantMessage; finishReason?: string; refusal?: boolean; usageMetadata?: UsageMetadata; modelVersion?: string; localTiming?: LocalTiming; localModel?: LocalModel; modelCost?: ModelCost };
export interface ModelProvider {
  generate(messages: ConversationMessage[], signal: AbortSignal): Promise<ProviderResponse>;
  inputBytes?(messages: ConversationMessage[]): number;
}
export type ToolDeclaration = { name: string; description: string; parametersJsonSchema: Record<string, unknown> };
