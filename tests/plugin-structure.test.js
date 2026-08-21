'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(
  repositoryRoot,
  'plugins',
  'codex-cost-meter',
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function localRequireGraph(entryPath, seen = new Set()) {
  const resolved = path.resolve(entryPath);
  if (seen.has(resolved)) {
    return seen;
  }
  seen.add(resolved);
  const source = fs.readFileSync(resolved, 'utf8');
  const requirePattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(requirePattern)) {
    const candidate = path.resolve(path.dirname(resolved), match[1]);
    const dependency = path.extname(candidate) ? candidate : `${candidate}.js`;
    if (fs.existsSync(dependency)) {
      localRequireGraph(dependency, seen);
    }
  }
  return seen;
}

test('marketplace points to a valid portable plugin', () => {
  const marketplace = readJson(
    path.join(repositoryRoot, '.agents', 'plugins', 'marketplace.json'),
  );
  const entry = marketplace.plugins.find(
    (candidate) => candidate.name === 'codex-cost-meter',
  );

  assert.equal(marketplace.name, 'cost-meter');
  assert.ok(entry);
  assert.equal(entry.source.source, 'local');
  assert.equal(entry.source.path, './plugins/codex-cost-meter');

  const manifest = readJson(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
  );
  assert.equal(manifest.name, 'codex-cost-meter');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.hooks, undefined);

  const hookConfig = readJson(path.join(pluginRoot, 'hooks', 'hooks.json'));
  const handler = hookConfig.hooks.Stop[0].hooks[0];
  assert.match(handler.command, /\$\{PLUGIN_ROOT\}/);
  assert.match(handler.commandWindows, /\$\{PLUGIN_ROOT\}/);
  assert.doesNotMatch(handler.command, /[A-Za-z]:\\\\|\/mnt\/[a-z]\//);
  assert.doesNotMatch(
    handler.commandWindows,
    /[A-Za-z]:\\\\Users\\\\|\/mnt\/[a-z]\//,
  );
  assert.equal(handler.timeout, 12);
});

test('bundled hook command resolves the plugin root without emitting for subagent Stop', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-plugin-'));
  const sessionDirectory = path.join(
    fixtureRoot,
    '.codex',
    'sessions',
    '2026',
    '08',
    '20',
  );
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const transcriptPath = path.join(sessionDirectory, 'child.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      timestamp: '2026-08-20T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'child-thread',
        session_id: 'root-thread',
        timestamp: '2026-08-20T12:00:00.000Z',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'root-thread',
              depth: 1,
              agent_path: '/root/child-thread',
            },
          },
        },
      },
    })}\n`,
    'utf8',
  );

  const hookConfig = readJson(path.join(pluginRoot, 'hooks', 'hooks.json'));
  const handler = hookConfig.hooks.Stop[0].hooks[0];
  const command = (
    process.platform === 'win32'
      ? handler.commandWindows
      : handler.command
  ).replaceAll('${PLUGIN_ROOT}', pluginRoot);
  const invocation = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'root-thread',
      turn_id: 'child-turn',
      transcript_path: transcriptPath,
      model: 'gpt-5.6-sol',
      hook_event_name: 'Stop',
    }),
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: path.join(fixtureRoot, 'plugin-data'),
    },
    timeout: 10_000,
  });

  assert.equal(invocation.status, 0, invocation.stderr);
  assert.equal(invocation.stdout, '');
});

test('dashboard enrichment stays outside the Stop-hook dependency graph', () => {
  const graph = localRequireGraph(
    path.join(pluginRoot, 'scripts', 'turn-cost.js'),
  );
  const basenames = new Set([...graph].map((filePath) => path.basename(filePath)));
  assert.equal(basenames.has('dashboard-task-names.js'), false);
  assert.equal(basenames.has('dashboard-live.js'), false);
});
