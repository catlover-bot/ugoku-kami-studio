import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publicStatus, readConfig } from '../src/config.js';
import { GeminiProvider, VertexProvider } from '../src/provider.js';

const env = { AI_PROVIDER: 'vertex', VERTEX_PROJECT: 'offline-project', VERTEX_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.8-flash', AI_ACCESS_SECRET: 'synthetic-access-secret-for-offline-test' };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('explicit Vertex configuration, never cloud discovery', () => {
  it('requires the selected project, global location and single supported model independently of SDK environment', () => {
    const config = readConfig({ ...env, GEMINI_API_KEY: 'stored-key-not-authorization', GOOGLE_API_KEY: 'ambient-key', GOOGLE_CLOUD_PROJECT: 'another-project', GOOGLE_CLOUD_LOCATION: 'us-central1' });
    expect(config).toMatchObject({ provider: 'vertex', aiEnabled: true, apiKey: '', model: 'gemini-3.8-flash', vertex: { project: 'offline-project', location: 'global', apiVersion: 'v1', endpoint: 'https://aiplatform.googleapis.com' } });
    expect(() => new GeminiProvider(config)).toThrow('explicit');
    expect(() => new VertexProvider(readConfig({}))).toThrow('explicit');
    expect(readConfig({ ...env, AI_PROVIDER: '', GOOGLE_GENAI_USE_VERTEXAI: 'true' }).provider).toBe('none');
    const status = publicStatus(config);
    expect(status.ai).toMatchObject({ provider: 'vertex', mode: 'vertex', sendsImage: false, connectionStatus: 'not-tested', authentication: 'ADC', location: 'global', apiVersion: 'v1' });
    expect(JSON.stringify(status)).not.toMatch(/offline-project|synthetic-access|stored-key|ambient-key/);
  });
  it.each([
    { VERTEX_PROJECT: '' }, { VERTEX_PROJECT: 'https://not-used.invalid' },
    { VERTEX_LOCATION: '' }, { VERTEX_LOCATION: 'asia-northeast1' },
    { VERTEX_MODEL: '' }, { VERTEX_MODEL: 'gemini-2.5-flash' }, { VERTEX_MODEL: 'models/gemini-3.8-flash' },
    { AI_ACCESS_SECRET: '' },
  ])('fails closed for incomplete/unsupported explicit values: %o', changes => {
    expect(() => readConfig({ ...env, ...changes, GOOGLE_CLOUD_PROJECT: 'ambient-project', GEMINI_API_KEY: 'not-a-fallback' })).toThrow();
  });
  it('doctor reports only configuration readiness without loading ADC, making requests or exposing project/secrets', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ugoku-vertex-doctor-')); dirs.push(cwd);
    const guard = join(cwd, 'network-guard.cjs');
    writeFileSync(guard, "global.fetch=()=>{throw Error('NETWORK_FORBIDDEN')}; for(const name of ['node:http','node:https']) { const m=require(name);m.request=()=>{throw Error('NETWORK_FORBIDDEN')};m.get=m.request; } const net=require('node:net');net.connect=()=>{throw Error('NETWORK_FORBIDDEN')};net.createConnection=net.connect;");
    const doctor = fileURLToPath(new URL('../../../scripts/doctor.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--require', guard, doctor], { cwd, env: { PATH: process.env.PATH, ...env, GOOGLE_APPLICATION_CREDENTIALS: join(cwd, 'deliberately-absent-adc.json'), GEMINI_API_KEY: 'synthetic-private-key-not-real' }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"vertexConfigurationReady": true');
    expect(result.stdout).toContain('"vertexAuthenticationVerified": false');
    expect(result.stdout).toContain('"adcStatus": "not-tested"');
    expect(result.stdout).toContain('"networkRequests": 0');
    expect(result.stdout).toContain('"readyForExplicitLiveAuthorization": false');
    expect(result.stdout + result.stderr).not.toMatch(/offline-project|synthetic-access|synthetic-private|deliberately-absent|NETWORK_FORBIDDEN/);
  });
});
