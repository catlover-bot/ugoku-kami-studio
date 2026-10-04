import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

type ProcessMemory = { pid: number; rssBytes: number };
export type MemorySample = {
  elapsedMs: number;
  system: { totalBytes: number; availableBytes: number } | null;
  ollama: { processes: ProcessMemory[]; rssSumBytes: number } | null;
};
type LoadedModel = { name: string; digest: string; sizeBytes: number; sizeVramBytes: number; contextLength: number | null };
export type LoadedSnapshot = { status: 'measured' | 'unavailable'; models: LoadedModel[] };
export type LocalMetricsReport = {
  intervalMs: number; elapsedMs: number; parentPid: number | null;
  processStatus: 'measured' | 'not-measured'; skippedSamples: number;
  samples: MemorySample[]; peakRssSumBytes: number | null;
  minimumSystemAvailableBytes: number | null;
  loadedBefore: LoadedSnapshot; loadedAfter: LoadedSnapshot;
  caveats: string[];
};
export function parseOllamaPid(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 1) throw new Error('Invalid measurement PID');
  return Number(value);
}
function startTicks(stat: string): string | undefined {
  // comm can contain spaces or parentheses. Field22 follows the final closing parenthesis.
  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}
async function identity(pid: number) { return startTicks(await readFile(`/proc/${pid}/stat`, 'utf8')); }
async function systemMemory(): Promise<MemorySample['system']> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const total = /^MemTotal:\s+(\d+) kB$/m.exec(text), available = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
    return total && available ? { totalBytes: Number(total[1]) * 1024, availableBytes: Number(available[1]) * 1024 } : null;
  } catch { return null; }
}
async function processMemory(parentPid: number, expectedStart: string): Promise<MemorySample['ollama']> {
  try {
    if (await identity(parentPid) !== expectedStart) return null;
    const pending = [parentPid], visited = new Set<number>(), processes: ProcessMemory[] = [];
    while (pending.length && visited.size < 128) {
      const pid = pending.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
        if (rss) processes.push({ pid, rssBytes: Number(rss[1]) * 1024 });
        // Go can launch a child from any thread. Inspect only tasks of this
        // process tree, never enumerate other users' processes or read argv.
        const tasks = (await readdir(`/proc/${pid}/task`)).filter(task => /^\d+$/.test(task)).slice(0, 1024);
        const children = await Promise.all(tasks.map(task => readFile(`/proc/${pid}/task/${task}/children`, 'utf8').catch(() => '')));
        for (const child of children.flatMap(text => text.trim().split(/\s+/)).filter(Boolean)) {
          const number = Number(child);
          if (Number.isSafeInteger(number) && number > 1 && !visited.has(number)) pending.push(number);
        }
      } catch { /* A child may finish between samples. */ }
    }
    if (pending.length || await identity(parentPid) !== expectedStart || !processes.some(item => item.pid === parentPid)) return null;
    return { processes, rssSumBytes: processes.reduce((sum, item) => sum + item.rssBytes, 0) };
  } catch { return null; }
}
async function loadedModels(baseUrl: string, model: string): Promise<LoadedSnapshot> {
  const unavailable: LoadedSnapshot = { status: 'unavailable', models: [] };
  try {
    const response = await fetch(`${baseUrl}/api/ps`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok || !response.body) return unavailable;
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65_536) { await reader.cancel(); return unavailable; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || !('models' in body) || !Array.isArray(body.models)) return unavailable;
    const models: LoadedModel[] = [];
    for (const value of body.models) {
      if (!value || typeof value !== 'object' || value.name !== model) continue;
      if (value.remote_host || value.remote_model || typeof value.digest !== 'string' || !/^(sha256:)?[a-f0-9]{64}$/.test(value.digest)) return unavailable;
      if (![value.size, value.size_vram].every(number => Number.isSafeInteger(number) && number >= 0)) return unavailable;
      models.push({ name: model, digest: value.digest, sizeBytes: value.size, sizeVramBytes: value.size_vram, contextLength: Number.isSafeInteger(value.context_length) && value.context_length > 0 ? value.context_length : null });
    }
    return { status: 'measured', models };
  } catch { return unavailable; }
}

/** Passive measurements only: /api/ps does not load, generate or unload models. */
export async function startLocalMetrics(options: { baseUrl: string; model: string; ollamaPid?: number; intervalMs?: number }) {
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(options.baseUrl)) throw new Error('Metrics require literal loopback');
  const endpoint = new URL(options.baseUrl);
  if (!endpoint.port || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535) throw new Error('Invalid measurement port');
  const parentPid = parseOllamaPid(options.ollamaPid?.toString());
  const intervalMs = options.intervalMs ?? 500;
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 5000) throw new Error('Invalid measurement interval');
  const parentStart = parentPid ? await identity(parentPid).catch(() => undefined) : undefined;
  const started = performance.now(), samples: MemorySample[] = [];
  let pending: Promise<void> | undefined, skippedSamples = 0;
  const sample = async () => {
    const [system, ollama] = await Promise.all([systemMemory(), parentPid && parentStart ? processMemory(parentPid, parentStart) : Promise.resolve(null)]);
    samples.push({ elapsedMs: Math.round(performance.now() - started), system, ollama });
  };
  await sample();
  const loadedBefore = await loadedModels(options.baseUrl, options.model);
  const timer = setInterval(() => {
    if (pending) { skippedSamples++; return; }
    pending = sample().finally(() => { pending = undefined; });
  }, intervalMs);
  timer.unref();
  let stopped: Promise<LocalMetricsReport> | undefined;
  return { stop(): Promise<LocalMetricsReport> {
    return stopped ??= (async () => {
      clearInterval(timer); await pending; await sample();
      const loadedAfter = await loadedModels(options.baseUrl, options.model);
      const rss = samples.flatMap(value => value.ollama ? [value.ollama.rssSumBytes] : []);
      const available = samples.flatMap(value => value.system ? [value.system.availableBytes] : []);
      return { intervalMs, elapsedMs: Math.round(performance.now() - started), parentPid: parentPid ?? null,
        processStatus: rss.length ? 'measured' : 'not-measured', skippedSamples, samples,
        peakRssSumBytes: rss.length ? Math.max(...rss) : null, minimumSystemAvailableBytes: available.length ? Math.min(...available) : null,
        loadedBefore, loadedAfter, caveats: [
          'RSS is the sum for the explicitly supplied parent PID and observed descendants; shared pages can be counted more than once.',
          'WSL MemAvailable covers the whole environment, not memory attributable only to this trial.',
          '500ms sampling can miss brief peaks. A missing/exited/reused PID is not reported as zero memory.',
          '/api/ps reports loaded model allocation, not downloaded file size or total process RAM. Other loaded models are omitted.',
        ] };
    })();
  } };
}
