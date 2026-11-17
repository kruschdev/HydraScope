/**
 * @module connectors/selfgraph-store
 * @description SelfGraph v0.2 knowledge-graph adapter for HydraScope,
 * bridging HydraScope's compiled code/MCP/ADR ontology into `@hydradb/selfgraph` (`HydraDBStore` over Bolt
 * or embedded `KuzuStore`) for native Personalized PageRank (`strategy: "ppr"`), `asOf` / `knownAt`
 * bi-temporal replay, known-time `graph.diff(since, until)`, `readiness()`, `certify`, and reversible `merge`/`unmerge`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { HydraDBStore, KuzuStore, Schema, SelfGraph, toJsonable } from '@hydradb/selfgraph';
import { scrubSensitiveStrings } from '../utils/scrubber.js';

const TOOL_NAME = 'hydrascope.selfgraph';

export const HYDRASCOPE_SELFGRAPH_SCHEMA = Schema.parse({
    entities: [
        { name: 'Skill', aliases: ['Capability', 'Workflow'] },
        { name: 'McpTool', aliases: ['Tool', 'Endpoint'] },
        { name: 'CodeSymbol', aliases: ['Function', 'Module', 'Service', 'File'] },
        { name: 'AdrRule', aliases: ['Decision', 'ADR', 'Invariant', 'Policy'] },
        { name: 'ResolvedEntity', aliases: ['Partner', 'Cluster', 'Account'] }
    ],
    relations: [
        {
            type: 'IMPACTS',
            from: { types: ['Skill', 'CodeSymbol', 'McpTool'] },
            to: { types: ['McpTool', 'CodeSymbol'] }
        },
        {
            type: 'CALLS',
            from: { types: ['CodeSymbol', 'McpTool'] },
            to: { types: ['CodeSymbol', 'McpTool'] }
        },
        {
            type: 'GOVERNS',
            from: { types: ['AdrRule'] },
            to: { types: ['CodeSymbol', 'McpTool', 'Skill'] }
        },
        {
            type: 'SUPERSEDES',
            from: { types: ['AdrRule', 'McpTool'] },
            to: { types: ['AdrRule', 'McpTool'] }
        },
        {
            type: 'ACTIVE_RULE_FOR',
            from: { types: ['CodeSymbol', 'McpTool', 'Skill'], max_count: 1 },
            to: { types: ['AdrRule'] }
        },
        {
            type: 'RESOLVED_TO',
            from: { types: ['ResolvedEntity'], max_count: 1 },
            to: { types: ['ResolvedEntity'] }
        }
    ]
});

/**
 * Map a HydraScope node `kind` into a canonical `HYDRASCOPE_SELFGRAPH_SCHEMA` entity type.
 *
 * @param {string} kind
 * @returns {string}
 */
export function mapNodeKindToSelfGraphType(kind) {
    const clean = String(kind || '').trim().toLowerCase();
    if (clean === 'skill' || clean === 'workflow') return 'Skill';
    if (clean === 'mcptool' || clean === 'mcp_tool' || clean === 'tool') return 'McpTool';
    if (clean === 'decision' || clean === 'adr' || clean === 'invariant') return 'AdrRule';
    if (clean === 'entity' || clean === 'resolved_entity' || clean === 'partner') {
        return 'ResolvedEntity';
    }
    return 'CodeSymbol';
}

/**
 * Normalize a HydraScope logical node ID (`fn:calculatePartnerFee`, `adr:ADR-014`) into a
 * valid SelfGraph `<type>:<slug>` explicit entity ID.
 *
 * @param {string} rawId
 * @param {string} entityType
 * @returns {string}
 */
export function toSelfGraphEntityId(rawId, entityType = 'CodeSymbol') {
    const typeSlug = String(entityType || 'codesymbol')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'node';
    const raw = String(rawId || '').trim();
    const afterColon = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    const slug = afterColon
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unnamed';
    return `${typeSlug}:${slug}`;
}

/**
 * Create a SelfGraph-backed knowledge adapter (`KuzuStore` embedded by default, or `HydraDBStore`
 * over Bolt when `boltUri` is configured).
 *
 * @param {object} [options]
 * @param {'kuzu'|'hydradb'} [options.backend]
 * @param {string} [options.kuzuPath]
 * @param {string} [options.boltUri]
 * @param {string} [options.boltToken]
 * @param {string} [options.namespace]
 */
export async function createHydraScopeSelfGraphAdapter(options = {}) {
    const backend = options.backend || (options.boltUri ? 'hydradb' : 'kuzu');
    const namespace = String(options.namespace || 'hydrascope').trim() || 'hydrascope';
    let tempRoot = null;
    let kuzuPath = options.kuzuPath ? path.resolve(options.kuzuPath) : null;

    let store;
    if (backend === 'hydradb') {
        store = new HydraDBStore(options.boltUri, {
            auth: options.boltToken ? ['neo4j', options.boltToken] : undefined
        });
    } else {
        if (!kuzuPath) {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrascope-selfgraph-'));
            kuzuPath = path.join(tempRoot, 'hydrascope.kuzu');
        } else {
            fs.mkdirSync(path.dirname(kuzuPath), { recursive: true });
        }
        store = new KuzuStore(kuzuPath);
    }

    const graph = new SelfGraph(store, {
        namespace,
        schema: HYDRASCOPE_SELFGRAPH_SCHEMA,
        schema_mode: 'warn',
        contradiction: 'supersede',
        resolver: 'default'
    });
    await graph.initialize();

    const idMap = new Map();

    async function syncHydraScopeGraph(compiledGraph, { sourceId = 'workspace-compile' } = {}) {
        const nodes = Array.isArray(compiledGraph?.nodes) ? compiledGraph.nodes : [];
        const edges = Array.isArray(compiledGraph?.edges) ? compiledGraph.edges : [];
        idMap.clear();

        const entities = nodes.map((node) => {
            const sgType = mapNodeKindToSelfGraphType(node.kind);
            const sgId = toSelfGraphEntityId(node.id, sgType);
            idMap.set(node.id, sgId);
            const props = {
                logical_id: String(node.id),
                kind: String(node.kind || 'symbol')
            };
            if (node.path) props.path = String(node.path);
            if (typeof node.tokens === 'number') props.tokens = Math.trunc(node.tokens);
            if (node.validFrom) props.valid_from = String(node.validFrom);
            if (node.retiredAt) props.retired_at = String(node.retiredAt);
            if (typeof node.isCurrent === 'boolean') props.is_current = node.isCurrent;
            if (node.summary || node.content) {
                props.summary = String(node.summary || node.content).slice(0, 4000);
            }
            return {
                id: sgId,
                type: sgType,
                name: String(node.title || node.id),
                aliases: node.id !== node.title ? [String(node.id)] : [],
                properties: props
            };
        });

        const relations = [];
        for (const edge of edges) {
            const fromId = idMap.get(edge.from) || toSelfGraphEntityId(edge.from);
            const toId = idMap.get(edge.to) || toSelfGraphEntityId(edge.to);
            const relType = String(edge.type || 'IMPACTS')
                .toUpperCase()
                .replace(/[^A-Z0-9_]+/g, '_');
            const relInput = {
                from_entity: fromId,
                type: relType,
                to_entity: toId,
                properties: {
                    source_logical_from: String(edge.from),
                    source_logical_to: String(edge.to)
                }
            };
            if (edge.validFrom) relInput.event_time = String(edge.validFrom);
            relations.push(relInput);
        }

        const inserted = toJsonable(
            await graph.insert.facts(
                { entities, relations },
                { source_id: sourceId }
            )
        );

        return okEnvelope(
            `${TOOL_NAME}.sync`,
            `Synced ${inserted.entities.length} entities and ${inserted.relations.length} relations into SelfGraph (${backend}).`,
            scrubSensitiveStrings({
                backend,
                namespace,
                entityCount: inserted.entities.length,
                relationCount: inserted.relations.length,
                warningCount: inserted.warnings.length
            })
        );
    }

    async function retrievePpr({ query, asOf = null, knownAt = null, budgetTokens = 900, depth = 3, strategy = 'ppr' } = {}) {
        const cleanQuery = String(query || '').trim();
        if (!cleanQuery) {
            return errorEnvelope(`${TOOL_NAME}.retrieve`, 'VALIDATION_ERROR', 'query is required');
        }
        const opts = {
            strategy,
            budget_tokens: Number(budgetTokens || 900),
            depth: Number(depth || 3)
        };
        if (asOf) opts.as_of = String(asOf);
        if (knownAt) opts.known_at = String(knownAt);

        const res = toJsonable(await graph.retrieve(cleanQuery, opts));
        return okEnvelope(
            `${TOOL_NAME}.retrieve`,
            `Retrieved ${res.subgraph.entities.length} entities and ${res.subgraph.relations.length} relations via SelfGraph (${res.strategy}).`,
            scrubSensitiveStrings(res)
        );
    }

    async function checkAnswerable({ query, terms = null, asOf = null } = {}) {
        const cleanQuery = String(query || '').trim();
        if (!cleanQuery) {
            return errorEnvelope(`${TOOL_NAME}.check_answerable`, 'VALIDATION_ERROR', 'query is required');
        }
        const opts = {};
        if (Array.isArray(terms) && terms.length > 0) opts.terms = terms.map(String);
        if (asOf) opts.as_of = String(asOf);
        const report = toJsonable(await graph.checkAnswerable(cleanQuery, opts));
        return okEnvelope(
            `${TOOL_NAME}.check_answerable`,
            `SelfGraph answerability verdict: ${report.verdict}.`,
            scrubSensitiveStrings(report)
        );
    }

    async function diffWindow({ since, until = null } = {}) {
        if (!since) {
            return errorEnvelope(`${TOOL_NAME}.diff`, 'VALIDATION_ERROR', 'since is required');
        }
        const diffRes = toJsonable(await graph.diff(String(since), until ? String(until) : null));
        return okEnvelope(
            `${TOOL_NAME}.diff`,
            `Computed SelfGraph diff since ${since}: +${diffRes.relations_added.length} / -${diffRes.relations_retired.length} relations.`,
            scrubSensitiveStrings(diffRes)
        );
    }

    async function recordActiveRule({ targetLogicalId, decisionLogicalId, title, effectiveAt = null } = {}) {
        const targetSgId = idMap.get(targetLogicalId) || toSelfGraphEntityId(targetLogicalId, 'CodeSymbol');
        const decSgId = idMap.get(decisionLogicalId) || toSelfGraphEntityId(decisionLogicalId, 'AdrRule');
        const facts = {
            entities: [
                { id: targetSgId, type: 'CodeSymbol', name: String(targetLogicalId) },
                { id: decSgId, type: 'AdrRule', name: String(title || decisionLogicalId) }
            ],
            relations: [
                {
                    from_entity: targetSgId,
                    type: 'ACTIVE_RULE_FOR',
                    to_entity: decSgId,
                    ...(effectiveAt ? { event_time: String(effectiveAt) } : {})
                }
            ]
        };
        const res = toJsonable(await graph.insert.facts(facts));
        return okEnvelope(
            `${TOOL_NAME}.supersede`,
            `Updated ACTIVE_RULE_FOR ${targetLogicalId} -> ${decisionLogicalId} (${res.warnings.length} supersede warning(s)).`,
            scrubSensitiveStrings(res)
        );
    }

    async function getStatus() {
        const readiness = toJsonable(await graph.readiness());
        return okEnvelope(
            `${TOOL_NAME}.status`,
            `SelfGraph (${readiness.store}, ns=${readiness.namespace}): ready=${readiness.ready}, ${readiness.counts?.entities ?? 0} entities, ${readiness.counts?.relations ?? 0} relations.`,
            scrubSensitiveStrings({
                sdk: '@hydradb/selfgraph@0.2.1',
                backend,
                readiness,
                tiers: graph.tiers
            })
        );
    }

    async function close() {
        try {
            await graph.close();
        } catch {
            // Ignore close errors
        }
        if (backend === 'kuzu' && kuzuPath) {
            try {
                await KuzuStore.closeDatabase(kuzuPath);
            } catch {
                // Ignore if already closed
            }
        }
        if (tempRoot) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    }

    return {
        backend,
        namespace,
        kuzuPath,
        graph,
        syncHydraScopeGraph,
        retrievePpr,
        checkAnswerable,
        diffWindow,
        recordActiveRule,
        getStatus,
        close
    };
}
