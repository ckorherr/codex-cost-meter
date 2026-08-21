'use strict';

// Dashboard-only, best-effort task-name enrichment. This module deliberately
// does not participate in hook accounting and never persists its parsed data.
const fs = require('node:fs');
const path = require('node:path');

const SESSION_INDEX_FILE = 'session_index.jsonl';
const STANDARD_DATA_DIRECTORY = 'codex-cost-meter-cost-meter';
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_NAME_CHARACTERS = 160;
const MAX_SOURCE_READ_ATTEMPTS = 3;
const cacheByPath = new Map();

function nonemptyPathOption(value, field) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty path.`);
  }
  return path.resolve(value.trim());
}

function codexHomeFromDataRoot(dataRoot) {
  const root = nonemptyPathOption(dataRoot, 'dataRoot');
  if (!root || path.basename(root) !== STANDARD_DATA_DIRECTORY) {
    return null;
  }
  const dataDirectory = path.dirname(root);
  const pluginsDirectory = path.dirname(dataDirectory);
  if (
    path.basename(dataDirectory) !== 'data' ||
    path.basename(pluginsDirectory) !== 'plugins'
  ) {
    return null;
  }
  return path.dirname(pluginsDirectory);
}

function resolveSessionIndexPath(options = {}) {
  const explicitIndex = nonemptyPathOption(
    options.sessionIndexPath ?? options.sessionIndex,
    'sessionIndexPath',
  );
  if (explicitIndex) {
    return explicitIndex;
  }

  const explicitHome = nonemptyPathOption(options.codexHome, 'codexHome');
  if (explicitHome) {
    return path.join(explicitHome, SESSION_INDEX_FILE);
  }

  const inferredHome = codexHomeFromDataRoot(options.dataRoot);
  if (inferredHome) {
    return path.join(inferredHome, SESSION_INDEX_FILE);
  }

  const environment =
    options.env && typeof options.env === 'object'
      ? options.env
      : process.env;
  const environmentValue = environment.CODEX_HOME;
  const environmentHome = nonemptyPathOption(
    typeof environmentValue === 'string' && !environmentValue.trim()
      ? null
      : environmentValue,
    'CODEX_HOME',
  );
  return environmentHome
    ? path.join(environmentHome, SESSION_INDEX_FILE)
    : null;
}

function parseTaskNameSourceArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('argv must be an array.');
  }
  const options = {};
  const remaining = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let field = null;
    let value = null;
    if (argument === '--session-index' || argument === '--codex-home') {
      field = argument === '--session-index' ? 'sessionIndexPath' : 'codexHome';
      value = argv[index + 1];
      index += 1;
    } else if (
      typeof argument === 'string' &&
      (argument.startsWith('--session-index=') ||
        argument.startsWith('--codex-home='))
    ) {
      const separator = argument.indexOf('=');
      field =
        argument.slice(0, separator) === '--session-index'
          ? 'sessionIndexPath'
          : 'codexHome';
      value = argument.slice(separator + 1);
    } else {
      remaining.push(argument);
      continue;
    }

    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(
        `${field === 'sessionIndexPath' ? '--session-index' : '--codex-home'} requires a path.`,
      );
    }
    if (Object.hasOwn(options, field)) {
      throw new Error(
        `${field === 'sessionIndexPath' ? '--session-index' : '--codex-home'} may be provided only once.`,
      );
    }
    options[field] = value.trim();
  }

  return { options, remaining };
}

function positiveIntegerOption(value, fallback, field) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function normalizeTaskName(value, maxCharacters = DEFAULT_MAX_NAME_CHARACTERS) {
  if (typeof value !== 'string') {
    return null;
  }
  const limit = positiveIntegerOption(
    maxCharacters,
    DEFAULT_MAX_NAME_CHARACTERS,
    'maxCharacters',
  );
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) {
    return null;
  }
  const characters = Array.from(normalized);
  return characters.length <= limit
    ? normalized
    : characters.slice(0, limit).join('').trimEnd();
}

function containsAbsolutePath(value) {
  return (
    /[A-Za-z]:[\\/]/u.test(value) ||
    /(?:^|[^A-Za-z0-9])\/[\S]/u.test(value) ||
    /(?:^|[^A-Za-z0-9])\\\\[\S]/u.test(value)
  );
}

function safeKeyFunction(options) {
  if (options.safeTaskKey !== undefined) {
    if (typeof options.safeTaskKey !== 'function') {
      throw new TypeError('safeTaskKey must be a function.');
    }
    return options.safeTaskKey;
  }
  // Load lazily so merely importing this dashboard helper has no accounting
  // side effects and the hook never needs to import this module.
  return require('./runtime-data').safeTaskKey;
}

function parseSessionIndexText(content, options = {}) {
  if (typeof content !== 'string') {
    throw new TypeError('Session index content must be a string.');
  }
  const safeTaskKey = safeKeyFunction(options);
  const maxNameCharacters = positiveIntegerOption(
    options.maxNameCharacters,
    DEFAULT_MAX_NAME_CHARACTERS,
    'maxNameCharacters',
  );
  const latestById = new Map();
  let malformedLines = 0;
  let invalidRecords = 0;
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/^\uFEFF/, '').trim();
    if (!line) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }

    const id =
      typeof record?.id === 'string' &&
      record.id.length > 0 &&
      record.id.length <= 512
        ? record.id
        : null;
    let name = normalizeTaskName(
      record?.thread_name,
      maxNameCharacters,
    );
    if (
      name &&
      (containsAbsolutePath(name) || (id && name.includes(id)))
    ) {
      name = null;
    }
    const updatedAtMs =
      typeof record?.updated_at === 'string'
        ? Date.parse(record.updated_at)
        : Number.NaN;
    if (!id || !name || !Number.isFinite(updatedAtMs)) {
      invalidRecords += 1;
      continue;
    }

    const previous = latestById.get(id);
    if (!previous || updatedAtMs >= previous.updatedAtMs) {
      latestById.set(id, { name, updatedAtMs });
    }
  }

  const names = new Map();
  const ownerByKey = new Map();
  const collidedKeys = new Set();
  let invalidKeys = 0;
  for (const [id, entry] of latestById) {
    let key;
    try {
      key = safeTaskKey(id);
    } catch {
      invalidKeys += 1;
      continue;
    }
    if (typeof key !== 'string' || !key) {
      invalidKeys += 1;
      continue;
    }
    const owner = ownerByKey.get(key);
    if (owner !== undefined && owner !== id) {
      names.delete(key);
      collidedKeys.add(key);
      continue;
    }
    ownerByKey.set(key, id);
    if (!collidedKeys.has(key)) {
      names.set(key, entry.name);
    }
  }

  const diagnostics = [];
  if (malformedLines > 0) {
    diagnostics.push(
      `Ignored ${malformedLines} malformed or truncated task-name index ${malformedLines === 1 ? 'line' : 'lines'}.`,
    );
  }
  if (invalidRecords > 0) {
    diagnostics.push(
      `Ignored ${invalidRecords} invalid task-name index ${invalidRecords === 1 ? 'record' : 'records'}.`,
    );
  }
  if (invalidKeys > 0) {
    diagnostics.push(
      `Ignored ${invalidKeys} task-name ${invalidKeys === 1 ? 'record' : 'records'} with an invalid safe key.`,
    );
  }
  if (collidedKeys.size > 0) {
    diagnostics.push(
      `Ignored ${collidedKeys.size} ambiguous task-name ${collidedKeys.size === 1 ? 'key' : 'keys'}.`,
    );
  }
  return {
    names,
    diagnostics,
    complete:
      malformedLines === 0 &&
      invalidRecords === 0 &&
      invalidKeys === 0 &&
      collidedKeys.size === 0,
  };
}

function statNumber(stat, nanosecondField, millisecondField) {
  const nanoseconds = stat?.[nanosecondField];
  if (typeof nanoseconds === 'bigint') {
    return nanoseconds.toString();
  }
  const milliseconds = Number(stat?.[millisecondField]);
  return Number.isFinite(milliseconds)
    ? String(Math.trunc(milliseconds * 1_000_000))
    : '0';
}

function statSignature(stat) {
  return [
    stat.size.toString(),
    stat.dev.toString(),
    stat.ino.toString(),
    statNumber(stat, 'birthtimeNs', 'birthtimeMs'),
    statNumber(stat, 'mtimeNs', 'mtimeMs'),
    statNumber(stat, 'ctimeNs', 'ctimeMs'),
  ].join(':');
}

function cloneResult(result) {
  return {
    names: new Map(result.names),
    diagnostics: [...result.diagnostics],
    complete: result.complete,
    available: result.available,
  };
}

function fallbackResult(diagnostic, available = false) {
  return {
    names: new Map(),
    diagnostics: diagnostic ? [diagnostic] : [],
    complete: false,
    available,
  };
}

function diagnosticCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? ` (${error.code})`
    : '';
}

function readDescriptor(descriptor, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      offset,
      size - offset,
      offset,
    );
    if (bytesRead === 0) {
      return null;
    }
    offset += bytesRead;
  }
  return buffer;
}

function loadDashboardTaskNames(options = {}) {
  const filePath = resolveSessionIndexPath(options);
  if (!filePath) {
    return fallbackResult(
      'Task-name source is not configured; hashed task labels will be used.',
    );
  }
  const safeTaskKey = safeKeyFunction(options);
  const maxFileBytes = positiveIntegerOption(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    'maxFileBytes',
  );
  const maxNameCharacters = positiveIntegerOption(
    options.maxNameCharacters,
    DEFAULT_MAX_NAME_CHARACTERS,
    'maxNameCharacters',
  );

  let pathStat;
  try {
    pathStat = fs.statSync(filePath, { bigint: true });
  } catch (error) {
    cacheByPath.delete(filePath);
    if (error?.code === 'ENOENT') {
      return fallbackResult(
        'Task-name index was not found; hashed task labels will be used.',
      );
    }
    return fallbackResult(
      `Task-name index could not be inspected${diagnosticCode(error)}; hashed task labels will be used.`,
    );
  }
  if (!pathStat.isFile()) {
    cacheByPath.delete(filePath);
    return fallbackResult(
      'Task-name index is not a regular file; hashed task labels will be used.',
      true,
    );
  }

  const initialSignature = statSignature(pathStat);
  const cached = cacheByPath.get(filePath);
  if (
    cached &&
    cached.signature === initialSignature &&
    cached.maxFileBytes === maxFileBytes &&
    cached.maxNameCharacters === maxNameCharacters &&
    cached.safeTaskKey === safeTaskKey
  ) {
    return cloneResult(cached.result);
  }

  if (pathStat.size > BigInt(maxFileBytes)) {
    const result = fallbackResult(
      `Task-name index exceeds the ${maxFileBytes}-byte dashboard limit; hashed task labels will be used.`,
      true,
    );
    cacheByPath.set(filePath, {
      signature: initialSignature,
      maxFileBytes,
      maxNameCharacters,
      safeTaskKey,
      result,
    });
    return cloneResult(result);
  }

  for (let attempt = 0; attempt < MAX_SOURCE_READ_ATTEMPTS; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(filePath, 'r');
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile()) {
        return fallbackResult(
          'Task-name index is not a regular file; hashed task labels will be used.',
          true,
        );
      }
      if (before.size > BigInt(maxFileBytes)) {
        return fallbackResult(
          `Task-name index exceeds the ${maxFileBytes}-byte dashboard limit; hashed task labels will be used.`,
          true,
        );
      }
      const size = Number(before.size);
      if (!Number.isSafeInteger(size)) {
        return fallbackResult(
          'Task-name index is too large to read safely; hashed task labels will be used.',
          true,
        );
      }
      const buffer = readDescriptor(descriptor, size);
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!buffer || statSignature(before) !== statSignature(after)) {
        continue;
      }
      let finalPathStat;
      try {
        finalPathStat = fs.statSync(filePath, { bigint: true });
      } catch {
        continue;
      }
      const signature = statSignature(after);
      if (signature !== statSignature(finalPathStat)) {
        continue;
      }

      const parsed = parseSessionIndexText(buffer.toString('utf8'), {
        safeTaskKey,
        maxNameCharacters,
      });
      const result = { ...parsed, available: true };
      cacheByPath.set(filePath, {
        signature,
        maxFileBytes,
        maxNameCharacters,
        safeTaskKey,
        result,
      });
      return cloneResult(result);
    } catch (error) {
      cacheByPath.delete(filePath);
      return fallbackResult(
        `Task-name index could not be read${diagnosticCode(error)}; hashed task labels will be used.`,
        true,
      );
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  }

  cacheByPath.delete(filePath);
  return fallbackResult(
    'Task-name index kept changing while it was read; hashed task labels will be used.',
    true,
  );
}

function clearDashboardTaskNameCache() {
  cacheByPath.clear();
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_NAME_CHARACTERS,
  SESSION_INDEX_FILE,
  clearDashboardTaskNameCache,
  codexHomeFromDataRoot,
  loadDashboardTaskNames,
  normalizeTaskName,
  parseSessionIndexText,
  parseTaskNameSourceArguments,
  resolveSessionIndexPath,
};
