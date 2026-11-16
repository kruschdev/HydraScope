/**
 * @module engines/repo-compiler
 * @description Structural repository compiler that transforms raw code, ADR, invariant,
 * environment template, incident, and PR artifacts (or live filesystem directories)
 * into HydraScope typed property graphs and pre-flight domain ontologies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { FORBIDDEN_OBJECT_KEYS, scrubSensitiveText } from '../utils/scrubber.js';

const TOOL_NAME = 'hydrascope.compile_dir';
const MAX_FILE_BYTES = 131072; // 128 KiB

const SKIPPED_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    'coverage',
    '.cache',
    '.turbo',
    '__pycache__',
    '.venv',
    'venv',
    'vendor',
    'logs',
    'data',
]);

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const ENV_TEMPLATE_NAMES = new Set(['.env.example', '.env.sample', '.env.template']);

const CODE_PROBE_EXTS = [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '/index.ts',
    '/index.tsx',
    '/index.js',
    '/index.mjs',
    '/__init__.py',
];

/**
 * Scrub local home paths, private/Tailscale/loopback IPs, and email addresses per INV-HS-02.
 *
 * @param {unknown} raw - Input string
 * @returns {string}
 */
function sanitizeMetadataText(raw) {
    return scrubSensitiveText(raw);
}

/**
 * Deterministically estimate LLM token weight at ~4 UTF-8 bytes per token.
 *
 * @param {unknown} text - Text content
 * @returns {number}
 */
export function estimateTokens(text) {
    return Math.max(1, Math.ceil(Buffer.byteLength(String(text || ''), 'utf8') / 4));
}

/**
 * Normalize a relative file path to POSIX forward-slash form without leading `./` or `/`.
 *
 * @param {unknown} rawPath - Candidate path
 * @returns {string}
 */
function normalizeRelPath(rawPath) {
    return sanitizeMetadataText(rawPath)
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .trim();
}

/**
 * Deduplicate and trim an array of non-empty strings while preserving first-seen order.
 *
 * @param {unknown} list - Candidate string array
 * @returns {string[]}
 */
function uniqueStrings(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const val = String(item ?? '').trim();
        if (!val || seen.has(val)) continue;
        seen.add(val);
        out.push(val);
    }
    return out;
}

/**
 * Split camelCase, PascalCase, acronym runs, snake_case, kebab-case, and punctuation into lowercase tokens.
 *
 * @param {unknown} raw - Identifier or phrase
 * @returns {string[]}
 */
function splitIdentifierTokens(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return [];
    const expanded = str
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    const parts = expanded.toLowerCase().split(/[^a-z0-9]+/g);
    const tokens = [];
    for (const part of parts) {
        if (part.length >= 2) {
            tokens.push(part);
        }
    }
    return tokens;
}

/**
 * Extract exported/top-level symbols from JS/TS/JSX/TSX or Python source code.
 *
 * @param {string} content - Source code text
 * @param {string} filePath - Normalized relative path
 * @returns {string[]}
 */
function extractCodeSymbols(content, filePath = '') {
    const src = String(content || '');
    const symbols = [];
    const isPython = filePath.endsWith('.py');

    if (isPython) {
        const pySymRe = /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)\b/gm;
        let m;
        while ((m = pySymRe.exec(src)) !== null) {
            if (!m[1].startsWith('_')) {
                symbols.push(m[1]);
            }
        }
        return uniqueStrings(symbols);
    }

    const esExportDeclRe = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
    let match;
    while ((match = esExportDeclRe.exec(src)) !== null) {
        symbols.push(match[1]);
    }

    const esNamedExportRe = /\bexport\s*\{\s*([^}]+)\}/g;
    while ((match = esNamedExportRe.exec(src)) !== null) {
        for (const chunk of match[1].split(',')) {
            const cleaned = chunk.trim();
            if (!cleaned) continue;
            const aliasParts = cleaned.split(/\s+as\s+/);
            const exportedName = (aliasParts[1] || aliasParts[0] || '').trim();
            if (/^[A-Za-z_$][\w$]*$/.test(exportedName) && exportedName !== 'default') {
                symbols.push(exportedName);
            }
        }
    }

    const cjsExportsRe = /\bmodule\.exports\s*=\s*\{\s*([^}]+)\}/g;
    while ((match = cjsExportsRe.exec(src)) !== null) {
        for (const chunk of match[1].split(',')) {
            const key = chunk.split(':')[0].trim();
            if (/^[A-Za-z_$][\w$]*$/.test(key)) {
                symbols.push(key);
            }
        }
    }

    return uniqueStrings(symbols);
}

/**
 * Extract relative module specifiers from ES module, CommonJS, and Python imports.
 *
 * @param {string} content - Source file content
 * @param {string} filePath - Normalized file path
 * @returns {string[]}
 */
function extractRelativeImports(content, filePath = '') {
    const src = String(content || '');
    const specifiers = [];
    const isPython = filePath.endsWith('.py');

    if (isPython) {
        const pyFromRe = /^\s*from\s+(\.+[A-Za-z0-9_.]*)\s+import\b/gm;
        let m;
        while ((m = pyFromRe.exec(src)) !== null) {
            const rawSpec = m[1];
            const dotMatch = /^(\.+)(.*)$/.exec(rawSpec);
            if (!dotMatch) continue;
            const dots = dotMatch[1].length;
            const modTail = dotMatch[2].replace(/\./g, '/');
            const upPrefix = dots === 1 ? './' : '../'.repeat(dots - 1);
            specifiers.push(`${upPrefix}${modTail}`);
        }
        return uniqueStrings(specifiers);
    }

    const staticImportRe = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]{0,240}?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;
    let match;
    while ((match = staticImportRe.exec(src)) !== null) {
        specifiers.push(match[1]);
    }

    const dynamicOrCjsRe = /\b(?:require|import)\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
    while ((match = dynamicOrCjsRe.exec(src)) !== null) {
        specifiers.push(match[1]);
    }

    return uniqueStrings(specifiers);
}

/**
 * Extract environment variable keys read via `process.env` or Python `os.environ` / `os.getenv`.
 *
 * @param {string} content - Source file content
 * @returns {string[]}
 */
function extractEnvReads(content) {
    const src = String(content || '');
    const keys = [];

    const dotEnvRe = /\bprocess\.env\.([A-Z][A-Z0-9_]{1,80})\b/g;
    let m;
    while ((m = dotEnvRe.exec(src)) !== null) {
        keys.push(m[1]);
    }

    const bracketEnvRe = /\bprocess\.env\[\s*['"]([A-Z][A-Z0-9_]{1,80})['"]\s*\]/g;
    while ((m = bracketEnvRe.exec(src)) !== null) {
        keys.push(m[1]);
    }

    const pyEnvRe = /\bos\.(?:environ\.get|getenv)\s*\(\s*['"]([A-Z][A-Z0-9_]{1,80})['"]|\bos\.environ\[\s*['"]([A-Z][A-Z0-9_]{1,80})['"]\s*\]/g;
    while ((m = pyEnvRe.exec(src)) !== null) {
        keys.push(m[1] || m[2]);
    }

    return uniqueStrings(keys);
}

/**
 * Extract declared `KEY=...` names from `.env.example` content.
 *
 * @param {string} content - Env file content
 * @returns {string[]}
 */
function extractDefinedEnvKeys(content) {
    const keys = [];
    const lines = String(content || '').split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^(?:export\s+)?([A-Z][A-Z0-9_]{1,80})\s*=/.exec(line);
        if (m) {
            keys.push(m[1]);
        }
    }
    return uniqueStrings(keys);
}

/**
 * Resolve a relative import specifier from `importerPath` to a target `GraphNode`.
 *
 * @param {string} importerPath - Normalized importer path
 * @param {string} specifier - Relative import string (`./x` or `../y`)
 * @param {Map<string, object>} codeByPath - Lookup map from normalized path to GraphNode
 * @returns {object|null}
 */
function resolveImportedCodeNode(importerPath, specifier, codeByPath) {
    const cleanSpec = String(specifier || '').split('?')[0].split('#')[0].trim();
    if (!cleanSpec.startsWith('.')) return null;

    const baseDir = path.posix.dirname(importerPath || '.');
    const joined = path.posix.normalize(path.posix.join(baseDir, cleanSpec));
    const candidates = new Set([joined]);

    // Support TypeScript ESM `.js` -> `.ts` resolution as well as extensionless imports.
    if (joined.endsWith('.js')) {
        const stem = joined.slice(0, -3);
        candidates.add(`${stem}.ts`);
        candidates.add(`${stem}.tsx`);
    } else if (joined.endsWith('.mjs')) {
        candidates.add(`${joined.slice(0, -4)}.mts`);
    }

    for (const ext of CODE_PROBE_EXTS) {
        candidates.add(`${joined}${ext}`);
    }

    for (const candidate of candidates) {
        const hit = codeByPath.get(candidate);
        if (hit) return hit;
    }
    return null;
}

/**
 * Compile an array of normalized or raw engineering artifacts into a HydraScope structural graph.
 *
 * @param {Array<object>} [artifacts=[]] - Engineering artifact descriptors
 * @param {object} [options={}] - Compiler options
 * @param {string} [options.workspaceName='fintech-core'] - Logical workspace identifier
 * @returns {{
 *   workspaceName: string,
 *   nodes: Array<object>,
 *   edges: Array<{ from: string, to: string, type: string, reason: string }>,
 *   ontology: { terms: string[], knownConcepts: string[], synonyms: Record<string, string[]> },
 *   totalRepoTokens: number
 * }}
 */
export function compileArtifactsToGraph(artifacts = [], { workspaceName = 'fintech-core' } = {}) {
    const safeWorkspace = sanitizeMetadataText(workspaceName || 'fintech-core').trim() || 'fintech-core';
    const rawList = Array.isArray(artifacts) ? artifacts : [];

    const nodeById = new Map();
    const codeByPath = new Map();
    const envKeyToNodeIds = new Map();
    const rawMetaById = new Map();
    const nodes = [];

    for (const raw of rawList) {
        if (!raw || typeof raw !== 'object' || !raw.id) continue;
        const id = String(raw.id).trim();
        if (!id || nodeById.has(id)) continue;

        const kind = String(raw.kind || 'code').trim();
        const relPath = normalizeRelPath(raw.path || id);
        const content = String(raw.content || '');
        const declaredSymbols = uniqueStrings(raw.symbols);
        const symbols =
            declaredSymbols.length > 0
                ? declaredSymbols
                : kind === 'code'
                  ? extractCodeSymbols(content, relPath)
                  : kind === 'env'
                    ? extractDefinedEnvKeys(content)
                    : [];
        const synonyms = uniqueStrings(raw.synonyms);
        const validFrom = raw.validFrom ? String(raw.validFrom).trim() : null;
        const retiredAt = raw.retiredAt ? String(raw.retiredAt).trim() : null;

        const node = {
            id,
            kind,
            title: String(raw.title || relPath || id).trim(),
            path: relPath,
            symbols,
            synonyms,
            content,
            tokens: estimateTokens(content),
            validFrom,
            retiredAt,
            isCurrent: !retiredAt,
            supersededBy: null,
        };

        nodes.push(node);
        nodeById.set(id, node);
        rawMetaById.set(id, {
            supersedesId: raw.supersedesId ? String(raw.supersedesId).trim() : null,
            governsIds: uniqueStrings(raw.governsIds),
            touchesIds: uniqueStrings(raw.touchesIds),
            tunedInIds: uniqueStrings(raw.tunedInIds),
            explicitImpactsIds: uniqueStrings(raw.explicitImpactsIds),
        });

        if (kind === 'code' && relPath) {
            codeByPath.set(relPath, node);
        }
        if (kind === 'env') {
            const envKeys = uniqueStrings([
                ...symbols,
                ...extractDefinedEnvKeys(content),
                ...(id.startsWith('env:') ? [id.slice(4)] : []),
            ]);
            for (const envKey of envKeys) {
                if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(envKey)) continue;
                if (!envKeyToNodeIds.has(envKey)) envKeyToNodeIds.set(envKey, []);
                envKeyToNodeIds.get(envKey).push(id);
            }
        }
    }

    // Pass 2: Resolve temporal supersession chains before emitting edges.
    for (const node of nodes) {
        const meta = rawMetaById.get(node.id);
        if (!meta?.supersedesId) continue;
        const older = nodeById.get(meta.supersedesId);
        if (!older) continue;
        older.isCurrent = false;
        older.supersededBy = node.id;
        if (!older.retiredAt && node.validFrom) {
            older.retiredAt = node.validFrom;
        }
    }

    // Pass 3: Emit deduplicated structural, governance, temporal, and provenance edges.
    const edges = [];
    const seenEdges = new Set();
    const addEdge = (from, to, type, reason) => {
        if (!from || !to || from === to) return;
        if (!nodeById.has(from) || !nodeById.has(to)) return;
        const edgeKey = `${from}|${type}|${to}`;
        if (seenEdges.has(edgeKey)) return;
        seenEdges.add(edgeKey);
        edges.push({
            from,
            to,
            type,
            reason: String(reason || type),
        });
    };

    for (const node of nodes) {
        const meta = rawMetaById.get(node.id);

        if (node.kind === 'code') {
            const relImports = extractRelativeImports(node.content, node.path);
            for (const spec of relImports) {
                const dependencyNode = resolveImportedCodeNode(node.path, spec, codeByPath);
                if (dependencyNode) {
                    // File `node` imports `dependencyNode`, so mutating `dependencyNode` impacts caller `node`.
                    addEdge(
                        dependencyNode.id,
                        node.id,
                        'IMPACTS',
                        `${node.path} imports ${dependencyNode.path}`
                    );
                }
            }

            const envKeysRead = extractEnvReads(node.content);
            for (const envKey of envKeysRead) {
                const candidateEnvIds = new Set();
                if (nodeById.has(`env:${envKey}`)) {
                    candidateEnvIds.add(`env:${envKey}`);
                }
                for (const mappedId of envKeyToNodeIds.get(envKey) || []) {
                    candidateEnvIds.add(mappedId);
                }
                for (const envNodeId of candidateEnvIds) {
                    addEdge(node.id, envNodeId, 'READS_ENV', `reads process.env.${envKey}`);
                    addEdge(node.id, envNodeId, 'IMPACTS', `reads env key ${envKey}`);
                }
            }
        }

        if (meta?.explicitImpactsIds) {
            for (const targetId of meta.explicitImpactsIds) {
                addEdge(node.id, targetId, 'IMPACTS', 'explicit structural impact');
            }
        }

        if (meta?.supersedesId) {
            addEdge(
                node.id,
                meta.supersedesId,
                'SUPERSEDES',
                `${node.id} supersedes ${meta.supersedesId}`
            );
        }

        if (meta?.governsIds) {
            for (const targetId of meta.governsIds) {
                addEdge(node.id, targetId, 'GOVERNS', `${node.id} governs ${targetId}`);
            }
        }

        if (meta?.touchesIds) {
            for (const targetId of meta.touchesIds) {
                addEdge(node.id, targetId, 'TOUCHED', `${node.id} touched ${targetId}`);
                addEdge(node.id, targetId, 'IMPACTS', `${node.id} touched ${targetId}`);
            }
        }

        if (meta?.tunedInIds) {
            for (const envId of meta.tunedInIds) {
                addEdge(node.id, envId, 'TUNED_IN', `${node.id} tuned ${envId}`);
                addEdge(envId, node.id, 'IMPACTS', `${envId} tuned in ${node.id}`);
            }
        }
    }

    // Pass 4: Build pre-flight domain ontology (terms, knownConcepts, synonyms).
    const termSet = new Set();
    const conceptSet = new Set();
    const synonymMap = Object.create(null);

    const addIndexedToken = (rawVal) => {
        const clean = String(rawVal ?? '').trim();
        if (!clean) return;
        const lowered = clean.toLowerCase();
        if (/^[a-z0-9_:-]{2,}$/.test(lowered) && !FORBIDDEN_OBJECT_KEYS.has(lowered)) {
            termSet.add(lowered);
        }
        for (const tok of splitIdentifierTokens(clean)) {
            if (!FORBIDDEN_OBJECT_KEYS.has(tok)) {
                termSet.add(tok);
            }
        }
    };

    const addSynonymLink = (phrase, nodeId) => {
        const key = String(phrase ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (!key || FORBIDDEN_OBJECT_KEYS.has(key)) return;
        if (!Object.hasOwn(synonymMap, key)) {
            synonymMap[key] = [];
        }
        if (!synonymMap[key].includes(nodeId)) {
            synonymMap[key].push(nodeId);
        }
    };

    for (const node of nodes) {
        const idSuffix = node.id.includes(':') ? node.id.split(':').slice(1).join(':') : node.id;
        addIndexedToken(idSuffix);

        const codeMatch = /\b((?:ADR|INC|PR|INV)-[A-Z0-9-]+)\b/i.exec(node.id) || /\b((?:ADR|INC|PR|INV)-[A-Z0-9-]+)\b/i.exec(node.title);
        if (codeMatch) {
            const canonicalCode = codeMatch[1].toUpperCase();
            conceptSet.add(canonicalCode);
            addIndexedToken(canonicalCode);
            addSynonymLink(canonicalCode, node.id);
        }

        if (node.path) {
            const parsedPath = path.posix.parse(node.path);
            if (parsedPath.name) {
                const cleanStem = parsedPath.name.replace(/^\.+/, '');
                if (cleanStem) {
                    conceptSet.add(cleanStem);
                    addIndexedToken(cleanStem);
                    addSynonymLink(cleanStem, node.id);
                }
            }
            for (const seg of node.path.split('/')) {
                addIndexedToken(seg.replace(/\.[A-Za-z0-9]+$/, ''));
            }
        }

        addIndexedToken(node.title);

        for (const sym of node.symbols) {
            conceptSet.add(sym);
            addIndexedToken(sym);
            addSynonymLink(sym, node.id);
        }

        if (node.kind === 'code') {
            for (const extractedSym of extractCodeSymbols(node.content, node.path)) {
                conceptSet.add(extractedSym);
                addIndexedToken(extractedSym);
                addSynonymLink(extractedSym, node.id);
            }
            for (const envRead of extractEnvReads(node.content)) {
                conceptSet.add(envRead);
                addIndexedToken(envRead);
            }
        }

        for (const syn of node.synonyms) {
            conceptSet.add(syn);
            addIndexedToken(syn);
            addSynonymLink(syn, node.id);
        }
    }

    const totalRepoTokens = nodes.reduce((sum, n) => sum + n.tokens, 0);

    return {
        workspaceName: safeWorkspace,
        nodes,
        edges,
        ontology: {
            terms: [...termSet].sort(),
            knownConcepts: [...conceptSet].sort(),
            synonyms: synonymMap,
        },
        totalRepoTokens,
    };
}

/**
 * Redact potential secret assignments in `.env.example` files while preserving key names and numeric defaults.
 *
 * @param {string} rawText - Raw env template content
 * @returns {string}
 */
function sanitizeEnvTemplateContent(rawText) {
    return String(rawText || '')
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                return sanitizeMetadataText(line);
            }
            const m = /^((?:export\s+)?[A-Z][A-Z0-9_]{1,80}\s*=\s*)(.*)$/.exec(line);
            if (!m) return sanitizeMetadataText(line);
            const prefix = m[1];
            const val = m[2].trim().replace(/^['"]|['"]$/g, '');
            if (val === '' || /^\d+(?:\.\d+)?$/.test(val) || /^(?:true|false|development|production|test)$/i.test(val)) {
                return `${prefix}${val}`;
            }
            return `${prefix}<example>`;
        })
        .join('\n');
}

/**
 * Parse Markdown headings and structured governance headers (`Supersedes:`, `Governs:`, `Touches:`, `Tuned-In:`).
 *
 * @param {string} content - Markdown text
 * @param {string} relPath - Relative file path
 * @returns {object}
 */
function parseMarkdownArtifactMeta(content, relPath) {
    const text = String(content || '');
    const fileStem = path.posix.basename(relPath, path.posix.extname(relPath));

    const headingMatch = /^#\s+(.+)$/m.exec(text);
    const title = headingMatch ? headingMatch[1].trim() : fileStem;

    const adrMatch = /\b(ADR-\d+)\b/i.exec(relPath) || /\b(ADR-\d+)\b/i.exec(title);
    const invMatch = /\b(INV-[A-Z0-9-]+)\b/i.exec(relPath) || /\b(INV-[A-Z0-9-]+)\b/i.exec(title);
    const incMatch = /\b(INC-\d+)\b/i.exec(relPath) || /\b(INC-\d+)\b/i.exec(title);
    const prMatch = /\b(PR-\d+)\b/i.exec(relPath) || /\b(PR-\d+)\b/i.exec(title);

    let id = `doc:${relPath}`;
    let kind = 'doc';
    const symbols = [];

    if (adrMatch) {
        const code = adrMatch[1].toUpperCase();
        id = `adr:${code}`;
        kind = 'adr';
        symbols.push(code);
    } else if (invMatch) {
        const code = invMatch[1].toUpperCase();
        id = `inv:${code}`;
        kind = 'invariant';
        symbols.push(code);
    } else if (incMatch) {
        const code = incMatch[1].toUpperCase();
        id = `inc:${code}`;
        kind = 'incident';
        symbols.push(code);
    } else if (prMatch) {
        const code = prMatch[1].toUpperCase();
        id = `pr:${code}`;
        kind = 'pr';
        symbols.push(code);
    }

    const supersedesMatch = /^[*-]?\s*Supersedes\s*:\s*([^\r\n]+)/im.exec(text);
    let supersedesRef = null;
    if (supersedesMatch) {
        const supRaw = supersedesMatch[1].trim();
        const supAdr = /\b(ADR-\d+)\b/i.exec(supRaw);
        const supInv = /\b(INV-[A-Z0-9-]+)\b/i.exec(supRaw);
        if (supAdr) supersedesRef = `adr:${supAdr[1].toUpperCase()}`;
        else if (supInv) supersedesRef = `inv:${supInv[1].toUpperCase()}`;
        else if (supRaw.includes(':')) supersedesRef = supRaw.split(/[,\s]/)[0].trim();
    }

    const validFromMatch = /^[*-]?\s*(?:Valid-From|Effective|Date)\s*:\s*(\d{4}-\d{2}-\d{2})/im.exec(text);
    const retiredAtMatch = /^[*-]?\s*(?:Retired-At|Deprecated-At|Superseded-At)\s*:\s*(\d{4}-\d{2}-\d{2})/im.exec(text);
    const statusSuperseded = /^[*-]?\s*Status\s*:\s*(?:Superseded|Retired|Deprecated)\b/im.test(text);

    const parseTargetList = (headerName) => {
        const re = new RegExp(`^[*-]?\\s*${headerName}\\s*:\\s*([^\\r\\n]+)`, 'gim');
        const refs = [];
        let m;
        while ((m = re.exec(text)) !== null) {
            for (const part of m[1].split(',')) {
                const cleaned = part.trim().replace(/^`|`$/g, '');
                if (cleaned) refs.push(cleaned);
            }
        }
        return refs;
    };

    return {
        id,
        kind,
        title,
        symbols,
        validFrom: validFromMatch ? validFromMatch[1] : null,
        retiredAt: retiredAtMatch ? retiredAtMatch[1] : statusSuperseded ? '1970-01-01' : null,
        supersedesRef,
        rawGoverns: parseTargetList('Governs'),
        rawTouches: parseTargetList('Touches'),
        rawTunedIn: parseTargetList('Tuned-In'),
    };
}

/**
 * Safely scan a local filesystem directory and compile discovered source, `.env.example`,
 * and Markdown governance files into a HydraScope property graph.
 *
 * @param {string} targetDir - Directory path to scan
 * @param {object} [options={}] - Scan options
 * @param {number} [options.maxFiles=120] - Maximum files to ingest (`1..1000`)
 * @param {string} [options.workspaceName] - Optional logical workspace label
 * @returns {{ ok: boolean, tool: string, summary: string, data?: object, error?: object }}
 */
export function compileDirectoryToGraph(
    targetDir,
    { maxFiles = 120, workspaceName, rejectSymlinkRoot = false } = {}
) {
    if (!targetDir || typeof targetDir !== 'string' || !targetDir.trim()) {
        return errorEnvelope(
            'INVALID_TARGET_DIR',
            'A non-empty target directory path is required.',
            null,
            TOOL_NAME
        );
    }

    const candidateRoot = path.resolve(targetDir.trim());
    let lstat;
    try {
        lstat = fs.lstatSync(candidateRoot);
    } catch {
        return errorEnvelope(
            'DIRECTORY_NOT_FOUND',
            'Target directory does not exist or cannot be accessed.',
            { directory: path.basename(candidateRoot) || 'unknown' },
            TOOL_NAME
        );
    }

    if (rejectSymlinkRoot && lstat.isSymbolicLink()) {
        return errorEnvelope(
            'SYMLINK_ROOT_REJECTED',
            'Symbolic link directories cannot be compiled via restricted workspace endpoints.',
            { target: path.basename(candidateRoot) },
            TOOL_NAME
        );
    }

    let resolvedRoot;
    let rootStat;
    try {
        resolvedRoot = fs.realpathSync(candidateRoot);
        rootStat = fs.statSync(resolvedRoot);
    } catch {
        return errorEnvelope(
            'DIRECTORY_NOT_FOUND',
            'Target directory does not exist or cannot be accessed.',
            { directory: path.basename(candidateRoot) || 'unknown' },
            TOOL_NAME
        );
    }

    if (!rootStat.isDirectory()) {
        return errorEnvelope(
            'NOT_A_DIRECTORY',
            'Target path must be a directory.',
            { target: path.basename(resolvedRoot) },
            TOOL_NAME
        );
    }

    const boundedMaxFiles = Math.max(1, Math.min(Number(maxFiles) || 120, 1000));
    const effectiveWorkspace =
        sanitizeMetadataText(workspaceName || path.basename(resolvedRoot) || 'local-workspace').trim() ||
        'local-workspace';

    const discoveredFiles = [];

    const walkDirectory = (currentAbsDir) => {
        if (discoveredFiles.length >= boundedMaxFiles) return;
        let entries;
        try {
            entries = fs.readdirSync(currentAbsDir, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            if (discoveredFiles.length >= boundedMaxFiles) break;
            if (entry.isSymbolicLink()) continue;

            const name = entry.name;
            const fullPath = path.join(currentAbsDir, name);

            if (entry.isDirectory()) {
                if (SKIPPED_DIRS.has(name) || name.startsWith('.')) continue;
                walkDirectory(fullPath);
                continue;
            }

            if (!entry.isFile()) continue;

            const lowerName = name.toLowerCase();
            const ext = path.extname(lowerName);
            const isEnvTemplate =
                ENV_TEMPLATE_NAMES.has(lowerName) ||
                lowerName.endsWith('.env.example') ||
                lowerName.endsWith('.env.sample') ||
                lowerName.endsWith('.env.template');
            const isCode = CODE_EXTENSIONS.has(ext);
            const isMarkdown = MARKDOWN_EXTENSIONS.has(ext);

            if (!isEnvTemplate && !isCode && !isMarkdown) continue;

            let fileStat;
            try {
                fileStat = fs.statSync(fullPath);
            } catch {
                continue;
            }
            if (fileStat.size <= 0 || fileStat.size > MAX_FILE_BYTES) continue;

            let buf;
            try {
                buf = fs.readFileSync(fullPath);
            } catch {
                continue;
            }
            // Skip binary blobs containing NUL bytes.
            if (buf.includes(0)) continue;

            const relPath = path.relative(resolvedRoot, fullPath).split(path.sep).join('/');
            discoveredFiles.push({
                relPath,
                isEnvTemplate,
                isCode,
                isMarkdown,
                text: buf.toString('utf8'),
            });
        }
    };

    walkDirectory(resolvedRoot);

    const stagedArtifacts = [];
    const deferredMarkdownLinks = [];
    const knownCodeRelPaths = new Set();
    const envKeyPrimaryNode = new Map();

    for (const item of discoveredFiles) {
        if (item.isCode) {
            knownCodeRelPaths.add(item.relPath);
            const symbols = extractCodeSymbols(item.text, item.relPath);
            stagedArtifacts.push({
                id: `file:${item.relPath}`,
                kind: 'code',
                title: item.relPath,
                path: item.relPath,
                symbols,
                synonyms: [],
                validFrom: null,
                retiredAt: null,
                supersedesId: null,
                governsIds: [],
                touchesIds: [],
                tunedInIds: [],
                explicitImpactsIds: [],
                content: sanitizeMetadataText(item.text),
            });
        } else if (item.isEnvTemplate) {
            const sanitizedEnv = sanitizeEnvTemplateContent(item.text);
            const definedKeys = extractDefinedEnvKeys(sanitizedEnv);
            const primaryId = definedKeys.length > 0 ? `env:${definedKeys[0]}` : `env:${item.relPath}`;
            for (const key of definedKeys) {
                if (!envKeyPrimaryNode.has(key)) {
                    envKeyPrimaryNode.set(key, primaryId);
                }
            }
            stagedArtifacts.push({
                id: primaryId,
                kind: 'env',
                title: item.relPath,
                path: item.relPath,
                symbols: definedKeys,
                synonyms: [],
                validFrom: null,
                retiredAt: null,
                supersedesId: null,
                governsIds: [],
                touchesIds: [],
                tunedInIds: [],
                explicitImpactsIds: [],
                content: sanitizedEnv,
            });
        } else if (item.isMarkdown) {
            const mdMeta = parseMarkdownArtifactMeta(item.text, item.relPath);
            const artifact = {
                id: mdMeta.id,
                kind: mdMeta.kind,
                title: sanitizeMetadataText(mdMeta.title),
                path: item.relPath,
                symbols: mdMeta.symbols,
                synonyms: [],
                validFrom: mdMeta.validFrom,
                retiredAt: mdMeta.retiredAt,
                supersedesId: mdMeta.supersedesRef,
                governsIds: [],
                touchesIds: [],
                tunedInIds: [],
                explicitImpactsIds: [],
                content: sanitizeMetadataText(item.text),
            };
            stagedArtifacts.push(artifact);
            deferredMarkdownLinks.push({ artifact, mdMeta });
        }
    }

    const resolveDocReferenceToId = (rawRef) => {
        const ref = String(rawRef || '').trim();
        if (!ref) return null;
        if (ref.startsWith('file:') || ref.startsWith('env:') || ref.startsWith('adr:') || ref.startsWith('inv:') || ref.startsWith('inc:') || ref.startsWith('pr:')) {
            return ref;
        }
        const envKeyHit = /\b([A-Z][A-Z0-9_]{2,80})\b/.exec(ref);
        if (envKeyHit && envKeyPrimaryNode.has(envKeyHit[1])) {
            return envKeyPrimaryNode.get(envKeyHit[1]);
        }
        const pathCandidate = ref.split(/\s+/)[0].replace(/^\.\//, '');
        if (knownCodeRelPaths.has(pathCandidate)) {
            return `file:${pathCandidate}`;
        }
        return null;
    };

    for (const { artifact, mdMeta } of deferredMarkdownLinks) {
        artifact.governsIds = uniqueStrings(mdMeta.rawGoverns.map(resolveDocReferenceToId).filter(Boolean));
        artifact.touchesIds = uniqueStrings(mdMeta.rawTouches.map(resolveDocReferenceToId).filter(Boolean));
        artifact.tunedInIds = uniqueStrings(mdMeta.rawTunedIn.map(resolveDocReferenceToId).filter(Boolean));
    }

    const graph = compileArtifactsToGraph(stagedArtifacts, { workspaceName: effectiveWorkspace });
    return okEnvelope(
        TOOL_NAME,
        `Compiled ${graph.nodes.length} artifacts and ${graph.edges.length} structural edges (${graph.totalRepoTokens} tokens) from ${effectiveWorkspace}`,
        graph
    );
}
