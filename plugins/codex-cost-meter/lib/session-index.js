'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INDEX_SCHEMA = 2;
const INDEX_FILE_NAME = 'session-index.json';
const MAX_FIRST_LINE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SAFE_THREAD_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;
const UUID_V7 =
  /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function uuidV7TimestampMs(value) {
  const match = UUID_V7.exec(value ?? '');
  if (!match) {
    return null;
  }

  const timestampMs = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isSafeInteger(timestampMs) ? timestampMs : null;
}

function utcDayParts(timestampMs) {
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ];
}

function sessionDayPartsForFile(sessionsRoot, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null;
  }

  const root = path.resolve(sessionsRoot);
  const directory = path.dirname(path.resolve(filePath));
  const relative = path.relative(root, directory);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('..')
  ) {
    return null;
  }

  const parts = relative.split(path.sep);
  if (
    parts.length !== 3 ||
    !/^\d{4}$/.test(parts[0]) ||
    !/^\d{2}$/.test(parts[1]) ||
    !/^\d{2}$/.test(parts[2])
  ) {
    return null;
  }

  const timestampMs = Date.UTC(
    Number(parts[0]),
    Number(parts[1]) - 1,
    Number(parts[2]),
  );
  const normalized = utcDayParts(timestampMs);
  return normalized?.every((part, index) => part === parts[index])
    ? parts
    : null;
}

function targetedDayDirectories(sessionsRoot, threadId, options = {}) {
  const root = path.resolve(sessionsRoot);
  const candidates = [];
  const seen = new Set();

  function add(parts) {
    if (!parts) {
      return;
    }
    const key = parts.join('/');
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(path.join(root, ...parts));
  }

  function addAround(timestampMs) {
    if (!Number.isFinite(timestampMs)) {
      return;
    }
    for (const dayOffset of [0, -1, 1]) {
      add(utcDayParts(timestampMs + dayOffset * 24 * 60 * 60 * 1000));
    }
  }

  addAround(uuidV7TimestampMs(threadId));
  add(sessionDayPartsForFile(root, options.parentFilePath));
  addAround(options.occurredAtMs);
  return candidates;
}

function readFirstLine(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const chunks = [];
  let total = 0;

  try {
    while (total < MAX_FIRST_LINE_BYTES) {
      const bytesRead = fs.readSync(
        descriptor,
        chunk,
        0,
        chunk.length,
        null,
      );
      if (bytesRead === 0) {
        break;
      }

      const piece = Buffer.from(chunk.subarray(0, bytesRead));
      const newline = piece.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(piece.subarray(0, newline));
        break;
      }

      chunks.push(piece);
      total += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }

  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
}

function readSessionMetadata(filePath) {
  try {
    const firstLine = readFirstLine(filePath);
    if (!firstLine) {
      return null;
    }

    const record = JSON.parse(firstLine);
    if (record.type !== 'session_meta') {
      return null;
    }

    const payload = record.payload ?? {};
    const threadId = payload.id ?? null;
    if (!threadId) {
      return null;
    }

    const spawn = payload.source?.subagent?.thread_spawn;
    return {
      filePath,
      threadId,
      sessionId: payload.session_id ?? threadId,
      forkedFromId: payload.forked_from_id ?? null,
      parentThreadId: spawn?.parent_thread_id ?? null,
      depth: Number(spawn?.depth ?? 0),
      isSubagent: Boolean(spawn),
      startedMs: parseTimestamp(payload.timestamp ?? record.timestamp),
    };
  } catch {
    return null;
  }
}

function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function toPortableRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function statSnapshot(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) {
      return null;
    }

    return {
      size: stat.size.toString(),
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      birthtimeNs: (stat.birthtimeNs ?? stat.birthtimeMs).toString(),
      mtimeNs: (stat.mtimeNs ?? stat.mtimeMs).toString(),
    };
  } catch {
    return null;
  }
}

function statDirectorySnapshot(directoryPath) {
  try {
    const stat = fs.statSync(directoryPath, { bigint: true });
    if (!stat.isDirectory()) {
      return null;
    }

    return {
      size: stat.size.toString(),
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      birthtimeNs: (stat.birthtimeNs ?? stat.birthtimeMs).toString(),
      mtimeNs: (stat.mtimeNs ?? stat.mtimeMs).toString(),
      ctimeNs: (stat.ctimeNs ?? stat.ctimeMs).toString(),
    };
  } catch {
    return null;
  }
}

function validIdentifier(value) {
  return typeof value === 'string' && value.length > 0;
}

function deserializeMetadata(value, filePath) {
  if (
    !value ||
    typeof value !== 'object' ||
    !validIdentifier(value.threadId) ||
    !validIdentifier(value.sessionId) ||
    !(
      value.forkedFromId === null ||
      validIdentifier(value.forkedFromId)
    ) ||
    !(
      value.parentThreadId === null ||
      validIdentifier(value.parentThreadId)
    ) ||
    !Number.isFinite(value.depth) ||
    typeof value.isSubagent !== 'boolean' ||
    !Number.isFinite(value.startedMs)
  ) {
    return null;
  }

  return {
    filePath,
    threadId: value.threadId,
    sessionId: value.sessionId,
    forkedFromId: value.forkedFromId,
    parentThreadId: value.parentThreadId,
    depth: value.depth,
    isSubagent: value.isSubagent,
    startedMs: value.startedMs,
  };
}

function serializeMetadata(metadata) {
  if (!metadata) {
    return null;
  }

  return {
    threadId: metadata.threadId,
    sessionId: metadata.sessionId,
    forkedFromId: metadata.forkedFromId,
    parentThreadId: metadata.parentThreadId,
    depth: metadata.depth,
    isSubagent: metadata.isSubagent,
    startedMs: metadata.startedMs,
  };
}

function parseNonnegativeBigInt(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function hasStableFileId(snapshot) {
  return (
    snapshot &&
    typeof snapshot.inode === 'string' &&
    /^\d+$/.test(snapshot.inode) &&
    snapshot.inode !== '0'
  );
}

function validSnapshotNumber(value) {
  return typeof value === 'string' && /^-?\d+$/.test(value);
}

function validFileSnapshot(snapshot) {
  return (
    snapshot &&
    typeof snapshot === 'object' &&
    parseNonnegativeBigInt(snapshot.size) !== null &&
    validSnapshotNumber(snapshot.device) &&
    validSnapshotNumber(snapshot.inode) &&
    validSnapshotNumber(snapshot.birthtimeNs) &&
    validSnapshotNumber(snapshot.mtimeNs)
  );
}

function validDirectorySnapshot(snapshot) {
  return (
    validFileSnapshot(snapshot) &&
    validSnapshotNumber(snapshot.ctimeNs)
  );
}

function canReuseEntry(entry, snapshot, filePath) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    !entry.snapshot ||
    typeof entry.snapshot !== 'object'
  ) {
    return null;
  }

  const metadata = deserializeMetadata(entry.metadata, filePath);
  const observedSize = parseNonnegativeBigInt(entry.snapshot?.size);
  const currentSize = parseNonnegativeBigInt(snapshot.size);
  if (
    !metadata ||
    observedSize === null ||
    currentSize === null ||
    currentSize < observedSize
  ) {
    return null;
  }

  const previousSnapshot = entry.snapshot;
  const previousHasFileId = hasStableFileId(previousSnapshot);
  const currentHasFileId = hasStableFileId(snapshot);
  if (previousHasFileId || currentHasFileId) {
    return (
      previousHasFileId &&
      currentHasFileId &&
      previousSnapshot.device === snapshot.device &&
      previousSnapshot.inode === snapshot.inode
    )
      ? metadata
      : null;
  }

  if (
    previousSnapshot.birthtimeNs !== '0' ||
    snapshot.birthtimeNs !== '0'
  ) {
    return (
      typeof previousSnapshot.birthtimeNs === 'string' &&
      previousSnapshot.birthtimeNs === snapshot.birthtimeNs
    )
      ? metadata
      : null;
  }

  return (
    previousSnapshot.size === snapshot.size &&
    typeof previousSnapshot.mtimeNs === 'string' &&
    previousSnapshot.mtimeNs === snapshot.mtimeNs
  )
    ? metadata
    : null;
}

function sameDirectorySnapshot(previousSnapshot, currentSnapshot) {
  if (
    !validDirectorySnapshot(previousSnapshot) ||
    !validDirectorySnapshot(currentSnapshot)
  ) {
    return false;
  }

  const previousHasFileId = hasStableFileId(previousSnapshot);
  const currentHasFileId = hasStableFileId(currentSnapshot);
  if (
    previousHasFileId ||
    currentHasFileId
  ) {
    if (
      !previousHasFileId ||
      !currentHasFileId ||
      previousSnapshot.device !== currentSnapshot.device ||
      previousSnapshot.inode !== currentSnapshot.inode
    ) {
      return false;
    }
  } else if (
    previousSnapshot.birthtimeNs !== '0' ||
    currentSnapshot.birthtimeNs !== '0'
  ) {
    if (
      previousSnapshot.birthtimeNs !== currentSnapshot.birthtimeNs
    ) {
      return false;
    }
  }

  return (
    previousSnapshot.size === currentSnapshot.size &&
    previousSnapshot.mtimeNs === currentSnapshot.mtimeNs &&
    previousSnapshot.ctimeNs === currentSnapshot.ctimeNs
  );
}

function emptyCache() {
  return {
    entries: {},
    directories: {},
  };
}

function isPortableRelativePath(value, allowRoot = false) {
  if (allowRoot && value === '') {
    return true;
  }
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function portableParent(relativePath) {
  const parent = path.posix.dirname(relativePath);
  return parent === '.' ? '' : parent;
}

function validCachedEntry(entry) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    !validFileSnapshot(entry.snapshot)
  ) {
    return false;
  }
  return (
    entry.metadata === null ||
    deserializeMetadata(entry.metadata, '') !== null
  );
}

function validDirectoryRecord(record) {
  return (
    record &&
    typeof record === 'object' &&
    validDirectorySnapshot(record.snapshot) &&
    Array.isArray(record.files) &&
    Array.isArray(record.directories)
  );
}

function normalizeCache(entries, directories) {
  if (
    !entries ||
    typeof entries !== 'object' ||
    Array.isArray(entries) ||
    !directories ||
    typeof directories !== 'object' ||
    Array.isArray(directories) ||
    !Object.prototype.hasOwnProperty.call(directories, '')
  ) {
    return null;
  }

  const normalizedDirectories = {};
  const referencedFiles = new Set();
  const referencedDirectories = new Set(['']);

  for (const [relativePath, record] of Object.entries(directories)) {
    if (
      !isPortableRelativePath(relativePath, true) ||
      !validDirectoryRecord(record)
    ) {
      return null;
    }

    const files = [...record.files].sort(compareText);
    const childDirectories = [...record.directories].sort(compareText);
    if (
      new Set(files).size !== files.length ||
      new Set(childDirectories).size !== childDirectories.length
    ) {
      return null;
    }

    for (const fileRelativePath of files) {
      if (
        !isPortableRelativePath(fileRelativePath) ||
        !fileRelativePath.endsWith('.jsonl') ||
        portableParent(fileRelativePath) !== relativePath ||
        !validCachedEntry(entries[fileRelativePath]) ||
        referencedFiles.has(fileRelativePath)
      ) {
        return null;
      }
      referencedFiles.add(fileRelativePath);
    }

    for (const childRelativePath of childDirectories) {
      if (
        !isPortableRelativePath(childRelativePath) ||
        portableParent(childRelativePath) !== relativePath ||
        !Object.prototype.hasOwnProperty.call(
          directories,
          childRelativePath,
        ) ||
        referencedDirectories.has(childRelativePath)
      ) {
        return null;
      }
      referencedDirectories.add(childRelativePath);
    }

    normalizedDirectories[relativePath] = {
      snapshot: record.snapshot,
      files,
      directories: childDirectories,
    };
  }

  if (
    referencedFiles.size !== Object.keys(entries).length ||
    referencedDirectories.size !== Object.keys(directories).length
  ) {
    return null;
  }

  return {
    entries,
    directories: normalizedDirectories,
  };
}

function readCache(cachePath) {
  if (!cachePath) {
    return emptyCache();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (
      parsed.schema !== INDEX_SCHEMA ||
      !parsed.entries ||
      !parsed.directories
    ) {
      return emptyCache();
    }
    return (
      normalizeCache(parsed.entries, parsed.directories) ??
      emptyCache()
    );
  } catch {
    return emptyCache();
  }
}

function writeCache(cachePath, entries, directories) {
  if (!cachePath) {
    return;
  }

  let temporaryPath = null;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    const payload = {
      schema: INDEX_SCHEMA,
      entries,
      directories,
    };
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      },
    );
    fs.renameSync(temporaryPath, cachePath);
    temporaryPath = null;
  } catch {
    // The index is only an optimization; the in-memory result remains usable.
  } finally {
    if (temporaryPath) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Ignore cleanup races and permission errors.
      }
    }
  }
}

function buildSessionFileIndex(sessionsRoot, cacheDirectory) {
  const root = path.resolve(sessionsRoot);
  const cachePath =
    typeof cacheDirectory === 'string' && cacheDirectory.length > 0
      ? path.join(cacheDirectory, INDEX_FILE_NAME)
      : null;
  const cached = readCache(cachePath);
  const entries = {};
  const directories = {};
  const metadataByRelativePath = new Map();

  function reuseFile(relativePath) {
    const cachedEntry = cached.entries[relativePath];
    const filePath = path.join(root, ...relativePath.split('/'));
    if (cachedEntry.metadata === null) {
      return inspectFile(filePath, relativePath);
    }
    const metadata =
      deserializeMetadata(cachedEntry.metadata, filePath);
    entries[relativePath] = cachedEntry;
    metadataByRelativePath.set(relativePath, metadata);
    return true;
  }

  function inspectFile(filePath, relativePath) {
    const snapshot = statSnapshot(filePath);
    if (!snapshot) {
      return false;
    }

    const cachedMetadata = canReuseEntry(
      cached.entries[relativePath],
      snapshot,
      filePath,
    );
    const metadata = cachedMetadata ?? readSessionMetadata(filePath);
    entries[relativePath] = {
      snapshot,
      metadata: serializeMetadata(metadata),
    };
    metadataByRelativePath.set(relativePath, metadata);
    return true;
  }

  function inspectDirectory(directoryPath, relativePath) {
    const snapshot = statDirectorySnapshot(directoryPath);
    if (!snapshot) {
      return false;
    }

    const cachedDirectory = cached.directories[relativePath];
    if (
      cachedDirectory &&
      sameDirectorySnapshot(cachedDirectory.snapshot, snapshot)
    ) {
      const directoryRecord = {
        snapshot,
        files: [],
        directories: [],
      };
      directories[relativePath] = directoryRecord;

      const children = [
        ...cachedDirectory.files.map((childPath) => ({
          kind: 'file',
          relativePath: childPath,
        })),
        ...cachedDirectory.directories.map((childPath) => ({
          kind: 'directory',
          relativePath: childPath,
        })),
      ].sort((left, right) =>
        compareText(left.relativePath, right.relativePath),
      );

      for (const child of children) {
        if (child.kind === 'file') {
          if (reuseFile(child.relativePath)) {
            directoryRecord.files.push(child.relativePath);
          }
          continue;
        }
        const childPath = path.join(
          root,
          ...child.relativePath.split('/'),
        );
        if (inspectDirectory(childPath, child.relativePath)) {
          directoryRecord.directories.push(child.relativePath);
        }
      }
      return true;
    }

    let childEntries;
    try {
      childEntries = fs.readdirSync(directoryPath, {
        withFileTypes: true,
      });
    } catch {
      return false;
    }
    childEntries.sort((left, right) =>
      compareText(left.name, right.name),
    );

    const directoryRecord = {
      snapshot,
      files: [],
      directories: [],
    };
    directories[relativePath] = directoryRecord;
    for (const childEntry of childEntries) {
      const childPath = path.join(directoryPath, childEntry.name);
      const childRelativePath = toPortableRelativePath(root, childPath);
      if (childEntry.isDirectory()) {
        if (inspectDirectory(childPath, childRelativePath)) {
          directoryRecord.directories.push(childRelativePath);
        }
      } else if (
        childEntry.isFile() &&
        childEntry.name.endsWith('.jsonl') &&
        inspectFile(childPath, childRelativePath)
      ) {
        directoryRecord.files.push(childRelativePath);
      }
    }
    return true;
  }

  inspectDirectory(root, '');
  writeCache(cachePath, entries, directories);

  const grouped = new Map();
  for (const metadata of metadataByRelativePath.values()) {
    if (!metadata) {
      continue;
    }
    const candidates = grouped.get(metadata.threadId) ?? [];
    candidates.push(metadata);
    grouped.set(metadata.threadId, candidates);
  }

  const byThreadId = new Map(
    [...grouped.entries()].sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
  return {
    files: [...metadataByRelativePath.keys()].map((relativePath) =>
      path.join(root, ...relativePath.split('/')),
    ),
    metadata: [...metadataByRelativePath.values()].filter(Boolean),
    byRelativePath: metadataByRelativePath,
    byThreadId,
  };
}

function findChildMetadata(index, threadId, parentThreadId, sessionId) {
  const candidates = index?.byThreadId?.get(threadId) ?? [];
  for (const metadata of candidates) {
    if (
      metadata.threadId === threadId &&
      metadata.parentThreadId === parentThreadId &&
      metadata.sessionId === sessionId
    ) {
      return metadata;
    }
  }
  return null;
}

function findChildSessionMetadata(
  sessionsRoot,
  threadId,
  parentThreadId,
  sessionId,
  options = {},
) {
  if (
    !SAFE_THREAD_ID.test(threadId ?? '') ||
    !validIdentifier(parentThreadId) ||
    !validIdentifier(sessionId)
  ) {
    return null;
  }

  const suffix = `-${threadId}.jsonl`;
  for (const directoryPath of targetedDayDirectories(
    sessionsRoot,
    threadId,
    options,
  )) {
    let entries;
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) {
        continue;
      }
      const metadata = readSessionMetadata(
        path.join(directoryPath, entry.name),
      );
      if (
        metadata?.threadId === threadId &&
        metadata.parentThreadId === parentThreadId &&
        metadata.sessionId === sessionId
      ) {
        return metadata;
      }
    }
  }
  return null;
}

module.exports = {
  readSessionMetadata,
  buildSessionFileIndex,
  findChildMetadata,
  findChildSessionMetadata,
  uuidV7TimestampMs,
};
