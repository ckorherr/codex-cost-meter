'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createDashboardFileInvalidator,
  createDashboardRefreshCoordinator,
  statPathsSignature,
} = require('../plugins/codex-cost-meter/lib/dashboard-live');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeTimers() {
  let nextId = 1;
  let order = 0;
  const pending = new Map();

  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay, order });
      order += 1;
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pendingCount() {
      return pending.size;
    },
    runNext() {
      const next = [...pending.entries()].sort(
        ([, left], [, right]) =>
          left.delay - right.delay || left.order - right.order,
      )[0];
      assert.ok(next, 'expected a pending timer');
      pending.delete(next[0]);
      next[1].callback();
    },
  };
}

async function flushAsyncWork(attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('coalesces a burst into one trailing build with all dirty reasons', async () => {
  const timers = fakeTimers();
  const builds = [];
  const coordinator = createDashboardRefreshCoordinator({
    debounceMs: 250,
    timers,
    build(context) {
      builds.push(context.reasons);
      return { build: builds.length };
    },
  });

  const idle = coordinator.invalidate('ledger');
  coordinator.invalidate('settings');
  coordinator.invalidate('ledger');

  assert.equal(timers.pendingCount(), 1);
  assert.equal(builds.length, 0);
  timers.runNext();
  await idle;

  assert.deepEqual(builds, [['ledger', 'settings']]);
  assert.deepEqual(coordinator.getState().payload, { build: 1 });
  assert.equal(coordinator.getState().stale, false);
  assert.equal(coordinator.getState().revision, 1);
  coordinator.close();
});

test('keeps builds single-flight and reruns once when dirtied during a build', async () => {
  const firstBuild = deferred();
  let calls = 0;
  let activeBuilds = 0;
  let maximumActiveBuilds = 0;
  const reasons = [];
  const coordinator = createDashboardRefreshCoordinator({
    async build(context) {
      calls += 1;
      reasons.push(context.reasons);
      activeBuilds += 1;
      maximumActiveBuilds = Math.max(maximumActiveBuilds, activeBuilds);
      try {
        if (calls === 1) {
          return await firstBuild.promise;
        }
        return { build: calls };
      } finally {
        activeBuilds -= 1;
      }
    },
  });

  const refreshed = coordinator.refresh({ reason: 'initial' });
  assert.equal(calls, 1);
  coordinator.invalidate('generation');
  coordinator.invalidate('settings');
  firstBuild.resolve({ build: 1 });
  await refreshed;

  assert.equal(calls, 2);
  assert.equal(maximumActiveBuilds, 1);
  assert.deepEqual(reasons, [
    ['initial'],
    ['generation', 'settings'],
  ]);
  assert.deepEqual(coordinator.getState().payload, { build: 2 });
  assert.equal(coordinator.getState().stale, false);
  coordinator.close();
});

test('concurrent cached requests share an in-flight initial build', async () => {
  const firstBuild = deferred();
  let calls = 0;
  const coordinator = createDashboardRefreshCoordinator({
    async build() {
      calls += 1;
      return firstBuild.promise;
    },
  });

  const first = coordinator.refresh({ force: false, reason: 'request' });
  const second = coordinator.refresh({ force: false, reason: 'request' });
  assert.equal(calls, 1);

  firstBuild.resolve({ shared: true });
  const [firstState, secondState] = await Promise.all([first, second]);
  assert.deepEqual(firstState.payload, { shared: true });
  assert.deepEqual(secondState.payload, { shared: true });
  assert.equal(calls, 1);
  coordinator.close();
});

test('reports stale failures without replacing the last-good payload', async () => {
  const timers = fakeTimers();
  let mode = 'good';
  let value = 1;
  const events = [];
  const coordinator = createDashboardRefreshCoordinator({
    timers,
    retryDelaysMs: [],
    now: () => Date.parse('2026-08-21T10:00:00.000Z'),
    build() {
      if (mode === 'fail') {
        const error = new Error('ledger was changing');
        error.code = 'EAGAIN';
        throw error;
      }
      return { value };
    },
  });
  coordinator.subscribe((event) => events.push(event), {
    emitCurrent: false,
  });

  await coordinator.refresh({ reason: 'initial' });
  const good = coordinator.getState();
  mode = 'fail';
  const failed = coordinator.invalidate('generation');
  timers.runNext();
  await failed;

  const stale = coordinator.getState();
  assert.deepEqual(stale.payload, { value: 1 });
  assert.equal(stale.payloadRevision, good.payloadRevision);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.error, {
    name: 'Error',
    message: 'Dashboard data could not be refreshed.',
    code: 'EAGAIN',
    at: '2026-08-21T10:00:00.000Z',
  });
  assert.ok(stale.revision > good.revision);
  assert.equal(events.at(-1).type, 'error');

  mode = 'good';
  value = 2;
  await coordinator.refresh({ reason: 'retry' });
  assert.deepEqual(coordinator.getState().payload, { value: 2 });
  assert.equal(coordinator.getState().stale, false);
  assert.equal(coordinator.getState().error, null);
  coordinator.close();
});

test('retries a transient build failure with injected backoff timers', async () => {
  const timers = fakeTimers();
  const rawErrors = [];
  let calls = 0;
  const coordinator = createDashboardRefreshCoordinator({
    timers,
    retryDelaysMs: [100, 500],
    build() {
      calls += 1;
      if (calls === 1) {
        throw new Error('/private/path/turns.jsonl was changing');
      }
      return { recovered: true };
    },
    onBuildError(error) {
      rawErrors.push(error.message);
    },
  });

  const refreshed = coordinator.refresh({ reason: 'generation' });
  await flushAsyncWork();
  assert.equal(coordinator.getState().stale, true);
  assert.equal(coordinator.getState().hasPayload, false);
  assert.equal(timers.pendingCount(), 1);
  assert.doesNotMatch(
    coordinator.getState().error.message,
    /private|turns\.jsonl/,
  );

  timers.runNext();
  await refreshed;
  assert.equal(calls, 2);
  assert.deepEqual(coordinator.getState().payload, { recovered: true });
  assert.equal(coordinator.getState().stale, false);
  assert.deepEqual(rawErrors, ['/private/path/turns.jsonl was changing']);
  coordinator.close();
});

test('notifies multiple subscribers independently with monotonic revisions', async () => {
  let build = 0;
  const first = [];
  const second = [];
  const subscriberErrors = [];
  const coordinator = createDashboardRefreshCoordinator({
    build() {
      build += 1;
      return { build };
    },
    onSubscriberError(error) {
      subscriberErrors.push(error.message);
    },
  });

  const unsubscribeFirst = coordinator.subscribe(async (event) => {
    first.push(event);
    if (event.type === 'updated') {
      throw new Error('closed SSE response');
    }
  }, { emitCurrent: false });
  coordinator.subscribe((event) => second.push(event), {
    emitCurrent: false,
  });

  await coordinator.refresh({ reason: 'one' });
  await flushAsyncWork();
  unsubscribeFirst();
  await coordinator.refresh({ reason: 'two' });

  assert.deepEqual(first.map((event) => event.type), ['updated']);
  assert.deepEqual(
    second.map((event) => event.type),
    ['updated', 'dirty', 'updated'],
  );
  assert.deepEqual(subscriberErrors, ['closed SSE response']);
  assert.ok(
    second.every(
      (event, index) => index === 0 || event.revision > second[index - 1].revision,
    ),
  );
  coordinator.close();
});

test('polling detects changes missed by watchers and pauses without clients', async () => {
  const timers = fakeTimers();
  const invalidations = [];
  let signature = 'version-1';
  let signatureCalls = 0;
  const invalidator = createDashboardFileInvalidator({
    timers,
    pollIntervalMs: 1_000,
    directories: [],
    signature() {
      signatureCalls += 1;
      return signature;
    },
    invalidate(reason) {
      invalidations.push(reason);
    },
  });

  const release = invalidator.retainClient();
  await flushAsyncWork();
  assert.equal(invalidator.getState().hasSignature, true);
  assert.equal(signatureCalls, 1);
  assert.equal(timers.pendingCount(), 1);

  signature = 'version-2';
  timers.runNext();
  await flushAsyncWork();
  assert.deepEqual(invalidations, ['filesystem-poll']);
  assert.equal(signatureCalls, 2);

  release();
  assert.equal(invalidator.getState().active, false);
  assert.equal(timers.pendingCount(), 0);
  signature = 'version-3';
  await flushAsyncWork();
  assert.equal(signatureCalls, 2);

  const releaseAgain = invalidator.retainClient();
  await flushAsyncWork();
  assert.deepEqual(invalidations, [
    'filesystem-poll',
    'filesystem-poll',
  ]);
  assert.equal(signatureCalls, 3);
  releaseAgain();
  invalidator.close();
});

test('polling is non-overlapping and coalesces requests made in flight', async () => {
  const timers = fakeTimers();
  const blocked = deferred();
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let block = false;
  const invalidator = createDashboardFileInvalidator({
    timers,
    directories: [],
    async signature() {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (block) {
          block = false;
          await blocked.promise;
        }
        return `signature-${calls}`;
      } finally {
        active -= 1;
      }
    },
    invalidate() {},
  });

  const release = invalidator.retainClient();
  await flushAsyncWork();
  block = true;
  timers.runNext();
  await flushAsyncWork(1);
  assert.equal(active, 1);
  const currentPoll = invalidator.pollNow();
  invalidator.pollNow();
  assert.equal(active, 1);
  blocked.resolve();
  await currentPoll;

  assert.equal(maximumActive, 1);
  assert.equal(calls, 3);
  release();
  invalidator.close();
});

test('reactivating during an old poll starts a fresh activation poll', async () => {
  const timers = fakeTimers();
  const firstPoll = deferred();
  let calls = 0;
  const invalidator = createDashboardFileInvalidator({
    timers,
    directories: [],
    async signature() {
      calls += 1;
      if (calls === 1) {
        await firstPoll.promise;
      }
      return `signature-${calls}`;
    },
    invalidate() {},
  });

  const releaseFirst = invalidator.retainClient();
  await flushAsyncWork(1);
  assert.equal(calls, 1);
  releaseFirst();
  const releaseSecond = invalidator.retainClient();
  firstPoll.resolve();
  await flushAsyncWork();

  assert.equal(calls, 2);
  assert.equal(invalidator.getState().active, true);
  assert.equal(invalidator.getState().hasSignature, true);
  assert.equal(timers.pendingCount(), 1);
  releaseSecond();
  invalidator.close();
});

class FakeWatcher extends EventEmitter {
  constructor(listener) {
    super();
    this.listener = listener;
    this.closed = false;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit('close');
  }
}

test('watch errors fall back to polling, re-arm, and shutdown cleans resources', async () => {
  const timers = fakeTimers();
  const watchers = [];
  const invalidations = [];
  const diagnostics = [];
  let signature = 'one';
  const invalidator = createDashboardFileInvalidator({
    timers,
    directories: ['/data/usage/2026-08'],
    signature: () => signature,
    watch(_directory, _options, listener) {
      const watcher = new FakeWatcher(listener);
      watchers.push(watcher);
      return watcher;
    },
    invalidate(reason) {
      invalidations.push(reason);
    },
    onError(error, context) {
      diagnostics.push([error.message, context.operation]);
    },
  });

  const release = invalidator.retainClient();
  await flushAsyncWork();
  assert.equal(watchers.length, 1);
  watchers[0].listener('change', '.generation');
  await flushAsyncWork();
  assert.deepEqual(invalidations, ['filesystem-watch']);

  watchers[0].emit('error', new Error('watch unavailable'));
  await flushAsyncWork();
  assert.equal(watchers[0].closed, true);
  assert.equal(watchers.length, 1);
  assert.deepEqual(invalidator.getState().watching, []);
  assert.deepEqual(diagnostics, [['watch unavailable', 'watch']]);

  signature = 'two';
  timers.runNext();
  await flushAsyncWork();
  assert.equal(watchers.length, 2);
  assert.ok(invalidations.includes('filesystem-poll'));

  const activeWatcher = watchers.at(-1);
  release();
  assert.equal(activeWatcher.closed, true);
  assert.equal(timers.pendingCount(), 0);
  invalidator.close();
  activeWatcher.listener('change', '.generation');
  await flushAsyncWork();
  assert.equal(invalidations.at(-1), 'filesystem-poll');
});

test('retries immediately failing watchers only on the polling cadence', async () => {
  const timers = fakeTimers();
  let attempts = 0;
  const invalidator = createDashboardFileInvalidator({
    timers,
    directories: ['/data/usage/2026-08'],
    signature: () => 'stable',
    watch(_directory, _options, _listener) {
      attempts += 1;
      const watcher = new FakeWatcher(() => {});
      queueMicrotask(() => watcher.emit('error', new Error('unsupported')));
      return watcher;
    },
    invalidate() {},
  });

  const release = invalidator.retainClient();
  await flushAsyncWork();
  assert.equal(attempts, 1);
  assert.equal(timers.pendingCount(), 1);

  timers.runNext();
  await flushAsyncWork();
  assert.equal(attempts, 2);
  assert.equal(timers.pendingCount(), 1);
  release();
  invalidator.close();
});

test('shutdown cancels coordinator work and aborts an in-flight build', async () => {
  const timers = fakeTimers();
  let builds = 0;
  let observedSignal;
  const blocked = deferred();
  const events = [];
  const coordinator = createDashboardRefreshCoordinator({
    timers,
    async build(context) {
      builds += 1;
      observedSignal = context.signal;
      return blocked.promise;
    },
  });
  coordinator.subscribe((event) => events.push(event.type), {
    emitCurrent: false,
  });

  coordinator.invalidate('debounced');
  assert.equal(timers.pendingCount(), 1);
  coordinator.close();
  assert.equal(timers.pendingCount(), 0);
  assert.equal(builds, 0);
  assert.deepEqual(events, ['closed']);

  const running = createDashboardRefreshCoordinator({
    build(context) {
      observedSignal = context.signal;
      return blocked.promise;
    },
  });
  running.refresh();
  assert.equal(observedSignal.aborted, false);
  running.close();
  assert.equal(observedSignal.aborted, true);
  blocked.resolve({ ignored: true });
  await flushAsyncWork();
  assert.equal(running.getState().hasPayload, false);
});

test('shutdown suppresses late polling diagnostics and zero disables fallback', async () => {
  const timers = fakeTimers();
  const pendingSignature = deferred();
  const diagnostics = [];
  const invalidator = createDashboardFileInvalidator({
    timers,
    pollIntervalMs: 0,
    directories: [],
    signature: () => pendingSignature.promise,
    invalidate() {},
    onError(error) {
      diagnostics.push(error.message);
    },
  });

  invalidator.retainClient();
  await flushAsyncWork(1);
  invalidator.close();
  pendingSignature.reject(new Error('late cross-filesystem failure'));
  await flushAsyncWork();

  assert.deepEqual(diagnostics, []);
  assert.equal(timers.pendingCount(), 0);
});

test('builds deterministic cheap stat signatures including missing paths', async () => {
  const signature = await statPathsSignature(['/missing', '/settings'], {
    async stat(filePath) {
      if (filePath === '/missing') {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return {
        dev: 1n,
        ino: 2n,
        size: 3n,
        mtimeNs: 4n,
        ctimeNs: 5n,
        isDirectory: () => false,
        isFile: () => true,
      };
    },
  });

  assert.deepEqual(JSON.parse(signature), [
    { path: '/missing', error: 'ENOENT' },
    {
      path: '/settings',
      kind: 'file',
      dev: '1',
      ino: '2',
      size: '3',
      mtime_ns: '4',
      ctime_ns: '5',
    },
  ]);
});
