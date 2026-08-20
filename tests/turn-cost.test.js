'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const hookPath = path.resolve(
  __dirname,
  '..',
  'plugins',
  'codex-cost-meter',
  'scripts',
  'turn-cost.js',
);

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function record(milliseconds, type, payload) {
  return JSON.stringify({ timestamp: iso(milliseconds), type, payload });
}

function usage(input, cached, writes, output, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: writes,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function add(left, right) {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    cache_write_input_tokens:
      left.cache_write_input_tokens + right.cache_write_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens:
      left.reasoning_output_tokens + right.reasoning_output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
  };
}

function tokenRecord(milliseconds, total, last) {
  return record(milliseconds, 'event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: total,
      last_token_usage: last,
      model_context_window: 258400,
    },
  });
}

function sessionMeta(
  milliseconds,
  id,
  sessionId,
  parentThreadId = null,
  forkedFromId = null,
) {
  return record(milliseconds, 'session_meta', {
    id,
    session_id: sessionId,
    ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
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

function taskStarted(milliseconds, id) {
  return record(milliseconds, 'event_msg', {
    type: 'task_started',
    turn_id: id,
    started_at: Math.floor(milliseconds / 1000),
    model_context_window: 258400,
  });
}

function taskComplete(milliseconds, id) {
  return record(milliseconds, 'event_msg', {
    type: 'task_complete',
    turn_id: id,
  });
}

function turnContext(milliseconds, id) {
  return record(milliseconds, 'turn_context', {
    turn_id: id,
    model: 'gpt-5.6-sol',
  });
}

function activity(milliseconds, childId, kind) {
  return record(milliseconds, 'event_msg', {
    type: 'sub_agent_activity',
    event_id: `${kind}-${childId}-${milliseconds}`,
    occurred_at_ms: milliseconds,
    agent_thread_id: childId,
    agent_path: `/root/${childId}`,
    kind,
  });
}

function writeRollout(directory, id, lines) {
  const filePath = path.join(directory, `rollout-test-${id}.jsonl`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

function invoke(
  transcriptPath,
  sessionId,
  turnId,
  debug = true,
  extraEnvironment = {},
) {
  return spawnSync(
    process.execPath,
    [hookPath, ...(debug ? ['--debug-json'] : [])],
    {
      input: JSON.stringify({
        session_id: sessionId,
        turn_id: turnId,
        transcript_path: transcriptPath,
        model: 'gpt-5.6-sol',
        hook_event_name: 'Stop',
      }),
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        CODEX_TURN_COST_NOW: '2026-08-20T12:00:00.000Z',
        CODEX_TURN_COST_TIME_ZONE: 'UTC',
        ...extraEnvironment,
      },
    },
  );
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('aggregates root, child, nested child, duplicates, and follow-up tasks', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-cost-hook-'));
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'root-thread';
  const childId = 'child-thread';
  const grandchildId = 'grandchild-thread';
  const rootTurnOne = 'root-turn-one';
  const rootTurnTwo = 'root-turn-two';
  const childTurnOne = 'child-turn-one';
  const childTurnTwo = 'child-turn-two';
  const grandchildTurn = 'grandchild-turn';

  const rootOne = usage(1000, 400, 100, 100, 30);
  const rootTwo = usage(200, 50, 0, 20, 5);
  const childOne = usage(500, 200, 50, 40, 10);
  const childTwo = usage(300, 100, 50, 30, 8);
  const grandchildOne = usage(300, 100, 50, 30, 8);

  const rootAfterTwo = add(rootOne, rootTwo);
  const childAfterOne = add(rootOne, childOne);
  const childAfterTwo = add(childAfterOne, childTwo);
  const grandchildAfterOne = add(rootOne, grandchildOne);

  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, rootTurnOne),
    turnContext(1_000_010, rootTurnOne),
    tokenRecord(1_000_100, rootOne, rootOne),
    activity(1_001_000, childId, 'started'),
    taskComplete(1_010_000, rootTurnOne),
    taskStarted(2_000_000, rootTurnTwo),
    turnContext(2_000_010, rootTurnTwo),
    tokenRecord(2_000_100, rootAfterTwo, rootTwo),
    activity(2_001_000, childId, 'interacted'),
    taskComplete(2_010_000, rootTurnTwo),
  ]);

  const childPath = writeRollout(sessionsDay, childId, [
    sessionMeta(1_001_000, childId, rootId, rootId),
    taskStarted(1_000_000, rootTurnOne),
    turnContext(1_000_010, rootTurnOne),
    tokenRecord(1_000_100, rootOne, rootOne),
    taskStarted(1_001_000, childTurnOne),
    turnContext(1_001_010, childTurnOne),
    activity(1_001_500, grandchildId, 'started'),
    tokenRecord(1_002_100, childAfterOne, childOne),
    tokenRecord(1_002_101, childAfterOne, childOne),
    record(1_002_102, 'event_msg', { type: 'token_count', info: null }),
    taskComplete(1_010_000, childTurnOne),
    taskStarted(2_001_000, childTurnTwo),
    turnContext(2_001_010, childTurnTwo),
    tokenRecord(2_002_100, childAfterTwo, childTwo),
    taskComplete(2_010_000, childTurnTwo),
  ]);

  writeRollout(sessionsDay, grandchildId, [
    sessionMeta(1_001_500, grandchildId, rootId, childId),
    taskStarted(1_000_000, rootTurnOne),
    turnContext(1_000_010, rootTurnOne),
    tokenRecord(1_000_100, rootOne, rootOne),
    taskStarted(1_001_000, childTurnOne),
    turnContext(1_001_010, childTurnOne),
    taskStarted(1_002_000, grandchildTurn),
    turnContext(1_002_010, grandchildTurn),
    tokenRecord(1_003_100, grandchildAfterOne, grandchildOne),
    taskComplete(1_010_000, grandchildTurn),
  ]);

  const firstTurn = invoke(rootPath, rootId, rootTurnOne);
  assert.equal(firstTurn.status, 0, firstTurn.stderr);
  const firstResult = JSON.parse(firstTurn.stdout);
  assert.equal(firstResult.agentThreads, 2);
  assert.equal(firstResult.turn.usage.total_tokens, 1970);
  assert.equal(firstResult.session.usage.total_tokens, 2520);
  assert.ok(Math.abs(firstResult.turn.cost - 0.0112) < 1e-12);
  assert.ok(Math.abs(firstResult.session.cost - 0.0145875) < 1e-12);
  assert.deepEqual(firstResult.warnings, []);

  const secondTurn = invoke(rootPath, rootId, rootTurnTwo);
  assert.equal(secondTurn.status, 0, secondTurn.stderr);
  const secondResult = JSON.parse(secondTurn.stdout);
  assert.equal(secondResult.turn.usage.total_tokens, 550);
  assert.ok(Math.abs(secondResult.turn.cost - 0.0033875) < 1e-12);

  const subagentStop = invoke(childPath, rootId, childTurnOne, false);
  assert.equal(subagentStop.status, 0, subagentStop.stderr);
  assert.equal(subagentStop.stdout, '');
  assert.equal(
    fs.existsSync(path.join(fixtureRoot, '.codex', 'usage')),
    false,
  );
});

test('does not present partial totals while a child task is still open', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-cost-open-'));
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'root-open';
  const childId = 'child-open';
  const rootTurn = 'root-turn';
  const childTurn = 'child-turn';
  const rootUsage = usage(100, 20, 10, 10);
  const childUsage = usage(50, 10, 5, 5);

  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, rootTurn),
    turnContext(1_000_010, rootTurn),
    tokenRecord(1_000_100, rootUsage, rootUsage),
    activity(1_001_000, childId, 'started'),
    taskComplete(1_010_000, rootTurn),
  ]);

  writeRollout(sessionsDay, childId, [
    sessionMeta(1_001_000, childId, rootId, rootId),
    taskStarted(1_000_000, rootTurn),
    turnContext(1_000_010, rootTurn),
    tokenRecord(1_000_100, rootUsage, rootUsage),
    taskStarted(1_001_000, childTurn),
    turnContext(1_001_010, childTurn),
    tokenRecord(1_002_000, add(rootUsage, childUsage), childUsage),
  ]);

  const invocation = invoke(rootPath, rootId, rootTurn, false);
  assert.equal(invocation.status, 0, invocation.stderr);
  const hookOutput = JSON.parse(invocation.stdout);
  assert.equal(
    hookOutput.systemMessage,
    'Usage unavailable — see hook diagnostics.',
  );
  assert.match(invocation.stderr, /still open/);
  assert.equal(
    fs.existsSync(path.join(fixtureRoot, '.codex', 'usage')),
    false,
  );
});

test('records exact root turns once and totals the current day and month in EUR', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-cost-ledger-'));
  const pluginData = path.join(fixtureRoot, 'plugin-data');
  const environment = { PLUGIN_DATA: pluginData };
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'ledger-root';
  const turnOne = 'ledger-turn-one';
  const turnTwo = 'ledger-turn-two';
  const firstUsage = usage(1000, 400, 100, 100);
  const secondUsage = usage(200, 50, 0, 20);
  const cumulative = add(firstUsage, secondUsage);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, turnOne),
    turnContext(1_000_010, turnOne),
    tokenRecord(1_000_100, firstUsage, firstUsage),
    taskComplete(1_010_000, turnOne),
  ]);

  const first = invoke(rootPath, rootId, turnOne, false, environment);
  assert.equal(first.status, 0, first.stderr);
  const firstMessage = JSON.parse(first.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(firstMessage, /Turn \+ agents 1,100 tok · €0\.00569/);
  assert.match(firstMessage, /Today €0\.00569/);
  assert.match(firstMessage, /Aug €0\.00569/);
  assert.doesNotMatch(firstMessage, /\$/);
  assert.equal((firstMessage.match(/\n/g) ?? []).length, 1);

  const ledgerPath = path.join(
    pluginData,
    'usage',
    '2026-08',
    `${rootId}.jsonl`,
  );
  let records = readJsonl(ledgerPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].turn_id, turnOne);
  assert.equal(records[0].cost_eur_nanos, 5_692_500);
  assert.equal(records[0].eur_per_usd, 0.9);

  const duplicate = invoke(rootPath, rootId, turnOne, false, environment);
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(readJsonl(ledgerPath).length, 1);

  fs.appendFileSync(
    rootPath,
    `${[
      taskStarted(2_000_000, turnTwo),
      turnContext(2_000_010, turnTwo),
      tokenRecord(2_000_100, cumulative, secondUsage),
      taskComplete(2_010_000, turnTwo),
    ].join('\n')}\n`,
    'utf8',
  );

  const second = invoke(rootPath, rootId, turnTwo, false, environment);
  assert.equal(second.status, 0, second.stderr);
  const secondMessage = JSON.parse(second.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(secondMessage, /Turn \+ agents 220 tok · €0\.00124/);
  assert.match(secondMessage, /Today €0\.00693/);
  assert.match(secondMessage, /Aug €0\.00693/);

  records = readJsonl(ledgerPath);
  assert.equal(records.length, 2);
  assert.equal(records[1].turn_id, turnTwo);
  assert.equal(records[1].cost_eur_nanos, 1_237_500);
});

test('forks use their new root id and never rebill inherited history', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-cost-fork-'));
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const sourceId = 'source-root';
  const forkId = 'fork-root';
  const sourceTurn = 'source-turn';
  const forkTurn = 'fork-turn';
  const sourceUsage = usage(1000, 400, 100, 100);
  const forkUsage = usage(300, 100, 50, 30);
  const forkCumulative = add(sourceUsage, forkUsage);

  const sourcePath = writeRollout(sessionsDay, sourceId, [
    sessionMeta(1_000_000, sourceId, sourceId),
    taskStarted(1_000_000, sourceTurn),
    turnContext(1_000_010, sourceTurn),
    tokenRecord(1_000_100, sourceUsage, sourceUsage),
    taskComplete(1_010_000, sourceTurn),
  ]);
  const sourceResult = invoke(sourcePath, sourceId, sourceTurn, false);
  assert.equal(sourceResult.status, 0, sourceResult.stderr);

  const forkPath = writeRollout(sessionsDay, forkId, [
    sessionMeta(2_000_000, forkId, sourceId, null, sourceId),
    sessionMeta(1_000_000, sourceId, sourceId),
    taskStarted(1_000_000, sourceTurn),
    turnContext(1_000_010, sourceTurn),
    tokenRecord(1_000_100, sourceUsage, sourceUsage),
    taskComplete(1_010_000, sourceTurn),
    taskStarted(2_000_000, forkTurn),
    turnContext(2_000_010, forkTurn),
    tokenRecord(2_000_100, forkCumulative, forkUsage),
    taskComplete(2_010_000, forkTurn),
  ]);

  const forkResult = invoke(forkPath, sourceId, forkTurn, false);
  assert.equal(forkResult.status, 0, forkResult.stderr);
  const forkMessage = JSON.parse(forkResult.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(forkMessage, /Turn \+ agents 330 tok · €0\.00181/);
  assert.match(forkMessage, /Session \+ agents 330 tok · €0\.00181/);
  assert.match(forkMessage, /Today €0\.00750/);

  const ledgerDirectory = path.join(
    fixtureRoot,
    '.codex',
    'usage',
    '2026-08',
  );
  const sourceRecords = readJsonl(path.join(ledgerDirectory, `${sourceId}.jsonl`));
  const forkRecords = readJsonl(path.join(ledgerDirectory, `${forkId}.jsonl`));
  assert.equal(sourceRecords.length, 1);
  assert.equal(forkRecords.length, 1);
  assert.equal(forkRecords[0].root_thread_id, forkId);
  assert.equal(forkRecords[0].session_id, sourceId);
  assert.equal(forkRecords[0].turn_id, forkTurn);
  assert.equal(forkRecords[0].usage.total_tokens, 330);
  assert.equal(forkRecords[0].cost_eur_nanos, 1_811_250);
});

test('uses the stable turn completion month when the same Stop is retried', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-cost-month-'));
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '09',
    '01',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'month-root';
  const augustTurn = 'august-turn';
  const septemberTurn = 'september-turn';
  const augustStart = Date.parse('2026-08-31T21:20:00.000Z');
  const augustComplete = Date.parse('2026-08-31T21:30:00.000Z');
  const septemberStart = Date.parse('2026-08-31T22:10:00.000Z');
  const septemberComplete = Date.parse('2026-08-31T22:20:00.000Z');
  const augustUsage = usage(100, 20, 10, 10);
  const septemberUsage = usage(200, 50, 20, 20);
  const cumulative = add(augustUsage, septemberUsage);

  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(augustStart, rootId, rootId),
    taskStarted(augustStart, augustTurn),
    turnContext(augustStart + 10, augustTurn),
    tokenRecord(augustStart + 100, augustUsage, augustUsage),
    taskComplete(augustComplete, augustTurn),
    taskStarted(septemberStart, septemberTurn),
    turnContext(septemberStart + 10, septemberTurn),
    tokenRecord(septemberStart + 100, cumulative, septemberUsage),
    taskComplete(septemberComplete, septemberTurn),
  ]);
  const environment = {
    CODEX_TURN_COST_NOW: '',
    CODEX_TURN_COST_TIME_ZONE: 'Europe/Berlin',
  };

  const first = invoke(rootPath, rootId, augustTurn, false, environment);
  assert.equal(first.status, 0, first.stderr);
  const second = invoke(rootPath, rootId, septemberTurn, false, environment);
  assert.equal(second.status, 0, second.stderr);
  const duplicate = invoke(rootPath, rootId, augustTurn, false, environment);
  assert.equal(duplicate.status, 0, duplicate.stderr);

  const usageRoot = path.join(fixtureRoot, '.codex', 'usage');
  const augustRecords = readJsonl(
    path.join(usageRoot, '2026-08', `${rootId}.jsonl`),
  );
  const septemberRecords = readJsonl(
    path.join(usageRoot, '2026-09', `${rootId}.jsonl`),
  );
  assert.equal(augustRecords.length, 1);
  assert.equal(augustRecords[0].turn_id, augustTurn);
  assert.equal(augustRecords[0].local_date, '2026-08-31');
  assert.equal(septemberRecords.length, 1);
  assert.equal(septemberRecords[0].turn_id, septemberTurn);
  assert.equal(septemberRecords[0].local_date, '2026-09-01');
});
