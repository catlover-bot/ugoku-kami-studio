import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';

/** Private-trial admission only. The operator durably reserves these unique
 * attempts before signing. This token is NOT a public financial hard cap. */
const Schema = z.object({
  version: z.literal(1), permitId: z.string().uuid(), sessionId: z.string().uuid(),
  requestId: z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  baseHash: z.string().min(8).max(128), baseRevision: z.number().int().positive(),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/), model: z.literal('gemini-3.8-flash'),
  callIds: z.array(z.string().uuid()).min(1).max(6),
  issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  priorCommittedNanoUsd: z.number().int().min(0).max(3_900_000_000),
  poolNanoUsd: z.literal(3_900_000_000), callReserveNanoUsd: z.literal(556_032_000),
}).strict().refine(value => new Set(value.callIds).size === value.callIds.length)
  .refine(value => value.priorCommittedNanoUsd + value.callIds.length * value.callReserveNanoUsd <= value.poolNanoUsd);
export type TrialPermit = z.infer<typeof Schema>;
const signature = (payload: string, secret: string) => createHmac('sha256', secret).update('ugoku-goal010-permit-v1\n' + payload).digest();

/** Local operator only; do not put the returned token in logs or artifacts. */
export function signTrialPermit(input: TrialPermit, secret: string): string {
  if (secret.length < 32) throw Error('Trial access secret required');
  const data = Schema.parse(input), payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}
export function verifyTrialPermit(token: unknown, secret: string, binding: { sessionId: string; requestId: unknown; baseHash: unknown; baseRevision: unknown; sourceSha: string }, now = Date.now()): TrialPermit {
  const fail = () => { throw new AppError('trial_permit_required', '試験の送信枠を確認できないため、AI依頼を開始しません。作品は保持しています。', 403); };
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || secret.length < 32) return fail();
  const [payload, mac] = token.split('.'), actual = Buffer.from(mac, 'base64url'), expected = signature(payload, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail();
  let parsed: ReturnType<typeof Schema.safeParse>;
  try { parsed = Schema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))); } catch { return fail(); }
  if (!parsed.success) return fail();
  const p = parsed.data;
  if (p.sessionId !== binding.sessionId || p.requestId !== binding.requestId || p.baseHash !== binding.baseHash || p.baseRevision !== binding.baseRevision || p.sourceSha !== binding.sourceSha || p.issuedAt > now + 5000 || p.expiresAt <= now || p.expiresAt - p.issuedAt > 15 * 60_000 || p.expiresAt <= p.issuedAt) return fail();
  return p;
}
