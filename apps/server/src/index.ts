import { createApp } from './app.js';
import { loadServerEnv } from './config.js';

loadServerEnv();
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const host = process.env.HOST || '0.0.0.0';
const app = await createApp();
await app.listen({ port, host });
process.stdout.write(`うごく紙工房 API ready on port ${port}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
