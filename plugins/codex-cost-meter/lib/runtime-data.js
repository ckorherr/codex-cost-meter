'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const SETTINGS_SCHEMA = 1;
const LEDGER_SCHEMA = 2;
const LEDGER_READ_CACHE_SCHEMA = 4;
const HOOK_ROLLUP_SCHEMA = 2;
const LEDGER_READ_CACHE_TAIL_BYTES = 128;
const DEFAULT_HOOK_LEDGER_FILES_PER_MONTH = 128;
const EUR_NANOS = 1_000_000_000;
const DEFAULT_TIME_ZONE = 'Europe/Berlin';
const DEFAULT_THRESHOLDS = Object.freeze([50, 80, 100]);
const LEDGER_GAP_REASONS = Object.freeze([
  'history_incomplete',
  'usage_unavailable',
  'pricing_unavailable',
  'accounting_error',
]);
const LEDGER_GAP_REASON_SET = new Set(LEDGER_GAP_REASONS);
const ledgerReadMemoryCache = new Map();
const USAGE_KEYS = Object.freeze([
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
]);

function defaultSettings() {
  return {
    schema: SETTINGS_SCHEMA,
    timezone: DEFAULT_TIME_ZONE,
    budgets: {
      daily_eur: null,
      monthly_eur: null,
      warning_thresholds_percent: [...DEFAULT_THRESHOLDS],
    },
    notifications: {
      windows: false,
    },
    hook: {
      message_format: 'compact',
    },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function normalizeBudget(value, field, diagnostics) {
  if (value === null) {
    return null;
  }
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    Math.round(value * EUR_NANOS) >= 1 &&
    value <= Number.MAX_SAFE_INTEGER / EUR_NANOS
  ) {
    return value;
  }
  diagnostics.push(
    `${field} must be null or round to at least €0.000000001; using null.`,
  );
  return null;
}

function normalizeThresholds(value, diagnostics) {
  if (!Array.isArray(value)) {
    diagnostics.push(
      'budgets.warning_thresholds_percent must be an array; using defaults.',
    );
    return [...DEFAULT_THRESHOLDS];
  }

  const valid = [];
  let invalid = false;
  for (const threshold of value) {
    if (
      typeof threshold === 'number' &&
      Number.isFinite(threshold) &&
      Number.isInteger(threshold) &&
      threshold >= 1 &&
      threshold <= 100
    ) {
      valid.push(threshold);
    } else {
      invalid = true;
    }
  }
  if (invalid) {
    diagnostics.push(
      'Budget warning thresholds must be whole percentages from 1 through 100; invalid values were ignored.',
    );
  }

  const normalized = [...new Set(valid)].sort((left, right) => left - right);
  if (normalized.length === 0) {
    diagnostics.push(
      'At least one valid budget warning threshold is required; using defaults.',
    );
    return [...DEFAULT_THRESHOLDS];
  }
  return normalized;
}

function normalizeSettings(input, options = {}) {
  const diagnostics = [];
  const defaults = defaultSettings();
  const diagnoseMissing = options.diagnoseMissing === true;

  if (!isObject(input)) {
    diagnostics.push('Settings must be a JSON object; using defaults.');
    return {
      settings: defaults,
      diagnostics,
      supported: true,
      unsupportedSchema: null,
    };
  }

  if (
    Number.isInteger(input.schema) &&
    input.schema > SETTINGS_SCHEMA
  ) {
    diagnostics.push(
      `Settings schema ${input.schema} is newer than supported schema ${SETTINGS_SCHEMA}; the file is read-only.`,
    );
    return {
      settings: defaults,
      diagnostics,
      supported: false,
      unsupportedSchema: input.schema,
    };
  }

  if (input.schema !== SETTINGS_SCHEMA) {
    diagnostics.push(
      `settings.schema must be ${SETTINGS_SCHEMA}; using schema ${SETTINGS_SCHEMA} defaults.`,
    );
  }

  let timeZone = defaults.timezone;
  if (isValidTimeZone(input.timezone)) {
    timeZone = input.timezone.trim();
  } else if (Object.hasOwn(input, 'timezone') || diagnoseMissing) {
    diagnostics.push(
      `timezone must be a valid IANA timezone; using ${DEFAULT_TIME_ZONE}.`,
    );
  }

  const budgets = isObject(input.budgets) ? input.budgets : {};
  if (!isObject(input.budgets) && (Object.hasOwn(input, 'budgets') || diagnoseMissing)) {
    diagnostics.push('budgets must be an object; using budget defaults.');
  }
  const dailyValue = Object.hasOwn(budgets, 'daily_eur')
    ? budgets.daily_eur
    : null;
  const monthlyValue = Object.hasOwn(budgets, 'monthly_eur')
    ? budgets.monthly_eur
    : null;
  if (diagnoseMissing && !Object.hasOwn(budgets, 'daily_eur')) {
    diagnostics.push('budgets.daily_eur is missing; using null.');
  }
  if (diagnoseMissing && !Object.hasOwn(budgets, 'monthly_eur')) {
    diagnostics.push('budgets.monthly_eur is missing; using null.');
  }

  let thresholds = [...DEFAULT_THRESHOLDS];
  if (Object.hasOwn(budgets, 'warning_thresholds_percent')) {
    thresholds = normalizeThresholds(
      budgets.warning_thresholds_percent,
      diagnostics,
    );
  } else if (diagnoseMissing) {
    diagnostics.push(
      'budgets.warning_thresholds_percent is missing; using defaults.',
    );
  }

  const notifications = isObject(input.notifications)
    ? input.notifications
    : {};
  if (
    !isObject(input.notifications) &&
    (Object.hasOwn(input, 'notifications') || diagnoseMissing)
  ) {
    diagnostics.push(
      'notifications must be an object; using notification defaults.',
    );
  }
  let windowsNotifications = defaults.notifications.windows;
  if (typeof notifications.windows === 'boolean') {
    windowsNotifications = notifications.windows;
  } else if (Object.hasOwn(notifications, 'windows') || diagnoseMissing) {
    diagnostics.push(
      'notifications.windows must be a boolean; using false.',
    );
  }

  const hook = isObject(input.hook) ? input.hook : {};
  if (!isObject(input.hook) && (Object.hasOwn(input, 'hook') || diagnoseMissing)) {
    diagnostics.push('hook must be an object; using hook defaults.');
  }
  let messageFormat = defaults.hook.message_format;
  if (hook.message_format === 'compact' || hook.message_format === 'detailed') {
    messageFormat = hook.message_format;
  } else if (Object.hasOwn(hook, 'message_format') || diagnoseMissing) {
    diagnostics.push(
      'hook.message_format must be "compact" or "detailed"; using compact.',
    );
  }

  return {
    settings: {
      schema: SETTINGS_SCHEMA,
      timezone: timeZone,
      budgets: {
        daily_eur: normalizeBudget(
          dailyValue,
          'budgets.daily_eur',
          diagnostics,
        ),
        monthly_eur: normalizeBudget(
          monthlyValue,
          'budgets.monthly_eur',
          diagnostics,
        ),
        warning_thresholds_percent: thresholds,
      },
      notifications: {
        windows: windowsNotifications,
      },
      hook: {
        message_format: messageFormat,
      },
    },
    diagnostics,
    supported: true,
    unsupportedSchema: null,
  };
}

function resolveDataRoot(options = {}) {
  if (typeof options === 'string') {
    return path.resolve(options);
  }

  const environment = isObject(options.env) ? options.env : process.env;
  const explicit =
    options.dataRoot ??
    options.pluginData ??
    environment.PLUGIN_DATA;
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== 'string' || !explicit.trim()) {
      throw new TypeError('A non-empty plugin data directory is required.');
    }
    return path.resolve(explicit.trim());
  }

  const codexHome =
    options.codexHome ??
    environment.CODEX_HOME ??
    path.join(os.homedir(), '.codex');
  if (typeof codexHome !== 'string' || !codexHome.trim()) {
    throw new TypeError('A non-empty plugin data directory is required.');
  }
  return path.resolve(
    codexHome.trim(),
    'plugins',
    'data',
    'codex-cost-meter-cost-meter',
  );
}

function settingsPath(dataRoot) {
  return path.join(resolveDataRoot(dataRoot), 'settings.json');
}

function loadSettings(dataRoot) {
  const filePath = settingsPath(dataRoot);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        settings: defaultSettings(),
        diagnostics: [],
        path: filePath,
        exists: false,
        supported: true,
      };
    }
    return {
      settings: defaultSettings(),
      diagnostics: [`Settings could not be read: ${error.message}`],
      path: filePath,
      exists: true,
      supported: true,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      settings: defaultSettings(),
      diagnostics: [`Settings JSON is malformed: ${error.message}`],
      path: filePath,
      exists: true,
      supported: true,
    };
  }

  const normalized = normalizeSettings(parsed, { diagnoseMissing: true });
  return {
    settings: normalized.settings,
    diagnostics: normalized.diagnostics,
    path: filePath,
    exists: true,
    supported: normalized.supported,
    ...(normalized.unsupportedSchema === null
      ? {}
      : { unsupportedSchema: normalized.unsupportedSchema }),
  };
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function atomicWriteBuffer(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
      fs.chmodSync(directory, 0o700);
    } catch (error) {
      if (
        error?.code !== 'EPERM' &&
        error?.code !== 'ENOSYS' &&
        error?.code !== 'EINVAL'
      ) {
        throw error;
      }
    }
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function readExistingSettingsSchema(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Number.isInteger(parsed?.schema) ? parsed.schema : null;
  } catch {
    return null;
  }
}

function saveSettings(dataRoot, input) {
  const filePath = settingsPath(dataRoot);
  const existingSchema = readExistingSettingsSchema(filePath);
  const inputSchema = isObject(input) && Number.isInteger(input.schema)
    ? input.schema
    : null;
  const unsupportedSchema = Math.max(existingSchema ?? 0, inputSchema ?? 0);

  if (unsupportedSchema > SETTINGS_SCHEMA) {
    const loaded = loadSettings(dataRoot);
    const diagnostics = [
      ...loaded.diagnostics,
      `Settings schema ${unsupportedSchema} is newer than supported schema ${SETTINGS_SCHEMA}; no changes were written.`,
    ];
    return {
      ...loaded,
      diagnostics: [...new Set(diagnostics)],
      supported: false,
      saved: false,
      reason: 'unsupported-schema',
      unsupportedSchema,
    };
  }

  const normalized = normalizeSettings(input, { diagnoseMissing: true });
  atomicWriteJson(filePath, normalized.settings);
  return {
    settings: normalized.settings,
    diagnostics: normalized.diagnostics,
    path: filePath,
    exists: true,
    supported: true,
    saved: true,
  };
}

function zeroUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
}

function normalizeUsage(value) {
  const result = zeroUsage();
  if (!isObject(value)) {
    return result;
  }
  for (const key of USAGE_KEYS) {
    const number = Number(value[key] ?? 0);
    result[key] =
      Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
  }
  return result;
}

function requireLedgerUsage(value) {
  if (!isObject(value)) {
    throw new TypeError('usage must be an object.');
  }
  const result = {};
  for (const key of USAGE_KEYS) {
    if (
      !Number.isSafeInteger(value[key]) ||
      value[key] < 0
    ) {
      throw new TypeError(
        `usage.${key} must be a non-negative safe integer.`,
      );
    }
    result[key] = value[key];
  }
  return result;
}

function addUsage(left, right) {
  const result = zeroUsage();
  for (const key of USAGE_KEYS) {
    result[key] = (left?.[key] ?? 0) + (right?.[key] ?? 0);
  }
  return result;
}

function subtractUsage(left, right) {
  const result = zeroUsage();
  for (const key of USAGE_KEYS) {
    result[key] = Math.max(0, (left?.[key] ?? 0) - (right?.[key] ?? 0));
  }
  return result;
}

function usageExceeds(left, right) {
  return USAGE_KEYS.some((key) => (left?.[key] ?? 0) > (right?.[key] ?? 0));
}

function hasUsage(value) {
  return USAGE_KEYS.some((key) => (value?.[key] ?? 0) > 0);
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requireNanos(value, field, optional = false) {
  if (optional && (value === undefined || value === null)) {
    return 0;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function normalizeTimestamp(value, field, fallback) {
  const timestamp = Date.parse(value ?? '');
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  if (fallback !== undefined) {
    const fallbackTimestamp = toTimestamp(fallback, field);
    return new Date(fallbackTimestamp).toISOString();
  }
  throw new TypeError(`${field} must be a valid timestamp.`);
}

function normalizeModelBreakdown(value, record) {
  const entries = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isObject(item) || typeof item.model !== 'string' || !item.model.trim()) {
        continue;
      }
      try {
        entries.push({
          model: item.model.trim(),
          usage: normalizeUsage(item.usage),
          cost_usd_nanos: requireNanos(
            item.cost_usd_nanos,
            'model_breakdown.cost_usd_nanos',
            true,
          ),
          cost_eur_nanos: requireNanos(
            item.cost_eur_nanos,
            'model_breakdown.cost_eur_nanos',
          ),
        });
      } catch {
        // A malformed breakdown entry does not invalidate the top-level turn.
      }
    }
  }

  if (entries.length === 0) {
    entries.push({
      model:
        typeof record.model === 'string' && record.model.trim()
          ? record.model.trim()
          : 'unknown',
      usage: record.usage,
      cost_usd_nanos: record.cost_usd_nanos,
      cost_eur_nanos: record.cost_eur_nanos,
    });
  }

  entries.sort((left, right) => left.model.localeCompare(right.model));
  return entries;
}

function normalizeAgentPart(value, field, options = {}) {
  const part = isObject(value) ? value : {};
  return {
    usage: normalizeUsage(part.usage),
    cost_usd_nanos: requireNanos(
      part.cost_usd_nanos,
      `${field}.cost_usd_nanos`,
      true,
    ),
    cost_eur_nanos: requireNanos(
      part.cost_eur_nanos,
      `${field}.cost_eur_nanos`,
      true,
    ),
    ...(options.includeThreadCount
      ? {
          thread_count:
            Number.isInteger(part.thread_count) && part.thread_count >= 0
              ? part.thread_count
              : options.defaultThreadCount ?? 0,
        }
      : {}),
  };
}

function normalizeAgentBreakdown(value, record) {
  if (!isObject(value)) {
    return {
      root: {
        usage: record.usage,
        cost_usd_nanos: record.cost_usd_nanos,
        cost_eur_nanos: record.cost_eur_nanos,
      },
      subagents: {
        usage: zeroUsage(),
        cost_usd_nanos: 0,
        cost_eur_nanos: 0,
        thread_count:
          Number.isInteger(record.agent_threads) && record.agent_threads >= 0
            ? record.agent_threads
            : 0,
      },
    };
  }

  return {
    root: normalizeAgentPart(value.root, 'agent_breakdown.root'),
    subagents: normalizeAgentPart(
      value.subagents,
      'agent_breakdown.subagents',
      {
        includeThreadCount: true,
        defaultThreadCount:
          Number.isInteger(record.agent_threads) && record.agent_threads >= 0
            ? record.agent_threads
            : 0,
      },
    ),
  };
}

function normalizeLedgerRecord(input, options = {}) {
  if (!isObject(input)) {
    throw new TypeError('Ledger record must be an object.');
  }
  if (input.schema !== undefined && input.schema !== LEDGER_SCHEMA) {
    throw new TypeError(`Ledger record schema must be ${LEDGER_SCHEMA}.`);
  }
  if (
    input.entry_type !== undefined &&
    input.entry_type !== 'record'
  ) {
    throw new TypeError('Ledger record entry_type must be "record".');
  }

  const completedAt = normalizeTimestamp(input.completed_at, 'completed_at');
  const writtenAt = normalizeTimestamp(
    input.written_at,
    'written_at',
    options.now ?? Date.now(),
  );
  const costEurNanos = requireNanos(
    input.cost_eur_nanos,
    'cost_eur_nanos',
  );
  const costUsdNanos = requireNanos(
    input.cost_usd_nanos,
    'cost_usd_nanos',
    true,
  );
  const usage = requireLedgerUsage(input.usage);
  const record = {
    schema: LEDGER_SCHEMA,
    root_thread_id: requireString(input.root_thread_id, 'root_thread_id'),
    session_id:
      typeof input.session_id === 'string' && input.session_id.trim()
        ? input.session_id.trim()
        : requireString(input.root_thread_id, 'root_thread_id'),
    turn_id: requireString(input.turn_id, 'turn_id'),
    completed_at: completedAt,
    written_at: writtenAt,
    pricing_as_of:
      typeof input.pricing_as_of === 'string' ? input.pricing_as_of : '',
    eur_per_usd:
      typeof input.eur_per_usd === 'number' &&
      Number.isFinite(input.eur_per_usd) &&
      input.eur_per_usd > 0
        ? input.eur_per_usd
        : null,
    usage,
    cost_usd_nanos: costUsdNanos,
    cost_eur_nanos: costEurNanos,
  };
  record.model_breakdown = normalizeModelBreakdown(
    input.model_breakdown,
    { ...input, ...record },
  );
  record.agent_breakdown = normalizeAgentBreakdown(
    input.agent_breakdown,
    { ...input, ...record },
  );
  return record;
}

function normalizeLedgerGap(input, options = {}) {
  if (!isObject(input)) {
    throw new TypeError('Ledger gap must be an object.');
  }
  if (input.schema !== undefined && input.schema !== LEDGER_SCHEMA) {
    throw new TypeError(`Ledger gap schema must be ${LEDGER_SCHEMA}.`);
  }
  if (
    input.entry_type !== undefined &&
    input.entry_type !== 'gap'
  ) {
    throw new TypeError('Ledger gap entry_type must be "gap".');
  }
  if (!LEDGER_GAP_REASON_SET.has(input.reason)) {
    throw new TypeError(
      `Ledger gap reason must be one of: ${LEDGER_GAP_REASONS.join(', ')}.`,
    );
  }

  const knownFields = [
    'known_usage',
    'known_cost_usd_nanos',
    'known_cost_eur_nanos',
  ];
  const knownFieldCount = knownFields.filter((field) =>
    Object.hasOwn(input, field),
  ).length;
  if (knownFieldCount !== 0 && knownFieldCount !== knownFields.length) {
    throw new TypeError(
      'Ledger gap known_usage, known_cost_usd_nanos, and known_cost_eur_nanos must be provided together.',
    );
  }

  const gap = {
    schema: LEDGER_SCHEMA,
    entry_type: 'gap',
    root_thread_id: requireString(input.root_thread_id, 'root_thread_id'),
    turn_id: requireString(input.turn_id, 'turn_id'),
    completed_at: normalizeTimestamp(input.completed_at, 'completed_at'),
    written_at: normalizeTimestamp(
      input.written_at,
      'written_at',
      options.now ?? Date.now(),
    ),
    reason: input.reason,
  };
  if (knownFieldCount === knownFields.length) {
    gap.known_usage = requireLedgerUsage(input.known_usage);
    gap.known_cost_usd_nanos = requireNanos(
      input.known_cost_usd_nanos,
      'known_cost_usd_nanos',
    );
    gap.known_cost_eur_nanos = requireNanos(
      input.known_cost_eur_nanos,
      'known_cost_eur_nanos',
    );
  }
  return gap;
}

function ledgerGapHasKnownSummary(gap) {
  return (
    isObject(gap?.known_usage) &&
    Number.isSafeInteger(gap?.known_cost_usd_nanos) &&
    Number.isSafeInteger(gap?.known_cost_eur_nanos)
  );
}

function knownGapExceedsRecord(gap, record) {
  if (!ledgerGapHasKnownSummary(gap)) {
    return false;
  }
  return (
    gap.known_cost_eur_nanos > record.cost_eur_nanos ||
    !Number.isSafeInteger(record.cost_usd_nanos) ||
    gap.known_cost_usd_nanos > record.cost_usd_nanos ||
    usageExceeds(gap.known_usage, record.usage)
  );
}

function safeHash(value, length = 16) {
  return crypto
    .createHash('sha256')
    .update(String(value), 'utf8')
    .digest('hex')
    .slice(0, length);
}

function safeTaskKey(rootThreadId) {
  return safeHash(rootThreadId, 16);
}

function safeTaskLabel(rootThreadId) {
  return `Task ${safeHash(rootThreadId, 8)}`;
}

function safeTurnLabel(turnId) {
  return `Turn ${safeHash(turnId, 8)}`;
}

function ledgerPathFor(dataRoot, record) {
  const utcMonth = record.completed_at.slice(0, 7);
  return path.join(
    resolveDataRoot(dataRoot),
    'usage',
    utcMonth,
    'turns.jsonl',
  );
}

function logicalRecord(record) {
  const copy = { ...record };
  delete copy.written_at;
  return copy;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameLogicalRecord(left, right) {
  return (
    stableStringify(logicalRecord(left)) ===
    stableStringify(logicalRecord(right))
  );
}

function ledgerReadCachePath(dataRoot) {
  return path.join(
    resolveDataRoot(dataRoot),
    'cache',
    `ledger-read-v${LEDGER_READ_CACHE_SCHEMA}.json.gz`,
  );
}

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function bigintStatValue(stat, field, millisecondField) {
  if (typeof stat?.[field] === 'bigint') {
    return stat[field].toString();
  }
  const milliseconds = Number(stat?.[millisecondField] ?? 0);
  return BigInt(Math.max(0, Math.round(milliseconds * 1_000_000))).toString();
}

function ledgerFileVersion(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: bigintStatValue(stat, 'birthtimeNs', 'birthtimeMs'),
    size: String(stat.size),
    mtime_ns: bigintStatValue(stat, 'mtimeNs', 'mtimeMs'),
    ctime_ns: bigintStatValue(stat, 'ctimeNs', 'ctimeMs'),
  };
}

function sameLedgerFileIdentity(left, right) {
  return (
    left?.dev === right?.dev &&
    left?.ino === right?.ino &&
    left?.birthtime_ns === right?.birthtime_ns
  );
}

function sameLedgerFileVersion(left, right) {
  return (
    sameLedgerFileIdentity(left, right) &&
    left?.size === right?.size &&
    left?.mtime_ns === right?.mtime_ns &&
    left?.ctime_ns === right?.ctime_ns
  );
}

function validLedgerFileVersion(value) {
  return (
    isObject(value) &&
    ['dev', 'ino', 'birthtime_ns', 'size', 'mtime_ns', 'ctime_ns'].every(
      (field) =>
        typeof value[field] === 'string' && /^\d+$/.test(value[field]),
    )
  );
}

function validateCachedLedgerFile(value) {
  if (
    !isObject(value) ||
    typeof value.relative_path !== 'string' ||
    !/^\d{4}-\d{2}\/turns\.jsonl$/.test(value.relative_path) ||
    !validLedgerFileVersion(value.source) ||
    !Number.isSafeInteger(value.line_count) ||
    value.line_count < 0 ||
    typeof value.ends_with_newline !== 'boolean' ||
    typeof value.tail_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.tail_hash) ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every((item) => typeof item === 'string') ||
    !Array.isArray(value.entries) ||
    !value.entries.every(
      (entry) =>
        isObject(entry) &&
        entry.schema === LEDGER_SCHEMA &&
        (entry.entry_type === undefined ||
          entry.entry_type === 'record' ||
          entry.entry_type === 'gap'),
    )
  ) {
    throw new TypeError('Cached ledger file is invalid.');
  }

  return {
    relative_path: value.relative_path,
    source: value.source,
    line_count: value.line_count,
    ends_with_newline: value.ends_with_newline,
    tail_hash: value.tail_hash,
    complete: value.complete,
    diagnostics: value.diagnostics,
    entries: value.entries,
  };
}

function validateCachedLedgerDirectory(value) {
  if (
    !isObject(value) ||
    typeof value.month !== 'string' ||
    !/^\d{4}-\d{2}$/.test(value.month) ||
    !validLedgerFileVersion(value.source) ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.pending_files) ||
    !value.pending_files.every(
      (fileName) =>
        fileName === 'turns.jsonl',
    ) ||
    !(
      value.generation_source === null ||
      validLedgerFileVersion(value.generation_source)
    )
  ) {
    throw new TypeError('Cached ledger directory is invalid.');
  }
  if (
    value.complete !== (value.pending_files.length === 0) ||
    new Set(value.pending_files).size !== value.pending_files.length
  ) {
    throw new TypeError('Cached ledger directory progress is invalid.');
  }
  return value;
}

function loadLedgerReadCache(dataRoot) {
  const cachePath = ledgerReadCachePath(dataRoot);
  let cacheStat;
  try {
    cacheStat = fs.statSync(cachePath, { bigint: true });
  } catch {
    ledgerReadMemoryCache.delete(cachePath);
    return null;
  }
  const cacheVersion = ledgerFileVersion(cacheStat);
  const inMemory = ledgerReadMemoryCache.get(cachePath);
  if (sameLedgerFileVersion(cacheVersion, inMemory?.source)) {
    return inMemory.cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(cachePath)).toString('utf8'),
    );
  } catch {
    ledgerReadMemoryCache.delete(cachePath);
    return null;
  }

  if (
    !isObject(parsed) ||
    parsed.schema !== LEDGER_READ_CACHE_SCHEMA ||
    !Array.isArray(parsed.files) ||
    !Array.isArray(parsed.directories)
  ) {
    return null;
  }

  try {
    const files = parsed.files.map(validateCachedLedgerFile);
    const directories = parsed.directories.map(
      validateCachedLedgerDirectory,
    );
    if (
      new Set(files.map((file) => file.relative_path)).size !== files.length ||
      new Set(directories.map((directory) => directory.month)).size !==
        directories.length
    ) {
      return null;
    }
    const cache = { files, directories };
    ledgerReadMemoryCache.set(cachePath, {
      source: ledgerFileVersion(
        fs.statSync(cachePath, { bigint: true }),
      ),
      cache,
    });
    return cache;
  } catch {
    ledgerReadMemoryCache.delete(cachePath);
    return null;
  }
}

function saveLedgerReadCache(dataRoot, cache) {
  const cachePath = ledgerReadCachePath(dataRoot);
  const compressed = zlib.gzipSync(
    JSON.stringify({
      schema: LEDGER_READ_CACHE_SCHEMA,
      files: cache.files,
      directories: cache.directories,
    }),
    { level: 1 },
  );
  atomicWriteBuffer(cachePath, compressed);
  ledgerReadMemoryCache.set(cachePath, {
    source: ledgerFileVersion(fs.statSync(cachePath, { bigint: true })),
    cache,
  });
}

function parseLedgerText(filePath, content, startLine = 1) {
  const entries = [];
  const diagnostics = [];
  let complete = true;
  const lines = content.split(/\r?\n/);
  const lineCount =
    content.length === 0
      ? 0
      : lines.length - (content.endsWith('\n') ? 1 : 0);

  for (let index = 0; index < lineCount; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      complete = false;
      diagnostics.push(
        `Ignored invalid JSON in ${path.basename(filePath)} line ${startLine + index}.`,
      );
      continue;
    }
    if (raw?.schema === 1) {
      // Version 0.1.x ledgers are intentionally not imported. Accounting
      // starts fresh with schema 2, and legacy records do not make the new
      // ledger traversal incomplete.
      continue;
    }
    if (raw?.schema !== LEDGER_SCHEMA) {
      complete = false;
      diagnostics.push(
        `Ignored unsupported ledger schema in ${path.basename(filePath)} line ${startLine + index}.`,
      );
      continue;
    }
    const isGap = raw?.entry_type === 'gap';
    try {
      entries.push(
        isGap
          ? normalizeLedgerGap(raw, {
              now: raw?.written_at ?? raw?.completed_at,
            })
          : normalizeLedgerRecord(raw, {
              now: raw?.written_at ?? raw?.completed_at,
            }),
      );
    } catch (error) {
      complete = false;
      diagnostics.push(
        `Ignored invalid ledger ${isGap ? 'gap' : 'record'} in ${path.basename(filePath)} line ${startLine + index}: ${error.message}`,
      );
    }
  }

  return {
    entries,
    diagnostics,
    complete,
    lineCount,
  };
}

function tailHash(buffer) {
  return hashBuffer(
    buffer.subarray(
      Math.max(0, buffer.length - LEDGER_READ_CACHE_TAIL_BYTES),
    ),
  );
}

function readFileRange(descriptor, start, length) {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new RangeError('Ledger file is too large to read safely.');
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      offset,
      length - offset,
      start + offset,
    );
    if (bytesRead === 0) {
      throw new Error('Ledger file changed while it was being read.');
    }
    offset += bytesRead;
  }
  return buffer;
}

function readStableLedgerFile(filePath, cachedFile) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(filePath, 'r');
      const beforeStat = fs.fstatSync(descriptor, { bigint: true });
      const before = ledgerFileVersion(beforeStat);
      if (sameLedgerFileVersion(before, cachedFile?.source)) {
        return { reused: true, file: cachedFile };
      }

      const currentSize = Number(beforeStat.size);
      const cachedSize = Number(cachedFile?.source?.size ?? -1);
      const canReadAppend =
        cachedFile !== undefined &&
        sameLedgerFileIdentity(before, cachedFile.source) &&
        Number.isSafeInteger(currentSize) &&
        Number.isSafeInteger(cachedSize) &&
        currentSize > cachedSize &&
        cachedFile.ends_with_newline;
      const anchorLength = canReadAppend
        ? Math.min(LEDGER_READ_CACHE_TAIL_BYTES, cachedSize)
        : 0;
      const start = canReadAppend ? cachedSize - anchorLength : 0;
      const buffer = readFileRange(
        descriptor,
        start,
        currentSize - start,
      );
      const after = ledgerFileVersion(
        fs.fstatSync(descriptor, { bigint: true }),
      );
      if (!sameLedgerFileVersion(before, after)) {
        continue;
      }

      if (
        canReadAppend &&
        tailHash(buffer.subarray(0, anchorLength)) === cachedFile.tail_hash
      ) {
        const appended = buffer.subarray(anchorLength).toString('utf8');
        const parsed = parseLedgerText(
          filePath,
          appended,
          cachedFile.line_count + 1,
        );
        return {
          reused: false,
          file: {
            relative_path: cachedFile.relative_path,
            source: after,
            line_count: cachedFile.line_count + parsed.lineCount,
            ends_with_newline:
              buffer.length > 0 && buffer[buffer.length - 1] === 0x0a,
            tail_hash: tailHash(buffer),
            complete: cachedFile.complete && parsed.complete,
            diagnostics: [
              ...cachedFile.diagnostics,
              ...parsed.diagnostics,
            ],
            entries: [...cachedFile.entries, ...parsed.entries],
          },
        };
      }

      const fullBuffer =
        start === 0
          ? buffer
          : readFileRange(descriptor, 0, currentSize);
      const finalVersion =
        start === 0
          ? after
          : ledgerFileVersion(
              fs.fstatSync(descriptor, { bigint: true }),
            );
      if (!sameLedgerFileVersion(after, finalVersion)) {
        continue;
      }
      const content = fullBuffer.toString('utf8');
      const parsed = parseLedgerText(filePath, content);
      return {
        reused: false,
        file: {
          relative_path: cachedFile?.relative_path,
          source: finalVersion,
          line_count: parsed.lineCount,
          ends_with_newline:
            fullBuffer.length > 0 &&
            fullBuffer[fullBuffer.length - 1] === 0x0a,
          tail_hash: tailHash(fullBuffer),
          complete: parsed.complete,
          diagnostics: parsed.diagnostics,
          entries: parsed.entries,
        },
      };
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  }
  throw new Error('Ledger file kept changing while it was being read.');
}

function ledgerGenerationPath(monthDirectory) {
  return path.join(monthDirectory, '.generation');
}

function optionalLedgerFileVersion(filePath) {
  try {
    return ledgerFileVersion(fs.statSync(filePath, { bigint: true }));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function sameOptionalLedgerFileVersion(left, right) {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      sameLedgerFileVersion(left, right))
  );
}

function ledgerMonths(dataRoot, diagnostics) {
  const usageRoot = path.join(resolveDataRoot(dataRoot), 'usage');
  let monthEntries;
  try {
    monthEntries = fs.readdirSync(usageRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { months: [], complete: true };
    }
    diagnostics.push(`Usage ledger could not be listed: ${error.message}`);
    return { months: [], complete: false };
  }

  const months = [];
  for (const monthEntry of monthEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      !monthEntry.isDirectory() ||
      !/^\d{4}-\d{2}$/.test(monthEntry.name)
    ) {
      continue;
    }
    months.push({
      month: monthEntry.name,
      directoryPath: path.join(usageRoot, monthEntry.name),
    });
  }
  return { months, complete: true };
}

function readLedgerMonth(
  monthInfo,
  cachedDirectory,
  cachedFiles,
  options = {},
) {
  const maxFiles = Number.isSafeInteger(options.maxFiles)
    ? Math.max(0, options.maxFiles)
    : Number.POSITIVE_INFINITY;
  const deadlineMs =
    typeof options.deadlineMs === 'number' &&
    Number.isFinite(options.deadlineMs)
      ? options.deadlineMs
      : Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const directoryStat = fs.statSync(monthInfo.directoryPath, {
      bigint: true,
    });
    if (!directoryStat.isDirectory()) {
      throw new Error('Ledger month path is not a directory.');
    }
    const directorySource = ledgerFileVersion(directoryStat);
    const generationSource = optionalLedgerFileVersion(
      ledgerGenerationPath(monthInfo.directoryPath),
    );

    if (
      cachedDirectory &&
      sameLedgerFileVersion(
        directorySource,
        cachedDirectory.source,
      ) &&
      sameOptionalLedgerFileVersion(
        generationSource,
        cachedDirectory.generation_source,
      )
    ) {
      if (cachedDirectory.complete) {
        return {
          reused: true,
          files: cachedFiles,
          directory: cachedDirectory,
          processed: 0,
        };
      }
    }

    const canResume =
      cachedDirectory &&
      sameLedgerFileVersion(
        directorySource,
        cachedDirectory.source,
      ) &&
      sameOptionalLedgerFileVersion(
        generationSource,
        cachedDirectory.generation_source,
      );
    const files = canResume ? [...cachedFiles] : [];
    let pendingFiles;
    if (canResume) {
      pendingFiles = [...cachedDirectory.pending_files];
    } else {
      const canonicalPath = path.join(
        monthInfo.directoryPath,
        'turns.jsonl',
      );
      try {
        pendingFiles = fs
          .lstatSync(canonicalPath)
          .isFile()
          ? ['turns.jsonl']
          : [];
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
        pendingFiles = [];
      }
    }
    let processed = 0;
    while (
      pendingFiles.length > 0 &&
      processed < maxFiles &&
      Date.now() < deadlineMs
    ) {
      const fileName = pendingFiles.shift();
      const filePath = path.join(monthInfo.directoryPath, fileName);
      const relativePath = `${monthInfo.month}/${fileName}`;
      const loaded = readStableLedgerFile(filePath);
      loaded.file.relative_path = relativePath;
      files.push(loaded.file);
      processed += 1;
    }

    const finalDirectorySource = ledgerFileVersion(
      fs.statSync(monthInfo.directoryPath, { bigint: true }),
    );
    const finalGenerationSource = optionalLedgerFileVersion(
      ledgerGenerationPath(monthInfo.directoryPath),
    );
    if (
      !sameLedgerFileVersion(directorySource, finalDirectorySource) ||
      !sameOptionalLedgerFileVersion(
        generationSource,
        finalGenerationSource,
      )
    ) {
      continue;
    }

    return {
      reused: false,
      files,
      processed,
      directory: {
        month: monthInfo.month,
        source: finalDirectorySource,
        generation_source: finalGenerationSource,
        complete: pendingFiles.length === 0,
        pending_files: pendingFiles,
      },
    };
  }
  throw new Error('Ledger month kept changing while it was being read.');
}

function reconcileLedgerFiles(
  files,
  initialDiagnostics = [],
  initialComplete = true,
  initialIssues = [],
) {
  const diagnostics = [...initialDiagnostics];
  const conflicts = [];
  const issues = [...initialIssues];
  const recordsByTurn = new Map();
  const gapsByTurn = new Map();
  let complete = initialComplete;

  for (const file of files) {
    diagnostics.push(...file.diagnostics);
    complete = complete && file.complete;
    if (!file.complete) {
      const relativePath = file.relative_path ?? '';
      const monthMatch = /^(\d{4}-\d{2})\/turns\.jsonl$/.exec(
        relativePath,
      );
      issues.push({
        kind: monthMatch ? 'month' : 'global',
        utc_month: monthMatch?.[1] ?? null,
        task_key: null,
        completed_at: null,
        diagnostics: [...file.diagnostics],
      });
    }
    for (const entry of file.entries) {
      const isGap = entry.entry_type === 'gap';

      const key = `${entry.root_thread_id}\u0000${entry.turn_id}`;
      if (isGap) {
        const existingRecord = recordsByTurn.get(key);
        const existingGap = gapsByTurn.get(key);
        if (existingRecord) {
          if (knownGapExceedsRecord(entry, existingRecord)) {
            complete = false;
            conflicts.push({
              key,
              kind: 'gap-known-summary-exceeds-record',
              root_thread_id: entry.root_thread_id,
              turn_id: entry.turn_id,
              first: existingRecord,
              conflicting: entry,
            });
            const diagnostic = `Gap known lower bound exceeds its exact record for ${safeTaskLabel(entry.root_thread_id)} ${safeTurnLabel(entry.turn_id)}.`;
            diagnostics.push(diagnostic);
            issues.push({
              kind: 'conflict',
              utc_month: entry.completed_at.slice(0, 7),
              task_key: safeHash(entry.root_thread_id, 24),
              completed_at: entry.completed_at,
              diagnostics: [diagnostic],
            });
          }
          continue;
        }
        if (!existingGap) {
          gapsByTurn.set(key, entry);
          continue;
        }
        if (!sameLogicalRecord(existingGap, entry)) {
          complete = false;
          conflicts.push({
            key,
            kind: 'conflicting-gap',
            root_thread_id: entry.root_thread_id,
            turn_id: entry.turn_id,
            first: existingGap,
            conflicting: entry,
          });
          diagnostics.push(
            `Conflicting gap ignored for ${safeTaskLabel(entry.root_thread_id)} ${safeTurnLabel(entry.turn_id)}.`,
          );
          issues.push({
            kind: 'conflict',
            utc_month: entry.completed_at.slice(0, 7),
            task_key: safeHash(entry.root_thread_id, 24),
            completed_at: entry.completed_at,
            diagnostics: [
              `Conflicting gap ignored for ${safeTaskLabel(entry.root_thread_id)} ${safeTurnLabel(entry.turn_id)}.`,
            ],
          });
        }
        continue;
      }

      const existing = recordsByTurn.get(key);
      if (existing && !sameLogicalRecord(existing, entry)) {
        complete = false;
        conflicts.push({
          key,
          kind: 'conflicting-record',
          root_thread_id: entry.root_thread_id,
          turn_id: entry.turn_id,
          first: existing,
          conflicting: entry,
        });
        diagnostics.push(
          `Conflicting duplicate ignored for ${safeTaskLabel(entry.root_thread_id)} ${safeTurnLabel(entry.turn_id)}.`,
        );
        issues.push({
          kind: 'conflict',
          utc_month: entry.completed_at.slice(0, 7),
          task_key: safeHash(entry.root_thread_id, 24),
          completed_at: entry.completed_at,
          diagnostics: [
            `Conflicting duplicate ignored for ${safeTaskLabel(entry.root_thread_id)} ${safeTurnLabel(entry.turn_id)}.`,
          ],
        });
        continue;
      }
      if (!existing) {
        recordsByTurn.set(key, entry);
      }

      const gap = gapsByTurn.get(key);
      if (gap) {
        if (!knownGapExceedsRecord(gap, entry)) {
          gapsByTurn.delete(key);
        } else {
          complete = false;
          gapsByTurn.delete(key);
          conflicts.push({
            key,
            kind: 'gap-known-summary-exceeds-record',
            root_thread_id: entry.root_thread_id,
            turn_id: entry.turn_id,
            first: gap,
            conflicting: entry,
          });
          const diagnostic = `Exact record is below its known gap lower bound for ${safeTaskLabel(entry.root_thread_id)} ${safeTurnLabel(entry.turn_id)}.`;
          diagnostics.push(diagnostic);
          issues.push({
            kind: 'conflict',
            utc_month: entry.completed_at.slice(0, 7),
            task_key: safeHash(entry.root_thread_id, 24),
            completed_at: entry.completed_at,
            diagnostics: [diagnostic],
          });
        }
      }
    }
  }

  return {
    records: [...recordsByTurn.values()],
    gaps: [...gapsByTurn.values()],
    conflicts,
    issues,
    diagnostics,
    complete,
  };
}

function readLedger(dataRoot, options = {}) {
  const root = resolveDataRoot(dataRoot);
  const diagnostics = [];
  const discovered = ledgerMonths(root, diagnostics);
  const issues = discovered.complete
    ? []
    : [
        {
          kind: 'global',
          utc_month: null,
          task_key: null,
          completed_at: null,
          diagnostics: [...diagnostics],
        },
      ];
  const requestedMonths = Array.isArray(options.months)
    ? new Set(
        options.months.filter(
          (month) =>
            typeof month === 'string' && /^\d{4}-\d{2}$/.test(month),
        ),
      )
    : null;
  const listedMonths = requestedMonths
    ? discovered.months
        .filter((item) => requestedMonths.has(item.month))
        .sort(
          (left, right) =>
            options.months.indexOf(left.month) -
            options.months.indexOf(right.month),
        )
    : discovered.months;
  const cached = loadLedgerReadCache(root);
  const cachedFilesByPath = new Map(
    (cached?.files ?? []).map((file) => [file.relative_path, file]),
  );
  const cachedDirectoriesByMonth = new Map(
    (cached?.directories ?? []).map((directory) => [
      directory.month,
      directory,
    ]),
  );
  const files = [];
  const directories = [];
  let traversalComplete = discovered.complete;
  let cacheWritable = discovered.complete;
  let cacheChanged = cached === null;
  let remainingFiles = Number.isSafeInteger(options.maxFiles)
    ? Math.max(0, options.maxFiles)
    : Number.POSITIVE_INFINITY;
  if (!requestedMonths) {
    cacheChanged =
      cacheChanged ||
      cachedDirectoriesByMonth.size !== listedMonths.length;
  } else {
    const listedNames = new Set(listedMonths.map((item) => item.month));
    for (const month of requestedMonths) {
      if (
        listedNames.has(month) !==
        cachedDirectoriesByMonth.has(month)
      ) {
        cacheChanged = true;
      }
    }
  }

  for (const monthInfo of listedMonths) {
    const cachedDirectory = cachedDirectoriesByMonth.get(monthInfo.month);
    const cachedFiles = [...cachedFilesByPath.values()].filter((file) =>
      file.relative_path.startsWith(`${monthInfo.month}/`),
    );
    try {
      const loaded = readLedgerMonth(
        monthInfo,
        cachedDirectory,
        cachedFiles,
        {
          maxFiles: Math.min(
            remainingFiles,
            Number.isSafeInteger(options.maxFilesPerMonth)
              ? Math.max(0, options.maxFilesPerMonth)
              : Number.POSITIVE_INFINITY,
          ),
          deadlineMs: options.deadlineMs,
        },
      );
      remainingFiles -= loaded.processed;
      files.push(...loaded.files);
      directories.push(loaded.directory);
      cacheChanged = cacheChanged || !loaded.reused;
      if (!loaded.directory.complete) {
        traversalComplete = false;
        const diagnostic = `Usage ledger cache is warming for ${monthInfo.month}; ${loaded.directory.pending_files.length} files remain.`;
        diagnostics.push(diagnostic);
        issues.push({
          kind: 'month',
          utc_month: monthInfo.month,
          task_key: null,
          completed_at: null,
          diagnostics: [diagnostic],
        });
      }
    } catch (error) {
      traversalComplete = false;
      cacheWritable = false;
      const diagnostic = `Usage month ${monthInfo.month} could not be read: ${error.message}`;
      diagnostics.push(diagnostic);
      issues.push({
        kind: 'month',
        utc_month: monthInfo.month,
        task_key: null,
        completed_at: null,
        diagnostics: [diagnostic],
      });
    }
  }

  if (cacheWritable && cacheChanged) {
    try {
      const preservedFiles = requestedMonths
        ? (cached?.files ?? []).filter(
            (file) =>
              !requestedMonths.has(file.relative_path.slice(0, 7)),
          )
        : [];
      const preservedDirectories = requestedMonths
        ? (cached?.directories ?? []).filter(
            (directory) => !requestedMonths.has(directory.month),
          )
        : [];
      saveLedgerReadCache(root, {
        files: [...preservedFiles, ...files].sort((left, right) =>
          left.relative_path.localeCompare(right.relative_path),
        ),
        directories: [...preservedDirectories, ...directories].sort(
          (left, right) => left.month.localeCompare(right.month),
        ),
      });
    } catch {
      // This cache is optional and rebuildable. Ledger correctness never
      // depends on a successful derived-cache write.
    }
  }

  return reconcileLedgerFiles(
    files,
    diagnostics,
    traversalComplete,
    issues,
  );
}

function bumpLedgerGeneration(monthDirectory) {
  atomicWriteBuffer(
    ledgerGenerationPath(monthDirectory),
    Buffer.from(
      `${Date.now()}-${process.pid}-${crypto.randomBytes(12).toString('hex')}\n`,
      'utf8',
    ),
  );
}

function refreshLedgerReadCacheAfterAppend(dataRoot, ledgerPath) {
  const root = resolveDataRoot(dataRoot);
  const cached = loadLedgerReadCache(root);
  if (!cached) {
    return false;
  }

  const usageRoot = path.join(root, 'usage');
  const relativePath = path
    .relative(usageRoot, ledgerPath)
    .split(path.sep)
    .join('/');
  const match = /^(\d{4}-\d{2})\/turns\.jsonl$/.exec(relativePath);
  if (!match) {
    throw new Error('Ledger path is outside the usage ledger.');
  }
  const month = match[1];
  const monthDirectory = path.dirname(ledgerPath);
  const cachedDirectory = cached.directories.find(
    (directory) => directory.month === month,
  );
  if (!cachedDirectory) {
    return false;
  }
  const cachedFile = cached.files.find(
    (file) => file.relative_path === relativePath,
  );
  const loaded = readStableLedgerFile(ledgerPath, cachedFile);
  loaded.file.relative_path = relativePath;

  const files = cached.files
    .filter((file) => file.relative_path !== relativePath)
    .concat(loaded.file)
    .sort((left, right) =>
      left.relative_path.localeCompare(right.relative_path),
    );
  const directoryStat = fs.statSync(monthDirectory, { bigint: true });
  if (!directoryStat.isDirectory()) {
    throw new Error('Ledger month path is not a directory.');
  }
  const pendingFiles = cachedDirectory.pending_files.filter(
    (fileName) => fileName !== path.basename(ledgerPath),
  );
  const directory = {
    month,
    source: ledgerFileVersion(directoryStat),
    generation_source: optionalLedgerFileVersion(
      ledgerGenerationPath(monthDirectory),
    ),
    complete: pendingFiles.length === 0,
    pending_files: pendingFiles,
  };
  const directories = cached.directories
    .filter((candidate) => candidate.month !== month)
    .concat(directory)
    .sort((left, right) => left.month.localeCompare(right.month));
  saveLedgerReadCache(root, { files, directories });
  return true;
}

function readLedgerTaskFiles(dataRoot, record) {
  void record;
  return readLedger(dataRoot);
}

function hookRollupCachePath(dataRoot) {
  return path.join(
    resolveDataRoot(dataRoot),
    'cache',
    `hook-rollup-v${HOOK_ROLLUP_SCHEMA}.json`,
  );
}

function emptyHookRollupSummary() {
  return {
    cost_eur_nanos: 0,
    usage: zeroUsage(),
    turns: 0,
    pending_turns: 0,
  };
}

function hookRollupSessionKey(rootThreadId) {
  return safeHash(rootThreadId, 64);
}

function hookRollupGapKey(rootThreadId, turnId) {
  return safeHash(`${rootThreadId}\u0000${turnId}`, 64);
}

function validateHookRollupSummary(value) {
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.turns) ||
    value.turns < 0 ||
    !Number.isSafeInteger(value.pending_turns) ||
    value.pending_turns < 0
  ) {
    throw new TypeError('Hook rollup summary is invalid.');
  }
  return {
    cost_eur_nanos: requireNanos(
      value.cost_eur_nanos,
      'cost_eur_nanos',
    ),
    usage: requireLedgerUsage(value.usage),
    turns: value.turns,
    pending_turns: value.pending_turns,
  };
}

function validateHookRollupSource(value) {
  if (
    !isObject(value) ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.months)
  ) {
    throw new TypeError('Hook rollup source is invalid.');
  }
  const months = value.months.map((item) => {
    if (
      !isObject(item) ||
      typeof item.month !== 'string' ||
      !/^\d{4}-\d{2}$/.test(item.month) ||
      !validLedgerFileVersion(item.directory) ||
      !(
        item.generation === null ||
        validLedgerFileVersion(item.generation)
      )
    ) {
      throw new TypeError('Hook rollup source month is invalid.');
    }
    return {
      month: item.month,
      directory: item.directory,
      generation: item.generation,
    };
  });
  if (
    new Set(months.map((item) => item.month)).size !== months.length ||
    months.some(
      (item, index) =>
        index > 0 && months[index - 1].month >= item.month,
    )
  ) {
    throw new TypeError('Hook rollup source months are invalid.');
  }
  return { complete: value.complete, months };
}

function validateHookRollupSummaries(value, keyPattern, field) {
  if (!isObject(value)) {
    throw new TypeError(`Hook rollup ${field} are invalid.`);
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!keyPattern.test(key)) {
      throw new TypeError(`Hook rollup ${field} key is invalid.`);
    }
    result[key] = validateHookRollupSummary(value[key]);
  }
  return result;
}

function validateHookRollupIssue(value) {
  if (
    !isObject(value) ||
    !['global', 'month', 'file', 'conflict'].includes(value.kind) ||
    !(
      value.utc_month === null ||
      (
        typeof value.utc_month === 'string' &&
        /^\d{4}-\d{2}$/.test(value.utc_month)
      )
    ) ||
    !(
      value.task_key === null ||
      (
        typeof value.task_key === 'string' &&
        /^[a-f0-9]{24}$/.test(value.task_key)
      )
    ) ||
    !(
      value.completed_at === null ||
      (
        typeof value.completed_at === 'string' &&
        normalizeTimestamp(value.completed_at, 'completed_at') ===
          value.completed_at
      )
    ) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length === 0 ||
    !value.diagnostics.every(
      (diagnostic) => typeof diagnostic === 'string',
    )
  ) {
    throw new TypeError('Hook rollup issue is invalid.');
  }
  if (
    (value.kind === 'global' &&
      (
        value.utc_month !== null ||
        value.task_key !== null ||
        value.completed_at !== null
      )) ||
    (value.kind === 'month' &&
      (
        value.utc_month === null ||
        value.task_key !== null ||
        value.completed_at !== null
      )) ||
    (value.kind === 'file' &&
      (
        value.utc_month === null ||
        value.task_key === null ||
        value.completed_at !== null
      )) ||
    (value.kind === 'conflict' &&
      (
        value.utc_month === null ||
        value.task_key === null ||
        value.completed_at === null
      ))
  ) {
    throw new TypeError('Hook rollup issue scope is invalid.');
  }
  return {
    kind: value.kind,
    utc_month: value.utc_month,
    task_key: value.task_key,
    completed_at: value.completed_at,
    diagnostics: [...value.diagnostics],
  };
}

function validateHookRollupPayload(value) {
  if (
    !isObject(value) ||
    !isValidTimeZone(value.timezone) ||
    typeof value.active_date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.active_date) ||
    value.active_month !== value.active_date.slice(0, 7) ||
    !(
      value.sealed_through === null ||
      (
        typeof value.sealed_through === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value.sealed_through) &&
        value.sealed_through < value.active_date
      )
    ) ||
    !Array.isArray(value.issues) ||
    !isObject(value.unresolved_gaps)
  ) {
    throw new TypeError('Hook rollup payload is invalid.');
  }

  const source = validateHookRollupSource(value.source);
  const days = validateHookRollupSummaries(
    value.days,
    /^\d{4}-\d{2}-\d{2}$/,
    'days',
  );
  const months = validateHookRollupSummaries(
    value.months,
    /^\d{4}-\d{2}$/,
    'months',
  );
  const sessions = validateHookRollupSummaries(
    value.sessions,
    /^[a-f0-9]{64}$/,
    'sessions',
  );
  const unresolvedGaps = {};
  const pendingByDay = new Map();
  const pendingByMonth = new Map();
  const pendingBySession = new Map();
  for (const key of Object.keys(value.unresolved_gaps).sort()) {
    const gap = value.unresolved_gaps[key];
    const knownFields = [
      'known_usage',
      'known_cost_usd_nanos',
      'known_cost_eur_nanos',
    ];
    const knownFieldCount = isObject(gap)
      ? knownFields.filter((field) => Object.hasOwn(gap, field)).length
      : 0;
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !isObject(gap) ||
      typeof gap.session_key !== 'string' ||
      !/^[a-f0-9]{64}$/.test(gap.session_key) ||
      typeof gap.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(gap.date) ||
      gap.month !== gap.date.slice(0, 7) ||
      (knownFieldCount !== 0 && knownFieldCount !== knownFields.length)
    ) {
      throw new TypeError('Hook rollup unresolved gap is invalid.');
    }
    const normalizedGap = {
      session_key: gap.session_key,
      date: gap.date,
      month: gap.month,
    };
    if (knownFieldCount === knownFields.length) {
      normalizedGap.known_usage = requireLedgerUsage(gap.known_usage);
      normalizedGap.known_cost_usd_nanos = requireNanos(
        gap.known_cost_usd_nanos,
        'known_cost_usd_nanos',
      );
      normalizedGap.known_cost_eur_nanos = requireNanos(
        gap.known_cost_eur_nanos,
        'known_cost_eur_nanos',
      );
    }
    unresolvedGaps[key] = normalizedGap;
    pendingByDay.set(gap.date, (pendingByDay.get(gap.date) ?? 0) + 1);
    pendingByMonth.set(
      gap.month,
      (pendingByMonth.get(gap.month) ?? 0) + 1,
    );
    pendingBySession.set(
      gap.session_key,
      (pendingBySession.get(gap.session_key) ?? 0) + 1,
    );
  }

  for (const [key, summary] of Object.entries(days)) {
    if (summary.pending_turns !== (pendingByDay.get(key) ?? 0)) {
      throw new TypeError('Hook rollup day pending count is invalid.');
    }
  }
  for (const [key, summary] of Object.entries(months)) {
    if (summary.pending_turns !== (pendingByMonth.get(key) ?? 0)) {
      throw new TypeError('Hook rollup month pending count is invalid.');
    }
  }
  for (const [key, summary] of Object.entries(sessions)) {
    if (summary.pending_turns !== (pendingBySession.get(key) ?? 0)) {
      throw new TypeError('Hook rollup session pending count is invalid.');
    }
  }
  if (
    [...pendingByDay.keys()].some((key) => !Object.hasOwn(days, key)) ||
    [...pendingByMonth.keys()].some((key) => !Object.hasOwn(months, key)) ||
    [...pendingBySession.keys()].some(
      (key) => !Object.hasOwn(sessions, key),
    )
  ) {
    throw new TypeError('Hook rollup pending summaries are incomplete.');
  }

  return {
    timezone: value.timezone,
    active_date: value.active_date,
    active_month: value.active_month,
    sealed_through: value.sealed_through,
    source,
    issues: value.issues.map(validateHookRollupIssue),
    days,
    months,
    sessions,
    unresolved_gaps: unresolvedGaps,
  };
}

function canonicalHookRollupPayload(payload) {
  const sortObject = (value) =>
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  const issues = [
    ...new Map(
      payload.issues.map((issue) => [stableStringify(issue), issue]),
    ).values(),
  ].sort((left, right) =>
    stableStringify(left).localeCompare(stableStringify(right)),
  );
  return {
    timezone: payload.timezone,
    active_date: payload.active_date,
    active_month: payload.active_month,
    sealed_through: payload.sealed_through,
    source: {
      complete: payload.source.complete,
      months: [...payload.source.months].sort((left, right) =>
        left.month.localeCompare(right.month),
      ),
    },
    issues,
    days: sortObject(payload.days),
    months: sortObject(payload.months),
    sessions: sortObject(payload.sessions),
    unresolved_gaps: sortObject(payload.unresolved_gaps),
  };
}

function loadHookRollupCache(dataRoot) {
  const filePath = hookRollupCachePath(dataRoot);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { payload: null, diagnostics: [] };
    }
    return {
      payload: null,
      diagnostics: [
        `Hook rollup cache will be rebuilt: ${error.message}`,
      ],
    };
  }

  try {
    if (
      !isObject(parsed) ||
      parsed.schema !== HOOK_ROLLUP_SCHEMA ||
      typeof parsed.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.checksum) ||
      !isObject(parsed.payload)
    ) {
      throw new TypeError('Hook rollup cache wrapper is invalid.');
    }
    const checksum = hashBuffer(
      Buffer.from(stableStringify(parsed.payload), 'utf8'),
    );
    if (checksum !== parsed.checksum) {
      throw new TypeError('Hook rollup cache checksum does not match.');
    }
    return {
      payload: validateHookRollupPayload(parsed.payload),
      diagnostics: [],
    };
  } catch (error) {
    return {
      payload: null,
      diagnostics: [
        `Hook rollup cache will be rebuilt: ${error.message}`,
      ],
    };
  }
}

function saveHookRollupCache(dataRoot, input) {
  const payload = canonicalHookRollupPayload(input);
  atomicWriteJson(hookRollupCachePath(dataRoot), {
    schema: HOOK_ROLLUP_SCHEMA,
    checksum: hashBuffer(
      Buffer.from(stableStringify(payload), 'utf8'),
    ),
    payload,
  });
  return payload;
}

function captureHookRollupSource(dataRoot) {
  const diagnostics = [];
  const discovered = ledgerMonths(dataRoot, diagnostics);
  const issues = discovered.complete
    ? []
    : [
        {
          kind: 'global',
          utc_month: null,
          task_key: null,
          completed_at: null,
          diagnostics: [...diagnostics],
        },
      ];
  const months = [];
  let complete = discovered.complete;
  for (const monthInfo of discovered.months) {
    try {
      const directory = fs.statSync(monthInfo.directoryPath, {
        bigint: true,
      });
      if (!directory.isDirectory()) {
        throw new Error('Usage month path is not a directory.');
      }
      months.push({
        month: monthInfo.month,
        directory: ledgerFileVersion(directory),
        generation: optionalLedgerFileVersion(
          ledgerGenerationPath(monthInfo.directoryPath),
        ),
      });
    } catch (error) {
      complete = false;
      const diagnostic = `Usage month ${monthInfo.month} source could not be read: ${error.message}`;
      diagnostics.push(diagnostic);
      issues.push({
        kind: 'month',
        utc_month: monthInfo.month,
        task_key: null,
        completed_at: null,
        diagnostics: [diagnostic],
      });
    }
  }
  return {
    source: {
      complete,
      months: months.sort((left, right) =>
        left.month.localeCompare(right.month),
      ),
    },
    diagnostics,
    issues,
  };
}

function sameHookRollupSource(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function hookRollupSummary(payload, field, key) {
  if (!Object.hasOwn(payload[field], key)) {
    payload[field][key] = emptyHookRollupSummary();
  }
  return payload[field][key];
}

function addHookRollupRecord(summary, record) {
  summary.cost_eur_nanos += record.cost_eur_nanos;
  summary.usage = addUsage(summary.usage, record.usage);
  summary.turns += 1;
}

function addHookRollupKnownSummary(summary, gap) {
  if (!ledgerGapHasKnownSummary(gap)) {
    return;
  }
  summary.cost_eur_nanos += gap.known_cost_eur_nanos;
  summary.usage = addUsage(summary.usage, gap.known_usage);
}

function subtractHookRollupKnownSummary(summary, gap) {
  if (!ledgerGapHasKnownSummary(gap)) {
    return;
  }
  if (
    gap.known_cost_eur_nanos > summary.cost_eur_nanos ||
    usageExceeds(gap.known_usage, summary.usage)
  ) {
    throw new Error('Hook rollup known gap summary exceeds its aggregate.');
  }
  summary.cost_eur_nanos -= gap.known_cost_eur_nanos;
  summary.usage = subtractUsage(summary.usage, gap.known_usage);
}

function adjustHookRollupPending(summary, delta) {
  summary.pending_turns += delta;
  if (summary.pending_turns < 0) {
    throw new Error('Hook rollup pending count became negative.');
  }
}

function removeHookRollupGap(payload, gapKey) {
  const gap = payload.unresolved_gaps[gapKey];
  if (!gap) {
    return false;
  }
  subtractHookRollupKnownSummary(
    hookRollupSummary(payload, 'days', gap.date),
    gap,
  );
  subtractHookRollupKnownSummary(
    hookRollupSummary(payload, 'months', gap.month),
    gap,
  );
  subtractHookRollupKnownSummary(
    hookRollupSummary(payload, 'sessions', gap.session_key),
    gap,
  );
  adjustHookRollupPending(
    hookRollupSummary(payload, 'days', gap.date),
    -1,
  );
  adjustHookRollupPending(
    hookRollupSummary(payload, 'months', gap.month),
    -1,
  );
  adjustHookRollupPending(
    hookRollupSummary(payload, 'sessions', gap.session_key),
    -1,
  );
  delete payload.unresolved_gaps[gapKey];
  return true;
}

function applyHookRollupRecord(payload, record) {
  const parts = localDateParts(record.completed_at, payload.timezone);
  const sessionKey = hookRollupSessionKey(record.root_thread_id);
  removeHookRollupGap(
    payload,
    hookRollupGapKey(record.root_thread_id, record.turn_id),
  );
  addHookRollupRecord(
    hookRollupSummary(payload, 'days', parts.date),
    record,
  );
  addHookRollupRecord(
    hookRollupSummary(payload, 'months', parts.monthKey),
    record,
  );
  addHookRollupRecord(
    hookRollupSummary(payload, 'sessions', sessionKey),
    record,
  );
}

function applyHookRollupGap(payload, gap) {
  const gapKey = hookRollupGapKey(gap.root_thread_id, gap.turn_id);
  if (Object.hasOwn(payload.unresolved_gaps, gapKey)) {
    return;
  }
  const parts = localDateParts(gap.completed_at, payload.timezone);
  const sessionKey = hookRollupSessionKey(gap.root_thread_id);
  payload.unresolved_gaps[gapKey] = {
    session_key: sessionKey,
    date: parts.date,
    month: parts.monthKey,
    ...(ledgerGapHasKnownSummary(gap)
      ? {
          known_usage: gap.known_usage,
          known_cost_usd_nanos: gap.known_cost_usd_nanos,
          known_cost_eur_nanos: gap.known_cost_eur_nanos,
        }
      : {}),
  };
  addHookRollupKnownSummary(
    hookRollupSummary(payload, 'days', parts.date),
    gap,
  );
  addHookRollupKnownSummary(
    hookRollupSummary(payload, 'months', parts.monthKey),
    gap,
  );
  addHookRollupKnownSummary(
    hookRollupSummary(payload, 'sessions', sessionKey),
    gap,
  );
  adjustHookRollupPending(
    hookRollupSummary(payload, 'days', parts.date),
    1,
  );
  adjustHookRollupPending(
    hookRollupSummary(payload, 'months', parts.monthKey),
    1,
  );
  adjustHookRollupPending(
    hookRollupSummary(payload, 'sessions', sessionKey),
    1,
  );
}

function rollHookRollupClock(payload, now) {
  const parts = localDateParts(now, payload.timezone);
  if (payload.active_date === parts.date) {
    return false;
  }
  payload.active_date = parts.date;
  payload.active_month = parts.monthKey;
  payload.sealed_through = shiftDateKey(parts.date, -1);
  return true;
}

function createHookRollupPayload(ledger, sourceResult, timeZone, now) {
  const nowParts = localDateParts(now, timeZone);
  const issues = [
    ...(ledger.issues ?? []),
    ...(sourceResult.issues ?? []),
  ];
  if (!ledger.complete && issues.length === 0) {
    issues.push({
      kind: 'global',
      utc_month: null,
      task_key: null,
      completed_at: null,
      diagnostics:
        ledger.diagnostics.length > 0
          ? [...ledger.diagnostics]
          : ['Usage ledger traversal is incomplete.'],
    });
  }
  const payload = {
    timezone: timeZone,
    active_date: nowParts.date,
    active_month: nowParts.monthKey,
    sealed_through: shiftDateKey(nowParts.date, -1),
    source: sourceResult.source,
    issues,
    days: {},
    months: {},
    sessions: {},
    unresolved_gaps: {},
  };
  const compareEntries = (left, right) =>
    left.completed_at.localeCompare(right.completed_at) ||
    left.root_thread_id.localeCompare(right.root_thread_id) ||
    left.turn_id.localeCompare(right.turn_id);
  for (const record of [...ledger.records].sort(compareEntries)) {
    applyHookRollupRecord(payload, record);
  }
  for (const gap of [...ledger.gaps].sort(compareEntries)) {
    applyHookRollupGap(payload, gap);
  }
  return payload;
}

function rebuildHookRollupCacheLocked(dataRoot, timeZone, now) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = captureHookRollupSource(dataRoot);
    const ledger = readLedger(dataRoot);
    const after = captureHookRollupSource(dataRoot);
    if (sameHookRollupSource(before.source, after.source)) {
      return saveHookRollupCache(
        dataRoot,
        createHookRollupPayload(ledger, after, timeZone, now),
      );
    }
  }
  throw new Error(
    'Usage ledger kept changing while the hook rollup was rebuilt.',
  );
}

function resolveHookRollupSettings(dataRoot, options = {}) {
  return options.settings
    ? normalizeSettings(
        options.settings.settings ?? options.settings,
        { diagnoseMissing: false },
      )
    : loadSettings(dataRoot);
}

function prepareHookRollupAppend(dataRoot, options = {}) {
  const loadedSettings = resolveHookRollupSettings(dataRoot, options);
  const timeZone = loadedSettings.settings.timezone;
  const now = toTimestamp(
    options.rollupNow ?? options.now ?? Date.now(),
    'rollupNow',
  );
  const cached = loadHookRollupCache(dataRoot);
  const source = captureHookRollupSource(dataRoot);
  if (
    cached.payload &&
    cached.payload.timezone === timeZone &&
    source.source.complete &&
    sameHookRollupSource(cached.payload.source, source.source)
  ) {
    rollHookRollupClock(cached.payload, now);
    return {
      payload: cached.payload,
      timeZone,
      now,
      diagnostics: loadedSettings.diagnostics ?? [],
    };
  }
  return {
    payload: null,
    timeZone,
    now,
    diagnostics: loadedSettings.diagnostics ?? [],
  };
}

function updateHookRollupAfterAppend(dataRoot, entry, prepared) {
  if (!prepared.payload) {
    const ledgerCache = loadLedgerReadCache(dataRoot);
    if (
      ledgerCache?.directories.some(
        (directory) => !directory.complete,
      )
    ) {
      // Preserve the bounded warming contract of the general ledger cache.
      // buildHookRollup() will finish the compact-ledger rebuild explicitly;
      // an ordinary append must not unexpectedly traverse every pending file.
      return null;
    }
    return rebuildHookRollupCacheLocked(
      dataRoot,
      prepared.timeZone,
      prepared.now,
    );
  }
  if (entry.entry_type === 'gap') {
    applyHookRollupGap(prepared.payload, entry);
  } else {
    applyHookRollupRecord(prepared.payload, entry);
  }
  const source = captureHookRollupSource(dataRoot);
  prepared.payload.source = source.source;
  prepared.payload.issues.push(...source.issues);
  return saveHookRollupCache(dataRoot, prepared.payload);
}

function hookRollupScope(summary, identity, issues) {
  const value = summary ?? emptyHookRollupSummary();
  return {
    ...identity,
    cost_eur_nanos: value.cost_eur_nanos,
    usage: { ...value.usage },
    turns: value.turns,
    complete: issues.length === 0 && value.pending_turns === 0,
    pending_turns: value.pending_turns,
  };
}

function hookRollupPeriodIssues(payload, now, timeZone, period) {
  const nowParts = localDateParts(now, timeZone);
  const possibleUtcMonths = new Set(nearbyUtcMonthKeys(now));
  return payload.issues.filter((issue) => {
    if (issue.kind === 'global') {
      return true;
    }
    if (issue.kind === 'conflict') {
      const parts = localDateParts(issue.completed_at, timeZone);
      return period === 'day'
        ? parts.date === nowParts.date
        : parts.monthKey === nowParts.monthKey;
    }
    return possibleUtcMonths.has(issue.utc_month);
  });
}

function hookRollupSessionIssues(payload, rootThreadId) {
  const taskKey = safeHash(rootThreadId, 24);
  return payload.issues.filter(
    (issue) =>
      issue.kind === 'global' ||
      (issue.kind === 'month' && issue.task_key === null) ||
      issue.task_key === taskKey,
  );
}

function hookRollupIssueDiagnostics(issues) {
  return issues.flatMap((issue) => issue.diagnostics);
}

function hookRollupRelevantIssues(
  payload,
  now,
  timeZone,
  rootThreadId,
) {
  const issues = [
    ...hookRollupPeriodIssues(payload, now, timeZone, 'day'),
    ...hookRollupPeriodIssues(payload, now, timeZone, 'month'),
    ...hookRollupSessionIssues(payload, rootThreadId),
  ];
  return [
    ...new Map(
      issues.map((issue) => [stableStringify(issue), issue]),
    ).values(),
  ];
}

function buildHookRollup(dataRoot, options = {}) {
  const root = resolveDataRoot(dataRoot);
  const loadedSettings = resolveHookRollupSettings(root, options);
  const settings = loadedSettings.settings;
  const now = toTimestamp(options.now ?? options.nowMs ?? Date.now(), 'now');
  const rootThreadId = requireString(
    options.rootThreadId,
    'rootThreadId',
  );
  const nowParts = localDateParts(now, settings.timezone);
  let cacheDiagnostics = [];
  let cached = loadHookRollupCache(root);
  cacheDiagnostics.push(...cached.diagnostics);
  let source = captureHookRollupSource(root);
  let payload =
    cached.payload &&
    cached.payload.timezone === settings.timezone &&
    source.source.complete &&
    sameHookRollupSource(cached.payload.source, source.source) &&
    hookRollupRelevantIssues(
      cached.payload,
      now,
      settings.timezone,
      rootThreadId,
    ).length === 0
      ? cached.payload
      : null;

  if (!payload || payload.active_date !== nowParts.date) {
    const lock = acquireLedgerWriteLock(root);
    try {
      cached = loadHookRollupCache(root);
      cacheDiagnostics.push(...cached.diagnostics);
      source = captureHookRollupSource(root);
      payload =
        cached.payload &&
        cached.payload.timezone === settings.timezone &&
        source.source.complete &&
        sameHookRollupSource(cached.payload.source, source.source) &&
        hookRollupRelevantIssues(
          cached.payload,
          now,
          settings.timezone,
          rootThreadId,
        ).length === 0
          ? cached.payload
          : rebuildHookRollupCacheLocked(
              root,
              settings.timezone,
              now,
            );
      if (rollHookRollupClock(payload, now)) {
        payload = saveHookRollupCache(root, payload);
      }
    } finally {
      releaseTurnLock(lock);
    }
  }

  const sessionStorageKey = hookRollupSessionKey(rootThreadId);
  const todayIssues = hookRollupPeriodIssues(
    payload,
    now,
    settings.timezone,
    'day',
  );
  const monthIssues = hookRollupPeriodIssues(
    payload,
    now,
    settings.timezone,
    'month',
  );
  const sessionIssues = hookRollupSessionIssues(
    payload,
    rootThreadId,
  );
  const today = hookRollupScope(
    payload.days[nowParts.date],
    { date: nowParts.date },
    todayIssues,
  );
  const month = hookRollupScope(
    payload.months[nowParts.monthKey],
    { month: nowParts.monthKey },
    monthIssues,
  );
  const session = hookRollupScope(
    payload.sessions[sessionStorageKey],
    { key: safeTaskKey(rootThreadId) },
    sessionIssues,
  );
  const relevantGapKeys = Object.entries(payload.unresolved_gaps)
    .filter(
      ([, gap]) =>
        gap.month === nowParts.monthKey ||
        gap.session_key === sessionStorageKey,
    )
    .map(([key]) => key);
  const pendingTurns = new Set(relevantGapKeys).size;
  const complete = today.complete && month.complete && session.complete;
  const diagnostics = [
    ...(loadedSettings.diagnostics ?? []),
    ...cacheDiagnostics,
    ...hookRollupIssueDiagnostics([
      ...todayIssues,
      ...monthIssues,
      ...sessionIssues,
    ]),
    ...(pendingTurns === 0
      ? []
      : [
          `Accounting has ${pendingTurns} pending completed ${pendingTurns === 1 ? 'turn' : 'turns'} relevant to the current month or task; displayed totals are exact-known lower bounds.`,
        ]),
  ];
  return {
    schema: HOOK_ROLLUP_SCHEMA,
    generated_at: new Date(now).toISOString(),
    timezone: settings.timezone,
    complete,
    pending_turns: pendingTurns,
    today,
    month,
    session,
    diagnostics: [...new Set(diagnostics)],
  };
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function acquireLedgerLock(lockPath, timeoutMessage) {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
      return { descriptor, lockPath };
    } catch (error) {
      // Windows can briefly report EPERM instead of EEXIST while another
      // process is deleting a lock file. Treat both as bounded contention;
      // the stat below still surfaces unrelated filesystem errors.
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') {
        throw error;
      }
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 30_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') {
          throw statError;
        }
        continue;
      }
      sleep(10);
    }
  }
  throw new Error(timeoutMessage);
}

function ledgerLockDirectory(dataRoot) {
  const lockDirectory = path.join(
    resolveDataRoot(dataRoot),
    'usage',
    '.locks',
  );
  fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  return lockDirectory;
}

function acquireTurnLock(dataRoot, record) {
  const lockPath = path.join(
    ledgerLockDirectory(dataRoot),
    `${safeHash(`${record.root_thread_id}\u0000${record.turn_id}`, 32)}.lock`,
  );
  return acquireLedgerLock(
    lockPath,
    'Timed out waiting for the usage-ledger turn lock.',
  );
}

function acquireLedgerWriteLock(dataRoot) {
  return acquireLedgerLock(
    path.join(ledgerLockDirectory(dataRoot), '.ledger-write.lock'),
    'Timed out waiting for the usage-ledger write lock.',
  );
}

function releaseTurnLock(lock) {
  try {
    fs.closeSync(lock.descriptor);
  } finally {
    try {
      fs.unlinkSync(lock.lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function appendJsonlRecord(filePath, record) {
  const descriptor = fs.openSync(filePath, 'a+', 0o600);
  try {
    const stat = fs.fstatSync(descriptor);
    let separator = '';
    if (stat.size > 0) {
      const lastByte = Buffer.allocUnsafe(1);
      const bytesRead = fs.readSync(
        descriptor,
        lastByte,
        0,
        1,
        stat.size - 1,
      );
      if (bytesRead !== 1) {
        throw new Error('The existing ledger tail could not be verified.');
      }
      if (lastByte[0] !== 0x0a) {
        separator = '\n';
      }
    }
    fs.writeFileSync(
      descriptor,
      `${separator}${JSON.stringify(record)}\n`,
      'utf8',
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function appendLedgerRecord(dataRoot, input, options = {}) {
  const root = resolveDataRoot(dataRoot);
  const record = normalizeLedgerRecord(input, options);
  const ledgerPath = ledgerPathFor(root, record);
  const lock = acquireTurnLock(root, record);
  let writeLock;
  try {
    writeLock = acquireLedgerWriteLock(root);
    const existingLedger = readLedgerTaskFiles(root, record);
    if (!existingLedger.complete) {
      const detail = existingLedger.diagnostics[0];
      const error = new Error(
        `Usage ledger traversal is incomplete; no record was written.${detail ? ` ${detail}` : ''}`,
      );
      error.code = 'INCOMPLETE_LEDGER';
      error.diagnostics = existingLedger.diagnostics;
      throw error;
    }
    const sameTurn = existingLedger.records.find(
      (candidate) =>
        candidate.root_thread_id === record.root_thread_id &&
        candidate.turn_id === record.turn_id,
    );
    const existingConflict = existingLedger.conflicts.find(
      (candidate) =>
        candidate.root_thread_id === record.root_thread_id &&
        candidate.turn_id === record.turn_id,
    );
    const sameGap = existingLedger.gaps.find(
      (candidate) =>
        candidate.root_thread_id === record.root_thread_id &&
        candidate.turn_id === record.turn_id,
    );

    if (existingConflict || (sameTurn && !sameLogicalRecord(sameTurn, record))) {
      return {
        record,
        recorded: false,
        duplicate: false,
        conflict: true,
        resolvedGap: false,
        ledgerPath,
        diagnostics: [
          ...existingLedger.diagnostics,
          `Conflicting duplicate was not written for ${safeTaskLabel(record.root_thread_id)} ${safeTurnLabel(record.turn_id)}.`,
        ],
      };
    }
    if (sameTurn) {
      return {
        record: sameTurn,
        recorded: false,
        duplicate: true,
        conflict: false,
        resolvedGap: false,
        ledgerPath: ledgerPathFor(root, sameTurn),
        diagnostics: existingLedger.diagnostics,
      };
    }
    if (sameGap && knownGapExceedsRecord(sameGap, record)) {
      return {
        record,
        recorded: false,
        duplicate: false,
        conflict: true,
        resolvedGap: false,
        ledgerPath,
        diagnostics: [
          ...existingLedger.diagnostics,
          `Exact record is below its known gap lower bound for ${safeTaskLabel(record.root_thread_id)} ${safeTurnLabel(record.turn_id)}.`,
        ],
      };
    }

    const hookRollup = prepareHookRollupAppend(root, options);
    fs.mkdirSync(path.dirname(ledgerPath), {
      recursive: true,
      mode: 0o700,
    });
    bumpLedgerGeneration(path.dirname(ledgerPath));
    appendJsonlRecord(ledgerPath, record);
    bumpLedgerGeneration(path.dirname(ledgerPath));
    const diagnostics = [...existingLedger.diagnostics];
    try {
      refreshLedgerReadCacheAfterAppend(root, ledgerPath);
    } catch (error) {
      diagnostics.push(
        `Ledger read cache will be rebuilt: ${error.message}`,
      );
    }
    try {
      updateHookRollupAfterAppend(root, record, hookRollup);
    } catch (error) {
      diagnostics.push(
        `Hook rollup cache will be rebuilt: ${error.message}`,
      );
    }
    return {
      record,
      recorded: true,
      duplicate: false,
      conflict: false,
      resolvedGap: Boolean(sameGap),
      ledgerPath,
      diagnostics,
    };
  } finally {
    try {
      if (writeLock) {
        releaseTurnLock(writeLock);
      }
    } finally {
      releaseTurnLock(lock);
    }
  }
}

function appendLedgerGap(dataRoot, input, options = {}) {
  const root = resolveDataRoot(dataRoot);
  const gap = normalizeLedgerGap(input, options);
  const ledgerPath = ledgerPathFor(root, gap);
  const lock = acquireTurnLock(root, gap);
  let writeLock;
  try {
    writeLock = acquireLedgerWriteLock(root);
    const existingLedger = readLedgerTaskFiles(root, gap);
    if (!existingLedger.complete) {
      const detail = existingLedger.diagnostics[0];
      const error = new Error(
        `Usage ledger traversal is incomplete; no gap was written.${detail ? ` ${detail}` : ''}`,
      );
      error.code = 'INCOMPLETE_LEDGER';
      error.diagnostics = existingLedger.diagnostics;
      throw error;
    }

    const sameTurn = existingLedger.records.find(
      (candidate) =>
        candidate.root_thread_id === gap.root_thread_id &&
        candidate.turn_id === gap.turn_id,
    );
    if (sameTurn) {
      const matches = !knownGapExceedsRecord(gap, sameTurn);
      return {
        gap,
        recorded: false,
        duplicate: false,
        conflict: !matches,
        resolved: matches,
        ledgerPath: ledgerPathFor(root, sameTurn),
        diagnostics: matches
          ? existingLedger.diagnostics
          : [
              ...existingLedger.diagnostics,
              `Gap exceeded its exact record's known lower bound for ${safeTaskLabel(gap.root_thread_id)} ${safeTurnLabel(gap.turn_id)}.`,
            ],
      };
    }

    const sameGap = existingLedger.gaps.find(
      (candidate) =>
        candidate.root_thread_id === gap.root_thread_id &&
        candidate.turn_id === gap.turn_id,
    );
    if (sameGap && !sameLogicalRecord(sameGap, gap)) {
      return {
        gap,
        recorded: false,
        duplicate: false,
        conflict: true,
        resolved: false,
        ledgerPath,
        diagnostics: [
          ...existingLedger.diagnostics,
          `Conflicting gap was not written for ${safeTaskLabel(gap.root_thread_id)} ${safeTurnLabel(gap.turn_id)}.`,
        ],
      };
    }
    if (sameGap) {
      return {
        gap: sameGap,
        recorded: false,
        duplicate: true,
        conflict: false,
        resolved: false,
        ledgerPath: ledgerPathFor(root, sameGap),
        diagnostics: existingLedger.diagnostics,
      };
    }

    const hookRollup = prepareHookRollupAppend(root, options);
    fs.mkdirSync(path.dirname(ledgerPath), {
      recursive: true,
      mode: 0o700,
    });
    bumpLedgerGeneration(path.dirname(ledgerPath));
    appendJsonlRecord(ledgerPath, gap);
    bumpLedgerGeneration(path.dirname(ledgerPath));
    const diagnostics = [...existingLedger.diagnostics];
    try {
      refreshLedgerReadCacheAfterAppend(root, ledgerPath);
    } catch (error) {
      diagnostics.push(
        `Ledger read cache will be rebuilt: ${error.message}`,
      );
    }
    try {
      updateHookRollupAfterAppend(root, gap, hookRollup);
    } catch (error) {
      diagnostics.push(
        `Hook rollup cache will be rebuilt: ${error.message}`,
      );
    }
    return {
      gap,
      recorded: true,
      duplicate: false,
      conflict: false,
      resolved: false,
      ledgerPath,
      diagnostics,
    };
  } finally {
    try {
      if (writeLock) {
        releaseTurnLock(writeLock);
      }
    } finally {
      releaseTurnLock(lock);
    }
  }
}

function toTimestamp(value, field = 'timestamp') {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  } else {
    const timestamp = Date.parse(value ?? '');
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  throw new TypeError(`${field} must be a valid date, timestamp, or date string.`);
}

function localDateParts(value, timeZone) {
  const timestamp = toTimestamp(value);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    monthKey: `${parts.year}-${parts.month}`,
  };
}

function shiftDateKey(dateKey, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    throw new TypeError('dateKey must use YYYY-MM-DD.');
  }
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days,
    12,
  );
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nearbyUtcMonthKeys(value) {
  const timestamp = toTimestamp(value);
  const date = new Date(timestamp);
  return [0, -1, 1].map((offset) =>
    new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth() + offset,
        1,
      ),
    )
      .toISOString()
      .slice(0, 7),
  );
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function eurosToNanos(value) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER / EUR_NANOS
  ) {
    throw new TypeError('EUR value must be a non-negative finite amount.');
  }
  return Math.round(value * EUR_NANOS);
}

function nanosToEuros(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return value / EUR_NANOS;
}

function roundRatioHalfUp(numerator, denominator) {
  const top = BigInt(numerator);
  const bottom = BigInt(denominator);
  if (top < 0n || bottom <= 0n) {
    throw new RangeError('Round-half-up inputs must be non-negative.');
  }
  const rounded = (2n * top + bottom) / (2n * bottom);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Rounded result exceeds the safe integer range.');
  }
  return Number(rounded);
}

function projectMonthEndNanos(monthCostEurNanos, now, timeZone) {
  const cost = requireNanos(
    monthCostEurNanos,
    'monthCostEurNanos',
  );
  const parts = localDateParts(now, timeZone);
  return roundRatioHalfUp(
    BigInt(cost) * BigInt(daysInMonth(parts.year, parts.month)),
    BigInt(parts.day),
  );
}

function budgetState(limitEur, spentEurNanos) {
  const spent = requireNanos(spentEurNanos, 'spentEurNanos');
  if (limitEur === null || limitEur === undefined) {
    return {
      limit_eur_nanos: null,
      spent_eur_nanos: spent,
      percentage: null,
      remaining_eur_nanos: null,
      over_eur_nanos: null,
    };
  }
  const limit = eurosToNanos(limitEur);
  if (limit < 1) {
    throw new RangeError('Budget limit must be at least one EUR nano.');
  }
  return {
    limit_eur_nanos: limit,
    spent_eur_nanos: spent,
    percentage: (spent / limit) * 100,
    remaining_eur_nanos: Math.max(0, limit - spent),
    over_eur_nanos: Math.max(0, spent - limit),
  };
}

function crossedThresholds(previousPercentage, currentPercentage, thresholds) {
  if (
    typeof currentPercentage !== 'number' ||
    !Number.isFinite(currentPercentage)
  ) {
    return [];
  }
  const previous =
    typeof previousPercentage === 'number' && Number.isFinite(previousPercentage)
      ? previousPercentage
      : 0;
  return [...new Set(thresholds ?? [])]
    .filter(
      (threshold) =>
        typeof threshold === 'number' &&
        threshold >= 1 &&
        threshold <= 100 &&
        previous < threshold &&
        currentPercentage >= threshold,
    )
    .sort((left, right) => left - right);
}

function crossedBudgetThresholds(previousBudget, currentBudget, thresholds) {
  const limit = currentBudget?.limit_eur_nanos;
  const currentSpent = currentBudget?.spent_eur_nanos;
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(currentSpent) ||
    currentSpent < 0
  ) {
    return [];
  }
  const previousSpent =
    Number.isSafeInteger(previousBudget?.spent_eur_nanos) &&
    previousBudget.spent_eur_nanos >= 0
      ? previousBudget.spent_eur_nanos
      : 0;
  const limitBigInt = BigInt(limit);
  const previousScaled = BigInt(previousSpent) * 100n;
  const currentScaled = BigInt(currentSpent) * 100n;

  return [...new Set(thresholds ?? [])]
    .filter(
      (threshold) =>
        Number.isInteger(threshold) &&
        threshold >= 1 &&
        threshold <= 100 &&
        previousScaled < limitBigInt * BigInt(threshold) &&
        currentScaled >= limitBigInt * BigInt(threshold),
    )
    .sort((left, right) => left - right);
}

function summarizeRecords(records) {
  return records.reduce(
    (summary, record) => ({
      cost_eur_nanos: summary.cost_eur_nanos + record.cost_eur_nanos,
      usage: addUsage(summary.usage, record.usage),
      turns: summary.turns + 1,
    }),
    {
      cost_eur_nanos: 0,
      usage: zeroUsage(),
      turns: 0,
    },
  );
}

function reconciledModelParts(record) {
  const aggregate = record.model_breakdown.reduce(
    (summary, part) => ({
      cost_eur_nanos: summary.cost_eur_nanos + part.cost_eur_nanos,
      usage: addUsage(summary.usage, part.usage),
    }),
    { cost_eur_nanos: 0, usage: zeroUsage() },
  );
  if (
    aggregate.cost_eur_nanos > record.cost_eur_nanos ||
    usageExceeds(aggregate.usage, record.usage)
  ) {
    return [
      {
        model: 'unknown',
        cost_eur_nanos: record.cost_eur_nanos,
        usage: record.usage,
      },
    ];
  }
  const residualCost = record.cost_eur_nanos - aggregate.cost_eur_nanos;
  const residualUsage = subtractUsage(record.usage, aggregate.usage);
  if (residualCost === 0 && !hasUsage(residualUsage)) {
    return record.model_breakdown;
  }
  return [
    ...record.model_breakdown,
    {
      model: 'unknown',
      cost_eur_nanos: residualCost,
      cost_usd_nanos: 0,
      usage: residualUsage,
    },
  ];
}

function reconciledAgentParts(record) {
  const root = record.agent_breakdown.root;
  const subagents = record.agent_breakdown.subagents;
  const aggregateCost = root.cost_eur_nanos + subagents.cost_eur_nanos;
  const aggregateUsage = addUsage(root.usage, subagents.usage);
  if (
    aggregateCost > record.cost_eur_nanos ||
    usageExceeds(aggregateUsage, record.usage)
  ) {
    return {
      root: {
        usage: record.usage,
        cost_eur_nanos: record.cost_eur_nanos,
        cost_usd_nanos: record.cost_usd_nanos,
      },
      subagent: {
        usage: zeroUsage(),
        cost_eur_nanos: 0,
        cost_usd_nanos: 0,
        thread_count: subagents.thread_count,
      },
    };
  }
  return {
    root: {
      ...root,
      usage: addUsage(root.usage, subtractUsage(record.usage, aggregateUsage)),
      cost_eur_nanos:
        root.cost_eur_nanos + record.cost_eur_nanos - aggregateCost,
    },
    subagent: {
      ...subagents,
    },
  };
}

function groupByModel(records) {
  const groups = new Map();
  for (const record of records) {
    const modelsSeen = new Set();
    for (const part of reconciledModelParts(record)) {
      const group = groups.get(part.model) ?? {
        model: part.model,
        cost_eur_nanos: 0,
        usage: zeroUsage(),
        turns: 0,
      };
      group.cost_eur_nanos += part.cost_eur_nanos;
      group.usage = addUsage(group.usage, part.usage);
      if (!modelsSeen.has(part.model)) {
        group.turns += 1;
        modelsSeen.add(part.model);
      }
      groups.set(part.model, group);
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.cost_eur_nanos - left.cost_eur_nanos ||
      left.model.localeCompare(right.model),
  );
}

function groupBySession(records) {
  const groups = new Map();
  for (const record of records) {
    // A fork can retain the source session id, but it is a distinct accounting
    // task and must not be merged back into its source.
    const groupingId = record.root_thread_id;
    const key = safeTaskKey(groupingId);
    const group = groups.get(key) ?? {
      key,
      label: safeTaskLabel(groupingId),
      cost_eur_nanos: 0,
      usage: zeroUsage(),
      turns: 0,
    };
    group.cost_eur_nanos += record.cost_eur_nanos;
    group.usage = addUsage(group.usage, record.usage);
    group.turns += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.cost_eur_nanos - left.cost_eur_nanos ||
      left.label.localeCompare(right.label),
  );
}

function groupByAgent(records) {
  const result = {
    root: {
      cost_eur_nanos: 0,
      usage: zeroUsage(),
      turns: 0,
      thread_count: records.length > 0 ? 1 : 0,
    },
    subagent: {
      cost_eur_nanos: 0,
      usage: zeroUsage(),
      turns: 0,
      thread_count: 0,
    },
  };
  for (const record of records) {
    const parts = reconciledAgentParts(record);
    result.root.cost_eur_nanos += parts.root.cost_eur_nanos;
    result.root.usage = addUsage(result.root.usage, parts.root.usage);
    if (parts.root.cost_eur_nanos > 0 || hasUsage(parts.root.usage)) {
      result.root.turns += 1;
    }
    result.subagent.cost_eur_nanos += parts.subagent.cost_eur_nanos;
    result.subagent.usage = addUsage(
      result.subagent.usage,
      parts.subagent.usage,
    );
    if (
      parts.subagent.cost_eur_nanos > 0 ||
      hasUsage(parts.subagent.usage)
    ) {
      result.subagent.turns += 1;
    }
    result.subagent.thread_count += parts.subagent.thread_count ?? 0;
  }
  return result;
}

function cacheSummary(records) {
  const usage = records.reduce(
    (total, record) => addUsage(total, record.usage),
    zeroUsage(),
  );
  const input = usage.input_tokens;
  return {
    input_tokens: input,
    cached_input_tokens: usage.cached_input_tokens,
    cache_write_input_tokens: usage.cache_write_input_tokens,
    uncached_input_tokens: Math.max(
      0,
      input - usage.cached_input_tokens - usage.cache_write_input_tokens,
    ),
    hit_rate_percent:
      input > 0 ? (usage.cached_input_tokens / input) * 100 : null,
  };
}

function recentTurn(record) {
  const modelNames = [
    ...new Set(record.model_breakdown.map((part) => part.model)),
  ];
  return {
    completed_at: record.completed_at,
    task_label: safeTaskLabel(record.root_thread_id),
    turn_label: safeTurnLabel(record.turn_id),
    model:
      modelNames.length === 1
        ? modelNames[0]
        : modelNames.length > 1
          ? `${modelNames.length} models`
          : 'unknown',
    cost_eur_nanos: record.cost_eur_nanos,
    usage: record.usage,
    agent_threads: record.agent_breakdown.subagents.thread_count,
  };
}

function buildSnapshot(dataRoot, options = {}) {
  const root = resolveDataRoot(dataRoot);
  const loadedSettings = options.settings
    ? normalizeSettings(
        options.settings.settings ?? options.settings,
        { diagnoseMissing: false },
      )
    : loadSettings(root);
  const settings = loadedSettings.settings;
  const nowMs = toTimestamp(options.now ?? options.nowMs ?? Date.now(), 'now');
  const nowParts = localDateParts(nowMs, settings.timezone);
  const firstSevenDay = shiftDateKey(nowParts.date, -6);
  const dates = Array.from({ length: 7 }, (_, index) =>
    shiftDateKey(firstSevenDay, index),
  );
  const dateSet = new Set(dates);
  const ledger = readLedger(
    root,
    options.fullHistory === true
      ? {}
      : {
          months: nearbyUtcMonthKeys(nowMs),
          maxFiles:
            options.maxLedgerFiles ??
            options.maxLedgerFilesPerMonth ??
            DEFAULT_HOOK_LEDGER_FILES_PER_MONTH,
          deadlineMs: options.ledgerDeadlineMs,
        },
  );
  const completedRecords = ledger.records
    .filter((record) => Date.parse(record.completed_at) <= nowMs)
    .sort(
      (left, right) =>
        Date.parse(left.completed_at) - Date.parse(right.completed_at),
    );
  const recordsWithLocalDate = completedRecords.map((record) => {
    const parts = localDateParts(record.completed_at, settings.timezone);
    return { record, localDate: parts.date, localMonth: parts.monthKey };
  });
  const relevantGaps = ledger.gaps.filter((gap) => {
    if (Date.parse(gap.completed_at) > nowMs) {
      return false;
    }
    const parts = localDateParts(gap.completed_at, settings.timezone);
    return (
      parts.monthKey === nowParts.monthKey ||
      dateSet.has(parts.date)
    );
  });
  const todayRecords = recordsWithLocalDate
    .filter((item) => item.localDate === nowParts.date)
    .map((item) => item.record);
  const monthRecords = recordsWithLocalDate
    .filter((item) => item.localMonth === nowParts.monthKey)
    .map((item) => item.record);
  const sevenDays = dates.map((date) => ({
    date,
    ...summarizeRecords(
      recordsWithLocalDate
        .filter((item) => item.localDate === date)
        .map((item) => item.record),
    ),
  }));
  const today = {
    date: nowParts.date,
    ...summarizeRecords(todayRecords),
  };
  const month = {
    month: nowParts.monthKey,
    ...summarizeRecords(monthRecords),
  };
  const dailyBudget = budgetState(
    settings.budgets.daily_eur,
    today.cost_eur_nanos,
  );
  const monthlyBudget = budgetState(
    settings.budgets.monthly_eur,
    month.cost_eur_nanos,
  );
  const forecastEurNanos = projectMonthEndNanos(
    month.cost_eur_nanos,
    nowMs,
    settings.timezone,
  );
  const monthlyLimit = monthlyBudget.limit_eur_nanos;
  const recentLimit = Math.max(
    0,
    Math.min(
      100,
      Number.isInteger(options.recentLimit) ? options.recentLimit : 20,
    ),
  );

  return {
    schema: 1,
    generated_at: new Date(nowMs).toISOString(),
    timezone: settings.timezone,
    complete: ledger.complete && relevantGaps.length === 0,
    today,
    month,
    seven_days: sevenDays,
    budgets: {
      daily: dailyBudget,
      monthly: monthlyBudget,
      warning_thresholds_percent:
        settings.budgets.warning_thresholds_percent,
      forecast_eur_nanos: forecastEurNanos,
      forecast_percentage:
        monthlyLimit === null
          ? null
          : (forecastEurNanos / monthlyLimit) * 100,
    },
    by_model: groupByModel(monthRecords),
    by_session: groupBySession(monthRecords),
    by_agent: groupByAgent(monthRecords),
    cache: cacheSummary(monthRecords),
    recent_turns: completedRecords
      .slice()
      .sort(
        (left, right) =>
          Date.parse(right.completed_at) - Date.parse(left.completed_at),
      )
      .slice(0, recentLimit)
      .map(recentTurn),
    records_count: completedRecords.length,
    conflicts: ledger.conflicts.map((conflict) => ({
      task_label: safeTaskLabel(conflict.root_thread_id),
      turn_label: safeTurnLabel(conflict.turn_id),
    })),
    diagnostics: [
      ...(loadedSettings.diagnostics ?? []),
      ...ledger.diagnostics,
      ...(relevantGaps.length === 0
        ? []
        : [
            `Accounting is incomplete for ${relevantGaps.length} completed ${relevantGaps.length === 1 ? 'turn' : 'turns'} in the displayed current-month or seven-day period.`,
          ]),
    ],
  };
}

function formatTokens(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(value ?? 0));
}

function formatCompactTokens(value) {
  const rounded = Math.round(value ?? 0);
  if (rounded < 1_000_000) {
    return formatTokens(rounded);
  }
  const divisor = rounded >= 1_000_000_000 ? 1_000_000_000 : 1_000_000;
  const suffix = divisor === 1_000_000_000 ? 'B' : 'M';
  return `${(rounded / divisor)
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1')}${suffix}`;
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

function formatEuroNanos(value) {
  return formatEuroCost(nanosToEuros(value));
}

module.exports = {
  DEFAULT_SETTINGS: Object.freeze(defaultSettings()),
  DEFAULT_TIME_ZONE,
  EUR_NANOS,
  HOOK_ROLLUP_SCHEMA,
  LEDGER_GAP_REASONS,
  LEDGER_SCHEMA,
  SETTINGS_SCHEMA,
  USAGE_KEYS,
  addUsage,
  appendLedgerGap,
  appendLedgerRecord,
  budgetState,
  buildHookRollup,
  buildSnapshot,
  crossedBudgetThresholds,
  crossedThresholds,
  defaultSettings,
  eurosToNanos,
  formatCompactTokens,
  formatEuroCost,
  formatEuroNanos,
  formatTokens,
  hasUsage,
  hookRollupCachePath,
  ledgerPathFor,
  loadSettings,
  localDateParts,
  nanosToEuros,
  normalizeLedgerGap,
  normalizeLedgerRecord,
  normalizeSettings,
  normalizeUsage,
  projectMonthEndNanos,
  readLedger,
  resolveDataRoot,
  safeTaskKey,
  safeTaskLabel,
  safeTurnLabel,
  saveSettings,
  shiftDateKey,
  zeroUsage,
};
