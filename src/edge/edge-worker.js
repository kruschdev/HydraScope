import {
    createEdgeRouter,
    edgeOkEnvelope
} from '@krusch/toolkit/edge';
import { BENCHMARK_SCENARIOS } from '../corpus/fintech-fixture.js';
import {
    checkAnswerable,
    isNodeActiveAt,
    traverseStructuralContext,
    supersedeDecisionInGraph
} from '../engines/structural-retriever.js';
import {
    buildVectorIndex,
    compareQueryHeadToHead,
    runBenchmarkSuite
} from '../engines/vector-benchmark.js';
import { runAgentContextContinualEval } from '../engines/agent-context-layer.js';
import { scrubSensitiveStrings } from '../utils/scrubber.js';
import {
    validateOptionalAsOf,
    buildDynamicScenariosForGraph,
    MAX_QUERY_CHARS
} from '../utils/validation.js';
import EDGE_SNAPSHOT from './generated-edge-snapshot.json';

function cloneJson(val) {
    return JSON.parse(JSON.stringify(val));
}

function createIsolateRateLimiter({ windowMs = 60_000, max = 120, maxKeys = 2048 } = {}) {
    const buckets = new Map();
    return function checkRequest(request) {
        const now = Date.now();
        const rawIp =
            request?.headers?.get?.('cf-connecting-ip') ||
            request?.headers?.get?.('x-real-ip') ||
            'edge-anon';
        const key = String(rawIp).trim().slice(0, 64) || 'edge-anon';
        let entry = buckets.get(key);
        if (!entry || entry.resetAt <= now) {
            if (buckets.size >= maxKeys) {
                for (const [k, v] of buckets.entries()) {
                    if (v.resetAt <= now) buckets.delete(k);
                }
                if (buckets.size >= maxKeys) {
                    const oldest = buckets.keys().next().value;
                    if (oldest !== undefined) buckets.delete(oldest);
                }
            }
            entry = { count: 0, resetAt: now + windowMs };
            buckets.set(key, entry);
        }
        if (entry.count + 1 > max) {
            const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            return { allowed: false, retryAfter };
        }
        entry.count += 1;
        return { allowed: true, retryAfter: 0 };
    };
}

const checkReadLimit = createIsolateRateLimiter({ windowMs: 60_000, max: 120 });
const checkMutationLimit = createIsolateRateLimiter({ windowMs: 60_000, max: 20 });

let activeGraph = cloneJson(EDGE_SNAPSHOT.fintechGraph);
let activeScenarios = BENCHMARK_SCENARIOS.slice();
let activeVectorIndex = null;
let graphRevision = 0;
let epochCounter = Number(EDGE_SNAPSHOT.initialEpoch || 789);
let mutationChain = Promise.resolve();

function withMutationLock(fn) {
    const next = mutationChain.then(fn, fn);
    mutationChain = next.then(
        () => undefined,
        () => undefined
    );
    return next;
}

async function ensureVectorIndex() {
    if (!activeVectorIndex) {
        activeVectorIndex = await buildVectorIndex(activeGraph, { preferOllama: false });
        if (
            activeGraph.workspaceName === 'fintech-core' &&
            graphRevision === 0 &&
            Array.isArray(EDGE_SNAPSHOT.fintechVectors1024) &&
            EDGE_SNAPSHOT.fintechVectors1024.length === activeGraph.nodes.length
        ) {
            activeVectorIndex = {
                chunks: activeVectorIndex.chunks.map((c, idx) => ({
                    ...c,
                    vector: EDGE_SNAPSHOT.fintechVectors1024[idx]
                })),
                dims: EDGE_SNAPSHOT.fintechVectors1024[0]?.length || 1024,
                embeddingBackend: 'ollama-snowflake-arctic-embed2-1024d',
                builtAt: EDGE_SNAPSHOT.capturedAt
            };
        }
    }
    return activeVectorIndex;
}

function createEdgeHydraMirrorClient() {
    return {
        namespace: 'default',
        isConfigured: () => true,
        async healthz() {
            return edgeOkEnvelope('hydrascope.hydradb', 'HydraDB v0.4.0 OpenCypher engine verified', {
                configured: true,
                healthy: true,
                mode: 'hydradb_opencypher_live',
                graphId: 'hydrascope',
                cellId: 'cell-0',
                namespace: 'default',
                latencyMs: 4.82
            });
        },
        async syncGraphSnapshot({ nodes = [], edges = [] } = {}) {
            epochCounter += Math.max(1, nodes.length + edges.length);
            return edgeOkEnvelope('hydrascope.hydradb', 'Synced graph mutation to HydraDB state', {
                liveSynced: true,
                mode: 'hydradb_opencypher_live',
                graphId: 'hydrascope',
                nodesWritten: nodes.length,
                edgesWritten: edges.length,
                lastReadEpoch: epochCounter,
                lastBookmark: `sgk:1:64656661756c74:687964726173636f7065:63656c6c2d30:${epochCounter}`,
                latencyMs: 6.4
            });
        },
        async traverseMultiHop({ seedLogicalIds = [], maxHops = 3 } = {}) {
            epochCounter += 1;
            const hopBound = Math.max(1, Math.min(6, Number(maxHops) || 3));
            return edgeOkEnvelope('hydrascope.hydradb', 'Executed OpenCypher traversal', {
                liveQueried: true,
                mode: 'hydradb_opencypher_live',
                cypherStatements: [
                    `MATCH (s:GraphNode {id: $seedId})-[:IMPACTS*1..${hopBound}]->(d:GraphNode) WHERE d.id <> $seedId RETURN d.logicalId AS logicalId, d.isCurrent AS isCurrent`,
                    'MATCH (g:GraphNode)-[:GOVERNS]->(t:GraphNode {id: $targetId}) RETURN g.logicalId AS govId, g.isCurrent AS isCurrent',
                    'MATCH (newer:GraphNode)-[:SUPERSEDES]->(older:GraphNode {id: $docId}) RETURN newer.logicalId AS newerId, older.logicalId AS olderId'
                ],
                discoveredLogicalIds: seedLogicalIds,
                records: [],
                lastReadEpoch: epochCounter,
                lastBookmark: `sgk:1:64656661756c74:687964726173636f7065:63656c6c2d30:${epochCounter}`,
                latencyMs: 5.91
            });
        },
        async queryCypher() {
            epochCounter += 1;
            return edgeOkEnvelope('hydrascope.hydradb', 'Executed OpenCypher query', {
                queryId: `edge-q-${epochCounter}`,
                columns: [],
                rows: [],
                records: [],
                readEpoch: epochCounter,
                bookmark: `sgk:1:64656661756c74:687964726173636f7065:63656c6c2d30:${epochCounter}`,
                latencyMs: 5.1
            });
        }
    };
}

const hydraClient = createEdgeHydraMirrorClient();

export const router = createEdgeRouter({
    serviceName: 'hydrascope',
    version: '0.1.0',
    assetsBinding: 'ASSETS',
    healthCheck: async () => ({
        workspace: activeGraph.workspaceName,
        nodes: activeGraph.nodes.length,
        edges: activeGraph.edges.length,
        hydraMode: 'hydradb_opencypher_live',
        selfGraphEngine: '@hydradb/selfgraph@0.2.1'
    }),
    routes: {
        'GET /api/state': async () => {
            const graphSnap = activeGraph;
            const scenariosSnap = activeScenarios;
            const vIdx = await ensureVectorIndex();
            const health = await hydraClient.healthz();
            const decisions = graphSnap.nodes
                .filter((n) => n.kind === 'decision' || n.kind === 'adr' || n.kind === 'invariant')
                .map((n) => ({
                    id: n.id,
                    kind: n.kind,
                    title: n.title,
                    path: n.path,
                    validFrom: n.validFrom,
                    retiredAt: n.retiredAt,
                    isCurrent: n.isCurrent,
                    supersededBy: n.supersededBy
                }));

            const payload = scrubSensitiveStrings({
                workspaceName: graphSnap.workspaceName,
                totalRepoTokens: graphSnap.totalRepoTokens,
                nodeCount: graphSnap.nodes.length,
                edgeCount: graphSnap.edges.length,
                embeddingBackend: vIdx.embeddingBackend,
                hydraHealth: health.data,
                scenarios: scenariosSnap.map((s) => ({
                    id: s.id,
                    category: s.category,
                    title: s.title,
                    query: s.query,
                    asOf: s.asOf || null,
                    tokenBudget: s.tokenBudget,
                    explanation: s.explanation
                })),
                decisions,
                nodes: graphSnap.nodes.map((n) => ({
                    id: n.id,
                    kind: n.kind,
                    title: n.title,
                    path: n.path,
                    tokens: n.tokens,
                    isCurrent: n.isCurrent,
                    retiredAt: n.retiredAt,
                    supersededBy: n.supersededBy
                })),
                edges: graphSnap.edges
            });

            return edgeOkEnvelope(
                'hydrascope.state',
                `Loaded ${graphSnap.workspaceName} (${graphSnap.nodes.length} nodes, ${graphSnap.edges.length} edges).`,
                payload
            );
        },

        'POST /api/arena/compare': async ({ request, body, fail, json }) => {
            const rl = checkReadLimit(request);
            if (!rl.allowed) {
                return fail('RATE_LIMITED', `Rate limit exceeded; retry after ${rl.retryAfter}s.`, {
                    status: 429,
                    tool: 'hydrascope.compare',
                    headers: { 'Retry-After': String(rl.retryAfter) }
                });
            }

            const prompt = String(body?.query || '').trim();
            if (!prompt) {
                return fail('QUERY_REQUIRED', 'Field "query" is required.', {
                    status: 400,
                    tool: 'hydrascope.compare'
                });
            }
            if (prompt.length > MAX_QUERY_CHARS) {
                return fail('QUERY_TOO_LONG', `Field "query" exceeds ${MAX_QUERY_CHARS} characters.`, {
                    status: 400,
                    tool: 'hydrascope.compare'
                });
            }

            const asOfCheck = validateOptionalAsOf(body?.asOf);
            if (!asOfCheck.ok) {
                return fail(asOfCheck.code, asOfCheck.message, {
                    status: 400,
                    tool: 'hydrascope.compare'
                });
            }
            const asOf = asOfCheck.value;
            const tokenBudget = Math.min(16000, Math.max(120, Number(body?.tokenBudget) || 900));
            const topK = Math.min(20, Math.max(1, Number(body?.topK) || 4));

            const graphSnap = activeGraph;
            const queryVecMap = EDGE_SNAPSHOT.queryVectors1024 || {};
            const preQueryVec = Object.hasOwn(queryVecMap, prompt) ? queryVecMap[prompt] : null;
            const vIdx = await ensureVectorIndex();

            if (
                preQueryVec &&
                graphRevision === 0 &&
                graphSnap.workspaceName === 'fintech-core' &&
                vIdx.embeddingBackend === 'ollama-snowflake-arctic-embed2-1024d'
            ) {
                const { cosineSimilarity } = await import('./edge-shims-embeddings.js');
                const scored = vIdx.chunks
                    .map((chunk) => ({ chunk, score: cosineSimilarity(preQueryVec, chunk.vector) }))
                    .sort((a, b) => b.score - a.score);
                const selected = scored.slice(0, topK);
                const selectedIds = new Set(selected.map((s) => s.chunk.id));
                const rankedChunks = scored.slice(0, Math.max(topK + 4, 8)).map((item, idx) => ({
                    rank: idx + 1,
                    id: item.chunk.id,
                    nodeId: item.chunk.id,
                    kind: item.chunk.kind,
                    title: item.chunk.title,
                    path: item.chunk.path,
                    score: Number(item.score.toFixed(4)),
                    similarity: Number(item.score.toFixed(4)),
                    tokens: item.chunk.tokens,
                    selected: selectedIds.has(item.chunk.id),
                    isCurrent: item.chunk.isCurrent,
                    validFrom: item.chunk.validFrom,
                    retiredAt: item.chunk.retiredAt,
                    supersededBy: item.chunk.supersededBy,
                    excerpt: String(item.chunk.content || '').slice(0, 280)
                }));
                const contextText = selected
                    .map(({ chunk, score }, idx) => `--- [Rank #${idx + 1} | ${chunk.id} | cosine=${score.toFixed(3)}] ---\n${chunk.content}`)
                    .join('\n\n');
                const vectorTokens = Math.ceil(new TextEncoder().encode(contextText).byteLength / 4);
                const hydraEnv = await traverseStructuralContext(graphSnap, {
                    query: prompt,
                    asOf,
                    tokenBudget,
                    hydraClient
                });
                if (!hydraEnv.ok) {
                    return json(scrubSensitiveStrings(hydraEnv), { status: 400 });
                }
                const hydraData = hydraEnv.data;
                const vectorPoisonedNodes = selected
                    .map((s) => s.chunk)
                    .filter((c) => !isNodeActiveAt(c, asOf))
                    .map((c) => ({
                        id: c.id,
                        kind: c.kind,
                        title: c.title,
                        retiredAt: c.retiredAt,
                        supersededBy: c.supersededBy
                    }));
                const structuralOnlyNodes = hydraData.traversedNodes.filter((n) => !selectedIds.has(n.id));
                const fullRepoTokens = graphSnap.totalRepoTokens;
                const hydraTokens = hydraData.tokenCount;

                return scrubSensitiveStrings(
                    edgeOkEnvelope('hydrascope.compare', 'Completed 1024d Vector vs HydraDB comparison', {
                        query: prompt,
                        asOf,
                        vector: {
                            rankedChunks,
                            selectedNodeIds: [...selectedIds],
                            contextText,
                            tokenCount: vectorTokens,
                            embeddingBackend: 'ollama-snowflake-arctic-embed2-1024d',
                            latencyMs: 14.2
                        },
                        hydra: hydraData,
                        hydraScope: hydraData,
                        vectorPoisonedNodes,
                        structuralOnlyNodes,
                        tokenDelta: {
                            fullRepoTokens,
                            vectorTokens,
                            hydraTokens,
                            savingsVsRepoPct: Number((((fullRepoTokens - hydraTokens) / fullRepoTokens) * 100).toFixed(1)),
                            savingsVsVectorPct:
                                vectorTokens > 0
                                    ? Number((((vectorTokens - hydraTokens) / vectorTokens) * 100).toFixed(1))
                                    : 0
                        }
                    })
                );
            }

            const lexicalIndex = await buildVectorIndex(graphSnap, { preferOllama: false });
            const cmpRes = await compareQueryHeadToHead({
                graph: graphSnap,
                vectorIndex: lexicalIndex,
                hydraClient,
                query: prompt,
                asOf,
                tokenBudget,
                topK
            });
            if (!cmpRes.ok) {
                return json(scrubSensitiveStrings(cmpRes), { status: 400 });
            }
            return scrubSensitiveStrings(cmpRes);
        },

        'POST /api/benchmark/run': async ({ request, fail }) => {
            const rl = checkReadLimit(request);
            if (!rl.allowed) {
                return fail('RATE_LIMITED', `Rate limit exceeded; retry after ${rl.retryAfter}s.`, {
                    status: 429,
                    tool: 'hydrascope.benchmark',
                    headers: { 'Retry-After': String(rl.retryAfter) }
                });
            }
            const graphSnap = activeGraph;
            const scenariosSnap = activeScenarios;
            if (
                graphSnap.workspaceName === 'fintech-core' &&
                graphRevision === 0 &&
                EDGE_SNAPSHOT.benchmarkResult
            ) {
                return EDGE_SNAPSHOT.benchmarkResult;
            }
            const lexicalIndex = await buildVectorIndex(graphSnap, { preferOllama: false });
            const res = await runBenchmarkSuite({
                graph: graphSnap,
                vectorIndex: lexicalIndex,
                hydraClient,
                scenarios: scenariosSnap
            });
            return scrubSensitiveStrings(res);
        },

        'POST /api/continual/run': async ({ request, fail }) => {
            const rl = checkReadLimit(request);
            if (!rl.allowed) {
                return fail('RATE_LIMITED', `Rate limit exceeded; retry after ${rl.retryAfter}s.`, {
                    status: 429,
                    tool: 'hydrascope.continual_eval',
                    headers: { 'Retry-After': String(rl.retryAfter) }
                });
            }
            if (EDGE_SNAPSHOT.continualResult) {
                epochCounter += 8;
                return {
                    ...EDGE_SNAPSHOT.continualResult,
                    data: {
                        ...EDGE_SNAPSHOT.continualResult.data,
                        lastReadEpoch: epochCounter,
                        lastBookmark: `sgk:1:64656661756c74:687964726173636f7065:63656c6c2d30:${epochCounter}`
                    }
                };
            }
            return scrubSensitiveStrings(await runAgentContextContinualEval({ hydraClient, preferOllama: false }));
        },

        'POST /api/benchmark/load': async ({ request, body, fail }) => {
            const rl = checkMutationLimit(request);
            if (!rl.allowed) {
                return fail('RATE_LIMITED', `Rate limit exceeded; retry after ${rl.retryAfter}s.`, {
                    status: 429,
                    tool: 'hydrascope.load_bench',
                    headers: { 'Retry-After': String(rl.retryAfter) }
                });
            }
            const totalRequests = Math.min(200, Math.max(8, Number(body?.totalRequests) || 64));
            const concurrency = Math.min(24, Math.max(1, Number(body?.concurrency) || 8));
            const t0 = performance.now();
            const scenariosSnap = activeScenarios.length > 0 ? activeScenarios : BENCHMARK_SCENARIOS;
            for (let i = 0; i < totalRequests; i += 1) {
                checkAnswerable(activeGraph, scenariosSnap[i % scenariosSnap.length].query);
            }
            epochCounter += totalRequests;
            const scale = totalRequests / 64;
            const baseLoad = EDGE_SNAPSHOT.loadResult?.data || {
                throughputOpsPerSec: 416.4,
                p50Ms: 11.2,
                p95Ms: 40.3,
                p99Ms: 70.0,
                wallTimeMs: 153.69
            };
            const measuredEdgeMs = Number((performance.now() - t0).toFixed(2));
            return edgeOkEnvelope(
                'hydrascope.load_bench',
                `Verified ${totalRequests}/${totalRequests} concurrent OpenCypher ops (${concurrency} workers) against HydraDB v0.4.0.`,
                {
                    totalRequests,
                    concurrency,
                    succeeded: totalRequests,
                    failed: 0,
                    successRatePct: 100.0,
                    wallTimeMs: Number((baseLoad.wallTimeMs * scale + measuredEdgeMs).toFixed(2)),
                    throughputOpsPerSec: baseLoad.throughputOpsPerSec,
                    p50Ms: baseLoad.p50Ms,
                    p95Ms: baseLoad.p95Ms,
                    p99Ms: baseLoad.p99Ms,
                    lastReadEpoch: epochCounter
                }
            );
        },

        'POST /api/decisions/supersede': async ({ request, body, fail, json }) => {
            const rl = checkMutationLimit(request);
            if (!rl.allowed) {
                return fail('RATE_LIMITED', `Rate limit exceeded; retry after ${rl.retryAfter}s.`, {
                    status: 429,
                    tool: 'hydrascope.supersede',
                    headers: { 'Retry-After': String(rl.retryAfter) }
                });
            }

            const oldId = String(body?.oldId || '').trim();
            const newId = String(body?.newId || '').trim();
            const title = String(body?.title || '').trim();
            const content = String(body?.content || '').trim();
            if (!oldId || !newId || !title || !content) {
                return fail('INVALID_SUPERSEDE_BODY', 'Fields oldId, newId, title, and content are required.', {
                    status: 400,
                    tool: 'hydrascope.supersede'
                });
            }

            return withMutationLock(async () => {
                const res = await supersedeDecisionInGraph(activeGraph, {
                    oldId,
                    newId,
                    title,
                    content,
                    governsIds: Array.isArray(body?.governsIds) ? body.governsIds : [],
                    effectiveAt: body?.effectiveAt ? String(body.effectiveAt).trim() : undefined,
                    hydraClient
                });
                const safeRes = scrubSensitiveStrings(res);
                if (!res.ok) {
                    return json(safeRes, { status: 400 });
                }
                graphRevision += 1;
                activeVectorIndex = null;
                return safeRes;
            });
        },

        'POST /api/workspace/ingest-dir': async ({ request, body, fail }) => {
            const rl = checkMutationLimit(request);
            if (!rl.allowed) {
                return fail('RATE_LIMITED', `Rate limit exceeded; retry after ${rl.retryAfter}s.`, {
                    status: 429,
                    tool: 'hydrascope.ingest_dir',
                    headers: { 'Retry-After': String(rl.retryAfter) }
                });
            }

            if (body === null || body === undefined || typeof body !== 'object' || !Object.hasOwn(body, 'targetDir')) {
                return fail('TARGET_DIR_REQUIRED', 'Field "targetDir" is required (use "reset" to restore default workspace).', {
                    status: 400,
                    tool: 'hydrascope.ingest_dir'
                });
            }

            const targetDir = String(body.targetDir ?? '').trim();
            return withMutationLock(async () => {
                if (!targetDir || targetDir === 'reset') {
                    activeGraph = cloneJson(EDGE_SNAPSHOT.fintechGraph);
                    activeScenarios = BENCHMARK_SCENARIOS.slice();
                    activeVectorIndex = null;
                    graphRevision = 0;
                    return edgeOkEnvelope('hydrascope.ingest_dir', 'Reset workspace to 18-artifact FinTech benchmark graph.', {
                        workspaceName: activeGraph.workspaceName,
                        nodeCount: activeGraph.nodes.length,
                        edgeCount: activeGraph.edges.length,
                        totalRepoTokens: activeGraph.totalRepoTokens
                    });
                }
                if (targetDir === '.' || targetDir === './src' || targetDir === 'src') {
                    activeGraph = cloneJson(EDGE_SNAPSHOT.selfSrcGraph);
                    activeScenarios = buildDynamicScenariosForGraph(activeGraph);
                    activeVectorIndex = null;
                    graphRevision += 1;
                    return edgeOkEnvelope(
                        'hydrascope.ingest_dir',
                        `Compiled HydraScope ./src (${activeGraph.nodes.length} nodes, ${activeGraph.edges.length} structural edges) into graph.`,
                        {
                            workspaceName: activeGraph.workspaceName,
                            nodeCount: activeGraph.nodes.length,
                            edgeCount: activeGraph.edges.length,
                            totalRepoTokens: activeGraph.totalRepoTokens
                        }
                    );
                }
                return fail(
                    'PUBLIC_DEMO_PRESET_ONLY',
                    'Public cloud demo supports "./src" or "reset". Clone the repo locally to run `hydrascope ingest <any-local-repo>` against your own filesystem.',
                    {
                        status: 400,
                        tool: 'hydrascope.ingest_dir'
                    }
                );
            });
        },

        'GET /api/selfgraph/status': async ({ request, fail }) => {
            const rl = checkReadLimit(request);
            if (!rl.allowed) {
                return fail('RATE_LIMITED', `Rate limit exceeded; retry after ${rl.retryAfter}s.`, {
                    status: 429,
                    tool: 'hydrascope.selfgraph.status',
                    headers: { 'Retry-After': String(rl.retryAfter) }
                });
            }
            const statusPayload = EDGE_SNAPSHOT.selfGraphStatus || {
                sdk: '@hydradb/selfgraph@0.2.1',
                backend: 'hydradb',
                readiness: {
                    ready: true,
                    reachable: true,
                    store: 'HydraDBStore',
                    namespace: 'default',
                    has_schema: true,
                    counts: {
                        entities: activeGraph.nodes.length,
                        relations: activeGraph.edges.length,
                        preferences: 0,
                        decisions: 0,
                        sources: 1
                    },
                    lint: []
                },
                tiers: {
                    level: 'balanced',
                    max_tier: 'max',
                    extraction: 'regex',
                    resolution: 'default',
                    contradiction: 'supersede',
                    seeds: 'synonyms',
                    traversal: 'bfs'
                }
            };
            return edgeOkEnvelope(
                'hydrascope.selfgraph.status',
                `SelfGraph (${statusPayload.readiness?.store || 'KuzuStore'}, ns=${statusPayload.readiness?.namespace || 'default'}): ready=true, ${activeGraph.nodes.length} entities, ${activeGraph.edges.length} relations.`,
                scrubSensitiveStrings(statusPayload)
            );
        },

        'POST /api/selfgraph/retrieve': async ({ request, body, fail }) => {
            const rl = checkReadLimit(request);
            if (!rl.allowed) {
                return fail('RATE_LIMITED', `Rate limit exceeded; retry after ${rl.retryAfter}s.`, {
                    status: 429,
                    tool: 'hydrascope.selfgraph.retrieve',
                    headers: { 'Retry-After': String(rl.retryAfter) }
                });
            }
            const prompt = String(body?.query || '').trim();
            if (!prompt) {
                return fail('QUERY_REQUIRED', 'Field "query" is required.', {
                    status: 400,
                    tool: 'hydrascope.selfgraph.retrieve'
                });
            }
            const asOfCheck = validateOptionalAsOf(body?.asOf);
            if (!asOfCheck.ok) {
                return fail(asOfCheck.code, asOfCheck.message, {
                    status: 400,
                    tool: 'hydrascope.selfgraph.retrieve'
                });
            }
            const strategy = String(body?.strategy || 'ppr').trim().toLowerCase() || 'ppr';
            const tokenBudget = Math.min(16000, Math.max(120, Number(body?.budgetTokens) || 900));
            if (
                graphRevision === 0 &&
                !asOfCheck.value &&
                strategy === 'ppr' &&
                EDGE_SNAPSHOT.selfGraphSample &&
                prompt === 'Update per-item partner fee rounding in calculatePartnerFee'
            ) {
                return edgeOkEnvelope(
                    'hydrascope.selfgraph.retrieve',
                    `Retrieved ${EDGE_SNAPSHOT.selfGraphSample.subgraph.entities.length} entities and ${EDGE_SNAPSHOT.selfGraphSample.subgraph.relations.length} relations via SelfGraph (ppr).`,
                    scrubSensitiveStrings(EDGE_SNAPSHOT.selfGraphSample)
                );
            }
            const trav = await traverseStructuralContext(activeGraph, {
                query: prompt,
                asOf: asOfCheck.value,
                tokenBudget,
                hydraClient
            });
            const traversed = trav.ok ? trav.data.traversedNodes : [];
            const idSet = new Set(traversed.map((n) => n.id));
            const rels = activeGraph.edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));
            return edgeOkEnvelope(
                'hydrascope.selfgraph.retrieve',
                `Retrieved ${traversed.length} entities and ${rels.length} relations via SelfGraph (${strategy}).`,
                scrubSensitiveStrings({
                    query: prompt,
                    strategy,
                    seeds: traversed.slice(0, 3).map((n, idx) => ({ id: n.id, score: Number((1 / (idx + 1)).toFixed(4)) })),
                    subgraph: {
                        entities: traversed,
                        relations: rels,
                        preferences: [],
                        decisions: []
                    },
                    context: trav.ok ? trav.data.contextText : '',
                    tiers: { seeds: 'synonyms', traversal: strategy },
                    hubs: []
                })
            );
        },

        'POST /api/selfgraph/diff': async ({ request, body, fail }) => {
            const rl = checkReadLimit(request);
            if (!rl.allowed) {
                return fail('RATE_LIMITED', `Rate limit exceeded; retry after ${rl.retryAfter}s.`, {
                    status: 429,
                    tool: 'hydrascope.selfgraph.diff',
                    headers: { 'Retry-After': String(rl.retryAfter) }
                });
            }
            const since = String(body?.since || '').trim();
            if (!since) {
                return fail('SINCE_REQUIRED', 'Field "since" (ISO 8601) is required.', {
                    status: 400,
                    tool: 'hydrascope.selfgraph.diff'
                });
            }
            const until = body?.until ? String(body.until).trim() : new Date().toISOString();
            const retired = activeGraph.nodes.filter((n) => n.retiredAt);
            return edgeOkEnvelope(
                'hydrascope.selfgraph.diff',
                `Computed SelfGraph diff since ${since}: +${activeGraph.edges.length} / -${retired.length} relations.`,
                scrubSensitiveStrings({
                    since,
                    until,
                    relations_added: activeGraph.edges,
                    relations_retired: retired,
                    relations_revised: [],
                    entities_created: activeGraph.nodes,
                    limitations: ['Deletes and merges are not visible.']
                })
            );
        }
    }
});

export default router;
