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
const {
  analyze,
} = require('../plugins/codex-cost-meter/scripts/turn-cost');
const INITIAL_TEST_COLD_WINDOW_BYTES = 600 * 1024;

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

function malformedTokenRecord(milliseconds) {
  return record(milliseconds, 'event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: {
        ...usage(200, 20, 10, 20),
        input_tokens: '200',
      },
      last_token_usage: usage(100, 10, 5, 10),
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

function turnContext(milliseconds, id, model = 'gpt-5.6-sol') {
  return record(milliseconds, 'turn_context', {
    turn_id: id,
    model,
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

function readLedgerForRoot(usageRoot, month, rootThreadId) {
  const monthDirectory = path.join(usageRoot, month);
  return fs
    .readdirSync(monthDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .flatMap((entry) => readJsonl(path.join(monthDirectory, entry.name)))
    .filter((record) => record.root_thread_id === rootThreadId);
}

function defaultUsageRoot(fixtureRoot) {
  return path.join(
    fixtureRoot,
    '.codex',
    'plugins',
    'data',
    'codex-cost-meter-cost-meter',
    'usage',
  );
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
  assert.ok(Math.abs(firstResult.turn.cost - 0.0112) < 1e-12);
  assert.equal(firstResult.sessionComplete, false);
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

test('maps same-second same-thread activities to distinct child tasks', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-same-second-child-'),
  );
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'same-second-root';
  const childId = 'same-second-child';
  const rootTurn = 'same-second-root-turn';
  const childTurnOne = 'same-second-child-one';
  const childTurnTwo = 'same-second-child-two';
  const rootUsage = usage(100, 20, 10, 10);
  const childOne = usage(50, 10, 5, 5);
  const childTwo = usage(70, 20, 5, 7);
  const afterChildOne = add(rootUsage, childOne);
  const afterChildTwo = add(afterChildOne, childTwo);

  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(2_000_000, rootId, rootId),
    taskStarted(2_000_000, rootTurn),
    turnContext(2_000_010, rootTurn),
    tokenRecord(2_000_100, rootUsage, rootUsage),
    activity(2_000_200, childId, 'started'),
    activity(2_000_600, childId, 'interacted'),
    taskComplete(2_000_900, rootTurn),
  ]);
  writeRollout(sessionsDay, childId, [
    sessionMeta(2_000_200, childId, rootId, rootId),
    taskStarted(2_000_000, rootTurn),
    turnContext(2_000_010, rootTurn),
    tokenRecord(2_000_100, rootUsage, rootUsage),
    taskStarted(2_000_200, childTurnOne),
    turnContext(2_000_210, childTurnOne),
    tokenRecord(2_000_300, afterChildOne, childOne),
    taskComplete(2_000_500, childTurnOne),
    taskStarted(2_000_600, childTurnTwo),
    turnContext(2_000_610, childTurnTwo),
    tokenRecord(2_000_700, afterChildTwo, childTwo),
    taskComplete(2_000_800, childTurnTwo),
  ]);

  const invocation = invoke(rootPath, rootId, rootTurn);
  assert.equal(invocation.status, 0, invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  assert.equal(result.turnComplete, true);
  assert.equal(result.turnAgentThreads, 1);
  assert.equal(
    result.turn.usage.total_tokens,
    rootUsage.total_tokens +
      childOne.total_tokens +
      childTwo.total_tokens,
  );
  assert.deepEqual(result.warnings, []);
});

test('does not reuse a stale open child task for a later interaction', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-stale-child-'),
  );
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'stale-child-root';
  const childId = 'stale-child-thread';
  const oldRootTurn = 'stale-old-root-turn';
  const currentRootTurn = 'stale-current-root-turn';
  const staleChildTurn = 'stale-open-child-turn';
  const oldRootUsage = usage(1_000, 400, 100, 100);
  const staleChildUsage = usage(500, 200, 50, 50);
  const currentRootUsage = usage(200, 50, 10, 20);
  const rootCumulative = add(oldRootUsage, currentRootUsage);

  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, oldRootTurn),
    turnContext(1_000_010, oldRootTurn),
    tokenRecord(1_000_100, oldRootUsage, oldRootUsage),
    activity(1_000_200, childId, 'started'),
    taskComplete(1_000_500, oldRootTurn),
    taskStarted(2_000_000, currentRootTurn),
    turnContext(2_000_010, currentRootTurn),
    tokenRecord(2_000_100, rootCumulative, currentRootUsage),
    activity(2_000_200, childId, 'interacted'),
    activity(2_000_300, childId, 'interrupted'),
    taskComplete(2_000_500, currentRootTurn),
  ]);
  writeRollout(sessionsDay, childId, [
    sessionMeta(1_000_200, childId, rootId, rootId),
    taskStarted(1_000_000, oldRootTurn),
    turnContext(1_000_010, oldRootTurn),
    tokenRecord(1_000_100, oldRootUsage, oldRootUsage),
    taskStarted(1_000_200, staleChildTurn),
    turnContext(1_000_210, staleChildTurn),
    tokenRecord(
      1_000_300,
      add(oldRootUsage, staleChildUsage),
      staleChildUsage,
    ),
  ]);

  const invocation = invoke(rootPath, rootId, currentRootTurn);
  assert.equal(invocation.status, 0, invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  assert.equal(result.turnComplete, false);
  assert.equal(
    result.turn.usage.total_tokens,
    currentRootUsage.total_tokens,
  );
  assert.equal(result.turnAgentThreads, 0);
  assert.match(result.warnings.join('\n'), /branch point/);
});

test('keeps a legitimate started and interacted activity on one open child task', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-open-child-reuse-'),
  );
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'open-child-reuse-root';
  const childId = 'open-child-reuse-thread';
  const rootTurn = 'open-child-reuse-root-turn';
  const childTurn = 'open-child-reuse-child-turn';
  const rootUsage = usage(100, 20, 10, 10);
  const childUsage = usage(50, 10, 5, 5);

  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(2_000_000, rootId, rootId),
    taskStarted(2_000_000, rootTurn),
    turnContext(2_000_010, rootTurn),
    tokenRecord(2_000_100, rootUsage, rootUsage),
    activity(2_000_200, childId, 'started'),
    activity(2_000_400, childId, 'interacted'),
    activity(2_000_800, childId, 'interrupted'),
    taskComplete(2_000_900, rootTurn),
  ]);
  writeRollout(sessionsDay, childId, [
    sessionMeta(2_000_200, childId, rootId, rootId),
    taskStarted(2_000_000, rootTurn),
    turnContext(2_000_010, rootTurn),
    tokenRecord(2_000_100, rootUsage, rootUsage),
    taskStarted(2_000_200, childTurn),
    turnContext(2_000_210, childTurn),
    tokenRecord(
      2_000_500,
      add(rootUsage, childUsage),
      childUsage,
    ),
  ]);

  const invocation = invoke(rootPath, rootId, rootTurn);
  assert.equal(invocation.status, 0, invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  assert.equal(result.turnComplete, true);
  assert.equal(
    result.turn.usage.total_tokens,
    rootUsage.total_tokens + childUsage.total_tokens,
  );
  assert.deepEqual(result.warnings, []);
});

test('cold child analysis expands when visible task reuse is ambiguous', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-cold-child-reuse-'),
  );
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'cold-child-reuse-root';
  const childId = 'cold-child-reuse-thread';
  const rootTurn = 'cold-child-reuse-root-turn';
  const childTurnOne = 'cold-child-reuse-one';
  const childTurnTwo = 'cold-child-reuse-two';
  const rootUsage = usage(100, 20, 10, 10);
  const childOne = usage(1_000, 200, 100, 100);
  const childTwo = usage(50, 10, 5, 5);
  const afterChildOne = add(rootUsage, childOne);
  const afterChildTwo = add(afterChildOne, childTwo);

  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(2_000_000, rootId, rootId),
    taskStarted(2_000_000, rootTurn),
    turnContext(2_000_010, rootTurn),
    tokenRecord(2_000_100, rootUsage, rootUsage),
    activity(2_000_200, childId, 'started'),
    activity(2_005_000, childId, 'interacted'),
    activity(2_005_500, childId, 'interrupted'),
    taskComplete(2_005_900, rootTurn),
  ]);
  writeRollout(sessionsDay, childId, [
    sessionMeta(2_000_200, childId, rootId, rootId),
    taskStarted(2_000_000, rootTurn),
    turnContext(2_000_010, rootTurn),
    tokenRecord(2_000_100, rootUsage, rootUsage),
    taskStarted(2_000_200, childTurnOne),
    turnContext(2_000_210, childTurnOne),
    tokenRecord(2_000_300, afterChildOne, childOne),
    taskComplete(2_001_000, childTurnOne),
    record(2_001_100, 'event_msg', {
      type: 'historical_padding',
      value: 'x'.repeat(700 * 1024),
    }),
    taskStarted(2_005_000, childTurnTwo),
    turnContext(2_005_010, childTurnTwo),
    tokenRecord(2_005_100, afterChildTwo, childTwo),
  ]);

  const invocation = invoke(rootPath, rootId, rootTurn);
  assert.equal(invocation.status, 0, invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  assert.equal(result.turnComplete, true);
  assert.equal(
    result.turn.usage.total_tokens,
    rootUsage.total_tokens +
      childOne.total_tokens +
      childTwo.total_tokens,
  );
  assert.deepEqual(result.warnings, []);
});

test('cold current-turn analysis ignores unrelated historical rollouts', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-targeted-cold-'),
  );
  const sessionsRoot = path.join(fixtureRoot, '.codex', 'sessions');
  const sessionsDay = path.join(sessionsRoot, '2026', '08', '20');
  const pluginData = path.join(fixtureRoot, 'analysis-plugin-data');
  const normalPluginData = path.join(fixtureRoot, 'normal-plugin-data');
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'targeted-root';
  const oldChildId = 'historical-child';
  const currentChildId = 'current-child';
  const oldTurn = 'historical-root-turn';
  const currentTurn = 'current-root-turn';
  const currentChildTurn = 'current-child-turn';
  const oldUsage = usage(10_000, 4_000, 1_000, 1_000);
  const rootUsage = usage(200, 50, 10, 20);
  const childUsage = usage(100, 25, 5, 10);
  const rootCumulative = add(oldUsage, rootUsage);
  const childCumulative = add(rootCumulative, childUsage);

  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, oldTurn),
    turnContext(1_000_010, oldTurn),
    tokenRecord(1_000_100, oldUsage, oldUsage),
    activity(1_000_200, oldChildId, 'started'),
    taskComplete(1_000_300, oldTurn),
    taskStarted(2_000_000, currentTurn),
    turnContext(2_000_010, currentTurn),
    tokenRecord(2_000_100, rootCumulative, rootUsage),
    activity(2_000_200, currentChildId, 'started'),
    taskComplete(2_000_300, currentTurn),
  ]);
  const childPath = writeRollout(sessionsDay, currentChildId, [
    sessionMeta(2_000_200, currentChildId, rootId, rootId),
    taskStarted(2_000_000, currentTurn),
    turnContext(2_000_010, currentTurn),
    tokenRecord(2_000_100, rootCumulative, rootUsage),
    taskStarted(2_000_200, currentChildTurn),
    turnContext(2_000_210, currentChildTurn),
    tokenRecord(2_000_250, childCumulative, childUsage),
    taskComplete(2_000_290, currentChildTurn),
  ]);
  for (let index = 0; index < 250; index += 1) {
    writeRollout(
      sessionsDay,
      `unrelated-${String(index).padStart(3, '0')}`,
      [
        sessionMeta(
          500_000 + index,
          `unrelated-${index}`,
          `unrelated-${index}`,
        ),
        taskStarted(500_100 + index, `unrelated-turn-${index}`),
      ],
    );
  }

  const originalOpenSync = fs.openSync;
  const openedRollouts = [];
  const sessionsPrefix = `${path.resolve(sessionsRoot)}${path.sep}`;
  fs.openSync = function patchedOpenSync(filePath, flags, ...rest) {
    if (
      flags === 'r' &&
      typeof filePath === 'string' &&
      path.resolve(filePath).startsWith(sessionsPrefix) &&
      filePath.endsWith('.jsonl')
    ) {
      openedRollouts.push(path.resolve(filePath));
    }
    return originalOpenSync.call(this, filePath, flags, ...rest);
  };
  const previousPluginData = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = pluginData;
  let result;
  try {
    result = analyze({
      session_id: rootId,
      turn_id: currentTurn,
      transcript_path: rootPath,
      model: 'gpt-5.6-sol',
      hook_event_name: 'Stop',
    });
  } finally {
    fs.openSync = originalOpenSync;
    if (previousPluginData === undefined) {
      delete process.env.PLUGIN_DATA;
    } else {
      process.env.PLUGIN_DATA = previousPluginData;
    }
  }

  assert.equal(result.turnComplete, true);
  assert.equal(result.warming, false);
  assert.equal(
    result.turn.usage.total_tokens,
    rootUsage.total_tokens + childUsage.total_tokens,
  );
  assert.deepEqual(
    [...new Set(openedRollouts)].sort(),
    [path.resolve(childPath), path.resolve(rootPath)].sort(),
  );
  assert.equal(
    openedRollouts.some((filePath) =>
      path.basename(filePath).includes('historical-child'),
    ),
    false,
  );

  const coldInvocation = invoke(rootPath, rootId, currentTurn, false, {
    PLUGIN_DATA: normalPluginData,
  });
  assert.equal(coldInvocation.status, 0, coldInvocation.stderr);
  assert.equal(coldInvocation.stderr, '');
  const coldMessage = JSON.parse(coldInvocation.stdout).systemMessage
    .replaceAll('\u00a0', ' ');
  assert.match(coldMessage, /Turn \+ agents 330 tok · €0\.00187/);
  assert.match(coldMessage, /Session \+ agents 330 tok · €0\.00187/);
  assert.doesNotMatch(coldMessage, /warming|unavailable/i);
});

test('cold analysis reads bounded tails of a large root and reused child', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-bounded-cold-'),
  );
  const sessionsRoot = path.join(fixtureRoot, '.codex', 'sessions');
  const sessionsDay = path.join(sessionsRoot, '2026', '08', '20');
  const pluginData = path.join(fixtureRoot, 'plugin-data');
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'bounded-root';
  const childId = 'bounded-reused-child';
  const oldTurn = 'bounded-old-root-turn';
  const currentTurn = 'bounded-current-root-turn';
  const oldChildTurn = 'bounded-old-child-turn';
  const currentChildTurn = 'bounded-current-child-turn';
  const oldRootUsage = usage(10_000, 4_000, 1_000, 1_000);
  const oldChildUsage = usage(5_000, 2_000, 500, 500);
  const rootUsage = usage(200, 50, 10, 20);
  const childUsage = usage(100, 25, 5, 10);
  const afterOldChild = add(oldRootUsage, oldChildUsage);
  const afterCurrentRoot = add(afterOldChild, rootUsage);
  const afterCurrentChild = add(afterCurrentRoot, childUsage);
  const historicalPayload = 'x'.repeat(8 * 1024 * 1024);

  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, oldTurn),
    turnContext(1_000_010, oldTurn),
    tokenRecord(1_000_100, oldRootUsage, oldRootUsage),
    activity(1_000_200, childId, 'started'),
    taskComplete(1_000_300, oldTurn),
    record(1_500_000, 'response_item', {
      type: 'tool_output',
      output: historicalPayload,
    }),
    taskStarted(2_000_000, currentTurn),
    turnContext(2_000_010, currentTurn),
    tokenRecord(2_000_100, afterCurrentRoot, rootUsage),
    activity(2_000_200, childId, 'interacted'),
    taskComplete(2_000_500, currentTurn),
  ]);
  const childPath = writeRollout(sessionsDay, childId, [
    sessionMeta(1_000_200, childId, rootId, rootId),
    taskStarted(1_000_000, oldTurn),
    turnContext(1_000_010, oldTurn),
    tokenRecord(1_000_100, oldRootUsage, oldRootUsage),
    taskStarted(1_000_200, oldChildTurn),
    turnContext(1_000_210, oldChildTurn),
    tokenRecord(1_000_250, afterOldChild, oldChildUsage),
    taskComplete(1_000_290, oldChildTurn),
    record(1_500_000, 'response_item', {
      type: 'tool_output',
      output: historicalPayload,
    }),
    taskStarted(2_000_000, currentTurn),
    turnContext(2_000_010, currentTurn),
    tokenRecord(2_000_100, afterCurrentRoot, rootUsage),
    taskStarted(2_000_200, currentChildTurn),
    turnContext(2_000_210, currentChildTurn),
    tokenRecord(2_000_300, afterCurrentChild, childUsage),
    taskComplete(2_000_400, currentChildTurn),
  ]);

  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;
  const descriptors = new Map();
  const explicitReads = [];
  const targetPaths = new Set([
    path.resolve(rootPath),
    path.resolve(childPath),
  ]);
  fs.openSync = function patchedOpenSync(filePath, flags, ...rest) {
    const descriptor = originalOpenSync.call(this, filePath, flags, ...rest);
    if (
      flags === 'r' &&
      typeof filePath === 'string' &&
      targetPaths.has(path.resolve(filePath))
    ) {
      descriptors.set(descriptor, path.resolve(filePath));
    }
    return descriptor;
  };
  fs.readSync = function patchedReadSync(
    descriptor,
    buffer,
    offset,
    length,
    position,
  ) {
    const bytesRead = originalReadSync.call(
      this,
      descriptor,
      buffer,
      offset,
      length,
      position,
    );
    if (descriptors.has(descriptor) && position !== null) {
      explicitReads.push({
        filePath: descriptors.get(descriptor),
        position,
        bytesRead,
      });
    }
    return bytesRead;
  };
  fs.closeSync = function patchedCloseSync(descriptor) {
    descriptors.delete(descriptor);
    return originalCloseSync.call(this, descriptor);
  };

  const previousPluginData = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = pluginData;
  let result;
  try {
    result = analyze({
      session_id: rootId,
      turn_id: currentTurn,
      transcript_path: rootPath,
      model: 'gpt-5.6-sol',
      hook_event_name: 'Stop',
    });
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.closeSync = originalCloseSync;
    if (previousPluginData === undefined) {
      delete process.env.PLUGIN_DATA;
    } else {
      process.env.PLUGIN_DATA = previousPluginData;
    }
  }

  assert.equal(result.turnComplete, true);
  assert.equal(
    result.turn.usage.total_tokens,
    rootUsage.total_tokens + childUsage.total_tokens,
  );
  for (const filePath of targetPaths) {
    const reads = explicitReads.filter(
      (read) => read.filePath === filePath,
    );
    assert.ok(reads.length > 0);
    assert.ok(
      reads.reduce((total, read) => total + read.bytesRead, 0) <=
        INITIAL_TEST_COLD_WINDOW_BYTES,
    );
    assert.ok(
      Math.min(...reads.map((read) => read.position)) >
        fs.statSync(filePath).size - INITIAL_TEST_COLD_WINDOW_BYTES,
    );
  }
});

test('cold analysis does not mark an uninferable token baseline exact', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-cold-reset-'),
  );
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'cold-reset-root';
  const oldTurn = 'cold-reset-old-turn';
  const currentTurn = 'cold-reset-current-turn';
  const priorTotal = usage(500, 0, 0, 50);
  const resetTotal = usage(100, 0, 0, 10);
  const resetLast = usage(200, 0, 0, 20);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, oldTurn),
    turnContext(1_000_010, oldTurn),
    tokenRecord(1_000_100, priorTotal, priorTotal),
    taskComplete(1_000_200, oldTurn),
    record(1_000_300, 'event_msg', {
      type: 'historical_padding',
      value: 'x'.repeat(700 * 1024),
    }),
    taskStarted(2_000_000, currentTurn),
    turnContext(2_000_010, currentTurn),
    tokenRecord(2_000_100, resetTotal, resetLast),
    taskComplete(2_000_200, currentTurn),
  ]);

  const invocation = invoke(rootPath, rootId, currentTurn);
  assert.equal(invocation.status, 0, invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  assert.equal(result.turnComplete, false);
  assert.equal(result.turn.usage.total_tokens, resetLast.total_tokens);
  assert.match(result.warnings.join('\n'), /Token counter reset/);
});

test('prices the current turn without revisiting an earlier unpriced turn', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-mixed-pricing-'),
  );
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'mixed-pricing-root';
  const unknownTurn = 'unknown-turn';
  const knownTurn = 'known-turn';
  const unknownUsage = usage(100, 0, 0, 10);
  const knownUsage = usage(200, 50, 0, 20);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, unknownTurn),
    turnContext(1_000_010, unknownTurn, 'future-model'),
    tokenRecord(1_000_100, unknownUsage, unknownUsage),
    taskComplete(1_010_000, unknownTurn),
    taskStarted(2_000_000, knownTurn),
    turnContext(2_000_010, knownTurn),
    tokenRecord(
      2_000_100,
      add(unknownUsage, knownUsage),
      knownUsage,
    ),
    taskComplete(2_010_000, knownTurn),
  ]);

  const invocation = invoke(rootPath, rootId, knownTurn);
  assert.equal(invocation.status, 0, invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  assert.equal(result.turnPriced, true);
  assert.equal(result.sessionPriced, false);
  assert.equal(result.priced, true);
  assert.equal(result.turn.usage.total_tokens, knownUsage.total_tokens);
  assert.ok(result.turn.cost > 0);
  assert.doesNotMatch(result.warnings.join('\n'), /future-model/);
});

test('reconciles a known lower-bound gap exactly once after child completion', () => {
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

  const childPath = writeRollout(sessionsDay, childId, [
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
  const message = JSON.parse(invocation.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(message, /Turn \+ agents ≥165 tok · ≥€0\.00098/);
  assert.match(
    message,
    /Session \+ agents ≥165 tok · ≥€0\.00098 · 1 pending/,
  );
  assert.match(message, /Today ≥€0\.00098 · 1 pending/);
  assert.match(message, /Aug ≥€0\.00098 · 1 pending/);
  assert.match(invocation.stderr, /still open/);
  const entries = readLedgerForRoot(
    defaultUsageRoot(fixtureRoot),
    '2026-08',
    rootId,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry_type, 'gap');
  assert.equal(entries[0].reason, 'history_incomplete');
  assert.equal(entries[0].usage, undefined);
  assert.equal(entries[0].known_usage.total_tokens, 165);
  assert.equal(entries[0].known_cost_eur_nanos, 975_375);

  fs.appendFileSync(
    childPath,
    `${taskComplete(1_002_100, childTurn)}\n`,
    'utf8',
  );
  const exact = invoke(rootPath, rootId, rootTurn, false);
  assert.equal(exact.status, 0, exact.stderr);
  const exactMessage = JSON.parse(exact.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(exactMessage, /Turn \+ agents 165 tok · €0\.00098/);
  assert.match(exactMessage, /Session \+ agents 165 tok · €0\.00098/);
  assert.match(exactMessage, /Today €0\.00098/);
  assert.doesNotMatch(exactMessage, /pending|≥/);

  const repeated = invoke(rootPath, rootId, rootTurn, false);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(
    JSON.parse(repeated.stdout).systemMessage,
    JSON.parse(exact.stdout).systemMessage,
  );

  const reconciledEntries = readLedgerForRoot(
    defaultUsageRoot(fixtureRoot),
    '2026-08',
    rootId,
  );
  assert.equal(
    reconciledEntries.filter((entry) => entry.entry_type === 'gap').length,
    1,
  );
  assert.equal(
    reconciledEntries.filter((entry) => entry.entry_type !== 'gap').length,
    1,
  );
});

test('records a gap and shows zero as a pending lower bound without tokens', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-no-tokens-'),
  );
  const pluginData = path.join(fixtureRoot, 'plugin-data');
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'no-token-root';
  const rootTurn = 'no-token-turn';
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, rootTurn),
    turnContext(1_000_010, rootTurn),
    taskComplete(1_010_000, rootTurn),
  ]);

  const invocation = invoke(rootPath, rootId, rootTurn, false, {
    PLUGIN_DATA: pluginData,
  });
  assert.equal(invocation.status, 0, invocation.stderr);
  const message = JSON.parse(invocation.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(message, /Turn \+ agents unavailable/);
  assert.match(message, /Session \+ agents ≥0 tok · ≥€0\.00000 · 1 pending/);
  assert.match(message, /Today ≥€0\.00000 · 1 pending/);
  assert.match(invocation.stderr, /without a usable token counter/);

  const entries = readLedgerForRoot(
    path.join(pluginData, 'usage'),
    '2026-08',
    rootId,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry_type, 'gap');
  assert.equal(entries[0].reason, 'usage_unavailable');
});

test('records a current root turn when Stop precedes task_complete', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-open-root-'),
  );
  const pluginData = path.join(fixtureRoot, 'plugin-data');
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'open-root';
  const rootTurn = 'open-root-turn';
  const rootUsage = usage(100, 20, 10, 10);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, rootTurn),
    turnContext(1_000_010, rootTurn),
    tokenRecord(1_000_100, rootUsage, rootUsage),
  ]);

  const debug = invoke(rootPath, rootId, rootTurn);
  assert.equal(debug.status, 0, debug.stderr);
  const result = JSON.parse(debug.stdout);
  assert.equal(result.turnComplete, true);
  assert.equal(result.ledgerContext.completedAtMs, 1_000_100);

  const invocation = invoke(rootPath, rootId, rootTurn, false, {
    PLUGIN_DATA: pluginData,
  });
  assert.equal(invocation.status, 0, invocation.stderr);
  const message = JSON.parse(invocation.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(message, /Turn \+ agents 110 tok · €0\.00065/);
  assert.match(message, /Session \+ agents 110 tok · €0\.00065/);
  assert.match(message, /Today €0\.00065/);

  const entries = readLedgerForRoot(
    path.join(pluginData, 'usage'),
    '2026-08',
    rootId,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry_type, undefined);
  assert.equal(entries[0].turn_id, rootTurn);
});

test('does not record a hook turn id absent from the root rollout', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-missing-turn-'),
  );
  const pluginData = path.join(fixtureRoot, 'plugin-data');
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'missing-turn-root';
  const recordedTurn = 'recorded-turn';
  const missingTurn = 'missing-turn';
  const rootUsage = usage(100, 20, 10, 10);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, recordedTurn),
    turnContext(1_000_010, recordedTurn),
    tokenRecord(1_000_100, rootUsage, rootUsage),
    taskComplete(1_010_000, recordedTurn),
  ]);

  const invocation = invoke(rootPath, rootId, missingTurn, false, {
    PLUGIN_DATA: pluginData,
  });
  assert.equal(invocation.status, 0, invocation.stderr);
  const message = JSON.parse(invocation.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(message, /Turn \+ agents unavailable/);
  assert.match(message, /Session \+ agents ≥0 tok · ≥€0\.00000 · 1 pending/);
  assert.match(invocation.stderr, /current root task could not be found/i);

  const entries = readLedgerForRoot(
    path.join(pluginData, 'usage'),
    '2026-08',
    rootId,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry_type, 'gap');
  assert.equal(entries[0].turn_id, missingTurn);
  assert.equal(entries[0].reason, 'usage_unavailable');
});

test('treats a malformed token counter as incomplete accounting', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-malformed-tokens-'),
  );
  const pluginData = path.join(fixtureRoot, 'plugin-data');
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'malformed-token-root';
  const rootTurn = 'malformed-token-turn';
  const firstUsage = usage(100, 20, 10, 10);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, rootTurn),
    turnContext(1_000_010, rootTurn),
    tokenRecord(1_000_100, firstUsage, firstUsage),
    malformedTokenRecord(1_000_200),
    taskComplete(1_010_000, rootTurn),
  ]);
  fs.mkdirSync(pluginData, { recursive: true });
  fs.writeFileSync(
    path.join(pluginData, 'settings.json'),
    `${JSON.stringify({
      schema: 1,
      timezone: 'Europe/Berlin',
      budgets: {
        daily_eur: 0.001,
        monthly_eur: 0.002,
        warning_thresholds_percent: [50, 80, 100],
      },
      notifications: { windows: false },
      hook: { message_format: 'compact' },
    })}\n`,
    'utf8',
  );

  const invocation = invoke(rootPath, rootId, rootTurn, false, {
    PLUGIN_DATA: pluginData,
  });
  assert.equal(invocation.status, 0, invocation.stderr);
  const message = JSON.parse(invocation.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(message, /Turn \+ agents ≥110 tok · ≥€0\.00065/);
  assert.match(
    message,
    /Session \+ agents ≥110 tok · ≥€0\.00065 · 1 pending/,
  );
  assert.match(
    message,
    /Budget: Today ≥65% · ≤€0\.00035 left │ Month ≥33% · ≤€0\.00135 left │ Forecast ≥€0\.00101/,
  );
  assert.match(invocation.stderr, /Malformed token counter/);

  const entries = readLedgerForRoot(
    path.join(pluginData, 'usage'),
    '2026-08',
    rootId,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry_type, 'gap');
  assert.equal(entries[0].reason, 'history_incomplete');
});

test('records an exact current turn without revisiting an earlier empty task', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-prior-empty-'),
  );
  const pluginData = path.join(fixtureRoot, 'plugin-data');
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'prior-empty-root';
  const emptyTurn = 'empty-turn';
  const currentTurn = 'current-turn';
  const currentUsage = usage(200, 50, 0, 20);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, emptyTurn),
    turnContext(1_000_010, emptyTurn),
    taskComplete(1_010_000, emptyTurn),
    taskStarted(2_000_000, currentTurn),
    turnContext(2_000_010, currentTurn),
    tokenRecord(2_000_100, currentUsage, currentUsage),
    taskComplete(2_010_000, currentTurn),
  ]);

  const debug = invoke(rootPath, rootId, currentTurn);
  assert.equal(debug.status, 0, debug.stderr);
  const result = JSON.parse(debug.stdout);
  assert.equal(result.turnComplete, true);
  assert.equal(result.sessionComplete, false);
  assert.equal(result.turn.usage.total_tokens, 220);

  const invocation = invoke(rootPath, rootId, currentTurn, false, {
    PLUGIN_DATA: pluginData,
  });
  assert.equal(invocation.status, 0, invocation.stderr);
  const message = JSON.parse(invocation.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(message, /Turn \+ agents 220 tok · €0\.00124/);
  assert.match(message, /Session \+ agents 220 tok · €0\.00124/);
  assert.match(message, /Today €0\.00124/);

  const entries = readLedgerForRoot(
    path.join(pluginData, 'usage'),
    '2026-08',
    rootId,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry_type, undefined);
  assert.equal(entries[0].turn_id, currentTurn);
});

test('records an accounting gap when analysis fails after root identity is known', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-fatal-gap-'),
  );
  const pluginData = path.join(fixtureRoot, 'plugin-data');
  const sessionsDay = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionsDay, { recursive: true });

  const rootId = 'fatal-gap-root';
  const rootTurn = 'fatal-gap-turn';
  const rootUsage = usage(100, 20, 10, 10);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, rootTurn),
    turnContext(1_000_010, rootTurn, { unexpected: 'model-shape' }),
    tokenRecord(1_000_100, rootUsage, rootUsage),
    taskComplete(1_010_000, rootTurn),
  ]);

  const invocation = invoke(rootPath, rootId, rootTurn, false, {
    PLUGIN_DATA: pluginData,
  });
  assert.equal(invocation.status, 0, invocation.stderr);
  assert.equal(
    JSON.parse(invocation.stdout).systemMessage,
    'Usage unavailable for this turn.',
  );
  assert.match(invocation.stderr, /startsWith|model/);

  const entries = readLedgerForRoot(
    path.join(pluginData, 'usage'),
    '2026-08',
    rootId,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry_type, 'gap');
  assert.equal(entries[0].reason, 'accounting_error');
});

test('records an unpriced gap and keeps later aggregates as lower bounds', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'turn-cost-unpriced-gap-'),
  );
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

  const rootId = 'unpriced-gap-root';
  const unknownTurn = 'unpriced-turn';
  const knownTurn = 'priced-turn';
  const unknownUsage = usage(100, 0, 0, 10);
  const knownUsage = usage(200, 50, 0, 20);
  const rootPath = writeRollout(sessionsDay, rootId, [
    sessionMeta(1_000_000, rootId, rootId),
    taskStarted(1_000_000, unknownTurn),
    turnContext(1_000_010, unknownTurn, 'future-model'),
    tokenRecord(1_000_100, unknownUsage, unknownUsage),
    taskComplete(1_010_000, unknownTurn),
  ]);

  const first = invoke(
    rootPath,
    rootId,
    unknownTurn,
    false,
    environment,
  );
  assert.equal(first.status, 0, first.stderr);
  const firstMessage = JSON.parse(first.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(firstMessage, /Turn \+ agents 110 tok · cost unavailable/);
  assert.match(
    firstMessage,
    /Session \+ agents ≥0 tok · ≥€0\.00000 · 1 pending/,
  );
  assert.match(firstMessage, /Today ≥€0\.00000 · 1 pending/);
  assert.match(firstMessage, /Aug ≥€0\.00000 · 1 pending/);

  const usageRoot = path.join(pluginData, 'usage');
  let entries = readLedgerForRoot(usageRoot, '2026-08', rootId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry_type, 'gap');
  assert.equal(entries[0].reason, 'pricing_unavailable');

  fs.appendFileSync(
    rootPath,
    `${[
      taskStarted(2_000_000, knownTurn),
      turnContext(2_000_010, knownTurn),
      tokenRecord(
        2_000_100,
        add(unknownUsage, knownUsage),
        knownUsage,
      ),
      taskComplete(2_010_000, knownTurn),
    ].join('\n')}\n`,
    'utf8',
  );

  const second = invoke(rootPath, rootId, knownTurn, false, environment);
  assert.equal(second.status, 0, second.stderr);
  const secondMessage = JSON.parse(second.stdout).systemMessage.replaceAll(
    '\u00a0',
    ' ',
  );
  assert.match(secondMessage, /Turn \+ agents 220 tok · €0\.00124/);
  assert.match(
    secondMessage,
    /Session \+ agents ≥220 tok · ≥€0\.00124 · 1 pending/,
  );
  assert.match(secondMessage, /Today ≥€0\.00124 · 1 pending/);
  assert.match(secondMessage, /Aug ≥€0\.00124 · 1 pending/);
  assert.match(second.stderr, /exact-known lower bounds/);

  entries = readLedgerForRoot(usageRoot, '2026-08', rootId);
  assert.equal(entries.length, 2);
  assert.equal(
    entries.filter((entry) => entry.entry_type === 'gap').length,
    1,
  );
  assert.equal(
    entries.filter((entry) => entry.turn_id === knownTurn).length,
    1,
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

  const usageRoot = path.join(pluginData, 'usage');
  let records = readLedgerForRoot(usageRoot, '2026-08', rootId);
  assert.equal(records.length, 1);
  assert.equal(records[0].schema, 2);
  assert.equal(records[0].turn_id, turnOne);
  assert.equal(records[0].cost_eur_nanos, 5_692_500);
  assert.equal(records[0].eur_per_usd, 0.9);
  assert.equal(records[0].model_breakdown.length, 1);
  assert.equal(
    records[0].agent_breakdown.root.cost_eur_nanos,
    records[0].cost_eur_nanos,
  );

  const duplicate = invoke(rootPath, rootId, turnOne, false, environment);
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(readLedgerForRoot(usageRoot, '2026-08', rootId).length, 1);

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

  records = readLedgerForRoot(usageRoot, '2026-08', rootId);
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

  const usageRoot = defaultUsageRoot(fixtureRoot);
  const sourceRecords = readLedgerForRoot(usageRoot, '2026-08', sourceId);
  const forkRecords = readLedgerForRoot(usageRoot, '2026-08', forkId);
  assert.equal(sourceRecords.length, 1);
  assert.equal(forkRecords.length, 1);
  assert.equal(forkRecords[0].root_thread_id, forkId);
  assert.equal(forkRecords[0].session_id, sourceId);
  assert.equal(forkRecords[0].turn_id, forkTurn);
  assert.equal(forkRecords[0].usage.total_tokens, 330);
  assert.equal(forkRecords[0].cost_eur_nanos, 1_811_250);
});

test('uses a stable final-token timestamp when Stop precedes task_complete', () => {
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
  ]);
  const environment = {
    CODEX_TURN_COST_NOW: '',
  };

  const first = invoke(rootPath, rootId, augustTurn, false, environment);
  assert.equal(first.status, 0, first.stderr);
  fs.appendFileSync(
    rootPath,
    `${[
      taskComplete(augustComplete, augustTurn),
      taskStarted(septemberStart, septemberTurn),
      turnContext(septemberStart + 10, septemberTurn),
      tokenRecord(septemberStart + 100, cumulative, septemberUsage),
      taskComplete(septemberComplete, septemberTurn),
    ].join('\n')}\n`,
    'utf8',
  );
  const second = invoke(rootPath, rootId, septemberTurn, false, environment);
  assert.equal(second.status, 0, second.stderr);
  const duplicate = invoke(rootPath, rootId, augustTurn, false, environment);
  assert.equal(duplicate.status, 0, duplicate.stderr);

  const usageRoot = defaultUsageRoot(fixtureRoot);
  const records = readLedgerForRoot(usageRoot, '2026-08', rootId);
  assert.equal(records.length, 2);
  const augustRecord = records.find((record) => record.turn_id === augustTurn);
  const septemberRecord = records.find(
    (record) => record.turn_id === septemberTurn,
  );
  assert.ok(augustRecord);
  assert.equal(
    augustRecord.completed_at,
    new Date(augustStart + 100).toISOString(),
  );
  assert.ok(septemberRecord);
  assert.equal(
    septemberRecord.completed_at,
    new Date(septemberStart + 100).toISOString(),
  );
  assert.equal(fs.existsSync(path.join(usageRoot, '2026-09')), false);
});
