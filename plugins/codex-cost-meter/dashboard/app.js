'use strict';

const TASK_SCOPE_LABELS = Object.freeze({
  today: 'Today',
  seven_days: 'Last 7 days',
  month: 'Current month',
});
const RECENT_COLLAPSED_LIMIT = 10;

const elements = {
  status: document.querySelector('#status'),
  timezone: document.querySelector('#timezone'),
  refreshed: document.querySelector('#refreshed'),
  liveStatus: document.querySelector('#live-status'),
  liveStatusCopy: document.querySelector('#live-status-copy'),
  refreshButton: document.querySelector('#refresh-button'),
  settingsButton: document.querySelector('#settings-button'),
  todayCost: document.querySelector('#today-cost'),
  todayDetail: document.querySelector('#today-detail'),
  monthCost: document.querySelector('#month-cost'),
  monthDetail: document.querySelector('#month-detail'),
  forecastCost: document.querySelector('#forecast-cost'),
  forecastDetail: document.querySelector('#forecast-detail'),
  budgetPanel: document.querySelector('#budget-panel'),
  budgetStateNote: document.querySelector('#budget-state-note'),
  budgetSetupButton: document.querySelector('#budget-setup-button'),
  dailyBudgetCopy: document.querySelector('#daily-budget-copy'),
  dailyBudgetProgress: document.querySelector('#daily-budget-progress'),
  monthlyBudgetCopy: document.querySelector('#monthly-budget-copy'),
  monthlyBudgetProgress: document.querySelector('#monthly-budget-progress'),
  sevenDayChart: document.querySelector('#seven-day-chart'),
  rootAgentCost: document.querySelector('#root-agent-cost'),
  rootAgentTokens: document.querySelector('#root-agent-tokens'),
  subagentCost: document.querySelector('#subagent-cost'),
  subagentTokens: document.querySelector('#subagent-tokens'),
  unattributedAgentRow: document.querySelector('#unattributed-agent-row'),
  unattributedAgentCost: document.querySelector('#unattributed-agent-cost'),
  unattributedAgentTokens: document.querySelector('#unattributed-agent-tokens'),
  cacheHitRate: document.querySelector('#cache-hit-rate'),
  cachedTokens: document.querySelector('#cached-tokens'),
  uncachedTokens: document.querySelector('#uncached-tokens'),
  cacheWriteTokens: document.querySelector('#cache-write-tokens'),
  modelsBody: document.querySelector('#models-body'),
  tasksBody: document.querySelector('#tasks-body'),
  taskCount: document.querySelector('#task-count'),
  taskSearch: document.querySelector('#task-search'),
  taskScopeButtons: [...document.querySelectorAll('[data-task-scope]')],
  taskSortButtons: [...document.querySelectorAll('[data-task-sort]')],
  recentBody: document.querySelector('#recent-body'),
  recentToggle: document.querySelector('#recent-toggle'),
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
let currentTimeZone = 'Europe/Berlin';
let currentTaskScope = 'month';
let currentTaskScopes = {
  today: [],
  seven_days: [],
  month: [],
};
let currentRecentTurns = [];
let recentExpanded = false;
let taskSort = { key: 'cost', direction: 'desc' };
let dashboardRequest = null;
let dashboardReloadQueued = false;
let dashboardReloadForce = false;
let liveEvents = null;
let liveReloadTimer = null;
let renderedRevision = '';
let pendingRevision = '';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function array(value) {
  return Array.isArray(value) ? value : [];
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

function formatEuroNanos(value) {
  const euros = Math.max(0, number(value)) / 1_000_000_000;
  if (euros === 0) {
    return '€0';
  }
  if (euros < 0.01) {
    return `€${euros.toFixed(5)}`;
  }
  if (euros < 1) {
    return `€${euros.toFixed(4)}`;
  }
  return `€${euros.toFixed(2)}`;
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

function setLiveStatus(state, message) {
  elements.liveStatus.dataset.state = state;
  elements.liveStatusCopy.textContent = message;
}

function renderBudget(budget, copyElement, progressElement) {
  if (!budget || budget.limit_eur_nanos === null) {
    copyElement.textContent = 'Not configured';
    progressElement.value = 0;
    progressElement.textContent = 'Not configured';
    progressElement.setAttribute('aria-label', 'Budget not configured');
    return false;
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
  return true;
}

function renderBudgetPanel(budgets) {
  const dailyConfigured = renderBudget(
    budgets?.daily,
    elements.dailyBudgetCopy,
    elements.dailyBudgetProgress,
  );
  const monthlyConfigured = renderBudget(
    budgets?.monthly,
    elements.monthlyBudgetCopy,
    elements.monthlyBudgetProgress,
  );
  const configured = dailyConfigured || monthlyConfigured;

  elements.budgetPanel.classList.toggle('is-unconfigured', !configured);
  elements.budgetStateNote.textContent = configured
    ? 'Informational only'
    : 'No limits configured';
  elements.budgetSetupButton.hidden = configured;
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
    const displayCost =
      number(day.cost_eur_nanos) === 0 ? '€0' : day.display_cost;

    cost.className = 'chart-cost';
    cost.textContent = displayCost;
    bar.max = maximum;
    bar.value = number(day.cost_eur_nanos);
    bar.textContent = displayCost;
    bar.setAttribute(
      'aria-label',
      `${day.date}: ${displayCost}, ${integer(day.turns)} turns`,
    );
    label.className = 'chart-day';
    label.textContent = shortDate(day.date);

    item.append(cost, bar, label);
    elements.sevenDayChart.append(item);
  }
}

function appendCell(row, value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = value;
  if (className) {
    cell.className = className;
  }
  row.append(cell);
  return cell;
}

function appendLabelCell(row, primary, secondary) {
  const cell = document.createElement('td');
  const primaryLabel = document.createElement('span');
  primaryLabel.className = 'task-primary-label';
  primaryLabel.textContent = primary;
  cell.className = 'task-label-cell';
  cell.append(primaryLabel);

  if (secondary) {
    const secondaryLabel = document.createElement('span');
    secondaryLabel.className = 'task-secondary-label';
    secondaryLabel.textContent = secondary;
    cell.append(secondaryLabel);
  }

  row.append(cell);
  return cell;
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

function taskDisplayLabel(task) {
  const display = String(task?.display_label ?? '').trim();
  const fallback = String(task?.label ?? '').trim();
  return display || fallback || 'Local task';
}

function taskHashLabel(task) {
  const display = taskDisplayLabel(task);
  const fallback = String(task?.label ?? '').trim();
  return fallback && fallback !== display ? fallback : '';
}

function taskSortValue(task, key) {
  switch (key) {
    case 'name':
      return taskDisplayLabel(task).toLocaleLowerCase();
    case 'turns':
      return number(task.turns);
    case 'tokens':
      return number(task.usage?.total_tokens);
    case 'last_active': {
      const parsed = Date.parse(task.last_completed_at ?? '');
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case 'average':
      return number(task.turns) > 0
        ? number(task.cost_eur_nanos) / number(task.turns)
        : 0;
    case 'share':
    case 'cost':
    default:
      return number(task.cost_eur_nanos);
  }
}

function compareTasks(left, right) {
  const leftValue = taskSortValue(left, taskSort.key);
  const rightValue = taskSortValue(right, taskSort.key);
  let result;

  if (typeof leftValue === 'string' && typeof rightValue === 'string') {
    result = leftValue.localeCompare(rightValue);
  } else {
    result = leftValue - rightValue;
  }
  if (result === 0) {
    result = taskDisplayLabel(left).localeCompare(taskDisplayLabel(right));
  }
  return taskSort.direction === 'asc' ? result : -result;
}

function updateTaskControls() {
  for (const button of elements.taskScopeButtons) {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.taskScope === currentTaskScope),
    );
  }

  for (const button of elements.taskSortButtons) {
    const column = button.closest('th');
    const selected = button.dataset.taskSort === taskSort.key;
    const indicator = button.querySelector('.sort-indicator');
    column.setAttribute(
      'aria-sort',
      selected
        ? taskSort.direction === 'asc'
          ? 'ascending'
          : 'descending'
        : 'none',
    );
    indicator.textContent = selected
      ? taskSort.direction === 'asc'
        ? '↑'
        : '↓'
      : '';
  }
}

function renderTaskShareCell(row, task, totalCost) {
  const cell = document.createElement('td');
  const copy = document.createElement('span');
  const progress = document.createElement('progress');
  const share =
    totalCost > 0 ? (number(task.cost_eur_nanos) / totalCost) * 100 : 0;
  const displayShare = percentage(share);

  cell.className = 'task-share-cell';
  copy.textContent = displayShare;
  progress.max = 100;
  progress.value = Math.min(100, Math.max(0, share));
  progress.textContent = displayShare;
  progress.setAttribute(
    'aria-label',
    `${taskDisplayLabel(task)}: ${displayShare} of ${TASK_SCOPE_LABELS[currentTaskScope]} spending`,
  );
  cell.append(copy, progress);
  row.append(cell);
}

function renderTasks() {
  const tasks = array(currentTaskScopes[currentTaskScope]);
  const query = elements.taskSearch.value.trim().toLocaleLowerCase();
  const totalCost = tasks.reduce(
    (total, task) => total + number(task.cost_eur_nanos),
    0,
  );
  const visible = tasks
    .filter((task) => {
      if (!query) {
        return true;
      }
      return [taskDisplayLabel(task), task.label, task.key]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    })
    .sort(compareTasks);

  updateTaskControls();
  elements.tasksBody.replaceChildren();
  const scopeLabel = TASK_SCOPE_LABELS[currentTaskScope];
  elements.taskCount.textContent = query
    ? `${integer(visible.length)} of ${integer(tasks.length)} tasks · ${scopeLabel}`
    : `${integer(tasks.length)} ${tasks.length === 1 ? 'task' : 'tasks'} · ${scopeLabel}`;

  if (visible.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 7;
    cell.textContent = query
      ? 'No tasks match this search'
      : `No recorded spending for ${scopeLabel.toLocaleLowerCase()}`;
    row.append(cell);
    elements.tasksBody.append(row);
    return;
  }

  for (const task of visible) {
    const row = document.createElement('tr');
    const turns = number(task.turns);
    const average = turns > 0 ? number(task.cost_eur_nanos) / turns : 0;

    row.dataset.taskKey = String(task.key ?? '');
    appendLabelCell(row, taskDisplayLabel(task), taskHashLabel(task));
    renderTaskShareCell(row, task, totalCost);
    appendCell(row, integer(turns));
    appendCell(row, integer(task.usage?.total_tokens));
    appendCell(
      row,
      task.last_completed_at
        ? localDateTime(task.last_completed_at, currentTimeZone)
        : '—',
      'task-last-active',
    );
    appendCell(row, formatEuroNanos(average));
    appendCell(
      row,
      task.display_cost ?? formatEuroNanos(task.cost_eur_nanos),
      'task-cost',
    );
    elements.tasksBody.append(row);
  }
}

function recentDisplayLabel(turn) {
  return (
    String(turn?.display_task_label ?? '').trim() ||
    String(turn?.task_label ?? '').trim() ||
    'Local task'
  );
}

function recentSecondaryLabel(turn) {
  const display = recentDisplayLabel(turn);
  const taskLabel = String(turn?.task_label ?? '').trim();
  return taskLabel && taskLabel !== display ? taskLabel : '';
}

function renderRecent(turns, timeZone) {
  currentRecentTurns = array(turns);
  elements.recentBody.replaceChildren();
  if (currentRecentTurns.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 6;
    cell.textContent = 'No completed turns in the local ledger';
    row.append(cell);
    elements.recentBody.append(row);
    elements.recentToggle.hidden = true;
    return;
  }

  const visibleTurns = recentExpanded
    ? currentRecentTurns
    : currentRecentTurns.slice(0, RECENT_COLLAPSED_LIMIT);
  for (const turn of visibleTurns) {
    const row = document.createElement('tr');
    row.dataset.taskKey = String(turn.task_key ?? '');
    appendCell(row, localDateTime(turn.completed_at, timeZone));
    appendLabelCell(
      row,
      recentDisplayLabel(turn),
      recentSecondaryLabel(turn),
    );
    appendCell(row, String(turn.model ?? 'Unknown'));
    appendCell(row, integer(turn.agent_threads));
    appendCell(row, integer(turn.usage?.total_tokens));
    appendCell(row, turn.display_cost, 'task-cost');
    elements.recentBody.append(row);
  }

  const hiddenCount = Math.max(
    0,
    currentRecentTurns.length - RECENT_COLLAPSED_LIMIT,
  );
  elements.recentToggle.hidden = hiddenCount === 0;
  elements.recentToggle.textContent = recentExpanded
    ? 'Show fewer'
    : `Show ${integer(hiddenCount)} more`;
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
  currentTimeZone = data.timezone ?? 'Europe/Berlin';
  currentTaskScopes = { today: [], seven_days: [], month: [] };
  currentRecentTurns = [];
  elements.timezone.textContent = currentTimeZone;
  elements.refreshed.textContent =
    `Checked ${localDateTime(data.generated_at, currentTimeZone)}`;
  elements.todayCost.textContent = '—';
  elements.todayDetail.textContent = 'No partial totals shown';
  elements.monthCost.textContent = '—';
  elements.monthDetail.textContent = 'No partial totals shown';
  elements.forecastCost.textContent = '—';
  elements.forecastDetail.textContent = 'No partial forecast shown';

  elements.budgetPanel.classList.remove('is-unconfigured');
  elements.budgetStateNote.textContent = 'Unavailable';
  elements.budgetSetupButton.hidden = true;
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
  renderUnavailableTable(elements.tasksBody, 7);
  renderUnavailableTable(elements.recentBody, 6);
  elements.taskCount.textContent = 'Ledger incomplete';
  elements.ledgerCount.textContent = 'Ledger incomplete';
  elements.recentToggle.hidden = true;

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

function snapshotRevision(data) {
  const value =
    data.live?.payload_revision ??
    data.revision ??
    data.data_revision ??
    data.ledger_revision ??
    null;
  return value === null || value === undefined ? '' : String(value);
}

function renderDashboard(data) {
  const revision = snapshotRevision(data);
  if (
    revision &&
    revision === pendingRevision &&
    liveReloadTimer !== null
  ) {
    clearTimeout(liveReloadTimer);
    liveReloadTimer = null;
  }
  if (revision) {
    renderedRevision = revision;
  } else if (pendingRevision) {
    renderedRevision = pendingRevision;
  }
  pendingRevision = '';

  const lowerBound =
    data.complete === false && data.lower_bound?.available === true;
  if (data.complete === false && !lowerBound) {
    renderUnavailable(data);
    return;
  }
  const pendingTurns = lowerBound
    ? Math.max(0, Math.round(number(data.lower_bound?.pending_turns)))
    : 0;
  const todayPendingTurns = lowerBound
    ? Math.max(
        0,
        Math.round(number(data.lower_bound?.today_pending_turns)),
      )
    : 0;
  const monthPendingTurns = lowerBound
    ? Math.max(
        0,
        Math.round(number(data.lower_bound?.month_pending_turns)),
      )
    : 0;
  const costPrefix = lowerBound ? '≥' : '';

  currentTimeZone = data.timezone ?? 'Europe/Berlin';
  elements.timezone.textContent = currentTimeZone;
  elements.refreshed.textContent =
    `Updated ${localDateTime(data.generated_at, currentTimeZone)}`;

  elements.todayCost.textContent =
    `${costPrefix}${data.today?.display_cost ?? '€0.00'}`;
  elements.todayDetail.textContent =
    `${integer(data.today?.turns)} ${lowerBound ? 'known turns' : 'turns'} · ${integer(data.today?.usage?.total_tokens)} tokens${lowerBound ? ` · ${integer(todayPendingTurns)} pending` : ''}`;
  elements.monthCost.textContent =
    `${costPrefix}${data.month?.display_cost ?? '€0.00'}`;
  elements.monthDetail.textContent =
    `${integer(data.month?.turns)} ${lowerBound ? 'known turns' : 'turns'} · ${integer(data.month?.usage?.total_tokens)} tokens${lowerBound ? ` · ${integer(monthPendingTurns)} pending` : ''}`;
  elements.forecastCost.textContent =
    `${costPrefix}${data.budgets?.display_forecast ?? '€0.00'}`;
  elements.forecastDetail.textContent =
    lowerBound
      ? 'Minimum recorded-cost projection'
      : data.budgets?.forecast_percentage === null
      ? 'Recorded-cost projection'
      : `${percentage(data.budgets.forecast_percentage)} of monthly budget`;

  renderBudgetPanel(data.budgets);
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
  const unattributed = data.by_agent?.unattributed;
  const showUnattributed =
    number(unattributed?.turns) > 0 ||
    number(unattributed?.cost_eur_nanos) > 0 ||
    number(unattributed?.usage?.total_tokens) > 0;
  elements.unattributedAgentRow.hidden = !showUnattributed;
  if (showUnattributed) {
    renderAgent(
      unattributed,
      elements.unattributedAgentCost,
      elements.unattributedAgentTokens,
    );
  }

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

  const taskScopes = data.task_scopes ?? {};
  currentTaskScopes = {
    today: array(taskScopes.today),
    seven_days: array(taskScopes.seven_days),
    month: array(taskScopes.month ?? data.by_session),
  };
  renderTasks();
  renderGroupTable(elements.modelsBody, data.by_model ?? [], 'model');
  renderRecent(data.recent_turns ?? [], data.timezone);
  elements.ledgerCount.textContent =
    `${integer(data.records_count)} exact turns${lowerBound ? ` · ${integer(pendingTurns)} pending` : ''}`;

  currentSettings = data.settings;
  const diagnostics = [
    ...(data.settings_diagnostics ?? []),
    ...(data.diagnostics ?? []),
  ];
  if (lowerBound) {
    const knownPending = integer(data.lower_bound?.known_pending_turns);
    const unknownPending = integer(data.lower_bound?.unknown_pending_turns);
    setStatus(
      `Showing a known minimum with ${integer(pendingTurns)} pending turns. ${knownPending} include known usage; ${unknownPending} have no usable total yet.`,
    );
  } else if (diagnostics.length > 0) {
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

function openSettings() {
  fillSettingsForm(currentSettings);
  elements.settingsDialog.showModal();
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

async function loadDashboard(options = {}) {
  const quiet = options.quiet === true;
  const force = options.force === true;
  if (dashboardRequest) {
    dashboardReloadQueued = true;
    dashboardReloadForce ||= force;
    await dashboardRequest;
    return;
  }

  elements.refreshButton.disabled = true;
  if (!quiet) {
    setStatus('Loading local ledger…');
  }
  dashboardRequest = (async () => {
    const response = await fetch(
      force ? '/api/dashboard?refresh=1' : '/api/dashboard',
      {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      },
    );
    if (!response.ok) {
      throw new Error(`Dashboard request failed (${response.status}).`);
    }
    csrfToken = response.headers.get('X-Codex-CSRF-Token') ?? '';
    const data = await response.json();
    renderDashboard(data);
    return data.live;
  })();

  try {
    const liveState = await dashboardRequest;
    if (liveState?.error || liveState?.stale) {
      setLiveStatus('error', 'Stale');
    } else if (liveEvents?.readyState === 1) {
      setLiveStatus('live', 'Live');
    }
  } catch (error) {
    setStatus(error.message, true);
    if (options.source === 'live') {
      pendingRevision = '';
      setLiveStatus('error', 'Update failed');
    }
  } finally {
    dashboardRequest = null;
    elements.refreshButton.disabled = false;
    if (dashboardReloadQueued) {
      const queuedForce = dashboardReloadForce;
      dashboardReloadQueued = false;
      dashboardReloadForce = false;
      queueMicrotask(() => {
        loadDashboard({
          quiet: true,
          source: 'live',
          force: queuedForce,
        });
      });
    }
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
        result.error ||
        result.reason ||
        (result.diagnostics ?? []).join(' ') ||
        'Settings could not be saved.';
      throw new Error(reason);
    }
    currentSettings = result.settings;
    const diagnostics = result.diagnostics ?? [];
    if (diagnostics.length > 0) {
      fillSettingsForm(currentSettings);
      elements.settingsStatus.textContent =
        `Saved with adjustments: ${diagnostics.join(' ')}`;
      await loadDashboard({ source: 'settings' });
      return;
    }
    elements.settingsStatus.textContent = 'Saved locally.';
    await loadDashboard({ source: 'settings' });
    elements.settingsDialog.close();
  } catch (error) {
    elements.settingsStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

function payloadFromEvent(event) {
  try {
    const payload = JSON.parse(event.data);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function payloadRevisionFromEvent(payload) {
  const revision =
    payload?.payload_revision ??
    payload?.data_revision ??
    payload?.ledger_revision ??
    '';
  return String(revision).trim();
}

function scheduleLiveReload(event) {
  const payload = payloadFromEvent(event);
  if (!payload) {
    return;
  }
  const revision = payloadRevisionFromEvent(payload);
  if (payload.type === 'error' || payload.error) {
    setLiveStatus('error', 'Stale · retrying');
    return;
  }
  if (payload.type === 'dirty') {
    setLiveStatus('syncing', 'Updating…');
    return;
  }
  if (payload.type === 'updated') {
    if (payload.stale) {
      setLiveStatus('syncing', 'Updating…');
      return;
    }
  } else if (payload.type === 'current') {
    if (payload.refreshing || payload.stale) {
      setLiveStatus('syncing', 'Updating…');
      return;
    }
  } else {
    return;
  }
  if (
    revision &&
    (revision === renderedRevision || revision === pendingRevision)
  ) {
    setLiveStatus('live', 'Live');
    return;
  }
  if (!revision || revision === '0') {
    return;
  }
  if (revision) {
    pendingRevision = revision;
  }
  if (liveReloadTimer !== null) {
    clearTimeout(liveReloadTimer);
  }
  setLiveStatus('syncing', 'Updating…');
  liveReloadTimer = setTimeout(() => {
    liveReloadTimer = null;
    loadDashboard({ quiet: true, source: 'live' });
  }, 80);
}

function connectLiveUpdates() {
  if (typeof window.EventSource !== 'function') {
    setLiveStatus('manual', 'Manual refresh');
    return;
  }

  liveEvents = new EventSource('/api/events');
  liveEvents.addEventListener('open', () => {
    setLiveStatus('live', 'Live');
  });
  liveEvents.addEventListener('dashboard', scheduleLiveReload);
  liveEvents.addEventListener('error', () => {
    setLiveStatus('reconnecting', 'Reconnecting…');
  });
}

elements.refreshButton.addEventListener('click', () => {
  loadDashboard({ source: 'manual', force: true });
});
elements.settingsButton.addEventListener('click', openSettings);
elements.budgetSetupButton.addEventListener('click', openSettings);
elements.settingsClose.addEventListener('click', () => {
  elements.settingsDialog.close();
});
elements.settingsCancel.addEventListener('click', () => {
  elements.settingsDialog.close();
});
elements.settingsForm.addEventListener('submit', saveSettings);
elements.taskSearch.addEventListener('input', renderTasks);
elements.recentToggle.addEventListener('click', () => {
  recentExpanded = !recentExpanded;
  renderRecent(currentRecentTurns, currentTimeZone);
});

for (const button of elements.taskScopeButtons) {
  button.addEventListener('click', () => {
    const scope = button.dataset.taskScope;
    if (Object.hasOwn(TASK_SCOPE_LABELS, scope)) {
      currentTaskScope = scope;
      renderTasks();
    }
  });
}

for (const button of elements.taskSortButtons) {
  button.addEventListener('click', () => {
    const key = button.dataset.taskSort;
    if (taskSort.key === key) {
      taskSort.direction = taskSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      taskSort = {
        key,
        direction: key === 'name' ? 'asc' : 'desc',
      };
    }
    renderTasks();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadDashboard({
      quiet: true,
      source: 'visibility',
      force: liveEvents?.readyState !== 1,
    });
  }
});
window.addEventListener('beforeunload', () => {
  liveEvents?.close();
});

updateTaskControls();
loadDashboard({ source: 'initial' });
connectLiveUpdates();
