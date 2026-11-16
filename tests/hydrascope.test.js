import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
import { createHydraScopeRuntime } from '../src/runtime.js';
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
    const sampleRootDir = ['', 'root', 'deploy', 'key'].join('/');
    const sampleSecret = ['hdb', 'scope', 'secret1234567890'].join('_');
    const samplePat = ['github', 'pat', '11ABCDEF0123456789'].join('_');
    const sampleUla = ['fd12', '3456', '789a', '1', '1'].join(':');

    const scrubbed = scrubSensitiveStrings({
        msg: `Failed on http://${sampleTailscaleHost}:18445 and [${sampleUla}]:8443 with Bearer ${sampleSecret} (${samplePat}) at ${sampleUserDir} and ${sampleRootDir}`,
        hydraToken: sampleSecret,
        webhookSecret: sampleSecret
    });
    const serialized = JSON.stringify(scrubbed);
    assert.ok(!serialized.includes(sampleTailscaleHost));
    assert.ok(!serialized.includes(sampleSecret));
    assert.ok(!serialized.includes(samplePat));
    assert.ok(!serialized.includes(sampleUserDir));
    assert.ok(!serialized.includes(sampleRootDir));
    assert.ok(!serialized.includes(sampleUla));
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

test('Structural traversal, compareQueryHeadToHead, and strict ISO date validation', async () => {
    const graph = compileArtifactsToGraph(FINTECH_BENCHMARK_CORPUS);
    const vectorIndex = await buildVectorIndex(graph, { preferOllama: false });

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

    // 2. Head-to-head comparator catches retired ADR-003 at HEAD vs valid at historical asOf
    const cmpHead = await compareQueryHeadToHead({
        graph,
        vectorIndex,
        query: 'How should I verify stripe webhook signature headers and replay window?',
        tokenBudget: 850,
        topK: 5
    });
    assert.equal(cmpHead.ok, true);
    const headHydraIds = new Set(cmpHead.data.hydra.traversedNodes.map((n) => n.id));
    assert.ok(headHydraIds.has('adr:ADR-014'));
    assert.ok(!headHydraIds.has('adr:ADR-003'));
    assert.ok(cmpHead.data.hydra.retiredBlockedNodes.some((n) => n.id === 'adr:ADR-003'));

    const cmpPast = await compareQueryHeadToHead({
        graph,
        vectorIndex,
        query: 'How should I verify stripe webhook signature headers and replay window?',
        asOf: '2026-03-01',
        tokenBudget: 850,
        topK: 5
    });
    assert.equal(cmpPast.ok, true);
    const pastHydraIds = new Set(cmpPast.data.hydra.traversedNodes.map((n) => n.id));
    assert.ok(pastHydraIds.has('adr:ADR-003'));
    assert.ok(!pastHydraIds.has('adr:ADR-014'));
    assert.ok(!cmpPast.data.vectorPoisonedNodes.some((n) => n.id === 'adr:ADR-003'));

    // 3. Reject malformed or impossible calendar dates (`SEC-04`)
    const badSlashDate = await traverseStructuralContext(graph, {
        query: 'How should I verify stripe webhook signature headers?',
        asOf: '03/01/2026'
    });
    assert.equal(badSlashDate.ok, false);
    assert.equal(badSlashDate.error.code, 'INVALID_DATE');

    const badFeb31 = await traverseStructuralContext(graph, {
        query: 'How should I verify stripe webhook signature headers?',
        asOf: '2026-02-31'
    });
    assert.equal(badFeb31.ok, false);
    assert.equal(badFeb31.error.code, 'INVALID_DATE');
});

test('SEC-01 & temporal integrity: supersedeDecisionInGraph blocks prototype pollution, "length" crash, retired targets, and duplicates', async () => {
    const graph = compileArtifactsToGraph(FINTECH_BENCHMARK_CORPUS);

    // 1. Prototype-key injection attempt must be rejected before mutating graph
    const protoAttempt = await supersedeDecisionInGraph(graph, {
        oldId: 'adr:ADR-014',
        newId: 'adr:__proto__',
        title: 'Prototype test',
        content: 'Should be rejected cleanly.',
        effectiveAt: '2026-11-15'
    });
    assert.equal(protoAttempt.ok, false);
    assert.equal(protoAttempt.error.code, 'INVALID_NODE_ID');
    assert.equal(Array.prototype.length, 0);
    assert.equal(graph.nodes.find((n) => n.id === 'adr:ADR-014').isCurrent, true);

    // 2. Superseding an already-retired ADR (`ADR-003`) must fail cleanly
    const retiredAttempt = await supersedeDecisionInGraph(graph, {
        oldId: 'adr:ADR-003',
        newId: 'adr:ADR-099',
        title: 'Cannot supersede retired ADR',
        content: 'Should fail because ADR-003 is already retired by ADR-014.',
        effectiveAt: '2026-11-15'
    });
    assert.equal(retiredAttempt.ok, false);
    assert.equal(retiredAttempt.error.code, 'DECISION_ALREADY_RETIRED');

    // 3. Content containing Array method/property names ("length", "push", "sort", "constructor") must succeed cleanly!
    const validSup = await supersedeDecisionInGraph(graph, {
        oldId: 'adr:ADR-014',
        newId: 'adr:ADR-025',
        title: 'ADR-025: Minimum Key Length and Constructor Bounds',
        content: 'Minimum HMAC key length is 32 bytes; push, sort, includes, and constructor words must never corrupt ontology terms.',
        governsIds: ['file:src/webhooks/stripe-handler.ts'],
        effectiveAt: '2026-11-15'
    });
    assert.equal(validSup.ok, true);
    assert.equal(Array.prototype.length, 0);
    assert.equal(graph.nodes.find((n) => n.id === 'adr:ADR-014').isCurrent, false);
    assert.equal(graph.nodes.find((n) => n.id === 'adr:ADR-025').isCurrent, true);

    // 4. Duplicate newId (`ADR-025` without prefix) must fail with DUPLICATE_DECISION_ID
    const dupAttempt = await supersedeDecisionInGraph(graph, {
        oldId: 'adr:ADR-025',
        newId: 'ADR-025',
        title: 'Duplicate ID check',
        content: 'Must be rejected.',
        effectiveAt: '2026-11-15'
    });
    assert.equal(dupAttempt.ok, false);
    assert.equal(dupAttempt.error.code, 'DUPLICATE_DECISION_ID');
});

test('SEC-03: runtime.ingestDirectory blocks symlink containment escape outside workspace', async (t) => {
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ws-'));
    const tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ext-'));
    t.after(() => {
        fs.rmSync(tmpWorkspace, { recursive: true, force: true });
        fs.rmSync(tmpOutside, { recursive: true, force: true });
    });

    fs.writeFileSync(path.join(tmpOutside, 'secret-mod.js'), 'export const outside = 1;\n');
    fs.symlinkSync(tmpOutside, path.join(tmpWorkspace, 'escaped-link'), 'dir');

    const runtime = await createHydraScopeRuntime({
        projectRoot: tmpWorkspace,
        preferOllama: false,
        hydraUrl: ''
    });

    const escapeRes = await runtime.ingestDirectory('./escaped-link');
    assert.equal(escapeRes.ok, false);
    assert.equal(escapeRes.error.code, 'PATH_OUTSIDE_WORKSPACE');
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

test('MCP server & hardened HTTP lifecycle: workspace compile/reset, date guard, Bearer auth, and rate limits', async (t) => {
    assert.equal(HYDRASCOPE_MCP_TOOLS.length, 6);
    for (const tool of HYDRASCOPE_MCP_TOOLS) {
        assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
        assert.equal(typeof tool.annotations?.destructiveHint, 'boolean');
        assert.equal(typeof tool.annotations?.idempotentHint, 'boolean');
        assert.equal(typeof tool.annotations?.openWorldHint, 'boolean');
    }

    const adminSecret = 'hs-unit-test-bearer-secret';
    const { server, runtime, close } = await buildServer({
        dbPath: ':memory:',
        adminToken: adminSecret,
        mutationRateLimitMax: 5,
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
    const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSecret}`
    };

    const stateRes = await fetch(`${base}/api/state`);
    assert.equal(stateRes.status, 200);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.ok, true);
    assert.equal(stateJson.data.nodeCount, 18);

    // Invalid asOf date returns 400
    const badCmp = await fetch(`${base}/api/arena/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'Update calculatePartnerFee', asOf: 'not-a-date' })
    });
    assert.equal(badCmp.status, 400);

    // Unauthenticated mutation is rejected with 401 when adminToken is configured
    const unauthSup = await fetch(`${base}/api/decisions/supersede`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            oldId: 'adr:ADR-014',
            newId: 'adr:ADR-025',
            title: 'ADR-025',
            content: 'Requires Bearer auth.'
        })
    });
    assert.equal(unauthSup.status, 401);

    // Authenticated supersede succeeds with "length" in content
    const supRes = await fetch(`${base}/api/decisions/supersede`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
            oldId: 'adr:ADR-014',
            newId: 'adr:ADR-025',
            title: 'ADR-025: Ed25519 + HMAC Key Length Policy',
            content: 'Require dual Ed25519 detached signature and 32-byte HMAC key length.',
            governsIds: ['file:src/webhooks/stripe-handler.ts'],
            effectiveAt: '2026-11-15'
        })
    });
    assert.equal(supRes.status, 200);

    // Compile ./src switches workspace and synthesizes dynamic scenarios (`UX-02`)
    const compileRes = await fetch(`${base}/api/workspace/ingest-dir`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ targetDir: './src' })
    });
    assert.equal(compileRes.status, 200);
    const srcState = await (await fetch(`${base}/api/state`)).json();
    assert.equal(srcState.data.workspaceName, 'src');
    assert.ok(srcState.data.scenarios.length >= 2);
    assert.ok(srcState.data.scenarios[0].id.startsWith('DYN-'));

    // Reset via empty string `""` (`UX-01`) restores 18-node FinTech workspace!
    const resetRes = await fetch(`${base}/api/workspace/ingest-dir`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ targetDir: '' })
    });
    assert.equal(resetRes.status, 200);
    const resetState = await (await fetch(`${base}/api/state`)).json();
    assert.equal(resetState.data.workspaceName, 'fintech-core');
    assert.equal(resetState.data.nodeCount, 18);
    assert.equal(resetState.data.scenarios.length, 8);

    // Exceeding mutationRateLimitMax (5/min) returns 429 (`SEC-02`)
    await fetch(`${base}/api/workspace/ingest-dir`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ targetDir: 'reset' })
    });
    const sixthMutation = await fetch(`${base}/api/workspace/ingest-dir`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ targetDir: 'reset' })
    });
    assert.equal(sixthMutation.status, 429);

    const dirCompiled = compileDirectoryToGraph(path.join(PROJECT_ROOT, 'src'));
    assert.equal(dirCompiled.ok, true);
    assert.ok(dirCompiled.data.nodes.length >= 4);
});

test('Workspace-scoped MCP ingestion compiles sibling repos, captures envOr/envInt/envBool edges, and preserves SEC-03 boundary', async (t) => {
    const tmpMono = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-mono-'));
    const tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-outside-'));
    t.after(() => {
        fs.rmSync(tmpMono, { recursive: true, force: true });
        fs.rmSync(tmpOutside, { recursive: true, force: true });
    });

    const siblingRepo = path.join(tmpMono, 'projects', 'sample-service');
    fs.mkdirSync(siblingRepo, { recursive: true });
    fs.writeFileSync(
        path.join(siblingRepo, '.env.example'),
        'SERVICE_PORT=4190\nAPI_BASE_URL=http://localhost:8080\n'
    );
    fs.writeFileSync(
        path.join(siblingRepo, 'config.js'),
        "import { envOr, envInt } from '@krusch/toolkit/config';\nexport const port = envInt('SERVICE_PORT', 4190);\nexport const apiUrl = envOr('API_BASE_URL', '');\n"
    );

    const runtime = await createHydraScopeRuntime({
        projectRoot: tmpMono,
        preferOllama: false,
        hydraUrl: ''
    });

    const ingestSibling = await runtime.ingestDirectory(siblingRepo);
    assert.equal(ingestSibling.ok, true);
    assert.equal(ingestSibling.data.workspaceName, 'sample-service');

    const compiledGraph = runtime.getGraph();
    const envEdges = compiledGraph.edges.filter((e) => e.type === 'READS_ENV');
    assert.ok(envEdges.length >= 1, 'Expected READS_ENV edge from envOr/envInt calls to .env.example');

    const outsideAttempt = await runtime.ingestDirectory(tmpOutside);
    assert.equal(outsideAttempt.ok, false);
    assert.equal(outsideAttempt.error.code, 'PATH_OUTSIDE_WORKSPACE');

    const resetAttempt = await runtime.ingestDirectory('reset');
    assert.equal(resetAttempt.ok, true);
    assert.equal(resetAttempt.data.workspaceName, 'fintech-core');
});
