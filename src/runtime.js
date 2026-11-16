import fs from 'node:fs';
import path from 'node:path';
import { okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { config } from './config.js';
import { createHydraOpenCypherClient } from './connectors/hydradb-client.js';
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
import { scrubSensitiveStrings } from './utils/scrubber.js';
import { buildDynamicScenariosForGraph } from './utils/validation.js';

export async function createHydraScopeRuntime(options = {}) {
    const preferOllama = options.preferOllama !== false;
    const projectRoot = options.projectRoot || config.projectRoot;
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

    // Serialize graph mutations (`supersedeDecision`, `ingestDirectory`) so concurrent requests never tear state.
    let mutationChain = Promise.resolve();
    function withMutationLock(fn) {
        const next = mutationChain.then(fn, fn);
        mutationChain = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }

    async function getState() {
        const graphSnap = activeGraph;
        const scenariosSnap = activeScenarios;
        const vecSnap = vectorIndex;

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
            embeddingBackend: vecSnap.embeddingBackend,
            hydraHealth,
            lastSync,
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

        return okEnvelope(
            'hydrascope.state',
            `Loaded ${graphSnap.workspaceName} (${graphSnap.nodes.length} nodes, ${graphSnap.edges.length} edges).`,
            payload
        );
    }

    function checkAnswerable(query) {
        return scrubSensitiveStrings(runAnswerabilityCheck(activeGraph, query));
    }

    async function traverse({ query, asOf = null, tokenBudget = 900, maxHops = 3 } = {}) {
        const graphSnap = activeGraph;
        const res = await traverseStructuralContext(graphSnap, {
            query,
            asOf,
            tokenBudget,
            maxHops,
            hydraClient
        });
        return scrubSensitiveStrings(res);
    }

    async function compare({ query, asOf = null, tokenBudget = 900, topK = 4 } = {}) {
        const graphSnap = activeGraph;
        const vecSnap = vectorIndex;
        const res = await compareQueryHeadToHead({
            graph: graphSnap,
            vectorIndex: vecSnap,
            hydraClient,
            query,
            asOf,
            tokenBudget,
            topK
        });
        return scrubSensitiveStrings(res);
    }

    async function runBenchmark() {
        const graphSnap = activeGraph;
        const vecSnap = vectorIndex;
        const scenariosSnap = activeScenarios;
        const res = await runBenchmarkSuite({
            graph: graphSnap,
            vectorIndex: vecSnap,
            hydraClient,
            scenarios: scenariosSnap
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

    function supersedeDecision({
        oldId,
        newId,
        title,
        content,
        governsIds = [],
        effectiveAt
    } = {}) {
        return withMutationLock(async () => {
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
        });
    }

    function ingestDirectory(targetDir, { allowExternalPaths = false } = {}) {
        return withMutationLock(async () => {
            const cleanTarget = String(targetDir || '').trim();
            if (!cleanTarget || cleanTarget === 'reset') {
                const nextGraph = compileArtifactsToGraph(FINTECH_BENCHMARK_CORPUS, {
                    workspaceName: 'fintech-core'
                });
                const nextScenarios = BENCHMARK_SCENARIOS.slice();
                if (hydraClient.isConfigured()) {
                    const syncRes = await hydraClient.syncGraphSnapshot({
                        nodes: nextGraph.nodes,
                        edges: nextGraph.edges
                    });
                    if (syncRes.ok) lastSync = syncRes.data;
                }
                const nextVectorIndex = await buildVectorIndex(nextGraph, {
                    preferOllama,
                    ollamaHost: options.ollamaEmbedHost ?? config.ollamaEmbedHost,
                    model: options.embedModel ?? config.embedModel
                });
                activeGraph = nextGraph;
                activeScenarios = nextScenarios;
                vectorIndex = nextVectorIndex;

                return okEnvelope('hydrascope.ingest_dir', 'Reset workspace to 18-artifact FinTech benchmark graph.', {
                    workspaceName: activeGraph.workspaceName,
                    nodeCount: activeGraph.nodes.length,
                    edgeCount: activeGraph.edges.length,
                    totalRepoTokens: activeGraph.totalRepoTokens
                });
            }

            const candidatePath = path.resolve(projectRoot, cleanTarget);
            if (
                !allowExternalPaths &&
                candidatePath !== projectRoot &&
                !candidatePath.startsWith(projectRoot + path.sep)
            ) {
                return errorEnvelope(
                    'PATH_OUTSIDE_WORKSPACE',
                    'HTTP directory compilation is restricted to paths within the project workspace (e.g. "." or "./src"). Use the local CLI (`hydrascope ingest <dir>`) for external paths.',
                    null,
                    'hydrascope.ingest_dir'
                );
            }

            let lstat;
            try {
                lstat = fs.lstatSync(candidatePath);
            } catch {
                return errorEnvelope(
                    'DIRECTORY_NOT_FOUND',
                    'Target directory does not exist or cannot be accessed.',
                    null,
                    'hydrascope.ingest_dir'
                );
            }

            if (!allowExternalPaths && lstat.isSymbolicLink()) {
                return errorEnvelope(
                    'PATH_OUTSIDE_WORKSPACE',
                    'Symbolic link directories outside workspace containment are rejected.',
                    null,
                    'hydrascope.ingest_dir'
                );
            }

            let realRoot;
            let realTarget;
            try {
                realRoot = fs.realpathSync(projectRoot);
                realTarget = fs.realpathSync(candidatePath);
            } catch {
                return errorEnvelope(
                    'DIRECTORY_NOT_FOUND',
                    'Target directory does not exist or cannot be accessed.',
                    null,
                    'hydrascope.ingest_dir'
                );
            }

            if (
                !allowExternalPaths &&
                realTarget !== realRoot &&
                !realTarget.startsWith(realRoot + path.sep)
            ) {
                return errorEnvelope(
                    'PATH_OUTSIDE_WORKSPACE',
                    'Directory resolves via symlink outside the project workspace.',
                    null,
                    'hydrascope.ingest_dir'
                );
            }

            const compiled = compileDirectoryToGraph(realTarget, {
                rejectSymlinkRoot: !allowExternalPaths
            });
            if (!compiled.ok) {
                return scrubSensitiveStrings(compiled);
            }

            const nextGraph = compiled.data;
            const nextScenarios =
                nextGraph.workspaceName === 'fintech-core'
                    ? BENCHMARK_SCENARIOS.slice()
                    : buildDynamicScenariosForGraph(nextGraph);

            if (hydraClient.isConfigured()) {
                const syncRes = await hydraClient.syncGraphSnapshot({
                    nodes: nextGraph.nodes,
                    edges: nextGraph.edges
                });
                if (syncRes.ok) lastSync = syncRes.data;
            }
            const nextVectorIndex = await buildVectorIndex(nextGraph, {
                preferOllama,
                ollamaHost: options.ollamaEmbedHost ?? config.ollamaEmbedHost,
                model: options.embedModel ?? config.embedModel
            });

            activeGraph = nextGraph;
            activeScenarios = nextScenarios;
            vectorIndex = nextVectorIndex;

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
        });
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
