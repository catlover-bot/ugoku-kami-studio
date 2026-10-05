import type { CheckResult, DesignDocument, DesignIntent, InterpretationCorrection } from '@ugoku/core';

/** A model-facing view, never a replacement for the trusted document or core checks.
 * The common stamp binds every check; complete fail/unknown explanations survive.
 * No history turn, author wording, protection or approval is inferred or discarded.
 */
export function modelChecks(checks: readonly CheckResult[]) {
  return checks.map(({ designHash: _hash, message, suggestion, ...check }) => ({
    ...check,
    ...(check.status === 'pass' ? {} : { message, ...(suggestion === undefined ? {} : { suggestion }) }),
  }));
}

export function modelLayout(layout: DesignDocument['layout']) {
  return { ...layout, placements: layout.placements.map(({ partId, page, rotated }) => ({ partId, page, rotated })) };
}

export function modelDesign(document: DesignDocument) {
  return structuredClone({
    schemaVersion: document.schemaVersion, designId: document.designId,
    revision: document.revision, designHash: document.designHash,
    unit: document.unit, mechanism: document.mechanism, input: document.input,
    parts: document.parts.map(({ id, label, role, widthMm, heightMm, layer, attachedTo }) => ({ id, label, role, widthMm, heightMm, layer, attachedTo })),
    layout: modelLayout(document.layout), checks: modelChecks(document.checks),
    assumptions: document.assumptions, physicalValidation: document.physicalValidation,
  });
}

export function modelInitialInput(base: DesignDocument, request: string, requestIntent: DesignIntent, authorCorrection?: InterpretationCorrection) {
  return {
    request, design: modelDesign(base), requestIntent: structuredClone(requestIntent),
    ...(authorCorrection ? { authorCorrection: structuredClone(authorCorrection) } : {}),
    sentData: '画像本体なし。サーバー検査済みの設計要約。checksの版は同じdesignHash。pass定型文と描画座標のみ省略。原本・全検査はサーバーに保持。',
  };
}

/** Only outputs of our allowlisted local tools enter here. Unknown/error fields
 * are copied intact; this is not an arbitrary JSON sanitizer or history trim.
 */
export function modelToolResult(name: string, result: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(result);
  if (name === 'inspect_design' && copy.document) copy.document = modelDesign(copy.document as DesignDocument);
  if (['propose_design_patch', 'validate_design', 'propose_constraint_change'].includes(name) && Array.isArray(copy.checks)) copy.checks = modelChecks(copy.checks as CheckResult[]);
  if (['propose_design_patch', 'arrange_pages'].includes(name) && copy.layout) copy.layout = modelLayout(copy.layout as DesignDocument['layout']);
  if (name === 'propose_constraint_change' && copy.suggestion) {
    const suggestion = copy.suggestion as { verification: { checks: CheckResult[]; hypotheticalDesignHash: string } };
    copy.suggestion = { ...suggestion, verification: { ...suggestion.verification, checks: modelChecks(suggestion.verification.checks) } };
  }
  return copy;
}
