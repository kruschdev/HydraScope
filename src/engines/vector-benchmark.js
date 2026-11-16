/**
 * @module engines/vector-benchmark
 * @description Honest dense vector store baseline (`snowflake-arctic-embed2` 1024d via
 * `@krusch/toolkit/embeddings` with deterministic 256d feature-hashed n-gram cosine fallback),
 * head-to-head query comparator, and 3-arm benchmark evaluator (`INV-HS-01..05`).
 */

import { okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import {
    embedBatch,
    cosineSimilarity,
    generateDeterministicVector,
    l2Normalize,
} from '@krusch/toolkit/embeddings';
import {
    isNodeActiveAt,
    traverseStructuralContext,
    estimateStructuralTokens,
} from './structural-retriever.js';

const OLLAMA_BACKEND_ID = 'ollama-snowflake-arctic-embed2-1024d';
const FALLBACK_BACKEND_ID = 'hashed-ngram-cosine-256d';
const FALLBACK_DIMS = 256;

const LEXICAL_STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'can', 'do', 'does',
    'for', 'from', 'had', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it',
    'its', 'of', 'on', 'or', 'our', 'should', 'so', 'that', 'the', 'their', 'then',
    'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
    'why', 'will', 'with', 'without', 'would',
]);

/**
 * Private runtime config map so serialized `vectorIndex` payloads never leak private LAN/Tailscale IPs (`INV-HS-02`).
 */
const VECTOR_INDEX_RUNTIME = new WeakMap();

/**
 * Deterministic 32-bit FNV-1a hash for fast signed feature projection.
 *
 * @param {string} feature
 * @param {number} seed
 * @returns {number}
 */
function fnv1a32(feature, seed = 0x811c9dc5) {
    let h = seed >>> 0;
    for (let i = 0; i < feature.length; i++) {
        h ^= feature.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/**
 * Build a genuine 256d L2-normalized bag-of-words + word-bigram + 3/4-char n-gram
 * signed feature-hashed vector so offline cosine similarity reflects real lexical overlap.
 *
 * @param {string} text
 * @param {number} [dims=256]
 * @returns {number[]}
 */
export function buildLexicalDenseVector(text, dims = FALLBACK_DIMS) {
    const targetDims = Number.isInteger(dims) && dims > 0 ? dims : FALLBACK_DIMS;
    const raw = String(text ?? '').trim();
    if (!raw) {
        return generateDeterministicVector('', targetDims);
    }

    const expanded = raw
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase();

    const words = (expanded.match(/[a-z0-9]{2,}/g) || []).filter((w) => !LEXICAL_STOP_WORDS.has(w));
    if (words.length === 0) {
        return generateDeterministicVector(raw, targetDims);
    }

    const vec = Array.from({ length: targetDims }, () => 0);
    const project = (feat, weight) => {
        const h1 = fnv1a32(feat, 0x811c9dc5);
        const h2 = fnv1a32(feat, 0x9e3779b9);
        const idx1 = h1 % targetDims;
        const sign1 = (h1 & 0x10000) === 0 ? 1 : -1;
        const idx2 = h2 % targetDims;
        const sign2 = (h2 & 0x20000) === 0 ? 1 : -1;
        vec[idx1] += sign1 * weight;
        vec[idx2] += sign2 * (weight * 0.5);
    };

    const tf = new Map();
    for (const w of words) {
        tf.set(w, (tf.get(w) || 0) + 1);
    }
    for (const [w, count] of tf.entries()) {
        const sublinearWeight = 1.45 * (1 + Math.log(count));
        project(`w:${w}`, sublinearWeight);
        if (w.length >= 4) {
            for (let i = 0; i <= w.length - 4; i++) {
                project(`g4:${w.slice(i, i + 4)}`, 0.32);
            }
        }
        if (w.length >= 3) {
            for (let i = 0; i <= w.length - 3; i++) {
                project(`g3:${w.slice(i, i + 3)}`, 0.22);
            }
        }
    }
    for (let i = 0; i + 1 < words.length; i++) {
        project(`bg:${words[i]}_${words[i + 1]}`, 1.05);
    }

    return l2Normalize(vec);
}

/**
 * Format a graph node as a flat RAG chunk string (blind to graph edges and `:SUPERSEDES` metadata,
 * mirroring how standard vector stores index repository files and markdown documents).
 *
 * @param {object} node
 * @returns {string}
 */
function formatNodeChunkText(node) {
    const parts = [];
    if (node.title) parts.push(String(node.title));
    if (node.path) parts.push(`File: ${node.path}`);
    if (Array.isArray(node.symbols) && node.symbols.length > 0) {
        parts.push(`Symbols: ${node.symbols.join(', ')}`);
    }
    if (node.content) parts.push(String(node.content));
    return parts.join('\n');
}

/**
 * Validate that a batch of vectors matches `expectedCount` and contains finite non-zero coordinates.
 */
function isValidDenseBatch(vectors, expectedCount) {
    if (!Array.isArray(vectors) || vectors.length !== expectedCount || expectedCount === 0) {
        return false;
    }
    const dim = Array.isArray(vectors[0]) ? vectors[0].length : 0;
    if (dim === 0) return false;
    return vectors.every(
        (vec) =>
            Array.isArray(vec) &&
            vec.length === dim &&
            vec.some((val) => typeof val === 'number' && Number.isFinite(val) && Math.abs(val) > 1e-9)
    );
}

/**
 * Build a dense vector index over ALL `graph.nodes` (`INV-HS-04`).
 * Attempts `snowflake-arctic-embed2:latest` (`1024d`) via `@krusch/toolkit/embeddings`
 * and falls back cleanly to `buildLexicalDenseVector` (`256d`) when offline.
 *
 * @param {object} graph
 * @param {object} [options={}]
 * @returns {Promise<{ chunks: object[], dims: number, embeddingBackend: string, builtAt: string }>}
 */
export async function buildVectorIndex(
    graph,
    {
        preferOllama = true,
        ollamaHost = process.env.OLLAMA_EMBED_HOST,
        model = process.env.EMBED_MODEL || 'snowflake-arctic-embed2:latest',
    } = {}
) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const texts = nodes.map((node) => formatNodeChunkText(node));

    let vectors = null;
    let embeddingBackend = FALLBACK_BACKEND_ID;
    let dims = FALLBACK_DIMS;

    if (preferOllama !== false && process.env.MOCK_EMBEDDINGS !== '1' && texts.length > 0) {
        try {
            const candidateVectors = await embedBatch(texts, {
                ...(ollamaHost ? { host: ollamaHost } : {}),
                model,
                mode: 'document',
                timeoutMs: 2500,
            });
            if (isValidDenseBatch(candidateVectors, texts.length)) {
                vectors = candidateVectors;
                dims = candidateVectors[0].length;
                embeddingBackend = OLLAMA_BACKEND_ID;
            }
        } catch {
            vectors = null;
        }
    }

    if (!vectors) {
        vectors = texts.map((t) => buildLexicalDenseVector(t, FALLBACK_DIMS));
        dims = FALLBACK_DIMS;
        embeddingBackend = FALLBACK_BACKEND_ID;
    }

    const chunks = nodes.map((node, i) => {
        const chunkText = texts[i];
        const rawTokens = Number(node.tokens) > 0 ? Number(node.tokens) : estimateStructuralTokens(chunkText);
        return {
            id: node.id,
            nodeId: node.id,
            kind: node.kind || 'file',
            title: node.title || node.id,
            path: node.path || null,
            content: node.content || '',
            chunkText,
            tokens: rawTokens,
            validFrom: node.validFrom || null,
            retiredAt: node.retiredAt || null,
            isCurrent: node.isCurrent !== false,
            supersededBy: node.supersededBy || null,
            vector: vectors[i],
        };
    });

    const indexObj = {
        chunks,
        dims,
        embeddingBackend,
        builtAt: new Date().toISOString(),
    };

    VECTOR_INDEX_RUNTIME.set(indexObj, {
        ollamaHost,
        model,
    });

    return indexObj;
}

/**
 * Query the dense vector index for `topK` nearest neighbors within `tokenBudget`.
 * Mirrors standard vector RAG behavior: always returns nearest neighbors by cosine similarity
 * without pre-flight answerability gating or `:SUPERSEDES` retirement filtering.
 *
 * @param {object} vectorIndex
 * @param {string} query
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
export async function queryVectorTopK(
    vectorIndex,
    query,
    { topK = 4, tokenBudget = 1600 } = {}
) {
    const startedAt = performance.now();
    const chunks = Array.isArray(vectorIndex?.chunks) ? vectorIndex.chunks : [];
    const effectiveTopK = Math.max(1, Number(topK) || 4);
    const effectiveBudget = Math.max(120, Number(tokenBudget) || 1600);
    const queryText = String(query ?? '');

    if (chunks.length === 0) {
        return {
            rankedChunks: [],
            selectedNodeIds: [],
            contextText: '',
            tokenCount: 0,
            embeddingBackend: vectorIndex?.embeddingBackend || FALLBACK_BACKEND_ID,
            latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        };
    }

    let activeBackend = vectorIndex.embeddingBackend || FALLBACK_BACKEND_ID;
    let queryVec = null;
    let scoreChunks = chunks;

    if (activeBackend === OLLAMA_BACKEND_ID) {
        const runtimeCfg = VECTOR_INDEX_RUNTIME.get(vectorIndex) || {};
        try {
            const [embeddedQuery] = await embedBatch([queryText], {
                ...(runtimeCfg.ollamaHost ? { host: runtimeCfg.ollamaHost } : {}),
                model: runtimeCfg.model || process.env.EMBED_MODEL || 'snowflake-arctic-embed2:latest',
                mode: 'query',
                timeoutMs: 2500,
            });
            if (Array.isArray(embeddedQuery) && embeddedQuery.length === vectorIndex.dims) {
                queryVec = embeddedQuery;
            }
        } catch {
            queryVec = null;
        }

        if (!queryVec) {
            activeBackend = FALLBACK_BACKEND_ID;
            queryVec = buildLexicalDenseVector(queryText, FALLBACK_DIMS);
            scoreChunks = chunks.map((c) => ({
                ...c,
                vector: buildLexicalDenseVector(c.chunkText || c.content || c.title, FALLBACK_DIMS),
            }));
        }
    } else {
        const targetDims = Number(vectorIndex.dims) > 0 ? Number(vectorIndex.dims) : FALLBACK_DIMS;
        queryVec = buildLexicalDenseVector(queryText, targetDims);
    }

    const scored = scoreChunks.map((chunk) => ({
        chunk,
        score: cosineSimilarity(queryVec, chunk.vector),
    }));
    scored.sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1));

    const selectedChunks = [];
    let usedTokens = 0;
    for (const item of scored) {
        if (selectedChunks.length >= effectiveTopK) break;
        const itemTokens = Math.max(16, Number(item.chunk.tokens) || estimateStructuralTokens(item.chunk.content || ''));
        if (selectedChunks.length > 0 && usedTokens + itemTokens > effectiveBudget) {
            continue;
        }
        selectedChunks.push({ ...item, itemTokens: Math.min(itemTokens, effectiveBudget) });
        usedTokens += Math.min(itemTokens, effectiveBudget);
    }

    const selectedIdSet = new Set(selectedChunks.map((s) => s.chunk.id));
    const rankedChunks = scored.slice(0, Math.max(effectiveTopK + 4, 8)).map((item, idx) => ({
        rank: idx + 1,
        id: item.chunk.id,
        nodeId: item.chunk.id,
        kind: item.chunk.kind,
        title: item.chunk.title,
        path: item.chunk.path,
        score: Number(item.score.toFixed(4)),
        similarity: Number(item.score.toFixed(4)),
        tokens: item.chunk.tokens,
        selected: selectedIdSet.has(item.chunk.id),
        isCurrent: item.chunk.isCurrent,
        validFrom: item.chunk.validFrom,
        retiredAt: item.chunk.retiredAt,
        supersededBy: item.chunk.supersededBy,
        excerpt: String(item.chunk.content || '').slice(0, 280),
    }));

    const contextSections = selectedChunks.map(
        ({ chunk, score }, idx) =>
            `--- [Rank #${idx + 1} | ${chunk.id} | cosine=${score.toFixed(3)}${chunk.path ? ` | ${chunk.path}` : ''}] ---\n${chunk.content || ''}`
    );
    const rawContext = contextSections.join('\n\n');
    const maxBytes = effectiveBudget * 4;
    const contextText =
        Buffer.byteLength(rawContext, 'utf8') > maxBytes
            ? `${rawContext.slice(0, Math.max(64, maxBytes - 16))}...`
            : rawContext;
    const tokenCount = selectedChunks.length === 0 ? 0 : Math.min(effectiveBudget, estimateStructuralTokens(contextText));

    return {
        rankedChunks,
        selectedNodeIds: selectedChunks.map((s) => s.chunk.id),
        contextText,
        tokenCount,
        embeddingBackend: activeBackend,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    };
}

/**
 * Normalize ID comparison so both exact IDs (`adr:ADR-014`) and bare IDs (`ADR-014`) match symmetrically.
 */
function matchesLogicalId(selectedIds, targetId) {
    if (!targetId) return false;
    const cleanTarget = String(targetId).trim();
    if (selectedIds.has(cleanTarget)) return true;
    const bareTarget = cleanTarget.replace(/^[a-z_]+:/i, '').toLowerCase();
    for (const sid of selectedIds) {
        if (sid.toLowerCase() === cleanTarget.toLowerCase()) return true;
        if (sid.replace(/^[a-z_]+:/i, '').toLowerCase() === bareTarget) return true;
    }
    return false;
}

/**
 * Run Dense Vector `topK` vs. HydraScope Structural Graph side-by-side on a single query (`INV-HS-01..05`).
 *
 * @param {object} [options={}]
 * @returns {Promise<object>} `INV-LEGO-01` envelope
 */
export async function compareQueryHeadToHead({
    graph,
    vectorIndex = null,
    hydraClient = null,
    query = '',
    asOf = null,
    tokenBudget = 900,
    topK = 4,
} = {}) {
    if (!graph || !Array.isArray(graph.nodes)) {
        return errorEnvelope('INVALID_GRAPH', 'Valid graph object is required.', null, 'hydrascope.compare');
    }

    const activeIndex = vectorIndex || (await buildVectorIndex(graph, { preferOllama: false }));
    const vectorBudget = Math.max(1600, Number(tokenBudget) || 900);

    const [vectorResult, hydraEnvelope] = await Promise.all([
        queryVectorTopK(activeIndex, query, { topK, tokenBudget: vectorBudget }),
        traverseStructuralContext(graph, { query, asOf, tokenBudget, hydraClient }),
    ]);

    if (!hydraEnvelope.ok) {
        return hydraEnvelope;
    }

    const hydraData = hydraEnvelope.data;
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

    const vectorPoisonedNodes = vectorResult.selectedNodeIds
        .map((id) => nodeById.get(id))
        .filter((node) => node && !isNodeActiveAt(node, asOf))
        .map((node) => ({
            id: node.id,
            kind: node.kind || 'decision',
            title: node.title || node.id,
            retiredAt: node.retiredAt || null,
            supersededBy: node.supersededBy || null,
        }));

    const vectorSelectedSet = new Set(vectorResult.selectedNodeIds);
    const structuralOnlyNodes = hydraData.traversedNodes
        .filter((n) => !vectorSelectedSet.has(n.id))
        .map((n) => ({
            id: n.id,
            kind: n.kind,
            title: n.title,
            path: n.path,
            hop: n.hop,
            role: n.role,
        }));

    const fullRepoTokens =
        Number(graph.totalRepoTokens) > 0
            ? Number(graph.totalRepoTokens)
            : graph.nodes.reduce((sum, n) => sum + (Number(n?.tokens) || estimateStructuralTokens(n?.content || '')), 0);
    const vectorTokens = vectorResult.tokenCount;
    const hydraTokens = hydraData.tokenCount;

    const savingsVsRepoPct =
        fullRepoTokens > 0 ? Number((((fullRepoTokens - hydraTokens) / fullRepoTokens) * 100).toFixed(1)) : 0;
    const savingsVsVectorPct =
        vectorTokens > 0 ? Number((((vectorTokens - hydraTokens) / vectorTokens) * 100).toFixed(1)) : 0;

    const tokenDelta = {
        fullRepoTokens,
        vectorTokens,
        hydraTokens,
        savingsVsRepoPct,
        savingsVsVectorPct,
    };

    return okEnvelope(
        'hydrascope.compare',
        `HydraScope used ${hydraTokens} tokens vs ${vectorTokens} vector tokens (${savingsVsRepoPct}% saved vs full repo; ${vectorPoisonedNodes.length} vector poison hit(s))`,
        {
            query,
            asOf,
            vector: vectorResult,
            hydra: hydraData,
            hydraScope: hydraData,
            vectorPoisonedNodes,
            structuralOnlyNodes,
            tokenDelta,
        }
    );
}

/**
 * Score a single retrieval arm against a scenario's required nodes, forbidden poison nodes, and answerability expectation.
 */
function scoreScenarioArm({
    selectedNodeIds,
    tokenCount,
    latencyMs = 0,
    scenario,
    nodeById,
}) {
    const selectedSet = new Set(selectedNodeIds);
    const expectAnswerable =
        scenario.expectAnswerable !== undefined
            ? Boolean(scenario.expectAnswerable)
            : scenario.category !== 'ungrounded_trap';
    const requiredIds = Array.isArray(scenario.requiredNodeIds) ? scenario.requiredNodeIds : [];
    const forbiddenIds = Array.isArray(scenario.forbiddenPoisonNodeIds) ? scenario.forbiddenPoisonNodeIds : [];

    const hitRequiredIds = requiredIds.filter((reqId) => matchesLogicalId(selectedSet, reqId));
    const missingRequiredIds = requiredIds.filter((reqId) => !matchesLogicalId(selectedSet, reqId));
    const criticalRecall =
        !expectAnswerable || requiredIds.length === 0
            ? 1
            : Number((hitRequiredIds.length / requiredIds.length).toFixed(4));

    const hitForbiddenIds = forbiddenIds.filter((badId) => matchesLogicalId(selectedSet, badId));
    if (hitForbiddenIds.length === 0 && scenario.category === 'temporal_supersession') {
        for (const id of selectedNodeIds) {
            const node = nodeById.get(id);
            if (node && !isNodeActiveAt(node, scenario.asOf || null)) {
                hitForbiddenIds.push(id);
            }
        }
    }

    const poisoned = hitForbiddenIds.length > 0;
    const trappedHallucination = !expectAnswerable && (selectedNodeIds.length > 0 || tokenCount > 0);
    const passed = !poisoned && !trappedHallucination && criticalRecall >= 1;

    return {
        selectedNodeIds,
        tokenCount,
        latencyMs: Number(latencyMs.toFixed(2)),
        criticalRecall,
        hitRequiredIds,
        missingRequiredIds,
        poisoned,
        poisonNodeIds: hitForbiddenIds,
        trappedHallucination,
        passed,
    };
}

/**
 * Aggregate per-scenario arm evaluations into a standardized benchmark summary card.
 */
function summarizeBenchmarkArm(armId, label, evaluations, scenarios, fullStuffingTotalTokens, vectorTotalTokens) {
    const count = Math.max(1, evaluations.length);
    const recallScenarios = evaluations.filter(
        (_, i) =>
            (scenarios[i].expectAnswerable !== undefined
                ? Boolean(scenarios[i].expectAnswerable)
                : scenarios[i].category !== 'ungrounded_trap') &&
            Array.isArray(scenarios[i].requiredNodeIds) &&
            scenarios[i].requiredNodeIds.length > 0
    );
    const poisonScenarios = evaluations.filter(
        (_, i) =>
            (Array.isArray(scenarios[i].forbiddenPoisonNodeIds) && scenarios[i].forbiddenPoisonNodeIds.length > 0) ||
            scenarios[i].category === 'temporal_supersession'
    );
    const trapScenarios = evaluations.filter(
        (_, i) =>
            (scenarios[i].expectAnswerable !== undefined
                ? Boolean(scenarios[i].expectAnswerable)
                : scenarios[i].category !== 'ungrounded_trap') === false
    );

    const recallDenom = recallScenarios.length > 0 ? recallScenarios : evaluations;
    const criticalRecallPct = Number(
        ((recallDenom.reduce((sum, e) => sum + e.criticalRecall, 0) / Math.max(1, recallDenom.length)) * 100).toFixed(1)
    );

    const poisonDenom = poisonScenarios.length > 0 ? poisonScenarios : evaluations;
    const poisonedCount = poisonDenom.filter((e) => e.poisoned).length;
    const temporalPoisoningPct = Number(((poisonedCount / Math.max(1, poisonDenom.length)) * 100).toFixed(1));

    const trappedCount = trapScenarios.filter((e) => e.trappedHallucination).length;
    const hallucinationTrapBlockPct =
        trapScenarios.length > 0
            ? Number((((trapScenarios.length - trappedCount) / trapScenarios.length) * 100).toFixed(1))
            : 100;
    const trappedHallucinationPct =
        trapScenarios.length > 0 ? Number(((trappedCount / trapScenarios.length) * 100).toFixed(1)) : 0;

    const passedCount = evaluations.filter((e) => e.passed).length;
    const passRatePct = Number(((passedCount / count) * 100).toFixed(1));
    const totalTokens = evaluations.reduce((sum, e) => sum + e.tokenCount, 0);
    const meanTokens = Math.round(totalTokens / count);
    const meanLatencyMs = Number((evaluations.reduce((sum, e) => sum + e.latencyMs, 0) / count).toFixed(2));

    const tokenReductionVsStuffing =
        fullStuffingTotalTokens > 0
            ? Number((((fullStuffingTotalTokens - totalTokens) / fullStuffingTotalTokens) * 100).toFixed(1))
            : 0;
    const tokenReductionVsVector =
        vectorTotalTokens > 0
            ? Number((((vectorTotalTokens - totalTokens) / vectorTotalTokens) * 100).toFixed(1))
            : 0;

    return {
        armId,
        label,
        scenarioCount: evaluations.length,
        passedCount,
        passRatePct,
        criticalRecallPct,
        temporalPoisoningPct,
        poisonedCount,
        trapBlockPct: hallucinationTrapBlockPct,
        hallucinationTrapBlockPct,
        trappedHallucinationPct,
        trappedCount,
        totalTokens,
        meanTokens,
        meanLatencyMs,
        tokenSavingsVsStuffingPct: tokenReductionVsStuffing,
        tokenSavingsVsVectorPct: tokenReductionVsVector,
        tokenReductionVsStuffing,
        tokenReductionVsVector,
    };
}

/**
 * Evaluate all passed `scenarios` across 3 retrieval arms:
 * 1. `full_stuffing` (`Full-Repo Stuffing`)
 * 2. `vector_topk` (`Dense Vector Top-K`)
 * 3. `hydrascope_graph` (`HydraScope Structural Graph`)
 *
 * @param {object} [options={}]
 * @returns {Promise<object>} `INV-LEGO-01` envelope
 */
export async function runBenchmarkSuite({
    graph,
    vectorIndex = null,
    hydraClient = null,
    scenarios = [],
} = {}) {
    if (!graph || !Array.isArray(graph.nodes)) {
        return errorEnvelope('INVALID_GRAPH', 'Valid graph object is required.', null, 'hydrascope.benchmark');
    }

    const activeIndex = vectorIndex || (await buildVectorIndex(graph));
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const allNodeIds = graph.nodes.map((n) => n.id);
    const fullRepoTokens =
        Number(graph.totalRepoTokens) > 0
            ? Number(graph.totalRepoTokens)
            : graph.nodes.reduce((sum, n) => sum + (Number(n?.tokens) || estimateStructuralTokens(n?.content || '')), 0);

    const fullEvals = [];
    const vectorEvals = [];
    const hydraEvals = [];
    const scenarioResults = [];
    let anyLiveHydra = false;

    for (const scenario of scenarios) {
        const fullArm = scoreScenarioArm({
            selectedNodeIds: allNodeIds,
            tokenCount: fullRepoTokens,
            latencyMs: 0.1,
            scenario,
            nodeById,
        });

        const vecRes = await queryVectorTopK(activeIndex, scenario.query, {
            topK: 4,
            tokenBudget: 1600,
        });
        const vectorArm = scoreScenarioArm({
            selectedNodeIds: vecRes.selectedNodeIds,
            tokenCount: vecRes.tokenCount,
            latencyMs: vecRes.latencyMs,
            scenario,
            nodeById,
        });

        const hydraStart = performance.now();
        const hydraEnv = await traverseStructuralContext(graph, {
            query: scenario.query,
            asOf: scenario.asOf || null,
            tokenBudget: scenario.tokenBudget || 900,
            hydraClient,
        });
        const hydraLatencyMs = performance.now() - hydraStart;
        const hydraData = hydraEnv.data || {
            selectedNodeIds: [],
            traversedNodes: [],
            retiredBlockedNodes: [],
            tokenCount: 0,
            answerability: { answerable: false },
            hydraExecution: { liveQueried: false },
        };
        if (hydraData.hydraExecution?.liveQueried) {
            anyLiveHydra = true;
        }

        const hydraSelectedIds = Array.isArray(hydraData.selectedNodeIds)
            ? hydraData.selectedNodeIds
            : (hydraData.traversedNodes || []).map((n) => n.id);

        const hydraArm = scoreScenarioArm({
            selectedNodeIds: hydraSelectedIds,
            tokenCount: hydraData.tokenCount || 0,
            latencyMs: hydraLatencyMs,
            scenario,
            nodeById,
        });

        fullEvals.push(fullArm);
        vectorEvals.push(vectorArm);
        hydraEvals.push(hydraArm);

        const expectAns =
            scenario.expectAnswerable !== undefined
                ? Boolean(scenario.expectAnswerable)
                : scenario.category !== 'ungrounded_trap';

        scenarioResults.push({
            id: scenario.id,
            category: scenario.category,
            title: scenario.title || scenario.id,
            query: scenario.query,
            asOf: scenario.asOf || null,
            expectAnswerable: expectAns,
            answerableExpected: expectAns,
            vectorRecallPct: Number((vectorArm.criticalRecall * 100).toFixed(1)),
            hydraRecallPct: Number((hydraArm.criticalRecall * 100).toFixed(1)),
            vectorPoisoned: vectorArm.poisoned,
            hydraPoisoned: hydraArm.poisoned,
            vectorTokens: vectorArm.tokenCount,
            hydraTokens: hydraArm.tokenCount,
            hydraBlockedTrap: !expectAns && !hydraArm.trappedHallucination,
            requiredNodeIds: scenario.requiredNodeIds || [],
            forbiddenPoisonNodeIds: scenario.forbiddenPoisonNodeIds || [],
            explanation: scenario.explanation || '',
            fullStuffing: fullArm,
            vectorTopK: vectorArm,
            hydraScope: {
                ...hydraArm,
                answerable: Boolean(hydraData.answerability?.answerable),
                retiredBlockedIds: (hydraData.retiredBlockedNodes || []).map((r) => r.id),
                cypherQuery: hydraData.cypherQuery || '',
            },
        });
    }

    const fullTotalTokens = fullEvals.reduce((s, e) => s + e.tokenCount, 0);
    const vectorTotalTokens = vectorEvals.reduce((s, e) => s + e.tokenCount, 0);

    const fullStuffing = summarizeBenchmarkArm(
        'full_stuffing',
        'Full-Repo Stuffing',
        fullEvals,
        scenarios,
        fullTotalTokens,
        vectorTotalTokens
    );
    const vectorTopK = summarizeBenchmarkArm(
        'vector_topk',
        'Dense Vector Top-K (k=4)',
        vectorEvals,
        scenarios,
        fullTotalTokens,
        vectorTotalTokens
    );
    const hydraScope = summarizeBenchmarkArm(
        'hydrascope_graph',
        'HydraScope Structural Graph',
        hydraEvals,
        scenarios,
        fullTotalTokens,
        vectorTotalTokens
    );

    const hydraLiveMode = Boolean(
        anyLiveHydra || (hydraClient && typeof hydraClient.isConfigured === 'function' && hydraClient.isConfigured())
    );

    return okEnvelope(
        'hydrascope.benchmark',
        `Evaluated ${scenarios.length} scenario(s): HydraScope ${hydraScope.criticalRecallPct}% recall, ${hydraScope.temporalPoisoningPct}% poison, ${hydraScope.meanTokens} mean tokens (${hydraScope.tokenReductionVsStuffing}% fewer vs full repo)`,
        {
            embeddingBackend: activeIndex.embeddingBackend,
            hydraLiveMode,
            scenarioCount: scenarios.length,
            criticalRecallPct: hydraScope.criticalRecallPct,
            temporalPoisoningPct: hydraScope.temporalPoisoningPct,
            hallucinationTrapBlockPct: hydraScope.hallucinationTrapBlockPct,
            meanTokens: hydraScope.meanTokens,
            tokenReductionVsStuffing: hydraScope.tokenReductionVsStuffing,
            tokenReductionVsVector: hydraScope.tokenReductionVsVector,
            arms: {
                fullStuffing,
                vectorTopK,
                hydraScope,
            },
            scenarioResults,
        }
    );
}
