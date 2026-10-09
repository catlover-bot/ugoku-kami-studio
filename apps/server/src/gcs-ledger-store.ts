import { LedgerStoreError, PUBLIC_LEDGER_LIMITS, type LedgerStoreFailureDetails, type PublicLedgerStore } from './public-ledger.js';

type Fetch = typeof fetch;
type Stage = LedgerStoreFailureDetails['stage'];
type Kind = LedgerStoreError['kind'];
export type AccessTokenProvider = (signal?: AbortSignal) => Promise<string>;
const GENERATION = /^[1-9]\d{0,30}$/;
// An entire read, including authentication and both generations' bodies, stays
// below the monitor's observation deadline. Only GETs have an extra attempt.
export const GCS_READ_BUDGET = Object.freeze({ totalMs: 4000, requestMs: 1500, attempts: 2 });
// Header text never enters diagnostic details. A long/invalid Retry-After means
// no second GET within this short observation, not an ignored server delay.
const retryDelays = new WeakMap<LedgerStoreError, number>();
const failure = (stage: Stage, category: LedgerStoreFailureDetails['category'], kind: Kind = 'unavailable', httpStatus?: number) => new LedgerStoreError(kind, { stage, category, ...(httpStatus === undefined ? {} : { httpStatus }) });
function classify(error: unknown, stage: Stage, signal?: AbortSignal, kind: Kind = 'unavailable'): LedgerStoreError {
  if (error instanceof LedgerStoreError) return error;
  const timeout = signal?.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
  return failure(stage, timeout ? 'timeout' : 'transport', kind);
}
function httpFailure(status: number, stage: Stage, kind: Kind = 'unavailable', retryAfter: string | null = null): LedgerStoreError {
  const category = status === 401 || status === 403 ? 'permission' : status === 404 ? 'missing' : status === 412 ? 'conflict' : 'http';
  const error = failure(stage, category, kind, status);
  if (retryAfter !== null) {
    const wait = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    retryDelays.set(error, Number.isFinite(wait) ? wait : Infinity);
  }
  return error;
}
function discard(response: Response) { void response.body?.cancel().catch(() => {}); }
async function retryWait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(failure('read-budget', 'timeout')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Race as well as abort: a stalled body or injected provider may ignore its
 * signal. A late result cannot cause another request or refresh token cache. */
async function bounded<T>(ms: number, parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new DOMException('Storage operation aborted', 'AbortError')); });
  signal.addEventListener('abort', rejectAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    signal.throwIfAborted();
    const result = await Promise.race([work(signal), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', rejectAbort); controller.abort();
  }
}
async function limitedText(response: Response, max: number, stage: Stage, signal: AbortSignal, kind: Kind = 'unavailable'): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) {
    discard(response); throw failure(stage, /^\d+$/.test(length) ? 'size' : 'invalid', kind);
  }
  if (!response.body) throw failure(stage, 'invalid', kind);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abortRead, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
      size += value.byteLength; if (size > max) throw failure(stage, 'size', kind); chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort', abortRead); abortRead(); reader.releaseLock(); }
}
function parseObject(text: string, stage: Stage, kind: Kind = 'unavailable'): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch { throw failure(stage, 'invalid', kind); }
}

/** Cloud Run service identity / ADC, obtained from the fixed metadata endpoint.
 * No env key, user token, gcloud process, remote credential URL, or disk cache.
 * https://docs.cloud.google.com/run/docs/securing/service-identity#fetching_access_and_id_tokens
 * Standalone callers retain 5s; a read passes its shorter parent deadline.
 */
export function createMetadataAccessToken(fetcher: Fetch = fetch, now: () => number = Date.now): AccessTokenProvider {
  let cached: { value: string; until: number } | undefined;
  return async signal => {
    let stage: Stage = 'token-http';
    try {
      signal?.throwIfAborted();
      if (cached && cached.until > now()) return cached.value;
      return await bounded(5000, signal, async tokenSignal => {
        const response = await fetcher('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: tokenSignal });
        tokenSignal.throwIfAborted();
        if (!response.ok) { discard(response); throw httpFailure(response.status, stage, 'unavailable', response.headers.get('retry-after')); }
        if (response.headers.get('metadata-flavor') !== 'Google') { discard(response); throw failure('token-validation', 'invalid'); }
        stage = 'token-body';
        const text = await limitedText(response, 16_384, stage, tokenSignal);
        stage = 'token-validation';
        const body = parseObject(text, stage);
        if (typeof body.access_token !== 'string' || body.access_token.length < 1 || body.access_token.length > 12_000 || body.token_type !== 'Bearer' || !Number.isSafeInteger(body.expires_in) || Number(body.expires_in) <= 60) throw failure(stage, 'invalid');
        tokenSignal.throwIfAborted();
        cached = { value: body.access_token, until: now() + Math.min(Number(body.expires_in) - 60, 3600) * 1000 };
        return cached.value;
      });
    } catch (error) { throw classify(error, stage, signal); }
  };
}
export const metadataAccessToken: AccessTokenProvider = createMetadataAccessToken();

/** Official JSON API generation CAS. Replacement needs objects.get/create/delete.
 * https://docs.cloud.google.com/storage/docs/request-preconditions
 * https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert
 * Endpoint is fixed; object/bucket are identifiers, never credential URLs.
 * A runtime 404 remains missing: this adapter never implicitly creates a ledger.
 */
export class GcsLedgerStore implements PublicLedgerStore {
  private readonly objectUrl: string;
  private readonly uploadUrl: string;
  private readonly token: AccessTokenProvider;
  private readonly fetcher: Fetch;
  private readonly signal?: AbortSignal;
  constructor(options: { bucket: string; object: string; accessToken?: AccessTokenProvider; fetch?: Fetch; signal?: AbortSignal }) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(options.bucket) || !options.object || Buffer.byteLength(options.object) > 1024 || [...options.object].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw failure('configuration', 'invalid');
    this.objectUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(options.bucket)}/o/${encodeURIComponent(options.object)}`;
    this.uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(options.bucket)}/o?uploadType=media&name=${encodeURIComponent(options.object)}`;
    this.token = options.accessToken ?? metadataAccessToken; this.fetcher = options.fetch ?? fetch; this.signal = options.signal;
  }
  private async accessToken(signal: AbortSignal | undefined, ms: number) {
    try { return await bounded(ms, signal, tokenSignal => this.token(tokenSignal)); }
    catch (error) { throw classify(error, 'token', signal); }
  }
  private async getText(url: string, max: number, operation: 'metadata' | 'media', signal: AbortSignal) {
    const token = await this.accessToken(signal, GCS_READ_BUDGET.requestMs);
    let stage: Stage = `${operation}-http`;
    try {
      return await bounded(GCS_READ_BUDGET.requestMs, signal, async requestSignal => {
        const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store', signal: requestSignal });
        requestSignal.throwIfAborted();
        if (!response.ok) { discard(response); throw httpFailure(response.status, stage, response.status === 404 ? 'missing' : 'unavailable', response.headers.get('retry-after')); }
        stage = `${operation}-body`;
        return limitedText(response, max, stage, requestSignal);
      });
    } catch (error) { throw classify(error, stage, signal); }
  }
  async read() {
    try {
      return await bounded(GCS_READ_BUDGET.totalMs, this.signal, async signal => {
        for (let attempt = 0; attempt < GCS_READ_BUDGET.attempts; attempt++) {
          try {
            const meta = parseObject(await this.getText(`${this.objectUrl}?fields=generation,size`, 16_384, 'metadata', signal), 'metadata-validation');
            if (typeof meta.generation !== 'string' || !GENERATION.test(meta.generation) || typeof meta.size !== 'string' || !/^\d+$/.test(meta.size)) throw failure('metadata-validation', 'invalid');
            if (Number(meta.size) > PUBLIC_LEDGER_LIMITS.maxBytes) throw failure('metadata-validation', 'size');
            const data = await this.getText(`${this.objectUrl}?alt=media&ifGenerationMatch=${meta.generation}`, PUBLIC_LEDGER_LIMITS.maxBytes, 'media', signal);
            if (Buffer.byteLength(data) !== Number(meta.size)) throw failure('media-validation', 'invalid');
            return { generation: meta.generation, data };
          } catch (error) {
            const details = error instanceof LedgerStoreError ? error.details : undefined;
            const retry = details?.category === 'timeout' || details?.category === 'transport' || (details?.category === 'conflict' && details.stage === 'media-http') || (details?.category === 'http' && details.httpStatus !== undefined && (details.httpStatus === 408 || details.httpStatus === 429 || details.httpStatus >= 500));
            const wait = Math.max(100, error instanceof LedgerStoreError ? retryDelays.get(error) ?? 0 : 0);
            if (signal.aborted || attempt + 1 >= GCS_READ_BUDGET.attempts || !retry || wait > 250) throw error;
            await retryWait(wait, signal);
          }
        }
        throw failure('read-budget', 'timeout');
      });
    } catch (error) { throw classify(error, 'read-budget', this.signal); }
  }
  async compareAndSwap(generation: string, data: string): Promise<string> {
    if (!(generation === '0' || GENERATION.test(generation)) || Buffer.byteLength(data) > PUBLIC_LEDGER_LIMITS.maxBytes) throw failure('write-validation', 'invalid');
    // Generation 0 is solely for explicit deployment initialization. Never
    // replay an ambiguous POST: PublicLedger verifies its receipt with a GET.
    const token = await this.accessToken(this.signal, 5000);
    let stage: Stage = 'write-http', dispatched = false;
    try {
      return await bounded(5000, this.signal, async signal => {
        signal.throwIfAborted(); dispatched = true;
        const response = await this.fetcher(`${this.uploadUrl}&ifGenerationMatch=${generation}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data, redirect: 'error', signal });
        signal.throwIfAborted();
        if (!response.ok) {
          discard(response);
          throw httpFailure(response.status, stage, response.status === 412 ? 'conflict' : response.status >= 500 || response.status === 408 ? 'uncertain' : 'unavailable');
        }
        stage = 'write-body';
        const text = await limitedText(response, 16_384, stage, signal, 'uncertain');
        stage = 'write-validation';
        const body = parseObject(text, stage, 'uncertain');
        if (typeof body.generation !== 'string' || !GENERATION.test(body.generation) || body.generation === generation) throw failure(stage, 'invalid', 'uncertain');
        return body.generation;
      });
    } catch (error) { throw classify(error, stage, this.signal, dispatched ? 'uncertain' : 'unavailable'); }
  }
}
