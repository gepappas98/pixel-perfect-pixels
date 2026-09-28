-- Trading Command Center safety hardening
-- 1) Keep the pipeline_runs unique partial index as the atomic mutex.
-- 2) Ensure only one open trade per symbol (race-safe DB guard).
-- 3) Remove the legacy DB-side trade closer so pipeline.server.ts is the
--    single owner of TP/SL close lifecycle.
-- 4) Keep the fee-rate function as the DB mirror used for reporting/backfill.

create unique index if not exists pipeline_runs_one_active
  on public.pipeline_runs (job_name)
  where status = 'running';

create unique index if not exists trades_one_open_per_symbol
  on public.trades (symbol)
  where status = 'open';

drop function if exists public.check_and_close_trades();
