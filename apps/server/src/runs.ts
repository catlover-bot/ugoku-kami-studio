import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { applyIntentPatch, assertRequestBinding, distanceTargetMm, InterpretationCorrectionSchema, interpretDesignRequest, interpretModelRequest, parseDesignDocument, validateDesign, type DesignDocument, type DesignPatch, type DesignIntent, type LockKey, type CheckResult, type InterpretationCorrection, type RequestInterpretation } from '@ugoku/core';
import type { ConversationMessage, ToolResult, LocalTiming, LocalModel, ModelCost } from './conversation.js';
import { vertexUsageCostUsd } from './vertex-budget.js';
import { OllamaProvider } from './ollama.js';
import type { ServerConfig } from './config.js';
import { AppError, publicError } from './errors.js';
import { assertModelInput, GeminiProvider, VertexProvider, type ModelProvider, type ProviderResponse } from './provider.js';
import type { Session } from './sessions.js';
import { modelInitialInput, modelToolResult } from './model-input.js';
import { executeTool, type ConstraintSuggestion, type ToolContext } from './tools.js';

const Correction = z.object({ runId: z.string().uuid(), requestId: z.string().min(8).max(100), changes: InterpretationCorrectionSchema }).strict();
const Request = z.object({ requestId: z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/), prompt: z.string().min(1).max(2000).refine(value => value.trim().length > 0), baseRevision: z.number().int().positive(), baseHash: z.string().min(8).max(128), correction: Correction.optional() }).strict();
const Approval = Request.omit({ prompt: true, correction: true });
type RunState = 'running' | 'awaiting_approval' | 'clarification_required' | 'succeeded' | 'failed' | 'cancelled';
export type PublicInterpretation = Pick<DesignIntent, 'binding' | 'interpretation' | 'clarifications' | 'summary' | 'approvalRequired'>;
function interpretationView(intent: DesignIntent): PublicInterpretation {
  return structuredClone({ binding: intent.binding, interpretation: intent.interpretation, clarifications: intent.clarifications, summary: intent.summary, approvalRequired: intent.approvalRequired });
}
type Event = { sequence: number; type: 'model' | 'tool' | 'validation'; tool?: string; message: string; designHash?: string; patch?: DesignPatch; checkStatuses?: { id: string; status: string }[]; durationMs: number };
export type Proposal = { id: string; requestId: string; baseRevision: number; baseHash: string; patch: DesignPatch; document: DesignDocument; addedLocks: LockKey[]; protectedConditions: string[]; requestedTravelMm?: number; fulfillsRequested: boolean };
export type TokenUsage = { promptTokens: number; outputTokens: number; thinkingTokens: number; cachedInputTokens: number; toolPromptTokens: number; totalTokens: number };
export type ModelUsage = { call: number; inputBytes: number; outputTokenLimit: number; durationMs: number; received: boolean; finishReason: string | null; modelVersion: string | null; usage: TokenUsage | null; usageComplete?: boolean; modelCost?: ModelCost; localTiming?: LocalTiming; localModel?: LocalModel };
function tokenUsage(usage: ProviderResponse['usageMetadata']): TokenUsage | null {
  if (!usage) return null;
  const count = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
  return { promptTokens: count(usage.promptTokenCount), outputTokens: count(usage.candidatesTokenCount), thinkingTokens: count(usage.thoughtsTokenCount), cachedInputTokens: count(usage.cachedContentTokenCount), toolPromptTokens: count(usage.toolUsePromptTokenCount), totalTokens: count(usage.totalTokenCount) };
}
export type Run = {
  id: string; requestId: string; baseRevision: number; baseHash: string; fingerprint: string;
  model: string; provider: 'none' | 'gemini' | 'ollama' | 'vertex'; mode: 'gemini' | 'ollama' | 'vertex' | 'injected-test'; modelUsage: ModelUsage[];
  prompt: string; authorCorrection?: InterpretationCorrection; interpretationProposal: RequestInterpretation;
  requestInterpretation: PublicInterpretation;
  intent: DesignIntent; intentSummary: { protections: string[]; notes: string[] };
  status: RunState; message: string; events: Event[]; proposal?: Proposal;
  validationIssues: CheckResult[];
  constraintSuggestions: ConstraintSuggestion[]; error?: { code: string; message: string };
  modelCalls: number; toolCalls: number; elapsedMs: number; usage: TokenUsage & { responsesWithUsage: number; responsesWithoutUsage: number };
  controller: AbortController; done?: Promise<void>;
};

export function publicRun(run: Run) {
  const { controller: _controller, done: _done, fingerprint: _fingerprint, intent: _intent, prompt: _prompt, authorCorrection: _authorCorrection, interpretationProposal: _interpretationProposal, ...result } = run;
  return structuredClone(result);
}

function protectionLabels(base: DesignDocument, intent: DesignIntent): string[] {
  const labels: Record<LockKey, string> = { widthMm: '作品の幅', heightMm: '作品の高さ', maxSheets: '厚紙の上限', direction: '動く方向', travelMm: '動く距離', selection: '選択領域', paperThicknessMm: '紙の厚さ', clearanceMm: 'すき間' };
  const directions = { right: '右', left: '左', up: '上', down: '下' };
  const protectedValues = { ...Object.fromEntries(base.input.locks.map(key => [key, base.input[key]])), ...intent.protections };
  return Object.entries(protectedValues).map(([key, value]) => {
    if (key === 'selection') return '選択領域を変更しない';
    if (key === 'direction') return `動く方向は${directions[value as keyof typeof directions]}`;
    return `${labels[key as LockKey]} ${String(value)}${key === 'maxSheets' ? '枚以内' : 'mmを維持'}`;
  });
}

function fulfillsInterpretation(base: DesignDocument, candidate: DesignDocument, intent: DesignIntent): boolean {
  const understood = intent.interpretation;
  if (!intent.supported || intent.conflicts.length || intent.clarifications.length || understood.unresolved.length || understood.mechanism !== 'single-pull-tab') return false;
  if (understood.direction.desired && candidate.input.direction !== understood.direction.desired || understood.direction.forbidden.includes(candidate.input.direction)) return false;
  const distance = understood.distance;
  if (distance.kind === 'qualitative') {
    if (distance.change === 'increase' ? candidate.input.travelMm <= base.input.travelMm : candidate.input.travelMm >= base.input.travelMm) return false;
  } else if (candidate.input.travelMm !== distanceTargetMm(base.input.travelMm, distance)) return false;
  if (understood.size === 'maintain' && (candidate.input.widthMm !== base.input.widthMm || candidate.input.heightMm !== base.input.heightMm)) return false;
  if (understood.paper.kind === 'maintain' && candidate.layout.sheets > base.layout.sheets) return false;
  if (understood.paper.kind === 'cap' && candidate.input.maxSheets > understood.paper.maxSheets) return false;
  return true;
}

function needsCandidate(base: DesignDocument, intent: DesignIntent): boolean {
  return Object.entries(intent.patch).some(([key, value]) => JSON.stringify(base.input[key as keyof DesignDocument['input']]) !== JSON.stringify(value)) || intent.addLocks.some(key => !base.input.locks.includes(key));
}

function assertCurrent(session: Session, revision: number, hash: string) {
  if (session.document.revision !== revision || session.document.designHash !== hash) throw new AppError('stale_design', '設計が更新されています。現在版からもう一度依頼してください。', 409);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true }); });
  try { return await Promise.race([promise, aborted]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}

export class RunManager {
  private active = 0;
  private starts: number[] = [];
  // Raw tool outcomes remain server-private for the lifetime of their session
  // run. Only the projected view crosses the provider boundary; neither history
  // is added to publicRun. Weak keys follow existing session expiry/cap limits.
  private histories = new WeakMap<Run, ConversationMessage[]>();
  constructor(private config: ServerConfig, private provider?: ModelProvider) {}

  start(session: Session, body: unknown): Run {
    if (!this.config.aiEnabled || !this.provider) throw new AppError('ai_disabled', 'AI未接続です。手動で設計できます。', 503);
    const input = Request.parse(body);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const duplicate = [...session.runs.values()].find(run => run.requestId === input.requestId);
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) throw new AppError('request_conflict', '同じリクエストIDを別の依頼には使えません。', 409);
      return duplicate;
    }
    assertCurrent(session, input.baseRevision, input.baseHash);
    let authorCorrection: InterpretationCorrection | undefined;
    let previous: Run | undefined;
    if (input.correction) {
      previous = session.runs.get(input.correction.runId);
      if (!previous || !['awaiting_approval', 'clarification_required'].includes(previous.status) || previous.requestId !== input.correction.requestId || previous.prompt !== input.prompt || previous.baseRevision !== input.baseRevision || previous.baseHash !== input.baseHash) throw new AppError('stale_interpretation', '訂正する依頼または基準版が一致しません。現在の設計から依頼してください。', 409);
      try { assertRequestBinding(session.document, input.prompt, input.correction.changes.binding); }
      catch { throw new AppError('stale_interpretation', '訂正する依頼または基準版が一致しません。現在の設計から依頼してください。', 409); }
      const changes = input.correction.changes;
      const merged = { ...previous.authorCorrection, ...changes,
        ignoredClauses: [...new Set([...(previous.authorCorrection?.ignoredClauses ?? []), ...(changes.ignoredClauses ?? [])])],
      };
      if (!changes.paperApproval && changes.paper && (changes.paper.kind !== 'cap' || changes.paper.maxSheets !== merged.paperApproval?.to)) delete merged.paperApproval;
      authorCorrection = InterpretationCorrectionSchema.parse(merged);
    }
    let intent: DesignIntent;
    try { intent = previous ? interpretModelRequest(session.document, input.prompt, previous.interpretationProposal, authorCorrection) : interpretDesignRequest(session.document, input.prompt); }
    catch { throw new AppError('invalid_correction', '訂正する項目と元の依頼が一致しません。現在の解釈に表示された項目から訂正してください。', 400); }
    // Only a definite unsupported mechanism stops before dispatch. Limited manual
    // vocabulary, ambiguities and conflicts remain available to the bounded model loop.
    if (!intent.supported && intent.interpretation.mechanism === 'unsupported') throw new AppError('unsupported_motion', [...intent.conflicts, ...intent.notes].join(' ') || 'この版は引っぱりタブの直線運動だけに対応しています。', 422);
    if (session.runs.size >= 100) throw new AppError('session_limit', 'この作業セッションの依頼上限です。保存して再接続してください。', 429);
    if ([...session.runs.values()].some(run => run.status === 'running' && run !== previous)) throw new AppError('run_active', 'この設計はすでに実行中です。', 409);
    const now = Date.now();
    this.starts = this.starts.filter(time => now - time < 3_600_000);
    if (this.active >= this.config.maxConcurrentRuns || this.starts.length >= this.config.runsPerHour || this.starts.filter(time => now - time < 60_000).length >= this.config.runsPerMinute) throw new AppError('instance_limit', '現在の実行上限です。時間をおいて再試行してください。', 429);
    if (previous) this.cancel(previous);
    for (const older of session.runs.values()) if (older.status === 'awaiting_approval') this.cancel(older);
    const run: Run = { id: randomUUID(), requestId: input.requestId, baseRevision: input.baseRevision, baseHash: input.baseHash, fingerprint, model: this.config.model, provider: this.config.provider, mode: this.provider instanceof VertexProvider ? 'vertex' : this.provider instanceof GeminiProvider ? 'gemini' : this.provider instanceof OllamaProvider ? 'ollama' : 'injected-test', modelUsage: [], prompt: input.prompt, authorCorrection, interpretationProposal: structuredClone(previous?.interpretationProposal ?? intent.interpretation), requestInterpretation: interpretationView(intent), intent: structuredClone(intent), intentSummary: { protections: protectionLabels(session.document, intent), notes: [...intent.notes] }, status: 'running', message: '現在の設計と、守る条件を確認しています。', events: [], validationIssues: [], constraintSuggestions: [], modelCalls: 0, toolCalls: 0, elapsedMs: 0, usage: { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedInputTokens: 0, toolPromptTokens: 0, totalTokens: 0, responsesWithUsage: 0, responsesWithoutUsage: 0 }, controller: new AbortController() };
    session.runs.set(run.id, run);
    this.starts.push(now); this.active++;
    run.done = this.execute(session, run, input.prompt).finally(() => { this.active--; });
    return run;
  }

  get(session: Session, runId: string): Run {
    const run = session.runs.get(runId);
    if (!run) throw new AppError('not_found', '実行が見つかりません。', 404);
    return run;
  }

  cancel(run: Run): Run {
    if (run.status === 'running' || run.status === 'awaiting_approval' || run.status === 'clarification_required') {
      run.status = 'cancelled'; run.proposal = undefined;
      run.message = (run.mode === 'gemini' || run.mode === 'vertex') ? '中断しました。送信済みのAPI呼び出しの課金取消しは保証されません。' : '中断しました。後続の検査・候補適用を停止しました。送信済みの推論が停止したとは限りません。';
      run.controller.abort(new AppError('cancelled', '利用者が中断しました。'));
    }
    return run;
  }

  approve(session: Session, proposalId: string, body: unknown) {
    const input = Approval.parse(body);
    const run = [...session.runs.values()].find(item => item.proposal?.id === proposalId);
    if (!run?.proposal || run.status !== 'awaiting_approval') throw new AppError('stale_approval', 'この提案の承認は無効です。', 409);
    const proposal = run.proposal;
    if (input.requestId !== proposal.requestId || input.baseRevision !== proposal.baseRevision || input.baseHash !== proposal.baseHash) throw new AppError('stale_approval', '承認した提案と元の設計が一致しません。', 409);
    assertCurrent(session, input.baseRevision, input.baseHash);
    // Rebuild from the currently trusted base, never from a client-supplied candidate.
    let document: DesignDocument;
    try {
      assertRequestBinding(session.document, run.prompt, run.intent.binding);
      const checkedIntent = interpretModelRequest(session.document, run.prompt, run.interpretationProposal, run.authorCorrection);
      document = applyIntentPatch(session.document, proposal.patch, checkedIntent);
    }
    catch { throw new AppError('protected_condition', '作者の保護条件に反するため、この変更案は採用できません。', 409); }
    if (document.designHash !== proposal.document.designHash || validateDesign(document).some(check => check.status === 'fail')) throw new AppError('validation_failed', '提案の再検査に失敗しました。', 409);
    session.document = structuredClone(document);
    for (const other of session.runs.values()) if (other !== run && (other.status === 'running' || other.status === 'awaiting_approval' || other.status === 'clarification_required')) this.cancel(other);
    run.status = 'succeeded'; run.message = '提案を採用しました。実物の動作は未検証です。'; run.proposal = undefined;
    return { document: structuredClone(document) };
  }

  reject(session: Session, proposalId: string) {
    const run = [...session.runs.values()].find(item => item.proposal?.id === proposalId);
    if (!run) throw new AppError('not_found', '提案が見つかりません。', 404);
    return this.cancel(run);
  }

  private async execute(session: Session, run: Run, prompt: string): Promise<void> {
    const start = performance.now();
    const timer = setTimeout(() => run.controller.abort(new AppError('timeout', '実行時間の上限に達しました。設計は変更されていません。')), this.config.runTimeoutMs);
    const signal = run.controller.signal;
    const base = structuredClone(parseDesignDocument(session.document));
    const context: ToolContext = { prompt, correction: run.authorCorrection, interpretationProposal: run.interpretationProposal, base, candidate: base, patch: structuredClone(run.intent.patch), intent: run.intent, seenHashes: new Set([base.designHash]), seenInterpretationDesigns: new Set(), constraintSuggestions: run.constraintSuggestions };
    const history: ConversationMessage[] = [{ role: 'user', text: JSON.stringify({ request: prompt, design: base, requestIntent: run.intent, ...(run.authorCorrection ? { authorCorrection: run.authorCorrection } : {}), sentData: '画像本体は送信していません。選択領域・寸法と検査結果です。' }) }];
    this.histories.set(run, history);
    const modelHistory: ConversationMessage[] = [{ role: 'user', text: JSON.stringify(modelInitialInput(base, prompt, run.intent, run.authorCorrection)) }];
    const failures = new Map<string, number>();
    let unresolvedToolFailure = false;
    const finalize = (text: string) => {
      if (!run.intent.supported) throw new AppError('unsupported_motion', run.intent.notes.join(' ') || 'この依頼は対応する直線運動の範囲外です。');
      if (run.intent.conflicts.length || run.intent.clarifications.length || run.intent.interpretation.unresolved.length) {
        run.status = 'clarification_required';
        run.message = [...run.intent.conflicts, ...run.intent.clarifications.map(item => item.message)].filter((value, index, values) => values.indexOf(value) === index).join(' ') || '希望の解釈を確認してください。作品は変更していません。';
        run.proposal = undefined; return;
      }
      if (unresolvedToolFailure) throw new AppError('invalid_output', '不正なツール実行が修正されていません。設計は変更されていません。');
      if (context.candidate.designHash === base.designHash && needsCandidate(base, run.intent)) {
        throw new AppError(run.constraintSuggestions.length ? 'conditions_conflict' : 'invalid_output', run.constraintSuggestions.length ? '希望と保護条件を両立する候補はできていません。条件変更案を確認し、必要な場合だけ手動で見直してください。' : '希望に対する設計候補が生成されていません。設計は変更されていません。');
      }
      const validationStart = performance.now();
      if (context.candidate.designHash !== base.designHash) {
        let rebuilt: DesignDocument;
        try { rebuilt = applyIntentPatch(base, context.patch, interpretModelRequest(base, run.prompt, run.interpretationProposal, run.authorCorrection)); }
        catch { throw new AppError('protected_condition', '変更案が作者の保護条件と一致しません。'); }
        if (rebuilt.designHash !== context.candidate.designHash) throw new AppError('protected_condition', '変更案が作者の保護条件と一致しません。');
      }
      const checks = validateDesign(context.candidate);
      run.validationIssues = checks.filter(check => check.status === 'fail');
      run.events.push({ sequence: run.events.length + 1, type: 'validation', message: '最終候補を再検査しました。', designHash: context.candidate.designHash, checkStatuses: checks.map(check => ({ id: check.id, status: check.status })), durationMs: performance.now() - validationStart });
      if (run.validationIssues.length) {
        const issue = run.validationIssues[0]!;
        throw new AppError('validation_failed', `候補は条件を満たしません。${issue.partIds.join('・')}：${issue.message} ${issue.suggestion ?? '条件変更案を確認してください。'}`);
      }
      run.message = text;
      if (context.candidate.designHash !== base.designHash) {
        run.proposal = { id: randomUUID(), requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash, patch: structuredClone(context.patch), document: structuredClone(context.candidate), addedLocks: context.candidate.input.locks.filter(key => !base.input.locks.includes(key)), protectedConditions: [...run.intentSummary.protections], requestedTravelMm: run.intent.explicitTravelMm, fulfillsRequested: fulfillsInterpretation(base, context.candidate, run.intent) };
        if (!run.proposal.fulfillsRequested) run.message = run.intent.explicitTravelMm !== undefined ? `希望は${run.intent.explicitTravelMm}mm、候補は${context.candidate.input.travelMm}mmです。違いを確認してから採用してください。\n${text}` : `これは希望と異なる代案です。解釈と設計差分を確認してから採用してください。\n${text}`;
        run.status = 'awaiting_approval';
      } else { run.status = 'succeeded'; run.message = `設計の変更はありません。\n${text}`; }
    };
    try {
      while (run.modelCalls < this.config.maxModelCalls) {
        signal.throwIfAborted(); assertCurrent(session, run.baseRevision, run.baseHash);
        const inputBytes = assertModelInput(this.config, modelHistory, this.provider);
        run.modelCalls++;
        const modelStart = performance.now();
        const meter: ModelUsage = { call: run.modelCalls, inputBytes, outputTokenLimit: this.config.maxOutputTokens, durationMs: 0, received: false, finishReason: null, modelVersion: null, usage: null };
        run.modelUsage.push(meter); run.usage.responsesWithoutUsage++;
        let response: ProviderResponse;
        try { response = await abortable(this.provider!.generate(modelHistory, signal), signal); }
        finally { meter.durationMs = performance.now() - modelStart; }
        meter.received = true;
        meter.finishReason = response.finishReason ?? null;
        meter.localTiming = response.localTiming; meter.localModel = response.localModel;
        meter.modelVersion = response.modelVersion?.slice(0, 128) ?? null;
        if (run.provider === 'vertex') meter.usageComplete = vertexUsageCostUsd(response.usageMetadata) !== null;
        meter.usage = meter.usageComplete === false ? null : tokenUsage(response.usageMetadata);
        meter.modelCost = response.modelCost;
        if (meter.usage) {
          run.usage.responsesWithUsage++; run.usage.responsesWithoutUsage--;
          for (const key of Object.keys(meter.usage) as (keyof TokenUsage)[]) run.usage[key] += meter.usage[key];
        }
        signal.throwIfAborted(); assertCurrent(session, run.baseRevision, run.baseHash);
        run.events.push({ sequence: run.events.length + 1, type: 'model', message: `モデル応答 ${run.modelCalls}`, durationMs: performance.now() - modelStart });
        const finishReason = response.finishReason;
        if (response.refusal || ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(finishReason || '')) throw new AppError('refusal', 'AIがこの依頼への応答を拒否しました。内容を変更して再試行してください。');
        if (finishReason && finishReason !== 'STOP') throw new AppError('invalid_output', 'AIの応答が途中で終了しました。設計は変更されていません。');
        const content = response.message;
        if (!content || content.role !== 'assistant' || typeof content.text !== 'string' || !Array.isArray(content.calls) || Buffer.byteLength(JSON.stringify(content), 'utf8') > 100_000) throw new AppError('invalid_output', 'AIの応答形式が不正です。');
        // Keep message identity so each adapter can replay its private original parts.
        history.push(content);
        modelHistory.push(content);
        const calls = content.calls;
        if (!calls.length) {
          const text = content.text.slice(0, 6000);
          if (!text.trim()) throw new AppError('invalid_output', 'AIから表示できる応答が届きませんでした。');
          finalize(text);
          return;
        }
        const results: ToolResult[] = [];
        let batchFailed = false;
        for (const call of calls) {
          signal.throwIfAborted(); assertCurrent(session, run.baseRevision, run.baseHash);
          if (run.toolCalls >= this.config.maxToolCalls) throw new AppError('tool_limit', 'ツール実行回数の上限に達しました。');
          run.toolCalls++;
          const toolStart = performance.now();
          let result: Record<string, unknown>;
          let message = '実行しました。';
          try {
            result = executeTool(call.name || '', call.args ?? {}, context);
            if (call.name === 'propose_request_interpretation') {
              run.intent = structuredClone(context.intent);
              run.interpretationProposal = structuredClone(context.interpretationProposal);
              run.requestInterpretation = interpretationView(run.intent);
              run.intentSummary = { protections: protectionLabels(base, run.intent), notes: [...run.intent.notes] };
              run.validationIssues = [];
              unresolvedToolFailure = false;
            }
            if (call.name === 'propose_design_patch' || call.name === 'validate_design') run.validationIssues = context.candidate.checks.filter(check => check.status === 'fail');
            if (call.name === 'propose_design_patch' || call.name === 'propose_constraint_change' && result.ignored !== true) unresolvedToolFailure = false;
            if (call.name === 'propose_constraint_change' && result.ignored === true) {
              message = '直近候補と同じ条件のため助言を追加せず、検査済み候補を保持しました。';
              if (unresolvedToolFailure) result = { ...result, nextStep: '同じ条件の助言は追加していません。以前の別のツールエラーが未修正です。そのエラーを修正するまで完了できません。' };
            }
          } catch (error) {
            batchFailed = true;
            const info = error instanceof AppError ? publicError(error) : { code: 'invalid_arguments', message: '値が不正、または固定条件の変更に当たるため拒否しました。' };
            message = info.message;
            result = { error: info };
            unresolvedToolFailure = true;
            const key = `${call.name}:${info.code}:${JSON.stringify(call.args)}`;
            const count = (failures.get(key) || 0) + 1; failures.set(key, count);
            if (count >= 2) throw new AppError('repeated_failure', '同じ失敗の反復を検出し、中止しました。');
          }
          run.events.push({ sequence: run.events.length + 1, type: 'tool', tool: call.name, message, designHash: context.candidate.designHash, patch: call.name === 'propose_design_patch' ? structuredClone(context.patch) : undefined, checkStatuses: context.candidate.checks.map(check => ({ id: check.id, status: check.status })), durationMs: performance.now() - toolStart });
          results.push({ name: call.name || 'unknown', ...(call.id ? { id: call.id } : {}), response: result });
        }
        history.push({ role: 'tool', results });
        modelHistory.push({ role: 'tool', results: results.map(result => ({ ...result, response: modelToolResult(result.name, result.response) })) });
        // A tool-bearing response can already include a short explanation. Once
        // its entire batch succeeds and the exact requested candidate passes,
        // a second model turn merely to paraphrase those results is unnecessary.
        // Tool-only responses, alternatives, failures and ambiguities keep the
        // normal loop. Never skip a remaining call in this response or adopt.
        if (content.text.trim() && calls.some(call => call.name === 'propose_design_patch')
          && !batchFailed && !unresolvedToolFailure && context.candidate.designHash !== base.designHash
          && fulfillsInterpretation(base, context.candidate, run.intent)
          && !context.candidate.checks.some(check => check.status === 'fail')) {
          finalize('希望に沿う候補を寸法・紙面で確認しました。採用するまで元の設計は変わりません。実物の動作は未検証です。');
          return;
        }
      }
      throw new AppError('model_limit', 'モデル呼び出し回数の上限に達しました。');
    } catch (error) {
      run.proposal = undefined;
      if (run.status !== 'cancelled') {
        run.error = publicError(signal.aborted ? signal.reason : error);
        run.status = 'failed'; run.message = run.error.message;
      }
    } finally { clearTimeout(timer); run.elapsedMs = performance.now() - start; }
  }
}
