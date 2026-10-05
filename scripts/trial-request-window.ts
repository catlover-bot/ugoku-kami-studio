/** Private sequential trial scheduling only. An accepted POST creates a run
 * and consumes a start even if that run later fails or is cancelled. These are
 * browser response-receipt times, never server starts or model completion times.
 * Use one clock throughout and retain its previous reading to detect reversal.
 * A zero wait grants no concurrency, budget, lifetime, retry or request permit. */
export type TrialRequestWindowInput = {
  nowMs: number;
  previousNowMs: number;
  acceptedRequestIds: string[];
  acknowledgements: { requestId: string; runId: string; receivedAtMs: number }[];
};
const LIMIT = 2, WINDOW_MS = 60_000, MARGIN_MS = 1_000;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

export function nextTrialRequestWindow(input: TrialRequestWindowInput) {
  if (!input || !timestamp(input.nowMs) || !timestamp(input.previousNowMs) || input.nowMs < input.previousNowMs) throw Error('Missing, invalid or reversed trial clock');
  const { acceptedRequestIds: ids, acknowledgements: acks, nowMs } = input;
  if (!Array.isArray(ids) || !Array.isArray(acks) || ids.length > 3 || ids.length !== acks.length || ids.some(value => !id(value)) || new Set(ids).size !== ids.length) throw Error('Incomplete accepted-request records');
  const runs = new Set<string>();
  for (let i = 0; i < acks.length; i++) {
    const ack = acks[i];
    if (!ack || ack.requestId !== ids[i] || !id(ack.runId) || runs.has(ack.runId) || !timestamp(ack.receivedAtMs) || ack.receivedAtMs > nowMs || (i > 0 && ack.receivedAtMs < acks[i - 1].receivedAtMs)) throw Error('Missing or inconsistent start acknowledgement');
    runs.add(ack.runId);
  }
  // The driver is sequential. Ambiguous history is stopped conservatively;
  // response receipt alone is not evidence of the server's exact start time.
  if (acks.length === 3 && acks[2].receivedAtMs - acks[0].receivedAtMs < WINDOW_MS) throw Error('Accepted acknowledgement window cannot be safely established');
  const threshold = acks.length < LIMIT ? nowMs : acks[acks.length - LIMIT].receivedAtMs + WINDOW_MS + MARGIN_MS;
  if (!timestamp(threshold)) throw Error('Trial clock arithmetic overflow');
  const notBeforeMs = Math.max(nowMs, threshold);
  return { waitMs: notBeforeMs - nowMs, notBeforeMs, windowLimit: LIMIT as 2, windowMs: WINDOW_MS as 60_000, safetyMarginMs: MARGIN_MS as 1_000 };
}
