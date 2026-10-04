import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { readConfig, publicStatus, type ServerConfig } from './config.js';
import { AppError } from './errors.js';
import { validateImage } from './images.js';
import { GeminiProvider, type ModelProvider } from './provider.js';
import { OllamaProvider } from './ollama.js';
import { publicRun, RunManager } from './runs.js';
import { SessionStore, secretMatches } from './sessions.js';

export type App = FastifyInstance & { sessions: SessionStore; runs: RunManager };
export type AppOptions = { config?: ServerConfig; provider?: ModelProvider; staticRoot?: string; logger?: boolean };
const DocumentBody = z.object({ document: z.unknown() }).strict();
const Params = z.object({ id: z.string().uuid(), runId: z.string().uuid().optional(), proposalId: z.string().uuid().optional() });

export async function createApp(options: AppOptions = {}): Promise<App> {
  if (options.provider && process.env.NODE_ENV !== 'test') throw new Error('Provider injection is test-only');
  const config = options.config ?? readConfig();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 256 * 1024, requestTimeout: 15_000, trustProxy: false }) as unknown as App;
  const sessions = new SessionStore(config);
  const runs = new RunManager(config, options.provider ?? (config.aiEnabled ? config.provider === 'ollama' ? new OllamaProvider(config) : config.provider === 'gemini' ? new GeminiProvider(config) : undefined : undefined));
  app.decorate('sessions', sessions); app.decorate('runs', runs);
  let imageActive = 0;
  let imageStarts: number[] = [];
  let apiStarts: number[] = [];

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      const now = Date.now(); apiStarts = apiStarts.filter(time => now - time < 60_000);
      if (apiStarts.length >= 600) throw new AppError('request_limit', 'アクセスが集中しています。少し待って再試行してください。', 429);
      apiStarts.push(now);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_input', message: '入力の形式または値を確認してください。' } });
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (statusCode === 413) return reply.code(413).send({ error: { code: 'body_too_large', message: '送信するデータが大きすぎます。' } });
    if (statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'bad_request', message: 'リクエストの形式を確認してください。' } });
    return reply.code(500).send({ error: { code: 'internal_error', message: '処理できませんでした。設計を保存して再試行してください。' } });
  });

  function session(request: FastifyRequest) { return sessions.authorize(Params.parse(request.params).id, request.headers.authorization); }
  function access(request: FastifyRequest) {
    if (!config.aiEnabled) throw new AppError('ai_disabled', 'AI未接続です。手動で設計できます。', 503);
    const key = request.headers['x-ai-access'];
    if (typeof key !== 'string' || !config.accessSecret || !secretMatches(key, config.accessSecret)) throw new AppError('access_denied', 'AIのアクセスコードが一致しません。', 401);
  }
  function checkedDocument<T>(operation: () => T): T {
    try { return operation(); } catch (error) {
      if (error instanceof AppError || error instanceof z.ZodError) throw error;
      throw new AppError('invalid_document', '設計ファイルの形式・参照・検査結果が不正です。');
    }
  }

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/status', async () => {
    const status = publicStatus(config);
    if (options.provider && config.aiEnabled) status.ai = { ...status.ai, mode: 'injected-test', reason: 'テスト用の模擬通信です。実Geminiへは接続しません。' };
    return status;
  });
  app.post('/api/images', { bodyLimit: 8 * 1024 * 1024 }, async request => {
    const now = Date.now(); imageStarts = imageStarts.filter(time => now - time < 60_000);
    if (imageActive >= 2 || imageStarts.length >= 20) throw new AppError('image_limit', '画像の処理が混み合っています。少し待って再試行してください。', 429);
    imageStarts.push(now); imageActive++;
    try { return await validateImage(request.body); } finally { imageActive--; }
  });
  app.post('/api/sessions', async (request, reply) => {
    const { document } = DocumentBody.parse(request.body);
    return reply.code(201).send(checkedDocument(() => sessions.create(document)));
  });
  app.put('/api/sessions/:id/document', async request => {
    const current = session(request);
    return checkedDocument(() => sessions.update(current, DocumentBody.parse(request.body).document));
  });
  app.delete('/api/sessions/:id', async request => {
    const current = session(request);
    for (const run of current.runs.values()) runs.cancel(run);
    sessions.sessions.delete(current.id);
    return { deleted: true };
  });
  app.post('/api/sessions/:id/runs', async (request, reply) => {
    const current = session(request); access(request);
    return reply.code(202).send({ run: publicRun(runs.start(current, request.body)) });
  });
  app.get('/api/sessions/:id/runs/:runId', async request => {
    const current = session(request);
    return { run: publicRun(runs.get(current, Params.parse(request.params).runId!)) };
  });
  app.delete('/api/sessions/:id/runs/:runId', async request => {
    const current = session(request);
    return { run: publicRun(runs.cancel(runs.get(current, Params.parse(request.params).runId!))) };
  });
  app.post('/api/sessions/:id/proposals/:proposalId/approve', async request => {
    const current = session(request);
    return runs.approve(current, Params.parse(request.params).proposalId!, request.body);
  });
  app.delete('/api/sessions/:id/proposals/:proposalId', async request => {
    const current = session(request);
    return { run: publicRun(runs.reject(current, Params.parse(request.params).proposalId!)) };
  });

  const staticRoot = options.staticRoot ?? resolve(process.cwd(), 'apps/web/dist');
  if (existsSync(resolve(staticRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: '/', setHeaders: response => {
      response.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    } });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: { code: 'not_found', message: 'APIが見つかりません。' } }) : reply.sendFile('index.html'));
  }
  app.addHook('onClose', async () => { sessions.close(); });
  return app;
}
