import type { ModelCost, UsageMetadata } from './conversation.js';
import { AppError } from './errors.js';

// Conservative pre-credit planning rates, USD / 1M: input 1.50, output/reasoning 7.50.
// Verified 2026-10-05 against Vertex global Standard: the promotional .75/3.75
// display uses 50% credits. No promotional, cache or billing-credit deduction.
// https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
const INPUT_NANO = 1500, OUTPUT_NANO = 7500, NANO_PER_USD = 1_000_000_000;
const THINKING_RESERVE = 65_536;
const dollars = (nano: number) => nano / NANO_PER_USD;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000_000;
const requiredFields = ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount'] as const;
const usageFields = [...requiredFields, 'cachedContentTokenCount', 'toolUsePromptTokenCount'] as const;
type UsageField = typeof usageFields[number];
type FieldObservation = { state: 'missing' | 'null' | 'zero' | 'value' | 'invalid'; value?: number };
export type VertexUsageDiagnostics = {
  source: 'http-usage-metadata' | 'sdk-usage-metadata'; metadataPresent: boolean; metadataState: 'missing' | 'null' | 'invalid' | 'present';
  observed: Partial<Record<UsageField, number>>; fields: Record<UsageField, FieldObservation>;
  missingRequired: UsageField[]; invalidFields: UsageField[];
  inconsistencies: ('empty_prompt' | 'empty_total' | 'total_less_than_components' | 'total_differs_from_components' | 'cached_input_exceeds_prompt' | 'cached_input_exceeds_total')[];
};

/** Only allowlisted numbers and fixed status labels. Missing, null and explicit
 * zero remain distinct. No arbitrary metadata/content/signatures enter records. */
export function vertexUsageDiagnostics(usage: unknown): VertexUsageDiagnostics {
  const present = typeof usage === 'object' && usage !== null && !Array.isArray(usage);
  const record = present ? usage as Record<string, unknown> : {};
  const result: VertexUsageDiagnostics = { source: 'sdk-usage-metadata', metadataPresent: present, metadataState: present ? 'present' : usage === undefined ? 'missing' : usage === null ? 'null' : 'invalid', observed: {}, fields: {} as Record<UsageField, FieldObservation>, missingRequired: [], invalidFields: [], inconsistencies: [] };
  for (const field of usageFields) {
    const value = record[field];
    const state = value === undefined ? 'missing' : value === null ? 'null' : !count(value) ? 'invalid' : value === 0 ? 'zero' : 'value';
    result.fields[field] = { state, ...(typeof value === 'number' && Number.isFinite(value) ? { value } : {}) };
    if (typeof value === 'number' && Number.isFinite(value)) result.observed[field] = value;
    if (state === 'missing' || state === 'null') {
      if ((requiredFields as readonly string[]).includes(field)) result.missingRequired.push(field);
    } else if (state === 'invalid') result.invalidFields.push(field);
  }
  const { promptTokenCount: input, candidatesTokenCount: output, thoughtsTokenCount: thinking, totalTokenCount: total, cachedContentTokenCount: cached, toolUsePromptTokenCount: tool } = result.observed;
  if (input === 0) result.inconsistencies.push('empty_prompt');
  if (total === 0) result.inconsistencies.push('empty_total');
  const components = [input, output, thinking, tool];
  const knownSum = components.filter(count).reduce((sum, value) => sum + value, 0);
  if (count(total) && total < knownSum) result.inconsistencies.push('total_less_than_components');
  else if (count(total) && components.every(count) && total !== knownSum) result.inconsistencies.push('total_differs_from_components');
  if (count(input) && count(cached) && cached > input) result.inconsistencies.push('cached_input_exceeds_prompt');
  if (count(total) && count(cached) && cached > total) result.inconsistencies.push('cached_input_exceeds_total');
  return result;
}

/** Vertex v1 total = prompt + candidates + toolUsePrompt + thoughts. Cache is
 * already in prompt. Scope: current text + function tools, no paid hosted tools.
 * All-total upper estimates do not assert any missing component was observed.
 * REST: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/GenerateContentResponse#UsageMetadata
 * SDK: @google/genai 2.27.0 GenerateContentResponseUsageMetadata (installed d.ts).
 */
export function assessVertexUsage(usage: unknown): Omit<ModelCost, 'reservationUsd'> {
  const diagnostics = vertexUsageDiagnostics(usage);
  const unknown: Omit<ModelCost, 'reservationUsd'> = { kind: 'sent-unknown', usageEstimateUsd: null, estimateUsd: null, basis: 'insufficient-or-inconsistent', rateBasis: 'vertex-global-standard-conservative-2026-10-05', billingActual: false };
  if (!diagnostics.metadataPresent || diagnostics.invalidFields.length || diagnostics.inconsistencies.length) return unknown;
  const { promptTokenCount: input, candidatesTokenCount: output, thoughtsTokenCount: thinking, totalTokenCount: total, toolUsePromptTokenCount: tool } = diagnostics.observed;
  if (!count(total) || total === 0) return unknown;
  // If tool count is absent, equality proves there is no residual charge; it
  // does not turn that absent field into an observed zero in the diagnostics.
  if (count(input) && count(output) && count(thinking) && total === input + output + thinking + (count(tool) ? tool : 0)) {
    const cost = dollars((input + (count(tool) ? tool : 0)) * INPUT_NANO + (output + thinking) * OUTPUT_NANO);
    return { ...unknown, kind: 'usage-estimate', usageEstimateUsd: cost, estimateUsd: cost, basis: 'itemized' };
  }
  return { ...unknown, kind: 'aggregate-upper-estimate', estimateUsd: dollars(total * OUTPUT_NANO), basis: 'total-at-output-rate' };
}

/** Compatibility for callers distinguishing fully itemized usage from unknown
 * components. Aggregate estimates must not become a complete display breakdown. */
export function vertexUsageCostUsd(usage: UsageMetadata | undefined): number | null {
  return assessVertexUsage(usage).usageEstimateUsd;
}

/** Planning reserve, NOT a verified tokenizer or thinking-inclusive billing cap. */
export function vertexCallReserveUsd(inputBytes: number, outputTokens: number): number {
  if (!count(inputBytes) || !count(outputTokens)) throw new Error('Invalid Vertex reservation limits');
  return dollars(inputBytes * INPUT_NANO + (THINKING_RESERVE + outputTokens) * OUTPUT_NANO);
}
export type VertexBudgetSnapshot = {
  kind: 'usage-estimates-and-reservations'; limitUsd: number; accountedUsd: number;
  usageEstimateUsd: number; aggregateUpperEstimateUsd: number; reservedUsd: number; callsReserved: number;
  callsWithCompleteUsage: number; callsWithAggregateEstimate: number; callsWithUnknownUsage: number; callsPending: number; callsNotSent: number;
  nextCallReserveUsd: number; scope: 'this-provider-instance'; hardBillingCap: false;
};

/** This instance guard is not restart protection. The durable trial permit
 * ledger owns whole-trial admission; both reservations represent the SAME cost. */
export class VertexBudget {
  private entries: { state: 'pending' | 'usage' | 'aggregate' | 'unknown' | 'not-sent'; nano: number }[] = [];
  private readonly limitNano: number;
  private readonly reserveNano: number;
  constructor(limitUsd: number, inputBytes: number, outputTokens: number) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 100) throw new Error('Invalid Vertex model budget');
    this.limitNano = Math.floor(limitUsd * NANO_PER_USD);
    this.reserveNano = Math.round(vertexCallReserveUsd(inputBytes, outputTokens) * NANO_PER_USD);
  }
  reserve(): number {
    const total = this.entries.reduce((sum, item) => sum + item.nano, 0);
    if (total + this.reserveNano > this.limitNano) throw new AppError('model_budget_limit', 'モデル費用の管理上限に達する見込みのため、次の呼び出しを停止しました。現在の設計は保持しています。');
    this.entries.push({ state: 'pending', nano: this.reserveNano });
    return this.entries.length - 1;
  }
  releaseNotSent(ticket: number): void {
    const entry = this.entries[ticket];
    if (entry?.state === 'pending') { entry.state = 'not-sent'; entry.nano = 0; }
  }
  settle(ticket: number, usage?: unknown): void {
    const entry = this.entries[ticket];
    if (!entry || entry.state !== 'pending') return;
    const cost = assessVertexUsage(usage);
    if (cost.estimateUsd === null) entry.state = 'unknown';
    else { entry.state = cost.kind === 'usage-estimate' ? 'usage' : 'aggregate'; entry.nano = Math.round(cost.estimateUsd * NANO_PER_USD); }
  }
  snapshot(): VertexBudgetSnapshot {
    const sum = (states: string[]) => this.entries.filter(item => states.includes(item.state)).reduce((total, item) => total + item.nano, 0);
    const num = (state: string) => this.entries.filter(item => item.state === state).length;
    const usageNano = sum(['usage']), upperNano = sum(['aggregate']), reservedNano = sum(['pending', 'unknown']);
    return { kind: 'usage-estimates-and-reservations', limitUsd: dollars(this.limitNano), accountedUsd: dollars(usageNano + upperNano + reservedNano), usageEstimateUsd: dollars(usageNano), aggregateUpperEstimateUsd: dollars(upperNano), reservedUsd: dollars(reservedNano), callsReserved: this.entries.length, callsWithCompleteUsage: num('usage'), callsWithAggregateEstimate: num('aggregate'), callsWithUnknownUsage: num('unknown'), callsPending: num('pending'), callsNotSent: num('not-sent'), nextCallReserveUsd: dollars(this.reserveNano), scope: 'this-provider-instance', hardBillingCap: false };
  }
}
