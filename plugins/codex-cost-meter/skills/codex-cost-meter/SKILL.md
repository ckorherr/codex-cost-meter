---
name: codex-cost-meter
description: Show, explain, configure, verify, or troubleshoot the Codex Cost Meter plugin, including its private dashboard, budgets, pricing, storage, accounting, formatting, and hook behavior. Use for local estimated Codex costs; do not use for authoritative API invoices.
---

# Codex Cost Meter

The plugin's bundled `Stop` hook runs automatically after the user enables and
trusts it. Do not add a duplicate user-level hook.

## Show the dashboard

When the user asks to show or open their cost dashboard in Codex:

1. Use the `visualize` skill when it is available.
2. Resolve this installed skill's directory and run the renderer located at
   `../../scripts/render-dashboard-fragment.js`.
3. Choose a unique absolute `.html` path in the current task's writable
   visualization directory. Pass it with `--output`.
4. Do not read the accounting ledger or generated HTML into model context. The
   renderer reads the ledger locally and prints only the output path.
5. Present that path with the visualization content reference required by the
   `visualize` skill.

For example, the local command shape is:

```sh
node /absolute/plugin/root/scripts/render-dashboard-fragment.js \
  --output /absolute/task/visualization/codex-cost-dashboard.html
```

The in-chat dashboard is a point-in-time snapshot. Its Refresh button asks
Codex to generate a new snapshot. It never fetches data from the browser and it
does not provide settings controls.

For a continuously refreshable dashboard with settings, start the local server
from the source checkout with `npm run dashboard`. It binds only to
`127.0.0.1` and prints the local URL. Never start it from the Stop hook.

## Explain

Treat every displayed amount as an estimate. The meter:

- includes the root turn and its direct and transitive subagents;
- excludes inherited work when a task is copied or forked;
- records a completed root turn only once;
- displays turn, current session, local-day, and local-month totals;
- defaults to unrestricted daily and monthly budgets;
- projects month end from recorded month-to-date cost and calendar days;
- uses hardcoded model prices and a fixed USD-to-EUR conversion.

It reads local Codex rollout files to extract token counters and agent lineage.
The source-of-truth ledger stores one aggregate record per completed root turn,
including compact model and root-versus-subagent breakdowns. It does not store
one record per tool call or persist prompt, response, or tool-output text.
Rebuildable caches contain only the accounting metadata needed to avoid
reparsing unchanged rollout history. The Stop hook and localhost dashboard
make no external requests. The in-chat Refresh button sends only a fixed
user-triggered Codex prompt and never sends ledger values.

## Configure

Normal user settings live in `PLUGIN_DATA/settings.json`:

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

`null` budgets are unrestricted. Budget guidance is informational and must
never block or continue a model turn. Prefer the dashboard settings form over
manual JSON editing.

Edit `../../scripts/turn-cost.js` only when the user asks to change pricing or
accounting implementation. Shared settings, ledger, aggregation, forecasting,
and formatting belong in `../../lib/runtime-data.js`.

Preserve these invariants:

- emit display-only results through `systemMessage`, never `additionalContext`;
- keep subagent `Stop` events silent;
- never display partial numeric totals when agent traversal is incomplete;
- keep fork/copy accounting branch-local;
- keep ledger writes idempotent by `(root_thread_id, turn_id)`;
- record a metadata-only gap when a post-install root turn cannot be traversed
  or priced exactly, so later aggregates remain unavailable rather than partial;
- never backfill turns that completed before the plugin began recording;
- keep all settings, ledgers, and caches under `PLUGIN_DATA`;
- never put prompts, responses, tool output, or full project paths in the
  ledger or dashboard;
- never send dashboard or accounting data over the network.

After changes, run `npm run check`.

## Troubleshoot

Confirm that:

- Node.js is available as `node`;
- the plugin is enabled and its current hook definition is trusted;
- a new Codex task was started after installation or update;
- the active model has an entry in `PRICE_PER_MILLION`.

The first turn in a very large agent history can show a cache-warming message.
Later turns can be measured after the cache warms, but the gap from that first
turn keeps affected current-period aggregate totals unavailable.
