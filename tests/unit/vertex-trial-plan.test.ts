import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { printVertexTrialPlan, vertexTrialPlan } from '../../scripts/vertex-trial-plan';

const env = { GCP_PROJECT: 'ugoku-trial-123', GCP_REGION: 'asia-northeast1', CLOUD_RUN_SERVICE: 'vertex-review',
  CLOUD_RUN_SERVICE_ACCOUNT: 'ugoku-runtime@ugoku-trial-123.iam.gserviceaccount.com',
  CONTAINER_IMAGE: `asia-northeast1-docker.pkg.dev/ugoku-trial-123/trial/app@sha256:${'a'.repeat(64)}`,
  AI_ACCESS_SECRET_NAME: 'trial-access', AI_ACCESS_SECRET_VERSION: '1' };

describe('Vertex limited trial is a private offline proposal', () => {
  it('keeps target regions distinct, ADC isolated from ambient keys, and async CPU available', () => {
    const plan = vertexTrialPlan({ ...env, GEMINI_API_KEY: 'must-not-print-key', AI_ACCESS_SECRET: 'must-not-print-access', GOOGLE_APPLICATION_CREDENTIALS: '/must-not-read.json', GOOGLE_GENAI_USE_VERTEXAI: 'false' });
    expect(plan.executionAuthorized).toBe(false); expect(plan.applied).toBe(false); expect(plan.inferenceCalls).toBe(0);
    expect(plan.cloudRunRegion).toBe('asia-northeast1'); expect(plan.vertexLocation).toBe('global');
    expect(JSON.stringify(plan)).not.toContain('must-not');
    expect(plan.totals).toEqual({ modelCalls: 24, toolCalls: 16, inputBytes: 786432, configuredOutputTokens: 49152, requestSeconds: 360 });
    expect(plan.limits).toMatchObject({ runMinutes: 120, buildMinutes: 60, grossManagementTargetUSD: 5 });
    expect(plan.requiredExecutionChecks.join(' ')).toContain('no credit deduction');
    const service = plan.manifest!;
    expect(service.metadata.annotations['run.googleapis.com/maxScale']).toBe('1');
    expect(service.spec.template.metadata.annotations['run.googleapis.com/cpu-throttling']).toBe('false');
    expect(service.spec.template.metadata.annotations['autoscaling.knative.dev/maxScale']).toBe('1');
    expect(service.spec.template.spec.containers).toHaveLength(1);
    expect(service.spec.template.spec.containers[0]!.env).toContainEqual({ name: 'VERTEX_LOCATION', value: 'global' });
    expect(service.spec.template.spec.containers[0]!.env).toContainEqual({ name: 'AI_MAX_MODEL_CALLS', value: '6' });
    expect(service.spec.template.spec.containers[0]!.env).toContainEqual({ name: 'AI_MAX_TOOL_CALLS', value: '4' });
    expect(service.spec.template.spec.containers[0]!.env).toContainEqual({ name: 'AI_TIMEOUT_MS', value: '90000' });
    expect(service.spec.template.spec.containers[0]!.env).toContainEqual({ name: 'VERTEX_MODEL_BUDGET_USD', value: '3.9' });
    expect(service.spec.template.spec.containers[0]!.env.some(x => /API_KEY|CREDENTIALS/.test(x.name))).toBe(false);
    expect(plan.iamProposal.customRolePermissions).not.toContain('roles/aiplatform.user');
    expect(vertexTrialPlan({ ...env, VERTEX_PROJECT: env.GCP_PROJECT }).manifest).toEqual(plan.manifest);
  });
  it('rejects a public request, wrong project/region/model and mutable image/secret', () => {
    for (const patch of [{ CLOUD_RUN_PUBLIC: 'true' }, { GCP_REGION: 'us-central1' }, { VERTEX_LOCATION: 'asia-northeast1' }, { VERTEX_MODEL: 'other' }, { CONTAINER_IMAGE: env.CONTAINER_IMAGE.replace('ugoku-trial-123', 'other-project') }, { CONTAINER_IMAGE: 'app:latest' }, { AI_ACCESS_SECRET_VERSION: 'latest' }, { CLOUD_RUN_SERVICE_ACCOUNT: 'ugoku-runtime@other-project.iam.gserviceaccount.com' }]) expect(() => vertexTrialPlan({ ...env, ...patch })).toThrow();
    expect(() => vertexTrialPlan({ ...env, VERTEX_PROJECT: 'other-project' })).toThrow('VERTEX_PROJECT');
    expect(vertexTrialPlan({}).manifest).toBeNull();
  });
  it('cannot execute or overwrite a saved review, even with ambient credentials', async () => {
    const result = spawnSync(process.execPath, ['scripts/deploy.mjs', '--vertex', '--execute'], { env: { PATH: '', GEMINI_API_KEY: 'must-not-print-key' }, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stdout).not.toContain('must-not-print-key');
    const dir = await mkdtemp(join(tmpdir(), 'ugoku-vertex-plan-')); const file = join(dir, 'plan.json');
    try {
      await printVertexTrialPlan(['--output', file], env); const before = await readFile(file, 'utf8');
      await expect(printVertexTrialPlan(['--output', file], { ...env, CLOUD_RUN_SERVICE: 'changed' })).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
