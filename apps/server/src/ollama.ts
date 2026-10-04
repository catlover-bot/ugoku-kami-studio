import { request } from 'node:http';
import { z } from 'zod';
import { validateOllamaEndpoint, validateOllamaModel, type ServerConfig } from './config.js';
import type { AssistantMessage, ConversationMessage, LocalModel, ModelProvider, ProviderResponse } from './conversation.js';
import { AppError } from './errors.js';
import { declarations } from './tools.js';
import { assertModelInput, SYSTEM_INSTRUCTION } from './provider.js';

const LOCAL_ERROR = 'ローカルAIの安全な接続設定を確認できません。手動で編集できます。';
const remote = z.object({ remote_host: z.string().optional(), remote_model: z.string().optional() }).passthrough();
function assertLocal(value: unknown) {
  const checked = remote.safeParse(value);
  if (!checked.success || checked.data.remote_host || checked.data.remote_model) throw new AppError('local_configuration', LOCAL_ERROR);
}
function atLeast(actual: string, minimum: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(actual)) return false;
  const a = actual.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}
/** Direct literal-IP HTTP: no environment proxy, credentials, redirect following or arbitrary path. */
async function localJson(config: ServerConfig, path: '/api/status' | '/api/version' | '/api/tags' | '/api/show' | '/api/chat', body: unknown, signal: AbortSignal, maxBytes = 100_000): Promise<unknown> {
  const base = validateOllamaEndpoint(config.ollama.baseUrl), target = new URL(path, base);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(target, { method: data === undefined ? 'GET' : 'POST', signal, agent: false, headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, response => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new AppError(response.statusCode && response.statusCode >= 300 && response.statusCode < 400 ? 'local_configuration' : 'provider_unavailable', response.statusCode === 400 ? 'ローカルAIが入力を処理できませんでした。履歴・設定の上限を確認してください。' : LOCAL_ERROR)); return;
      }
      if (!response.headers['content-type']?.includes('application/json') || Number(response.headers['content-length']) > maxBytes) {
        response.destroy(); reject(new AppError('invalid_output', 'ローカルAIの応答形式または容量が不正です。')); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(); reject(new AppError('invalid_output', 'ローカルAIの応答が大きすぎます。')); }
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new AppError('provider_unavailable', 'ローカルAIとの通信が切れました。作品は変更していません。')));
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new AppError('invalid_output', 'ローカルAIの応答JSONが不正です。')); } });
    });
    req.on('error', () => reject(signal.aborted ? signal.reason : new AppError('provider_unavailable', 'ローカルAIに接続できません。起動を確認するか、手動で編集できます。')));
    req.setTimeout(Math.min(config.runTimeoutMs, path === '/api/chat' ? config.runTimeoutMs : 10_000), () => req.destroy(new Error('local timeout')));
    req.end(data);
  });
}

/** Read-only preflight; no pull, model loading or generation. Repeat before each model request. */
export async function checkLocalRuntime(config: ServerConfig, signal: AbortSignal): Promise<LocalModel> {
  if (config.provider !== 'ollama') throw new AppError('local_configuration', LOCAL_ERROR);
  validateOllamaModel(config.ollama.model);
  const status = z.object({ cloud: z.object({ disabled: z.literal(true), source: z.string().min(1) }) }).safeParse(await localJson(config, '/api/status', undefined, signal));
  if (!status.success) throw new AppError('local_configuration', 'Ollamaプロセスのクラウド機能が無効か確認できません。手動で編集できます。');
  const version = z.object({ version: z.string() }).safeParse(await localJson(config, '/api/version', undefined, signal));
  // These exact runtime semantics (cloud status, truncate:false, shift:false) were inspected at v0.33.3.
  if (!version.success || !atLeast(version.data.version, '0.33.3')) throw new AppError('local_configuration', 'ローカルAIの対応ランタイムを確認してください。Ollama 0.33.3以上が必要です。');
  const tags = z.object({ models: z.array(z.object({ name: z.string(), model: z.string().optional(), digest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/), size: z.number().positive() }).passthrough()).max(1000) }).safeParse(await localJson(config, '/api/tags', undefined, signal, 1_000_000));
  if (!tags.success) throw new AppError('local_configuration', LOCAL_ERROR);
  const item = tags.data.models.find(model => model.name === config.ollama.model || model.model === config.ollama.model);
  if (!item) throw new AppError('local_model_missing', '指定されたローカルモデルが見つかりません。自動取得は行いません。');
  assertLocal(item);
  const digest = item.digest.replace(/^sha256:/, '');
  if (config.ollama.digest && digest !== config.ollama.digest) throw new AppError('local_configuration', 'ローカルモデルのdigestが指定値と一致しません。');
  const raw = await localJson(config, '/api/show', { model: config.ollama.model }, signal, 2_000_000);
  assertLocal(raw);
  const model = z.object({ details: z.object({ format: z.literal('gguf'), quantization_level: z.string().min(1) }), capabilities: z.array(z.string()), model_info: z.record(z.string(), z.unknown()), requires: z.string().optional() }).safeParse(raw);
  if (!model.success || !model.data.capabilities.includes('completion') || config.ollama.toolMode === 'native' && !model.data.capabilities.includes('tools')) throw new AppError('local_configuration', 'ローカルモデルの必要な生成・ツール機能を確認できません。');
  if (model.data.requires && !atLeast(version.data.version, model.data.requires)) throw new AppError('local_configuration', 'モデルに必要なOllamaの版を満たしていません。');
  const contextLimits = Object.entries(model.data.model_info).filter(([key]) => key.endsWith('.context_length')).map(([, value]) => value);
  if (!contextLimits.some(value => typeof value === 'number' && value >= config.ollama.contextLength)) throw new AppError('local_configuration', 'モデルのコンテキスト上限を確認できません。');
  return { digest, quantization: model.data.details.quantization_level, contextLength: config.ollama.contextLength, runtimeVersion: version.data.version, toolMode: config.ollama.toolMode };
}

const actionSchema = z.object({ actions: z.array(z.object({ tool: z.string().refine(name => declarations.some(tool => tool.name === name)), arguments: z.record(z.string(), z.unknown()) }).strict()).max(12), message: z.string().max(6000) }).strict();
const actionFormat = { type: 'object', properties: { actions: { type: 'array', maxItems: 12, items: { type: 'object', properties: { tool: { type: 'string', enum: declarations.map(tool => tool.name) }, arguments: { type: 'object' } }, required: ['tool', 'arguments'], additionalProperties: false } }, message: { type: 'string' } }, required: ['actions', 'message'], additionalProperties: false };
type NativeMessage = { role: string; content: string; thinking?: string; tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> } }[]; tool_name?: string; tool_call_id?: string };
const metric = z.number().finite().nonnegative().optional();
const chatSchema = z.object({ model: z.string(), message: z.object({ role: z.literal('assistant'), content: z.string(), thinking: z.string().optional(), images: z.array(z.string()).max(0).optional(), tool_calls: z.array(z.object({ id: z.string().max(200).optional(), function: z.object({ name: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()) }) })).max(24).optional() }), done: z.literal(true), done_reason: z.literal('stop'), total_duration: metric, load_duration: metric, prompt_eval_duration: metric, eval_duration: metric, prompt_eval_count: metric, eval_count: metric }).passthrough();

export class OllamaProvider implements ModelProvider {
  private originals = new WeakMap<AssistantMessage, NativeMessage>();
  private identities = new WeakMap<ConversationMessage, string>();
  constructor(private config: ServerConfig) {
    if (config.provider !== 'ollama') throw new Error('OllamaProvider requires explicit AI_PROVIDER=ollama');
    validateOllamaEndpoint(config.ollama.baseUrl); validateOllamaModel(config.ollama.model);
  }
  private payload(history: ConversationMessage[]) {
    const jsonMode = this.config.ollama.toolMode === 'json-actions';
    const system = SYSTEM_INSTRUCTION + (jsonMode ? '\n返答は厳密なJSON {"actions":[{"tool":"許可ツール名","arguments":{}}],"message":"短い説明"}だけです。actionsは実行要求です。検査を終えた最終返答だけactionsを空にします。ツール定義:\n' + JSON.stringify(declarations) : '');
    const messages: NativeMessage[] = [{ role: 'system', content: system }];
    for (const message of history) {
      if (message.role === 'user') messages.push({ role: 'user', content: message.text });
      else if (message.role === 'assistant') {
        const original = this.originals.get(message);
        if (!original) throw new AppError('invalid_history', 'ローカルAIの会話の元データが一致しません。');
        messages.push(original);
      } else for (const result of message.results) messages.push(jsonMode ? { role: 'user', content: JSON.stringify({ toolResult: result }) } : { role: 'tool', tool_name: result.name, ...(result.id ? { tool_call_id: result.id } : {}), content: JSON.stringify(result.response) });
    }
    return { model: this.config.ollama.model, messages, stream: false, think: false, truncate: false, shift: false, keep_alive: '5m', options: { num_ctx: this.config.ollama.contextLength, num_predict: this.config.maxOutputTokens, temperature: 0 }, ...(jsonMode ? { format: actionFormat } : { tools: declarations.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parametersJsonSchema } })) }) };
  }
  inputBytes(messages: ConversationMessage[]): number { return Buffer.byteLength(JSON.stringify(this.payload(messages)), 'utf8'); }
  async generate(history: ConversationMessage[], signal: AbortSignal): Promise<ProviderResponse> {
    signal.throwIfAborted(); assertModelInput(this.config, history, this);
    const localModel = await checkLocalRuntime(this.config, signal);
    const first = history[0];
    if (!first) throw new AppError('invalid_history', '希望が指定されていません。');
    const prior = this.identities.get(first);
    if (prior && prior !== localModel.digest) throw new AppError('local_configuration', '実行中にローカルモデルが変更されました。');
    this.identities.set(first, localModel.digest);
    const raw = await localJson(this.config, '/api/chat', this.payload(history), signal);
    assertLocal(raw);
    const parsed = chatSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('invalid_output', 'ローカルAIの応答が不正、または途中で終了しました。');
    const data = parsed.data;
    if (data.model !== this.config.ollama.model) throw new AppError('local_configuration', 'ローカルAIが指定と異なるモデルで応答しました。');
    let message: AssistantMessage;
    if (this.config.ollama.toolMode === 'json-actions') {
      if (data.message.tool_calls?.length) throw new AppError('invalid_output', 'ローカルAIのアクション形式が一致しません。');
      let action: z.infer<typeof actionSchema>;
      try { action = actionSchema.parse(JSON.parse(data.message.content)); }
      catch { throw new AppError('invalid_output', 'ローカルAIのアクションJSONが不正です。'); }
      message = { role: 'assistant', text: action.message, calls: action.actions.map(item => ({ name: item.tool, args: item.arguments })) };
    } else message = { role: 'assistant', text: data.message.content, calls: (data.message.tool_calls ?? []).map(call => ({ name: call.function.name, args: call.function.arguments, ...(call.id ? { id: call.id } : {}) })) };
    if (!message.text.trim() && !message.calls.length) throw new AppError('invalid_output', 'ローカルAIから有効な返答が届きませんでした。');
    if (message.calls.some(call => !declarations.some(tool => tool.name === call.name))) throw new AppError('unknown_tool', '許可されていないツール要求を拒否しました。');
    this.originals.set(message, structuredClone(data.message));
    const timings = [data.load_duration, data.prompt_eval_duration, data.eval_duration, data.total_duration];
    const localTiming = timings.every(value => value !== undefined) ? { loadMs: data.load_duration! / 1_000_000, promptEvalMs: data.prompt_eval_duration! / 1_000_000, evalMs: data.eval_duration! / 1_000_000, totalMs: data.total_duration! / 1_000_000 } : undefined;
    return { message, finishReason: 'STOP', modelVersion: this.config.model, localModel, ...(localTiming ? { localTiming } : {}), ...(data.prompt_eval_count === undefined || data.eval_count === undefined ? {} : { usageMetadata: { promptTokenCount: data.prompt_eval_count, candidatesTokenCount: data.eval_count, totalTokenCount: data.prompt_eval_count + data.eval_count } }) };
  }
}
