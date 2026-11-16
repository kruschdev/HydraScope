/**
 * @module utils/scrubber
 * @description Zero-`node:*` outbound privacy & secret scrubber (`INV-HS-02`) shared across
 * Node.js connectors, repository compilers, runtime state, and Cloudflare Edge Workers.
 */

export const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SENSITIVE_FIELD_NAME_RE =
    /(?:^|[_-])(?:authorization|bearer|password|passwd|secret|api[_-]?key|token|private[_-]?key|cookie|x-api-key)$|(?:Token|Secret|Password|ApiKey|PrivateKey)$/i;

const INTERNAL_HOST_TOKEN =
    '(?:localhost|\\[::1\\]|\\[(?:f[cd][0-9a-f]{0,2}|fe80):[^\\]]*\\]|127(?:\\.\\d{1,3}){3}|0\\.0\\.0\\.0|10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}|169\\.254(?:\\.\\d{1,3}){2}|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(?:\\.\\d{1,3}){2})';

const INTERNAL_URL_RE = new RegExp(
    `https?:\\/\\/${INTERNAL_HOST_TOKEN}(?::\\d{1,5})?(?:\\/[^\\s"'<>\\])]*)?`,
    'gi'
);
const INTERNAL_HOST_PORT_RE = new RegExp(
    `(?:\\b(?:localhost|127(?:\\.\\d{1,3}){3}|0\\.0\\.0\\.0|10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}|169\\.254(?:\\.\\d{1,3}){2}|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(?:\\.\\d{1,3}){2})(?::\\d{1,5})?\\b|\\[(?:::1|(?:f[cd][0-9a-f]{0,2}|fe80):[^\\]]*)\\](?::\\d{1,5})?)`,
    'gi'
);
const IPV6_ULA_BARE_RE = /\b(?:f[cd][0-9a-f]{2}|fe80):(?:[0-9a-f]{0,4}:){2,6}[0-9a-f]{1,4}\b/gi;

const BEARER_OR_BASIC_SECRET_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const PREFIXED_TOKEN_RE =
    /\b(?:hdb_[A-Za-z0-9_-]{4,}|sk_[A-Za-z0-9_-]{4,}|sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{12,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const URL_CREDENTIALS_RE = /\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const LOCAL_USER_PATH_RE =
    /\/(?:(?:home|Users)\/[A-Za-z0-9._-]+|root)(?:\/[^\s"'<>:;,)\]]*)?/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Scrub a single string for credentials, secret tokens, private/Tailscale/loopback/ULA hosts,
 * local user-home or `/root` paths, and email addresses (`INV-HS-02`).
 *
 * @param {unknown} raw - Raw text input
 * @returns {string}
 */
export function scrubSensitiveText(raw) {
    return String(raw ?? '')
        .replace(BEARER_OR_BASIC_SECRET_RE, '$1 [REDACTED_TOKEN]')
        .replace(PREFIXED_TOKEN_RE, '[REDACTED_SECRET]')
        .replace(URL_CREDENTIALS_RE, '$1[REDACTED_CREDENTIALS]@')
        .replace(INTERNAL_URL_RE, '[REDACTED_INTERNAL_URL]')
        .replace(INTERNAL_HOST_PORT_RE, '[REDACTED_INTERNAL_HOST]')
        .replace(IPV6_ULA_BARE_RE, '[REDACTED_INTERNAL_HOST]')
        .replace(LOCAL_USER_PATH_RE, '[REDACTED_LOCAL_PATH]')
        .replace(EMAIL_RE, '[REDACTED_EMAIL]');
}

/**
 * Recursively scrub sensitive tokens, private/Tailscale/loopback network endpoints,
 * local user-home filesystem paths, and email addresses (`INV-HS-02`).
 *
 * @param {unknown} value - Arbitrary string, array, Error, or object structure
 * @returns {unknown}
 */
export function scrubSensitiveStrings(value) {
    const seen = new WeakSet();

    const visit = (current) => {
        if (typeof current === 'string') {
            return scrubSensitiveText(current);
        }
        if (current === null || current === undefined || typeof current !== 'object') {
            return current;
        }
        if (seen.has(current)) {
            return '[Circular]';
        }
        seen.add(current);

        if (Array.isArray(current)) {
            return current.map((item) => visit(item));
        }
        if (current instanceof Error) {
            return {
                name: scrubSensitiveText(String(current.name || 'Error')),
                message: scrubSensitiveText(String(current.message || ''))
            };
        }

        const out = {};
        for (const [key, val] of Object.entries(current)) {
            if (FORBIDDEN_OBJECT_KEYS.has(key)) continue;
            const safeKey = scrubSensitiveText(key);
            if (SENSITIVE_FIELD_NAME_RE.test(key) && typeof val === 'string' && val.trim().length > 0) {
                out[safeKey] = '[REDACTED_SECRET]';
            } else {
                out[safeKey] = visit(val);
            }
        }
        return out;
    };

    return visit(value);
}
