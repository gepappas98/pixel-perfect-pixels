alter table public.early_entry_candle_lineage
  drop constraint if exists early_entry_candle_lineage_decision_id_fkey,
  drop constraint if exists early_entry_candle_lineage_trade_id_fkey;
alter table public.early_entry_candle_lineage
  drop column if exists decision_id,
  drop column if exists trade_id;
drop index if exists public.early_entry_candle_lineage_evaluation_idx;
drop index if exists public.early_entry_candle_lineage_trade_idx;