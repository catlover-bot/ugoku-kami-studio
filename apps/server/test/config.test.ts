import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadServerEnv, readConfig } from '../src/config.js';

const dirs: string[] = [];
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'ugoku-env-test-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('one offline configuration path', () => {
  it('loads only the selected env file, preserves process values and validates with readConfig', () => {
    const cwd = temporary();
    writeFileSync(join(cwd, '.env'), 'AI_ENABLED=false\nAI_MAX_MODEL_CALLS=4\nGEMINI_MODEL=gemini-3.8-flash\n');
    writeFileSync(join(cwd, '.env.local'), 'AI_ENABLED=true\n');
    const env: NodeJS.ProcessEnv = { AI_MAX_MODEL_CALLS: '2' };
    expect(loadServerEnv({ env, cwd })).toEqual({ path: join(cwd, '.env'), source: 'default', loaded: true });
    expect(readConfig(env)).toMatchObject({ aiEnabled: false, maxModelCalls: 2, model: 'gemini-3.8-flash' });
    writeFileSync(join(cwd, 'private.env'), 'AI_MAX_MODEL_CALLS=3\nAI_ENABLED=false\n');
    const selected: NodeJS.ProcessEnv = { UGOKU_ENV_FILE: 'private.env' };
    expect(loadServerEnv({ env: selected, cwd }).source).toBe('explicit');
    expect(readConfig(selected).maxModelCalls).toBe(3);
  });
  it('allows a missing default but rejects a missing or unreadable explicitly selected file', () => {
    const cwd = temporary();
    expect(loadServerEnv({ env: {}, cwd }).loaded).toBe(false);
    expect(() => loadServerEnv({ env: { UGOKU_ENV_FILE: 'absent.env' }, cwd })).toThrow('UGOKU_ENV_FILE does not exist');
    expect(() => loadServerEnv({ env: { UGOKU_ENV_FILE: cwd }, cwd })).toThrow('Environment file could not be read');
  });
  it('reports exact limit names without echoing bad values or accepting whitespace credentials', () => {
    expect(() => readConfig({ AI_MAX_INPUT_BYTES: 'private-value' })).toThrow('AI_MAX_INPUT_BYTES must be an integer');
    expect(() => readConfig({ AI_MAX_OUTPUT_TOKENS: '8193' })).toThrow('AI_MAX_OUTPUT_TOKENS');
    expect(() => readConfig({ AI_ENABLED: 'true', GEMINI_API_KEY: '  ', AI_ACCESS_SECRET: 's'.repeat(32) })).toThrow('requires');
    expect(() => readConfig({ AI_ENABLED: 'true', GEMINI_API_KEY: 'key', AI_ACCESS_SECRET: ' '.repeat(32) })).toThrow('requires');
  });
  it('doctor works with synthetic secrets while all outbound network primitives are blocked', () => {
    const cwd = temporary();
    const secret = 'synthetic-doctor-secret-not-a-live-value-';
    writeFileSync(join(cwd, 'network-guard.cjs'), "global.fetch=()=>{throw Error('NETWORK_FORBIDDEN')}; for(const name of ['node:http','node:https']) { const m=require(name); m.request=()=>{throw Error('NETWORK_FORBIDDEN')};m.get=m.request;} const net=require('node:net');net.connect=()=>{throw Error('NETWORK_FORBIDDEN')};net.createConnection=net.connect;");
    writeFileSync(join(cwd, 'doctor.env'), `AI_ENABLED=true\nGEMINI_API_KEY=${secret}key\nAI_ACCESS_SECRET=${secret}access\nAI_MAX_INPUT_BYTES=8192\nAI_MAX_OUTPUT_TOKENS=512\n`);
    const doctor = fileURLToPath(new URL('../../../scripts/doctor.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--require', join(cwd, 'network-guard.cjs'), doctor], { cwd, env: { PATH: process.env.PATH, UGOKU_ENV_FILE: join(cwd, 'doctor.env') }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain(secret); expect(output).not.toContain('NETWORK_FORBIDDEN');
    expect(output).toContain('"configurationValid": true');
    expect(output).toContain('"inputBytesPerCall": 8192');
    expect(output).toContain('"outputTokensPerCall": 512');
    expect(output).toContain('"remoteStatus": "not-tested"');
    expect(output).toContain('"paidApiCalls": 0');
    expect(output).toContain('"readyForExplicitLiveAuthorization": false');
    const explicit = spawnSync(process.execPath, ['--require', join(cwd, 'network-guard.cjs'), doctor], { cwd, env: { PATH: process.env.PATH, UGOKU_ENV_FILE: join(cwd, 'doctor.env'), GEMINI_MODEL: 'gemini-3.8-flash' }, encoding: 'utf8' });
    expect(explicit.status).toBe(0);
    expect(explicit.stdout).toContain('"readyForExplicitLiveAuthorization": true');
    expect(explicit.stdout + explicit.stderr).not.toContain(secret);
    expect(explicit.stdout).toContain('"paidApiCalls": 0');
    const invalid = spawnSync(process.execPath, [doctor], { cwd, env: { PATH: process.env.PATH, UGOKU_ENV_FILE: join(cwd, 'doctor.env'), AI_MAX_INPUT_BYTES: secret }, encoding: 'utf8' });
    expect(invalid.status).toBe(1); expect(invalid.stdout + invalid.stderr).not.toContain(secret);
    expect(invalid.stdout).toContain('AI_MAX_INPUT_BYTES');
  });
});
