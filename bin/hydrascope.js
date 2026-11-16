#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCli } from '@krusch/toolkit/cli';
import { createHydraScopeRuntime } from '../src/runtime.js';
import { createHydraScopeMcp } from '../src/mcp/hydrascope-mcp.js';

export const cli = defineCli({
    name: 'hydrascope',
    version: '0.1.0',
    description: 'HydraScope: Structural Context Layer & Proof-Over-Vectors Benchmark on HydraDB',
    commands: {
        bench: {
            summary: 'Run the 8-scenario Vector Store vs HydraDB Structural Graph benchmark',
            options: {},
            async run({ io, values }) {
                const runtime = await createHydraScopeRuntime();
                const res = await runtime.runBenchmark();
                if (!values.json && res.ok) {
                    const { arms, embeddingBackend, hydraLiveMode, scenarioCount } = res.data;
                    io.stdout(`HydraScope Proof-Over-Vectors Benchmark (${scenarioCount} scenarios)`);
                    io.stdout(`HydraDB Mode: ${hydraLiveMode} | Vector Baseline: ${embeddingBackend}`);
                    io.stdout('');
                    io.stdout(
                        [
                            'Arm                     | Recall % | Poisoned % | Trap Block % | Mean Tokens',
                            '------------------------|----------|------------|--------------|------------',
                            `Full-Repo Stuffing      | ${String(arms.fullStuffing.criticalRecallPct).padStart(7)}% | ${String(arms.fullStuffing.temporalPoisoningPct).padStart(9)}% | ${String(arms.fullStuffing.trapBlockPct).padStart(11)}% | ${String(arms.fullStuffing.meanTokens).padStart(11)}`,
                            `Dense Vector Top-K      | ${String(arms.vectorTopK.criticalRecallPct).padStart(7)}% | ${String(arms.vectorTopK.temporalPoisoningPct).padStart(9)}% | ${String(arms.vectorTopK.trapBlockPct).padStart(11)}% | ${String(arms.vectorTopK.meanTokens).padStart(11)}`,
                            `HydraDB Graph Traversal | ${String(arms.hydraScope.criticalRecallPct).padStart(7)}% | ${String(arms.hydraScope.temporalPoisoningPct).padStart(9)}% | ${String(arms.hydraScope.trapBlockPct).padStart(11)}% | ${String(arms.hydraScope.meanTokens).padStart(11)}`
                        ].join('\n')
                    );
                }
                return res;
            }
        },
        query: {
            summary: 'Traverse structural context for an engineering prompt',
            options: {
                'as-of': { type: 'string' },
                budget: { type: 'string' }
            },
            async run({ positionals, values, io }) {
                const prompt = positionals.join(' ').trim();
                const runtime = await createHydraScopeRuntime();
                const res = await runtime.traverse({
                    query: prompt || 'Update per-item partner fee rounding in calculatePartnerFee',
                    asOf: values['as-of'] || null,
                    tokenBudget: Number(values.budget) || 900
                });
                if (!values.json && res.ok) {
                    io.stdout(res.summary);
                    io.stdout(`Tokens: ${res.data.tokenCount} / ${res.data.fullRepoTokens} full-repo`);
                    io.stdout(res.data.contextText || '(Blocked pre-flight: 0 tokens burned)');
                }
                return res;
            }
        },
        check: {
            summary: 'Check pre-flight ontology answerability at zero LLM token cost',
            options: {},
            async run({ positionals, values, io }) {
                const prompt = positionals.join(' ').trim();
                const runtime = await createHydraScopeRuntime();
                const res = runtime.checkAnswerable(prompt || 'What is the Kafka consumer lag threshold?');
                if (!values.json && res.ok) {
                    io.stdout(`Answerable: ${res.data.answerable} | Missing: ${(res.data.missingTerms || []).join(', ') || 'none'}`);
                }
                return res;
            }
        },
        ingest: {
            summary: 'Compile a local repository directory into HydraDB',
            options: {},
            async run({ positionals, values, io }) {
                const targetDir = positionals[0] || process.cwd();
                const runtime = await createHydraScopeRuntime();
                const res = await runtime.ingestDirectory(targetDir, { allowExternalPaths: true });
                if (!values.json && res.ok) {
                    io.stdout(res.summary);
                }
                return res;
            }
        },
        continual: {
            summary: 'Run the 4-epoch Continual-Learning 64-MCP-Tool & Resolved-Entity evaluation',
            options: {},
            async run({ io, values }) {
                const runtime = await createHydraScopeRuntime();
                const res = await runtime.runContinualEval();
                if (!values.json && res.ok) {
                    io.stdout(res.summary);
                    for (const ep of res.data.epochs) {
                        io.stdout(
                            `  ${ep.label.padEnd(28)} | Tool F1: ${String(ep.toolF1Pct).padStart(5)}% | 1-Turn Ready: ${String(ep.singleTurnAccuracyPct).padStart(5)}% | Round-Trips: ${ep.meanRoundTrips} | Tokens: ${ep.meanPromptTokens}`
                        );
                    }
                }
                return res;
            }
        },
        load: {
            summary: 'Run concurrent OpenCypher load benchmark against self-hosted HydraDB v0.4.0',
            options: {
                requests: { type: 'string' },
                concurrency: { type: 'string' }
            },
            async run({ io, values }) {
                const runtime = await createHydraScopeRuntime();
                const res = await runtime.runLoadTest({
                    totalRequests: Number(values.requests) || 64,
                    concurrency: Number(values.concurrency) || 8
                });
                if (!values.json && res.ok) {
                    io.stdout(res.summary);
                }
                return res;
            }
        },
        mcp: {
            summary: 'Start the HydraScope stdio MCP server',
            options: {},
            async run() {
                const workspaceRoot = String(process.env.HYDRASCOPE_WORKSPACE_ROOT || process.cwd()).trim();
                const runtime = await createHydraScopeRuntime(workspaceRoot ? { projectRoot: workspaceRoot } : {});
                await createHydraScopeMcp({ runtime, connect: true });
                return new Promise(() => {});
            }
        }
    }
});

function isDirectEntrypoint(metaUrl, argvEntry) {
    if (!argvEntry) return false;
    try {
        return realpathSync(argvEntry) === realpathSync(fileURLToPath(metaUrl));
    } catch {
        return resolve(argvEntry) === resolve(fileURLToPath(metaUrl));
    }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
    const { exitCode } = await cli.run();
    if (exitCode !== 0) process.exitCode = exitCode;
}
