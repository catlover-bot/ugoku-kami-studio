import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// Reserve the full allowance before launching a browser/server. Failed or
// interrupted attempts keep their reservation: no automatic paid retries.
export const CAMPAIGN_LIMITS = { attempts: 3, modelCalls: 18, toolCalls: 36, executionMs: 270_000 } as const;
export const ATTEMPT_LIMITS = { modelCalls: 6, toolCalls: 12, executionMs: 90_000 } as const;
export function parseLiveArgs(args: string[]) {
  const seen = new Set<string>();
  let caseId: 'L1' | 'L2' | 'L3' = 'L1';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!['--plan', '--authorize-paid-api', '--case'].includes(arg) || seen.has(arg)) throw new Error('Invalid or duplicate live option');
    seen.add(arg);
    if (arg === '--case') {
      const value = args[++index];
      if (value !== 'L1' && value !== 'L2' && value !== 'L3') throw new Error('Invalid live case');
      caseId = value;
    }
  }
  return { caseId, plan: seen.has('--plan'), authorize: seen.has('--authorize-paid-api') };
}
const Attempt = z.object({ id: z.string().uuid(), caseId: z.enum(['L1', 'L2', 'L3']), reservedAt: z.string(), status: z.string(), model: z.string(), modelCalls: z.number().int().nonnegative().optional(), toolCalls: z.number().int().nonnegative().optional(), runId: z.string().optional(), usage: z.unknown().optional() }).strict();
const Ledger = z.object({ format: z.literal('ugoku-kami-live-campaign'), version: z.literal(1), attempts: z.array(Attempt).max(3) }).strict();
export type LiveLedger = z.infer<typeof Ledger>;

export async function readLedger(directory: string): Promise<LiveLedger> {
  try { return Ledger.parse(JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: 'ugoku-kami-live-campaign', version: 1, attempts: [] };
    throw new Error('ライブ履歴を確認できません。自動で初期化しません。', { cause: error });
  }
}
export async function reserveAttempt(directory: string, caseId: 'L1' | 'L2' | 'L3', model: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.active');
  try { await mkdir(lockPath); }
  catch { throw new Error('別のライブ実行または中断記録があります。自動再試行しません。'); }
  try {
    const ledger = await readLedger(directory);
    if (ledger.attempts.length >= CAMPAIGN_LIMITS.attempts) throw new Error('このGoalの合計3試行を使いました。追加実行には新たな許可と予算確認が必要です。');
    if (caseId !== 'L1' && !ledger.attempts.some(item => item.caseId === 'L1' && item.status === 'adopted-and-pdf-verified')) throw new Error('最初にL1の採用とPDFを確認してください。');
    if (ledger.attempts.some(item => item.caseId === caseId && !item.status.endsWith('failed'))) throw new Error('このケースは予約済みまたは確認済みです。自動で再実行しません。');
    const attempt = { id: randomUUID(), caseId, model, reservedAt: new Date().toISOString(), status: 'reserved' };
    ledger.attempts.push(attempt);
    const save = async () => { const temp = join(directory, 'ledger.tmp'); await writeFile(temp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 }); await rename(temp, join(directory, 'ledger.json')); };
    await save();
    return {
      id: attempt.id,
      async finish(result: Partial<z.infer<typeof Attempt>>) {
        Object.assign(attempt, result);
        Ledger.parse(ledger);
        await save();
        await rm(lockPath, { recursive: true });
      },
    };
  } catch (error) { await rm(lockPath, { recursive: true }); throw error; }
}
