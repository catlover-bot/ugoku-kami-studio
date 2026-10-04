import { execFileSync } from 'node:child_process';
import { chmod, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InspectionOptions {
  project: string; region: string; executeReadOnly: boolean;
  gcloud?: string; configDir?: string; output?: string;
}
type Json = Record<string, unknown>;
type Dependencies = { local: (args: string[]) => string; request: typeof fetch };
const permissions = [
  'resourcemanager.projects.get', 'serviceusage.services.list', 'serviceusage.services.use',
  'serviceusage.services.enable', 'run.services.list', 'run.services.get', 'run.services.create',
  'run.services.update', 'run.services.delete', 'run.services.getIamPolicy', 'run.services.setIamPolicy',
  'iam.serviceAccounts.list', 'iam.serviceAccounts.create', 'iam.serviceAccounts.actAs',
  'artifactregistry.repositories.list', 'artifactregistry.repositories.create', 'artifactregistry.repositories.uploadArtifacts',
  'cloudbuild.builds.create', 'cloudbuild.builds.get', 'secretmanager.secrets.list',
  'secretmanager.secrets.create', 'secretmanager.secrets.setIamPolicy', 'secretmanager.versions.add',
];
export function parseInspectionArgs(args: string[]): InspectionOptions {
  const values: Record<string, string> = {}; let executeReadOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute-read-only' && !executeReadOnly) { executeReadOnly = true; continue; }
    if (!['--project', '--region', '--gcloud', '--config-dir', '--output'].includes(arg) || arg in values || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid or duplicate inspection argument');
    values[arg] = args[++i];
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(values['--project'] ?? '')) throw new Error('Explicit project ID required');
  if (!/^[a-z]+-[a-z]+\d+$/.test(values['--region'] ?? '')) throw new Error('Explicit region required');
  if (executeReadOnly && (!isAbsolute(values['--gcloud'] ?? '') || !isAbsolute(values['--config-dir'] ?? '') || !values['--output'])) throw new Error('Read-only execution requires absolute CLI/config paths and a private output file');
  return { project: values['--project'], region: values['--region'], executeReadOnly, gcloud: values['--gcloud'], configDir: values['--config-dir'], output: values['--output'] };
}
export function inspectionPlan(options: InspectionOptions) {
  return {
    mode: options.executeReadOnly ? 'read-only' : 'plan', project: options.project, region: options.region,
    cloudWrites: 0, deploymentApproved: false,
    operations: ['Local gcloud version and active credential presence (account is not reported)',
      'GET specified project metadata', 'GET specified project billing association',
      'GET enabled APIs in specified project', 'GET Cloud Run service summaries in specified project/region',
      'GET Cloud Run quota metadata in specified project (region applicability retained)',
      'POST specified project testIamPermissions (read-only; never sets IAM)'],
    limitations: ['No login, API enablement, IAM mutation, service creation/deployment or model invocation',
      'No other projects or billing accounts are listed; no secret values or container environment values are read',
      'Project-level permissions do not prove resource-level grants, organization policies, available capacity or deployment compatibility',
      'Quota API disabled or permission denied remains unknown; quota availability does not guarantee capacity'],
  };
}
export function isReadOnlyInspectionRequest(options: InspectionOptions, address: string, method: string, projectNumber?: string): boolean {
  const url = new URL(address);
  if (url.username || url.password || url.hash || url.protocol !== 'https:') return false;
  const project = options.project;
  const endpoints = new Set([
    `https://cloudresourcemanager.googleapis.com/v3/projects/${project}`,
    `https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`,
    `https://run.googleapis.com/v2/projects/${project}/locations/${options.region}/services`,
    ...(projectNumber && /^\d+$/.test(projectNumber) ? [
      `https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services`,
      `https://cloudquotas.googleapis.com/v1/projects/${projectNumber}/locations/global/services/run.googleapis.com/quotaInfos`,
    ] : []),
  ]);
  if (method === 'POST') return !url.search && url.href === `https://cloudresourcemanager.googleapis.com/v3/projects/${project}:testIamPermissions`;
  return method === 'GET' && endpoints.has(url.origin + url.pathname) && [...url.searchParams.keys()].every(key => ['filter', 'pageSize', 'pageToken', 'fields'].includes(key));
}
function object(value: unknown): Json { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function pick(value: unknown, keys: string[]): Json {
  const source = object(value); return Object.fromEntries(keys.filter(key => key in source).map(key => [key, source[key]]));
}
function serviceSummary(value: unknown) {
  const item = object(value); const template = object(item.template);
  return { ...pick(item, ['name', 'uri', 'createTime', 'updateTime', 'ingress', 'launchStage', 'scaling']),
    template: { ...pick(template, ['serviceAccount', 'executionEnvironment', 'scaling', 'timeout', 'maxInstanceRequestConcurrency']),
      containers: Array.isArray(template.containers) ? template.containers.map(container => pick(container, ['name', 'image', 'resources', 'ports'])) : [] } };
}
async function boundedJson(response: Response): Promise<Json> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Invalid response');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > 2_000_000) throw new Error('Response limit'); chunks.push(value); }
  } finally { await reader.cancel(); }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
/** Only local credential inspection and an explicit allowlist of REST reads. No gcloud cloud command can auto-enable an API. */
export async function inspectCloud(options: InspectionOptions, deps: Dependencies) {
  const plan = inspectionPlan(options);
  if (!options.executeReadOnly) return { ...plan, status: 'not_run', cloudRequests: 0 };
  const results: Json = {}; let cloudRequests = 0; const scope: { projectNumber?: string } = {};
  const finish = (status: string) => ({ ...plan, status, checkedAt: new Date().toISOString(), cloudRequests, results });
  let account: string; let token: string;
  try {
    const version = object(JSON.parse(deps.local(['version', '--format=json'])));
    results.cli = { version: version['Google Cloud SDK'] };
    const active: unknown = JSON.parse(deps.local(['auth', 'list', '--filter=status:ACTIVE', '--format=json(account,status)', '--quiet']));
    if (!Array.isArray(active) || active.length !== 1 || typeof object(active[0]).account !== 'string') return finish('authentication_required');
    account = object(active[0]).account as string;
    token = deps.local(['auth', 'print-access-token', `--account=${account}`, `--project=${options.project}`, '--quiet']).trim();
    if (!/^[A-Za-z0-9._~+/=-]{16,16384}$/.test(token)) return finish('authentication_required');
  } catch { return finish('authentication_required'); }
  const call = async (url: string, body?: Json): Promise<{ ok: boolean; data?: Json; httpStatus?: number; reason?: string }> => {
    const method = body ? 'POST' : 'GET';
    if (!isReadOnlyInspectionRequest(options, url, method, scope.projectNumber)) throw new Error('Request outside read-only scope');
    cloudRequests++;
    try {
      const response = await deps.request(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-goog-user-project': options.project }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await boundedJson(response);
      if (!response.ok) {
        const error = object(data.error); const details = Array.isArray(error.details) ? error.details : [];
        const disabled = details.some(item => object(item).reason === 'SERVICE_DISABLED');
        return { ok: false, httpStatus: response.status, reason: disabled ? 'api_disabled' : response.status === 403 ? 'permission_denied' : response.status === 401 ? 'authentication_required' : 'read_failed' };
      }
      return { ok: true, data };
    } catch { return { ok: false, reason: 'network_or_response_failure' }; }
  };
  const project = await call(`https://cloudresourcemanager.googleapis.com/v3/projects/${options.project}`);
  if (!project.ok) { results.project = project; return finish('project_unverified'); }
  if (project.data?.projectId !== options.project || !/^projects\/\d+$/.test(String(project.data.name))) return finish('project_identity_mismatch');
  results.project = pick(project.data, ['name', 'projectId', 'state', 'displayName', 'createTime']);
  const projectNumber = String(project.data.name).slice('projects/'.length); scope.projectNumber = projectNumber;
  const billing = await call(`https://cloudbilling.googleapis.com/v1/projects/${options.project}/billingInfo`);
  results.billing = billing.ok ? { ok: true, data: pick(billing.data, ['projectId', 'billingEnabled', 'billingAccountName']) } : billing;
  async function pages(url: string, field: string, select: (entry: unknown) => unknown) {
    const items: unknown[] = []; const seen = new Set<string>(); let next: string | undefined;
    for (let page = 0; page < 5; page++) {
      const address = new URL(url); if (next) address.searchParams.set('pageToken', next);
      const result = await call(address.href);
      if (!result.ok) return { ...result, items, complete: false };
      const data = result.data!;
      if (data[field] !== undefined && !Array.isArray(data[field])) return { ok: false, reason: 'invalid_list_response', items, complete: false };
      items.push(...((data[field] ?? []) as unknown[]).map(select));
      next = typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined;
      if (!next) return { ok: true, items, complete: true };
      if (next.length > 4096 || seen.has(next)) return { ok: false, reason: 'invalid_pagination', items, complete: false };
      seen.add(next);
    }
    return { ok: true, items, complete: false, reason: 'bounded_page_limit' };
  }
  results.enabledApis = await pages(`https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services?filter=state:ENABLED&pageSize=200`, 'services', entry => ({ name: object(object(entry).config).name, state: object(entry).state }));
  const serviceFields = 'services(name,uri,createTime,updateTime,ingress,launchStage,scaling,template(serviceAccount,executionEnvironment,scaling,timeout,maxInstanceRequestConcurrency,containers(name,image,resources,ports))),nextPageToken';
  results.cloudRun = await pages(`https://run.googleapis.com/v2/projects/${options.project}/locations/${options.region}/services?pageSize=100&fields=${encodeURIComponent(serviceFields)}`, 'services', serviceSummary);
  results.quotas = await pages(`https://cloudquotas.googleapis.com/v1/projects/${projectNumber}/locations/global/services/run.googleapis.com/quotaInfos?pageSize=200`, 'quotaInfos', entry => pick(entry, ['name', 'metric', 'quotaId', 'metricUnit', 'dimensions', 'dimensionsInfos', 'refreshInterval', 'isPrecise', 'quotaIncreaseEligibility']));
  const iam = await call(`https://cloudresourcemanager.googleapis.com/v3/projects/${options.project}:testIamPermissions`, { permissions });
  const granted = Array.isArray(iam.data?.permissions) ? iam.data.permissions.filter((item): item is string => typeof item === 'string' && permissions.includes(item)) : [];
  results.permissions = iam.ok ? { ok: true, scope: 'project-level; not a grant or deployment approval', granted, notReturned: permissions.filter(permission => !granted.includes(permission)) } : iam;
  return finish('inspected');
}
function localRunner(options: InspectionOptions) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { CLOUDSDK_CONFIG: options.configDir, CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true', CLOUDSDK_CORE_DISABLE_PROMPTS: 'true', CLOUDSDK_CORE_LOG_HTTP: 'false' });
  return (args: string[]) => execFileSync(options.gcloud!, args, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
export async function inspectionMain(args: string[]) {
  const options = parseInspectionArgs(args);
  if (!options.executeReadOnly) { console.log(JSON.stringify(inspectionPlan(options), null, 2)); return; }
  const privateDir = resolve('artifacts/submission/private'); const output = resolve(options.output!);
  if (dirname(output) !== privateDir || !output.endsWith('.json')) throw new Error('Output must be a JSON file directly under artifacts/submission/private');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  if (await realpath(privateDir) !== privateDir) throw new Error('Private output directory must not be a symlink');
  await chmod(privateDir, 0o700);
  const file = await open(output, 'wx', 0o600);
  try {
    const result = await inspectCloud(options, { local: localRunner(options), request: fetch });
    await file.writeFile(JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ status: result.status, cloudRequests: result.cloudRequests, cloudWrites: 0, resultSavedPrivately: true }));
  } finally { await file.close(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  inspectionMain(process.argv.slice(2)).catch(() => { console.error('Inspection failed. Check explicit arguments, CLI/config paths and unused private output path. No raw credential or remote error details are printed.'); process.exitCode = 1; });
}
