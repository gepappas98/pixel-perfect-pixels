-- Permit the isolated paper-only Whale Shock research entry source.
-- Existing entry-source values and historical rows remain unchanged.
alter table public.trades
  drop constraint if exists trades_entry_source_check;

alter table public.trades
  add constraint trades_entry_source_check
  check (entry_source = any (array[
    'standard'::text,
    'early_entry_regime'::text,
    'live_exchange'::text,
    'whale_shock'::text
  ]));
