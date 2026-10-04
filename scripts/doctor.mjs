import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadServerEnv, readConfig, DEFAULT_MODEL, GEMINI_ENDPOINT } from '../apps/server/src/config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const major = Number(process.versions.node.split('.')[0]);
const lock = existsSync(`${root}/package-lock.json`);
const installed = existsSync(`${root}/node_modules`);
const tool = (name) => spawnSync('which', [name], { stdio: 'ignore' }).status === 0;
let configurationValid = true;
let environmentFile = null;
let config;
let configurationIssue = null;
try {
  environmentFile = loadServerEnv();
  config = readConfig();
} catch (error) {
  configurationValid = false;
  // Only errors created by our loader/parser; never stringify env or SDK objects.
  configurationIssue = error instanceof Error ? error.message : 'Configuration could not be read';
}
const report = {
  node: process.version, supportedNode24: major === 24,
  packageLock: lock, dependenciesInstalled: installed,
  japaneseFont: existsSync(`${root}/apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf`),
  dockerAvailable: tool('docker'), pdfRendererAvailable: tool('pdftoppm'),
  environmentFile,
  environmentPrecedence: 'existing process variables, then selected env file; no .env.local or parent search',
  provider: config?.provider ?? 'none',
  aiEnabled: config?.aiEnabled ?? false,
  legacyAiEnabledIgnored: Boolean(process.env.AI_ENABLED),
  apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
  accessSecretConfigured: Boolean(process.env.AI_ACCESS_SECRET),
  model: config?.model ?? null,
  modelSource: config?.provider === 'ollama' ? 'explicit-local' : process.env.GEMINI_MODEL ? 'explicit' : 'default',
  documentedModel: DEFAULT_MODEL,
  documentedModelCheckedAt: '2026-10-04',
  connection: config?.provider === 'ollama' ? { provider: 'Ollama loopback', endpoint: config.ollama.baseUrl, runtimeStatus: 'not-tested', cloudDisabledStatus: 'not-tested', contextLength: config.ollama.contextLength, toolMode: config.ollama.toolMode, digestPinned: Boolean(config.ollama.digest) } : { provider: config?.provider === 'gemini' ? 'Gemini Developer API' : 'none', endpoint: config?.provider === 'gemini' ? GEMINI_ENDPOINT : null, sdk: '@google/genai', apiVersion: 'v1beta', authentication: 'server-side GEMINI_API_KEY; explicit app AI_ACCESS_SECRET', remoteStatus: 'not-tested' },
  limits: config ? { modelCalls: config.maxModelCalls, toolCalls: config.maxToolCalls, timeoutMs: config.runTimeoutMs, inputBytesPerCall: config.maxInputBytes, outputTokensPerCall: config.maxOutputTokens, concurrentRuns: config.maxConcurrentRuns, runsPerMinute: config.runsPerMinute, runsPerHour: config.runsPerHour, retries: 0 } : null,
  ignoredSdkEnvironmentPresent: ['GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL'].some(key => Boolean(process.env[key])),
  configurationValid, configurationIssue,
  readyForExplicitLiveAuthorization: Boolean(config?.provider === 'gemini' && config.aiEnabled && process.env.GEMINI_MODEL),
  readyForExplicitLocalRun: Boolean(config?.provider === 'ollama' && config.aiEnabled),
  networkRequests: 0, paidApiCalls: 0,
};
console.log(JSON.stringify(report, null, 2));
console.log('秘密の値は表示しません。接続・権限・残高は未確認です。AIは明示したproviderだけを使います。doctorは推論もモデル取得も行いません。');
if (lock) {
  const data = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8'));
  if (data.lockfileVersion !== 3) process.exitCode = 1;
}
if (major !== 24 || !lock || !installed || !report.japaneseFont || !configurationValid) process.exitCode = 1;
