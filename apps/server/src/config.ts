import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com';

/** Shared bootstrap for server, doctor and live command. Never contacts Google. */
export function loadServerEnv({ env = process.env, cwd = process.cwd() }: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const explicit = Boolean(env.UGOKU_ENV_FILE?.trim());
  const path = resolve(cwd, explicit ? env.UGOKU_ENV_FILE!.trim() : '.env');
  if (!existsSync(path)) {
    if (explicit) throw new Error('UGOKU_ENV_FILE does not exist');
    return { path, loaded: false, source: 'default' as const };
  }
  let values: NodeJS.Dict<string>;
  try { values = parseEnv(readFileSync(path, 'utf8')); }
  catch { throw new Error('Environment file could not be read'); }
  for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value;
  return { path, loaded: true, source: explicit ? 'explicit' as const : 'default' as const };
}

export type ServerConfig = {
  aiEnabled: boolean;
  apiKey: string;
  accessSecret: string;
  model: string;
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  runTimeoutMs: number;
  maxConcurrentRuns: number;
  runsPerMinute: number;
  runsPerHour: number;
  sessionTtlMs: number;
  maxSessions: number;
};

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (env.AI_ENABLED && !['true', 'false'].includes(env.AI_ENABLED)) throw new Error('AI_ENABLED must be true or false');
  const config: ServerConfig = {
    aiEnabled: env.AI_ENABLED === 'true',
    apiKey: env.GEMINI_API_KEY?.trim() || '',
    accessSecret: env.AI_ACCESS_SECRET || '',
    model: env.GEMINI_MODEL || DEFAULT_MODEL,
    maxModelCalls: integer(env.AI_MAX_MODEL_CALLS, 6, 1, 12, 'AI_MAX_MODEL_CALLS'),
    maxToolCalls: integer(env.AI_MAX_TOOL_CALLS, 12, 1, 24, 'AI_MAX_TOOL_CALLS'),
    maxInputBytes: integer(env.AI_MAX_INPUT_BYTES, 65_536, 8192, 262_144, 'AI_MAX_INPUT_BYTES'),
    maxOutputTokens: integer(env.AI_MAX_OUTPUT_TOKENS, 4096, 256, 8192, 'AI_MAX_OUTPUT_TOKENS'),
    runTimeoutMs: integer(env.AI_TIMEOUT_MS, 90_000, 100, 180_000, 'AI_TIMEOUT_MS'),
    maxConcurrentRuns: integer(env.AI_MAX_CONCURRENT, 2, 1, 5, 'AI_MAX_CONCURRENT'),
    runsPerMinute: integer(env.AI_RUNS_PER_MINUTE, 6, 1, 30, 'AI_RUNS_PER_MINUTE'),
    runsPerHour: integer(env.AI_MAX_RUNS_PER_HOUR, 60, 1, 120, 'AI_MAX_RUNS_PER_HOUR'),
    sessionTtlMs: 60 * 60 * 1000,
    maxSessions: 200,
  };
  if (/\s/.test(config.apiKey)) throw new Error('GEMINI_API_KEY must not contain whitespace');
  if (!/^gemini-[a-z0-9.-]{1,80}$/.test(config.model)) throw new Error('Invalid GEMINI_MODEL');
  if (config.aiEnabled && (!config.apiKey || config.accessSecret.trim().length < 32)) {
    throw new Error('AI_ENABLED requires GEMINI_API_KEY and AI_ACCESS_SECRET of at least 32 characters');
  }
  return config;
}

export function publicStatus(config: ServerConfig) {
  return {
    ai: {
      enabled: config.aiEnabled,
      mode: config.aiEnabled ? 'gemini' : 'manual',
      reason: config.aiEnabled ? 'AI接続設定済み（実通信は実行時のみ）' : 'AI未接続 — 手動で設計できます',
      model: config.aiEnabled ? config.model : null,
      sendsImage: false,
    },
    limits: { modelCalls: config.maxModelCalls, toolCalls: config.maxToolCalls, timeoutMs: config.runTimeoutMs, inputBytes: config.maxInputBytes, outputTokens: config.maxOutputTokens },
  };
}
