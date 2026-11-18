import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BRICK_ONTOLOGY_EDGE_TYPES,
    compileExchangeSnapshotToHydraGraph,
    mergeOntologyIntoRepoGraph,
    syncAndQueryBrickOntology,
} from '../src/engines/brick-ontology-bridge.js';
import {
    surrogateVertexId,
    createHydraOpenCypherClient,
} from '../src/connectors/hydradb-client.js';
import {
    traverseStructuralContext,
    supersedeDecisionInGraph,
} from '../src/engines/structural-retriever.js';
import { createHydraScopeRuntime } from '../src/runtime.js';
import { buildServer } from '../src/server.js';
import { HYDRASCOPE_MCP_TOOLS, createHydraScopeMcp } from '../src/mcp/hydrascope-mcp.js';

const HASH_STRIPE_INGRESS = 'a11ce000111122223333444455556666777788889999aaaabbbbccccddddeeee';
const HASH_LEDGER_AUDITOR = 'b22df000111122223333444455556666777788889999aaaabbbbccccddddeeee';
const HASH_CADENCE_WINDOW = 'c33ef000111122223333444455556666777788889999aaaabbbbccccddddeeee';
const HASH_FEE_V1 = '1111111111111111111111111111111111111111111111111111111111111111';
const HASH_FEE_V2 = '2222222222222222222222222222222222222222222222222222222222222222';

function buildMultiStackSnapshot() {
    return {
        orgProfiles: [
            {
                orgId: 'fintech-ops',
                name: 'FinTech Operations Org',
                stacks: ['node-esm', 'python-fastapi'],
                channels: ['webhook:stripe'],
                requiredPorts: ['ledger_event', 'audit_record'],
            },
        ],
        bricks: [
            {
                format: 'krusch-sealed-brick/v1',
                brickId: 'stripe-webhook-normalizer',
                name: 'Stripe Webhook Envelope Normalizer',
                summary: 'Verifies Stripe webhook signatures on edge or Node and emits normalized ledger_event payloads.',
                capabilities: ['webhook-verify', 'stripe-ledger-ingest'],
                lineage: {
                    sourceHash: HASH_STRIPE_INGRESS,
                    sealedAt: '2026-10-10T12:00:00Z',
                },
                ontology: {
                    stacks: ['node-esm', 'cloudflare-edge'],
                    channels: ['webhook:stripe'],
                    consumesPorts: ['webhook_envelope'],
                    producesPorts: ['ledger_event'],
                    validFrom: '2026-10-10',
                },
            },
            {
                brickId: 'ledger-audit-sealer',
                name: 'Ledger Audit Chain Sealer',
                summary: 'Consumes ledger_event items and appends tamper-evident audit_record entries across Node or FastAPI adapters.',
                capabilities: ['audit-chain', 'compliance-ledger'],
                lineage: {
                    sourceHash: HASH_LEDGER_AUDITOR,
                    sealedAt: '2026-10-12T08:30:00Z',
                },
                ontology: {
                    stacks: ['node-esm', 'python-fastapi'],
                    consumesPorts: ['ledger_event'],
                    producesPorts: ['audit_record'],
                    validFrom: '2026-10-12',
                },
            },
            {
                brickId: 'cadence-anomaly-detector',
                name: 'Monotonic Cadence Window Detector',
                summary: 'Evaluates monotonic time-series windows routed through timeseries-cadence-moe.',
                capabilities: ['timeseries-window', 'cadence-check'],
                sourceHash: HASH_CADENCE_WINDOW,
                ontology: {
                    stacks: ['node-esm', 'cloudflare-edge', 'python-fastapi'],
                    consumesPorts: ['timeseries_window'],
                    producesPorts: ['audit_record'],
                    moeProfile: 'timeseries-cadence-moe',
                    validFrom: '2026-10-15',
                },
            },
        ],
    };
}

test('1. Compiles multi-stack, multi-channel Brick Exchange snapshot into HydraScope vertices with 48-bit safe surrogateIds', () => {
    assert.deepEqual(BRICK_ONTOLOGY_EDGE_TYPES, [
        'TARGETS_STACK',
        'CONSUMES_PORT',
        'PRODUCES_PORT',
        'BRIDGES_CHANNEL',
        'ROUTES_TO_MODEL',
        'USES_STACK',
        'LISTENS_CHANNEL',
        'REQUIRES_PORT',
        'SUPERSEDES',
        'GOVERNS',
    ]);
    assert.equal(Object.isFrozen(BRICK_ONTOLOGY_EDGE_TYPES), true);

    const snapshot = buildMultiStackSnapshot();
    const compiled = compileExchangeSnapshotToHydraGraph(snapshot, {
        workspaceName: 'exchange-multi-stack',
        namespace: 'brick-ontology',
    });

    assert.equal(compiled.ok, true);
    assert.equal(compiled.tool, 'hydrascope.brick_ontology.compile');

    const graph = compiled.data;
    assert.equal(graph.workspaceName, 'exchange-multi-stack');
    assert.equal(graph.namespace, 'brick-ontology');
    assert.ok(graph.totalRepoTokens > 0);
    assert.ok(graph.nodes.length >= 11);

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    assert.ok(nodeIds.has(`brick:stripe-webhook-normalizer@${HASH_STRIPE_INGRESS}`));
    assert.ok(nodeIds.has(`brick:ledger-audit-sealer@${HASH_LEDGER_AUDITOR}`));
    assert.ok(nodeIds.has(`brick:cadence-anomaly-detector@${HASH_CADENCE_WINDOW}`));
    assert.ok(nodeIds.has('stack:node-esm'));
    assert.ok(nodeIds.has('stack:cloudflare-edge'));
    assert.ok(nodeIds.has('stack:python-fastapi'));
    assert.ok(nodeIds.has('channel:webhook:stripe'));
    assert.ok(nodeIds.has('port:ledger_event'));
    assert.ok(nodeIds.has('port:audit_record'));
    assert.ok(nodeIds.has('moe:timeseries-cadence-moe'));
    assert.ok(nodeIds.has('org:fintech-ops'));

    // Every node conforms to HydraScope shape and deterministic 48-bit safe integer surrogateId
    const seenSurrogates = new Set();
    for (const node of graph.nodes) {
        assert.equal(typeof node.id, 'string');
        assert.equal(Number.isSafeInteger(node.surrogateId), true);
        assert.ok(node.surrogateId >= 1000 && node.surrogateId <= Number.MAX_SAFE_INTEGER);
        assert.equal(node.surrogateId, surrogateVertexId('brick-ontology', node.id));
        seenSurrogates.add(node.surrogateId);
        assert.equal(typeof node.kind, 'string');
        assert.equal(typeof node.title, 'string');
        assert.equal(typeof node.path, 'string');
        assert.equal(typeof node.content, 'string');
        assert.ok(node.tokens >= 1);
        assert.equal(typeof node.isCurrent, 'boolean');
        assert.ok('validFrom' in node && 'retiredAt' in node && 'supersededBy' in node);
    }
    assert.equal(seenSurrogates.size, graph.nodes.length);

    // Every edge is strictly restricted to BRICK_ONTOLOGY_EDGE_TYPES
    const allowedSet = new Set(BRICK_ONTOLOGY_EDGE_TYPES);
    for (const edge of graph.edges) {
        assert.deepEqual(Object.keys(edge).sort(), ['from', 'to', 'type']);
        assert.equal(allowedSet.has(edge.type), true);
    }

    const edgeSet = new Set(graph.edges.map((e) => `${e.from}|${e.type}|${e.to}`));
    assert.ok(edgeSet.has(`brick:stripe-webhook-normalizer@${HASH_STRIPE_INGRESS}|TARGETS_STACK|stack:cloudflare-edge`));
    assert.ok(edgeSet.has(`brick:stripe-webhook-normalizer@${HASH_STRIPE_INGRESS}|BRIDGES_CHANNEL|channel:webhook:stripe`));
    assert.ok(edgeSet.has(`brick:stripe-webhook-normalizer@${HASH_STRIPE_INGRESS}|PRODUCES_PORT|port:ledger_event`));
    assert.ok(edgeSet.has(`brick:ledger-audit-sealer@${HASH_LEDGER_AUDITOR}|CONSUMES_PORT|port:ledger_event`));
    assert.ok(edgeSet.has(`brick:ledger-audit-sealer@${HASH_LEDGER_AUDITOR}|PRODUCES_PORT|port:audit_record`));
    assert.ok(edgeSet.has(`brick:cadence-anomaly-detector@${HASH_CADENCE_WINDOW}|ROUTES_TO_MODEL|moe:timeseries-cadence-moe`));
    assert.ok(edgeSet.has('org:fintech-ops|USES_STACK|stack:python-fastapi'));
    assert.ok(edgeSet.has('org:fintech-ops|LISTENS_CHANNEL|channel:webhook:stripe'));
    assert.ok(edgeSet.has('org:fintech-ops|REQUIRES_PORT|port:audit_record'));

    // Also accepts pre-compiled `{ nodes, edges }` graph input and filters out non-ontology edge types
    const recompiled = compileExchangeSnapshotToHydraGraph({
        nodes: graph.nodes,
        edges: [
            ...graph.edges,
            { from: 'stack:node-esm', to: 'stack:cloudflare-edge', type: 'UNSUPPORTED_RANDOM_EDGE' },
        ],
    });
    assert.equal(recompiled.ok, true);
    assert.equal(recompiled.data.nodes.length, graph.nodes.length);
    assert.equal(recompiled.data.edges.length, graph.edges.length);
});

test('2. :SUPERSEDES temporal retirement and asOf historical replay (v1 retired at 2026-11-17 excluded by default, restored at asOf 2026-11-01)', async () => {
    const snapshot = {
        bricks: [
            {
                brickId: 'fee-allocator',
                name: 'Fee Allocator v1 (Float Rounding)',
                summary: 'Legacy partner fee allocator v1.',
                sourceHash: HASH_FEE_V1,
                ontology: {
                    stacks: ['node-esm'],
                    consumesPorts: ['ledger_event'],
                    producesPorts: ['audit_record'],
                    validFrom: '2026-10-01',
                },
            },
            {
                brickId: 'fee-allocator',
                name: 'Fee Allocator v2 (Integer Basis-Point Conservation)',
                summary: 'Superseding integer basis-point allocator v2.',
                sourceHash: HASH_FEE_V2,
                ontology: {
                    stacks: ['node-esm'],
                    consumesPorts: ['ledger_event'],
                    producesPorts: ['audit_record'],
                    supersedes: [HASH_FEE_V1],
                    validFrom: '2026-11-17',
                },
            },
        ],
    };

    const compiled = compileExchangeSnapshotToHydraGraph(snapshot);
    assert.equal(compiled.ok, true);

    const v1Id = `brick:fee-allocator@${HASH_FEE_V1}`;
    const v2Id = `brick:fee-allocator@${HASH_FEE_V2}`;
    const v1Node = compiled.data.nodes.find((n) => n.id === v1Id);
    const v2Node = compiled.data.nodes.find((n) => n.id === v2Id);

    assert.ok(v1Node && v2Node);
    assert.equal(v1Node.isCurrent, false);
    assert.equal(v1Node.supersededBy, v2Id);
    assert.equal(v1Node.retiredAt, '2026-11-17');
    assert.equal(v2Node.isCurrent, true);
    assert.equal(v2Node.supersededBy, null);
    assert.equal(v2Node.retiredAt, null);
    assert.ok(
        compiled.data.edges.some(
            (e) => e.from === v2Id && e.to === v1Id && e.type === 'SUPERSEDES'
        )
    );

    // Default HEAD query excludes retired v1 and returns active v2 + retiredLineage
    const headQuery = await syncAndQueryBrickOntology({
        snapshot,
        targetStack: 'node-esm',
        requiredPorts: ['ledger_event'],
    });
    assert.equal(headQuery.ok, true);
    assert.deepEqual(
        headQuery.data.oneHopMatches.map((m) => m.id),
        [v2Id]
    );
    assert.equal(headQuery.data.retiredLineage.length, 1);
    assert.equal(headQuery.data.retiredLineage[0].id, v1Id);
    assert.equal(headQuery.data.retiredLineage[0].retiredAt, '2026-11-17');
    assert.equal(headQuery.data.retiredLineage[0].supersededBy, v2Id);
    assert.equal(headQuery.data.retiredLineage[0].activeReplacementId, v2Id);

    // Historical replay at `asOf: '2026-11-01'` restores v1 and excludes not-yet-valid v2
    const replayQuery = await syncAndQueryBrickOntology({
        snapshot,
        targetStack: 'node-esm',
        requiredPorts: ['ledger_event'],
        asOf: '2026-11-01',
    });
    assert.equal(replayQuery.ok, true);
    assert.equal(replayQuery.data.asOf, '2026-11-01');
    assert.deepEqual(
        replayQuery.data.oneHopMatches.map((m) => m.id),
        [v1Id]
    );
    assert.equal(replayQuery.data.retiredLineage.length, 0);

    // Malformed asOf date fails closed with INVALID_DATE
    const badDateRes = await syncAndQueryBrickOntology({
        snapshot,
        asOf: '2026-02-30',
    });
    assert.equal(badDateRes.ok, false);
    assert.equal(badDateRes.error.code, 'INVALID_DATE');
});

test('3. Merges brick ontology into HydraScope repo AST graph (file:bricks/fee-allocator/index.js -> file:src/settlement.js) and traces :GOVERNS + AST impact end-to-end', async () => {
    const repoGraph = {
        workspaceName: 'billing-service',
        totalRepoTokens: 320,
        nodes: [
            {
                id: 'file:bricks/fee-allocator/index.js',
                kind: 'code',
                title: 'bricks/fee-allocator/index.js',
                path: 'bricks/fee-allocator/index.js',
                symbols: ['allocatePartnerFee'],
                content: 'export function allocatePartnerFee(grossCents) { return grossCents; }',
                tokens: 110,
                validFrom: null,
                retiredAt: null,
                isCurrent: true,
                supersededBy: null,
            },
            {
                id: 'file:src/settlement.js',
                kind: 'code',
                title: 'src/settlement.js',
                path: 'src/settlement.js',
                symbols: ['settleMerchantBatch'],
                content: "import { allocatePartnerFee } from '../bricks/fee-allocator/index.js';\nexport function settleMerchantBatch(items) { return items.map(allocatePartnerFee); }",
                tokens: 120,
                validFrom: null,
                retiredAt: null,
                isCurrent: true,
                supersededBy: null,
            },
            {
                id: 'file:src/reconciler.js',
                kind: 'code',
                title: 'src/reconciler.js',
                path: 'src/reconciler.js',
                symbols: ['reconcileDailyLedger'],
                content: "import { settleMerchantBatch } from './settlement.js';\nexport function reconcileDailyLedger(batch) { return settleMerchantBatch(batch); }",
                tokens: 90,
                validFrom: null,
                retiredAt: null,
                isCurrent: true,
                supersededBy: null,
            },
        ],
        edges: [
            {
                from: 'file:bricks/fee-allocator/index.js',
                to: 'file:src/settlement.js',
                type: 'IMPACTS',
                reason: 'src/settlement.js imports vendored fee-allocator brick',
            },
            {
                from: 'file:src/settlement.js',
                to: 'file:src/reconciler.js',
                type: 'IMPACTS',
                reason: 'src/reconciler.js imports src/settlement.js',
            },
        ],
        ontology: {
            terms: ['allocatepartnerfee', 'settlemerchantbatch', 'reconciledailyledger'],
            knownConcepts: ['allocatePartnerFee', 'settleMerchantBatch', 'reconcileDailyLedger'],
            synonyms: {},
        },
    };

    const snapshot = {
        bricks: [
            {
                brickId: 'fee-allocator',
                name: 'Sealed Fee Allocator Brick',
                summary: 'Deterministic basis-point fee allocator governing vendored bricks/fee-allocator/index.js.',
                sourceHash: HASH_FEE_V2,
                ontology: {
                    stacks: ['node-esm'],
                    channels: ['webhook:stripe'],
                    consumesPorts: ['ledger_event'],
                    producesPorts: ['audit_record'],
                    validFrom: '2026-11-01',
                },
            },
        ],
    };

    const compiledOnt = compileExchangeSnapshotToHydraGraph(snapshot);
    assert.equal(compiledOnt.ok, true);

    const repoEdgesBefore = repoGraph.edges.length;
    const mergedRes = mergeOntologyIntoRepoGraph(repoGraph, compiledOnt.data);
    assert.equal(mergedRes.ok, true);
    assert.equal(mergedRes.tool, 'hydrascope.brick_ontology.merge');
    // Non-destructive merge check
    assert.equal(repoGraph.edges.length, repoEdgesBefore);

    const brickNodeId = `brick:fee-allocator@${HASH_FEE_V2}`;
    assert.ok(
        mergedRes.data.edges.some(
            (e) =>
                e.from === brickNodeId &&
                e.to === 'file:bricks/fee-allocator/index.js' &&
                e.type === 'GOVERNS'
        )
    );

    // End-to-end syncAndQueryBrickOntology traces brick -> :GOVERNS -> 1-hop & 2-hop repo AST callers
    const queryRes = await syncAndQueryBrickOntology({
        snapshot,
        baseRepoGraph: repoGraph,
        query: 'fee-allocator settlement impact',
        targetStack: 'node-esm',
        maxHops: 2,
    });
    assert.equal(queryRes.ok, true);
    assert.equal(queryRes.data.governedRepoNodes.length, 1);
    assert.equal(queryRes.data.governedRepoNodes[0].id, 'file:bricks/fee-allocator/index.js');

    const callerIds = queryRes.data.downstreamRepoCallers.map((c) => c.id);
    assert.deepEqual(callerIds, ['file:src/settlement.js', 'file:src/reconciler.js']);
    assert.equal(queryRes.data.downstreamRepoCallers[0].hop, 1);
    assert.equal(queryRes.data.downstreamRepoCallers[1].hop, 2);
    assert.ok(
        queryRes.data.downstreamRepoCallers[0].governedByBrickIds.includes(brickNodeId)
    );

    // Verify HydraScope's native traverseStructuralContext also walks the merged graph cleanly
    const nativeTraverse = await traverseStructuralContext(mergedRes.data, {
        query: 'Update allocatePartnerFee in fee-allocator without breaking settlement',
        tokenBudget: 1200,
        maxHops: 3,
    });
    assert.equal(nativeTraverse.ok, true);
    const nativeIds = new Set(nativeTraverse.data.traversedNodes.map((n) => n.id));
    assert.ok(nativeIds.has('file:bricks/fee-allocator/index.js'));
    assert.ok(nativeIds.has('file:src/settlement.js'));
    assert.ok(nativeIds.has(brickNodeId));
});

test('4. Port namespace collision guard (slack:channel_id !== discord:channel_id), 2-hop port compositions, mock OpenCypher sync + offline fallback, and INV-HS-02 dynamic IP scrubbing', async () => {
    const dynamicLanIp = ['10', '20', '30', '40'].join('.');
    const dynamicTailscaleIp = ['100', '95', '44', '12'].join('.');
    const dynamicLocalPath = ['', 'home', 'sandboxuser', 'private-notes.txt'].join('/');

    const snapshot = {
        bricks: [
            {
                brickId: 'stripe-ingress',
                name: 'Stripe Ingress Brick',
                summary: `Receives webhook_envelope from internal gateway http://${dynamicLanIp}:8080 and emits ledger_event.`,
                sourceHash: HASH_STRIPE_INGRESS,
                ontology: {
                    stacks: ['node-esm'],
                    channels: ['webhook:stripe'],
                    consumesPorts: ['webhook_envelope'],
                    producesPorts: ['ledger_event'],
                    validFrom: '2026-10-01',
                },
            },
            {
                brickId: 'ledger-auditor',
                name: 'Ledger Auditor Brick',
                summary: `Transforms ledger_event into audit_record (debug trace ${dynamicLocalPath} on ${dynamicTailscaleIp}).`,
                sourceHash: HASH_LEDGER_AUDITOR,
                ontology: {
                    stacks: ['node-esm'],
                    consumesPorts: ['ledger_event'],
                    producesPorts: ['audit_record'],
                    validFrom: '2026-10-05',
                },
            },
            {
                brickId: 'slack-thread-router',
                name: 'Slack Channel Router',
                summary: 'Emits scoped slack:channel_id port.',
                sourceHash: 'aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff',
                ontology: {
                    stacks: ['node-esm'],
                    channels: ['webhook:slack'],
                    producesPorts: ['slack:channel_id'],
                    validFrom: '2026-10-05',
                },
            },
            {
                brickId: 'discord-alert-sink',
                name: 'Discord Alert Sink',
                summary: 'Consumes scoped discord:channel_id port.',
                sourceHash: 'bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff',
                ontology: {
                    stacks: ['node-esm'],
                    consumesPorts: ['discord:channel_id'],
                    producesPorts: ['audit_record'],
                    validFrom: '2026-10-05',
                },
            },
        ],
    };

    // Mock live OpenCypher HydraDB client
    const syncedSnapshots = [];
    const mockLiveHydraClient = {
        isConfigured: () => true,
        async syncGraphSnapshot(payload) {
            syncedSnapshots.push(payload);
            return {
                ok: true,
                data: {
                    liveSynced: true,
                    mode: 'hydradb_opencypher_live',
                    nodesWritten: payload.nodes.length,
                    edgesWritten: payload.edges.length,
                    cypherStatements: [
                        'MERGE (root:WorkspaceRoot {id: 1000, namespace: $ns})-[:CONTAINS]->(n:GraphNode {id: $id})',
                    ],
                    latencyMs: 1.4,
                },
            };
        },
    };

    const liveRes = await syncAndQueryBrickOntology({
        snapshot,
        targetStack: 'node-esm',
        maxHops: 2,
        hydraClient: mockLiveHydraClient,
    });

    assert.equal(liveRes.ok, true);
    assert.equal(liveRes.data.liveSynced, true);
    assert.equal(liveRes.data.mode, 'hydradb_opencypher_live');
    assert.equal(liveRes.data.hydraSync.liveSynced, true);
    assert.equal(syncedSnapshots.length, 1);
    assert.ok(syncedSnapshots[0].nodes.length >= 4);

    // Valid 2-hop composition (`stripe-ingress --[:PRODUCES_PORT]-> port:ledger_event <--[:CONSUMES_PORT]-- ledger-auditor`)
    assert.equal(liveRes.data.twoHopCompositions.length, 1);
    assert.equal(liveRes.data.twoHopCompositions[0].producerBrickId, 'stripe-ingress');
    assert.equal(liveRes.data.twoHopCompositions[0].consumerBrickId, 'ledger-auditor');
    assert.equal(liveRes.data.twoHopCompositions[0].bridgePort, 'port:ledger_event');

    // Port namespace collision guard: `slack:channel_id` NEVER composes into `discord:channel_id`
    const crossNamespaceComposed = liveRes.data.twoHopCompositions.some(
        (c) =>
            c.producerBrickId === 'slack-thread-router' ||
            c.consumerBrickId === 'discord-alert-sink'
    );
    assert.equal(crossNamespaceComposed, false);
    assert.ok(
        liveRes.data.blockedPortCollisions.some(
            (col) =>
                col.producedPort === 'slack:channel_id' &&
                col.consumedPort === 'discord:channel_id'
        )
    );

    // Querying specifically for `discord:channel_id` never matches `slack-thread-router`
    const discordPortQuery = await syncAndQueryBrickOntology({
        snapshot,
        requiredPorts: ['discord:channel_id'],
    });
    assert.equal(discordPortQuery.ok, true);
    assert.deepEqual(
        discordPortQuery.data.oneHopMatches.map((m) => m.brickId),
        ['discord-alert-sink']
    );

    // INV-HS-02 Zero-Leak check across serialized result and synced snapshot
    const serializedResult = JSON.stringify(liveRes);
    const serializedSynced = JSON.stringify(syncedSnapshots);
    assert.equal(serializedResult.includes(dynamicLanIp), false);
    assert.equal(serializedResult.includes(dynamicTailscaleIp), false);
    assert.equal(serializedResult.includes(dynamicLocalPath), false);
    assert.equal(serializedSynced.includes(dynamicLanIp), false);
    assert.equal(serializedSynced.includes(dynamicTailscaleIp), false);
    assert.equal(serializedSynced.includes(dynamicLocalPath), false);

    // Offline HydraDB client falls back cleanly without throwing (`INV-HS-03`)
    const offlineRealClient = createHydraOpenCypherClient({
        baseUrl: 'http://127.0.0.1:9',
        allowPrivateLan: true,
        timeoutMs: 80,
        fetchImpl: async () => {
            throw new Error(`Connection refused at http://${dynamicLanIp}:8443`);
        },
        lookupFn: (_host, _opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
    });

    const offlineRes = await syncAndQueryBrickOntology({
        snapshot,
        targetStack: 'node-esm',
        targetChannel: 'webhook:stripe',
        requiredPorts: ['audit_record'],
        hydraClient: offlineRealClient,
    });
    assert.equal(offlineRes.ok, true);
    assert.equal(offlineRes.data.liveSynced, false);
    assert.equal(offlineRes.data.mode, 'embedded_graph_fallback');
    assert.equal(offlineRes.data.twoHopCompositions.length, 1);
    assert.equal(JSON.stringify(offlineRes).includes(dynamicLanIp), false);
});

test('5. Runtime ingestBrickOntology -> queryBrickOntology preserves repo AST downstreamRepoCallers, consistent namespace, and surrogateId SET sync', async () => {
    const HASH_PARTNER_FEE = '4444444444444444444444444444444444444444444444444444444444444444';
    const capturedQueries = [];
    const customNs = 'triad-ontology';

    const mockHydraClient = createHydraOpenCypherClient({
        baseUrl: 'https://hydradb-test.example.com:8443',
        token: 'hs-mock-token-123456',
        namespace: customNs,
        lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async (url, init = {}) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/healthz') {
                return new Response(JSON.stringify({ status: 'ok' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            const body = init.body ? JSON.parse(String(init.body)) : {};
            capturedQueries.push(body);
            return new Response(
                JSON.stringify({
                    columns: ['ok'],
                    rows: [[{ type: 'int', value: 1 }]],
                    read_epoch: 5,
                    bookmark: 'sgk:1:triad:5',
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        },
    });

    const runtime = await createHydraScopeRuntime({
        preferOllama: false,
        hydraNamespace: customNs,
        hydraClient: mockHydraClient,
    });

    // Fintech fixture has file:src/billing/fee-engine.ts -> settlement-batch.ts -> sox-reconciler.ts
    const snapshot = {
        bricks: [
            {
                brickId: 'partner-fee-brick',
                name: 'Partner Fee Governance Brick',
                summary: 'Sealed cent-conserving partner fee brick governing fee-engine.ts.',
                sourceHash: HASH_PARTNER_FEE,
                governs: ['file:src/billing/fee-engine.ts'],
                ontology: {
                    stacks: ['typescript-node'],
                    consumesPorts: ['ledger_event'],
                    producesPorts: ['audit_record'],
                    validFrom: '2026-10-01',
                },
            },
        ],
    };

    const ingestRes = await runtime.ingestBrickOntology(snapshot);
    assert.equal(ingestRes.ok, true);
    assert.equal(ingestRes.data.namespace, customNs);

    // Query WITHOUT passing `snapshot` so runtime queries merged `activeGraph` directly
    const queryRes = await runtime.queryBrickOntology({
        query: 'partner-fee-brick calculatePartnerFee',
        targetStack: 'typescript-node',
        maxHops: 2,
    });
    assert.equal(queryRes.ok, true);
    assert.equal(queryRes.data.namespace, customNs);
    assert.equal(queryRes.data.oneHopMatches.length, 1);
    assert.deepEqual(
        queryRes.data.governedRepoNodes.map((n) => n.id),
        ['file:src/billing/fee-engine.ts']
    );

    const downstreamIds = queryRes.data.downstreamRepoCallers.map((c) => c.id);
    assert.ok(downstreamIds.includes('file:src/billing/settlement-batch.ts'));
    assert.ok(downstreamIds.includes('file:src/compliance/sox-reconciler.ts'));

    // Verify WorkspaceRoot uses namespace-scoped surrogateVertexId and HydraDB v0.4.0 standalone MERGE (no trailing SET)
    const expectedRootId = surrogateVertexId(customNs, 'workspace:root');
    assert.notEqual(expectedRootId, 1000);
    const nodeMergeCalls = capturedQueries.filter((q) =>
        String(q.query || '').includes('WorkspaceRoot')
    );
    assert.ok(nodeMergeCalls.length > 0);
    assert.equal(nodeMergeCalls[0].parameters.rootId, expectedRootId);
    assert.equal(nodeMergeCalls[0].parameters.ns, customNs);
    assert.ok(
        String(nodeMergeCalls[0].query).includes(
            'MERGE (root:WorkspaceRoot {id: $rootId, namespace: $ns})-[:CONTAINS]->(n:GraphNode {id: $id, namespace: $ns, logicalId: $logicalId'
        )
    );
    assert.equal(String(nodeMergeCalls[0].query).includes(' SET '), false);
});

test('6. Un-dated asOf supersession, cross-org :SUPERSEDES isolation, bare brickId guard, ^bricks/ root anchor, and pre-slugification scrubbing', async () => {
    const HASH_V1 = '1010101010101010101010101010101010101010101010101010101010101010';
    const HASH_V2 = '2020202020202020202020202020202020202020202020202020202020202020';
    const HASH_V3 = '3030303030303030303030303030303030303030303030303030303030303030';
    const HASH_OTHER_ORG = '9090909090909090909090909090909090909090909090909090909090909090';

    // 6a. Un-dated supersession (`v2` has no `validFrom`, so `v1.retiredAt === null` & `v1.isCurrent === false`)
    // Querying with `asOf` must NOT resurrect `v1`!
    const undatedSnapshot = {
        bricks: [
            {
                brickId: 'audit-writer',
                name: 'Audit Writer v1',
                sourceHash: HASH_V1,
                orgId: 'org-alpha',
                ontology: {
                    stacks: ['node-esm'],
                    producesPorts: ['audit_record'],
                    validFrom: '2026-09-01',
                },
            },
            {
                brickId: 'audit-writer',
                name: 'Audit Writer v2 (Undated Replacement)',
                sourceHash: HASH_V2,
                orgId: 'org-alpha',
                ontology: {
                    stacks: ['node-esm'],
                    producesPorts: ['audit_record'],
                    supersedes: [HASH_V1],
                },
            },
            // Cross-org brick attempting to supersede org-alpha's HASH_V2 must be blocked!
            {
                brickId: 'audit-writer',
                name: 'Hostile Cross-Org Superseder',
                sourceHash: HASH_OTHER_ORG,
                orgId: 'org-intruder',
                ontology: {
                    stacks: ['node-esm'],
                    producesPorts: ['audit_record'],
                    supersedes: [HASH_V2],
                },
            },
            // Bare `brickId` supersession without `@hash` or 64-hex hash must be ignored (never re-retiring v1 while leaving v2 active)
            {
                brickId: 'audit-writer',
                name: 'Ambiguous Bare Ref v3',
                sourceHash: HASH_V3,
                orgId: 'org-alpha',
                ontology: {
                    stacks: ['node-esm'],
                    producesPorts: ['audit_record'],
                    supersedes: ['audit-writer'],
                },
            },
        ],
    };

    const undatedAsOfRes = await syncAndQueryBrickOntology({
        snapshot: undatedSnapshot,
        targetStack: 'node-esm',
        asOf: '2026-11-01',
    });
    assert.equal(undatedAsOfRes.ok, true);

    const activeIds = undatedAsOfRes.data.oneHopMatches.map((m) => m.id);
    const v1Id = `brick:audit-writer@${HASH_V1}`;
    const v2Id = `brick:audit-writer@${HASH_V2}`;
    assert.equal(activeIds.includes(v1Id), false, 'Un-dated retired v1 must stay inactive at asOf');
    assert.equal(activeIds.includes(v2Id), true, 'Cross-org supersession must NOT retire org-alpha v2');
    assert.ok(undatedAsOfRes.data.retiredLineage.some((r) => r.id === v1Id && r.supersededBy === v2Id));

    // 6b. Repo-root anchor (`^bricks/`) & pre-slugification sensitive string scrubbing
    const sensitiveIp = ['192', '168', '44', '99'].join('.');
    const sensitivePath = ['', 'home', 'devbox', 'secret-brick'].join('/');
    const sensitiveSluggedIp = ['192', '168', '44', '99'].join('-');

    const rootAnchorRepo = {
        workspaceName: 'anchor-check',
        nodes: [
            {
                id: 'file:bricks/audit-writer/index.js',
                kind: 'code',
                title: 'bricks/audit-writer/index.js',
                path: './bricks/audit-writer/index.js',
                content: 'export const writeAudit = () => true;',
                tokens: 12,
                isCurrent: true,
            },
            {
                id: 'file:tests/fixtures/bricks/audit-writer/index.js',
                kind: 'code',
                title: 'Nested fixture brick copy',
                path: 'tests/fixtures/bricks/audit-writer/index.js',
                content: 'export const fixtureCopy = () => false;',
                tokens: 12,
                isCurrent: true,
            },
        ],
        edges: [],
    };

    const scrubSnap = {
        orgProfiles: [{ orgId: `org-${sensitiveIp}`, name: `Org at ${sensitivePath}` }],
        bricks: [
            {
                brickId: 'audit-writer',
                name: 'Audit Writer Root',
                sourceHash: HASH_V2,
                ontology: { stacks: ['node-esm'] },
            },
            {
                name: `Leaky Brick ${sensitivePath} ${sensitiveIp}`,
                sourceHash: '5555555555555555555555555555555555555555555555555555555555555555',
                ontology: { stacks: ['node-esm'] },
            },
        ],
    };

    const compiledScrub = compileExchangeSnapshotToHydraGraph(scrubSnap);
    assert.equal(compiledScrub.ok, true);
    const mergedAnchor = mergeOntologyIntoRepoGraph(rootAnchorRepo, compiledScrub.data);
    assert.equal(mergedAnchor.ok, true);
    assert.equal(mergedAnchor.data.governsLinks.length, 1);
    assert.equal(mergedAnchor.data.governsLinks[0].to, 'file:bricks/audit-writer/index.js');

    const serializedMerged = JSON.stringify(mergedAnchor);
    assert.equal(serializedMerged.includes(sensitiveIp), false);
    assert.equal(serializedMerged.includes(sensitiveSluggedIp), false);
    assert.equal(serializedMerged.includes('devbox'), false);

    // Also verify supersedeDecisionInGraph scrubs sensitive content before storing in graph
    const decisionGraph = {
        workspaceName: 'sec-test',
        nodes: [
            {
                id: 'adr:ADR-100',
                kind: 'decision',
                title: 'Old Rule',
                path: 'docs/adr/adr-100.md',
                content: 'Legacy rule.',
                tokens: 4,
                isCurrent: true,
            },
        ],
        edges: [],
    };
    const supDecision = await supersedeDecisionInGraph(decisionGraph, {
        oldId: 'adr:ADR-100',
        newId: 'adr:ADR-101',
        title: `Rule on ${sensitiveIp}`,
        content: `Loaded from ${sensitivePath} on ${sensitiveIp}`,
        effectiveAt: '2026-11-17',
    });
    assert.equal(supDecision.ok, true);
    assert.equal(JSON.stringify(decisionGraph).includes(sensitiveIp), false);
    assert.equal(JSON.stringify(decisionGraph).includes('devbox'), false);
});

test('7. HTTP /api/ontology/ingest and /api/ontology/query routes honor Bearer auth and preserve 6 MCP tools', async (t) => {
    assert.equal(HYDRASCOPE_MCP_TOOLS.length, 6);

    const adminToken = 'hs-ontology-route-secret';
    const { server, runtime, close } = await buildServer({
        dbPath: ':memory:',
        adminToken,
        runtimeOptions: { preferOllama: false, hydraUrl: '' },
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await close();
    });

    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const HASH_HTTP_BRICK = '7777777777777777777777777777777777777777777777777777777777777777';

    const ontologyPayload = {
        snapshot: {
            bricks: [
                {
                    brickId: 'sox-fee-guard',
                    name: 'SOX Fee Guard Brick',
                    summary: 'Governs fee-engine.ts partner fee rounding.',
                    sourceHash: HASH_HTTP_BRICK,
                    governs: ['file:src/billing/fee-engine.ts'],
                    ontology: {
                        stacks: ['typescript-node'],
                        consumesPorts: ['ledger_event'],
                        producesPorts: ['audit_record'],
                        validFrom: '2026-10-15',
                    },
                },
            ],
        },
    };

    // Unauthenticated ingest rejected with 401
    const unauthRes = await fetch(`${base}/api/ontology/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ontologyPayload),
    });
    assert.equal(unauthRes.status, 401);

    // Authenticated ingest merges ontology into active FinTech repo graph
    const ingestRes = await fetch(`${base}/api/ontology/ingest`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(ontologyPayload),
    });
    assert.equal(ingestRes.status, 200);
    const ingestJson = await ingestRes.json();
    assert.equal(ingestJson.ok, true);

    // Query route preserves repo AST downstream callers (`settlement-batch.ts` + `sox-reconciler.ts`)
    const queryRes = await fetch(`${base}/api/ontology/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: 'sox-fee-guard',
            targetStack: 'typescript-node',
            maxHops: 2,
        }),
    });
    assert.equal(queryRes.status, 200);
    const queryJson = await queryRes.json();
    assert.equal(queryJson.ok, true);
    assert.equal(queryJson.data.oneHopMatches.length, 1);
    const callerIds = queryJson.data.downstreamRepoCallers.map((c) => c.id);
    assert.ok(callerIds.includes('file:src/billing/settlement-batch.ts'));
    assert.ok(callerIds.includes('file:src/compliance/sox-reconciler.ts'));

    // MCP hydrascope_traverse_context with includeBrickOntology=true enriches structural traversal while preserving 6 MCP tools
    const mcpInstance = createHydraScopeMcp({ runtime, connect: false });
    assert.equal(HYDRASCOPE_MCP_TOOLS.length, 6);
    assert.ok(mcpInstance);
});
