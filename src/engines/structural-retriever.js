/**
 * @module engines/structural-retriever
 * @description Pre-flight ontology answerability gate, temporal `asOf` active-node filter,
 * multi-hop structural BFS + `:GOVERNS` / `:SUPERSEDES` resolver, and live decision
 * supersession mutator for HydraScope (`INV-HS-01..05`).
 */

import { okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { FORBIDDEN_OBJECT_KEYS, scrubSensitiveText } from '../utils/scrubber.js';
import {
    isValidIsoDate,
    normalizeIsoDateOrTimestamp,
    validateOptionalAsOf,
    validateSupersedePayload,
    MAX_CUSTOM_DECISIONS,
    MAX_QUERY_CHARS
} from '../utils/validation.js';

const STOP_AND_FRAMING_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'before', 'after',
    'between', 'both', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done',
    'down', 'during', 'each', 'either', 'for', 'from', 'further', 'had', 'has',
    'have', 'having', 'here', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
    'just', 'may', 'might', 'more', 'most', 'must', 'my', 'need', 'needs', 'needed',
    'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
    'our', 'ours', 'out', 'over', 'own', 'per', 'same', 'shall', 'should', 'so',
    'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
    'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'upon',
    'us', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
    'who', 'whom', 'why', 'will', 'with', 'within', 'without', 'would', 'you', 'your',
    // Generic engineering imperative / question framing words
    'update', 'updating', 'updated', 'change', 'changing', 'changed', 'implement',
    'implementing', 'modify', 'modifying', 'refactor', 'refactoring', 'touch',
    'touching', 'touched', 'verify', 'verifying', 'verification', 'trace', 'tracing',
    'break', 'breaking', 'broken', 'downstream', 'upstream', 'accounting', 'check',
    'checks', 'checking', 'impact', 'impacts', 'impacted', 'affect', 'affects',
    'affected', 'setting', 'settings', 'control', 'controls', 'controlled',
    'threshold', 'thresholds', 'scale', 'scales', 'scaling', 'manifest', 'manifests',
    'group', 'groups', 'lag', 'item', 'items', 'browser', 'incoming', 'outgoing',
    'current', 'currently', 'active', 'retired', 'legacy', 'old', 'new', 'latest',
    'safe', 'safely', 'ensure', 'make', 'sure', 'handle', 'handles', 'handling',
    'store', 'storing', 'stored', 'use', 'uses', 'using', 'used', 'work', 'works',
    'working', 'configure', 'configured', 'configuration', 'rule', 'rules', 'policy',
    'policies', 'module', 'modules', 'file', 'files', 'function', 'functions',
    'method', 'methods', 'code', 'codebase', 'system', 'service', 'services',
    'architecture', 'decision', 'decisions', 'record', 'records', 'invariant',
    'invariants', 'postmortem', 'incident', 'incidents', 'blast', 'radius',
    'tuned', 'tuning', 'tune', 'happens', 'happen', 'find', 'show', 'list',
    'explain', 'tell', 'govern', 'governs', 'governed', 'allow', 'allowed',
    'prevent', 'prevents', 'stop', 'stops', 'year', 'end', 'user', 'users',
]);

const EXTERNAL_SUBSYSTEM_TERMS = new Set([
    'kafka', 'zookeeper', 'pulsar', 'rabbitmq', 'activemq', 'nats', 'kinesis', 'sqs', 'sns',
    'kubernetes', 'k8s', 'kubectl', 'helm', 'horizontalpodautoscaler', 'hpa', 'istio',
    'envoy', 'linkerd', 'nomad', 'openshift', 'eks', 'gke', 'aks',
    'graphql', 'apollo', 'grpc', 'protobuf', 'trpc', 'soap',
    'mongodb', 'mongoose', 'cassandra', 'scylladb', 'dynamodb', 'couchbase', 'neo4j',
    'arangodb', 'cockroachdb', 'clickhouse', 'bigquery', 'redshift', 'spanner',
    'elasticsearch', 'opensearch', 'solr', 'algolia', 'meilisearch', 'pinecone',
    'weaviate', 'qdrant', 'milvus', 'chromadb',
    'terraform', 'ansible', 'pulumi', 'cloudformation',
    'celery', 'temporal', 'airflow', 'dagster', 'prefect', 'flink', 'hadoop',
    'memcached', 'etcd', 'consul', 'vault', 'keycloak', 'auth0', 'okta', 'cognito',
    'supabase', 'firebase', 'prisma', 'typeorm', 'sequelize', 'drizzle',
]);

const FORWARD_TRAVERSAL_TYPES = new Set([
    'IMPACTS',
    'CALLS',
    'IMPORTS',
    'READS_ENV',
    'TOUCHED',
    'TUNED_IN',
    'DEFINES',
    'CONTAINS',
]);

const REVERSE_TRAVERSAL_TYPES = new Set([
    'TUNED_IN',
    'READS_ENV',
    'TOUCHED',
    'CALLS',
    'IMPORTS',
    'DEFINES',
    'CONTAINS',
]);

/**
 * Estimate UTF-8 token count deterministically (~4 bytes per token).
 *
 * @param {string} text
 * @returns {number}
 */
const UTF8_ENCODER = new TextEncoder();

export function estimateStructuralTokens(text) {
    if (!text) return 0;
    return Math.ceil(UTF8_ENCODER.encode(String(text)).byteLength / 4);
}

/**
 * Scrub private RFC1918/Tailscale/loopback IPs, local user-home paths, emails, and Bearer tokens (`INV-HS-02`).
 *
 * @param {unknown} raw
 * @returns {string}
 */
function scrubSafeText(raw) {
    return scrubSensitiveText(raw);
}

/**
 * Lightweight deterministic English morphological stemmer for lowercase domain nouns.
 *
 * @param {string} token
 * @returns {string}
 */
function stemDomainWord(token) {
    const w = String(token || '').toLowerCase();
    if (w.length <= 3 || EXTERNAL_SUBSYSTEM_TERMS.has(w)) return w;
    if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
    if (w.endsWith('ches') || w.endsWith('shes') || w.endsWith('xes') || w.endsWith('zes') || w.endsWith('ses')) {
        return w.slice(0, -2);
    }
    if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
    if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
    if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
        return w.slice(0, -1);
    }
    return w;
}

/**
 * Split camelCase, PascalCase, snake_case, and kebab-case identifiers into lowercase sub-words.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function splitIdentifierParts(raw) {
    const text = String(raw || '');
    if (!text) return [];
    const expanded = text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[/_.:-]+/g, ' ');
    return (expanded.toLowerCase().match(/[a-z0-9]{2,}/g) || []);
}

/**
 * Normalize a node ID by stripping common type prefixes (`sym:`, `file:`, `adr:`, `decision:`, `env:`, `inc:`, `pr:`, `inv:`).
 *
 * @param {string} id
 * @returns {string}
 */
function bareLogicalId(id) {
    return String(id || '').replace(/^[a-z_]+:/i, '').trim();
}

/**
 * Build a fast ontology + node grounding lookup index from `graph`.
 *
 * @param {object} graph
 */
function buildOntologyIndex(graph) {
    const exactTerms = new Map();
    const stemmedTerms = new Map();
    const synonyms = new Map();
    const nodeById = new Map();
    const bareIdToNodeId = new Map();

    const addTerm = (term, nodeId = null) => {
        const clean = String(term || '').trim().toLowerCase();
        if (!clean || clean.length < 2) return;
        if (!exactTerms.has(clean)) exactTerms.set(clean, new Set());
        if (nodeId) exactTerms.get(clean).add(nodeId);

        if (!EXTERNAL_SUBSYSTEM_TERMS.has(clean)) {
            const stemmed = stemDomainWord(clean);
            if (stemmed && stemmed.length >= 3) {
                if (!stemmedTerms.has(stemmed)) stemmedTerms.set(stemmed, new Set());
                if (nodeId) stemmedTerms.get(stemmed).add(nodeId);
            }
        }
    };

    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    for (const node of nodes) {
        if (!node || !node.id) continue;
        nodeById.set(node.id, node);
        const bare = bareLogicalId(node.id);
        if (bare) {
            bareIdToNodeId.set(bare.toLowerCase(), node.id);
            addTerm(bare, node.id);
            for (const part of splitIdentifierParts(bare)) {
                addTerm(part, node.id);
            }
        }
        addTerm(node.id, node.id);

        if (node.path) {
            addTerm(node.path, node.id);
            const base = String(node.path).split('/').pop() || '';
            if (base) {
                addTerm(base, node.id);
                addTerm(base.replace(/\.[^.]+$/, ''), node.id);
            }
            for (const part of splitIdentifierParts(node.path)) {
                if (part !== 'src' && part !== 'docs' && part !== 'ts' && part !== 'js' && part !== 'md') {
                    addTerm(part, node.id);
                }
            }
        }

        if (node.title) {
            for (const tok of (String(node.title).toLowerCase().match(/[a-z0-9_-]{2,}/g) || [])) {
                addTerm(tok, node.id);
            }
            for (const part of splitIdentifierParts(node.title)) {
                addTerm(part, node.id);
            }
        }

        if (Array.isArray(node.symbols)) {
            for (const sym of node.symbols) {
                addTerm(sym, node.id);
                for (const part of splitIdentifierParts(sym)) {
                    addTerm(part, node.id);
                }
            }
        }

        if (Array.isArray(node.synonyms)) {
            for (const syn of node.synonyms) {
                const key = String(syn || '').trim().toLowerCase();
                if (!key) continue;
                synonyms.set(key, node.id);
                for (const part of splitIdentifierParts(key)) {
                    addTerm(part, node.id);
                }
            }
        }

        if (node.content) {
            const contentStr = String(node.content);
            const artifactIds = contentStr.match(/\b(?:ADR|INC|PR|INV)-[A-Za-z0-9_-]+\b/g) || [];
            for (const aid of artifactIds) addTerm(aid, node.id);
            const envVars = contentStr.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
            for (const envKey of envVars) {
                addTerm(envKey, node.id);
                for (const part of splitIdentifierParts(envKey)) {
                    addTerm(part, node.id);
                }
            }
            const camelTokens = contentStr.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g) || [];
            for (const ct of camelTokens) {
                addTerm(ct, node.id);
                for (const part of splitIdentifierParts(ct)) {
                    addTerm(part, node.id);
                }
            }
            const contentWords = contentStr.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
            for (const cw of contentWords) {
                if (!STOP_AND_FRAMING_WORDS.has(cw) && !EXTERNAL_SUBSYSTEM_TERMS.has(cw)) {
                    addTerm(cw, node.id);
                }
            }
        }
    }

    const ont = graph?.ontology || {};
    if (Array.isArray(ont.terms)) {
        for (const term of ont.terms) {
            if (typeof term === 'string' && !FORBIDDEN_OBJECT_KEYS.has(term)) {
                addTerm(term, null);
            }
        }
    } else if (ont.terms && typeof ont.terms === 'object') {
        for (const [term, mapped] of Object.entries(ont.terms)) {
            if (FORBIDDEN_OBJECT_KEYS.has(term)) continue;
            if (Array.isArray(mapped)) {
                if (mapped.length === 0) addTerm(term, null);
                for (const id of mapped) addTerm(term, id);
            } else if (typeof mapped === 'string') {
                addTerm(term, mapped);
            } else if (mapped) {
                addTerm(term, null);
            }
        }
    }

    if (Array.isArray(ont.knownConcepts)) {
        for (const concept of ont.knownConcepts) {
            addTerm(concept, null);
            for (const part of splitIdentifierParts(concept)) {
                addTerm(part, null);
            }
        }
    }

    if (ont.synonyms && typeof ont.synonyms === 'object') {
        for (const [phrase, target] of Object.entries(ont.synonyms)) {
            if (FORBIDDEN_OBJECT_KEYS.has(phrase)) continue;
            const cleanPhrase = String(phrase || '').trim().toLowerCase();
            if (!cleanPhrase) continue;
            const targetStr = Array.isArray(target) ? String(target[0] || '') : String(target || '');
            synonyms.set(cleanPhrase, targetStr);
        }
    }

    return { exactTerms, stemmedTerms, synonyms, nodeById, bareIdToNodeId };
}

/**
 * Determine whether `node` is active at `asOf` (`INV-HS-05`).
 *
 * @param {object} node
 * @param {string | null} [asOf=null]
 * @returns {boolean}
 */
export function isNodeActiveAt(node, asOf = null) {
    if (!node || typeof node !== 'object') return false;
    const asOfCheck = validateOptionalAsOf(asOf);
    const cleanAsOf = asOfCheck.ok ? asOfCheck.value : null;
    const validFrom = normalizeIsoDateOrTimestamp(node.validFrom);
    const retiredAt = normalizeIsoDateOrTimestamp(node.retiredAt);
    if (!cleanAsOf) {
        return node.isCurrent !== false && !retiredAt;
    }
    if (validFrom && validFrom > cleanAsOf) {
        return false;
    }
    if (retiredAt) {
        return retiredAt > cleanAsOf;
    }
    if (node.isCurrent === false) {
        return false;
    }
    return true;
}

/**
 * Pre-flight ontology answerability check (`0` LLM tokens burned on ungrounded traps).
 *
 * @param {object} graph
 * @param {string} query
 * @returns {object} `INV-LEGO-01` envelope
 */
export function checkAnswerable(graph, query) {
    if (!graph || !Array.isArray(graph.nodes)) {
        return errorEnvelope(
            'INVALID_GRAPH',
            'A compiled graph with a nodes array is required.',
            null,
            'hydrascope.check_answerable'
        );
    }

    const rawQuery = String(query ?? '').trim();
    if (!rawQuery) {
        return okEnvelope('hydrascope.check_answerable', 'Rejected empty query pre-flight', {
            answerable: false,
            groundedTerms: [],
            synonymMatches: [],
            missingTerms: [],
            reason: 'Query is empty.',
        });
    }

    const idx = buildOntologyIndex(graph);
    const strippedDatesQuery = rawQuery.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
    const lowerQuery = strippedDatesQuery.toLowerCase();

    const groundedSet = new Set();
    const synonymMatches = [];
    const missingSet = new Set();
    const ungroundedDomainCandidates = [];

    for (const [phrase, target] of idx.synonyms.entries()) {
        if (phrase.length >= 3 && lowerQuery.includes(phrase)) {
            synonymMatches.push(`${phrase} -> ${target}`);
            groundedSet.add(phrase);
        }
    }

    // 1. Check explicit structured identifiers in raw query (ADR/INC/PR/INV, camelCase/PascalCase, snake_case/ENV_VAR)
    const explicitArtifactIds = strippedDatesQuery.match(/\b(?:ADR|INC|PR|INV)-[A-Za-z0-9_-]+\b/gi) || [];
    for (const rawId of explicitArtifactIds) {
        const lower = rawId.toLowerCase();
        if (idx.exactTerms.has(lower) || idx.bareIdToNodeId.has(lower)) {
            groundedSet.add(rawId);
        } else {
            missingSet.add(lower);
        }
    }

    const explicitCamelOrPascal =
        strippedDatesQuery.match(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g) || [];
    for (const ident of explicitCamelOrPascal) {
        const lower = ident.toLowerCase();
        if (idx.exactTerms.has(lower) || idx.bareIdToNodeId.has(lower)) {
            groundedSet.add(ident);
        } else {
            missingSet.add(lower);
        }
    }

    const explicitSnakeOrEnv = strippedDatesQuery.match(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g) || [];
    for (const ident of explicitSnakeOrEnv) {
        const lower = ident.toLowerCase();
        if (idx.exactTerms.has(lower) || idx.bareIdToNodeId.has(lower)) {
            groundedSet.add(ident);
        } else {
            missingSet.add(lower);
        }
    }

    // 2. Tokenize query words, strip stop/framing words, check external tech traps and ontology grounding
    const rawTokens = lowerQuery.match(/[a-z0-9][a-z0-9_-]*/g) || [];
    for (const token of rawTokens) {
        if (/^\d+$/.test(token) || token.length < 2) continue;

        if (EXTERNAL_SUBSYSTEM_TERMS.has(token)) {
            if (idx.exactTerms.has(token)) {
                groundedSet.add(token);
            } else {
                missingSet.add(token);
            }
            continue;
        }

        if (STOP_AND_FRAMING_WORDS.has(token)) continue;
        const stemmed = stemDomainWord(token);
        if (STOP_AND_FRAMING_WORDS.has(stemmed)) continue;

        if (idx.exactTerms.has(token) || idx.stemmedTerms.has(stemmed)) {
            groundedSet.add(token);
        } else if (!missingSet.has(token)) {
            ungroundedDomainCandidates.push(token);
        }
    }

    const groundedTerms = [...groundedSet];
    if (missingSet.size > 0) {
        const missingTerms = [...missingSet];
        const reason = `Ungrounded subsystem or identifier not present in workspace ontology: ${missingTerms.join(', ')}.`;
        return okEnvelope('hydrascope.check_answerable', `Blocked ungrounded query (${missingTerms.join(', ')})`, {
            answerable: false,
            groundedTerms,
            synonymMatches,
            missingTerms,
            reason,
        });
    }

    if (groundedTerms.length === 0 && synonymMatches.length === 0) {
        const missingTerms = ungroundedDomainCandidates.slice(0, 6);
        const reason = missingTerms.length > 0
            ? `Zero workspace concepts matched query terms: ${missingTerms.join(', ')}.`
            : 'Query contains no grounded workspace symbols, artifacts, or domain concepts.';
        return okEnvelope('hydrascope.check_answerable', 'Blocked ungrounded query (0 ontology matches)', {
            answerable: false,
            groundedTerms: [],
            synonymMatches: [],
            missingTerms,
            reason,
        });
    }

    return okEnvelope(
        'hydrascope.check_answerable',
        `Query grounded across ${groundedTerms.length} workspace concept(s)`,
        {
            answerable: true,
            groundedTerms,
            synonymMatches,
            missingTerms: [],
            reason: `Grounded in workspace ontology (${groundedTerms.slice(0, 5).join(', ')}).`,
        }
    );
}

/**
 * Normalize an edge to `{ from, to, type, reason }`.
 *
 * @param {object} edge
 * @returns {{ from: string, to: string, type: string, reason: string } | null}
 */
function normalizeEdge(edge) {
    if (!edge) return null;
    const from = String(edge.from ?? edge.source ?? '').trim();
    const to = String(edge.to ?? edge.target ?? '').trim();
    const type = String(edge.type ?? '').trim().toUpperCase();
    if (!from || !to || !type) return null;
    return {
        from,
        to,
        type,
        reason: String(edge.reason ?? ''),
    };
}

/**
 * Score candidate seed nodes by structural symbol/ID/synonym/title match and graph degree.
 */
function selectSeedNodes(graph, query, idx) {
    const rawQuery = String(query || '').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
    const lowerQuery = rawQuery.toLowerCase();
    const queryTokens = (lowerQuery.match(/[a-z0-9][a-z0-9_-]*/g) || []).filter(
        (t) => t.length >= 2 && !STOP_AND_FRAMING_WORDS.has(t) && !STOP_AND_FRAMING_WORDS.has(stemDomainWord(t))
    );

    const edges = (Array.isArray(graph.edges) ? graph.edges : []).map(normalizeEdge).filter(Boolean);
    const degreeByNode = new Map();
    for (const e of edges) {
        degreeByNode.set(e.from, (degreeByNode.get(e.from) || 0) + 1);
        degreeByNode.set(e.to, (degreeByNode.get(e.to) || 0) + 1);
    }

    const synonymTargetBoost = new Map();
    for (const [phrase, target] of idx.synonyms.entries()) {
        if (phrase.length >= 3 && lowerQuery.includes(phrase)) {
            const resolved = idx.nodeById.has(target)
                ? target
                : (idx.bareIdToNodeId.get(target.toLowerCase()) || target);
            synonymTargetBoost.set(resolved, (synonymTargetBoost.get(resolved) || 0) + 90);
            const termNodes = idx.exactTerms.get(target.toLowerCase());
            if (termNodes) {
                for (const nid of termNodes) {
                    synonymTargetBoost.set(nid, (synonymTargetBoost.get(nid) || 0) + 65);
                }
            }
        }
    }

    const scored = [];
    for (const node of graph.nodes) {
        if (!node || !node.id) continue;
        let lexicalScore = 0;

        const bareId = bareLogicalId(node.id).toLowerCase();
        if (bareId.length >= 3 && lowerQuery.includes(bareId)) {
            lexicalScore += 125;
        } else if (lowerQuery.includes(String(node.id).toLowerCase())) {
            lexicalScore += 125;
        }

        if (synonymTargetBoost.has(node.id)) {
            lexicalScore += synonymTargetBoost.get(node.id);
        }

        if (Array.isArray(node.synonyms)) {
            for (const syn of node.synonyms) {
                const s = String(syn || '').trim().toLowerCase();
                if (s.length >= 3 && lowerQuery.includes(s)) {
                    lexicalScore += 80;
                }
            }
        }

        const symbolSet = new Set();
        const symbolParts = new Set();
        for (const sym of (Array.isArray(node.symbols) ? node.symbols : [])) {
            const lowerSym = String(sym).toLowerCase();
            symbolSet.add(lowerSym);
            if (lowerSym.length >= 3 && lowerQuery.includes(lowerSym)) {
                lexicalScore += 120;
            }
            for (const p of splitIdentifierParts(sym)) {
                symbolParts.add(p);
                symbolParts.add(stemDomainWord(p));
            }
        }

        const pathParts = new Set();
        if (node.path) {
            const baseStem = (String(node.path).split('/').pop() || '').replace(/\.[^.]+$/, '').toLowerCase();
            if (baseStem.length >= 3 && lowerQuery.includes(baseStem)) {
                lexicalScore += 55;
            }
            for (const p of splitIdentifierParts(node.path)) {
                pathParts.add(p);
                pathParts.add(stemDomainWord(p));
            }
        }

        const titleParts = new Set();
        if (node.title) {
            for (const p of splitIdentifierParts(node.title)) {
                titleParts.add(p);
                titleParts.add(stemDomainWord(p));
            }
        }

        const contentLower = String(node.content || '').toLowerCase();
        for (const tok of queryTokens) {
            const stem = stemDomainWord(tok);
            let matchedStructured = false;
            if (symbolSet.has(tok) || symbolParts.has(tok) || symbolParts.has(stem)) {
                lexicalScore += 30;
                matchedStructured = true;
            }
            if (pathParts.has(tok) || pathParts.has(stem)) {
                lexicalScore += 22;
                matchedStructured = true;
            }
            if (titleParts.has(tok) || titleParts.has(stem)) {
                lexicalScore += 18;
                matchedStructured = true;
            }
            const ontHitNodes = idx.exactTerms.get(tok) || idx.stemmedTerms.get(stem);
            if (ontHitNodes && ontHitNodes.has(node.id)) {
                lexicalScore += 14;
                matchedStructured = true;
            }
            if (!matchedStructured && contentLower.includes(tok)) {
                lexicalScore += 3;
            }
        }

        if (lexicalScore <= 0) continue;

        const kind = String(node.kind || '').toLowerCase();
        const degree = degreeByNode.get(node.id) || 0;
        let structuralAdjust = Math.min(20, degree * 6);
        if (['symbol', 'file', 'module', 'pr', 'incident', 'env', 'decision', 'adr', 'invariant'].includes(kind)) {
            structuralAdjust += 12;
        } else if (degree === 0) {
            structuralAdjust -= 18;
        }
        if (degree === 0) {
            structuralAdjust -= 12;
        }

        const totalScore = lexicalScore + structuralAdjust;
        if (totalScore > 0) {
            scored.push({ node, score: totalScore, degree });
        }
    }

    scored.sort((a, b) => b.score - a.score || b.degree - a.degree || (a.node.id < b.node.id ? -1 : 1));
    if (scored.length === 0) return [];

    const topSeeds = [scored[0]];
    if (scored.length > 1 && scored[1].score >= Math.max(40, scored[0].score * 0.68)) {
        topSeeds.push(scored[1]);
    }
    return topSeeds;
}

/**
 * Walk the connected `:SUPERSEDES` lineage component around `startNodeId` and partition
 * active member(s) at `asOf` vs retired predecessors (`retiredAt <= asOf` or `!asOf && !active`).
 */
function resolveSupersedesComponent(startNodeId, nodeById, edges, asOf) {
    const asOfCheck = validateOptionalAsOf(asOf);
    const cleanAsOf = asOfCheck.ok ? asOfCheck.value : null;
    const componentIds = new Set();
    const queue = [startNodeId];
    const usedSupersedesEdges = [];

    while (queue.length > 0) {
        const currId = queue.shift();
        if (!currId || componentIds.has(currId)) continue;
        const currNode = nodeById.get(currId);
        if (!currNode) continue;
        componentIds.add(currId);

        if (currNode.supersededBy && nodeById.has(currNode.supersededBy) && !componentIds.has(currNode.supersededBy)) {
            queue.push(currNode.supersededBy);
        }

        for (const e of edges) {
            if (e.type !== 'SUPERSEDES') continue;
            if (e.from === currId && !componentIds.has(e.to)) {
                usedSupersedesEdges.push(e);
                queue.push(e.to);
            } else if (e.to === currId && !componentIds.has(e.from)) {
                usedSupersedesEdges.push(e);
                queue.push(e.from);
            }
        }
    }

    const activeMembers = [];
    const retiredMembers = [];
    for (const memberId of componentIds) {
        const member = nodeById.get(memberId);
        if (!member) continue;
        if (isNodeActiveAt(member, cleanAsOf)) {
            activeMembers.push(member);
        } else {
            const memberValidFrom = normalizeIsoDateOrTimestamp(member.validFrom);
            const memberRetiredAt = normalizeIsoDateOrTimestamp(member.retiredAt);
            const retiredByDate = cleanAsOf
                ? Boolean(memberRetiredAt && memberRetiredAt <= cleanAsOf) ||
                  (member.isCurrent === false &&
                      !memberRetiredAt &&
                      (!memberValidFrom || memberValidFrom <= cleanAsOf))
                : (member.isCurrent === false || Boolean(memberRetiredAt));
            if (retiredByDate) {
                let supersededBy = member.supersededBy || null;
                if (!supersededBy) {
                    const incomingSup = edges.find((e) => e.type === 'SUPERSEDES' && e.to === member.id);
                    if (incomingSup) supersededBy = incomingSup.from;
                }
                retiredMembers.push({
                    id: member.id,
                    kind: member.kind || 'decision',
                    title: member.title || member.id,
                    path: member.path || null,
                    retiredAt: memberRetiredAt || null,
                    supersededBy,
                });
            }
        }
    }

    return { activeMembers, retiredMembers, usedSupersedesEdges };
}

/**
 * Extract a compact high-signal structural excerpt when full file content exceeds remaining budget.
 */
function formatCompactNodeExcerpt(node, maxTokens) {
    const rawContent = String(node.content || '').trim();
    if (!rawContent) return '';
    const fullTokens = estimateStructuralTokens(rawContent);
    if (fullTokens <= maxTokens) return rawContent;

    const maxBytes = Math.max(48, Math.floor(maxTokens * 4) - 16);
    const lines = rawContent.split('\n');
    const kept = [];
    let usedBytes = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const lineBytes = UTF8_ENCODER.encode(line).byteLength + 1;
        if (usedBytes + lineBytes > maxBytes) break;
        kept.push(line);
        usedBytes += lineBytes;
    }

    if (kept.length > 0) {
        return `${kept.join('\n')}\n// ... [truncated to structural budget]`;
    }
    return `${rawContent.slice(0, Math.max(32, maxBytes - 12))}...`;
}

/**
 * Build a readable OpenCypher query trace representing the executed HydraDB `v0.4.0` traversal.
 */
function buildDisplayCypherQuery(seedIds, maxHops, asOf) {
    const seedList = JSON.stringify(seedIds);
    const hopBound = Math.max(1, Math.min(6, Number(maxHops) || 3));
    const safeAsOf = asOf && isValidIsoDate(asOf) ? asOf.trim() : null;
    const temporalClause = safeAsOf
        ? `WHERE (n.valid_from IS NULL OR n.valid_from <= '${safeAsOf}') AND (n.retired_at IS NULL OR n.retired_at > '${safeAsOf}')`
        : `WHERE n.is_current <> false AND n.retired_at IS NULL`;

    return [
        `MATCH (seed:GraphNode) WHERE seed.logical_id IN ${seedList}`,
        `OPTIONAL MATCH path = (seed)-[:IMPACTS|CALLS|IMPORTS|READS_ENV|TOUCHED|TUNED_IN*1..${hopBound}]-(n:GraphNode)`,
        temporalClause,
        `OPTIONAL MATCH (gov:GraphNode)-[:GOVERNS]->(n)`,
        `OPTIONAL MATCH (activeGov:GraphNode)-[:SUPERSEDES*1..3]->(gov)`,
        `RETURN DISTINCT seed.logical_id, n.logical_id, gov.logical_id, activeGov.logical_id`,
    ].join('\n');
}

/**
 * Traverse minimum-token structural context with pre-flight answerability,
 * live HydraDB `v0.4.0` OpenCypher execution (when configured), and `asOf` temporal filtering.
 *
 * @param {object} graph
 * @param {object} [options={}]
 * @returns {Promise<object>} `INV-LEGO-01` envelope
 */
export async function traverseStructuralContext(
    graph,
    { query = '', asOf = null, tokenBudget = 900, maxHops = 3, hydraClient = null } = {}
) {
    if (!graph || !Array.isArray(graph.nodes)) {
        return errorEnvelope(
            'INVALID_GRAPH',
            'A compiled graph with a nodes array is required.',
            null,
            'hydrascope.traverse'
        );
    }

    const asOfCheck = validateOptionalAsOf(asOf);
    if (!asOfCheck.ok) {
        return errorEnvelope(asOfCheck.code, asOfCheck.message, null, 'hydrascope.traverse');
    }
    const cleanAsOf = asOfCheck.value;
    const boundedQuery = String(query ?? '').slice(0, MAX_QUERY_CHARS);
    const effectiveBudget = Math.max(120, Math.min(16000, Number(tokenBudget) || 900));
    const effectiveMaxHops = Math.max(1, Math.min(6, Number(maxHops) || 3));
    const fullRepoTokens =
        Number(graph.totalRepoTokens) > 0
            ? Number(graph.totalRepoTokens)
            : graph.nodes.reduce((sum, n) => sum + (Number(n?.tokens) || estimateStructuralTokens(n?.content || '')), 0);

    // Step 1: Pre-flight ontology answerability gate
    const answerCheck = checkAnswerable(graph, boundedQuery);
    const answerability = answerCheck.data;
    if (!answerability.answerable) {
        return okEnvelope(
            'hydrascope.traverse',
            `Blocked ungrounded query pre-flight (0 tokens burned): ${answerability.reason}`,
            {
                answerability,
                asOf: cleanAsOf,
                seedNodes: [],
                selectedNodeIds: [],
                traversedNodes: [],
                traversedEdges: [],
                retiredBlockedNodes: [],
                contextText: '',
                tokenCount: 0,
                fullRepoTokens,
                tokenSavingsRatio: fullRepoTokens > 0 ? 1 : 0,
                cypherQuery: '// Blocked pre-flight by checkAnswerable (0 tokens burned)',
                hydraExecution: {
                    liveQueried: false,
                    mode: 'blocked-preflight',
                    cypherStatements: [],
                    lastReadEpoch: null,
                    lastBookmark: null,
                    latencyMs: 0,
                },
            }
        );
    }

    // Step 2: Structural seed selection
    const idx = buildOntologyIndex(graph);
    const edges = (Array.isArray(graph.edges) ? graph.edges : []).map(normalizeEdge).filter(Boolean);
    const rawSeeds = selectSeedNodes(graph, boundedQuery, idx);

    const retiredBlockedMap = new Map();
    const traversedEdgeMap = new Map();
    const recordEdge = (edge) => {
        if (!edge) return;
        const key = `${edge.from}|${edge.type}|${edge.to}`;
        if (!traversedEdgeMap.has(key)) {
            traversedEdgeMap.set(key, edge);
        }
    };

    const activeSeedEntries = [];
    for (const entry of rawSeeds) {
        if (isNodeActiveAt(entry.node, cleanAsOf)) {
            activeSeedEntries.push(entry);
        } else {
            const lineage = resolveSupersedesComponent(entry.node.id, idx.nodeById, edges, cleanAsOf);
            for (const r of lineage.retiredMembers) retiredBlockedMap.set(r.id, r);
            for (const se of lineage.usedSupersedesEdges) recordEdge(se);
            for (const replacement of lineage.activeMembers) {
                if (!activeSeedEntries.some((s) => s.node.id === replacement.id)) {
                    activeSeedEntries.push({ node: replacement, score: entry.score, degree: entry.degree });
                }
            }
        }
    }

    const seedNodes = activeSeedEntries.map((s) => ({
        id: s.node.id,
        kind: s.node.kind || 'file',
        title: s.node.title || s.node.id,
        path: s.node.path || null,
        score: s.score,
    }));

    // Step 3: Live HydraDB v0.4.0 OpenCypher execution when configured (INV-HS-03)
    let hydraExecution = {
        liveQueried: false,
        mode: 'in-memory-mirror',
        cypherStatements: [],
        lastReadEpoch: null,
        lastBookmark: null,
        latencyMs: 0,
    };

    let liveDiscoveredLogicalIds = [];
    const seedIds = seedNodes.map((s) => s.id);
    if (seedIds.length > 0 && hydraClient && typeof hydraClient.isConfigured === 'function' && hydraClient.isConfigured()) {
        try {
            const rawHydra = await hydraClient.traverseMultiHop({
                seedLogicalIds: seedIds,
                seedIds,
                maxHops: effectiveMaxHops,
                asOf: cleanAsOf,
            });
            const payload = rawHydra?.data && typeof rawHydra.data === 'object' ? rawHydra.data : rawHydra;
            if (Array.isArray(payload?.discoveredLogicalIds)) {
                liveDiscoveredLogicalIds = payload.discoveredLogicalIds;
            }
            hydraExecution = {
                liveQueried: Boolean(rawHydra?.ok !== false && (payload?.liveQueried ?? true)),
                mode: payload?.mode || (rawHydra?.ok === false ? 'fallback-mirror' : 'hydradb-v0.4.0'),
                cypherStatements: Array.isArray(payload?.cypherStatements)
                    ? payload.cypherStatements
                    : (payload?.cypherUsed ? [payload.cypherUsed] : []),
                lastReadEpoch: payload?.lastReadEpoch ?? null,
                lastBookmark: payload?.lastBookmark ?? null,
                latencyMs: Number(payload?.latencyMs ?? 0),
            };
        } catch (err) {
            hydraExecution = {
                liveQueried: false,
                mode: 'fallback-mirror',
                cypherStatements: [],
                lastReadEpoch: null,
                lastBookmark: null,
                latencyMs: 0,
                fallbackReason: scrubSafeText(err?.message || 'HydraDB unreachable'),
            };
        }
    }

    // Step 4: Deterministic Temporal + Structural BFS (0..maxHops) + :GOVERNS / :SUPERSEDES resolution
    const reachedMap = new Map();
    const bfsQueue = [];

    for (const seed of activeSeedEntries) {
        reachedMap.set(seed.node.id, {
            node: seed.node,
            hop: 0,
            role: 'seed',
            priority: 1,
        });
        bfsQueue.push({ id: seed.node.id, hop: 0 });

        // If a seed is a governing decision/invariant, also pull active targets it GOVERNS at hop 1
        for (const e of edges) {
            if (e.type === 'GOVERNS' && e.from === seed.node.id) {
                const target = idx.nodeById.get(e.to);
                if (target && isNodeActiveAt(target, cleanAsOf) && !reachedMap.has(target.id)) {
                    recordEdge(e);
                    reachedMap.set(target.id, {
                        node: target,
                        hop: 1,
                        role: 'governed_target',
                        priority: 2,
                    });
                    bfsQueue.push({ id: target.id, hop: 1 });
                }
            }
        }
    }

    while (bfsQueue.length > 0) {
        const { id: currId, hop } = bfsQueue.shift();
        if (hop >= effectiveMaxHops) continue;

        for (const edge of edges) {
            let nextId = null;
            let edgePriority = 3;

            if (edge.from === currId && FORWARD_TRAVERSAL_TYPES.has(edge.type)) {
                nextId = edge.to;
                edgePriority =
                    edge.type === 'IMPACTS' ||
                    edge.type === 'READS_ENV' ||
                    edge.type === 'TUNED_IN' ||
                    edge.type === 'TOUCHED'
                        ? 2
                        : 3;
            } else if (edge.to === currId && REVERSE_TRAVERSAL_TYPES.has(edge.type)) {
                nextId = edge.from;
                edgePriority = edge.type === 'TUNED_IN' || edge.type === 'READS_ENV' || edge.type === 'TOUCHED' ? 2 : 4;
            }

            if (!nextId) continue;
            const candidate = idx.nodeById.get(nextId);
            if (!candidate) continue;

            if (!isNodeActiveAt(candidate, cleanAsOf)) {
                const lineage = resolveSupersedesComponent(candidate.id, idx.nodeById, edges, cleanAsOf);
                for (const r of lineage.retiredMembers) retiredBlockedMap.set(r.id, r);
                for (const se of lineage.usedSupersedesEdges) recordEdge(se);
                for (const activeRep of lineage.activeMembers) {
                    if (!reachedMap.has(activeRep.id)) {
                        reachedMap.set(activeRep.id, {
                            node: activeRep,
                            hop: hop + 1,
                            role: 'superseding_replacement',
                            priority: 2,
                        });
                        bfsQueue.push({ id: activeRep.id, hop: hop + 1 });
                    }
                }
                continue;
            }

            recordEdge(edge);
            if (!reachedMap.has(candidate.id)) {
                reachedMap.set(candidate.id, {
                    node: candidate,
                    hop: hop + 1,
                    role: `hop_${hop + 1}_${edge.type.toLowerCase()}`,
                    priority: edgePriority,
                });
                bfsQueue.push({ id: candidate.id, hop: hop + 1 });
            }
        }
    }

    // Fold live HydraDB v0.4.0 OpenCypher-discovered nodes directly into reachedMap / retiredBlockedMap
    if (hydraExecution.liveQueried && liveDiscoveredLogicalIds.length > 0) {
        for (const rawLid of liveDiscoveredLogicalIds) {
            const lid = String(rawLid || '').trim();
            if (!lid) continue;
            const liveNode = idx.nodeById.get(lid);
            if (!liveNode) continue;
            if (!isNodeActiveAt(liveNode, cleanAsOf)) {
                const lineage = resolveSupersedesComponent(liveNode.id, idx.nodeById, edges, cleanAsOf);
                for (const r of lineage.retiredMembers) retiredBlockedMap.set(r.id, r);
                for (const se of lineage.usedSupersedesEdges) recordEdge(se);
                for (const activeRep of lineage.activeMembers) {
                    if (!reachedMap.has(activeRep.id)) {
                        reachedMap.set(activeRep.id, {
                            node: activeRep,
                            hop: 2,
                            role: 'hydradb_opencypher_replacement',
                            priority: 2,
                        });
                    }
                }
            } else if (!reachedMap.has(liveNode.id)) {
                reachedMap.set(liveNode.id, {
                    node: liveNode,
                    hop: 2,
                    role: 'hydradb_opencypher_hop',
                    priority: 3,
                });
            }
        }
    }

    // Inspect incoming :GOVERNS and connected :SUPERSEDES chains on every reached node
    const snapshotIds = [...reachedMap.keys()];
    for (const nodeId of snapshotIds) {
        const lineageSelf = resolveSupersedesComponent(nodeId, idx.nodeById, edges, cleanAsOf);
        for (const r of lineageSelf.retiredMembers) retiredBlockedMap.set(r.id, r);
        for (const se of lineageSelf.usedSupersedesEdges) recordEdge(se);

        for (const edge of edges) {
            if (edge.type !== 'GOVERNS' || edge.to !== nodeId) continue;
            const govNode = idx.nodeById.get(edge.from);
            if (!govNode) continue;

            const lineage = resolveSupersedesComponent(govNode.id, idx.nodeById, edges, cleanAsOf);
            for (const r of lineage.retiredMembers) retiredBlockedMap.set(r.id, r);
            for (const se of lineage.usedSupersedesEdges) recordEdge(se);

            for (const activeGov of lineage.activeMembers) {
                if (activeGov.id === govNode.id) {
                    recordEdge(edge);
                } else {
                    recordEdge({
                        from: activeGov.id,
                        to: nodeId,
                        type: 'GOVERNS',
                        reason: `Active superseding governance via ${govNode.id}`,
                    });
                }
                if (!reachedMap.has(activeGov.id)) {
                    const targetHop = reachedMap.get(nodeId)?.hop ?? 0;
                    reachedMap.set(activeGov.id, {
                        node: activeGov,
                        hop: targetHop + 1,
                        role: 'governing_policy',
                        priority: 2,
                    });
                }
            }
        }
    }

    // Step 5: Assemble minimum-token structural context respecting tokenBudget
    const orderedEntries = [...reachedMap.values()].sort(
        (a, b) => a.priority - b.priority || a.hop - b.hop || (a.node.id < b.node.id ? -1 : 1)
    );

    const retiredBlockedNodes = [...retiredBlockedMap.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const headerLines = [
        `// HydraScope Structural Slice | Workspace: ${graph.workspaceName || 'repo'}${cleanAsOf ? ` | As-Of: ${cleanAsOf}` : ' | Mode: Current'}`,
    ];
    for (const ret of retiredBlockedNodes) {
        headerLines.push(
            `// [RETIRED: ${ret.id}${ret.supersededBy ? ` -> Superseded by ${ret.supersededBy}` : ''}${ret.retiredAt ? ` (retired ${ret.retiredAt})` : ''}]`
        );
    }
    const headerBlock = headerLines.join('\n');
    let usedTokens = estimateStructuralTokens(headerBlock) + 2;

    const traversedNodes = [];
    const bodySections = [headerBlock];
    const activeIncludedIds = new Set();

    for (let i = 0; i < orderedEntries.length; i++) {
        const entry = orderedEntries[i];
        const remainingSlots = Math.max(1, orderedEntries.length - i);
        const remainingBudget = effectiveBudget - usedTokens;
        if (remainingBudget < 24) break;

        const metaHeader = `--- [${entry.node.id}] (${entry.node.kind || 'node'} | hop=${entry.hop}${entry.node.path ? ` | ${entry.node.path}` : ''}) ---`;
        const metaTokens = estimateStructuralTokens(metaHeader) + 2;
        if (remainingBudget <= metaTokens + 12) continue;

        const rawTokens = estimateStructuralTokens(entry.node.content || '');
        const totalNeededForRemaining = orderedEntries
            .slice(i)
            .reduce((acc, item) => acc + estimateStructuralTokens(item.node.content || '') + 24, 0);

        const hardCeilingForNode = Math.max(12, remainingBudget - metaTokens - 2);
        const fairShareForNode = Math.max(
            16,
            Math.floor(((remainingBudget - metaTokens * remainingSlots) * 0.9) / remainingSlots)
        );
        const maxExcerptTokens =
            totalNeededForRemaining <= remainingBudget
                ? hardCeilingForNode
                : Math.min(hardCeilingForNode, fairShareForNode);

        const excerpt = formatCompactNodeExcerpt(entry.node, Math.min(rawTokens, maxExcerptTokens));
        const section = excerpt ? `${metaHeader}\n${excerpt}` : metaHeader;
        const sectionTokens = estimateStructuralTokens(section) + 1;
        if (usedTokens + sectionTokens > effectiveBudget && traversedNodes.length > 0) {
            const fallbackHeaderOnlyTokens = estimateStructuralTokens(metaHeader) + 1;
            if (usedTokens + fallbackHeaderOnlyTokens <= effectiveBudget) {
                bodySections.push(metaHeader);
                usedTokens += fallbackHeaderOnlyTokens;
                activeIncludedIds.add(entry.node.id);
                traversedNodes.push({
                    id: entry.node.id,
                    kind: entry.node.kind || 'file',
                    title: entry.node.title || entry.node.id,
                    path: entry.node.path || null,
                    symbols: Array.isArray(entry.node.symbols) ? entry.node.symbols : [],
                    hop: entry.hop,
                    role: entry.role,
                    tokens: fallbackHeaderOnlyTokens,
                    validFrom: entry.node.validFrom || null,
                    retiredAt: entry.node.retiredAt || null,
                    isCurrent: entry.node.isCurrent !== false,
                    supersededBy: entry.node.supersededBy || null,
                });
            }
            continue;
        }

        bodySections.push(section);
        usedTokens += sectionTokens;
        activeIncludedIds.add(entry.node.id);
        traversedNodes.push({
            id: entry.node.id,
            kind: entry.node.kind || 'file',
            title: entry.node.title || entry.node.id,
            path: entry.node.path || null,
            symbols: Array.isArray(entry.node.symbols) ? entry.node.symbols : [],
            hop: entry.hop,
            role: entry.role,
            tokens: sectionTokens,
            validFrom: entry.node.validFrom || null,
            retiredAt: entry.node.retiredAt || null,
            isCurrent: entry.node.isCurrent !== false,
            supersededBy: entry.node.supersededBy || null,
        });
    }

    const retiredIds = new Set(retiredBlockedNodes.map((r) => r.id));
    const traversedEdges = [...traversedEdgeMap.values()].filter(
        (e) =>
            (activeIncludedIds.has(e.from) || retiredIds.has(e.from)) &&
            (activeIncludedIds.has(e.to) || retiredIds.has(e.to))
    );

    const contextText = bodySections.join('\n\n');
    const tokenCount = Math.min(effectiveBudget, estimateStructuralTokens(contextText));
    const tokenSavingsRatio =
        fullRepoTokens > 0 ? Number(Math.max(0, (fullRepoTokens - tokenCount) / fullRepoTokens).toFixed(4)) : 0;
    const cypherQuery =
        hydraExecution.cypherStatements.length > 0
            ? hydraExecution.cypherStatements.join('\n\n')
            : buildDisplayCypherQuery(seedIds, effectiveMaxHops, cleanAsOf);

    return okEnvelope(
        'hydrascope.traverse',
        `Traversed ${traversedNodes.length} active node(s), blocked ${retiredBlockedNodes.length} retired node(s) in ${tokenCount} tokens`,
        {
            answerability,
            asOf: cleanAsOf,
            seedNodes,
            selectedNodeIds: traversedNodes.map((n) => n.id),
            traversedNodes,
            traversedEdges,
            retiredBlockedNodes,
            contextText,
            tokenCount,
            fullRepoTokens,
            tokenSavingsRatio,
            cypherQuery,
            hydraExecution,
        }
    );
}

/**
 * Supersede an existing architectural decision in `graph` (`:SUPERSEDES` + `:GOVERNS`)
 * and synchronize the mutation to HydraDB `v0.4.0` when configured.
 *
 * @param {object} graph
 * @param {object} [options={}]
 * @returns {Promise<object>} `INV-LEGO-01` envelope
 */
export async function supersedeDecisionInGraph(
    graph,
    {
        oldId,
        newId,
        title,
        content,
        governsIds = [],
        effectiveAt = new Date().toISOString().slice(0, 10),
        hydraClient = null,
    } = {}
) {
    if (!graph || !Array.isArray(graph.nodes)) {
        return errorEnvelope('INVALID_GRAPH', 'Valid graph object is required.', null, 'hydrascope.supersede');
    }

    const validation = validateSupersedePayload({
        oldId,
        newId,
        title,
        content,
        governsIds,
        effectiveAt,
    });
    if (!validation.ok) {
        return errorEnvelope(validation.code, validation.message, null, 'hydrascope.supersede');
    }

    const {
        oldId: cleanOldId,
        newId: cleanNewId,
        title: rawTitle,
        content: rawContent,
        governsIds: sanitizedGovernsIds,
        effectiveAt: cleanEffectiveAt,
    } = validation.value;
    const cleanTitle = scrubSensitiveText(rawTitle);
    const cleanContent = scrubSensitiveText(rawContent);

    const dynamicCount = graph.nodes.filter((n) => n?._dynamicSupersede === true).length;
    if (dynamicCount >= MAX_CUSTOM_DECISIONS) {
        return errorEnvelope(
            'DECISION_LIMIT_REACHED',
            `Workspace has reached the maximum of ${MAX_CUSTOM_DECISIONS} dynamic supersessions. Reset workspace to add more.`,
            { limit: MAX_CUSTOM_DECISIONS },
            'hydrascope.supersede'
        );
    }

    const oldNode =
        graph.nodes.find((n) => n.id === cleanOldId) ||
        graph.nodes.find((n) => bareLogicalId(n.id).toLowerCase() === bareLogicalId(cleanOldId).toLowerCase());

    if (!oldNode) {
        return errorEnvelope(
            'DECISION_NOT_FOUND',
            `Decision node "${cleanOldId}" does not exist in workspace graph.`,
            { oldId: cleanOldId },
            'hydrascope.supersede'
        );
    }

    if (oldNode.isCurrent === false) {
        return errorEnvelope(
            'DECISION_ALREADY_RETIRED',
            `Decision node "${oldNode.id}" is already retired${oldNode.supersededBy ? ` by ${oldNode.supersededBy}` : ''}. Supersede the currently active replacement instead.`,
            { oldId: oldNode.id, supersededBy: oldNode.supersededBy || null },
            'hydrascope.supersede'
        );
    }

    const hasPrefix = oldNode.id.includes(':') && !cleanNewId.includes(':');
    const resolvedNewId = hasPrefix ? `${oldNode.id.split(':')[0]}:${cleanNewId}` : cleanNewId;
    const resolvedNewBare = bareLogicalId(resolvedNewId).toLowerCase();

    if (
        resolvedNewId === oldNode.id ||
        graph.nodes.some(
            (n) =>
                n.id === resolvedNewId ||
                bareLogicalId(n.id).toLowerCase() === resolvedNewBare
        )
    ) {
        return errorEnvelope(
            'DUPLICATE_DECISION_ID',
            `Decision node "${resolvedNewId}" already exists in workspace graph.`,
            { newId: resolvedNewId },
            'hydrascope.supersede'
        );
    }

    oldNode.isCurrent = false;
    oldNode.retiredAt = cleanEffectiveAt;
    oldNode.supersededBy = resolvedNewId;

    if (!Array.isArray(graph.edges)) {
        graph.edges = [];
    }

    const inheritedTargets = graph.edges
        .map(normalizeEdge)
        .filter((e) => e && e.type === 'GOVERNS' && e.from === oldNode.id)
        .map((e) => e.to);

    const requestedTargets = sanitizedGovernsIds.length > 0
        ? sanitizedGovernsIds
            .map((gid) => {
                const match =
                    graph.nodes.find((n) => n.id === gid) ||
                    graph.nodes.find((n) => bareLogicalId(n.id).toLowerCase() === bareLogicalId(gid).toLowerCase());
                return match ? match.id : gid;
            })
            .filter(Boolean)
        : inheritedTargets;

    const slug = bareLogicalId(resolvedNewId)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-');
    const newNode = {
        id: resolvedNewId,
        kind: oldNode.kind || 'decision',
        title: cleanTitle,
        path: `docs/adr/${slug}.md`,
        symbols: [bareLogicalId(resolvedNewId)],
        synonyms: Array.isArray(oldNode.synonyms) ? [...oldNode.synonyms] : [],
        content: cleanContent,
        tokens: estimateStructuralTokens(cleanContent),
        validFrom: cleanEffectiveAt,
        retiredAt: null,
        isCurrent: true,
        supersededBy: null,
        _dynamicSupersede: true,
    };

    graph.nodes.push(newNode);
    graph.totalRepoTokens = (Number(graph.totalRepoTokens) || 0) + newNode.tokens;

    const newEdges = [
        {
            from: newNode.id,
            to: oldNode.id,
            type: 'SUPERSEDES',
            reason: `Supersedes ${oldNode.id} effective ${cleanEffectiveAt}`,
        },
    ];

    for (const targetId of new Set(requestedTargets)) {
        newEdges.push({
            from: newNode.id,
            to: targetId,
            type: 'GOVERNS',
            reason: `Active decision ${newNode.id} governs ${targetId}`,
        });
    }
    graph.edges.push(...newEdges);

    // Update graph ontology safely using null-prototype map (`SEC-01` prototype & Array.length protection)
    if (!graph.ontology || typeof graph.ontology !== 'object') {
        graph.ontology = { terms: Object.create(null), knownConcepts: [], synonyms: Object.create(null) };
    }
    if (!graph.ontology.terms || typeof graph.ontology.terms !== 'object' || Array.isArray(graph.ontology.terms)) {
        const migrated = Object.create(null);
        if (Array.isArray(graph.ontology.terms)) {
            for (const existing of graph.ontology.terms) {
                if (typeof existing === 'string' && !FORBIDDEN_OBJECT_KEYS.has(existing)) {
                    migrated[existing] = [];
                }
            }
        }
        graph.ontology.terms = migrated;
    }
    if (!Array.isArray(graph.ontology.knownConcepts)) {
        graph.ontology.knownConcepts = [];
    }

    const newConceptTokens = new Set([
        bareLogicalId(newNode.id).toLowerCase(),
        ...splitIdentifierParts(cleanTitle),
        ...(cleanContent.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter(
            (w) => !STOP_AND_FRAMING_WORDS.has(w) && !EXTERNAL_SUBSYSTEM_TERMS.has(w)
        ),
    ]);
    for (const tok of newConceptTokens) {
        if (!tok || FORBIDDEN_OBJECT_KEYS.has(tok)) continue;
        if (!Object.hasOwn(graph.ontology.terms, tok) || !Array.isArray(graph.ontology.terms[tok])) {
            graph.ontology.terms[tok] = [];
        }
        if (!graph.ontology.terms[tok].includes(newNode.id)) {
            graph.ontology.terms[tok].push(newNode.id);
        }
        if (!graph.ontology.knownConcepts.includes(tok)) {
            graph.ontology.knownConcepts.push(tok);
        }
    }

    let hydraSync = {
        liveSynced: false,
        mode: 'in-memory-mirror',
        latencyMs: 0,
    };
    if (hydraClient && typeof hydraClient.isConfigured === 'function' && hydraClient.isConfigured()) {
        try {
            const syncRes = await hydraClient.syncGraphSnapshot({
                nodes: [oldNode, newNode],
                edges: newEdges,
            });
            const payload = syncRes?.data && typeof syncRes.data === 'object' ? syncRes.data : syncRes;
            hydraSync = {
                liveSynced: Boolean(syncRes?.ok !== false && (payload?.liveSynced ?? true)),
                mode: payload?.mode || 'hydradb-v0.4.0',
                nodesWritten: payload?.nodesWritten ?? 2,
                edgesWritten: payload?.edgesWritten ?? newEdges.length,
                latencyMs: Number(payload?.latencyMs ?? 0),
            };
        } catch (err) {
            hydraSync = {
                liveSynced: false,
                mode: 'fallback-mirror',
                latencyMs: 0,
                fallbackReason: scrubSafeText(err?.message || 'HydraDB sync skipped'),
            };
        }
    }

    return okEnvelope(
        'hydrascope.supersede',
        `Superseded ${oldNode.id} with ${newNode.id} effective ${cleanEffectiveAt}`,
        {
            retiredNode: {
                id: oldNode.id,
                title: oldNode.title,
                retiredAt: oldNode.retiredAt,
                isCurrent: oldNode.isCurrent,
                supersededBy: oldNode.supersededBy,
            },
            newNode,
            addedEdges: newEdges,
            effectiveAt: cleanEffectiveAt,
            hydraSync,
        }
    );
}
