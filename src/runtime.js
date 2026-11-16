import path from 'node:path';
import { okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { config } from './config.js';
import { createHydraOpenCypherClient, scrubSensitiveStrings } from './connectors/hydradb-client.js';
import { FINTECH_BENCHMARK_CORPUS, BENCHMARK_SCENARIOS } from './corpus/fintech-fixture.js';
import { compileArtifactsToGraph, compileDirectoryToGraph } from './engines/repo-compiler.js';
import {
    checkAnswerable as runAnswerabilityCheck,
    traverseStructuralContext,
    supersedeDecisionInGraph
} from './engines/structural-retriever.js';
import {
    buildVectorIndex,
    compareQueryHeadToHead,
    runBenchmarkSuite
} from './engines/vector-benchmark.js';
import {
    runAgentContextContinualEval,
    runHydraLoadBenchmark
} from './engines/agent-context-layer.js';

export async function createHydraScopeRuntime(options = {}) {
    const preferOllama = options.preferOllama !== false;
    const hydraClient =
        options.hydraClient ||
        createHydraOpenCypherClient({
            baseUrl: options.hydraUrl ?? config.hydraUrl,
            token: options.hydraToken ?? config.hydraToken,
            graphId: options.hydraGraphId ?? config.hydraGraphId,
            cellId: options.hydraCellId ?? config.hydraCellId,
            namespace: options.hydraNamespace ?? config.hydraNamespace,
            allowPrivateLan: options.hydraAllowLan ?? config.hydraAllowLan,
            allowTailscale: options.hydraAllowTailscale ?? config.hydraAllowTailscale,
            timeoutMs: options.timeoutMs ?? 2500
        });

    let activeGraph = compileArtifactsToGraph(FINTECH_BENCHMARK_CORPUS, {
        workspaceName: 'fintech-core'
    });
    let activeScenarios = BENCHMARK_SCENARIOS.slice();

    let lastSync = { liveSynced: false, mode: 'embedded_graph_fallback' };
    if (hydraClient.isConfigured()) {
        const syncRes = await hydraClient.syncGraphSnapshot({
            nodes: activeGraph.nodes,
            edges: activeGraph.edges
        });
        if (syncRes.ok) {
            lastSync = syncRes.data;
        }
    }

    let vectorIndex = await buildVectorIndex(activeGraph, {
        preferOllama,
        ollamaHost: options.ollamaEmbedHost ?? config.ollamaEmbedHost,
        model: options.embedModel ?? config.embedModel
    });

    async function getState() {
        const healthRes = await hydraClient.healthz();
        const hydraHealth = healthRes.ok
            ? healthRes.data
            : {
                  configured: hydraClient.isConfigured(),
                  healthy: false,
                  mode: 'embedded_graph_fallback',
                  graphId: config.hydraGraphId,
                  latencyMs: 0
              };

        const decisions = activeGraph.nodes
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

        return okEnvelope(
            'hydrascope.state',
            `Loaded ${activeGraph.workspaceName} (${activeGraph.nodes.length} nodes, ${activeGraph.edges.length} edges).`,
            {
                workspaceName: activeGraph.workspaceName,
                totalRepoTokens: activeGraph.totalRepoTokens,
                nodeCount: activeGraph.nodes.length,
                edgeCount: activeGraph.edges.length,
                embeddingBackend: vectorIndex.embeddingBackend,
                hydraHealth: scrubSensitiveStrings(hydraHealth),
                lastSync: scrubSensitiveStrings(lastSync),
                scenarios: activeScenarios.map((s) => ({
                    id: s.id,
                    category: s.category,
                    title: s.title,
                    query: s.query,
                    asOf: s.asOf || null,
                    tokenBudget: s.tokenBudget,
                    explanation: s.explanation
                })),
                decisions,
                nodes: activeGraph.nodes.map((n) => ({
                    id: n.id,
                    kind: n.kind,
                    title: n.title,
                    path: n.path,
                    tokens: n.tokens,
                    isCurrent: n.isCurrent,
                    retiredAt: n.retiredAt,
                    supersededBy: n.supersededBy
                })),
                edges: activeGraph.edges
            }
        );
    }

    function checkAnswerable(query) {
        return runAnswerabilityCheck(activeGraph, query);
    }

    async function traverse({ query, asOf = null, tokenBudget = 900, maxHops = 3 } = {}) {
        const res = await traverseStructuralContext(activeGraph, {
            query,
            asOf,
            tokenBudget,
            maxHops,
            hydraClient
        });
        return scrubSensitiveStrings(res);
    }

    async function compare({ query, asOf = null, tokenBudget = 900, topK = 4 } = {}) {
        const res = await compareQueryHeadToHead({
            graph: activeGraph,
            vectorIndex,
            hydraClient,
            query,
            asOf,
            tokenBudget,
            topK
        });
        return scrubSensitiveStrings(res);
    }

    async function runBenchmark() {
        const res = await runBenchmarkSuite({
            graph: activeGraph,
            vectorIndex,
            hydraClient,
            scenarios: activeScenarios
        });
        return scrubSensitiveStrings(res);
    }

    async function runContinualEval() {
        const res = await runAgentContextContinualEval({
            hydraClient,
            preferOllama,
            ollamaHost: options.ollamaEmbedHost ?? config.ollamaEmbedHost,
            model: options.embedModel ?? config.embedModel
        });
        return scrubSensitiveStrings(res);
    }

    async function runLoadTest({ totalRequests = 64, concurrency = 8 } = {}) {
        const res = await runHydraLoadBenchmark({
            hydraClient,
            totalRequests,
            concurrency
        });
        return scrubSensitiveStrings(res);
    }

    async function supersedeDecision({
        oldId,
        newId,
        title,
        content,
        governsIds = [],
        effectiveAt
    } = {}) {
        const res = await supersedeDecisionInGraph(activeGraph, {
            oldId,
            newId,
            title,
            content,
            governsIds,
            effectiveAt,
            hydraClient
        });
        if (!res.ok) return scrubSensitiveStrings(res);

        vectorIndex = await buildVectorIndex(activeGraph, {
            preferOllama,
            ollamaHost: options.ollamaEmbedHost ?? config.ollamaEmbedHost,
            model: options.embedModel ?? config.embedModel
        });
        return scrubSensitiveStrings(res);
    }

    async function ingestDirectory(targetDir) {
        if (!targetDir || String(targetDir).trim() === 'reset') {
            activeGraph = compileArtifactsToGraph(FINTECH_BENCHMARK_CORPUS, {
                workspaceName: 'fintech-core'
            });
            activeScenarios = BENCHMARK_SCENARIOS.slice();
            if (hydraClient.isConfigured()) {
                await hydraClient.syncGraphSnapshot({
                    nodes: activeGraph.nodes,
                    edges: activeGraph.edges
                });
            }
            vectorIndex = await buildVectorIndex(activeGraph, {
                preferOllama,
                ollamaHost: options.ollamaEmbedHost ?? config.ollamaEmbedHost,
                model: options.embedModel ?? config.embedModel
            });
            return okEnvelope('hydrascope.ingest_dir', 'Reset workspace to 18-artifact FinTech benchmark graph.', {
                workspaceName: activeGraph.workspaceName,
                nodeCount: activeGraph.nodes.length,
                edgeCount: activeGraph.edges.length,
                totalRepoTokens: activeGraph.totalRepoTokens
            });
        }

        const resolved = path.resolve(String(targetDir).trim());
        const compiled = compileDirectoryToGraph(resolved);
        if (!compiled.ok) {
            return scrubSensitiveStrings(compiled);
        }

        activeGraph = compiled.data;
        if (hydraClient.isConfigured()) {
            await hydraClient.syncGraphSnapshot({
                nodes: activeGraph.nodes,
                edges: activeGraph.edges
            });
        }
        vectorIndex = await buildVectorIndex(activeGraph, {
            preferOllama,
            ollamaHost: options.ollamaEmbedHost ?? config.ollamaEmbedHost,
            model: options.embedModel ?? config.embedModel
        });

        return okEnvelope(
            'hydrascope.ingest_dir',
            `Compiled ${activeGraph.nodes.length} nodes and ${activeGraph.edges.length} structural edges into HydraDB.`,
            {
                workspaceName: activeGraph.workspaceName,
                nodeCount: activeGraph.nodes.length,
                edgeCount: activeGraph.edges.length,
                totalRepoTokens: activeGraph.totalRepoTokens
            }
        );
    }

    return Object.freeze({
        getGraph: () => activeGraph,
        getState,
        checkAnswerable,
        traverse,
        compare,
        runBenchmark,
        runContinualEval,
        runLoadTest,
        supersedeDecision,
        ingestDirectory
    });
}
