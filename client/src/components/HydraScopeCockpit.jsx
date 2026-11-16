import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { fetchApiJson } from '@krusch/toolkit/react';
import CompareTab from './CompareTab.jsx';
import { BenchmarksTab, StudioTab } from './BenchmarksAndStudioTabs.jsx';
import '../styles.css';

const ISO_DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TAB_ORDER = ['compare', 'benchmarks', 'studio'];

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

function formatNum(value, fallback = '0') {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString() : fallback;
}

function formatPct(value, digits = 1) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(digits)}%` : '0%';
}

export function HydraScopeCockpit() {
  const [activeTab, setActiveTab] = useState('compare');
  const [workspaceState, setWorkspaceState] = useState(null);
  const [globalError, setGlobalError] = useState('');

  // Compare tab state
  const [selectedScenarioId, setSelectedScenarioId] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [asOfInput, setAsOfInput] = useState('');
  const [tokenBudget, setTokenBudget] = useState(900);
  const [topK, setTopK] = useState(5);
  const [arenaResult, setArenaResult] = useState(null);
  const [arenaLoading, setArenaLoading] = useState(false);

  // Benchmarks tab state
  const [benchResult, setBenchResult] = useState(null);
  const [benchLoading, setBenchLoading] = useState(false);
  const [continualResult, setContinualResult] = useState(null);
  const [continualLoading, setContinualLoading] = useState(false);
  const [loadTestResult, setLoadTestResult] = useState(null);
  const [loadTestLoading, setLoadTestLoading] = useState(false);
  const [loadTestError, setLoadTestError] = useState('');

  // Studio tab state
  const [supersedeForm, setSupersedeForm] = useState({
    oldId: 'adr:ADR-014',
    newId: 'adr:ADR-025',
    title: 'ADR-025: Dual Ed25519 + HMAC Webhook Verification',
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
  const benchAbortRef = useRef(null);
  const continualAbortRef = useRef(null);
  const loadTestAbortRef = useRef(null);
  const studioAbortRef = useRef(null);
  const userEditedQueryRef = useRef(false);
  const tabButtonRefs = useRef({});
  const initializedRef = useRef(false);

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
      setSupersedeForm((prev) => ({ ...prev, oldId: '' }));
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
        setGlobalError(`Invalid date "${cleanAsOf}". Use YYYY-MM-DD format.`);
        return;
      }

      arenaAbortRef.current?.abort();
      const controller = new AbortController();
      arenaAbortRef.current = controller;

      const onExternalAbort = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) return;
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }

      setArenaLoading(true);
      setGlobalError('');
      if (scenarioId !== undefined) setSelectedScenarioId(scenarioId);

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
          setArenaResult(unwrapPayload(raw));
          setArenaLoading(false);
        }
      } catch (err) {
        if (controller.signal.aborted || err?.name === 'AbortError') return;
        setGlobalError(err?.message || 'Comparison request failed.');
        setArenaLoading(false);
      } finally {
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
    []
  );

  const runLiveBenchmark = useCallback(async (externalSignal) => {
    benchAbortRef.current?.abort();
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
      setGlobalError(err?.message || 'Benchmark run failed.');
      setBenchLoading(false);
    } finally {
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }, []);

  const runContinualLoop = useCallback(async (externalSignal) => {
    continualAbortRef.current?.abort();
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
      setGlobalError(err?.message || 'Continual evaluation failed.');
      setContinualLoading(false);
      return null;
    } finally {
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }, []);

  const runConcurrentLoadTest = useCallback(
    async ({ totalRequests = 64, concurrency = 8 } = {}) => {
      loadTestAbortRef.current?.abort();
      const controller = new AbortController();
      loadTestAbortRef.current = controller;

      setLoadTestLoading(true);
      setLoadTestError('');
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
        setLoadTestError(err?.message || 'Throughput test failed.');
        setLoadTestLoading(false);
        return null;
      }
    },
    []
  );

  const reloadWorkspaceState = useCallback(async (signal) => {
    const raw = await fetchApiJson('/api/state', { signal, timeoutMs: 20000 });
    const data = unwrapPayload(raw);
    if (!signal?.aborted) {
      setWorkspaceState(data);
    }
    return data;
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function bootstrap() {
      try {
        const data = await reloadWorkspaceState(controller.signal);
        if (controller.signal.aborted || !data) return;

        syncDefaultSupersedeTarget(data);

        if (!initializedRef.current) {
          initializedRef.current = true;
          const firstScenario =
            Array.isArray(data.scenarios) && data.scenarios.length > 0 ? data.scenarios[0] : null;
          const initQuery =
            firstScenario?.query ||
            'Update per-item partner fee rounding in calculatePartnerFee without breaking downstream accounting';
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
        setGlobalError(err?.message || 'Unable to load HydraScope workspace.');
      }
    }

    bootstrap();

    return () => {
      controller.abort();
      arenaAbortRef.current?.abort();
      benchAbortRef.current?.abort();
      continualAbortRef.current?.abort();
      loadTestAbortRef.current?.abort();
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
    setActiveTab('compare');
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

  const handleSubmitQuery = (event) => {
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
      setGlobalError(`Invalid date "${cleanEff}". Use YYYY-MM-DD format.`);
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
        governsIds
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
      setGlobalError(err?.message || 'Failed to publish rule update.');
    } finally {
      if (!controller.signal.aborted) setSupersedeLoading(false);
    }
  };

  const handleTestSupersededInCompare = () => {
    const targetGov = supersedeStatus?.governsIds?.[0] || 'stripe-handler';
    const cleanTarget = targetGov.replace(/^(file:|symbol:)/, '');
    const testQuery = `What active security ADR governs webhook signature verification in ${cleanTarget}?`;
    setQueryInput(testQuery);
    setAsOfInput('');
    setSelectedScenarioId('');
    setActiveTab('compare');
    runArenaComparison({
      query: testQuery,
      asOf: '',
      budget: tokenBudget,
      k: topK,
      scenarioId: ''
    });
  };

  const handleReplayRetiredDecision = (dec) => {
    const replayDate = dec.validFrom || '2026-03-01';
    const q = `What architectural decision governs ${dec.title || dec.id}?`;
    setQueryInput(q);
    setAsOfInput(replayDate);
    setSelectedScenarioId('');
    setActiveTab('compare');
    runArenaComparison({
      query: q,
      asOf: replayDate,
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
        workspaceName: refreshed?.workspaceName || ingestData?.workspaceName || normalizedDir || 'workspace',
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
      if (!controller.signal.aborted) setIngestLoading(false);
    }
  };

  const hydraHealthy = Boolean(workspaceState?.hydraHealth?.healthy);
  const scenarios = Array.isArray(workspaceState?.scenarios) ? workspaceState.scenarios : [];

  return (
    <div className="hs-shell">
      <header className="hs-header">
        <div className="hs-header-inner">
          <div className="hs-brand">
            <div className="hs-logo" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="5" cy="12" r="2.5" fill="#fafafa" />
                <circle cx="14" cy="6" r="2.3" fill="#a1a1aa" />
                <circle cx="14" cy="18" r="2.3" fill="#10b981" />
                <circle cx="20" cy="12" r="2.5" fill="#10b981" />
                <path
                  d="M7.3 10.8L11.8 7.2M7.3 13.2L11.8 16.8M15.8 7.5L18.2 10.4M15.8 16.5L18.2 13.6"
                  stroke="#a1a1aa"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <h1 className="hs-brand-name">HydraScope</h1>
            <span className="hs-brand-sep" aria-hidden="true">/</span>
            <span className="hs-brand-tagline">Graph context for coding agents</span>
          </div>

          <nav className="hs-tabs" role="tablist" aria-label="HydraScope views">
            {[
              { key: 'compare', label: 'Compare' },
              { key: 'benchmarks', label: 'Benchmarks' },
              { key: 'studio', label: 'Studio' }
            ].map((tab) => {
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  ref={(el) => {
                    tabButtonRefs.current[tab.key] = el;
                  }}
                  id={`hs-tab-${tab.key}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`hs-panel-${tab.key}`}
                  tabIndex={active ? 0 : -1}
                  className={`hs-tab ${active ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                  onKeyDown={(e) => handleTabKeyDown(e, tab.key)}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>

          <div className="hs-status-group" aria-label="Connection status">
            <span className="hs-status-pill">
              <span className={`hs-dot ${hydraHealthy ? 'hs-dot-live' : ''}`} />
              {hydraHealthy ? 'HydraDB Live' : 'Local Graph'}
            </span>
          </div>
        </div>
      </header>

      <main className="hs-container hs-main">
        {globalError && (
          <div className="hs-alert hs-alert-error" role="alert" style={{ marginBottom: '1.1rem' }}>
            <span>{globalError}</span>
            <button type="button" className="hs-btn hs-btn-sm" onClick={() => setGlobalError('')}>
              Dismiss
            </button>
          </div>
        )}

        {activeTab === 'compare' && (
          <CompareTab
            scenarios={scenarios}
            selectedScenarioId={selectedScenarioId}
            queryInput={queryInput}
            setQueryInput={setQueryInput}
            onUserEditQuery={() => {
              userEditedQueryRef.current = true;
            }}
            asOfInput={asOfInput}
            setAsOfInput={setAsOfInput}
            tokenBudget={tokenBudget}
            topK={topK}
            arenaResult={arenaResult}
            arenaLoading={arenaLoading}
            workspaceEdges={workspaceState?.edges || []}
            nodeLookup={nodeLookup}
            onSelectScenario={handleSelectScenario}
            onSubmitQuery={handleSubmitQuery}
            onQuickTimeTravel={handleQuickTimeTravel}
            onBudgetChange={handleBudgetChange}
            onTopKChange={handleTopKChange}
            formatNum={formatNum}
          />
        )}

        {activeTab === 'benchmarks' && (
          <BenchmarksTab
            scenarios={scenarios}
            benchResult={benchResult}
            benchLoading={benchLoading}
            onRunBenchmark={() => runLiveBenchmark()}
            onSelectScenario={handleSelectScenario}
            continualResult={continualResult}
            continualLoading={continualLoading}
            onRunContinual={() => runContinualLoop()}
            loadTestResult={loadTestResult}
            loadTestLoading={loadTestLoading}
            loadTestError={loadTestError}
            onClearLoadError={() => setLoadTestError('')}
            onRunLoadTest={runConcurrentLoadTest}
            formatNum={formatNum}
            formatPct={formatPct}
          />
        )}

        {activeTab === 'studio' && (
          <StudioTab
            workspaceState={workspaceState}
            activeDecisions={activeDecisions}
            supersedeForm={supersedeForm}
            setSupersedeForm={setSupersedeForm}
            onOldDecisionChange={handleOldDecisionChange}
            supersedeStatus={supersedeStatus}
            supersedeLoading={supersedeLoading}
            onSupersedeSubmit={handleSupersedeSubmit}
            onTestSupersededInCompare={handleTestSupersededInCompare}
            onReplayRetiredDecision={handleReplayRetiredDecision}
            ingestDirInput={ingestDirInput}
            setIngestDirInput={setIngestDirInput}
            ingestStatus={ingestStatus}
            ingestLoading={ingestLoading}
            onIngestDirectory={handleIngestDirectory}
            formatNum={formatNum}
          />
        )}
      </main>
    </div>
  );
}

export default HydraScopeCockpit;
