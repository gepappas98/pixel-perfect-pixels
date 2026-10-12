# Polymarket removal — staged rollout

## Scope and rationale
The Research Lab is intended to evaluate short-horizon Binance Spot signals. Polymarket markets encode event probabilities and resolution horizons that can be long or unrelated to Spot entry timing. The prediction-market source is therefore removed from signal scoring, council context, regime classification, and the user interface.

## Phase 1 — safe preparation
1. Apply `20261012100000_prepare_polymarket_removal.sql` first. It only adds a default of zero to `strategy_shadow_diagnostics.prediction_weight`; it does not delete data or tables.
2. Deploy the updated frontend and Edge Functions from this branch. The default makes the new diagnostic inserts safe, while an older deployed Edge Function can still explicitly write zero during rollout.
3. Recheck the live signal-combiner and scheduled orchestrator logs after deployment. Do not proceed based solely on source review.

## Phase 2 — database routine retirement (non-destructive; not yet an active migration)
After Phase 1 is deployed and verified, review and promote `REMOVE_POLYMARKET_FINAL_CLEANUP_DRAFT.sql` into `supabase/migrations` as a new migration. This replaces database routines and removes a retired feature flag; it does not delete prediction-era rows, columns, or tables. It:
- Replaces the three database functions that still depend on prediction snapshots so they operate without prediction-market inputs.
- Removes the retired `watch_conflict_fix` setting from persisted cleanup configuration.
- Preserves all historical prediction-era records and links: `composite_signals.entry_context_snapshot`, `prediction_snapshot_id`, `strategy_config.prediction_weight`, `pipeline_runs.predictions`, `whale_flow_transition_context.prediction_context`, and `prediction_snapshots` remain intact.
- Does not drop the historical table or columns. Archival/deletion requires a separate explicit approval and export/recovery plan.
- Leaves `strategy_shadow_diagnostics.prediction_weight` temporarily in place for backwards compatibility; the preparation migration sets its default to zero.

## Current verification status
- Active TypeScript paths reviewed for the pipeline, signal combiner, council sync, orchestrator, regime, diagnostics, and AI Council contain no active Polymarket/prediction-market references. Generated Supabase types remain aligned with the live schema because legacy historical columns and tables are retained.
- Earlier read-only production inspection found 21 rows in `prediction_snapshots`, 520 composite signals linked through `prediction_snapshot_id`, and 1,462 composite signals whose entry context includes the `prediction_market` key (520 non-null objects, 942 null values at that audit snapshot). Counts can change while the live pipeline continues running. All existing rows, snapshot context, and links are retained.
- PR head `f906242314555ae5511abf5a8beec4904ddb9099` passed both workflows: [build/tests](https://github.com/gepappas98/pixel-perfect-pixels/actions/runs/38208199165) and [Edge Function type-check](https://github.com/gepappas98/pixel-perfect-pixels/actions/runs/38208199177). The full combined run on code commit `9f8de624cb74a252619aa9a6dc395fa69a544569` also passed locked dependency installation, Deno type-check, **75/75 unit tests**, and client/SSR/Nitro production builds: https://github.com/gepappas98/pixel-perfect-pixels/actions/runs/38208012147.
- The new Deno check caught two nullable `indicator.price` dereferences in `signal-combiner`; both were corrected with null-safe access and the full validation passed afterward.
- No production migration, table drop, data update, merge, or deployment has been executed by this work.


## Live production audit — 2026-10-12 06:52 UTC (read-only)

- The active `pg_cron` job is `trading-pipeline-orchestrator`, schedule `*/2 * * * *`. The deployed orchestrator and persisted run records both report `interval_minutes: 2`; do not assume the earlier UI label of 10 minutes reflects the live schedule.
- In the preceding 24 hours, 328 orchestrator rows were observed, 327 completed, and zero were marked error; average completed-run duration was about 18.6 seconds. The newest row was still starting at the time of this snapshot.
- The `polymarket-check` stage appeared in 327 recorded runs, with 327 successful stage results, zero stage failures, and an average duration of about 343 ms. This confirms it is still active in production and is not currently failing the pipeline.
- `prediction_snapshots` contained 22 rows; 18 were created in the preceding hour. Historical rows must be retained during rollout.
- A read-only scan of public PostgreSQL function definitions found exactly three routines still referencing prediction-market objects: `analyze_whale_waves_by_market_regime`, `capture_whale_flow_transition_context`, and `check_whale_wave_research_readiness`. These are the three routines replaced in the cleanup draft. The draft contains three function definitions/terminators and no `DROP TABLE`, `DROP COLUMN`, `DELETE FROM`, or `TRUNCATE` statements.
- No production migration, function replacement, merge, or deployment was executed during this audit.
- Follow-up outside this Polymarket-removal scope: reconcile the live two-minute cron schedule with the earlier intent to reduce database growth by running every ten minutes. Do not silently change the schedule as part of this feature removal.
