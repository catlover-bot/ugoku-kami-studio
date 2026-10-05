/** Pure validation of an authenticated trial response. Never fetches, signs,
 * changes a ledger, or treats the model's text as accounting evidence. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ClosureReport, TrialGrant } from './trial-ledger.js';

const MODEL = 'gemini-3.8-flash';
const RATE = 'vertex-global-standard-conservative-2026-10-05';
const HASH = /^[a-f0-9]{64}$/;
const date = z.string().datetime();
const count = z.number().int().nonnegative();
const object = z.record(z.string(), z.unknown());
const Meter = z.object({ call: count.positive(), attemptId: z.string().uuid(), received: z.boolean(),
  dispatch: z.object({ attemptId: z.string().uuid(), startedAt: date, transport: z.literal('vertex-http'), sdkRetryAttempts: z.literal(1) }).strict().optional(),
  observations: z.array(object).max(2),
}).passthrough();
const Run = z.object({ id: z.string().uuid(), requestId: z.string(), baseHash: z.string(), baseRevision: count.positive(),
  provider: z.literal('vertex'), mode: z.literal('vertex'), model: z.literal(MODEL),
  status: z.enum(['running', 'awaiting_approval', 'clarification_required', 'succeeded', 'failed', 'cancelled']),
  dispatchClosed: z.boolean(), dispatchClosedAt: date.optional(), modelCalls: count.max(6), modelUsage: z.array(Meter).max(6),
  trialDispatch: z.object({ permitId: z.string().uuid(), callIds: z.array(z.string().uuid()).min(1).max(6), sourceSha: z.string(), sessionId: z.string(), sdkRetryAttempts: z.literal(1) }).strict(),
}).passthrough();
type Assessment = { kind: 'usage-estimate' | 'aggregate-upper-estimate' | 'sent-unknown'; estimateUsd: number | null; usageEstimateUsd: number | null; basis: string; rateBasis: string; billingActual: false };
export type AssessTrialUsage = (usage: unknown) => Assessment;
export type ResponseEvidence = { authenticatedHttps: true; origin: string; sourceSha: string; revision: string; sessionId: string; runId?: string; responseSha256: string; deploymentProofSha256: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unknownCost = { kind: 'sent-unknown' as const };
const usageNames = ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount', 'cachedContentTokenCount', 'toolUsePromptTokenCount'] as const;

function observedCost(observation: Record<string, unknown>, assess: AssessTrialUsage): { kind: 'usage-estimate' | 'aggregate-upper-estimate'; nano: number } | null {
  const d = object.safeParse(observation.usageDiagnostics), c = object.safeParse(observation.modelCost);
  if (!d.success || !c.success) return null;
  const diagnostics = d.data, cost = c.data;
  if (diagnostics.metadataPresent !== true || diagnostics.metadataState !== 'present' || !same(diagnostics.invalidFields, []) || !same(diagnostics.inconsistencies, [])) return null;
  if (diagnostics.source !== (observation.source === 'http-response' ? 'http-usage-metadata' : 'sdk-usage-metadata')) return null;
  const fields = object.safeParse(diagnostics.fields), observed = object.safeParse(diagnostics.observed);
  if (!fields.success || !observed.success || Object.keys(observed.data).some(key => !(usageNames as readonly string[]).includes(key))) return null;
  const raw: Record<string, unknown> = {};
  for (const name of usageNames) {
    const field = object.safeParse(fields.data[name]); if (!field.success) return null;
    const { state, value } = field.data;
    if (state === 'zero' || state === 'value') {
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (state === 'zero') !== (value === 0) || observed.data[name] !== value) return null;
      raw[name] = value;
    } else if ((state === 'missing' || state === 'null') && value === undefined && observed.data[name] === undefined) {
      if (state === 'null') raw[name] = null;
    } else return null;
  }
  const calculated = assess(raw);
  if (calculated.kind === 'sent-unknown' || calculated.estimateUsd === null || !Number.isFinite(calculated.estimateUsd) || calculated.estimateUsd < 0 || calculated.rateBasis !== RATE || calculated.billingActual !== false || cost.reservationUsd !== 0.556032) return null;
  for (const key of ['kind', 'estimateUsd', 'usageEstimateUsd', 'basis', 'rateBasis', 'billingActual'] as const) if (calculated[key] !== cost[key]) return null;
  const nano = Math.ceil(calculated.estimateUsd * 1e9); // Conservative rounding, never downward.
  return Number.isSafeInteger(nano) ? { kind: calculated.kind, nano } : null;
}

/** Caller supplies provenance only after its own single authenticated HTTPS
 * fetch to the pinned service. A request/body cannot supply this evidence.
 * Closure of dispatch does not prove remote computation or billing stopped. */
export function trialClosureFromResponse(bytes: Uint8Array, grant: TrialGrant, evidence: ResponseEvidence, assess: AssessTrialUsage): ClosureReport | null {
  const origin = new URL(evidence.origin);
  if (evidence.authenticatedHttps !== true || origin.protocol !== 'https:' || !origin.hostname.endsWith('.run.app') || origin.origin !== evidence.origin || !HASH.test(evidence.responseSha256) || !HASH.test(evidence.deploymentProofSha256) || createHash('sha256').update(bytes).digest('hex') !== evidence.responseSha256) throw Error('Unverified response provenance');
  if (evidence.sourceSha !== grant.binding.sourceSha || evidence.revision !== grant.binding.revision || evidence.sessionId !== grant.binding.sessionId) throw Error('Deployment/session evidence mismatch');
  const envelope = object.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  const run = Run.parse(envelope.run), dispatch = run.trialDispatch;
  if (run.requestId !== grant.requestId || run.baseHash !== grant.binding.baseHash || run.baseRevision !== grant.binding.baseRevision || (evidence.runId !== undefined && evidence.runId !== run.id)) throw Error('Run base/request mismatch');
  if (dispatch.permitId !== grant.grantId || dispatch.sessionId !== grant.binding.sessionId || dispatch.sourceSha !== grant.binding.sourceSha || !same(dispatch.callIds, grant.callIds)) throw Error('Run permit mismatch');
  if (run.status === 'running' || run.dispatchClosed !== true) return null;
  if (!run.dispatchClosedAt || run.modelCalls !== run.modelUsage.length || run.modelCalls > grant.maxCalls) throw Error('Incomplete attempt list/closure');
  const attempts: ClosureReport['attempts'] = [];
  for (let index = 0; index < run.modelUsage.length; index++) {
    const meter = run.modelUsage[index];
    if (meter.call !== index + 1 || meter.attemptId !== grant.callIds[index]) throw Error('Attempt order/identity mismatch');
    if (!meter.dispatch) {
      if (meter.received || meter.observations.length || index !== run.modelUsage.length - 1) throw Error('Response without dispatch or nonterminal unsent attempt');
      continue;
    }
    if (meter.dispatch.attemptId !== meter.attemptId || Date.parse(meter.dispatch.startedAt) > Date.parse(run.dispatchClosedAt)) throw Error('Dispatch identity/time mismatch');
    const observationHashes: string[] = [], costs: ({ kind: 'usage-estimate' | 'aggregate-upper-estimate'; nano: number } | null)[] = [];
    const numericObservations = new Map<string, number>(); let contradictoryNumbers = false;
    for (let i = 0; i < meter.observations.length; i++) {
      const observation = meter.observations[i];
      if (observation.attemptId !== meter.attemptId || observation.call !== meter.call || observation.sdkVersion !== '2.27.0' || observation.model !== MODEL || observation.source !== (i === 0 ? 'http-response' : 'sdk-response') || !date.safeParse(observation.observedAt).success || typeof observation.aborted !== 'boolean') throw Error('Observation binding/order mismatch');
      const diagnostics = object.safeParse(observation.usageDiagnostics);
      const observed = object.safeParse(diagnostics.success ? diagnostics.data.observed : undefined);
      if (observed.success) for (const name of usageNames) {
        const value = observed.data[name];
        if (typeof value === 'number' && Number.isFinite(value)) {
          if (numericObservations.has(name) && numericObservations.get(name) !== value) contradictoryNumbers = true;
          numericObservations.set(name, value);
        }
      }
      observationHashes.push(hash(observation)); costs.push(observedCost(observation, assess));
    }
    if (meter.received && meter.observations.length !== 2) throw Error('Received SDK response missing observations');
    const known = !contradictoryNumbers && costs.length > 0 && costs.every(value => value !== null);
    const max = known ? costs.reduce((a, b) => a!.nano >= b!.nano ? a : b)! : null;
    attempts.push({ attemptId: meter.attemptId, dispatch: meter.observations.length ? 'sent' : 'possibly-sent',
      cost: max ? { kind: max.kind, usd: max.nano / 1e9 } : unknownCost,
      observationHashes: observationHashes.length ? observationHashes : [hash(meter.dispatch)],
    });
  }
  return { requestId: grant.requestId, grantId: grant.grantId, binding: structuredClone(grant.binding), dispatchClosed: true, completeAttemptList: true, sdkFetchRetryGuard: 1,
    serverIdentity: `${evidence.origin}/${evidence.revision}/${run.id}`, proofHashes: [evidence.responseSha256, evidence.deploymentProofSha256], attempts };
}
