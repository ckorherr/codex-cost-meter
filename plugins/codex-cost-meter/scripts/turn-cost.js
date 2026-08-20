'use strict';

// Portable Stop hook bundled with the Codex Cost Meter plugin.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const PRICING_AS_OF = '2026-08-20';
const EUR_PER_USD = 0.9;
const LEDGER_SCHEMA = 1;
const CACHE_VERSION = 1;
const ANALYSIS_BUDGET_MS = 7_500;
const PRICE_PER_MILLION = {
  'gpt-5.6-sol': {
    input: 5.0,
    cachedInput: 0.5,
    cacheWrite: 6.25,
    output: 30.0,
  },
  'gpt-5.6-terra': {
    input: 2.0,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    output: 12.0,
  },
  'gpt-5.6-luna': {
    input: 0.2,
    cachedInput: 0.02,
    cacheWrite: 0.25,
    output: 1.2,
  },
};

const USAGE_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];

function zeroUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
}

function normalizeUsage(value) {
  const normalized = zeroUsage();
  if (!value || typeof value !== 'object') {
    return normalized;
  }

  for (const key of USAGE_KEYS) {
    const number = Number(value[key] ?? 0);
    normalized[key] = Number.isFinite(number) && number >= 0 ? number : 0;
  }
  return normalized;
}

function addUsage(left, right) {
  const result = zeroUsage();
  for (const key of USAGE_KEYS) {
    result[key] = (left[key] ?? 0) + (right[key] ?? 0);
  }
  return result;
}

function subtractUsage(current, previous) {
  const result = zeroUsage();
  for (const key of USAGE_KEYS) {
    result[key] = Math.max(0, (current[key] ?? 0) - (previous[key] ?? 0));
  }
  return result;
}

function sameUsage(left, right) {
  return USAGE_KEYS.every((key) => (left[key] ?? 0) === (right[key] ?? 0));
}

function isMonotonic(previous, current) {
  return USAGE_KEYS.every((key) => (current[key] ?? 0) >= (previous[key] ?? 0));
}

function hasUsage(usage) {
  return USAGE_KEYS.some((key) => (usage[key] ?? 0) > 0);
}

function parseTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForFileToSettle(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }

  let previousSize = -1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const currentSize = fs.statSync(filePath).size;
    if (currentSize === previousSize) {
      return;
    }
    previousSize = currentSize;
    sleep(75);
  }
}

function resolveTranscriptPath(rawPath) {
  if (!rawPath) {
    return null;
  }
  if (fs.existsSync(rawPath)) {
    return rawPath;
  }

  if (process.platform !== 'win32') {
    const windowsMatch = /^([A-Za-z]):[\\/](.*)$/.exec(rawPath);
    if (windowsMatch) {
      const converted = `/mnt/${windowsMatch[1].toLowerCase()}/${windowsMatch[2].replaceAll('\\', '/')}`;
      if (fs.existsSync(converted)) {
        return converted;
      }
    }
  } else {
    const wslMatch = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(rawPath);
    if (wslMatch) {
      const converted = `${wslMatch[1].toUpperCase()}:\\${wslMatch[2].replaceAll('/', '\\')}`;
      if (fs.existsSync(converted)) {
        return converted;
      }
    }
  }

  return rawPath;
}

function findSessionsRoot(transcriptPath) {
  let current = path.dirname(path.resolve(transcriptPath));
  while (true) {
    if (path.basename(current).toLowerCase() === 'sessions') {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function listJsonlFiles(root) {
  const files = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function readFirstLine(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const chunks = [];
  let total = 0;

  try {
    while (total < 4 * 1024 * 1024) {
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      const piece = Buffer.from(chunk.subarray(0, bytesRead));
      const newline = piece.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(piece.subarray(0, newline));
        break;
      }
      chunks.push(piece);
      total += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }

  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
}

function readSessionMetadata(filePath) {
  try {
    const firstLine = readFirstLine(filePath);
    if (!firstLine) {
      return null;
    }
    const record = JSON.parse(firstLine);
    if (record.type !== 'session_meta') {
      return null;
    }

    const payload = record.payload ?? {};
    const threadId = payload.id ?? null;
    if (!threadId) {
      return null;
    }

    const spawn = payload.source?.subagent?.thread_spawn;
    return {
      filePath,
      threadId,
      sessionId: payload.session_id ?? threadId,
      forkedFromId: payload.forked_from_id ?? null,
      parentThreadId: spawn?.parent_thread_id ?? null,
      depth: Number(spawn?.depth ?? 0),
      isSubagent: Boolean(spawn),
      startedMs: parseTimestamp(payload.timestamp ?? record.timestamp),
    };
  } catch {
    return null;
  }
}

function buildSessionFileIndex(sessionsRoot) {
  const files = listJsonlFiles(sessionsRoot);
  const byThreadId = new Map();
  const threadIdPattern =
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

  for (const filePath of files) {
    const match = threadIdPattern.exec(path.basename(filePath));
    if (!match) {
      continue;
    }
    const candidates = byThreadId.get(match[1]) ?? [];
    candidates.push(filePath);
    byThreadId.set(match[1], candidates);
  }
  return { files, byThreadId };
}

function findChildMetadata(fileIndex, threadId, parentThreadId, sessionId) {
  const indexed = fileIndex.byThreadId.get(threadId);
  const candidates =
    indexed ??
    fileIndex.files.filter((filePath) =>
      path.basename(filePath).endsWith(`-${threadId}.jsonl`),
    );

  for (const filePath of candidates) {
    const metadata = readSessionMetadata(filePath);
    if (
      metadata?.threadId === threadId &&
      metadata.parentThreadId === parentThreadId &&
      metadata.sessionId === sessionId
    ) {
      return metadata;
    }
  }
  return null;
}

function parseRollout(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const taskStarts = [];
  const taskCompletes = [];
  const turnModels = new Map();
  const tokenEvents = [];
  const activities = [];
  let firstMetadata = null;
  let currentModel = null;
  let lastTimestampMs = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // The final JSONL record can still be in flight while Stop executes.
      continue;
    }

    const payload = record.payload ?? {};
    const timestampMs = parseTimestamp(record.timestamp);
    lastTimestampMs = Math.max(lastTimestampMs, timestampMs);

    if (!firstMetadata && record.type === 'session_meta') {
      const spawn = payload.source?.subagent?.thread_spawn;
      firstMetadata = {
        threadId: payload.id ?? null,
        sessionId: payload.session_id ?? payload.id ?? null,
        forkedFromId: payload.forked_from_id ?? null,
        parentThreadId: spawn?.parent_thread_id ?? null,
        isSubagent: Boolean(spawn),
        startedMs: parseTimestamp(payload.timestamp ?? record.timestamp),
      };
    }

    if (record.type === 'turn_context') {
      if (payload.model) {
        currentModel = payload.model;
      }
      if (payload.turn_id && payload.model) {
        turnModels.set(payload.turn_id, payload.model);
      }
      continue;
    }

    if (record.type !== 'event_msg') {
      continue;
    }

    if (payload.type === 'task_started' && payload.turn_id) {
      taskStarts.push({
        id: payload.turn_id,
        index,
        timestampMs,
        startedMs: Number(payload.started_at ?? 0) * 1000 || timestampMs,
      });
      continue;
    }

    if (payload.type === 'task_complete' && payload.turn_id) {
      taskCompletes.push({
        id: payload.turn_id,
        index,
        timestampMs,
      });
      continue;
    }

    if (payload.type === 'model_rerouted') {
      currentModel = payload.to_model ?? payload.toModel ?? currentModel;
      continue;
    }

    if (payload.type === 'token_count' && payload.info?.total_token_usage) {
      tokenEvents.push({
        index,
        timestampMs,
        total: normalizeUsage(payload.info.total_token_usage),
        last: normalizeUsage(payload.info.last_token_usage),
        model: currentModel,
      });
      continue;
    }

    if (
      payload.type === 'sub_agent_activity' &&
      payload.agent_thread_id &&
      ['started', 'interacted', 'interrupted'].includes(payload.kind)
    ) {
      activities.push({
        index,
        timestampMs,
        occurredAtMs: Number(payload.occurred_at_ms ?? timestampMs),
        childThreadId: payload.agent_thread_id,
        kind: payload.kind,
      });
    }
  }

  const taskIds = new Set(taskStarts.map((task) => task.id));
  for (const task of taskStarts) {
    const completion = taskCompletes.find(
      (candidate) => candidate.id === task.id && candidate.index > task.index,
    );
    task.endIndex = completion?.index ?? Number.POSITIVE_INFINITY;
    task.completed = Boolean(completion);
    task.completedMs = completion?.timestampMs ?? null;
    task.model = turnModels.get(task.id) ?? null;
  }

  return {
    filePath,
    firstMetadata,
    taskStarts,
    taskIds,
    tokenEvents,
    activities,
    lastTimestampMs,
  };
}

function cachePathFor(cacheDirectory, threadId) {
  const safeThreadId = String(threadId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(cacheDirectory, `${safeThreadId}.json`);
}

function serializeParsedRollout(parsed, stat) {
  return {
    version: CACHE_VERSION,
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    parsed: {
      firstMetadata: parsed.firstMetadata,
      taskStarts: parsed.taskStarts.map((task) => ({
        ...task,
        endIndex: Number.isFinite(task.endIndex) ? task.endIndex : null,
      })),
      tokenEvents: parsed.tokenEvents,
      activities: parsed.activities,
      lastTimestampMs: parsed.lastTimestampMs,
    },
  };
}

function hydrateParsedRollout(filePath, value) {
  const taskStarts = (value.taskStarts ?? []).map((task) => ({
    ...task,
    endIndex:
      task.endIndex === null || task.endIndex === undefined
        ? Number.POSITIVE_INFINITY
        : task.endIndex,
  }));
  return {
    filePath,
    firstMetadata: value.firstMetadata ?? null,
    taskStarts,
    taskIds: new Set(taskStarts.map((task) => task.id)),
    tokenEvents: value.tokenEvents ?? [],
    activities: value.activities ?? [],
    lastTimestampMs: value.lastTimestampMs ?? 0,
  };
}

function parseRolloutCached(filePath, threadId, cacheDirectory) {
  const stat = fs.statSync(filePath);
  const cachePath = cachePathFor(cacheDirectory, threadId);

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (
      cached.version === CACHE_VERSION &&
      cached.size === stat.size &&
      cached.mtimeMs === Math.trunc(stat.mtimeMs)
    ) {
      return hydrateParsedRollout(filePath, cached.parsed ?? {});
    }
  } catch {
    // A missing, stale, or partial cache is rebuilt below.
  }

  const parsed = parseRollout(filePath);
  try {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify(serializeParsedRollout(parsed, stat)),
      'utf8',
    );
  } catch {
    // Cache failures must not block the hook.
  }
  return parsed;
}

function tokenBefore(parsed, index) {
  let result = null;
  for (const event of parsed.tokenEvents) {
    if (event.index >= index) {
      break;
    }
    result = event;
  }
  return result;
}

function normalizeModel(model) {
  if (!model) {
    return null;
  }
  if (model === 'gpt-5.6') {
    return 'gpt-5.6-sol';
  }
  for (const known of Object.keys(PRICE_PER_MILLION)) {
    if (model === known || model.startsWith(`${known}-`)) {
      return known;
    }
  }
  return model;
}

function buildAccounting(parsed, ownedTaskStarts, branchIndex, defaultModel, warnings) {
  const ownedTaskIds = new Set(ownedTaskStarts.map((task) => task.id));
  const tasks = new Map(
    ownedTaskStarts.map((task) => [
      task.id,
      {
        ...task,
        model: normalizeModel(task.model ?? defaultModel),
        rootTurnId: null,
        usage: zeroUsage(),
        cost: 0,
      },
    ]),
  );

  const markers = [];
  for (const task of ownedTaskStarts) {
    markers.push({ type: 'start', index: task.index, taskId: task.id });
    if (Number.isFinite(task.endIndex)) {
      markers.push({ type: 'complete', index: task.endIndex, taskId: task.id });
    }
  }
  for (const event of parsed.tokenEvents) {
    if (event.index > branchIndex) {
      markers.push({ type: 'token', index: event.index, event });
    }
  }
  markers.sort((left, right) => left.index - right.index);

  const baseline = tokenBefore(parsed, branchIndex)?.total ?? zeroUsage();
  let previous = baseline;
  let activeTaskId = null;
  const segments = [];
  let exact = true;

  for (const marker of markers) {
    if (marker.type === 'start') {
      activeTaskId = marker.taskId;
      continue;
    }

    if (marker.type === 'complete') {
      if (activeTaskId === marker.taskId) {
        activeTaskId = null;
      }
      continue;
    }

    const event = marker.event;
    if (sameUsage(previous, event.total)) {
      continue;
    }

    let delta;
    if (isMonotonic(previous, event.total)) {
      delta = subtractUsage(event.total, previous);
    } else {
      delta = hasUsage(event.last) ? event.last : event.total;
      warnings.push(`Token counter reset in ${path.basename(parsed.filePath)}.`);
      exact = false;
    }
    previous = event.total;

    if (!hasUsage(delta)) {
      continue;
    }

    const task = activeTaskId ? tasks.get(activeTaskId) : null;
    const model = normalizeModel(event.model ?? task?.model ?? defaultModel);
    const segment = {
      taskId: activeTaskId,
      timestampMs: event.timestampMs,
      usage: delta,
      model,
    };
    segments.push(segment);

    if (task) {
      task.usage = addUsage(task.usage, delta);
    } else {
      warnings.push(`Unassigned token usage in ${path.basename(parsed.filePath)}.`);
      exact = false;
    }
  }

  return {
    parsed,
    branchIndex,
    ownedTaskIds,
    tasks,
    segments,
    exact,
  };
}

function findActiveTask(accounting, eventIndex) {
  let match = null;
  for (const task of accounting.tasks.values()) {
    if (
      task.index <= eventIndex &&
      eventIndex <= task.endIndex &&
      (!match || task.index > match.index)
    ) {
      match = task;
    }
  }
  return match;
}

function selectChildBranch(parentParsed, childParsed, spawnActivity) {
  const candidates = childParsed.taskStarts.filter(
    (task) => !parentParsed.taskIds.has(task.id),
  );
  const pool = candidates.length > 0 ? candidates : childParsed.taskStarts;
  if (pool.length === 0) {
    return null;
  }

  return pool.reduce((best, candidate) => {
    const distance = Math.abs(candidate.startedMs - spawnActivity.occurredAtMs);
    if (!best || distance < best.distance) {
      return { task: candidate, distance };
    }
    return best;
  }, null)?.task;
}

function mapChildTasksToRoot(parentAccounting, childAccounting, childThreadId, warnings) {
  const ownedStarts = [...childAccounting.tasks.values()].sort(
    (left, right) => left.index - right.index,
  );
  const activities = parentAccounting.parsed.activities.filter(
    (activity) =>
      activity.childThreadId === childThreadId &&
      activity.index > parentAccounting.branchIndex &&
      activity.kind !== 'interrupted',
  );
  const usedActivities = new Set();
  let exact = true;

  for (let taskIndex = 0; taskIndex < ownedStarts.length; taskIndex += 1) {
    const task = ownedStarts[taskIndex];
    const preferredKind = taskIndex === 0 ? 'started' : 'interacted';
    const preferred = activities.filter(
      (activity, index) =>
        activity.kind === preferredKind && !usedActivities.has(index),
    );
    const fallback = activities.filter(
      (_activity, index) => !usedActivities.has(index),
    );
    const pool = preferred.length > 0 ? preferred : fallback;

    let best = null;
    for (const activity of pool) {
      const originalIndex = activities.indexOf(activity);
      const distance = Math.abs(activity.occurredAtMs - task.startedMs);
      if (!best || distance < best.distance) {
        best = { activity, originalIndex, distance };
      }
    }

    if (!best || best.distance > 10_000) {
      warnings.push(`Could not map subagent task ${task.id} to its parent turn.`);
      exact = false;
      continue;
    }

    usedActivities.add(best.originalIndex);
    const parentTask = findActiveTask(parentAccounting, best.activity.index);
    if (!parentTask?.rootTurnId) {
      warnings.push(`Could not resolve the root turn for subagent task ${task.id}.`);
      exact = false;
      continue;
    }
    task.rootTurnId = parentTask.rootTurnId;
  }

  for (let index = 0; index < ownedStarts.length; index += 1) {
    const task = ownedStarts[index];
    if (task.completed) {
      continue;
    }
    const nextStartedMs =
      ownedStarts[index + 1]?.startedMs ?? Number.POSITIVE_INFINITY;
    const wasInterrupted = parentAccounting.parsed.activities.some(
      (activity) =>
        activity.childThreadId === childThreadId &&
        activity.kind === 'interrupted' &&
        activity.occurredAtMs >= task.startedMs &&
        activity.occurredAtMs < nextStartedMs,
    );
    if (!wasInterrupted) {
      warnings.push(
        'At least one subagent task was still open; its values are cost-so-far.',
      );
      exact = false;
    }
  }
  return exact;
}

function usageForSegments(segments) {
  return segments.reduce(
    (total, segment) => addUsage(total, segment.usage),
    zeroUsage(),
  );
}

function priceSegments(segments) {
  let cost = 0;
  const models = new Set();
  const unpricedModels = new Set();

  for (const segment of segments) {
    const model = normalizeModel(segment.model);
    const rates = PRICE_PER_MILLION[model];
    if (!rates) {
      unpricedModels.add(model ?? 'unknown');
      continue;
    }

    models.add(model);
    const usage = segment.usage;
    const regularInput = Math.max(
      0,
      usage.input_tokens -
        usage.cached_input_tokens -
        usage.cache_write_input_tokens,
    );
    cost +=
      (regularInput * rates.input +
        usage.cached_input_tokens * rates.cachedInput +
        usage.cache_write_input_tokens * rates.cacheWrite +
        usage.output_tokens * rates.output) /
      1_000_000;
  }

  return {
    cost,
    models,
    unpricedModels,
  };
}

function formatTokens(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatCompactTokens(value) {
  const rounded = Math.round(value);
  if (rounded < 1_000_000) {
    return formatTokens(rounded);
  }

  const divisor = rounded >= 1_000_000_000 ? 1_000_000_000 : 1_000_000;
  const suffix = divisor === 1_000_000_000 ? 'B' : 'M';
  const compact = (rounded / divisor)
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1');
  return `${compact}${suffix}`;
}

function eurosFromUsd(value) {
  return value * EUR_PER_USD;
}

function eurosToNanos(value) {
  return Math.round(value * 1_000_000_000);
}

function nanosToEuros(value) {
  return Number(value ?? 0) / 1_000_000_000;
}

function formatEuroCost(value) {
  if (value < 0.01) {
    return `€${value.toFixed(5)}`;
  }
  if (value < 1) {
    return `€${value.toFixed(4)}`;
  }
  return `€${value.toFixed(2)}`;
}

function noBreak(value) {
  return String(value).replaceAll(' ', '\u00a0');
}

function usageNowMs(fallbackMs) {
  const override = Date.parse(process.env.CODEX_TURN_COST_NOW ?? '');
  if (Number.isFinite(override)) {
    return override;
  }
  return Number.isFinite(fallbackMs) ? fallbackMs : Date.now();
}

function usageTimeZone() {
  const configured = process.env.CODEX_TURN_COST_TIME_ZONE;
  if (configured) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: configured }).format();
      return configured;
    } catch {
      // Fall through to the operating system timezone.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function usagePeriod(timestampMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    localDate,
    month: `${parts.year}-${parts.month}`,
    monthLabel: new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'short',
    }).format(new Date(timestampMs)),
  };
}

function pluginDataRoot(codexHome) {
  const configured = process.env.PLUGIN_DATA?.trim();
  return configured ? path.resolve(configured) : codexHome;
}

function safeLedgerName(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
}

function readLedgerRecords(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const records = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (
        record?.schema === LEDGER_SCHEMA &&
        record.root_thread_id &&
        record.turn_id &&
        Number.isFinite(record.cost_eur_nanos)
      ) {
        records.push(record);
      }
    } catch {
      // Ignore an invalid line without losing the other recorded turns.
    }
  }
  return records;
}

function aggregateLedgerMonth(monthDirectory, localDate) {
  const recordsByTurn = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(monthDirectory, { withFileTypes: true });
  } catch {
    return { todayCostEur: 0, monthCostEur: 0 };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    for (const record of readLedgerRecords(path.join(monthDirectory, entry.name))) {
      const key = `${record.root_thread_id}\u0000${record.turn_id}`;
      recordsByTurn.set(key, record);
    }
  }

  let todayNanos = 0;
  let monthNanos = 0;
  for (const record of recordsByTurn.values()) {
    monthNanos += record.cost_eur_nanos;
    if (record.local_date === localDate) {
      todayNanos += record.cost_eur_nanos;
    }
  }
  return {
    todayCostEur: nanosToEuros(todayNanos),
    monthCostEur: nanosToEuros(monthNanos),
  };
}

function updateUsageLedger(result) {
  const context = result.ledgerContext;
  const nowMs = usageNowMs(context.completedAtMs);
  const timeZone = usageTimeZone();
  const period = usagePeriod(nowMs, timeZone);
  const monthDirectory = path.join(
    context.dataRoot,
    'usage',
    period.month,
  );
  const ledgerPath = path.join(
    monthDirectory,
    `${safeLedgerName(context.rootThreadId)}.jsonl`,
  );
  fs.mkdirSync(monthDirectory, { recursive: true });

  const record = {
    schema: LEDGER_SCHEMA,
    root_thread_id: context.rootThreadId,
    session_id: context.rootSessionId,
    turn_id: context.turnId,
    recorded_at: new Date(nowMs).toISOString(),
    local_date: period.localDate,
    timezone: timeZone,
    model: result.model,
    usage: result.turn.usage,
    agent_threads: result.turnAgentThreads,
    pricing_as_of: result.pricingAsOf,
    cost_usd_nanos: Math.round(result.turn.cost * 1_000_000_000),
    eur_per_usd: EUR_PER_USD,
    cost_eur_nanos: eurosToNanos(eurosFromUsd(result.turn.cost)),
  };

  const exists = readLedgerRecords(ledgerPath).some(
    (candidate) =>
      candidate.root_thread_id === record.root_thread_id &&
      candidate.turn_id === record.turn_id,
  );
  if (!exists) {
    fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  return {
    ...aggregateLedgerMonth(monthDirectory, period.localDate),
    localDate: period.localDate,
    month: period.month,
    monthLabel: period.monthLabel,
    timeZone,
    ledgerPath,
    recorded: !exists,
  };
}

function modelLabel(models, fallback) {
  const values = [...models].sort();
  if (values.length === 1) {
    return values[0];
  }
  if (values.length > 1) {
    return `${values.length} models`;
  }
  return normalizeModel(fallback) ?? 'unknown model';
}

function analyze(hookInput) {
  const analysisStarted = performance.now();
  const warnings = [];
  let complete = true;
  let warming = false;
  const transcriptPath = resolveTranscriptPath(hookInput.transcript_path);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    throw new Error('The current transcript could not be found.');
  }

  const sessionsRoot = findSessionsRoot(transcriptPath);
  if (!sessionsRoot) {
    throw new Error('The Codex sessions directory could not be located.');
  }
  const codexHome = path.dirname(sessionsRoot);
  const dataRoot = pluginDataRoot(codexHome);
  const cacheDirectory = path.join(
    dataRoot,
    'hook-cache',
  );
  const rootMetadata = readSessionMetadata(transcriptPath);
  if (!rootMetadata) {
    throw new Error('The current session metadata could not be read.');
  }
  if (rootMetadata.isSubagent) {
    return { skip: true };
  }
  const rootParsed = parseRolloutCached(
    transcriptPath,
    rootMetadata.threadId,
    cacheDirectory,
  );

  const rootThreadId =
    rootParsed.firstMetadata?.threadId ?? hookInput.session_id ?? null;
  const rootSessionId =
    rootParsed.firstMetadata?.sessionId ?? rootThreadId ?? hookInput.session_id;
  if (!rootThreadId) {
    throw new Error('The current thread id could not be determined.');
  }

  let rootBranchIndex = -1;
  let rootOwnedTaskStarts = rootParsed.taskStarts;
  if (rootParsed.firstMetadata?.forkedFromId) {
    const forkStartedMs = rootParsed.firstMetadata.startedMs;
    const firstOwnedTask = rootParsed.taskStarts.find(
      (task) => task.startedMs >= forkStartedMs - 1_000,
    );
    if (!firstOwnedTask) {
      throw new Error('The branch point for this forked task could not be found.');
    }
    rootBranchIndex = firstOwnedTask.index;
    rootOwnedTaskStarts = rootParsed.taskStarts.filter(
      (task) => task.index >= rootBranchIndex,
    );
  }

  const rootAccounting = buildAccounting(
    rootParsed,
    rootOwnedTaskStarts,
    rootBranchIndex,
    hookInput.model,
    warnings,
  );
  complete &&= rootAccounting.exact;
  for (const task of rootAccounting.tasks.values()) {
    task.rootTurnId = task.id;
  }

  const sessionFileIndex = buildSessionFileIndex(sessionsRoot);
  const accountingByThread = new Map([[rootThreadId, rootAccounting]]);
  const pending = [rootThreadId];
  const visited = new Set([rootThreadId]);

  while (pending.length > 0) {
    const parentThreadId = pending.shift();
    const parentAccounting = accountingByThread.get(parentThreadId);
    if (!parentAccounting) {
      continue;
    }

    const spawnActivities = parentAccounting.parsed.activities.filter(
      (activity) =>
        activity.kind === 'started' &&
        activity.index > parentAccounting.branchIndex,
    );

    for (const spawnActivity of spawnActivities) {
      if (performance.now() - analysisStarted > ANALYSIS_BUDGET_MS) {
        warnings.push(
          'The analysis time budget was reached before every subagent could be included.',
        );
        complete = false;
        warming = true;
        pending.length = 0;
        break;
      }

      const childThreadId = spawnActivity.childThreadId;
      if (visited.has(childThreadId)) {
        continue;
      }

      const childMetadata = findChildMetadata(
        sessionFileIndex,
        childThreadId,
        parentThreadId,
        rootSessionId,
      );
      if (!childMetadata) {
        warnings.push(`Missing or mismatched rollout for subagent ${childThreadId}.`);
        complete = false;
        continue;
      }

      try {
        if (Date.now() - fs.statSync(childMetadata.filePath).mtimeMs < 2_000) {
          waitForFileToSettle(childMetadata.filePath);
        }
      } catch {
        // A later read reports a useful diagnostic if the file disappeared.
      }
      const childParsed = parseRolloutCached(
        childMetadata.filePath,
        childThreadId,
        cacheDirectory,
      );
      if (performance.now() - analysisStarted > ANALYSIS_BUDGET_MS) {
        warnings.push(
          'The analysis time budget was reached before every subagent could be included.',
        );
        complete = false;
        warming = true;
        pending.length = 0;
        break;
      }
      const branchTask = selectChildBranch(
        parentAccounting.parsed,
        childParsed,
        spawnActivity,
      );
      if (!branchTask) {
        warnings.push(`Could not find the branch point for subagent ${childThreadId}.`);
        complete = false;
        continue;
      }

      const ownedTaskStarts = childParsed.taskStarts.filter(
        (task) => task.index >= branchTask.index,
      );
      const childAccounting = buildAccounting(
        childParsed,
        ownedTaskStarts,
        branchTask.index,
        hookInput.model,
        warnings,
      );
      complete &&= childAccounting.exact;
      const childMappingExact = mapChildTasksToRoot(
        parentAccounting,
        childAccounting,
        childThreadId,
        warnings,
      );
      complete = complete && childMappingExact;

      accountingByThread.set(childThreadId, childAccounting);
      visited.add(childThreadId);
      pending.push(childThreadId);
    }
  }

  const sessionSegments = [];
  const turnSegments = [];
  const currentTurnId = hookInput.turn_id;
  const currentRootTask = rootAccounting.tasks.get(currentTurnId);
  const turnAgentThreadIds = new Set();

  for (const [threadId, accounting] of accountingByThread.entries()) {
    for (const segment of accounting.segments) {
      sessionSegments.push(segment);
      const task = segment.taskId ? accounting.tasks.get(segment.taskId) : null;
      if (task?.rootTurnId === currentTurnId) {
        turnSegments.push(segment);
        if (threadId !== rootThreadId) {
          turnAgentThreadIds.add(threadId);
        }
      }
    }
  }

  const turnUsage = usageForSegments(turnSegments);
  const sessionUsage = usageForSegments(sessionSegments);
  const turnPricing = priceSegments(turnSegments);
  const sessionPricing = priceSegments(sessionSegments);
  const unpricedModels = new Set([
    ...turnPricing.unpricedModels,
    ...sessionPricing.unpricedModels,
  ]);

  if (unpricedModels.size > 0) {
    warnings.push(`No hardcoded price for: ${[...unpricedModels].join(', ')}.`);
  }

  return {
    skip: false,
    pricingAsOf: PRICING_AS_OF,
    model: modelLabel(sessionPricing.models, hookInput.model),
    agentThreads: Math.max(0, accountingByThread.size - 1),
    turnAgentThreads: turnAgentThreadIds.size,
    complete,
    warming,
    priced: unpricedModels.size === 0,
    turn: {
      usage: turnUsage,
      cost: turnPricing.cost,
      costEur: eurosFromUsd(turnPricing.cost),
    },
    session: {
      usage: sessionUsage,
      cost: sessionPricing.cost,
      costEur: eurosFromUsd(sessionPricing.cost),
    },
    ledgerContext: {
      dataRoot,
      rootThreadId,
      rootSessionId,
      turnId: currentTurnId,
      completedAtMs:
        currentRootTask?.completedMs ??
        currentRootTask?.startedMs ??
        rootParsed.lastTimestampMs,
    },
    warnings: [...new Set(warnings)],
  };
}

function buildSystemMessage(result) {
  if (!result.complete) {
    return result.warming
      ? 'Usage: warming agent-history cache — exact totals will appear on a later turn.'
      : 'Usage unavailable — see hook diagnostics.';
  }

  const turnCost = result.priced
    ? formatEuroCost(result.turn.costEur)
    : 'cost unavailable';
  const sessionCost = result.priced
    ? formatEuroCost(result.session.costEur)
    : 'cost unavailable';
  const primaryGroups = [
    `Turn + agents ${formatCompactTokens(result.turn.usage.total_tokens)} tok · ${turnCost}`,
    `Session + agents ${formatCompactTokens(result.session.usage.total_tokens)} tok · ${sessionCost}`,
  ];
  const secondaryGroups = [];

  if (result.ledger) {
    secondaryGroups.push(`Today ${formatEuroCost(result.ledger.todayCostEur)}`);
    secondaryGroups.push(
      `${result.ledger.monthLabel} ${formatEuroCost(result.ledger.monthCostEur)}`,
    );
  }
  secondaryGroups.push(result.model);

  if (result.warnings.length > 0) {
    secondaryGroups.push('See diagnostics');
  }
  return (
    primaryGroups.map(noBreak).join(' │ ') +
    '  \n' +
    secondaryGroups.map(noBreak).join(' │ ')
  );
}

function main() {
  const rawInput = fs.readFileSync(0, 'utf8').trim();
  if (!rawInput) {
    throw new Error('The hook received no input.');
  }

  const hookInput = JSON.parse(rawInput);
  waitForFileToSettle(resolveTranscriptPath(hookInput.transcript_path));
  const result = analyze(hookInput);
  const debug = process.argv.includes('--debug-json');

  if (result.skip) {
    return;
  }

  if (!debug && result.complete && result.priced) {
    try {
      result.ledger = updateUsageLedger(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`Usage ledger could not be updated: ${message}`);
    }
  }

  if (result.warnings.length > 0) {
    process.stderr.write(
      `turn-cost hook diagnostics:\n- ${result.warnings.join('\n- ')}\n`,
    );
  }

  if (debug) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      systemMessage: buildSystemMessage(result),
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--debug-json')) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `${JSON.stringify({
        continue: true,
        systemMessage: 'Usage unavailable for this turn.',
      })}\n`,
    );
    process.stderr.write(`turn-cost hook: ${message}\n`);
  }
}
