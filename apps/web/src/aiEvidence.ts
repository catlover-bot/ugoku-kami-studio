import { type CheckResult, type DesignDocument, type DesignPatch, type DesignIntent } from '@ugoku/core';
import { designChanges } from './DesignComparison';

export type AiRun = {
  id: string; requestId: string; baseRevision: number; baseHash: string;
  mode?: 'ollama' | 'gemini' | 'injected-test'; provider?: 'ollama' | 'gemini'; model?: string;
  localModel?: {digest: string; quantization: string; contextLength: number; runtimeVersion: string; toolMode?: 'native' | 'json-actions'};
  status: 'running' | 'awaiting_approval' | 'clarification_required' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
  events: { sequence?: number; type?: string; tool?: string; name?: string; message?: string; designHash?: string; patch?: DesignPatch; checkStatuses?: {id: string; status: string}[]; durationMs?: number }[];
  proposal?: { id: string; requestId?: string; baseRevision?: number; baseHash?: string; patch: DesignPatch; document: DesignDocument; addedLocks?: string[]; protectedConditions?: string[]; requestedTravelMm?: number; fulfillsRequested?: boolean };
  requestInterpretation?: Pick<DesignIntent, 'binding' | 'interpretation' | 'clarifications' | 'summary' | 'approvalRequired'>;
  intentSummary?: {protections: string[]; notes: string[]};
  validationIssues?: CheckResult[];
  constraintSuggestions: {key: string; value: unknown; reason: string; source?: 'model'; verification?: {source: 'deterministic-core'; geometry: 'pass'; conditionsApproved: false; baseHash: string; baseRevision: number; comparedCandidateHash: string; hypotheticalDesignHash: string; checks: CheckResult[]}}[];
  error?: {code: string; message: string};
  modelCalls: number; toolCalls: number; elapsedMs: number;
  usage?: {promptTokens: number; outputTokens: number; totalTokens: number; thinkingTokens?: number; cachedInputTokens?: number; toolPromptTokens?: number; responsesWithUsage?: number; responsesWithoutUsage?: number};
  modelUsage?: {call: number; inputBytes: number; outputTokenLimit: number; durationMs: number; received: boolean; finishReason: string | null; modelVersion: string | null; localTiming?: {loadMs: number; promptEvalMs: number; evalMs: number; totalMs: number}; usage: {promptTokens: number; outputTokens: number; thinkingTokens: number; cachedInputTokens: number; toolPromptTokens: number; totalTokens: number} | null}[];
};
export type DesignStamp = {designId: string; revision: number; designHash: string};
export type AiEvidence = {
  runId: string; requestedAt: string; observedAt: string; prompt: string;
  execution: {mode: 'ollama' | 'gemini' | 'injected-test' | 'unknown'; model: string | null};
  base: DesignStamp & {checks: CheckResult[]};
  proposed?: DesignStamp & {checks: CheckResult[]; changes: ReturnType<typeof designChanges>};
  /** Last response actually received from the application server, independent of the UI decision. */
  serverRun: AiRun;
  decision: {status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'stale' | 'failed' | 'completed'; at: string; adopted?: DesignStamp; reason?: string};
};
export const designStamp = (document: DesignDocument): DesignStamp => ({designId: document.designId, revision: document.revision, designHash: document.designHash});

/** Explicit public fields: credentials, transport headers and image bytes cannot enter this export. */
export function publicRunSnapshot(run: AiRun): AiRun {
  return structuredClone({
    id: run.id, requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash,
    mode: run.mode, provider: run.provider, model: run.model, localModel: run.localModel, status: run.status, message: run.message,
    events: run.events.map(event => ({sequence: event.sequence, type: event.type, tool: event.tool, name: event.name, message: event.message, designHash: event.designHash, patch: event.patch, checkStatuses: event.checkStatuses, durationMs: event.durationMs})),
    proposal: run.proposal ? {id: run.proposal.id, requestId: run.proposal.requestId, baseRevision: run.proposal.baseRevision, baseHash: run.proposal.baseHash, patch: run.proposal.patch, document: run.proposal.document, addedLocks: run.proposal.addedLocks, protectedConditions: run.proposal.protectedConditions, requestedTravelMm: run.proposal.requestedTravelMm, fulfillsRequested: run.proposal.fulfillsRequested} : undefined,
    requestInterpretation: run.requestInterpretation, intentSummary: run.intentSummary, validationIssues: run.validationIssues, constraintSuggestions: run.constraintSuggestions,
    error: run.error, modelCalls: run.modelCalls, toolCalls: run.toolCalls, elapsedMs: run.elapsedMs, usage: run.usage, modelUsage: run.modelUsage,
  });
}
export function observeRun(previous: AiEvidence | undefined, run: AiRun, base: DesignDocument, prompt: string, requestedAt: string): AiEvidence {
  const now = new Date().toISOString();
  const document = run.proposal?.document;
  const terminalDecision = previous && ['accepted', 'rejected', 'cancelled', 'stale'].includes(previous.decision.status);
  return {
    runId: run.id, requestedAt, observedAt: now, prompt,
    execution: {mode: run.mode ?? 'unknown', model: run.model ?? null},
    base: {...designStamp(base), checks: base.checks},
    proposed: document ? {...designStamp(document), checks: document.checks, changes: designChanges(base, document)} : previous?.proposed,
    serverRun: publicRunSnapshot(run),
    decision: terminalDecision ? previous.decision : {status: run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'cancelled' : run.status === 'succeeded' ? 'completed' : 'pending', at: now},
  };
}

/** Aggregate zero is only a sum of known responses; it never proves zero usage. */
export function usageLabel(run: AiRun): string {
  const known = run.usage?.responsesWithUsage ?? run.modelUsage?.filter(call => call.usage !== null).length;
  const unknown = run.usage?.responsesWithoutUsage ?? run.modelUsage?.filter(call => call.usage === null).length ?? 0;
  if (!run.usage || known === 0) return '使用量は未取得';
  if (known === undefined) return `報告された集計値 ${run.usage.totalTokens}トークン（取得状況は未確認）`;
  return `取得済み分 ${run.usage.totalTokens}トークン${unknown > 0 ? '（使用量不明の呼び出しあり）' : ''}`;
}
