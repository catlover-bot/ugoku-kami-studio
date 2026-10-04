import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../apps/server/src/config.ts';

export const PINNED_MODEL = 'gemma4:e2b-it-qat';
export const PINNED_MODEL_DIGEST = '07ea59a474013479c8b6b802bef095c40e964a1d776ba02f264c0e30e1aede0c';
const required = ['GCP_PROJECT', 'GCP_REGION', 'CLOUD_RUN_SERVICE', 'CONTAINER_IMAGE', 'OLLAMA_CONTAINER_IMAGE', 'CLOUD_RUN_SERVICE_ACCOUNT', 'AI_ACCESS_SECRET_NAME', 'AI_ACCESS_SECRET_VERSION'] as const;
const imagePattern = /^[a-z0-9-]+-docker\.pkg\.dev\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;

export function cloudRunPlan(env: NodeJS.ProcessEnv) {
  const missing = required.filter(key => !env[key]);
  const checked = (key: typeof required[number], pattern: RegExp) => { if (env[key] && !pattern.test(env[key]!)) throw Error(`Invalid ${key}`); };
  checked('GCP_PROJECT', /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
  checked('GCP_REGION', /^[a-z]+-[a-z]+[0-9]$/);
  checked('CLOUD_RUN_SERVICE', /^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/);
  checked('AI_ACCESS_SECRET_NAME', /^[a-zA-Z0-9_-]{1,255}$/);
  checked('AI_ACCESS_SECRET_VERSION', /^[1-9][0-9]*$/);
  checked('CLOUD_RUN_SERVICE_ACCOUNT', /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/);
  for (const key of ['CONTAINER_IMAGE', 'OLLAMA_CONTAINER_IMAGE'] as const) {
    checked(key, imagePattern);
    if (env[key] && env.GCP_PROJECT && env[key]!.match(imagePattern)![1] !== env.GCP_PROJECT) throw Error(`${key} must use the selected project`);
  }
  if (env.CLOUD_RUN_SERVICE_ACCOUNT && env.GCP_PROJECT && !env.CLOUD_RUN_SERVICE_ACCOUNT.endsWith(`@${env.GCP_PROJECT}.iam.gserviceaccount.com`)) throw Error('Service account must use the selected project');
  if (env.CLOUD_RUN_PUBLIC && !['true', 'false'].includes(env.CLOUD_RUN_PUBLIC)) throw Error('CLOUD_RUN_PUBLIC must be true or false');
  const appEnv = {
    HOST: '0.0.0.0', AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    OLLAMA_MODEL: PINNED_MODEL, OLLAMA_MODEL_DIGEST: PINNED_MODEL_DIGEST,
    OLLAMA_CONTEXT_LENGTH: '16384', OLLAMA_TOOL_MODE: 'json-actions',
    AI_MAX_MODEL_CALLS: '6', AI_MAX_TOOL_CALLS: '12', AI_MAX_INPUT_BYTES: '65536', AI_MAX_OUTPUT_TOKENS: '768',
    AI_TIMEOUT_MS: '180000', AI_MAX_CONCURRENT: '1', AI_RUNS_PER_MINUTE: '3', AI_MAX_RUNS_PER_HOUR: '20',
  };
  // Use the real server parser without reading any ambient key or secret. This synthetic value
  // is only for offline validation and is never emitted into the manifest or used at runtime.
  readConfig({ ...appEnv, AI_ACCESS_SECRET: 'offline-config-validation-only-not-a-runtime-secret' });
  const manifest = missing.length ? null : {
    apiVersion: 'serving.knative.dev/v1', kind: 'Service',
    metadata: { name: env.CLOUD_RUN_SERVICE, namespace: env.GCP_PROJECT, annotations: { 'run.googleapis.com/ingress': 'all', 'run.googleapis.com/maxScale': '1' } },
    spec: {
      template: {
        metadata: { annotations: {
          'run.googleapis.com/execution-environment': 'gen2', 'run.googleapis.com/cpu-throttling': 'false',
          'run.googleapis.com/startup-cpu-boost': 'false', 'run.googleapis.com/sessionAffinity': 'true',
          'autoscaling.knative.dev/minScale': '0', 'autoscaling.knative.dev/maxScale': '1',
          'run.googleapis.com/container-dependencies': JSON.stringify({ app: ['ollama'] }),
        } },
        spec: {
          serviceAccountName: env.CLOUD_RUN_SERVICE_ACCOUNT, containerConcurrency: 8, timeoutSeconds: 300,
          containers: [
            { name: 'app', image: env.CONTAINER_IMAGE, ports: [{ containerPort: 8080 }],
              resources: { limits: { cpu: '1', memory: '1Gi' } },
              env: [...Object.entries(appEnv).map(([name, value]) => ({ name, value })), { name: 'AI_ACCESS_SECRET', valueFrom: { secretKeyRef: { name: env.AI_ACCESS_SECRET_NAME, key: env.AI_ACCESS_SECRET_VERSION } } }],
              startupProbe: { httpGet: { path: '/api/health', port: 8080 }, periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 48 },
            },
            { name: 'ollama', image: env.OLLAMA_CONTAINER_IMAGE, resources: { limits: { cpu: '4', memory: '8Gi' } },
              startupProbe: { tcpSocket: { port: 11434 }, periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 48 },
            },
          ],
        },
      },
      traffic: [{ latestRevision: true, percent: 100 }],
    },
  };
  return {
    status: missing.length ? 'incomplete-offline-plan' : 'offline-plan-ready-for-review', missing, manifest,
    region: env.GCP_REGION ?? null, publicAccessRequested: env.CLOUD_RUN_PUBLIC === 'true',
    resourcesPerInstance: { cpu: 5, memoryGiB: 9, httpConcurrency: 8, appAiConcurrency: 1, ollamaParallel: 1, minInstances: 0, maxServiceInstances: 1, maxRevisionInstances: 1, billing: 'instance-based' },
    model: { name: PINNED_MODEL, digest: PINNED_MODEL_DIGEST, runtime: '0.33.3', contextLength: 16384, toolMode: 'json-actions' },
    cloudWrites: 0, inferenceCalls: 0, applied: false,
    missingVerification: ['model container build/run', 'Cloud Run admission/quota', 'cold and warm model load latency/memory', 'public browser AI adoption/PDF/save/reconnect', 'approved project/budget/period/access and secret permissions'],
    notes: ['Only app port8080 is ingress; 11434 belongs to the same instance network only.', 'CPU remains allocated outside polling requests while an instance exists; scale-to-zero/restart can still lose sessions.', 'Max instances/session affinity are not persistence or an exact financial cap.', 'No runtime download, hosted fallback, image data sent to model, or secret value in this plan.', 'All traffic moves to the new revision. Existing runs/proposals may expire; save browser work before rollout.'],
  };
}

export async function printCloudRunPlan(args: string[], env: NodeJS.ProcessEnv = process.env) {
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && !output && args[i + 1] && !args[i + 1]!.startsWith('--')) output = resolve(args[++i]!);
    else throw Error('Only --output DIR is supported; cloud execution is not implemented');
  }
  const plan = cloudRunPlan(env);
  if (output) {
    if (!plan.manifest) throw Error(`Missing configuration: ${plan.missing.join(', ')}`);
    // Compare model pin to the bundle definition, so images and application never drift silently.
    const lock = JSON.parse(await readFile(new URL('../deployment/ollama/bundle-lock.json', import.meta.url), 'utf8'));
    if (lock.model !== plan.model.name || lock.modelDigest !== plan.model.digest) throw Error('Model bundle pin mismatch');
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(resolve(output, 'service.json'), JSON.stringify(plan.manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(plan, null, 2));
  console.log('DRY RUN ONLY. No gcloud, IAM changes, uploads, inference or deployment. --execute is not supported.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await printCloudRunPlan(process.argv.slice(2));
}
