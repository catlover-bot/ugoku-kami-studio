/** Local trial accounting only. No network, credentials, provider SDK or cloud storage.
 * A held grant is not a bill. Closure verification belongs to the trusted runner.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const Nano = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().min(1).max(200);
const BindingSchema = z.object({ sessionId: Id, baseRevision: z.number().int().positive(), baseHash: Hash, sourceSha: z.string().regex(/^[a-f0-9]{40}$/), revision: Id }).strict();
const PhaseSchema = z.enum(['cancel', 'recovery', 'infeasible']);
const BudgetSchema = z.object({ grossLimitNanoUsd: Nano, modelPoolNanoUsd: Nano, priorInfrastructureNanoUsd: Nano, additionalInfrastructureNanoUsd: Nano, safetyNanoUsd: Nano, callReserveNanoUsd: Nano, maxRequests: z.literal(4), maxCalls: z.literal(24) }).strict();
const HistorySchema = z.object({ requestId: Id, reservationId: Id, runId: Id, sourceSha: z.string().regex(/^[a-f0-9]{40}$/), originalLedgerHash: Hash, evidenceHashes: z.array(Hash).min(1), reservedCalls: z.number().int().min(1).max(6), sentUnknownCalls: z.number().int().min(0).max(6), priorRunSeconds: z.number().nonnegative(), priorBuildSeconds: z.number().nonnegative() }).strict();
const InitialSchema = z.object({ trialId: Id, budget: BudgetSchema, historicalReconciliation: HistorySchema }).strict();
const RequestSchema = z.object({ requestId: Id, phase: PhaseSchema, maxCalls: z.number().int().min(1).max(6), binding: BindingSchema }).strict();
const GrantSchema = RequestSchema.extend({ grantId: z.string().uuid(), callIds: z.array(z.string().uuid()).min(1).max(6), priorCommittedNanoUsd: Nano, reservedNanoUsd: Nano });
const CostSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('sent-unknown') }).strict(), z.object({ kind: z.enum(['usage-estimate', 'aggregate-upper-estimate']), usd: z.number().finite().nonnegative() }).strict()]);
const AttemptSchema = z.object({ attemptId: z.string().uuid(), dispatch: z.enum(['sent', 'possibly-sent']), cost: CostSchema, observationHashes: z.array(Hash).min(1) }).strict();
const ReportSchema = z.object({ requestId: Id, grantId: z.string().uuid(), binding: BindingSchema, dispatchClosed: z.literal(true), completeAttemptList: z.literal(true), sdkFetchRetryGuard: z.literal(1), serverIdentity: Id, proofHashes: z.array(Hash).min(1), attempts: z.array(AttemptSchema).max(6) }).strict();
const RejectionSchema = z.object({ requestId: Id, grantId: z.string().uuid(), binding: BindingSchema, httpStatus: z.literal(429), errorCode: z.literal('instance_limit'), classification: z.literal('audited-before-run-rejection'), proofHashes: z.array(Hash).min(1), serverIdentity: Id }).strict();
const EventSchema = z.object({ version: z.literal(1), sequence: z.number().int().nonnegative(), previousHash: Hash.nullable(), at: z.string().datetime(), type: z.enum(['initialize', 'reserve', 'forward', 'reconcile', 'close-unforwarded', 'reject-before-run']), payload: z.unknown(), hash: Hash }).strict();
export type LedgerInitial = z.infer<typeof InitialSchema>;
export type TrialBinding = z.infer<typeof BindingSchema>;
export type TrialPhase = z.infer<typeof PhaseSchema>;
export type ReserveRequest = z.infer<typeof RequestSchema>;
export type TrialGrant = z.infer<typeof GrantSchema>;
export type ClosureReport = z.infer<typeof ReportSchema>;
export type VerifyClosure = (report: Readonly<ClosureReport>, grant: Readonly<TrialGrant>) => boolean;
export type RejectedRequestReport = z.infer<typeof RejectionSchema>;
export type VerifyRejectedRequest = (report: Readonly<RejectedRequestReport>, grant: Readonly<TrialGrant>) => boolean;
type Call = { id: string; state: 'reserved-not-sent' | 'possibly-sent' | 'sent-unknown' | 'usage-estimate' | 'aggregate-upper-estimate' | 'released-not-sent'; committedNanoUsd: number };
type StoredGrant = { grant: TrialGrant; forwarded: boolean; closed: boolean; calls: Call[]; closure?: ClosureReport; rejection?: RejectedRequestReport; localClosureReason?: string };
type State = { initial: LedgerInitial; grants: StoredGrant[] };
type Event = z.infer<typeof EventSchema>;
const clone = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const checkedSum = (values: number[]): number => { const total = values.reduce((sum, n) => sum + n, 0); if (!Number.isSafeInteger(total)) throw Error('Accounting overflow'); return total; };
const nanoUsd = (usd: number): number => { const scaled = usd * 1e9, rounded = Math.round(scaled); if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.000001) throw Error('Cost precision exceeds nanodollars'); return rounded; };
function committed(state: State): number { return checkedSum([state.initial.historicalReconciliation.sentUnknownCalls * state.initial.budget.callReserveNanoUsd, ...state.grants.flatMap(g => g.calls.map(c => c.committedNanoUsd))]); }
function validateInitial(input: unknown): LedgerInitial {
  const initial = InitialSchema.parse(input), { budget: b, historicalReconciliation: h } = initial;
  if (h.sentUnknownCalls > h.reservedCalls || !b.callReserveNanoUsd || !b.modelPoolNanoUsd) throw Error('Invalid historical reservation');
  if (checkedSum([b.modelPoolNanoUsd, b.priorInfrastructureNanoUsd, b.additionalInfrastructureNanoUsd, b.safetyNanoUsd]) > b.grossLimitNanoUsd) throw Error('Cumulative budget exceeds gross limit');
  if (h.sentUnknownCalls * b.callReserveNanoUsd > b.modelPoolNanoUsd || h.priorRunSeconds > 7200 || h.priorBuildSeconds > 3600) throw Error('Prior trial already exceeds bounds');
  return initial;
}
function validateReservation(state: State, request: ReserveRequest) {
  if (request.requestId === state.initial.historicalReconciliation.requestId) throw Error('Historical request ID cannot be reused');
  const b = state.initial.budget, phases: TrialPhase[] = ['cancel', 'recovery', 'infeasible'];
  if (state.grants.length + 1 >= b.maxRequests || request.phase !== phases[state.grants.length]) throw Error('Request/phase limit or order');
  if (state.grants.some(g => !g.closed)) throw Error('Previous dispatch is not verified closed');
  const cap = request.phase === 'cancel' ? 1 : request.phase === 'recovery' ? 3 : 6;
  if (request.maxCalls > cap) throw Error('Phase call cap exceeded');
  if (state.initial.historicalReconciliation.sentUnknownCalls + state.grants.reduce((n, g) => n + g.grant.maxCalls, 0) + request.maxCalls > b.maxCalls) throw Error('Cumulative call permits exceeded');
  const remainingPhases = request.phase === 'cancel' ? 2 : request.phase === 'recovery' ? 1 : 0;
  if (checkedSum([committed(state), (request.maxCalls + remainingPhases) * b.callReserveNanoUsd]) > b.modelPoolNanoUsd) throw Error('Request would consume the later-phase minimum or exceed model pool');
}
function transition(prior: State | undefined, type: Event['type'], payload: unknown): State {
  if (type === 'initialize') { if (prior) throw Error('Duplicate initialization'); return { initial: validateInitial(payload), grants: [] }; }
  if (!prior) throw Error('Missing initial event');
  const state = clone(prior);
  if (type === 'reserve') {
    const g = GrantSchema.parse(payload);
    if (state.grants.some(x => x.grant.requestId === g.requestId || x.grant.grantId === g.grantId)) throw Error('Duplicate grant');
    validateReservation(state, RequestSchema.parse({ requestId: g.requestId, phase: g.phase, maxCalls: g.maxCalls, binding: g.binding }));
    if (g.callIds.length !== g.maxCalls || new Set(g.callIds).size !== g.callIds.length || state.grants.some(x => x.grant.callIds.some(id => g.callIds.includes(id)))) throw Error('Duplicate or missing call permits');
    if (g.priorCommittedNanoUsd !== committed(state) || g.reservedNanoUsd !== g.maxCalls * state.initial.budget.callReserveNanoUsd) throw Error('Reservation amount mismatch');
    state.grants.push({ grant: g, forwarded: false, closed: false, calls: g.callIds.map(id => ({ id, state: 'reserved-not-sent', committedNanoUsd: state.initial.budget.callReserveNanoUsd })) }); return state;
  }
  if (type === 'forward') {
    const p = z.object({ requestId: Id, grantId: z.string().uuid() }).strict().parse(payload), g = state.grants.find(x => x.grant.requestId === p.requestId);
    if (!g || g.grant.grantId !== p.grantId || g.forwarded || g.closed) throw Error('Invalid forward event');
    g.forwarded = true; g.calls.forEach(c => { c.state = 'possibly-sent'; }); return state;
  }
  if (type === 'close-unforwarded') {
    const p = z.object({ requestId: Id, grantId: z.string().uuid(), reason: z.string().min(1).max(200) }).strict().parse(payload), g = state.grants.find(x => x.grant.requestId === p.requestId);
    if (!g || g.grant.grantId !== p.grantId || g.forwarded || g.closed) throw Error('Cannot locally release a forwarded request');
    g.closed = true; g.localClosureReason = p.reason; g.calls.forEach(c => { c.state = 'released-not-sent'; c.committedNanoUsd = 0; }); return state;
  }
  if (type === 'reject-before-run') {
    const report = RejectionSchema.parse(payload), g = state.grants.find(x => x.grant.requestId === report.requestId);
    if (!g || g.grant.grantId !== report.grantId || !g.forwarded || g.closed || !same(g.grant.binding, report.binding)) throw Error('Before-run rejection binding/state mismatch');
    g.closed = true; g.rejection = report;
    g.calls.forEach(c => { c.state = 'released-not-sent'; c.committedNanoUsd = 0; }); return state;
  }
  const report = ReportSchema.parse(payload), g = state.grants.find(x => x.grant.requestId === report.requestId);
  if (!g || g.grant.grantId !== report.grantId || !g.forwarded || g.closed || !same(g.grant.binding, report.binding)) throw Error('Closure binding/state mismatch');
  if (new Set(report.attempts.map(a => a.attemptId)).size !== report.attempts.length || report.attempts.some(a => !g.grant.callIds.includes(a.attemptId))) throw Error('Attempt not covered by unique permit');
  for (const c of g.calls) {
    const attempt = report.attempts.find(a => a.attemptId === c.id);
    if (!attempt) { c.state = 'released-not-sent'; c.committedNanoUsd = 0; }
    else if (attempt.dispatch === 'possibly-sent' && attempt.cost.kind !== 'sent-unknown') throw Error('Uncertain dispatch cannot settle usage');
    else { c.state = attempt.cost.kind; c.committedNanoUsd = attempt.cost.kind === 'sent-unknown' ? state.initial.budget.callReserveNanoUsd : nanoUsd(attempt.cost.usd); }
  }
  g.closed = true; g.closure = report;
  // Actual observed estimates may exceed their original reserve; retain them and block subsequent work.
  committed(state); return state;
}
function syncDirectory(path: string) { const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function writeAll(fd: number, bytes: Buffer) { for (let offset = 0; offset < bytes.length;) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (!n) throw Error('Short ledger write'); offset += n; } }
const LockSchema = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).strict();

export class Ledger {
  private state!: State;
  private events: Event[] = [];
  private fd: number | undefined;
  private poisoned = false;
  private ownsLock = false;
  private readonly lockToken = randomUUID();
  private constructor(readonly path: string) {}
  private lock() {
    const fd = openSync(this.path + '.lock', 'wx', 0o600); this.ownsLock = true;
    try { writeAll(fd, Buffer.from(JSON.stringify({ pid: process.pid, token: this.lockToken }) + '\n')); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(this.path);
  }
  static create(path: string, initial: LedgerInitial): Ledger {
    const valid = validateInitial(initial), ledger = new Ledger(resolve(path)); mkdirSync(dirname(ledger.path), { recursive: true, mode: 0o700 }); ledger.lock();
    try { ledger.fd = openSync(ledger.path, 'ax', 0o600); syncDirectory(ledger.path); ledger.append('initialize', valid); return ledger; }
    catch (error) { ledger.close(); throw error; }
  }
  static open(path: string): Ledger {
    const ledger = new Ledger(resolve(path)); ledger.lock();
    try {
      const text = readFileSync(ledger.path, 'utf8');
      if (!text || !text.endsWith('\n')) throw Error('Empty or torn ledger; fail closed');
      for (const line of text.slice(0, -1).split('\n')) {
        const event = EventSchema.parse(JSON.parse(line)), { hash, ...body } = event;
        if (event.sequence !== ledger.events.length || event.previousHash !== (ledger.events.at(-1)?.hash ?? null) || digest(body) !== hash) throw Error('Ledger hash chain mismatch');
        ledger.state = transition(ledger.events.length ? ledger.state : undefined, event.type, event.payload); ledger.events.push(event);
      }
      ledger.fd = openSync(ledger.path, 'a'); return ledger;
    } catch (error) { ledger.close(); throw error; }
  }
  /** Explicit local recovery only: a live/reused PID or mismatched token always blocks. */
  static clearAbandonedLock(path: string, expected: { pid: number; token: string }): void {
    const target = resolve(path), lock = LockSchema.parse(JSON.parse(readFileSync(target + '.lock', 'utf8')));
    if (!same(lock, expected)) throw Error('Lock provenance mismatch');
    try { process.kill(lock.pid, 0); throw Error('Writer is still alive'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (!same(JSON.parse(readFileSync(target + '.lock', 'utf8')), lock)) throw Error('Lock changed');
    unlinkSync(target + '.lock'); syncDirectory(target);
  }
  private assertOpen() { if (this.fd === undefined || this.poisoned) throw Error('Ledger closed or write uncertain; reopen and verify before further work'); }
  private append(type: Event['type'], payload: unknown) {
    this.assertOpen(); const state = transition(this.events.length ? this.state : undefined, type, payload);
    const body = { version: 1 as const, sequence: this.events.length, previousHash: this.events.at(-1)?.hash ?? null, at: new Date().toISOString(), type, payload: clone(payload) };
    const event: Event = { ...body, hash: digest(body) };
    try { writeAll(this.fd!, Buffer.from(canonical(event) + '\n')); fsyncSync(this.fd!); syncDirectory(this.path); }
    catch (error) { this.poisoned = true; throw error; }
    this.events.push(event); this.state = state;
  }
  getSnapshot() {
    this.assertOpen(); const b = this.state.initial.budget, amount = committed(this.state);
    return clone({ trialId: this.state.initial.trialId, headHash: this.events.at(-1)!.hash, eventCount: this.events.length, budget: b,
      committedNanoUsd: amount, remainingModelNanoUsd: b.modelPoolNanoUsd - amount, grossCommittedAndInfraNanoUsd: checkedSum([amount, b.priorInfrastructureNanoUsd, b.additionalInfrastructureNanoUsd, b.safetyNanoUsd]),
      requestsConsumed: 1 + this.state.grants.length, callPermitsConsumed: this.state.initial.historicalReconciliation.sentUnknownCalls + this.state.grants.reduce((n, g) => n + g.grant.maxCalls, 0),
      historicalReconciliation: this.state.initial.historicalReconciliation, historicalAmounts: { reservedBeforeNanoUsd: this.state.initial.historicalReconciliation.reservedCalls * b.callReserveNanoUsd, retainedSentUnknownNanoUsd: this.state.initial.historicalReconciliation.sentUnknownCalls * b.callReserveNanoUsd, releasedNotSentNanoUsd: (this.state.initial.historicalReconciliation.reservedCalls - this.state.initial.historicalReconciliation.sentUnknownCalls) * b.callReserveNanoUsd }, grants: this.state.grants });
  }
  reserveRequest(input: ReserveRequest): TrialGrant {
    this.assertOpen(); const request = RequestSchema.parse(input), prior = this.state.grants.find(g => g.grant.requestId === request.requestId);
    if (prior) { if (!same(request, { requestId: prior.grant.requestId, phase: prior.grant.phase, maxCalls: prior.grant.maxCalls, binding: prior.grant.binding })) throw Error('Conflicting duplicate request'); return clone(prior.grant); }
    validateReservation(this.state, request);
    const grant = { ...request, grantId: randomUUID(), callIds: Array.from({ length: request.maxCalls }, () => randomUUID()), priorCommittedNanoUsd: committed(this.state), reservedNanoUsd: request.maxCalls * this.state.initial.budget.callReserveNanoUsd };
    this.append('reserve', grant); return clone(grant);
  }
  markForwarded(input: { requestId: string; grantId: string }): boolean {
    this.assertOpen(); const prior = this.state.grants.find(g => g.grant.requestId === input.requestId);
    if (prior?.grant.grantId === input.grantId && prior.forwarded) return false; // No second forward authority is issued.
    this.append('forward', { requestId: input.requestId, grantId: input.grantId }); return true;
  }
  closeUnforwarded(input: { requestId: string; grantId: string; reason: string }) {
    this.assertOpen(); const prior = this.state.grants.find(g => g.grant.requestId === input.requestId);
    if (prior?.closed && prior.grant.grantId === input.grantId && prior.localClosureReason === input.reason) return;
    this.append('close-unforwarded', { requestId: input.requestId, grantId: input.grantId, reason: input.reason });
  }
  reconcile(input: ClosureReport, verifyClosure: VerifyClosure) {
    this.assertOpen(); const report = ReportSchema.parse(input), prior = this.state.grants.find(g => g.grant.requestId === report.requestId);
    if (prior?.closure) { if (same(prior.closure, report)) return; throw Error('Conflicting duplicate settlement'); }
    if (!prior || verifyClosure(clone(report), clone(prior.grant)) !== true) throw Error('Authenticated closure proof rejected');
    this.append('reconcile', report);
  }
  /** Separate from a run closure: no run ID or dispatchClosed is fabricated.
   * The trusted audit must establish this exact source rejected the HTTP start
   * BEFORE creating a run. HTTP 429 alone is insufficient. Request/call permits
   * stay consumed, and all original reserve/forward evidence stays appended. */
  reconcileRejectedRequest(input: RejectedRequestReport, verify: VerifyRejectedRequest) {
    this.assertOpen(); const report = RejectionSchema.parse(input), prior = this.state.grants.find(g => g.grant.requestId === report.requestId);
    if (!prior || typeof verify !== 'function' || verify(clone(report), clone(prior.grant)) !== true) throw Error('Audited before-run rejection proof rejected');
    if (prior.rejection) { if (same(prior.rejection, report)) return; throw Error('Conflicting duplicate rejection settlement'); }
    this.append('reject-before-run', report);
  }
  close() {
    if (!this.ownsLock) return;
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
    if (existsSync(this.path + '.lock')) {
      const lock = LockSchema.parse(JSON.parse(readFileSync(this.path + '.lock', 'utf8')));
      if (lock.token !== this.lockToken || lock.pid !== process.pid) throw Error('Writer lock changed; preserve it');
      unlinkSync(this.path + '.lock'); syncDirectory(this.path); this.ownsLock = false;
    }
  }
}
