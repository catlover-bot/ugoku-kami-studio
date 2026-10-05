/** Provider-neutral messages. Provider-private signed/native payloads never enter this history. */
import type { VertexUsageDiagnostics } from './vertex-budget.js';
export type ToolCall = { name: string; args: Record<string, unknown>; id?: string };
export type ToolResult = { name: string; response: Record<string, unknown>; id?: string };
export type AssistantMessage = { role: 'assistant'; text: string; calls: ToolCall[] };
export type ConversationMessage = { role: 'user'; text: string } | AssistantMessage | { role: 'tool'; results: ToolResult[] };
export type UsageMetadata = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number; toolUsePromptTokenCount?: number; totalTokenCount?: number };
export type LocalTiming = { loadMs: number; promptEvalMs: number; evalMs: number; totalMs: number };
export type LocalModel = { digest: string; quantization: string; contextLength: number; runtimeVersion: string; toolMode: 'native' | 'json-actions' };
export type ModelCost = { kind: 'usage-estimate' | 'aggregate-upper-estimate' | 'sent-unknown'; usageEstimateUsd: number | null; estimateUsd: number | null; reservationUsd: number; basis: 'itemized' | 'total-at-output-rate' | 'insufficient-or-inconsistent'; rateBasis: 'vertex-global-standard-conservative-2026-10-05'; billingActual: false };
export type ModelDispatch = { attemptId: string; call: number; dispatchedAt: string };
export type ModelObservation = { attemptId: string; call: number; source: 'http-response' | 'sdk-response'; observedAt: string; sdkVersion: '2.27.0'; model: string; modelVersion: string | null; responseId: string | null; finishReason: string | null; aborted: boolean; usageDiagnostics: VertexUsageDiagnostics; modelCost: ModelCost };
export type ModelCallContext = { attemptId: string; call: number; beforeDispatch?: () => void | Promise<void>; onDispatch?: (dispatch: ModelDispatch) => void | Promise<void>; onObservation?: (observation: ModelObservation) => void | Promise<void> };
export type ProviderResponse = { message: AssistantMessage; finishReason?: string; refusal?: boolean; usageMetadata?: UsageMetadata; modelVersion?: string; localTiming?: LocalTiming; localModel?: LocalModel; modelCost?: ModelCost };
export interface ModelProvider {
  generate(messages: ConversationMessage[], signal: AbortSignal, context?: ModelCallContext): Promise<ProviderResponse>;
  inputBytes?(messages: ConversationMessage[]): number;
}
export type ToolDeclaration = { name: string; description: string; parametersJsonSchema: Record<string, unknown> };
