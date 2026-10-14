-- Structured Binance Spot candles for research features (OHLCV + taker-buy volume).
create table if not exists public.market_candles (
  symbol text not null,
  timeframe text not null check (timeframe in ('5m','15m')),
  open_time timestamptz not null,
  close_time timestamptz not null,
  open numeric not null, high numeric not null, low numeric not null, close numeric not null,
  base_volume numeric not null, quote_volume numeric not null, trade_count integer not null,
  taker_buy_base_volume numeric not null, taker_buy_quote_volume numeric not null,
  source text not null default 'binance-spot-klines',
  captured_at timestamptz not null default now(),
  primary key (symbol, timeframe, open_time),
  check (high >= low and high >= open and high >= close and low <= open and low <= close),
  check (base_volume >= 0 and quote_volume >= 0 and taker_buy_base_volume >= 0 and taker_buy_quote_volume >= 0)
);
create index if not exists market_candles_timeframe_close_idx on public.market_candles (timeframe, close_time desc);
create index if not exists market_candles_symbol_close_idx on public.market_candles (symbol, close_time desc);
alter table public.market_candles enable row level security;
drop policy if exists "market_candles_read_authenticated" on public.market_candles;
create policy "market_candles_read_authenticated" on public.market_candles for select to authenticated using (true);
comment on table public.market_candles is 'Structured Binance Spot OHLCV candles including taker-buy base/quote volumes; research use only.';
