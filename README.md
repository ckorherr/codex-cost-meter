# Codex Cost Meter

A local-only Codex plugin that shows token usage and estimated EUR cost after
each root turn.

It reports:

- the current turn, including direct and transitive subagents;
- the current task session;
- the current local day and month;
- fork- and copy-aware totals that exclude inherited history.

The amounts are intentionally approximate. Prices and the USD-to-EUR conversion
are hardcoded so the display remains predictable.

## Install from GitHub

Node.js must be available as `node`.

```sh
codex plugin marketplace add ckorherr/codex-cost-meter --ref main
codex plugin add codex-cost-meter@cost-meter
```

Start a new Codex task after installation and trust the hook when Codex asks
you to review it.

## Install from a local clone

From outside this repository:

```sh
codex plugin marketplace add /path/to/codex-cost-meter
codex plugin add codex-cost-meter@cost-meter
```

## Update a GitHub installation

```sh
codex plugin marketplace upgrade cost-meter
codex plugin add codex-cost-meter@cost-meter
```

## Update a local-clone installation

Pull or otherwise update the local clone, then reinstall the plugin snapshot:

```sh
git pull
codex plugin add codex-cost-meter@cost-meter
```

After either update path, start a new Codex task. If the hook definition
changed, review and trust the new definition.

## Migrating from the standalone hook

If you previously installed Codex Cost Meter directly in
`~/.codex/hooks.json`, remove that old `Stop` handler before enabling this
plugin. Otherwise both registrations can display a result for the same turn.

## Remove

```sh
codex plugin remove codex-cost-meter@cost-meter
codex plugin marketplace remove cost-meter
```

Removing the plugin does not intentionally delete its existing local usage
ledger.

## Privacy

The hook makes no network requests. It reads local Codex rollout JSONL files to
extract token counters, model names, task boundaries, and subagent lineage. It
does not persist prompt or tool-output text.

Parsed accounting metadata and aggregate usage records are stored in Codex's
writable plugin data directory. Do not commit that runtime directory.

## Estimates and configuration

The model rates are in
`plugins/codex-cost-meter/scripts/turn-cost.js` under
`PRICE_PER_MILLION`. The fixed conversion is `EUR_PER_USD`.

Current assumptions, in USD per million tokens:

| Model | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| `gpt-5.6-sol` | 5.00 | 0.50 | 6.25 | 30.00 |
| `gpt-5.6-terra` | 2.00 | 0.20 | 2.50 | 12.00 |
| `gpt-5.6-luna` | 0.20 | 0.02 | 0.25 | 1.20 |

The USD-to-EUR multiplier is currently `0.90`.

Historical ledger entries retain the conversion and calculated EUR amount used
when they were recorded. Updating rates affects future turns only.

The meter depends on Codex's local rollout format, which may change. Unknown
models and incomplete agent traversal produce an unavailable or cache-warming
message instead of a misleading numeric estimate.

## Development

```sh
npm run check
npm test
```

Before publishing an update, bump the semantic version in
`plugins/codex-cost-meter/.codex-plugin/plugin.json`.

The test suite covers nested subagents, duplicate events, incomplete agents,
daily/monthly ledgers, forks, copied history, month boundaries, and the
portable plugin hook command.
