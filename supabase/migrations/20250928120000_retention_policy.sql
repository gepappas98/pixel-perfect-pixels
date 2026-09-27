-- ══════════════════════════════════════════════════════════════
-- Retention policy — auto-cleanup παλιών δεδομένων
-- Χωρίς αυτό, οι πίνακες γεμίζουν με εκατομμύρια rows σε εβδομάδες.
-- ══════════════════════════════════════════════════════════════

create or replace function cleanup_old_pipeline_data()
returns table (
  deleted_whale_alerts bigint,
  deleted_council_signals bigint,
  deleted_composite_signals bigint,
  deleted_trade_alerts bigint,
  deleted_pipeline_runs bigint
)
language plpgsql
security definer
as $$
declare
  v_whales bigint;
  v_council bigint;
  v_composite bigint;
  v_trade_alerts bigint;
  v_runs bigint;
begin
  -- whale_alerts: κρατάμε 7 μέρες
  delete from whale_alerts where created_at < now() - interval '7 days';
  get diagnostics v_whales = row_count;

  -- council_signals: κρατάμε 3 μέρες
  delete from council_signals where source_created_at < now() - interval '3 days';
  get diagnostics v_council = row_count;

  -- composite_signals: κρατάμε 3 μέρες (μόνο watch/hold — τα buy/sell τα θέλουμε για audit)
  delete from composite_signals
  where created_at < now() - interval '3 days'
    and recommendation in ('watch', 'hold');
  get diagnostics v_composite = row_count;

  -- trade_alerts: κρατάμε 30 μέρες
  delete from trade_alerts where created_at < now() - interval '30 days';
  get diagnostics v_trade_alerts = row_count;

  -- pipeline_runs: κρατάμε 7 μέρες
  delete from pipeline_runs where started_at < now() - interval '7 days';
  get diagnostics v_runs = row_count;

  return query select v_whales, v_council, v_composite, v_trade_alerts, v_runs;
end;
$$;

grant execute on function cleanup_old_pipeline_data() to service_role;

-- Τρέξε μία φορά τώρα για καθαρισμό:
select * from cleanup_old_pipeline_data();

-- ⚠️ Για auto-run κάθε μέρα, ενεργοποίησε pg_cron (αν δεν είναι ενεργό):
-- create extension if not exists pg_cron;
-- select cron.schedule('cleanup-pipeline-data', '0 3 * * *', 'select cleanup_old_pipeline_data();');
