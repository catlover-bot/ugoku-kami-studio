import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../apps/server/src/config.ts';

export const VERTEX_TRIAL_LIMITS = Object.freeze({
  realRequests: 4, modelCallsPerRequest: 6, toolCallsPerRequest: 4,
  inputBytesPerCall: 32_768, configuredOutputTokensPerCall: 2_048, requestSeconds: 90,
  maxInstances: 1, concurrentInference: 1, cpu: 1, memoryGiB: 1,
  runMinutes: 120, buildMinutes: 60, imageGiB: 1, sourceMiB: 50, cleanupHours: 24,
  grossManagementTargetUSD: 5,
});
const required = ['GCP_PROJECT', 'GCP_REGION', 'CLOUD_RUN_SERVICE', 'CONTAINER_IMAGE', 'CLOUD_RUN_SERVICE_ACCOUNT', 'AI_ACCESS_SECRET_NAME', 'AI_ACCESS_SECRET_VERSION'] as const;
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const imagePattern = /^asia-northeast1-docker\.pkg\.dev\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;

/** Offline only. Never loads credentials, contacts an API, or enables a provider in a running service. */
export function vertexTrialPlan(env: NodeJS.ProcessEnv) {
  const missing = required.filter(key => !env[key]);
  if (env.GCP_PROJECT && !projectPattern.test(env.GCP_PROJECT)) throw Error('Invalid GCP_PROJECT');
  if (env.VERTEX_PROJECT && env.VERTEX_PROJECT !== env.GCP_PROJECT) throw Error('VERTEX_PROJECT must match the explicitly selected GCP_PROJECT');
  if (env.GCP_REGION && env.GCP_REGION !== 'asia-northeast1') throw Error('This reviewed plan requires Cloud Run Tokyo');
  if (env.CLOUD_RUN_SERVICE && !/^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/.test(env.CLOUD_RUN_SERVICE)) throw Error('Invalid CLOUD_RUN_SERVICE');
  if (env.CLOUD_RUN_SERVICE_ACCOUNT && (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(env.CLOUD_RUN_SERVICE_ACCOUNT) || env.GCP_PROJECT && !env.CLOUD_RUN_SERVICE_ACCOUNT.endsWith(`@${env.GCP_PROJECT}.iam.gserviceaccount.com`))) throw Error('Service account must belong to the selected project');
  if (env.CONTAINER_IMAGE && (!imagePattern.test(env.CONTAINER_IMAGE) || env.GCP_PROJECT && env.CONTAINER_IMAGE.match(imagePattern)![1] !== env.GCP_PROJECT)) throw Error('Use a same-project Tokyo image digest');
  if (env.AI_ACCESS_SECRET_NAME && !/^[a-zA-Z0-9_-]{1,255}$/.test(env.AI_ACCESS_SECRET_NAME)) throw Error('Invalid secret name');
  if (env.AI_ACCESS_SECRET_VERSION && !/^[1-9][0-9]*$/.test(env.AI_ACCESS_SECRET_VERSION)) throw Error('Secret version must be pinned');
  if (env.CLOUD_RUN_PUBLIC && env.CLOUD_RUN_PUBLIC !== 'false') throw Error('Private trial only');
  if (env.VERTEX_LOCATION && env.VERTEX_LOCATION !== 'global') throw Error('Vertex location is global, separate from Cloud Run Tokyo');
  if (env.VERTEX_MODEL && env.VERTEX_MODEL !== 'gemini-3.8-flash') throw Error('One reviewed model only');
  const limits = VERTEX_TRIAL_LIMITS;
  const appEnv = {
    HOST: '0.0.0.0', AI_PROVIDER: 'vertex', VERTEX_PROJECT: env.GCP_PROJECT ?? '',
    VERTEX_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.8-flash',
    VERTEX_MODEL_BUDGET_USD: '3.9',
    AI_MAX_MODEL_CALLS: String(limits.modelCallsPerRequest), AI_MAX_TOOL_CALLS: String(limits.toolCallsPerRequest),
    AI_MAX_INPUT_BYTES: String(limits.inputBytesPerCall), AI_MAX_OUTPUT_TOKENS: String(limits.configuredOutputTokensPerCall),
    AI_TIMEOUT_MS: String(limits.requestSeconds * 1000), AI_MAX_CONCURRENT: '1', AI_RUNS_PER_MINUTE: '2', AI_MAX_RUNS_PER_HOUR: '4',
  };
  // A synthetic secret validates syntax only; no ambient API key/ADC is read or emitted.
  if (env.GCP_PROJECT) readConfig({ ...appEnv, AI_ACCESS_SECRET: 'offline-validation-only-never-a-runtime-secret' });
  const manifest = missing.length ? null : {
    apiVersion: 'serving.knative.dev/v1', kind: 'Service',
    metadata: { name: env.CLOUD_RUN_SERVICE, namespace: env.GCP_PROJECT, annotations: { 'run.googleapis.com/ingress': 'all', 'run.googleapis.com/maxScale': '1' } },
    spec: { template: {
      metadata: { annotations: {
        'run.googleapis.com/execution-environment': 'gen2', 'run.googleapis.com/cpu-throttling': 'false',
        'run.googleapis.com/startup-cpu-boost': 'false', 'run.googleapis.com/sessionAffinity': 'true',
        'autoscaling.knative.dev/minScale': '0', 'autoscaling.knative.dev/maxScale': '1',
      } },
      spec: { serviceAccountName: env.CLOUD_RUN_SERVICE_ACCOUNT, containerConcurrency: 8, timeoutSeconds: 120,
        containers: [{ name: 'app', image: env.CONTAINER_IMAGE, ports: [{ containerPort: 8080 }],
          resources: { limits: { cpu: '1', memory: '1Gi' } },
          env: [...Object.entries(appEnv).map(([name, value]) => ({ name, value })), { name: 'AI_ACCESS_SECRET', valueFrom: { secretKeyRef: { name: env.AI_ACCESS_SECRET_NAME, key: env.AI_ACCESS_SECRET_VERSION } } }],
          startupProbe: { httpGet: { path: '/api/health', port: 8080 }, periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 24 },
        }],
      },
    }, traffic: [{ latestRevision: true, percent: 100 }] },
  };
  return {
    status: missing.length ? 'incomplete-offline-plan' : 'offline-plan-ready-for-review', missing, manifest,
    cloudWrites: 0, inferenceCalls: 0, applied: false, executionAuthorized: false,
    cloudRunRegion: 'asia-northeast1', vertexLocation: 'global', model: 'gemini-3.8-flash', thinking: 'LOW',
    limits, totals: { modelCalls: limits.realRequests * limits.modelCallsPerRequest, toolCalls: limits.realRequests * limits.toolCallsPerRequest, inputBytes: limits.realRequests * limits.modelCallsPerRequest * limits.inputBytesPerCall, configuredOutputTokens: limits.realRequests * limits.modelCallsPerRequest * limits.configuredOutputTokensPerCall, requestSeconds: limits.realRequests * limits.requestSeconds },
    auth: { method: 'ADC from attached Cloud Run service account', keysCreated: false, apiKeyUsed: false, privateIamRequired: true },
    iamProposal: { customRolePermissions: ['aiplatform.endpoints.predict', 'serviceusage.services.use'], projectScoped: true, modelScopeEnforcedBy: 'application allowlist; project IAM is not a model-only policy', secretAccessorScope: 'only the trial access-code secret' },
    requiredExecutionChecks: ['user approval for this private trial with gross cash costs acknowledged; no credit deduction or coupon expiry/scope prerequisite', 'name collisions and build source SHA', 'actual image digest and <=1GiB size', 'IAM invoker check enabled and no public members', 'durable external four-request ledger including failures/retries and total 24 model calls', 'reserve the next model call before dispatch against cumulative usage and retained unknown-usage reservations', 'elapsed-time and estimated-cost stop; cleanup only trial-created resources'],
    caveats: ['No automatic fallback to Developer API or Ollama.', 'Global model processing is not Tokyo data residency.', 'Configured output limit is not represented as a verified Vertex thinking-inclusive billing ceiling.', 'Hourly/in-memory limits reset on restart; they do not enforce a four-request whole-trial cap or a financial hard stop.', 'Instance billing preserves the existing asynchronous run/poll design; min0 does not guarantee immediate shutdown.', 'Session affinity does not persist sessions or proposals across restart/scale-to-zero; keep the original work in browser storage.'],
  };
}

export async function printVertexTrialPlan(args: string[], env: NodeJS.ProcessEnv = process.env) {
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && !output && args[i + 1] && !args[i + 1]!.startsWith('--')) output = resolve(args[++i]!);
    else throw Error('Only --output FILE is supported; execution is not implemented');
  }
  const plan = vertexTrialPlan(env);
  if (output) { await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  console.log(JSON.stringify(plan, null, 2));
  console.log('DRY RUN ONLY. No credentials loaded, cloud writes, inference or deployment.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await printVertexTrialPlan(process.argv.slice(2));
