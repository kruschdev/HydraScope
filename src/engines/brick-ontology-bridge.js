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
import { isValidIsoDate, validateOptionalAsOf } from '../utils/validation.js';

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
 * Extract a valid `YYYY-MM-DD` calendar date prefix from an ISO-8601 date or timestamp.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function extractIsoDate(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const candidate = trimmed.length >= 10 ? trimmed.slice(0, 10) : trimmed;
    return isValidIsoDate(candidate) ? candidate : null;
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
    const text = String(raw ?? '').trim();
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
    if (lower.startsWith('moe:')) return 'moe_profile';
    if (lower.startsWith('org:')) return 'org_profile';
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
    if (kind === 'brick' || id.startsWith('brick:')) {
        const { brickId, hash } = parseBrickLogicalId(id);
        const safeBrick = (brickId || 'unknown').replace(/[^A-Za-z0-9_-]+/g, '-');
        const suffix = hash ? `@${hash.slice(0, 12)}` : '';
        return `ontology/bricks/${safeBrick}${suffix}.json`;
    }
    const safeSlug = id.replace(/:/g, '/').replace(/[^A-Za-z0-9/_-]+/g, '-');
    return `ontology/${safeSlug}.json`;
}

/**
 * Evaluate whether `node` is active at `asOf` (`!isCurrent` retired nodes excluded unless `asOf < retiredAt`).
 *
 * @param {object} node
 * @param {string | null} [asOf=null]
 * @returns {boolean}
 */
function isOntologyNodeActiveAt(node, asOf = null) {
    if (!node || typeof node !== 'object') return false;
    const cleanAsOf = typeof asOf === 'string' && asOf.trim().length > 0 ? asOf.trim() : null;
    if (!cleanAsOf || !isValidIsoDate(cleanAsOf)) {
        return node.isCurrent !== false && !node.retiredAt;
    }
    const validOk = !node.validFrom || node.validFrom <= cleanAsOf;
    const notRetiredYet = !node.retiredAt || cleanAsOf < node.retiredAt;
    return validOk && notRetiredYet;
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
        const cleanId = scrubSensitiveText(String(raw.id ?? '').trim());
        if (!cleanId || FORBIDDEN_OBJECT_KEYS.has(cleanId)) return null;
        if (nodeById.has(cleanId)) {
            return nodeById.get(cleanId);
        }

        const kind = scrubSensitiveText(String(raw.kind || inferOntologyNodeKind(cleanId)).trim()) || 'ontology_entity';
        const title = scrubSensitiveText(String(raw.title || cleanId).trim()) || cleanId;
        const nodePath = scrubSensitiveText(String(raw.path || buildDefaultOntologyPath(cleanId, kind)).trim());
        const content = scrubSensitiveText(String(raw.content || title).trim());
        const validFrom = extractIsoDate(raw.validFrom) || null;
        const retiredAt = extractIsoDate(raw.retiredAt) || null;
        const supersededBy = raw.supersededBy ? scrubSensitiveText(String(raw.supersededBy).trim()) : null;
        const isCurrent =
            typeof raw.isCurrent === 'boolean' ? raw.isCurrent : !retiredAt && !supersededBy;

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
            supersededBy,
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

        nodeById.set(cleanId, node);
        return node;
    };

    const addOntologyEdge = (from, to, rawType) => {
        const cleanFrom = scrubSensitiveText(String(from ?? '').trim());
        const cleanTo = scrubSensitiveText(String(to ?? '').trim());
        const cleanType = String(rawType ?? '')
            .trim()
            .toUpperCase()
            .replace(/[\s-]+/g, '_');
        if (!cleanFrom || !cleanTo || cleanFrom === cleanTo) return;
        if (!BRICK_ONTOLOGY_EDGE_SET.has(cleanType)) return;
        const key = `${cleanFrom}|${cleanType}|${cleanTo}`;
        if (!edgeByKey.has(key)) {
            edgeByKey.set(key, {
                from: cleanFrom,
                to: cleanTo,
                type: cleanType,
            });
        }
    };

    const ensureStackNode = (rawStack, extra = {}) => {
        const slug = normalizeEntitySlug(rawStack, 'stack').toLowerCase();
        if (!slug) return null;
        const id = `stack:${slug}`;
        const preset = Object.hasOwn(CANONICAL_STACK_META, slug) ? CANONICAL_STACK_META[slug] : null;
        const title = extra.title || extra.name || preset?.title || `Stack ${slug}`;
        const runtimeFamily = extra.runtimeFamily || preset?.runtimeFamily || 'unknown';
        const purity = Boolean(extra.requiresWebStandardPurity ?? preset?.requiresWebStandardPurity);
        const content =
            extra.content ||
            extra.summary ||
            `${title} (${slug}) | runtimeFamily=${runtimeFamily} | requiresWebStandardPurity=${purity}`;
        return upsertNode({
            id,
            kind: 'stack',
            title,
            path: extra.path || `ontology/stacks/${slug}.json`,
            content,
            symbols: [slug],
            validFrom: extra.validFrom,
            retiredAt: extra.retiredAt,
            isCurrent: extra.isCurrent,
            supersededBy: extra.supersededBy,
        });
    };

    const ensurePortNode = (rawPort, extra = {}) => {
        const parsed = parsePortScope(rawPort);
        if (!parsed.slug) return null;
        const id = `port:${parsed.slug}`;
        const preset =
            !parsed.namespaced && Object.hasOwn(CANONICAL_PORT_META, parsed.slug)
                ? CANONICAL_PORT_META[parsed.slug]
                : null;
        const shared =
            typeof extra.shared === 'boolean'
                ? extra.shared
                : parsed.namespaced
                  ? false
                  : Boolean(preset?.shared ?? true);
        const aliases = uniqueSafeStrings([
            ...(Array.isArray(extra.aliases) ? extra.aliases : []),
            ...(Array.isArray(preset?.aliases) ? preset.aliases : []),
        ]);
        const title =
            extra.title ||
            extra.name ||
            preset?.title ||
            (parsed.namespaced ? `Namespaced Port ${parsed.slug}` : `DataPort ${parsed.slug}`);
        const content =
            extra.content ||
            extra.summary ||
            `${title} (${parsed.slug}) | shared=${shared}${parsed.namespace ? ` | namespace=${parsed.namespace}` : ''}${aliases.length > 0 ? ` | aliases=${aliases.join(', ')}` : ''}`;
        return upsertNode({
            id,
            kind: 'port',
            title,
            path: extra.path || `ontology/ports/${parsed.slug.replace(/:/g, '_')}.json`,
            content,
            symbols: [parsed.slug],
            synonyms: aliases,
            shared,
            portNamespace: parsed.namespace || undefined,
            validFrom: extra.validFrom,
            retiredAt: extra.retiredAt,
            isCurrent: extra.isCurrent,
            supersededBy: extra.supersededBy,
        });
    };

    const ensureChannelNode = (rawChannel, extra = {}) => {
        const slug = normalizeEntitySlug(rawChannel, 'channel').toLowerCase();
        if (!slug) return null;
        const id = `channel:${slug}`;
        const preset = Object.hasOwn(CANONICAL_CHANNEL_META, slug) ? CANONICAL_CHANNEL_META[slug] : null;
        const title = extra.title || extra.name || preset?.title || `Channel ${slug}`;
        const content = extra.content || extra.summary || `${title} (${slug})`;
        const channelNode = upsertNode({
            id,
            kind: 'channel',
            title,
            path: extra.path || `ontology/channels/${slug.replace(/:/g, '_')}.json`,
            content,
            symbols: [slug],
            validFrom: extra.validFrom,
            retiredAt: extra.retiredAt,
            isCurrent: extra.isCurrent,
            supersededBy: extra.supersededBy,
        });

        const reqPorts = uniqueSafeStrings(extra.requiresPorts || extra.requiredPorts || []);
        for (const p of reqPorts) {
            const pNode = ensurePortNode(p);
            if (channelNode && pNode) {
                addOntologyEdge(channelNode.id, pNode.id, 'REQUIRES_PORT');
            }
        }
        return channelNode;
    };

    const ensureMoeNode = (rawMoe, extra = {}) => {
        const slug = normalizeEntitySlug(rawMoe, 'moe').toLowerCase();
        if (!slug) return null;
        const id = `moe:${slug}`;
        const preset = Object.hasOwn(CANONICAL_MOE_META, slug) ? CANONICAL_MOE_META[slug] : null;
        const title = extra.title || extra.name || preset?.title || `MoE Profile ${slug}`;
        const tier = extra.dispatchTier || preset?.dispatchTier || 'L2_HEAVY_MOE';
        const content = extra.content || extra.summary || `${title} (${slug}) | dispatchTier=${tier}`;
        return upsertNode({
            id,
            kind: 'moe_profile',
            title,
            path: extra.path || `ontology/moe/${slug}.json`,
            content,
            symbols: [slug],
            validFrom: extra.validFrom,
            retiredAt: extra.retiredAt,
            isCurrent: extra.isCurrent,
            supersededBy: extra.supersededBy,
        });
    };

    // Mode 1: Pre-compiled ontology graph (`{ nodes, edges }`)
    if (Array.isArray(unwrapped.nodes)) {
        for (const rawNode of unwrapped.nodes) {
            if (!isPlainObject(rawNode)) continue;
            const rawId = String(rawNode.id ?? rawNode.logicalId ?? '').trim();
            if (!rawId || FORBIDDEN_OBJECT_KEYS.has(rawId)) continue;
            const kind = String(rawNode.kind || rawNode.type || inferOntologyNodeKind(rawId)).trim();
            const parsedBrick = kind === 'brick' || rawId.startsWith('brick:') ? parseBrickLogicalId(rawId) : null;
            const parsedPort = kind === 'port' || rawId.startsWith('port:') ? parsePortScope(rawId) : null;

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
                    : [parsedBrick?.brickId || normalizeEntitySlug(rawId, kind)].filter(Boolean),
                synonyms: Array.isArray(rawNode.synonyms) ? rawNode.synonyms : [],
                brickId: rawNode.brickId || parsedBrick?.brickId || undefined,
                shared:
                    typeof rawNode.shared === 'boolean'
                        ? rawNode.shared
                        : parsedPort
                          ? !parsedPort.namespaced
                          : undefined,
                portNamespace: rawNode.portNamespace || parsedPort?.namespace || undefined,
                validFrom: rawNode.validFrom ?? rawNode.ontology?.validFrom ?? rawNode.createdAt,
                retiredAt: rawNode.retiredAt ?? rawNode.ontology?.retiredAt,
                isCurrent: rawNode.isCurrent,
                supersededBy: rawNode.supersededBy,
            });

            if (created && (kind === 'brick' || created.id.startsWith('brick:'))) {
                registerBrickAlias(created.id, created.id);
                if (parsedBrick?.brickId) {
                    registerBrickAlias(parsedBrick.brickId, created.id);
                    if (parsedBrick.hash) {
                        registerBrickAlias(parsedBrick.hash, created.id);
                        registerBrickAlias(`${parsedBrick.brickId}@${parsedBrick.hash}`, created.id);
                        registerBrickAlias(
                            `${parsedBrick.brickId}@${parsedBrick.hash.slice(0, 12)}`,
                            created.id
                        );
                    }
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
            if (!from || !to || !BRICK_ONTOLOGY_EDGE_SET.has(type)) continue;
            if (type === 'SUPERSEDES') {
                pendingSupersedes.push({ newerId: from, olderRef: to });
            } else {
                addOntologyEdge(from, to, type);
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

    const orgProfiles = Array.isArray(unwrapped.orgProfiles) ? unwrapped.orgProfiles : [];
    for (const org of orgProfiles) {
        if (!isPlainObject(org)) continue;
        const slug = normalizeEntitySlug(org.orgId || org.id || org.slug || org.name, 'org');
        if (!slug) continue;
        const orgNodeId = `org:${slug}`;
        const orgStacks = uniqueSafeStrings(org.stacks || org.usesStacks || []);
        const orgChannels = uniqueSafeStrings(org.channels || org.listensChannels || []);
        const orgPorts = uniqueSafeStrings(org.requiredPorts || org.requiresPorts || []);
        const title = org.title || org.name || `Organization ${slug}`;
        const content =
            org.content ||
            org.summary ||
            `${title} (${orgNodeId}) | stacks=${orgStacks.join(', ') || 'none'} | channels=${orgChannels.join(', ') || 'none'} | requiredPorts=${orgPorts.join(', ') || 'none'}`;

        const orgNode = upsertNode({
            id: orgNodeId,
            kind: 'org_profile',
            title,
            path: `ontology/orgs/${slug.replace(/[^A-Za-z0-9_-]+/g, '-')}.json`,
            content,
            symbols: [slug],
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
        if (!isPlainObject(rawEntry)) continue;
        const rawBrick =
            isPlainObject(rawEntry.bundle)
                ? {
                      ...rawEntry.bundle,
                      ontology: rawEntry.ontology || rawEntry.bundle.ontology,
                  }
                : rawEntry;

        const ont = isPlainObject(rawBrick.ontology)
            ? rawBrick.ontology
            : isPlainObject(rawBrick.blueprint?.ontology)
              ? rawBrick.blueprint.ontology
              : {};

        const parsedFromId = typeof rawBrick.id === 'string' ? parseBrickLogicalId(rawBrick.id) : { brickId: '', hash: '' };
        const brickId = String(
            rawBrick.brickId ||
                rawBrick.blueprint?.id ||
                parsedFromId.brickId ||
                rawBrick.name ||
                ''
        )
            .trim()
            .replace(/[^A-Za-z0-9_-]+/g, '-');
        if (!brickId || FORBIDDEN_OBJECT_KEYS.has(brickId)) continue;

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
            validFrom,
            retiredAt,
            isCurrent: rawBrick.isCurrent,
            supersededBy: rawBrick.supersededBy,
        });
        if (!brickNode) continue;

        registerBrickAlias(canonicalBrickNodeId, brickNode.id);
        registerBrickAlias(brickId, brickNode.id);
        registerBrickAlias(resolvedHash, brickNode.id);
        registerBrickAlias(`${brickId}@${resolvedHash}`, brickNode.id);
        if (resolvedHash.length > 12) {
            registerBrickAlias(resolvedHash.slice(0, 12), brickNode.id);
            registerBrickAlias(`${brickId}@${resolvedHash.slice(0, 12)}`, brickNode.id);
        }
        if (resolvedHash.length > 8) {
            registerBrickAlias(resolvedHash.slice(0, 8), brickNode.id);
            registerBrickAlias(`${brickId}@${resolvedHash.slice(0, 8)}`, brickNode.id);
        }
        if (typeof rawBrick.id === 'string' && rawBrick.id.trim()) {
            registerBrickAlias(rawBrick.id.trim(), brickNode.id);
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

    // Also honor pre-declared `supersededBy` fields on older brick nodes
    for (const node of nodeById.values()) {
        if (node.supersededBy) {
            pendingSupersedes.push({ newerId: node.supersededBy, olderRef: node.id });
        }
    }

    const resolveBrickRef = (ref, excludeId = '') => {
        const cleanRef = String(ref ?? '').trim();
        if (!cleanRef) return null;
        if (nodeById.has(cleanRef) && cleanRef !== excludeId) return cleanRef;

        const pickCandidate = (key) => {
            const candidates = brickAliasIndex.get(key) || brickAliasIndex.get(key.toLowerCase()) || [];
            return candidates.find((cid) => cid !== excludeId && nodeById.has(cid)) || null;
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

    // Resolve `:SUPERSEDES` lineage across bricks (`v2 -> v1`)
    for (const { newerId: rawNewer, olderRef } of pendingSupersedes) {
        const newerCanonicalId = resolveBrickRef(rawNewer) || rawNewer;
        const olderCanonicalId = resolveBrickRef(olderRef, newerCanonicalId);
        if (!newerCanonicalId || !olderCanonicalId || newerCanonicalId === olderCanonicalId) continue;

        const newerNode = nodeById.get(newerCanonicalId);
        const olderNode = nodeById.get(olderCanonicalId);
        if (!newerNode || !olderNode) continue;

        // Guard against accidental 2-node or transitive cycles
        let cursor = newerNode.supersededBy;
        const seenChain = new Set([newerCanonicalId]);
        let createsCycle = false;
        while (cursor && !seenChain.has(cursor)) {
            if (cursor === olderCanonicalId) {
                createsCycle = true;
                break;
            }
            seenChain.add(cursor);
            cursor = nodeById.get(cursor)?.supersededBy || null;
        }
        if (createsCycle) continue;

        olderNode.isCurrent = false;
        olderNode.supersededBy = newerNode.id;
        if (!olderNode.retiredAt) {
            olderNode.retiredAt = newerNode.validFrom || null;
        }
        addOntologyEdge(newerNode.id, olderNode.id, 'SUPERSEDES');
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
        (edge) => edge && edge.from && edge.to && BRICK_ONTOLOGY_EDGE_SET.has(edge.type)
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
        /(?:^|\/)bricks\/([A-Za-z0-9][A-Za-z0-9_-]*)\/(?:index|binding|binding_adapter)\.(?:js|ts|mjs|cjs|jsx|tsx|py)$/i;
    for (const candidate of candidates) {
        const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
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
 * @returns {object} `INV-LEGO-01` envelope
 */
export function mergeOntologyIntoRepoGraph(repoGraph, ontologyGraph) {
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

    const mergedNamespace =
        scrubSensitiveText(String(baseRepo.namespace || baseOnt.namespace || 'brick-ontology').trim()) ||
        'brick-ontology';
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
        return {
            ...cloned,
            id: cleanId,
            surrogateId:
                Number.isSafeInteger(cloned.surrogateId) &&
                cloned.surrogateId >= 1000 &&
                cloned.surrogateId <= Number.MAX_SAFE_INTEGER
                    ? cloned.surrogateId
                    : surrogateVertexId(mergedNamespace, cleanId),
            kind: String(cloned.kind || inferOntologyNodeKind(cleanId)),
            title: String(cloned.title || cleanId),
            path: cloned.path ?? null,
            content,
            tokens: Number(cloned.tokens) > 0 ? Number(cloned.tokens) : estimateTokens(content),
            validFrom: cloned.validFrom || null,
            retiredAt: cloned.retiredAt || null,
            isCurrent: cloned.isCurrent !== false && !cloned.retiredAt,
            supersededBy: cloned.supersededBy || null,
        };
    };

    for (const rn of baseRepo.nodes) {
        const cloned = cloneNode(rn);
        if (cloned) mergedNodesById.set(cloned.id, cloned);
    }
    for (const on of baseOnt.nodes) {
        const cloned = cloneNode(on);
        if (cloned && !mergedNodesById.has(cloned.id)) {
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
        if (candidate && isOntologyNodeActiveAt(candidate, asOf)) {
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
        const mergedRes = mergeOntologyIntoRepoGraph(baseRepoGraph, workingGraph);
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

    // Step 1: Synchronize snapshot to HydraDB v0.4.0 when configured (`INV-HS-03` fast-trip fallback)
    let hydraSync = {
        configured: false,
        liveSynced: false,
        mode: 'embedded_graph_fallback',
        nodesWritten: 0,
        edgesWritten: 0,
        cypherStatements: [],
        latencyMs: 0,
    };

    const clientConfigured = Boolean(
        hydraClient && typeof hydraClient.isConfigured === 'function' && hydraClient.isConfigured()
    );
    if (clientConfigured && typeof hydraClient.syncGraphSnapshot === 'function') {
        try {
            const syncRes = await hydraClient.syncGraphSnapshot({
                nodes: workingGraph.nodes,
                edges: workingGraph.edges,
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
        if (isOntologyNodeActiveAt(node, cleanAsOf)) {
            activeBrickNodes.push(node);
        } else {
            const isRetiredAtHorizon = cleanAsOf
                ? Boolean(node.retiredAt && cleanAsOf >= node.retiredAt)
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
            const m = normalizeEntitySlug(edge.to, 'moe').toLowerCase();
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
        if (!collisionKeys.has(key)) {
            collisionKeys.add(key);
            blockedPortCollisions.push(entry);
        }
    };

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
        const lowerQuery = cleanQuery.toLowerCase();
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

    const oneHopMatches = [];
    for (const prof of profileByBrickNodeId.values()) {
        if (cleanStack && prof.stacks.length > 0 && !prof.stacks.includes(cleanStack)) {
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

        const lexScore = scoreLexical(prof);
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

    // Step 5: Discover 2-hop composable pipelines (`producer --[:PRODUCES_PORT]-> port <--[:CONSUMES_PORT]-- consumer`)
    const twoHopCompositions = [];
    if (effectiveMaxHops >= 2) {
        const profiles = [...profileByBrickNodeId.values()];
        for (const producer of profiles) {
            if (cleanStack && producer.stacks.length > 0 && !producer.stacks.includes(cleanStack)) {
                continue;
            }
            for (const consumer of profiles) {
                if (producer.id === consumer.id) continue;
                if (cleanStack && consumer.stacks.length > 0 && !consumer.stacks.includes(cleanStack)) {
                    continue;
                }
                if (
                    cleanChannel &&
                    !producer.channels.includes(cleanChannel) &&
                    !consumer.channels.includes(cleanChannel)
                ) {
                    continue;
                }

                for (const outPort of producer.producesPorts) {
                    for (const inPort of consumer.consumesPorts) {
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

                        const pipelinePorts = uniqueSafeStrings([
                            ...producer.consumesPorts,
                            ...producer.producesPorts,
                            ...consumer.consumesPorts,
                            ...consumer.producesPorts,
                        ]);
                        const satisfiedRequired = cleanRequiredPorts.filter((req) =>
                            pipelinePorts.some((pp) => compareDataPorts(pp, req).match)
                        );
                        if (cleanRequiredPorts.length > 0 && satisfiedRequired.length === 0) {
                            continue;
                        }

                        const pairLex = scoreLexical(producer) + scoreLexical(consumer);
                        if (!hasStructuralFilter && queryTokens.length > 0 && pairLex <= 0) {
                            continue;
                        }

                        let compositionScore = 25 + pairLex + satisfiedRequired.length * 30;
                        if (cleanChannel && producer.channels.includes(cleanChannel)) {
                            compositionScore += 30;
                        }
                        if (cleanStack) {
                            compositionScore += 25;
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
                    }
                }
            }
        }
    }

    twoHopCompositions.sort(
        (a, b) =>
            b.score - a.score ||
            (a.producerId < b.producerId ? -1 : a.producerId > b.producerId ? 1 : 0) ||
            (a.consumerId < b.consumerId ? -1 : a.consumerId > b.consumerId ? 1 : 0)
    );

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
            if (!targetNode || !isOntologyNodeActiveAt(targetNode, cleanAsOf)) continue;
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
            if (!candidate || !isOntologyNodeActiveAt(candidate, cleanAsOf)) continue;
            if (
                candidate.kind === 'brick' ||
                candidate.kind === 'stack' ||
                candidate.kind === 'port' ||
                candidate.kind === 'channel' ||
                candidate.kind === 'moe_profile' ||
                candidate.kind === 'org_profile'
            ) {
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

    const activeNodeCount = workingGraph.nodes.filter((n) => isOntologyNodeActiveAt(n, cleanAsOf)).length;

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
