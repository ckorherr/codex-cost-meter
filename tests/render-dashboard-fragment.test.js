'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const runtime = require('../plugins/codex-cost-meter/lib/runtime-data');
const rendererPath = path.resolve(
  __dirname,
  '..',
  'plugins',
  'codex-cost-meter',
  'scripts',
  'render-dashboard-fragment.js',
);
const {
  MAX_FRAGMENT_BYTES,
  renderDashboardFragment,
  visualizationReferencePath,
} = require(rendererPath);

function temporaryDirectory(t, prefix = 'cost-fragment-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function usage(input, cached, cacheWrite, output, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function ledgerRecord(overrides = {}) {
  const totalUsage = usage(1_000, 400, 100, 250, 50);
  return {
    schema: 2,
    root_thread_id: 'root-thread',
    session_id: 'session-id',
    turn_id: 'turn-one',
    completed_at: '2026-08-20T11:30:00.000Z',
    written_at: '2026-08-20T11:30:01.000Z',
    pricing_as_of: '2026-08-20',
    eur_per_usd: 0.9,
    usage: totalUsage,
    cost_usd_nanos: 2_000_000_000,
    cost_eur_nanos: 1_800_000_000,
    model_breakdown: [
      {
        model: 'gpt-5.6-sol',
        usage: totalUsage,
        cost_usd_nanos: 2_000_000_000,
        cost_eur_nanos: 1_800_000_000,
      },
    ],
    agent_breakdown: {
      root: {
        usage: usage(700, 300, 50, 175, 35),
        cost_usd_nanos: 1_400_000_000,
        cost_eur_nanos: 1_260_000_000,
      },
      subagents: {
        usage: usage(300, 100, 50, 75, 15),
        cost_usd_nanos: 600_000_000,
        cost_eur_nanos: 540_000_000,
        thread_count: 2,
      },
    },
    ...overrides,
  };
}

function writeFixtureLedger(dataRoot) {
  runtime.appendLedgerRecord(dataRoot, ledgerRecord());
  runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      turn_id: 'turn-two',
      completed_at: '2026-08-19T10:00:00.000Z',
      written_at: '2026-08-19T10:00:01.000Z',
      cost_eur_nanos: 700_000_000,
      cost_usd_nanos: 800_000_000,
      usage: usage(500, 200, 50, 100, 20),
      model_breakdown: [
        {
          model:
            '</td><script>globalThis.pwned=true</script><img src=x onerror=alert(1)>',
          usage: usage(500, 200, 50, 100, 20),
          cost_usd_nanos: 800_000_000,
          cost_eur_nanos: 700_000_000,
        },
      ],
      agent_breakdown: {
        root: {
          usage: usage(500, 200, 50, 100, 20),
          cost_usd_nanos: 800_000_000,
          cost_eur_nanos: 700_000_000,
        },
        subagents: {
          usage: usage(0, 0, 0, 0),
          cost_usd_nanos: 0,
          cost_eur_nanos: 0,
          thread_count: 0,
        },
      },
    }),
  );
}

test('requires an explicit absolute --output path', () => {
  const help = spawnSync(process.execPath, [rendererPath, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--output ABSOLUTE_PATH/);
  assert.equal(help.stderr, '');

  const missing = spawnSync(process.execPath, [rendererPath], {
    encoding: 'utf8',
  });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /--output ABSOLUTE_PATH is required/);

  const relative = spawnSync(
    process.execPath,
    [rendererPath, '--output', 'dashboard.html'],
    { encoding: 'utf8' },
  );
  assert.notEqual(relative.status, 0);
  assert.equal(relative.stdout, '');
  assert.match(relative.stderr, /absolute path/);
});

test('prints a Windows host path for WSL-mounted visualization files', () => {
  const mountedPath =
    '/mnt/c/Users/example/.codex/visualizations/2026/08/20/thread/dashboard.html';
  assert.equal(
    visualizationReferencePath(mountedPath, {
      WSL_DISTRO_NAME: 'Ubuntu-24.04',
    }),
    'C:/Users/example/.codex/visualizations/2026/08/20/thread/dashboard.html',
  );
  assert.equal(
    visualizationReferencePath(mountedPath, {}),
    path.resolve(mountedPath),
  );
  assert.equal(
    visualizationReferencePath('/home/example/dashboard.html', {
      WSL_DISTRO_NAME: 'Ubuntu-24.04',
    }),
    path.resolve('/home/example/dashboard.html'),
  );
});

test('writes a self-contained safe fragment with all requested snapshot views', (t) => {
  const dataRoot = temporaryDirectory(t);
  const outputPath = path.join(
    temporaryDirectory(t, 'cost-fragment-output-'),
    'codex-cost-dashboard.html',
  );
  writeFixtureLedger(dataRoot);

  const result = renderDashboardFragment({
    dataDir: dataRoot,
    outputPath,
    now: '2026-08-20T12:00:00.000Z',
    rootId: 'cost-dashboard-test',
  });
  const fragment = fs.readFileSync(outputPath, 'utf8');

  assert.equal(result.outputPath, outputPath);
  assert.ok(result.bytes < MAX_FRAGMENT_BYTES);
  assert.ok(Buffer.byteLength(fragment) < MAX_FRAGMENT_BYTES);
  assert.doesNotMatch(fragment, /<!doctype|<html\b|<head\b|<body\b/i);
  assert.doesNotMatch(
    fragment,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/,
  );
  assert.doesNotMatch(fragment, /https?:\/\//i);
  assert.doesNotMatch(fragment, /<(?:link|iframe|img)\b/i);
  assert.match(fragment, /id="cost-dashboard-test"/);
  assert.match(fragment, /var\(--foreground\)/);
  assert.match(fragment, /var\(--viz-series-1\)/);
  assert.match(fragment, /@media \(max-width: 560px\)/);

  assert.match(fragment, />Today</);
  assert.match(fragment, />€1\.80</);
  assert.match(fragment, />Current month</);
  assert.match(fragment, />€2\.50</);
  assert.match(fragment, />Recorded-cost forecast</);
  assert.match(fragment, />€3\.88</);
  assert.match(fragment, />Last seven days</);
  assert.match(fragment, />Cost by model</);
  assert.match(fragment, />Cost by task</);
  assert.match(fragment, /Task [a-f0-9]{8}/);
  assert.match(fragment, />Root and subagents</);
  assert.match(fragment, />Prompt cache</);
  assert.match(fragment, />Recent turns</);
  assert.match(fragment, />40%</);
  assert.match(fragment, /1,850 tokens/);
  assert.match(fragment, /sendFollowUpMessage/);
  assert.match(fragment, /Show my Codex cost dashboard/);

  assert.match(fragment, /Budgets are unrestricted\./);
  assert.doesNotMatch(fragment, /role="progressbar"/);
  assert.doesNotMatch(fragment, /<script>globalThis\.pwned/);
  assert.doesNotMatch(fragment, /<img src=x/);
  assert.doesNotMatch(fragment, /root-thread|session-id/);
  assert.match(
    fragment,
    /&lt;\/td&gt;&lt;script&gt;globalThis\.pwned=true&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;/,
  );
});

test('renders configured budget progress while keeping limits informational', (t) => {
  const dataRoot = temporaryDirectory(t);
  const outputPath = path.join(dataRoot, 'budget-dashboard.html');
  writeFixtureLedger(dataRoot);
  runtime.saveSettings(dataRoot, {
    schema: 1,
    timezone: 'Europe/Berlin',
    budgets: {
      daily_eur: 3,
      monthly_eur: 10,
      warning_thresholds_percent: [50, 80, 100],
    },
    notifications: { windows: false },
    hook: { message_format: 'compact' },
  });

  renderDashboardFragment({
    dataDir: dataRoot,
    outputPath,
    now: '2026-08-20T12:00:00.000Z',
    rootId: 'budget-dashboard-test',
  });
  const fragment = fs.readFileSync(outputPath, 'utf8');

  assert.doesNotMatch(fragment, /Budgets are unrestricted/);
  assert.match(fragment, />Budget guidance</);
  assert.match(fragment, />Daily budget</);
  assert.match(fragment, /aria-valuenow="60\.0"/);
  assert.match(fragment, /60% · €1\.20 left/);
  assert.match(fragment, />Monthly budget</);
  assert.match(fragment, /aria-valuenow="25\.0"/);
  assert.match(fragment, /25% · €7\.50 left/);
  assert.match(fragment, />38\.8% of monthly budget</);
  assert.match(fragment, />Informational only</);
});

test('CLI prints only the output path and never snapshot values', (t) => {
  const dataRoot = temporaryDirectory(t);
  const outputRoot = temporaryDirectory(t, 'cost-cli-output-');
  const outputPath = path.join(outputRoot, 'dashboard.html');
  const secretModel = 'ledger-secret-model-value';
  runtime.appendLedgerRecord(
    dataRoot,
    ledgerRecord({
      completed_at: new Date(Date.now() - 1_000).toISOString(),
      written_at: new Date().toISOString(),
      model_breakdown: [
        {
          model: secretModel,
          usage: usage(1_000, 400, 100, 250, 50),
          cost_usd_nanos: 2_000_000_000,
          cost_eur_nanos: 1_800_000_000,
        },
      ],
    }),
  );

  const invocation = spawnSync(
    process.execPath,
    [
      rendererPath,
      '--output',
      outputPath,
      '--data-dir',
      dataRoot,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(invocation.status, 0, invocation.stderr);
  assert.equal(
    invocation.stdout,
    `${visualizationReferencePath(outputPath)}\n`,
  );
  assert.equal(invocation.stderr, '');
  assert.doesNotMatch(invocation.stdout, /ledger-secret|€|tokens|turn/i);
  assert.match(fs.readFileSync(outputPath, 'utf8'), /ledger-secret-model-value/);
});

test('suppresses numeric totals when the ledger traversal is incomplete', (t) => {
  const outputPath = path.join(
    temporaryDirectory(t),
    'incomplete-dashboard.html',
  );
  const fakeRuntime = {
    EUR_NANOS: 1_000_000_000,
    resolveDataRoot() {
      return '/unused';
    },
    loadSettings() {
      return { settings: runtime.defaultSettings() };
    },
    buildSnapshot() {
      return {
        complete: false,
        today: { cost_eur_nanos: 987_654_321_000 },
      };
    },
    formatEuroCost: runtime.formatEuroCost,
    formatTokens: runtime.formatTokens,
  };

  renderDashboardFragment({
    outputPath,
    runtimeData: fakeRuntime,
    rootId: 'incomplete-dashboard-test',
  });
  const fragment = fs.readFileSync(outputPath, 'utf8');

  assert.match(fragment, /no partial totals are shown/);
  assert.doesNotMatch(fragment, /987|€/);
});

test('renders trustworthy gap amounts as a pending lower bound', (t) => {
  const outputPath = path.join(
    temporaryDirectory(t),
    'lower-bound-dashboard.html',
  );
  const fakeRuntime = {
    EUR_NANOS: 1_000_000_000,
    resolveDataRoot() {
      return '/unused';
    },
    loadSettings() {
      return { settings: runtime.defaultSettings() };
    },
    buildSnapshot() {
      return {
        complete: false,
        generated_at: '2026-08-20T13:00:00.000Z',
        timezone: 'Europe/Berlin',
        lower_bound: {
          available: true,
          pending_turns: 2,
          known_pending_turns: 1,
          unknown_pending_turns: 1,
          today_pending_turns: 1,
          seven_day_pending_turns: 2,
          month_pending_turns: 2,
        },
        today: {
          turns: 1,
          cost_eur_nanos: 1_250_000_000,
          usage: usage(100, 20, 0, 10),
        },
        month: {
          turns: 2,
          cost_eur_nanos: 2_500_000_000,
          usage: usage(200, 40, 0, 20),
        },
        seven_days: [],
        budgets: {
          daily: { limit_eur_nanos: null },
          monthly: { limit_eur_nanos: null },
          forecast_eur_nanos: 3_750_000_000,
          forecast_percentage: null,
        },
        by_model: [],
        by_session: [],
        by_agent: {
          root: {},
          subagent: {},
          unattributed: {
            turns: 1,
            cost_eur_nanos: 500_000_000,
            usage: usage(50, 0, 0, 5),
          },
        },
        cache: {},
        recent_turns: [],
      };
    },
    formatEuroCost: runtime.formatEuroCost,
    formatTokens: runtime.formatTokens,
  };

  renderDashboardFragment({
    outputPath,
    runtimeData: fakeRuntime,
    rootId: 'lower-bound-dashboard-test',
  });
  const fragment = fs.readFileSync(outputPath, 'utf8');

  assert.match(fragment, /Showing a known minimum/);
  assert.match(fragment, /2 completed turns are pending/);
  assert.match(fragment, /≥€1\.25/);
  assert.match(fragment, /1 pending/);
  assert.match(fragment, /Pending attribution/);
  assert.doesNotMatch(fragment, /no partial totals are shown/);
});
