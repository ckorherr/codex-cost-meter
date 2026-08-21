#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FRAGMENT_BYTES = 1024 * 1024;
const DEFAULT_RECENT_LIMIT = 12;
const MAX_MODEL_ROWS = 12;
const MAX_SESSION_ROWS = 10;
const MAX_TEXT_LENGTH = 120;

function loadRuntimeData() {
  return require('../lib/runtime-data.js');
}

function parseArguments(argv) {
  const options = {
    outputPath: null,
    dataDir: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--output' || argument === '--data-dir') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${argument} requires a path.`);
      }
      if (argument === '--output') {
        options.outputPath = value;
      } else {
        options.dataDir = value;
      }
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }

  if (!options.help && !options.outputPath) {
    throw new TypeError('--output ABSOLUTE_PATH is required.');
  }
  if (!options.help && !path.isAbsolute(options.outputPath)) {
    throw new TypeError('--output must be an absolute path.');
  }

  return options;
}

function truncateText(value, maximum = MAX_TEXT_LENGTH) {
  const text = String(value ?? '');
  const characters = Array.from(text);
  if (characters.length <= maximum) {
    return text;
  }
  return `${characters.slice(0, maximum - 1).join('')}…`;
}

function escapeHtml(value) {
  return truncateText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeRootId(value) {
  if (
    typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
  ) {
    return value;
  }
  return `codex-cost-meter-${crypto.randomBytes(6).toString('hex')}`;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '—';
  }
  return `${number.toLocaleString('en-US', {
    maximumFractionDigits: 1,
  })}%`;
}

function formatDateTime(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return 'Unknown time';
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatShortDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  return match ? `${match[2]}/${match[3]}` : truncateText(value, 10);
}

function formatEuroNanos(value, runtimeData) {
  return runtimeData.formatEuroCost(safeNumber(value) / runtimeData.EUR_NANOS);
}

function formatUsage(value, runtimeData) {
  return runtimeData.formatTokens(safeNumber(value?.total_tokens));
}

function budgetMarkup(label, budget, runtimeData) {
  if (!budget || budget.limit_eur_nanos === null) {
    return '';
  }

  const rawPercentage = safeNumber(budget.percentage);
  const progressPercentage = Math.min(100, rawPercentage);
  const balance =
    safeNumber(budget.over_eur_nanos) > 0
      ? `${formatEuroNanos(budget.over_eur_nanos, runtimeData)} over`
      : `${formatEuroNanos(budget.remaining_eur_nanos, runtimeData)} left`;

  return `
        <div class="ccm-budget">
          <div class="ccm-budget-copy">
            <span>${escapeHtml(label)}</span>
            <span class="text-muted">${escapeHtml(formatPercent(rawPercentage))} · ${escapeHtml(balance)}</span>
          </div>
          <div
            class="progress"
            role="progressbar"
            aria-label="${escapeHtml(label)} progress"
            aria-valuenow="${progressPercentage.toFixed(1)}"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="progress-bar" style="width:${progressPercentage.toFixed(1)}%"></div>
          </div>
        </div>`;
}

function summaryCard(label, value, detail) {
  return `
      <article class="card viz-stat">
        <div class="text-muted">${escapeHtml(label)}</div>
        <div class="viz-stat-value">${escapeHtml(value)}</div>
        <div class="text-small text-muted">${escapeHtml(detail)}</div>
      </article>`;
}

function sevenDayMarkup(days, runtimeData) {
  const normalized = (days ?? []).slice(-7);
  const maximum = Math.max(
    1,
    ...normalized.map((day) => safeNumber(day.cost_eur_nanos)),
  );
  const accessibleSummary = normalized
    .map(
      (day) =>
        `${formatShortDate(day.date)} ${formatEuroNanos(day.cost_eur_nanos, runtimeData)}`,
    )
    .join(', ');

  const bars = normalized
    .map((day) => {
      const cost = safeNumber(day.cost_eur_nanos);
      const height = Math.min(100, (cost / maximum) * 100);
      const displayCost = formatEuroNanos(cost, runtimeData);
      return `
          <div
            class="ccm-bar-column"
            aria-label="${escapeHtml(`${day.date}: ${displayCost}, ${safeNumber(day.turns)} turns`)}"
          >
            <span class="ccm-bar-value text-small">${escapeHtml(displayCost)}</span>
            <div class="ccm-bar-track" aria-hidden="true">
              <div class="ccm-bar-fill" style="height:${height.toFixed(2)}%"></div>
            </div>
            <span class="text-small text-muted">${escapeHtml(formatShortDate(day.date))}</span>
          </div>`;
    })
    .join('');

  return `
      <section class="ccm-section" aria-labelledby="ccm-seven-day-heading">
        <h3 id="ccm-seven-day-heading">Last seven days</h3>
        <div
          class="ccm-bars"
          role="img"
          aria-label="${escapeHtml(`Recorded cost over the last seven days: ${accessibleSummary || 'no spending recorded'}`)}"
        >${bars}
        </div>
      </section>`;
}

function modelRows(groups, runtimeData) {
  const rows = (groups ?? []).slice(0, MAX_MODEL_ROWS).map((group) => `
              <tr>
                <td>${escapeHtml(group.model ?? 'Unknown')}</td>
                <td class="text-end">${escapeHtml(String(safeNumber(group.turns)))}</td>
                <td class="text-end">${escapeHtml(formatUsage(group.usage, runtimeData))}</td>
                <td class="text-end text-nowrap">${escapeHtml(formatEuroNanos(group.cost_eur_nanos, runtimeData))}</td>
              </tr>`);

  if (rows.length === 0) {
    return `
              <tr>
                <td colspan="4" class="text-muted">No recorded spending this month</td>
              </tr>`;
  }

  if ((groups ?? []).length > MAX_MODEL_ROWS) {
    rows.push(`
              <tr>
                <td colspan="4" class="text-muted">+ ${escapeHtml(String(groups.length - MAX_MODEL_ROWS))} more models</td>
              </tr>`);
  }
  return rows.join('');
}

function sessionRows(groups, runtimeData) {
  const rows = (groups ?? []).slice(0, MAX_SESSION_ROWS).map((group) => `
              <tr>
                <td>${escapeHtml(group.label ?? 'Local task')}</td>
                <td class="text-end">${escapeHtml(String(safeNumber(group.turns)))}</td>
                <td class="text-end">${escapeHtml(formatUsage(group.usage, runtimeData))}</td>
                <td class="text-end text-nowrap">${escapeHtml(formatEuroNanos(group.cost_eur_nanos, runtimeData))}</td>
              </tr>`);

  if (rows.length === 0) {
    return `
              <tr>
                <td colspan="4" class="text-muted">No recorded spending this month</td>
              </tr>`;
  }

  if ((groups ?? []).length > MAX_SESSION_ROWS) {
    rows.push(`
              <tr>
                <td colspan="4" class="text-muted">+ ${escapeHtml(String(groups.length - MAX_SESSION_ROWS))} more tasks</td>
              </tr>`);
  }
  return rows.join('');
}

function agentRows(byAgent, runtimeData) {
  const groups = [
    ['Root agent', byAgent?.root],
    ['Subagents', byAgent?.subagent],
  ];
  if (
    safeNumber(byAgent?.unattributed?.turns) > 0 ||
    safeNumber(byAgent?.unattributed?.cost_eur_nanos) > 0 ||
    safeNumber(byAgent?.unattributed?.usage?.total_tokens) > 0
  ) {
    groups.push(['Pending attribution', byAgent.unattributed]);
  }
  return groups
    .map(([label, group]) => `
              <tr>
                <td>${escapeHtml(label)}</td>
                <td class="text-end">${escapeHtml(String(safeNumber(group?.turns)))}</td>
                <td class="text-end">${escapeHtml(formatUsage(group?.usage, runtimeData))}</td>
                <td class="text-end text-nowrap">${escapeHtml(formatEuroNanos(group?.cost_eur_nanos, runtimeData))}</td>
              </tr>`)
    .join('');
}

function recentRows(turns, timeZone, runtimeData) {
  const rows = (turns ?? []).slice(0, DEFAULT_RECENT_LIMIT).map((turn) => `
              <tr>
                <td class="text-nowrap">${escapeHtml(formatDateTime(turn.completed_at, timeZone))}</td>
                <td>${escapeHtml(turn.task_label ?? 'Local task')}<br><span class="text-small text-muted">${escapeHtml(turn.turn_label ?? 'Turn')}</span></td>
                <td>${escapeHtml(turn.model ?? 'Unknown')}</td>
                <td class="text-end">${escapeHtml(String(safeNumber(turn.agent_threads)))}</td>
                <td class="text-end">${escapeHtml(formatUsage(turn.usage, runtimeData))}</td>
                <td class="text-end text-nowrap">${escapeHtml(formatEuroNanos(turn.cost_eur_nanos, runtimeData))}</td>
              </tr>`);

  if (rows.length === 0) {
    return `
              <tr>
                <td colspan="6" class="text-muted">No completed turns in the local ledger</td>
              </tr>`;
  }
  return rows.join('');
}

function refreshScript(rootId) {
  return `<script>
    (() => {
      const root = document.getElementById('${rootId}');
      const refresh = root ? root.querySelector('[data-ccm-refresh]') : null;
      if (!refresh) return;
      if (!window.openai || typeof window.openai.sendFollowUpMessage !== 'function') {
        refresh.hidden = true;
        return;
      }
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        try {
          await window.openai.sendFollowUpMessage({
            prompt: 'Show my Codex cost dashboard',
            title: 'Refresh cost dashboard'
          });
        } finally {
          refresh.disabled = false;
        }
      });
    })();
  </script>`;
}

function unavailableFragment(rootId, refreshMarkup) {
  return `<section id="${rootId}" class="ccm-dashboard" aria-labelledby="${rootId}-heading">
  <style>
    #${rootId} { color: var(--foreground); }
    #${rootId} .ccm-header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
  </style>
  <div class="ccm-header">
    <div>
      <h2 id="${rootId}-heading">Codex cost meter</h2>
      <p class="text-muted">The local ledger could not be read completely, so no partial totals are shown.</p>
    </div>
    ${refreshMarkup}
  </div>
  ${refreshScript(rootId)}
</section>`;
}

function renderFragment(snapshot, runtimeData, options = {}) {
  const rootId = safeRootId(options.rootId);
  const refreshMarkup =
    '<button class="btn btn-ghost" type="button" data-ccm-refresh>Refresh</button>';

  const lowerBound =
    snapshot.complete === false &&
    snapshot.lower_bound?.available === true;
  if (snapshot.complete === false && !lowerBound) {
    return unavailableFragment(rootId, refreshMarkup);
  }

  const costPrefix = lowerBound ? '≥' : '';
  const todayCost = `${costPrefix}${formatEuroNanos(snapshot.today?.cost_eur_nanos, runtimeData)}`;
  const monthCost = `${costPrefix}${formatEuroNanos(snapshot.month?.cost_eur_nanos, runtimeData)}`;
  const forecastCost = `${costPrefix}${formatEuroNanos(
    snapshot.budgets?.forecast_eur_nanos,
    runtimeData,
  )}`;
  const monthForecastDetail =
    lowerBound
      ? 'Minimum recorded-cost projection'
      : snapshot.budgets?.forecast_percentage === null ||
    snapshot.budgets?.forecast_percentage === undefined
      ? 'Recorded-cost projection'
      : `${formatPercent(snapshot.budgets.forecast_percentage)} of monthly budget`;
  const pendingTurns = safeNumber(snapshot.lower_bound?.pending_turns);
  const todayPendingTurns = safeNumber(
    snapshot.lower_bound?.today_pending_turns,
  );
  const monthPendingTurns = safeNumber(
    snapshot.lower_bound?.month_pending_turns,
  );
  const lowerBoundNotice = lowerBound
    ? `<p class="ccm-lower-bound" role="status">Showing a known minimum. ${escapeHtml(String(pendingTurns))} completed ${pendingTurns === 1 ? 'turn is' : 'turns are'} pending exact reconciliation; known portions are included and marked with ≥.</p>`
    : '';
  const dailyBudget = budgetMarkup(
    'Daily budget',
    snapshot.budgets?.daily,
    runtimeData,
  );
  const monthlyBudget = budgetMarkup(
    'Monthly budget',
    snapshot.budgets?.monthly,
    runtimeData,
  );
  const budgetSection =
    dailyBudget || monthlyBudget
      ? `
      <section class="ccm-section" aria-labelledby="${rootId}-budgets">
        <div class="ccm-section-heading">
          <h3 id="${rootId}-budgets">Budget guidance</h3>
          <span class="text-small text-muted">Informational only</span>
        </div>
        <div class="ccm-budget-list">${dailyBudget}${monthlyBudget}
        </div>
      </section>`
      : `
      <p class="text-small text-muted ccm-unrestricted">Budgets are unrestricted.</p>`;
  const cache = snapshot.cache ?? {};
  const cacheHitRate =
    cache.hit_rate_percent === null || cache.hit_rate_percent === undefined
      ? '—'
      : formatPercent(cache.hit_rate_percent);
  const generatedAt = formatDateTime(
    snapshot.generated_at,
    snapshot.timezone,
  );

  return `<section id="${rootId}" class="ccm-dashboard" aria-labelledby="${rootId}-heading">
  <style>
    #${rootId} {
      display: grid;
      gap: 1.25rem;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow-x: hidden;
      color: var(--foreground);
      font-size: var(--font-size-base);
    }
    #${rootId} .ccm-header,
    #${rootId} .ccm-section-heading,
    #${rootId} .ccm-budget-copy {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
    }
    #${rootId} .ccm-header {
      flex-wrap: wrap;
    }
    #${rootId} h2,
    #${rootId} h3,
    #${rootId} p {
      margin-top: 0;
    }
    #${rootId} .ccm-summary {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    #${rootId} .ccm-section {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }
    #${rootId} .ccm-unrestricted {
      margin: 0;
    }
    #${rootId} .ccm-lower-bound {
      margin: 0;
      padding: 0.75rem 1rem;
      border-left: 3px solid var(--viz-series-1);
      background: var(--muted);
      color: var(--foreground);
    }
    #${rootId} .ccm-bars {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      align-items: end;
      gap: 0.5rem;
      min-height: 9rem;
    }
    #${rootId} .ccm-bar-column {
      display: grid;
      grid-template-rows: auto 6rem auto;
      align-items: end;
      gap: 0.35rem;
      min-width: 0;
      text-align: center;
    }
    #${rootId} .ccm-bar-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${rootId} .ccm-bar-track {
      position: relative;
      height: 6rem;
      overflow: hidden;
      background: var(--muted);
    }
    #${rootId} .ccm-bar-fill {
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      background: var(--viz-series-1);
    }
    #${rootId} .ccm-budget-list {
      display: grid;
      gap: 0.85rem;
    }
    #${rootId} .ccm-budget {
      display: grid;
      gap: 0.45rem;
    }
    #${rootId} .ccm-detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1.25rem;
    }
    #${rootId} .ccm-stack {
      display: grid;
      gap: 1.25rem;
      min-width: 0;
    }
    #${rootId} .ccm-detail-grid > *,
    #${rootId} .table-responsive {
      min-width: 0;
      max-width: 100%;
    }
    #${rootId} .ccm-cache-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem 1rem;
      margin: 0;
    }
    #${rootId} .ccm-cache-grid div {
      min-width: 0;
    }
    #${rootId} .ccm-cache-grid dt,
    #${rootId} .ccm-cache-grid dd {
      margin: 0;
    }
    @media (max-width: 560px) {
      #${rootId} .ccm-summary,
      #${rootId} .ccm-detail-grid {
        grid-template-columns: 1fr;
      }
      #${rootId} .ccm-bars {
        gap: 0.25rem;
      }
      #${rootId} .ccm-bar-value {
        display: none;
      }
      #${rootId} .ccm-budget-copy {
        display: grid;
        gap: 0.2rem;
      }
    }
  </style>

  <header class="ccm-header">
    <div>
      <h2 id="${rootId}-heading">Codex cost meter</h2>
      <div class="text-small text-muted">Local ledger · ${escapeHtml(snapshot.timezone)} · Updated ${escapeHtml(generatedAt)}</div>
    </div>
    ${refreshMarkup}
  </header>

  ${lowerBoundNotice}

  <div class="viz-grid ccm-summary" aria-label="Spending summary">
    ${summaryCard(
      lowerBound ? 'Today · known minimum' : 'Today',
      todayCost,
      `${safeNumber(snapshot.today?.turns)} ${lowerBound ? 'known turns' : 'turns'} · ${formatUsage(snapshot.today?.usage, runtimeData)} tokens${lowerBound ? ` · ${todayPendingTurns} pending` : ''}`,
    )}
    ${summaryCard(
      lowerBound ? 'Current month · known minimum' : 'Current month',
      monthCost,
      `${safeNumber(snapshot.month?.turns)} ${lowerBound ? 'known turns' : 'turns'} · ${formatUsage(snapshot.month?.usage, runtimeData)} tokens${lowerBound ? ` · ${monthPendingTurns} pending` : ''}`,
    )}
    ${summaryCard(lowerBound ? 'Minimum forecast' : 'Recorded-cost forecast', forecastCost, monthForecastDetail)}
  </div>

  ${budgetSection}
  ${sevenDayMarkup(snapshot.seven_days, runtimeData)}

  <div class="ccm-detail-grid">
    <div class="ccm-stack">
      <section class="ccm-section" aria-labelledby="${rootId}-models">
        <h3 id="${rootId}-models">Cost by model</h3>
        <div class="table-responsive">
          <table class="table table-sm">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" class="text-end">Turns</th>
                <th scope="col" class="text-end">Tokens</th>
                <th scope="col" class="text-end">Cost</th>
              </tr>
            </thead>
            <tbody>${modelRows(snapshot.by_model, runtimeData)}
            </tbody>
          </table>
        </div>
      </section>

      <section class="ccm-section" aria-labelledby="${rootId}-tasks">
        <h3 id="${rootId}-tasks">Cost by task</h3>
        <div class="table-responsive">
          <table class="table table-sm">
            <thead>
              <tr>
                <th scope="col">Local task</th>
                <th scope="col" class="text-end">Turns</th>
                <th scope="col" class="text-end">Tokens</th>
                <th scope="col" class="text-end">Cost</th>
              </tr>
            </thead>
            <tbody>${sessionRows(snapshot.by_session, runtimeData)}
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <div class="ccm-stack">
      <section class="ccm-section" aria-labelledby="${rootId}-agents">
        <h3 id="${rootId}-agents">Root and subagents</h3>
        <div class="table-responsive">
          <table class="table table-sm">
            <thead>
              <tr>
                <th scope="col">Execution</th>
                <th scope="col" class="text-end">Turns</th>
                <th scope="col" class="text-end">Tokens</th>
                <th scope="col" class="text-end">Cost</th>
              </tr>
            </thead>
            <tbody>${agentRows(snapshot.by_agent, runtimeData)}
            </tbody>
          </table>
        </div>
      </section>

      <section class="ccm-section" aria-labelledby="${rootId}-cache">
        <h3 id="${rootId}-cache">Prompt cache</h3>
        <dl class="ccm-cache-grid">
          <div><dt class="text-small text-muted">Hit rate</dt><dd>${escapeHtml(cacheHitRate)}</dd></div>
          <div><dt class="text-small text-muted">Cached</dt><dd>${escapeHtml(runtimeData.formatTokens(safeNumber(cache.cached_input_tokens)))}</dd></div>
          <div><dt class="text-small text-muted">Uncached</dt><dd>${escapeHtml(runtimeData.formatTokens(safeNumber(cache.uncached_input_tokens)))}</dd></div>
          <div><dt class="text-small text-muted">Cache writes</dt><dd>${escapeHtml(runtimeData.formatTokens(safeNumber(cache.cache_write_input_tokens)))}</dd></div>
        </dl>
      </section>
    </div>
  </div>

  <section class="ccm-section" aria-labelledby="${rootId}-recent">
    <div class="ccm-section-heading">
      <h3 id="${rootId}-recent">Recent turns</h3>
      <span class="text-small text-muted">${escapeHtml(runtimeData.formatTokens(safeNumber(snapshot.records_count)))} recorded</span>
    </div>
    <div class="table-responsive">
      <table class="table table-sm">
        <thead>
          <tr>
            <th scope="col">Completed</th>
            <th scope="col">Task / turn</th>
            <th scope="col">Model</th>
            <th scope="col" class="text-end">Agents</th>
            <th scope="col" class="text-end">Tokens</th>
            <th scope="col" class="text-end">Cost</th>
          </tr>
        </thead>
        <tbody>${recentRows(snapshot.recent_turns, snapshot.timezone, runtimeData)}
        </tbody>
      </table>
    </div>
  </section>

  ${refreshScript(rootId)}
</section>`;
}

function writeFragment(outputPath, fragment) {
  const byteLength = Buffer.byteLength(fragment, 'utf8');
  if (byteLength >= MAX_FRAGMENT_BYTES) {
    throw new RangeError('Dashboard fragment exceeds the 1 MB limit.');
  }
  fs.mkdirSync(path.dirname(outputPath), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(outputPath, `${fragment}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return byteLength + 1;
}

function visualizationReferencePath(outputPath, environment = process.env) {
  const normalizedInput = String(outputPath).replaceAll('\\', '/');
  if (environment.WSL_DISTRO_NAME) {
    const mountedWindowsPath =
      /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(normalizedInput);
    if (mountedWindowsPath) {
      const [, drive, remainder = ''] = mountedWindowsPath;
      return `${drive.toUpperCase()}:/${remainder}`;
    }
  }
  return path.resolve(outputPath);
}

function renderDashboardFragment(options = {}) {
  if (
    typeof options.outputPath !== 'string' ||
    !path.isAbsolute(options.outputPath)
  ) {
    throw new TypeError('An absolute outputPath is required.');
  }

  const runtimeData = options.runtimeData ?? loadRuntimeData();
  const dataRoot = runtimeData.resolveDataRoot({
    dataRoot: options.dataDir,
    env: options.env ?? process.env,
  });
  const settingsResult = runtimeData.loadSettings(dataRoot);
  const snapshot = runtimeData.buildSnapshot(dataRoot, {
    settings: settingsResult.settings,
    now: options.now ?? options.nowMs ?? Date.now(),
    recentLimit: options.recentLimit ?? DEFAULT_RECENT_LIMIT,
    fullHistory: true,
  });
  const fragment = renderFragment(snapshot, runtimeData, {
    rootId: options.rootId,
  });
  const bytes = writeFragment(options.outputPath, fragment);
  return {
    outputPath: path.resolve(options.outputPath),
    bytes,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node render-dashboard-fragment.js --output ABSOLUTE_PATH [--data-dir PATH]\n',
    );
    return;
  }
  const result = renderDashboardFragment(options);
  process.stdout.write(`${visualizationReferencePath(result.outputPath)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Dashboard fragment was not written: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_FRAGMENT_BYTES,
  escapeHtml,
  main,
  parseArguments,
  renderDashboardFragment,
  renderFragment,
  visualizationReferencePath,
};
