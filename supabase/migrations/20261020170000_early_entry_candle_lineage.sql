create table if not exists public.early_entry_candle_lineage (
  id bigint generated always as identity primary key,
  evaluation_id uuid not null,
  function_name text not null check (function_name in ('early-entry-regime','early-entry-variants')),
  variant text,
  decision_id bigint references public.early_entry_variant_decisions(id) on delete set null,
  trade_id uuid references public.trades(id) on delete set null,
  symbol text not null,
  timeframe text not null check (timeframe in ('5m','15m')),
  open_time timestamptz not null,
  close_time timestamptz not null,
  captured_at timestamptz not null,
  source text not null,
  recorded_at timestamptz not null default now(),
  constraint early_entry_candle_lineage_valid_times check (open_time < close_time and captured_at >= close_time),
  constraint early_entry_candle_lineage_evaluation_source_unique unique (evaluation_id, symbol, timeframe, open_time, source)
);
create index if not exists early_entry_candle_lineage_evaluation_idx on public.early_entry_candle_lineage (evaluation_id);
create index if not exists early_entry_candle_lineage_symbol_time_idx on public.early_entry_candle_lineage (symbol, timeframe, close_time desc);
create index if not exists early_entry_candle_lineage_trade_idx on public.early_entry_candle_lineage (trade_id) where trade_id is not null;
alter table public.early_entry_candle_lineage enable row level security;
revoke all on table public.early_entry_candle_lineage from anon, authenticated;
grant all on table public.early_entry_candle_lineage to service_role;
comment on table public.early_entry_candle_lineage is 'Normalized, bounded per-evaluation source candle lineage for Early Entry. Contains identifiers/timestamps only, not full candle OHLCV payloads. Historical rows are not backfilled because original consumed-candle identity is unavailable.';