/**
 * Zero-dependency HTTP server: static UI + one SSE endpoint.
 * POST /api/chat   {message, sessionId, tz}  → text/event-stream of AgentEvents
 * GET  /api/history?sessionId=…              → prior turns of that session
 * GET  /api/health
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { config, missingKeys } from './config.js';
import { validTz } from './clock.js';

const missing = missingKeys();
if (missing.length) {
  console.error(`\n  Missing ${missing.join(' and ')}.\n  Copy .env.example to .env and fill in the keys, then run \`npm run dev\` again.\n`);
  process.exit(1);
}

const { agent, ledger } = createApp();
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 32_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { message?: unknown; sessionId?: unknown; tz?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'Invalid JSON body.' });
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const sessionId = typeof body.sessionId === 'string' && /^[\w-]{1,64}$/.test(body.sessionId) ? body.sessionId : 'default';
  if (!message) return json(res, 400, { error: 'Empty message.' });
  if (message.length > config.maxMessageChars) return json(res, 413, { error: `Message too long (max ${config.maxMessageChars} characters).` });
  const tz = validTz(typeof body.tz === 'string' ? body.tz : undefined);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const send = (e: unknown): void => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const keepAlive = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000);
  try {
    await agent.run({ message, sessionId, ...(tz ? { tz } : {}) }, send, ac.signal);
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/chat') return await chat(req, res);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const sid = url.searchParams.get('sessionId') ?? '';
      const turns = /^[\w-]{1,64}$/.test(sid) ? ledger.sessionTurns(config.userId, sid, 50) : [];
      return json(res, 200, { turns: turns.map((t) => ({ id: t.id, ts: t.ts, user: t.user, assistant: t.assistant, sources: t.sources })) });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(path.join(publicDir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return void res.end(html);
    }
    json(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : 'Server error.' });
    else res.end();
  }
});

server.listen(config.port, () => {
  console.log(`\n  Almanac is running → http://localhost:${config.port}\n  model: ${config.model} · digests: ${config.ledgerModel} · memory: ${path.resolve(config.dataDir)}/ledger.jsonl\n`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    void agent.flush().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
