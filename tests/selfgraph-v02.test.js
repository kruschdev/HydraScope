import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHydraScopeSelfGraphAdapter } from '../src/connectors/selfgraph-store.js';
import { buildServer } from '../src/server.js';
import { HYDRASCOPE_MCP_TOOLS, createHydraScopeMcp } from '../src/mcp/hydrascope-mcp.js';
import { cli } from '../bin/hydrascope.js';

describe('HydraScope SelfGraph PPR & Bi-Temporal Adapter', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrascope-v02-test-'));
    const cleanups = [];

    after(async () => {
        for (const fn of cleanups.reverse()) {
            await fn();
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('syncs compiled HydraScope workspace into SelfGraph KuzuStore, runs PPR retrieval, and supersedes active rules', async () => {
        const adapter = await createHydraScopeSelfGraphAdapter({
            backend: 'kuzu',
            kuzuPath: path.join(tmpDir, 'adapter.kuzu'),
            namespace: 'hs_v02'
        });
        cleanups.push(() => adapter.close());

        const syncRes = await adapter.syncHydraScopeGraph({
            nodes: [
                { id: 'fn:calculatePartnerFee', kind: 'symbol', title: 'calculatePartnerFee', path: 'src/fees.js', tokens: 120 },
                { id: 'tool:ledger_verify_cent_conservation', kind: 'mcp_tool', title: 'ledger_verify_cent_conservation', tokens: 85 },
                { id: 'adr:ADR-014', kind: 'adr', title: 'ADR-014 HMAC-SHA256 Webhooks', tokens: 95 }
            ],
            edges: [
                { from: 'fn:calculatePartnerFee', to: 'tool:ledger_verify_cent_conservation', type: 'IMPACTS' },
                { from: 'adr:ADR-014', to: 'fn:calculatePartnerFee', type: 'GOVERNS' }
            ]
        });
        assert.equal(syncRes.ok, true);
        assert.equal(syncRes.data.entityCount, 3);
        assert.equal(syncRes.data.relationCount, 2);

        const ppr = await adapter.retrievePpr({ query: 'calculatePartnerFee', strategy: 'ppr' });
        assert.equal(ppr.ok, true);
        assert.ok(ppr.data.subgraph.entities.length >= 2);
        assert.ok(ppr.data.context.includes('calculatePartnerFee'));

        // Verify max_count: 1 supersession on ACTIVE_RULE_FOR
        await adapter.recordActiveRule({
            targetLogicalId: 'fn:calculatePartnerFee',
            decisionLogicalId: 'adr:ADR-014',
            title: 'ADR-014 HMAC-SHA256',
            effectiveAt: '2025-01-01T00:00:00Z'
        });
        const superseded = await adapter.recordActiveRule({
            targetLogicalId: 'fn:calculatePartnerFee',
            decisionLogicalId: 'adr:ADR-025',
            title: 'ADR-025 Ed25519 Signatures',
            effectiveAt: '2026-06-01T00:00:00Z'
        });
        assert.equal(superseded.ok, true);
        assert.ok(superseded.data.warnings.some((w) => w.code === 'relation_superseded'));

        const diff = await adapter.diffWindow({ since: new Date(Date.now() - 60_000).toISOString() });
        assert.equal(diff.ok, true);
        assert.ok(diff.data.relations_added.length >= 1);
    });

    it('preserves 6 MCP tools and serves /api/selfgraph/retrieve and /api/selfgraph/diff', async () => {
        assert.equal(HYDRASCOPE_MCP_TOOLS.length, 6);

        const { server, runtime, close } = await buildServer({
            dbPath: path.join(tmpDir, 'server.db'),
            runtimeOptions: {
                preferOllama: false,
                selfGraphKuzuPath: path.join(tmpDir, 'runtime.kuzu')
            }
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        cleanups.push(async () => {
            await new Promise((resolve) => server.close(resolve));
            await close();
        });

        const retrieveResp = await fetch(`http://127.0.0.1:${port}/api/selfgraph/retrieve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'calculatePartnerFee', strategy: 'ppr' })
        });
        assert.equal(retrieveResp.status, 200);
        const retrieveJson = await retrieveResp.json();
        assert.equal(retrieveJson.ok, true);
        assert.ok(retrieveJson.data.subgraph.entities.length >= 1);

        const statusResp = await fetch(`http://127.0.0.1:${port}/api/selfgraph/status`);
        assert.equal(statusResp.status, 200);
        const statusJson = await statusResp.json();
        assert.equal(statusJson.ok, true);
        assert.equal(statusJson.data.readiness.ready, true);

        const diffResp = await fetch(`http://127.0.0.1:${port}/api/selfgraph/diff`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ since: new Date(Date.now() - 60_000).toISOString() })
        });
        assert.equal(diffResp.status, 200);
        const diffJson = await diffResp.json();
        assert.equal(diffJson.ok, true);

        const mcp = createHydraScopeMcp({ runtime, connect: false });
        assert.ok(mcp);

        const cliLines = [];
        const cliRun = await cli.run(['selfgraph', 'calculatePartnerFee'], {
            stdout: (msg) => cliLines.push(msg),
            stderr: () => {}
        });
        assert.equal(cliRun.exitCode, 0);
        assert.ok(cliLines.some((l) => l.includes('Partner Fee Calculation Engine')));
    });
});
