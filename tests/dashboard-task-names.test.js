'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const modulePath = path.resolve(
  __dirname,
  '..',
  'plugins',
  'codex-cost-meter',
  'lib',
  'dashboard-task-names.js',
);
const taskNames = require(modulePath);

const knownKeys = new Map([
  ['thread-a', 'safe-a'],
  ['thread-b', 'safe-b'],
  ['thread-c', 'safe-c'],
]);
const safeTaskKey = (id) => knownKeys.get(id) ?? `safe-${id.length}`;

function record(id, name, updatedAt) {
  return JSON.stringify({
    id,
    thread_name: name,
    updated_at: updatedAt,
  });
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'dashboard-task-names-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('parses normalized names and selects newest timestamps with last-tie wins', () => {
  const longName = `${'z'.repeat(12)} ignored`;
  const parsed = taskNames.parseSessionIndexText(
    [
      record('thread-a', ' Initial name ', '2026-08-20T10:00:00.000Z'),
      record('thread-a', 'older later line', '2026-08-20T09:00:00.000Z'),
      record('thread-a', ' Equal\t\n newest ', '2026-08-20T10:00:00.000Z'),
      record('thread-b', ' Controls\u0000 and   spaces ', '2026-08-20T11:00:00.000Z'),
      record('thread-c', longName, '2026-08-20T12:00:00.000Z'),
    ].join('\n'),
    { safeTaskKey, maxNameCharacters: 12 },
  );

  assert.equal(parsed.complete, true);
  assert.deepEqual([...parsed.names], [
    ['safe-a', 'Equal newest'],
    ['safe-b', 'Controls and'],
    ['safe-c', 'zzzzzzzzzzzz'],
  ]);
  assert.deepEqual(parsed.diagnostics, []);
});

test('keeps valid names while safely diagnosing malformed and invalid lines', () => {
  const parsed = taskNames.parseSessionIndexText(
    [
      record('thread-a', 'Usable name', '2026-08-20T10:00:00.000Z'),
      '{"id":"truncated"',
      JSON.stringify({
        id: 'thread-b',
        thread_name: 'Bad timestamp',
        updated_at: 'not-a-date',
      }),
      JSON.stringify({
        id: 'thread-c',
        thread_name: '\u0000\t',
        updated_at: '2026-08-20T12:00:00.000Z',
      }),
    ].join('\n'),
    { safeTaskKey },
  );

  assert.deepEqual([...parsed.names], [['safe-a', 'Usable name']]);
  assert.equal(parsed.complete, false);
  assert.match(parsed.diagnostics.join('\n'), /1 malformed or truncated/i);
  assert.match(parsed.diagnostics.join('\n'), /2 invalid task-name index records/i);
  assert.doesNotMatch(parsed.diagnostics.join('\n'), /thread-|Usable name/);
});

test('rejects task names that could expose a full path or raw task id', () => {
  const parsed = taskNames.parseSessionIndexText(
    [
      record(
        'thread-a',
        'Work in /home/private/project',
        '2026-08-20T10:00:00.000Z',
      ),
      record(
        'thread-b',
        'Inspect C:\\Users\\private\\project',
        '2026-08-20T11:00:00.000Z',
      ),
      record(
        'thread-c',
        'Follow up on thread-c',
        '2026-08-20T12:00:00.000Z',
      ),
      record(
        'thread-d',
        'Fix `/home/private/project/app.js`',
        '2026-08-20T13:00:00.000Z',
      ),
      record(
        'thread-e',
        'Check path=/home/private/project',
        '2026-08-20T14:00:00.000Z',
      ),
      record(
        'thread-f',
        'Open file:///home/private/project',
        '2026-08-20T15:00:00.000Z',
      ),
    ].join('\n'),
    { safeTaskKey },
  );

  assert.deepEqual([...parsed.names], []);
  assert.equal(parsed.complete, false);
  assert.match(parsed.diagnostics.join('\n'), /6 invalid task-name index records/i);
  assert.doesNotMatch(parsed.diagnostics.join('\n'), /private|thread-c/i);
});

test('drops ambiguous safe-key collisions without exposing source ids', () => {
  const parsed = taskNames.parseSessionIndexText(
    [
      record('first-private-id', 'First private name', '2026-08-20T10:00:00.000Z'),
      record('second-private-id', 'Second private name', '2026-08-20T11:00:00.000Z'),
    ].join('\n'),
    { safeTaskKey: () => 'collision' },
  );

  assert.deepEqual([...parsed.names], []);
  assert.equal(parsed.complete, false);
  assert.match(parsed.diagnostics.join('\n'), /ambiguous task-name key/i);
  assert.doesNotMatch(
    parsed.diagnostics.join('\n'),
    /private-id|private name/i,
  );
});

test('resolves explicit and inferred sources and extracts future CLI flags', () => {
  const standardRoot = path.resolve(
    '/tmp/example-codex',
    'plugins',
    'data',
    'codex-cost-meter-cost-meter',
  );
  assert.equal(
    taskNames.codexHomeFromDataRoot(standardRoot),
    path.resolve('/tmp/example-codex'),
  );
  assert.equal(
    taskNames.codexHomeFromDataRoot('/tmp/custom/data-root'),
    null,
  );

  const explicitIndex = path.resolve('/tmp/explicit-index.jsonl');
  assert.equal(
    taskNames.resolveSessionIndexPath({
      sessionIndexPath: explicitIndex,
      codexHome: '/tmp/ignored-home',
      env: { CODEX_HOME: '/tmp/ignored-env' },
      dataRoot: standardRoot,
    }),
    explicitIndex,
  );
  assert.equal(
    taskNames.resolveSessionIndexPath({
      codexHome: '/tmp/explicit-home',
      env: { CODEX_HOME: '/tmp/ignored-env' },
      dataRoot: standardRoot,
    }),
    path.resolve('/tmp/explicit-home', 'session_index.jsonl'),
  );
  assert.equal(
    taskNames.resolveSessionIndexPath({
      env: { CODEX_HOME: '/tmp/environment-home' },
      dataRoot: standardRoot,
    }),
    path.resolve('/tmp/example-codex', 'session_index.jsonl'),
  );
  assert.equal(
    taskNames.resolveSessionIndexPath({
      env: { CODEX_HOME: '/tmp/environment-home' },
      dataRoot: '/tmp/custom/data-root',
    }),
    path.resolve('/tmp/environment-home', 'session_index.jsonl'),
  );
  assert.equal(
    taskNames.resolveSessionIndexPath({ env: {}, dataRoot: standardRoot }),
    path.resolve('/tmp/example-codex', 'session_index.jsonl'),
  );
  assert.equal(
    taskNames.resolveSessionIndexPath({
      env: { CODEX_HOME: '  ' },
      dataRoot: '/tmp/custom/data-root',
    }),
    null,
  );

  assert.deepEqual(
    taskNames.parseTaskNameSourceArguments([
      '--port',
      '43118',
      '--codex-home=/tmp/home',
      '--session-index',
      '/tmp/index.jsonl',
    ]),
    {
      options: {
        codexHome: '/tmp/home',
        sessionIndexPath: '/tmp/index.jsonl',
      },
      remaining: ['--port', '43118'],
    },
  );
  assert.throws(
    () => taskNames.parseTaskNameSourceArguments(['--codex-home']),
    /requires a path/i,
  );
});

test('caches unchanged sources and rereads appends and replacements', (t) => {
  const codexHome = temporaryDirectory(t);
  const filePath = path.join(codexHome, 'session_index.jsonl');
  fs.writeFileSync(
    filePath,
    `${record('thread-a', 'First name', '2026-08-20T10:00:00.000Z')}\n`,
    'utf8',
  );
  taskNames.clearDashboardTaskNameCache();

  const originalOpenSync = fs.openSync;
  let sourceOpens = 0;
  fs.openSync = function countedOpenSync(candidate, flags, ...rest) {
    if (path.resolve(candidate) === path.resolve(filePath) && flags === 'r') {
      sourceOpens += 1;
    }
    return originalOpenSync.call(this, candidate, flags, ...rest);
  };
  t.after(() => {
    fs.openSync = originalOpenSync;
    taskNames.clearDashboardTaskNameCache();
  });

  const options = { codexHome, env: {}, safeTaskKey };
  const first = taskNames.loadDashboardTaskNames(options);
  assert.equal(first.names.get('safe-a'), 'First name');
  first.names.set('safe-a', 'Caller mutation');
  const unchanged = taskNames.loadDashboardTaskNames(options);
  assert.equal(unchanged.names.get('safe-a'), 'First name');
  assert.equal(sourceOpens, 1);

  fs.appendFileSync(
    filePath,
    `${record('thread-a', 'Appended name', '2026-08-20T11:00:00.000Z')}\n`,
    'utf8',
  );
  const appended = taskNames.loadDashboardTaskNames(options);
  assert.equal(appended.names.get('safe-a'), 'Appended name');
  assert.equal(sourceOpens, 2);

  const replacementPath = `${filePath}.replacement`;
  fs.writeFileSync(
    replacementPath,
    `${record('thread-a', 'Replacement name', '2026-08-20T12:00:00.000Z')}\n`,
    'utf8',
  );
  fs.renameSync(replacementPath, filePath);
  const replaced = taskNames.loadDashboardTaskNames(options);
  assert.equal(replaced.names.get('safe-a'), 'Replacement name');
  assert.equal(sourceOpens, 3);
});

test('returns safe fallbacks for missing, truncated, and oversized sources', (t) => {
  const codexHome = temporaryDirectory(t);
  const filePath = path.join(codexHome, 'session_index.jsonl');
  const options = { codexHome, env: {}, safeTaskKey };
  taskNames.clearDashboardTaskNameCache();

  const missing = taskNames.loadDashboardTaskNames(options);
  assert.equal(missing.available, false);
  assert.deepEqual([...missing.names], []);
  assert.match(missing.diagnostics.join('\n'), /not found.*hashed/i);

  fs.writeFileSync(
    filePath,
    `${record('thread-a', 'Valid before tail', '2026-08-20T10:00:00.000Z')}\n{"id":"partial"`,
    'utf8',
  );
  const truncated = taskNames.loadDashboardTaskNames(options);
  assert.equal(truncated.available, true);
  assert.equal(truncated.complete, false);
  assert.equal(truncated.names.get('safe-a'), 'Valid before tail');
  assert.match(truncated.diagnostics.join('\n'), /malformed or truncated/i);

  const oversized = taskNames.loadDashboardTaskNames({
    ...options,
    maxFileBytes: 8,
  });
  assert.equal(oversized.available, true);
  assert.deepEqual([...oversized.names], []);
  assert.match(oversized.diagnostics.join('\n'), /exceeds the 8-byte/i);
});

test('module contains no persistence path for names or source ids', () => {
  const source = fs.readFileSync(modulePath, 'utf8');
  assert.doesNotMatch(
    source,
    /\b(?:writeFileSync|appendFileSync|createWriteStream|renameSync)\b/,
  );
  assert.doesNotMatch(source, /turn-cost/);
});
