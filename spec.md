# HydraScope Specification (`spec.md`)

> **Track 2 Entry (HydraDB Hackathon)**: *"The context layer for agents, traversing structure instead of burning tokens. One rule: it has to earn its place over a vector store."*

## 1. Problem & Thesis
Coding agents burn `30,000+` tokens per turn stuffing whole files into prompts, or rely on dense vector stores (`top-k` cosine similarity) that fail catastrophically on three structural invariants of real software engineering:
1. **Multi-Hop Blast Radius Blindness (`0%` Lexical Overlap)**: Changing `calculatePartnerFee` breaks `reconcileSoxLedger` 2 hops away (`fee-engine -> settlement-batch -> sox-reconciler`), even though `sox-reconciler` shares zero vocabulary with `"partner fee"`.
2. **Temporal Supersession Poisoning (`Retired ADRs Rank #1`)**: Superseded Architecture Decision Records (`ADR-003: SHA-1 webhook check`) often have higher cosine similarity to a developer prompt than the active replacement (`ADR-014: constant-time HMAC-SHA256`, `SUPERSEDES ADR-003`), causing vector RAG to inject deprecated security rules at rank `#1`.
3. **Cross-Artifact Provenance & Ungrounded Hallucination**: Questions spanning `PR -> Symbol -> Env Key -> Incident` cannot be joined by isolated text chunks, and vector stores always return `top-k` neighbors (`cosine ~0.50`) even when a queried subsystem (e.g., Kafka) does not exist in the architecture.

**HydraScope** compiles codebases (AST symbols, `IMPORTS`, `CALLS`, `READS_ENV`), versioned ADRs (`:SUPERSEDES`, `validFrom`, `retiredAt`), and incidents/PRs (`:TOUCHED`, `:TUNED_IN`) into **HydraDB (`v0.4.0` OpenCypher `:8443`)**, then serves minimum-token structural context slices (`< 900` tokens) with temporal `asOf` time-travel and pre-flight ontology answerability checks over **MCP, CLI, REST API, and an interactive Vector-vs-HydraDB Cockpit**.

---

## 2. Frozen Envelope & Security Invariants
- **`INV-HS-01` (`@krusch/toolkit` Envelopes)**: Every exported engine/connector method and HTTP JSON endpoint returns `{ ok: true, tool, summary, data }` (`okEnvelope`) or `{ ok: false, tool, error: { code, message, details } }` (`errorEnvelope`).
- **`INV-HS-02` (Zero-Leak Public Safety)**: Outbound payloads scrub private RFC1918/Tailscale/loopback IPs, local user-home filesystem paths, emails, and Bearer/secret tokens before slugifying identifiers or returning errors/UI metadata. `.gitignore` excludes `.env`, `data/`, `logs/`, `node_modules/`, `client/dist/`, `GEMINI_INFLIGHT.md`, and `JEAN_SESSION_REVIEW.md`.
- **`INV-HS-03` (Dual-Mode HydraDB `v0.4.0` OpenCypher)**: Every graph write and multi-hop traversal executes real parameterized OpenCypher (`MERGE` + `SET` / `MATCH ... WHERE ... RETURN`) against `ghcr.io/hydra-db/hydradb:0.4.0` (`/v1/graphs/{graph_id}/query`) when configured, scoping `WorkspaceRoot` by `surrogateVertexId(namespace, 'workspace:root')` while mirroring the typed graph in deterministic in-memory/SQLite state so `npx hydrascope bench` and `npm test` (`22/22` tests) also work zero-config offline.
- **`INV-HS-04` (Honest Vector Store Baseline)**: The head-to-head benchmark evaluates a real `1024d` dense cosine vector index (`@krusch/toolkit/embeddings` `snowflake-arctic-embed2:latest` when available, with deterministic character/token n-gram dense L2-normalized embeddings as offline CI fallback, explicitly reporting `embeddingBackend: 'ollama-1024d' | 'deterministic-dense-256d'`).
- **`INV-HS-05` (Temporal Supersession & `asOf` Replay)**: Traversal filters out nodes retired via `:SUPERSEDES` (`retiredAt <= asOf` or `isCurrent === false` when `asOf` is omitted), while preserving historical replay when `asOf` precedes `retiredAt`.

---

## 3. Disjoint Module Architecture & Frozen Exports

### Module A: `src/connectors/hydradb-client.js`
Native OpenCypher HTTP client for `hydra-db/hydradb` (`v0.4.0`).
- `surrogateVertexId(namespace, logicalId)` -> deterministic positive safe integer (`1000..281474976711655` within `Number.MAX_SAFE_INTEGER`, collision-free SHA-256 48-bit integer across Node and Edge shims)
- `decodeHydraCell(cell)` / `decodeHydraQueryResult(payload)`
- `scrubSensitiveStrings(value)`
- `createHydraOpenCypherClient({ baseUrl, token, graphId, cellId, namespace, allowPrivateLan, allowTailscale, timeoutMs, fetchImpl })`:
  - `isConfigured()` -> `boolean`
  - `healthz()` -> Promise<Envelope> (`{ configured, healthy, mode, graphId, latencyMs }`)
  - `queryCypher(cypher, parameters)` -> Promise<Envelope> (`{ columns, rows, records, stats, latencyMs }`)
  - `syncGraphSnapshot({ nodes, edges })` -> Promise<Envelope> (batches `MERGE` statements for nodes and directed edges `:IMPACTS`, `:SUPERSEDES`, `:GOVERNS`, `:READS_ENV`, `:TOUCHED`, `:TUNED_IN` into HydraDB `v0.4.0`, returning `{ liveSynced, mode, nodesWritten, edgesWritten, cypherStatements, latencyMs }`)
  - `traverseMultiHop({ seedIds, maxHops, asOf })` -> Promise<Envelope> (runs parameterized `MATCH (s:GraphNode {id: $seedId})-[:IMPACTS*1..3]->(d:GraphNode) WHERE d.id <> $seedId RETURN ...` + `:GOVERNS` / `:SUPERSEDES` lookup on HydraDB `v0.4.0`, returning `{ liveQueried, mode, cypherUsed, records, latencyMs }`)

### Module B: `src/corpus/fintech-fixture.js` & `src/engines/repo-compiler.js`
1. `src/corpus/fintech-fixture.js`:
   - `FINTECH_BENCHMARK_CORPUS`: Realistic 18-artifact multi-hop engineering workspace (`src/billing/fee-engine.ts`, `src/billing/settlement-batch.ts`, `src/compliance/sox-reconciler.ts`, `src/webhooks/stripe-handler.ts`, `src/webhooks/signature-guard.ts`, `src/queue/retry-worker.ts`, `src/auth/session-middleware.ts`, `infra/worker.env.example`, `docs/adr/ADR-003-webhook-sha1.md` [retired], `docs/adr/ADR-014-webhook-hmac-sha256.md` [supersedes ADR-003], `docs/adr/ADR-004-jwt-localstorage.md` [retired], `docs/adr/ADR-019-httponly-session-rotation.md` [supersedes ADR-004], `docs/invariants/INV-FIN-03-cent-conservation.md`, `docs/incidents/INC-204-redis-stall-drop.md`, `docs/prs/PR-412-batch-payout-rounding.md`, plus realistic distractor docs/modules `docs/pricing-faq.md`, `src/billing/invoice-formatter.ts`, `src/billing/currency-display.ts` that share high lexical overlap with queries!).
   - `BENCHMARK_SCENARIOS`: 8 deterministic evaluation tasks across 4 categories (`blast_radius`, `temporal_supersession`, `cross_artifact_trace`, `ungrounded_trap`), each defining `{ id, category, title, query, asOf, tokenBudget, requiredNodeIds, forbiddenPoisonNodeIds, expectAnswerable, expectedMissingTerms, explanation }`.
2. `src/engines/repo-compiler.js`:
   - `estimateTokens(text)` -> `number` (`Math.ceil(bytes / 4)`)
   - `compileArtifactsToGraph(artifacts, { workspaceName })` -> `{ workspaceName, nodes, edges, ontology, totalRepoTokens }`
   - `compileDirectoryToGraph(targetDir, { maxFiles })` -> scans real `.js/.ts/.jsx/.tsx/.py/.md/.env.example` files on disk, extracting exported symbols, relative `import`/`require`/`from` edges, `process.env.X` / `os.environ` `:READS_ENV` edges, and Markdown `Supersedes:` / `Governs:` frontmatter into the exact same `{ workspaceName, nodes, edges, ontology, totalRepoTokens }` graph model!

### Module C: `src/engines/structural-retriever.js` & `src/engines/vector-benchmark.js`
1. `src/engines/structural-retriever.js`:
   - `checkAnswerable(graph, query)` -> Envelope `{ answerable, groundedTerms, synonymMatches, missingTerms, reason }` (grounds domain nouns/identifiers against `graph.ontology` symbols, node titles, env vars, and synonyms; rejects ungrounded subsystem traps like `"Kafka"`, `"GraphQL"`, `"Kubernetes"` at `0` LLM tokens!)
   - `traverseStructuralContext(graph, { query, asOf, tokenBudget, maxHops, hydraClient })` -> Promise<Envelope> returning `{ answerability, seedNodes, traversedNodes, traversedEdges, retiredBlockedNodes, contextText, tokenCount, fullRepoTokens, tokenSavingsRatio, cypherQuery, hydraExecution }`
   - `supersedeDecisionInGraph(graph, { oldId, newId, title, content, governsIds, effectiveAt, hydraClient })` -> Promise<Envelope> (live mutation adding a new `:Decision` with `:SUPERSEDES` edge to `oldId` and syncing to HydraDB!)
2. `src/engines/vector-benchmark.js`:
   - `buildVectorIndex(graph, { preferOllama, ollamaHost, model })` -> Promise<VectorIndex> (uses `@krusch/toolkit/embeddings` `embedBatch` on configured `OLLAMA_EMBED_HOST` `snowflake-arctic-embed2:latest` with 2.5s timeout and deterministic 256d L2-normalized character/word n-gram fallback)
   - `queryVectorTopK(vectorIndex, query, { topK, tokenBudget })` -> Promise<VectorResult> (`{ rankedChunks, contextText, tokenCount, embeddingBackend, latencyMs }`)
   - `compareQueryHeadToHead({ graph, vectorIndex, hydraClient, query, asOf, tokenBudget, topK })` -> Promise<Envelope> (side-by-side comparison for the UI Arena!)
   - `runBenchmarkSuite({ graph, vectorIndex, hydraClient, scenarios })` -> Promise<Envelope> (executes all 8 scenarios across `Full-Repo Stuffing`, `Dense Vector Top-K`, and `HydraDB Structural Graph`, computing aggregate `criticalRecallPct`, `temporalPoisoningPct`, `hallucinationTrapBlockPct`, `meanTokens`, `tokenReductionVsStuffing`, `tokenReductionVsVector`, and per-scenario breakdowns!)

### Module D: `src/engines/brick-ontology-bridge.js` (4-Axis Brick Ontology Bridge)
Connects HydraScope as Pillar 2 of the [Common Ground · HydraScope · DEADBOLT Ontology Triad](https://krusch.dev/articles/ontological-brick-exchange-deadbolt-common-ground-hydrascope) alongside [`0xANUSHKA/common-ground-8090`](https://github.com/0xANUSHKA/common-ground-8090), [`@krusch/toolkit/brick-exchange`](https://github.com/kruschdev/toolkit), and [`kruschdev/deadbolt`](https://github.com/kruschdev/deadbolt):
- `BRICK_ONTOLOGY_EDGE_TYPES`: Frozen 10-edge schema (`TARGETS_STACK`, `CONSUMES_PORT`, `PRODUCES_PORT`, `BRIDGES_CHANNEL`, `ROUTES_TO_MODEL`, `USES_STACK`, `LISTENS_CHANNEL`, `REQUIRES_PORT`, `SUPERSEDES`, `GOVERNS`) spanning the 4 ontology axes (`SoftwareStack`, `DataPort`, `Channel`, `MoEProfile`).
- `compileExchangeSnapshotToHydraGraph(snapshot, { workspaceName, namespace })` -> compiles sealed brick bundles and org profiles with deterministic 48-bit SHA-256 `surrogateId`s, pre-slugification Zero-Leak scrubbing, qualified `brickId@hash` / 64-hex `sourceHash` `:SUPERSEDES` resolution, same-`orgId` isolation, and cycle guards while preserving repository AST edges in Mode 1.
- `mergeOntologyIntoRepoGraph(repoGraph, ontologyGraph)` -> non-destructively wires `brick:<brickId>@<hash> -[:GOVERNS]-> file:bricks/<brickId>/index.(js|ts)` anchored to repo-root `^bricks/`.
- `syncAndQueryBrickOntology(...)` -> executes 1-hop brick ranking, bounded 2-hop `PRODUCES_PORT -> CONSUMES_PORT` pipeline discovery (`MAX_ONTOLOGY_BRICKS = 512`, `MAX_ONTOLOGY_NODES = 2048`, `MAX_ONTOLOGY_EDGES = 8192`, port-indexed consumers, top-256 cap) with port-namespace collision blocking, `:GOVERNS` -> downstream repository AST caller traversal (`downstreamRepoCallers`), UTC-normalized `asOf` historical lineage filtering, and optional `syncToHydra` (default `true` on explicit ingest/direct sync, `false` inside read-only `runtime.queryBrickOntology` / `POST /api/ontology/query` / `hydrascope_traverse_context`).

### Module E: Choke Points (Wired by Orchestrator)
- `src/server.js`: HTTP API (`GET /api/state`, `POST /api/arena/compare`, `POST /api/benchmark/run`, `POST /api/decisions/supersede`, `POST /api/workspace/ingest-dir`, `POST /api/ontology/ingest`, `POST /api/ontology/query`) + static serving of `client/dist`.
- `src/mcp/hydrascope-mcp.js`: 6-tool stdio MCP server (`@krusch/toolkit/mcp` `defineMcpTool` + `createMcpServer`, 4-boolean annotations, `HYDRASCOPE_MCP_TOOLS.length === 6`).
- `bin/hydrascope.js`: Zero-boilerplate CLI (`defineCli` from `@krusch/toolkit/cli`: `bench`, `query`, `check`, `ingest`, `mcp`, `serve`).
- `client/src/App.jsx`, `client/src/components/HydraScopeCockpit.jsx`, `client/src/components/CompareTab.jsx`, & `client/src/components/BenchmarksAndStudioTabs.jsx`: Minimal 3-tab (`Compare`, `Benchmarks`, `Studio`) prompt-first dark UI with 4 plain-English example presets, 3-stat verdict bar, side-by-side Vector Search vs. HydraDB Graph results, 3-step SVG dependency diagram, unified 8-task + 64-tool continual benchmarks, ADR supersession studio, and collapsible technical inspectors.
