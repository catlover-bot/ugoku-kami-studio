import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cloudRunPlan, printCloudRunPlan, PINNED_MODEL_DIGEST } from '../../scripts/cloud-run-plan';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'ugoku-deployment-')); temporary.push(path); return path; }
const env = {
  GCP_PROJECT: 'ugoku-test-123', GCP_REGION: 'asia-northeast1', CLOUD_RUN_SERVICE: 'ugoku-kami',
  CONTAINER_IMAGE: `asia-northeast1-docker.pkg.dev/ugoku-test-123/images/app@sha256:${'a'.repeat(64)}`,
  OLLAMA_CONTAINER_IMAGE: `asia-northeast1-docker.pkg.dev/ugoku-test-123/images/ollama@sha256:${'b'.repeat(64)}`,
  CLOUD_RUN_SERVICE_ACCOUNT: 'ugoku-runtime@ugoku-test-123.iam.gserviceaccount.com',
  AI_ACCESS_SECRET_NAME: 'review-ai-access', AI_ACCESS_SECRET_VERSION: '1',
};
function verify(root: string, entries: unknown[], exact = true) {
  const verifier = pathToFileURL(resolve('deployment/ollama/verify-bundle.mjs')).href;
  return execFileSync(process.execPath, ['--input-type=module', '-e', `import {verifyFiles} from ${JSON.stringify(verifier)}; await verifyFiles(process.argv[1], JSON.parse(process.argv[2]), ${exact});`, root, JSON.stringify(entries)], { encoding: 'utf8', stdio: 'pipe' });
}
describe('deployment preparation stays offline and separate from runtime success', () => {
  it('keeps default manual dry-run and rejects an execute flag without requiring any cloud CLI', () => {
    const result = spawnSync(process.execPath, ['scripts/deploy.mjs'], { encoding: 'utf8', env: { PATH: '', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'secret-must-not-print' } });
    expect(result.status).toBe(0); expect(result.stdout).toContain('AI_PROVIDER=none'); expect(result.stdout).not.toContain('secret-must-not-print');
    expect(spawnSync(process.execPath, ['scripts/deploy.mjs', '--execute'], { encoding: 'utf8', env: { PATH: '' } }).status).toBe(1);
    expect(spawnSync(process.execPath, ['scripts/deploy.mjs', '--ollama', '--execute'], { encoding: 'utf8', env: { PATH: '' } }).status).toBe(1);
  });
  it('generates pinned same-instance CPU-always-on configuration while distinguishing HTTP and model concurrency', () => {
    const plan = cloudRunPlan({ ...env, AI_ACCESS_SECRET: 'secret-must-not-print', GEMINI_API_KEY: 'unused-secret' });
    expect(plan.status).toBe('offline-plan-ready-for-review'); expect(plan.cloudWrites).toBe(0); expect(plan.applied).toBe(false);
    const template = plan.manifest!.spec.template;
    expect(plan.manifest!.metadata.annotations['run.googleapis.com/maxScale']).toBe('1');
    expect(template.metadata.annotations).toMatchObject({ 'run.googleapis.com/cpu-throttling': 'false', 'run.googleapis.com/container-dependencies': '{"app":["ollama"]}', 'autoscaling.knative.dev/maxScale': '1' });
    expect(template.spec.containerConcurrency).toBe(8);
    expect(template.spec.containers.filter(container => 'ports' in container)).toHaveLength(1);
    const vars = template.spec.containers[0]!.env!;
    expect(vars).toContainEqual({ name: 'AI_MAX_CONCURRENT', value: '1' });
    expect(vars).toContainEqual({ name: 'OLLAMA_MODEL_DIGEST', value: PINNED_MODEL_DIGEST });
    expect(vars).toContainEqual({ name: 'AI_ACCESS_SECRET', valueFrom: { secretKeyRef: { name: env.AI_ACCESS_SECRET_NAME, key: '1' } } });
    expect(JSON.stringify(plan)).not.toContain('secret-must-not-print'); expect(JSON.stringify(plan)).not.toContain('unused-secret');
    expect(plan.resourcesPerInstance).toMatchObject({ cpu: 5, memoryGiB: 9, appAiConcurrency: 1, ollamaParallel: 1 });
    expect(plan.missingVerification).toContain('model container build/run');
  });
  it.each([
    { CONTAINER_IMAGE: 'registry/image:latest' }, { OLLAMA_CONTAINER_IMAGE: env.OLLAMA_CONTAINER_IMAGE.replace('ugoku-test-123', 'other-project') },
    { AI_ACCESS_SECRET_VERSION: 'latest' }, { CLOUD_RUN_SERVICE: 'bad;command' }, { GCP_REGION: 'bad/path' },
  ])('rejects unpinned or ambiguous deployment targets %j', override => { expect(() => cloudRunPlan({ ...env, ...override })).toThrow(); });
  it('does not fabricate a manifest from missing target inputs and never overwrites a reviewed plan', async () => {
    expect(cloudRunPlan({}).manifest).toBeNull();
    const out = await directory();
    await printCloudRunPlan(['--output', out], env);
    const before = await readFile(join(out, 'service.json'), 'utf8');
    await expect(printCloudRunPlan(['--output', out], { ...env, CLOUD_RUN_SERVICE: 'changed' })).rejects.toThrow();
    expect(await readFile(join(out, 'service.json'), 'utf8')).toBe(before);
  });
  it('validates real file bytes, parent paths and allowlists before bundling model/runtime assets', async () => {
    const root = await directory(); await mkdir(join(root, 'files')); await writeFile(join(root, 'files/blob'), 'model-fixture');
    const item = { path: 'files/blob', size: 13, sha256: createHash('sha256').update('model-fixture').digest('hex') };
    expect(() => verify(root, [item])).not.toThrow();
    await writeFile(join(root, 'files/blob'), 'model-tampered'); expect(() => verify(root, [item])).toThrow();
    await writeFile(join(root, 'files/blob'), 'model-fixture'); await writeFile(join(root, 'secret'), 'must-not-be-bundled');
    expect(() => verify(root, [item])).toThrow();
    await rm(join(root, 'secret')); await symlink(join(root, 'files'), join(root, 'alias'));
    expect(() => verify(root, [{ ...item, path: 'alias/blob' }], false)).toThrow();
    expect(() => verify(root, [{ ...item, path: '../outside' }], false)).toThrow();
  });
});
