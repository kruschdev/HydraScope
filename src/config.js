import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, envOr, envInt } from '@krusch/toolkit/config';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = await loadProjectConfig(projectRoot, {
    port: 4190,
    serviceName: 'hydrascope',
    dbPath: './data/hydrascope.db',
    logDir: './logs'
});

function envBool(key, fallback = false) {
    const raw = String(process.env[key] ?? '').trim().toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    return fallback;
}

export const config = Object.freeze({
    projectRoot,
    port: envInt('PORT', baseConfig.port, 4190),
    serviceName: envOr('SERVICE_NAME', baseConfig.serviceName, 'hydrascope'),
    dbPath: envOr('DB_PATH', baseConfig.dbPath, './data/hydrascope.db'),
    logDir: envOr('LOG_DIR', baseConfig.logDir, './logs'),
    hydraUrl: envOr('HYDRADB_GRAPH_URL', '', ''),
    hydraToken: envOr('HYDRADB_GRAPH_TOKEN', '', ''),
    hydraGraphId: envOr('HYDRADB_GRAPH_ID', 'hydrascope', 'hydrascope'),
    hydraCellId: envOr('HYDRADB_CELL_ID', 'cell-0', 'cell-0'),
    hydraNamespace: envOr('HYDRADB_NAMESPACE', 'default', 'default'),
    hydraAllowLan: envBool('HYDRADB_ALLOW_LAN', false),
    hydraAllowTailscale: envBool('HYDRADB_ALLOW_TAILSCALE', false),
    hydraBoltUri: envOr('HYDRADB_BOLT_URI', '', ''),
    selfGraphBackend: envOr('SELFGRAPH_BACKEND', '', ''),
    selfGraphKuzuPath: envOr('SELFGRAPH_KUZU_PATH', '', ''),
    ollamaEmbedHost: envOr('OLLAMA_EMBED_HOST', 'http://127.0.0.1:11434', 'http://127.0.0.1:11434'),
    embedModel: envOr('EMBED_MODEL', 'snowflake-arctic-embed2:latest', 'snowflake-arctic-embed2:latest'),
    adminToken: envOr('HYDRASCOPE_ADMIN_TOKEN', '', '')
});
