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
  provider: 'none' | 'ollama' | 'gemini';
  /** Derived from provider; never an independent enabling flag. */
  aiEnabled: boolean;
  ollama: { baseUrl: string; model: string; digest: string; contextLength: number; toolMode: 'native' | 'json-actions' };
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

export function validateOllamaEndpoint(value: string): string {
  // Literal loopback only: no DNS, credentials, URL path, proxy, search or fragment.
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/?$/.test(value)) throw new Error('OLLAMA_BASE_URL requires an explicit HTTP loopback address and port');
  const url = new URL(value);
  if (!url.port || Number(url.port) > 65535 || Number(url.port) < 1) throw new Error('OLLAMA_BASE_URL requires an explicit loopback port');
  return url.origin;
}
export function validateOllamaModel(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i.test(value) || /cloud|remote/i.test(value)) throw new Error('OLLAMA_MODEL requires an explicit local model tag; remote models are forbidden');
  return value;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const provider = env.AI_PROVIDER?.trim() || 'none';
  if (!['none', 'ollama', 'gemini'].includes(provider)) throw new Error('AI_PROVIDER must be none, ollama or gemini');
  const local = provider === 'ollama';
  const localModel = local ? validateOllamaModel(env.OLLAMA_MODEL || '') : '';
  const localUrl = local ? validateOllamaEndpoint(env.OLLAMA_BASE_URL || '') : '';
  const toolMode = env.OLLAMA_TOOL_MODE || 'native';
  if (local && !['native', 'json-actions'].includes(toolMode)) throw new Error('OLLAMA_TOOL_MODE must be native or json-actions');
  if (local && env.OLLAMA_MODEL_DIGEST && !/^(?:sha256:)?[a-f0-9]{64}$/.test(env.OLLAMA_MODEL_DIGEST)) throw new Error('OLLAMA_MODEL_DIGEST must be a SHA-256 digest');
  const config: ServerConfig = {
    provider: provider as ServerConfig['provider'],
    aiEnabled: provider !== 'none',
    ollama: { baseUrl: localUrl, model: localModel, digest: local ? env.OLLAMA_MODEL_DIGEST?.replace(/^sha256:/, '') || '' : '', contextLength: integer(env.OLLAMA_CONTEXT_LENGTH, 8192, 2048, 32768, 'OLLAMA_CONTEXT_LENGTH'), toolMode: toolMode as 'native' | 'json-actions' },
    apiKey: provider === 'gemini' ? env.GEMINI_API_KEY?.trim() || '' : '',
    accessSecret: env.AI_ACCESS_SECRET || '',
    model: local ? localModel : env.GEMINI_MODEL || DEFAULT_MODEL,
    maxModelCalls: integer(env.AI_MAX_MODEL_CALLS, 6, 1, 12, 'AI_MAX_MODEL_CALLS'),
    maxToolCalls: integer(env.AI_MAX_TOOL_CALLS, 12, 1, 24, 'AI_MAX_TOOL_CALLS'),
    maxInputBytes: integer(env.AI_MAX_INPUT_BYTES, 65_536, 8192, 262_144, 'AI_MAX_INPUT_BYTES'),
    maxOutputTokens: integer(env.AI_MAX_OUTPUT_TOKENS, local ? 1024 : 4096, 256, 8192, 'AI_MAX_OUTPUT_TOKENS'),
    runTimeoutMs: integer(env.AI_TIMEOUT_MS, 90_000, 100, 180_000, 'AI_TIMEOUT_MS'),
    maxConcurrentRuns: integer(env.AI_MAX_CONCURRENT, 1, 1, 5, 'AI_MAX_CONCURRENT'),
    runsPerMinute: integer(env.AI_RUNS_PER_MINUTE, 6, 1, 30, 'AI_RUNS_PER_MINUTE'),
    runsPerHour: integer(env.AI_MAX_RUNS_PER_HOUR, 60, 1, 120, 'AI_MAX_RUNS_PER_HOUR'),
    sessionTtlMs: 60 * 60 * 1000,
    maxSessions: 200,
  };
  if (/\s/.test(config.apiKey)) throw new Error('GEMINI_API_KEY must not contain whitespace');
  if (provider === 'gemini' && !/^gemini-[a-z0-9.-]{1,80}$/.test(config.model)) throw new Error('Invalid GEMINI_MODEL');
  if (config.aiEnabled && (config.accessSecret.trim().length < 32 || provider === 'gemini' && !config.apiKey)) {
    throw new Error('Selected AI_PROVIDER requires AI_ACCESS_SECRET of at least 32 characters; gemini also requires GEMINI_API_KEY');
  }
  return config;
}

export function publicStatus(config: ServerConfig) {
  return {
    ai: {
      enabled: config.aiEnabled,
      provider: config.provider,
      mode: config.aiEnabled ? config.provider : 'manual',
      reason: config.aiEnabled ? (config.provider === 'ollama' ? 'ローカルAI設定済み（実通信は実行時のみ）' : 'AI接続設定済み（実通信は実行時のみ）') : 'AI未接続 — 手動で設計できます',
      model: config.aiEnabled ? config.model : null,
      sendsImage: false,
      endpoint: config.provider === 'ollama' ? config.ollama.baseUrl : config.provider === 'gemini' ? GEMINI_ENDPOINT : null,
      ...(config.provider === 'ollama' ? { contextLength: config.ollama.contextLength, toolMode: config.ollama.toolMode } : {}),
    },
    limits: { modelCalls: config.maxModelCalls, toolCalls: config.maxToolCalls, timeoutMs: config.runTimeoutMs, inputBytes: config.maxInputBytes, outputTokens: config.maxOutputTokens },
  };
}
