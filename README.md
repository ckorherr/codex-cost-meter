# Codex Cost Meter

A local-only Codex plugin that shows token usage, estimated EUR cost, optional
budget guidance, and private dashboards.

After each completed root turn, the Stop hook reports:

- the current turn, including direct and transitive subagents;
- the current task session;
- the current local day and month;
- optional daily/monthly budget progress and a month-end forecast;
- fork- and copy-aware totals that exclude inherited history.

Budgets are unrestricted by default. They are informational only and never
block, continue, or otherwise affect a model turn. All displayed costs are
estimates.

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

The installed plugin is a cached snapshot separate from a development clone.
Editing the clone does not update the installed copy until it is reinstalled.

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

## Show the dashboard in Codex

After installing this version, ask:

> Show my Codex cost dashboard

The plugin skill generates a private visualization snapshot directly in the
chat. The snapshot is built locally from the accounting ledger, and the
renderer prints only its output path. The browser view never fetches ledger
data or sends accounting values; its Refresh button sends only a fixed request
asking Codex to generate a new snapshot.

This is an on-demand Codex visualization, not a permanent native sidebar,
panel, or Settings page. Use the local dashboard for live refresh and editing
settings.

Codex stores the derived HTML snapshot in the current task's private
visualization directory so the app can render it. That file contains only the
aggregate values and safe labels visible in the dashboard; it contains no
prompts, responses, tool output, or full paths. It can be deleted and
regenerated from the source ledger at any time. The source ledger, settings,
and hook caches remain under `PLUGIN_DATA`.

## Run the local dashboard

From this repository:

```sh
npm run dashboard
```

It listens only on `127.0.0.1:43117` and prints the URL and resolved data
directory. It never starts automatically from the hook.

Optional arguments:

```sh
npm run dashboard -- --port 43118
npm run dashboard -- --data-dir /absolute/path/to/plugin-data
```

When launching from WSL against data stored on Windows, pass the WSL-mounted
form of the path, for example `/mnt/c/Users/<you>/.codex/...`, rather than a
`C:\...` path. Check the printed `Data directory` when the page looks empty:
an ordinary WSL shell with `CODEX_HOME` unset otherwise defaults to the Linux
home directory.

The dashboard shows:

- today, current month, and projected month-end cost;
- daily and monthly budget progress;
- a seven-day spending chart;
- recent completed turns;
- cost by model and safe task identifier;
- root-agent versus subagent usage;
- cached, uncached, and cache-write input usage.

The settings form writes `settings.json` in the resolved data directory,
normally `PLUGIN_DATA/settings.json`.

## Settings

If `settings.json` does not exist, these defaults are used:

```json
{
  "schema": 1,
  "timezone": "Europe/Berlin",
  "budgets": {
    "daily_eur": null,
    "monthly_eur": null,
    "warning_thresholds_percent": [50, 80, 100]
  },
  "notifications": {
    "windows": false
  },
  "hook": {
    "message_format": "compact"
  }
}
```

- `daily_eur` and `monthly_eur` accept a positive EUR amount or `null`.
  `null` means unrestricted.
- Warning thresholds are unique whole percentages from 1 through 100.
- `timezone` is an IANA timezone used for daily/monthly bucketing.
- Windows notifications are best-effort and occur only when a configured
  threshold is crossed.
- Hook message format is `compact` or `detailed`.

The recorded-cost forecast uses:

```text
round-half-up(month-to-date cost × days in month ÷ local day of month)
```

The current day counts as a full observed day. This keeps the estimate stable
throughout the day and across daylight-saving transitions. Because accounting
starts at installation, the forecast does not include earlier spending.

## Accounting and storage

The monthly JSONL ledger is the source of truth. It stores one compact record
per completed root user-to-assistant turn. A turn with subagents is still one
ledger line; model and root-versus-subagent totals are nested breakdowns.
There is no ledger row for each tool call.

If a post-install turn cannot be traversed or priced exactly, the ledger stores
only a metadata gap marker. Affected current-period totals remain unavailable
instead of silently omitting that turn.

Rebuildable hook caches store only rollout metadata, task boundaries, lineage,
and token-counter events needed for incremental accounting. They avoid
re-reading unchanged transcript history. The dashboard reads the compact
ledger and never parses Codex transcripts.

Ledger writes update a rebuildable compressed read index and a per-month
generation marker. In-place edits made outside the plugin must also update that
marker, or delete the read index, before cached totals are read again. File
adds, removals, and replacements invalidate the month automatically. The Stop
hook reads only the UTC months that can affect its current local-month and
seven-day totals and rebuilds a large cold month in bounded batches across
later Stops. It records each exact current turn while aggregate totals remain
unavailable during warming. Dashboard views request the full ledger.

All settings, ledgers, locks, and caches remain below `PLUGIN_DATA`. Task labels
shown in dashboards are local hashes; project paths and task titles are not
published.

Version 0.2 introduces ledger schema 2. Development-era schema-1 rows are not
backfilled; new accounting starts when the updated plugin records its first
turn.

## Privacy

The hook makes no network requests. It reads local Codex rollout JSONL files to
extract token counters, model names, task boundaries, and subagent lineage. It
does not persist prompts, responses, tool-output text, or full project paths.

Parsed accounting metadata and aggregate usage records are stored in Codex's
writable plugin data directory. Do not commit that runtime directory.

The browser dashboard binds only to loopback, rejects untrusted Host and Origin
headers, uses a per-process CSRF token for settings writes, and loads no
analytics, CDNs, or external assets.

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
```

`npm run check` syntax-checks all JavaScript and runs the complete Node test
suite.

The test suite covers nested subagents, duplicate events, incomplete agents,
incremental caches, default/custom/malformed settings, Berlin calendar and DST
boundaries, budget forecasts, dashboard security, duplicate ledger records,
forks, copied history, and the portable plugin hook command.
