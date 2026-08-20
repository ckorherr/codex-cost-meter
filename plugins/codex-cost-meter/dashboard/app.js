'use strict';

const elements = {
  status: document.querySelector('#status'),
  timezone: document.querySelector('#timezone'),
  refreshed: document.querySelector('#refreshed'),
  refreshButton: document.querySelector('#refresh-button'),
  settingsButton: document.querySelector('#settings-button'),
  todayCost: document.querySelector('#today-cost'),
  todayDetail: document.querySelector('#today-detail'),
  monthCost: document.querySelector('#month-cost'),
  monthDetail: document.querySelector('#month-detail'),
  forecastCost: document.querySelector('#forecast-cost'),
  forecastDetail: document.querySelector('#forecast-detail'),
  dailyBudgetCopy: document.querySelector('#daily-budget-copy'),
  dailyBudgetProgress: document.querySelector('#daily-budget-progress'),
  monthlyBudgetCopy: document.querySelector('#monthly-budget-copy'),
  monthlyBudgetProgress: document.querySelector('#monthly-budget-progress'),
  sevenDayChart: document.querySelector('#seven-day-chart'),
  rootAgentCost: document.querySelector('#root-agent-cost'),
  rootAgentTokens: document.querySelector('#root-agent-tokens'),
  subagentCost: document.querySelector('#subagent-cost'),
  subagentTokens: document.querySelector('#subagent-tokens'),
  cacheHitRate: document.querySelector('#cache-hit-rate'),
  cachedTokens: document.querySelector('#cached-tokens'),
  uncachedTokens: document.querySelector('#uncached-tokens'),
  cacheWriteTokens: document.querySelector('#cache-write-tokens'),
  modelsBody: document.querySelector('#models-body'),
  sessionsBody: document.querySelector('#sessions-body'),
  recentBody: document.querySelector('#recent-body'),
  ledgerCount: document.querySelector('#ledger-count'),
  settingsDialog: document.querySelector('#settings-dialog'),
  settingsForm: document.querySelector('#settings-form'),
  settingsClose: document.querySelector('#settings-close'),
  settingsCancel: document.querySelector('#settings-cancel'),
  settingsStatus: document.querySelector('#settings-status'),
  dailyBudget: document.querySelector('#daily-budget'),
  monthlyBudget: document.querySelector('#monthly-budget'),
  warningThresholds: document.querySelector('#warning-thresholds'),
  settingsTimezone: document.querySelector('#settings-timezone'),
  messageFormat: document.querySelector('#message-format'),
  windowsNotifications: document.querySelector('#windows-notifications'),
};

let csrfToken = '';
let currentSettings = null;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value) {
  return Math.max(0, Math.round(number(value))).toLocaleString('en-US');
}

function percentage(value) {
  const parsed = number(value);
  return `${parsed.toLocaleString('en-US', {
    maximumFractionDigits: 1,
  })}%`;
}

function optionalPercentage(value) {
  return value === null || value === undefined ? '—' : percentage(value);
}

function localDateTime(value, timeZone) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return 'Unknown time';
  }
  try {
    return parsed.toLocaleString([], {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return 'Unknown time';
  }
}

function shortDate(value) {
  const parts = String(value).split('-');
  if (parts.length !== 3) {
    return String(value);
  }
  return `${parts[1]}/${parts[2]}`;
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('visible', Boolean(message));
  elements.status.classList.toggle('error', error);
}

function renderBudget(budget, copyElement, progressElement) {
  if (!budget || budget.limit_eur_nanos === null) {
    copyElement.textContent = 'Not configured';
    progressElement.value = 0;
    progressElement.textContent = 'Not configured';
    progressElement.setAttribute('aria-label', 'Budget not configured');
    return;
  }

  const rawPercent = number(budget.percentage);
  const displayPercent = percentage(rawPercent);
  const balance =
    number(budget.over_eur_nanos) > 0
      ? `${budget.display_over} over`
      : `${budget.display_remaining} left`;
  copyElement.textContent = `${displayPercent} · ${balance}`;
  progressElement.value = Math.min(100, Math.max(0, rawPercent));
  progressElement.textContent = displayPercent;
  progressElement.setAttribute(
    'aria-label',
    `${displayPercent} of ${budget.display_limit}`,
  );
}

function renderChart(days) {
  elements.sevenDayChart.replaceChildren();
  const values = days.map((day) => number(day.cost_eur_nanos));
  const maximum = Math.max(1, ...values);

  for (const day of days) {
    const item = document.createElement('li');
    const cost = document.createElement('span');
    const bar = document.createElement('progress');
    const label = document.createElement('span');

    cost.className = 'chart-cost';
    cost.textContent = day.display_cost;
    bar.max = maximum;
    bar.value = number(day.cost_eur_nanos);
    bar.textContent = day.display_cost;
    bar.setAttribute(
      'aria-label',
      `${day.date}: ${day.display_cost}, ${integer(day.turns)} turns`,
    );
    label.className = 'chart-day';
    label.textContent = shortDate(day.date);

    item.append(cost, bar, label);
    elements.sevenDayChart.append(item);
  }
}

function appendCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = value;
  row.append(cell);
}

function renderGroupTable(body, groups, labelKey) {
  body.replaceChildren();
  if (groups.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 4;
    cell.textContent = 'No recorded spending yet';
    row.append(cell);
    body.append(row);
    return;
  }

  for (const group of groups) {
    const row = document.createElement('tr');
    appendCell(row, String(group[labelKey] ?? 'Unknown'));
    appendCell(row, integer(group.turns));
    appendCell(row, integer(group.usage?.total_tokens));
    appendCell(row, group.display_cost);
    body.append(row);
  }
}

function renderRecent(turns, timeZone) {
  elements.recentBody.replaceChildren();
  if (turns.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 7;
    cell.textContent = 'No completed turns in the local ledger';
    row.append(cell);
    elements.recentBody.append(row);
    return;
  }

  for (const turn of turns) {
    const row = document.createElement('tr');
    appendCell(row, localDateTime(turn.completed_at, timeZone));
    appendCell(row, String(turn.task_label ?? 'Local task'));
    appendCell(row, String(turn.turn_label ?? 'Turn'));
    appendCell(row, String(turn.model ?? 'Unknown'));
    appendCell(row, integer(turn.agent_threads));
    appendCell(row, integer(turn.usage?.total_tokens));
    appendCell(row, turn.display_cost);
    elements.recentBody.append(row);
  }
}

function renderAgent(group, costElement, tokenElement) {
  costElement.textContent = group?.display_cost ?? '€0.00';
  tokenElement.textContent = `${integer(group?.usage?.total_tokens)} tokens · ${integer(group?.turns)} turns`;
}

function renderUnavailableTable(body, columnCount) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.className = 'empty-cell';
  cell.colSpan = columnCount;
  cell.textContent = 'Unavailable while the local ledger is incomplete';
  row.append(cell);
  body.replaceChildren(row);
}

function renderUnavailable(data) {
  elements.timezone.textContent = data.timezone ?? 'Europe/Berlin';
  elements.refreshed.textContent =
    `Checked ${localDateTime(data.generated_at, data.timezone)}`;
  elements.todayCost.textContent = '—';
  elements.todayDetail.textContent = 'No partial totals shown';
  elements.monthCost.textContent = '—';
  elements.monthDetail.textContent = 'No partial totals shown';
  elements.forecastCost.textContent = '—';
  elements.forecastDetail.textContent = 'No partial forecast shown';

  for (const [copy, progress] of [
    [elements.dailyBudgetCopy, elements.dailyBudgetProgress],
    [elements.monthlyBudgetCopy, elements.monthlyBudgetProgress],
  ]) {
    copy.textContent = 'Unavailable';
    progress.removeAttribute('value');
    progress.textContent = 'Unavailable';
    progress.setAttribute(
      'aria-label',
      'Budget progress unavailable while the ledger is incomplete',
    );
  }

  elements.sevenDayChart.replaceChildren();
  elements.rootAgentCost.textContent = '—';
  elements.rootAgentTokens.textContent = 'No partial totals shown';
  elements.subagentCost.textContent = '—';
  elements.subagentTokens.textContent = 'No partial totals shown';
  elements.cacheHitRate.textContent = '—';
  elements.cachedTokens.textContent = '—';
  elements.uncachedTokens.textContent = '—';
  elements.cacheWriteTokens.textContent = '—';
  renderUnavailableTable(elements.modelsBody, 4);
  renderUnavailableTable(elements.sessionsBody, 4);
  renderUnavailableTable(elements.recentBody, 7);
  elements.ledgerCount.textContent = 'Ledger incomplete';

  currentSettings = data.settings;
  const diagnostics = [
    ...(data.settings_diagnostics ?? []),
    ...(data.diagnostics ?? []),
  ];
  const detail =
    diagnostics.length > 0 ? ` ${diagnostics.join(' ')}` : '';
  setStatus(
    `The local ledger could not be read completely, so no partial totals are shown.${detail}`,
    true,
  );
}

function renderDashboard(data) {
  if (data.complete === false) {
    renderUnavailable(data);
    return;
  }

  elements.timezone.textContent = data.timezone ?? 'Europe/Berlin';
  elements.refreshed.textContent =
    `Updated ${localDateTime(data.generated_at, data.timezone)}`;

  elements.todayCost.textContent = data.today?.display_cost ?? '€0.00';
  elements.todayDetail.textContent =
    `${integer(data.today?.turns)} turns · ${integer(data.today?.usage?.total_tokens)} tokens`;
  elements.monthCost.textContent = data.month?.display_cost ?? '€0.00';
  elements.monthDetail.textContent =
    `${integer(data.month?.turns)} turns · ${integer(data.month?.usage?.total_tokens)} tokens`;
  elements.forecastCost.textContent =
    data.budgets?.display_forecast ?? '€0.00';
  elements.forecastDetail.textContent =
    data.budgets?.forecast_percentage === null
      ? 'Recorded-cost projection'
      : `${percentage(data.budgets.forecast_percentage)} of monthly budget`;

  renderBudget(
    data.budgets?.daily,
    elements.dailyBudgetCopy,
    elements.dailyBudgetProgress,
  );
  renderBudget(
    data.budgets?.monthly,
    elements.monthlyBudgetCopy,
    elements.monthlyBudgetProgress,
  );
  renderChart(data.seven_days ?? []);

  renderAgent(
    data.by_agent?.root,
    elements.rootAgentCost,
    elements.rootAgentTokens,
  );
  renderAgent(
    data.by_agent?.subagent,
    elements.subagentCost,
    elements.subagentTokens,
  );

  elements.cacheHitRate.textContent = optionalPercentage(
    data.cache?.hit_rate_percent,
  );
  elements.cachedTokens.textContent = integer(
    data.cache?.cached_input_tokens,
  );
  elements.uncachedTokens.textContent = integer(
    data.cache?.uncached_input_tokens,
  );
  elements.cacheWriteTokens.textContent = integer(
    data.cache?.cache_write_input_tokens,
  );

  renderGroupTable(elements.modelsBody, data.by_model ?? [], 'model');
  renderGroupTable(elements.sessionsBody, data.by_session ?? [], 'label');
  renderRecent(data.recent_turns ?? [], data.timezone);
  elements.ledgerCount.textContent =
    `${integer(data.records_count)} recorded turns`;

  currentSettings = data.settings;
  const diagnostics = [
    ...(data.settings_diagnostics ?? []),
    ...(data.diagnostics ?? []),
  ];
  if (diagnostics.length > 0) {
    setStatus(diagnostics.join(' '));
  } else {
    setStatus('');
  }
}

function fillSettingsForm(settings) {
  const budgets = settings?.budgets ?? {};
  elements.dailyBudget.value =
    budgets.daily_eur === null || budgets.daily_eur === undefined
      ? ''
      : String(budgets.daily_eur);
  elements.monthlyBudget.value =
    budgets.monthly_eur === null || budgets.monthly_eur === undefined
      ? ''
      : String(budgets.monthly_eur);
  elements.warningThresholds.value = (
    budgets.warning_thresholds_percent ?? [50, 80, 100]
  ).join(', ');
  elements.settingsTimezone.value =
    settings?.timezone ?? 'Europe/Berlin';
  elements.messageFormat.value =
    settings?.hook?.message_format ?? 'compact';
  elements.windowsNotifications.checked =
    settings?.notifications?.windows === true;
  elements.settingsStatus.textContent = '';
}

function nullablePositive(input) {
  const trimmed = input.value.trim();
  return trimmed === '' ? null : Number(trimmed);
}

function settingsFromForm() {
  return {
    schema: 1,
    timezone: elements.settingsTimezone.value.trim(),
    budgets: {
      daily_eur: nullablePositive(elements.dailyBudget),
      monthly_eur: nullablePositive(elements.monthlyBudget),
      warning_thresholds_percent: elements.warningThresholds.value
        .split(',')
        .map((value) => Number(value.trim()))
        .filter(Number.isFinite),
    },
    notifications: {
      windows: elements.windowsNotifications.checked,
    },
    hook: {
      message_format: elements.messageFormat.value,
    },
  };
}

async function loadDashboard() {
  elements.refreshButton.disabled = true;
  setStatus('Loading local ledger…');
  try {
    const response = await fetch('/api/dashboard', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Dashboard request failed (${response.status}).`);
    }
    csrfToken = response.headers.get('X-Codex-CSRF-Token') ?? '';
    renderDashboard(await response.json());
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const submit = elements.settingsForm.querySelector('[type="submit"]');
  submit.disabled = true;
  elements.settingsStatus.textContent = 'Saving…';

  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Codex-CSRF-Token': csrfToken,
      },
      body: JSON.stringify(settingsFromForm()),
    });
    const result = await response.json();
    if (!response.ok || result.saved === false) {
      const reason =
        result.error ??
        result.reason ??
        (result.diagnostics ?? []).join(' ') ??
        'Settings could not be saved.';
      throw new Error(reason);
    }
    currentSettings = result.settings;
    const diagnostics = result.diagnostics ?? [];
    if (diagnostics.length > 0) {
      fillSettingsForm(currentSettings);
      elements.settingsStatus.textContent =
        `Saved with adjustments: ${diagnostics.join(' ')}`;
      await loadDashboard();
      return;
    }
    elements.settingsStatus.textContent = 'Saved locally.';
    await loadDashboard();
    elements.settingsDialog.close();
  } catch (error) {
    elements.settingsStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

elements.refreshButton.addEventListener('click', loadDashboard);
elements.settingsButton.addEventListener('click', () => {
  fillSettingsForm(currentSettings);
  elements.settingsDialog.showModal();
});
elements.settingsClose.addEventListener('click', () => {
  elements.settingsDialog.close();
});
elements.settingsCancel.addEventListener('click', () => {
  elements.settingsDialog.close();
});
elements.settingsForm.addEventListener('submit', saveSettings);

loadDashboard();
