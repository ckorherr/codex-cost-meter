'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readSessionMetadata,
  buildSessionFileIndex,
  findChildMetadata,
  findChildSessionMetadata,
  uuidV7TimestampMs,
} = require('../plugins/codex-cost-meter/lib/session-index');

function sessionMeta(
  id,
  sessionId = id,
  parentThreadId = null,
  options = {},
) {
  const timestamp = options.timestamp ?? '2026-08-20T12:00:00.000Z';
  return JSON.stringify({
    timestamp,
    type: 'session_meta',
    payload: {
      id,
      session_id: sessionId,
      ...(options.forkedFromId
        ? { forked_from_id: options.forkedFromId }
        : {}),
      timestamp,
      source: parentThreadId
        ? {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentThreadId,
                depth: options.depth ?? 1,
                agent_path: `/root/${id}`,
              },
            },
          }
        : 'vscode',
    },
  });
}

function writeRollout(sessionsRoot, relativePath, firstLine) {
  const filePath = path.join(sessionsRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${firstLine}\n`, 'utf8');
  return filePath;
}

function cacheFile(cacheDirectory) {
  const matches = fs
    .readdirSync(cacheDirectory)
    .filter((name) => name.endsWith('.json'));
  assert.equal(matches.length, 1);
  return path.join(cacheDirectory, matches[0]);
}

function countSourceOpens(sessionsRoot, callback) {
  const originalOpenSync = fs.openSync;
  const rootPrefix = `${path.resolve(sessionsRoot)}${path.sep}`;
  let count = 0;

  fs.openSync = function patchedOpenSync(filePath, flags, ...rest) {
    if (
      typeof filePath === 'string' &&
      path.resolve(filePath).startsWith(rootPrefix) &&
      flags === 'r'
    ) {
      count += 1;
    }
    return originalOpenSync.call(this, filePath, flags, ...rest);
  };

  try {
    return {
      result: callback(),
      sourceOpens: () => count,
    };
  } finally {
    fs.openSync = originalOpenSync;
  }
}

function countSessionFsOperations(sessionsRoot, callback) {
  const originalReaddirSync = fs.readdirSync;
  const originalStatSync = fs.statSync;
  const resolvedRoot = path.resolve(sessionsRoot);
  const rootPrefix = `${resolvedRoot}${path.sep}`;
  const readdirPaths = [];
  const statPaths = [];

  function relativeSourcePath(filePath) {
    if (typeof filePath !== 'string') {
      return null;
    }
    const resolved = path.resolve(filePath);
    if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix)) {
      return null;
    }
    return path.relative(resolvedRoot, resolved).split(path.sep).join('/');
  }

  fs.readdirSync = function patchedReaddirSync(filePath, ...rest) {
    const relativePath = relativeSourcePath(filePath);
    if (relativePath !== null) {
      readdirPaths.push(relativePath);
    }
    return originalReaddirSync.call(this, filePath, ...rest);
  };
  fs.statSync = function patchedStatSync(filePath, ...rest) {
    const relativePath = relativeSourcePath(filePath);
    if (relativePath !== null) {
      statPaths.push(relativePath);
    }
    return originalStatSync.call(this, filePath, ...rest);
  };

  try {
    return {
      result: callback(),
      readdirPaths,
      statPaths,
    };
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.statSync = originalStatSync;
  }
}

function markDirectoryChanged(directoryPath, offsetSeconds) {
  const changedAt = new Date(Date.now() + offsetSeconds * 1000);
  fs.utimesSync(directoryPath, changedAt, changedAt);
}

test('reads the existing first-line session metadata shape', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-meta-'),
  );
  const filePath = writeRollout(
    fixtureRoot,
    'rollout-child.jsonl',
    `\uFEFF${sessionMeta('child', 'root-session', 'parent', {
      depth: 2,
      forkedFromId: 'fork-source',
    })}`,
  );

  assert.deepEqual(readSessionMetadata(filePath), {
    filePath,
    threadId: 'child',
    sessionId: 'root-session',
    forkedFromId: 'fork-source',
    parentThreadId: 'parent',
    depth: 2,
    isSubagent: true,
    startedMs: Date.parse('2026-08-20T12:00:00.000Z'),
  });
});

test('derives a UUIDv7 rollout day and performs a suffix-targeted lookup', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-targeted-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const childId = '01a0208e-2129-73a1-8223-d92165c80424';
  const childPath = writeRollout(
    sessionsRoot,
    `2026/08/20/rollout-2026-08-20T19-03-00-${childId}.jsonl`,
    sessionMeta(childId, 'root-session', 'parent-thread'),
  );
  writeRollout(
    sessionsRoot,
    `2026/08/19/rollout-unrelated-${childId}.jsonl`,
    sessionMeta(childId, 'other-session', 'other-parent'),
  );

  assert.equal(
    new Date(uuidV7TimestampMs(childId)).toISOString(),
    '2026-08-20T19:03:00.649Z',
  );
  const observed = countSessionFsOperations(sessionsRoot, () =>
    findChildSessionMetadata(
      sessionsRoot,
      childId,
      'parent-thread',
      'root-session',
    ),
  );
  assert.equal(observed.result.filePath, childPath);
  assert.deepEqual(observed.readdirPaths, ['2026/08/20']);
  assert.deepEqual(observed.statPaths, []);
});

test('checks adjacent bounded days for UUIDv7 midnight rollouts', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-targeted-midnight-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const timestampMs = Date.parse('2026-08-20T00:00:00.100Z');
  const timestampHex = timestampMs.toString(16).padStart(12, '0');
  const childId =
    `${timestampHex.slice(0, 8)}-${timestampHex.slice(8)}-` +
    '7000-8000-000000000001';
  const childPath = writeRollout(
    sessionsRoot,
    `2026/08/19/rollout-local-date-${childId}.jsonl`,
    sessionMeta(childId, 'root-session', 'parent-thread'),
  );

  const observed = countSessionFsOperations(sessionsRoot, () =>
    findChildSessionMetadata(
      sessionsRoot,
      childId,
      'parent-thread',
      'root-session',
    ),
  );
  assert.equal(observed.result.filePath, childPath);
  assert.deepEqual(observed.readdirPaths, [
    '2026/08/20',
    '2026/08/19',
  ]);
});

test('limits non-UUID fallback lookup to explicit candidate days', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-targeted-fallback-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const parentPath = writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-parent-thread.jsonl',
    sessionMeta('parent-thread', 'root-session'),
  );
  const childPath = writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-test-child-thread.jsonl',
    sessionMeta('child-thread', 'root-session', 'parent-thread'),
  );
  writeRollout(
    sessionsRoot,
    '2025/01/01/rollout-test-child-thread.jsonl',
    sessionMeta('child-thread', 'root-session', 'parent-thread'),
  );

  const observed = countSessionFsOperations(sessionsRoot, () =>
    findChildSessionMetadata(
      sessionsRoot,
      'child-thread',
      'parent-thread',
      'root-session',
      {
        parentFilePath: parentPath,
        occurredAtMs: Date.parse('2026-08-21T00:00:01.000Z'),
      },
    ),
  );
  assert.equal(observed.result.filePath, childPath);
  assert.deepEqual(observed.readdirPaths, ['2026/08/20']);

  const unsafe = countSessionFsOperations(sessionsRoot, () =>
    findChildSessionMetadata(
      sessionsRoot,
      '../child-thread',
      'parent-thread',
      'root-session',
      { parentFilePath: parentPath },
    ),
  );
  assert.equal(unsafe.result, null);
  assert.deepEqual(unsafe.readdirPaths, []);
  assert.deepEqual(unsafe.statPaths, []);
});

test('rejects targeted rollout candidates with mismatched lineage', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-targeted-lineage-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const parentPath = writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-parent-thread.jsonl',
    sessionMeta('parent-thread', 'root-session'),
  );
  writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-test-child-thread.jsonl',
    sessionMeta('child-thread', 'other-session', 'other-parent'),
  );

  assert.equal(
    findChildSessionMetadata(
      sessionsRoot,
      'child-thread',
      'parent-thread',
      'root-session',
      { parentFilePath: parentPath },
    ),
    null,
  );
});

test('reuses cached metadata without reopening unchanged or appended rollouts', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-reuse-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const cacheDirectory = path.join(fixtureRoot, 'plugin-data', 'hook-cache');
  const rootPath = writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-root.jsonl',
    sessionMeta('root'),
  );
  writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-child.jsonl',
    sessionMeta('child', 'root', 'root'),
  );

  const first = countSourceOpens(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.equal(first.sourceOpens(), 2);
  assert.equal(first.result.files.length, 2);

  const second = countSourceOpens(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.equal(second.sourceOpens(), 0);
  assert.deepEqual(
    second.result.metadata.map((metadata) => metadata.threadId),
    ['child', 'root'],
  );

  const unchangedActivity = countSessionFsOperations(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.deepEqual(unchangedActivity.readdirPaths, []);
  assert.equal(
    unchangedActivity.statPaths.some((relativePath) =>
      relativePath.endsWith('.jsonl'),
    ),
    false,
  );
  assert.deepEqual(unchangedActivity.statPaths, [
    '',
    '2026',
    '2026/08',
    '2026/08/20',
  ]);

  fs.appendFileSync(rootPath, '{"type":"event_msg"}\n', 'utf8');
  const afterAppend = countSourceOpens(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.equal(afterAppend.sourceOpens(), 0);
  assert.equal(afterAppend.result.byThreadId.get('root').length, 1);
});

test('changed day discovers new rollouts and removes disappeared entries', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-changes-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const cacheDirectory = path.join(fixtureRoot, 'cache');
  const rootPath = writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-root.jsonl',
    sessionMeta('root'),
  );
  buildSessionFileIndex(sessionsRoot, cacheDirectory);

  const childPath = writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-child.jsonl',
    sessionMeta('child', 'root', 'root'),
  );
  const dayDirectory = path.dirname(childPath);
  markDirectoryChanged(dayDirectory, 5);
  const withChild = countSessionFsOperations(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.deepEqual(withChild.readdirPaths, ['2026/08/20']);
  assert.deepEqual(
    withChild.statPaths.filter((relativePath) =>
      relativePath.endsWith('.jsonl'),
    ),
    [
      '2026/08/20/rollout-child.jsonl',
      '2026/08/20/rollout-root.jsonl',
    ],
  );
  assert.deepEqual(
    withChild.result.metadata.map((metadata) => metadata.threadId),
    ['child', 'root'],
  );

  fs.unlinkSync(rootPath);
  markDirectoryChanged(dayDirectory, 10);
  const withoutRoot = countSessionFsOperations(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.deepEqual(withoutRoot.readdirPaths, ['2026/08/20']);
  assert.deepEqual(
    withoutRoot.statPaths.filter((relativePath) =>
      relativePath.endsWith('.jsonl'),
    ),
    ['2026/08/20/rollout-child.jsonl'],
  );
  assert.deepEqual(withoutRoot.result.files, [childPath]);
  assert.equal(withoutRoot.result.byThreadId.has('root'), false);

  const persisted = JSON.parse(
    fs.readFileSync(cacheFile(cacheDirectory), 'utf8'),
  );
  assert.deepEqual(Object.keys(persisted.entries), [
    '2026/08/20/rollout-child.jsonl',
  ]);
});

test('rechecks a cached file whose session metadata was initially absent', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-late-metadata-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const cacheDirectory = path.join(fixtureRoot, 'cache');
  const filePath = path.join(
    sessionsRoot,
    '2026',
    '08',
    '20',
    'rollout-child.jsonl',
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');

  const first = buildSessionFileIndex(sessionsRoot, cacheDirectory);
  assert.equal(first.metadata.length, 0);

  fs.appendFileSync(
    filePath,
    `${sessionMeta('child', 'root', 'root')}\n`,
    'utf8',
  );
  const second = buildSessionFileIndex(sessionsRoot, cacheDirectory);
  assert.equal(second.metadata[0].threadId, 'child');
  assert.equal(second.byThreadId.has('child'), true);
});

test('discovers and prunes new nested day directories', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-directories-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const cacheDirectory = path.join(fixtureRoot, 'cache');
  const oldPath = writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-root.jsonl',
    sessionMeta('root'),
  );
  buildSessionFileIndex(sessionsRoot, cacheDirectory);

  const newPath = writeRollout(
    sessionsRoot,
    '2026/08/21/rollout-child.jsonl',
    sessionMeta('child', 'root', 'root'),
  );
  const monthDirectory = path.join(sessionsRoot, '2026', '08');
  markDirectoryChanged(monthDirectory, 5);
  const afterAddition = countSessionFsOperations(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.deepEqual(afterAddition.readdirPaths, [
    '2026/08',
    '2026/08/21',
  ]);
  assert.deepEqual(afterAddition.result.files, [oldPath, newPath]);

  fs.unlinkSync(oldPath);
  fs.rmdirSync(path.dirname(oldPath));
  markDirectoryChanged(monthDirectory, 10);
  const afterRemoval = countSessionFsOperations(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.deepEqual(afterRemoval.readdirPaths, ['2026/08']);
  assert.deepEqual(afterRemoval.result.files, [newPath]);

  const persisted = JSON.parse(
    fs.readFileSync(cacheFile(cacheDirectory), 'utf8'),
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      persisted.directories,
      '2026/08/20',
    ),
    false,
  );
});

test('rebuilds safely after a corrupt or incompatible cache', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-corrupt-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const cacheDirectory = path.join(fixtureRoot, 'cache');
  writeRollout(
    sessionsRoot,
    'rollout-root.jsonl',
    sessionMeta('root'),
  );
  buildSessionFileIndex(sessionsRoot, cacheDirectory);

  const indexPath = cacheFile(cacheDirectory);
  fs.writeFileSync(indexPath, '{malformed', 'utf8');
  const afterCorruption = countSourceOpens(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.equal(afterCorruption.sourceOpens(), 1);
  assert.equal(afterCorruption.result.metadata[0].threadId, 'root');

  fs.writeFileSync(
    indexPath,
    JSON.stringify({ schema: 999, entries: {} }),
    'utf8',
  );
  const afterIncompatible = countSourceOpens(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.equal(afterIncompatible.sourceOpens(), 1);
  assert.equal(
    JSON.parse(fs.readFileSync(indexPath, 'utf8')).schema,
    2,
  );

  const malformed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  malformed.entries['rollout-root.jsonl'].snapshot = null;
  fs.writeFileSync(
    indexPath,
    JSON.stringify(malformed),
    'utf8',
  );
  const afterMalformedEntry = countSourceOpens(sessionsRoot, () =>
    buildSessionFileIndex(sessionsRoot, cacheDirectory),
  );
  assert.equal(afterMalformedEntry.sourceOpens(), 1);
  assert.equal(afterMalformedEntry.result.metadata[0].threadId, 'root');
});

test('matches children by thread, parent, and root session deterministically', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-index-match-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  const cacheDirectory = path.join(fixtureRoot, 'cache');
  const firstPath = writeRollout(
    sessionsRoot,
    'a/rollout-child.jsonl',
    sessionMeta('child', 'session-a', 'parent-a'),
  );
  const secondPath = writeRollout(
    sessionsRoot,
    'b/rollout-child.jsonl',
    sessionMeta('child', 'session-b', 'parent-b'),
  );
  const index = buildSessionFileIndex(sessionsRoot, cacheDirectory);

  assert.equal(
    findChildMetadata(index, 'child', 'parent-a', 'session-a').filePath,
    firstPath,
  );
  assert.equal(
    findChildMetadata(index, 'child', 'parent-b', 'session-b').filePath,
    secondPath,
  );
  assert.equal(
    findChildMetadata(index, 'child', 'parent-a', 'session-b'),
    null,
  );
  assert.equal(
    findChildMetadata(index, 'missing', 'parent-a', 'session-a'),
    null,
  );
});

test('persists portable relative keys while returning native file paths', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session index portable-'),
  );
  const sessionsRoot = path.join(fixtureRoot, 'Codex Data', 'sessions');
  const cacheDirectory = path.join(fixtureRoot, 'Plugin Data', 'hook-cache');
  const filePath = writeRollout(
    sessionsRoot,
    '2026/08/20/rollout-root.jsonl',
    sessionMeta('root'),
  );
  const index = buildSessionFileIndex(sessionsRoot, cacheDirectory);
  const persistedText = fs.readFileSync(
    cacheFile(cacheDirectory),
    'utf8',
  );
  const persisted = JSON.parse(persistedText);

  assert.deepEqual(Object.keys(persisted.entries), [
    '2026/08/20/rollout-root.jsonl',
  ]);
  assert.equal(persistedText.includes(path.resolve(sessionsRoot)), false);
  assert.deepEqual(index.files, [filePath]);
  assert.equal(index.metadata[0].filePath, filePath);
});
