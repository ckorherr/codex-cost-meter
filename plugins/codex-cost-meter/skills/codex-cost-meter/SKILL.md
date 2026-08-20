---
name: codex-cost-meter
description: Explain, configure, verify, or troubleshoot the Codex Cost Meter plugin, which displays local per-turn, session, daily, and monthly token usage and estimated EUR costs. Use for this meter's pricing, formatting, storage, accounting, or hook behavior; do not use for authoritative API invoices.
---

# Codex Cost Meter

The plugin's bundled `Stop` hook runs automatically after the user enables and
trusts it. Do not add a duplicate user-level hook.

## Explain

Treat every displayed amount as an estimate. The meter:

- includes the root turn and its direct and transitive subagents;
- excludes inherited work when a task is copied or forked;
- records a completed root turn only once;
- displays turn, current session, local-day, and local-month totals;
- uses hardcoded model prices and a fixed USD-to-EUR conversion.

It reads local Codex rollout files to extract token counters and agent lineage.
It stores only parsed accounting metadata, token counters, and aggregate cost
records in the plugin data directory. It makes no network requests.

## Configure

Edit `../../scripts/turn-cost.js` only when the user asks to change pricing,
the fixed EUR conversion, formatting, time-zone behavior, or accounting logic.
Preserve these invariants:

- emit display-only results through `systemMessage`, never `additionalContext`;
- keep subagent `Stop` events silent;
- never display partial numeric totals when agent traversal is incomplete;
- keep fork/copy accounting branch-local;
- keep ledger writes idempotent by `(root_thread_id, turn_id)`;
- never backfill turns that completed before the plugin began recording.

After changes, run the repository's Node test suite and syntax checks.

## Troubleshoot

Confirm that:

- Node.js is available as `node`;
- the plugin is enabled and its current hook definition is trusted;
- a new Codex task was started after installation or update;
- the active model has an entry in `PRICE_PER_MILLION`.

The first turn in a very large agent history can show a cache-warming message.
Exact totals appear after the history cache finishes warming.
