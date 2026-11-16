import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    surrogateVertexId,
    decodeHydraCell,
    decodeHydraQueryResult,
    scrubSensitiveStrings,
    createHydraOpenCypherClient
} from '../src/connectors/hydradb-client.js';
import { FINTECH_BENCHMARK_CORPUS, BENCHMARK_SCENARIOS } from '../src/corpus/fintech-fixture.js';
import { compileArtifactsToGraph, compileDirectoryToGraph } from '../src/engines/repo-compiler.js';
import {
    checkAnswerable,
    traverseStructuralContext,
    supersedeDecisionInGraph
} from '../src/engines/structural-retriever.js';
import {
    buildVectorIndex,
    compareQueryHeadToHead,
    runBenchmarkSuite
} from '../src/engines/vector-benchmark.js';
import {
    buildAgentToolCatalog,
    runAgentContextContinualEval
} from '../src/engines/agent-context-layer.js';
import { HYDRASCOPE_MCP_TOOLS, createHydraScopeMcp } from '../src/mcp/hydrascope-mcp.js';
import { buildServer } from '../src/server.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(THIS_DIR, '..');

test('HydraDB v0.4.0 surrogate keys, typed cell decoder, and zero-leak scrubber', () => {
    const idA = surrogateVertexId('default', 'file:src/billing/fee-engine.ts');
    const idB = surrogateVertexId('default', 'file:src/billing/fee-engine.ts');
    const idC = surrogateVertexId('default', 'file:src/compliance/sox-reconciler.ts');

    assert.equal(idA, idB);
    assert.notEqual(idA, idC);
    assert.ok(Number.isSafeInteger(idA) && idA >= 1000 && idA <= Number.MAX_SAFE_INTEGER);

    assert.equal(decodeHydraCell({ type: 'string', value: 'alpha' }), 'alpha');
    assert.equal(decodeHydraCell({ type: 'null' }), null);

    const decoded = decodeHydraQueryResult({
        query_id: 'q-1',
        columns: ['src', 'dst'],
        rows: [[{ type: 'string', value: 'a' }, { type: 'int', value: 42 }]],
        read_epoch: 12,
        bookmark: 'sgk:1:test:12'
    });
    assert.equal(decoded.readEpoch, 12);
    assert.equal(decoded.records[0].src, 'a');
    assert.equal(decoded.records[0].dst, 42);

    const sampleTailscaleHost = ['100', '100', '42', '10'].join('.');
    const sampleUserDir = ['', 'home', 'alice', 'app'].join('/');
    const sampleSecret = ['hdb', 'scope', 'secret1234567890'].join('_');
    const scrubbed = scrubSensitiveStrings({
        msg: `Failed on http://${sampleTailscaleHost}:18445 with Bearer ${sampleSecret} at ${sampleUserDir}`,
        token: sampleSecret
    });
    assert.ok(!JSON.stringify(scrubbed).includes(sampleTailscaleHost));
    assert.ok(!JSON.stringify(scrubbed).includes(sampleSecret));
    assert.ok(!JSON.stringify(scrubbed).includes(sampleUserDir));
});

test('AST & temporal ADR graph compiler + pre-flight ontology answerability gate', () => {
    const graph = compileArtifactsToGraph(FINTECH_BENCHMARK_CORPUS);
    assert.equal(graph.nodes.length, 18);
    assert.ok(graph.edges.length >= 14);
    assert.ok(graph.totalRepoTokens >= 4500);

    const adr003 = graph.nodes.find((n) => n.id === 'adr:ADR-003');
    const adr014 = graph.nodes.find((n) => n.id === 'adr:ADR-014');
    assert.equal(adr003.isCurrent, false);
    assert.equal(adr003.supersededBy, 'adr:ADR-014');
    assert.equal(adr014.isCurrent, true);

    const grounded = checkAnswerable(graph, 'Update partner fee rounding in calculatePartnerFee');
    assert.equal(grounded.ok, true);
    assert.equal(grounded.data.answerable, true);

    const trap = checkAnswerable(graph, 'What is the Kafka consumer group lag threshold for calculatePartnerFee?');
    assert.equal(trap.ok, true);
    assert.equal(trap.data.answerable, false);
    assert.ok(trap.data.missingTerms.includes('kafka'));
});

test('Structural traversal: 2-hop blast radius, SUPERSEDES filtering, and asOf time-travel', async () => {
    const graph = compileArtifactsToGraph(FINTECH_BENCHMARK_CORPUS);

    // 1. 2-hop blast radius reaches zero-lexical-overlap sox-reconciler + INV-FIN-03
    const s1 = await traverseStructuralContext(graph, {
        query: 'Update per-item partner fee rounding in calculatePartnerFee without breaking downstream accounting',
        tokenBudget: 900
    });
    assert.equal(s1.ok, true);
    const s1Ids = new Set(s1.data.traversedNodes.map((n) => n.id));
    assert.ok(s1Ids.has('file:src/billing/fee-engine.ts'));
    assert.ok(s1Ids.has('file:src/billing/settlement-batch.ts'));
    assert.ok(s1Ids.has('file:src/compliance/sox-reconciler.ts'));
    assert.ok(s1Ids.has('inv:INV-FIN-03'));

    // 2. HEAD query blocks retired ADR-003 and surfaces active ADR-014
    const s3Head = await traverseStructuralContext(graph, {
        query: 'How should I verify stripe webhook signature headers and replay window?',
        tokenBudget: 850
    });
    const s3HeadIds = new Set(s3Head.data.traversedNodes.map((n) => n.id));
    assert.ok(s3HeadIds.has('adr:ADR-014'));
    assert.ok(!s3HeadIds.has('adr:ADR-003'));
    assert.ok(s3Head.data.retiredBlockedNodes.some((n) => n.id === 'adr:ADR-003'));

    // 3. Historical asOf='2026-03-01' replays ADR-003 before ADR-014 existed!
    const s3Past = await traverseStructuralContext(graph, {
        query: 'How should I verify stripe webhook signature headers and replay window?',
        asOf: '2026-03-01',
        tokenBudget: 850
    });
    const s3PastIds = new Set(s3Past.data.traversedNodes.map((n) => n.id));
    assert.ok(s3PastIds.has('adr:ADR-003'));
    assert.ok(!s3PastIds.has('adr:ADR-014'));
});

test('8-scenario Proof-Over-Vectors benchmark suite beats Dense Vector Top-K', async () => {
    const graph = compileArtifactsToGraph(FINTECH_BENCHMARK_CORPUS);
    const vectorIndex = await buildVectorIndex(graph, { preferOllama: false });
    const bench = await runBenchmarkSuite({
        graph,
        vectorIndex,
        scenarios: BENCHMARK_SCENARIOS
    });

    assert.equal(bench.ok, true);
    assert.equal(bench.data.arms.hydraScope.passRatePct, 100);
    assert.equal(bench.data.arms.hydraScope.criticalRecallPct, 100);
    assert.equal(bench.data.arms.hydraScope.temporalPoisoningPct, 0);
    assert.equal(bench.data.arms.hydraScope.trapBlockPct, 100);
    assert.ok(bench.data.arms.hydraScope.passRatePct > bench.data.arms.vectorTopK.passRatePct);
    assert.ok(bench.data.arms.vectorTopK.temporalPoisoningPct > 0);
});

test('Track 2 64-MCP-tool + Resolved-Entities continual learning improves monotonically over 4 epochs', async () => {
    const catalog = buildAgentToolCatalog();
    assert.equal(catalog.tools.length, 64);
    assert.equal(catalog.servers.length, 8);

    const evalRes = await runAgentContextContinualEval({
        hydraClient: createHydraOpenCypherClient({ baseUrl: '' }),
        preferOllama: false
    });
    assert.equal(evalRes.ok, true);
    const { epochs, baselines } = evalRes.data;
    assert.equal(epochs.length, 4);
    assert.ok(epochs[3].toolF1Pct > epochs[0].toolF1Pct);
    assert.equal(epochs[3].toolF1Pct, 100);
    assert.equal(epochs[3].singleTurnAccuracyPct, 100);
    assert.ok(epochs[3].meanRoundTrips < epochs[0].meanRoundTrips);
    assert.ok(epochs[3].meanRoundTrips < baselines.vectorTopK.meanRoundTrips);
    assert.ok(epochs[3].tokenSavingsVsPreloadPct > 90);
});

test('MCP server exposes 6 strict tools with 4-boolean annotations and HTTP API serves full lifecycle', async (t) => {
    assert.equal(HYDRASCOPE_MCP_TOOLS.length, 6);
    for (const tool of HYDRASCOPE_MCP_TOOLS) {
        assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
        assert.equal(typeof tool.annotations?.destructiveHint, 'boolean');
        assert.equal(typeof tool.annotations?.idempotentHint, 'boolean');
        assert.equal(typeof tool.annotations?.openWorldHint, 'boolean');
    }

    const { server, runtime, close } = await buildServer({
        dbPath: ':memory:',
        runtimeOptions: { preferOllama: false, hydraUrl: '' }
    });
    const mcp = await createHydraScopeMcp({ runtime, connect: false });
    assert.ok(mcp);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        close();
    });

    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const stateRes = await fetch(`${base}/api/state`);
    assert.equal(stateRes.status, 200);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.ok, true);
    assert.equal(stateJson.data.nodeCount, 18);

    const cmpRes = await fetch(`${base}/api/arena/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'Update partner fee rounding in calculatePartnerFee' })
    });
    assert.equal(cmpRes.status, 200);
    const cmpJson = await cmpRes.json();
    assert.equal(cmpJson.ok, true);
    assert.ok(Array.isArray(cmpJson.data.hydra.traversedNodes));

    const contRes = await fetch(`${base}/api/continual/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    assert.equal(contRes.status, 200);
    const contJson = await contRes.json();
    assert.equal(contJson.ok, true);
    assert.equal(contJson.data.epochs.length, 4);

    const supRes = await fetch(`${base}/api/decisions/supersede`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            oldId: 'adr:ADR-014',
            newId: 'adr:ADR-025',
            title: 'ADR-025: Ed25519 + HMAC Dual Envelope Attestation',
            content: 'Require dual Ed25519 detached signature and HMAC-SHA256 raw-body verification.',
            governsIds: ['file:src/webhooks/stripe-handler.ts'],
            effectiveAt: '2026-11-15'
        })
    });
    assert.equal(supRes.status, 200);
    const supJson = await supRes.json();
    assert.equal(supJson.ok, true);

    const dirCompiled = compileDirectoryToGraph(path.join(PROJECT_ROOT, 'src'));
    assert.equal(dirCompiled.ok, true);
    assert.ok(dirCompiled.data.nodes.length >= 4);
});
