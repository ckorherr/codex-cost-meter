'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseRolloutCached,
  windowsNotificationCommand,
} = require('../plugins/codex-cost-meter/scripts/turn-cost');

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function sessionMeta(threadId) {
  return line('2026-08-20T10:00:00.000Z', 'session_meta', {
    id: threadId,
    session_id: threadId,
    timestamp: '2026-08-20T10:00:00.000Z',
    source: 'vscode',
  });
}

function tokenRecord(timestamp, inputTokens, outputTokens) {
  return line(timestamp, 'event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: inputTokens,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: outputTokens,
        reasoning_output_tokens: 0,
        total_tokens: inputTokens + outputTokens,
      },
      last_token_usage: {
        input_tokens: inputTokens,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: outputTokens,
        reasoning_output_tokens: 0,
        total_tokens: inputTokens + outputTokens,
      },
    },
  });
}

test('incremental rollout cache reads only newly appended bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-cache-'));
  const cacheDirectory = path.join(root, 'cache');
  const filePath = path.join(root, 'rollout-root.jsonl');
  const threadId = 'root-thread';
  const initial = [
    sessionMeta(threadId),
    line('2026-08-20T10:00:01.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: 'turn-one',
      started_at: 1_776_247_201,
    }),
    line('2026-08-20T10:00:01.100Z', 'turn_context', {
      turn_id: 'turn-one',
      model: 'gpt-5.6-sol',
    }),
    tokenRecord('2026-08-20T10:00:02.000Z', 100, 10),
    line('2026-08-20T10:00:03.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: 'turn-one',
    }),
  ].join('\n');
  fs.writeFileSync(filePath, `${initial}\n`, 'utf8');

  const first = parseRolloutCached(filePath, threadId, cacheDirectory);
  assert.equal(first.taskStarts.length, 1);
  assert.equal(first.tokenEvents.length, 1);
  const initialSize = fs.statSync(filePath).size;
  const cached = JSON.parse(
    fs.readFileSync(path.join(cacheDirectory, `${threadId}.json`), 'utf8'),
  );
  assert.equal(cached.version, 5);
  assert.match(cached.sourceKey, /^[a-f0-9]{64}$/);
  assert.equal(
    cached.sourceIdentity.inode,
    fs.statSync(filePath, { bigint: true }).ino.toString(),
  );
  assert.equal(cached.sourcePath, undefined);
  assert.equal(JSON.stringify(cached).includes(filePath), false);

  const appended = [
    line('2026-08-20T11:00:00.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: 'turn-two',
      started_at: 1_776_250_800,
    }),
    line('2026-08-20T11:00:00.100Z', 'turn_context', {
      turn_id: 'turn-two',
      model: 'gpt-5.6-terra',
    }),
    tokenRecord('2026-08-20T11:00:01.000Z', 150, 20),
    line('2026-08-20T11:00:02.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: 'turn-two',
    }),
  ].join('\n');
  fs.appendFileSync(filePath, `${appended}\n`, 'utf8');

  const originalReadSync = fs.readSync;
  const positions = [];
  fs.readSync = function patchedReadSync(
    descriptor,
    buffer,
    offset,
    length,
    position,
  ) {
    if (position !== null) {
      positions.push(position);
    }
    return originalReadSync.call(
      this,
      descriptor,
      buffer,
      offset,
      length,
      position,
    );
  };

  let second;
  try {
    second = parseRolloutCached(filePath, threadId, cacheDirectory);
  } finally {
    fs.readSync = originalReadSync;
  }

  assert.equal(positions[0], initialSize);
  assert.equal(second.taskStarts.length, 2);
  assert.equal(second.tokenEvents.length, 2);
  assert.equal(second.taskStarts[1].model, 'gpt-5.6-terra');
  assert.equal(second.taskStarts[1].completed, true);
});

test('incremental rollout cache retains and later parses an incomplete tail', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rollout-cache-partial-'),
  );
  const cacheDirectory = path.join(root, 'cache');
  const filePath = path.join(root, 'rollout-root.jsonl');
  const threadId = 'partial-root';
  const partialRecord = tokenRecord(
    '2026-08-20T10:00:02.000Z',
    100,
    10,
  );
  const splitAt = Math.floor(partialRecord.length / 2);
  fs.writeFileSync(
    filePath,
    `${sessionMeta(threadId)}\n${partialRecord.slice(0, splitAt)}`,
    'utf8',
  );

  const first = parseRolloutCached(filePath, threadId, cacheDirectory);
  assert.equal(first.tokenEvents.length, 0);

  fs.appendFileSync(filePath, `${partialRecord.slice(splitAt)}\n`, 'utf8');
  const second = parseRolloutCached(filePath, threadId, cacheDirectory);
  assert.equal(second.tokenEvents.length, 1);
  assert.equal(second.tokenEvents[0].total.total_tokens, 110);
});

test('incremental rollout cache parses a complete EOF record without a newline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-cache-eof-'));
  const cacheDirectory = path.join(root, 'cache');
  const filePath = path.join(root, 'rollout-root.jsonl');
  const threadId = 'eof-root';
  const firstToken = tokenRecord('2026-08-20T10:00:02.000Z', 100, 10);
  fs.writeFileSync(
    filePath,
    `${sessionMeta(threadId)}\n${firstToken}`,
    'utf8',
  );

  const first = parseRolloutCached(filePath, threadId, cacheDirectory);
  assert.equal(first.tokenEvents.length, 1);
  assert.equal(first.tokenEvents[0].total.total_tokens, 110);

  const initialSize = fs.statSync(filePath).size;
  const firstCache = JSON.parse(
    fs.readFileSync(path.join(cacheDirectory, `${threadId}.json`), 'utf8'),
  );
  assert.equal(firstCache.offset, initialSize);

  const unchanged = parseRolloutCached(filePath, threadId, cacheDirectory);
  assert.equal(unchanged.tokenEvents.length, 1);

  const secondToken = tokenRecord('2026-08-20T10:00:03.000Z', 200, 20);
  fs.appendFileSync(filePath, `\n${secondToken}`, 'utf8');

  const originalReadSync = fs.readSync;
  const positions = [];
  fs.readSync = function patchedReadSync(
    descriptor,
    buffer,
    offset,
    length,
    position,
  ) {
    if (position !== null) {
      positions.push(position);
    }
    return originalReadSync.call(
      this,
      descriptor,
      buffer,
      offset,
      length,
      position,
    );
  };

  let appended;
  try {
    appended = parseRolloutCached(filePath, threadId, cacheDirectory);
  } finally {
    fs.readSync = originalReadSync;
  }

  assert.equal(positions[0], initialSize);
  assert.equal(appended.tokenEvents.length, 2);
  assert.deepEqual(
    appended.tokenEvents.map((event) => event.total.total_tokens),
    [110, 220],
  );
});

test('incremental rollout cache rebuilds when a path is replaced', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rollout-cache-replaced-'),
  );
  const cacheDirectory = path.join(root, 'cache');
  const filePath = path.join(root, 'rollout-root.jsonl');
  const replacementPath = path.join(root, 'replacement.jsonl');
  const threadId = 'replaced-root';

  fs.writeFileSync(
    filePath,
    `${[
      sessionMeta(threadId),
      line('2026-08-20T10:00:01.000Z', 'event_msg', {
        type: 'task_started',
        turn_id: 'old-turn',
      }),
      tokenRecord('2026-08-20T10:00:02.000Z', 100, 10),
    ].join('\n')}\n`,
    'utf8',
  );
  const first = parseRolloutCached(filePath, threadId, cacheDirectory);
  assert.deepEqual(
    first.taskStarts.map((task) => task.id),
    ['old-turn'],
  );

  fs.writeFileSync(
    replacementPath,
    `${[
      sessionMeta(threadId),
      line('2026-08-20T11:00:01.000Z', 'event_msg', {
        type: 'task_started',
        turn_id: 'new-turn',
      }),
      tokenRecord('2026-08-20T11:00:02.000Z', 200, 20),
      line('2026-08-20T11:00:03.000Z', 'event_msg', {
        type: 'task_complete',
        turn_id: 'new-turn',
      }),
    ].join('\n')}\n`,
    'utf8',
  );
  fs.renameSync(replacementPath, filePath);

  const second = parseRolloutCached(filePath, threadId, cacheDirectory);
  assert.deepEqual(
    second.taskStarts.map((task) => task.id),
    ['new-turn'],
  );
  assert.equal(second.tokenEvents.length, 1);
  assert.equal(second.tokenEvents[0].total.total_tokens, 220);
});

test('Windows notification command carries its message without WSL env forwarding', () => {
  const message = 'Budget threshold: €10 $(unsafe)';
  const encodedCommand = windowsNotificationCommand(message);
  const script = Buffer.from(encodedCommand, 'base64').toString('utf16le');
  const encodedMessage = Buffer.from(message, 'utf8').toString('base64');

  assert.match(script, /System\.Windows\.Forms\.NotifyIcon/);
  assert.equal(script.includes(encodedMessage), true);
  assert.doesNotMatch(script, /CODEX_COST_METER_NOTIFICATION|\\$env:/);
  assert.equal(script.includes(message), false);
});
