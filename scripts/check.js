'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const sourceRoots = ['plugins', 'scripts', 'tests'];

function JavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...JavaScriptFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(filePath);
    }
  }
  return files;
}

function runNode(arguments_) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const files = sourceRoots
  .flatMap((directory) => JavaScriptFiles(path.join(repositoryRoot, directory)))
  .sort();

for (const filePath of files) {
  runNode(['--check', filePath]);
}
runNode(['--test']);
