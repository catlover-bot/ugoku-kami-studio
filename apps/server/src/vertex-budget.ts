import type { UsageMetadata } from './conversation.js';
import { AppError } from './errors.js';

// Standard (pre-credit) USD: input 1.50 / 1M, output + reasoning 7.50 / 1M.
// Integer nanodollars avoid cumulative floating-point rounding down.
const INPUT_NANO = 1500, OUTPUT_NANO = 7500, NANO_PER_USD = 1_000_000_000;
const THINKING_RESERVE = 65_536;
const dollars = (nano: number) => nano / NANO_PER_USD;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000_000;

/** Planning reserve, NOT a verified tokenizer or thinking-inclusive billing cap. */
export function vertexCallReserveUsd(inputBytes: number, outputTokens: number): number {
  if (!count(inputBytes) || !count(outputTokens)) throw new Error('Invalid Vertex reservation limits');
  return dollars(inputBytes * INPUT_NANO + (THINKING_RESERVE + outputTokens) * OUTPUT_NANO);
}

/** Missing/inconsistent usage remains unknown. Never treat absent thinking as zero.
 * Cached input gets no discount. Unclassified total tokens get the higher output rate. */
export function vertexUsageCostUsd(usage: UsageMetadata | undefined): number | null {
  if (!usage) return null;
  const { promptTokenCount: input, candidatesTokenCount: output, thoughtsTokenCount: thinking, totalTokenCount: total } = usage;
  if (!count(input) || input === 0 || !count(output) || !count(thinking) || !count(total) || total < input + output + thinking) return null;
  if (usage.cachedContentTokenCount !== undefined && (!count(usage.cachedContentTokenCount) || usage.cachedContentTokenCount > input)) return null;
  if (usage.toolUsePromptTokenCount !== undefined && !count(usage.toolUsePromptTokenCount)) return null;
  // Charge any extra reported tool-prompt tokens conservatively, even if the
  // service already included them in promptTokenCount/totalTokenCount.
  return dollars((input + (usage.toolUsePromptTokenCount ?? 0)) * INPUT_NANO + (total - input) * OUTPUT_NANO);
}

export type VertexBudgetSnapshot = {
  kind: 'usage-estimates-and-reservations'; limitUsd: number; accountedUsd: number;
  usageEstimateUsd: number; reservedUsd: number; callsReserved: number;
  callsWithCompleteUsage: number; callsWithUnknownUsage: number; callsPending: number;
  nextCallReserveUsd: number; scope: 'this-provider-instance'; hardBillingCap: false;
};

/** Shared across runs in one instance. The trial's durable outer ledger must also
 * reserve a whole run before dispatch; this RAM state is not restart protection. */
export class VertexBudget {
  private entries: { state: 'pending' | 'usage' | 'unknown'; nano: number }[] = [];
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
  settle(ticket: number, usage?: UsageMetadata): void {
    const entry = this.entries[ticket];
    if (!entry || entry.state !== 'pending') return;
    const cost = vertexUsageCostUsd(usage);
    if (cost === null) entry.state = 'unknown';
    else { entry.state = 'usage'; entry.nano = Math.round(cost * NANO_PER_USD); }
  }
  snapshot(): VertexBudgetSnapshot {
    const usageNano = this.entries.filter(item => item.state === 'usage').reduce((sum, item) => sum + item.nano, 0);
    const reservedNano = this.entries.filter(item => item.state !== 'usage').reduce((sum, item) => sum + item.nano, 0);
    return { kind: 'usage-estimates-and-reservations', limitUsd: dollars(this.limitNano), accountedUsd: dollars(usageNano + reservedNano), usageEstimateUsd: dollars(usageNano), reservedUsd: dollars(reservedNano), callsReserved: this.entries.length, callsWithCompleteUsage: this.entries.filter(item => item.state === 'usage').length, callsWithUnknownUsage: this.entries.filter(item => item.state === 'unknown').length, callsPending: this.entries.filter(item => item.state === 'pending').length, nextCallReserveUsd: dollars(this.reserveNano), scope: 'this-provider-instance', hardBillingCap: false };
  }
}
