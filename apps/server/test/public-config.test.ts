import { describe, expect, it } from 'vitest';
import { readConfig, publicStatus } from '../src/config.js';
export const publicEnvironment = {
  AI_PROVIDER: 'vertex', AI_ACCESS_SECRET: 'test-only-public-access-'.repeat(3), VERTEX_PROJECT: 'example-project', VERTEX_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.8-flash', VERTEX_MODEL_BUDGET_USD: '85', AI_PUBLIC_RELEASE: 'true', AI_LEDGER_BUCKET: 'example-private-ledger', AI_LEDGER_OBJECT: 'public-release-011/ledger.json', AI_RELEASE_PHASE: 'pre-release', AI_MAX_MODEL_CALLS: '6', AI_MAX_TOOL_CALLS: '4', AI_MAX_INPUT_BYTES: '32768', AI_MAX_OUTPUT_TOKENS: '2048', AI_TIMEOUT_MS: '90000', AI_MAX_CONCURRENT: '1', AI_RUNS_PER_MINUTE: '2', AI_MAX_RUNS_PER_HOUR: '4',
};
describe('public release configuration', () => {
  it('requires explicit limits and a separate ledger without exposing its identifiers', () => {
    const config = readConfig(publicEnvironment);
    expect(config.publicRelease?.phase).toBe('pre-release');
    expect(JSON.stringify(publicStatus(config))).not.toContain('example-private-ledger');
    expect(JSON.stringify(publicStatus(config))).not.toContain(config.accessSecret);
  });
  it.each([{ AI_PROVIDER: 'gemini' }, { VERTEX_MODEL_BUDGET_USD: '3.9' }, { VERTEX_TRIAL_PERMITS_REQUIRED: 'true' }, { AI_MAX_MODEL_CALLS: '7' }, { AI_MAX_TOOL_CALLS: '12' }, { AI_MAX_INPUT_BYTES: '65536' }, { AI_MAX_OUTPUT_TOKENS: '4096' }, { AI_MAX_CONCURRENT: '2' }, { AI_LEDGER_BUCKET: '' }, { AI_LEDGER_OBJECT: 'old-trial.json' }, { AI_RELEASE_PHASE: '' }])('rejects mixed trial/provider controls or increased limits: %j', override => {
    expect(() => readConfig({ ...publicEnvironment, ...override })).toThrow();
  });
});
