alter table public.early_entry_candle_lineage
  add column if not exists evaluation_at timestamptz;
update public.early_entry_candle_lineage
  set evaluation_at = recorded_at
  where evaluation_at is null;
alter table public.early_entry_candle_lineage
  alter column evaluation_at set not null;
alter table public.early_entry_candle_lineage
  drop constraint if exists early_entry_candle_lineage_valid_times;
alter table public.early_entry_candle_lineage
  add constraint early_entry_candle_lineage_valid_times
  check (open_time < close_time and close_time <= captured_at and close_time < evaluation_at and captured_at <= evaluation_at);
comment on column public.early_entry_candle_lineage.evaluation_at is 'Evaluation clock used by the strategy; DB constraint prevents lineage rows from referencing a candle captured after evaluation.';