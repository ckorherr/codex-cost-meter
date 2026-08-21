'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const dashboardPath = path.resolve(
  __dirname,
  '..',
  'plugins',
  'codex-cost-meter',
  'scripts',
  'dashboard.js',
);
const dashboardRoot = path.resolve(
  __dirname,
  '..',
  'plugins',
  'codex-cost-meter',
  'dashboard',
);
const { createDashboardServer, main } = require(dashboardPath);

const DEFAULT_SETTINGS = {
  schema: 1,
  timezone: 'Europe/Berlin',
  budgets: {
    daily_eur: null,
    monthly_eur: null,
    warning_thresholds_percent: [50, 80, 100],
  },
  notifications: {
    windows: false,
  },
  hook: {
    message_format: 'compact',
  },
};

function usage(totalTokens = 0) {
  return {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
}

function snapshot(settings) {
  const day = (date, nanos, turns = 1) => ({
    date,
    cost_eur_nanos: nanos,
    usage: usage(turns * 100),
    turns,
  });
  return {
    complete: true,
    generated_at: '2026-08-20T12:00:00.000Z',
    timezone: settings.timezone,
    today: day('2026-08-20', 1_250_000_000, 2),
    month: {
      month: '2026-08',
      cost_eur_nanos: 8_500_000_000,
      usage: usage(800),
      turns: 8,
    },
    seven_days: [
      day('2026-08-14', 250_000_000),
      day('2026-08-15', 500_000_000),
      day('2026-08-16', 750_000_000),
      day('2026-08-17', 1_000_000_000),
      day('2026-08-18', 1_250_000_000),
      day('2026-08-19', 1_500_000_000),
      day('2026-08-20', 1_250_000_000, 2),
    ],
    budgets: {
      daily: {
        limit_eur_nanos:
          settings.budgets.daily_eur === null
            ? null
            : settings.budgets.daily_eur * 1_000_000_000,
        spent_eur_nanos: 1_250_000_000,
        percentage:
          settings.budgets.daily_eur === null
            ? null
            : 125 / settings.budgets.daily_eur,
        remaining_eur_nanos: 0,
        over_eur_nanos: 0,
      },
      monthly: {
        limit_eur_nanos:
          settings.budgets.monthly_eur === null
            ? null
            : settings.budgets.monthly_eur * 1_000_000_000,
        spent_eur_nanos: 8_500_000_000,
        percentage:
          settings.budgets.monthly_eur === null
            ? null
            : 850 / settings.budgets.monthly_eur,
        remaining_eur_nanos: 0,
        over_eur_nanos: 0,
      },
      warning_thresholds_percent:
        settings.budgets.warning_thresholds_percent,
      forecast_eur_nanos: 13_175_000_000,
      forecast_percentage: null,
    },
    by_model: [
      {
        model: 'gpt-5.6-sol',
        cost_eur_nanos: 8_500_000_000,
        usage: usage(800),
        turns: 8,
      },
    ],
    by_session: [
      {
        label: 'Task <img src=x onerror=alert(1)>',
        key: 'safe-local-key',
        cost_eur_nanos: 8_500_000_000,
        usage: usage(800),
        turns: 8,
        last_completed_at: '2026-08-20T11:30:00.000Z',
      },
    ],
    task_scopes: {
      today: [
        {
          label: 'Task <img src=x onerror=alert(1)>',
          key: 'safe-local-key',
          cost_eur_nanos: 1_250_000_000,
          usage: usage(200),
          turns: 2,
          last_completed_at: '2026-08-20T11:30:00.000Z',
        },
      ],
      seven_days: [
        {
          label: 'Task <img src=x onerror=alert(1)>',
          key: 'safe-local-key',
          cost_eur_nanos: 6_500_000_000,
          usage: usage(700),
          turns: 7,
          last_completed_at: '2026-08-20T11:30:00.000Z',
        },
      ],
      month: [
        {
          label: 'Task <img src=x onerror=alert(1)>',
          key: 'safe-local-key',
          cost_eur_nanos: 8_500_000_000,
          usage: usage(800),
          turns: 8,
          last_completed_at: '2026-08-20T11:30:00.000Z',
        },
      ],
    },
    by_agent: {
      root: {
        cost_eur_nanos: 6_000_000_000,
        usage: usage(600),
        turns: 8,
      },
      subagent: {
        cost_eur_nanos: 2_500_000_000,
        usage: usage(200),
        turns: 2,
      },
    },
    cache: {
      input_tokens: 800,
      cached_input_tokens: 300,
      cache_write_input_tokens: 50,
      uncached_input_tokens: 450,
      hit_rate_percent: 37.5,
    },
    recent_turns: [
      {
        completed_at: '2026-08-20T11:30:00.000Z',
        task_key: 'safe-local-key',
        task_label: 'Task <unsafe>',
        turn_label: 'Turn 1234',
        model: 'gpt-5.6-sol',
        cost_eur_nanos: 1_250_000_000,
        usage: usage(200),
        agent_threads: 2,
      },
    ],
    records_count: 8,
    conflicts: 0,
    diagnostics: [],
  };
}

function mockRuntimeData(initialSettings = DEFAULT_SETTINGS) {
  let settings = structuredClone(initialSettings);
  return {
    resolveDataRoot(options) {
      return options.dataDir;
    },
    loadSettings(dataRoot) {
      return {
        settings: structuredClone(settings),
        diagnostics: [],
        path: path.join(dataRoot, 'settings.json'),
        exists: fs.existsSync(path.join(dataRoot, 'settings.json')),
        supported: true,
      };
    },
    saveSettings(dataRoot, input) {
      if (input.schema > 1) {
        return {
          settings: structuredClone(settings),
          diagnostics: [],
          path: path.join(dataRoot, 'settings.json'),
          exists: true,
          supported: false,
          saved: false,
          reason: 'unsupported-schema',
        };
      }
      settings = structuredClone(input);
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.writeFileSync(
        path.join(dataRoot, 'settings.json'),
        `${JSON.stringify(settings)}\n`,
        'utf8',
      );
      return {
        settings: structuredClone(settings),
        diagnostics: [],
        path: path.join(dataRoot, 'settings.json'),
        exists: true,
        supported: true,
        saved: true,
      };
    },
    buildSnapshot(_dataRoot, options) {
      return snapshot(options.settings);
    },
    formatEuroCost(value) {
      return `€${Number(value).toFixed(2)}`;
    },
    safeTaskKey(value) {
      return value === 'private-thread-id'
        ? 'safe-local-key'
        : `safe-${String(value).length}`;
    },
  };
}

async function startServer(runtimeData = mockRuntimeData()) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-dashboard-'));
  const server = createDashboardServer({
    dataDir,
    runtimeData,
    nowMs: Date.parse('2026-08-20T12:00:00.000Z'),
    csrfToken: 'test-csrf-token',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    dataDir,
    host: `127.0.0.1:${server.address().port}`,
  };
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function request(server, options = {}) {
  const address = server.address();
  const body =
    options.body === undefined
      ? null
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(String(options.body), 'utf8');
  const headers = { ...(options.headers ?? {}) };
  if (
    body &&
    headers['Content-Length'] === undefined &&
    headers['content-length'] === undefined
  ) {
    headers['Content-Length'] = body.length;
  }

  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: responseBody,
            json: response.headers['content-type']?.startsWith(
              'application/json',
            )
              ? JSON.parse(responseBody)
              : null,
          });
        });
      },
    );
    outgoing.on('error', reject);
    if (body) {
      outgoing.write(body);
    }
    outgoing.end();
  });
}

function openEventStream(server) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = http.get(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/api/events',
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.includes('\n\n') && body.includes('event: dashboard')) {
            resolve({
              outgoing,
              response,
              get body() {
                return body;
              },
            });
          }
        });
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
  });
}

async function waitForCondition(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for dashboard event data.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function dashboardEvents(body) {
  return body
    .split('\n\n')
    .map((block) => block
      .split('\n')
      .find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

test('serves the fixed local dashboard routes with security headers', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture.server));

  assert.equal(fixture.server.address().address, '127.0.0.1');
  assert.equal(typeof createDashboardServer, 'function');
  assert.equal(typeof main, 'function');

  for (const route of ['/', '/app.js', '/styles.css', '/healthz']) {
    const response = await request(fixture.server, { path: route });
    assert.equal(response.statusCode, 200, route);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.match(
      response.headers['content-security-policy'],
      /default-src 'self'/,
    );
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }

  const page = await request(fixture.server);
  assert.match(page.body, /<dialog id="settings-dialog"/);
  assert.match(page.body, /id="seven-day-chart"/);
  assert.doesNotMatch(page.body, /https?:\/\/[^"]+/);
});

test('returns server-computed dashboard data and a per-process CSRF token', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture.server));

  const response = await request(fixture.server, {
    path: '/api/dashboard',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-codex-csrf-token'], 'test-csrf-token');
  assert.equal(response.json.today.display_cost, '€1.25');
  assert.equal(response.json.budgets.display_forecast, '€13.18');
  assert.equal(response.json.by_model[0].usage.display_total_tokens, '800');
  assert.equal(
    response.json.by_session[0].label,
    'Task <img src=x onerror=alert(1)>',
  );
  assert.equal(response.json.settings.timezone, 'Europe/Berlin');
  assert.equal(response.json.live.stale, false);
  assert.equal(response.json.live.error, false);
});

test('reuses cached data until a forced refresh is requested', async (t) => {
  const runtimeData = mockRuntimeData();
  const originalBuildSnapshot = runtimeData.buildSnapshot;
  let builds = 0;
  runtimeData.buildSnapshot = (...arguments_) => {
    builds += 1;
    return originalBuildSnapshot(...arguments_);
  };
  const fixture = await startServer(runtimeData);
  t.after(() => stopServer(fixture.server));

  assert.equal((await request(fixture.server, {
    path: '/api/dashboard',
  })).statusCode, 200);
  assert.equal((await request(fixture.server, {
    path: '/api/dashboard',
  })).statusCode, 200);
  assert.equal(builds, 1);

  assert.equal((await request(fixture.server, {
    path: '/api/dashboard?refresh=1',
  })).statusCode, 200);
  assert.equal(builds, 2);
});

test('joins friendly task names only in the localhost dashboard payload', async (t) => {
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cost-dashboard-codex-home-'),
  );
  fs.writeFileSync(
    path.join(codexHome, 'session_index.jsonl'),
    `${JSON.stringify({
      id: 'private-thread-id',
      thread_name: 'Friendly dashboard task',
      updated_at: '2026-08-20T11:35:00.000Z',
    })}\n`,
    'utf8',
  );
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-dashboard-'));
  const server = createDashboardServer({
    dataDir,
    codexHome,
    env: {},
    runtimeData: mockRuntimeData(),
    nowMs: Date.parse('2026-08-20T12:00:00.000Z'),
    csrfToken: 'friendly-name-token',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => stopServer(server));

  const response = await request(server, { path: '/api/dashboard' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.by_session[0].display_label, 'Friendly dashboard task');
  assert.equal(
    response.json.task_scopes.today[0].display_label,
    'Friendly dashboard task',
  );
  assert.equal(
    response.json.recent_turns[0].display_task_label,
    'Friendly dashboard task',
  );
  assert.equal(response.json.task_names.available, true);
  assert.equal(response.json.task_names.resolved, 1);
  assert.equal(
    response.json.by_session[0].label,
    'Task <img src=x onerror=alert(1)>',
  );
  assert.doesNotMatch(response.body, /private-thread-id/);
});

test('serves a bounded same-origin event stream for live revisions', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture.server));
  const stream = await openEventStream(fixture.server);
  t.after(() => stream.response.destroy());

  assert.equal(stream.response.statusCode, 200);
  assert.match(
    stream.response.headers['content-type'],
    /^text\/event-stream/,
  );
  assert.match(stream.body, /event: dashboard/);
  assert.match(stream.body, /"type":"current"/);
  assert.match(stream.body, /"payload_revision":0/);

  const refreshed = await request(fixture.server, {
    path: '/api/dashboard?refresh=1',
  });
  assert.equal(refreshed.statusCode, 200);
  await waitForCondition(
    () => dashboardEvents(stream.body).some((event) => event.type === 'updated'),
  );
  const updated = dashboardEvents(stream.body)
    .findLast((event) => event.type === 'updated');
  assert.equal(updated.stale, false);
  assert.equal(updated.refreshing, false);
  assert.ok(updated.payload_revision > 0);
});

test('omits every accounting total when the ledger snapshot is incomplete', async (t) => {
  const runtimeData = mockRuntimeData();
  runtimeData.buildSnapshot = (_dataRoot, options) => ({
    ...snapshot(options.settings),
    complete: false,
    today: {
      cost_eur_nanos: 987_654_321_000,
      usage: usage(987_654_321),
      turns: 987,
    },
    by_model: [
      {
        model: 'partial-secret-model',
        cost_eur_nanos: 987_654_321_000,
        usage: usage(987_654_321),
        turns: 987,
      },
    ],
    diagnostics: ['The ledger could not be read completely.'],
  });
  const fixture = await startServer(runtimeData);
  t.after(() => stopServer(fixture.server));

  const response = await request(fixture.server, {
    path: '/api/dashboard',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.complete, false);
  assert.equal(response.json.settings.timezone, 'Europe/Berlin');
  assert.deepEqual(response.json.diagnostics, [
    'The ledger could not be read completely.',
  ]);
  for (const field of [
    'today',
    'month',
    'seven_days',
    'budgets',
    'by_model',
    'by_session',
    'by_agent',
    'cache',
    'recent_turns',
    'records_count',
  ]) {
    assert.equal(Object.hasOwn(response.json, field), false, field);
  }
  assert.doesNotMatch(response.body, /partial-secret-model|987654321/);
});

test('serves trustworthy incomplete accounting as a labeled lower bound', async (t) => {
  const runtimeData = mockRuntimeData();
  runtimeData.buildSnapshot = (_dataRoot, options) => ({
    ...snapshot(options.settings),
    complete: false,
    lower_bound: {
      available: true,
      pending_turns: 2,
      known_pending_turns: 1,
      unknown_pending_turns: 1,
      today_pending_turns: 1,
      seven_day_pending_turns: 2,
      month_pending_turns: 2,
    },
    diagnostics: ['Accounting is incomplete for 2 completed turns.'],
  });
  const fixture = await startServer(runtimeData);
  t.after(() => stopServer(fixture.server));

  const response = await request(fixture.server, {
    path: '/api/dashboard',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.complete, false);
  assert.equal(response.json.lower_bound.available, true);
  assert.equal(response.json.lower_bound.pending_turns, 2);
  assert.equal(response.json.today.display_cost, '€1.25');
  assert.equal(response.json.by_model[0].model, 'gpt-5.6-sol');
  assert.match(response.body, /Accounting is incomplete/);
});

test('uses --data-dir as the real runtime-data root', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-dashboard-real-'));
  const server = createDashboardServer({
    dataDir,
    nowMs: Date.parse('2026-08-20T12:00:00.000Z'),
    csrfToken: 'real-runtime-token',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => stopServer(server));

  assert.equal(server.dashboard.dataRoot, dataDir);
  const response = await request(server, { path: '/api/dashboard' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.records_count, 0);
  assert.equal(response.json.settings.budgets.daily_eur, null);
  assert.equal(response.json.settings.budgets.monthly_eur, null);
});

test('rejects untrusted hosts, cross-origin writes, and bad CSRF tokens', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture.server));
  const settings = JSON.stringify(DEFAULT_SETTINGS);

  const invalidHost = await request(fixture.server, {
    path: '/api/dashboard',
    headers: { Host: 'example.com' },
  });
  assert.equal(invalidHost.statusCode, 403);

  const crossOrigin = await request(fixture.server, {
    method: 'PUT',
    path: '/api/settings',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://example.com',
      'X-Codex-CSRF-Token': 'test-csrf-token',
    },
    body: settings,
  });
  assert.equal(crossOrigin.statusCode, 403);

  const badToken = await request(fixture.server, {
    method: 'PUT',
    path: '/api/settings',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://${fixture.host}`,
      'X-Codex-CSRF-Token': 'wrong',
    },
    body: settings,
  });
  assert.equal(badToken.statusCode, 403);
});

test('updates settings only with JSON, a same-origin Origin, and CSRF', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture.server));
  const updated = {
    schema: 1,
    timezone: 'Europe/Berlin',
    budgets: {
      daily_eur: 3.5,
      monthly_eur: 40,
      warning_thresholds_percent: [50, 80, 100],
    },
    notifications: {
      windows: true,
    },
    hook: {
      message_format: 'detailed',
    },
  };
  const writeHeaders = {
    Origin: `http://${fixture.host}`,
    'X-Codex-CSRF-Token': 'test-csrf-token',
  };

  const wrongType = await request(fixture.server, {
    method: 'PUT',
    path: '/api/settings',
    headers: {
      ...writeHeaders,
      'Content-Type': 'text/plain',
    },
    body: JSON.stringify(updated),
  });
  assert.equal(wrongType.statusCode, 415);

  const malformed = await request(fixture.server, {
    method: 'PUT',
    path: '/api/settings',
    headers: {
      ...writeHeaders,
      'Content-Type': 'application/json',
    },
    body: '{',
  });
  assert.equal(malformed.statusCode, 400);

  const saved = await request(fixture.server, {
    method: 'PUT',
    path: '/api/settings',
    headers: {
      ...writeHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(updated),
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json.saved, true);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(fixture.dataDir, 'settings.json'), 'utf8'),
    ),
    updated,
  );

  const refreshed = await request(fixture.server, {
    path: '/api/dashboard',
  });
  assert.equal(refreshed.json.settings.budgets.daily_eur, 3.5);
  assert.equal(refreshed.json.settings.hook.message_format, 'detailed');
});

test('returns normalized settings diagnostics to the browser after PUT', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-dashboard-settings-'));
  const server = createDashboardServer({
    dataDir,
    nowMs: Date.parse('2026-08-20T12:00:00.000Z'),
    csrfToken: 'settings-diagnostics-token',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => stopServer(server));
  const host = `127.0.0.1:${server.address().port}`;

  const response = await request(server, {
    method: 'PUT',
    path: '/api/settings',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://${host}`,
      'X-Codex-CSRF-Token': 'settings-diagnostics-token',
    },
    body: JSON.stringify({
      schema: 1,
      timezone: 'Not/A-Timezone',
      budgets: {
        daily_eur: -1,
        monthly_eur: 'invalid',
        warning_thresholds_percent: [0, 80, 101],
      },
      notifications: { windows: 'yes' },
      hook: { message_format: 'verbose' },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.saved, true);
  assert.ok(response.json.diagnostics.length >= 5);
  assert.equal(response.json.settings.timezone, 'Europe/Berlin');
  assert.equal(response.json.settings.budgets.daily_eur, null);
  assert.equal(response.json.settings.budgets.monthly_eur, null);
  assert.deepEqual(
    response.json.settings.budgets.warning_thresholds_percent,
    [80],
  );
  assert.equal(response.json.settings.notifications.windows, false);
  assert.equal(response.json.settings.hook.message_format, 'compact');
});

test('enforces the 16 KiB JSON limit and preserves newer settings schemas', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture.server));
  const headers = {
    'Content-Type': 'application/json',
    Origin: `http://${fixture.host}`,
    'X-Codex-CSRF-Token': 'test-csrf-token',
  };

  const oversized = await request(fixture.server, {
    method: 'PUT',
    path: '/api/settings',
    headers,
    body: JSON.stringify({ padding: 'x'.repeat(17 * 1024) }),
  });
  assert.equal(oversized.statusCode, 413);

  const unsupported = await request(fixture.server, {
    method: 'PUT',
    path: '/api/settings',
    headers,
    body: JSON.stringify({ ...DEFAULT_SETTINGS, schema: 2 }),
  });
  assert.equal(unsupported.statusCode, 409);
  assert.equal(unsupported.json.saved, false);
  assert.equal(unsupported.json.reason, 'unsupported-schema');
});

test('uses a fixed route allowlist and never serves traversal paths', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture.server));

  for (const unsafePath of [
    '/../scripts/turn-cost.js',
    '/..%2fscripts%2fturn-cost.js',
    '/dashboard.js',
    '/index.html',
  ]) {
    const response = await request(fixture.server, { path: unsafePath });
    assert.equal(response.statusCode, 404, unsafePath);
    assert.doesNotMatch(response.body, /PRICE_PER_MILLION/);
  }

  const method = await request(fixture.server, {
    method: 'POST',
    path: '/api/dashboard',
  });
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.allow, 'GET');

  const eventMethod = await request(fixture.server, {
    method: 'POST',
    path: '/api/events',
  });
  assert.equal(eventMethod.statusCode, 405);
  assert.equal(eventMethod.headers.allow, 'GET');
});

test('browser code uses safe DOM sinks for ledger-derived values', () => {
  const source = fs.readFileSync(path.join(dashboardRoot, 'app.js'), 'utf8');
  assert.doesNotMatch(
    source,
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/,
  );
  assert.doesNotMatch(source, /fetch\(\s*['"]https?:/);
  assert.match(source, /\.textContent\s*=/);
  assert.match(source, /if \(data\.complete === false && !lowerBound\)/);
  assert.match(source, /Showing a known minimum/);
  assert.match(source, /no partial totals are shown/);
  assert.match(source, /function localDateTime\(value, timeZone\)/);
  assert.match(
    source,
    /renderRecent\(data\.recent_turns \?\? \[\], data\.timezone\)/,
  );
  assert.match(source, /function optionalPercentage\(value\)/);
  assert.match(source, /Saved with adjustments:/);
  assert.match(source, /fillSettingsForm\(currentSettings\)/);
  assert.match(source, /new EventSource\(['"]\/api\/events['"]\)/);
  assert.match(
    source,
    /addEventListener\(['"]dashboard['"], scheduleLiveReload\)/,
  );
  assert.match(source, /['"]\/api\/dashboard\?refresh=1['"]/);
  assert.match(
    source,
    /if \(options\.source === ['"]live['"]\) \{\s*pendingRevision = ['"]['"];/,
  );
});

test('a failed live reload does not suppress retrying the same revision', async () => {
  const source = fs.readFileSync(path.join(dashboardRoot, 'app.js'), 'utf8');
  const loadStart = source.indexOf('async function loadDashboard(options = {})');
  const loadEnd = source.indexOf('\nasync function saveSettings', loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  const loadFunction = source.slice(loadStart, loadEnd);
  const result = await vm.runInNewContext(
    `
      let dashboardRequest = null;
      let dashboardReloadQueued = false;
      let dashboardReloadForce = false;
      let liveEvents = null;
      let pendingRevision = 'payload-7';
      const elements = { refreshButton: { disabled: false } };
      const fetch = async () => { throw new Error('temporary failure'); };
      const setStatus = () => {};
      const setLiveStatus = () => {};
      const renderDashboard = () => {};
      ${loadFunction}
      loadDashboard({ quiet: true, source: 'live' })
        .then(() => pendingRevision);
    `,
    { queueMicrotask },
  );

  assert.equal(result, '');
});
