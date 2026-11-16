import React, { useState, useMemo } from 'react';
import { useCopyToClipboard } from '@krusch/toolkit/react';

const SHORT_PRESET_LABELS = {
  S1: 'Fee rounding impact',
  S2: 'Tenant claim impact',
  S3: 'Stripe webhook rule',
  S4: 'Session cookie rule',
  S5: 'Queue drop cause',
  S6: 'PR-412 impact trace',
  S7: 'Fake Kafka trap',
  S8: 'Fake Kubernetes trap'
};

export function cleanNodeId(rawId) {
  return String(rawId || '').replace(/^[a-z_]+:/i, '');
}

export function cleanDisplaySub(item) {
  if (!item) return '';
  if (item.path) return item.path;
  return cleanNodeId(item.id);
}

function smartTruncate(text, maxLen = 30) {
  const raw = String(text || '').trim();
  if (raw.length <= maxLen) return raw;
  const sliced = raw.slice(0, maxLen - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxLen * 0.55)) {
    return `${sliced.slice(0, lastSpace)}...`;
  }
  return `${sliced}...`;
}

function normalizeId(entry) {
  if (!entry) return '';
  return typeof entry === 'string' ? entry : String(entry.id || '');
}

function buildSubgraphLayout(hydra, stateEdges = []) {
  const traversedNodes = Array.isArray(hydra?.traversedNodes) ? hydra.traversedNodes : [];
  const retiredNodes = Array.isArray(hydra?.retiredBlockedNodes) ? hydra.retiredBlockedNodes : [];
  const rawEdges = Array.isArray(hydra?.traversedEdges) ? hydra.traversedEdges : [];
  const seedIds = new Set(
    (Array.isArray(hydra?.seedNodes) ? hydra.seedNodes : []).map(normalizeId).filter(Boolean)
  );

  const nodeMap = new Map();
  for (const node of traversedNodes) {
    if (node?.id) nodeMap.set(node.id, { ...node, isBlockedRetired: false });
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
      type: String(edge.type || 'IMPACTS').toUpperCase()
    });
  };

  for (const edge of rawEdges) pushEdge(edge);
  for (const edge of stateEdges) {
    if (edge?.type === 'SUPERSEDES' || edge?.type === 'GOVERNS') pushEdge(edge);
  }
  for (const rNode of retiredNodes) {
    if (rNode?.id && rNode?.supersededBy && nodeMap.has(rNode.supersededBy)) {
      pushEdge({ from: rNode.supersededBy, to: rNode.id, type: 'SUPERSEDES' });
    }
  }

  const adj = new Map();
  for (const id of nodeMap.keys()) adj.set(id, new Set());
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
    if (seedIds.has(node.id) || explicitHop === 0) columns[0].push(node);
    else if (explicitHop === 1) columns[1].push(node);
    else columns[2].push(node);
  }

  if (columns[0].length === 0 && columns[1].length > 0) {
    columns[0].push(columns[1].shift());
  } else if (columns[0].length === 0 && columns[2].length > 0) {
    const nonRetiredIdx = columns[2].findIndex((n) => !n.isBlockedRetired);
    if (nonRetiredIdx >= 0) columns[0].push(...columns[2].splice(nonRetiredIdx, 1));
  }

  // If column 1 is empty while column 2 has active nodes, pull active nodes into column 1 so there is no blank middle gap
  if (columns[1].length === 0 && columns[2].some((n) => !n.isBlockedRetired)) {
    const activeFromCol2 = columns[2].filter((n) => !n.isBlockedRetired);
    const retiredInCol2 = columns[2].filter((n) => n.isBlockedRetired);
    if (retiredInCol2.length > 0) {
      columns[1].push(...activeFromCol2);
      columns[2] = retiredInCol2;
    }
  }

  const colX = [24, 298, 572];
  const boxW = 224;
  const maxPerCol = 4;
  const positionedMap = new Map();
  const overflowCounts = [0, 0, 0];

  columns.forEach((colNodes, colIdx) => {
    const visible = colNodes.slice(0, maxPerCol);
    overflowCounts[colIdx] = Math.max(0, colNodes.length - visible.length);
    const count = visible.length;
    if (count === 0) return;

    const canvasTop = 38;
    const canvasBottom = overflowCounts[colIdx] > 0 ? 210 : 222;
    const availH = canvasBottom - canvasTop;
    const cardH = count <= 3 ? 42 : 36;
    const totalCardsH = count * cardH;
    const gap = count > 1 ? Math.max(6, Math.min(14, (availH - totalCardsH) / (count - 1))) : 0;
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

  const positionedEdges = [...dedupedPairMap.values()].map((edge) => {
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

    const dx = Math.max(34, Math.abs(x2 - x1) * 0.45);
    const sameColOffset = src.colIdx === 2 ? -24 : 24;
    const pathD =
      src.colIdx === dst.colIdx
        ? `M ${x1} ${y1} C ${x1 + sameColOffset} ${y1}, ${x2 + sameColOffset} ${y2}, ${x2} ${y2}`
        : src.colIdx < dst.colIdx
          ? `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;

    return { ...edge, pathD };
  });

  return {
    positionedNodes: [...positionedMap.values()],
    positionedEdges,
    overflowCounts
  };
}

export default function CompareTab({
  scenarios,
  selectedScenarioId,
  queryInput,
  setQueryInput,
  onUserEditQuery,
  asOfInput,
  setAsOfInput,
  tokenBudget,
  topK,
  arenaResult,
  arenaLoading,
  workspaceEdges,
  nodeLookup,
  onSelectScenario,
  onSubmitQuery,
  onQuickTimeTravel,
  onBudgetChange,
  onTopKChange,
  formatNum
}) {
  const [showOptions, setShowOptions] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState('');

  const cypherCopy = useCopyToClipboard({ timeout: 1800 });
  const promptCopy = useCopyToClipboard({ timeout: 1800 });

  const { primaryPresets, extraPresets } = useMemo(() => {
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      return { primaryPresets: [], extraPresets: [] };
    }
    // Pick 1 representative per failure category so only 4 calm chips show by default
    const seenCats = new Set();
    const primary = [];
    const extra = [];
    for (const s of scenarios) {
      const cat = String(s.category || 'default');
      if (!seenCats.has(cat) && primary.length < 4) {
        seenCats.add(cat);
        primary.push(s);
      } else {
        extra.push(s);
      }
    }
    while (primary.length < 4 && extra.length > 0) {
      primary.push(extra.shift());
    }
    return { primaryPresets: primary, extraPresets: extra };
  }, [scenarios]);

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === selectedScenarioId) || null,
    [scenarios, selectedScenarioId]
  );

  const vectorData = arenaResult?.vector || {};
  const hydraData = arenaResult?.hydra || {};
  const answerability = hydraData?.answerability || {
    answerable: true,
    groundedTerms: [],
    missingTerms: []
  };
  const isAnswerable = answerability.answerable !== false;
  const effectiveAsOf = arenaResult?.asOf || '';

  const tokenDelta = arenaResult?.tokenDelta || {};
  const fullTokens = tokenDelta.fullRepoTokens ?? 0;
  const vectorTokens = tokenDelta.vectorTokens ?? vectorData.tokenCount ?? 0;
  const hydraTokens = tokenDelta.hydraTokens ?? hydraData.tokenCount ?? 0;
  const savingsVsRepoPct =
    tokenDelta.savingsVsRepoPct ??
    (fullTokens > 0 ? Math.round(((fullTokens - hydraTokens) / fullTokens) * 1000) / 10 : 0);

  const displayedVectorChunks = useMemo(() => {
    const raw = Array.isArray(vectorData.rankedChunks) ? vectorData.rankedChunks : [];
    return raw.filter((c) => c.selected !== false);
  }, [vectorData.rankedChunks]);

  const vectorPoisonedList = useMemo(() => {
    if (Array.isArray(arenaResult?.vectorPoisonedNodes)) {
      return arenaResult.vectorPoisonedNodes.map((item) => {
        const id = normalizeId(item);
        return typeof item === 'object' ? item : nodeLookup.get(id) || { id, title: cleanNodeId(id) };
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
      return traversedMap.get(id) || nodeLookup.get(id) || { id, title: cleanNodeId(id) };
    });
  }, [arenaResult, hydraData, nodeLookup]);

  const isHistoricallyValidNode = (node) => {
    if (!effectiveAsOf || !node) return false;
    const refNode = nodeLookup.get(node.id);
    return Boolean(
      node.retiredAt || node.isCurrent === false || refNode?.retiredAt || refNode?.isCurrent === false
    );
  };

  const subgraphLayout = useMemo(
    () => buildSubgraphLayout(hydraData, workspaceEdges),
    [hydraData, workspaceEdges]
  );

  const inspectedNode = useMemo(() => {
    if (!selectedNodeId) return subgraphLayout.positionedNodes[0] || null;
    return (
      subgraphLayout.positionedNodes.find((n) => n.id === selectedNodeId) ||
      subgraphLayout.positionedNodes[0] ||
      null
    );
  }, [selectedNodeId, subgraphLayout.positionedNodes]);

  const seedIdSet = useMemo(
    () => new Set((hydraData?.seedNodes || []).map(normalizeId)),
    [hydraData?.seedNodes]
  );

  return (
    <div id="hs-panel-compare" role="tabpanel" aria-labelledby="hs-tab-compare" className="hs-stack">
      {/* 1. Prompt-First Search Card */}
      <section className="hs-prompt-card" aria-label="Search codebase context">
        <div className="hs-prompt-intro">
          <div>
            <h2 className="hs-prompt-heading">Compare Vector Search vs. HydraDB Graph</h2>
            <p className="hs-prompt-sub">
              Ask an engineering question to see what text similarity retrieves vs. what the codebase graph finds.
            </p>
          </div>
          <button
            type="button"
            className="hs-btn hs-btn-ghost"
            aria-expanded={showOptions}
            onClick={() => setShowOptions((v) => !v)}
          >
            {showOptions ? 'Hide options' : 'Options & time-travel'}
          </button>
        </div>

        <form className="hs-search-form" onSubmit={onSubmitQuery}>
          <input
            id="hs-query-input"
            type="text"
            className="hs-input"
            value={queryInput}
            onChange={(e) => {
              onUserEditQuery();
              setQueryInput(e.target.value);
            }}
            placeholder="Ask about a function change, security rule, or incident..."
            aria-label="Engineering question"
          />
          <button
            type="submit"
            className="hs-btn hs-btn-primary"
            disabled={arenaLoading || !queryInput.trim()}
          >
            {arenaLoading ? 'Comparing...' : 'Compare'}
          </button>
        </form>

        {/* 4 Short Example Chips + Optional More Dropdown */}
        <div className="hs-examples-bar">
          <div className="hs-chips">
            <span className="hs-chips-label">Try an example:</span>
            {primaryPresets.map((preset) => {
              const isSelected = preset.id === selectedScenarioId;
              const shortLabel = SHORT_PRESET_LABELS[preset.id] || smartTruncate(preset.title, 26);
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={isSelected}
                  className={`hs-chip ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => onSelectScenario(preset)}
                >
                  {shortLabel}
                </button>
              );
            })}

            {extraPresets.length > 0 && (
              <select
                aria-label="More example questions"
                className="hs-select hs-more-select"
                value={extraPresets.some((p) => p.id === selectedScenarioId) ? selectedScenarioId : ''}
                onChange={(e) => {
                  const found = extraPresets.find((p) => p.id === e.target.value);
                  if (found) onSelectScenario(found);
                }}
              >
                <option value="">More examples...</option>
                {extraPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {SHORT_PRESET_LABELS[preset.id] || preset.title}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Active Time-Travel Indicator when Options drawer is closed */}
        {effectiveAsOf && !showOptions && (
          <div className="hs-active-filter-bar">
            <span>
              Viewing historical snapshot as of <strong>{effectiveAsOf}</strong> (rules retired after this date remain active).
            </span>
            <button
              type="button"
              className="hs-btn hs-btn-sm"
              onClick={() => onQuickTimeTravel('')}
            >
              Reset to Today
            </button>
          </div>
        )}

        {/* Collapsible Time-Travel & Token Budget Options */}
        {showOptions && (
          <div className="hs-options-drawer">
            <div className="hs-option-group">
              <span>View rules as of:</span>
              <button
                type="button"
                className={`hs-chip ${!asOfInput ? 'is-selected' : ''}`}
                onClick={() => onQuickTimeTravel('')}
              >
                Today (HEAD)
              </button>
              <button
                type="button"
                className={`hs-chip ${asOfInput === '2026-03-01' ? 'is-selected' : ''}`}
                onClick={() => onQuickTimeTravel('2026-03-01')}
              >
                2026-03-01
              </button>
              <input
                id="hs-asof-input"
                type="text"
                pattern="\d{4}-\d{2}-\d{2}"
                className="hs-input hs-inline-date"
                value={asOfInput}
                onChange={(e) => setAsOfInput(e.target.value)}
                placeholder="YYYY-MM-DD"
                aria-label="Custom ISO date YYYY-MM-DD"
              />
            </div>

            <div className="hs-option-group">
              <label htmlFor="hs-budget-select" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                Budget
                <select
                  id="hs-budget-select"
                  className="hs-select hs-inline-select"
                  value={tokenBudget}
                  onChange={(e) => onBudgetChange(Number(e.target.value))}
                >
                  <option value={600}>600 tokens</option>
                  <option value={900}>900 tokens</option>
                  <option value={1400}>1,400 tokens</option>
                </select>
              </label>

              <label htmlFor="hs-topk-select" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                Vector Top-K
                <select
                  id="hs-topk-select"
                  className="hs-select hs-inline-select"
                  value={topK}
                  onChange={(e) => onTopKChange(Number(e.target.value))}
                >
                  <option value={3}>Top 3</option>
                  <option value={5}>Top 5</option>
                  <option value={8}>Top 8</option>
                </select>
              </label>
            </div>
          </div>
        )}

        {activeScenario?.explanation && (
          <div className="hs-why-note">
            <strong style={{ color: '#fafafa' }}>What this tests: </strong>
            {activeScenario.explanation}
          </div>
        )}
      </section>

      {/* 2. Simple 3-Stat Verdict Bar */}
      <section className="hs-verdict-grid" aria-label="Comparison summary">
        <div className="hs-stat-card hs-stat-card-win">
          <div className="hs-stat-label">Context Size (HydraDB)</div>
          <div className="hs-stat-value hs-stat-value-win">{formatNum(hydraTokens)} tokens</div>
          <div className="hs-stat-sub">
            {!isAnswerable
              ? `Saved ${formatNum(vectorTokens)} wasted vector tokens`
              : `${savingsVsRepoPct}% smaller than full repo (${formatNum(fullTokens)} tok)`}
          </div>
        </div>

        <div className={`hs-stat-card ${!isAnswerable || structuralOnlyList.length > 0 ? 'hs-stat-card-win' : ''}`}>
          <div className="hs-stat-label">Dependency Coverage</div>
          {!isAnswerable ? (
            <>
              <div className="hs-stat-value hs-stat-value-win">Fake topic blocked</div>
              <div className="hs-stat-sub">
                Stopped pre-flight ({(answerability.missingTerms || []).join(', ') || 'not in repo'})
              </div>
            </>
          ) : structuralOnlyList.length > 0 ? (
            <>
              <div className="hs-stat-value hs-stat-value-win">
                +{structuralOnlyList.length} missed by vector
              </div>
              <div className="hs-stat-sub">Found via multi-hop code and rule links</div>
            </>
          ) : (
            <>
              <div className="hs-stat-value">
                {(hydraData?.traversedNodes || []).length} connected items
              </div>
              <div className="hs-stat-sub">All required dependencies retrieved</div>
            </>
          )}
        </div>

        <div
          className={`hs-stat-card ${
            vectorPoisonedList.length > 0 ? 'hs-stat-card-fail' : 'hs-stat-card-win'
          }`}
        >
          <div className="hs-stat-label">Outdated Rules</div>
          {vectorPoisonedList.length > 0 ? (
            <>
              <div className="hs-stat-value hs-stat-value-fail">
                Vector pulled {vectorPoisonedList.length} retired
              </div>
              <div className="hs-stat-sub">HydraDB blocked outdated ADR automatically</div>
            </>
          ) : effectiveAsOf ? (
            <>
              <div className="hs-stat-value">Snapshot {effectiveAsOf}</div>
              <div className="hs-stat-sub">Showing rules active on that date</div>
            </>
          ) : (
            <>
              <div className="hs-stat-value hs-stat-value-win">0 retired rules</div>
              <div className="hs-stat-sub">Only current architecture rules included</div>
            </>
          )}
        </div>
      </section>

      {/* 3. Side-by-Side Results: Vector Search vs. HydraDB Graph */}
      <section className="hs-compare-grid" aria-label="Side-by-side retrieval results">
        {/* Left Pane: Vector Search */}
        <div className="hs-pane">
          <div className="hs-pane-head">
            <div>
              <h3 className="hs-pane-title">Vector Search</h3>
              <p className="hs-pane-meta">
                Top-{displayedVectorChunks.length || topK} text similarity · {formatNum(vectorTokens)} tokens
              </p>
            </div>
            {vectorPoisonedList.length > 0 ? (
              <span className="hs-tag hs-tag-fail">Outdated rule injected</span>
            ) : !isAnswerable ? (
              <span className="hs-tag hs-tag-fail">False matches</span>
            ) : structuralOnlyList.length > 0 ? (
              <span className="hs-tag hs-tag-fail">Incomplete</span>
            ) : (
              <span className="hs-tag">Baseline</span>
            )}
          </div>

          {!isAnswerable && (
            <div className="hs-callout hs-callout-fail">
              <span className="hs-callout-strong">Hallucination risk</span>
              Even though {(answerability.missingTerms || []).join(', ')} does not exist in this codebase,
              vector search still returned {displayedVectorChunks.length} nearby files ({formatNum(vectorTokens)} tokens).
            </div>
          )}

          {isAnswerable && structuralOnlyList.length > 0 && (
            <div className="hs-callout hs-callout-fail">
              <span className="hs-callout-strong">
                Missed {structuralOnlyList.length} downstream {structuralOnlyList.length === 1 ? 'dependency' : 'dependencies'}
              </span>
              {structuralOnlyList.map((m) => m.title || cleanNodeId(m.id)).join(' · ')}
            </div>
          )}

          <div className="hs-item-list">
            {displayedVectorChunks.length === 0 ? (
              <div className="hs-item">
                <div className="hs-item-body">
                  <div className="hs-item-title">No vector matches returned</div>
                </div>
              </div>
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
                    className={`hs-item ${isPoisoned ? 'hs-item-fail' : ''}`}
                  >
                    <div className="hs-item-body">
                      <div className="hs-item-title">{chunk.title || cleanNodeId(chunk.id)}</div>
                      <div className="hs-item-path">{cleanDisplaySub(chunk)}</div>
                    </div>
                    {isPoisoned ? (
                      <span className="hs-tag hs-tag-fail">Retired rule</span>
                    ) : (
                      <span className="hs-tag">#{idx + 1}</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Pane: HydraDB Graph */}
        <div className="hs-pane hs-pane-hydra">
          <div className="hs-pane-head">
            <div>
              <h3 className="hs-pane-title">HydraDB Graph</h3>
              <p className="hs-pane-meta">
                Dependency &amp; rule traversal · {formatNum(hydraTokens)} tokens
              </p>
            </div>
            {!isAnswerable ? (
              <span className="hs-tag hs-tag-win">0 tokens burned</span>
            ) : effectiveAsOf ? (
              <span className="hs-tag">As of {effectiveAsOf}</span>
            ) : (
              <span className="hs-tag hs-tag-win">Verified clean</span>
            )}
          </div>

          {!isAnswerable && (
            <div className="hs-callout hs-callout-win">
              <span className="hs-callout-strong">Blocked before calling the LLM</span>
              {answerability.reason ||
                `Checked the codebase graph first: "${(answerability.missingTerms || []).join(', ')}" does not exist here, so 0 tokens were sent.`}
            </div>
          )}

          {isAnswerable && (hydraData?.retiredBlockedNodes || []).length > 0 && (
            <div className="hs-callout hs-callout-win">
              <span className="hs-callout-strong">Filtered outdated architecture rule</span>
              {(hydraData.retiredBlockedNodes || [])
                .map(
                  (b) =>
                    `Skipped ${cleanNodeId(b.id)}${b.supersededBy ? ` (replaced by ${cleanNodeId(b.supersededBy)})` : ''}`
                )
                .join(' · ')}
            </div>
          )}

          {isAnswerable && (
            <div className="hs-item-list">
              {(hydraData?.traversedNodes || []).length === 0 ? (
                <div className="hs-item">
                  <div className="hs-item-body">
                    <div className="hs-item-title">No connected items matched</div>
                  </div>
                </div>
              ) : (
                (hydraData.traversedNodes || []).map((node, idx) => {
                  const isSeed = seedIdSet.has(node.id) || node.hop === 0;
                  const histValid = isHistoricallyValidNode(node);
                  const stepLabel = histValid
                    ? `Active on ${effectiveAsOf}`
                    : isSeed
                      ? 'Start'
                      : typeof node.hop === 'number'
                        ? `${node.hop} ${node.hop === 1 ? 'hop' : 'hops'}`
                        : idx === 0
                          ? 'Start'
                          : 'Connected';

                  return (
                    <div key={node.id} className="hs-item">
                      <div className="hs-item-body">
                        <div className="hs-item-title">{node.title || cleanNodeId(node.id)}</div>
                        <div className="hs-item-path">{cleanDisplaySub(node)}</div>
                      </div>
                      <span className={`hs-tag ${!isSeed ? 'hs-tag-win' : ''}`}>{stepLabel}</span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </section>

      {/* 4. Clean Dependency Flow Diagram (only shown when graph nodes exist) */}
      {isAnswerable && subgraphLayout.positionedNodes.length > 0 && (
        <section className="hs-graph-card" aria-label="Dependency path diagram">
          <div className="hs-graph-header">
            <h3 className="hs-section-title" style={{ fontSize: '0.92rem' }}>
              How HydraDB Connected the Answer
            </h3>
            <div className="hs-graph-legend">
              <span>
                <span className="hs-legend-dot" style={{ background: '#a1a1aa' }} />
                Starting match
              </span>
              <span>
                <span className="hs-legend-dot" style={{ background: '#10b981' }} />
                Connected dependency
              </span>
              {(hydraData?.retiredBlockedNodes || []).length > 0 && (
                <span>
                  <span className="hs-legend-dot" style={{ background: '#ef4444' }} />
                  Retired rule (blocked)
                </span>
              )}
            </div>
          </div>

          <div className="hs-svg-wrap">
            <svg
              viewBox="0 0 820 232"
              className="hs-svg"
              role="group"
              aria-labelledby="hs-flow-title"
            >
              <title id="hs-flow-title">
                Step-by-step dependency path from starting match to downstream files and rules
              </title>
              <defs>
                <marker
                  id="hs-arrow-neutral"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="5.5"
                  markerHeight="5.5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#71717a" />
                </marker>
                <marker
                  id="hs-arrow-red"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="5.5"
                  markerHeight="5.5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#ef4444" />
                </marker>
              </defs>

              {/* Column Headings */}
              <text x="24" y="22" fill="#71717a" fontSize="10.5" fontFamily="Inter, sans-serif" fontWeight="500">
                1. Starting Match
              </text>
              <text x="298" y="22" fill="#71717a" fontSize="10.5" fontFamily="Inter, sans-serif" fontWeight="500">
                2. Direct Links (1 Hop)
              </text>
              <text x="572" y="22" fill="#71717a" fontSize="10.5" fontFamily="Inter, sans-serif" fontWeight="500">
                3. Downstream &amp; Rules (2+ Hops)
              </text>

              {/* Edges */}
              {subgraphLayout.positionedEdges.map((edge, idx) => {
                const isSup = edge.type === 'SUPERSEDES';
                return (
                  <path
                    key={`${edge.from}-${edge.to}-${idx}`}
                    d={edge.pathD}
                    fill="none"
                    stroke={isSup ? '#ef4444' : '#52525b'}
                    strokeWidth="1.5"
                    strokeDasharray={isSup ? '4 3' : undefined}
                    markerEnd={isSup ? 'url(#hs-arrow-red)' : 'url(#hs-arrow-neutral)'}
                  />
                );
              })}

              {/* Nodes */}
              {subgraphLayout.positionedNodes.map((node) => {
                const isBlocked = Boolean(node.isBlockedRetired);
                const isSeed = node.colIdx === 0 && !isBlocked;
                const isSelected = inspectedNode?.id === node.id;

                const stroke = isBlocked
                  ? 'rgba(239, 68, 68, 0.55)'
                  : isSeed
                    ? 'rgba(255, 255, 255, 0.25)'
                    : 'rgba(16, 185, 129, 0.45)';
                const fill = isBlocked
                  ? 'rgba(239, 68, 68, 0.08)'
                  : isSeed
                    ? '#141418'
                    : 'rgba(16, 185, 129, 0.08)';

                const titleLabel = smartTruncate(node.title || cleanNodeId(node.id), 30);
                const subText = isBlocked
                  ? 'Blocked (retired rule)'
                  : smartTruncate(cleanDisplaySub(node), 32);

                return (
                  <g
                    key={node.id}
                    className="hs-svg-node"
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    aria-label={`${node.title || cleanNodeId(node.id)} (${subText})`}
                    onClick={() => setSelectedNodeId(node.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedNodeId(node.id);
                      }
                    }}
                  >
                    <rect
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={node.h}
                      rx="7"
                      fill={fill}
                      stroke={isSelected ? '#fafafa' : stroke}
                      strokeWidth={isSelected ? '1.8' : '1.2'}
                      strokeDasharray={isBlocked ? '4 3' : undefined}
                    />
                    <text
                      x={node.x + 10}
                      y={node.y + (node.h <= 36 ? 15 : 17)}
                      fill={isBlocked ? '#fca5a5' : '#fafafa'}
                      fontSize="11"
                      fontFamily="Inter, sans-serif"
                      fontWeight="600"
                      textDecoration={isBlocked ? 'line-through' : undefined}
                    >
                      {titleLabel}
                    </text>
                    <text
                      x={node.x + 10}
                      y={node.y + node.h - 7}
                      fill={isBlocked ? '#f87171' : '#a1a1aa'}
                      fontSize="9.5"
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {subText}
                    </text>
                  </g>
                );
              })}

              {subgraphLayout.overflowCounts.map((extra, cIdx) =>
                extra > 0 ? (
                  <text
                    key={`extra-${cIdx}`}
                    x={[24, 298, 572][cIdx] + 112}
                    y="224"
                    textAnchor="middle"
                    fill="#71717a"
                    fontSize="9.5"
                    fontFamily="Inter, sans-serif"
                  >
                    +{extra} more
                  </text>
                ) : null
              )}
            </svg>
          </div>

          {inspectedNode && (
            <div className="hs-selected-bar">
              <span>
                <strong style={{ color: '#fafafa' }}>
                  {inspectedNode.title || cleanNodeId(inspectedNode.id)}
                </strong>{' '}
                · <span style={{ fontFamily: 'var(--hs-font-mono)', fontSize: '0.75rem' }}>{cleanDisplaySub(inspectedNode)}</span>
              </span>
              {inspectedNode.isBlockedRetired ? (
                <span className="hs-tag hs-tag-fail">
                  Replaced by {cleanNodeId(inspectedNode.supersededBy || 'newer ADR')}
                </span>
              ) : (
                <span className="hs-tag hs-tag-win">{inspectedNode.tokens ?? 0} tokens</span>
              )}
            </div>
          )}
        </section>
      )}

      {/* 5. Progressive Disclosure: Collapsed Technical Details */}
      <section className="hs-disclosure" aria-label="Technical query details">
        <button
          type="button"
          className="hs-disclosure-btn"
          aria-expanded={showTechnical}
          onClick={() => setShowTechnical((v) => !v)}
        >
          <span>
            Technical details (OpenCypher query, assembled prompt slice, and raw vector output)
          </span>
          <span>{showTechnical ? 'Hide ▴' : 'Show ▾'}</span>
        </button>

        {showTechnical && (
          <div className="hs-disclosure-body">
            <div>
              <div className="hs-code-header">
                <span>
                  OpenCypher Query
                  {hydraData?.hydraExecution?.lastReadEpoch !== undefined &&
                    hydraData?.hydraExecution?.lastReadEpoch !== null &&
                    ` · Read epoch ${hydraData.hydraExecution.lastReadEpoch}`}
                </span>
                {hydraData?.cypherQuery && (
                  <button
                    type="button"
                    className="hs-btn hs-btn-sm"
                    onClick={() => cypherCopy.copyToClipboard(hydraData.cypherQuery)}
                  >
                    {cypherCopy.isCopied ? 'Copied' : 'Copy Cypher'}
                  </button>
                )}
              </div>
              <pre className="hs-pre">
                {hydraData?.cypherQuery ||
                  '// Pre-flight ontology check stopped ungrounded terms before OpenCypher ran.'}
              </pre>
            </div>

            <div>
              <div className="hs-code-header">
                <span>HydraDB Assembled Prompt ({formatNum(hydraTokens)} tokens)</span>
                {hydraData?.contextText && (
                  <button
                    type="button"
                    className="hs-btn hs-btn-sm"
                    onClick={() => promptCopy.copyToClipboard(hydraData.contextText)}
                  >
                    {promptCopy.isCopied ? 'Copied' : 'Copy Prompt'}
                  </button>
                )}
              </div>
              <pre className="hs-pre">
                {hydraData?.contextText || '[0 tokens] Blocked by pre-flight ontology check.'}
              </pre>
            </div>

            <div>
              <div className="hs-code-header">
                <span>Raw Vector Search Prompt ({formatNum(vectorTokens)} tokens)</span>
              </div>
              <pre className="hs-pre">{vectorData.contextText || '(empty vector context)'}</pre>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
