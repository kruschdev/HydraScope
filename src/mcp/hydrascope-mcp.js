#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    defineMcpTool,
    createMcpServer,
    okMcpResult,
    errorMcpResult
} from '@krusch/toolkit/mcp';

export const HYDRASCOPE_MCP_TOOLS = Object.freeze([
    defineMcpTool({
        name: 'hydrascope_traverse_context',
        title: 'Traverse Structural Agent Context on HydraDB',
        description:
            'Walks multi-hop AST call/import/env edges and temporal SUPERSEDES lineage in HydraDB to assemble a bounded context slice without burning tokens on full-file stuffing.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Engineering task or question to ground structurally.'
                },
                asOf: {
                    type: 'string',
                    description: 'Optional ISO date (YYYY-MM-DD) for point-in-time historical graph replay.'
                },
                tokenBudget: {
                    type: 'integer',
                    default: 900,
                    description: 'Maximum context token budget.'
                },
                maxHops: {
                    type: 'integer',
                    default: 3,
                    description: 'Maximum structural hops (1 to 4).'
                },
                engine: {
                    type: 'string',
                    enum: ['hydradb', 'selfgraph'],
                    default: 'hydradb',
                    description:
                        'Traversal backend: "hydradb" (default OpenCypher structural retriever) or "selfgraph" (@hydradb/selfgraph Personalized PageRank & asOf/knownAt replay).'
                }
            },
            required: ['query']
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
    }),
    defineMcpTool({
        name: 'hydrascope_check_answerable',
        title: 'Check Pre-Flight Ontology Answerability',
        description:
            'Verifies at zero LLM token cost whether every queried technical subsystem or identifier is grounded in the HydraDB ontology before calling a model.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Candidate user or agent question.'
                }
            },
            required: ['query']
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
    }),
    defineMcpTool({
        name: 'hydrascope_compare_vector_vs_graph',
        title: 'Compare Dense Vector Top-K vs HydraDB Structural Traversal',
        description:
            'Runs a head-to-head comparison between dense cosine similarity and HydraDB structural traversal, reporting missed multi-hop dependencies, superseded ADR poisoning, and token savings.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Engineering task or question to compare.'
                },
                asOf: {
                    type: 'string',
                    description: 'Optional ISO date (YYYY-MM-DD) for temporal evaluation.'
                },
                tokenBudget: {
                    type: 'integer',
                    default: 900,
                    description: 'Token budget for HydraDB structural context.'
                },
                topK: {
                    type: 'integer',
                    default: 4,
                    description: 'Number of dense vector chunks to retrieve.'
                }
            },
            required: ['query']
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
    }),
    defineMcpTool({
        name: 'hydrascope_run_benchmark',
        title: 'Run 8-Task Proof-Over-Vectors Benchmark Suite',
        description:
            'Executes the 8-scenario evaluation suite comparing Full-Repo Stuffing, Dense Vector Store Top-K, and HydraDB Structural Traversal.',
        inputSchema: {
            type: 'object',
            properties: {}
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
    }),
    defineMcpTool({
        name: 'hydrascope_supersede_decision',
        title: 'Supersede Architecture Decision in HydraDB',
        description:
            'Writes a new Architecture Decision Record with a directed SUPERSEDES edge into HydraDB, immediately retiring the superseded rule from active agent context while preserving asOf history.',
        inputSchema: {
            type: 'object',
            properties: {
                oldId: {
                    type: 'string',
                    description: 'Node ID of the decision being retired (e.g. adr:ADR-014).'
                },
                newId: {
                    type: 'string',
                    description: 'Node ID for the new decision (e.g. adr:ADR-025).'
                },
                title: {
                    type: 'string',
                    description: 'Human-readable title of the new decision.'
                },
                content: {
                    type: 'string',
                    description: 'Normative text of the new decision.'
                },
                governsIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Target code or module node IDs governed by this decision.'
                },
                effectiveAt: {
                    type: 'string',
                    description: 'ISO effective date (YYYY-MM-DD).'
                }
            },
            required: ['oldId', 'newId', 'title', 'content']
        },
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
    }),
    defineMcpTool({
        name: 'hydrascope_ingest_directory',
        title: 'Compile Local Repository Directory into HydraDB',
        description:
            'Parses AST symbols, relative imports, environment variable reads, and ADR markdown files from a local directory into HydraDB.',
        inputSchema: {
            type: 'object',
            properties: {
                targetDir: {
                    type: 'string',
                    description:
                        'Absolute or workspace-relative directory path to compile, or "reset" to restore the default FinTech benchmark graph.'
                }
            },
            required: ['targetDir']
        },
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
    })
]);

export function createHydraScopeMcp({ runtime, connect = false } = {}) {
    const handleToolCall = async (name, rawArgs = {}) => {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
        if (!runtime) {
            return errorMcpResult(name, 'RUNTIME_NOT_READY', 'HydraScope runtime is not initialized.');
        }

        try {
            switch (name) {
                case 'hydrascope_traverse_context': {
                    const query = String(args.query || '').trim();
                    if (!query) return errorMcpResult(name, 'INVALID_ARGUMENTS', 'query is required.');
                    const useSelfGraph = String(args.engine || '').trim().toLowerCase() === 'selfgraph';
                    const res =
                        useSelfGraph && typeof runtime.selfGraphRetrieve === 'function'
                            ? await runtime.selfGraphRetrieve({
                                  query,
                                  asOf: args.asOf ? String(args.asOf).trim() : null,
                                  budgetTokens: Number(args.tokenBudget) || 900,
                                  depth: Number(args.maxHops) || 3
                              })
                            : await runtime.traverse({
                                  query,
                                  asOf: args.asOf ? String(args.asOf).trim() : null,
                                  tokenBudget: Number(args.tokenBudget) || 900,
                                  maxHops: Number(args.maxHops) || 3
                              });
                    return res.ok
                        ? okMcpResult(name, res.summary, res.data)
                        : errorMcpResult(name, res.error?.code || 'TRAVERSE_FAILED', res.error?.message || 'Traversal failed');
                }
                case 'hydrascope_check_answerable': {
                    const query = String(args.query || '').trim();
                    if (!query) return errorMcpResult(name, 'INVALID_ARGUMENTS', 'query is required.');
                    const res = runtime.checkAnswerable(query);
                    return res.ok
                        ? okMcpResult(name, res.summary, res.data)
                        : errorMcpResult(name, res.error?.code || 'CHECK_FAILED', res.error?.message || 'Check failed');
                }
                case 'hydrascope_compare_vector_vs_graph': {
                    const query = String(args.query || '').trim();
                    if (!query) return errorMcpResult(name, 'INVALID_ARGUMENTS', 'query is required.');
                    const res = await runtime.compare({
                        query,
                        asOf: args.asOf ? String(args.asOf).trim() : null,
                        tokenBudget: Number(args.tokenBudget) || 900,
                        topK: Number(args.topK) || 4
                    });
                    return res.ok
                        ? okMcpResult(name, res.summary, res.data)
                        : errorMcpResult(name, res.error?.code || 'COMPARE_FAILED', res.error?.message || 'Compare failed');
                }
                case 'hydrascope_run_benchmark': {
                    const res = await runtime.runBenchmark();
                    return res.ok
                        ? okMcpResult(name, res.summary, res.data)
                        : errorMcpResult(name, res.error?.code || 'BENCH_FAILED', res.error?.message || 'Benchmark failed');
                }
                case 'hydrascope_supersede_decision': {
                    const res = await runtime.supersedeDecision({
                        oldId: String(args.oldId || '').trim(),
                        newId: String(args.newId || '').trim(),
                        title: String(args.title || '').trim(),
                        content: String(args.content || '').trim(),
                        governsIds: Array.isArray(args.governsIds) ? args.governsIds : [],
                        effectiveAt: args.effectiveAt ? String(args.effectiveAt).trim() : undefined
                    });
                    return res.ok
                        ? okMcpResult(name, res.summary, res.data)
                        : errorMcpResult(name, res.error?.code || 'SUPERSEDE_FAILED', res.error?.message || 'Supersede failed');
                }
                case 'hydrascope_ingest_directory': {
                    const targetDir = String(args.targetDir || '').trim();
                    if (!targetDir) return errorMcpResult(name, 'INVALID_ARGUMENTS', 'targetDir is required.');
                    const res = await runtime.ingestDirectory(targetDir);
                    return res.ok
                        ? okMcpResult(name, res.summary, res.data)
                        : errorMcpResult(name, res.error?.code || 'INGEST_FAILED', res.error?.message || 'Ingest failed');
                }
                default:
                    return errorMcpResult(name, 'UNKNOWN_TOOL', `Unknown HydraScope tool: ${name}`);
            }
        } catch (err) {
            return errorMcpResult(name, 'HYDRASCOPE_MCP_ERROR', err?.message || String(err));
        }
    };

    return createMcpServer('hydrascope-mcp', '0.1.0', HYDRASCOPE_MCP_TOOLS, handleToolCall, {
        connect,
        strictTools: true
    });
}

function isDirectEntrypoint(metaUrl, argvEntry) {
    if (!argvEntry) return false;
    try {
        return realpathSync(argvEntry) === realpathSync(fileURLToPath(metaUrl));
    } catch {
        return resolve(argvEntry) === resolve(fileURLToPath(metaUrl));
    }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
    const { createHydraScopeRuntime } = await import('../runtime.js');
    const workspaceRoot = String(process.env.HYDRASCOPE_WORKSPACE_ROOT || process.cwd()).trim();
    const runtime = await createHydraScopeRuntime(workspaceRoot ? { projectRoot: workspaceRoot } : {});
    await createHydraScopeMcp({ runtime, connect: true });
}
