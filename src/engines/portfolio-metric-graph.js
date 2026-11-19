/**
 * @module engines/portfolio-metric-graph
 * @description Bi-temporal Metric-to-Surface Dependency Graph & Blast-Radius Propagator
 * built on HydraDB v0.4.0 OpenCypher (`:SUPERSEDES`, `:DERIVED_FROM`, `:RENDERS_LIVE`,
 * `:PINNED_AS_OF`, `:MEASURES_SOURCE`, `:CURRENT_FACT`).
 *
 * Solves cross-surface metric drift on static documentation and portfolio sites without
 * putting a database in the browser request path:
 *   1. Base metrics (`stars`, `merged_prs`, `tests`, `version`) attach to `:SourceEntity` nodes.
 *   2. Derived rollup metrics (`extra_prs`, `total_merged_prs`, `combined_tests`) evaluate
 *      topologically over `:DERIVED_FROM` edges (with cycle detection).
 *   3. When a metric mutates, the prior `:MetricFact` vertex is retired (`isCurrent: false`,
 *      `retiredAt`, `supersededBy`) and linked via `(:MetricFact_new)-[:SUPERSEDES]->(:MetricFact_old)`.
 *   4. Graph traversal walks reverse `:DERIVED_FROM` + outbound `:RENDERS_LIVE` edges to update
 *      every connected HTML, Plain-English JS, Resume, Discovery, and README slot in lockstep,
 *      while provably skipping historical whitepapers bound via `:PINNED_AS_OF`.
 */

import crypto from 'node:crypto';
import { okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { surrogateVertexId, scrubSensitiveStrings } from '../connectors/hydradb-client.js';
import { FORBIDDEN_OBJECT_KEYS } from '../utils/scrubber.js';
import { isValidIsoDate } from '../utils/validation.js';

const TOOL_NAME = 'hydrascope.metric_graph';

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeOptionalTimestamp(raw) {
    if (raw === null || raw === undefined || raw === '') {
        return { ok: true, iso: null, targetMs: null };
    }
    if (typeof raw !== 'string') {
        return { ok: false, error: 'Timestamp must be an ISO-8601 date or datetime string' };
    }
    const trimmed = raw.trim();
    if (isValidIsoDate(trimmed)) {
        const iso = `${trimmed}T23:59:59.999Z`;
        return { ok: true, iso: trimmed, targetMs: Date.parse(iso) };
    }
    if (ISO_DATETIME_RE.test(trimmed) && isValidIsoDate(trimmed.slice(0, 10))) {
        const ms = Date.parse(trimmed);
        if (Number.isFinite(ms)) {
            return { ok: true, iso: trimmed, targetMs: ms };
        }
    }
    return { ok: false, error: `Invalid ISO-8601 date or timestamp: "${trimmed}"` };
}

export const METRIC_GRAPH_EDGE_TYPES = Object.freeze([
    'MEASURES_SOURCE',
    'CURRENT_FACT',
    'SUPERSEDES',
    'DERIVED_FROM',
    'RENDERS_LIVE',
    'PINNED_AS_OF'
]);

const SAFE_KEY_RE = /^[a-zA-Z0-9._:-]{1,96}$/;

function stableSerializeValue(val) {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'number' || typeof val === 'boolean') return JSON.stringify(val);
    if (typeof val === 'string') return JSON.stringify(val);
    if (Array.isArray(val)) {
        return `[${val.map((item) => stableSerializeValue(item)).join(',')}]`;
    }
    if (typeof val === 'object') {
        const keys = Object.keys(val)
            .filter((k) => !FORBIDDEN_OBJECT_KEYS.has(k))
            .sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerializeValue(val[k])}`).join(',')}}`;
    }
    return JSON.stringify(String(val));
}

function shortValueHash(serialized) {
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 10);
}

function formatSummaryValue(val) {
    if (Array.isArray(val)) {
        return `[${val.join(', ')}]`;
    }
    if (val && typeof val === 'object') {
        return stableSerializeValue(val);
    }
    return String(val);
}

/**
 * Evaluate derived metric definitions in topological order along `:DERIVED_FROM` dependencies.
 *
 * @param {Record<string, unknown>} baseValues - Base metric key-value map
 * @param {Array<{ key: string, dependsOn: string[], compute: (vals: Record<string, any>) => unknown }>} derivedDefs
 * @returns {{ ok: boolean, values?: Record<string, unknown>, order?: string[], error?: { code: string, message: string } }}
 */
function evaluateDerivedMetricsTopologically(baseValues, derivedDefs = []) {
    const resolved = Object.create(null);
    for (const [k, v] of Object.entries(baseValues || {})) {
        if (FORBIDDEN_OBJECT_KEYS.has(k)) continue;
        resolved[k] = v;
    }

    if (!Array.isArray(derivedDefs) || derivedDefs.length === 0) {
        return { ok: true, values: resolved, order: [] };
    }

    const defByKey = new Map();
    for (const def of derivedDefs) {
        if (!def || typeof def.key !== 'string' || !SAFE_KEY_RE.test(def.key)) {
            return {
                ok: false,
                error: { code: 'INVALID_DERIVED_KEY', message: `Invalid derived metric key: ${String(def?.key)}` }
            };
        }
        if (typeof def.compute !== 'function') {
            return {
                ok: false,
                error: { code: 'INVALID_DERIVED_COMPUTE', message: `Derived metric "${def.key}" missing compute()` }
            };
        }
        defByKey.set(def.key, {
            key: def.key,
            dependsOn: Array.isArray(def.dependsOn) ? def.dependsOn.map(String) : [],
            compute: def.compute
        });
    }

    const inDegree = new Map();
    const dependents = new Map();
    for (const [key, def] of defByKey.entries()) {
        let deg = 0;
        for (const dep of def.dependsOn) {
            if (defByKey.has(dep)) {
                deg += 1;
                if (!dependents.has(dep)) dependents.set(dep, []);
                dependents.get(dep).push(key);
            } else if (!(dep in resolved)) {
                return {
                    ok: false,
                    error: {
                        code: 'UNKNOWN_METRIC_DEPENDENCY',
                        message: `Derived metric "${key}" depends on unknown metric "${dep}"`
                    }
                };
            }
        }
        inDegree.set(key, deg);
    }

    const queue = [];
    for (const [key, deg] of inDegree.entries()) {
        if (deg === 0) queue.push(key);
    }

    const order = [];
    while (queue.length > 0) {
        queue.sort();
        const current = queue.shift();
        order.push(current);
        const def = defByKey.get(current);
        resolved[current] = def.compute({ ...resolved });

        for (const nextKey of dependents.get(current) || []) {
            const nextDeg = (inDegree.get(nextKey) || 0) - 1;
            inDegree.set(nextKey, nextDeg);
            if (nextDeg === 0) queue.push(nextKey);
        }
    }

    if (order.length !== defByKey.size) {
        return {
            ok: false,
            error: {
                code: 'METRIC_CYCLE_DETECTED',
                message: 'Cycle detected in derived metric :DERIVED_FROM definitions'
            }
        };
    }

    return { ok: true, values: resolved, order };
}

/**
 * Compile base metrics, derived formulas, historical `:SUPERSEDES` ledger, and surface slots
 * into a HydraDB v0.4.0 OpenCypher-compatible graph snapshot.
 *
 * @param {object} [input={}]
 * @param {Array<{ id: string, title: string, path?: string, kind?: string }>} [input.sources=[]]
 * @param {Record<string, { value: unknown, sourceId?: string, title?: string }>} [input.baseMetrics={}]
 * @param {Array<{ key: string, title?: string, dependsOn: string[], compute: (vals: Record<string, any>) => unknown }>} [input.derivedDefinitions=[]]
 * @param {Array<{ slotId: string, file: string, title?: string, metrics?: string[], pinnedAsOf?: string|null }>} [input.slots=[]]
 * @param {Record<string, Array<{ factId: string, value: unknown, serialized: string, recordedAt: string, isCurrent: boolean, retiredAt?: string|null, supersededBy?: string|null, supersedes?: string|null }>>} [input.previousLedger={}]
 * @param {string} [input.recordedAt]
 * @param {string} [input.namespace='portfolio-telemetry']
 */
export function compileMetricPropagationGraph(input = {}) {
    const safeNamespace =
        typeof input.namespace === 'string' && input.namespace.trim()
            ? input.namespace.trim()
            : 'portfolio-telemetry';
    const recordedAt =
        typeof input.recordedAt === 'string' && input.recordedAt.trim()
            ? input.recordedAt.trim()
            : new Date().toISOString();

    const sources = Array.isArray(input.sources) ? input.sources : [];
    const rawBase = input.baseMetrics && typeof input.baseMetrics === 'object' ? input.baseMetrics : {};
    const derivedDefs = Array.isArray(input.derivedDefinitions) ? input.derivedDefinitions : [];
    const slots = Array.isArray(input.slots) ? input.slots : [];
    const prevHistory =
        input.previousLedger && typeof input.previousLedger === 'object' ? input.previousLedger : {};

    const baseValues = Object.create(null);
    const metricMeta = new Map();

    for (const [key, entry] of Object.entries(rawBase)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) continue;
        if (!SAFE_KEY_RE.test(key)) {
            return errorEnvelope('INVALID_METRIC_KEY', `Invalid base metric key: "${key}"`, { key }, TOOL_NAME);
        }
        const isDescriptor =
            entry && typeof entry === 'object' && !Array.isArray(entry) && Object.hasOwn(entry, 'value');
        const value = isDescriptor ? entry.value : entry;
        baseValues[key] = value;
        metricMeta.set(key, {
            key,
            isDerived: false,
            sourceId: isDescriptor && typeof entry.sourceId === 'string' ? entry.sourceId : null,
            title: isDescriptor && typeof entry.title === 'string' ? entry.title : key,
            dependsOn: []
        });
    }

    const derivedEval = evaluateDerivedMetricsTopologically(baseValues, derivedDefs);
    if (!derivedEval.ok) {
        return errorEnvelope(derivedEval.error.code, derivedEval.error.message, {}, TOOL_NAME);
    }

    for (const def of derivedDefs) {
        metricMeta.set(def.key, {
            key: def.key,
            isDerived: true,
            sourceId: null,
            title: typeof def.title === 'string' && def.title.trim() ? def.title.trim() : def.key,
            dependsOn: Array.isArray(def.dependsOn) ? def.dependsOn.map(String) : []
        });
    }

    const resolvedValues = derivedEval.values;
    const nodes = [];
    const edges = [];
    const nextLedger = {};
    const changedMetricKeys = [];

    const addNode = (node) => {
        nodes.push({
            ...node,
            surrogateId: surrogateVertexId(safeNamespace, node.logicalId)
        });
    };

    // 1. Source entity nodes
    const knownSourceIds = new Set();
    for (const src of sources) {
        if (!src || typeof src.id !== 'string' || !src.id.trim()) continue;
        const id = src.id.trim();
        const logicalId = id.startsWith('source:') ? id : `source:${id}`;
        knownSourceIds.add(logicalId);
        addNode({
            id: logicalId,
            logicalId,
            kind: src.kind || 'SourceEntity',
            title: src.title || id,
            path: src.path || id,
            isCurrent: true,
            summary: `Upstream telemetry source ${src.title || id}`
        });
    }

    // 2. MetricKey + temporal MetricFact (:SUPERSEDES) nodes & edges
    for (const [key, meta] of metricMeta.entries()) {
        const metricLogicalId = `metric:${key}`;
        const val = resolvedValues[key];
        const serialized = stableSerializeValue(val);

        const priorChain = Array.isArray(prevHistory[key])
            ? prevHistory[key].map((item) => ({ ...item }))
            : [];
        const activeIdx = priorChain.findIndex((f) => f.isCurrent !== false);
        const activePrior = activeIdx >= 0 ? priorChain[activeIdx] : null;

        let activeFact = activePrior;
        if (!activePrior) {
            const factId = `fact:${key}@v1-${shortValueHash(serialized)}`;
            activeFact = {
                factId,
                value: val,
                serialized,
                recordedAt,
                isCurrent: true,
                retiredAt: null,
                supersededBy: null,
                supersedes: null
            };
            priorChain.push(activeFact);
            changedMetricKeys.push(key);
        } else if (activePrior.serialized !== serialized) {
            const seq = priorChain.length + 1;
            const factId = `fact:${key}@v${seq}-${shortValueHash(serialized)}`;
            activePrior.isCurrent = false;
            activePrior.retiredAt = recordedAt;
            activePrior.supersededBy = factId;

            activeFact = {
                factId,
                value: val,
                serialized,
                recordedAt,
                isCurrent: true,
                retiredAt: null,
                supersededBy: null,
                supersedes: activePrior.factId
            };
            priorChain.push(activeFact);
            changedMetricKeys.push(key);
        }

        nextLedger[key] = priorChain;

        addNode({
            id: metricLogicalId,
            logicalId: metricLogicalId,
            kind: meta.isDerived ? 'DerivedMetricKey' : 'MetricKey',
            title: meta.title,
            path: metricLogicalId,
            isCurrent: true,
            summary: `${key} = ${formatSummaryValue(val)}`
        });

        if (meta.sourceId) {
            const sourceLogicalId = meta.sourceId.startsWith('source:')
                ? meta.sourceId
                : `source:${meta.sourceId}`;
            if (!knownSourceIds.has(sourceLogicalId)) {
                knownSourceIds.add(sourceLogicalId);
                addNode({
                    id: sourceLogicalId,
                    logicalId: sourceLogicalId,
                    kind: 'SourceEntity',
                    title: meta.sourceId,
                    path: meta.sourceId,
                    isCurrent: true
                });
            }
            edges.push({
                from: metricLogicalId,
                to: sourceLogicalId,
                type: 'MEASURES_SOURCE'
            });
        }

        for (const depKey of meta.dependsOn) {
            edges.push({
                from: metricLogicalId,
                to: `metric:${depKey}`,
                type: 'DERIVED_FROM'
            });
        }

        for (const fact of priorChain) {
            addNode({
                id: fact.factId,
                logicalId: fact.factId,
                kind: 'MetricFact',
                title: `${key} = ${formatSummaryValue(fact.value)}`,
                path: metricLogicalId,
                isCurrent: Boolean(fact.isCurrent),
                retiredAt: fact.retiredAt || undefined,
                supersededBy: fact.supersededBy || undefined,
                summary: `Recorded ${fact.recordedAt}: ${key}=${formatSummaryValue(fact.value)}`
            });
            if (fact.supersedes) {
                edges.push({
                    from: fact.factId,
                    to: fact.supersedes,
                    type: 'SUPERSEDES'
                });
            }
        }

        edges.push({
            from: metricLogicalId,
            to: activeFact.factId,
            type: 'CURRENT_FACT'
        });
    }

    // 3. SurfaceSlot nodes & :RENDERS_LIVE vs :PINNED_AS_OF edges
    for (const slot of slots) {
        if (!slot || typeof slot.slotId !== 'string' || !slot.slotId.trim()) continue;
        const cleanSlotId = slot.slotId.trim();
        const slotLogicalId = cleanSlotId.startsWith('slot:') ? cleanSlotId : `slot:${cleanSlotId}`;
        const pinnedCheck = normalizeOptionalTimestamp(slot.pinnedAsOf);
        if (!pinnedCheck.ok) {
            return errorEnvelope(
                'INVALID_PINNED_AS_OF',
                `Slot "${cleanSlotId}" has invalid pinnedAsOf date: ${pinnedCheck.error}`,
                { slotId: cleanSlotId },
                TOOL_NAME
            );
        }
        const pinnedAsOf = pinnedCheck.iso;
        const isPinned = Boolean(pinnedAsOf);
        const file = String(slot.file || cleanSlotId).trim();
        const boundMetrics = Array.isArray(slot.metrics) ? slot.metrics.map(String) : [];

        for (const mKey of boundMetrics) {
            if (!metricMeta.has(mKey)) {
                return errorEnvelope(
                    'UNKNOWN_SLOT_METRIC',
                    `Surface slot "${cleanSlotId}" references unknown metric "${mKey}"`,
                    { slotId: cleanSlotId, metric: mKey },
                    TOOL_NAME
                );
            }
        }

        addNode({
            id: slotLogicalId,
            logicalId: slotLogicalId,
            kind: isPinned ? 'PinnedSurfaceSlot' : 'SurfaceSlot',
            title: slot.title || cleanSlotId,
            path: file,
            isCurrent: true,
            summary: isPinned
                ? `Frozen historical slot in ${file} pinned asOf ${pinnedAsOf}`
                : `Live auto-propagated slot in ${file} (${boundMetrics.join(', ')})`
        });

        for (const mKey of boundMetrics) {
            if (isPinned) {
                edges.push({
                    from: slotLogicalId,
                    to: `metric:${mKey}`,
                    type: 'PINNED_AS_OF'
                });
            } else {
                edges.push({
                    from: `metric:${mKey}`,
                    to: slotLogicalId,
                    type: 'RENDERS_LIVE'
                });
            }
        }
    }

    return okEnvelope(
        TOOL_NAME,
        `Compiled metric graph (${nodes.length} nodes, ${edges.length} edges, ${changedMetricKeys.length} changed metrics)`,
        {
            namespace: safeNamespace,
            recordedAt,
            nodes,
            edges,
            resolvedValues: { ...resolvedValues },
            changedMetricKeys,
            ledger: nextLedger
        }
    );
}

/**
 * Traverse reverse `:DERIVED_FROM` edges (parent -> downstream derived metrics) and outbound
 * `:RENDERS_LIVE` edges to determine every surface slot impacted by a set of metric changes,
 * while excluding `:PINNED_AS_OF` historical whitepaper slots.
 *
 * @param {object} compiledGraph - `.data` output from `compileMetricPropagationGraph`
 * @param {string[]} [seedMetricKeys] - Metric keys that changed (defaults to `compiledGraph.changedMetricKeys`)
 */
export function traverseImpactedSurfaceSlots(compiledGraph, seedMetricKeys) {
    const graph = compiledGraph && typeof compiledGraph === 'object' ? compiledGraph : {};
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const seeds = Array.isArray(seedMetricKeys)
        ? seedMetricKeys.map(String)
        : Array.isArray(graph.changedMetricKeys)
          ? graph.changedMetricKeys.map(String)
          : [];

    const nodeByLogicalId = new Map(nodes.map((n) => [n.logicalId, n]));

    // Build reverse :DERIVED_FROM adjacency: depMetricLogicalId -> [derivedMetricLogicalId]
    const reverseDerived = new Map();
    const liveSlotsByMetric = new Map();
    const pinnedSlotsByMetric = new Map();

    for (const edge of edges) {
        if (edge.type === 'DERIVED_FROM') {
            // edge: derived -[:DERIVED_FROM]-> parentDep
            if (!reverseDerived.has(edge.to)) reverseDerived.set(edge.to, []);
            reverseDerived.get(edge.to).push(edge.from);
        } else if (edge.type === 'RENDERS_LIVE') {
            // edge: metric -[:RENDERS_LIVE]-> slot
            if (!liveSlotsByMetric.has(edge.from)) liveSlotsByMetric.set(edge.from, []);
            liveSlotsByMetric.get(edge.from).push(edge.to);
        } else if (edge.type === 'PINNED_AS_OF') {
            // edge: slot -[:PINNED_AS_OF]-> metric
            if (!pinnedSlotsByMetric.has(edge.to)) pinnedSlotsByMetric.set(edge.to, []);
            pinnedSlotsByMetric.get(edge.to).push(edge.from);
        }
    }

    const impactedMetricLogicalIds = new Set();
    const bfsQueue = [];
    for (const key of seeds) {
        const logicalId = key.startsWith('metric:') ? key : `metric:${key}`;
        if (!impactedMetricLogicalIds.has(logicalId)) {
            impactedMetricLogicalIds.add(logicalId);
            bfsQueue.push(logicalId);
        }
    }

    while (bfsQueue.length > 0) {
        const currentMetricId = bfsQueue.shift();
        for (const downstreamDerivedId of reverseDerived.get(currentMetricId) || []) {
            if (!impactedMetricLogicalIds.has(downstreamDerivedId)) {
                impactedMetricLogicalIds.add(downstreamDerivedId);
                bfsQueue.push(downstreamDerivedId);
            }
        }
    }

    const impactedSlotIds = new Set();
    const skippedPinnedSlotIds = new Set();
    const propagationPaths = [];

    for (const metricId of impactedMetricLogicalIds) {
        for (const slotId of liveSlotsByMetric.get(metricId) || []) {
            impactedSlotIds.add(slotId);
            const slotNode = nodeByLogicalId.get(slotId);
            propagationPaths.push({
                metricKey: metricId.replace(/^metric:/, ''),
                slotId: slotId.replace(/^slot:/, ''),
                file: slotNode?.path || slotId
            });
        }
        for (const pinnedId of pinnedSlotsByMetric.get(metricId) || []) {
            skippedPinnedSlotIds.add(pinnedId);
        }
    }

    const impactedSlots = [...impactedSlotIds].map((id) => {
        const node = nodeByLogicalId.get(id);
        return {
            slotId: id.replace(/^slot:/, ''),
            logicalId: id,
            file: node?.path || id,
            title: node?.title || id
        };
    });

    const skippedPinnedSlots = [...skippedPinnedSlotIds].map((id) => {
        const node = nodeByLogicalId.get(id);
        return {
            slotId: id.replace(/^slot:/, ''),
            logicalId: id,
            file: node?.path || id,
            summary: node?.summary || ''
        };
    });

    const filesImpacted = [...new Set(impactedSlots.map((s) => s.file))];

    return {
        seedMetricKeys: seeds,
        impactedMetricKeys: [...impactedMetricLogicalIds].map((id) => id.replace(/^metric:/, '')),
        impactedSlots,
        skippedPinnedSlots,
        filesImpacted,
        propagationPaths
    };
}

/**
 * Resolve the value of `metricKey` as of a historical timestamp (`asOfIso`) by walking
 * its `:SUPERSEDES` fact chain (`[recordedAt, retiredAt)`).
 *
 * @param {Record<string, Array<Record<string, any>>>} ledger
 * @param {string} metricKey
 * @param {string|null} [asOfIso=null]
 */
export function resolveMetricAsOf(ledger, metricKey, asOfIso = null) {
    const chain = ledger && Array.isArray(ledger[metricKey]) ? ledger[metricKey] : [];
    if (chain.length === 0) return { found: false, value: undefined, fact: null };

    if (!asOfIso) {
        const current = chain.find((f) => f.isCurrent !== false) || chain[chain.length - 1];
        return { found: true, value: current.value, fact: current };
    }

    const check = normalizeOptionalTimestamp(asOfIso);
    if (!check.ok || check.targetMs === null) {
        return { found: false, value: undefined, fact: null, error: check.error };
    }
    const targetMs = check.targetMs;

    // Find the latest fact recorded at or before targetMs that was not yet retired at targetMs
    const matching = chain.filter((f) => {
        const recMs = Date.parse(f.recordedAt);
        const retMs = f.retiredAt ? Date.parse(f.retiredAt) : Number.POSITIVE_INFINITY;
        return Number.isFinite(recMs) && recMs <= targetMs && targetMs < retMs;
    });

    if (matching.length > 0) {
        const picked = matching[matching.length - 1];
        return { found: true, value: picked.value, fact: picked };
    }

    return { found: false, value: undefined, fact: null };
}

/**
 * Apply ONLY the impacted `:RENDERS_LIVE` slot renderers to an in-memory `{ [filePath]: content }` map.
 *
 * @param {object} params
 * @param {Record<string, string>} params.filesByPath
 * @param {Record<string, unknown>} params.resolvedValues
 * @param {Record<string, (content: string, values: Record<string, any>) => string>} params.slotRenderers
 * @param {Array<{ slotId: string, file: string }>} params.impactedSlots
 */
export function applyImpactedSlotsToContent({
    filesByPath = {},
    resolvedValues = {},
    slotRenderers = {},
    impactedSlots = []
} = {}) {
    const updatedFiles = { ...filesByPath };
    const changedFilePaths = new Set();
    const appliedSlotIds = [];

    for (const slot of impactedSlots) {
        const renderer = slotRenderers[slot.slotId];
        if (typeof renderer !== 'function') continue;
        const currentContent = updatedFiles[slot.file];
        if (typeof currentContent !== 'string') continue;

        const nextContent = renderer(currentContent, resolvedValues);
        appliedSlotIds.push(slot.slotId);
        if (nextContent !== currentContent) {
            updatedFiles[slot.file] = nextContent;
            changedFilePaths.add(slot.file);
        }
    }

    return {
        updatedFiles,
        changedFilePaths: [...changedFilePaths],
        appliedSlotIds
    };
}

/**
 * Sync a compiled metric propagation graph into live HydraDB v0.4.0 via OpenCypher and
 * optionally verify live 1-hop `:RENDERS_LIVE` slot discovery from HydraDB.
 *
 * @param {object} compiledGraph - `.data` output from `compileMetricPropagationGraph`
 * @param {ReturnType<import('../connectors/hydradb-client.js').createHydraOpenCypherClient>} hydraClient
 * @param {object} [options={}]
 * @param {string[]} [options.verifyMetricKeys=[]]
 */
export async function syncMetricGraphToHydra(compiledGraph, hydraClient, options = {}) {
    if (!hydraClient || typeof hydraClient.syncGraphSnapshot !== 'function') {
        return okEnvelope(
            TOOL_NAME,
            'No HydraDB client supplied; operating in local graph mode',
            {
                liveSynced: false,
                mode: 'embedded_graph_fallback',
                hydraVerifiedSlots: []
            }
        );
    }

    const syncRes = await hydraClient.syncGraphSnapshot({
        nodes: compiledGraph.nodes,
        edges: compiledGraph.edges
    });

    if (!syncRes.ok) {
        return scrubSensitiveStrings(syncRes);
    }

    const liveSynced = Boolean(syncRes.data?.liveSynced);
    const verifyKeys = Array.isArray(options.verifyMetricKeys) ? options.verifyMetricKeys : [];
    const hydraVerifiedSlots = [];

    const queryFn =
        typeof hydraClient.queryCypher === 'function'
            ? hydraClient.queryCypher.bind(hydraClient)
            : typeof hydraClient.queryOpenCypher === 'function'
              ? hydraClient.queryOpenCypher.bind(hydraClient)
              : null;

    if (liveSynced && verifyKeys.length > 0 && queryFn) {
        const ns = compiledGraph.namespace || 'portfolio-telemetry';
        for (const rawKey of verifyKeys.slice(0, 8)) {
            const metricLogicalId = rawKey.startsWith('metric:') ? rawKey : `metric:${rawKey}`;
            const metricVertexId = surrogateVertexId(ns, metricLogicalId);
            const queryRes = await queryFn(
                'MATCH (m:GraphNode {id: $id})-[:RENDERS_LIVE]->(s:GraphNode) RETURN s.logicalId AS slotId, s.path AS filePath',
                { id: metricVertexId }
            );
            if (queryRes.ok && Array.isArray(queryRes.data?.records)) {
                for (const rec of queryRes.data.records) {
                    hydraVerifiedSlots.push({
                        metricKey: metricLogicalId.replace(/^metric:/, ''),
                        slotId: String(rec.slotId || '').replace(/^slot:/, ''),
                        file: String(rec.filePath || '')
                    });
                }
            }
        }
    }

    return scrubSensitiveStrings(
        okEnvelope(
            TOOL_NAME,
            liveSynced
                ? `Synced ${compiledGraph.nodes.length} metric vertices & ${compiledGraph.edges.length} edges to live HydraDB`
                : 'Retained metric propagation graph in embedded fallback mode',
            {
                ...syncRes.data,
                hydraVerifiedSlots
            }
        )
    );
}
