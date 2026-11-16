/**
 * @module utils/validation
 * @description Strict zero-`node:*` validators for ISO-8601 calendar dates, graph decision
 * mutation bounds, and dynamic scenario synthesis for compiled repositories.
 */

import { FORBIDDEN_OBJECT_KEYS } from './scrubber.js';

const ISO_DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SAFE_NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:./-]{0,127}$/;

export const MAX_CUSTOM_DECISIONS = 32;
export const MAX_TITLE_CHARS = 240;
export const MAX_DECISION_CONTENT_CHARS = 8192;
export const MAX_GOVERNS_TARGETS = 32;
export const MAX_QUERY_CHARS = 1000;

/**
 * Validate a strict real UTC calendar date formatted as `YYYY-MM-DD`.
 * Rejects malformed strings, SQL/Cypher quotes, and impossible calendar dates like `2026-02-31`.
 *
 * @param {unknown} rawDate - Candidate date string
 * @returns {boolean}
 */
export function isValidIsoDate(rawDate) {
    if (typeof rawDate !== 'string') return false;
    const trimmed = rawDate.trim();
    const match = ISO_DATE_RE.exec(trimmed);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const utc = new Date(Date.UTC(year, month - 1, day));
    return (
        utc.getUTCFullYear() === year &&
        utc.getUTCMonth() === month - 1 &&
        utc.getUTCDate() === day
    );
}

/**
 * Normalize an optional `asOf` parameter: returns `{ ok: true, value: string|null }` or `{ ok: false, message }`.
 *
 * @param {unknown} rawAsOf - Optional ISO date string
 * @returns {{ ok: true, value: string | null } | { ok: false, code: string, message: string }}
 */
export function validateOptionalAsOf(rawAsOf) {
    if (rawAsOf === null || rawAsOf === undefined) {
        return { ok: true, value: null };
    }
    const trimmed = String(rawAsOf).trim();
    if (!trimmed) {
        return { ok: true, value: null };
    }
    if (!isValidIsoDate(trimmed)) {
        return {
            ok: false,
            code: 'INVALID_DATE',
            message: `Invalid asOf date "${trimmed.slice(0, 40)}". Expected valid calendar date in YYYY-MM-DD format.`
        };
    }
    return { ok: true, value: trimmed };
}

/**
 * Check whether a candidate node identifier is safe and immune to prototype-key collisions.
 *
 * @param {unknown} rawId - Candidate node ID
 * @returns {boolean}
 */
export function isSafeNodeIdentifier(rawId) {
    if (typeof rawId !== 'string') return false;
    const trimmed = rawId.trim();
    if (!trimmed || !SAFE_NODE_ID_RE.test(trimmed)) return false;
    const lower = trimmed.toLowerCase();
    const bare = lower.replace(/^[a-z_]+:/, '');
    if (
        FORBIDDEN_OBJECT_KEYS.has(trimmed) ||
        FORBIDDEN_OBJECT_KEYS.has(lower) ||
        FORBIDDEN_OBJECT_KEYS.has(bare)
    ) {
        return false;
    }
    return true;
}

/**
 * Validate inputs to `supersedeDecision` before mutating any graph or database state.
 *
 * @param {object} [params={}] - Candidate supersede payload
 * @returns {{ ok: true, value: object } | { ok: false, code: string, message: string }}
 */
export function validateSupersedePayload({
    oldId,
    newId,
    title,
    content,
    governsIds = [],
    effectiveAt
} = {}) {
    const cleanOldId = String(oldId ?? '').trim();
    const cleanNewId = String(newId ?? '').trim();
    const cleanTitle = String(title ?? '').trim();
    const cleanContent = String(content ?? '').trim();
    const cleanEffectiveAt =
        effectiveAt !== undefined && effectiveAt !== null && String(effectiveAt).trim() !== ''
            ? String(effectiveAt).trim()
            : new Date().toISOString().slice(0, 10);

    if (!cleanOldId || !cleanNewId || !cleanTitle || !cleanContent) {
        return {
            ok: false,
            code: 'VALIDATION_ERROR',
            message: 'Fields oldId, newId, title, and content are required to supersede a decision.'
        };
    }

    if (!isSafeNodeIdentifier(cleanOldId)) {
        return {
            ok: false,
            code: 'INVALID_NODE_ID',
            message: 'Field "oldId" must be 1..128 safe identifier characters ([A-Za-z0-9_:./-]).'
        };
    }

    if (!isSafeNodeIdentifier(cleanNewId)) {
        return {
            ok: false,
            code: 'INVALID_NODE_ID',
            message: 'Field "newId" must be 1..128 safe identifier characters ([A-Za-z0-9_:./-]).'
        };
    }

    if (cleanTitle.length > MAX_TITLE_CHARS) {
        return {
            ok: false,
            code: 'TITLE_TOO_LONG',
            message: `Field "title" exceeds maximum length of ${MAX_TITLE_CHARS} characters.`
        };
    }

    if (cleanContent.length > MAX_DECISION_CONTENT_CHARS) {
        return {
            ok: false,
            code: 'CONTENT_TOO_LONG',
            message: `Field "content" exceeds maximum length of ${MAX_DECISION_CONTENT_CHARS} characters.`
        };
    }

    if (!isValidIsoDate(cleanEffectiveAt)) {
        return {
            ok: false,
            code: 'INVALID_DATE',
            message: `Invalid effectiveAt date "${cleanEffectiveAt.slice(0, 40)}". Expected valid YYYY-MM-DD date.`
        };
    }

    if (!Array.isArray(governsIds) || governsIds.length > MAX_GOVERNS_TARGETS) {
        return {
            ok: false,
            code: 'INVALID_GOVERNS_IDS',
            message: `Field "governsIds" must be an array of at most ${MAX_GOVERNS_TARGETS} target IDs.`
        };
    }

    const sanitizedGoverns = [];
    for (const item of governsIds) {
        const cleanTarget = String(item ?? '').trim();
        if (!cleanTarget) continue;
        if (!isSafeNodeIdentifier(cleanTarget)) {
            return {
                ok: false,
                code: 'INVALID_GOVERNS_IDS',
                message: `Invalid governed target identifier "${cleanTarget.slice(0, 40)}".`
            };
        }
        sanitizedGoverns.push(cleanTarget);
    }

    return {
        ok: true,
        value: {
            oldId: cleanOldId,
            newId: cleanNewId,
            title: cleanTitle,
            content: cleanContent,
            governsIds: sanitizedGoverns,
            effectiveAt: cleanEffectiveAt
        }
    };
}

/**
 * Synthesize grounded evaluation scenarios from a compiled custom directory graph so
 * Arena presets and Benchmark suites stay valid after `Compile ./src` (`UX-02`).
 *
 * @param {object} graph - Compiled HydraScope workspace graph
 * @returns {Array<object>}
 */
export function buildDynamicScenariosForGraph(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    if (nodes.length === 0) return [];

    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const outgoingImpacts = new Map();
    for (const edge of edges) {
        if (edge?.type !== 'IMPACTS') continue;
        if (!outgoingImpacts.has(edge.from)) outgoingImpacts.set(edge.from, []);
        outgoingImpacts.get(edge.from).push(edge.to);
    }

    const codeNodes = nodes.filter((n) => n.kind === 'code');
    const scenarios = [];

    // 1. Pick highest out-degree code module for blast-radius scenario
    const rankedCode = [...codeNodes].sort(
        (a, b) => (outgoingImpacts.get(b.id)?.length || 0) - (outgoingImpacts.get(a.id)?.length || 0)
    );
    const primaryCode = rankedCode[0] || nodes[0];
    if (primaryCode) {
        const sym = primaryCode.symbols?.[0] || primaryCode.path || primaryCode.title;
        const hop1 = (outgoingImpacts.get(primaryCode.id) || []).filter((id) => nodeById.has(id));
        const required = [primaryCode.id, ...hop1.slice(0, 2)];
        scenarios.push({
            id: 'DYN-1',
            category: 'blast_radius',
            title: `Impact Blast Radius: ${sym}`,
            query: `What downstream modules and callers are impacted if I modify ${sym}?`,
            tokenBudget: 900,
            expectAnswerable: true,
            requiredNodeIds: required,
            forbiddenPoisonNodeIds: [],
            explanation: `Traces structural :IMPACTS edges out of ${primaryCode.title}.`
        });
    }

    // 2. Second module or environment/governance artifact
    const secondaryCode = rankedCode[1];
    if (secondaryCode) {
        const sym2 = secondaryCode.symbols?.[0] || secondaryCode.path || secondaryCode.title;
        const hop1 = (outgoingImpacts.get(secondaryCode.id) || []).filter((id) => nodeById.has(id));
        scenarios.push({
            id: 'DYN-2',
            category: 'cross_artifact_trace',
            title: `Module Trace: ${sym2}`,
            query: `Trace callers and dependencies connected to ${sym2}`,
            tokenBudget: 900,
            expectAnswerable: true,
            requiredNodeIds: [secondaryCode.id, ...hop1.slice(0, 1)],
            forbiddenPoisonNodeIds: [],
            explanation: `Resolves structural dependency graph around ${secondaryCode.title}.`
        });
    }

    // 3. Ungrounded subsystem trap (`0` tokens burned)
    const anchorSym = primaryCode?.symbols?.[0] || 'server';
    scenarios.push({
        id: 'DYN-3',
        category: 'ungrounded_trap',
        title: 'Ungrounded Kafka Consumer Trap',
        query: `What is the Kafka consumer group lag threshold for ${anchorSym}?`,
        tokenBudget: 800,
        expectAnswerable: false,
        requiredNodeIds: [],
        forbiddenPoisonNodeIds: [],
        explanation: 'Blocks ungrounded external subsystem ("Kafka") pre-flight at 0 tokens.'
    });

    return scenarios;
}
