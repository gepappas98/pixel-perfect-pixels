# Polymarket removal — staged rollout

## Scope and rationale
The Research Lab is intended to evaluate short-horizon Binance Spot signals. Polymarket markets encode event probabilities and resolution horizons that can be long or unrelated to Spot entry timing. The prediction-market source is therefore removed from signal scoring, council context, regime classification, and the user interface.

## Phase 1 — safe preparation
1. Apply `20261012100000_prepare_polymarket_removal.sql` first. It only adds a default of zero to `strategy_shadow_diagnostics.prediction_weight`; it does not delete data or tables.
2. Deploy the updated frontend and Edge Functions from this branch. The default makes the new diagnostic inserts safe, while an older deployed Edge Function can still explicitly write zero during rollout.
3. Recheck the live signal-combiner and scheduled orchestrator logs after deployment. Do not proceed based solely on source review.

## Phase 2 — destructive cleanup (not yet an active migration)
After Phase 1 is deployed and verified, review and promote `REMOVE_POLYMARKET_FINAL_CLEANUP_DRAFT.sql` into `supabase/migrations` as a new migration. It:
- Replaces the three database functions that currently depend on `prediction_snapshots`.
- Replaces the three database functions that still depend on prediction snapshots so they operate without prediction-market inputs.
- Removes the retired `watch_conflict_fix` setting from persisted cleanup configuration.
- Preserves all historical prediction-era records and links: `composite_signals.entry_context_snapshot`, `prediction_snapshot_id`, `strategy_config.prediction_weight`, `pipeline_runs.predictions`, `whale_flow_transition_context.prediction_context`, and `prediction_snapshots` remain intact.
- Does not drop the historical table or columns. Archival/deletion requires a separate explicit approval and export/recovery plan.
- Leaves `strategy_shadow_diagnostics.prediction_weight` temporarily in place for backwards compatibility; the preparation migration sets its default to zero.

## Phase 3 — final schema tidy-up
Only after the new Edge Function is confirmed live, add a separate migration to drop `strategy_shadow_diagnostics.prediction_weight`. Do not include that drop in the same batch as the first deployment, because an older Edge Function may still explicitly write the column.

## Current verification status
- Code references to Polymarket/prediction-market fields have been removed from the active and legacy TypeScript paths reviewed on the branch.
- Read-only production inspection found 21 rows in `prediction_snapshots`, 520 composite signals linked through `prediction_snapshot_id`, and 1,462 composite signals whose entry context includes the `prediction_market` key (520 non-null object contexts, 942 null contexts at the audit snapshot). Counts can change while the live pipeline continues running. Active code stops consuming Polymarket, while all existing rows, snapshot context, and links are retained.
- No production migration, table drop, data update, merge, or deployment has been executed by this work.
- GitHub Actions passed on the prior PR head `ecd7f88348d07ee6984aeeadc4dc471cba4ae59c`: dependency install passed, 72/72 unit tests passed, and client/SSR/Nitro production builds passed. Three additional tests now cover the current ±2.2 BUY/SELL thresholds and the watch band; their CI result is pending for commit `35c69a2e905189469d41513edfd837216789464c`.
