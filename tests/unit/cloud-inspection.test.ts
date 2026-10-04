import { describe, expect, it, vi } from 'vitest';
import { inspectCloud, isReadOnlyInspectionRequest, parseInspectionArgs } from '../../scripts/inspect-cloud.ts';

const target = { project: 'example-review-123', region: 'asia-northeast1', executeReadOnly: true };
const token = 'TOKEN_MUST_NEVER_BE_RECORDED_12345';
function local(args: string[]) {
  if (args[0] === 'version') return '{"Google Cloud SDK":"587.0.0"}';
  if (args[1] === 'list') return '[{"account":"private@example.test","status":"ACTIVE"}]';
  if (args[1] === 'print-access-token') return token;
  throw new Error('Unexpected local command');
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe('explicit read-only Cloud inspection', () => {
  it('requires explicit target, rejects repeated or mutation flags, and defaults to no calls', async () => {
    for (const args of [[], ['--project', target.project], ['--project', target.project, '--region', target.region, '--project', target.project], ['--project', target.project, '--region', target.region, '--execute'], ['--project', target.project, '--region', target.region, '--execute-read-only']]) expect(() => parseInspectionArgs(args)).toThrow();
    const options = parseInspectionArgs(['--project', target.project, '--region', target.region]);
    const local = vi.fn(); const request = vi.fn();
    const result = await inspectCloud(options, { local, request });
    expect(result.status).toBe('not_run'); expect(result.cloudRequests).toBe(0);
    expect(local).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it('stops before any cloud request when no active credentials exist', async () => {
    const request = vi.fn(); const commands: string[][] = [];
    const result = await inspectCloud(target, { request, local: args => { commands.push(args); return args[0] === 'version' ? '{}' : '[]'; } });
    expect(result.status).toBe('authentication_required'); expect(result.cloudRequests).toBe(0);
    expect(request).not.toHaveBeenCalled(); expect(commands).toHaveLength(2);
  });
  it('allowlists only selected project REST reads and the read-only permissions POST', () => {
    const get = `https://cloudresourcemanager.googleapis.com/v3/projects/${target.project}`;
    expect(isReadOnlyInspectionRequest(target, get, 'GET')).toBe(true);
    expect(isReadOnlyInspectionRequest(target, get + ':testIamPermissions', 'POST')).toBe(true);
    for (const [url, method] of [[get, 'DELETE'], [get, 'POST'], [get + ':setIamPolicy', 'POST'], [get + ':testIamPermissions?alt=json', 'POST'], [get.replace(target.project, 'other-project'), 'GET'], ['https://cloudresourcemanager.googleapis.com/v3/projects', 'GET'], ['https://evil.example/v3/projects/' + target.project, 'GET'], [get + '?access_token=secret', 'GET']]) expect(isReadOnlyInspectionRequest(target, url, method)).toBe(false);
  });
  it('keeps tokens/accounts/env out of results and reads only the candidate project', async () => {
    const commands: string[][] = []; const requests: { url: string; method: string }[] = [];
    const result = await inspectCloud(target, { local: args => { commands.push(args); return local(args); }, request: async (input, init) => {
      const url = String(input); requests.push({ url, method: init?.method ?? '' });
      expect(init?.redirect).toBe('error'); expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ' + token);
      if (url.includes(':testIamPermissions')) { expect(JSON.parse(String(init?.body)).permissions).toContain('run.services.create'); return reply({ permissions: ['run.services.get', 'unknown.permission'] }); }
      if (url.includes('cloudresourcemanager')) return reply({ projectId: target.project, name: 'projects/123456', state: 'ACTIVE' });
      if (url.includes('cloudbilling')) return reply({ projectId: target.project, billingEnabled: true, billingAccountName: 'billingAccounts/PRIVATE' });
      if (url.includes('serviceusage')) return reply({ services: [{ state: 'ENABLED', config: { name: 'run.googleapis.com', unknownSecret: token } }] });
      if (url.includes('cloudquotas')) return reply({ quotaInfos: [] });
      expect(new URL(url).searchParams.get('fields')).not.toContain('env');
      expect(new URL(url).searchParams.get('fields')).toContain('resources');
      return reply({ services: [{ name: 'projects/example-review-123/locations/asia-northeast1/services/app', template: { containers: [{ image: 'registry/image@sha256:abc', env: [{ name: 'SECRET', value: 'inline-secret' }] }] } }] });
    } });
    expect(result.status).toBe('inspected'); expect(result.cloudRequests).toBe(6);
    expect(commands.map(args => args.slice(0, 2))).toEqual([['version', '--format=json'], ['auth', 'list'], ['auth', 'print-access-token']]);
    for (const request of requests) expect(isReadOnlyInspectionRequest(target, request.url, request.method, '123456')).toBe(true);
    const serialized = JSON.stringify(result);
    for (const secret of [token, 'private@example.test', 'inline-secret', 'unknown.permission', 'unknownSecret']) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('billingAccounts/PRIVATE'); // Private report, never public stdout.
  });
  it('records disabled/denied reads without enabling APIs or leaking raw errors', async () => {
    const result = await inspectCloud(target, { local, request: async input => String(input).endsWith('/projects/' + target.project)
      ? reply({ projectId: target.project, name: 'projects/123456' })
      : reply({ error: { message: token, details: [{ reason: 'SERVICE_DISABLED' }] } }, 403) });
    expect(result.status).toBe('inspected'); expect(result.cloudWrites).toBe(0);
    expect(JSON.stringify(result)).toContain('api_disabled'); expect(JSON.stringify(result)).not.toContain(token);
  });
  it('refuses a mismatched project identity before billing, service or permissions requests', async () => {
    const request = vi.fn(async () => reply({ projectId: 'other-project', name: 'projects/123' }));
    const result = await inspectCloud(target, { local, request });
    expect(result.status).toBe('project_identity_mismatch'); expect(request).toHaveBeenCalledTimes(1);
  });
  it('marks pagination incomplete at its bound and preserves same-project addresses', async () => {
    let pages = 0;
    const result = await inspectCloud(target, { local, request: async input => {
      const url = String(input);
      if (url.endsWith('/projects/' + target.project)) return reply({ projectId: target.project, name: 'projects/123456' });
      if (url.includes('serviceusage')) return reply({ services: [], nextPageToken: 'page-' + ++pages });
      return reply({});
    } });
    expect(pages).toBe(5); expect(JSON.stringify(result)).toContain('bounded_page_limit');
  });
});
