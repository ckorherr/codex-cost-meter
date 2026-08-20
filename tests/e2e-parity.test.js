'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(
  __dirname,
  '..',
  'plugins',
  'codex-cost-meter',
);
const hookPath = path.join(pluginRoot, 'scripts', 'turn-cost.js');
const {
  createDashboardServer,
} = require(path.join(pluginRoot, 'scripts', 'dashboard.js'));
const {
  renderDashboardFragment,
} = require(path.join(pluginRoot, 'scripts', 'render-dashboard-fragment.js'));
const runtimeData = require(path.join(pluginRoot, 'lib', 'runtime-data.js'));

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function line(milliseconds, type, payload) {
  return JSON.stringify({ timestamp: iso(milliseconds), type, payload });
}

function usage(input, cached, writes, output) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: writes,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function addUsage(left, right) {
  return Object.fromEntries(
    Object.keys(left).map((key) => [key, left[key] + right[key]]),
  );
}

function accountingUsage(value) {
  return {
    input_tokens: value.input_tokens,
    cached_input_tokens: value.cached_input_tokens,
    cache_write_input_tokens: value.cache_write_input_tokens,
    output_tokens: value.output_tokens,
    reasoning_output_tokens: value.reasoning_output_tokens,
    total_tokens: value.total_tokens,
  };
}

function sessionMeta(milliseconds, id, sessionId, parentThreadId = null) {
  return line(milliseconds, 'session_meta', {
    id,
    session_id: sessionId,
    timestamp: iso(milliseconds),
    source: parentThreadId
      ? {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: 1,
              agent_path: `/root/${id}`,
            },
          },
        }
      : 'vscode',
    thread_source: parentThreadId ? 'subagent' : 'user',
  });
}

function taskStarted(milliseconds, turnId) {
  return line(milliseconds, 'event_msg', {
    type: 'task_started',
    turn_id: turnId,
    started_at: Math.floor(milliseconds / 1000),
    model_context_window: 258_400,
  });
}

function taskComplete(milliseconds, turnId) {
  return line(milliseconds, 'event_msg', {
    type: 'task_complete',
    turn_id: turnId,
  });
}

function turnContext(milliseconds, turnId) {
  return line(milliseconds, 'turn_context', {
    turn_id: turnId,
    model: 'gpt-5.6-sol',
  });
}

function tokenRecord(milliseconds, total, last) {
  return line(milliseconds, 'event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: total,
      last_token_usage: last,
      model_context_window: 258_400,
    },
  });
}

function childStarted(milliseconds, childThreadId) {
  return line(milliseconds, 'event_msg', {
    type: 'sub_agent_activity',
    event_id: `started-${childThreadId}`,
    occurred_at_ms: milliseconds,
    agent_thread_id: childThreadId,
    agent_path: `/root/${childThreadId}`,
    kind: 'started',
  });
}

function writeRollout(directory, id, lines) {
  const filePath = path.join(directory, `rollout-${id}.jsonl`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

function requestJson(server, requestPath) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port: address.port,
        path: requestPath,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve({
              statusCode: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
  });
}

test('Stop hook, dashboard API, and in-chat fragment share exact accounting', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-parity-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const dataRoot = path.join(fixtureRoot, 'plugin-data');
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const now = '2026-08-20T12:00:00.000Z';
  const startedAt = Date.parse('2026-08-20T10:00:00.000Z');
  const rootId = 'parity-root';
  const childId = 'parity-child';
  const rootTurn = 'parity-root-turn';
  const childTurn = 'parity-child-turn';
  const rootUsage = usage(1_000, 400, 100, 100);
  const childUsage = usage(500, 200, 50, 40);
  const expectedUsage = addUsage(rootUsage, childUsage);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(startedAt, rootId, rootId),
    taskStarted(startedAt, rootTurn),
    turnContext(startedAt + 10, rootTurn),
    tokenRecord(startedAt + 100, rootUsage, rootUsage),
    childStarted(startedAt + 1_000, childId),
    taskComplete(startedAt + 10_000, rootTurn),
  ]);
  writeRollout(sessionsDay, childId, [
    sessionMeta(startedAt + 1_000, childId, rootId, rootId),
    taskStarted(startedAt, rootTurn),
    turnContext(startedAt + 10, rootTurn),
    tokenRecord(startedAt + 100, rootUsage, rootUsage),
    taskStarted(startedAt + 1_000, childTurn),
    turnContext(startedAt + 1_010, childTurn),
    tokenRecord(
      startedAt + 2_000,
      addUsage(rootUsage, childUsage),
      childUsage,
    ),
    taskComplete(startedAt + 9_000, childTurn),
  ]);

  const hook = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: rootId,
      turn_id: rootTurn,
      transcript_path: rootPath,
      model: 'gpt-5.6-sol',
      hook_event_name: 'Stop',
    }),
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PLUGIN_DATA: dataRoot,
      CODEX_TURN_COST_NOW: now,
      CODEX_TURN_COST_DISABLE_NOTIFICATIONS: '1',
    },
  });
  assert.equal(hook.status, 0, hook.stderr);
  const hookMessage = JSON.parse(hook.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );

  const server = createDashboardServer({
    dataDir: dataRoot,
    nowMs: Date.parse(now),
    csrfToken: 'parity-csrf',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const response = await requestJson(server, '/api/dashboard');
  assert.equal(response.statusCode, 200);
  const dashboard = response.body;
  assert.equal(dashboard.complete, true);
  assert.equal(dashboard.today.cost_eur_nanos, 8_268_750);
  assert.equal(dashboard.month.cost_eur_nanos, 8_268_750);
  assert.equal(dashboard.budgets.forecast_eur_nanos, 12_816_563);
  assert.deepEqual(accountingUsage(dashboard.today.usage), expectedUsage);
  assert.equal(dashboard.by_model.length, 1);
  assert.equal(dashboard.by_model[0].model, 'gpt-5.6-sol');
  assert.equal(dashboard.by_model[0].cost_eur_nanos, 8_268_750);
  assert.deepEqual(
    accountingUsage(dashboard.by_model[0].usage),
    expectedUsage,
  );
  assert.equal(dashboard.by_agent.root.cost_eur_nanos, 5_692_500);
  assert.deepEqual(
    accountingUsage(dashboard.by_agent.root.usage),
    rootUsage,
  );
  assert.equal(dashboard.by_agent.subagent.cost_eur_nanos, 2_576_250);
  assert.deepEqual(
    accountingUsage(dashboard.by_agent.subagent.usage),
    childUsage,
  );
  assert.equal(dashboard.cache.input_tokens, 1_500);
  assert.equal(dashboard.cache.cached_input_tokens, 600);
  assert.equal(dashboard.cache.cache_write_input_tokens, 150);
  assert.equal(dashboard.cache.uncached_input_tokens, 750);
  assert.equal(dashboard.cache.hit_rate_percent, 40);
  assert.equal(dashboard.recent_turns.length, 1);
  assert.equal(dashboard.recent_turns[0].cost_eur_nanos, 8_268_750);
  assert.equal(dashboard.recent_turns[0].agent_threads, 1);
  assert.deepEqual(
    accountingUsage(dashboard.recent_turns[0].usage),
    expectedUsage,
  );
  assert.match(hookMessage, new RegExp(`Today ${dashboard.today.display_cost}`));
  assert.match(hookMessage, new RegExp(`Aug ${dashboard.month.display_cost}`));

  const settings = runtimeData.loadSettings(dataRoot).settings;
  const snapshot = runtimeData.buildSnapshot(dataRoot, {
    settings,
    now,
    fullHistory: true,
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(dashboard.today.usage, {
    ...snapshot.today.usage,
    display_total_tokens: runtimeData.formatTokens(
      snapshot.today.usage.total_tokens,
    ),
  });
  assert.equal(
    dashboard.today.cost_eur_nanos,
    snapshot.today.cost_eur_nanos,
  );
  assert.equal(
    dashboard.month.cost_eur_nanos,
    snapshot.month.cost_eur_nanos,
  );
  assert.equal(
    dashboard.budgets.forecast_eur_nanos,
    snapshot.budgets.forecast_eur_nanos,
  );
  assert.deepEqual(dashboard.by_model[0].usage, {
    ...snapshot.by_model[0].usage,
    display_total_tokens: runtimeData.formatTokens(
      snapshot.by_model[0].usage.total_tokens,
    ),
  });
  assert.equal(
    dashboard.by_model[0].cost_eur_nanos,
    snapshot.by_model[0].cost_eur_nanos,
  );
  assert.equal(
    dashboard.by_agent.root.cost_eur_nanos,
    snapshot.by_agent.root.cost_eur_nanos,
  );
  assert.equal(
    dashboard.by_agent.subagent.cost_eur_nanos,
    snapshot.by_agent.subagent.cost_eur_nanos,
  );
  assert.deepEqual(dashboard.cache, snapshot.cache);
  assert.equal(
    dashboard.recent_turns[0].cost_eur_nanos,
    snapshot.recent_turns[0].cost_eur_nanos,
  );

  const outputPath = path.join(fixtureRoot, 'visualization', 'dashboard.html');
  renderDashboardFragment({
    dataDir: dataRoot,
    outputPath,
    now,
  });
  const fragment = fs.readFileSync(outputPath, 'utf8');
  assert.ok(fragment.includes(dashboard.today.display_cost));
  assert.ok(fragment.includes('1,640 tokens'));
  assert.match(fragment, /gpt-5\.6-sol/);
  assert.match(fragment, /Root agent/);
  assert.match(fragment, /Subagents/);
});
