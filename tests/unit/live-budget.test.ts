import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseLiveArgs, readLedger, reserveAttempt } from '../../scripts/live-budget.js';

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'ugoku-live-budget-')); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('rejects ambiguous case arguments before any authorization can dispatch', () => {
  for (const args of [['L2', '--authorize-paid-api'], ['--case', 'L1', '--case', 'L2'], ['--case'], ['--case', 'L4'], ['--authorize-paid-api', '--authorize-paid-api']]) expect(() => parseLiveArgs(args)).toThrow();
  expect(parseLiveArgs(['--case', 'L2', '--plan'])).toEqual({ caseId: 'L2', plan: true, authorize: false });
});

it('reserves before execution, rejects overlapping runs and counts failed attempts toward the campaign cap', async () => {
  const path = await directory();
  const first = await reserveAttempt(path, 'L1', 'test-model');
  await expect(reserveAttempt(path, 'L1', 'test-model')).rejects.toThrow('別のライブ');
  expect((await readLedger(path)).attempts[0]!.status).toBe('reserved');
  await first.finish({ status: 'verification-failed', modelCalls: 1 });
  const second = await reserveAttempt(path, 'L1', 'test-model');
  await second.finish({ status: 'verification-failed', modelCalls: 1 });
  const third = await reserveAttempt(path, 'L1', 'test-model');
  await third.finish({ status: 'verification-failed', modelCalls: 1 });
  await expect(reserveAttempt(path, 'L1', 'test-model')).rejects.toThrow('合計3試行');
  expect((await readLedger(path)).attempts).toHaveLength(3);
});

it('requires successful L1 first, prevents silent repeated cases, and refuses corrupt ledgers', async () => {
  const path = await directory();
  await expect(reserveAttempt(path, 'L2', 'test-model')).rejects.toThrow('最初にL1');
  const first = await reserveAttempt(path, 'L1', 'test-model');
  await first.finish({ status: 'adopted-and-pdf-verified', modelCalls: 2 });
  await expect(reserveAttempt(path, 'L1', 'test-model')).rejects.toThrow('予約済み');
  const second = await reserveAttempt(path, 'L2', 'test-model');
  await second.finish({ status: 'alternative-offered-original-preserved', modelCalls: 3 });
  await writeFile(join(path, 'ledger.json'), '{"damaged":true}');
  await expect(reserveAttempt(path, 'L3', 'test-model')).rejects.toThrow('自動で初期化しません');
});
