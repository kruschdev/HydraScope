import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compileMetricPropagationGraph,
    traverseImpactedSurfaceSlots,
    resolveMetricAsOf,
    applyImpactedSlotsToContent,
    syncMetricGraphToHydra
} from '../src/engines/portfolio-metric-graph.js';
import { createHydraScopeRuntime } from '../src/runtime.js';

function buildFixtureDefinition(easiMerged = 5, toolkitTests = 179) {
    return {
        namespace: 'portfolio-telemetry-test',
        sources: [
            { id: 'julianosig/easi.run', title: 'easi.run Rust Wayland/CDP' },
            { id: 'hydra-db/selfgraph', title: 'SelfGraph Temporal Graph Engine' },
            { id: 'kruschdev/toolkit', title: '@krusch/toolkit' }
        ],
        baseMetrics: {
            'easi.merged_prs': { value: easiMerged, sourceId: 'julianosig/easi.run' },
            'selfgraph.merged_prs': { value: 9, sourceId: 'hydra-db/selfgraph' },
            'toolkit.node_tests': { value: toolkitTests, sourceId: 'kruschdev/toolkit' },
            'hydrascope.tests': { value: 25, sourceId: 'kruschdev/toolkit' }
        },
        derivedDefinitions: [
            {
                key: 'upstream.total_merged_prs',
                title: 'Total External Merged PRs',
                dependsOn: ['easi.merged_prs', 'selfgraph.merged_prs'],
                compute: (v) => Number(v['easi.merged_prs']) + Number(v['selfgraph.merged_prs'])
            },
            {
                key: 'triad.combined_tests',
                title: 'Combined Triad Tests',
                dependsOn: ['toolkit.node_tests', 'hydrascope.tests'],
                compute: (v) => Number(v['toolkit.node_tests']) + Number(v['hydrascope.tests'])
            }
        ],
        slots: [
            {
                slotId: 'index.easi_card',
                file: 'src/public/index.html',
                metrics: ['easi.merged_prs']
            },
            {
                slotId: 'home_copy.easi_card',
                file: 'src/public/assets/layman/home-copy.js',
                metrics: ['easi.merged_prs']
            },
            {
                slotId: 'resume.upstream_rollup',
                file: 'src/public/resume.html',
                metrics: ['upstream.total_merged_prs']
            },
            {
                slotId: 'index.toolkit_card',
                file: 'src/public/index.html',
                metrics: ['toolkit.node_tests', 'triad.combined_tests']
            },
            {
                slotId: 'paper29.frozen_table',
                file: 'src/public/articles/mit-open-source-brick-exchange-common-ground-deadbolt.html',
                metrics: ['toolkit.node_tests'],
                pinnedAsOf: '2026-11-17T20:00:00Z'
            }
        ]
    };
}

test('1. Single metric change propagates 2 hops across :DERIVED_FROM and :RENDERS_LIVE without touching unrelated slots', () => {
    const t1 = compileMetricPropagationGraph({
        ...buildFixtureDefinition(5, 179),
        recordedAt: '2026-11-17T10:00:00.000Z'
    });
    assert.equal(t1.ok, true);
    assert.equal(t1.data.resolvedValues['upstream.total_merged_prs'], 14);

    // Mutate ONLY easi.merged_prs: 5 -> 6
    const t2 = compileMetricPropagationGraph({
        ...buildFixtureDefinition(6, 179),
        previousLedger: t1.data.ledger,
        recordedAt: '2026-11-18T19:00:00.000Z'
    });
    assert.equal(t2.ok, true);
    assert.deepEqual(
        t2.data.changedMetricKeys.sort(),
        ['easi.merged_prs', 'upstream.total_merged_prs'],
        'Only easi.merged_prs and its :DERIVED_FROM rollup should mark changed'
    );
    assert.equal(t2.data.resolvedValues['upstream.total_merged_prs'], 15);

    const impact = traverseImpactedSurfaceSlots(t2.data);
    assert.deepEqual(
        impact.impactedSlots.map((s) => s.slotId).sort(),
        ['home_copy.easi_card', 'index.easi_card', 'resume.upstream_rollup'],
        'Toolkit slots must remain untouched when only easi.merged_prs changes'
    );

    const files = {
        'src/public/index.html': '<span>MERGED: 5 PRS</span> | <span>179/179 Node</span>',
        'src/public/assets/layman/home-copy.js': 'plain: 5 fixes merged',
        'src/public/resume.html': 'Total merged PRs: 14'
    };
    let toolkitRendererCalled = false;
    const renderers = {
        'index.easi_card': (src, v) => src.replace(/MERGED: \d+ PRS/, `MERGED: ${v['easi.merged_prs']} PRS`),
        'home_copy.easi_card': (src, v) => src.replace(/\d+ fixes merged/, `${v['easi.merged_prs']} fixes merged`),
        'resume.upstream_rollup': (src, v) =>
            src.replace(/Total merged PRs: \d+/, `Total merged PRs: ${v['upstream.total_merged_prs']}`),
        'index.toolkit_card': (src) => {
            toolkitRendererCalled = true;
            return src;
        }
    };

    const applied = applyImpactedSlotsToContent({
        filesByPath: files,
        resolvedValues: t2.data.resolvedValues,
        slotRenderers: renderers,
        impactedSlots: impact.impactedSlots
    });
    assert.equal(toolkitRendererCalled, false, 'Unrelated slot renderer must not execute');
    assert.equal(applied.updatedFiles['src/public/index.html'], '<span>MERGED: 6 PRS</span> | <span>179/179 Node</span>');
    assert.equal(applied.updatedFiles['src/public/assets/layman/home-copy.js'], 'plain: 6 fixes merged');
    assert.equal(applied.updatedFiles['src/public/resume.html'], 'Total merged PRs: 15');
});

test('2. :SUPERSEDES lineage and :PINNED_AS_OF freeze historical whitepapers while resolving point-in-time asOf queries', () => {
    const epoch1 = compileMetricPropagationGraph({
        ...buildFixtureDefinition(5, 179),
        recordedAt: '2026-11-17T12:00:00.000Z'
    });
    const epoch2 = compileMetricPropagationGraph({
        ...buildFixtureDefinition(5, 191),
        previousLedger: epoch1.data.ledger,
        recordedAt: '2026-11-18T18:00:00.000Z'
    });

    assert.equal(epoch2.ok, true);
    const supersedesEdges = epoch2.data.edges.filter((e) => e.type === 'SUPERSEDES');
    assert.equal(supersedesEdges.length, 2, 'toolkit.node_tests and triad.combined_tests must emit :SUPERSEDES edges');

    const impact = traverseImpactedSurfaceSlots(epoch2.data);
    assert.deepEqual(
        impact.impactedSlots.map((s) => s.slotId),
        ['index.toolkit_card'],
        'Live index.toolkit_card updates'
    );
    assert.deepEqual(
        impact.skippedPinnedSlots.map((s) => s.slotId),
        ['paper29.frozen_table'],
        'Historical Paper #29 slot bound via :PINNED_AS_OF is protected from mutation'
    );

    const historical = resolveMetricAsOf(epoch2.data.ledger, 'toolkit.node_tests', '2026-11-17T20:00:00Z');
    assert.equal(historical.found, true);
    assert.equal(historical.value, 179);

    const current = resolveMetricAsOf(epoch2.data.ledger, 'toolkit.node_tests');
    assert.equal(current.found, true);
    assert.equal(current.value, 191);
});

test('3. Rejects cyclic :DERIVED_FROM graphs and syncs + verifies :RENDERS_LIVE edges via HydraDB OpenCypher client', async () => {
    const cyclic = compileMetricPropagationGraph({
        baseMetrics: { a: 1 },
        derivedDefinitions: [
            { key: 'b', dependsOn: ['c'], compute: (v) => v.c + 1 },
            { key: 'c', dependsOn: ['b'], compute: (v) => v.b + 1 }
        ]
    });
    assert.equal(cyclic.ok, false);
    assert.equal(cyclic.error.code, 'METRIC_CYCLE_DETECTED');

    const compiled = compileMetricPropagationGraph(buildFixtureDefinition(6, 191));
    const queriesSeen = [];
    const mockHydraClient = {
        async syncGraphSnapshot({ nodes, edges }) {
            return {
                ok: true,
                data: {
                    liveSynced: true,
                    mode: 'hydradb_opencypher_live',
                    nodesWritten: nodes.length,
                    edgesWritten: edges.length
                }
            };
        },
        async queryOpenCypher(cypher, params) {
            queriesSeen.push({ cypher, params });
            return {
                ok: true,
                data: {
                    records: [
                        { slotId: 'slot:index.easi_card', filePath: 'src/public/index.html' },
                        { slotId: 'slot:home_copy.easi_card', filePath: 'src/public/assets/layman/home-copy.js' }
                    ]
                }
            };
        }
    };

    const synced = await syncMetricGraphToHydra(compiled.data, mockHydraClient, {
        verifyMetricKeys: ['easi.merged_prs']
    });
    assert.equal(synced.ok, true);
    assert.equal(synced.data.liveSynced, true);
    assert.equal(queriesSeen.length, 1);
    assert.match(queriesSeen[0].cypher, /\[:RENDERS_LIVE\]/);
    assert.equal(synced.data.hydraVerifiedSlots.length, 2);

    const runtime = await createHydraScopeRuntime({ preferOllama: false, hydraUrl: '' });
    const runtimeRes = await runtime.syncMetricGraph(buildFixtureDefinition(6, 191), {
        verifyMetricKeys: ['easi.merged_prs']
    });
    assert.equal(runtimeRes.ok, true);
    assert.equal(runtimeRes.data.impact.impactedSlots.length, 3);
    await runtime.closeSelfGraph();
});
