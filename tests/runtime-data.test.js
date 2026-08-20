'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const runtime = require('../plugins/codex-cost-meter/lib/runtime-data');

function temporaryData(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-cost-runtime-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function usage(
  input,
  cached = 0,
  cacheWrite = 0,
  output = 0,
  reasoning = 0,
) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function addUsage(left, right) {
  return runtime.addUsage(left, right);
}

function ledgerRecord(overrides = {}) {
  const baseUsage = usage(100, 40, 10, 20, 5);
  return {
    schema: 2,
    root_thread_id: 'root-thread',
    session_id: 'session-id',
    turn_id: 'turn-id',
    completed_at: '2026-08-20T12:00:00.000Z',
    written_at: '2026-08-20T12:00:01.000Z',
    pricing_as_of: '2026-08-20',
    eur_per_usd: 0.9,
    usage: baseUsage,
    cost_usd_nanos: 1_000_000_000,
    cost_eur_nanos: 900_000_000,
    model_breakdown: [
      {
        model: 'gpt-test',
        usage: baseUsage,
        cost_usd_nanos: 1_000_000_000,
        cost_eur_nanos: 900_000_000,
      },
    ],
    agent_breakdown: {
      root: {
        usage: baseUsage,
        cost_usd_nanos: 1_000_000_000,
        cost_eur_nanos: 900_000_000,
      },
      subagents: {
        usage: usage(0),
        cost_usd_nanos: 0,
        cost_eur_nanos: 0,
        thread_count: 0,
      },
    },
    ...overrides,
  };
}

function ledgerGap(overrides = {}) {
  return {
    schema: 2,
    entry_type: 'gap',
    root_thread_id: 'root-thread',
    turn_id: 'gap-turn',
    completed_at: '2026-08-20T12:00:00.000Z',
    written_at: '2026-08-20T12:00:01.000Z',
    reason: 'pricing_unavailable',
    ...overrides,
  };
}

function trackLedgerReads(run) {
  const opened = [];
  const positions = [];
  const ledgerDescriptors = new Set();
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;

  fs.openSync = function trackedOpenSync(filePath, flags, ...rest) {
    const descriptor = originalOpenSync.call(fs, filePath, flags, ...rest);
    if (
      flags === 'r' &&
      typeof filePath === 'string' &&
      filePath.endsWith('.jsonl')
    ) {
      opened.push(filePath);
      ledgerDescriptors.add(descriptor);
    }
    return descriptor;
  };
  fs.readSync = function trackedReadSync(
    descriptor,
    buffer,
    offset,
    length,
    position,
  ) {
    if (ledgerDescriptors.has(descriptor)) {
      positions.push(position);
    }
    return originalReadSync.call(
      fs,
      descriptor,
      buffer,
      offset,
      length,
      position,
    );
  };
  fs.closeSync = function trackedCloseSync(descriptor) {
    ledgerDescriptors.delete(descriptor);
    return originalCloseSync.call(fs, descriptor);
  };

  try {
    return {
      value: run(),
      opened,
      positions,
    };
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.closeSync = originalCloseSync;
  }
}

function markLedgerChanged(ledgerPath) {
  fs.appendFileSync(
    path.join(path.dirname(ledgerPath), '.generation'),
    `test-${Date.now()}-${Math.random()}\n`,
    'utf8',
  );
}

function waitMilliseconds(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

test('loads unrestricted defaults and resolves an explicit plugin-data root', () => {
  const dataRoot = path.join(os.tmpdir(), 'runtime-data-explicit-root');
  assert.equal(
    runtime.resolveDataRoot({
      env: { PLUGIN_DATA: dataRoot, CODEX_HOME: '/ignored' },
    }),
    path.resolve(dataRoot),
  );
  assert.equal(
    runtime.resolveDataRoot({
      env: { CODEX_HOME: '/codex-home' },
    }),
    path.resolve(
      '/codex-home',
      'plugins',
      'data',
      'codex-cost-meter-cost-meter',
    ),
  );
  assert.equal(
    runtime.resolveDataRoot({
      codexHome: '/discovered-codex-home',
      env: {},
    }),
    path.resolve(
      '/discovered-codex-home',
      'plugins',
      'data',
      'codex-cost-meter-cost-meter',
    ),
  );

  const loaded = runtime.loadSettings(dataRoot);
  assert.deepEqual(loaded.settings, {
    schema: 1,
    timezone: 'Europe/Berlin',
    budgets: {
      daily_eur: null,
      monthly_eur: null,
      warning_thresholds_percent: [50, 80, 100],
    },
    notifications: { windows: false },
    hook: { message_format: 'compact' },
  });
  assert.equal(loaded.exists, false);
  assert.equal(loaded.supported, true);
  assert.deepEqual(loaded.diagnostics, []);

  const disabled = runtime.budgetState(null, 123);
  assert.deepEqual(disabled, {
    limit_eur_nanos: null,
    spent_eur_nanos: 123,
    percentage: null,
    remaining_eur_nanos: null,
    over_eur_nanos: null,
  });
});

test('saves normalized custom settings atomically and reloads them', (t) => {
  const dataRoot = temporaryData(t);
  const saved = runtime.saveSettings(dataRoot, {
    schema: 1,
    timezone: 'America/New_York',
    budgets: {
      daily_eur: 1.5,
      monthly_eur: 25,
      warning_thresholds_percent: [100, 50, 80, 50],
    },
    notifications: { windows: true },
    hook: { message_format: 'detailed' },
  });

  assert.equal(saved.saved, true);
  assert.deepEqual(saved.diagnostics, []);
  assert.deepEqual(saved.settings.budgets.warning_thresholds_percent, [
    50, 80, 100,
  ]);
  assert.deepEqual(runtime.loadSettings(dataRoot).settings, saved.settings);
  assert.deepEqual(fs.readdirSync(dataRoot), ['settings.json']);
  assert.equal(
    fs.readFileSync(path.join(dataRoot, 'settings.json'), 'utf8').endsWith(
      '\n',
    ),
    true,
  );
});

test('uses safe defaults with diagnostics for malformed and invalid settings', (t) => {
  const dataRoot = temporaryData(t);
  const filePath = path.join(dataRoot, 'settings.json');
  fs.writeFileSync(filePath, '{bad json', 'utf8');

  const malformed = runtime.loadSettings(dataRoot);
  assert.deepEqual(malformed.settings, runtime.defaultSettings());
  assert.match(malformed.diagnostics.join('\n'), /malformed/i);

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      schema: 1,
      timezone: 'Mars/Olympus',
      budgets: {
        daily_eur: 1e-12,
        monthly_eur: -10,
        warning_thresholds_percent: [0, 50.5, 80, 101, '50'],
      },
      notifications: { windows: 'yes' },
      hook: { message_format: 'verbose' },
    }),
    'utf8',
  );
  const invalid = runtime.loadSettings(dataRoot);
  assert.equal(invalid.settings.timezone, 'Europe/Berlin');
  assert.equal(invalid.settings.budgets.daily_eur, null);
  assert.equal(invalid.settings.budgets.monthly_eur, null);
  assert.deepEqual(invalid.settings.budgets.warning_thresholds_percent, [80]);
  assert.equal(invalid.settings.notifications.windows, false);
  assert.equal(invalid.settings.hook.message_format, 'compact');
  assert.ok(invalid.diagnostics.length >= 5);
  assert.throws(
    () => runtime.budgetState(1e-12, 0),
    /at least one EUR nano/i,
  );
});

test('never overwrites a settings file with a newer schema', (t) => {
  const dataRoot = temporaryData(t);
  const filePath = path.join(dataRoot, 'settings.json');
  const original = '{"schema":99,"future":true}\n';
  fs.writeFileSync(filePath, original, 'utf8');

  const loaded = runtime.loadSettings(dataRoot);
  assert.equal(loaded.supported, false);
  assert.equal(loaded.unsupportedSchema, 99);

  const result = runtime.saveSettings(dataRoot, runtime.defaultSettings());
  assert.equal(result.saved, false);
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'unsupported-schema');
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
});

test('writes schema-2 records by UTC completion month and is idempotent', (t) => {
  const dataRoot = temporaryData(t);
  const record = ledgerRecord({
    root_thread_id: '../../private/root',
    turn_id: 'same-turn',
    completed_at: '2026-08-31T22:30:00.000Z',
  });

  const first = runtime.appendLedgerRecord(dataRoot, record);
  assert.equal(first.recorded, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.conflict, false);
  assert.match(first.ledgerPath, /usage[\\/]2026-08[\\/]task-[a-f0-9]+\.jsonl$/);
  assert.doesNotMatch(first.ledgerPath, /private/);

  const duplicate = runtime.appendLedgerRecord(dataRoot, {
    ...record,
    written_at: '2026-09-01T01:00:00.000Z',
  });
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.conflict, false);

  const conflict = runtime.appendLedgerRecord(dataRoot, {
    ...record,
    written_at: '2026-09-01T02:00:00.000Z',
    cost_eur_nanos: record.cost_eur_nanos + 1,
  });
  assert.equal(conflict.recorded, false);
  assert.equal(conflict.duplicate, false);
  assert.equal(conflict.conflict, true);
  assert.equal(
    fs
      .readFileSync(first.ledgerPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean).length,
    1,
  );
  assert.throws(
    () =>
      runtime.appendLedgerRecord(dataRoot, {
        ...record,
        completed_at: 'not-a-date',
      }),
    /completed_at/,
  );
});

test('writes metadata-only schema-2 gaps idempotently', (t) => {
  const dataRoot = temporaryData(t);
  const gap = ledgerGap({
    root_thread_id: '../../private/root',
    turn_id: 'same-gap',
    completed_at: '2026-08-31T22:30:00.000Z',
  });

  const first = runtime.appendLedgerGap(dataRoot, gap);
  assert.equal(first.recorded, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.conflict, false);
  assert.equal(first.resolved, false);
  assert.match(first.ledgerPath, /usage[\\/]2026-08[\\/]task-[a-f0-9]+\.jsonl$/);
  assert.doesNotMatch(first.ledgerPath, /private/);

  const duplicate = runtime.appendLedgerGap(dataRoot, {
    ...gap,
    written_at: '2026-09-01T01:00:00.000Z',
  });
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.conflict, false);

  const conflict = runtime.appendLedgerGap(dataRoot, {
    ...gap,
    reason: 'history_incomplete',
  });
  assert.equal(conflict.recorded, false);
  assert.equal(conflict.duplicate, false);
  assert.equal(conflict.conflict, true);

  const lines = fs
    .readFileSync(first.ledgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(lines.length, 1);
  const stored = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(stored).sort(), [
    'completed_at',
    'entry_type',
    'reason',
    'root_thread_id',
    'schema',
    'turn_id',
    'written_at',
  ]);
  assert.equal(stored.reason, 'pricing_unavailable');
  assert.doesNotMatch(
    JSON.stringify(stored),
    /session|model|usage|cost|prompt|response|tool/i,
  );

  const ledger = runtime.readLedger(dataRoot);
  assert.equal(ledger.complete, true);
  assert.equal(ledger.records.length, 0);
  assert.deepEqual(ledger.gaps, [first.gap]);
  assert.throws(
    () =>
      runtime.appendLedgerGap(dataRoot, {
        ...gap,
        turn_id: 'unsafe-reason',
        reason: 'arbitrary user text',
      }),
    /reason must be one of/i,
  );
});

test('a later exact record resolves a gap without rewriting history', (t) => {
  const dataRoot = temporaryData(t);
  const gap = ledgerGap({
    root_thread_id: 'retry-root',
    turn_id: 'retry-turn',
  });
  const first = runtime.appendLedgerGap(dataRoot, gap);

  const before = runtime.buildSnapshot(dataRoot, {
    now: '2026-08-20T13:00:00.000Z',
  });
  assert.equal(before.complete, false);
  assert.match(before.diagnostics.join('\n'), /1 completed turn/i);
  assert.doesNotMatch(
    before.diagnostics.join('\n'),
    /retry-root|retry-turn/,
  );

  const retry = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: gap.root_thread_id,
      turn_id: gap.turn_id,
      completed_at: gap.completed_at,
    }),
  );
  assert.equal(retry.recorded, true);
  assert.equal(retry.conflict, false);
  assert.equal(retry.resolvedGap, true);

  const ledger = runtime.readLedger(dataRoot);
  assert.equal(ledger.complete, true);
  assert.equal(ledger.records.length, 1);
  assert.deepEqual(ledger.gaps, []);
  assert.equal(
    fs
      .readFileSync(first.ledgerPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean).length,
    2,
  );
  assert.equal(
    runtime.buildSnapshot(dataRoot, {
      now: '2026-08-20T13:00:00.000Z',
    }).complete,
    true,
  );

  const redundant = runtime.appendLedgerGap(dataRoot, gap);
  assert.equal(redundant.recorded, false);
  assert.equal(redundant.resolved, true);
  assert.equal(redundant.conflict, false);
});

test('requires an exact completion timestamp when resolving a gap', (t) => {
  const dataRoot = temporaryData(t);
  const gap = ledgerGap({
    root_thread_id: 'strict-retry-root',
    turn_id: 'strict-retry-turn',
  });
  const first = runtime.appendLedgerGap(dataRoot, gap);
  const retry = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: gap.root_thread_id,
      turn_id: gap.turn_id,
      completed_at: '2026-08-20T12:00:00.001Z',
    }),
  );

  assert.equal(retry.recorded, false);
  assert.equal(retry.conflict, true);
  assert.equal(retry.resolvedGap, false);
  assert.equal(
    fs
      .readFileSync(first.ledgerPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean).length,
    1,
  );
  assert.equal(runtime.readLedger(dataRoot).gaps.length, 1);
});

test('rebuckets gap relevance by configured timezone and seven-day window', (t) => {
  const dataRoot = temporaryData(t);
  runtime.appendLedgerGap(
    dataRoot,
    ledgerGap({
      completed_at: '2026-08-31T22:30:00.000Z',
    }),
  );
  const settings = runtime.defaultSettings();

  const berlin = runtime.buildSnapshot(dataRoot, {
    now: '2026-09-30T12:00:00.000Z',
    settings: {
      ...settings,
      timezone: 'Europe/Berlin',
    },
  });
  assert.equal(berlin.complete, false);

  const utc = runtime.buildSnapshot(dataRoot, {
    now: '2026-09-30T12:00:00.000Z',
    settings: {
      ...settings,
      timezone: 'UTC',
    },
  });
  assert.equal(utc.complete, true);

  const sevenDay = runtime.buildSnapshot(dataRoot, {
    now: '2026-09-03T12:00:00.000Z',
    settings: {
      ...settings,
      timezone: 'UTC',
    },
  });
  assert.equal(sevenDay.complete, false);
});

test('keeps old unresolved gaps visible without blocking current totals', (t) => {
  const dataRoot = temporaryData(t);
  runtime.appendLedgerGap(
    dataRoot,
    ledgerGap({
      completed_at: '2026-07-01T10:00:00.000Z',
    }),
  );

  const ledger = runtime.readLedger(dataRoot);
  assert.equal(ledger.complete, true);
  assert.equal(ledger.gaps.length, 1);

  const snapshot = runtime.buildSnapshot(dataRoot, {
    now: '2026-08-20T12:00:00.000Z',
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.diagnostics, []);
});

test('scopes hook snapshots to nearby UTC months while full-history dashboards scan all months', (t) => {
  const dataRoot = temporaryData(t);
  const oldRecord = runtime.normalizeLedgerRecord(
    ledgerRecord({
      root_thread_id: 'old-root',
      turn_id: 'old-turn',
      completed_at: '2025-01-15T12:00:00.000Z',
    }),
  );
  const currentRecord = runtime.normalizeLedgerRecord(
    ledgerRecord({
      root_thread_id: 'current-root',
      turn_id: 'current-turn',
      completed_at: '2026-08-20T12:00:00.000Z',
    }),
  );
  const oldPath = runtime.ledgerPathFor(dataRoot, oldRecord);
  const currentPath = runtime.ledgerPathFor(dataRoot, currentRecord);
  for (const [filePath, record] of [
    [oldPath, oldRecord],
    [currentPath, currentRecord],
  ]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(record)}\n`,
      'utf8',
    );
  }

  const scoped = trackLedgerReads(() =>
    runtime.buildSnapshot(dataRoot, {
      now: '2026-08-20T13:00:00.000Z',
    }),
  );
  assert.equal(scoped.value.records_count, 1);
  assert.deepEqual(scoped.opened, [currentPath]);

  const full = trackLedgerReads(() =>
    runtime.buildSnapshot(dataRoot, {
      now: '2026-08-20T13:00:00.000Z',
      fullHistory: true,
    }),
  );
  assert.equal(full.value.records_count, 2);
  assert.deepEqual(full.opened, [oldPath]);
});

test('persists bounded month warming across snapshots while exact turns remain appendable', (t) => {
  const dataRoot = temporaryData(t);
  for (let index = 0; index < 3; index += 1) {
    const record = runtime.normalizeLedgerRecord(
      ledgerRecord({
        root_thread_id: `warming-root-${index}`,
        turn_id: `warming-turn-${index}`,
      }),
    );
    const filePath = runtime.ledgerPathFor(dataRoot, record);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(record)}\n`,
      'utf8',
    );
  }

  const snapshotOptions = {
    now: '2026-08-20T13:00:00.000Z',
    maxLedgerFilesPerMonth: 1,
  };
  const first = runtime.buildSnapshot(dataRoot, snapshotOptions);
  assert.equal(first.complete, false);
  assert.match(first.diagnostics.join('\n'), /cache is warming/i);

  const cachePath = path.join(
    dataRoot,
    'cache',
    'ledger-read-v3.json.gz',
  );
  const readPendingCount = () => {
    const cache = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(cachePath)),
    );
    return cache.directories.find(
      (directory) => directory.month === '2026-08',
    ).pending_files.length;
  };
  assert.equal(readPendingCount(), 2);

  let snapshot = first;
  for (let pass = 0; pass < 2; pass += 1) {
    const runtimeModulePath = require.resolve(
      '../plugins/codex-cost-meter/lib/runtime-data',
    );
    delete require.cache[runtimeModulePath];
    const freshRuntime = require(runtimeModulePath);
    const appended = freshRuntime.appendLedgerRecord(
      dataRoot,
      ledgerRecord({
        root_thread_id: `warming-new-root-${pass}`,
        turn_id: `warming-new-turn-${pass}`,
      }),
    );
    assert.equal(appended.recorded, true);
    assert.equal(readPendingCount(), 2 - pass);
    snapshot = freshRuntime.buildSnapshot(dataRoot, snapshotOptions);
    assert.equal(readPendingCount(), 1 - pass);
  }

  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.records_count, 5);
  assert.equal(readPendingCount(), 0);
});

test('buckets records across Berlin day, month, and DST boundaries', (t) => {
  const dataRoot = temporaryData(t);
  const records = [
    ledgerRecord({
      turn_id: 'before-dst-day',
      completed_at: '2026-03-28T22:30:00.000Z',
      cost_eur_nanos: 1,
    }),
    ledgerRecord({
      turn_id: 'dst-day',
      completed_at: '2026-03-28T23:30:00.000Z',
      cost_eur_nanos: 2,
    }),
    ledgerRecord({
      turn_id: 'after-dst-day',
      completed_at: '2026-03-29T22:30:00.000Z',
      cost_eur_nanos: 3,
    }),
  ];
  for (const record of records) {
    runtime.appendLedgerRecord(dataRoot, record);
  }

  const snapshot = runtime.buildSnapshot(dataRoot, {
    now: '2026-03-30T10:00:00.000Z',
  });
  assert.equal(snapshot.timezone, 'Europe/Berlin');
  assert.equal(snapshot.today.date, '2026-03-30');
  assert.equal(snapshot.today.cost_eur_nanos, 3);
  assert.equal(snapshot.month.cost_eur_nanos, 6);
  assert.deepEqual(
    snapshot.seven_days.map((day) => day.date),
    [
      '2026-03-24',
      '2026-03-25',
      '2026-03-26',
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ],
  );
  assert.deepEqual(
    snapshot.seven_days.map((day) => day.cost_eur_nanos),
    [0, 0, 0, 0, 1, 2, 3],
  );

  runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      turn_id: 'local-april-utc-march',
      completed_at: '2026-03-31T22:30:00.000Z',
      cost_eur_nanos: 5,
    }),
  );
  runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      turn_id: 'local-april-utc-april',
      completed_at: '2026-04-01T01:00:00.000Z',
      cost_eur_nanos: 7,
    }),
  );

  const april = runtime.buildSnapshot(dataRoot, {
    nowMs: Date.parse('2026-04-01T12:00:00.000Z'),
  });
  assert.equal(april.today.date, '2026-04-01');
  assert.equal(april.today.cost_eur_nanos, 12);
  assert.equal(april.month.cost_eur_nanos, 12);
});

test('uses Berlin calendar boundaries without 24-hour date arithmetic', () => {
  const cases = [
    ['2026-08-20T21:59:59.999Z', '2026-08-20'],
    ['2026-08-20T22:00:00.000Z', '2026-08-21'],
    ['2026-08-31T21:59:59.999Z', '2026-08-31'],
    ['2026-08-31T22:00:00.000Z', '2026-09-01'],
    ['2026-12-31T22:59:59.999Z', '2026-12-31'],
    ['2026-12-31T23:00:00.000Z', '2027-01-01'],
    ['2026-03-29T00:59:59.000Z', '2026-03-29'],
    ['2026-03-29T01:00:00.000Z', '2026-03-29'],
    ['2026-10-25T00:59:59.000Z', '2026-10-25'],
    ['2026-10-25T01:00:00.000Z', '2026-10-25'],
  ];
  for (const [timestamp, expectedDate] of cases) {
    assert.equal(
      runtime.localDateParts(timestamp, 'Europe/Berlin').date,
      expectedDate,
      timestamp,
    );
  }
  assert.deepEqual(
    Array.from({ length: 7 }, (_, index) =>
      runtime.shiftDateKey('2026-03-31', index - 6),
    ),
    [
      '2026-03-25',
      '2026-03-26',
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
    ],
  );
});

test('projects month end with integer round-half-up and computes budgets', (t) => {
  assert.equal(
    runtime.projectMonthEndNanos(
      1,
      '2026-08-02T10:00:00.000Z',
      'Europe/Berlin',
    ),
    16,
  );
  for (const [now, expected] of [
    ['2026-08-20T10:00:00.000Z', 15_500_000_000],
    ['2026-08-31T10:00:00.000Z', 10_000_000_000],
    ['2027-02-10T10:00:00.000Z', 28_000_000_000],
    ['2028-02-10T10:00:00.000Z', 29_000_000_000],
  ]) {
    assert.equal(
      runtime.projectMonthEndNanos(
        10_000_000_000,
        now,
        'Europe/Berlin',
      ),
      expected,
      now,
    );
  }
  assert.equal(
    runtime.projectMonthEndNanos(
      0,
      '2026-08-20T10:00:00.000Z',
      'Europe/Berlin',
    ),
    0,
  );

  const dataRoot = temporaryData(t);
  runtime.saveSettings(dataRoot, {
    schema: 1,
    timezone: 'Europe/Berlin',
    budgets: {
      daily_eur: 20,
      monthly_eur: 40,
      warning_thresholds_percent: [50, 80, 100],
    },
    notifications: { windows: false },
    hook: { message_format: 'compact' },
  });
  runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      completed_at: '2026-08-20T10:00:00.000Z',
      cost_eur_nanos: 10_000_000_000,
    }),
  );

  const snapshot = runtime.buildSnapshot(dataRoot, {
    now: '2026-08-20T12:00:00.000Z',
  });
  assert.equal(snapshot.budgets.daily.percentage, 50);
  assert.equal(
    snapshot.budgets.daily.remaining_eur_nanos,
    10_000_000_000,
  );
  assert.equal(snapshot.budgets.daily.over_eur_nanos, 0);
  assert.equal(snapshot.budgets.monthly.percentage, 25);
  assert.equal(snapshot.budgets.forecast_eur_nanos, 15_500_000_000);
  assert.equal(snapshot.budgets.forecast_percentage, 38.75);
  assert.deepEqual(runtime.crossedThresholds(49, 101, [100, 50, 80]), [
    50, 80, 100,
  ]);
  assert.deepEqual(
    runtime.crossedBudgetThresholds(
      runtime.budgetState(0.3, 149_999_999),
      runtime.budgetState(0.3, 150_000_000),
      [100, 50, 80],
    ),
    [50],
  );
});

test('summarizes models, sessions, agents, cache usage, and recent turns', (t) => {
  const dataRoot = temporaryData(t);
  const aUsage = usage(60, 30, 5, 10);
  const bUsage = usage(40, 10, 5, 10);
  const firstUsage = addUsage(aUsage, bUsage);
  const secondUsage = usage(50, 10, 5, 5);
  const sessionId = '/private/work/project-name';

  runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: 'summary-root',
      session_id: sessionId,
      turn_id: 'summary-one',
      completed_at: '2026-08-20T09:00:00.000Z',
      usage: firstUsage,
      cost_eur_nanos: 2_000_000_000,
      model_breakdown: [
        {
          model: 'model-a',
          usage: aUsage,
          cost_usd_nanos: 0,
          cost_eur_nanos: 1_200_000_000,
        },
        {
          model: 'model-b',
          usage: bUsage,
          cost_usd_nanos: 0,
          cost_eur_nanos: 800_000_000,
        },
      ],
      agent_breakdown: {
        root: {
          usage: aUsage,
          cost_usd_nanos: 0,
          cost_eur_nanos: 1_400_000_000,
        },
        subagents: {
          usage: bUsage,
          cost_usd_nanos: 0,
          cost_eur_nanos: 600_000_000,
          thread_count: 2,
        },
      },
    }),
  );
  const second = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: 'summary-root',
      session_id: sessionId,
      turn_id: 'summary-two',
      completed_at: '2026-08-20T10:00:00.000Z',
      usage: secondUsage,
      cost_eur_nanos: 1_000_000_000,
      model_breakdown: [
        {
          model: 'model-a',
          usage: secondUsage,
          cost_usd_nanos: 0,
          cost_eur_nanos: 1_000_000_000,
        },
      ],
      agent_breakdown: {
        root: {
          usage: secondUsage,
          cost_usd_nanos: 0,
          cost_eur_nanos: 1_000_000_000,
        },
        subagents: {
          usage: usage(0),
          cost_usd_nanos: 0,
          cost_eur_nanos: 0,
          thread_count: 0,
        },
      },
    }),
  );

  const snapshot = runtime.buildSnapshot(dataRoot, {
    now: '2026-08-20T12:00:00.000Z',
  });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.today.cost_eur_nanos, 3_000_000_000);
  assert.deepEqual(
    snapshot.by_model.map((item) => [
      item.model,
      item.cost_eur_nanos,
      item.turns,
    ]),
    [
      ['model-a', 2_200_000_000, 2],
      ['model-b', 800_000_000, 1],
    ],
  );
  assert.equal(snapshot.by_session.length, 1);
  assert.equal(snapshot.by_session[0].cost_eur_nanos, 3_000_000_000);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|project-name/);
  assert.equal(snapshot.by_agent.root.cost_eur_nanos, 2_400_000_000);
  assert.equal(snapshot.by_agent.subagent.cost_eur_nanos, 600_000_000);
  assert.equal(snapshot.by_agent.subagent.thread_count, 2);
  assert.deepEqual(
    {
      ...snapshot.cache,
      hit_rate_percent: undefined,
    },
    {
    input_tokens: 150,
    cached_input_tokens: 50,
    cache_write_input_tokens: 15,
    uncached_input_tokens: 85,
      hit_rate_percent: undefined,
    },
  );
  assert.ok(Math.abs(snapshot.cache.hit_rate_percent - 100 / 3) < 1e-12);
  assert.equal(snapshot.recent_turns.length, 2);
  assert.equal(snapshot.recent_turns[0].model, 'model-a');
  assert.equal(snapshot.records_count, 2);
  assert.equal(snapshot.conflicts.length, 0);
  assert.deepEqual(snapshot.diagnostics, []);
});

test('keeps forks separate when they retain the source session id', (t) => {
  const dataRoot = temporaryData(t);
  runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: 'source-root',
      session_id: 'shared-source-session',
      turn_id: 'source-turn',
      cost_eur_nanos: 1,
    }),
  );
  runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: 'fork-root',
      session_id: 'shared-source-session',
      turn_id: 'fork-turn',
      cost_eur_nanos: 2,
    }),
  );

  const snapshot = runtime.buildSnapshot(dataRoot, {
    now: '2026-08-20T13:00:00.000Z',
  });
  assert.equal(snapshot.by_session.length, 2);
  assert.deepEqual(
    snapshot.by_session.map((group) => group.cost_eur_nanos).sort(),
    [1, 2],
  );
  assert.equal(
    new Set(snapshot.by_session.map((group) => group.key)).size,
    2,
  );
});

test('incremental ledger cache skips unchanged files and detects appends, additions, and deletions', (t) => {
  const dataRoot = temporaryData(t);
  const first = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: 'cached-root',
      turn_id: 'cached-first',
    }),
  );

  assert.equal(runtime.readLedger(dataRoot).records.length, 1);
  const cachePath = path.join(
    dataRoot,
    'cache',
    'ledger-read-v3.json.gz',
  );
  if (process.platform !== 'win32' && (fs.statSync(dataRoot).mode & 0o777) !== 0o777) {
    assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
  }
  assert.equal(
    zlib.gunzipSync(fs.readFileSync(cachePath)).includes(dataRoot),
    false,
  );

  const warm = trackLedgerReads(() => runtime.readLedger(dataRoot));
  assert.equal(warm.value.records.length, 1);
  assert.deepEqual(warm.opened, []);

  const runtimeModulePath = require.resolve(
    '../plugins/codex-cost-meter/lib/runtime-data',
  );
  delete require.cache[runtimeModulePath];
  const freshRuntime = require(runtimeModulePath);
  const diskWarm = trackLedgerReads(() =>
    freshRuntime.readLedger(dataRoot),
  );
  assert.equal(diskWarm.value.records.length, 1);
  assert.deepEqual(diskWarm.opened, []);

  const appendedRecord = ledgerRecord({
    root_thread_id: 'cached-root',
    turn_id: 'cached-second',
  });
  const appendIo = trackLedgerReads(() =>
    runtime.appendLedgerRecord(dataRoot, appendedRecord),
  );
  assert.equal(appendIo.value.recorded, true);
  assert.equal(
    appendIo.positions.some((position) => position > 0),
    true,
  );
  const appended = trackLedgerReads(() => runtime.readLedger(dataRoot));
  assert.equal(appended.value.records.length, 2);
  assert.deepEqual(appended.opened, []);

  const addedRecord = ledgerRecord({
    root_thread_id: 'new-file-root',
    turn_id: 'new-file-turn',
  });
  const addedResult = runtime.appendLedgerRecord(
    dataRoot,
    addedRecord,
  );
  assert.equal(addedResult.recorded, true);
  const addedPath = addedResult.ledgerPath;
  const added = trackLedgerReads(() => runtime.readLedger(dataRoot));
  assert.equal(added.value.records.length, 3);
  assert.deepEqual(added.opened, []);

  fs.unlinkSync(first.ledgerPath);
  const deleted = trackLedgerReads(() => runtime.readLedger(dataRoot));
  assert.equal(deleted.value.complete, true);
  assert.deepEqual(
    deleted.value.records.map((record) => record.turn_id),
    ['new-file-turn'],
  );
  assert.deepEqual(deleted.opened, [addedPath]);
});

test('requires the generation marker for external in-place ledger appends', (t) => {
  const dataRoot = temporaryData(t);
  const first = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: 'cached-root',
      turn_id: 'cached-first',
    }),
  );
  assert.equal(runtime.readLedger(dataRoot).records.length, 1);

  const appendedRecord = runtime.normalizeLedgerRecord(
    ledgerRecord({
      root_thread_id: 'cached-root',
      turn_id: 'external-second',
    }),
  );
  fs.appendFileSync(
    first.ledgerPath,
    `${JSON.stringify(appendedRecord)}\n`,
    'utf8',
  );
  assert.equal(runtime.readLedger(dataRoot).records.length, 1);

  const monthDirectory = path.dirname(first.ledgerPath);
  fs.writeFileSync(
    path.join(monthDirectory, '.generation'),
    'external-edit\n',
    'utf8',
  );
  assert.equal(runtime.readLedger(dataRoot).records.length, 2);
});

test('uses pre/post generation epochs so an interleaved reader cannot leave a stale cache', (t) => {
  const dataRoot = temporaryData(t);
  const first = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: 'epoch-root',
      turn_id: 'epoch-first',
    }),
  );
  assert.equal(runtime.readLedger(dataRoot).records.length, 1);

  const originalRenameSync = fs.renameSync;
  let generationRenames = 0;
  fs.renameSync = function trackedRenameSync(source, destination) {
    if (path.basename(destination) === '.generation') {
      generationRenames += 1;
    }
    return originalRenameSync.call(fs, source, destination);
  };
  try {
    const second = runtime.appendLedgerRecord(
      dataRoot,
      ledgerRecord({
        root_thread_id: 'epoch-root',
        turn_id: 'epoch-second',
      }),
    );
    assert.equal(second.recorded, true);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(generationRenames, 2);
  assert.equal(runtime.readLedger(dataRoot).records.length, 2);

  markLedgerChanged(first.ledgerPath);
  assert.equal(runtime.readLedger(dataRoot).records.length, 2);
  const external = runtime.normalizeLedgerRecord(
    ledgerRecord({
      root_thread_id: 'epoch-root',
      turn_id: 'epoch-third',
    }),
  );
  fs.appendFileSync(
    first.ledgerPath,
    `${JSON.stringify(external)}\n`,
    'utf8',
  );
  assert.equal(runtime.readLedger(dataRoot).records.length, 2);
  markLedgerChanged(first.ledgerPath);
  assert.equal(runtime.readLedger(dataRoot).records.length, 3);
});

test('waits beyond one second for a concurrent ledger writer', (t) => {
  const dataRoot = temporaryData(t);
  const lockDirectory = path.join(dataRoot, 'usage', '.locks');
  const lockPath = path.join(lockDirectory, '.ledger-write.lock');
  fs.mkdirSync(lockDirectory, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        "const fs=require('node:fs');",
        'const file=process.argv[1];',
        "const descriptor=fs.openSync(file,'wx',0o600);",
        "fs.writeFileSync(descriptor,`${process.pid}\\n`);",
        'fs.closeSync(descriptor);',
        'setTimeout(()=>fs.unlinkSync(file),1400);',
      ].join(''),
      lockPath,
    ],
    { stdio: 'ignore' },
  );
  t.after(() => child.kill());

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(lockPath)) {
      break;
    }
    waitMilliseconds(10);
  }
  assert.equal(fs.existsSync(lockPath), true);

  const started = Date.now();
  const appended = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({ turn_id: 'after-contention' }),
  );
  assert.equal(appended.recorded, true);
  assert.ok(Date.now() - started >= 1_000);
});

test('retries a transient permission error while acquiring a ledger lock', (t) => {
  const dataRoot = temporaryData(t);
  const originalOpenSync = fs.openSync;
  let injected = false;
  fs.openSync = function openSyncWithTransientLockError(filePath, flags, mode) {
    if (
      !injected &&
      flags === 'wx' &&
      path.basename(filePath) === '.ledger-write.lock'
    ) {
      injected = true;
      const error = new Error('transient Windows lock contention');
      error.code = 'EPERM';
      throw error;
    }
    return originalOpenSync.call(fs, filePath, flags, mode);
  };
  t.after(() => {
    fs.openSync = originalOpenSync;
  });

  const appended = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({ turn_id: 'after-transient-eperm' }),
  );
  assert.equal(injected, true);
  assert.equal(appended.recorded, true);
});

test('rebuilds a corrupt ledger cache and detects source-file replacement', (t) => {
  const dataRoot = temporaryData(t);
  const first = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      root_thread_id: 'replace-root',
      turn_id: 'replace-one',
    }),
  );
  assert.equal(runtime.readLedger(dataRoot).records.length, 1);

  const cachePath = path.join(
    dataRoot,
    'cache',
    'ledger-read-v3.json.gz',
  );
  fs.writeFileSync(cachePath, '{"schema":1,"broken":', 'utf8');
  const rebuilt = trackLedgerReads(() => runtime.readLedger(dataRoot));
  assert.equal(rebuilt.value.complete, true);
  assert.equal(rebuilt.value.records[0].turn_id, 'replace-one');
  assert.deepEqual(rebuilt.opened, [first.ledgerPath]);
  assert.doesNotThrow(() =>
    JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath))),
  );

  const replacement = runtime.normalizeLedgerRecord(
    ledgerRecord({
      root_thread_id: 'replace-root',
      turn_id: 'replace-two',
    }),
  );
  const replacementPath = `${first.ledgerPath}.replacement`;
  fs.writeFileSync(
    replacementPath,
    `${JSON.stringify(replacement)}\n`,
    'utf8',
  );
  const originalStat = fs.statSync(first.ledgerPath);
  fs.utimesSync(
    replacementPath,
    originalStat.atime,
    originalStat.mtime,
  );
  fs.renameSync(replacementPath, first.ledgerPath);

  const replaced = trackLedgerReads(() => runtime.readLedger(dataRoot));
  assert.equal(replaced.value.complete, true);
  assert.deepEqual(
    replaced.value.records.map((record) => record.turn_id),
    ['replace-two'],
  );
  assert.deepEqual(replaced.opened, [first.ledgerPath]);
});

test('marks malformed schema-2 ledgers incomplete and refuses new writes', (t) => {
  const dataRoot = temporaryData(t);
  const first = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({ turn_id: 'valid-before-corruption' }),
  );
  fs.appendFileSync(first.ledgerPath, '{invalid json', 'utf8');
  markLedgerChanged(first.ledgerPath);
  const before = fs.readFileSync(first.ledgerPath, 'utf8');

  const malformedJson = runtime.readLedger(dataRoot);
  assert.equal(malformedJson.complete, false);
  assert.match(malformedJson.diagnostics.join('\n'), /invalid JSON/i);
  assert.throws(
    () =>
      runtime.appendLedgerRecord(
        dataRoot,
        ledgerRecord({ turn_id: 'must-not-append' }),
      ),
    (error) =>
      error?.code === 'INCOMPLETE_LEDGER' &&
      /no record was written/i.test(error.message),
  );
  assert.equal(fs.readFileSync(first.ledgerPath, 'utf8'), before);

  fs.writeFileSync(
    first.ledgerPath,
    `${JSON.stringify({
      schema: 2,
      root_thread_id: 'invalid-schema-two',
      turn_id: 'missing-required-fields',
      completed_at: '2026-08-20T12:00:00.000Z',
    })}\n`,
    'utf8',
  );
  markLedgerChanged(first.ledgerPath);
  const invalidRecord = runtime.readLedger(dataRoot);
  assert.equal(invalidRecord.complete, false);
  assert.match(invalidRecord.diagnostics.join('\n'), /invalid ledger record/i);

  const invalidUsages = [
    {
      ...first.record.usage,
      output_tokens: '20',
    },
    {
      ...first.record.usage,
      cached_input_tokens: -1,
    },
    Object.fromEntries(
      Object.entries(first.record.usage).filter(
        ([key]) => key !== 'total_tokens',
      ),
    ),
  ];
  for (const invalidUsage of invalidUsages) {
    fs.writeFileSync(
      first.ledgerPath,
      `${JSON.stringify({
        ...first.record,
        usage: invalidUsage,
      })}\n`,
      'utf8',
    );
    markLedgerChanged(first.ledgerPath);
    const invalidUsageLedger = runtime.readLedger(dataRoot);
    assert.equal(invalidUsageLedger.complete, false);
    assert.match(
      invalidUsageLedger.diagnostics.join('\n'),
      /usage\.[a-z_]+ must be a non-negative safe integer/i,
    );
  }
});

test('marks conflicting duplicate turns incomplete and blocks unrelated appends', (t) => {
  const dataRoot = temporaryData(t);
  const first = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({ turn_id: 'conflicting-turn' }),
  );
  fs.appendFileSync(
    first.ledgerPath,
    `${JSON.stringify({
      ...first.record,
      written_at: '2026-08-20T12:01:00.000Z',
      cost_eur_nanos: first.record.cost_eur_nanos + 1,
    })}\n`,
    'utf8',
  );
  markLedgerChanged(first.ledgerPath);

  const ledger = runtime.readLedger(dataRoot);
  assert.equal(ledger.complete, false);
  assert.equal(ledger.conflicts.length, 1);
  assert.throws(
    () =>
      runtime.appendLedgerRecord(
        dataRoot,
        ledgerRecord({ turn_id: 'unrelated-turn' }),
      ),
    (error) => error?.code === 'INCOMPLETE_LEDGER',
  );
});

test('ignores schema-1 history so schema-2 accounting can start fresh', (t) => {
  const dataRoot = temporaryData(t);
  const record = runtime.normalizeLedgerRecord(
    ledgerRecord({ turn_id: 'new-schema-two-turn' }),
  );
  const ledgerPath = runtime.ledgerPathFor(dataRoot, record);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema: 1,
      root_thread_id: record.root_thread_id,
      turn_id: 'legacy-turn',
      cost_eur_nanos: 123,
    }),
    'utf8',
  );

  const before = runtime.readLedger(dataRoot);
  assert.equal(before.complete, true);
  assert.deepEqual(before.records, []);

  const appended = runtime.appendLedgerRecord(dataRoot, record);
  assert.equal(appended.recorded, true);
  const content = fs.readFileSync(ledgerPath, 'utf8');
  assert.match(content, /"schema":1.*\n\{"schema":2/s);
  const after = runtime.readLedger(dataRoot);
  assert.equal(after.complete, true);
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].turn_id, 'new-schema-two-turn');
});

test('adds a separator after a valid unterminated JSONL record', (t) => {
  const dataRoot = temporaryData(t);
  const first = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({ turn_id: 'unterminated-valid-first' }),
  );
  const content = fs.readFileSync(first.ledgerPath, 'utf8');
  fs.writeFileSync(first.ledgerPath, content.replace(/\n$/, ''), 'utf8');

  const second = runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({ turn_id: 'second-after-unterminated' }),
  );
  assert.equal(second.recorded, true);
  const lines = fs
    .readFileSync(first.ledgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).turn_id, 'unterminated-valid-first');
  assert.equal(JSON.parse(lines[1]).turn_id, 'second-after-unterminated');
});
