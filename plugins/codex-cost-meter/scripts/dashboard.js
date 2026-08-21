'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  loadDashboardTaskNames,
  parseTaskNameSourceArguments,
  resolveSessionIndexPath,
} = require('../lib/dashboard-task-names');
const {
  createDashboardFileInvalidator,
  createDashboardRefreshCoordinator,
  createStatSignature,
} = require('../lib/dashboard-live');

const DEFAULT_PORT = 43_117;
const DEFAULT_LIVE_POLL_INTERVAL_MS = 3_000;
const MAX_EVENT_CLIENTS = 16;
const MAX_JSON_BYTES = 16 * 1024;
const CSRF_HEADER = 'x-codex-csrf-token';
const DASHBOARD_ROOT = path.resolve(__dirname, '..', 'dashboard');

const STATIC_ASSETS = new Map([
  [
    '/',
    {
      filePath: path.join(DASHBOARD_ROOT, 'index.html'),
      contentType: 'text/html; charset=utf-8',
    },
  ],
  [
    '/app.js',
    {
      filePath: path.join(DASHBOARD_ROOT, 'app.js'),
      contentType: 'text/javascript; charset=utf-8',
    },
  ],
  [
    '/styles.css',
    {
      filePath: path.join(DASHBOARD_ROOT, 'styles.css'),
      contentType: 'text/css; charset=utf-8',
    },
  ],
]);

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

function loadRuntimeData() {
  return require('../lib/runtime-data.js');
}

function setSecurityHeaders(response, extraHeaders = {}) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    response.setHeader(name, value);
  }
}

function sendBuffer(response, statusCode, body, contentType, extraHeaders = {}) {
  setSecurityHeaders(response, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.statusCode = statusCode;
  response.end(body);
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  sendBuffer(
    response,
    statusCode,
    Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'),
    'application/json; charset=utf-8',
    extraHeaders,
  );
}

function sendText(response, statusCode, message, extraHeaders = {}) {
  sendBuffer(
    response,
    statusCode,
    Buffer.from(`${message}\n`, 'utf8'),
    'text/plain; charset=utf-8',
    extraHeaders,
  );
}

function allowedAuthorities(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    return new Set();
  }

  const portSuffix = address.port === 80 ? '' : `:${address.port}`;
  return new Set([
    `127.0.0.1${portSuffix}`,
    `localhost${portSuffix}`,
  ]);
}

function validHost(request, server) {
  const host = request.headers.host;
  return (
    typeof host === 'string' &&
    allowedAuthorities(server).has(host.trim().toLowerCase())
  );
}

function sameOrigin(request) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  return (
    typeof host === 'string' &&
    typeof origin === 'string' &&
    origin === `http://${host.trim().toLowerCase()}`
  );
}

function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined) {
      if (!/^\d+$/.test(contentLength)) {
        reject(Object.assign(new Error('Invalid Content-Length.'), {
          statusCode: 400,
        }));
        return;
      }
      if (Number(contentLength) > MAX_JSON_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), {
          statusCode: 413,
        }));
        request.resume();
        return;
      }
    }

    let byteLength = 0;
    const chunks = [];
    let settled = false;

    request.on('data', (chunk) => {
      if (settled) {
        return;
      }
      byteLength += chunk.length;
      if (byteLength > MAX_JSON_BYTES) {
        settled = true;
        reject(Object.assign(new Error('Request body is too large.'), {
          statusCode: 413,
        }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          throw new TypeError('Settings must be a JSON object.');
        }
        resolve(parsed);
      } catch (error) {
        reject(Object.assign(new Error('Malformed JSON request body.', {
          cause: error,
        }), {
          statusCode: 400,
        }));
      }
    });

    request.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function nowMilliseconds(options) {
  if (typeof options.nowMs === 'function') {
    return options.nowMs();
  }
  if (Number.isFinite(options.nowMs)) {
    return options.nowMs;
  }
  return Date.now();
}

function formattedNanos(nanos, formatEuroCost) {
  const normalized = Number(nanos);
  return formatEuroCost(
    Number.isFinite(normalized) ? normalized / 1_000_000_000 : 0,
  );
}

function presentUsage(usage) {
  const value = usage && typeof usage === 'object' ? usage : {};
  return {
    ...value,
    display_total_tokens: Number(value.total_tokens ?? 0).toLocaleString(
      'en-US',
    ),
  };
}

function presentCostGroup(group, formatEuroCost) {
  if (!group || typeof group !== 'object') {
    return group;
  }
  return {
    ...group,
    display_cost: formattedNanos(group.cost_eur_nanos, formatEuroCost),
    usage: presentUsage(group.usage),
  };
}

function presentBudget(budget, formatEuroCost) {
  if (!budget || typeof budget !== 'object') {
    return budget;
  }
  const formatNullable = (value) => (
    value === null || value === undefined
      ? null
      : formattedNanos(value, formatEuroCost)
  );
  return {
    ...budget,
    display_limit: formatNullable(budget.limit_eur_nanos),
    display_spent: formatNullable(budget.spent_eur_nanos),
    display_remaining: formatNullable(budget.remaining_eur_nanos),
    display_over: formatNullable(budget.over_eur_nanos),
  };
}

function presentSnapshot(snapshot, formatEuroCost) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const budgets = value.budgets ?? {};
  const taskScopes = value.task_scopes ?? {};
  return {
    ...value,
    today: presentCostGroup(value.today, formatEuroCost),
    month: presentCostGroup(value.month, formatEuroCost),
    seven_days: (value.seven_days ?? []).map((day) =>
      presentCostGroup(day, formatEuroCost),
    ),
    budgets: {
      ...budgets,
      daily: presentBudget(budgets.daily, formatEuroCost),
      monthly: presentBudget(budgets.monthly, formatEuroCost),
      display_forecast: formattedNanos(
        budgets.forecast_eur_nanos,
        formatEuroCost,
      ),
    },
    by_model: (value.by_model ?? []).map((group) =>
      presentCostGroup(group, formatEuroCost),
    ),
    by_session: (value.by_session ?? []).map((group) =>
      presentCostGroup(group, formatEuroCost),
    ),
    task_scopes: Object.fromEntries(
      ['today', 'seven_days', 'month'].map((scope) => [
        scope,
        (taskScopes[scope] ?? (scope === 'month' ? value.by_session : [])).map(
          (group) => presentCostGroup(group, formatEuroCost),
        ),
      ]),
    ),
    by_agent: {
      root: presentCostGroup(value.by_agent?.root, formatEuroCost),
      subagent: presentCostGroup(value.by_agent?.subagent, formatEuroCost),
      unattributed: presentCostGroup(
        value.by_agent?.unattributed,
        formatEuroCost,
      ),
    },
    recent_turns: (value.recent_turns ?? []).map((turn) =>
      presentCostGroup(turn, formatEuroCost),
    ),
  };
}

function taskNameOptions(options, dataRoot, runtimeData) {
  return {
    dataRoot,
    env: options.env ?? process.env,
    codexHome: options.codexHome,
    sessionIndexPath: options.sessionIndexPath,
    ...(typeof runtimeData.safeTaskKey === 'function'
      ? { safeTaskKey: runtimeData.safeTaskKey }
      : {}),
  };
}

function enrichTaskNames(snapshot, taskNames) {
  const names = taskNames.names ?? new Map();
  const resolved = new Set();
  const enrichGroup = (group) => {
    const friendlyName = names.get(group.key);
    if (friendlyName) {
      resolved.add(group.key);
    }
    return {
      ...group,
      display_label: friendlyName ?? group.label,
      has_friendly_name: Boolean(friendlyName),
    };
  };
  const enrichTurn = (turn) => {
    const friendlyName = names.get(turn.task_key);
    if (friendlyName) {
      resolved.add(turn.task_key);
    }
    return {
      ...turn,
      display_task_label: friendlyName ?? turn.task_label,
      has_friendly_name: Boolean(friendlyName),
    };
  };
  const taskScopes = Object.fromEntries(
    Object.entries(snapshot.task_scopes ?? {}).map(([scope, groups]) => [
      scope,
      groups.map(enrichGroup),
    ]),
  );
  return {
    ...snapshot,
    by_session: (snapshot.by_session ?? []).map(enrichGroup),
    task_scopes: taskScopes,
    recent_turns: (snapshot.recent_turns ?? []).map(enrichTurn),
    task_names: {
      available: taskNames.available === true,
      resolved: resolved.size,
    },
    diagnostics: [
      ...(snapshot.diagnostics ?? []),
      ...(taskNames.available === true ? taskNames.diagnostics ?? [] : []),
    ],
  };
}

function publicSettingsResult(result) {
  return {
    settings: result.settings,
    diagnostics: result.diagnostics ?? [],
    exists: Boolean(result.exists),
    supported: result.supported !== false,
    ...(result.saved === undefined ? {} : { saved: Boolean(result.saved) }),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function usageMonthDirectories(dataRoot) {
  const usageRoot = path.join(dataRoot, 'usage');
  try {
    return fs
      .readdirSync(usageRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name),
      )
      .map((entry) => path.join(usageRoot, entry.name))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function dashboardWatchDirectories(
  dataRoot,
  monthDirectories = usageMonthDirectories(dataRoot),
) {
  const roots = [dataRoot, path.join(dataRoot, 'usage')].filter((directory) => {
    try {
      return fs.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  });
  return [...roots, ...monthDirectories];
}

function dashboardSignaturePaths(
  dataRoot,
  sessionIndexPath,
  monthDirectories = usageMonthDirectories(dataRoot),
) {
  const usageRoot = path.join(dataRoot, 'usage');
  return [
    path.join(dataRoot, 'settings.json'),
    usageRoot,
    ...monthDirectories.flatMap((directory) => [
      path.join(directory, '.generation'),
      path.join(directory, 'turns.jsonl'),
    ]),
    ...(sessionIndexPath ? [sessionIndexPath] : []),
  ];
}

function dashboardWatchEventRelevant(dataRoot, directory, filename) {
  if (filename === null || filename === undefined) {
    return true;
  }
  const name = Buffer.isBuffer(filename)
    ? filename.toString('utf8')
    : String(filename);
  const usageRoot = path.join(dataRoot, 'usage');
  if (directory === dataRoot) {
    return name === 'settings.json' || name === 'usage';
  }
  if (directory === usageRoot) {
    return /^\d{4}-\d{2}$/.test(name);
  }
  return name === '.generation' || name === 'turns.jsonl';
}

function publicLiveState(state) {
  return {
    revision: state.revision,
    payload_revision: state.payloadRevision,
    stale: state.stale,
    refreshing:
      state.dirty || (state.building && state.type !== 'updated'),
    error: Boolean(state.error),
  };
}

function createDashboardServer(options = {}) {
  const runtimeData = options.runtimeData ?? loadRuntimeData();
  const dataRoot = runtimeData.resolveDataRoot({
    dataRoot: options.dataDir,
    pluginData: options.dataDir,
    dataDir: options.dataDir,
    env: options.env ?? process.env,
  });
  const csrfToken =
    options.csrfToken ?? crypto.randomBytes(32).toString('base64url');
  const recentLimit = options.recentLimit ?? 50;
  const assets = new Map(
    [...STATIC_ASSETS].map(([route, asset]) => [
      route,
      {
        contentType: asset.contentType,
        body: fs.readFileSync(asset.filePath),
      },
    ]),
  );
  const taskNamesOptions = taskNameOptions(options, dataRoot, runtimeData);
  const sessionIndexPath = resolveSessionIndexPath(taskNamesOptions);
  const eventResponses = new Set();

  let server;

  function loadDashboard() {
    const settingsResult = runtimeData.loadSettings(dataRoot);
    const nowMs = nowMilliseconds(options);
    const snapshot = runtimeData.buildSnapshot(dataRoot, {
      settings: settingsResult.settings,
      now: nowMs,
      nowMs,
      fullHistory: true,
      recentLimit,
    });
    const settingsPayload = {
      settings: settingsResult.settings,
      settings_diagnostics: settingsResult.diagnostics ?? [],
      settings_supported: settingsResult.supported !== false,
    };
    if (
      snapshot.complete === false &&
      snapshot.lower_bound?.available !== true
    ) {
      return {
        schema: snapshot.schema,
        generated_at: snapshot.generated_at,
        timezone: snapshot.timezone,
        complete: false,
        diagnostics: snapshot.diagnostics ?? [],
        ...settingsPayload,
      };
    }
    const taskNames = loadDashboardTaskNames(
      taskNamesOptions,
    );
    return {
      ...enrichTaskNames(
        presentSnapshot(snapshot, runtimeData.formatEuroCost),
        taskNames,
      ),
      ...settingsPayload,
    };
  }

  const refreshCoordinator = createDashboardRefreshCoordinator({
    build: loadDashboard,
    debounceMs: options.refreshDebounceMs,
    onBuildError(error) {
      if (options.debug) {
        process.stderr.write(`dashboard refresh: ${error.message}\n`);
      }
    },
  });
  let liveMonthDirectories = [];
  const fileInvalidator = createDashboardFileInvalidator({
    invalidate: (reason) => refreshCoordinator.invalidate(reason),
    directories: () => {
      liveMonthDirectories = usageMonthDirectories(dataRoot);
      return dashboardWatchDirectories(dataRoot, liveMonthDirectories);
    },
    signature: createStatSignature(() =>
      dashboardSignaturePaths(
        dataRoot,
        sessionIndexPath,
        liveMonthDirectories,
      ),
    ),
    watch(directory, watchOptions, listener) {
      return fs.watch(directory, watchOptions, (eventType, filename) => {
        if (dashboardWatchEventRelevant(dataRoot, directory, filename)) {
          listener(eventType, filename);
        }
      });
    },
    pollIntervalMs:
      options.pollIntervalMs ?? DEFAULT_LIVE_POLL_INTERVAL_MS,
    onError(error, context) {
      if (options.debug) {
        process.stderr.write(
          `dashboard ${context.operation}: ${error.message}\n`,
        );
      }
    },
  });

  async function dashboardPayload(force = false, reason = 'request') {
    const state = await refreshCoordinator.refresh({ force, reason });
    if (!state.hasPayload) {
      throw new Error('No dashboard snapshot is available.', {
        cause: state.error ?? undefined,
      });
    }
    return {
      ...state.payload,
      live: publicLiveState(state),
    };
  }

  function openEventStream(response) {
    if (eventResponses.size >= MAX_EVENT_CLIENTS) {
      sendJson(response, 503, { error: 'Too many dashboard event clients.' });
      return;
    }
    setSecurityHeaders(response, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.statusCode = 200;
    response.flushHeaders();
    response.write('retry: 3000\n\n');

    eventResponses.add(response);
    const releaseInvalidator = fileInvalidator.retainClient();
    const unsubscribe = refreshCoordinator.subscribe((event) => {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      const payload = {
        type: event.type,
        reasons: event.reasons,
        ...publicLiveState(event),
      };
      response.write(
        `id: ${event.revision}\nevent: dashboard\ndata: ${JSON.stringify(payload)}\n\n`,
      );
    });
    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      eventResponses.delete(response);
      unsubscribe();
      releaseInvalidator();
    };
    response.once('close', close);
    response.once('error', close);
  }

  async function handleRequest(request, response) {
    if (!validHost(request, server)) {
      sendJson(response, 403, { error: 'Invalid Host header.' });
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(response, 400, { error: 'Malformed request URL.' });
      return;
    }
    const rawPath = requestUrl.pathname;

    if (request.method === 'GET' && rawPath === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && assets.has(rawPath)) {
      const asset = assets.get(rawPath);
      sendBuffer(response, 200, asset.body, asset.contentType);
      return;
    }

    if (request.method === 'GET' && rawPath === '/api/dashboard') {
      try {
        const force = requestUrl.searchParams.get('refresh') === '1';
        sendJson(response, 200, await dashboardPayload(force), {
          'X-Codex-CSRF-Token': csrfToken,
        });
      } catch (error) {
        sendJson(response, 500, {
          error: 'Dashboard data could not be loaded.',
          detail: options.debug ? error.message : undefined,
        });
      }
      return;
    }

    if (request.method === 'GET' && rawPath === '/api/events') {
      openEventStream(response);
      return;
    }

    if (request.method === 'PUT' && rawPath === '/api/settings') {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'A same-origin request is required.' });
        return;
      }
      if (!safeTokenEqual(request.headers[CSRF_HEADER], csrfToken)) {
        sendJson(response, 403, { error: 'Invalid CSRF token.' });
        return;
      }
      const contentType = request.headers['content-type'];
      if (
        typeof contentType !== 'string' ||
        contentType.split(';', 1)[0].trim().toLowerCase() !==
          'application/json'
      ) {
        sendJson(response, 415, {
          error: 'Content-Type must be application/json.',
        });
        return;
      }
      if (
        request.headers['content-encoding'] &&
        request.headers['content-encoding'] !== 'identity'
      ) {
        sendJson(response, 415, {
          error: 'Compressed request bodies are not supported.',
        });
        return;
      }

      try {
        const input = await readJsonBody(request);
        const result = runtimeData.saveSettings(dataRoot, input);
        if (result.saved === false) {
          sendJson(response, 409, publicSettingsResult(result));
          return;
        }
        void refreshCoordinator.invalidate('settings');
        sendJson(response, 200, publicSettingsResult(result));
      } catch (error) {
        sendJson(response, error.statusCode ?? 500, {
          error:
            error.statusCode === 400 || error.statusCode === 413
              ? error.message
              : 'Settings could not be saved.',
          detail: options.debug ? error.message : undefined,
        });
      }
      return;
    }

    const knownPath =
      rawPath === '/healthz' ||
      rawPath === '/api/dashboard' ||
      rawPath === '/api/events' ||
      rawPath === '/api/settings' ||
      assets.has(rawPath);
    if (knownPath) {
      const allow =
        rawPath === '/api/settings'
          ? 'PUT'
          : 'GET';
      sendJson(
        response,
        405,
        { error: 'Method not allowed.' },
        { Allow: allow },
      );
      return;
    }

    sendText(response, 404, 'Not found.');
  }

  server = http.createServer((request, response) => {
    Promise.resolve(handleRequest(request, response)).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'Internal server error.' });
      } else {
        response.destroy();
      }
    });
  });
  const nativeClose = server.close.bind(server);
  let liveClosed = false;
  server.close = function closeDashboardServer(callback) {
    if (!liveClosed) {
      liveClosed = true;
      fileInvalidator.close();
      refreshCoordinator.close();
      for (const response of eventResponses) {
        response.end();
      }
      eventResponses.clear();
    }
    return nativeClose(callback);
  };
  server.dashboard = Object.freeze({
    dataRoot,
    csrfToken,
    sessionIndexPath,
    refreshCoordinator,
    fileInvalidator,
  });
  return server;
}

function parseArguments(argv) {
  const taskNameArguments = parseTaskNameSourceArguments(argv);
  const options = {
    port: DEFAULT_PORT,
    dataDir: undefined,
    ...taskNameArguments.options,
  };

  for (let index = 0; index < taskNameArguments.remaining.length; index += 1) {
    const argument = taskNameArguments.remaining[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--port') {
      const value = taskNameArguments.remaining[index + 1];
      index += 1;
      if (!/^\d+$/.test(value ?? '')) {
        throw new Error('--port requires an integer.');
      }
      options.port = Number(value);
      if (options.port < 1 || options.port > 65_535) {
        throw new Error('--port must be between 1 and 65535.');
      }
      continue;
    }
    if (argument === '--data-dir') {
      const value = taskNameArguments.remaining[index + 1];
      index += 1;
      if (!value) {
        throw new Error('--data-dir requires a path.');
      }
      options.dataDir = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`dashboard: ${error.message}\n`);
    process.exitCode = 1;
    return null;
  }

  if (options.help) {
    process.stdout.write(
      [
        'Usage: node dashboard.js [--port 43117] [--data-dir PATH]',
        '                         [--codex-home PATH | --session-index PATH]',
        '',
      ].join('\n'),
    );
    return null;
  }

  let server;
  try {
    server = createDashboardServer(options);
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address();
      process.stdout.write(
        [
          `Codex Cost Meter dashboard: http://127.0.0.1:${address.port}/`,
          `Data directory: ${server.dashboard.dataRoot}`,
          `Task names: ${server.dashboard.sessionIndexPath ?? 'hashed labels only'}`,
          '',
        ].join('\n'),
      );
    });
    server.on('error', (error) => {
      process.stderr.write(`dashboard: ${error.message}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`dashboard: ${error.message}\n`);
    process.exitCode = 1;
    return null;
  }
  return server;
}

if (require.main === module) {
  main();
}

module.exports = {
  createDashboardServer,
  main,
};
