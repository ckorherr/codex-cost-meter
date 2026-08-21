'use strict';

const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);

function requiredFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
  return value;
}

function nonNegativeMilliseconds(value, fallback, name) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isFinite(candidate) || candidate < 0) {
    throw new RangeError(`${name} must be a non-negative number.`);
  }
  return candidate;
}

function retryDelays(value) {
  const delays = value === undefined ? DEFAULT_RETRY_DELAYS_MS : value;
  if (
    !Array.isArray(delays) ||
    !delays.every((delay) => Number.isFinite(delay) && delay >= 0)
  ) {
    throw new RangeError(
      'retryDelaysMs must be an array of non-negative numbers.',
    );
  }
  return [...delays];
}

function timerFunctions(options) {
  const timers = options.timers ?? {};
  return {
    setTimeout: requiredFunction(
      timers.setTimeout ?? setTimeout,
      'timers.setTimeout',
    ),
    clearTimeout: requiredFunction(
      timers.clearTimeout ?? clearTimeout,
      'timers.clearTimeout',
    ),
  };
}

function normalizedReason(reason, fallback) {
  return typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : fallback;
}

function normalizedPaths(value) {
  const candidates = typeof value === 'string' ? [value] : [...(value ?? [])];
  return [
    ...new Set(
      candidates.filter(
        (filePath) => typeof filePath === 'string' && filePath.length > 0,
      ),
    ),
  ].sort();
}

function publicError(error, now) {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    name: value.name || 'Error',
    message: 'Dashboard data could not be refreshed.',
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    at: new Date(now()).toISOString(),
  };
}

class DashboardRefreshCoordinator {
  constructor(options = {}) {
    this._build = requiredFunction(options.build, 'build');
    this._debounceMs = nonNegativeMilliseconds(
      options.debounceMs,
      DEFAULT_DEBOUNCE_MS,
      'debounceMs',
    );
    this._timers = timerFunctions(options);
    this._retryDelaysMs = retryDelays(options.retryDelaysMs);
    this._now = requiredFunction(options.now ?? Date.now, 'now');
    this._onBuildError =
      typeof options.onBuildError === 'function' ? options.onBuildError : null;
    this._onSubscriberError =
      typeof options.onSubscriberError === 'function'
        ? options.onSubscriberError
        : null;

    this._hasPayload = Object.hasOwn(options, 'initialPayload');
    this._payload = options.initialPayload;
    this._revision = 0;
    this._payloadRevision = 0;
    this._stale = !this._hasPayload;
    this._error = null;
    this._dirty = false;
    this._dirtyReasons = new Set();
    this._building = false;
    this._buildTimer = null;
    this._retryTimer = null;
    this._retryIndex = 0;
    this._drainPromise = null;
    this._idleWaiters = new Set();
    this._subscribers = new Set();
    this._closed = false;
    this._abortController = new AbortController();
  }

  getState() {
    return {
      revision: this._revision,
      payloadRevision: this._payloadRevision,
      hasPayload: this._hasPayload,
      payload: this._hasPayload ? this._payload : null,
      stale: this._stale,
      error: this._error,
      dirty: this._dirty,
      building: this._building,
      pendingReasons: [...this._dirtyReasons],
      subscriberCount: this._subscribers.size,
      closed: this._closed,
    };
  }

  subscribe(listener, options = {}) {
    requiredFunction(listener, 'listener');
    if (this._closed) {
      if (options.emitCurrent !== false) {
        this._callSubscriber(listener, {
          type: 'current',
          reasons: [],
          ...this.getState(),
        });
      }
      return () => {};
    }

    this._subscribers.add(listener);
    if (options.emitCurrent !== false) {
      this._callSubscriber(listener, {
        type: 'current',
        reasons: [],
        ...this.getState(),
      });
    }

    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this._subscribers.delete(listener);
    };
  }

  invalidate(reason = 'change') {
    if (this._closed) {
      return Promise.resolve(this.getState());
    }

    this._markDirty(normalizedReason(reason, 'change'));
    this._cancelRetryTimer();
    this._retryIndex = 0;
    if (!this._building) {
      this._scheduleBuild();
    }
    return this.whenIdle();
  }

  refresh(options = {}) {
    if (this._closed) {
      return Promise.resolve(this.getState());
    }

    const force = options.force !== false;
    if (
      !force &&
      this._hasPayload &&
      !this._stale &&
      !this._dirty &&
      !this._building
    ) {
      return Promise.resolve(this.getState());
    }
    if (!force && this._building && !this._dirty) {
      return this.whenIdle();
    }

    this._markDirty(normalizedReason(options.reason, 'refresh'));
    this._cancelRetryTimer();
    this._retryIndex = 0;
    this._cancelBuildTimer();
    this._startBuildDrain();
    return this.whenIdle();
  }

  whenIdle() {
    if (this._closed || this._isIdle()) {
      return Promise.resolve(this.getState());
    }
    return new Promise((resolve) => {
      this._idleWaiters.add(resolve);
    });
  }

  close() {
    if (this._closed) {
      return this.getState();
    }

    this._closed = true;
    this._cancelBuildTimer();
    this._cancelRetryTimer();
    this._dirty = false;
    this._dirtyReasons.clear();
    this._building = false;
    this._abortController.abort();
    this._publish('closed', []);
    this._subscribers.clear();
    this._settleIdleWaiters();
    return this.getState();
  }

  _isIdle() {
    return (
      !this._building &&
      this._buildTimer === null &&
      this._retryTimer === null &&
      !this._dirty
    );
  }

  _markDirty(reason) {
    this._dirty = true;
    this._dirtyReasons.add(reason);
    if (!this._stale) {
      this._stale = true;
      this._publish('dirty', [reason]);
    }
  }

  _scheduleBuild() {
    this._cancelBuildTimer();
    this._buildTimer = this._timers.setTimeout(() => {
      this._buildTimer = null;
      this._startBuildDrain();
    }, this._debounceMs);
  }

  _cancelBuildTimer() {
    if (this._buildTimer === null) {
      return;
    }
    this._timers.clearTimeout(this._buildTimer);
    this._buildTimer = null;
  }

  _startBuildDrain() {
    if (this._closed || this._building || !this._dirty) {
      return this._drainPromise;
    }

    this._cancelBuildTimer();
    this._building = true;
    const execution = this._drainBuilds().catch((error) => {
      if (!this._closed) {
        this._recordBuildError(error, ['coordinator']);
        this._scheduleRetry();
      }
    });
    this._drainPromise = execution.finally(() => {
      this._building = false;
      this._drainPromise = null;
      this._settleIdleWaiters();
    });
    return this._drainPromise;
  }

  async _drainBuilds() {
    while (!this._closed && this._dirty) {
      const reasons = [...this._dirtyReasons];
      this._dirty = false;
      this._dirtyReasons.clear();

      let payload;
      try {
        payload = await this._build({
          reasons,
          previousPayload: this._hasPayload ? this._payload : null,
          revision: this._revision,
          payloadRevision: this._payloadRevision,
          signal: this._abortController.signal,
        });
      } catch (error) {
        if (!this._closed) {
          this._recordBuildError(error, reasons);
          if (!this._dirty) {
            this._scheduleRetry();
          }
        }
        continue;
      }

      if (this._closed) {
        return;
      }
      this._payload = payload;
      this._hasPayload = true;
      this._error = null;
      this._retryIndex = 0;
      this._stale = this._dirty;
      this._publish('updated', reasons, { payloadChanged: true });
    }
  }

  _recordBuildError(error, reasons) {
    this._error = publicError(error, this._now);
    this._stale = true;
    this._publish('error', reasons);
    if (this._onBuildError) {
      try {
        this._onBuildError(error, this.getState());
      } catch {
        // Diagnostics must not break refresh state or retry behavior.
      }
    }
  }

  _scheduleRetry() {
    if (
      this._closed ||
      this._retryTimer !== null ||
      this._retryIndex >= this._retryDelaysMs.length
    ) {
      return;
    }
    const delay = this._retryDelaysMs[this._retryIndex];
    this._retryIndex += 1;
    this._retryTimer = this._timers.setTimeout(() => {
      this._retryTimer = null;
      if (this._closed) {
        this._settleIdleWaiters();
        return;
      }
      this._dirty = true;
      this._dirtyReasons.add('retry');
      this._startBuildDrain();
    }, delay);
  }

  _cancelRetryTimer() {
    if (this._retryTimer === null) {
      return;
    }
    this._timers.clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }

  _publish(type, reasons, options = {}) {
    this._revision += 1;
    if (options.payloadChanged) {
      this._payloadRevision = this._revision;
    }
    const event = Object.freeze({
      type,
      reasons: [...reasons],
      ...this.getState(),
    });
    for (const listener of [...this._subscribers]) {
      this._callSubscriber(listener, event);
    }
  }

  _callSubscriber(listener, event) {
    try {
      const result = listener(event);
      if (result && typeof result.then === 'function') {
        result.catch((error) => this._reportSubscriberError(error, listener));
      }
    } catch (error) {
      this._reportSubscriberError(error, listener);
    }
  }

  _reportSubscriberError(error, listener) {
    if (this._closed || !this._onSubscriberError) {
      return;
    }
    try {
      this._onSubscriberError(error, listener);
    } catch {
      // A broken diagnostics callback must not break other subscribers.
    }
  }

  _settleIdleWaiters() {
    if (!this._closed && !this._isIdle()) {
      return;
    }
    const state = this.getState();
    for (const resolve of this._idleWaiters) {
      resolve(state);
    }
    this._idleWaiters.clear();
  }
}

class DashboardFileInvalidator {
  constructor(options = {}) {
    this._invalidate = requiredFunction(options.invalidate, 'invalidate');
    this._directories =
      typeof options.directories === 'function'
        ? options.directories
        : () => options.directories ?? [];
    this._signature =
      typeof options.signature === 'function'
        ? options.signature
        : async () => null;
    this._signatureEquals =
      typeof options.signatureEquals === 'function'
        ? options.signatureEquals
        : isDeepStrictEqual;
    this._watch = requiredFunction(
      options.watch ?? fs.watch.bind(fs),
      'watch',
    );
    this._watchOptions = {
      persistent: false,
      ...(options.watchOptions ?? {}),
    };
    this._pollIntervalMs = nonNegativeMilliseconds(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
    );
    this._timers = timerFunctions(options);
    this._onError =
      typeof options.onError === 'function' ? options.onError : null;
    this._pollReason = normalizedReason(
      options.pollReason,
      'filesystem-poll',
    );
    this._watchReason = normalizedReason(
      options.watchReason,
      'filesystem-watch',
    );

    this._watchers = new Map();
    this._pollTimer = null;
    this._pollPromise = null;
    this._pollAgain = false;
    this._hasSignature = false;
    this._lastSignature = undefined;
    this._clients = 0;
    this._manual = false;
    this._active = false;
    this._closed = false;
    this._epoch = 0;
  }

  getState() {
    return {
      active: this._active,
      clients: this._clients,
      manual: this._manual,
      watching: [...this._watchers.keys()],
      polling: this._pollPromise !== null,
      hasSignature: this._hasSignature,
      closed: this._closed,
    };
  }

  retainClient() {
    if (this._closed) {
      return () => {};
    }
    this._clients += 1;
    this._updateActivation();
    let retained = true;
    return () => {
      if (!retained) {
        return;
      }
      retained = false;
      this._clients = Math.max(0, this._clients - 1);
      this._updateActivation();
    };
  }

  start() {
    if (this._closed) {
      return;
    }
    this._manual = true;
    this._updateActivation();
  }

  stop() {
    this._manual = false;
    this._updateActivation();
  }

  pollNow() {
    if (this._closed || !this._active) {
      return Promise.resolve(this.getState());
    }
    this._cancelPollTimer();
    if (this._pollPromise) {
      this._pollAgain = true;
      return this._pollPromise;
    }

    const epoch = this._epoch;
    this._pollPromise = this._drainPolls(epoch).finally(() => {
      this._pollPromise = null;
      if (this._closed || !this._active) {
        return;
      }
      if (this._pollAgain || epoch !== this._epoch) {
        this._pollAgain = false;
        void this.pollNow();
        return;
      }
      this._schedulePoll();
    });
    return this._pollPromise;
  }

  close() {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this._active = false;
    this._manual = false;
    this._clients = 0;
    this._epoch += 1;
    this._pollAgain = false;
    this._cancelPollTimer();
    this._closeWatchers();
  }

  _updateActivation() {
    const active = !this._closed && (this._manual || this._clients > 0);
    if (active === this._active) {
      return;
    }

    this._active = active;
    this._epoch += 1;
    if (!active) {
      this._pollAgain = false;
      this._cancelPollTimer();
      this._closeWatchers();
      return;
    }
    void this.pollNow();
  }

  async _drainPolls(epoch) {
    do {
      this._pollAgain = false;
      await this._pollOnce(epoch);
    } while (
      this._pollAgain &&
      !this._closed &&
      this._active &&
      epoch === this._epoch
    );
  }

  async _pollOnce(epoch) {
    await this._syncWatchers(epoch);
    if (this._closed || !this._active || epoch !== this._epoch) {
      return;
    }

    let signature;
    try {
      signature = await this._signature();
    } catch (error) {
      if (!this._closed && this._active && epoch === this._epoch) {
        this._report(error, { operation: 'signature' });
      }
      return;
    }
    if (this._closed || !this._active || epoch !== this._epoch) {
      return;
    }

    if (!this._hasSignature) {
      this._lastSignature = signature;
      this._hasSignature = true;
      return;
    }
    if (this._signatureEquals(this._lastSignature, signature)) {
      return;
    }

    this._lastSignature = signature;
    this._callInvalidate(this._pollReason);
  }

  async _syncWatchers(epoch) {
    let directories;
    try {
      const value = await this._directories();
      directories = normalizedPaths(value);
    } catch (error) {
      if (!this._closed && this._active && epoch === this._epoch) {
        this._report(error, { operation: 'directories' });
      }
      return;
    }
    if (this._closed || !this._active || epoch !== this._epoch) {
      return;
    }

    const wanted = new Set(directories);
    for (const [directory, record] of this._watchers) {
      if (!wanted.has(directory)) {
        this._dropWatcher(directory, record);
      }
    }

    for (const directory of directories) {
      if (this._watchers.has(directory)) {
        continue;
      }
      try {
        const watcher = this._watch(
          directory,
          this._watchOptions,
          () => this._handleWatchHint(),
        );
        const record = { watcher };
        this._watchers.set(directory, record);
        if (typeof watcher.on === 'function') {
          watcher.on('error', (error) => {
            if (this._watchers.get(directory) !== record) {
              return;
            }
            this._dropWatcher(directory, record);
            this._report(error, { operation: 'watch', directory });
          });
          watcher.on('close', () => {
            if (this._watchers.get(directory) !== record) {
              return;
            }
            this._watchers.delete(directory);
          });
        }
      } catch (error) {
        this._report(error, { operation: 'watch', directory });
      }
    }
  }

  _handleWatchHint() {
    if (this._closed || !this._active) {
      return;
    }
    this._callInvalidate(this._watchReason);
    void this.pollNow();
  }

  _callInvalidate(reason) {
    try {
      const result = this._invalidate(reason);
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          if (!this._closed && this._active) {
            this._report(error, { operation: 'invalidate' });
          }
        });
      }
    } catch (error) {
      this._report(error, { operation: 'invalidate' });
    }
  }

  _schedulePoll() {
    if (
      this._pollIntervalMs === 0 ||
      this._pollTimer !== null ||
      this._closed ||
      !this._active
    ) {
      return;
    }
    this._pollTimer = this._timers.setTimeout(() => {
      this._pollTimer = null;
      void this.pollNow();
    }, this._pollIntervalMs);
  }

  _cancelPollTimer() {
    if (this._pollTimer === null) {
      return;
    }
    this._timers.clearTimeout(this._pollTimer);
    this._pollTimer = null;
  }

  _dropWatcher(directory, record) {
    if (this._watchers.get(directory) !== record) {
      return;
    }
    this._watchers.delete(directory);
    try {
      record.watcher.close();
    } catch (error) {
      this._report(error, { operation: 'watch-close', directory });
    }
  }

  _closeWatchers() {
    for (const [directory, record] of [...this._watchers]) {
      this._dropWatcher(directory, record);
    }
  }

  _report(error, context) {
    if (!this._onError) {
      return;
    }
    try {
      this._onError(error, context);
    } catch {
      // Diagnostics are optional and must not disable fallback polling.
    }
  }
}

async function statPathsSignature(paths, options = {}) {
  const stat = requiredFunction(
    options.stat ?? fs.promises.stat.bind(fs.promises),
    'stat',
  );
  const normalized = normalizedPaths(paths);

  const entries = await Promise.all(
    normalized.map(async (filePath) => {
      try {
        const value = await stat(filePath, { bigint: true });
        const nanoseconds = (field, millisecondsField) => {
          if (typeof value[field] === 'bigint') {
            return value[field].toString();
          }
          return String(
            Math.max(0, Math.round(Number(value[millisecondsField] ?? 0) * 1e6)),
          );
        };
        return {
          path: filePath,
          kind: value.isDirectory()
            ? 'directory'
            : value.isFile()
              ? 'file'
              : 'other',
          dev: String(value.dev ?? 0),
          ino: String(value.ino ?? 0),
          size: String(value.size ?? 0),
          mtime_ns: nanoseconds('mtimeNs', 'mtimeMs'),
          ctime_ns: nanoseconds('ctimeNs', 'ctimeMs'),
        };
      } catch (error) {
        return {
          path: filePath,
          error:
            typeof error?.code === 'string'
              ? error.code
              : error?.name ?? 'Error',
        };
      }
    }),
  );
  return JSON.stringify(entries);
}

function createStatSignature(paths, options = {}) {
  const provider = typeof paths === 'function' ? paths : () => paths;
  return async () => statPathsSignature(await provider(), options);
}

function createDashboardRefreshCoordinator(options) {
  return new DashboardRefreshCoordinator(options);
}

function createDashboardFileInvalidator(options) {
  return new DashboardFileInvalidator(options);
}

module.exports = {
  DashboardFileInvalidator,
  DashboardRefreshCoordinator,
  createDashboardFileInvalidator,
  createDashboardRefreshCoordinator,
  createStatSignature,
  statPathsSignature,
};
