import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createApiServer,
    attachGracefulShutdown,
    okEnvelope,
    errorEnvelope
} from '@krusch/toolkit/http';
import { sseResponse } from '@krusch/toolkit/streaming';
import { initDb, exec, query, run, closeDb } from '@krusch/toolkit/db';
import { createRateLimiter } from '@krusch/toolkit/security';
import { setupLogging } from '@krusch/toolkit/log';
import { config } from './config.js';
import { createHydraScopeRuntime } from './runtime.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..');
const CLIENT_DIST_DIR = path.join(PROJECT_ROOT, 'client', 'dist');

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#07090e"/><circle cx="18" cy="32" r="6" fill="#06b6d4"/><circle cx="44" cy="18" r="6" fill="#10b981"/><circle cx="44" cy="46" r="6" fill="#10b981"/><path d="M23 29L39 20M23 35L39 44M44 24V40" stroke="#38bdf8" stroke-width="3" stroke-linecap="round"/></svg>`;

const FALLBACK_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HydraScope | Structural Agent Context on HydraDB</title>
  </head>
  <body style="background:#07090e;color:#f8fafc;font-family:system-ui,sans-serif;padding:2rem;">
    <h1>HydraScope</h1>
    <p>Run <code>npm run build</code> to compile the React cockpit bundle, or query <code>/api/state</code>.</p>
  </body>
</html>`;

function sendStaticAsset(res, content, contentType) {
    if (!res || res.writableEnded || res.destroyed || res.headersSent) return;
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buf.byteLength));
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buf);
}

function serveDistFile(res, relPath, contentType, fallbackContent = null) {
    const safeRel = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const candidate = path.resolve(CLIENT_DIST_DIR, safeRel);
    if (
        candidate.startsWith(CLIENT_DIST_DIR + path.sep) &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile()
    ) {
        sendStaticAsset(res, fs.readFileSync(candidate), contentType);
        return;
    }
    if (fallbackContent !== null) {
        sendStaticAsset(res, fallbackContent, contentType);
        return;
    }
    const payload = JSON.stringify(
        errorEnvelope('ASSET_NOT_FOUND', `Static asset not found: /${safeRel}`, null, 'hydrascope.static')
    );
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(Buffer.byteLength(payload, 'utf8')));
    res.end(payload);
}

export async function buildServer({
    dbPath = config.dbPath,
    logger = null,
    runtimeOptions = {}
} = {}) {
    const activeLogger =
        logger || setupLogging(config.serviceName, { logDir: config.logDir, console: false });
    initDb(dbPath);
    exec(`
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    const runtime = await createHydraScopeRuntime(runtimeOptions);
    const limiter = createRateLimiter({ windowMs: 60_000, max: 120 });

    const server = createApiServer({
        serviceName: config.serviceName,
        version: '0.1.0',
        corsOrigins: [
            'http://127.0.0.1:4190',
            'http://localhost:4190',
            'http://127.0.0.1:5173',
            'http://localhost:5173'
        ],
        logger: activeLogger,
        healthCheck: async () => {
            const state = await runtime.getState();
            return {
                workspace: state.data.workspaceName,
                nodes: state.data.nodeCount,
                edges: state.data.edgeCount,
                hydraMode: state.data.hydraHealth.mode
            };
        },
        routes: {
            'GET /': (ctx) => serveDistFile(ctx.res, 'index.html', 'text/html; charset=utf-8', FALLBACK_HTML),
            'GET /index.html': (ctx) => serveDistFile(ctx.res, 'index.html', 'text/html; charset=utf-8', FALLBACK_HTML),
            'GET /assets/app.js': (ctx) =>
                serveDistFile(ctx.res, 'assets/app.js', 'application/javascript; charset=utf-8'),
            'GET /assets/app.css': (ctx) =>
                serveDistFile(ctx.res, 'assets/app.css', 'text/css; charset=utf-8'),
            'GET /favicon.svg': (ctx) => sendStaticAsset(ctx.res, FAVICON_SVG, 'image/svg+xml'),

            'GET /api/state': async () => runtime.getState(),

            'POST /api/arena/compare': async (ctx) => {
                const check = limiter.consume(ctx.req.socket?.remoteAddress || 'local');
                if (!check.allowed) {
                    ctx.sendJson(429, errorEnvelope('RATE_LIMITED', 'Too many requests.', null, 'hydrascope.compare'));
                    return;
                }
                const prompt = String(ctx.body?.query || '').trim();
                if (!prompt) {
                    ctx.sendJson(400, errorEnvelope('QUERY_REQUIRED', 'Field "query" is required.', null, 'hydrascope.compare'));
                    return;
                }
                run('INSERT INTO events (label) VALUES (?)', [`compare:${prompt.slice(0, 64)}`]);
                return runtime.compare({
                    query: prompt,
                    asOf: ctx.body?.asOf ? String(ctx.body.asOf).trim() : null,
                    tokenBudget: Number(ctx.body?.tokenBudget) || 900,
                    topK: Number(ctx.body?.topK) || 4
                });
            },

            'POST /api/benchmark/run': async () => {
                run('INSERT INTO events (label) VALUES (?)', ['benchmark:run']);
                return runtime.runBenchmark();
            },

            'POST /api/continual/run': async () => {
                run('INSERT INTO events (label) VALUES (?)', ['continual:run']);
                return runtime.runContinualEval();
            },

            'POST /api/benchmark/load': async (ctx) => {
                const check = limiter.consume(ctx.req.socket?.remoteAddress || 'local');
                if (!check.allowed) {
                    ctx.sendJson(429, errorEnvelope('RATE_LIMITED', 'Too many requests.', null, 'hydrascope.load_bench'));
                    return;
                }
                run('INSERT INTO events (label) VALUES (?)', ['load:run']);
                const res = await runtime.runLoadTest({
                    totalRequests: Number(ctx.body?.totalRequests) || 64,
                    concurrency: Number(ctx.body?.concurrency) || 8
                });
                if (!res.ok) {
                    ctx.sendJson(400, res);
                    return;
                }
                return res;
            },

            'POST /api/decisions/supersede': async (ctx) => {
                const oldId = String(ctx.body?.oldId || '').trim();
                const newId = String(ctx.body?.newId || '').trim();
                const title = String(ctx.body?.title || '').trim();
                const content = String(ctx.body?.content || '').trim();
                if (!oldId || !newId || !title || !content) {
                    ctx.sendJson(
                        400,
                        errorEnvelope(
                            'INVALID_SUPERSEDE_BODY',
                            'Fields oldId, newId, title, and content are required.',
                            null,
                            'hydrascope.supersede'
                        )
                    );
                    return;
                }
                run('INSERT INTO events (label) VALUES (?)', [`supersede:${oldId}->${newId}`]);
                const res = await runtime.supersedeDecision({
                    oldId,
                    newId,
                    title,
                    content,
                    governsIds: Array.isArray(ctx.body?.governsIds) ? ctx.body.governsIds : [],
                    effectiveAt: ctx.body?.effectiveAt ? String(ctx.body.effectiveAt).trim() : undefined
                });
                if (!res.ok) {
                    ctx.sendJson(400, res);
                    return;
                }
                return res;
            },

            'POST /api/workspace/ingest-dir': async (ctx) => {
                const targetDir = String(ctx.body?.targetDir || '').trim();
                if (!targetDir) {
                    ctx.sendJson(
                        400,
                        errorEnvelope('TARGET_DIR_REQUIRED', 'Field "targetDir" is required.', null, 'hydrascope.ingest_dir')
                    );
                    return;
                }
                run('INSERT INTO events (label) VALUES (?)', ['workspace:ingest']);
                const res = await runtime.ingestDirectory(targetDir);
                if (!res.ok) {
                    ctx.sendJson(400, res);
                    return;
                }
                return res;
            },

            'GET /api/metrics': () => {
                const row = query('SELECT COUNT(*) AS count FROM events')[0];
                return okEnvelope('metrics.read', 'Loaded dashboard metrics', {
                    service: config.serviceName,
                    eventCount: row?.count ?? 0
                });
            },

            'POST /api/stream': (ctx) => {
                const prompt = String(ctx.body?.prompt || 'ping').trim();
                run('INSERT INTO events (label) VALUES (?)', [prompt]);
                const sse = sseResponse(ctx.res, ctx.req);
                if (!sse.signal.aborted) {
                    sse.sendToken(`HydraScope ready: ${prompt}`);
                    sse.done(okEnvelope('stream.complete', 'SSE stream finished', { prompt }));
                }
            }
        }
    });

    return { server, runtime, close: () => closeDb() };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const logger = setupLogging(config.serviceName, { logDir: config.logDir });
    const { server, close } = await buildServer({ logger });
    server.listen(config.port, () => {
        logger.info(`${config.serviceName} listening on port ${config.port}`);
    });
    attachGracefulShutdown(server, [close], { logger });
}
