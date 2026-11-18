# HydraScope: Building a Continual-Learning Agent Context Layer on Self-Hosted HydraDB v0.4.0

**Cover Image:** https://krusch.dev/assets/hydrascope_ui_hero.jpg
**Live App:** https://hydrascope.krusch.dev
**Loom Walkthrough:** https://www.loom.com/share/eb71cc14722b4e47a24cd95972261b59
**GitHub Repository:** https://github.com/kruschdev/HydraScope
**Canonical Paper:** https://krusch.dev/articles/hydrascope-agent-context-on-hydradb

---

Preloading 64 MCP tool definitions into an agent's context window burns 12,412 tokens before Turn 1, while flat cosine vector stores retrieve deprecated v1 tools, miss zero-lexical-overlap post-check tools, and burn 5.0 round-trips rediscovering entity IDs on every task.

For the HydraDB Hackathon, I built **HydraScope** on the self-hosted open-source **HydraDB v0.4.0** Rust graph engine (`ghcr.io/hydra-db/hydradb:0.4.0`). By storing skills, 64 MCP tool schemas, temporal `:SUPERSEDES` lineages, and continually learned entity shortcuts in HydraDB, HydraScope:

- Climbs from **85.7% to 100.0% Tool Selection F1** across four continual-learning epochs (versus **25.0%** on 1024d dense vector search).
- Cuts continual execution from **2.5 round-trips in Epoch 1 to 1.0 single-pass turn in Epoch 4** (**5x fewer turns** than the 5.0-turn vector baseline).
- Reduces prompt tokens by **94.2%** (`721` tokens vs `12,412` preloaded).
- Passes **8/8 (100.0%)** multi-hop AST + temporal ADR scenarios (versus **12.5%** on vector search).
- Sustains **416.4 OpenCypher ops/sec** (`P50 = 11.2ms`, `P95 = 40.3ms`) under 8-worker concurrent load.

## Why Flat Vector Search Cannot Serve as an Agent Context Layer

When an engineering team connects an AI agent to eight internal MCP servers (Stripe, General Ledger, Redis, PagerDuty, Vault, PostgreSQL, GitHub, and Audit, totaling 64 tools) alongside a living codebase and Architecture Decision Records (ADRs), both full-window preloading and dense vector retrieval fail structurally:

- **Full-Window Preloading Burns Budget and Attention:** Dumping all 64 JSON tool schemas into every turn consumes `12,412` tokens before the model reads the user prompt, drops tool precision to `4.7%` (61 distractor tools per turn), and leaves deprecated v1 tools sitting inside active context.
- **Zero-Lexical-Overlap Dependencies Defeat Cosine Similarity:** Processing a disputed partner invoice refund (`stripe_v2_idempotent_refund`) requires verifying double-entry cent conservation (`ledger_verify_cent_conservation`) and appending a tamper-evident compliance receipt (`audit_append_signed_receipt`). In real `1024d` `snowflake-arctic-embed2` vector space, those mandatory post-check tools share near-zero vocabulary with *"partner invoice refund"*, so Top-5 vector Tool-RAG misses both tools 100% of the time (`33.3%` recall) and forces `5.00` reactive round-trips.
- **Temporal Supersession Poisoning:** Legacy tools (`stripe_v1_legacy_charge_refund`) and retired ADRs (`ADR-003: SHA-1 webhook check`) share higher keyword overlap with a developer prompt than their v2 replacements (`ADR-014: HMAC-SHA256`), causing cosine search to inject deprecated rules at Rank #1 (`100.0%` poisoning).
- **Amnesia on Resolved Entities:** Even when an agent resolves *"Acme Logistics"* to `acct_partner_99281` on Run 1, a static vector index cannot wire a directed shortcut from the skill to that canonical entity, forcing repeated lookup tool round-trips on every future task.

## How HydraScope Uses HydraDB and SelfGraph Design Principles

I built HydraScope on top of the self-hosted open-source HydraDB v0.4.0 engine (`ghcr.io/hydra-db/hydradb:0.4.0`) and drew directly from SelfGraph's ontology answerability and versioned temporal model across a 4-stage pipeline:

- **Stage 1: Pre-Flight Ontology Answerability Gate (0 LLM Tokens):** Before executing model inference, `checkAnswerable` grounds technical nouns and identifiers against a prototype-safe (`Object.create(null)`) workspace ontology compiled from HydraDB. Queries referencing non-existent subsystems (such as `Kafka` or `Kubernetes HorizontalPodAutoscaler`) are halted pre-flight at zero LLM token cost instead of returning hallucination-inducing nearest neighbors.
- **Stage 2: Single-Query Multi-Hop OpenCypher Traversal:** From grounded entry seeds, HydraScope executes parameterized `MATCH (s:GraphNode {id: $sid})-[:IMPACTS*1..3]->(d:GraphNode)`, `:GOVERNS`, `:READS_ENV`, and `:TUNED_IN` queries against HydraDB's HTTP query port, pulling 2-hop downstream code callers (such as `fee-engine.ts -> settlement-batch.ts -> sox-reconciler.ts`) and mandatory post-check MCP tools in a single pass.
- **Stage 3: Temporal `:SUPERSEDES` Retirement and `asOf` Time-Travel:** Retired tools and ADRs stay in the graph for auditability with `:SUPERSEDES` edges pointing from their active replacements. Queries at `HEAD` automatically filter retired nodes out of the agent window (`0.0%` temporal poisoning), while passing a validated UTC `asOf` date (such as `2026-03-01`) replays the exact rule that governed production on that historical date.
- **Stage 4: Unified `GraphNode` Continual Writeback (`src/engines/agent-context-layer.js`):** Whenever an agent run resolves an entity alias (`"Acme Logistics" -> entity:acct_partner_99281`), HydraScope persists it as a `GraphNode` vertex with `kind: "resolved_entity"` linked directly from the active skill via a 1-hop `:IMPACTS` edge. Unifying tools and resolved entities under `GraphNode` + `:IMPACTS*1..2` lets the next run pull both the exact tool schemas and the pre-resolved entity IDs in one OpenCypher query, dropping lookup tools from the prompt and collapsing execution from `2.5` turns to `1.0` turn.

## Measured Results Against Preload and 1024d Vector Baselines

I evaluated HydraScope across two reproducible benchmark suites plus a concurrent stress runner against live `hydradb:0.4.0` and GPU-backed `snowflake-arctic-embed2` (`1024d`) embeddings. Before Epoch 1 of every continual-learning run, HydraScope executes `MATCH (e:GraphNode {id: $eid}) DETACH DELETE e` against HydraDB so the rising accuracy curve starts from a verified cold graph with zero cross-run state leakage:

**Suite 1: Agent Context Layer (64 MCP Tools across 8 Servers)**
- **Baseline 1 (Preload All 64 Tools):** `100.0%` Recall | `4.7%` Precision | `9.0%` Tool F1 | `100.0%` Deprecated Poison | `2.50` Round-Trips | `12,412` Prompt Tokens
- **Baseline 2 (Dense 1024d Vector Top-5):** `33.3%` Recall | `20.0%` Precision | `25.0%` Tool F1 | `100.0%` Deprecated Poison | `5.00` Round-Trips | `1,132` Prompt Tokens
- **HydraScope Epoch 1 (Cold Graph):** `100.0%` Recall | `75.0%` Precision | `85.7%` Tool F1 | `0.0%` Deprecated Poison | `2.50` Round-Trips | `883` Prompt Tokens
- **HydraScope Epoch 2 (+Resolved Partner):** `100.0%` Recall | `87.5%` Precision | `93.3%` Tool F1 | `0.0%` Deprecated Poison | `1.75` Round-Trips | `802` Prompt Tokens
- **HydraScope Epoch 3 (+Resolved Cluster):** `100.0%` Recall | `93.8%` Precision | `96.8%` Tool F1 | `0.0%` Deprecated Poison | `1.38` Round-Trips | `761` Prompt Tokens
- **HydraScope Epoch 4 (Converged Graph):** `100.0%` Recall | `100.0%` Precision | **`100.0%` Tool F1** | **`0.0%` Deprecated Poison** | **`1.00` Round-Trip** | **`721` Prompt Tokens (`-94.2%`)**

**Suite 2: 8-Scenario Multi-Hop Code AST + Temporal ADR Suite**
- **Baseline A (Full-Repo Stuffing):** `4/8 (50.0%)` Passed | `100.0%` Critical Recall | `100.0%` Temporal Poisoning | `0.0%` Trap Block | `4,813` Mean Tokens
- **Baseline B (Dense 1024d Vector Top-K, k=4):** `1/8 (12.5%)` Passed | `77.8%` Critical Recall | `100.0%` Temporal Poisoning | `0.0%` Trap Block | `1,257` Mean Tokens
- **HydraScope Structural Graph (HydraDB v0.4.0):** **`8/8 (100.0%)` Passed** | **`100.0%` Critical Recall** | **`0.0%` Temporal Poisoning** | **`100.0%` Trap Block** | **`520` Mean Tokens (`-89.2%`)** | **`70.4 ms` Mean Latency**

## Five Real Technical Challenges I Solved Integrating HydraDB v0.4.0

Running real multi-epoch mutations and concurrent stress tests against self-hosted `ghcr.io/hydra-db/hydradb:0.4.0` surfaced five concrete engine constraints that shaped my OpenCypher connector (`src/connectors/hydradb-client.js`) and container stack (`docker-compose.yml`):

**Challenge 1: One-Hop Directed Edge Patterns in Query-Engine MERGE**
During my first live load test (64 concurrent operations across 8 workers), 56 read queries succeeded immediately while all 8 standalone node upserts returned HTTP 400:
```text
OpenCypher query is not supported yet: only one-hop edge patterns are executable in Query engine MERGE
```
Similarly, probing `RETURN 1 AS ok` without a `MATCH` clause returned `row execution supports MATCH ... RETURN queries`. I solved this by anchoring every standalone vertex upsert to an idempotent namespace root vertex using a one-hop `:CONTAINS` pattern, turning 100% of node and edge mutations into native one-hop `MERGE` statements:
```cypher
MERGE (root:WorkspaceRoot {id: 1000, namespace: $ns})-[:CONTAINS]->(n:GraphNode {
  id: $id,
  logicalId: $logicalId,
  kind: $kind,
  title: $title,
  path: $path,
  isCurrent: $isCurrent
})
```
Once aligned to one-hop `MERGE` patterns, concurrent stress runs jumped to **64/64 (100.0%) success at 416.4 ops/sec** (`P50 = 11.2ms`, `P95 = 40.3ms`).

**Challenge 2: Safe Integer Surrogate Keys Over JSON HTTP**
HydraDB indexes vertices by positive integer IDs. Over Bolt in SelfGraph, 63-bit `blake2b` surrogate keys work cleanly as native `BigInt` values, but standard JSON HTTP payloads lose IEEE-754 integer precision above `Number.MAX_SAFE_INTEGER` (`2^53 - 1`). I solved this by implementing `surrogateVertexId(namespace, logicalId)` using the first 48 bits of SHA-256 (`digest.readUIntBE(0, 6) + 1000`), yielding a deterministic, collision-resistant integer strictly inside `[1000, 281474976711655]` that round-trips losslessly across JSON, JavaScript, and Rust.

**Challenge 3: Non-Null Property Maps and Epoch Bookmark Decoding**
HydraDB rejects `null` property values on write and wraps returned OpenCypher cells in typed envelopes such as `{"type":"string","value":"alpha"}` (or `{"type":"null"}` with no `value` key), alongside monotonic snapshot bookmarks (`sgk:1:...`). I added a recursive parameter sanitizer that strips `null` and `undefined` fields prior to `POST /v1/graphs/{graph_id}/query`, paired with a null-prototype cell decoder that extracts `read_epoch` and `bookmark` tokens directly into the HydraScope UI inspector.

**Challenge 4: Unprivileged Shared Disk Cache Initialization in Docker Compose**
When minting an initial admin token inside a fresh Docker volume before starting `ghcr.io/hydra-db/hydradb:0.4.0`, a root-owned volume caused HydraDB to exit on startup with `CorruptValue: cannot create the shared disk cache directory: Permission denied (os error 13)` on `/data/node-data-cache/shared`. I added a dedicated one-shot `hydradb-init` service in `docker-compose.yml` that pre-creates writable `/data/store` and `/data/node-data-cache/shared` directories before `hydradb` boots, paired with `service_completed_successfully` health gating so a fresh `docker compose --profile hydradb up -d` comes up healthy on `/healthz` every time.

**Challenge 5: Mutation `RETURN count(<binding>)` Rules and Clean Epoch Resets**
While wiring live continual-learning resets against HydraDB v0.4.0, returning vertex properties after a mutation (such as `MERGE ... RETURN e.id` or `DETACH DELETE e RETURN e.logicalId`) triggered HTTP 400 because HydraDB's mutation planner restricts post-mutation projections to `RETURN count(<binding>)`. At the same time, fuzzing user-supplied ADR supersession titles uncovered a V8 prototype trap: indexing ontology tokens on a plain `{}` object caused words like `"length"` to collide with `Array.prototype.length` via `Object.prototype`. I standardized all write and reset queries on `DETACH DELETE e RETURN count(e) AS deleted` for hermetic Epoch-1 resets, and migrated every ontology and adjacency map to `Object.create(null)` with `Object.hasOwn` guards.

## Why Teams Pay For This: Go-To-Market and Production Fit

An agent context layer only earns a line item on an engineering budget when it reduces direct inference spend or prevents production incidents that vector RAG cannot catch. HydraScope targets three immediate production buyers:

- **Regulated FinTech & Healthcare Agents:** Payment, ledger, and clinical operations teams run strict multi-tool compliance chains (refund -> cent conservation check -> signed audit receipt). HydraScope guarantees `100.0%` post-check tool recall and `0.0%` deprecated v1 API execution while replaying historical `asOf` ADR state during SOX or HIPAA audits.
- **Internal Developer Platforms (50-200+ MCP Tools):** Platform engineering teams aggregating GitHub, Vault, PagerDuty, PostgreSQL, and internal microservice MCPs pay a `12,400+`-token tax on every agent turn. Dropping prompt overhead to `721` tokens (`-94.2%`) and cutting reactive lookup turns from `5.0` to `1.0` lowers frontier LLM API spend by over `10x` at scale.
- **Self-Hosted VPC Sovereignty on HydraDB:** Enterprise security teams refuse to ship proprietary AST call graphs, incident postmortems, and internal customer IDs to multi-tenant SaaS memory wrappers. Because HydraScope runs entirely on open-source `hydradb:0.4.0` inside a private VPC or Kubernetes cluster, zero source code or customer identifiers leave the perimeter.

## Try HydraScope Live or Attach via MCP

Explore the 3-tab interactive Compare, Benchmarks (8-Scenario AST/ADR Suite + 64-Tool Continual-Learning Curve), and Live ADR Studio views at https://hydrascope.krusch.dev, watch the walkthrough at https://www.loom.com/share/eb71cc14722b4e47a24cd95972261b59, or run the full stack locally against self-hosted HydraDB v0.4.0:

```bash
git clone https://github.com/kruschdev/HydraScope.git
cd HydraScope
docker compose --profile hydradb up -d
npm install && npm run build && npm test
node bin/hydrascope.js continual
node bin/hydrascope.js bench
```
