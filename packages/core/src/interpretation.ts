import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { DesignDocument } from './types.js';

const direction = z.enum(['right', 'left', 'up', 'down']);
const amount = z.number().finite().min(-100_000).max(100_000);
const unit = z.enum(['mm', 'cm']);
export const DistanceOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unspecified') }).strict(),
  z.object({ kind: z.literal('maintain') }).strict(),
  z.object({ kind: z.literal('absolute'), value: amount, unit }).strict(),
  z.object({ kind: z.literal('relative'), delta: amount, unit }).strict(),
  z.object({ kind: z.literal('qualitative'), change: z.enum(['increase', 'decrease']) }).strict(),
]);
export const DirectionInterpretationSchema = z.object({ desired: direction.optional(), forbidden: z.array(direction).max(4) }).strict();
export const PaperOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unspecified') }).strict(),
  z.object({ kind: z.literal('maintain') }).strict(),
  z.object({ kind: z.literal('cap'), maxSheets: z.number().int().min(0).max(100_000) }).strict(),
]);
/** Model output describes meaning only. It cannot supply locks or approval. */
export const RequestInterpretationSchema = z.object({
  distance: DistanceOperationSchema,
  direction: DirectionInterpretationSchema,
  size: z.enum(['unspecified', 'maintain', 'change']),
  paper: PaperOperationSchema,
  mechanism: z.enum(['single-pull-tab', 'unsupported', 'uncertain']),
  unresolved: z.array(z.string().min(1).max(2000)).max(40),
}).strict();
export const RequestBindingSchema = z.object({
  designId: z.string().min(1).max(64), baseRevision: z.number().int().positive(),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
/** Only an explicit author interaction may provide these fields to a server. */
export const InterpretationCorrectionSchema = z.object({
  binding: RequestBindingSchema,
  distance: DistanceOperationSchema.optional(), direction: DirectionInterpretationSchema.optional(),
  size: z.enum(['unspecified', 'maintain', 'change']).optional(), paper: PaperOperationSchema.optional(),
  ignoredClauses: z.array(z.string().min(1).max(2000)).max(40).optional(),
  paperApproval: z.object({ from: z.number().int().min(1).max(8), to: z.number().int().min(1).max(8) }).strict().optional(),
}).strict();
export type DistanceOperation = z.infer<typeof DistanceOperationSchema>;
export type DirectionInterpretation = z.infer<typeof DirectionInterpretationSchema>;
export type RequestInterpretation = z.infer<typeof RequestInterpretationSchema>;
export type RequestBinding = z.infer<typeof RequestBindingSchema>;
export type InterpretationCorrection = z.infer<typeof InterpretationCorrectionSchema>;
export type InterpretationChanges = Omit<InterpretationCorrection, 'binding'>;
export type InterpretationClarification = {
  id: string; field: 'distance' | 'direction' | 'size' | 'paper' | 'other'; message: string;
  choices: { label: string; changes: InterpretationChanges }[];
};
export function getRequestBinding(document: DesignDocument, request: string): RequestBinding {
  return { designId: document.designId, baseRevision: document.revision, baseHash: document.designHash, requestHash: bytesToHex(sha256(new TextEncoder().encode(request))) };
}
export function assertRequestBinding(document: DesignDocument, request: string, binding: RequestBinding): void {
  const expected = getRequestBinding(document, request);
  if (JSON.stringify(RequestBindingSchema.parse(binding)) !== JSON.stringify(expected)) throw new Error('依頼または基準の設計版が変わりました。現在の依頼と設計から解釈し直してください。');
}
export function distanceTargetMm(current: number, operation: DistanceOperation): number {
  if (operation.kind === 'absolute') return operation.value * (operation.unit === 'cm' ? 10 : 1);
  if (operation.kind === 'relative') return current + operation.delta * (operation.unit === 'cm' ? 10 : 1);
  if (operation.kind === 'qualitative') return current + (operation.change === 'increase' ? 1 : -1) * Math.max(2, Math.round(current * .25));
  return current;
}
