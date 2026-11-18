/**
 * @module connectors/hydradb-client
 * @description Native OpenCypher HTTP connector for HydraDB v0.4.0 (`/v1/graphs/{graph_id}/query`)
 * with deterministic 48-bit SHA-256 surrogate vertex IDs, typed cell decoding, outbound secret/IP
 * scrubbing (`INV-HS-02`), and fast-trip graceful offline fallback (`INV-HS-03`, `INV-LEGO-01`).
 */

import crypto from 'node:crypto';
import { okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { safeFetch } from '@krusch/toolkit/security';
import { FORBIDDEN_OBJECT_KEYS, scrubSensitiveStrings } from '../utils/scrubber.js';

export { scrubSensitiveStrings };

const TOOL_NAME = 'hydrascope.hydradb';
const SAFE_EDGE_TYPE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;
const DEFAULT_SYNC_CONCURRENCY = 8;
const MAX_TRAVERSAL_TARGETS = 24;

/**
 * Map a `(namespace, logicalId)` pair deterministically to a positive 48-bit safe integer
 * in `[1000, 281474976711655]` (`<= 9007199254740000 <= Number.MAX_SAFE_INTEGER`)
 * required by HydraDB v0.4.0 vertex storage.
 *
 * @param {string} namespace - Graph tenant/namespace (or logicalId when called with 1 arg)
 * @param {string} [logicalId] - Logical string identifier for the node
 * @returns {number}
 */
export function surrogateVertexId(namespace, logicalId) {
    const hasTwoArgs = logicalId !== undefined;
    const ns = hasTwoArgs ? String(namespace ?? 'default').trim() || 'default' : 'default';
    const id = hasTwoArgs ? String(logicalId ?? '').trim() : String(namespace ?? '').trim();
    const digest = crypto.createHash('sha256').update(`${ns}\0${id}`, 'utf8').digest();
    return digest.readUIntBE(0, 6) + 1000;
}

/**
 * Decode a single HydraDB v0.4.0 typed cell (`{ type, value }`) into a native JS value.
 *
 * @param {unknown} cell - Raw cell from a HydraDB query row
 * @returns {unknown}
 */
export function decodeHydraCell(cell) {
    if (cell === null || cell === undefined) {
        return null;
    }
    if (typeof cell !== 'object') {
        return cell;
    }
    if (Array.isArray(cell)) {
        return cell.map((entry) => decodeHydraCell(entry));
    }

    const record = /** @type {Record<string, any>} */ (cell);
    if (typeof record.type === 'string') {
        const lowerType = record.type.trim().toLowerCase();
        if (lowerType === 'null' || lowerType === 'none') {
            return null;
        }
        if (
            lowerType === 'int' ||
            lowerType === 'integer' ||
            lowerType === 'int64' ||
            lowerType === 'uint64' ||
            lowerType === 'float' ||
            lowerType === 'float64' ||
            lowerType === 'double' ||
            lowerType === 'number'
        ) {
            if (typeof record.value === 'number') return record.value;
            const parsedNum = Number(record.value);
            return Number.isFinite(parsedNum) ? parsedNum : record.value ?? null;
        }
        if (lowerType === 'bool' || lowerType === 'boolean') {
            if (typeof record.value === 'boolean') return record.value;
            if (record.value === 'true' || record.value === 1) return true;
            if (record.value === 'false' || record.value === 0) return false;
            return Boolean(record.value);
        }
        if (lowerType === 'string' || lowerType === 'str' || lowerType === 'text') {
            return record.value === null || record.value === undefined ? '' : String(record.value);
        }
        if (lowerType === 'list' || lowerType === 'array') {
            const listVal = Array.isArray(record.value)
                ? record.value
                : Array.isArray(record.elements)
                  ? record.elements
                  : [];
            return listVal.map((entry) => decodeHydraCell(entry));
        }
        if (lowerType === 'map' || lowerType === 'object') {
            return decodePlainMap(record.value);
        }
        if (
            lowerType === 'node' ||
            lowerType === 'vertex' ||
            lowerType === 'edge' ||
            lowerType === 'relationship'
        ) {
            const entitySource =
                record.value && typeof record.value === 'object' && !Array.isArray(record.value)
                    ? record.value
                    : record;
            const decodedEntity = {};
            for (const [k, v] of Object.entries(entitySource)) {
                if (FORBIDDEN_OBJECT_KEYS.has(k) || k === 'type') continue;
                if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
                    decodedEntity.properties = decodePlainMap(v);
                } else {
                    decodedEntity[k] = decodeHydraCell(v);
                }
            }
            return decodedEntity;
        }
        if (Object.hasOwn(record, 'value')) {
            return decodeHydraCell(record.value);
        }
    }

    return decodePlainMap(record);
}

/**
 * Decode a plain object map safely without prototype pollution.
 *
 * @param {unknown} rawMap - Candidate object map
 * @returns {Record<string, unknown>}
 */
function decodePlainMap(rawMap) {
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
        return {};
    }
    const out = {};
    for (const [key, val] of Object.entries(rawMap)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) continue;
        out[key] = decodeHydraCell(val);
    }
    return out;
}

/**
 * Decode a HydraDB v0.4.0 `/v1/graphs/{graph_id}/query` JSON payload into normalized
 * `columns`, `rows`, keyed `records`, `readEpoch`, `bookmark`, and `stats`.
 *
 * @param {unknown} payload - Raw parsed JSON response from HydraDB
 * @returns {{
 *   queryId: string|null,
 *   columns: string[],
 *   rows: Array<Array<unknown>>,
 *   records: Array<Record<string, unknown>>,
 *   readEpoch: number|null,
 *   bookmark: string|null,
 *   stats: { rowCount: number, columnCount: number } & Record<string, unknown>
 * }}
 */
export function decodeHydraQueryResult(payload) {
    const body = payload && typeof payload === 'object' ? /** @type {Record<string, any>} */ (payload) : {};
    const queryId =
        typeof body.query_id === 'string'
            ? body.query_id
            : typeof body.queryId === 'string'
              ? body.queryId
              : null;

    const columns = Array.isArray(body.columns) ? body.columns.map((col) => String(col)) : [];
    const rawRows = Array.isArray(body.rows) ? body.rows : [];

    const rows = [];
    const records = [];

    for (const rawRow of rawRows) {
        if (Array.isArray(rawRow)) {
            const decodedRow = rawRow.map((cell) => decodeHydraCell(cell));
            rows.push(decodedRow);
            const rowObj = {};
            for (let idx = 0; idx < decodedRow.length; idx += 1) {
                const colName = columns[idx] ?? `col_${idx}`;
                if (!FORBIDDEN_OBJECT_KEYS.has(colName)) {
                    rowObj[colName] = decodedRow[idx];
                }
            }
            records.push(rowObj);
        } else if (rawRow && typeof rawRow === 'object') {
            const decodedMap = decodePlainMap(rawRow);
            const orderedRow =
                columns.length > 0
                    ? columns.map((col) => (Object.hasOwn(decodedMap, col) ? decodedMap[col] : null))
                    : Object.values(decodedMap);
            rows.push(orderedRow);
            records.push(decodedMap);
        }
    }

    const readEpoch =
        typeof body.read_epoch === 'number' && Number.isFinite(body.read_epoch)
            ? body.read_epoch
            : typeof body.readEpoch === 'number' && Number.isFinite(body.readEpoch)
              ? body.readEpoch
              : null;

    const bookmark = typeof body.bookmark === 'string' && body.bookmark.length > 0 ? body.bookmark : null;
    const rawStats =
        body.stats && typeof body.stats === 'object' && !Array.isArray(body.stats) ? body.stats : {};

    return {
        queryId,
        columns,
        rows,
        records,
        readEpoch,
        bookmark,
        stats: {
            ...decodePlainMap(rawStats),
            rowCount: rows.length,
            columnCount: columns.length,
        },
    };
}

/**
 * Sanitize header value against CR/LF injection.
 *
 * @param {unknown} raw - Header candidate
 * @returns {string}
 */
function cleanHeaderToken(raw) {
    return String(raw ?? '').replace(/[\r\n]+/g, '').trim();
}

/**
 * Strip `null`, `undefined`, and non-finite numeric values from Cypher parameter maps
 * because HydraDB v0.4.0 rejects `null` property values.
 *
 * @param {unknown} rawParams - Candidate Cypher parameter dictionary
 * @returns {Record<string, unknown>}
 */
function sanitizeCypherParameters(rawParams) {
    if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
        return {};
    }
    const cleanValue = (val) => {
        if (val === null || val === undefined) return undefined;
        if (typeof val === 'number') {
            return Number.isFinite(val) ? val : undefined;
        }
        if (typeof val === 'string' || typeof val === 'boolean') {
            return val;
        }
        if (Array.isArray(val)) {
            return val.map((item) => cleanValue(item)).filter((item) => item !== undefined);
        }
        if (typeof val === 'object') {
            const nested = {};
            for (const [k, v] of Object.entries(val)) {
                if (FORBIDDEN_OBJECT_KEYS.has(k)) continue;
                const cleaned = cleanValue(v);
                if (cleaned !== undefined) {
                    nested[k] = cleaned;
                }
            }
            return nested;
        }
        return String(val);
    };

    const clean = {};
    for (const [key, val] of Object.entries(rawParams)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) continue;
        const cleaned = cleanValue(val);
        if (cleaned !== undefined) {
            clean[key] = cleaned;
        }
    }
    return clean;
}

/**
 * Normalize and validate an edge label against `/^[A-Z][A-Z0-9_]{1,31}$/`.
 *
 * @param {unknown} rawType - Candidate relationship label
 * @returns {string|null}
 */
function normalizeSafeEdgeType(rawType) {
    const candidate = String(rawType ?? '')
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_');
    return SAFE_EDGE_TYPE_RE.test(candidate) ? candidate : null;
}

/**
 * Check whether an error code indicates a transport/connectivity failure that should trip fast.
 *
 * @param {string|undefined} code - Error envelope code
 * @returns {boolean}
 */
function isTransportTripError(code) {
    return (
        code === 'FETCH_FAILED' ||
        code === 'FETCH_ABORTED' ||
        code === 'SSRF_PRIVATE_IP' ||
        code === 'SSRF_DNS_FAILED' ||
        code === 'SSRF_INVALID_URL' ||
        code === 'SSRF_BLOCKED_PROTOCOL' ||
        code === 'SSRF_HOST_NOT_ALLOWED'
    );
}

/**
 * Create a HydraDB v0.4.0 OpenCypher HTTP connector (`INV-HS-01`, `INV-HS-02`, `INV-HS-03`).
 *
 * @param {object} [options={}] - Client configuration
 * @param {string} [options.baseUrl=''] - HydraDB HTTP(S) base URL (e.g., `http://127.0.0.1:8443`)
 * @param {string} [options.token=''] - Optional Bearer auth token
 * @param {string} [options.graphId='hydrascope'] - Target HydraDB graph identifier
 * @param {string} [options.cellId='cell-0'] - Target HydraDB storage cell identifier
 * @param {string} [options.namespace='default'] - `X-Graph-Namespace` header and vertex ID salt
 * @param {boolean} [options.allowPrivateLan=false] - Permit RFC1918 LAN endpoints via `safeFetch`
 * @param {boolean} [options.allowTailscale=false] - Permit Tailscale CGNAT (`100.64.0.0/10`) via `safeFetch`
 * @param {number} [options.timeoutMs=2500] - Per-request timeout in milliseconds
 * @param {typeof fetch} [options.fetchImpl] - Optional `fetch` override for deterministic testing
 * @param {Function|null} [options.lookupFn=null] - Optional DNS lookup override forwarded to `safeFetch`
 */
export function createHydraOpenCypherClient(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const cleanBaseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl.trim().replace(/\/+$/, '') : '';
    const cleanToken = cleanHeaderToken(opts.token).replace(/^Bearer\s+/i, '');
    const safeGraphId = cleanHeaderToken(opts.graphId) || 'hydrascope';
    const safeCellId = cleanHeaderToken(opts.cellId) || 'cell-0';
    const safeNamespace = cleanHeaderToken(opts.namespace) || 'default';
    const allowPrivateLan = opts.allowPrivateLan === true;
    const allowTailscale = opts.allowTailscale === true;
    const rawTimeout = Number(opts.timeoutMs);
    const safeTimeoutMs =
        Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.max(50, Math.trunc(rawTimeout)) : 2500;
    const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : undefined;
    const lookupFn = typeof opts.lookupFn === 'function' ? opts.lookupFn : null;

    let lastBookmark = null;
    let lastReadEpoch = null;

    const buildSafeFetchOptions = () => ({
        timeoutMs: safeTimeoutMs,
        maxRedirects: 0,
        allowPrivateLan,
        allowTailscale,
        ...(lookupFn ? { lookupFn } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
        tool: TOOL_NAME,
    });

    const buildHeaders = ({ includeContentType = true } = {}) => {
        /** @type {Record<string, string>} */
        const headers = {
            Accept: 'application/json',
            'X-Graph-Namespace': safeNamespace,
        };
        if (includeContentType) {
            headers['Content-Type'] = 'application/json';
        }
        if (cleanToken.length > 0) {
            headers.Authorization = `Bearer ${cleanToken}`;
        }
        return headers;
    };

    /**
     * Check whether a live HydraDB `baseUrl` has been configured.
     *
     * @returns {boolean}
     */
    function isConfigured() {
        return cleanBaseUrl.length > 0;
    }

    /**
     * Probe `GET ${baseUrl}/healthz` and report live vs. `embedded_graph_fallback` operating mode.
     *
     * @returns {Promise<ReturnType<typeof okEnvelope>>}
     */
    async function healthz() {
        if (!isConfigured()) {
            return okEnvelope(
                TOOL_NAME,
                'HydraDB baseUrl unconfigured; operating in embedded_graph_fallback mode',
                {
                    configured: false,
                    healthy: false,
                    mode: 'embedded_graph_fallback',
                    graphId: safeGraphId,
                    cellId: safeCellId,
                    namespace: safeNamespace,
                    latencyMs: 0,
                }
            );
        }

        const startedAt = performance.now();
        const fetchRes = await safeFetch(
            `${cleanBaseUrl}/healthz`,
            {
                method: 'GET',
                headers: buildHeaders({ includeContentType: false }),
            },
            buildSafeFetchOptions()
        );
        const latencyMs = Number((performance.now() - startedAt).toFixed(2));

        if (!fetchRes.ok) {
            return okEnvelope(
                TOOL_NAME,
                'HydraDB health probe unreachable; using embedded_graph_fallback mode',
                {
                    configured: true,
                    healthy: false,
                    mode: 'embedded_graph_fallback',
                    graphId: safeGraphId,
                    cellId: safeCellId,
                    namespace: safeNamespace,
                    latencyMs,
                    errorCode: fetchRes.error?.code || 'FETCH_FAILED',
                    reason: /** @type {string} */ (
                        scrubSensitiveStrings(fetchRes.error?.message || 'Health probe failed')
                    ),
                }
            );
        }

        const status = Number(fetchRes.data.status) || 0;
        let parsed = null;
        try {
            const rawText = await fetchRes.data.response.text();
            parsed = rawText.trim() ? JSON.parse(rawText) : null;
        } catch {
            parsed = null;
        }

        const isOk =
            status >= 200 &&
            status < 300 &&
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed.status === 'ok' || parsed.ok === true);

        if (!isOk) {
            return okEnvelope(
                TOOL_NAME,
                `HydraDB healthz returned status ${status}; using embedded_graph_fallback mode`,
                {
                    configured: true,
                    healthy: false,
                    mode: 'embedded_graph_fallback',
                    graphId: safeGraphId,
                    cellId: safeCellId,
                    namespace: safeNamespace,
                    latencyMs,
                    httpStatus: status,
                }
            );
        }

        return okEnvelope(TOOL_NAME, 'HydraDB v0.4.0 OpenCypher endpoint healthy', {
            configured: true,
            healthy: true,
            mode: 'hydradb_opencypher_live',
            graphId: safeGraphId,
            cellId: safeCellId,
            namespace: safeNamespace,
            latencyMs,
        });
    }

    /**
     * Execute a parameterized OpenCypher query against `POST /v1/graphs/{graph_id}/query`.
     *
     * @param {string} cypher - OpenCypher statement
     * @param {Record<string, unknown>} [parameters={}] - Query parameters (nulls stripped)
     * @returns {Promise<ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>>}
     */
    async function queryCypher(cypher, parameters = {}) {
        if (typeof cypher !== 'string' || cypher.trim().length === 0) {
            return errorEnvelope(
                'INVALID_CYPHER',
                'OpenCypher query must be a non-empty string',
                null,
                TOOL_NAME
            );
        }

        if (!isConfigured()) {
            return errorEnvelope(
                'HYDRADB_NOT_CONFIGURED',
                'HydraDB baseUrl is not configured',
                { mode: 'embedded_graph_fallback', graphId: safeGraphId },
                TOOL_NAME
            );
        }

        const cleanParams = sanitizeCypherParameters(parameters);
        const endpoint = `${cleanBaseUrl}/v1/graphs/${encodeURIComponent(safeGraphId)}/query`;
        const requestBody = JSON.stringify({
            cell_id: safeCellId,
            query: cypher.trim(),
            parameters: cleanParams,
        });

        const startedAt = performance.now();
        const fetchRes = await safeFetch(
            endpoint,
            {
                method: 'POST',
                headers: buildHeaders({ includeContentType: true }),
                body: requestBody,
            },
            buildSafeFetchOptions()
        );
        const latencyMs = Number((performance.now() - startedAt).toFixed(2));

        if (!fetchRes.ok) {
            const safeMsg = /** @type {string} */ (
                scrubSensitiveStrings(fetchRes.error?.message || 'HydraDB query transport failed')
            );
            const safeDetails = scrubSensitiveStrings({
                ...(fetchRes.error?.details && typeof fetchRes.error.details === 'object'
                    ? fetchRes.error.details
                    : {}),
                graphId: safeGraphId,
                latencyMs,
            });
            return errorEnvelope(
                fetchRes.error?.code || 'FETCH_FAILED',
                safeMsg,
                safeDetails,
                TOOL_NAME
            );
        }

        const status = Number(fetchRes.data.status) || 0;
        let rawText = '';
        try {
            rawText = await fetchRes.data.response.text();
        } catch (err) {
            return errorEnvelope(
                'HYDRADB_READ_FAILED',
                /** @type {string} */ (
                    scrubSensitiveStrings(err?.message || 'Failed reading HydraDB response body')
                ),
                { graphId: safeGraphId, latencyMs },
                TOOL_NAME
            );
        }

        let parsed = null;
        if (rawText.trim().length > 0) {
            try {
                parsed = JSON.parse(rawText);
            } catch {
                return errorEnvelope(
                    'HYDRADB_INVALID_JSON',
                    `HydraDB returned malformed JSON (HTTP ${status})`,
                    scrubSensitiveStrings({
                        status,
                        graphId: safeGraphId,
                        preview: rawText.slice(0, 200),
                        latencyMs,
                    }),
                    TOOL_NAME
                );
            }
        }

        if (status < 200 || status >= 300) {
            const remoteReason =
                (parsed && typeof parsed === 'object'
                    ? parsed.error?.message || parsed.message || parsed.detail || parsed.error
                    : null) ||
                rawText.slice(0, 240) ||
                `HTTP ${status}`;
            return errorEnvelope(
                'HYDRADB_QUERY_ERROR',
                /** @type {string} */ (
                    scrubSensitiveStrings(`HydraDB query failed (${status}): ${String(remoteReason)}`)
                ),
                scrubSensitiveStrings({ status, graphId: safeGraphId, latencyMs }),
                TOOL_NAME
            );
        }

        const decoded = decodeHydraQueryResult(parsed || {});
        if (decoded.bookmark !== null) {
            lastBookmark = decoded.bookmark;
        }
        if (decoded.readEpoch !== null) {
            lastReadEpoch = decoded.readEpoch;
        }

        return okEnvelope(
            TOOL_NAME,
            `Executed OpenCypher query (${decoded.records.length} row(s) in ${latencyMs}ms)`,
            {
                queryId: decoded.queryId,
                columns: decoded.columns,
                rows: decoded.rows,
                records: decoded.records,
                readEpoch: decoded.readEpoch,
                bookmark: decoded.bookmark,
                stats: decoded.stats,
                latencyMs,
            }
        );
    }

    /**
     * Write nodes and directed edges into HydraDB v0.4.0 via standalone `MERGE` statements
     * with bounded concurrency (`8` per batch) and single-probe fast-trip offline fallback.
     *
     * @param {object} [snapshot={}] - Graph snapshot
     * @param {Array<Record<string, any>>} [snapshot.nodes=[]] - Graph nodes
     * @param {Array<Record<string, any>>} [snapshot.edges=[]] - Directed graph edges
     * @returns {Promise<ReturnType<typeof okEnvelope>>}
     */
    async function syncGraphSnapshot({ nodes = [], edges = [] } = {}) {
        const safeNodes = Array.isArray(nodes) ? nodes : [];
        const safeEdges = Array.isArray(edges) ? edges : [];

        const rootVertexId = surrogateVertexId(safeNamespace, 'workspace:root');
        const baseNodeCypher =
            'MERGE (root:WorkspaceRoot {id: $rootId, namespace: $ns})-[:CONTAINS]->(n:GraphNode {id: $id, namespace: $ns, logicalId: $logicalId, kind: $kind, title: $title, path: $path, isCurrent: $isCurrent})';

        const vertexIdByLogicalId = new Map();
        const nodeOps = [];
        const nodeCypherSet = new Set();
        for (const rawNode of safeNodes) {
            if (!rawNode || typeof rawNode !== 'object') continue;
            const logicalId = String(rawNode.logicalId ?? rawNode.id ?? '').trim();
            if (!logicalId) continue;
            const vertexId =
                Number.isSafeInteger(rawNode.surrogateId) &&
                rawNode.surrogateId >= 1000 &&
                rawNode.surrogateId <= Number.MAX_SAFE_INTEGER
                    ? rawNode.surrogateId
                    : Number.isSafeInteger(rawNode.vertexId) &&
                        rawNode.vertexId >= 1000 &&
                        rawNode.vertexId <= Number.MAX_SAFE_INTEGER
                      ? rawNode.vertexId
                      : surrogateVertexId(safeNamespace, logicalId);
            vertexIdByLogicalId.set(logicalId, vertexId);
            const kind = String(rawNode.kind ?? rawNode.type ?? rawNode.label ?? 'Artifact').trim() || 'Artifact';
            const title = String(rawNode.title ?? rawNode.name ?? logicalId).trim() || logicalId;
            const nodePath = String(rawNode.path ?? rawNode.filePath ?? logicalId).trim() || logicalId;
            const isCurrent =
                typeof rawNode.isCurrent === 'boolean' ? rawNode.isCurrent : !rawNode.retiredAt;

            const propEntries = [
                'id: $id',
                'namespace: $ns',
                'logicalId: $logicalId',
                'kind: $kind',
                'title: $title',
                'path: $path',
                'isCurrent: $isCurrent',
            ];
            /** @type {Record<string, unknown>} */
            const parameters = {
                rootId: rootVertexId,
                ns: safeNamespace,
                id: vertexId,
                logicalId,
                kind,
                title,
                path: nodePath,
                isCurrent,
            };

            const summaryText =
                typeof rawNode.summary === 'string' && rawNode.summary.trim()
                    ? rawNode.summary.trim()
                    : '';
            if (summaryText) {
                propEntries.push('summary: $summary');
                parameters.summary = summaryText;
            }
            const retiredAtText =
                typeof rawNode.retiredAt === 'string' && rawNode.retiredAt.trim()
                    ? rawNode.retiredAt.trim()
                    : '';
            if (retiredAtText) {
                propEntries.push('retiredAt: $retiredAt');
                parameters.retiredAt = retiredAtText;
            }
            const supersededByText =
                typeof rawNode.supersededBy === 'string' && rawNode.supersededBy.trim()
                    ? rawNode.supersededBy.trim()
                    : '';
            if (supersededByText) {
                propEntries.push('supersededBy: $supersededBy');
                parameters.supersededBy = supersededByText;
            }

            // HydraDB v0.4.0 Rust OpenCypher engine requires standalone MERGE property maps without trailing SET clauses
            const statementCypher = `MERGE (root:WorkspaceRoot {id: $rootId, namespace: $ns})-[:CONTAINS]->(n:GraphNode {${propEntries.join(', ')}})`;
            nodeCypherSet.add(statementCypher);
            nodeOps.push({
                cypher: statementCypher,
                parameters,
            });
        }

        const edgeOps = [];
        const distinctEdgeTypes = new Set();
        for (const rawEdge of safeEdges) {
            if (!rawEdge || typeof rawEdge !== 'object') continue;
            const fromLogicalId = String(
                rawEdge.fromLogicalId ?? rawEdge.from ?? rawEdge.source ?? ''
            ).trim();
            const toLogicalId = String(
                rawEdge.toLogicalId ?? rawEdge.to ?? rawEdge.target ?? ''
            ).trim();
            const safeType = normalizeSafeEdgeType(
                rawEdge.type ?? rawEdge.kind ?? rawEdge.relation ?? rawEdge.label
            );
            if (!fromLogicalId || !toLogicalId || !safeType) continue;
            distinctEdgeTypes.add(safeType);

            edgeOps.push({
                cypher: `MERGE (a:GraphNode {id: $fromId, namespace: $ns, logicalId: $fromLogicalId})-[:${safeType}]->(b:GraphNode {id: $toId, namespace: $ns, logicalId: $toLogicalId})`,
                parameters: {
                    ns: safeNamespace,
                    fromId:
                        vertexIdByLogicalId.get(fromLogicalId) ??
                        surrogateVertexId(safeNamespace, fromLogicalId),
                    fromLogicalId,
                    toId:
                        vertexIdByLogicalId.get(toLogicalId) ??
                        surrogateVertexId(safeNamespace, toLogicalId),
                    toLogicalId,
                },
            });
        }

        const cypherStatements = [
            ...(nodeOps.length > 0 ? [...(nodeCypherSet.size > 0 ? nodeCypherSet : [baseNodeCypher])] : []),
            ...[...distinctEdgeTypes].map(
                (t) =>
                    `MERGE (a:GraphNode {id: $fromId, namespace: $ns, logicalId: $fromLogicalId})-[:${t}]->(b:GraphNode {id: $toId, namespace: $ns, logicalId: $toLogicalId})`
            ),
        ];

        if (!isConfigured()) {
            return okEnvelope(
                TOOL_NAME,
                'HydraDB unconfigured; graph snapshot retained in embedded_graph_fallback mode',
                {
                    liveSynced: false,
                    mode: 'embedded_graph_fallback',
                    graphId: safeGraphId,
                    nodesWritten: 0,
                    edgesWritten: 0,
                    cypherStatements,
                    lastBookmark,
                    lastReadEpoch,
                    latencyMs: 0,
                }
            );
        }

        const startedAt = performance.now();

        if (nodeOps.length === 0 && edgeOps.length === 0) {
            const probe = await healthz();
            const latencyMs = Number((performance.now() - startedAt).toFixed(2));
            const isHealthy = Boolean(probe.data?.healthy);
            return okEnvelope(
                TOOL_NAME,
                isHealthy
                    ? 'Empty graph snapshot verified against live HydraDB'
                    : 'HydraDB unreachable; empty snapshot retained in embedded_graph_fallback mode',
                {
                    liveSynced: isHealthy,
                    mode: isHealthy ? 'hydradb_opencypher_live' : 'embedded_graph_fallback',
                    graphId: safeGraphId,
                    nodesWritten: 0,
                    edgesWritten: 0,
                    cypherStatements,
                    lastBookmark,
                    lastReadEpoch,
                    latencyMs,
                }
            );
        }

        let nodesWritten = 0;
        let edgesWritten = 0;

        // Probe with the very first operation before fanning out so offline endpoints fail fast without stalling.
        const firstIsNode = nodeOps.length > 0;
        const firstOp = firstIsNode ? nodeOps[0] : edgeOps[0];
        const firstRes = await queryCypher(firstOp.cypher, firstOp.parameters);
        if (!firstRes.ok) {
            const latencyMs = Number((performance.now() - startedAt).toFixed(2));
            return okEnvelope(
                TOOL_NAME,
                'HydraDB sync probe failed; operating in embedded_graph_fallback mode',
                {
                    liveSynced: false,
                    mode: 'embedded_graph_fallback',
                    graphId: safeGraphId,
                    nodesWritten: 0,
                    edgesWritten: 0,
                    cypherStatements,
                    lastBookmark,
                    lastReadEpoch,
                    fallbackReason: /** @type {string} */ (
                        scrubSensitiveStrings(firstRes.error?.message || 'Initial sync probe failed')
                    ),
                    latencyMs,
                }
            );
        }

        if (firstIsNode) {
            nodesWritten += 1;
        } else {
            edgesWritten += 1;
        }

        const remainingNodes = firstIsNode ? nodeOps.slice(1) : [];
        let trippedError = null;

        for (let i = 0; i < remainingNodes.length; i += DEFAULT_SYNC_CONCURRENCY) {
            const chunk = remainingNodes.slice(i, i + DEFAULT_SYNC_CONCURRENCY);
            const results = await Promise.all(
                chunk.map((op) => queryCypher(op.cypher, op.parameters))
            );
            for (const res of results) {
                if (res.ok) {
                    nodesWritten += 1;
                } else if (!trippedError && isTransportTripError(res.error?.code)) {
                    trippedError = res.error;
                }
            }
            if (trippedError) break;
        }

        const remainingEdges = firstIsNode ? edgeOps : edgeOps.slice(1);
        if (!trippedError) {
            for (let i = 0; i < remainingEdges.length; i += DEFAULT_SYNC_CONCURRENCY) {
                const chunk = remainingEdges.slice(i, i + DEFAULT_SYNC_CONCURRENCY);
                const results = await Promise.all(
                    chunk.map((op) => queryCypher(op.cypher, op.parameters))
                );
                for (const res of results) {
                    if (res.ok) {
                        edgesWritten += 1;
                    } else if (!trippedError && isTransportTripError(res.error?.code)) {
                        trippedError = res.error;
                    }
                }
                if (trippedError) break;
            }
        }

        const latencyMs = Number((performance.now() - startedAt).toFixed(2));
        if (trippedError) {
            return okEnvelope(
                TOOL_NAME,
                'HydraDB connection interrupted mid-sync; switched to embedded_graph_fallback',
                {
                    liveSynced: false,
                    mode: 'embedded_graph_fallback',
                    graphId: safeGraphId,
                    nodesWritten,
                    edgesWritten,
                    cypherStatements,
                    lastBookmark,
                    lastReadEpoch,
                    fallbackReason: /** @type {string} */ (
                        scrubSensitiveStrings(trippedError.message || 'Transport interrupted')
                    ),
                    latencyMs,
                }
            );
        }

        return okEnvelope(
            TOOL_NAME,
            `Synced ${nodesWritten} node(s) and ${edgesWritten} edge(s) to HydraDB v0.4.0`,
            {
                liveSynced: true,
                mode: 'hydradb_opencypher_live',
                graphId: safeGraphId,
                nodesWritten,
                edgesWritten,
                cypherStatements,
                lastBookmark,
                lastReadEpoch,
                latencyMs,
            }
        );
    }

    /**
     * Execute live parameterized OpenCypher multi-hop traversal across `:IMPACTS*1..maxHops`,
     * `:GOVERNS`, `:SUPERSEDES`, `:READS_ENV`, `:TOUCHED`, and `:TUNED_IN` in HydraDB v0.4.0.
     *
     * @param {object} [params={}] - Traversal parameters
     * @param {string[]} [params.seedLogicalIds=[]] - Seed logical node identifiers
     * @param {string[]} [params.seedIds] - Alias for `seedLogicalIds`
     * @param {number} [params.maxHops=3] - Bounded `:IMPACTS` hop depth (`1..6`)
     * @param {string|null} [params.asOf=null] - Optional ISO timestamp for historical supersession replay
     * @returns {Promise<ReturnType<typeof okEnvelope>>}
     */
    async function traverseMultiHop({ seedLogicalIds = [], seedIds, maxHops = 3, asOf = null } = {}) {
        const rawSeeds =
            Array.isArray(seedLogicalIds) && seedLogicalIds.length > 0
                ? seedLogicalIds
                : Array.isArray(seedIds)
                  ? seedIds
                  : [];

        const cleanSeeds = [];
        const seenSeeds = new Set();
        for (const item of rawSeeds) {
            const logical = String(item ?? '').trim();
            if (logical && !seenSeeds.has(logical)) {
                seenSeeds.add(logical);
                cleanSeeds.push(logical);
            }
        }

        const hops = Math.min(6, Math.max(1, Math.trunc(Number(maxHops) || 3)));
        const cypherImpacts = `MATCH (s:GraphNode {id: $seedId})-[:IMPACTS*1..${hops}]->(d:GraphNode) WHERE d.id <> $seedId RETURN d.id AS vertexId, d.logicalId AS logicalId, d.kind AS kind, d.title AS title, d.isCurrent AS isCurrent`;
        const cypherGoverns =
            'MATCH (g:GraphNode)-[:GOVERNS]->(t:GraphNode {id: $targetId}) RETURN g.logicalId AS govId, g.isCurrent AS isCurrent';
        const cypherGovernsOut =
            'MATCH (g:GraphNode {id: $targetId})-[:GOVERNS]->(t:GraphNode) RETURN t.logicalId AS governedId, t.isCurrent AS isCurrent';
        const cypherSupersedes =
            'MATCH (newer:GraphNode)-[:SUPERSEDES]->(older:GraphNode {id: $docId}) RETURN newer.logicalId AS newerId, older.logicalId AS olderId';
        const cypherSupersedesOut =
            'MATCH (newer:GraphNode {id: $docId})-[:SUPERSEDES]->(older:GraphNode) RETURN newer.logicalId AS newerId, older.logicalId AS olderId';
        const cypherReadsEnv =
            'MATCH (s:GraphNode {id: $targetId})-[:READS_ENV]->(e:GraphNode) RETURN e.logicalId AS envId';
        const cypherReadsEnvIn =
            'MATCH (s:GraphNode)-[:READS_ENV]->(e:GraphNode {id: $targetId}) RETURN s.logicalId AS readerId';
        const cypherTouchedOut =
            'MATCH (s:GraphNode {id: $targetId})-[:TOUCHED]->(t:GraphNode) RETURN t.logicalId AS touchedId';
        const cypherTouchedIn =
            'MATCH (a:GraphNode)-[:TOUCHED]->(t:GraphNode {id: $targetId}) RETURN a.logicalId AS touchedById';
        const cypherTunedIn =
            'MATCH (x:GraphNode)-[:TUNED_IN]->(e:GraphNode {id: $envId}) RETURN x.logicalId AS linkedId';
        const cypherTunedOut =
            'MATCH (x:GraphNode {id: $targetId})-[:TUNED_IN]->(e:GraphNode) RETURN e.logicalId AS envId';

        const plannedStatements = [
            cypherImpacts,
            cypherGoverns,
            cypherSupersedes,
            cypherReadsEnv,
            cypherTouchedOut,
            cypherTunedIn,
        ];

        if (!isConfigured()) {
            return okEnvelope(
                TOOL_NAME,
                'HydraDB unconfigured; returning embedded_graph_fallback traversal plan',
                {
                    liveQueried: false,
                    mode: 'embedded_graph_fallback',
                    graphId: safeGraphId,
                    cypherStatements: plannedStatements,
                    cypherUsed: cypherImpacts,
                    discoveredLogicalIds: [],
                    records: [],
                    lastReadEpoch,
                    lastBookmark,
                    latencyMs: 0,
                }
            );
        }

        if (cleanSeeds.length === 0) {
            return okEnvelope(
                TOOL_NAME,
                'Zero seed logical IDs supplied for HydraDB multi-hop traversal',
                {
                    liveQueried: false,
                    mode: 'hydradb_opencypher_live',
                    graphId: safeGraphId,
                    cypherStatements: [],
                    cypherUsed: '',
                    discoveredLogicalIds: [],
                    records: [],
                    lastReadEpoch,
                    lastBookmark,
                    latencyMs: 0,
                }
            );
        }

        const startedAt = performance.now();
        const executedStatements = new Set();
        const discoveredSet = new Set();
        const allRecords = [];

        const recordDiscovered = (candidate) => {
            if (typeof candidate === 'string') {
                const trimmed = candidate.trim();
                if (trimmed.length > 0) {
                    discoveredSet.add(trimmed);
                }
            }
        };

        const runBatch = async (tasks) => {
            const batchResults = [];
            for (let i = 0; i < tasks.length; i += DEFAULT_SYNC_CONCURRENCY) {
                const slice = tasks.slice(i, i + DEFAULT_SYNC_CONCURRENCY);
                const settled = await Promise.all(
                    slice.map(async (task) => {
                        executedStatements.add(task.cypher);
                        const res = await queryCypher(task.cypher, task.parameters);
                        return { task, res };
                    })
                );
                batchResults.push(...settled);
            }
            return batchResults;
        };

        // Fast-trip probe using the first seed's multi-hop impact query.
        const firstSeed = cleanSeeds[0];
        const firstSeedVertexId = surrogateVertexId(safeNamespace, firstSeed);
        executedStatements.add(cypherImpacts);
        const firstProbe = await queryCypher(cypherImpacts, { seedId: firstSeedVertexId });

        if (!firstProbe.ok) {
            const latencyMs = Number((performance.now() - startedAt).toFixed(2));
            return okEnvelope(
                TOOL_NAME,
                'HydraDB traversal probe failed; operating in embedded_graph_fallback mode',
                {
                    liveQueried: false,
                    mode: 'embedded_graph_fallback',
                    graphId: safeGraphId,
                    cypherStatements: plannedStatements,
                    cypherUsed: cypherImpacts,
                    discoveredLogicalIds: [],
                    records: [],
                    lastReadEpoch,
                    lastBookmark,
                    fallbackReason: /** @type {string} */ (
                        scrubSensitiveStrings(firstProbe.error?.message || 'Traversal probe failed')
                    ),
                    latencyMs,
                }
            );
        }

        for (const rec of firstProbe.data.records) {
            recordDiscovered(rec.logicalId);
            allRecords.push({ relation: 'IMPACTS', seedLogicalId: firstSeed, ...rec });
        }

        // Remaining seeds for :IMPACTS*1..hops plus :TOUCHED on all seeds (e.g., PR -> Symbol).
        const phase1Tasks = [];
        for (let idx = 1; idx < cleanSeeds.length; idx += 1) {
            const seed = cleanSeeds[idx];
            phase1Tasks.push({
                relation: 'IMPACTS',
                anchor: seed,
                cypher: cypherImpacts,
                parameters: { seedId: surrogateVertexId(safeNamespace, seed) },
            });
        }
        for (const seed of cleanSeeds) {
            const targetId = surrogateVertexId(safeNamespace, seed);
            phase1Tasks.push({
                relation: 'TOUCHED_OUT',
                anchor: seed,
                cypher: cypherTouchedOut,
                parameters: { targetId },
            });
            phase1Tasks.push({
                relation: 'TOUCHED_IN',
                anchor: seed,
                cypher: cypherTouchedIn,
                parameters: { targetId },
            });
            phase1Tasks.push({
                relation: 'TUNED_OUT',
                anchor: seed,
                cypher: cypherTunedOut,
                parameters: { targetId },
            });
        }

        const phase1Out = await runBatch(phase1Tasks);
        const touchedFromSeeds = [];
        const envCandidateSet = new Set();

        for (const { task, res } of phase1Out) {
            if (!res.ok) continue;
            for (const rec of res.data.records) {
                if (task.relation === 'IMPACTS') {
                    recordDiscovered(rec.logicalId);
                } else if (task.relation === 'TOUCHED_OUT') {
                    recordDiscovered(rec.touchedId);
                    if (typeof rec.touchedId === 'string' && rec.touchedId.trim()) {
                        touchedFromSeeds.push(rec.touchedId.trim());
                    }
                } else if (task.relation === 'TOUCHED_IN') {
                    recordDiscovered(rec.touchedById);
                } else if (task.relation === 'TUNED_OUT') {
                    recordDiscovered(rec.envId);
                    if (typeof rec.envId === 'string' && rec.envId.trim()) {
                        envCandidateSet.add(rec.envId.trim());
                    }
                }
                allRecords.push({ relation: task.relation, anchor: task.anchor, ...rec });
            }
        }

        // If a PR/Incident seed touched code symbols, expand :IMPACTS*1..hops from those symbols too.
        const extraImpactSeeds = touchedFromSeeds.filter((id) => !seenSeeds.has(id)).slice(0, 8);
        if (extraImpactSeeds.length > 0) {
            const extraOut = await runBatch(
                extraImpactSeeds.map((id) => ({
                    relation: 'IMPACTS',
                    anchor: id,
                    cypher: cypherImpacts,
                    parameters: { seedId: surrogateVertexId(safeNamespace, id) },
                }))
            );
            for (const { task, res } of extraOut) {
                if (!res.ok) continue;
                for (const rec of res.data.records) {
                    recordDiscovered(rec.logicalId);
                    allRecords.push({ relation: task.relation, anchor: task.anchor, ...rec });
                }
            }
        }

        // Collect bounded target set (seeds + reached nodes) for 1-hop governance, env, and incident joins.
        const reachedTargets = [...new Set([...cleanSeeds, ...discoveredSet])].slice(
            0,
            MAX_TRAVERSAL_TARGETS
        );

        const phase2Tasks = [];
        for (const targetLogicalId of reachedTargets) {
            const targetId = surrogateVertexId(safeNamespace, targetLogicalId);
            phase2Tasks.push({
                relation: 'GOVERNS',
                anchor: targetLogicalId,
                cypher: cypherGoverns,
                parameters: { targetId },
            });
            phase2Tasks.push({
                relation: 'GOVERNS_OUT',
                anchor: targetLogicalId,
                cypher: cypherGovernsOut,
                parameters: { targetId },
            });
            phase2Tasks.push({
                relation: 'READS_ENV',
                anchor: targetLogicalId,
                cypher: cypherReadsEnv,
                parameters: { targetId },
            });
            phase2Tasks.push({
                relation: 'READS_ENV_IN',
                anchor: targetLogicalId,
                cypher: cypherReadsEnvIn,
                parameters: { targetId },
            });
            if (!seenSeeds.has(targetLogicalId)) {
                phase2Tasks.push({
                    relation: 'TOUCHED_IN',
                    anchor: targetLogicalId,
                    cypher: cypherTouchedIn,
                    parameters: { targetId },
                });
            }
        }

        const phase2Out = await runBatch(phase2Tasks);
        const docCandidateSet = new Set(cleanSeeds);

        for (const { task, res } of phase2Out) {
            if (!res.ok) continue;
            for (const rec of res.data.records) {
                if (task.relation === 'GOVERNS') {
                    recordDiscovered(rec.govId);
                    if (typeof rec.govId === 'string' && rec.govId.trim()) {
                        docCandidateSet.add(rec.govId.trim());
                    }
                } else if (task.relation === 'GOVERNS_OUT') {
                    recordDiscovered(rec.governedId);
                } else if (task.relation === 'READS_ENV') {
                    recordDiscovered(rec.envId);
                    if (typeof rec.envId === 'string' && rec.envId.trim()) {
                        envCandidateSet.add(rec.envId.trim());
                    }
                } else if (task.relation === 'READS_ENV_IN') {
                    recordDiscovered(rec.readerId);
                } else if (task.relation === 'TOUCHED_IN') {
                    recordDiscovered(rec.touchedById);
                }
                allRecords.push({ relation: task.relation, anchor: task.anchor, ...rec });
            }
        }

        for (const id of reachedTargets) {
            envCandidateSet.add(id);
            docCandidateSet.add(id);
        }

        // Phase 3: `:TUNED_IN` attachments on environment variables + iterative `:SUPERSEDES` lineage.
        const envTargets = [...envCandidateSet].slice(0, MAX_TRAVERSAL_TARGETS);
        if (envTargets.length > 0) {
            const envOut = await runBatch(
                envTargets.map((envLogicalId) => ({
                    relation: 'TUNED_IN',
                    anchor: envLogicalId,
                    cypher: cypherTunedIn,
                    parameters: { envId: surrogateVertexId(safeNamespace, envLogicalId) },
                }))
            );
            for (const { task, res } of envOut) {
                if (!res.ok) continue;
                for (const rec of res.data.records) {
                    recordDiscovered(rec.linkedId);
                    allRecords.push({ relation: task.relation, anchor: task.anchor, ...rec });
                }
            }
        }

        // Follow inbound `:SUPERSEDES` up to 3 hops so chained ADR replacements (e.g. ADR-003 -> ADR-014 -> ADR-025) resolve.
        const checkedDocs = new Set();
        let frontierDocs = [...docCandidateSet].slice(0, MAX_TRAVERSAL_TARGETS);
        for (let depth = 0; depth < 3 && frontierDocs.length > 0; depth += 1) {
            const supTasks = [];
            for (const docLogicalId of frontierDocs) {
                if (checkedDocs.has(docLogicalId)) continue;
                checkedDocs.add(docLogicalId);
                const docId = surrogateVertexId(safeNamespace, docLogicalId);
                supTasks.push({
                    relation: 'SUPERSEDES',
                    anchor: docLogicalId,
                    cypher: cypherSupersedes,
                    parameters: { docId },
                });
                if (depth === 0 && typeof asOf === 'string' && asOf.trim().length > 0) {
                    supTasks.push({
                        relation: 'SUPERSEDES_HISTORICAL',
                        anchor: docLogicalId,
                        cypher: cypherSupersedesOut,
                        parameters: { docId },
                    });
                }
            }
            if (supTasks.length === 0) break;

            const supOut = await runBatch(supTasks);
            const nextFrontier = [];
            for (const { task, res } of supOut) {
                if (!res.ok) continue;
                for (const rec of res.data.records) {
                    if (task.relation === 'SUPERSEDES' && typeof rec.newerId === 'string') {
                        const newerTrimmed = rec.newerId.trim();
                        if (newerTrimmed) {
                            recordDiscovered(newerTrimmed);
                            if (!checkedDocs.has(newerTrimmed)) {
                                nextFrontier.push(newerTrimmed);
                            }
                        }
                    } else if (
                        task.relation === 'SUPERSEDES_HISTORICAL' &&
                        typeof rec.olderId === 'string'
                    ) {
                        recordDiscovered(rec.olderId);
                    }
                    allRecords.push({ relation: task.relation, anchor: task.anchor, ...rec });
                }
            }
            frontierDocs = nextFrontier.slice(0, MAX_TRAVERSAL_TARGETS);
        }

        const cypherStatements = [...executedStatements];
        const discoveredLogicalIds = [...discoveredSet];
        const latencyMs = Number((performance.now() - startedAt).toFixed(2));

        return okEnvelope(
            TOOL_NAME,
            `Traversed ${discoveredLogicalIds.length} node(s) across HydraDB v0.4.0 in ${latencyMs}ms`,
            {
                liveQueried: true,
                mode: 'hydradb_opencypher_live',
                graphId: safeGraphId,
                cypherStatements,
                cypherUsed: cypherStatements[0] || cypherImpacts,
                discoveredLogicalIds,
                records: allRecords,
                lastReadEpoch,
                lastBookmark,
                latencyMs,
            }
        );
    }

    return {
        namespace: safeNamespace,
        graphId: safeGraphId,
        cellId: safeCellId,
        isConfigured,
        healthz,
        queryCypher,
        syncGraphSnapshot,
        traverseMultiHop,
    };
}
