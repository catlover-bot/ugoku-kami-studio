import { LedgerStoreError, PUBLIC_LEDGER_LIMITS, type PublicLedgerStore } from './public-ledger.js';

type Fetch = typeof fetch;
export type AccessTokenProvider = () => Promise<string>;
const GENERATION = /^[1-9]\d{0,30}$/;
async function limitedText(response: Response, max: number): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) { await response.body?.cancel(); throw new LedgerStoreError('unavailable'); }
  if (!response.body) throw new LedgerStoreError('unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) throw new LedgerStoreError('unavailable'); chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Cloud Run service identity / ADC, obtained from the fixed metadata endpoint.
 * No env key, user token, gcloud process, remote credential URL, or disk cache.
 * https://docs.cloud.google.com/run/docs/securing/service-identity#fetching_access_and_id_tokens
 */
export function createMetadataAccessToken(fetcher: Fetch = fetch, now: () => number = Date.now): AccessTokenProvider {
  let cached: { value: string; until: number } | undefined;
  return async () => {
    if (cached && cached.until > now()) return cached.value;
    try {
      const response = await fetcher('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok || response.headers.get('metadata-flavor') !== 'Google') throw new Error();
      const body = JSON.parse(await limitedText(response, 16_384)) as Record<string, unknown>;
      if (typeof body.access_token !== 'string' || body.access_token.length < 1 || body.access_token.length > 12_000 || body.token_type !== 'Bearer' || !Number.isSafeInteger(body.expires_in) || Number(body.expires_in) <= 60) throw new Error();
      cached = { value: body.access_token, until: now() + Math.min(Number(body.expires_in) - 60, 3600) * 1000 };
      return cached.value;
    } catch { throw new LedgerStoreError('unavailable'); }
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
  constructor(options: { bucket: string; object: string; accessToken?: AccessTokenProvider; fetch?: Fetch }) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(options.bucket) || !options.object || Buffer.byteLength(options.object) > 1024 || [...options.object].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new LedgerStoreError('unavailable');
    this.objectUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(options.bucket)}/o/${encodeURIComponent(options.object)}`;
    this.uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(options.bucket)}/o?uploadType=media&name=${encodeURIComponent(options.object)}`;
    this.token = options.accessToken ?? metadataAccessToken; this.fetcher = options.fetch ?? fetch;
  }
  private readonly token: AccessTokenProvider;
  private readonly fetcher: Fetch;
  private async get(url: string) {
    return this.fetcher(url, { headers: { Authorization: `Bearer ${await this.token()}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
  }
  async read() {
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await this.get(`${this.objectUrl}?fields=generation,size`);
        if (response.status === 404) { await response.body?.cancel(); throw new LedgerStoreError('missing'); }
        if (!response.ok) { await response.body?.cancel(); throw new LedgerStoreError('unavailable'); }
        const meta = JSON.parse(await limitedText(response, 16_384)) as Record<string, unknown>;
        if (typeof meta.generation !== 'string' || !GENERATION.test(meta.generation) || typeof meta.size !== 'string' || !/^\d+$/.test(meta.size) || Number(meta.size) > PUBLIC_LEDGER_LIMITS.maxBytes) throw new LedgerStoreError('unavailable');
        const media = await this.get(`${this.objectUrl}?alt=media&ifGenerationMatch=${meta.generation}`);
        if (media.status === 412) { await media.body?.cancel(); continue; }
        if (!media.ok) { await media.body?.cancel(); throw new LedgerStoreError('unavailable'); }
        const data = await limitedText(media, PUBLIC_LEDGER_LIMITS.maxBytes);
        if (Buffer.byteLength(data) !== Number(meta.size)) throw new LedgerStoreError('unavailable');
        return { generation: meta.generation, data };
      }
      throw new LedgerStoreError('unavailable');
    } catch (error) { if (error instanceof LedgerStoreError) throw error; throw new LedgerStoreError('unavailable'); }
  }
  async compareAndSwap(generation: string, data: string): Promise<string> {
    if (!(generation === '0' || GENERATION.test(generation)) || Buffer.byteLength(data) > PUBLIC_LEDGER_LIMITS.maxBytes) throw new LedgerStoreError('unavailable');
    // Generation 0 is solely for an explicit deployment initialization. The
    // PublicLedger runtime always obtains a nonzero generation from read().
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetcher(`${this.uploadUrl}&ifGenerationMatch=${generation}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data, redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch { throw new LedgerStoreError('uncertain'); }
    if (response.status === 412) { await response.body?.cancel(); throw new LedgerStoreError('conflict'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LedgerStoreError(response.status >= 500 || response.status === 408 ? 'uncertain' : 'unavailable');
    }
    try {
      const body = JSON.parse(await limitedText(response, 16_384)) as Record<string, unknown>;
      if (typeof body.generation !== 'string' || !GENERATION.test(body.generation) || body.generation === generation) throw new Error();
      return body.generation;
    } catch { throw new LedgerStoreError('uncertain'); }
  }
}
