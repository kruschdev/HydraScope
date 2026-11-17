import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedBatch } from '@krusch/toolkit/embeddings';
import { config } from '../src/config.js';
import { FINTECH_BENCHMARK_CORPUS, BENCHMARK_SCENARIOS } from '../src/corpus/fintech-fixture.js';
import { compileArtifactsToGraph, compileDirectoryToGraph } from '../src/engines/repo-compiler.js';
import { formatNodeChunkText } from '../src/engines/vector-benchmark.js';
import { createHydraScopeRuntime } from '../src/runtime.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = path.join(ROOT_DIR, 'src', 'edge', 'generated-edge-snapshot.json');
const DIST_WORKER_PATH = path.join(ROOT_DIR, 'client', 'dist', '_worker.js');

function roundVec(vec) {
    return vec.map((v) => Number(Number(v).toFixed(5)));
}

const fintechGraph = compileArtifactsToGraph(FINTECH_BENCHMARK_CORPUS, { workspaceName: 'fintech-core' });
const selfSrcCompiled = compileDirectoryToGraph(path.join(ROOT_DIR, 'src'), { workspaceName: 'hydrascope-src' });
const selfSrcGraph = selfSrcCompiled.ok ? selfSrcCompiled.data : fintechGraph;

let fintechVectors1024 = null;
const queryVectors1024 = Object.create(null);

try {
    const texts = fintechGraph.nodes.map((n) => formatNodeChunkText(n));
    const vecs = await embedBatch(texts, {
        host: config.ollamaEmbedHost,
        model: config.embedModel,
        mode: 'document',
        timeoutMs: 3000
    });
    if (Array.isArray(vecs) && vecs.length === texts.length) {
        fintechVectors1024 = vecs.map(roundVec);
    }

    const qTexts = BENCHMARK_SCENARIOS.map((s) => s.query);
    const qVecs = await embedBatch(qTexts, {
        host: config.ollamaEmbedHost,
        model: config.embedModel,
        mode: 'query',
        timeoutMs: 3000
    });
    if (Array.isArray(qVecs) && qVecs.length === qTexts.length) {
        qTexts.forEach((q, idx) => {
            queryVectors1024[q] = roundVec(qVecs[idx]);
        });
    }
} catch {
    fintechVectors1024 = null;
}

const runtime = await createHydraScopeRuntime();
const benchmarkResult = await runtime.runBenchmark();
const continualResult = await runtime.runContinualEval();
const loadResult = await runtime.runLoadTest({ totalRequests: 64, concurrency: 8 });
const selfGraphStatus = await runtime.selfGraphStatus();
const selfGraphSample = await runtime.selfGraphRetrieve({
    query: 'Update per-item partner fee rounding in calculatePartnerFee',
    strategy: 'ppr',
    budgetTokens: 900
});
await runtime.closeSelfGraph();

const snapshot = {
    capturedAt: new Date().toISOString(),
    initialEpoch: loadResult?.data?.lastReadEpoch || continualResult?.data?.lastReadEpoch || 789,
    fintechGraph,
    selfSrcGraph,
    fintechVectors1024,
    queryVectors1024,
    benchmarkResult,
    continualResult,
    loadResult: loadResult.ok ? loadResult : null,
    selfGraphStatus: selfGraphStatus.ok ? selfGraphStatus.data : null,
    selfGraphSample: selfGraphSample.ok ? selfGraphSample.data : null
};

fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot));

const esbuildMod = await import(path.join(ROOT_DIR, 'client', 'node_modules', 'esbuild', 'lib', 'main.js'));
const esbuild = esbuildMod.default || esbuildMod;

await esbuild.build({
    entryPoints: [path.join(ROOT_DIR, 'src', 'edge', 'edge-worker.js')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    outfile: DIST_WORKER_PATH,
    alias: {
        '@krusch/toolkit/http': path.join(ROOT_DIR, 'src', 'edge', 'edge-shims-http.js'),
        '@krusch/toolkit/embeddings': path.join(ROOT_DIR, 'src', 'edge', 'edge-shims-embeddings.js')
    },
    plugins: [
        {
            name: 'hydradb-edge-shim',
            setup(build) {
                build.onResolve({ filter: /hydradb-client\.js$/ }, () => ({
                    path: path.join(ROOT_DIR, 'src', 'edge', 'edge-shims-hydradb.js')
                }));
            }
        }
    ]
});

console.log(`Built ${DIST_WORKER_PATH} (${fs.statSync(DIST_WORKER_PATH).size} bytes)`);
