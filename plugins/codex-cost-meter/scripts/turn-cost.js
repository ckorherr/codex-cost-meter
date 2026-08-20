'use strict';

// Portable Stop hook bundled with the Codex Cost Meter plugin.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');
const {
  readSessionMetadata,
  findChildSessionMetadata,
} = require('../lib/session-index');
const {
  appendLedgerGap,
  appendLedgerRecord,
  budgetState,
  buildHookRollup,
  crossedBudgetThresholds,
  loadSettings,
  projectMonthEndNanos,
  resolveDataRoot,
} = require('../lib/runtime-data');

const PRICING_AS_OF = '2026-08-20';
const EUR_PER_USD = 0.9;
const CACHE_VERSION = 5;
const ANALYSIS_BUDGET_MS = 7_500;
const INITIAL_COLD_WINDOW_BYTES = 512 * 1024;
const MAX_COLD_WINDOW_BYTES = 64 * 1024 * 1024;
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

function exactUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const normalized = {};
  for (const key of USAGE_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      return null;
    }
    normalized[key] = value[key];
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

function emptyParsedRollout(filePath) {
  return {
    filePath,
    firstMetadata: null,
    taskStarts: [],
    taskIds: new Set(),
    tokenEvents: [],
    invalidTokenEvents: [],
    activities: [],
    lastTimestampMs: 0,
    currentModel: null,
    turnModels: new Map(),
    nextLineIndex: 0,
    offset: 0,
  };
}

function applyRolloutRecord(parsed, record, index) {
  const payload = record.payload ?? {};
  const timestampMs = parseTimestamp(record.timestamp);
  parsed.lastTimestampMs = Math.max(parsed.lastTimestampMs, timestampMs);

  if (!parsed.firstMetadata && record.type === 'session_meta') {
    const spawn = payload.source?.subagent?.thread_spawn;
    parsed.firstMetadata = {
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
      parsed.currentModel = payload.model;
    }
    if (payload.turn_id && payload.model) {
      parsed.turnModels.set(payload.turn_id, payload.model);
      for (let taskIndex = parsed.taskStarts.length - 1; taskIndex >= 0; taskIndex -= 1) {
        const task = parsed.taskStarts[taskIndex];
        if (task.id === payload.turn_id) {
          task.model = payload.model;
          break;
        }
      }
    }
    return;
  }

  if (record.type !== 'event_msg') {
    return;
  }

  if (payload.type === 'task_started' && payload.turn_id) {
    parsed.taskStarts.push({
      id: payload.turn_id,
      index,
      timestampMs,
      startedMs: Number(payload.started_at ?? 0) * 1000 || timestampMs,
      endIndex: Number.POSITIVE_INFINITY,
      completed: false,
      completedMs: null,
      model: parsed.turnModels.get(payload.turn_id) ?? null,
    });
    parsed.taskIds.add(payload.turn_id);
    return;
  }

  if (payload.type === 'task_complete' && payload.turn_id) {
    for (let taskIndex = parsed.taskStarts.length - 1; taskIndex >= 0; taskIndex -= 1) {
      const task = parsed.taskStarts[taskIndex];
      if (
        task.id === payload.turn_id &&
        task.index < index &&
        !Number.isFinite(task.endIndex)
      ) {
        task.endIndex = index;
        task.completed = true;
        task.completedMs = timestampMs;
        break;
      }
    }
    return;
  }

  if (payload.type === 'model_rerouted') {
    parsed.currentModel =
      payload.to_model ?? payload.toModel ?? parsed.currentModel;
    return;
  }

  if (payload.type === 'token_count' && payload.info !== null && payload.info !== undefined) {
    const total = exactUsage(payload.info.total_token_usage);
    const last = exactUsage(payload.info.last_token_usage);
    if (!total || !last) {
      parsed.invalidTokenEvents.push({ index, timestampMs });
      return;
    }
    parsed.tokenEvents.push({
      index,
      timestampMs,
      total,
      last,
      model: parsed.currentModel,
    });
    return;
  }

  if (
    payload.type === 'sub_agent_activity' &&
    payload.agent_thread_id &&
    ['started', 'interacted', 'interrupted'].includes(payload.kind)
  ) {
    parsed.activities.push({
      index,
      timestampMs,
      occurredAtMs: Number(payload.occurred_at_ms ?? timestampMs),
      childThreadId: payload.agent_thread_id,
      kind: payload.kind,
    });
  }
}

function appendRolloutBytes(parsed, buffer) {
  const lastNewline = buffer.lastIndexOf(0x0a);
  const completeLength = lastNewline + 1;
  const complete = buffer.subarray(0, completeLength).toString('utf8');
  const lines = completeLength > 0 ? complete.split('\n') : [];
  if (lines.length > 0) {
    lines.pop();
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').replace(/^\uFEFF/, '').trim();
    if (!line) {
      continue;
    }

    const index = parsed.nextLineIndex;
    parsed.nextLineIndex += 1;
    try {
      applyRolloutRecord(parsed, JSON.parse(line), index);
    } catch {
      // Ignore a malformed complete line without losing later records.
    }
  }

  const rawTail = buffer.subarray(completeLength).toString('utf8');
  const tail = rawTail.replace(/\r$/, '').replace(/^\uFEFF/, '').trim();
  if (!tail) {
    return buffer.length;
  }

  let record;
  try {
    record = JSON.parse(tail);
  } catch {
    // Keep an incomplete EOF record behind the offset for a later append.
    return completeLength;
  }

  const index = parsed.nextLineIndex;
  parsed.nextLineIndex += 1;
  try {
    applyRolloutRecord(parsed, record, index);
  } catch {
    // A syntactically complete but unsupported JSON record is still consumed.
  }
  return buffer.length;
}

function readRolloutTail(filePath, offset, size) {
  const length = Math.max(0, size - offset);
  if (length === 0) {
    return Buffer.alloc(0);
  }

  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(length);
  let position = 0;
  try {
    while (position < length) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        position,
        length - position,
        offset + position,
      );
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return buffer.subarray(0, position);
}

function rolloutStat(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  const size = Number(stat.size);
  const mtimeMs = Number(stat.mtimeMs);
  if (!Number.isSafeInteger(size) || !Number.isFinite(mtimeMs)) {
    throw new RangeError('The rollout file metadata exceeds supported limits.');
  }
  return {
    size,
    mtimeMs,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

function parseRollout(filePath) {
  const parsed = emptyParsedRollout(filePath);
  const stat = rolloutStat(filePath);
  const bytes = readRolloutTail(filePath, 0, stat.size);
  parsed.offset = appendRolloutBytes(parsed, bytes);
  return parsed;
}

function cachePathFor(cacheDirectory, threadId) {
  const safeThreadId = String(threadId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(cacheDirectory, `${safeThreadId}.json`);
}

function rolloutSourceKey(filePath) {
  return crypto
    .createHash('sha256')
    .update(path.resolve(filePath), 'utf8')
    .digest('hex');
}

function rolloutSourceIdentity(stat) {
  return {
    device: stat.device,
    inode: stat.inode,
    birthtimeNs: stat.birthtimeNs,
  };
}

function sameRolloutSource(cached, filePath, stat) {
  const expected = rolloutSourceIdentity(stat);
  const observed = cached.sourceIdentity;
  if (
    cached.version !== CACHE_VERSION ||
    cached.sourceKey !== rolloutSourceKey(filePath) ||
    !observed ||
    typeof observed !== 'object'
  ) {
    return false;
  }
  if (observed.inode !== '0' || expected.inode !== '0') {
    return (
      observed.device === expected.device &&
      observed.inode === expected.inode
    );
  }
  return observed.birthtimeNs === expected.birthtimeNs;
}

function compactUsage(usage) {
  return USAGE_KEYS.map((key) => usage?.[key] ?? 0);
}

function expandUsage(values) {
  return Object.fromEntries(
    USAGE_KEYS.map((key, index) => [key, Number(values?.[index] ?? 0)]),
  );
}

function serializeParsedRollout(parsed, stat, windowStartOffset = 0) {
  return {
    version: CACHE_VERSION,
    sourceKey: rolloutSourceKey(parsed.filePath),
    sourceIdentity: rolloutSourceIdentity(stat),
    sourceSize: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    offset: parsed.offset,
    windowStartOffset,
    parsed: {
      firstMetadata: parsed.firstMetadata,
      taskStarts: parsed.taskStarts.map((task) => [
        task.id,
        task.index,
        task.timestampMs,
        task.startedMs,
        Number.isFinite(task.endIndex) ? task.endIndex : null,
        task.completed,
        task.completedMs,
        task.model,
      ]),
      tokenEvents: parsed.tokenEvents.map((event) => [
        event.index,
        event.timestampMs,
        event.model,
        compactUsage(event.total),
        compactUsage(event.last),
      ]),
      invalidTokenEvents: parsed.invalidTokenEvents.map((event) => [
        event.index,
        event.timestampMs,
      ]),
      activities: parsed.activities.map((activity) => [
        activity.index,
        activity.timestampMs,
        activity.occurredAtMs,
        activity.childThreadId,
        activity.kind,
      ]),
      lastTimestampMs: parsed.lastTimestampMs,
      currentModel: parsed.currentModel,
      turnModels: [...parsed.turnModels.entries()],
      nextLineIndex: parsed.nextLineIndex,
    },
  };
}

function hydrateParsedRollout(filePath, value) {
  const taskStarts = (value.taskStarts ?? []).map((task) => ({
    id: task[0],
    index: task[1],
    timestampMs: task[2],
    startedMs: task[3],
    endIndex:
      task[4] === null || task[4] === undefined
        ? Number.POSITIVE_INFINITY
        : task[4],
    completed: task[5],
    completedMs: task[6],
    model: task[7],
  }));
  return {
    filePath,
    firstMetadata: value.firstMetadata ?? null,
    taskStarts,
    taskIds: new Set(taskStarts.map((task) => task.id)),
    tokenEvents: (value.tokenEvents ?? []).map((event) => ({
      index: event[0],
      timestampMs: event[1],
      model: event[2],
      total: expandUsage(event[3]),
      last: expandUsage(event[4]),
    })),
    invalidTokenEvents: (value.invalidTokenEvents ?? []).map((event) => ({
      index: event[0],
      timestampMs: event[1],
    })),
    activities: (value.activities ?? []).map((activity) => ({
      index: activity[0],
      timestampMs: activity[1],
      occurredAtMs: activity[2],
      childThreadId: activity[3],
      kind: activity[4],
    })),
    lastTimestampMs: value.lastTimestampMs ?? 0,
    currentModel: value.currentModel ?? null,
    turnModels: new Map(value.turnModels ?? []),
    nextLineIndex: Number(value.nextLineIndex ?? 0),
    offset: 0,
  };
}

function applySessionMetadata(parsed, metadata) {
  if (!metadata || parsed.firstMetadata) {
    return;
  }
  parsed.firstMetadata = {
    threadId: metadata.threadId,
    sessionId: metadata.sessionId,
    forkedFromId: metadata.forkedFromId,
    parentThreadId: metadata.parentThreadId,
    isSubagent: metadata.isSubagent,
    startedMs: metadata.startedMs,
  };
}

function acceptsParsedWindow(accept, parsed, windowStartOffset) {
  return accept(parsed, {
    truncated: windowStartOffset > 0,
    windowStartOffset,
  });
}

function parseColdRolloutWindow(filePath, stat, options) {
  const maximumBytes = Math.max(
    INITIAL_COLD_WINDOW_BYTES,
    Math.min(
      stat.size,
      Number.isSafeInteger(options.maxColdBytes)
        ? options.maxColdBytes
        : MAX_COLD_WINDOW_BYTES,
    ),
  );
  let windowBytes = Math.min(stat.size, INITIAL_COLD_WINDOW_BYTES);
  let latest = null;

  while (true) {
    const requestedStart = Math.max(0, stat.size - windowBytes);
    let bytes = readRolloutTail(filePath, requestedStart, stat.size);
    let windowStartOffset = requestedStart;
    if (requestedStart > 0) {
      const firstNewline = bytes.indexOf(0x0a);
      if (firstNewline < 0) {
        if (
          windowBytes >= maximumBytes ||
          performance.now() >= options.deadlineMs
        ) {
          const parsed = emptyParsedRollout(filePath);
          applySessionMetadata(parsed, options.metadata);
          parsed.offset = stat.size;
          parsed.coldWindowLimited = true;
          return { parsed, windowStartOffset: stat.size };
        }
        windowBytes = Math.min(maximumBytes, windowBytes * 2);
        continue;
      }
      windowStartOffset += firstNewline + 1;
      bytes = bytes.subarray(firstNewline + 1);
    }

    const parsed = emptyParsedRollout(filePath);
    applySessionMetadata(parsed, options.metadata);
    parsed.offset =
      windowStartOffset + appendRolloutBytes(parsed, bytes);
    latest = { parsed, windowStartOffset };
    if (acceptsParsedWindow(
      options.accept,
      parsed,
      windowStartOffset,
    )) {
      return latest;
    }
    if (
      requestedStart === 0 ||
      windowBytes >= maximumBytes ||
      performance.now() >= options.deadlineMs
    ) {
      parsed.coldWindowLimited = requestedStart > 0;
      return latest;
    }
    windowBytes = Math.min(maximumBytes, windowBytes * 2);
  }
}

function parseRolloutCached(
  filePath,
  threadId,
  cacheDirectory,
  options = {},
) {
  const stat = rolloutStat(filePath);
  const cachePath = cachePathFor(cacheDirectory, threadId);
  const accept =
    typeof options.accept === 'function' ? options.accept : null;
  let parsed = null;
  let cached = null;
  let windowStartOffset = 0;

  try {
    cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const sameSource = sameRolloutSource(cached, filePath, stat);
    const unchanged =
      sameSource &&
      cached.sourceSize === stat.size &&
      cached.mtimeMs === Math.trunc(stat.mtimeMs);
    if (unchanged) {
      parsed = hydrateParsedRollout(filePath, cached.parsed ?? {});
      parsed.offset = Number(cached.offset ?? stat.size);
      windowStartOffset = Number(cached.windowStartOffset ?? 0);
      if (
        !accept ||
        acceptsParsedWindow(accept, parsed, windowStartOffset)
      ) {
        return parsed;
      }
      parsed = null;
    }
    const appendOnly =
      sameSource &&
      Number.isFinite(cached.sourceSize) &&
      Number.isFinite(cached.offset) &&
      cached.sourceSize < stat.size &&
      cached.offset >= 0 &&
      cached.offset <= cached.sourceSize;
    if (appendOnly) {
      parsed = hydrateParsedRollout(filePath, cached.parsed ?? {});
      parsed.offset = cached.offset;
      windowStartOffset = Number(cached.windowStartOffset ?? 0);
    }
  } catch {
    // A missing, stale, or partial cache is rebuilt below.
  }

  if (parsed) {
    const bytes = readRolloutTail(filePath, parsed.offset, stat.size);
    parsed.offset += appendRolloutBytes(parsed, bytes);
    if (
      accept &&
      !acceptsParsedWindow(accept, parsed, windowStartOffset)
    ) {
      parsed = null;
    }
  }

  if (!parsed && accept) {
    const cold = parseColdRolloutWindow(filePath, stat, {
      ...options,
      accept,
      deadlineMs:
        Number.isFinite(options.deadlineMs)
          ? options.deadlineMs
          : Number.POSITIVE_INFINITY,
    });
    parsed = cold.parsed;
    windowStartOffset = cold.windowStartOffset;
  } else if (!parsed) {
    parsed = emptyParsedRollout(filePath);
    const bytes = readRolloutTail(filePath, 0, stat.size);
    parsed.offset = appendRolloutBytes(parsed, bytes);
    windowStartOffset = 0;
  }

  try {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(
        serializeParsedRollout(parsed, stat, windowStartOffset),
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    fs.renameSync(temporaryPath, cachePath);
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
        exact: true,
      },
    ]),
  );

  const markers = [];
  const accountingEndIndex = ownedTaskStarts.reduce(
    (latest, task) => Math.max(latest, task.endIndex),
    branchIndex,
  );
  for (const task of ownedTaskStarts) {
    markers.push({ type: 'start', index: task.index, taskId: task.id });
    if (Number.isFinite(task.endIndex)) {
      markers.push({ type: 'complete', index: task.endIndex, taskId: task.id });
    }
  }
  for (const event of parsed.tokenEvents) {
    if (
      event.index > branchIndex &&
      event.index <= accountingEndIndex
    ) {
      markers.push({ type: 'token', index: event.index, event });
    }
  }
  for (const event of parsed.invalidTokenEvents) {
    if (
      event.index > branchIndex &&
      event.index <= accountingEndIndex
    ) {
      markers.push({ type: 'invalid-token', index: event.index, event });
    }
  }
  markers.sort((left, right) => left.index - right.index);

  const precedingToken = tokenBefore(parsed, branchIndex);
  const firstOwnedToken = parsed.tokenEvents.find(
    (event) =>
      event.index > branchIndex &&
      event.index <= accountingEndIndex,
  );
  const baseline =
    precedingToken?.total ??
    (
      firstOwnedToken &&
      isMonotonic(firstOwnedToken.last, firstOwnedToken.total)
        ? subtractUsage(firstOwnedToken.total, firstOwnedToken.last)
        : firstOwnedToken?.last ?? zeroUsage()
    );
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

    if (marker.type === 'invalid-token') {
      const task = activeTaskId ? tasks.get(activeTaskId) : null;
      if (task) {
        task.exact = false;
      }
      warnings.push(
        `Malformed token counter in ${path.basename(parsed.filePath)}.`,
      );
      exact = false;
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
      if (activeTaskId) {
        const task = tasks.get(activeTaskId);
        if (task) {
          task.exact = false;
        }
      }
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

  for (const task of tasks.values()) {
    if (!hasUsage(task.usage)) {
      task.exact = false;
      warnings.push(
        `Task completed without a usable token counter in ${path.basename(parsed.filePath)}.`,
      );
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

function currentChildActivities(parentAccounting, rootTurnId) {
  return parentAccounting.parsed.activities.filter((activity) => {
    if (
      activity.index <= parentAccounting.branchIndex ||
      !['started', 'interacted'].includes(activity.kind)
    ) {
      return false;
    }
    return (
      findActiveTask(parentAccounting, activity.index)?.rootTurnId ===
      rootTurnId
    );
  });
}

function groupActivitiesByChild(activities) {
  const grouped = new Map();
  for (const activity of activities) {
    const childActivities = grouped.get(activity.childThreadId) ?? [];
    childActivities.push(activity);
    grouped.set(activity.childThreadId, childActivities);
  }
  return grouped;
}

function selectChildTasks(parentParsed, childParsed, activities) {
  const candidates = childParsed.taskStarts
    .filter((task) => !parentParsed.taskIds.has(task.id))
    .sort((left, right) => left.index - right.index);
  const orderedActivities = [...activities].sort(
    (left, right) =>
      left.occurredAtMs - right.occurredAtMs ||
      left.index - right.index,
  );
  const selected = new Map();
  const matches = [];
  let complete = true;

  function covers(task, activity) {
    return (
      task.startedMs <= activity.occurredAtMs + 10_000 &&
      (
        task.completedMs === null ||
        activity.occurredAtMs <= task.completedMs
      )
    );
  }

  function startsNear(task, activity) {
    return Math.abs(task.startedMs - activity.occurredAtMs) <= 10_000;
  }

  let cursor = -1;
  let currentTask = null;
  for (
    let activityIndex = 0;
    activityIndex < orderedActivities.length;
    activityIndex += 1
  ) {
    const activity = orderedActivities[activityIndex];
    const remainingActivities =
      orderedActivities.length - activityIndex;
    const nextCandidates = candidates
      .map((task, index) => ({ task, index }))
      .filter(
        ({ task, index }) =>
          index > cursor &&
          covers(task, activity) &&
          startsNear(task, activity),
      );
    let task = null;
    let taskIndex = cursor;

    if (!currentTask) {
      const closest = nextCandidates.reduce((best, candidate) => {
        const distance = Math.abs(
          candidate.task.startedMs - activity.occurredAtMs,
        );
        return (
          !best ||
          distance < best.distance ||
          (
            distance === best.distance &&
            candidate.index < best.index
          )
        )
          ? { ...candidate, distance }
          : best;
      }, null);
      task = closest?.task ?? null;
      taskIndex = closest?.index ?? cursor;
    } else if (
      covers(currentTask, activity) &&
      nextCandidates.length < remainingActivities
    ) {
      task = currentTask;
    } else if (nextCandidates.length > 0) {
      task = nextCandidates[0].task;
      taskIndex = nextCandidates[0].index;
    } else if (covers(currentTask, activity)) {
      task = currentTask;
    }

    if (!task) {
      complete = false;
      continue;
    }
    cursor = taskIndex;
    currentTask = task;
    selected.set(task.id, task);
    matches.push({ activity, task });
  }

  const selectedIndexes = [...selected.values()].map((task) =>
    candidates.indexOf(task),
  );
  if (selectedIndexes.length > 0) {
    const first = Math.min(...selectedIndexes);
    const last = Math.max(...selectedIndexes);
    for (let index = first; index <= last; index += 1) {
      const task = candidates[index];
      if (
        !selected.has(task.id) &&
        orderedActivities.some((activity) => covers(task, activity))
      ) {
        complete = false;
      }
    }
  }
  for (const task of selected.values()) {
    if (
      task.completed &&
      matches.filter((match) => match.task.id === task.id).length > 1
    ) {
      complete = false;
    }
  }

  return {
    tasks: [...selected.values()].sort(
      (left, right) => left.index - right.index,
    ),
    matches,
    complete,
  };
}

function reusesSelectedTask(selection) {
  const matchedTaskIds = new Set();
  for (const match of selection.matches) {
    if (matchedTaskIds.has(match.task.id)) {
      return true;
    }
    matchedTaskIds.add(match.task.id);
  }
  return false;
}

function mapChildTasksToRoot(
  parentAccounting,
  childAccounting,
  childThreadId,
  activityTaskMatches,
  warnings,
) {
  const ownedStarts = [...childAccounting.tasks.values()].sort(
    (left, right) => left.index - right.index,
  );
  let exact = true;

  for (const task of ownedStarts) {
    const matches = activityTaskMatches.filter(
      (match) => match.task.id === task.id,
    );
    if (matches.length === 0) {
      warnings.push(`Could not map subagent task ${task.id} to its parent turn.`);
      task.exact = false;
      exact = false;
      continue;
    }

    const rootTurnIds = new Set(
      matches
        .map((match) =>
          findActiveTask(parentAccounting, match.activity.index)?.rootTurnId,
        )
        .filter(Boolean),
    );
    if (rootTurnIds.size !== 1) {
      warnings.push(`Could not resolve the root turn for subagent task ${task.id}.`);
      task.exact = false;
      exact = false;
      continue;
    }
    task.rootTurnId = [...rootTurnIds][0];
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
      task.exact = false;
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

function summarizeSegments(segments) {
  const usage = usageForSegments(segments);
  const pricing = priceSegments(segments);
  return {
    usage,
    cost: pricing.cost,
    costEur: eurosFromUsd(pricing.cost),
  };
}

function turnBreakdown(segments, subagentThreadCount) {
  const byModel = new Map();
  const byRole = {
    root: [],
    subagents: [],
  };

  for (const segment of segments) {
    const model = normalizeModel(segment.model) ?? 'unknown';
    const modelSegments = byModel.get(model) ?? [];
    modelSegments.push(segment);
    byModel.set(model, modelSegments);
    byRole[segment.agentRole === 'subagent' ? 'subagents' : 'root'].push(
      segment,
    );
  }

  return {
    modelBreakdown: [...byModel.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([model, modelSegments]) => ({
        model,
        ...summarizeSegments(modelSegments),
      })),
    agentBreakdown: {
      root: summarizeSegments(byRole.root),
      subagents: {
        ...summarizeSegments(byRole.subagents),
        threadCount: subagentThreadCount,
      },
    },
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

function hookNowMs() {
  const override = Date.parse(process.env.CODEX_TURN_COST_NOW ?? '');
  if (Number.isFinite(override)) {
    return override;
  }
  return Date.now();
}

function completionMs(fallbackMs) {
  const override = Date.parse(process.env.CODEX_TURN_COST_NOW ?? '');
  if (Number.isFinite(override)) {
    return override;
  }
  return Number.isFinite(fallbackMs) ? fallbackMs : Date.now();
}

function monthLabel(timestampMs, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
  }).format(new Date(timestampMs));
}

function ledgerRecordFor(result, completedAtMs, writtenAtMs) {
  const context = result.ledgerContext;
  return {
    schema: 2,
    root_thread_id: context.rootThreadId,
    session_id: context.rootSessionId,
    turn_id: context.turnId,
    completed_at: new Date(completedAtMs).toISOString(),
    written_at: new Date(writtenAtMs).toISOString(),
    usage: result.turn.usage,
    pricing_as_of: result.pricingAsOf,
    cost_usd_nanos: Math.round(result.turn.cost * 1_000_000_000),
    eur_per_usd: EUR_PER_USD,
    cost_eur_nanos: eurosToNanos(eurosFromUsd(result.turn.cost)),
    model_breakdown: result.turn.modelBreakdown.map((part) => ({
      model: part.model,
      usage: part.usage,
      cost_usd_nanos: Math.round(part.cost * 1_000_000_000),
      cost_eur_nanos: eurosToNanos(part.costEur),
    })),
    agent_breakdown: {
      root: {
        usage: result.turn.agentBreakdown.root.usage,
        cost_usd_nanos: Math.round(
          result.turn.agentBreakdown.root.cost * 1_000_000_000,
        ),
        cost_eur_nanos: eurosToNanos(
          result.turn.agentBreakdown.root.costEur,
        ),
      },
      subagents: {
        usage: result.turn.agentBreakdown.subagents.usage,
        cost_usd_nanos: Math.round(
          result.turn.agentBreakdown.subagents.cost * 1_000_000_000,
        ),
        cost_eur_nanos: eurosToNanos(
          result.turn.agentBreakdown.subagents.costEur,
        ),
        thread_count: result.turn.agentBreakdown.subagents.threadCount,
      },
    },
  };
}

function ledgerGapFor(result, reason, completedAtMs, writtenAtMs) {
  const context = result.ledgerContext;
  return {
    schema: 2,
    entry_type: 'gap',
    root_thread_id: context.rootThreadId,
    turn_id: context.turnId,
    completed_at: new Date(completedAtMs).toISOString(),
    written_at: new Date(writtenAtMs).toISOString(),
    reason,
    ...(result.turnPriced && hasUsage(result.turn.usage)
      ? {
          known_usage: result.turn.usage,
          known_cost_usd_nanos: Math.round(
            result.turn.cost * 1_000_000_000,
          ),
          known_cost_eur_nanos: eurosToNanos(result.turn.costEur),
        }
      : {}),
  };
}

function budgetThresholdCrossings(before, after, settings) {
  const thresholds = settings.budgets.warning_thresholds_percent;
  return {
    daily: crossedBudgetThresholds(
      before?.budgets?.daily,
      after?.budgets?.daily,
      thresholds,
    ),
    monthly: crossedBudgetThresholds(
      before?.budgets?.monthly,
      after?.budgets?.monthly,
      thresholds,
    ),
  };
}

function buildRollupBudgetSnapshot(rollup, settings, nowMs) {
  const daily = {
    ...budgetState(
      settings.budgets.daily_eur,
      rollup.today.cost_eur_nanos,
    ),
    complete: rollup.today.complete,
    pending_turns: rollup.today.pending_turns,
  };
  const monthly = {
    ...budgetState(
      settings.budgets.monthly_eur,
      rollup.month.cost_eur_nanos,
    ),
    complete: rollup.month.complete,
    pending_turns: rollup.month.pending_turns,
  };
  const forecastEurNanos = projectMonthEndNanos(
    rollup.month.cost_eur_nanos,
    nowMs,
    rollup.timezone,
  );
  return {
    budgets: {
      daily,
      monthly,
      warning_thresholds_percent:
        settings.budgets.warning_thresholds_percent,
      forecast_eur_nanos: forecastEurNanos,
      forecast_percentage:
        monthly.limit_eur_nanos === null
          ? null
          : (forecastEurNanos / monthly.limit_eur_nanos) * 100,
      forecast_complete: rollup.month.complete,
    },
  };
}

function buildLedgerView(
  result,
  settings,
  nowMs,
  beforeRollup,
  afterRollup,
  appendResult,
) {
  const beforeBudgetSnapshot = buildRollupBudgetSnapshot(
    beforeRollup,
    settings,
    nowMs,
  );
  const snapshot = buildRollupBudgetSnapshot(
    afterRollup,
    settings,
    nowMs,
  );

  result.session = {
    usage: afterRollup.session.usage,
    cost:
      nanosToEuros(afterRollup.session.cost_eur_nanos) / EUR_PER_USD,
    costEur: nanosToEuros(afterRollup.session.cost_eur_nanos),
  };
  result.sessionComplete = afterRollup.session.complete;
  result.sessionPriced = true;

  return {
    todayCostEur: nanosToEuros(afterRollup.today.cost_eur_nanos),
    monthCostEur: nanosToEuros(afterRollup.month.cost_eur_nanos),
    localDate: afterRollup.today.date,
    month: afterRollup.month.month,
    monthLabel: monthLabel(nowMs, afterRollup.timezone),
    timeZone: afterRollup.timezone,
    ledgerPath: appendResult.ledgerPath,
    recorded: appendResult.recorded,
    settings,
    snapshot,
    rollup: afterRollup,
    thresholdCrossings: appendResult.recorded
      ? budgetThresholdCrossings(
          beforeBudgetSnapshot,
          snapshot,
          settings,
        )
      : { daily: [], monthly: [] },
  };
}

function recordUsageGap(result, reason, options = {}) {
  const context = result.ledgerContext;
  const nowMs = options.nowMs ?? hookNowMs();
  const completedAtMs =
    options.completedAtMs ?? completionMs(context.completedAtMs);
  const appendResult = appendLedgerGap(
    context.dataRoot,
    ledgerGapFor(result, reason, completedAtMs, nowMs),
    {
      now: nowMs,
      ...(options.settings ? { settings: options.settings } : {}),
    },
  );
  result.warnings.push(...appendResult.diagnostics);
  if (appendResult.conflict) {
    throw new Error('A conflicting accounting gap already exists for this turn.');
  }
  return appendResult;
}

function fatalLedgerContext(hookInput) {
  const transcriptPath = resolveTranscriptPath(hookInput.transcript_path);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null;
  }
  const sessionsRoot = findSessionsRoot(transcriptPath);
  if (!sessionsRoot) {
    return null;
  }
  const metadata = readSessionMetadata(transcriptPath);
  if (!metadata || metadata.isSubagent || !metadata.threadId) {
    return null;
  }
  if (
    typeof hookInput.turn_id !== 'string' ||
    hookInput.turn_id.length === 0
  ) {
    return null;
  }
  return {
    dataRoot: resolveDataRoot({
      pluginData: process.env.PLUGIN_DATA,
      codexHome: path.dirname(sessionsRoot),
    }),
    rootThreadId: metadata.threadId,
    turnId: hookInput.turn_id,
  };
}

function recordFatalUsageGap(hookInput) {
  const context = fatalLedgerContext(hookInput);
  if (!context) {
    return null;
  }
  const nowMs = hookNowMs();
  return appendLedgerGap(
    context.dataRoot,
    {
      schema: 2,
      entry_type: 'gap',
      root_thread_id: context.rootThreadId,
      turn_id: context.turnId,
      completed_at: new Date(nowMs).toISOString(),
      written_at: new Date(nowMs).toISOString(),
      reason: 'accounting_error',
    },
    { now: nowMs },
  );
}

function updateUsageLedger(result) {
  const context = result.ledgerContext;
  const nowMs = hookNowMs();
  const completedAtMs = completionMs(context.completedAtMs);
  const loadedSettings = loadSettings(context.dataRoot);
  result.warnings.push(...loadedSettings.diagnostics);
  const settings = loadedSettings.settings;
  const beforeRollup = buildHookRollup(context.dataRoot, {
    settings,
    now: nowMs,
    rootThreadId: context.rootThreadId,
  });
  const appendResult = appendLedgerRecord(
    context.dataRoot,
    ledgerRecordFor(result, completedAtMs, nowMs),
    { now: nowMs, settings },
  );
  result.warnings.push(...appendResult.diagnostics);
  if (appendResult.conflict) {
    throw new Error('A conflicting record already exists for this turn.');
  }
  const afterRollup = buildHookRollup(context.dataRoot, {
    settings,
    now: nowMs,
    rootThreadId: context.rootThreadId,
  });
  result.warnings.push(...afterRollup.diagnostics);
  return buildLedgerView(
    result,
    settings,
    nowMs,
    beforeRollup,
    afterRollup,
    appendResult,
  );
}

function updateUsageGapLedger(result, reason) {
  const context = result.ledgerContext;
  const nowMs = hookNowMs();
  const completedAtMs = completionMs(context.completedAtMs);
  const loadedSettings = loadSettings(context.dataRoot);
  result.warnings.push(...loadedSettings.diagnostics);
  const settings = loadedSettings.settings;
  const beforeRollup = buildHookRollup(context.dataRoot, {
    settings,
    now: nowMs,
    rootThreadId: context.rootThreadId,
  });
  const appendResult = recordUsageGap(result, reason, {
    nowMs,
    completedAtMs,
    settings,
  });
  const afterRollup = buildHookRollup(context.dataRoot, {
    settings,
    now: nowMs,
    rootThreadId: context.rootThreadId,
  });
  result.warnings.push(...afterRollup.diagnostics);
  return buildLedgerView(
    result,
    settings,
    nowMs,
    beforeRollup,
    afterRollup,
    appendResult,
  );
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
  const analysisDeadline = analysisStarted + ANALYSIS_BUDGET_MS;
  const currentTurnId = hookInput.turn_id;
  const transcriptPath = resolveTranscriptPath(hookInput.transcript_path);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    throw new Error('The current transcript could not be found.');
  }

  const sessionsRoot = findSessionsRoot(transcriptPath);
  if (!sessionsRoot) {
    throw new Error('The Codex sessions directory could not be located.');
  }
  const codexHome = path.dirname(sessionsRoot);
  const dataRoot = resolveDataRoot({
    pluginData: process.env.PLUGIN_DATA,
    codexHome,
  });
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
    {
      metadata: rootMetadata,
      deadlineMs: analysisDeadline,
      accept: (parsed) =>
        parsed.taskStarts.some((task) => task.id === currentTurnId),
    },
  );
  if (rootParsed.coldWindowLimited) {
    warnings.push(
      'The bounded cold read ended before the current root task could be found.',
    );
  }

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

  const currentRootTaskStart = rootOwnedTaskStarts.find(
    (task) => task.id === currentTurnId,
  );
  const rootAccounting = buildAccounting(
    rootParsed,
    currentRootTaskStart ? [currentRootTaskStart] : [],
    currentRootTaskStart?.index ?? rootBranchIndex,
    hookInput.model,
    warnings,
  );
  for (const task of rootAccounting.tasks.values()) {
    task.rootTurnId = task.id;
  }

  const accountingByThread = new Map([[rootThreadId, rootAccounting]]);
  const pending = [rootThreadId];
  const visited = new Set([rootThreadId]);
  let currentTraversalComplete =
    !rootParsed.coldWindowLimited &&
    rootAccounting.exact;

  while (pending.length > 0) {
    const parentThreadId = pending.shift();
    const parentAccounting = accountingByThread.get(parentThreadId);
    if (!parentAccounting) {
      continue;
    }

    const childActivitiesByThread = groupActivitiesByChild(
      currentChildActivities(parentAccounting, currentTurnId),
    );

    for (const [childThreadId, childActivities] of childActivitiesByThread) {
      if (performance.now() - analysisStarted > ANALYSIS_BUDGET_MS) {
        warnings.push(
          'The analysis time budget was reached before every subagent could be included.',
        );
        currentTraversalComplete = false;
        pending.length = 0;
        break;
      }

      if (visited.has(childThreadId)) {
        continue;
      }

      const representativeActivity = childActivities[0];
      const childMetadata = findChildSessionMetadata(
        sessionsRoot,
        childThreadId,
        parentThreadId,
        rootSessionId,
        {
          parentFilePath: parentAccounting.parsed.filePath,
          occurredAtMs: representativeActivity.occurredAtMs,
        },
      );
      if (!childMetadata) {
        warnings.push(`Missing or mismatched rollout for subagent ${childThreadId}.`);
        currentTraversalComplete = false;
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
        {
          metadata: childMetadata,
          deadlineMs: analysisDeadline,
          accept: (parsed, window) => {
            const selection = selectChildTasks(
              parentAccounting.parsed,
              parsed,
              childActivities,
            );
            return (
              selection.complete &&
              selection.tasks.length > 0 &&
              !(window.truncated && reusesSelectedTask(selection))
            );
          },
        },
      );
      if (childParsed.coldWindowLimited) {
        warnings.push(
          `The bounded cold read ended before subagent ${childThreadId} could be isolated.`,
        );
        currentTraversalComplete = false;
      }
      if (performance.now() - analysisStarted > ANALYSIS_BUDGET_MS) {
        warnings.push(
          'The analysis time budget was reached before every subagent could be included.',
        );
        currentTraversalComplete = false;
        pending.length = 0;
        break;
      }
      const selected = selectChildTasks(
        parentAccounting.parsed,
        childParsed,
        childActivities,
      );
      if (!selected.complete || selected.tasks.length === 0) {
        warnings.push(`Could not find the branch point for subagent ${childThreadId}.`);
        currentTraversalComplete = false;
      }
      if (selected.tasks.length === 0) {
        continue;
      }

      const childAccounting = buildAccounting(
        childParsed,
        selected.tasks,
        selected.tasks[0].index,
        hookInput.model,
        warnings,
      );
      currentTraversalComplete &&= childAccounting.exact;
      const childMappingExact = mapChildTasksToRoot(
        parentAccounting,
        childAccounting,
        childThreadId,
        selected.matches,
        warnings,
      );
      if (!childMappingExact) {
        currentTraversalComplete = false;
      }
      if (
        [...childAccounting.tasks.values()].some(
          (task) => task.rootTurnId !== currentTurnId,
        )
      ) {
        warnings.push(
          `Could not isolate subagent ${childThreadId} to the current root turn.`,
        );
        currentTraversalComplete = false;
      }

      accountingByThread.set(childThreadId, childAccounting);
      visited.add(childThreadId);
      pending.push(childThreadId);
    }
  }

  const turnSegments = [];
  const currentRootTask = rootAccounting.tasks.get(currentTurnId);
  const turnAgentThreadIds = new Set();

  for (const [threadId, accounting] of accountingByThread.entries()) {
    for (const segment of accounting.segments) {
      const scopedSegment = {
        ...segment,
        agentRole: threadId === rootThreadId ? 'root' : 'subagent',
      };
      const task = segment.taskId ? accounting.tasks.get(segment.taskId) : null;
      if (task?.rootTurnId === currentTurnId) {
        turnSegments.push(scopedSegment);
        if (threadId !== rootThreadId) {
          turnAgentThreadIds.add(threadId);
        }
      }
    }
  }

  // Codex invokes the root Stop hook before it appends task_complete to the
  // rollout. The matching Stop event is completion evidence for the current
  // root task; token validity and subagent traversal still determine whether
  // its accounting is exact.
  let turnComplete =
    currentTraversalComplete &&
    Boolean(currentRootTask && currentRootTask.exact);
  if (!currentRootTask) {
    warnings.push('The current root task could not be found in its rollout.');
  }
  for (const accounting of accountingByThread.values()) {
    for (const task of accounting.tasks.values()) {
      if (task.rootTurnId === currentTurnId && !task.exact) {
        turnComplete = false;
      }
    }
  }

  const turnUsage = usageForSegments(turnSegments);
  const lastTurnUsageMs = turnSegments.reduce(
    (latest, segment) => Math.max(latest, segment.timestampMs),
    Number.NEGATIVE_INFINITY,
  );
  const turnPricing = priceSegments(turnSegments);
  const breakdown = turnBreakdown(turnSegments, turnAgentThreadIds.size);
  const unpricedModels = turnPricing.unpricedModels;
  const turnPriced = turnPricing.unpricedModels.size === 0;

  if (unpricedModels.size > 0) {
    warnings.push(`No hardcoded price for: ${[...unpricedModels].join(', ')}.`);
  }

  return {
    skip: false,
    pricingAsOf: PRICING_AS_OF,
    model: modelLabel(turnPricing.models, hookInput.model),
    agentThreads: Math.max(0, accountingByThread.size - 1),
    turnAgentThreads: turnAgentThreadIds.size,
    complete: turnComplete,
    turnComplete,
    sessionComplete: false,
    warming: false,
    priced: turnPriced,
    turnPriced,
    sessionPriced: false,
    turn: {
      usage: turnUsage,
      cost: turnPricing.cost,
      costEur: eurosFromUsd(turnPricing.cost),
      ...breakdown,
    },
    session: {
      usage: zeroUsage(),
      cost: 0,
      costEur: 0,
    },
    ledgerContext: {
      dataRoot,
      rootThreadId,
      rootSessionId,
      turnId: currentTurnId,
      completedAtMs:
        (Number.isFinite(lastTurnUsageMs) ? lastTurnUsageMs : null) ??
        currentRootTask?.completedMs ??
        rootParsed.lastTimestampMs ??
        currentRootTask?.startedMs,
    },
    warnings: [...new Set(warnings)],
  };
}

function buildSystemMessage(result) {
  const turnComplete = result.turnComplete ?? result.complete;
  const sessionComplete = result.sessionComplete ?? result.complete;
  const turnHasKnownLowerBound =
    !turnComplete &&
    result.turnPriced &&
    hasUsage(result.turn.usage);
  if (!turnComplete && !turnHasKnownLowerBound && !result.ledger) {
    return 'Usage unavailable — see hook diagnostics.';
  }

  const turnCost = result.turnPriced ?? result.priced
    ? formatEuroCost(result.turn.costEur)
    : 'cost unavailable';
  const sessionCost = result.sessionPriced ?? result.priced
    ? formatEuroCost(result.session.costEur)
    : 'cost unavailable';
  let turnGroup;
  if (turnComplete) {
    turnGroup =
      `Turn + agents ${formatCompactTokens(
        result.turn.usage.total_tokens,
      )} tok · ${turnCost}`;
  } else if (turnHasKnownLowerBound) {
    turnGroup =
      `Turn + agents ≥${formatCompactTokens(
        result.turn.usage.total_tokens,
      )} tok · ≥${turnCost}`;
  } else {
    turnGroup = 'Turn + agents unavailable';
  }

  const sessionScope = result.ledger?.rollup?.session;
  let sessionGroup = 'Session + agents unavailable';
  if (sessionComplete) {
    sessionGroup =
      `Session + agents ${formatCompactTokens(
        result.session.usage.total_tokens,
      )} tok · ${sessionCost}`;
  } else if (sessionScope) {
    const pending = sessionScope.pending_turns;
    sessionGroup =
      `Session + agents ≥${formatCompactTokens(
        result.session.usage.total_tokens,
      )} tok · ≥${sessionCost} · ${pending} pending`;
  }

  const primaryGroups = [
    turnGroup,
    sessionGroup,
  ];
  const secondaryGroups = [];

  if (result.ledger) {
    const today = result.ledger.rollup?.today;
    const month = result.ledger.rollup?.month;
    secondaryGroups.push(
      today?.complete === false
        ? `Today ≥${formatEuroCost(result.ledger.todayCostEur)} · ${today.pending_turns} pending`
        : `Today ${formatEuroCost(result.ledger.todayCostEur)}`,
    );
    secondaryGroups.push(
      month?.complete === false
        ? `${result.ledger.monthLabel} ≥${formatEuroCost(
            result.ledger.monthCostEur,
          )} · ${month.pending_turns} pending`
        : `${result.ledger.monthLabel} ${formatEuroCost(
            result.ledger.monthCostEur,
          )}`,
    );
  }
  secondaryGroups.push(result.model);

  if (result.warnings.length > 0) {
    secondaryGroups.push('See diagnostics');
  }
  const lines = [
    primaryGroups.map(noBreak).join(' │ ') +
      '  \n' +
      secondaryGroups.map(noBreak).join(' │ '),
  ];

  const budgets = result.ledger?.snapshot?.budgets;
  if (
    budgets &&
    (budgets.daily.limit_eur_nanos !== null ||
      budgets.monthly.limit_eur_nanos !== null)
  ) {
    const budgetGroups = [];
    for (const [label, budget] of [
      ['Today', budgets.daily],
      ['Month', budgets.monthly],
    ]) {
      if (budget.limit_eur_nanos === null) {
        continue;
      }
      const lowerBound = budget.complete === false;
      const percentage = Math.round(budget.percentage);
      const balance =
        budget.over_eur_nanos > 0
          ? `${lowerBound ? '≥' : ''}${formatEuroCost(
              nanosToEuros(budget.over_eur_nanos),
            )} over`
          : `${lowerBound ? '≤' : ''}${formatEuroCost(
              nanosToEuros(budget.remaining_eur_nanos),
            )} left`;
      budgetGroups.push(
        `${label} ${lowerBound ? '≥' : ''}${percentage}% · ${balance}`,
      );
    }
    budgetGroups.push(
      `Forecast ${budgets.forecast_complete === false ? '≥' : ''}${formatEuroCost(
        nanosToEuros(budgets.forecast_eur_nanos),
      )}`,
    );
    lines.push(`Budget: ${budgetGroups.map(noBreak).join(' │ ')}`);
  }

  if (result.ledger?.settings?.hook?.message_format === 'detailed') {
    const root = result.turn.agentBreakdown.root;
    const subagents = result.turn.agentBreakdown.subagents;
    const usage = result.turn.usage;
    const freshInput = Math.max(
      0,
      usage.input_tokens -
        usage.cached_input_tokens -
        usage.cache_write_input_tokens,
    );
    const lowerBound = turnComplete ? '' : '≥';
    lines.push(
      [
        `Breakdown: Root ${lowerBound}${formatEuroCost(root.costEur)}`,
        `Agents ${lowerBound}${formatEuroCost(subagents.costEur)}`,
        `Fresh ${lowerBound}${formatCompactTokens(freshInput)} tok`,
        `Cached ${lowerBound}${formatCompactTokens(
          usage.cached_input_tokens,
        )} tok`,
      ]
        .map(noBreak)
        .join(' │ '),
    );
  }

  return lines.join('  \n');
}

function notificationMessage(ledger) {
  const crossed = [];
  if (ledger.thresholdCrossings.daily.length > 0) {
    crossed.push(
      `daily ${Math.max(...ledger.thresholdCrossings.daily)}%`,
    );
  }
  if (ledger.thresholdCrossings.monthly.length > 0) {
    crossed.push(
      `monthly ${Math.max(...ledger.thresholdCrossings.monthly)}%`,
    );
  }
  if (crossed.length === 0) {
    return null;
  }
  return `Budget threshold reached: ${crossed.join(', ')}.`;
}

function windowsNotificationCommand(message) {
  const encodedMessage = Buffer.from(message, 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedMessage}"))`,
    '$icon = [System.Windows.Forms.NotifyIcon]::new()',
    '$icon.Icon = [System.Drawing.SystemIcons]::Information',
    '$icon.BalloonTipTitle = "Codex Cost Meter"',
    '$icon.BalloonTipText = $message',
    '$icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info',
    '$icon.Visible = $true',
    '$icon.ShowBalloonTip(5000)',
    'Start-Sleep -Seconds 6',
    '$icon.Dispose()',
  ].join('; ');
  return Buffer.from(script, 'utf16le').toString('base64');
}

function maybeSendWindowsNotification(ledger) {
  if (
    !ledger?.settings?.notifications?.windows ||
    process.env.CODEX_TURN_COST_DISABLE_NOTIFICATIONS === '1'
  ) {
    return null;
  }
  const message = notificationMessage(ledger);
  if (!message) {
    return null;
  }

  if (process.platform !== 'win32' && !process.env.WSL_DISTRO_NAME) {
    return 'Windows budget notification could not be displayed.';
  }
  try {
    const encodedCommand = windowsNotificationCommand(message);
    const notification = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodedCommand,
      ],
      {
        detached: true,
        env: process.env,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    notification.on('error', () => {});
    notification.unref();
  } catch {
    return 'Windows budget notification could not be displayed.';
  }
  return null;
}

function main() {
  const rawInput = fs.readFileSync(0, 'utf8').trim();
  if (!rawInput) {
    throw new Error('The hook received no input.');
  }

  const hookInput = JSON.parse(rawInput);
  const debug = process.argv.includes('--debug-json');
  let result;
  try {
    waitForFileToSettle(resolveTranscriptPath(hookInput.transcript_path));
    result = analyze(hookInput);
  } catch (error) {
    if (!debug) {
      try {
        const appendResult = recordFatalUsageGap(hookInput);
        if (appendResult?.conflict) {
          process.stderr.write(
            'turn-cost hook diagnostics:\n- A conflicting accounting gap already exists for this turn.\n',
          );
        }
      } catch (gapError) {
        const message =
          gapError instanceof Error ? gapError.message : String(gapError);
        process.stderr.write(
          `turn-cost hook diagnostics:\n- Fatal accounting gap could not be recorded: ${message}\n`,
        );
      }
    }
    throw error;
  }

  if (result.skip) {
    return;
  }

  if (!debug) {
    const turnComplete = result.turnComplete ?? result.complete;
    if (turnComplete && result.turnPriced) {
      try {
        result.ledger = updateUsageLedger(result);
        const notificationWarning = maybeSendWindowsNotification(result.ledger);
        if (notificationWarning) {
          result.warnings.push(notificationWarning);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.warnings.push(`Usage ledger could not be updated: ${message}`);
      }
    } else {
      const reason = turnComplete
        ? 'pricing_unavailable'
        : hasUsage(result.turn.usage)
          ? 'history_incomplete'
          : 'usage_unavailable';
      try {
        result.ledger = updateUsageGapLedger(result, reason);
        const notificationWarning = maybeSendWindowsNotification(result.ledger);
        if (notificationWarning) {
          result.warnings.push(notificationWarning);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.warnings.push(
          `Usage ledger gap could not be recorded: ${message}`,
        );
      }
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

if (require.main === module) {
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
}

module.exports = {
  analyze,
  appendRolloutBytes,
  buildSystemMessage,
  emptyParsedRollout,
  ledgerGapFor,
  ledgerRecordFor,
  main,
  parseRollout,
  parseRolloutCached,
  recordFatalUsageGap,
  recordUsageGap,
  turnBreakdown,
  updateUsageGapLedger,
  updateUsageLedger,
  windowsNotificationCommand,
};
