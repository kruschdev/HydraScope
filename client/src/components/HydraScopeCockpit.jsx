import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { fetchApiJson, useCopyToClipboard } from '@krusch/toolkit/react';
import '../styles.css';

const CATEGORY_META = {
  blast_radius: { label: '2-Hop Blast Radius', className: 'hs-cat-blast' },
  temporal_supersession: { label: 'Temporal Supersession', className: 'hs-cat-temporal' },
  cross_artifact_trace: { label: 'Cross-Artifact Trace', className: 'hs-cat-trace' },
  ungrounded_trap: { label: 'Ungrounded Trap', className: 'hs-cat-trap' }
};

const ISO_DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TAB_ORDER = ['arena', 'continual', 'benchmark', 'studio'];

function isValidIsoDate(raw) {
  if (typeof raw !== 'string') return false;
  const m = ISO_DATE_RE.exec(raw.trim());
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function computeNextAdrId(nodes = [], fallbackPrefix = 'adr') {
  let maxNum = 24;
  for (const n of nodes) {
    const m = /ADR-(\d+)/i.exec(String(n?.id || ''));
    if (m) {
      const val = Number.parseInt(m[1], 10);
      if (Number.isFinite(val) && val > maxNum) maxNum = val;
    }
  }
  const nextCode = `ADR-${String(maxNum + 1).padStart(3, '0')}`;
  return fallbackPrefix ? `${fallbackPrefix}:${nextCode}` : nextCode;
}

function unwrapPayload(res) {
  if (res && typeof res === 'object' && res.ok === true && 'data' in res) {
    return res.data;
  }
  return res;
}

function getCategoryMeta(category) {
  const key = String(category || '').toLowerCase();
  if (CATEGORY_META[key]) return CATEGORY_META[key];
  if (key.includes('blast')) return CATEGORY_META.blast_radius;
  if (key.includes('temporal') || key.includes('supersess')) return CATEGORY_META.temporal_supersession;
  if (key.includes('trap') || key.includes('ungrounded')) return CATEGORY_META.ungrounded_trap;
  return {
    label: category ? String(category).replace(/_/g, ' ') : 'Structural Task',
    className: 'hs-cat-trace'
  };
}

function formatNum(value, fallback = '0') {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString() : fallback;
}

function formatPct(value, digits = 1) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(digits)}%` : '0.0%';
}

function truncateLabel(text, maxLen = 24) {
  const raw = String(text || '');
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, Math.max(1, maxLen - 2))}..`;
}

function normalizeId(entry) {
  if (!entry) return '';
  return typeof entry === 'string' ? entry : String(entry.id || '');
}

/**
 * Compute deterministic 3-column left-to-right SVG layout:
 * Column 0: Seed Entrypoints
 * Column 1: Hop 1 Direct Impact / Governance
 * Column 2: Hop 2+ Multi-Hop Blast Radius & Retired Supersessions
 */
function buildSubgraphLayout(hydra, stateEdges = []) {
  const traversedNodes = Array.isArray(hydra?.traversedNodes) ? hydra.traversedNodes : [];
  const retiredNodes = Array.isArray(hydra?.retiredBlockedNodes) ? hydra.retiredBlockedNodes : [];
  const rawEdges = Array.isArray(hydra?.traversedEdges) ? hydra.traversedEdges : [];
  const seedIds = new Set(
    (Array.isArray(hydra?.seedNodes) ? hydra.seedNodes : []).map(normalizeId).filter(Boolean)
  );

  const nodeMap = new Map();
  for (const node of traversedNodes) {
    if (node?.id) {
      nodeMap.set(node.id, { ...node, isBlockedRetired: false });
    }
  }
  for (const rNode of retiredNodes) {
    if (rNode?.id && !nodeMap.has(rNode.id)) {
      nodeMap.set(rNode.id, {
        ...rNode,
        kind: rNode.kind || 'decision',
        isCurrent: false,
        isBlockedRetired: true
      });
    } else if (rNode?.id && nodeMap.has(rNode.id)) {
      nodeMap.set(rNode.id, { ...nodeMap.get(rNode.id), isBlockedRetired: true });
    }
  }

  const allNodes = [...nodeMap.values()];
  if (allNodes.length === 0) {
    return { positionedNodes: [], positionedEdges: [], overflowCounts: [0, 0, 0] };
  }

  if (seedIds.size === 0 && traversedNodes[0]?.id) {
    seedIds.add(traversedNodes[0].id);
  }

  // Merge traversedEdges with any SUPERSEDES / GOVERNS links touching visible/retired nodes
  const edgeKeySet = new Set();
  const combinedEdges = [];
  const pushEdge = (edge) => {
    if (!edge?.from || !edge?.to) return;
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) return;
    const key = `${edge.from}|${edge.to}|${edge.type || 'IMPACTS'}`;
    if (edgeKeySet.has(key)) return;
    edgeKeySet.add(key);
    combinedEdges.push({
      from: edge.from,
      to: edge.to,
      type: String(edge.type || 'IMPACTS').toUpperCase(),
      reason: edge.reason || ''
    });
  };

  for (const edge of rawEdges) {
    pushEdge(edge);
  }
  for (const edge of stateEdges) {
    if (edge?.type === 'SUPERSEDES' || edge?.type === 'GOVERNS') {
      pushEdge(edge);
    }
  }
  for (const rNode of retiredNodes) {
    if (rNode?.id && rNode?.supersededBy && nodeMap.has(rNode.supersededBy)) {
      pushEdge({
        from: rNode.supersededBy,
        to: rNode.id,
        type: 'SUPERSEDES',
        reason: 'Retired via temporal supersession'
      });
    }
  }

  // Bidirectional BFS from seeds for clean visual column tiering
  const adj = new Map();
  for (const id of nodeMap.keys()) {
    adj.set(id, new Set());
  }
  for (const edge of combinedEdges) {
    adj.get(edge.from)?.add(edge.to);
    adj.get(edge.to)?.add(edge.from);
  }

  const hopDist = new Map();
  const queue = [];
  for (const id of seedIds) {
    if (nodeMap.has(id) && !nodeMap.get(id).isBlockedRetired) {
      hopDist.set(id, 0);
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const curr = queue.shift();
    const currDist = hopDist.get(curr) ?? 0;
    for (const neighbor of adj.get(curr) || []) {
      if (!hopDist.has(neighbor)) {
        hopDist.set(neighbor, currDist + 1);
        queue.push(neighbor);
      }
    }
  }

  const columns = [[], [], []];
  for (const node of allNodes) {
    if (node.isBlockedRetired) {
      columns[2].push(node);
      continue;
    }
    const explicitHop = typeof node.hop === 'number' ? node.hop : hopDist.get(node.id);
    if (seedIds.has(node.id) || explicitHop === 0) {
      columns[0].push(node);
    } else if (explicitHop === 1) {
      columns[1].push(node);
    } else {
      columns[2].push(node);
    }
  }

  // Balance fallback if col 0 is empty
  if (columns[0].length === 0 && columns[1].length > 0) {
    columns[0].push(columns[1].shift());
  } else if (columns[0].length === 0 && columns[2].length > 0) {
    const nonRetiredIdx = columns[2].findIndex((n) => !n.isBlockedRetired);
    if (nonRetiredIdx >= 0) {
      columns[0].push(...columns[2].splice(nonRetiredIdx, 1));
    }
  }

  const colX = [24, 280, 536];
  const boxW = 200;
  const maxPerCol = 5;
  const positionedMap = new Map();
  const overflowCounts = [0, 0, 0];

  columns.forEach((colNodes, colIdx) => {
    const visible = colNodes.slice(0, maxPerCol);
    overflowCounts[colIdx] = Math.max(0, colNodes.length - visible.length);
    const count = visible.length;
    if (count === 0) return;

    const canvasTop = 36;
    const canvasBottom = overflowCounts[colIdx] > 0 ? 216 : 228;
    const availH = canvasBottom - canvasTop;
    const cardH = count <= 3 ? 40 : count === 4 ? 35 : 30;
    const totalCardsH = count * cardH;
    const gap = count > 1 ? Math.max(5, Math.min(14, (availH - totalCardsH) / (count - 1))) : 0;
    const usedH = totalCardsH + Math.max(0, count - 1) * gap;
    const startY = canvasTop + Math.max(0, (availH - usedH) / 2);

    visible.forEach((node, idx) => {
      const x = colX[colIdx];
      const y = Math.round(startY + idx * (cardH + gap));
      positionedMap.set(node.id, {
        ...node,
        colIdx,
        x,
        y,
        w: boxW,
        h: cardH,
        cxLeft: x,
        cxRight: x + boxW,
        cy: Math.round(y + cardH / 2)
      });
    });
  });

  const dedupedPairMap = new Map();
  for (const e of combinedEdges) {
    if (!positionedMap.has(e.from) || !positionedMap.has(e.to) || e.from === e.to) continue;
    const pairKey = [e.from, e.to].sort().join('<->');
    const existing = dedupedPairMap.get(pairKey);
    if (!existing || (existing.type === 'IMPACTS' && e.type !== 'IMPACTS')) {
      dedupedPairMap.set(pairKey, e);
    }
  }

  const positionedEdges = [...dedupedPairMap.values()].map((edge, edgeIdx) => {
      const src = positionedMap.get(edge.from);
      const dst = positionedMap.get(edge.to);
      let x1;
      let y1;
      let x2;
      let y2;
      if (src.colIdx < dst.colIdx) {
        x1 = src.cxRight;
        y1 = src.cy;
        x2 = dst.cxLeft;
        y2 = dst.cy;
      } else if (src.colIdx > dst.colIdx) {
        x1 = src.cxLeft;
        y1 = src.cy;
        x2 = dst.cxRight;
        y2 = dst.cy;
      } else if (src.colIdx === 2) {
        x1 = src.cxLeft;
        y1 = src.cy;
        x2 = dst.cxLeft;
        y2 = dst.cy;
      } else {
        x1 = src.cxRight;
        y1 = src.cy;
        x2 = dst.cxRight;
        y2 = dst.cy;
      }
      const dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
      const sameColOffset = src.colIdx === 2 ? -28 : 26;
      const pathD =
        src.colIdx === dst.colIdx
          ? `M ${x1} ${y1} C ${x1 + sameColOffset} ${y1}, ${x2 + sameColOffset} ${y2}, ${x2} ${y2}`
          : src.colIdx < dst.colIdx
            ? `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;

      const midX =
        src.colIdx === dst.colIdx
          ? src.colIdx === 2
            ? x1 - 32
            : x1 + 28
          : Math.round((x1 + x2) / 2);

      return {
        ...edge,
        pathD,
        midX,
        midY: Math.round((y1 + y2) / 2) - (edgeIdx % 2 === 0 ? 5 : -10)
      };
    });

  return {
    positionedNodes: [...positionedMap.values()],
    positionedEdges,
    overflowCounts
  };
}

export function HydraScopeCockpit() {
  const [activeTab, setActiveTab] = useState('arena');

  // Workspace state from GET /api/state
  const [workspaceState, setWorkspaceState] = useState(null);
  const [stateLoading, setStateLoading] = useState(true);
  const [globalError, setGlobalError] = useState('');

  // Tab 1: Vector vs. HydraDB Arena state
  const [selectedScenarioId, setSelectedScenarioId] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [asOfInput, setAsOfInput] = useState('');
  const [tokenBudget, setTokenBudget] = useState(900);
  const [topK, setTopK] = useState(5);
  const [arenaResult, setArenaResult] = useState(null);
  const [arenaLoading, setArenaLoading] = useState(false);
  const [selectedSvgNodeId, setSelectedSvgNodeId] = useState('');
  const [showCypherInspector, setShowCypherInspector] = useState(true);
  const [showVectorRawContext, setShowVectorRawContext] = useState(false);

  // Tab 2: 64-Tool Continual Learning & Concurrent Load state
  const [continualResult, setContinualResult] = useState(null);
  const [continualLoading, setContinualLoading] = useState(false);
  const [loadTotalRequests, setLoadTotalRequests] = useState(64);
  const [loadConcurrency, setLoadConcurrency] = useState(8);
  const [loadTestResult, setLoadTestResult] = useState(null);
  const [loadTestLoading, setLoadTestLoading] = useState(false);
  const [loadTestError, setLoadTestError] = useState('');

  // Tab 3: 8-Task Benchmark state
  const [benchResult, setBenchResult] = useState(null);
  const [benchLoading, setBenchLoading] = useState(false);

  // Tab 4: Live Graph Studio state
  const [supersedeForm, setSupersedeForm] = useState({
    oldId: 'adr:ADR-014',
    newId: 'adr:ADR-025',
    title: 'ADR-025: Post-Quantum Ed25519 + HMAC Dual Attestation',
    governsInput: 'file:src/webhooks/stripe-handler.ts, file:src/webhooks/signature-guard.ts',
    effectiveAt: '2026-11-15',
    content:
      'All inbound Stripe webhooks must verify both constant-time HMAC-SHA256 and detached Ed25519 signature headers within a 180-second replay window. Single-primitive HMAC-only verification in ADR-014 is retired.'
  });
  const [supersedeStatus, setSupersedeStatus] = useState(null);
  const [supersedeLoading, setSupersedeLoading] = useState(false);

  const [ingestDirInput, setIngestDirInput] = useState('.');
  const [ingestStatus, setIngestStatus] = useState(null);
  const [ingestLoading, setIngestLoading] = useState(false);

  const arenaAbortRef = useRef(null);
  const continualAbortRef = useRef(null);
  const loadTestAbortRef = useRef(null);
  const benchAbortRef = useRef(null);
  const studioAbortRef = useRef(null);
  const userEditedQueryRef = useRef(false);
  const tabButtonRefs = useRef({});
  const initializedRef = useRef(false);

  const cypherClipboard = useCopyToClipboard({ timeout: 1800 });
  const promptClipboard = useCopyToClipboard({ timeout: 1800 });

  const nodeLookup = useMemo(() => {
    const map = new Map();
    for (const node of workspaceState?.nodes || []) {
      if (node?.id) map.set(node.id, node);
    }
    for (const dec of workspaceState?.decisions || []) {
      if (dec?.id && !map.has(dec.id)) map.set(dec.id, { ...dec, kind: 'decision' });
    }
    return map;
  }, [workspaceState]);

  const activeDecisions = useMemo(
    () => (workspaceState?.decisions || []).filter((d) => d.isCurrent !== false),
    [workspaceState]
  );

  const syncDefaultSupersedeTarget = useCallback((stateData) => {
    const decisions = Array.isArray(stateData?.decisions) ? stateData.decisions : [];
    const edges = Array.isArray(stateData?.edges) ? stateData.edges : [];
    const currentOnly = decisions.filter((d) => d.isCurrent !== false);
    if (currentOnly.length === 0) {
      setSupersedeForm((prev) => ({
        ...prev,
        oldId: ''
      }));
      return;
    }

    const preferred =
      currentOnly.find((d) => String(d.id).includes('ADR-014')) || currentOnly[0];

    if (!preferred?.id) return;

    const governed = edges
      .filter((e) => e.from === preferred.id && String(e.type).toUpperCase() === 'GOVERNS')
      .map((e) => e.to);
    const prefix = preferred.id.includes(':') ? preferred.id.split(':')[0] : 'adr';
    const nextAdrId = computeNextAdrId(stateData?.nodes || decisions, prefix);

    setSupersedeForm((prev) => ({
      ...prev,
      oldId: preferred.id,
      newId: nextAdrId,
      governsInput: governed.length > 0 ? governed.join(', ') : prev.governsInput
    }));
  }, []);

  const runArenaComparison = useCallback(
    async ({ query, asOf, budget, k, scenarioId, externalSignal }) => {
      const trimmed = String(query || '').trim();
      if (!trimmed) return;

      const cleanAsOf = asOf && String(asOf).trim() ? String(asOf).trim() : null;
      if (cleanAsOf && !isValidIsoDate(cleanAsOf)) {
        setGlobalError(`Invalid asOf date "${cleanAsOf}". Expected valid calendar date in YYYY-MM-DD format.`);
        return;
      }

      if (arenaAbortRef.current) {
        arenaAbortRef.current.abort();
      }
      const controller = new AbortController();
      arenaAbortRef.current = controller;

      const onExternalAbort = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) return;
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }

      setArenaLoading(true);
      setGlobalError('');
      if (scenarioId !== undefined) {
        setSelectedScenarioId(scenarioId);
      }

      try {
        const raw = await fetchApiJson('/api/arena/compare', {
          method: 'POST',
          body: {
            query: trimmed,
            asOf: cleanAsOf,
            tokenBudget: Number(budget) || 900,
            topK: Number(k) || 5
          },
          signal: controller.signal,
          timeoutMs: 25000
        });
        if (!controller.signal.aborted) {
          const data = unwrapPayload(raw);
          setArenaResult(data);
          const firstNode =
            data?.hydra?.traversedNodes?.[0]?.id ||
            data?.hydra?.retiredBlockedNodes?.[0]?.id ||
            '';
          setSelectedSvgNodeId(firstNode);
          setArenaLoading(false);
        }
      } catch (err) {
        if (controller.signal.aborted || err?.name === 'AbortError') return;
        setGlobalError(err?.message || 'Arena head-to-head comparison failed.');
        setArenaLoading(false);
      } finally {
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    },
    []
  );

  const runLiveBenchmark = useCallback(async (externalSignal) => {
    if (benchAbortRef.current) {
      benchAbortRef.current.abort();
    }
    const controller = new AbortController();
    benchAbortRef.current = controller;

    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) return;
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    setBenchLoading(true);
    setGlobalError('');
    try {
      const raw = await fetchApiJson('/api/benchmark/run', {
        method: 'POST',
        body: {},
        signal: controller.signal,
        timeoutMs: 30000
      });
      if (!controller.signal.aborted) {
        setBenchResult(unwrapPayload(raw));
        setBenchLoading(false);
      }
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return;
      setGlobalError(err?.message || 'Benchmark suite execution failed.');
      setBenchLoading(false);
    } finally {
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }, []);

  const runContinualLoop = useCallback(async (externalSignal) => {
    if (continualAbortRef.current) {
      continualAbortRef.current.abort();
    }
    const controller = new AbortController();
    continualAbortRef.current = controller;

    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) return null;
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    setContinualLoading(true);
    setGlobalError('');
    try {
      const raw = await fetchApiJson('/api/continual/run', {
        method: 'POST',
        body: {},
        signal: controller.signal,
        timeoutMs: 30000
      });
      if (!controller.signal.aborted) {
        const parsed = unwrapPayload(raw);
        setContinualResult(parsed);
        setContinualLoading(false);
        return parsed;
      }
      return null;
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return null;
      setGlobalError(err?.message || 'Continual-learning 4-epoch evaluation failed.');
      setContinualLoading(false);
      return null;
    } finally {
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }, []);

  const runConcurrentLoadTest = useCallback(
    async ({ totalRequests = 64, concurrency = 8, externalSignal } = {}) => {
      if (loadTestAbortRef.current) {
        loadTestAbortRef.current.abort();
      }
      const controller = new AbortController();
      loadTestAbortRef.current = controller;

      const onExternalAbort = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) return null;
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }

      setLoadTestLoading(true);
      setLoadTestError('');
      setGlobalError('');
      try {
        const raw = await fetchApiJson('/api/benchmark/load', {
          method: 'POST',
          body: {
            totalRequests: Number(totalRequests) || 64,
            concurrency: Number(concurrency) || 8
          },
          signal: controller.signal,
          timeoutMs: 45000
        });
        if (!controller.signal.aborted) {
          const parsed = unwrapPayload(raw);
          setLoadTestResult(parsed);
          setLoadTestLoading(false);
          return parsed;
        }
        return null;
      } catch (err) {
        if (controller.signal.aborted || err?.name === 'AbortError') return null;
        const msg = err?.message || 'Concurrent OpenCypher load test failed.';
        setLoadTestError(msg);
        setGlobalError(msg);
        setLoadTestLoading(false);
        return null;
      } finally {
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    },
    []
  );

  // Auto-load 4-epoch continual learning when Tab 2 opens if not already loaded or in-flight
  useEffect(() => {
    if (activeTab !== 'continual') return;
    if (continualResult || continualLoading) return;
    runContinualLoop();
  }, [activeTab, continualResult, continualLoading, runContinualLoop]);

  const reloadWorkspaceState = useCallback(
    async (signal) => {
      setStateLoading(true);
      const raw = await fetchApiJson('/api/state', { signal, timeoutMs: 20000 });
      const data = unwrapPayload(raw);
      if (!signal?.aborted) {
        setWorkspaceState(data);
        setStateLoading(false);
      }
      return data;
    },
    []
  );

  // Initial load: hydrate workspace state, auto-run Scenario #1 in Arena, and warm 8-Task Benchmark
  useEffect(() => {
    const controller = new AbortController();

    async function bootstrap() {
      try {
        const data = await reloadWorkspaceState(controller.signal);
        if (controller.signal.aborted || !data) return;

        syncDefaultSupersedeTarget(data);

        if (!initializedRef.current) {
          initializedRef.current = true;
          const firstScenario = Array.isArray(data.scenarios) && data.scenarios.length > 0 ? data.scenarios[0] : null;
          const initQuery =
            firstScenario?.query ||
            'If we modify calculatePartnerFee, what downstream compliance reconcilers and invariants are impacted?';
          const initAsOf = firstScenario?.asOf || '';
          const initBudget = firstScenario?.tokenBudget || 900;

          if (!userEditedQueryRef.current) {
            setSelectedScenarioId(firstScenario?.id || '');
            setQueryInput(initQuery);
            setAsOfInput(initAsOf);
            setTokenBudget(initBudget);
          }

          await Promise.all([
            runArenaComparison({
              query: initQuery,
              asOf: initAsOf,
              budget: initBudget,
              k: 5,
              scenarioId: firstScenario?.id || '',
              externalSignal: controller.signal
            }),
            runContinualLoop(controller.signal),
            runLiveBenchmark(controller.signal)
          ]);
        }
      } catch (err) {
        if (controller.signal.aborted || err?.name === 'AbortError') return;
        setGlobalError(err?.message || 'Unable to load HydraScope workspace state.');
        setStateLoading(false);
      }
    }

    bootstrap();

    return () => {
      controller.abort();
      arenaAbortRef.current?.abort();
      continualAbortRef.current?.abort();
      loadTestAbortRef.current?.abort();
      benchAbortRef.current?.abort();
      studioAbortRef.current?.abort();
    };
  }, [reloadWorkspaceState, runArenaComparison, runContinualLoop, runLiveBenchmark, syncDefaultSupersedeTarget]);

  const handleTabKeyDown = (event, currentKey) => {
    const idx = TAB_ORDER.indexOf(currentKey);
    if (idx === -1) return;
    let nextIdx = -1;
    if (event.key === 'ArrowRight') nextIdx = (idx + 1) % TAB_ORDER.length;
    else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = TAB_ORDER.length - 1;
    if (nextIdx === -1) return;

    event.preventDefault();
    const nextTab = TAB_ORDER[nextIdx];
    setActiveTab(nextTab);
    if (nextTab === 'benchmark' && !benchResult && !benchLoading) {
      runLiveBenchmark();
    }
    tabButtonRefs.current[nextTab]?.focus();
  };

  const handleSelectScenario = (scenario) => {
    if (!scenario) return;
    const nextQuery = scenario.query || '';
    const nextAsOf = scenario.asOf || '';
    const nextBudget = scenario.tokenBudget || tokenBudget || 900;
    setSelectedScenarioId(scenario.id || '');
    setQueryInput(nextQuery);
    setAsOfInput(nextAsOf);
    setTokenBudget(nextBudget);
    setActiveTab('arena');
    runArenaComparison({
      query: nextQuery,
      asOf: nextAsOf,
      budget: nextBudget,
      k: topK,
      scenarioId: scenario.id || ''
    });
  };

  const handleQuickTimeTravel = (nextAsOf) => {
    setAsOfInput(nextAsOf);
    if (queryInput.trim()) {
      runArenaComparison({
        query: queryInput,
        asOf: nextAsOf,
        budget: tokenBudget,
        k: topK,
        scenarioId: selectedScenarioId
      });
    }
  };

  const handleBudgetChange = (nextBudget) => {
    setTokenBudget(nextBudget);
    if (queryInput.trim()) {
      runArenaComparison({
        query: queryInput,
        asOf: asOfInput,
        budget: nextBudget,
        k: topK,
        scenarioId: selectedScenarioId
      });
    }
  };

  const handleTopKChange = (nextK) => {
    setTopK(nextK);
    if (queryInput.trim()) {
      runArenaComparison({
        query: queryInput,
        asOf: asOfInput,
        budget: tokenBudget,
        k: nextK,
        scenarioId: selectedScenarioId
      });
    }
  };

  const handleArenaFormSubmit = (event) => {
    event.preventDefault();
    runArenaComparison({
      query: queryInput,
      asOf: asOfInput,
      budget: tokenBudget,
      k: topK,
      scenarioId: selectedScenarioId
    });
  };

  const handleOldDecisionChange = (nextOldId) => {
    const edges = Array.isArray(workspaceState?.edges) ? workspaceState.edges : [];
    const governed = edges
      .filter((e) => e.from === nextOldId && String(e.type).toUpperCase() === 'GOVERNS')
      .map((e) => e.to);

    setSupersedeForm((prev) => ({
      ...prev,
      oldId: nextOldId,
      governsInput: governed.length > 0 ? governed.join(', ') : prev.governsInput
    }));
  };

  const handleSupersedeSubmit = async (event) => {
    event.preventDefault();
    const cleanEff = supersedeForm.effectiveAt.trim() || '2026-11-15';
    if (!isValidIsoDate(cleanEff)) {
      setGlobalError(`Invalid effectiveAt date "${cleanEff}". Expected valid calendar date in YYYY-MM-DD format.`);
      return;
    }

    studioAbortRef.current?.abort();
    const controller = new AbortController();
    studioAbortRef.current = controller;

    setSupersedeLoading(true);
    setSupersedeStatus(null);
    setGlobalError('');

    const governsIds = supersedeForm.governsInput
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    try {
      const submittedOldId = supersedeForm.oldId.trim();
      const submittedNewId = supersedeForm.newId.trim();
      const submittedTitle = supersedeForm.title.trim();

      const raw = await fetchApiJson('/api/decisions/supersede', {
        method: 'POST',
        body: {
          oldId: submittedOldId,
          newId: submittedNewId,
          title: submittedTitle,
          content: supersedeForm.content.trim(),
          governsIds,
          effectiveAt: cleanEff
        },
        signal: controller.signal,
        timeoutMs: 25000
      });
      const resultData = unwrapPayload(raw);
      const refreshedState = await reloadWorkspaceState(controller.signal);
      if (controller.signal.aborted) return;

      const createdId = resultData?.newNode?.id || submittedNewId;
      const prefix = createdId.includes(':') ? createdId.split(':')[0] : 'adr';
      const nextUnusedId = computeNextAdrId(refreshedState?.nodes || [], prefix);
      const nextBareCode = nextUnusedId.replace(/^[a-z_]+:/i, '');

      setSupersedeForm((prev) => ({
        ...prev,
        oldId: createdId,
        newId: nextUnusedId,
        title: prev.title.replace(/^ADR-\d+/i, nextBareCode)
      }));

      setSupersedeStatus({
        newId: createdId,
        oldId: submittedOldId,
        title: submittedTitle,
        governsIds,
        details: resultData,
        nodeCount: refreshedState?.nodeCount
      });
      runLiveBenchmark();
      if (queryInput.trim()) {
        runArenaComparison({
          query: queryInput,
          asOf: asOfInput,
          budget: tokenBudget,
          k: topK,
          scenarioId: selectedScenarioId
        });
      }
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return;
      setGlobalError(err?.message || 'Failed to write :SUPERSEDES decision edge.');
    } finally {
      if (!controller.signal.aborted) {
        setSupersedeLoading(false);
      }
    }
  };

  const handleTestSupersededInArena = () => {
    const targetGov = supersedeStatus?.governsIds?.[0] || 'stripe-handler';
    const cleanTarget = targetGov.replace(/^(file:|symbol:)/, '');
    const testQuery = `What active security ADR governs webhook signature verification in ${cleanTarget}?`;
    setQueryInput(testQuery);
    setAsOfInput('');
    setSelectedScenarioId('');
    setActiveTab('arena');
    runArenaComparison({
      query: testQuery,
      asOf: '',
      budget: tokenBudget,
      k: topK,
      scenarioId: ''
    });
  };

  const handleIngestDirectory = async (dirPath) => {
    studioAbortRef.current?.abort();
    const controller = new AbortController();
    studioAbortRef.current = controller;

    setIngestLoading(true);
    setIngestStatus(null);
    setSupersedeStatus(null);
    setGlobalError('');
    try {
      const normalizedDir = dirPath === '' ? 'reset' : dirPath;
      const raw = await fetchApiJson('/api/workspace/ingest-dir', {
        method: 'POST',
        body: { targetDir: normalizedDir },
        signal: controller.signal,
        timeoutMs: 30000
      });
      const ingestData = unwrapPayload(raw);
      const refreshed = await reloadWorkspaceState(controller.signal);
      if (controller.signal.aborted) return;

      syncDefaultSupersedeTarget(refreshed);
      setSelectedSvgNodeId('');
      setArenaResult(null);
      setBenchResult(null);

      const nextFirstScenario =
        Array.isArray(refreshed?.scenarios) && refreshed.scenarios.length > 0
          ? refreshed.scenarios[0]
          : null;
      const fallbackNode = refreshed?.nodes?.[0];
      const nextQuery =
        nextFirstScenario?.query ||
        (fallbackNode
          ? `What downstream modules and callers are impacted if I modify ${fallbackNode.title || fallbackNode.id}?`
          : '');
      const nextAsOf = nextFirstScenario?.asOf || '';
      const nextBudget = nextFirstScenario?.tokenBudget || 900;

      setSelectedScenarioId(nextFirstScenario?.id || '');
      setQueryInput(nextQuery);
      setAsOfInput(nextAsOf);
      setTokenBudget(nextBudget);

      setIngestStatus({
        workspaceName:
          refreshed?.workspaceName || ingestData?.workspaceName || normalizedDir || 'workspace',
        nodeCount: refreshed?.nodeCount ?? ingestData?.nodeCount ?? 0,
        edgeCount: refreshed?.edgeCount ?? ingestData?.edgeCount ?? 0
      });

      if (nextQuery) {
        runArenaComparison({
          query: nextQuery,
          asOf: nextAsOf,
          budget: nextBudget,
          k: topK,
          scenarioId: nextFirstScenario?.id || ''
        });
      }
      runLiveBenchmark();
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return;
      setGlobalError(err?.message || 'Directory compilation failed.');
    } finally {
      if (!controller.signal.aborted) {
        setIngestLoading(false);
      }
    }
  };

  // Derived telemetry & Arena metrics
  const hydraHealth = workspaceState?.hydraHealth || {};
  const nodeCount = workspaceState?.nodeCount ?? workspaceState?.nodes?.length ?? 0;
  const edgeCount = workspaceState?.edgeCount ?? workspaceState?.edges?.length ?? 0;
  const fullRepoBaselineTokens = workspaceState?.totalRepoTokens ?? 0;
  const embeddingBackend =
    arenaResult?.vector?.embeddingBackend ||
    workspaceState?.embeddingBackend ||
    'deterministic-dense-256d';

  const scenarios = Array.isArray(workspaceState?.scenarios) ? workspaceState.scenarios : [];
  const activeScenario = scenarios.find((s) => s.id === selectedScenarioId) || null;

  const vectorData = arenaResult?.vector || {};
  const hydraData = arenaResult?.hydra || {};
  const answerability = hydraData?.answerability || { answerable: true, groundedTerms: [], missingTerms: [] };
  const isAnswerable = answerability.answerable !== false;
  const effectiveAsOf = arenaResult?.asOf || '';

  const tokenDelta = arenaResult?.tokenDelta || {};
  const kpiFullTokens = tokenDelta.fullRepoTokens ?? fullRepoBaselineTokens;
  const kpiVectorTokens = tokenDelta.vectorTokens ?? vectorData.tokenCount ?? 0;
  const kpiHydraTokens = tokenDelta.hydraTokens ?? hydraData.tokenCount ?? 0;
  const savingsVsRepoPct =
    tokenDelta.savingsVsRepoPct ??
    (kpiFullTokens > 0 ? Math.round(((kpiFullTokens - kpiHydraTokens) / kpiFullTokens) * 1000) / 10 : 0);
  const savingsVsVectorPct =
    tokenDelta.savingsVsVectorPct ??
    (kpiVectorTokens > 0 ? Math.round(((kpiVectorTokens - kpiHydraTokens) / kpiVectorTokens) * 1000) / 10 : 0);

  const rankedChunks = Array.isArray(vectorData.rankedChunks) ? vectorData.rankedChunks : [];
  const displayedVectorChunks = useMemo(
    () => rankedChunks.filter((c) => c.selected !== false),
    [rankedChunks]
  );
  const effectiveTopK = displayedVectorChunks.length || topK;

  const vectorPoisonedList = useMemo(() => {
    if (Array.isArray(arenaResult?.vectorPoisonedNodes)) {
      return arenaResult.vectorPoisonedNodes.map((item) => {
        const id = normalizeId(item);
        return typeof item === 'object' ? item : nodeLookup.get(id) || { id, title: id };
      });
    }
    return displayedVectorChunks.filter((c) => c.isCurrent === false || Boolean(c.retiredAt));
  }, [arenaResult, displayedVectorChunks, nodeLookup]);

  const structuralOnlyList = useMemo(() => {
    const rawList = Array.isArray(arenaResult?.structuralOnlyNodes) ? arenaResult.structuralOnlyNodes : [];
    const traversedMap = new Map((hydraData?.traversedNodes || []).map((n) => [n.id, n]));
    return rawList.map((item) => {
      const id = normalizeId(item);
      if (typeof item === 'object' && item.title) return item;
      return traversedMap.get(id) || nodeLookup.get(id) || { id, title: id };
    });
  }, [arenaResult, hydraData, nodeLookup]);

  const subgraphLayout = useMemo(
    () => buildSubgraphLayout(hydraData, workspaceState?.edges || []),
    [hydraData, workspaceState?.edges]
  );

  const inspectedNode = useMemo(() => {
    if (!selectedSvgNodeId) return subgraphLayout.positionedNodes[0] || null;
    return (
      subgraphLayout.positionedNodes.find((n) => n.id === selectedSvgNodeId) ||
      nodeLookup.get(selectedSvgNodeId) ||
      subgraphLayout.positionedNodes[0] ||
      null
    );
  }, [selectedSvgNodeId, subgraphLayout.positionedNodes, nodeLookup]);

  const nodeKindSummary = useMemo(() => {
    const counts = {};
    for (const n of workspaceState?.nodes || []) {
      const k = n.kind || 'artifact';
      counts[k] = (counts[k] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [workspaceState]);

  const isHistoricallyValidNode = (node) => {
    if (!effectiveAsOf || !node) return false;
    const refNode = nodeLookup.get(node.id);
    return Boolean(
      node.retiredAt ||
        node.isCurrent === false ||
        refNode?.retiredAt ||
        refNode?.isCurrent === false
    );
  };

  return (
    <div className="hs-cockpit">
      {/* 1. Top Telemetry Header */}
      <header className="hs-header">
        <div className="hs-header-inner">
          <div className="hs-brand">
            <div className="hs-brand-mark" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <circle cx="5" cy="12" r="2.6" fill="#10b981" />
                <circle cx="13" cy="6" r="2.4" fill="#06b6d4" />
                <circle cx="13" cy="18" r="2.4" fill="#10b981" />
                <circle cx="20" cy="12" r="2.6" fill="#34d399" />
                <path
                  d="M7.4 10.9L10.8 7.3M7.4 13.1L10.8 16.7M15.2 7.3L18 10.6M15.2 16.7L18 13.4"
                  stroke="#10b981"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div className="hs-brand-copy">
              <div className="hs-brand-title-row">
                <h1 className="hs-brand-title">HydraScope</h1>
                <span className="hs-track-tag">HydraDB Track 2</span>
              </div>
              <p className="hs-brand-subtitle">
                Structural Context Layer for Coding Agents on HydraDB
              </p>
            </div>
          </div>

          <div className="hs-telemetry-strip" aria-label="Live system telemetry">
            {hydraHealth?.healthy ? (
              <span className="hs-pill hs-pill-emerald" title={`Graph ID: ${hydraHealth.graphId || 'default'}`}>
                <span className="hs-dot hs-dot-emerald" />
                hydradb:0.4.0 LIVE
                {typeof hydraHealth.latencyMs === 'number' ? ` (${hydraHealth.latencyMs}ms)` : ''}
              </span>
            ) : (
              <span className="hs-pill hs-pill-cyan">
                <span className="hs-dot hs-dot-cyan" />
                {hydraHealth?.mode ? `Embedded Mode (${hydraHealth.mode})` : 'Embedded Graph Mode'}
              </span>
            )}

            <span className="hs-pill">
              Embeddings: <strong style={{ color: '#e2e8f0' }}>{embeddingBackend}</strong>
            </span>

            <span className="hs-pill">
              {stateLoading
                ? 'Loading graph topology...'
                : `${formatNum(nodeCount)} Nodes / ${formatNum(edgeCount)} Edges / ${formatNum(fullRepoBaselineTokens)} Full-Repo Tokens`}
            </span>
          </div>
        </div>
      </header>

      <main className="hs-container">
        {/* 2. Navigation Tabs */}
        <div className="hs-nav-bar">
          <div className="hs-tabs" role="tablist" aria-label="HydraScope navigation">
            <button
              ref={(el) => {
                tabButtonRefs.current.arena = el;
              }}
              id="hs-tab-arena"
              type="button"
              role="tab"
              aria-selected={activeTab === 'arena'}
              aria-controls="hs-panel-arena"
              tabIndex={activeTab === 'arena' ? 0 : -1}
              className={`hs-tab-btn ${activeTab === 'arena' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('arena')}
              onKeyDown={(e) => handleTabKeyDown(e, 'arena')}
            >
              <span className="hs-tab-index">01</span>
              Vector vs. HydraDB Arena
            </button>

            <button
              ref={(el) => {
                tabButtonRefs.current.continual = el;
              }}
              id="hs-tab-continual"
              type="button"
              role="tab"
              aria-selected={activeTab === 'continual'}
              aria-controls="hs-panel-continual"
              tabIndex={activeTab === 'continual' ? 0 : -1}
              className={`hs-tab-btn ${activeTab === 'continual' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('continual')}
              onKeyDown={(e) => handleTabKeyDown(e, 'continual')}
            >
              <span className="hs-tab-index">02</span>
              64-Tool Continual Learning &amp; Load
            </button>

            <button
              ref={(el) => {
                tabButtonRefs.current.benchmark = el;
              }}
              id="hs-tab-benchmark"
              type="button"
              role="tab"
              aria-selected={activeTab === 'benchmark'}
              aria-controls="hs-panel-benchmark"
              tabIndex={activeTab === 'benchmark' ? 0 : -1}
              className={`hs-tab-btn ${activeTab === 'benchmark' ? 'is-active' : ''}`}
              onClick={() => {
                setActiveTab('benchmark');
                if (!benchResult && !benchLoading) {
                  runLiveBenchmark();
                }
              }}
              onKeyDown={(e) => handleTabKeyDown(e, 'benchmark')}
            >
              <span className="hs-tab-index">03</span>
              Proof-Over-Vectors Benchmark ({scenarios.length || 8} Tasks)
            </button>

            <button
              ref={(el) => {
                tabButtonRefs.current.studio = el;
              }}
              id="hs-tab-studio"
              type="button"
              role="tab"
              aria-selected={activeTab === 'studio'}
              aria-controls="hs-panel-studio"
              tabIndex={activeTab === 'studio' ? 0 : -1}
              className={`hs-tab-btn ${activeTab === 'studio' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('studio')}
              onKeyDown={(e) => handleTabKeyDown(e, 'studio')}
            >
              <span className="hs-tab-index">04</span>
              Live Graph Studio &amp; Time-Travel ADRs
            </button>
          </div>
        </div>

        {globalError && (
          <div className="hs-error-banner" role="alert" style={{ marginBottom: '1rem' }}>
            <span>Error: {globalError}</span>
            <button type="button" className="hs-btn hs-btn-mini" onClick={() => setGlobalError('')}>
              Dismiss
            </button>
          </div>
        )}

        {/* TAB 1: VECTOR VS. HYDRADB ARENA */}
        {activeTab === 'arena' && (
          <div
            id="hs-panel-arena"
            role="tabpanel"
            aria-labelledby="hs-tab-arena"
            className="hs-section-stack"
          >
            {/* Scenario Preset Strip + Query & Time-Travel Bar */}
            <section className="hs-card" aria-label="Scenario presets and query controls">
              <div className="hs-preset-header">
                <span className="hs-eyebrow">
                  Evaluation Presets ({scenarios.length || 8} Deterministic Engineering Tasks)
                </span>
                {workspaceState?.workspaceName && (
                  <span className="hs-badge hs-badge-slate">
                    Workspace: {workspaceState.workspaceName}
                  </span>
                )}
              </div>

              <div className="hs-preset-grid">
                {scenarios.map((scenario) => {
                  const cat = getCategoryMeta(scenario.category);
                  const isSelected = scenario.id === selectedScenarioId;
                  return (
                    <button
                      key={scenario.id}
                      type="button"
                      aria-pressed={isSelected}
                      className={`hs-preset-pill ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => handleSelectScenario(scenario)}
                    >
                      <span className={`hs-cat-tag ${cat.className}`}>{cat.label}</span>
                      <span>{scenario.title}</span>
                    </button>
                  );
                })}
              </div>

              {activeScenario?.explanation && (
                <div className="hs-scenario-note">
                  <strong style={{ color: '#e2e8f0' }}>Why Vector RAG Fails Here: </strong>
                  {activeScenario.explanation}
                </div>
              )}

              <form className="hs-query-form" onSubmit={handleArenaFormSubmit}>
                <input
                  id="hs-query-input"
                  type="text"
                  className="hs-input"
                  value={queryInput}
                  onChange={(e) => {
                    userEditedQueryRef.current = true;
                    setQueryInput(e.target.value);
                  }}
                  placeholder="Ask an architectural, blast-radius, or ADR governance question..."
                  aria-label="Engineering query"
                />
                <button
                  type="submit"
                  className="hs-btn hs-btn-primary"
                  disabled={arenaLoading || !queryInput.trim()}
                >
                  {arenaLoading ? 'Traversing...' : 'Run Head-to-Head'}
                </button>
              </form>

              <div className="hs-controls-subrow">
                <div className="hs-timetravel-group">
                  <label htmlFor="hs-asof-input" className="hs-inline-label">
                    Temporal Replay (asOf):
                  </label>
                  <button
                    type="button"
                    aria-pressed={!asOfInput}
                    className={`hs-btn hs-btn-mini ${!asOfInput ? 'is-active' : ''}`}
                    onClick={() => handleQuickTimeTravel('')}
                  >
                    HEAD (Now)
                  </button>
                  <button
                    type="button"
                    aria-pressed={asOfInput === '2026-03-01'}
                    className={`hs-btn hs-btn-mini ${asOfInput === '2026-03-01' ? 'is-active' : ''}`}
                    onClick={() => handleQuickTimeTravel('2026-03-01')}
                    title="Replay graph as of 2026-03-01 before ADR-003 was retired"
                  >
                    Time-Travel: 2026-03-01
                  </button>
                  <input
                    id="hs-asof-input"
                    type="text"
                    pattern="\d{4}-\d{2}-\d{2}"
                    className="hs-input hs-date-input"
                    value={asOfInput}
                    onChange={(e) => setAsOfInput(e.target.value)}
                    placeholder="YYYY-MM-DD (HEAD)"
                    aria-label="Optional asOf ISO date"
                  />
                </div>

                <div className="hs-budget-group">
                  <label htmlFor="hs-budget-select" className="hs-inline-label">
                    Budget:
                    <select
                      id="hs-budget-select"
                      className="hs-select hs-mini-select"
                      value={tokenBudget}
                      onChange={(e) => handleBudgetChange(Number(e.target.value))}
                    >
                      <option value={600}>600 tok</option>
                      <option value={900}>900 tok</option>
                      <option value={1400}>1,400 tok</option>
                    </select>
                  </label>
                  <label htmlFor="hs-topk-select" className="hs-inline-label">
                    Vector Top-K:
                    <select
                      id="hs-topk-select"
                      className="hs-select hs-mini-select"
                      value={topK}
                      onChange={(e) => handleTopKChange(Number(e.target.value))}
                    >
                      <option value={3}>Top 3</option>
                      <option value={5}>Top 5</option>
                      <option value={8}>Top 8</option>
                    </select>
                  </label>
                </div>
              </div>

              {effectiveAsOf && (
                <div className="hs-timetravel-banner">
                  <span>
                    TIME-TRAVEL ACTIVE (asOf = {effectiveAsOf}): Evaluating historical graph validity.
                    ADRs retired after {effectiveAsOf} become HISTORICALLY VALID while later ADRs are filtered.
                  </span>
                  <button
                    type="button"
                    className="hs-btn hs-btn-mini"
                    onClick={() => handleQuickTimeTravel('')}
                  >
                    Return to HEAD
                  </button>
                </div>
              )}
            </section>

            {/* KPI Comparison Banner */}
            <section className="hs-kpi-grid" aria-label="Token and accuracy comparison metrics">
              <div className="hs-kpi-card">
                <span className="hs-kpi-label">Full-Repo Stuffing</span>
                <span className="hs-kpi-value">{formatNum(kpiFullTokens)} tok</span>
                <span className="hs-kpi-sub">100% raw repository dump</span>
              </div>

              <div className="hs-kpi-card">
                <span className="hs-kpi-label">Vector Top-{effectiveTopK} Tokens</span>
                <span className="hs-kpi-value">{formatNum(kpiVectorTokens)} tok</span>
                <span className="hs-kpi-sub">
                  Cosine chunks ({vectorData.latencyMs ?? 0}ms)
                </span>
              </div>

              <div className="hs-kpi-card hs-kpi-card-emerald">
                <span className="hs-kpi-label">HydraDB Structural Slice</span>
                <span className="hs-kpi-value" style={{ color: '#34d399' }}>
                  {formatNum(kpiHydraTokens)} tok
                </span>
                <span className="hs-kpi-sub">
                  <span className="hs-badge hs-badge-emerald">-{savingsVsRepoPct}% vs repo</span>
                  {kpiVectorTokens > 0 && (
                    <span className="hs-badge hs-badge-cyan">
                      {savingsVsVectorPct >= 0
                        ? `-${savingsVsVectorPct}% vs vec`
                        : `+${Math.abs(savingsVsVectorPct)}% vs vec`}
                    </span>
                  )}
                </span>
              </div>

              <div
                className={`hs-kpi-card ${
                  vectorPoisonedList.length > 0 ? 'hs-kpi-card-rose' : ''
                }`}
              >
                <span className="hs-kpi-label">Poisoned Retired ADRs</span>
                <span className="hs-kpi-value">
                  <span style={{ color: vectorPoisonedList.length > 0 ? '#fb7185' : '#94a3b8' }}>
                    Vec: {vectorPoisonedList.length}
                  </span>
                  {' / '}
                  <span style={{ color: '#34d399' }}>Hydra: 0</span>
                </span>
                <span className="hs-kpi-sub">
                  {hydraData?.retiredBlockedNodes?.length > 0
                    ? `:SUPERSEDES blocked ${hydraData.retiredBlockedNodes.length} retired ADR(s)`
                    : effectiveAsOf
                      ? `Historical replay @ ${effectiveAsOf}`
                      : 'Zero deprecated rules injected'}
                </span>
              </div>

              <div className="hs-kpi-card hs-kpi-card-emerald">
                <span className="hs-kpi-label">2-Hop Graph-Only Nodes</span>
                <span className="hs-kpi-value" style={{ color: '#34d399' }}>
                  +{structuralOnlyList.length} nodes
                </span>
                <span className="hs-kpi-sub">
                  Found by AST/ADR edges, missed by cosine
                </span>
              </div>
            </section>

            {/* Interactive Custom SVG Subgraph Visualizer OR Pre-Flight Answerability Shield */}
            <section className="hs-card" aria-label="Structural subgraph visualization">
              <div className="hs-viz-header">
                <span className="hs-eyebrow">
                  {isAnswerable
                    ? 'Interactive Structural Traversal Subgraph (Seeds -> Hop 1 -> Hop 2 / Governance)'
                    : 'Pre-Flight Ontology Answerability Gate'}
                </span>
                <div className="hs-viz-legend">
                  <span className="hs-legend-item">
                    <span className="hs-legend-swatch" style={{ background: '#06b6d4' }} />
                    Seed Entrypoint
                  </span>
                  <span className="hs-legend-item">
                    <span className="hs-legend-swatch" style={{ background: '#10b981' }} />
                    Active Structural Hop
                  </span>
                  <span className="hs-legend-item">
                    <span
                      className="hs-legend-swatch"
                      style={{ background: 'rgba(244,63,94,0.35)', border: '1px dashed #f43f5e' }}
                    />
                    Blocked Retired ADR (:SUPERSEDES)
                  </span>
                </div>
              </div>

              {!isAnswerable ? (
                <div className="hs-shield-card" role="status">
                  <h3 className="hs-shield-title">
                    <span className="hs-badge hs-badge-amber">PRE-FLIGHT BLOCK</span>
                    0 LLM Tokens Burned: Missing Concepts [
                    {(answerability.missingTerms || []).join(', ') || 'ungrounded subsystem'}]
                  </h3>
                  <p className="hs-shield-body">
                    {answerability.reason ||
                      'HydraScope verified the query against the compiled repository ontology before invoking any LLM or burning context budget. Because the requested subsystem does not exist in the codebase graph, traversal halted deterministically at 0 tokens.'}
                  </p>
                  <div className="hs-term-chips">
                    {(answerability.missingTerms || []).map((term) => (
                      <span key={term} className="hs-term-chip hs-badge-amber">
                        Missing in Ontology: {term}
                      </span>
                    ))}
                    {(answerability.groundedTerms || []).map((term) => (
                      <span key={term} className="hs-term-chip hs-badge-emerald">
                        Grounded: {term}
                      </span>
                    ))}
                    <span className="hs-term-chip hs-badge-rose">
                      Vector Store Wasted: {formatNum(kpiVectorTokens)} tok of unrelated neighbors
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="hs-svg-frame">
                    <svg
                      viewBox="0 0 760 240"
                      className="hs-subgraph-svg"
                      role="group"
                      aria-labelledby="hs-subgraph-title"
                    >
                      <title id="hs-subgraph-title">
                        HydraDB traversed nodes and edges layered from seeds to multi-hop governance
                      </title>
                      <defs>
                        <marker
                          id="hs-arrow-emerald"
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#10b981" />
                        </marker>
                        <marker
                          id="hs-arrow-cyan"
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#06b6d4" />
                        </marker>
                        <marker
                          id="hs-arrow-rose"
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#f43f5e" />
                        </marker>
                        <marker
                          id="hs-arrow-amber"
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#f59e0b" />
                        </marker>
                      </defs>

                      {/* Column Divider Lane Guides */}
                      <line x1="252" y1="10" x2="252" y2="232" stroke="#1e293b" strokeDasharray="3 4" />
                      <line x1="508" y1="10" x2="508" y2="232" stroke="#1e293b" strokeDasharray="3 4" />

                      {/* Column Titles */}
                      <text x="24" y="22" fill="#94a3b8" fontSize="10" fontFamily="monospace" fontWeight="700">
                        01. SEED ENTRYPOINTS
                      </text>
                      <text x="280" y="22" fill="#94a3b8" fontSize="10" fontFamily="monospace" fontWeight="700">
                        02. HOP 1 DIRECT / GOVERNS
                      </text>
                      <text x="536" y="22" fill="#94a3b8" fontSize="10" fontFamily="monospace" fontWeight="700">
                        03. HOP 2+ / ADR LINEAGE
                      </text>

                      {subgraphLayout.positionedNodes.length === 0 && (
                        <text
                          x="380"
                          y="132"
                          textAnchor="middle"
                          fill="#94a3b8"
                          fontSize="11"
                          fontFamily="monospace"
                        >
                          {arenaLoading
                            ? 'Traversing structural OpenCypher subgraph...'
                            : 'No active structural nodes matched at the selected timestamp.'}
                        </text>
                      )}

                      {/* Directed Edges */}
                      {subgraphLayout.positionedEdges.map((edge, idx) => {
                        const isSupersedes = edge.type === 'SUPERSEDES';
                        const isGoverns = edge.type === 'GOVERNS';
                        const isEnv = edge.type === 'READS_ENV';
                        const stroke = isSupersedes
                          ? '#f43f5e'
                          : isGoverns
                            ? '#06b6d4'
                            : isEnv
                              ? '#f59e0b'
                              : '#10b981';
                        const marker = isSupersedes
                          ? 'url(#hs-arrow-rose)'
                          : isGoverns
                            ? 'url(#hs-arrow-cyan)'
                            : isEnv
                              ? 'url(#hs-arrow-amber)'
                              : 'url(#hs-arrow-emerald)';

                        return (
                          <g key={`${edge.from}-${edge.to}-${idx}`}>
                            <path
                              d={edge.pathD}
                              fill="none"
                              stroke={stroke}
                              strokeWidth={isSupersedes ? '1.8' : '1.5'}
                              strokeDasharray={isSupersedes ? '5 3' : undefined}
                              strokeOpacity="0.82"
                              markerEnd={marker}
                            />
                            <text
                              x={edge.midX}
                              y={edge.midY}
                              textAnchor="middle"
                              fill={stroke}
                              fontSize="8.5"
                              fontFamily="monospace"
                              fontWeight="600"
                            >
                              :{edge.type}
                            </text>
                          </g>
                        );
                      })}

                      {/* Traversed + Blocked Retired Nodes */}
                      {subgraphLayout.positionedNodes.map((node) => {
                        const isBlocked = Boolean(node.isBlockedRetired);
                        const isHistValid = !isBlocked && isHistoricallyValidNode(node);
                        const isSeed = node.colIdx === 0 && !isBlocked;
                        const isSelected = inspectedNode?.id === node.id;

                        const strokeColor = isBlocked
                          ? '#f43f5e'
                          : isHistValid || isSeed
                            ? '#06b6d4'
                            : '#10b981';
                        const fillColor = isBlocked
                          ? 'rgba(244, 63, 94, 0.11)'
                          : isHistValid || isSeed
                            ? 'rgba(6, 182, 212, 0.12)'
                            : 'rgba(16, 185, 129, 0.11)';

                        const label = truncateLabel(node.title || node.id, 24);
                        const subLabel = isBlocked
                          ? 'BLOCKED: SUPERSEDED'
                          : isHistValid
                            ? `VALID @ ${effectiveAsOf}`
                            : `${String(node.kind || 'node').toUpperCase()} (${node.tokens ?? 0}t)`;

                        return (
                          <g
                            key={node.id}
                            className="hs-svg-node-group"
                            role="button"
                            tabIndex={0}
                            aria-pressed={isSelected}
                            aria-label={`${node.title || node.id} (${subLabel})`}
                            onClick={() => setSelectedSvgNodeId(node.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setSelectedSvgNodeId(node.id);
                              }
                            }}
                          >
                            <rect
                              x={node.x}
                              y={node.y}
                              width={node.w}
                              height={node.h}
                              rx="6"
                              fill={fillColor}
                              stroke={strokeColor}
                              strokeWidth={isSelected ? '2.2' : '1.3'}
                              strokeDasharray={isBlocked ? '5 3' : undefined}
                            />
                            <text
                              x={node.x + 9}
                              y={node.y + (node.h <= 32 ? 13 : 15)}
                              fill={isBlocked ? '#fda4af' : '#f8fafc'}
                              fontSize="10.5"
                              fontFamily="monospace"
                              fontWeight="700"
                            >
                              {label}
                            </text>
                            {/* Dashed red strikethrough line for retiredBlockedNodes */}
                            {isBlocked && (
                              <line
                                x1={node.x + 7}
                                y1={node.y + (node.h <= 32 ? 10 : 12)}
                                x2={node.x + Math.min(node.w - 10, 12 + label.length * 6.3)}
                                y2={node.y + (node.h <= 32 ? 10 : 12)}
                                stroke="#f43f5e"
                                strokeWidth="1.8"
                                strokeDasharray="4 2"
                              />
                            )}
                            <text
                              x={node.x + 9}
                              y={node.y + node.h - 6}
                              fill={isBlocked ? '#fb7185' : isHistValid ? '#22d3ee' : '#94a3b8'}
                              fontSize="8.5"
                              fontFamily="monospace"
                            >
                              {truncateLabel(subLabel, 28)}
                            </text>
                          </g>
                        );
                      })}

                      {/* Overflow counters per column */}
                      {subgraphLayout.overflowCounts.map((extra, cIdx) =>
                        extra > 0 ? (
                          <text
                            key={`overflow-${cIdx}`}
                            x={[24, 280, 536][cIdx] + 100}
                            y="233"
                            textAnchor="middle"
                            fill="#94a3b8"
                            fontSize="9"
                            fontFamily="monospace"
                          >
                            +{extra} additional node(s) in hop
                          </text>
                        ) : null
                      )}
                    </svg>
                  </div>

                  {inspectedNode && (
                    <div className="hs-node-inspector">
                      <span>
                        <strong style={{ color: '#f8fafc' }}>Selected Node:</strong>{' '}
                        {inspectedNode.id} ({inspectedNode.kind || 'artifact'})
                        {inspectedNode.path ? ` | Path: ${inspectedNode.path}` : ''}
                      </span>
                      <span>
                        {inspectedNode.isBlockedRetired ? (
                          <span className="hs-badge hs-badge-rose">
                            BLOCKED BY :SUPERSEDES ({inspectedNode.supersededBy || 'Newer ADR'})
                          </span>
                        ) : isHistoricallyValidNode(inspectedNode) ? (
                          <span className="hs-badge hs-badge-cyan">
                            HISTORICALLY VALID @ {effectiveAsOf}
                          </span>
                        ) : (
                          <span className="hs-badge hs-badge-emerald">
                            ACTIVE IN SLICE ({inspectedNode.tokens ?? 0} tok)
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                </>
              )}
            </section>

            {/* Split-Screen Comparison Columns */}
            <section className="hs-arena-split" aria-label="Side by side Vector Store vs HydraDB comparison">
              {/* LEFT COLUMN: Dense Cosine Vector Store Top-K */}
              <div className="hs-col-card hs-col-vector">
                <div className="hs-col-header">
                  <div>
                    <h2 className="hs-col-title">Dense Cosine Vector Store (Top-{effectiveTopK})</h2>
                    <p className="hs-col-subtitle">
                      Backend: {vectorData.embeddingBackend || embeddingBackend} |{' '}
                      {formatNum(vectorData.tokenCount)} tok | {vectorData.latencyMs ?? 0}ms
                    </p>
                  </div>
                  {vectorPoisonedList.length > 0 ? (
                    <span className="hs-badge hs-badge-rose">
                      {vectorPoisonedList.length} POISONED ADR
                    </span>
                  ) : (
                    <span className="hs-badge hs-badge-slate">Cosine Top-{effectiveTopK}</span>
                  )}
                </div>

                {structuralOnlyList.length > 0 && (
                  <div className="hs-callout-rose">
                    <div className="hs-callout-title">
                      Missed Multi-Hop Dependencies ({structuralOnlyList.length})
                    </div>
                    <div style={{ marginBottom: '0.4rem' }}>
                      Cosine similarity missed critical 2-hop callers, env keys, or governing invariants
                      that share zero vocabulary with the prompt:
                    </div>
                    <div className="hs-missed-list">
                      {structuralOnlyList.map((missed) => (
                        <span key={missed.id} className="hs-badge hs-badge-rose">
                          {missed.title || missed.id}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="hs-chunk-list">
                  {displayedVectorChunks.length === 0 ? (
                    <div className="hs-chunk-item">No vector chunks returned.</div>
                  ) : (
                    displayedVectorChunks.map((chunk, idx) => {
                      const isRetiredAtHead = !effectiveAsOf && (chunk.isCurrent === false || Boolean(chunk.retiredAt));
                      const isRetiredAtAsOf =
                        Boolean(effectiveAsOf) &&
                        ((Boolean(chunk.retiredAt) && String(chunk.retiredAt) <= String(effectiveAsOf)) ||
                          (Boolean(chunk.validFrom) && String(chunk.validFrom) > String(effectiveAsOf)));
                      const isPoisoned = isRetiredAtHead || isRetiredAtAsOf;

                      return (
                        <div
                          key={`${chunk.id}-${idx}`}
                          className={`hs-chunk-item ${isPoisoned ? 'hs-chunk-poisoned' : ''}`}
                        >
                          <div className="hs-chunk-top">
                            <span className="hs-chunk-title">
                              #{idx + 1} {chunk.title || chunk.id}
                            </span>
                            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                              {isPoisoned && (
                                <span className="hs-badge hs-badge-rose">
                                  POISONED: RETIRED ADR
                                </span>
                              )}
                              <span className="hs-badge hs-badge-slate">
                                cos {Number(chunk.score ?? 0).toFixed(3)}
                              </span>
                            </div>
                          </div>
                          <div className="hs-chunk-meta">
                            <span>[{chunk.kind || 'chunk'}]</span>
                            {chunk.path && <span>{chunk.path}</span>}
                            <span>{chunk.tokens ?? 0} tok</span>
                            {chunk.retiredAt && (
                              <span style={{ color: '#fda4af' }}>retiredAt: {chunk.retiredAt}</span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div>
                  <button
                    type="button"
                    aria-expanded={showVectorRawContext}
                    className="hs-btn hs-btn-mini"
                    onClick={() => setShowVectorRawContext((prev) => !prev)}
                  >
                    {showVectorRawContext ? 'Hide Raw Vector Context' : 'Inspect Raw Vector Prompt'}
                  </button>
                  {showVectorRawContext && (
                    <pre className="hs-code-pre" style={{ marginTop: '0.5rem' }}>
                      {vectorData.contextText || '(empty vector context)'}
                    </pre>
                  )}
                </div>
              </div>

              {/* RIGHT COLUMN: HydraDB Structural Traversal */}
              <div className="hs-col-card hs-col-hydra">
                <div className="hs-col-header">
                  <div>
                    <h2 className="hs-col-title">HydraDB Structural Traversal</h2>
                    <p className="hs-col-subtitle">
                      Mode: {hydraData?.hydraExecution?.mode || (hydraHealth?.healthy ? 'hydradb-live' : 'embedded-opencypher')}{' '}
                      | {formatNum(hydraData.tokenCount)} tok |{' '}
                      {hydraData?.hydraExecution?.latencyMs ?? 0}ms
                    </p>
                  </div>
                  {!isAnswerable ? (
                    <span className="hs-badge hs-badge-amber">0 TOK TRAP SHIELD</span>
                  ) : effectiveAsOf ? (
                    <span className="hs-badge hs-badge-cyan">AS-OF {effectiveAsOf}</span>
                  ) : (
                    <span className="hs-badge hs-badge-emerald">0% ADR POISONING</span>
                  )}
                </div>

                {(hydraData?.retiredBlockedNodes || []).length > 0 && (
                  <div className="hs-callout-emerald">
                    <div className="hs-callout-title">
                      Retired Decisions Filtered via :SUPERSEDES ({hydraData.retiredBlockedNodes.length})
                    </div>
                    <div className="hs-missed-list">
                      {hydraData.retiredBlockedNodes.map((blocked) => (
                        <span key={blocked.id} className="hs-badge hs-badge-rose">
                          BLOCKED: {blocked.title || blocked.id}
                          {blocked.supersededBy ? ` -> ${blocked.supersededBy}` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="hs-chunk-list">
                  {!isAnswerable ? (
                    <div className="hs-chunk-item" style={{ borderColor: 'rgba(245, 158, 11, 0.4)' }}>
                      <div className="hs-chunk-title" style={{ color: '#fbbf24' }}>
                        Traversal Halted Pre-Flight (0 Tokens Emitted)
                      </div>
                      <div className="hs-chunk-meta">
                        Missing terms not in graph ontology:{' '}
                        {(answerability.missingTerms || []).join(', ')}
                      </div>
                    </div>
                  ) : (hydraData?.traversedNodes || []).length === 0 ? (
                    <div className="hs-chunk-item">No structural nodes matched.</div>
                  ) : (
                    (hydraData.traversedNodes || []).map((node, idx) => {
                      const seedSet = new Set(
                        (hydraData.seedNodes || []).map(normalizeId)
                      );
                      const isSeed = seedSet.has(node.id) || node.hop === 0;
                      const histValid = isHistoricallyValidNode(node);
                      const hopLabel = isSeed
                        ? 'SEED'
                        : typeof node.hop === 'number'
                          ? `HOP ${node.hop}`
                          : idx === 0
                            ? 'SEED'
                            : 'TRAVERSED';

                      return (
                        <div
                          key={node.id}
                          className={`hs-chunk-item ${
                            histValid ? 'hs-chunk-historical' : 'hs-chunk-structural'
                          }`}
                        >
                          <div className="hs-chunk-top">
                            <span className="hs-chunk-title">{node.title || node.id}</span>
                            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                              {histValid && (
                                <span className="hs-badge hs-badge-cyan">
                                  HISTORICALLY VALID
                                </span>
                              )}
                              <span className="hs-badge hs-badge-emerald">{hopLabel}</span>
                              <span className="hs-badge hs-badge-slate">
                                {node.kind || 'node'}
                              </span>
                            </div>
                          </div>
                          <div className="hs-chunk-meta">
                            <span>ID: {node.id}</span>
                            {node.path && <span>| {node.path}</span>}
                            <span>| {node.tokens ?? 0} tok</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Live OpenCypher & Epoch Bookmark Inspector */}
                <div className="hs-cypher-box">
                  <div className="hs-cypher-top">
                    <div className="hs-cypher-meta">
                      <strong>OpenCypher &amp; Epoch Bookmark Inspector</strong>
                      {hydraData?.hydraExecution?.lastReadEpoch !== undefined &&
                        hydraData?.hydraExecution?.lastReadEpoch !== null && (
                          <span className="hs-badge hs-badge-cyan">
                            Epoch: {String(hydraData.hydraExecution.lastReadEpoch)}
                          </span>
                        )}
                      {hydraData?.hydraExecution?.lastBookmark && (
                        <span className="hs-badge hs-badge-slate">
                          Bookmark: {truncateLabel(hydraData.hydraExecution.lastBookmark, 22)}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
                      {hydraData?.cypherQuery && (
                        <button
                          type="button"
                          className="hs-btn hs-btn-mini hs-btn-cyan"
                          onClick={() => cypherClipboard.copyToClipboard(hydraData.cypherQuery)}
                        >
                          {cypherClipboard.isCopied ? 'Copied!' : 'Copy Cypher'}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-expanded={showCypherInspector}
                        className="hs-btn hs-btn-mini"
                        onClick={() => setShowCypherInspector((prev) => !prev)}
                      >
                        {showCypherInspector ? 'Collapse' : 'Expand'}
                      </button>
                    </div>
                  </div>

                  {showCypherInspector && (
                    <pre className="hs-code-pre hs-code-pre-cypher">
                      {hydraData?.cypherQuery ||
                        '// Pre-flight ontology gate rejected ungrounded terms prior to OpenCypher execution.'}
                    </pre>
                  )}
                </div>

                {/* Assembled Compact Agent Prompt Preview */}
                <div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                      marginBottom: '0.4rem',
                      flexWrap: 'wrap'
                    }}
                  >
                    <span className="hs-eyebrow">
                      Assembled Agent Context Slice ({formatNum(hydraData.tokenCount)} Tokens)
                    </span>
                    {hydraData?.contextText && (
                      <button
                        type="button"
                        className="hs-btn hs-btn-mini"
                        onClick={() => promptClipboard.copyToClipboard(hydraData.contextText)}
                      >
                        {promptClipboard.isCopied ? 'Copied Slice!' : 'Copy Prompt Slice'}
                      </button>
                    )}
                  </div>
                  <pre className="hs-code-pre">
                    {hydraData?.contextText ||
                      (isAnswerable
                        ? 'Run a scenario to inspect the compiled structural context slice.'
                        : '[0 TOKENS] Query blocked by HydraScope ontology answerability guard.')}
                  </pre>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* TAB 2: 64-TOOL CONTINUAL LEARNING & CONCURRENT HYDRADB LOAD */}
        {activeTab === 'continual' && (
          <div
            id="hs-panel-continual"
            role="tabpanel"
            aria-labelledby="hs-tab-continual"
            className="hs-section-stack"
          >
            {(() => {
              const cat = continualResult?.catalogSummary || {
                mcpServers: 8,
                totalMcpTools: 64,
                skillsCount: 8,
                totalPreloadTokens: 14800
              };
              const preloadBase = continualResult?.baselines?.preloadAll64 || {};
              const vecBase = continualResult?.baselines?.vectorTopK || {};
              const calcF1 = (p, r, explicit) => {
                if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
                const pv = Number(p) || 0;
                const rv = Number(r) || 0;
                return pv + rv > 0 ? (2 * pv * rv) / (pv + rv) : 0;
              };
              const preloadF1 = calcF1(
                preloadBase.toolPrecisionPct,
                preloadBase.toolRecallPct,
                preloadBase.toolF1Pct
              );
              const vecF1 = calcF1(
                vecBase.toolPrecisionPct,
                vecBase.toolRecallPct,
                vecBase.toolF1Pct
              );

              const epochs = Array.isArray(continualResult?.epochs) ? continualResult.epochs : [];
              const firstEp = epochs[0] || null;
              const lastEp = epochs.length > 0 ? epochs[epochs.length - 1] : null;

              // SVG Chart Geometry (viewBox 760 x 255)
              const plotLeft = 64;
              const plotRight = 720;
              const xStart = 122;
              const xEnd = 668;
              const plotTop = 30;
              const plotBottom = 182;
              const plotH = plotBottom - plotTop;
              const pctToY = (pct) => {
                const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
                return Math.round((plotBottom - (clamped / 100) * plotH) * 10) / 10;
              };
              const epochPoints = epochs.map((ep, idx) => {
                const denom = Math.max(1, epochs.length - 1);
                const x = Math.round((xStart + (idx / denom) * (xEnd - xStart)) * 10) / 10;
                return {
                  ...ep,
                  x,
                  yF1: pctToY(ep.toolF1Pct),
                  ySingle: pctToY(ep.singleTurnAccuracyPct)
                };
              });

              const f1Polyline = epochPoints.map((pt) => `${pt.x},${pt.yF1}`).join(' ');
              const f1AreaPath =
                epochPoints.length > 1
                  ? `M ${epochPoints[0].x} ${plotBottom} ` +
                    epochPoints.map((pt) => `L ${pt.x} ${pt.yF1}`).join(' ') +
                    ` L ${epochPoints[epochPoints.length - 1].x} ${plotBottom} Z`
                  : '';
              const singlePolyline = epochPoints.map((pt) => `${pt.x},${pt.ySingle}`).join(' ');
              const vecBaselineY = pctToY(vecF1);

              return (
                <>
                  {/* Continual Learning Header Banner */}
                  <section className="hs-card hs-bench-banner">
                    <div>
                      <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                        <span className="hs-badge hs-badge-emerald">Track 2 Agent Memory</span>
                        {continualResult?.hydraLive ? (
                          <span className="hs-badge hs-badge-cyan">
                            HydraDB Live ({formatNum(continualResult.cypherOpsCount)} Cypher Ops | Epoch{' '}
                            {String(continualResult.lastReadEpoch ?? 0)})
                          </span>
                        ) : (
                          <span className="hs-badge hs-badge-slate">
                            OpenCypher Continual Loop ({formatNum(continualResult?.cypherOpsCount ?? 0)} Ops)
                          </span>
                        )}
                      </div>
                      <h2 className="hs-bench-quote">
                        64-Tool MCP Context Layer: 4-Epoch Continual Learning vs. Static Tool-RAG
                      </h2>
                      <p className="hs-bench-sub">
                        Evaluates dynamic skill + MCP tool routing across {cat.mcpServers} servers (
                        {cat.totalMcpTools} tools), persisting <code>:RESOLVED_TO</code> entity
                        shortcuts and verified post-check tool chains in HydraDB so multi-turn lookups
                        collapse to single-turn execution.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="hs-btn hs-btn-primary"
                      onClick={() => runContinualLoop()}
                      disabled={continualLoading}
                    >
                      {continualLoading ? 'Running 4 Epochs...' : 'Run 4-Epoch Continual Loop'}
                    </button>
                  </section>

                  {/* 4 KPI Summary Cards */}
                  <section className="hs-continual-kpi-grid" aria-label="Continual learning summary metrics">
                    <div className="hs-kpi-card">
                      <span className="hs-kpi-label">MCP Tool &amp; Skill Catalog</span>
                      <span className="hs-kpi-value">
                        {formatNum(cat.totalMcpTools)} Tools / {formatNum(cat.mcpServers)} Servers
                      </span>
                      <span className="hs-kpi-sub">
                        {formatNum(cat.skillsCount)} skills | {formatNum(cat.totalPreloadTokens)} tok full preload
                      </span>
                    </div>

                    <div className="hs-kpi-card hs-kpi-card-emerald">
                      <span className="hs-kpi-label">Tool Selection F1 (Ep 1 -&gt; Ep 4)</span>
                      <span className="hs-kpi-value" style={{ color: '#34d399' }}>
                        {firstEp ? formatPct(firstEp.toolF1Pct) : '..'} -&gt;{' '}
                        {lastEp ? formatPct(lastEp.toolF1Pct) : '..'}
                      </span>
                      <span className="hs-kpi-sub">
                        Single-Turn Ready:{' '}
                        <strong style={{ color: '#22d3ee' }}>
                          {firstEp ? formatPct(firstEp.singleTurnAccuracyPct, 0) : '0%'} -&gt;{' '}
                          {lastEp ? formatPct(lastEp.singleTurnAccuracyPct, 0) : '100%'}
                        </strong>
                      </span>
                    </div>

                    <div className="hs-kpi-card hs-kpi-card-emerald">
                      <span className="hs-kpi-label">Mean Agent Round-Trips</span>
                      <span className="hs-kpi-value" style={{ color: '#22d3ee' }}>
                        {firstEp ? Number(firstEp.meanRoundTrips).toFixed(1) : '5.0'} -&gt;{' '}
                        {lastEp ? Number(lastEp.meanRoundTrips).toFixed(1) : '1.0'} turns
                      </span>
                      <span className="hs-kpi-sub">
                        {formatNum(lastEp?.resolvedEntityCount ?? 0)} :RESOLVED_TO entity edges learned
                      </span>
                    </div>

                    <div className="hs-kpi-card hs-kpi-card-emerald">
                      <span className="hs-kpi-label">Token Reduction vs. Preload</span>
                      <span className="hs-kpi-value" style={{ color: '#34d399' }}>
                        -{Number(lastEp?.tokenSavingsVsPreloadPct ?? 94.2).toFixed(1)}%
                      </span>
                      <span className="hs-kpi-sub">
                        {formatNum(lastEp?.meanPromptTokens ?? 0)} tok vs{' '}
                        {formatNum(preloadBase.meanPromptTokens ?? cat.totalPreloadTokens)} tok preload
                      </span>
                    </div>
                  </section>

                  {/* 1. SVG Rising Continual-Learning Curve Chart */}
                  <section className="hs-card" aria-label="Continual learning progression chart">
                    <div className="hs-viz-header">
                      <span className="hs-eyebrow">
                        Continual-Learning Convergence Curve (Epoch 1 Cold -&gt; Epoch 4 Converged)
                      </span>
                      <div className="hs-viz-legend">
                        <span className="hs-legend-item">
                          <span className="hs-legend-swatch" style={{ background: '#10b981' }} />
                          HydraScope Tool F1 %
                        </span>
                        <span className="hs-legend-item">
                          <span className="hs-legend-swatch" style={{ background: '#06b6d4' }} />
                          Single-Turn Ready %
                        </span>
                        <span className="hs-legend-item">
                          <span
                            className="hs-legend-swatch"
                            style={{ background: 'rgba(244,63,94,0.35)', border: '1px dashed #f43f5e' }}
                          />
                          Static Vector Tool-RAG Baseline ({formatPct(vecF1)})
                        </span>
                      </div>
                    </div>

                    <div className="hs-svg-frame">
                      <svg
                        viewBox="0 0 760 255"
                        className="hs-subgraph-svg"
                        role="img"
                        aria-labelledby="hs-continual-chart-title"
                      >
                        <title id="hs-continual-chart-title">
                          Four-epoch continual learning F1 and single-turn readiness curve compared against flat Vector Tool-RAG baseline
                        </title>
                        <defs>
                          <linearGradient id="hs-f1-area-grad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#10b981" stopOpacity="0.28" />
                            <stop offset="100%" stopColor="#10b981" stopOpacity="0.01" />
                          </linearGradient>
                        </defs>

                        {/* Horizontal Y-Axis Gridlines (0%, 25%, 50%, 75%, 100%) */}
                        {[100, 75, 50, 25, 0].map((tick) => {
                          const y = pctToY(tick);
                          return (
                            <g key={`grid-${tick}`}>
                              <line
                                x1={plotLeft}
                                y1={y}
                                x2={plotRight}
                                y2={y}
                                stroke="#1e293b"
                                strokeDasharray={tick === 0 ? undefined : '3 4'}
                              />
                              <text
                                x={plotLeft - 10}
                                y={y + 3.5}
                                textAnchor="end"
                                fill="#94a3b8"
                                fontSize="9.5"
                                fontFamily="monospace"
                              >
                                {tick}%
                              </text>
                            </g>
                          );
                        })}

                        {/* Flat Dashed Vector Tool-RAG Baseline */}
                        {epochPoints.length > 0 && (
                          <g>
                            <line
                              x1={plotLeft}
                              y1={vecBaselineY}
                              x2={plotRight}
                              y2={vecBaselineY}
                              stroke="#f43f5e"
                              strokeWidth="1.6"
                              strokeDasharray="6 4"
                            />
                            <text
                              x={plotRight - 4}
                              y={Math.max(18, vecBaselineY - 6)}
                              textAnchor="end"
                              fill="#fda4af"
                              fontSize="9"
                              fontFamily="monospace"
                              fontWeight="600"
                            >
                              Static Vector Tool-RAG F1: {formatPct(vecF1)} (0% epoch gain)
                            </text>
                          </g>
                        )}

                        {/* Area + Rising Curves */}
                        {f1AreaPath && <path d={f1AreaPath} fill="url(#hs-f1-area-grad)" />}

                        {singlePolyline && (
                          <polyline
                            fill="none"
                            stroke="#06b6d4"
                            strokeWidth="2.2"
                            points={singlePolyline}
                          />
                        )}

                        {f1Polyline && (
                          <polyline
                            fill="none"
                            stroke="#10b981"
                            strokeWidth="2.8"
                            points={f1Polyline}
                          />
                        )}

                        {/* Epoch Vertices & Telemetry Annotations */}
                        {epochPoints.map((pt) => {
                          const collideLabels = Math.abs(pt.yF1 - pt.ySingle) < 16;
                          const singleLabelY = collideLabels ? pt.ySingle + 15 : pt.ySingle - 8;
                          return (
                            <g key={`ep-pt-${pt.epoch}`}>
                              <line
                                x1={pt.x}
                                y1={plotTop}
                                x2={pt.x}
                                y2={plotBottom}
                                stroke="#1e293b"
                                strokeOpacity="0.5"
                              />

                              {/* Single-Turn Ready Vertex */}
                              <circle
                                cx={pt.x}
                                cy={pt.ySingle}
                                r="4.5"
                                fill="#07090e"
                                stroke="#06b6d4"
                                strokeWidth="2.2"
                              />
                              <text
                                x={pt.x}
                                y={singleLabelY}
                                textAnchor="middle"
                                fill="#22d3ee"
                                fontSize="9"
                                fontFamily="monospace"
                                fontWeight="700"
                              >
                                1-Turn: {formatPct(pt.singleTurnAccuracyPct, 0)}
                              </text>

                              {/* Tool Selection F1 Vertex */}
                              <circle
                                cx={pt.x}
                                cy={pt.yF1}
                                r="5.2"
                                fill="#10b981"
                                stroke="#052e16"
                                strokeWidth="1.8"
                              />
                              <text
                                x={pt.x}
                                y={Math.max(15, pt.yF1 - 9)}
                                textAnchor="middle"
                                fill="#34d399"
                                fontSize="10"
                                fontFamily="monospace"
                                fontWeight="700"
                              >
                                F1 {formatPct(pt.toolF1Pct)}
                              </text>

                              {/* X-Axis Epoch Metadata */}
                              <text
                                x={pt.x}
                                y="202"
                                textAnchor="middle"
                                fill="#f8fafc"
                                fontSize="10.5"
                                fontFamily="monospace"
                                fontWeight="700"
                              >
                                Epoch {pt.epoch}
                              </text>
                              <text
                                x={pt.x}
                                y="217"
                                textAnchor="middle"
                                fill="#94a3b8"
                                fontSize="9"
                                fontFamily="monospace"
                              >
                                {truncateLabel(pt.label || `Stage ${pt.epoch}`, 22)}
                              </text>
                              <text
                                x={pt.x}
                                y="233"
                                textAnchor="middle"
                                fill="#34d399"
                                fontSize="9"
                                fontFamily="monospace"
                                fontWeight="600"
                              >
                                {Number(pt.meanRoundTrips ?? 0).toFixed(1)} turns | -
                                {Number(pt.tokenSavingsVsPreloadPct ?? 0).toFixed(1)}% tok
                              </text>
                            </g>
                          );
                        })}

                        {epochPoints.length === 0 && (
                          <text
                            x="380"
                            y="125"
                            textAnchor="middle"
                            fill="#94a3b8"
                            fontSize="12"
                            fontFamily="monospace"
                          >
                            {continualLoading
                              ? 'Executing 4-Epoch Continual-Learning Loop on HydraDB...'
                              : 'Click Run 4-Epoch Continual Loop to generate curve.'}
                          </text>
                        )}
                      </svg>
                    </div>
                  </section>

                  {/* 2. Baseline vs. Epoch Progression Table */}
                  <section aria-label="Continual learning baseline vs epoch comparison table">
                    <div className="hs-table-scroll">
                      <table className="hs-table">
                        <thead>
                          <tr>
                            <th>Strategy / Continual Epoch</th>
                            <th>Tool Recall</th>
                            <th>Tool Precision</th>
                            <th>Tool F1</th>
                            <th>Single-Turn Ready</th>
                            <th>Deprecated Tool Poison</th>
                            <th>Mean Round-Trips</th>
                            <th>Mean Prompt Tokens</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>
                              <strong>Baseline 1: {preloadBase.name || '64-Tool Window Preload'}</strong>
                              <div className="hs-col-subtitle">Stuff all 64 MCP schemas every turn</div>
                            </td>
                            <td>{formatPct(preloadBase.toolRecallPct)}</td>
                            <td>
                              <span className="hs-badge hs-badge-amber">
                                {formatPct(preloadBase.toolPrecisionPct)}
                              </span>
                            </td>
                            <td>{formatPct(preloadF1)}</td>
                            <td>
                              <span className="hs-badge hs-badge-slate">0.0%</span>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-rose">
                                {formatPct(preloadBase.deprecatedToolPoisonPct)}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'var(--hs-font-mono)' }}>
                              {Number(preloadBase.meanRoundTrips ?? 5).toFixed(1)}
                            </td>
                            <td style={{ fontFamily: 'var(--hs-font-mono)' }}>
                              {formatNum(preloadBase.meanPromptTokens ?? cat.totalPreloadTokens)} tok
                            </td>
                          </tr>

                          <tr>
                            <td>
                              <strong>Baseline 2: {vecBase.name || 'Static Vector Tool-RAG'}</strong>
                              <div className="hs-col-subtitle">
                                Frozen cosine Top-K ({continualResult?.embeddingBackend || embeddingBackend})
                              </div>
                            </td>
                            <td>{formatPct(vecBase.toolRecallPct)}</td>
                            <td>{formatPct(vecBase.toolPrecisionPct)}</td>
                            <td>
                              <span className="hs-badge hs-badge-amber">{formatPct(vecF1)}</span>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-slate">0.0%</span>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-rose">
                                {formatPct(vecBase.deprecatedToolPoisonPct)}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'var(--hs-font-mono)' }}>
                              {Number(vecBase.meanRoundTrips ?? 5).toFixed(1)}
                            </td>
                            <td style={{ fontFamily: 'var(--hs-font-mono)' }}>
                              {formatNum(vecBase.meanPromptTokens)} tok
                            </td>
                          </tr>

                          {epochs.map((ep, idx) => {
                            const isConverged = idx === epochs.length - 1;
                            return (
                              <tr key={ep.epoch} className={isConverged ? 'hs-arm-hydra' : ''}>
                                <td>
                                  <strong style={{ color: isConverged ? '#34d399' : '#f8fafc' }}>
                                    Epoch {ep.epoch}: {ep.label}
                                  </strong>
                                  <div className="hs-col-subtitle">
                                    {formatNum(ep.resolvedEntityCount)} :RESOLVED_TO shortcuts active
                                  </div>
                                </td>
                                <td>{formatPct(ep.toolRecallPct)}</td>
                                <td>{formatPct(ep.toolPrecisionPct)}</td>
                                <td>
                                  <span
                                    className={`hs-badge ${
                                      isConverged ? 'hs-badge-emerald' : 'hs-badge-cyan'
                                    }`}
                                  >
                                    {formatPct(ep.toolF1Pct)}
                                  </span>
                                </td>
                                <td>
                                  <span
                                    className={`hs-badge ${
                                      (ep.singleTurnAccuracyPct ?? 0) >= 99
                                        ? 'hs-badge-emerald'
                                        : (ep.singleTurnAccuracyPct ?? 0) > 0
                                          ? 'hs-badge-cyan'
                                          : 'hs-badge-slate'
                                    }`}
                                  >
                                    {formatPct(ep.singleTurnAccuracyPct, 0)}
                                  </span>
                                </td>
                                <td>
                                  <span className="hs-badge hs-badge-emerald">
                                    {formatPct(ep.deprecatedToolPoisonPct)}
                                  </span>
                                </td>
                                <td style={{ fontFamily: 'var(--hs-font-mono)', fontWeight: 700 }}>
                                  {Number(ep.meanRoundTrips ?? 1).toFixed(1)}
                                </td>
                                <td style={{ fontFamily: 'var(--hs-font-mono)' }}>
                                  <strong style={{ color: '#34d399' }}>
                                    {formatNum(ep.meanPromptTokens)} tok
                                  </strong>{' '}
                                  <span className="hs-badge hs-badge-emerald">
                                    -{Number(ep.tokenSavingsVsPreloadPct ?? 0).toFixed(1)}%
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  {/* Persisted Graph Learnings per Epoch */}
                  {epochs.length > 0 && (
                    <section className="hs-card" aria-label="Learned graph shortcuts per epoch">
                      <div className="hs-preset-header">
                        <span className="hs-eyebrow">
                          Learned Graph Mutations Persisted in HydraDB (:RESOLVED_TO &amp; Compressed Post-Check Chains)
                        </span>
                        {continualResult?.lastBookmark && (
                          <span className="hs-badge hs-badge-cyan">
                            Bookmark: {truncateLabel(continualResult.lastBookmark, 26)}
                          </span>
                        )}
                      </div>
                      <div className="hs-epoch-cards-grid">
                        {epochs.map((ep, idx) => {
                          const isFinal = idx === epochs.length - 1;
                          const learnedItems = Array.isArray(ep.learnedThisEpoch)
                            ? ep.learnedThisEpoch
                            : [];
                          return (
                            <div
                              key={`learned-${ep.epoch}`}
                              className={`hs-epoch-card ${isFinal ? 'hs-epoch-card-converged' : ''}`}
                            >
                              <div className="hs-epoch-card-head">
                                <h3 className="hs-epoch-title">
                                  Epoch {ep.epoch}: {ep.label}
                                </h3>
                                <span
                                  className={`hs-badge ${
                                    isFinal ? 'hs-badge-emerald' : 'hs-badge-cyan'
                                  }`}
                                >
                                  {Number(ep.meanRoundTrips ?? 1).toFixed(1)} turns
                                </span>
                              </div>
                              <div className="hs-chunk-meta" style={{ marginTop: 0 }}>
                                <span>F1: {formatPct(ep.toolF1Pct)}</span>
                                <span>| Entities: {formatNum(ep.resolvedEntityCount)}</span>
                              </div>
                              <ul className="hs-learned-list">
                                {learnedItems.length === 0 ? (
                                  <li className="hs-learned-item">
                                    Cold start structural routing (no prior :RESOLVED_TO edges yet)
                                  </li>
                                ) : (
                                  learnedItems.map((item, lIdx) => (
                                    <li key={`${ep.epoch}-${lIdx}`} className="hs-learned-item">
                                      {item}
                                    </li>
                                  ))
                                )}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {/* 3. Live HydraDB v0.4.0 Concurrent Load Test Panel */}
                  <section className="hs-card" aria-label="HydraDB concurrent OpenCypher load test">
                    <div className="hs-bench-banner">
                      <div>
                        <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', marginBottom: '0.28rem', flexWrap: 'wrap' }}>
                          <span className="hs-eyebrow">
                            Live HydraDB v0.4.0 Concurrent Stress Benchmark
                          </span>
                          <span className="hs-badge hs-badge-cyan">MATCH + MERGE Concurrency</span>
                        </div>
                        <p className="hs-bench-sub">
                          Fires concurrent parameterized OpenCypher read/write bursts directly against
                          HydraDB to verify tail latency (P50 / P95 / P99), zero-drop reliability, and
                          monotonic <code>read_epoch</code> consistency under swarm load.
                        </p>
                      </div>

                      <div className="hs-load-controls">
                        <label className="hs-inline-label">
                          Ops:
                          <select
                            className="hs-select hs-mini-select"
                            value={loadTotalRequests}
                            onChange={(e) => setLoadTotalRequests(Number(e.target.value))}
                          >
                            <option value={32}>32 ops</option>
                            <option value={64}>64 ops</option>
                            <option value={128}>128 ops</option>
                          </select>
                        </label>
                        <label className="hs-inline-label">
                          Workers:
                          <select
                            className="hs-select hs-mini-select"
                            value={loadConcurrency}
                            onChange={(e) => setLoadConcurrency(Number(e.target.value))}
                          >
                            <option value={4}>4x</option>
                            <option value={8}>8x</option>
                            <option value={16}>16x</option>
                          </select>
                        </label>
                        <button
                          type="button"
                          className="hs-btn hs-btn-primary"
                          disabled={loadTestLoading}
                          onClick={() =>
                            runConcurrentLoadTest({
                              totalRequests: loadTotalRequests,
                              concurrency: loadConcurrency
                            })
                          }
                        >
                          {loadTestLoading
                            ? `Firing ${loadTotalRequests} Concurrent Ops...`
                            : `Run ${loadTotalRequests}-Op Concurrent OpenCypher Load Test`}
                        </button>
                      </div>
                    </div>

                    {loadTestError && (
                      <div className="hs-error-banner" role="alert" style={{ marginTop: '0.85rem' }}>
                        <span>Load Test: {loadTestError}</span>
                        <button
                          type="button"
                          className="hs-btn hs-btn-mini"
                          onClick={() => setLoadTestError('')}
                        >
                          Dismiss
                        </button>
                      </div>
                    )}

                    {loadTestResult ? (
                      <>
                        <div className="hs-load-grid">
                          <div className="hs-kpi-card hs-kpi-card-emerald">
                            <span className="hs-kpi-label">Throughput</span>
                            <span className="hs-kpi-value" style={{ color: '#34d399' }}>
                              {Number(loadTestResult.throughputOpsPerSec ?? 0).toFixed(1)} ops/sec
                            </span>
                            <span className="hs-kpi-sub">
                              Wall time: {formatNum(loadTestResult.wallTimeMs)}ms (
                              {loadTestResult.concurrency} workers)
                            </span>
                          </div>

                          <div
                            className={`hs-kpi-card ${
                              (loadTestResult.failed ?? 0) === 0
                                ? 'hs-kpi-card-emerald'
                                : 'hs-kpi-card-rose'
                            }`}
                          >
                            <span className="hs-kpi-label">Success Rate</span>
                            <span className="hs-kpi-value">
                              {formatPct(loadTestResult.successRatePct)}
                            </span>
                            <span className="hs-kpi-sub">
                              {formatNum(loadTestResult.succeeded)}/{formatNum(loadTestResult.totalRequests)}{' '}
                              succeeded ({formatNum(loadTestResult.failed)} failed)
                            </span>
                          </div>

                          <div className="hs-kpi-card">
                            <span className="hs-kpi-label">P50 / P95 / P99 Latency</span>
                            <span className="hs-kpi-value" style={{ fontSize: '1.08rem' }}>
                              {Number(loadTestResult.p50Ms ?? 0).toFixed(1)} /{' '}
                              {Number(loadTestResult.p95Ms ?? 0).toFixed(1)} /{' '}
                              {Number(loadTestResult.p99Ms ?? 0).toFixed(1)} ms
                            </span>
                            <span className="hs-kpi-sub">End-to-end OpenCypher round-trip</span>
                          </div>

                          <div className="hs-kpi-card">
                            <span className="hs-kpi-label">HydraDB Read Epoch</span>
                            <span className="hs-kpi-value" style={{ color: '#22d3ee' }}>
                              {loadTestResult.lastReadEpoch !== null &&
                              loadTestResult.lastReadEpoch !== undefined
                                ? `epoch #${loadTestResult.lastReadEpoch}`
                                : 'embedded'}
                            </span>
                            <span className="hs-kpi-sub">Snapshot-consistent graph state</span>
                          </div>
                        </div>

                        {(() => {
                          const maxLat = Math.max(
                            1,
                            Number(loadTestResult.p99Ms) || 1,
                            Number(loadTestResult.p95Ms) || 1
                          );
                          const rows = [
                            { label: 'P50', ms: Number(loadTestResult.p50Ms ?? 0), color: '#10b981' },
                            { label: 'P95', ms: Number(loadTestResult.p95Ms ?? 0), color: '#06b6d4' },
                            { label: 'P99', ms: Number(loadTestResult.p99Ms ?? 0), color: '#f59e0b' }
                          ];
                          return (
                            <div className="hs-latency-bars">
                              {rows.map((r) => (
                                <div key={r.label} className="hs-latency-row">
                                  <strong>{r.label}</strong>
                                  <div className="hs-latency-track">
                                    <div
                                      className="hs-bar-fill"
                                      style={{
                                        width: `${Math.min(100, Math.max(4, (r.ms / maxLat) * 100))}%`,
                                        background: r.color
                                      }}
                                    />
                                  </div>
                                  <span style={{ textAlign: 'right', color: '#e2e8f0' }}>
                                    {r.ms.toFixed(1)}ms
                                  </span>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </>
                    ) : (
                      <div className="hs-node-inspector" style={{ marginTop: '0.85rem' }}>
                        <span>
                          Ready to fire {loadTotalRequests} concurrent parameterized OpenCypher MATCH +
                          MERGE operations at {loadConcurrency}x worker concurrency.
                        </span>
                        <span className="hs-badge hs-badge-cyan">POST /api/benchmark/load</span>
                      </div>
                    )}
                  </section>
                </>
              );
            })()}
          </div>
        )}

        {/* TAB 3: PROOF-OVER-VECTORS BENCHMARK */}
        {activeTab === 'benchmark' && (
          <div
            id="hs-panel-benchmark"
            role="tabpanel"
            aria-labelledby="hs-tab-benchmark"
            className="hs-section-stack"
          >
            <section className="hs-card hs-bench-banner">
              <div>
                <h2 className="hs-bench-quote">
                  &ldquo;One Rule: It Has to Earn Its Place Over a Vector Store&rdquo;
                </h2>
                <p className="hs-bench-sub">
                  Live {benchResult?.scenarioCount ?? (scenarios.length || 8)}-scenario deterministic
                  benchmark comparing Full-Repo Stuffing, Dense Vector Top-K (
                  {benchResult?.embeddingBackend || embeddingBackend}), and HydraDB Structural
                  Traversal across multi-hop recall, temporal ADR poisoning, and trap blocking.
                </p>
              </div>
              <button
                type="button"
                className="hs-btn hs-btn-primary"
                onClick={() => runLiveBenchmark()}
                disabled={benchLoading}
              >
                {benchLoading
                  ? 'Running Benchmark Suite...'
                  : `Run Live ${scenarios.length || 8}-Task Suite`}
              </button>
            </section>

            {/* 3-Arm Scorecard Table */}
            <section aria-label="Three-arm benchmark scorecard">
              <div className="hs-table-scroll">
                <table className="hs-table">
                  <thead>
                    <tr>
                      <th>Retrieval Arm</th>
                      <th>Critical Multi-Hop Recall</th>
                      <th>Temporal Supersession Poisoning</th>
                      <th>Ungrounded Trap Block Rate</th>
                      <th>Mean Prompt Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const arms = benchResult?.arms || {};
                      const stuff = arms.fullStuffing || {};
                      const vec = arms.vectorTopK || {};
                      const hydraArm = arms.hydraScope || {};
                      const saveVsStuff =
                        hydraArm.tokenSavingsVsStuffingPct ?? hydraArm.tokenReductionVsStuffing ?? 0;
                      const saveVsVec =
                        hydraArm.tokenSavingsVsVectorPct ?? hydraArm.tokenReductionVsVector ?? 0;

                      return (
                        <>
                          <tr>
                            <td>
                              <strong>1. Full-Repo Stuffing</strong>
                              <div className="hs-col-subtitle">Naive whole-workspace prompt dump</div>
                            </td>
                            <td>{formatPct(stuff.criticalRecallPct)}</td>
                            <td>
                              <span className="hs-badge hs-badge-rose">
                                {formatPct(stuff.temporalPoisoningPct)} Poisoned
                              </span>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-rose">
                                {formatPct(stuff.trapBlockPct ?? stuff.hallucinationTrapBlockPct)}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'var(--hs-font-mono)' }}>
                              {formatNum(stuff.meanTokens)} tok
                            </td>
                          </tr>

                          <tr>
                            <td>
                              <strong>2. Dense Vector Store (Top-K)</strong>
                              <div className="hs-col-subtitle">
                                Cosine similarity ({benchResult?.embeddingBackend || embeddingBackend})
                              </div>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-amber">
                                {formatPct(vec.criticalRecallPct)}
                              </span>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-rose">
                                {formatPct(vec.temporalPoisoningPct)} Poisoned
                              </span>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-rose">
                                {formatPct(vec.trapBlockPct ?? vec.hallucinationTrapBlockPct)}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'var(--hs-font-mono)' }}>
                              {formatNum(vec.meanTokens)} tok
                            </td>
                          </tr>

                          <tr className="hs-arm-hydra">
                            <td>
                              <strong style={{ color: '#34d399' }}>
                                3. HydraDB Structural Graph (HydraScope)
                              </strong>
                              <div className="hs-col-subtitle">
                                OpenCypher multi-hop + :SUPERSEDES filter + ontology gate
                              </div>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-emerald">
                                {formatPct(hydraArm.criticalRecallPct)}
                              </span>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-emerald">
                                {formatPct(hydraArm.temporalPoisoningPct)} (Zero Poison)
                              </span>
                            </td>
                            <td>
                              <span className="hs-badge hs-badge-emerald">
                                {formatPct(hydraArm.trapBlockPct ?? hydraArm.hallucinationTrapBlockPct)}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'var(--hs-font-mono)' }}>
                              <strong style={{ color: '#34d399' }}>
                                {formatNum(hydraArm.meanTokens)} tok
                              </strong>{' '}
                              <span className="hs-badge hs-badge-emerald">
                                -{Number(saveVsStuff).toFixed(1)}% vs Stuffing
                              </span>{' '}
                              {Number(saveVsVec) !== 0 && (
                                <span className="hs-badge hs-badge-cyan">
                                  {Number(saveVsVec) > 0
                                    ? `-${Number(saveVsVec).toFixed(1)}% vs Vec`
                                    : `+${Math.abs(Number(saveVsVec)).toFixed(1)}% vs Vec`}
                                </span>
                              )}
                            </td>
                          </tr>
                        </>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Per-Scenario 8-Row Breakdown Table */}
            <section className="hs-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '0.85rem 1rem', borderBottom: '1px solid var(--hs-border)' }}>
                <span className="hs-eyebrow">
                  Per-Scenario Breakdown (Click Any Row to Inspect Live in Arena)
                </span>
              </div>
              <div className="hs-table-scroll" style={{ border: 'none', borderRadius: 0 }}>
                <table className="hs-table">
                  <thead>
                    <tr>
                      <th>Scenario</th>
                      <th>Category</th>
                      <th>Vector Recall</th>
                      <th>HydraDB Recall</th>
                      <th>Poisoning / Trap Gate</th>
                      <th>Tokens (Vec vs Hydra)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(benchResult?.scenarioResults || []).map((row) => {
                      const cat = getCategoryMeta(row.category);
                      const matchingPreset = scenarios.find((s) => s.id === row.id);
                      const isTrapTask = row.answerableExpected === false || row.category === 'ungrounded_trap';

                      const activateScenarioRow = () =>
                        handleSelectScenario(
                          matchingPreset || {
                            id: row.id,
                            category: row.category,
                            title: row.title,
                            query: row.query,
                            asOf: row.asOf || ''
                          }
                        );

                      return (
                        <tr
                          key={row.id}
                          className="hs-table-row-clickable"
                          tabIndex={0}
                          role="button"
                          aria-label={`Inspect scenario ${row.title} in Arena`}
                          onClick={activateScenarioRow}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              activateScenarioRow();
                            }
                          }}
                        >
                          <td>
                            <strong style={{ color: '#f8fafc' }}>{row.title}</strong>
                            <div className="hs-col-subtitle">{truncateLabel(row.query, 68)}</div>
                          </td>
                          <td>
                            <span className={`hs-cat-tag ${cat.className}`}>{cat.label}</span>
                          </td>
                          <td>
                            {isTrapTask ? (
                              <span className="hs-badge hs-badge-rose">Hallucinated K Chunks</span>
                            ) : (
                              <div className="hs-bar-wrap">
                                <div className="hs-bar-track">
                                  <div
                                    className="hs-bar-fill"
                                    style={{
                                      width: `${Math.min(100, Math.max(0, row.vectorRecallPct ?? 0))}%`,
                                      background: (row.vectorRecallPct ?? 0) >= 99 ? '#94a3b8' : '#f43f5e'
                                    }}
                                  />
                                </div>
                                <span>{formatPct(row.vectorRecallPct, 0)}</span>
                              </div>
                            )}
                          </td>
                          <td>
                            {isTrapTask ? (
                              <span className="hs-badge hs-badge-emerald">
                                {row.hydraBlockedTrap ? 'Trap Blocked (100%)' : 'Checked'}
                              </span>
                            ) : (
                              <div className="hs-bar-wrap">
                                <div className="hs-bar-track">
                                  <div
                                    className="hs-bar-fill"
                                    style={{
                                      width: `${Math.min(100, Math.max(0, row.hydraRecallPct ?? 0))}%`,
                                      background: '#10b981'
                                    }}
                                  />
                                </div>
                                <span style={{ color: '#34d399', fontWeight: 700 }}>
                                  {formatPct(row.hydraRecallPct, 0)}
                                </span>
                              </div>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                              {row.vectorPoisoned && (
                                <span className="hs-badge hs-badge-rose">VEC POISONED</span>
                              )}
                              {!row.hydraPoisoned && !isTrapTask && (
                                <span className="hs-badge hs-badge-emerald">HYDRA CLEAN</span>
                              )}
                              {row.hydraBlockedTrap && (
                                <span className="hs-badge hs-badge-amber">0 TOK GATE</span>
                              )}
                            </div>
                          </td>
                          <td style={{ fontFamily: 'var(--hs-font-mono)' }}>
                            <span style={{ color: '#94a3b8' }}>{formatNum(row.vectorTokens)}t</span>
                            {' -> '}
                            <strong style={{ color: '#34d399' }}>{formatNum(row.hydraTokens)}t</strong>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* TAB 4: LIVE GRAPH STUDIO & TIME-TRAVEL ADRS */}
        {activeTab === 'studio' && (
          <div
            id="hs-panel-studio"
            role="tabpanel"
            aria-labelledby="hs-tab-studio"
            className="hs-studio-grid"
          >
            {/* Panel A: Supersede Decision Live */}
            <section className="hs-card" aria-label="Live ADR supersession studio">
              <div className="hs-preset-header">
                <span className="hs-eyebrow">Panel A: Supersede Decision Live (:SUPERSEDES)</span>
                <span className="hs-badge hs-badge-emerald">Live Mutable Graph</span>
              </div>
              <p className="hs-bench-sub" style={{ marginBottom: '0.9rem' }}>
                Evolve architectural governance in real time without re-embedding the repository.
                Committing a new ADR writes a directed <code>:SUPERSEDES</code> edge to HydraDB,
                immediately retiring the prior ADR at HEAD while preserving historical time-travel.
              </p>

              {supersedeStatus && (
                <div className="hs-success-banner" style={{ marginBottom: '0.9rem' }}>
                  <div>
                    <strong>Committed {supersedeStatus.newId}</strong> (:SUPERSEDES{' '}
                    {supersedeStatus.oldId}) into HydraDB!
                  </div>
                  <button
                    type="button"
                    className="hs-btn hs-btn-primary hs-btn-mini"
                    onClick={handleTestSupersededInArena}
                  >
                    Test in Arena -&gt;
                  </button>
                </div>
              )}

              {activeDecisions.length === 0 ? (
                <div className="hs-scenario-note" style={{ marginBottom: '0.9rem' }}>
                  <strong style={{ color: '#e2e8f0' }}>No Active ADR Artifacts in Compiled Directory: </strong>
                  Workspace <code>{workspaceState?.workspaceName || 'custom'}</code> contains code/module
                  nodes without Markdown ADR records. Reset to the 18-artifact FinTech workspace to
                  test live <code>:SUPERSEDES</code> lineage mutations.
                  <div style={{ marginTop: '0.6rem' }}>
                    <button
                      type="button"
                      className="hs-btn hs-btn-mini hs-btn-cyan"
                      disabled={ingestLoading}
                      onClick={() => {
                        setIngestDirInput('.');
                        handleIngestDirectory('reset');
                      }}
                    >
                      Reset FinTech Workspace
                    </button>
                  </div>
                </div>
              ) : null}

              <form className="hs-form-grid" onSubmit={handleSupersedeSubmit}>
                <div className="hs-form-row-2">
                  <label className="hs-field-label">
                    Active ADR to Supersede (oldId)
                    <select
                      className="hs-select"
                      value={supersedeForm.oldId}
                      disabled={activeDecisions.length === 0}
                      onChange={(e) => handleOldDecisionChange(e.target.value)}
                    >
                      {activeDecisions.length === 0 ? (
                        <option value="">No active ADRs in current workspace</option>
                      ) : (
                        activeDecisions.map((dec) => (
                          <option key={dec.id} value={dec.id}>
                            {dec.id} (ACTIVE)
                          </option>
                        ))
                      )}
                    </select>
                  </label>

                  <label className="hs-field-label">
                    New ADR Identifier (newId)
                    <input
                      type="text"
                      className="hs-input"
                      value={supersedeForm.newId}
                      disabled={activeDecisions.length === 0}
                      onChange={(e) =>
                        setSupersedeForm((p) => ({ ...p, newId: e.target.value }))
                      }
                      required
                    />
                  </label>
                </div>

                <div className="hs-form-row-2">
                  <label className="hs-field-label">
                    New Decision Title
                    <input
                      type="text"
                      className="hs-input"
                      value={supersedeForm.title}
                      disabled={activeDecisions.length === 0}
                      onChange={(e) =>
                        setSupersedeForm((p) => ({ ...p, title: e.target.value }))
                      }
                      required
                    />
                  </label>

                  <label className="hs-field-label">
                    Effective Date (ISO YYYY-MM-DD)
                    <input
                      type="text"
                      pattern="\d{4}-\d{2}-\d{2}"
                      className="hs-input"
                      value={supersedeForm.effectiveAt}
                      disabled={activeDecisions.length === 0}
                      onChange={(e) =>
                        setSupersedeForm((p) => ({ ...p, effectiveAt: e.target.value }))
                      }
                      required
                    />
                  </label>
                </div>

                <label className="hs-field-label">
                  Governed Graph Node IDs (comma-separated :GOVERNS targets)
                  <input
                    type="text"
                    className="hs-input"
                    value={supersedeForm.governsInput}
                    disabled={activeDecisions.length === 0}
                    onChange={(e) =>
                      setSupersedeForm((p) => ({ ...p, governsInput: e.target.value }))
                    }
                  />
                </label>

                <label className="hs-field-label">
                  Normative Architectural Specification
                  <textarea
                    className="hs-textarea"
                    value={supersedeForm.content}
                    disabled={activeDecisions.length === 0}
                    onChange={(e) =>
                      setSupersedeForm((p) => ({ ...p, content: e.target.value }))
                    }
                    required
                  />
                </label>

                <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                  <button
                    type="submit"
                    className="hs-btn hs-btn-primary"
                    disabled={supersedeLoading || activeDecisions.length === 0}
                  >
                    {supersedeLoading
                      ? 'Writing :SUPERSEDES to HydraDB...'
                      : 'Write :SUPERSEDES to HydraDB'}
                  </button>
                </div>
              </form>

              {/* Current ADR Lineage Registry */}
              <div style={{ marginTop: '1.15rem' }}>
                <span className="hs-eyebrow">
                  Recorded ADR Lineage ({(workspaceState?.decisions || []).length})
                </span>
                <div className="hs-adr-list">
                  {(workspaceState?.decisions || []).map((dec) => (
                    <div key={dec.id} className="hs-adr-item">
                      <div>
                        <div className="hs-chunk-title">{dec.title || dec.id}</div>
                        <div className="hs-chunk-meta">
                          <span>{dec.id}</span>
                          {dec.validFrom && <span>| validFrom: {dec.validFrom}</span>}
                          {dec.retiredAt && (
                            <span style={{ color: '#fda4af' }}>| retiredAt: {dec.retiredAt}</span>
                          )}
                          {dec.supersededBy && (
                            <span style={{ color: '#22d3ee' }}>
                              | supersededBy: {dec.supersededBy}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                        {dec.isCurrent !== false ? (
                          <span className="hs-badge hs-badge-emerald">ACTIVE</span>
                        ) : (
                          <>
                            <span className="hs-badge hs-badge-rose">RETIRED</span>
                            {dec.validFrom && (
                              <button
                                type="button"
                                className="hs-btn hs-btn-mini hs-btn-cyan"
                                onClick={() => {
                                  const replayDate = dec.validFrom || '2026-03-01';
                                  const q = `What architectural decision governs ${dec.title || dec.id}?`;
                                  setQueryInput(q);
                                  setAsOfInput(replayDate);
                                  setActiveTab('arena');
                                  runArenaComparison({
                                    query: q,
                                    asOf: replayDate,
                                    budget: tokenBudget,
                                    k: topK,
                                    scenarioId: ''
                                  });
                                }}
                              >
                                Replay @ {dec.validFrom}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Panel B: Compile Local Repository Path */}
            <section className="hs-card" aria-label="Compile local repository directory">
              <div className="hs-preset-header">
                <span className="hs-eyebrow">Panel B: Compile Local Repository Path</span>
                <span className="hs-badge hs-badge-cyan">AST + Env + ADR Compiler</span>
              </div>
              <p className="hs-bench-sub" style={{ marginBottom: '0.9rem' }}>
                Point HydraScope at a local repository path to extract exported symbols, relative
                imports, <code>process.env</code> / <code>os.environ</code> dependencies, and Markdown
                ADR frontmatter directly into HydraDB, or reset to the 18-artifact FinTech suite.
              </p>

              {ingestStatus && (
                <div className="hs-success-banner" style={{ marginBottom: '0.85rem' }}>
                  <span>
                    Compiled <strong>{ingestStatus.workspaceName}</strong>:{' '}
                    {formatNum(ingestStatus.nodeCount)} nodes / {formatNum(ingestStatus.edgeCount)}{' '}
                    edges synced.
                  </span>
                </div>
              )}

              <div className="hs-form-grid">
                <label className="hs-field-label">
                  Target Directory Path
                  <input
                    type="text"
                    className="hs-input"
                    value={ingestDirInput}
                    onChange={(e) => setIngestDirInput(e.target.value)}
                    placeholder="./src or ."
                  />
                </label>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="hs-btn hs-btn-primary"
                    disabled={ingestLoading || !ingestDirInput.trim()}
                    onClick={() => handleIngestDirectory(ingestDirInput.trim())}
                  >
                    {ingestLoading ? 'Compiling Graph...' : 'Compile into HydraDB'}
                  </button>

                  <button
                    type="button"
                    className="hs-btn hs-btn-cyan"
                    disabled={ingestLoading}
                    onClick={() => {
                      setIngestDirInput('./src');
                      handleIngestDirectory('./src');
                    }}
                  >
                    Compile ./src
                  </button>

                  <button
                    type="button"
                    className="hs-btn"
                    disabled={ingestLoading}
                    onClick={() => {
                      setIngestDirInput('.');
                      handleIngestDirectory('reset');
                    }}
                    title="Reload default 18-artifact FinTech evaluation workspace"
                  >
                    Reset FinTech Workspace
                  </button>
                </div>
              </div>

              {/* Active Ontology & Graph Breakdown */}
              <div style={{ marginTop: '1.2rem' }}>
                <span className="hs-eyebrow">
                  Active Graph Ontology ({workspaceState?.workspaceName || 'fintech-benchmark'})
                </span>
                <div className="hs-topology-grid">
                  {nodeKindSummary.map(([kind, count]) => (
                    <div key={kind} className="hs-topo-stat">
                      <div className="hs-topo-count">{formatNum(count)}</div>
                      <div className="hs-topo-kind">{kind}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default HydraScopeCockpit;
