# Install `HydraScope`

These are instructions for a coding agent (Claude Code, Codex, Cursor, Windsurf, or Antigravity) that a person asked to install and configure `HydraScope` (`kruschdev/HydraScope`) on their machine or connect to their IDE.

`HydraScope` is a Node 22+ ESM live agent context layer with a React/Vite 3-tab UI (`http://127.0.0.1:4190`), a benchmark and traversal CLI (`bin/hydrascope.js`), and a 6-tool stdio MCP server (`src/mcp/hydrascope-mcp.js`) backed by embedded `@hydradb/selfgraph` (`KuzuStore`) or self-hosted HydraDB (`v0.4.0`).

## 1. Check Prerequisites First (All at Once)

Run one read-only check before making any changes:

```bash
id -u
node -v 2>/dev/null || echo "MISSING: node"
npm -v 2>/dev/null || echo "MISSING: npm"
git --version 2>/dev/null || echo "MISSING: git"
ss -ltnp 2>/dev/null | grep -E ':4190\b' || lsof -iTCP:4190 -sTCP:LISTEN 2>/dev/null || echo "PORT_4190_FREE"
docker compose version 2>/dev/null || echo "OPTIONAL_MISSING: docker-compose"
ollama --version 2>/dev/null || echo "OPTIONAL_MISSING: ollama"
```

Evaluate the results:
1. **User check**: If `id -u` prints `0` (root), stop and ask the person to run you under a normal non-root user account.
2. **Node.js `>= 22.0.0` (Required)**: `HydraScope` uses Node 22 ESM and built-in `node:sqlite`. If `node -v` is missing or older than `v22.0.0`, ask the person before installing or switching to Node 22 (`nvm install 22` or `fnm use 22`).
3. **Port `4190` check**: Confirm port `4190` is free before starting the web server (`PORT` in `.env` can be adjusted if `4190` is already occupied).
4. **Docker & Ollama (Strictly Optional)**: Neither is required for Mode A. `HydraScope` runs zero-daemon embedded graph traversal plus `KuzuStore` and falls back to a deterministic `256d` hashed n-gram cosine baseline when local Ollama (`snowflake-arctic-embed2:latest`) is offline.

## 2. Choose the Right Setup Mode

- **Mode A: Zero-Docker Embedded Graph + `KuzuStore` Setup (Recommended Default)**: Installs dependencies, builds the 3-tab React/Vite UI, runs the full automated test suite, and starts `HydraScope` on `http://127.0.0.1:4190` with zero Docker containers and zero API keys.
- **Mode B: Optional Self-Hosted `ghcr.io/hydra-db/hydradb:0.4.0` OpenCypher Graph Engine**: Launches the local HydraDB `v0.4.0` engine via Docker Compose (`127.0.0.1:8443` OpenCypher HTTP, `127.0.0.1:7687` Bolt, `127.0.0.1:9090` Admin) and runs the continual-learning and multi-hop benchmarks against live HydraDB.

## 3. Install & Verify

### Mode A: Zero-Docker Embedded Graph + `KuzuStore` Setup (Default)

Clone into the target directory if not already inside a `HydraScope` checkout (check `pwd` first):

```bash
git clone https://github.com/kruschdev/HydraScope.git
cd HydraScope
[ -f .env ] || cp .env.example .env
npm install
npm run build
npm test
```

Start the 3-tab UI (`Compare`, `Benchmarks`, `Studio`) on `http://127.0.0.1:4190` and verify `/health`:

```bash
npm start
# In a separate terminal or background check:
curl -fsS http://127.0.0.1:4190/health
```

### Mode B: Optional Self-Hosted `ghcr.io/hydra-db/hydradb:0.4.0` OpenCypher Graph Engine

Only run Mode B if Docker is running, ports `8443`, `7687`, and `9090` are free (`ss -ltnp 2>/dev/null | grep -E ':(8443|7687|9090)\b' || true`), and the person wants live self-hosted HydraDB `v0.4.0`:

```bash
[ -f .env ] || cp .env.example .env
docker compose --profile hydradb up -d
```

When connecting the host CLI or `npm start` directly to the local `hydradb` container, make sure `HYDRADB_GRAPH_TOKEN` in `.env` matches the local container token (`hydrascope-local-dev-token` by default in `docker-compose.yml`), then run the evaluation suites:

```bash
npm run continual
npm run bench
node ./bin/hydrascope.js load --requests 64 --concurrency 8
node ./bin/hydrascope.js selfgraph "Update per-item partner fee rounding in calculatePartnerFee"
```

## 4. Connect the 6-Tool Stdio MCP Server to the Person's Coding Agent

`src/mcp/hydrascope-mcp.js` exposes 6 tools (`hydrascope_traverse_context`, `hydrascope_check_answerable`, `hydrascope_compare_vector_vs_graph`, `hydrascope_run_benchmark`, `hydrascope_supersede_decision`, and `hydrascope_ingest_directory`). Replace `/absolute/path/to/HydraScope` with the real checkout path from `pwd`, and set `HYDRASCOPE_WORKSPACE_ROOT` to the person's target repository or workspace directory:

- **Claude Code CLI**:
  ```bash
  claude mcp add hydrascope \
    -e HYDRASCOPE_WORKSPACE_ROOT=/absolute/path/to/workspace \
    -- node /absolute/path/to/HydraScope/src/mcp/hydrascope-mcp.js
  ```
- **Cursor (`~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), or Antigravity (`~/.gemini/antigravity/mcp_config.json`)**:
  ```json
  {
    "mcpServers": {
      "hydrascope": {
        "command": "node",
        "args": ["/absolute/path/to/HydraScope/src/mcp/hydrascope-mcp.js"],
        "env": {
          "HYDRASCOPE_WORKSPACE_ROOT": "/absolute/path/to/workspace"
        }
      }
    }
  }
  ```
- **Codex (`~/.codex/config.toml`)**:
  ```toml
  [mcp_servers.hydrascope]
  command = "node"
  args = ["/absolute/path/to/HydraScope/src/mcp/hydrascope-mcp.js"]

  [mcp_servers.hydrascope.env]
  HYDRASCOPE_WORKSPACE_ROOT = "/absolute/path/to/workspace"
  ```

## Never

- **Never run `npm`, `node`, or `git` with `sudo` or as `root`**.
- **Never overwrite an existing `.env` or wipe existing entries in an IDE MCP config file** (`~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.codex/config.toml`); read the file first, merge or update only the `hydrascope` entry, and write it back cleanly.
- **Never invent secrets or admin bearer tokens** (`HYDRASCOPE_ADMIN_TOKEN`) unless the person asks to enable token-gated HTTP Studio mutations.
- **Never start Docker containers** unless the person requested self-hosted `hydradb:0.4.0` and ports `8443`, `7687`, and `9090` are free.

## Tell the Person After

Share a concise setup summary:
1. **Active mode & UI URL**: Confirm whether Mode A (Zero-Docker embedded graph + `KuzuStore`) or Mode B (Docker `hydradb:0.4.0` on `:8443` / `:7687`) is active, and provide `http://127.0.0.1:4190`.
2. **Verification status**: Report the exact `npm test` pass count (plus `npm run continual` and `npm run bench` results if executed).
3. **Configured MCP clients**: List the exact MCP configuration file paths updated and remind the person to reload MCP servers or start a fresh agent session so all 6 `hydrascope_*` tools appear.
4. **First-turn test prompt**: Suggest running `"Call hydrascope_check_answerable and hydrascope_traverse_context to verify HydraScope is connected."`
