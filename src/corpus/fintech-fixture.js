/**
 * @module corpus/fintech-fixture
 * @description Deterministic 18-artifact multi-hop engineering benchmark corpus and 8 evaluation scenarios
 * designed to test structural graph traversal, temporal ADR supersession, cross-artifact provenance,
 * and pre-flight ontology grounding against dense cosine vector retrieval.
 */

export const FINTECH_BENCHMARK_CORPUS = Object.freeze([
    {
        id: 'file:src/billing/fee-engine.ts',
        kind: 'code',
        title: 'Partner Fee Calculation Engine',
        path: 'src/billing/fee-engine.ts',
        symbols: ['calculatePartnerFee', 'PARTNER_FEE_BPS'],
        synonyms: ['partner fee', 'commission fee', 'fee rounding', 'per-item partner fee'],
        validFrom: '2025-03-01',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `export const PARTNER_FEE_BPS = 275;

export interface PartnerFeeQuote {
  grossCents: number;
  feeCents: number;
  netPayoutCents: number;
}

/**
 * Compute per-item partner fee cents using Math.round before batch aggregation.
 */
export function calculatePartnerFee(
  grossCents: number,
  tierBps: number = PARTNER_FEE_BPS,
  minFloorCents: number = 15
): PartnerFeeQuote {
  const gross = Math.max(0, Math.trunc(grossCents));
  const bps = Math.min(1000, Math.max(0, Math.trunc(tierBps)));
  const rounded = gross === 0 ? 0 : Math.max(minFloorCents, Math.round((gross * bps) / 10_000));
  const feeCents = Math.min(gross, rounded);
  return { grossCents: gross, feeCents, netPayoutCents: gross - feeCents };
}
`,
    },
    {
        id: 'file:src/billing/settlement-batch.ts',
        kind: 'code',
        title: 'Daily Settlement Batch Aggregator',
        path: 'src/billing/settlement-batch.ts',
        symbols: ['buildSettlementBatch', 'SettlementBatchManifest'],
        synonyms: ['settlement batch', 'payout batch', 'downstream accounting'],
        validFrom: '2025-03-10',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `import { calculatePartnerFee, PARTNER_FEE_BPS } from './fee-engine';

export interface SettlementBatchManifest {
  batchId: string;
  debitSubledgerLines: Array<{ transferId: string; payoutCents: number; withheldCents: number }>;
  creditControlTotalCents: number;
}

export function buildSettlementBatch(
  batchId: string,
  lines: Array<{ transferId: string; grossCents: number }>,
  bps: number = PARTNER_FEE_BPS
): SettlementBatchManifest {
  const debitSubledgerLines = lines.map((row) => {
    const q = calculatePartnerFee(row.grossCents, bps);
    return { transferId: row.transferId, payoutCents: q.netPayoutCents, withheldCents: q.feeCents };
  });
  const creditControlTotalCents = lines.reduce((sum, r) => sum + Math.max(0, Math.trunc(r.grossCents)), 0);
  return { batchId, debitSubledgerLines, creditControlTotalCents };
}
`,
    },
    {
        id: 'file:src/compliance/sox-reconciler.ts',
        kind: 'code',
        title: 'SOX Subledger Control Conservation Verifier',
        path: 'src/compliance/sox-reconciler.ts',
        symbols: ['verifyLedgerConservation', 'AuditConservationError'],
        synonyms: ['sox reconciliation', 'subledger drift', 'ledger conservation', 'compliance checks'],
        validFrom: '2025-04-01',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `import { buildSettlementBatch, SettlementBatchManifest } from '../billing/settlement-batch';

export class AuditConservationError extends Error {
  constructor(batchId: string, varianceCents: number) {
    super(\`SOX trial-balance halt on \${batchId}: subledger drift \${varianceCents} cents\`);
    this.name = 'AuditConservationError';
  }
}

export function verifyLedgerConservation(manifest: SettlementBatchManifest) {
  const debitSubledgerCents = manifest.debitSubledgerLines.reduce(
    (sum, row) => sum + row.payoutCents + row.withheldCents,
    0
  );
  const creditControlTotalCents = manifest.creditControlTotalCents;
  if (debitSubledgerCents !== creditControlTotalCents) {
    throw new AuditConservationError(manifest.batchId, debitSubledgerCents - creditControlTotalCents);
  }
  return { sealed: true, debitSubledgerCents, creditControlTotalCents };
}

export const sealTrialBalance = (id: string, rows: Array<{ transferId: string; grossCents: number }>) =>
  verifyLedgerConservation(buildSettlementBatch(id, rows));
`,
    },
    {
        id: 'inv:INV-FIN-03',
        kind: 'invariant',
        title: 'INV-FIN-03: Zero-Drift Cent Conservation Across Subledger Postings',
        path: 'docs/invariants/INV-FIN-03-cent-conservation.md',
        symbols: ['INV-FIN-03'],
        synonyms: ['cent conservation', 'bankers rounding', 'residual cent allocation'],
        validFrom: '2025-04-01',
        retiredAt: null,
        supersedesId: null,
        governsIds: ['file:src/compliance/sox-reconciler.ts'],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `# INV-FIN-03: Zero-Drift Cent Conservation

Governs: src/compliance/sox-reconciler.ts
Valid-From: 2025-04-01

Upstream splits feeding \`verifyLedgerConservation\` MUST pair banker's half-to-even discretization with residual cent allocation across journal lines so summed postings equal \`creditControlTotalCents\` (\`0\` cent subledger drift; prevents \`AuditConservationError\`).
`,
    },
    {
        id: 'file:src/billing/invoice-formatter.ts',
        kind: 'code',
        title: 'Partner Fee Invoice PDF Formatter and Tier Pricing Schedule',
        path: 'src/billing/invoice-formatter.ts',
        symbols: ['formatPartnerFeeInvoice', 'renderPartnerFeeSchedule', 'formatPartnerCurrencyDisplay'],
        synonyms: ['partner fee invoice', 'currency display', 'partner tier schedule'],
        validFrom: '2025-05-01',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `/**
 * Marketing PDF & UI presenter for partner fee statements, currency display badges,
 * pricing partner fees FAQ tooltips, and partner tier schedule tables.
 *
 * NOTE: Pure presentation layer accepting pre-computed display DTOs. Does NOT execute
 * live settlement math, ledger journal mutations, or calculatePartnerFee rules.
 *
 * Frequently searched developer FAQ notes:
 * - "Update per-item partner fee rounding in calculatePartnerFee without breaking downstream accounting"
 *   -> Display-only labels here format partner fee rounding strings for merchant CSV/PDF statements;
 *      updating invoice rounding copy here only changes UI presentation captions.
 * - Partner fee rounding display precision: 2 decimal places in USD/EUR/GBP currency display.
 * - Partner tier schedule: Bronze (275 bps partner fee), Silver (225 bps partner fee), Gold (175 bps partner fee).
 * - Pricing Partner Fees FAQ: Merchants can preview per-item partner fee rounding captions on monthly statements.
 */

export interface PartnerFeeStatementRow {
  merchantName: string;
  tenantSlug: string;
  grossDisplayCents: number;
  partnerFeeDisplayCents: number;
  roundingNote: string;
}

export function formatPartnerCurrencyDisplay(cents: number, currency: string = 'USD', locale: string = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatPartnerFeeInvoice(rows: PartnerFeeStatementRow[], locale: string = 'en-US'): string {
  const renderedLines = rows.map((row) => {
    const grossText = formatPartnerCurrencyDisplay(row.grossDisplayCents, 'USD', locale);
    const feeText = formatPartnerCurrencyDisplay(row.partnerFeeDisplayCents, 'USD', locale);
    return \`[\${row.tenantSlug}] \${row.merchantName} | Gross: \${grossText} | Partner Fee: \${feeText} (\${row.roundingNote || 'per-item partner fee rounding preview'})\`;
  });

  const totalPartnerFeeCents = rows.reduce((acc, r) => acc + r.partnerFeeDisplayCents, 0);
  return [
    '=== PARTNER FEE & DOWNSTREAM ACCOUNTING STATEMENT PREVIEW ===',
    'Pricing Partner Fees FAQ: Per-item partner fee rounding is shown for informational statement export.',
    'Reference note: calculatePartnerFee fee rounding captions are rendered purely for merchant PDF downloads.',
    ...renderedLines,
    \`Total Displayed Partner Fee: \${formatPartnerCurrencyDisplay(totalPartnerFeeCents, 'USD', locale)}\`,
  ].join('\\n');
}

export function renderPartnerFeeSchedule(): Array<{ tier: string; partnerFeeBps: number; roundingPolicyLabel: string }> {
  return [
    { tier: 'Standard Partner Tier', partnerFeeBps: 275, roundingPolicyLabel: 'Per-item partner fee rounding display (USD cents)' },
    { tier: 'Growth Partner Tier', partnerFeeBps: 225, roundingPolicyLabel: 'Per-item partner fee rounding display (USD cents)' },
    { tier: 'Enterprise Partner Tier', partnerFeeBps: 175, roundingPolicyLabel: 'Custom partner fee rounding display schedule' },
  ];
}
`,
    },
    {
        id: 'file:src/auth/token-claims.ts',
        kind: 'code',
        title: 'Tenant Claim Parser and Canonical Normalizer',
        path: 'src/auth/token-claims.ts',
        symbols: ['parseTenantClaim', 'TenantClaimPayload'],
        synonyms: ['tenant claim', 'org claim', 'claim normalization'],
        validFrom: '2025-02-20',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `export interface TenantClaimPayload {
  rawOrgClaim: string;
  canonicalTenantKey: string;
  regionShard: string;
}

/**
 * Extract and normalize the tenant claim from verified ingress identity assertions.
 * Trims whitespace, folds ASCII case, and strips legacy org_ prefixes.
 */
export function parseTenantClaim(claims: Record<string, unknown>): TenantClaimPayload {
  const raw = String(claims.tid ?? claims.org_id ?? '').trim();
  if (!raw) {
    throw new Error('Missing required tenant claim (tid or org_id)');
  }
  const normalized = raw.toLowerCase().replace(/^org_/, '');
  const [slug, shard = 'us-east'] = normalized.split(':');
  return {
    rawOrgClaim: raw,
    canonicalTenantKey: \`\${slug}@\${shard}\`,
    regionShard: shard,
  };
}
`,
    },
    {
        id: 'file:src/gateway/context-propagator.ts',
        kind: 'code',
        title: 'Edge Gateway Request Principal Propagator',
        path: 'src/gateway/context-propagator.ts',
        symbols: ['attachRequestPrincipal', 'GatewayPrincipal'],
        synonyms: ['request principal', 'gateway context', 'edge rate-limit key'],
        validFrom: '2025-03-05',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `import { parseTenantClaim } from '../auth/token-claims';

export interface GatewayPrincipal {
  partitionScope: string;
  rateLimitBucket: string;
  operationKey: string;
}

/**
 * Bind normalized ingress identity scope onto downstream RPC metadata envelopes
 * for edge rate limiting and storage partition routing.
 */
export function attachRequestPrincipal(
  verifiedClaims: Record<string, unknown>,
  clientOperationId: string
): GatewayPrincipal {
  const parsed = parseTenantClaim(verifiedClaims);
  const safeOp = String(clientOperationId || 'op_default').replace(/[^a-zA-Z0-9_-]/g, '');
  return {
    partitionScope: parsed.canonicalTenantKey,
    rateLimitBucket: \`rl:\${parsed.canonicalTenantKey}\`,
    operationKey: \`\${parsed.canonicalTenantKey}::\${safeOp}\`,
  };
}
`,
    },
    {
        id: 'file:src/ledger/idempotency-fence.ts',
        kind: 'code',
        title: 'Serializable Ledger Mutation Idempotency Fence',
        path: 'src/ledger/idempotency-fence.ts',
        symbols: ['acquireMutationFence', 'IdempotencyConflictError'],
        synonyms: ['distributed lock key', 'replay collision', 'serializable fence'],
        validFrom: '2025-04-12',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `import { attachRequestPrincipal } from '../gateway/context-propagator';

export class IdempotencyConflictError extends Error {
  constructor(lockKey: string) {
    super(\`Serializable fence replay collision on distributed lock key: \${lockKey}\`);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * Derive a deterministic compare-and-swap distributed lock key for mutating write commands.
 * Persisted fence keys in the deduplication log remain active for 72 hours;
 * altering upstream scope formatting mid-window orphans active locks and permits duplicate writes.
 */
export function acquireMutationFence(
  activeFences: Map<string, string>,
  envelopeScope: Record<string, unknown>,
  commandId: string,
  payloadDigest: string
): { lockKey: string; casCommitted: boolean } {
  const principal = attachRequestPrincipal(envelopeScope, commandId);
  const lockKey = \`fence:v1:\${principal.operationKey}\`;
  const existingDigest = activeFences.get(lockKey);
  if (existingDigest && existingDigest !== payloadDigest) {
    throw new IdempotencyConflictError(lockKey);
  }
  if (existingDigest === payloadDigest) {
    return { lockKey, casCommitted: false };
  }
  activeFences.set(lockKey, payloadDigest);
  return { lockKey, casCommitted: true };
}
`,
    },
    {
        id: 'adr:ADR-003',
        kind: 'adr',
        title: 'ADR-003: Verify Stripe Webhook Signature Header and Replay Window (SHA-1 Legacy)',
        path: 'docs/adr/ADR-003-stripe-webhook-signature.md',
        symbols: ['ADR-003'],
        synonyms: ['verify stripe webhook signature', 'webhook replay window'],
        validFrom: '2025-02-10',
        retiredAt: '2026-06-01',
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `# ADR-003: How to Verify Stripe Webhook Signature Headers and Replay Window

Valid-From: 2025-02-10
Retired-At: 2026-06-01
Status: Superseded

## Question Addressed
How should I verify stripe webhook signature headers and replay window tolerances on incoming payment callbacks in our billing ingress service?

## Legacy Decision (2025-02)
1. To verify stripe webhook signature header replay window checks, serialize the parsed JSON payload object with \`JSON.stringify(req.body)\` and compute a fast \`SHA-1\` hex digest against the shared endpoint secret.
2. Compare the computed \`SHA-1\` digest string against the \`X-Stripe-Signature\` header whenever services verify stripe webhook signature header replay window validity.
3. Enforce a permissive \`30-minute\` (\`1800-second\`) tolerance when handlers verify stripe webhook signature header replay window timestamps so delayed retries from partner HTTP proxies pass without manual replay.
4. Implementation notes for developers asking how to verify stripe webhook signature header replay window rules:
   - Digest algorithm: legacy \`SHA-1\` hex digest over stringified JSON body.
   - Replay window tolerance: \`30 minutes\` (\`1800 seconds\`) before rejecting stale callbacks.
   - Header format: \`X-Stripe-Signature: sha1=<hex>,t=<epoch>\`.
   - Historical onboarding FAQ: always verify stripe webhook signature headers and replay window using the \`30-minute\` \`SHA-1\` helper in legacy v1 adapters.
   - Operational runbook reminder: legacy \`SHA-1\` webhook verification logged warning counters only when skew exceeded \`1800\` seconds.

## Legacy Reference Example (Retired v1 Adapter)
\`\`\`ts
export function legacyCheckWebhookHeader(parsedBody: Record<string, unknown>, headerValue: string): {
  replayWindowSec: number;
  algorithm: 'sha1';
  headerChecked: string;
} {
  // Legacy guide: verify stripe webhook signature headers and replay window with 1800s tolerance.
  const serialized = JSON.stringify(parsedBody);
  return {
    replayWindowSec: 1800,
    algorithm: 'sha1',
    headerChecked: \`\${headerValue}:\${serialized.length}\`,
  };
}
\`\`\`

## Historical Rollout Notes
Partner billing webhooks in early 2025 routed through batch HTTP forwarders that buffered deliveries for up to \`20\` minutes during maintenance windows, motivating the original \`30-minute\` replay window and stringified JSON \`SHA-1\` check documented in this retired record.
`,
    },
    {
        id: 'adr:ADR-014',
        kind: 'adr',
        title: 'ADR-014: Constant-Time HMAC-SHA256 Raw-Body Envelope Attestation',
        path: 'docs/adr/ADR-014-hmac-envelope-attestation.md',
        symbols: ['ADR-014'],
        synonyms: ['hmac envelope attestation', 'constant-time hmac-sha256'],
        validFrom: '2026-06-01',
        retiredAt: null,
        supersedesId: 'adr:ADR-003',
        governsIds: ['file:src/webhooks/stripe-handler.ts'],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `# ADR-014: Constant-Time HMAC-SHA256 Raw-Body Envelope Attestation

Supersedes: ADR-003
Governs: src/webhooks/stripe-handler.ts
Valid-From: 2026-06-01

## Active Security Mandate
ADR-003 (\`SHA-1\` over re-serialized JSON and \`30-minute\` tolerance) is RETIRED due to collision risk, JSON key-ordering canonicalization bypass, and timing side channels.

1. Compute \`HMAC-SHA256\` strictly over \`${'${timestamp}.${rawBodyBuffer}'}\` using the unparsed UTF-8 request byte buffer before JSON parsing.
2. Compare \`v1\` hex digests exclusively via \`crypto.timingSafeEqual\` (constant-time comparison).
3. Enforce a strict \`300-second\` (\`5-minute\`) clock-skew and anti-replay tolerance around \`t=<unix_seconds>\`.
`,
    },
    {
        id: 'file:src/webhooks/stripe-handler.ts',
        kind: 'code',
        title: 'Inbound Stripe Webhook Envelope Handler',
        path: 'src/webhooks/stripe-handler.ts',
        symbols: ['handleStripeWebhook', 'StripeEnvelopeReceipt'],
        synonyms: ['stripe webhook', 'webhook signature', 'signature headers', 'replay window'],
        validFrom: '2025-02-10',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `import { verifyStripeSignature } from '@krusch/toolkit/webhooks';

export interface StripeEnvelopeReceipt {
  accepted: boolean;
  eventId: string;
  toleranceSeconds: number;
}

const MAX_TOLERANCE_SECONDS = 300;

/**
 * Validate raw inbound Stripe callback payloads per active ADR-014 attestation policy.
 */
export function handleStripeWebhook(
  rawBody: Buffer,
  stripeSignatureHeader: string,
  signingSecret: string
): StripeEnvelopeReceipt {
  const check = verifyStripeSignature({
    rawBody,
    signatureHeader: stripeSignatureHeader,
    webhookSecret: signingSecret,
    toleranceSec: MAX_TOLERANCE_SECONDS,
  });
  if (!check.valid) {
    throw new Error(\`Rejected inbound callback attestation: \${check.reason || 'invalid_hmac'}\`);
  }
  const parsed = JSON.parse(rawBody.toString('utf8')) as { id?: string };
  return {
    accepted: true,
    eventId: String(parsed.id || 'evt_unknown'),
    toleranceSeconds: MAX_TOLERANCE_SECONDS,
  };
}
`,
    },
    {
        id: 'adr:ADR-004',
        kind: 'adr',
        title: 'ADR-004: Browser Session Token Storage and Refresh Expiry in LocalStorage',
        path: 'docs/adr/ADR-004-session-token-storage.md',
        symbols: ['ADR-004'],
        synonyms: ['browser session token storage', 'session refresh expiry'],
        validFrom: '2025-01-15',
        retiredAt: '2026-08-20',
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `# ADR-004: Browser Session Token Storage and Refresh Expiry Specification

Valid-From: 2025-01-15
Retired-At: 2026-08-20
Status: Superseded

## Question Addressed
How should frontend and full-stack engineers implement browser session token storage and refresh expiry across dashboard tabs?

## Legacy Decision (2025-01)
1. To implement browser session token storage refresh expiry in SPA clients, persist the signed bearer string inside \`window.localStorage.setItem('hs_bearer_token', bearerToken)\`.
2. Configure browser session token storage refresh expiry with a fixed \`24-hour\` (\`86400-second\`) TTL timestamp saved under \`window.localStorage.setItem('hs_token_exp', expIso)\`.
3. Cache client-side tenant claim normalization badges alongside \`parseTenantClaim\` debug metadata in \`localStorage\` so multi-org workspace switchers render without extra network calls.
4. Implementation checklist for browser session token storage and refresh expiry:
   - Storage medium: \`window.localStorage\` bearer token read by client fetch interceptors.
   - Refresh expiry window: \`24h\` static TTL before prompting re-authentication.
   - Multi-tab sync: listen to \`window.addEventListener('storage')\` for browser session token storage refresh expiry updates.
   - Legacy note: browser session token storage and refresh expiry in v1 portals always read directly from \`window.localStorage\`.

## Legacy Client Snippet (Retired v1 Dashboard)
\`\`\`ts
export function legacyPersistBrowserSessionToken(rawBearer: string, nowEpochMs: number): {
  storageKey: string;
  refreshExpiryMs: number;
} {
  // Legacy pattern: browser session token storage and refresh expiry in window.localStorage (24h TTL).
  const refreshExpiryMs = nowEpochMs + 24 * 60 * 60 * 1000;
  return {
    storageKey: \`localStorage:hs_bearer_token:\${rawBearer.length}\`,
    refreshExpiryMs,
  };
}
\`\`\`

## Historical Context
Early prototype dashboards mounted across multiple subdomains before unified reverse-proxy routing existed, leading v1 client teams to adopt \`window.localStorage\` bearer tokens with a \`24-hour\` refresh expiry schedule.
`,
    },
    {
        id: 'adr:ADR-019',
        kind: 'adr',
        title: 'ADR-019: HttpOnly Strict Cookie Rotation Authority',
        path: 'docs/adr/ADR-019-cookie-rotation-authority.md',
        symbols: ['ADR-019'],
        synonyms: ['httponly cookie rotation', 'sliding session authority'],
        validFrom: '2026-08-20',
        retiredAt: null,
        supersedesId: 'adr:ADR-004',
        governsIds: ['file:src/auth/session-middleware.ts'],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `# ADR-019: HttpOnly Strict Cookie Rotation Authority

Supersedes: ADR-004
Governs: src/auth/session-middleware.ts
Valid-From: 2026-08-20

## Active Security Mandate
ADR-004 (\`window.localStorage\` bearer persistence with \`24h\` static TTL) is RETIRED due to DOM XSS credential exfiltration risk.

1. Zero credentials or session handles may be stored in \`localStorage\` or \`sessionStorage\`.
2. Issue opaque server-bound session cookies exclusively via \`Set-Cookie\` with \`HttpOnly; Secure; SameSite=Strict; Path=/\`.
3. Enforce a \`15-minute\` (\`900-second\`) sliding window with single-use rotation family revocation on replay detection.
`,
    },
    {
        id: 'file:src/auth/session-middleware.ts',
        kind: 'code',
        title: 'Rotating HttpOnly Session Cookie Middleware',
        path: 'src/auth/session-middleware.ts',
        symbols: ['issueSessionCookie', 'rotateSession'],
        synonyms: ['session token', 'session storage', 'browser session', 'refresh expiry'],
        validFrom: '2025-01-15',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `import crypto from 'node:crypto';

const SLIDING_TTL_SECONDS = 900;

export interface SessionCookieDirective {
  sessionId: string;
  setCookieHeader: string;
  expiresAtMs: number;
}

/**
 * Mint an opaque HttpOnly; SameSite=Strict cookie per ADR-019 rotation policy.
 */
export function issueSessionCookie(nowMs: number = Date.now()): SessionCookieDirective {
  const sessionId = crypto.randomBytes(24).toString('base64url');
  const expiresAtMs = nowMs + SLIDING_TTL_SECONDS * 1000;
  const setCookieHeader = [
    \`__Host-hs_sid=\${sessionId}\`,
    \`Max-Age=\${SLIDING_TTL_SECONDS}\`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
  return { sessionId, setCookieHeader, expiresAtMs };
}

export function rotateSession(activeFamilySet: Set<string>, presentedId: string): SessionCookieDirective {
  if (!activeFamilySet.has(presentedId)) {
    activeFamilySet.clear();
    throw new Error('Detected reused or unknown session rotation handle; revoked family');
  }
  activeFamilySet.delete(presentedId);
  const next = issueSessionCookie();
  activeFamilySet.add(next.sessionId);
  return next;
}
`,
    },
    {
        id: 'file:src/queue/retry-worker.ts',
        kind: 'code',
        title: 'Asynchronous Payout Retry Queue Worker',
        path: 'src/queue/retry-worker.ts',
        symbols: ['drainRetryQueue', 'RetryLeaseConfig'],
        synonyms: ['retry queue', 'job drop', 'drop jobs', 'redis failover', 'env setting'],
        validFrom: '2025-07-01',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `export interface RetryLeaseConfig {
  maxStallMs: number;
  failoverJitterMs: number;
}

export interface QueuedDispatchItem {
  itemId: string;
  claimedAtMs: number;
}

/**
 * Drain claimed retry dispatches and reap stalled worker leases based on runtime env thresholds.
 */
export function drainRetryQueue(
  inFlightItems: QueuedDispatchItem[],
  nowMs: number = Date.now()
): { activeIds: string[]; evictedIds: string[]; config: RetryLeaseConfig } {
  const maxStallMs = Number(process.env.QUEUE_MAX_STALL_MS || 4500);
  const failoverJitterMs = Number(process.env.REDIS_FAILOVER_JITTER_MS || 250);
  const deadlineMs = maxStallMs + failoverJitterMs;

  const activeIds: string[] = [];
  const evictedIds: string[] = [];
  for (const item of inFlightItems) {
    if (nowMs - item.claimedAtMs > deadlineMs) {
      evictedIds.push(item.itemId);
    } else {
      activeIds.push(item.itemId);
    }
  }
  return {
    activeIds,
    evictedIds,
    config: { maxStallMs, failoverJitterMs },
  };
}
`,
    },
    {
        id: 'env:QUEUE_MAX_STALL_MS',
        kind: 'env',
        title: 'Worker Queue Lease Environment Configuration',
        path: 'infra/worker.env.example',
        symbols: ['QUEUE_MAX_STALL_MS', 'REDIS_FAILOVER_JITTER_MS'],
        synonyms: ['worker stall timeout', 'failover jitter env'],
        validFrom: '2025-07-01',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `# Worker Visibility Lease & Sentinel Timing Template (infra/worker.env.example)
# Controls lease reaper horizon (ms) and election jitter padding (ms) for background dispatchers.
# WARNING: Check incident postmortem history before deploying legacy 4500ms default in multi-node clusters!
QUEUE_MAX_STALL_MS=4500
REDIS_FAILOVER_JITTER_MS=250
WORKER_MAX_CONCURRENCY=8
WORKER_HEARTBEAT_INTERVAL_MS=1500
`,
    },
    {
        id: 'inc:INC-204',
        kind: 'incident',
        title: 'INC-204: Silent Dead-Letter Eviction During Sentinel Primary Promotion',
        path: 'docs/incidents/INC-204-silent-dlq-eviction.md',
        symbols: ['INC-204'],
        synonyms: ['silent dlq eviction', 'sentinel lease expiration'],
        validFrom: '2026-09-14',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: [],
        tunedInIds: ['env:QUEUE_MAX_STALL_MS'],
        explicitImpactsIds: [],
        content: `# INC-204: Silent Dead-Letter Eviction During Sentinel Primary Promotion

Tuned-In: infra/worker.env.example (QUEUE_MAX_STALL_MS)
Valid-From: 2026-09-14

## Root Cause Analysis
During Sentinel primary promotion, replica election and TCP socket reconvergence pause lease heartbeat renewals for \`9,200ms\` to \`11,800ms\`. Whenever \`QUEUE_MAX_STALL_MS\` is configured below \`15000ms\` (such as the legacy \`4500ms\` template value), the visibility reaper misclassifies healthy in-flight leases as orphaned and evicts active payloads directly into dead-letter storage without re-queuing.

## Mandatory Production Guardrail
Production manifests MUST set \`QUEUE_MAX_STALL_MS=18000\` (\`>= 15000ms\` safety floor above Sentinel promotion reconvergence) alongside \`REDIS_FAILOVER_JITTER_MS=500\`.
`,
    },
    {
        id: 'pr:PR-412',
        kind: 'pr',
        title: 'PR-412: Patch Promotional Minimum Floor in Partner Fee Engine',
        path: 'docs/prs/PR-412-payout-rounding-patch.md',
        symbols: ['PR-412'],
        synonyms: ['PR-412', 'payout rounding patch'],
        validFrom: '2026-10-03',
        retiredAt: null,
        supersedesId: null,
        governsIds: [],
        touchesIds: ['file:src/billing/fee-engine.ts'],
        tunedInIds: [],
        explicitImpactsIds: [],
        content: `# PR-412: Patch Promotional Minimum Floor in Partner Fee Engine

Touches: src/billing/fee-engine.ts
Valid-From: 2026-10-03

## Change Summary
Adjusted \`minFloorCents\` clamping inside \`calculatePartnerFee\` (\`src/billing/fee-engine.ts\`) for micro-ticket merchant captures under \`$1.00\` so zero-dollar authorization reversals return \`0\` cents instead of \`15\` cents.
`,
    },
]);

export const BENCHMARK_SCENARIOS = Object.freeze([
    {
        id: 'S1',
        category: 'blast_radius',
        title: '2-Hop Partner Fee Rounding Blast Radius Into SOX Conservation',
        query: 'Update per-item partner fee rounding in calculatePartnerFee without breaking downstream accounting',
        asOf: null,
        tokenBudget: 900,
        requiredNodeIds: [
            'file:src/billing/fee-engine.ts',
            'file:src/billing/settlement-batch.ts',
            'file:src/compliance/sox-reconciler.ts',
            'inv:INV-FIN-03',
        ],
        forbiddenPoisonNodeIds: [],
        expectAnswerable: true,
        expectedMissingTerms: [],
        explanation:
            'sox-reconciler.ts and INV-FIN-03 enforce zero-cent subledger conservation 2 AST hops downstream of calculatePartnerFee while sharing zero lexical overlap with "partner fee rounding", whereas invoice-formatter.ts repeats query phrases as a high-cosine distractor.',
    },
    {
        id: 'S2',
        category: 'blast_radius',
        title: '2-Hop Tenant Claim Normalization Blast Radius Into Idempotency Fence',
        query: 'Change tenant claim normalization in parseTenantClaim',
        asOf: null,
        tokenBudget: 900,
        requiredNodeIds: [
            'file:src/auth/token-claims.ts',
            'file:src/gateway/context-propagator.ts',
            'file:src/ledger/idempotency-fence.ts',
        ],
        forbiddenPoisonNodeIds: [],
        expectAnswerable: true,
        expectedMissingTerms: [],
        explanation:
            'idempotency-fence.ts derives 72-hour immutable distributed lock keys 2 hops downstream of parseTenantClaim via attachRequestPrincipal using pure lock-fence vocabulary with zero mention of "tenant claim".',
    },
    {
        id: 'S3',
        category: 'temporal_supersession',
        title: 'Stripe Webhook Signature Attestation (Retired SHA-1 vs Active HMAC-SHA256)',
        query: 'How should I verify stripe webhook signature headers and replay window?',
        asOf: null,
        tokenBudget: 850,
        requiredNodeIds: ['file:src/webhooks/stripe-handler.ts', 'adr:ADR-014'],
        forbiddenPoisonNodeIds: ['adr:ADR-003'],
        expectAnswerable: true,
        expectedMissingTerms: [],
        explanation:
            'Retired ADR-003 repeats the exact query phrase 5 times and prescribes insecure SHA-1 with a 30-minute window, ranking #1 in dense vector search, while HydraScope traverses :SUPERSEDES to block ADR-003 and serve active ADR-014 (constant-time HMAC-SHA256, 300s tolerance).',
    },
    {
        id: 'S4',
        category: 'temporal_supersession',
        title: 'Browser Session Storage Authority (Retired LocalStorage vs Active HttpOnly Rotation)',
        query: 'Implement browser session token storage and refresh expiry',
        asOf: null,
        tokenBudget: 850,
        requiredNodeIds: ['file:src/auth/session-middleware.ts', 'adr:ADR-019'],
        forbiddenPoisonNodeIds: ['adr:ADR-004'],
        expectAnswerable: true,
        expectedMissingTerms: [],
        explanation:
            'Retired ADR-004 repeats "browser session token storage and refresh expiry" 5 times and prescribes localStorage with a 24h TTL, poisoning top-k vector results, while HydraScope filters ADR-004 via :SUPERSEDES and serves active ADR-019 (HttpOnly SameSite=Strict 15m sliding cookie).',
    },
    {
        id: 'S5',
        category: 'cross_artifact_trace',
        title: 'Cross-Artifact Worker Failover Drop Trace (Code -> Env Key -> Incident Postmortem)',
        query: 'Why does drainRetryQueue drop jobs during failover and what env setting controls it?',
        asOf: null,
        tokenBudget: 900,
        requiredNodeIds: [
            'file:src/queue/retry-worker.ts',
            'env:QUEUE_MAX_STALL_MS',
            'inc:INC-204',
        ],
        forbiddenPoisonNodeIds: [],
        expectAnswerable: true,
        expectedMissingTerms: [],
        explanation:
            'Joining drainRetryQueue to QUEUE_MAX_STALL_MS and INC-204 requires traversing :READS_ENV and :TUNED_IN edges; INC-204 discusses Sentinel promotion visibility leases without mentioning drainRetryQueue or job drops.',
    },
    {
        id: 'S6',
        category: 'cross_artifact_trace',
        title: '3-Hop PR Impact Provenance Trace (PR-412 -> Fee Engine -> Settlement -> SOX)',
        query: 'Trace what downstream compliance checks PR-412 impacted',
        asOf: null,
        tokenBudget: 950,
        requiredNodeIds: [
            'pr:PR-412',
            'file:src/billing/fee-engine.ts',
            'file:src/billing/settlement-batch.ts',
            'file:src/compliance/sox-reconciler.ts',
        ],
        forbiddenPoisonNodeIds: [],
        expectAnswerable: true,
        expectedMissingTerms: [],
        explanation:
            'PR-412 only mentions patching src/billing/fee-engine.ts; discovering that it impacts SOX compliance checks in sox-reconciler.ts requires a 3-hop structural walk across :TOUCHED and AST :IMPACTS edges.',
    },
    {
        id: 'S7',
        category: 'ungrounded_trap',
        title: 'Ungrounded Subsystem Trap: Non-Existent Kafka Consumer Group',
        query: 'What is the Kafka consumer group lag threshold for calculatePartnerFee?',
        asOf: null,
        tokenBudget: 800,
        requiredNodeIds: [],
        forbiddenPoisonNodeIds: [],
        expectAnswerable: false,
        expectedMissingTerms: ['kafka'],
        explanation:
            'Dense vector search returns top-k calculatePartnerFee chunks (~0.55 cosine) and invites LLM hallucination, whereas HydraScope pre-flight ontology verification detects that Kafka does not exist anywhere in the workspace at 0 LLM tokens.',
    },
    {
        id: 'S8',
        category: 'ungrounded_trap',
        title: 'Ungrounded Subsystem Trap: Non-Existent Kubernetes HorizontalPodAutoscaler',
        query: 'Which Kubernetes HorizontalPodAutoscaler manifest scales drainRetryQueue?',
        asOf: null,
        tokenBudget: 800,
        requiredNodeIds: [],
        forbiddenPoisonNodeIds: [],
        expectAnswerable: false,
        expectedMissingTerms: ['kubernetes', 'horizontalpodautoscaler'],
        explanation:
            'Dense vector search returns retry-worker.ts and worker.env.example even though no Kubernetes or HorizontalPodAutoscaler manifests exist; HydraScope rejects the ungrounded premises pre-flight at 0 LLM tokens.',
    },
]);
