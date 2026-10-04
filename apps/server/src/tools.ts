import { z } from 'zod';
import { applyIntentPatch, arrangePages, DesignPatchSchema, distanceTargetMm, interpretModelRequest, RequestInterpretationSchema, validateDesign, type DesignDocument, type DesignPatch, type DesignIntent, type InterpretationCorrection, type RequestInterpretation } from '@ugoku/core';
import type { ToolDeclaration } from './conversation.js';
import { AppError } from './errors.js';

const Empty = z.object({}).strict();
const Constraint = z.object({ key: z.enum(['travelMm', 'direction', 'widthMm', 'heightMm', 'maxSheets', 'paperThicknessMm', 'clearanceMm']), value: z.union([z.number().finite().min(0).max(500), z.enum(['right', 'left', 'up', 'down'])]), reason: z.string().min(1).max(500) }).strict();
export type ConstraintSuggestion = z.infer<typeof Constraint>;
export type ToolContext = { prompt: string; correction?: InterpretationCorrection; interpretationProposal: RequestInterpretation; base: DesignDocument; candidate: DesignDocument; patch: DesignPatch; intent: DesignIntent; seenHashes: Set<string>; seenInterpretationDesigns: Set<string>; constraintSuggestions: ConstraintSuggestion[] };
const number = { type: 'number' };
const direction = { type: 'string', enum: ['right', 'left', 'up', 'down'] };
const noArgs = { type: 'object', properties: {}, additionalProperties: false };

const interpretationSchema = z.toJSONSchema(RequestInterpretationSchema);
delete interpretationSchema.$schema;

export const declarations: ToolDeclaration[] = [
  { name: 'inspect_design', description: '現在の設計・固定条件・実検査結果を読み取る。', parametersJsonSchema: noArgs },
  { name: 'propose_request_interpretation', description: '依頼を方向・禁止方向・絶対距離・増減量・維持・未指定に分けて提案する。単位換算と基準版からの計算はサーバーが行う。未解釈の重要条件はunresolvedへ残す。固定解除や本人の承認を指定する権限はない。確実な初期解釈に訂正が不要なら省略できる。', parametersJsonSchema: interpretationSchema },
  { name: 'propose_design_patch', description: '利用者の希望と保護条件の中で候補を生成し、決定的に検査する。空オブジェクトは解釈済み希望の初期候補を作る。返されたfailを読んで修正する。選択・画像・固定条件は変更できない。', parametersJsonSchema: {
    type: 'object', properties: { direction, travelMm: number, widthMm: number, heightMm: number, maxSheets: { type: 'integer' }, paperThicknessMm: number, clearanceMm: number }, additionalProperties: false,
  } },
  { name: 'validate_design', description: '最新候補の全検査を再計算する。unknownをpassにしない。', parametersJsonSchema: noArgs },
  { name: 'arrange_pages', description: '最新候補の全機構部品をA4紙面へ決定的に配置する。縮小しない。', parametersJsonSchema: noArgs },
  { name: 'propose_constraint_change', description: '固定条件を変える案を表示するだけ。最新候補と異なる具体値を指定する。同じ値や失敗した値の繰り返しは変更案にならない。実際の条件や設計は変更しない。', parametersJsonSchema: {
    type: 'object', properties: { key: { type: 'string', enum: ['travelMm', 'direction', 'widthMm', 'heightMm', 'maxSheets', 'paperThicknessMm', 'clearanceMm'] }, value: { anyOf: [number, direction] }, reason: { type: 'string' } }, required: ['key', 'value', 'reason'], additionalProperties: false,
  } },
];

function interpretationDesignKey(context: ToolContext, designHash: string): string {
  const value = context.intent.interpretation;
  return JSON.stringify({
    ...value,
    distance: { kind: value.distance.kind, targetMm: distanceTargetMm(context.base.input.travelMm, value.distance) },
    direction: { desired: value.direction.desired, forbidden: [...new Set(value.direction.forbidden)].sort() },
    unresolved: [...new Set(value.unresolved)].sort(), designHash,
  });
}

export function executeTool(name: string, args: unknown, context: ToolContext): Record<string, unknown> {
  switch (name) {
    case 'inspect_design': {
      Empty.parse(args);
      return { requestInterpretation: { binding: context.intent.binding, interpretation: context.intent.interpretation, clarifications: context.intent.clarifications, summary: context.intent.summary, approvalRequired: context.intent.approvalRequired }, document: context.candidate, trustedLocks: context.base.input.locks, requestedPatch: context.intent.patch, requestProtections: context.intent.protections, locksToAddOnApproval: context.intent.addLocks, relativeTravel: context.intent.relativeTravel, requestedTravelMm: context.intent.explicitTravelMm, approvalRequired: true };
    }
    case 'propose_request_interpretation': {
      const proposal = RequestInterpretationSchema.parse(args);
      // Previously acknowledged clauses stay available for validation of accumulated corrections.
      proposal.unresolved = [...new Set([...proposal.unresolved, ...(context.correction?.ignoredClauses ?? [])])];
      const intent = interpretModelRequest(context.base, context.prompt, proposal, context.correction);
      // A revised interpretation invalidates any candidate calculated for the old one.
      const changed = JSON.stringify(intent) !== JSON.stringify(context.intent);
      context.intent = intent;
      context.interpretationProposal = structuredClone(proposal);
      if (changed) { context.candidate = context.base; context.patch = structuredClone(intent.patch); context.seenHashes = new Set([context.base.designHash]); }
      return { interpretation: intent.interpretation, binding: intent.binding, summary: intent.summary, clarifications: intent.clarifications, approvalRequired: intent.approvalRequired, supported: intent.supported, conflicts: intent.conflicts, protections: intent.protections, requestedPatch: intent.patch, applied: false };
    }
    case 'propose_design_patch': {
      const patch = DesignPatchSchema.parse(args);
      if ('selection' in patch || 'title' in patch) throw new AppError('forbidden_patch', 'AIは選択領域や作品名を変更できません。');
      if (Object.keys(patch).length === 0 && Object.keys(context.intent.patch).length === 0 && context.intent.addLocks.length === 0) throw new AppError('invalid_arguments', '変更値を指定してください。');
      const merged = { ...context.patch, ...patch };
      // Always apply against the immutable server snapshot. Model input never supplies locks.
      let candidate: DesignDocument;
      try { candidate = applyIntentPatch(context.base, merged, context.intent); }
      catch (error) { throw new AppError('protected_condition', error instanceof Error ? error.message : '作者の保護条件に反する変更は採用できません。'); }
      const state = interpretationDesignKey(context, candidate.designHash);
      if (candidate.designHash === context.base.designHash && !context.seenInterpretationDesigns.has(state)) {
        // A first valid no-op confirms the current design, without minting a revision or approval.
        // Keep its interpreted state so a second no-op, including A→B→A, is still a repeat.
        context.seenInterpretationDesigns.add(state);
        context.patch = merged;
        context.candidate = context.base;
        return { unchanged: true, designHash: context.base.designHash, revision: context.base.revision, patch: {}, checks: validateDesign(context.base), layout: arrangePages(context.base), protections: context.intent.protections, candidateTravelMm: context.base.input.travelMm, applied: false };
      }
      if (context.seenHashes.has(candidate.designHash) || context.seenInterpretationDesigns.has(state)) throw new AppError('repeated_design', '同じ設計候補の反復を検出しました。');
      context.seenHashes.add(candidate.designHash);
      context.seenInterpretationDesigns.add(state);
      context.patch = merged;
      context.candidate = candidate;
      return { designHash: candidate.designHash, revision: candidate.revision, patch: merged, checks: validateDesign(candidate), layout: arrangePages(candidate), protections: context.intent.protections, locksToAddOnApproval: context.intent.addLocks, requestedTravelMm: context.intent.explicitTravelMm, candidateTravelMm: candidate.input.travelMm, applied: false };
    }
    case 'validate_design': {
      Empty.parse(args);
      return { designHash: context.candidate.designHash, checks: validateDesign(context.candidate) };
    }
    case 'arrange_pages': {
      Empty.parse(args);
      return { designHash: context.candidate.designHash, layout: arrangePages(context.candidate), searchIsExhaustive: false };
    }
    case 'propose_constraint_change': {
      const suggestion = Constraint.parse(args);
      if ((suggestion.key === 'direction') !== (typeof suggestion.value === 'string')) throw new AppError('invalid_arguments', '条件の値の型が一致しません。');
      DesignPatchSchema.parse({ [suggestion.key]: suggestion.value });
      if (context.candidate.input[suggestion.key] === suggestion.value) throw new AppError('invalid_arguments', '最新候補と同じ値は条件変更案にできません。変更する具体値を指定してください。');
      context.constraintSuggestions.push(suggestion);
      return { suggestion, applied: false, nextStep: '利用者が手動で固定を解除・変更してから再実行してください。' };
    }
    default: throw new AppError('unknown_tool', '許可されていないツールです。');
  }
}
