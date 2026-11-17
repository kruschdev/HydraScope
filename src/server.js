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
import { verifyBearerToken } from '@krusch/toolkit/webhooks';
import { setupLogging } from '@krusch/toolkit/log';
import { config } from './config.js';
import { createHydraScopeRuntime } from './runtime.js';
import { MAX_QUERY_CHARS } from './utils/validation.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..');
const CLIENT_DIST_DIR = path.join(PROJECT_ROOT, 'client', 'dist');
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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

function resolveRateLimitKey(req) {
    const socketAddr = String(req?.socket?.remoteAddress || 'local').trim();
    if (LOOPBACK_ADDRS.has(socketAddr)) {
        const cfIp = String(req?.headers?.['cf-connecting-ip'] || '').trim();
        if (cfIp) return cfIp.slice(0, 64);
    }
    return socketAddr.slice(0, 64) || 'local';
}

function recordBoundedEvent(label) {
    run('INSERT INTO events (label) VALUES (?)', [String(label || 'event').slice(0, 128)]);
}

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
    adminToken = config.adminToken,
    rateLimitMax = 120,
    mutationRateLimitMax = 20,
    runtimeOptions = {}
} = {}) {
    const activeLogger =
        logger || setupLogging(config.serviceName, { logDir: config.logDir, console: false });
    const cleanAdminToken = String(adminToken ?? '').trim();

    initDb(dbPath);
    exec(`
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    const runtime = await createHydraScopeRuntime(runtimeOptions);
    const readLimiter = createRateLimiter({ windowMs: 60_000, max: rateLimitMax });
    const mutationLimiter = createRateLimiter({ windowMs: 60_000, max: mutationRateLimitMax });

    function enforceRateLimit(ctx, limiter, toolName) {
        const check = limiter.consume(resolveRateLimitKey(ctx.req));
        if (!check.allowed) {
            if (typeof ctx.res?.setHeader === 'function' && !ctx.res.headersSent) {
                for (const [k, v] of Object.entries(check.headers || {})) {
                    ctx.res.setHeader(k, v);
                }
            }
            ctx.sendJson(429, errorEnvelope('RATE_LIMITED', 'Too many requests.', null, toolName));
            return false;
        }
        return true;
    }

    function enforceOptionalAdminBearer(ctx, toolName) {
        if (!cleanAdminToken) return true;
        const authRes = verifyBearerToken(ctx.req?.headers?.authorization || '', cleanAdminToken, {
            tool: toolName
        });
        if (!authRes.ok) {
            ctx.sendJson(
                401,
                errorEnvelope(
                    authRes.error?.code || 'AUTH_UNAUTHORIZED',
                    'Valid Authorization Bearer token is required for workspace mutations.',
                    null,
                    toolName
                )
            );
            return false;
        }
        return true;
    }

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
                hydraMode: state.data.hydraHealth.mode,
                selfGraphEngine: '@hydradb/selfgraph@0.2.1'
            };
        },
        routes: {
            'GET /': (ctx) => serveDistFile(ctx.res, 'index.html', 'text/html; charset=utf-8', FALLBACK_HTML),
            'GET /index.html': (ctx) => serveDistFile(ctx.res, 'index.html', 'text/html; charset=utf-8', FALLBACK_HTML),
            'GET /assets/app.js': (ctx) =>
                serveDistFile(ctx.res, 'assets/app.js', 'application/javascript; charset=utf-8'),
            'GET /assets/app.css': (ctx) =>
                serveDistFile(ctx.res, 'assets/app.css', 'text/css; charset=utf-8'),
            'GET /og-card.png': (ctx) =>
                serveDistFile(ctx.res, 'og-card.png', 'image/png'),
            'GET /favicon.svg': (ctx) => sendStaticAsset(ctx.res, FAVICON_SVG, 'image/svg+xml'),

            'GET /api/state': async () => runtime.getState(),

            'POST /api/arena/compare': async (ctx) => {
                if (!enforceRateLimit(ctx, readLimiter, 'hydrascope.compare')) return;
                const prompt = String(ctx.body?.query || '').trim();
                if (!prompt) {
                    ctx.sendJson(400, errorEnvelope('QUERY_REQUIRED', 'Field "query" is required.', null, 'hydrascope.compare'));
                    return;
                }
                if (prompt.length > MAX_QUERY_CHARS) {
                    ctx.sendJson(
                        400,
                        errorEnvelope('QUERY_TOO_LONG', `Field "query" exceeds ${MAX_QUERY_CHARS} characters.`, null, 'hydrascope.compare')
                    );
                    return;
                }
                recordBoundedEvent(`compare:${prompt.slice(0, 64)}`);
                const res = await runtime.compare({
                    query: prompt,
                    asOf: ctx.body?.asOf ? String(ctx.body.asOf).trim() : null,
                    tokenBudget: Math.min(16000, Math.max(120, Number(ctx.body?.tokenBudget) || 900)),
                    topK: Math.min(20, Math.max(1, Number(ctx.body?.topK) || 4))
                });
                if (!res.ok) {
                    ctx.sendJson(400, res);
                    return;
                }
                return res;
            },

            'POST /api/benchmark/run': async (ctx) => {
                if (!enforceRateLimit(ctx, readLimiter, 'hydrascope.benchmark')) return;
                recordBoundedEvent('benchmark:run');
                return runtime.runBenchmark();
            },

            'POST /api/continual/run': async (ctx) => {
                if (!enforceRateLimit(ctx, readLimiter, 'hydrascope.continual_eval')) return;
                recordBoundedEvent('continual:run');
                return runtime.runContinualEval();
            },

            'POST /api/benchmark/load': async (ctx) => {
                if (!enforceRateLimit(ctx, mutationLimiter, 'hydrascope.load_bench')) return;
                recordBoundedEvent('load:run');
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
                if (!enforceRateLimit(ctx, mutationLimiter, 'hydrascope.supersede')) return;
                if (!enforceOptionalAdminBearer(ctx, 'hydrascope.supersede')) return;

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
                recordBoundedEvent(`supersede:${oldId.slice(0, 48)}->${newId.slice(0, 48)}`);
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
                if (!enforceRateLimit(ctx, mutationLimiter, 'hydrascope.ingest_dir')) return;
                if (!enforceOptionalAdminBearer(ctx, 'hydrascope.ingest_dir')) return;

                if (ctx.body === null || ctx.body === undefined || typeof ctx.body !== 'object' || !Object.hasOwn(ctx.body, 'targetDir')) {
                    ctx.sendJson(
                        400,
                        errorEnvelope('TARGET_DIR_REQUIRED', 'Field "targetDir" is required (use "reset" to restore default workspace).', null, 'hydrascope.ingest_dir')
                    );
                    return;
                }
                const rawTarget = String(ctx.body.targetDir ?? '').trim();
                const normalizedTarget = rawTarget === '' || rawTarget === 'reset' ? 'reset' : rawTarget;
                recordBoundedEvent(`workspace:ingest:${normalizedTarget.slice(0, 64)}`);
                const res = await runtime.ingestDirectory(normalizedTarget);
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

            'GET /api/selfgraph/status': async (ctx) => {
                if (!enforceRateLimit(ctx, readLimiter, 'hydrascope.selfgraph_status')) return;
                recordBoundedEvent('selfgraph:status');
                return runtime.selfGraphStatus();
            },

            'POST /api/selfgraph/retrieve': async (ctx) => {
                if (!enforceRateLimit(ctx, readLimiter, 'hydrascope.selfgraph_retrieve')) return;
                const prompt = String(ctx.body?.query || '').trim();
                if (!prompt) {
                    ctx.sendJson(400, errorEnvelope('QUERY_REQUIRED', 'Field "query" is required.', null, 'hydrascope.selfgraph_retrieve'));
                    return;
                }
                recordBoundedEvent(`selfgraph:retrieve:${prompt.slice(0, 48)}`);
                const res = await runtime.selfGraphRetrieve({
                    query: prompt,
                    asOf: ctx.body?.asOf ? String(ctx.body.asOf).trim() : null,
                    knownAt: ctx.body?.knownAt ? String(ctx.body.knownAt).trim() : null,
                    budgetTokens: Math.min(16000, Math.max(120, Number(ctx.body?.budgetTokens) || 900)),
                    depth: Math.min(5, Math.max(1, Number(ctx.body?.depth) || 3)),
                    strategy: ctx.body?.strategy ? String(ctx.body.strategy).trim() : 'ppr'
                });
                if (!res.ok) {
                    ctx.sendJson(400, res);
                    return;
                }
                return res;
            },

            'POST /api/selfgraph/diff': async (ctx) => {
                if (!enforceRateLimit(ctx, readLimiter, 'hydrascope.selfgraph_diff')) return;
                const since = String(ctx.body?.since || '').trim();
                if (!since) {
                    ctx.sendJson(400, errorEnvelope('SINCE_REQUIRED', 'Field "since" (ISO 8601) is required.', null, 'hydrascope.selfgraph_diff'));
                    return;
                }
                recordBoundedEvent(`selfgraph:diff:${since.slice(0, 32)}`);
                const res = await runtime.selfGraphDiff({
                    since,
                    until: ctx.body?.until ? String(ctx.body.until).trim() : null
                });
                if (!res.ok) {
                    ctx.sendJson(400, res);
                    return;
                }
                return res;
            },

            'POST /api/stream': (ctx) => {
                if (!enforceRateLimit(ctx, readLimiter, 'hydrascope.stream')) return;
                const prompt = String(ctx.body?.prompt || 'ping').trim().slice(0, 240);
                recordBoundedEvent(`stream:${prompt.slice(0, 96)}`);
                const sse = sseResponse(ctx.res, ctx.req);
                if (!sse.signal.aborted) {
                    sse.sendToken(`HydraScope ready: ${prompt}`);
                    sse.done(okEnvelope('stream.complete', 'SSE stream finished', { prompt }));
                }
            }
        }
    });

    return {
        server,
        runtime,
        close: async () => {
            await runtime.closeSelfGraph();
            closeDb();
        }
    };
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
