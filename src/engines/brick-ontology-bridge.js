/**
 * @module engines/brick-ontology-bridge
 * @description Clean-room Brick Exchange 4-Axis Ontology <-> HydraScope property-graph bridge
 * (`INV-LEGO-36`, `INV-HS-01..05`, `INV-LEGO-01`). Compiles Brick Exchange snapshots or
 * pre-compiled ontology graphs into HydraScope vertices with 48-bit SHA-256 `surrogateId`s,
 * resolves `:SUPERSEDES` lineage, merges `:GOVERNS` links into repository AST graphs,
 * enforces port-namespace isolation (`slack:channel_id` !== `discord:channel_id`), and
 * executes OpenCypher sync + graceful offline fallback traversal.
 */

import { okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { surrogateVertexId, scrubSensitiveStrings } from '../connectors/hydradb-client.js';
import { FORBIDDEN_OBJECT_KEYS, scrubSensitiveText } from '../utils/scrubber.js';
import { normalizeIsoDateOrTimestamp, validateOptionalAsOf } from '../utils/validation.js';

export const MAX_ONTOLOGY_BRICKS = 512;
export const MAX_ONTOLOGY_NODES = 2048;
export const MAX_ONTOLOGY_EDGES = 8192;
export const MAX_TWO_HOP_COMPOSITIONS = 256;

export const BRICK_ONTOLOGY_EDGE_TYPES = Object.freeze([
    'TARGETS_STACK',
    'CONSUMES_PORT',
    'PRODUCES_PORT',
    'BRIDGES_CHANNEL',
    'ROUTES_TO_MODEL',
    'USES_STACK',
    'LISTENS_CHANNEL',
    'REQUIRES_PORT',
    'SUPERSEDES',
    'GOVERNS',
]);

const BRICK_ONTOLOGY_EDGE_SET = new Set(BRICK_ONTOLOGY_EDGE_TYPES);
const REPO_AST_EDGE_SET = new Set([
    'IMPORTS',
    'IMPACTS',
    'CALLS',
    'DEPENDS_ON',
    'READS_ENV',
    'TOUCHED',
    'TUNED_IN',
]);
const ONTOLOGY_NODE_KINDS = new Set([
    'brick',
    'stack',
    'port',
    'channel',
    'moe_profile',
    'org_profile',
    'org',
]);
const HEX_64_RE = /^[0-9a-f]{64}$/i;

const CANONICAL_STACK_META = Object.freeze({
    'node-esm': Object.freeze({
        title: 'Node.js 22 ESM Stack',
        runtimeFamily: 'js',
        requiresWebStandardPurity: false,
        adapterFile: 'binding.js',
    }),
    'typescript-node': Object.freeze({
        title: 'TypeScript Node Service Stack',
        runtimeFamily: 'js',
        requiresWebStandardPurity: false,
        adapterFile: 'binding.ts',
    }),
    'python-fastapi': Object.freeze({
        title: 'Python 3.11+ FastAPI Stack',
        runtimeFamily: 'python',
        requiresWebStandardPurity: false,
        adapterFile: 'binding_adapter.py',
    }),
    'react-vite': Object.freeze({
        title: 'React + Vite Frontend Stack',
        runtimeFamily: 'js',
        requiresWebStandardPurity: true,
        adapterFile: 'binding.js',
    }),
    'cloudflare-edge': Object.freeze({
        title: 'Cloudflare Workers Web-Standards Edge Stack',
        runtimeFamily: 'js',
        requiresWebStandardPurity: true,
        adapterFile: 'binding.js',
    }),
});

const CANONICAL_PORT_META = Object.freeze({
    timeseries_window: Object.freeze({
        title: 'Time-Series Window Port',
        shared: true,
        aliases: Object.freeze(['ts_ms', 'timestamp', 'recorded_at', 'unix_ts', 'val', 'reading', 'measurement', 'metric_value']),
    }),
    ledger_event: Object.freeze({
        title: 'Financial Ledger Event Port',
        shared: true,
        aliases: Object.freeze(['amount_cents', 'amount_minor', 'gross_cents', 'gross', 'tenant_id', 'company_id', 'workspace_id', 'orgId']),
    }),
    webhook_envelope: Object.freeze({
        title: 'Signed Webhook Envelope Port',
        shared: true,
        aliases: Object.freeze(['signature', 'timestamp', 'payload', 'event_id']),
    }),
    audit_record: Object.freeze({
        title: 'Tamper-Evident Audit Record Port',
        shared: true,
        aliases: Object.freeze(['seq', 'actor', 'action', 'entryHash', 'prevHash']),
    }),
    identity_claims: Object.freeze({
        title: 'Authenticated Identity Claims Port',
        shared: true,
        aliases: Object.freeze(['sub', 'tenantId', 'orgId', 'roles']),
    }),
    document_page: Object.freeze({
        title: 'Grounded Document Page Port',
        shared: true,
        aliases: Object.freeze(['pageNumber', 'sectionTitle', 'pageHash', 'content']),
    }),
});

const CANONICAL_CHANNEL_META = Object.freeze({
    'webhook:github': Object.freeze({ title: 'GitHub HMAC Webhook Channel', inboundPorts: Object.freeze(['webhook_envelope']) }),
    'webhook:slack': Object.freeze({ title: 'Slack Signed Webhook Channel', inboundPorts: Object.freeze(['webhook_envelope', 'slack:channel_id']) }),
    'webhook:stripe': Object.freeze({ title: 'Stripe Signed Webhook Channel', inboundPorts: Object.freeze(['webhook_envelope', 'ledger_event']) }),
    'workspace:gmail': Object.freeze({ title: 'Workspace Gmail Channel', inboundPorts: Object.freeze(['document_page']) }),
    'workspace:drive': Object.freeze({ title: 'Workspace Drive Channel', inboundPorts: Object.freeze(['document_page']) }),
    'workspace:calendar': Object.freeze({ title: 'Workspace Calendar Channel', inboundPorts: Object.freeze(['timeseries_window']) }),
    'mcp:stdio': Object.freeze({ title: 'MCP Stdio Transport Channel', inboundPorts: Object.freeze([]) }),
    'http:sse': Object.freeze({ title: 'HTTP Server-Sent Events Channel', inboundPorts: Object.freeze([]) }),
    'telemetry:timeseries': Object.freeze({ title: 'Telemetry Time-Series Channel', inboundPorts: Object.freeze(['timeseries_window']) }),
});

const CANONICAL_MOE_META = Object.freeze({
    'timeseries-cadence-moe': Object.freeze({
        title: 'Time-Series Cadence & Monotonicity MoE Profile',
        dispatchTier: 'L2_HEAVY_MOE',
    }),
    'financial-integer-ledger': Object.freeze({
        title: 'Financial Integer Conservation MoE Profile',
        dispatchTier: 'L2_HEAVY_MOE',
    }),
    'cross-stack-schema-adapter': Object.freeze({
        title: 'Cross-Stack Hexagonal Schema Adapter Profile',
        dispatchTier: 'L1_FAST',
    }),
    'channel-security-normalizer': Object.freeze({
        title: 'Channel HMAC & Replay Security Normalizer Profile',
        dispatchTier: 'TIER_0_DETERMINISTIC',
    }),
});

const UTF8_ENCODER = new TextEncoder();

/**
 * Deterministically estimate UTF-8 token weight (~4 bytes per token, minimum 1 for non-empty content).
 *
 * @param {unknown} text
 * @returns {number}
 */
function estimateTokens(text) {
    const str = String(text ?? '');
    if (!str) return 0;
    return Math.max(1, Math.ceil(UTF8_ENCODER.encode(str).byteLength / 4));
}

/**
 * Check whether `value` is a non-null, non-array plain object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Produce deterministic key-sorted JSON for comparing signed vs top-level ontology objects.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
    }
    const keys = Object.keys(/** @type {Record<string, unknown>} */ (value))
        .filter((k) => !FORBIDDEN_OBJECT_KEYS.has(k) && /** @type {any} */ (value)[k] !== undefined)
        .sort();
    const parts = keys.map(
        (k) => `${JSON.stringify(k)}:${canonicalJson(/** @type {any} */ (value)[k])}`
    );
    return `{${parts.join(',')}}`;
}

/**
 * Extract a valid UTC `YYYY-MM-DD` calendar date from a strict ISO-8601 date or timestamp.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function extractIsoDate(raw) {
    return normalizeIsoDateOrTimestamp(raw);
}

/**
 * Deduplicate and sanitize string lists while blocking prototype-polluting identifiers.
 *
 * @param {unknown} list
 * @returns {string[]}
 */
function uniqueSafeStrings(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of list) {
        const val = typeof entry === 'string'
            ? entry.trim()
            : (isPlainObject(entry) && typeof entry.id === 'string' ? entry.id.trim() : '');
        if (!val || FORBIDDEN_OBJECT_KEYS.has(val) || seen.has(val)) continue;
        seen.add(val);
        out.push(val);
    }
    return out;
}

/**
 * Split identifiers (`camelCase`, `PascalCase`, `snake_case`, `kebab-case`, `ns:slug`) into lowercase tokens.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function splitSearchTokens(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return [];
    const expanded = text
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[/_.:@-]+/g, ' ');
    return expanded.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
}

/**
 * Strip a single leading ontology vertex type prefix (`stack:`, `port:`, `channel:`, `moe:`, `org:`, `brick:`)
 * without stripping internal namespace colons (`slack:channel_id`, `webhook:stripe`).
 *
 * @param {unknown} raw
 * @param {string} expectedPrefix
 * @returns {string}
 */
function normalizeEntitySlug(raw, expectedPrefix) {
    const text = scrubSensitiveText(String(raw ?? '').trim()).trim();
    if (!text) return '';
    const prefixLower = `${expectedPrefix.toLowerCase()}:`;
    const stripped = text.toLowerCase().startsWith(prefixLower)
        ? text.slice(prefixLower.length).trim()
        : text;
    if (!stripped || FORBIDDEN_OBJECT_KEYS.has(stripped) || FORBIDDEN_OBJECT_KEYS.has(stripped.toLowerCase())) {
        return '';
    }
    return stripped;
}

/**
 * Normalize a DataPort slug, preserving any `<namespace>:<portName>` scope (`slack:channel_id`).
 *
 * @param {unknown} rawPort
 * @returns {string}
 */
function normalizePortSlug(rawPort) {
    return normalizeEntitySlug(rawPort, 'port').toLowerCase();
}

/**
 * Parse a normalized DataPort slug into `{ slug, namespace, localName, namespaced }`.
 *
 * @param {unknown} rawPort
 * @returns {{ slug: string, namespace: string | null, localName: string, namespaced: boolean }}
 */
function parsePortScope(rawPort) {
    const slug = normalizePortSlug(rawPort);
    if (!slug) {
        return { slug: '', namespace: null, localName: '', namespaced: false };
    }
    const colonIdx = slug.indexOf(':');
    if (colonIdx > 0 && colonIdx < slug.length - 1) {
        const namespace = slug.slice(0, colonIdx);
        const localName = slug.slice(colonIdx + 1);
        return { slug, namespace, localName, namespaced: true };
    }
    return { slug, namespace: null, localName: slug, namespaced: false };
}

/**
 * Strict port compatibility check enforcing namespace isolation (`slack:channel_id` !== `discord:channel_id`).
 *
 * @param {unknown} portA
 * @param {unknown} portB
 * @returns {{ match: boolean, collision: boolean, reason: string | null }}
 */
function compareDataPorts(portA, portB) {
    const a = parsePortScope(portA);
    const b = parsePortScope(portB);
    if (!a.slug || !b.slug) {
        return { match: false, collision: false, reason: null };
    }
    if (a.namespaced || b.namespaced) {
        if (a.localName === b.localName && a.namespace !== b.namespace) {
            return {
                match: false,
                collision: true,
                reason: `Port namespace collision blocked: "${a.slug}" cannot compose with "${b.slug}"`,
            };
        }
        return { match: a.slug === b.slug, collision: false, reason: null };
    }
    return { match: a.slug === b.slug, collision: false, reason: null };
}

/**
 * Sanitize the `<hash>` component of `brick:<brickId>@<hash>` so it contains only `[A-Za-z0-9_-]`
 * (preventing accidental `EMAIL_RE` redaction on dotted semver strings while preserving hex digests).
 *
 * @param {unknown} rawHash
 * @returns {string}
 */
function sanitizeBrickHashToken(rawHash) {
    const cleaned = String(rawHash ?? '')
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!cleaned) return '';
    return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

/**
 * Compute a deterministic 12-char hex digest for unsealed brick descriptors lacking an explicit `sourceHash`.
 *
 * @param {object} payload
 * @returns {string}
 */
function computeShortBrickDigest(payload) {
    const hi = surrogateVertexId('brick-digest-hi', JSON.stringify(payload))
        .toString(16)
        .padStart(12, '0');
    return hi.slice(0, 12);
}

/**
 * Parse `{ brickId, hash }` from a `brick:<brickId>@<hash>` or `<brickId>@<hash>` identifier.
 *
 * @param {unknown} rawId
 * @returns {{ brickId: string, hash: string }}
 */
function parseBrickLogicalId(rawId) {
    const stripped = normalizeEntitySlug(rawId, 'brick');
    if (!stripped) return { brickId: '', hash: '' };
    const atIdx = stripped.indexOf('@');
    if (atIdx > 0) {
        return {
            brickId: stripped.slice(0, atIdx).trim(),
            hash: sanitizeBrickHashToken(stripped.slice(atIdx + 1)),
        };
    }
    return { brickId: stripped.trim(), hash: '' };
}

/**
 * Normalize an MoE profile slug from either `moe:<slug>`, `moe_profile:<slug>`, or bare `<slug>`.
 *
 * @param {unknown} rawMoe
 * @returns {string}
 */
function normalizeMoeSlug(rawMoe) {
    const strippedProfile = normalizeEntitySlug(rawMoe, 'moe_profile');
    return normalizeEntitySlug(strippedProfile, 'moe').toLowerCase();
}

/**
 * Infer HydraScope ontology vertex `kind` from logical ID prefix when `kind` is omitted.
 *
 * @param {string} id
 * @returns {string}
 */
function inferOntologyNodeKind(id) {
    const lower = String(id || '').toLowerCase();
    if (lower.startsWith('brick:')) return 'brick';
    if (lower.startsWith('stack:')) return 'stack';
    if (lower.startsWith('port:')) return 'port';
    if (lower.startsWith('channel:')) return 'channel';
    if (lower.startsWith('moe:') || lower.startsWith('moe_profile:')) return 'moe_profile';
    if (lower.startsWith('org:')) return 'org';
    return 'ontology_entity';
}

/**
 * Build a deterministic virtual path for an ontology vertex.
 *
 * @param {string} id
 * @param {string} kind
 * @returns {string}
 */
function buildDefaultOntologyPath(id, kind) {
    const cleanId = scrubSensitiveText(String(id || ''));
    if (kind === 'brick' || cleanId.startsWith('brick:')) {
        const { brickId, hash } = parseBrickLogicalId(cleanId);
        const safeBrick = (scrubSensitiveText(brickId) || 'unknown').replace(/[^A-Za-z0-9_-]+/g, '-');
        const suffix = hash ? `@${hash.slice(0, 12)}` : '';
        return `ontology/bricks/${safeBrick}${suffix}.json`;
    }
    const safeSlug = cleanId.replace(/:/g, '/').replace(/[^A-Za-z0-9/_-]+/g, '-');
    return `ontology/${safeSlug}.json`;
}

/**
 * Evaluate whether `node` is active at `asOf` (`!isCurrent` retired nodes excluded unless `asOf < retiredAt`,
 * or when `!node.retiredAt` and `node.isCurrent === false`, inactive unless `supersededBy` node's `validFrom > asOf`).
 *
 * @param {object} node
 * @param {string | null} [asOf=null]
 * @param {Map<string, any> | null} [nodeById=null]
 * @returns {boolean}
 */
function isOntologyNodeActiveAt(node, asOf = null, nodeById = null) {
    if (!node || typeof node !== 'object') return false;
    const asOfCheck = validateOptionalAsOf(asOf);
    const cleanAsOf = asOfCheck.ok ? asOfCheck.value : null;
    const nodeValidFrom = extractIsoDate(node.validFrom);
    const nodeRetiredAt = extractIsoDate(node.retiredAt);
    if (!cleanAsOf) {
        return node.isCurrent !== false && !nodeRetiredAt;
    }
    const validOk = !nodeValidFrom || nodeValidFrom <= cleanAsOf;
    if (!validOk) return false;
    if (nodeRetiredAt) {
        return cleanAsOf < nodeRetiredAt;
    }
    if (node.isCurrent === false) {
        const repl =
            node.supersededBy && nodeById instanceof Map ? nodeById.get(node.supersededBy) : null;
        const replValidFrom = repl ? extractIsoDate(repl.validFrom) : null;
        return Boolean(replValidFrom && replValidFrom > cleanAsOf);
    }
    return true;
}

/**
 * Build a HydraScope-compatible `ontology` lookup dictionary (`{ terms, knownConcepts, synonyms }`)
 * from compiled graph nodes so `checkAnswerable` and `traverseStructuralContext` work out-of-the-box.
 *
 * @param {Array<object>} nodes
 * @returns {{ terms: string[], knownConcepts: string[], synonyms: Record<string, string> }}
 */
function buildHydraOntologyFacet(nodes) {
    const termSet = new Set();
    const conceptSet = new Set();
    /** @type {Record<string, string>} */
    const synonyms = {};

    const addTerm = (raw) => {
        for (const tok of splitSearchTokens(raw)) {
            if (!FORBIDDEN_OBJECT_KEYS.has(tok)) {
                termSet.add(tok);
            }
        }
    };

    for (const node of nodes) {
        if (!node || !node.id) continue;
        addTerm(node.id);
        addTerm(node.title);
        addTerm(node.path);

        if (Array.isArray(node.symbols)) {
            for (const sym of node.symbols) {
                const cleanSym = String(sym ?? '').trim();
                if (!cleanSym || FORBIDDEN_OBJECT_KEYS.has(cleanSym)) continue;
                conceptSet.add(cleanSym);
                addTerm(cleanSym);
                const lowerSym = cleanSym.toLowerCase();
                if (!FORBIDDEN_OBJECT_KEYS.has(lowerSym) && !Object.hasOwn(synonyms, lowerSym)) {
                    synonyms[lowerSym] = node.id;
                }
            }
        }

        if (Array.isArray(node.synonyms)) {
            for (const syn of node.synonyms) {
                const cleanSyn = String(syn ?? '').trim();
                if (!cleanSyn || FORBIDDEN_OBJECT_KEYS.has(cleanSyn)) continue;
                conceptSet.add(cleanSyn);
                addTerm(cleanSyn);
                const lowerSyn = cleanSyn.toLowerCase();
                if (!FORBIDDEN_OBJECT_KEYS.has(lowerSyn) && !Object.hasOwn(synonyms, lowerSyn)) {
                    synonyms[lowerSyn] = node.id;
                }
            }
        }
    }

    return {
        terms: [...termSet].sort(),
        knownConcepts: [...conceptSet].sort(),
        synonyms,
    };
}

/**
 * Compile either a pre-compiled `{ nodes, edges }` ontology graph or a raw Brick Exchange snapshot
 * (`{ bricks, orgProfiles, stacks, ports, channels, moeProfiles }`) into HydraScope's exact
 * property-graph shape with deterministic 48-bit `surrogateId`s, `:SUPERSEDES` retirement chains,
 * and `INV-HS-02` sensitive-string scrubbing.
 *
 * @param {object} [snapshot={}]
 * @param {object} [options={}]
 * @param {string} [options.workspaceName='brick-exchange-ontology']
 * @param {string} [options.namespace='brick-ontology']
 * @returns {object} `INV-LEGO-01` envelope
 */
export function compileExchangeSnapshotToHydraGraph(
    snapshot = {},
    { workspaceName = 'brick-exchange-ontology', namespace = 'brick-ontology' } = {}
) {
    const tool = 'hydrascope.brick_ontology.compile';
    const unwrapped =
        isPlainObject(snapshot) && snapshot.ok === true && isPlainObject(snapshot.data)
            ? snapshot.data
            : snapshot;

    if (!isPlainObject(unwrapped)) {
        return errorEnvelope(
            'INVALID_SNAPSHOT',
            'Brick Exchange ontology snapshot must be a plain object.',
            null,
            tool
        );
    }

    if (Array.isArray(unwrapped.bricks) && unwrapped.bricks.length > MAX_ONTOLOGY_BRICKS) {
        return /** @type {object} */ (
            scrubSensitiveStrings(
                errorEnvelope(
                    'SNAPSHOT_LIMIT_EXCEEDED',
                    `Snapshot bricks count (${unwrapped.bricks.length}) exceeds maximum of ${MAX_ONTOLOGY_BRICKS}.`,
                    { limit: MAX_ONTOLOGY_BRICKS, count: unwrapped.bricks.length },
                    tool
                )
            )
        );
    }
    if (Array.isArray(unwrapped.nodes) && unwrapped.nodes.length > MAX_ONTOLOGY_NODES) {
        return /** @type {object} */ (
            scrubSensitiveStrings(
                errorEnvelope(
                    'SNAPSHOT_LIMIT_EXCEEDED',
                    `Snapshot nodes count (${unwrapped.nodes.length}) exceeds maximum of ${MAX_ONTOLOGY_NODES}.`,
                    { limit: MAX_ONTOLOGY_NODES, count: unwrapped.nodes.length },
                    tool
                )
            )
        );
    }
    if (Array.isArray(unwrapped.edges) && unwrapped.edges.length > MAX_ONTOLOGY_EDGES) {
        return /** @type {object} */ (
            scrubSensitiveStrings(
                errorEnvelope(
                    'SNAPSHOT_LIMIT_EXCEEDED',
                    `Snapshot edges count (${unwrapped.edges.length}) exceeds maximum of ${MAX_ONTOLOGY_EDGES}.`,
                    { limit: MAX_ONTOLOGY_EDGES, count: unwrapped.edges.length },
                    tool
                )
            )
        );
    }

    const safeWorkspaceName =
        scrubSensitiveText(String(workspaceName || unwrapped.workspaceName || 'brick-exchange-ontology').trim()) ||
        'brick-exchange-ontology';
    const safeNamespace =
        scrubSensitiveText(String(namespace || unwrapped.namespace || 'brick-ontology').trim()) ||
        'brick-ontology';

    /** @type {Map<string, any>} */
    const nodeById = new Map();
    /** @type {Map<string, { from: string, to: string, type: string }>} */
    const edgeByKey = new Map();
    /** @type {Map<string, string[]>} */
    const brickAliasIndex = new Map();
    /** @type {Array<{ newerId: string, olderRef: string }>} */
    const pendingSupersedes = [];
    /** @type {object | null} */
    let compileError = null;
    let brickNodeCount = 0;

    const registerBrickAlias = (alias, canonicalId) => {
        const key = String(alias ?? '').trim();
        if (!key || FORBIDDEN_OBJECT_KEYS.has(key)) return;
        for (const variant of [key, key.toLowerCase()]) {
            if (FORBIDDEN_OBJECT_KEYS.has(variant)) continue;
            let bucket = brickAliasIndex.get(variant);
            if (!bucket) {
                bucket = [];
                brickAliasIndex.set(variant, bucket);
            }
            if (!bucket.includes(canonicalId)) {
                bucket.push(canonicalId);
            }
        }
    };

    const upsertNode = (raw) => {
        if (compileError) return null;
        const cleanId = scrubSensitiveText(String(raw.id ?? '').trim());
        if (!cleanId || FORBIDDEN_OBJECT_KEYS.has(cleanId)) return null;
        if (nodeById.has(cleanId)) {
            return nodeById.get(cleanId);
        }

        const kind = scrubSensitiveText(String(raw.kind || inferOntologyNodeKind(cleanId)).trim()) || 'ontology_entity';
        const isBrickNode = kind === 'brick' || cleanId.startsWith('brick:');
        if (isBrickNode && brickNodeCount >= MAX_ONTOLOGY_BRICKS) {
            compileError = errorEnvelope(
                'SNAPSHOT_LIMIT_EXCEEDED',
                `Compiled brick vertex count exceeds maximum of ${MAX_ONTOLOGY_BRICKS}.`,
                { limit: MAX_ONTOLOGY_BRICKS },
                tool
            );
            return null;
        }
        if (nodeById.size >= MAX_ONTOLOGY_NODES) {
            compileError = errorEnvelope(
                'SNAPSHOT_LIMIT_EXCEEDED',
                `Compiled ontology vertex count exceeds maximum of ${MAX_ONTOLOGY_NODES}.`,
                { limit: MAX_ONTOLOGY_NODES },
                tool
            );
            return null;
        }

        const title = scrubSensitiveText(String(raw.title || cleanId).trim()) || cleanId;
        const nodePath = scrubSensitiveText(String(raw.path || buildDefaultOntologyPath(cleanId, kind)).trim());
        const content = scrubSensitiveText(String(raw.content || title).trim());
        const validFrom = extractIsoDate(raw.validFrom) || null;
        const retiredAt = extractIsoDate(raw.retiredAt) || null;
        if (validFrom && retiredAt && retiredAt < validFrom) {
            compileError = errorEnvelope(
                'INVALID_TEMPORAL_WINDOW',
                `Invalid temporal window on "${cleanId}": retiredAt (${retiredAt}) precedes validFrom (${validFrom}).`,
                { id: cleanId, validFrom, retiredAt },
                tool
            );
            return null;
        }

        const candidateSupersededBy = raw.supersededBy
            ? scrubSensitiveText(String(raw.supersededBy).trim())
            : null;
        if (candidateSupersededBy) {
            pendingSupersedes.push({ newerId: candidateSupersededBy, olderRef: cleanId });
        }
        const isCurrent =
            typeof raw.isCurrent === 'boolean'
                ? candidateSupersededBy
                    ? !retiredAt
                    : raw.isCurrent
                : !retiredAt;

        const node = {
            id: cleanId,
            surrogateId: surrogateVertexId(safeNamespace, cleanId),
            kind,
            title,
            path: nodePath,
            content,
            tokens: estimateTokens(content),
            validFrom,
            retiredAt,
            isCurrent,
            supersededBy: null,
        };

        if (Array.isArray(raw.symbols) && raw.symbols.length > 0) {
            node.symbols = uniqueSafeStrings(raw.symbols.map((s) => scrubSensitiveText(s)));
        }
        if (Array.isArray(raw.synonyms) && raw.synonyms.length > 0) {
            node.synonyms = uniqueSafeStrings(raw.synonyms.map((s) => scrubSensitiveText(s)));
        }
        if (typeof raw.brickId === 'string' && raw.brickId.trim()) {
            node.brickId = scrubSensitiveText(raw.brickId.trim());
        }
        if (typeof raw.shared === 'boolean') {
            node.shared = raw.shared;
        }
        if (typeof raw.portNamespace === 'string' && raw.portNamespace) {
            node.portNamespace = scrubSensitiveText(raw.portNamespace);
        }
        if (typeof raw.orgId === 'string' && raw.orgId.trim()) {
            const cleanOrgId = normalizeEntitySlug(raw.orgId, 'org').toLowerCase();
            if (cleanOrgId) {
                node.orgId = cleanOrgId;
            }
        }

        if (isBrickNode) {
            brickNodeCount += 1;
        }
        nodeById.set(cleanId, node);
        return node;
    };

    const addOntologyEdge = (from, to, rawType, extraReason = null) => {
        if (compileError) return;
        const cleanFrom = scrubSensitiveText(String(from ?? '').trim());
        const cleanTo = scrubSensitiveText(String(to ?? '').trim());
        const cleanType = String(rawType ?? '')
            .trim()
            .toUpperCase()
            .replace(/[\s-]+/g, '_');
        if (!cleanFrom || !cleanTo || cleanFrom === cleanTo) return;
        const isOntEdge = BRICK_ONTOLOGY_EDGE_SET.has(cleanType);
        const isRepoEdge = REPO_AST_EDGE_SET.has(cleanType);
        if (!isOntEdge && !isRepoEdge) return;
        const key = `${cleanFrom}|${cleanType}|${cleanTo}`;
        if (!edgeByKey.has(key)) {
            if (edgeByKey.size >= MAX_ONTOLOGY_EDGES) {
                compileError = errorEnvelope(
                    'SNAPSHOT_LIMIT_EXCEEDED',
                    `Compiled ontology edge count exceeds maximum of ${MAX_ONTOLOGY_EDGES}.`,
                    { limit: MAX_ONTOLOGY_EDGES },
                    tool
                );
                return;
            }
            const edgeObj = {
                from: cleanFrom,
                to: cleanTo,
                type: cleanType,
            };
            if (isRepoEdge && typeof extraReason === 'string' && extraReason.trim()) {
                edgeObj.reason = scrubSensitiveText(extraReason.trim());
            }
            edgeByKey.set(key, edgeObj);
        }
    };

    const ensureStackNode = (rawStack, extra = null) => {
        const slug = normalizeEntitySlug(rawStack, 'stack').toLowerCase();
        if (!slug) return null;
        const id = `stack:${slug}`;
        if (!extra && nodeById.has(id)) return nodeById.get(id);
        const meta = extra || {};
        const preset = Object.hasOwn(CANONICAL_STACK_META, slug) ? CANONICAL_STACK_META[slug] : null;
        const title = meta.title || meta.name || preset?.title || `Stack ${slug}`;
        const runtimeFamily = meta.runtimeFamily || preset?.runtimeFamily || 'unknown';
        const purity = Boolean(meta.requiresWebStandardPurity ?? preset?.requiresWebStandardPurity);
        const content =
            meta.content ||
            meta.summary ||
            `${title} (${slug}) | runtimeFamily=${runtimeFamily} | requiresWebStandardPurity=${purity}`;
        return upsertNode({
            id,
            kind: 'stack',
            title,
            path: meta.path || `ontology/stacks/${slug}.json`,
            content,
            symbols: [slug],
            validFrom: meta.validFrom,
            retiredAt: meta.retiredAt,
            isCurrent: meta.isCurrent,
            supersededBy: meta.supersededBy,
        });
    };

    const ensurePortNode = (rawPort, extra = null) => {
        const parsed = parsePortScope(rawPort);
        if (!parsed.slug) return null;
        const id = `port:${parsed.slug}`;
        if (!extra && nodeById.has(id)) return nodeById.get(id);
        const meta = extra || {};
        const preset =
            !parsed.namespaced && Object.hasOwn(CANONICAL_PORT_META, parsed.slug)
                ? CANONICAL_PORT_META[parsed.slug]
                : null;
        const shared =
            typeof meta.shared === 'boolean'
                ? meta.shared
                : parsed.namespaced
                  ? false
                  : Boolean(preset?.shared ?? true);
        const aliases = uniqueSafeStrings([
            ...(Array.isArray(meta.aliases) ? meta.aliases : []),
            ...(Array.isArray(preset?.aliases) ? preset.aliases : []),
        ]);
        const title =
            meta.title ||
            meta.name ||
            preset?.title ||
            (parsed.namespaced ? `Namespaced Port ${parsed.slug}` : `DataPort ${parsed.slug}`);
        const content =
            meta.content ||
            meta.summary ||
            `${title} (${parsed.slug}) | shared=${shared}${parsed.namespace ? ` | namespace=${parsed.namespace}` : ''}${aliases.length > 0 ? ` | aliases=${aliases.join(', ')}` : ''}`;
        return upsertNode({
            id,
            kind: 'port',
            title,
            path: meta.path || `ontology/ports/${parsed.slug.replace(/:/g, '_')}.json`,
            content,
            symbols: [parsed.slug],
            synonyms: aliases,
            shared,
            portNamespace: parsed.namespace || undefined,
            validFrom: meta.validFrom,
            retiredAt: meta.retiredAt,
            isCurrent: meta.isCurrent,
            supersededBy: meta.supersededBy,
        });
    };

    const ensureChannelNode = (rawChannel, extra = null) => {
        const slug = normalizeEntitySlug(rawChannel, 'channel').toLowerCase();
        if (!slug) return null;
        const id = `channel:${slug}`;
        if (!extra && nodeById.has(id)) return nodeById.get(id);
        const meta = extra || {};
        const preset = Object.hasOwn(CANONICAL_CHANNEL_META, slug) ? CANONICAL_CHANNEL_META[slug] : null;
        const title = meta.title || meta.name || preset?.title || `Channel ${slug}`;
        const content = meta.content || meta.summary || `${title} (${slug})`;
        const channelNode = upsertNode({
            id,
            kind: 'channel',
            title,
            path: meta.path || `ontology/channels/${slug.replace(/:/g, '_')}.json`,
            content,
            symbols: [slug],
            validFrom: meta.validFrom,
            retiredAt: meta.retiredAt,
            isCurrent: meta.isCurrent,
            supersededBy: meta.supersededBy,
        });

        const reqPorts = uniqueSafeStrings(meta.requiresPorts || meta.requiredPorts || []);
        for (const p of reqPorts) {
            const pNode = ensurePortNode(p);
            if (channelNode && pNode) {
                addOntologyEdge(channelNode.id, pNode.id, 'REQUIRES_PORT');
            }
        }
        return channelNode;
    };

    const ensureMoeNode = (rawMoe, extra = null) => {
        const slug = normalizeMoeSlug(rawMoe);
        if (!slug) return null;
        const id = `moe:${slug}`;
        if (!extra && nodeById.has(id)) return nodeById.get(id);
        const meta = extra || {};
        const preset = Object.hasOwn(CANONICAL_MOE_META, slug) ? CANONICAL_MOE_META[slug] : null;
        const title = meta.title || meta.name || preset?.title || `MoE Profile ${slug}`;
        const tier = meta.dispatchTier || preset?.dispatchTier || 'L2_HEAVY_MOE';
        const content = meta.content || meta.summary || `${title} (${slug}) | dispatchTier=${tier}`;
        return upsertNode({
            id,
            kind: 'moe_profile',
            title,
            path: meta.path || `ontology/moe/${slug}.json`,
            content,
            symbols: [slug],
            validFrom: meta.validFrom,
            retiredAt: meta.retiredAt,
            isCurrent: meta.isCurrent,
            supersededBy: meta.supersededBy,
        });
    };

    // Mode 1: Pre-compiled ontology graph (`{ nodes, edges }`)
    if (Array.isArray(unwrapped.nodes)) {
        for (const rawNode of unwrapped.nodes) {
            if (compileError) break;
            if (!isPlainObject(rawNode)) continue;
            const rawId = String(rawNode.id ?? rawNode.logicalId ?? '').trim();
            if (!rawId || FORBIDDEN_OBJECT_KEYS.has(rawId)) continue;
            const kind = String(rawNode.kind || rawNode.type || inferOntologyNodeKind(rawId)).trim();
            const parsedBrick = kind === 'brick' || rawId.startsWith('brick:') ? parseBrickLogicalId(rawId) : null;
            const parsedPort = kind === 'port' || rawId.startsWith('port:') ? parsePortScope(rawId) : null;
            const fallbackSymbol =
                parsedBrick?.brickId ||
                (kind === 'moe_profile' ? normalizeMoeSlug(rawId) : normalizeEntitySlug(rawId, kind));

            const created = upsertNode({
                id: rawId,
                kind,
                title: rawNode.title || rawNode.name || rawId,
                path: rawNode.path || buildDefaultOntologyPath(rawId, kind),
                content:
                    rawNode.content ||
                    rawNode.summary ||
                    `${rawNode.title || rawNode.name || rawId} (${rawId})`,
                symbols: Array.isArray(rawNode.symbols)
                    ? rawNode.symbols
                    : [fallbackSymbol].filter(Boolean),
                synonyms: Array.isArray(rawNode.synonyms) ? rawNode.synonyms : [],
                brickId: rawNode.brickId || parsedBrick?.brickId || undefined,
                shared:
                    typeof rawNode.shared === 'boolean'
                        ? rawNode.shared
                        : parsedPort
                          ? !parsedPort.namespaced
                          : undefined,
                portNamespace: rawNode.portNamespace || parsedPort?.namespace || undefined,
                orgId:
                    rawNode.orgId ??
                    rawNode.org ??
                    rawNode.ontology?.orgId ??
                    rawNode.lineage?.orgId ??
                    rawNode.publisher?.orgId,
                validFrom: rawNode.validFrom ?? rawNode.ontology?.validFrom ?? rawNode.createdAt,
                retiredAt: rawNode.retiredAt ?? rawNode.ontology?.retiredAt,
                isCurrent: rawNode.isCurrent,
                supersededBy: rawNode.supersededBy,
            });

            if (created && (kind === 'brick' || created.id.startsWith('brick:'))) {
                registerBrickAlias(created.id, created.id);
                if (parsedBrick?.brickId && parsedBrick.hash) {
                    if (HEX_64_RE.test(parsedBrick.hash)) {
                        registerBrickAlias(parsedBrick.hash, created.id);
                    }
                    registerBrickAlias(`${parsedBrick.brickId}@${parsedBrick.hash}`, created.id);
                    registerBrickAlias(
                        `${parsedBrick.brickId}@${parsedBrick.hash.slice(0, 12)}`,
                        created.id
                    );
                }
                const supRaw = rawNode.supersedes ?? rawNode.ontology?.supersedes;
                const supList = Array.isArray(supRaw) ? supRaw : supRaw ? [supRaw] : [];
                for (const olderRef of uniqueSafeStrings(supList)) {
                    pendingSupersedes.push({ newerId: created.id, olderRef });
                }
            }
        }

        const rawEdges = Array.isArray(unwrapped.edges) ? unwrapped.edges : [];
        for (const edge of rawEdges) {
            if (!isPlainObject(edge)) continue;
            const from = String(edge.from ?? edge.fromLogicalId ?? edge.source ?? '').trim();
            const to = String(edge.to ?? edge.toLogicalId ?? edge.target ?? '').trim();
            const type = String(edge.type ?? edge.kind ?? edge.relation ?? edge.label ?? '')
                .trim()
                .toUpperCase()
                .replace(/[\s-]+/g, '_');
            if (!from || !to) continue;
            if (!BRICK_ONTOLOGY_EDGE_SET.has(type) && !REPO_AST_EDGE_SET.has(type)) continue;
            if (type === 'SUPERSEDES') {
                pendingSupersedes.push({ newerId: from, olderRef: to });
            } else {
                addOntologyEdge(from, to, type, edge.reason || null);
            }
        }
    }

    // Mode 2: Raw Brick Exchange Snapshot (`{ bricks, orgProfiles, stacks, ports, channels, moeProfiles }`)
    const explicitStacks = Array.isArray(unwrapped.stacks) ? unwrapped.stacks : [];
    for (const st of explicitStacks) {
        if (typeof st === 'string') ensureStackNode(st);
        else if (isPlainObject(st)) ensureStackNode(st.id || st.slug || st.name, st);
    }

    const explicitPorts = Array.isArray(unwrapped.ports) ? unwrapped.ports : [];
    for (const pt of explicitPorts) {
        if (typeof pt === 'string') ensurePortNode(pt);
        else if (isPlainObject(pt)) ensurePortNode(pt.id || pt.slug || pt.name, pt);
    }

    const explicitChannels = Array.isArray(unwrapped.channels) ? unwrapped.channels : [];
    for (const ch of explicitChannels) {
        if (typeof ch === 'string') ensureChannelNode(ch);
        else if (isPlainObject(ch)) ensureChannelNode(ch.id || ch.slug || ch.name, ch);
    }

    const explicitMoe = Array.isArray(unwrapped.moeProfiles) ? unwrapped.moeProfiles : [];
    for (const mp of explicitMoe) {
        if (typeof mp === 'string') ensureMoeNode(mp);
        else if (isPlainObject(mp)) ensureMoeNode(mp.id || mp.slug || mp.name, mp);
    }

    const orgProfiles = Array.isArray(unwrapped.orgProfiles)
        ? unwrapped.orgProfiles
        : Array.isArray(unwrapped.orgs)
          ? unwrapped.orgs
          : [];
    for (const org of orgProfiles) {
        if (compileError) break;
        if (!isPlainObject(org)) continue;
        const rawOrgIdent = scrubSensitiveText(String(org.orgId || org.id || org.slug || org.name || '').trim());
        const slug = normalizeEntitySlug(rawOrgIdent, 'org');
        if (!slug) continue;
        const safeOrgSlug = scrubSensitiveText(slug).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        if (!safeOrgSlug || FORBIDDEN_OBJECT_KEYS.has(safeOrgSlug)) continue;
        const orgNodeId = `org:${safeOrgSlug}`;
        const orgStacks = uniqueSafeStrings(org.stacks || org.usesStacks || []);
        const orgChannels = uniqueSafeStrings(org.channels || org.listensChannels || []);
        const orgPorts = uniqueSafeStrings(org.requiredPorts || org.requiresPorts || []);
        const title = scrubSensitiveText(String(org.title || org.name || `Organization ${safeOrgSlug}`).trim());
        const content =
            org.content ||
            org.summary ||
            `${title} (${orgNodeId}) | stacks=${orgStacks.join(', ') || 'none'} | channels=${orgChannels.join(', ') || 'none'} | requiredPorts=${orgPorts.join(', ') || 'none'}`;

        const orgNode = upsertNode({
            id: orgNodeId,
            kind: 'org',
            title,
            path: `ontology/orgs/${safeOrgSlug}.json`,
            content,
            symbols: [safeOrgSlug],
            orgId: safeOrgSlug,
            validFrom: org.validFrom ?? org.createdAt,
            retiredAt: org.retiredAt,
            isCurrent: org.isCurrent,
            supersededBy: org.supersededBy,
        });
        if (!orgNode) continue;

        for (const s of orgStacks) {
            const sn = ensureStackNode(s);
            if (sn) addOntologyEdge(orgNode.id, sn.id, 'USES_STACK');
        }
        for (const c of orgChannels) {
            const cn = ensureChannelNode(c);
            if (cn) addOntologyEdge(orgNode.id, cn.id, 'LISTENS_CHANNEL');
        }
        for (const p of orgPorts) {
            const pn = ensurePortNode(p);
            if (pn) addOntologyEdge(orgNode.id, pn.id, 'REQUIRES_PORT');
        }
    }

    const rawBricks = Array.isArray(unwrapped.bricks) ? unwrapped.bricks : [];
    for (const rawEntry of rawBricks) {
        if (compileError) break;
        if (!isPlainObject(rawEntry)) continue;
        if (
            isPlainObject(rawEntry.bundle) &&
            rawEntry.ontology !== undefined &&
            rawEntry.ontology !== null &&
            isPlainObject(rawEntry.bundle.blueprint?.ontology) &&
            (!isPlainObject(rawEntry.ontology) ||
                canonicalJson(rawEntry.ontology) !== canonicalJson(rawEntry.bundle.blueprint.ontology))
        ) {
            return /** @type {object} */ (
                scrubSensitiveStrings(
                    errorEnvelope(
                        'TAMPERED_ONTOLOGY',
                        'Wrapper brick ontology does not match sealed bundle blueprint.ontology.',
                        { brickId: String(rawEntry.bundle.brickId || rawEntry.bundle.blueprint?.id || '') },
                        tool
                    )
                )
            );
        }

        const rawBrick = isPlainObject(rawEntry.bundle)
            ? {
                  ...rawEntry.bundle,
                  ...(rawEntry.ontology !== undefined && rawEntry.bundle.ontology === undefined
                      ? { ontology: rawEntry.ontology }
                      : {}),
              }
            : rawEntry;

        const hasBlueprintOnt = isPlainObject(rawBrick.blueprint?.ontology);
        const hasTopOnt = isPlainObject(rawBrick.ontology);
        if (hasBlueprintOnt && rawBrick.ontology !== undefined && rawBrick.ontology !== null) {
            if (
                !hasTopOnt ||
                canonicalJson(rawBrick.ontology) !== canonicalJson(rawBrick.blueprint.ontology)
            ) {
                return /** @type {object} */ (
                    scrubSensitiveStrings(
                        errorEnvelope(
                            'TAMPERED_ONTOLOGY',
                            'Unsigned top-level brick ontology does not match sealed blueprint.ontology.',
                            { brickId: String(rawBrick.brickId || rawBrick.blueprint?.id || '') },
                            tool
                        )
                    )
                );
            }
        }

        const ont = hasBlueprintOnt
            ? rawBrick.blueprint.ontology
            : hasTopOnt
              ? rawBrick.ontology
              : {};

        const parsedFromId =
            typeof rawBrick.id === 'string'
                ? parseBrickLogicalId(scrubSensitiveText(rawBrick.id))
                : { brickId: '', hash: '' };
        const rawBrickIdent = scrubSensitiveText(
            String(
                rawBrick.brickId ||
                    rawBrick.blueprint?.id ||
                    parsedFromId.brickId ||
                    rawBrick.name ||
                    ''
            ).trim()
        );
        const brickId = rawBrickIdent
            .replace(/[^A-Za-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!brickId || FORBIDDEN_OBJECT_KEYS.has(brickId)) continue;

        const isSealedBrick =
            rawBrick.format === 'krusch-sealed-brick/v1' || isPlainObject(rawBrick.blueprint);
        const brickOrgRaw = isSealedBrick
            ? (rawBrick.lineage?.orgId ??
              rawBrick.blueprint?.orgId ??
              ont.orgId ??
              rawBrick.orgId ??
              rawBrick.org ??
              rawBrick.publisher?.orgId ??
              null)
            : (rawBrick.orgId ??
              rawBrick.org ??
              ont.orgId ??
              rawBrick.lineage?.orgId ??
              rawBrick.publisher?.orgId ??
              rawBrick.blueprint?.orgId ??
              null);

        const explicitHash = sanitizeBrickHashToken(
            rawBrick.lineage?.sourceHash ||
                rawBrick.sourceHash ||
                rawBrick.hash ||
                rawBrick.version ||
                ont.version ||
                parsedFromId.hash ||
                ''
        );
        const resolvedHash =
            explicitHash ||
            computeShortBrickDigest({
                brickId,
                name: rawBrick.name || '',
                summary: rawBrick.summary || '',
                source: rawBrick.source || '',
                validFrom: ont.validFrom || rawBrick.validFrom || rawBrick.createdAt || '',
            });

        const canonicalBrickNodeId =
            typeof rawBrick.id === 'string' && rawBrick.id.trim().startsWith('brick:') && rawBrick.id.includes('@')
                ? `brick:${brickId}@${resolvedHash}`
                : `brick:${brickId}@${resolvedHash}`;

        const stacks = uniqueSafeStrings(
            ont.stacks || ont.targetStacks || ont.targetsStacks || rawBrick.stacks || []
        );
        const consumesPorts = uniqueSafeStrings(
            ont.consumesPorts || ont.inputPorts || ont.inputs || rawBrick.consumesPorts || []
        );
        const producesPorts = uniqueSafeStrings(
            ont.producesPorts || ont.outputPorts || ont.outputs || rawBrick.producesPorts || []
        );
        const requiresPorts = uniqueSafeStrings(
            ont.requiresPorts || rawBrick.requiresPorts || []
        );
        const channels = uniqueSafeStrings(
            ont.channels || ont.bridgesChannels || rawBrick.channels || []
        );
        const moeProfiles = uniqueSafeStrings([
            ...(Array.isArray(ont.moeProfiles) ? ont.moeProfiles : []),
            ...(ont.moeProfile ? [ont.moeProfile] : []),
            ...(rawBrick.moeProfile ? [rawBrick.moeProfile] : []),
        ]);
        const capabilities = uniqueSafeStrings(rawBrick.capabilities || rawBrick.blueprint?.capabilities || []);
        const governsTargets = uniqueSafeStrings(ont.governs || rawBrick.governs || []);

        const title = String(rawBrick.name || rawBrick.title || rawBrick.blueprint?.name || brickId).trim();
        const summary = String(rawBrick.summary || rawBrick.blueprint?.summary || '').trim();
        const contentParts = [
            `${title} (${canonicalBrickNodeId})`,
            summary,
            capabilities.length > 0 ? `capabilities: ${capabilities.join(', ')}` : '',
            stacks.length > 0 ? `stacks: ${stacks.join(', ')}` : '',
            consumesPorts.length > 0 ? `consumesPorts: ${consumesPorts.join(', ')}` : '',
            producesPorts.length > 0 ? `producesPorts: ${producesPorts.join(', ')}` : '',
            channels.length > 0 ? `channels: ${channels.join(', ')}` : '',
            moeProfiles.length > 0 ? `moeProfiles: ${moeProfiles.join(', ')}` : '',
        ].filter(Boolean);

        const validFrom =
            ont.validFrom ??
            rawBrick.validFrom ??
            rawBrick.lineage?.sealedAt ??
            rawBrick.createdAt ??
            null;
        const retiredAt = ont.retiredAt ?? rawBrick.retiredAt ?? null;

        const brickNode = upsertNode({
            id: canonicalBrickNodeId,
            kind: 'brick',
            title,
            path: rawBrick.path || buildDefaultOntologyPath(canonicalBrickNodeId, 'brick'),
            content: rawBrick.content || contentParts.join(' | '),
            symbols: uniqueSafeStrings([brickId, ...capabilities]),
            synonyms: uniqueSafeStrings(rawBrick.synonyms || []),
            brickId,
            orgId: brickOrgRaw,
            validFrom,
            retiredAt,
            isCurrent: rawBrick.isCurrent,
            supersededBy: rawBrick.supersededBy,
        });
        if (!brickNode) continue;

        registerBrickAlias(canonicalBrickNodeId, brickNode.id);
        if (HEX_64_RE.test(resolvedHash)) {
            registerBrickAlias(resolvedHash, brickNode.id);
        }
        registerBrickAlias(`${brickId}@${resolvedHash}`, brickNode.id);
        if (resolvedHash.length > 12) {
            registerBrickAlias(`${brickId}@${resolvedHash.slice(0, 12)}`, brickNode.id);
        }
        if (resolvedHash.length > 8) {
            registerBrickAlias(`${brickId}@${resolvedHash.slice(0, 8)}`, brickNode.id);
        }
        if (
            typeof rawBrick.id === 'string' &&
            rawBrick.id.trim() &&
            rawBrick.id.includes('@')
        ) {
            registerBrickAlias(scrubSensitiveText(rawBrick.id.trim()), brickNode.id);
        }

        for (const s of stacks) {
            const sn = ensureStackNode(s);
            if (sn) addOntologyEdge(brickNode.id, sn.id, 'TARGETS_STACK');
        }
        for (const p of consumesPorts) {
            const pn = ensurePortNode(p);
            if (pn) addOntologyEdge(brickNode.id, pn.id, 'CONSUMES_PORT');
        }
        for (const p of producesPorts) {
            const pn = ensurePortNode(p);
            if (pn) addOntologyEdge(brickNode.id, pn.id, 'PRODUCES_PORT');
        }
        for (const p of requiresPorts) {
            const pn = ensurePortNode(p);
            if (pn) addOntologyEdge(brickNode.id, pn.id, 'REQUIRES_PORT');
        }
        for (const c of channels) {
            const cn = ensureChannelNode(c);
            if (cn) addOntologyEdge(brickNode.id, cn.id, 'BRIDGES_CHANNEL');
        }
        for (const m of moeProfiles) {
            const mn = ensureMoeNode(m);
            if (mn) addOntologyEdge(brickNode.id, mn.id, 'ROUTES_TO_MODEL');
        }
        for (const g of governsTargets) {
            addOntologyEdge(brickNode.id, g, 'GOVERNS');
        }

        const supRaw = ont.supersedes ?? rawBrick.supersedes ?? rawBrick.lineage?.supersedes;
        const supList = Array.isArray(supRaw) ? supRaw : supRaw ? [supRaw] : [];
        for (const olderRef of uniqueSafeStrings(supList)) {
            pendingSupersedes.push({ newerId: brickNode.id, olderRef });
        }
    }

    if (compileError) {
        return /** @type {object} */ (scrubSensitiveStrings(compileError));
    }

    const isQualifiedBrickReference = (rawRef) => {
        const stripped = normalizeEntitySlug(rawRef, 'brick');
        if (!stripped) return false;
        if (HEX_64_RE.test(stripped)) return true;
        if (stripped.includes('@')) {
            const parsed = parseBrickLogicalId(rawRef);
            return Boolean(parsed.brickId && parsed.hash);
        }
        return false;
    };

    const resolveBrickRef = (ref, excludeId = '') => {
        const cleanRef = scrubSensitiveText(String(ref ?? '').trim());
        if (!cleanRef) return null;

        if (nodeById.has(cleanRef) && cleanRef !== excludeId) {
            const existing = nodeById.get(cleanRef);
            const isBrick = existing?.kind === 'brick' || cleanRef.startsWith('brick:');
            if (!isBrick || isQualifiedBrickReference(cleanRef)) {
                return cleanRef;
            }
            return null;
        }

        if (!isQualifiedBrickReference(cleanRef)) {
            return null;
        }

        const pickCandidate = (key) => {
            const candidates =
                brickAliasIndex.get(key) || brickAliasIndex.get(key.toLowerCase()) || [];
            const valid = candidates.filter((cid) => cid !== excludeId && nodeById.has(cid));
            return valid.length === 1 ? valid[0] : null;
        };

        const directMatch = pickCandidate(cleanRef);
        if (directMatch) return directMatch;

        const stripped = normalizeEntitySlug(cleanRef, 'brick');
        if (stripped) {
            const strippedMatch = pickCandidate(stripped);
            if (strippedMatch) return strippedMatch;
        }
        return null;
    };

    // Resolve and sort `:SUPERSEDES` lineage deterministically (`v2 -> v1`)
    const resolvedSupersedes = [];
    const seenSupersedePairs = new Set();
    for (const { newerId: rawNewer, olderRef } of pendingSupersedes) {
        const newerCanonicalId = resolveBrickRef(rawNewer) || (nodeById.has(rawNewer) ? rawNewer : null);
        const olderCanonicalId = resolveBrickRef(olderRef, newerCanonicalId || '');
        if (!newerCanonicalId || !olderCanonicalId || newerCanonicalId === olderCanonicalId) continue;
        const pairKey = `${newerCanonicalId}|${olderCanonicalId}`;
        if (seenSupersedePairs.has(pairKey)) continue;
        seenSupersedePairs.add(pairKey);
        resolvedSupersedes.push({ newerCanonicalId, olderCanonicalId });
    }

    resolvedSupersedes.sort((a, b) => {
        const olderA = nodeById.get(a.olderCanonicalId)?.validFrom || '';
        const olderB = nodeById.get(b.olderCanonicalId)?.validFrom || '';
        if (olderA !== olderB) return olderA < olderB ? -1 : 1;
        const newerA = nodeById.get(a.newerCanonicalId)?.validFrom || '';
        const newerB = nodeById.get(b.newerCanonicalId)?.validFrom || '';
        if (newerA !== newerB) return newerA < newerB ? -1 : 1;
        if (a.newerCanonicalId !== b.newerCanonicalId) {
            return a.newerCanonicalId < b.newerCanonicalId ? -1 : 1;
        }
        return a.olderCanonicalId < b.olderCanonicalId
            ? -1
            : a.olderCanonicalId > b.olderCanonicalId
              ? 1
              : 0;
    });

    const createsSupersedesCycle = (newerId, olderId) => {
        // Adding `newerId --[:SUPERSEDES]--> olderId` creates a cycle iff `olderId` already reaches `newerId`
        // via outgoing `:SUPERSEDES` edges (or `newerId` reaches `olderId` via `supersededBy`).
        const visited = new Set([olderId]);
        const stack = [olderId];
        while (stack.length > 0) {
            const curr = stack.pop();
            if (curr === newerId) return true;
            for (const edge of edgeByKey.values()) {
                if (edge.type === 'SUPERSEDES' && edge.from === curr && !visited.has(edge.to)) {
                    visited.add(edge.to);
                    stack.push(edge.to);
                }
            }
        }

        let cursor = nodeById.get(newerId)?.supersededBy || null;
        const seenChain = new Set([newerId]);
        while (cursor && !seenChain.has(cursor)) {
            if (cursor === olderId) return true;
            seenChain.add(cursor);
            cursor = nodeById.get(cursor)?.supersededBy || null;
        }
        return false;
    };

    for (const { newerCanonicalId, olderCanonicalId } of resolvedSupersedes) {
        if (compileError) break;
        const newerNode = nodeById.get(newerCanonicalId);
        const olderNode = nodeById.get(olderCanonicalId);
        if (!newerNode || !olderNode) continue;

        // Enforce strict organization equality (`String(newer.orgId || '') === String(older.orgId || '')`)
        if (String(newerNode.orgId || '') !== String(olderNode.orgId || '')) {
            continue;
        }

        // Guard against 2-node or multi-hop cycles
        if (createsSupersedesCycle(newerCanonicalId, olderCanonicalId)) {
            continue;
        }

        // Prevent overwriting an earlier chronological superseder if `olderNode` was already retired by another version
        if (olderNode.supersededBy && olderNode.supersededBy !== newerNode.id) {
            continue;
        }

        olderNode.isCurrent = false;
        olderNode.supersededBy = newerNode.id;
        if (!olderNode.retiredAt && newerNode.validFrom) {
            olderNode.retiredAt =
                olderNode.validFrom && newerNode.validFrom < olderNode.validFrom
                    ? olderNode.validFrom
                    : newerNode.validFrom;
        }
        addOntologyEdge(newerNode.id, olderNode.id, 'SUPERSEDES');
    }

    if (compileError) {
        return /** @type {object} */ (scrubSensitiveStrings(compileError));
    }

    const rawGraph = {
        workspaceName: safeWorkspaceName,
        namespace: safeNamespace,
        nodes: [...nodeById.values()],
        edges: [...edgeByKey.values()],
    };

    const scrubbed = /** @type {Record<string, any>} */ (scrubSensitiveStrings(rawGraph));
    const finalNodes = (Array.isArray(scrubbed.nodes) ? scrubbed.nodes : []).map((node) => {
        const tokens = estimateTokens(node.content);
        return {
            ...node,
            surrogateId: surrogateVertexId(scrubbed.namespace, node.id),
            tokens,
            validFrom: node.validFrom || null,
            retiredAt: node.retiredAt || null,
            isCurrent: Boolean(node.isCurrent),
            supersededBy: node.supersededBy || null,
        };
    });
    const finalEdges = (Array.isArray(scrubbed.edges) ? scrubbed.edges : []).filter(
        (edge) =>
            edge &&
            edge.from &&
            edge.to &&
            (BRICK_ONTOLOGY_EDGE_SET.has(edge.type) || REPO_AST_EDGE_SET.has(edge.type))
    );
    const totalRepoTokens = finalNodes.reduce((sum, n) => sum + n.tokens, 0);
    const ontology = /** @type {any} */ (scrubSensitiveStrings(buildHydraOntologyFacet(finalNodes)));

    const compiledGraph = {
        workspaceName: scrubbed.workspaceName,
        namespace: scrubbed.namespace,
        totalRepoTokens,
        nodes: finalNodes,
        edges: finalEdges,
        ontology,
    };

    return okEnvelope(
        tool,
        `Compiled Brick Exchange ontology graph (${finalNodes.length} node(s), ${finalEdges.length} edge(s))`,
        compiledGraph
    );
}

/**
 * Extract `<brickId>` if a repository file path corresponds to a vendored sealed brick
 * (`bricks/<brickId>/index.js`, `bricks/<brickId>/index.ts`, `bricks/<brickId>/binding.*`).
 *
 * @param {object} repoNode
 * @returns {string | null}
 */
function matchVendoredBrickIdFromRepoNode(repoNode) {
    if (!repoNode || typeof repoNode !== 'object') return null;
    if (String(repoNode.id || '').startsWith('brick:')) return null;

    const candidates = [];
    if (typeof repoNode.path === 'string' && repoNode.path.trim()) {
        candidates.push(repoNode.path.trim());
    }
    if (typeof repoNode.id === 'string' && repoNode.id.trim()) {
        candidates.push(repoNode.id.trim().replace(/^file:/i, ''));
    }

    const vendoredRe =
        /^(?:\.\/)?bricks\/([A-Za-z0-9][A-Za-z0-9_-]*)\/(?:index|binding|binding_adapter)\.(?:js|ts|mjs|cjs|jsx|tsx|py)$/i;
    for (const candidate of candidates) {
        const normalized = candidate.replace(/\\/g, '/');
        const match = vendoredRe.exec(normalized);
        if (match && !FORBIDDEN_OBJECT_KEYS.has(match[1])) {
            return match[1];
        }
    }
    return null;
}

/**
 * Non-destructively merge a compiled Brick Exchange ontology graph with a HydraScope
 * repository AST/ADR graph, wiring `brick:<brickId>@<hash> --[:GOVERNS]--> file:bricks/<brickId>/index.(js|ts)`
 * so structural queries trace from sealed bricks straight into 1-hop and 2-hop repository AST callers.
 *
 * @param {object} repoGraph
 * @param {object} ontologyGraph
 * @param {object} [options={}]
 * @param {string} [options.namespace]
 * @returns {object} `INV-LEGO-01` envelope
 */
export function mergeOntologyIntoRepoGraph(repoGraph, ontologyGraph, { namespace } = {}) {
    const tool = 'hydrascope.brick_ontology.merge';
    const baseRepo =
        isPlainObject(repoGraph) && repoGraph.ok === true && isPlainObject(repoGraph.data)
            ? repoGraph.data
            : repoGraph;
    const baseOnt =
        isPlainObject(ontologyGraph) && ontologyGraph.ok === true && isPlainObject(ontologyGraph.data)
            ? ontologyGraph.data
            : ontologyGraph;

    if (!isPlainObject(baseRepo) || !Array.isArray(baseRepo.nodes)) {
        return errorEnvelope(
            'INVALID_REPO_GRAPH',
            'mergeOntologyIntoRepoGraph requires a repoGraph with a nodes array.',
            null,
            tool
        );
    }
    if (!isPlainObject(baseOnt) || !Array.isArray(baseOnt.nodes)) {
        return errorEnvelope(
            'INVALID_ONTOLOGY_GRAPH',
            'mergeOntologyIntoRepoGraph requires an ontologyGraph with a nodes array.',
            null,
            tool
        );
    }

    const effectiveNamespace = namespace || baseOnt.namespace || baseRepo.namespace || 'default';
    const mergedNamespace = scrubSensitiveText(String(effectiveNamespace).trim()) || 'default';
    const mergedWorkspaceName =
        scrubSensitiveText(String(baseRepo.workspaceName || baseOnt.workspaceName || 'merged-workspace').trim()) ||
        'merged-workspace';

    /** @type {Map<string, any>} */
    const mergedNodesById = new Map();
    /** @type {Map<string, any>} */
    const mergedEdgesByKey = new Map();

    const cloneNode = (rawNode) => {
        if (!isPlainObject(rawNode) || typeof rawNode.id !== 'string' || !rawNode.id.trim()) return null;
        const cleanId = scrubSensitiveText(rawNode.id.trim());
        if (!cleanId || FORBIDDEN_OBJECT_KEYS.has(cleanId)) return null;
        const cloned = /** @type {Record<string, any>} */ (scrubSensitiveStrings(rawNode));
        const content = String(cloned.content ?? '');
        const normalizedValidFrom = extractIsoDate(cloned.validFrom) || null;
        const rawNormalizedRetiredAt = extractIsoDate(cloned.retiredAt) || null;
        const normalizedRetiredAt =
            normalizedValidFrom && rawNormalizedRetiredAt && rawNormalizedRetiredAt < normalizedValidFrom
                ? normalizedValidFrom
                : rawNormalizedRetiredAt;
        return {
            ...cloned,
            id: cleanId,
            surrogateId: surrogateVertexId(mergedNamespace, cleanId),
            kind: String(cloned.kind || inferOntologyNodeKind(cleanId)),
            title: String(cloned.title || cleanId),
            path: cloned.path ?? null,
            content,
            tokens: Number(cloned.tokens) > 0 ? Number(cloned.tokens) : estimateTokens(content),
            validFrom: normalizedValidFrom,
            retiredAt: normalizedRetiredAt,
            isCurrent: cloned.isCurrent !== false && !normalizedRetiredAt,
            supersededBy: cloned.supersededBy || null,
        };
    };

    for (const rn of baseRepo.nodes) {
        const cloned = cloneNode(rn);
        if (cloned) mergedNodesById.set(cloned.id, cloned);
    }
    for (const on of baseOnt.nodes) {
        const cloned = cloneNode(on);
        if (!cloned) continue;
        const existing = mergedNodesById.get(cloned.id);
        if (!existing || ONTOLOGY_NODE_KINDS.has(cloned.kind)) {
            mergedNodesById.set(cloned.id, cloned);
        }
    }

    const addMergedEdge = (rawEdge) => {
        if (!isPlainObject(rawEdge)) return false;
        const from = scrubSensitiveText(String(rawEdge.from ?? rawEdge.source ?? '').trim());
        const to = scrubSensitiveText(String(rawEdge.to ?? rawEdge.target ?? '').trim());
        const type = String(rawEdge.type ?? '')
            .trim()
            .toUpperCase()
            .replace(/[\s-]+/g, '_');
        if (!from || !to || !type || from === to) return false;
        const key = `${from}|${type}|${to}`;
        if (mergedEdgesByKey.has(key)) return false;
        const edgeRecord = { from, to, type };
        if (typeof rawEdge.reason === 'string' && rawEdge.reason.trim()) {
            edgeRecord.reason = scrubSensitiveText(rawEdge.reason.trim());
        }
        mergedEdgesByKey.set(key, edgeRecord);
        return true;
    };

    for (const re of Array.isArray(baseRepo.edges) ? baseRepo.edges : []) {
        addMergedEdge(re);
    }
    for (const oe of Array.isArray(baseOnt.edges) ? baseOnt.edges : []) {
        addMergedEdge(oe);
    }

    // Index ontology brick nodes by `<brickId>` (case-insensitive)
    /** @type {Map<string, Array<any>>} */
    const bricksByBrickId = new Map();
    for (const node of mergedNodesById.values()) {
        if (node.kind !== 'brick' && !String(node.id).startsWith('brick:')) continue;
        const parsed = parseBrickLogicalId(node.id);
        const bid = String(node.brickId || parsed.brickId || '').trim().toLowerCase();
        if (!bid || FORBIDDEN_OBJECT_KEYS.has(bid)) continue;
        if (!bricksByBrickId.has(bid)) {
            bricksByBrickId.set(bid, []);
        }
        bricksByBrickId.get(bid).push(node);
    }

    // Link vendored `bricks/<brickId>/index.(js|ts)` repo AST nodes via `:GOVERNS`
    const governsLinks = [];
    for (const repoNode of baseRepo.nodes) {
        const vendoredBrickId = matchVendoredBrickIdFromRepoNode(repoNode);
        if (!vendoredBrickId) continue;
        const repoNodeCleanId = scrubSensitiveText(String(repoNode.id ?? '').trim());
        if (!repoNodeCleanId || !mergedNodesById.has(repoNodeCleanId)) continue;

        const matchingBricks = bricksByBrickId.get(vendoredBrickId.toLowerCase()) || [];
        for (const brickNode of matchingBricks) {
            const added = addMergedEdge({
                from: brickNode.id,
                to: repoNodeCleanId,
                type: 'GOVERNS',
            });
            if (added) {
                governsLinks.push({
                    from: brickNode.id,
                    to: repoNodeCleanId,
                    type: 'GOVERNS',
                    brickId: vendoredBrickId,
                });
            }
        }
    }

    const mergedNodes = [...mergedNodesById.values()];
    const mergedEdges = [...mergedEdgesByKey.values()];
    const totalRepoTokens = mergedNodes.reduce((sum, n) => sum + (Number(n.tokens) || 0), 0);

    // Merge ontology facets non-destructively
    const autoFacet = buildHydraOntologyFacet(mergedNodes);
    const termSet = new Set(autoFacet.terms);
    const conceptSet = new Set(autoFacet.knownConcepts);
    /** @type {Record<string, string>} */
    const mergedSynonyms = { ...autoFacet.synonyms };

    for (const srcOnt of [baseRepo.ontology, baseOnt.ontology]) {
        if (!isPlainObject(srcOnt)) continue;
        if (Array.isArray(srcOnt.terms)) {
            for (const t of srcOnt.terms) {
                const ct = scrubSensitiveText(String(t ?? '').trim());
                if (ct && !FORBIDDEN_OBJECT_KEYS.has(ct)) termSet.add(ct);
            }
        } else if (isPlainObject(srcOnt.terms)) {
            for (const k of Object.keys(srcOnt.terms)) {
                const ck = scrubSensitiveText(k.trim());
                if (ck && !FORBIDDEN_OBJECT_KEYS.has(ck)) termSet.add(ck);
            }
        }
        if (Array.isArray(srcOnt.knownConcepts)) {
            for (const c of srcOnt.knownConcepts) {
                const cc = scrubSensitiveText(String(c ?? '').trim());
                if (cc && !FORBIDDEN_OBJECT_KEYS.has(cc)) conceptSet.add(cc);
            }
        }
        if (isPlainObject(srcOnt.synonyms)) {
            for (const [k, v] of Object.entries(srcOnt.synonyms)) {
                if (FORBIDDEN_OBJECT_KEYS.has(k)) continue;
                const ck = scrubSensitiveText(k.trim().toLowerCase());
                const cv = scrubSensitiveText(String(Array.isArray(v) ? v[0] ?? '' : v ?? '').trim());
                if (ck && cv && !FORBIDDEN_OBJECT_KEYS.has(ck)) {
                    mergedSynonyms[ck] = cv;
                }
            }
        }
    }

    const mergedGraph = /** @type {Record<string, any>} */ (
        scrubSensitiveStrings({
            workspaceName: mergedWorkspaceName,
            namespace: mergedNamespace,
            totalRepoTokens,
            nodes: mergedNodes,
            edges: mergedEdges,
            governsLinks,
            ontology: {
                terms: [...termSet].sort(),
                knownConcepts: [...conceptSet].sort(),
                synonyms: mergedSynonyms,
            },
        })
    );

    return okEnvelope(
        tool,
        `Merged Brick Exchange ontology into ${mergedWorkspaceName} (${mergedNodes.length} node(s), ${governsLinks.length} :GOVERNS link(s))`,
        mergedGraph
    );
}

/**
 * Resolve the active replacement brick ID along `:SUPERSEDES` edges at `asOf`.
 *
 * @param {string} retiredId
 * @param {Map<string, any>} nodeById
 * @param {Array<any>} edges
 * @param {string | null} asOf
 * @returns {string | null}
 */
function findActiveSupersedingBrickId(retiredId, nodeById, edges, asOf) {
    const visited = new Set([retiredId]);
    let currId = retiredId;

    while (currId) {
        const currNode = nodeById.get(currId);
        let nextId = currNode?.supersededBy || null;
        if (!nextId) {
            const incoming = edges.find((e) => e.type === 'SUPERSEDES' && e.to === currId);
            if (incoming) nextId = incoming.from;
        }
        if (!nextId || visited.has(nextId)) break;
        visited.add(nextId);
        const candidate = nodeById.get(nextId);
        if (candidate && isOntologyNodeActiveAt(candidate, asOf, nodeById)) {
            return candidate.id;
        }
        currId = nextId;
    }

    return null;
}

/**
 * Compile `snapshot` (and optionally merge into `baseRepoGraph`), synchronize to HydraDB v0.4.0
 * OpenCypher when configured (gracefully falling back when offline per `INV-HS-03`), filter
 * temporal active bricks by `asOf`, enforce DataPort namespace isolation, and return ranked
 * 1-hop brick matches, 2-hop `PRODUCES_PORT -> CONSUMES_PORT` compositions, downstream repository
 * AST callers via `:GOVERNS`, and retired `:SUPERSEDES` lineage.
 *
 * @param {object} [options={}]
 * @returns {Promise<object>} `INV-LEGO-01` envelope
 */
export async function syncAndQueryBrickOntology({
    snapshot = {},
    baseRepoGraph = null,
    query = '',
    targetStack = null,
    targetChannel = null,
    requiredPorts = [],
    asOf = null,
    maxHops = 2,
    hydraClient = null,
    namespace = 'brick-ontology',
    syncToHydra = true,
} = {}) {
    const tool = 'hydrascope.brick_ontology.query';

    const asOfCheck = validateOptionalAsOf(asOf);
    if (!asOfCheck.ok) {
        return /** @type {object} */ (
            scrubSensitiveStrings(errorEnvelope(asOfCheck.code, asOfCheck.message, null, tool))
        );
    }
    const cleanAsOf = asOfCheck.value;
    const effectiveMaxHops = Math.max(1, Math.min(6, Math.trunc(Number(maxHops) || 2)));

    const compiledRes = compileExchangeSnapshotToHydraGraph(snapshot, { namespace });
    if (!compiledRes.ok) {
        return /** @type {object} */ (
            scrubSensitiveStrings(
                errorEnvelope(
                    compiledRes.error?.code || 'COMPILE_FAILED',
                    compiledRes.error?.message || 'Failed compiling Brick Exchange snapshot',
                    compiledRes.error?.details || null,
                    tool
                )
            )
        );
    }

    let workingGraph = compiledRes.data;
    if (baseRepoGraph !== null && baseRepoGraph !== undefined) {
        const mergedRes = mergeOntologyIntoRepoGraph(baseRepoGraph, workingGraph, {
            namespace: workingGraph.namespace,
        });
        if (!mergedRes.ok) {
            return /** @type {object} */ (
                scrubSensitiveStrings(
                    errorEnvelope(
                        mergedRes.error?.code || 'MERGE_FAILED',
                        mergedRes.error?.message || 'Failed merging Brick Exchange ontology with baseRepoGraph',
                        mergedRes.error?.details || null,
                        tool
                    )
                )
            );
        }
        workingGraph = mergedRes.data;
    }

    const totalBrickCount = workingGraph.nodes.reduce(
        (acc, n) => acc + (n && (n.kind === 'brick' || String(n.id).startsWith('brick:')) ? 1 : 0),
        0
    );
    if (
        totalBrickCount > MAX_ONTOLOGY_BRICKS ||
        workingGraph.nodes.length > MAX_ONTOLOGY_NODES ||
        workingGraph.edges.length > MAX_ONTOLOGY_EDGES
    ) {
        return /** @type {object} */ (
            scrubSensitiveStrings(
                errorEnvelope(
                    'SNAPSHOT_LIMIT_EXCEEDED',
                    `Merged ontology graph exceeds limits (bricks=${totalBrickCount}/${MAX_ONTOLOGY_BRICKS}, nodes=${workingGraph.nodes.length}/${MAX_ONTOLOGY_NODES}, edges=${workingGraph.edges.length}/${MAX_ONTOLOGY_EDGES}).`,
                    {
                        bricks: totalBrickCount,
                        nodes: workingGraph.nodes.length,
                        edges: workingGraph.edges.length,
                        limits: {
                            maxBricks: MAX_ONTOLOGY_BRICKS,
                            maxNodes: MAX_ONTOLOGY_NODES,
                            maxEdges: MAX_ONTOLOGY_EDGES,
                        },
                    },
                    tool
                )
            )
        );
    }

    // Step 1: Synchronize snapshot to HydraDB v0.4.0 when configured (`INV-HS-03` fast-trip fallback)
    const clientConfigured = Boolean(
        hydraClient && typeof hydraClient.isConfigured === 'function' && hydraClient.isConfigured()
    );
    let hydraSync = {
        configured: clientConfigured,
        liveSynced: false,
        mode: syncToHydra === false ? 'query_only_no_sync' : 'embedded_graph_fallback',
        nodesWritten: 0,
        edgesWritten: 0,
        cypherStatements: [],
        latencyMs: 0,
    };

    if (syncToHydra !== false && clientConfigured && typeof hydraClient.syncGraphSnapshot === 'function') {
        try {
            const syncRes = await hydraClient.syncGraphSnapshot({
                nodes: workingGraph.nodes,
                edges: workingGraph.edges,
                namespace: workingGraph.namespace,
            });
            const payload =
                syncRes && isPlainObject(syncRes.data) ? syncRes.data : isPlainObject(syncRes) ? syncRes : {};
            const liveSynced = Boolean(syncRes?.ok !== false && payload.liveSynced === true);
            hydraSync = {
                configured: true,
                liveSynced,
                mode: String(
                    payload.mode || (liveSynced ? 'hydradb_opencypher_live' : 'embedded_graph_fallback')
                ),
                nodesWritten: Number(payload.nodesWritten ?? 0),
                edgesWritten: Number(payload.edgesWritten ?? 0),
                cypherStatements: Array.isArray(payload.cypherStatements) ? payload.cypherStatements : [],
                latencyMs: Number(payload.latencyMs ?? 0),
                ...(payload.fallbackReason
                    ? { fallbackReason: scrubSensitiveText(payload.fallbackReason) }
                    : syncRes?.ok === false && syncRes?.error?.message
                      ? { fallbackReason: scrubSensitiveText(syncRes.error.message) }
                      : {}),
            };
        } catch (err) {
            hydraSync = {
                configured: true,
                liveSynced: false,
                mode: 'embedded_graph_fallback',
                nodesWritten: 0,
                edgesWritten: 0,
                cypherStatements: [],
                latencyMs: 0,
                fallbackReason: scrubSensitiveText(
                    err?.message || 'HydraDB sync failed; operating in embedded_graph_fallback mode'
                ),
            };
        }
    }

    // Step 2: Partition active vs retired bricks at `cleanAsOf`
    /** @type {Map<string, any>} */
    const nodeById = new Map();
    for (const node of workingGraph.nodes) {
        if (node && node.id) nodeById.set(node.id, node);
    }

    const edges = Array.isArray(workingGraph.edges) ? workingGraph.edges : [];
    const activeBrickNodes = [];
    const retiredLineage = [];

    for (const node of workingGraph.nodes) {
        if (!node || (node.kind !== 'brick' && !String(node.id).startsWith('brick:'))) continue;
        if (isOntologyNodeActiveAt(node, cleanAsOf, nodeById)) {
            activeBrickNodes.push(node);
        } else {
            const isRetiredAtHorizon = cleanAsOf
                ? Boolean(node.retiredAt && cleanAsOf >= node.retiredAt) ||
                  (node.isCurrent === false &&
                      !node.retiredAt &&
                      (!node.validFrom || node.validFrom <= cleanAsOf))
                : node.isCurrent === false || Boolean(node.retiredAt);
            if (isRetiredAtHorizon) {
                let directSupersededBy = node.supersededBy || null;
                if (!directSupersededBy) {
                    const incoming = edges.find((e) => e.type === 'SUPERSEDES' && e.to === node.id);
                    if (incoming) directSupersededBy = incoming.from;
                }
                const parsed = parseBrickLogicalId(node.id);
                retiredLineage.push({
                    id: node.id,
                    surrogateId: node.surrogateId,
                    brickId: node.brickId || parsed.brickId,
                    title: node.title,
                    validFrom: node.validFrom || null,
                    retiredAt: node.retiredAt || null,
                    supersededBy: directSupersededBy,
                    activeReplacementId: findActiveSupersedingBrickId(node.id, nodeById, edges, cleanAsOf),
                });
            }
        }
    }

    retiredLineage.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // Step 3: Build per-brick structural profile from ontology & `:GOVERNS` edges
    /** @type {Map<string, any>} */
    const profileByBrickNodeId = new Map();
    for (const brickNode of activeBrickNodes) {
        const parsed = parseBrickLogicalId(brickNode.id);
        profileByBrickNodeId.set(brickNode.id, {
            node: brickNode,
            id: brickNode.id,
            surrogateId: brickNode.surrogateId,
            brickId: brickNode.brickId || parsed.brickId,
            title: brickNode.title,
            path: brickNode.path,
            validFrom: brickNode.validFrom || null,
            stacks: [],
            consumesPorts: [],
            producesPorts: [],
            requiresPorts: [],
            channels: [],
            moeProfiles: [],
            governedTargetIds: [],
        });
    }

    for (const edge of edges) {
        const prof = profileByBrickNodeId.get(edge.from);
        if (!prof) continue;
        if (edge.type === 'TARGETS_STACK') {
            const s = normalizeEntitySlug(edge.to, 'stack').toLowerCase();
            if (s && !prof.stacks.includes(s)) prof.stacks.push(s);
        } else if (edge.type === 'CONSUMES_PORT') {
            const p = normalizePortSlug(edge.to);
            if (p && !prof.consumesPorts.includes(p)) prof.consumesPorts.push(p);
        } else if (edge.type === 'PRODUCES_PORT') {
            const p = normalizePortSlug(edge.to);
            if (p && !prof.producesPorts.includes(p)) prof.producesPorts.push(p);
        } else if (edge.type === 'REQUIRES_PORT') {
            const p = normalizePortSlug(edge.to);
            if (p && !prof.requiresPorts.includes(p)) prof.requiresPorts.push(p);
        } else if (edge.type === 'BRIDGES_CHANNEL') {
            const c = normalizeEntitySlug(edge.to, 'channel').toLowerCase();
            if (c && !prof.channels.includes(c)) prof.channels.push(c);
        } else if (edge.type === 'ROUTES_TO_MODEL') {
            const m = normalizeMoeSlug(edge.to);
            if (m && !prof.moeProfiles.includes(m)) prof.moeProfiles.push(m);
        } else if (edge.type === 'GOVERNS') {
            if (edge.to && !prof.governedTargetIds.includes(edge.to)) {
                prof.governedTargetIds.push(edge.to);
            }
        }
    }

    // Step 4: Evaluate query + stack + channel + requiredPorts (with strict port namespace isolation)
    const cleanQuery = scrubSensitiveText(String(query ?? '').trim());
    const queryTokens = splitSearchTokens(cleanQuery);
    const cleanStack = targetStack ? normalizeEntitySlug(targetStack, 'stack').toLowerCase() : null;
    const cleanChannel = targetChannel ? normalizeEntitySlug(targetChannel, 'channel').toLowerCase() : null;
    const cleanRequiredPorts = uniqueSafeStrings(requiredPorts).map(normalizePortSlug).filter(Boolean);
    const hasStructuralFilter = Boolean(cleanStack || cleanChannel || cleanRequiredPorts.length > 0);

    /** @type {Array<any>} */
    const blockedPortCollisions = [];
    const collisionKeys = new Set();
    const recordCollision = (entry) => {
        const key = `${entry.producerId || entry.brickId}|${entry.producedPort}|${entry.consumedPort}|${entry.consumerId || 'query'}`;
        if (!collisionKeys.has(key) && blockedPortCollisions.length < MAX_TWO_HOP_COMPOSITIONS) {
            collisionKeys.add(key);
            blockedPortCollisions.push(entry);
        }
    };

    const lowerQuery = cleanQuery.toLowerCase();
    const scoreLexical = (prof) => {
        if (queryTokens.length === 0) return 0;
        const haystack = [
            prof.id,
            prof.brickId,
            prof.title,
            prof.node.content,
            ...prof.stacks,
            ...prof.consumesPorts,
            ...prof.producesPorts,
            ...prof.channels,
            ...prof.moeProfiles,
        ]
            .join(' ')
            .toLowerCase();
        let score = 0;
        if (prof.brickId && lowerQuery.includes(prof.brickId.toLowerCase())) {
            score += 60;
        }
        for (const tok of queryTokens) {
            if (haystack.includes(tok)) {
                score += 15;
            }
        }
        return score;
    };

    /** @type {Map<string, number>} */
    const lexicalScoreById = new Map();
    for (const prof of profileByBrickNodeId.values()) {
        lexicalScoreById.set(prof.id, scoreLexical(prof));
    }

    const oneHopMatches = [];
    for (const prof of profileByBrickNodeId.values()) {
        if (cleanStack && !prof.stacks.includes(cleanStack)) {
            continue;
        }

        const matchedChannel = cleanChannel ? prof.channels.includes(cleanChannel) : true;
        const matchedPorts = [];
        for (const reqPort of cleanRequiredPorts) {
            let portHit = false;
            for (const candidatePort of [...prof.producesPorts, ...prof.consumesPorts, ...prof.requiresPorts]) {
                const cmp = compareDataPorts(candidatePort, reqPort);
                if (cmp.collision) {
                    recordCollision({
                        brickId: prof.id,
                        producedPort: candidatePort,
                        consumedPort: reqPort,
                        reason: cmp.reason,
                    });
                } else if (cmp.match) {
                    portHit = true;
                }
            }
            if (portHit) matchedPorts.push(reqPort);
        }

        if (cleanChannel && cleanRequiredPorts.length === 0 && !matchedChannel) {
            continue;
        }
        if (!cleanChannel && cleanRequiredPorts.length > 0 && matchedPorts.length === 0) {
            continue;
        }
        if (cleanChannel && cleanRequiredPorts.length > 0 && !matchedChannel && matchedPorts.length === 0) {
            continue;
        }

        const lexScore = lexicalScoreById.get(prof.id) || 0;
        if (!hasStructuralFilter && queryTokens.length > 0 && lexScore <= 0) {
            continue;
        }

        let score = 10 + lexScore;
        if (cleanStack && prof.stacks.includes(cleanStack)) score += 35;
        if (cleanChannel && matchedChannel) score += 35;
        score += matchedPorts.length * 30;
        if (cleanRequiredPorts.length > 0 && matchedPorts.length === cleanRequiredPorts.length) {
            score += 20;
        }
        score += Math.min(15, prof.governedTargetIds.length * 5 + prof.moeProfiles.length * 3);

        oneHopMatches.push({
            id: prof.id,
            surrogateId: prof.surrogateId,
            brickId: prof.brickId,
            title: prof.title,
            path: prof.path,
            validFrom: prof.validFrom,
            stacks: prof.stacks,
            consumesPorts: prof.consumesPorts,
            producesPorts: prof.producesPorts,
            channels: prof.channels,
            moeProfiles: prof.moeProfiles,
            governedTargetIds: prof.governedTargetIds,
            matchedPorts,
            hop: 1,
            score,
        });
    }

    oneHopMatches.sort(
        (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );

    // Step 5: Discover bounded 2-hop composable pipelines (`producer --[:PRODUCES_PORT]-> port <--[:CONSUMES_PORT]-- consumer`)
    const compareCompositionOrder = (a, b) =>
        b.score - a.score ||
        (a.producerId < b.producerId ? -1 : a.producerId > b.producerId ? 1 : 0) ||
        (a.consumerId < b.consumerId ? -1 : a.consumerId > b.consumerId ? 1 : 0) ||
        (a.portSlug < b.portSlug ? -1 : a.portSlug > b.portSlug ? 1 : 0);

    let twoHopCompositions = [];
    if (effectiveMaxHops >= 2) {
        const eligibleProfiles = [...profileByBrickNodeId.values()].filter(
            (prof) => !cleanStack || prof.stacks.includes(cleanStack)
        );
        eligibleProfiles.sort(
            (a, b) =>
                (lexicalScoreById.get(b.id) || 0) - (lexicalScoreById.get(a.id) || 0) ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );

        /** @type {Map<string, Array<{ consumer: any, inPort: string }>>} */
        const consumersByLocalPort = new Map();
        for (const consumer of eligibleProfiles) {
            for (const inPort of consumer.consumesPorts) {
                const parsedIn = parsePortScope(inPort);
                if (!parsedIn.localName) continue;
                let bucket = consumersByLocalPort.get(parsedIn.localName);
                if (!bucket) {
                    bucket = [];
                    consumersByLocalPort.set(parsedIn.localName, bucket);
                }
                bucket.push({ consumer, inPort });
            }
        }

        let floorItem = null;
        for (const producer of eligibleProfiles) {
            const producerLex = lexicalScoreById.get(producer.id) || 0;
            const producerHasChannel = cleanChannel ? producer.channels.includes(cleanChannel) : true;

            for (const outPort of producer.producesPorts) {
                const parsedOut = parsePortScope(outPort);
                if (!parsedOut.localName) continue;
                const candidates = consumersByLocalPort.get(parsedOut.localName);
                if (!candidates) continue;

                for (const { consumer, inPort } of candidates) {
                    if (producer.id === consumer.id) continue;
                    if (
                        cleanChannel &&
                        !producerHasChannel &&
                        !consumer.channels.includes(cleanChannel)
                    ) {
                        continue;
                    }

                    const cmp = compareDataPorts(outPort, inPort);
                    if (cmp.collision) {
                        recordCollision({
                            producerId: producer.id,
                            consumerId: consumer.id,
                            producedPort: outPort,
                            consumedPort: inPort,
                            reason: cmp.reason,
                        });
                        continue;
                    }
                    if (!cmp.match) continue;

                    const pairLex = producerLex + (lexicalScoreById.get(consumer.id) || 0);
                    if (!hasStructuralFilter && queryTokens.length > 0 && pairLex <= 0) {
                        continue;
                    }

                    let satisfiedRequired = [];
                    if (cleanRequiredPorts.length > 0) {
                        const pipelinePorts = uniqueSafeStrings([
                            ...producer.consumesPorts,
                            ...producer.producesPorts,
                            ...consumer.consumesPorts,
                            ...consumer.producesPorts,
                        ]);
                        satisfiedRequired = cleanRequiredPorts.filter((req) =>
                            pipelinePorts.some((pp) => compareDataPorts(pp, req).match)
                        );
                        if (satisfiedRequired.length === 0) {
                            continue;
                        }
                    }

                    let compositionScore = 25 + pairLex + satisfiedRequired.length * 30;
                    if (cleanChannel && producerHasChannel) {
                        compositionScore += 30;
                    }
                    if (cleanStack) {
                        compositionScore += 25;
                    }

                    if (
                        floorItem &&
                        (compositionScore < floorItem.score ||
                            (compositionScore === floorItem.score && producer.id > floorItem.producerId) ||
                            (compositionScore === floorItem.score &&
                                producer.id === floorItem.producerId &&
                                consumer.id > floorItem.consumerId))
                    ) {
                        continue;
                    }

                    const bridgePortId = `port:${outPort}`;
                    twoHopCompositions.push({
                        producerId: producer.id,
                        consumerId: consumer.id,
                        producerBrickId: producer.brickId,
                        consumerBrickId: consumer.brickId,
                        producerTitle: producer.title,
                        consumerTitle: consumer.title,
                        bridgePort: bridgePortId,
                        portSlug: outPort,
                        outputPorts: consumer.producesPorts,
                        channels: uniqueSafeStrings([...producer.channels, ...consumer.channels]),
                        stacks: uniqueSafeStrings([...producer.stacks, ...consumer.stacks]),
                        satisfiedRequiredPorts: satisfiedRequired,
                        path: [producer.id, bridgePortId, consumer.id],
                        edges: [
                            { from: producer.id, to: bridgePortId, type: 'PRODUCES_PORT' },
                            { from: consumer.id, to: bridgePortId, type: 'CONSUMES_PORT' },
                        ],
                        hops: 2,
                        score: compositionScore,
                    });

                    if (twoHopCompositions.length >= MAX_TWO_HOP_COMPOSITIONS * 2) {
                        twoHopCompositions.sort(compareCompositionOrder);
                        twoHopCompositions.length = MAX_TWO_HOP_COMPOSITIONS;
                        floorItem = twoHopCompositions[MAX_TWO_HOP_COMPOSITIONS - 1];
                    }
                }
            }
        }
    }

    twoHopCompositions.sort(compareCompositionOrder);
    if (twoHopCompositions.length > MAX_TWO_HOP_COMPOSITIONS) {
        twoHopCompositions = twoHopCompositions.slice(0, MAX_TWO_HOP_COMPOSITIONS);
    }

    // Step 6: Trace `:GOVERNS` -> downstream repository AST callers (`IMPACTS`, `READS_ENV`, reverse `IMPORTS`/`CALLS`)
    const seedBrickIds = new Set([
        ...oneHopMatches.map((m) => m.id),
        ...twoHopCompositions.flatMap((c) => [c.producerId, c.consumerId]),
    ]);
    // If filters yielded zero specific brick seeds but query/graph has active bricks with `:GOVERNS`, only trace matched seeds
    /** @type {Map<string, { node: any, governedByBrickIds: Set<string> }>} */
    const governedRepoMap = new Map();
    /** @type {Map<string, any>} */
    const repoImpactEdgeMap = new Map();

    const recordImpactEdge = (edge) => {
        const key = `${edge.from}|${edge.type}|${edge.to}`;
        if (!repoImpactEdgeMap.has(key)) {
            repoImpactEdgeMap.set(key, { from: edge.from, to: edge.to, type: edge.type });
        }
    };

    for (const brickNodeId of seedBrickIds) {
        const prof = profileByBrickNodeId.get(brickNodeId);
        if (!prof) continue;
        for (const targetId of prof.governedTargetIds) {
            const targetNode = nodeById.get(targetId);
            if (!targetNode || !isOntologyNodeActiveAt(targetNode, cleanAsOf, nodeById)) continue;
            recordImpactEdge({ from: brickNodeId, to: targetId, type: 'GOVERNS' });
            if (!governedRepoMap.has(targetId)) {
                governedRepoMap.set(targetId, {
                    node: targetNode,
                    governedByBrickIds: new Set([brickNodeId]),
                });
            } else {
                governedRepoMap.get(targetId).governedByBrickIds.add(brickNodeId);
            }
        }
    }

    /** @type {Map<string, { node: any, hop: number, governedByBrickIds: Set<string>, viaEdgeType: string }>} */
    const callerReachedMap = new Map();
    const astQueue = [];

    for (const [govNodeId, entry] of governedRepoMap.entries()) {
        astQueue.push({
            id: govNodeId,
            hop: 0,
            governedByBrickIds: entry.governedByBrickIds,
        });
    }

    const FORWARD_REPO_EDGE_TYPES = new Set(['IMPACTS', 'READS_ENV', 'TOUCHED', 'TUNED_IN']);
    const REVERSE_CALLER_EDGE_TYPES = new Set(['IMPORTS', 'CALLS', 'DEPENDS_ON']);

    while (astQueue.length > 0) {
        const curr = astQueue.shift();
        if (curr.hop >= effectiveMaxHops) continue;

        for (const edge of edges) {
            let nextRepoId = null;
            if (edge.from === curr.id && FORWARD_REPO_EDGE_TYPES.has(edge.type)) {
                nextRepoId = edge.to;
            } else if (edge.to === curr.id && REVERSE_CALLER_EDGE_TYPES.has(edge.type)) {
                nextRepoId = edge.from;
            }
            if (!nextRepoId || governedRepoMap.has(nextRepoId)) continue;

            const candidate = nodeById.get(nextRepoId);
            if (!candidate || !isOntologyNodeActiveAt(candidate, cleanAsOf, nodeById)) continue;
            if (ONTOLOGY_NODE_KINDS.has(candidate.kind)) {
                continue;
            }

            recordImpactEdge(edge);
            const nextHop = curr.hop + 1;
            const existing = callerReachedMap.get(nextRepoId);
            if (!existing) {
                const govSet = new Set(curr.governedByBrickIds);
                callerReachedMap.set(nextRepoId, {
                    node: candidate,
                    hop: nextHop,
                    governedByBrickIds: govSet,
                    viaEdgeType: edge.type,
                });
                astQueue.push({
                    id: nextRepoId,
                    hop: nextHop,
                    governedByBrickIds: govSet,
                });
            } else {
                for (const bid of curr.governedByBrickIds) {
                    existing.governedByBrickIds.add(bid);
                }
                if (nextHop < existing.hop) {
                    existing.hop = nextHop;
                }
            }
        }
    }

    const governedRepoNodes = [...governedRepoMap.values()]
        .map((entry) => ({
            id: entry.node.id,
            surrogateId: entry.node.surrogateId,
            kind: entry.node.kind || 'code',
            title: entry.node.title || entry.node.id,
            path: entry.node.path || null,
            governedByBrickIds: [...entry.governedByBrickIds].sort(),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const downstreamRepoCallers = [...callerReachedMap.values()]
        .map((entry) => ({
            id: entry.node.id,
            surrogateId: entry.node.surrogateId,
            kind: entry.node.kind || 'code',
            title: entry.node.title || entry.node.id,
            path: entry.node.path || null,
            hop: entry.hop,
            viaEdgeType: entry.viaEdgeType,
            governedByBrickIds: [...entry.governedByBrickIds].sort(),
        }))
        .sort((a, b) => a.hop - b.hop || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const activeNodeCount = workingGraph.nodes.filter((n) =>
        isOntologyNodeActiveAt(n, cleanAsOf, nodeById)
    ).length;

    const result = {
        namespace: workingGraph.namespace,
        workspaceName: workingGraph.workspaceName,
        asOf: cleanAsOf,
        liveSynced: hydraSync.liveSynced,
        mode: hydraSync.mode,
        hydraSync,
        filters: {
            query: cleanQuery,
            targetStack: cleanStack,
            targetChannel: cleanChannel,
            requiredPorts: cleanRequiredPorts,
            maxHops: effectiveMaxHops,
        },
        oneHopMatches,
        matches: oneHopMatches,
        twoHopCompositions,
        compositions: twoHopCompositions,
        governedRepoNodes,
        downstreamRepoCallers,
        repoImpactEdges: [...repoImpactEdgeMap.values()],
        retiredLineage,
        blockedPortCollisions,
        graphStats: {
            totalNodes: workingGraph.nodes.length,
            activeNodes: activeNodeCount,
            totalEdges: workingGraph.edges.length,
            totalRepoTokens: workingGraph.totalRepoTokens,
        },
    };

    const summary = `Ontology query matched ${oneHopMatches.length} 1-hop brick(s), ${twoHopCompositions.length} 2-hop composition(s), ${downstreamRepoCallers.length} repo AST caller(s), and filtered ${retiredLineage.length} retired brick(s) [${hydraSync.mode}]`;

    return /** @type {object} */ (scrubSensitiveStrings(okEnvelope(tool, summary, result)));
}
