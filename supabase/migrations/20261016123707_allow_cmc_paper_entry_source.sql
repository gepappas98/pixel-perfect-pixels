-- Permit the isolated CMC research-only paper strategy to persist its own tagged trades.
-- Existing trade history and other entry-source rules are preserved.
alter table public.trades drop constraint if exists trades_entry_source_check;
alter table public.trades add constraint trades_entry_source_check
  check (entry_source = any (array[
    'standard',
    'early_entry_regime',
    'early_entry_b_reversal',
    'early_entry_c_adaptive',
    'event_flow_paper',
    'whale_shock',
    'live_exchange',
    'cmc_paper'
  ]::text[]));
