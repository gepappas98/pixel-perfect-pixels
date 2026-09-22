create extension if not exists "pgcrypto";

create table public.whale_alerts (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  chain text,
  direction text not null check (direction in ('accumulation','distribution')),
  usd_value numeric not null,
  wallet_address text,
  tx_hash text,
  source text not null default 'whale-watch',
  raw jsonb,
  created_at timestamptz not null default now()
);
create index idx_whale_alerts_symbol_time on public.whale_alerts (symbol, created_at desc);
grant select on public.whale_alerts to anon, authenticated;
grant all on public.whale_alerts to service_role;
alter table public.whale_alerts enable row level security;
create policy "public read whale_alerts" on public.whale_alerts for select to anon, authenticated using (true);

create table public.indicator_snapshots (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  timeframe text not null,
  rsi numeric,
  macd numeric,
  macd_signal numeric,
  bb_upper numeric,
  bb_lower numeric,
  price numeric,
  signal text check (signal in ('bullish','bearish','neutral')),
  raw jsonb,
  created_at timestamptz not null default now()
);
create index idx_indicator_snapshots_symbol_time on public.indicator_snapshots (symbol, timeframe, created_at desc);
grant select on public.indicator_snapshots to anon, authenticated;
grant all on public.indicator_snapshots to service_role;
alter table public.indicator_snapshots enable row level security;
create policy "public read indicator_snapshots" on public.indicator_snapshots for select to anon, authenticated using (true);

create table public.prediction_snapshots (
  id uuid primary key default gen_random_uuid(),
  market_slug text not null,
  question text,
  related_symbol text,
  yes_price numeric,
  no_price numeric,
  volume_24h numeric,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index idx_prediction_snapshots_symbol_time on public.prediction_snapshots (related_symbol, created_at desc);
grant select on public.prediction_snapshots to anon, authenticated;
grant all on public.prediction_snapshots to service_role;
alter table public.prediction_snapshots enable row level security;
create policy "public read prediction_snapshots" on public.prediction_snapshots for select to anon, authenticated using (true);

create table public.council_signals (
  id uuid primary key default gen_random_uuid(),
  source_id text not null unique,
  symbol text not null,
  token_id text,
  depth text,
  final_verdict text not null,
  conviction numeric,
  price_at numeric,
  reflection text,
  source_created_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);
create index idx_council_signals_symbol_time on public.council_signals (symbol, source_created_at desc);
grant select on public.council_signals to anon, authenticated;
grant all on public.council_signals to service_role;
alter table public.council_signals enable row level security;
create policy "public read council_signals" on public.council_signals for select to anon, authenticated using (true);

create table public.composite_signals (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  whale_alert_id uuid references public.whale_alerts(id),
  indicator_snapshot_id uuid references public.indicator_snapshots(id),
  prediction_snapshot_id uuid references public.prediction_snapshots(id),
  council_signal_id uuid references public.council_signals(id),
  confidence numeric check (confidence >= 0 and confidence <= 1),
  recommendation text check (recommendation in ('buy','sell','hold','watch')),
  reasoning text,
  created_at timestamptz not null default now()
);
create index idx_composite_signals_symbol_time on public.composite_signals (symbol, created_at desc);
grant select on public.composite_signals to anon, authenticated;
grant all on public.composite_signals to service_role;
alter table public.composite_signals enable row level security;
create policy "public read composite_signals" on public.composite_signals for select to anon, authenticated using (true);

create table public.trades (
  id uuid primary key default gen_random_uuid(),
  composite_signal_id uuid references public.composite_signals(id),
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  quantity numeric not null,
  entry_price numeric not null,
  stop_loss numeric,
  take_profit numeric,
  mode text not null default 'paper' check (mode in ('paper','live')),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  exit_price numeric,
  pnl numeric,
  exchange_order_id text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index idx_trades_symbol_status on public.trades (symbol, status);
grant select on public.trades to anon, authenticated;
grant all on public.trades to service_role;
alter table public.trades enable row level security;
create policy "public read trades" on public.trades for select to anon, authenticated using (true);

alter publication supabase_realtime add table public.whale_alerts;
alter publication supabase_realtime add table public.indicator_snapshots;
alter publication supabase_realtime add table public.prediction_snapshots;
alter publication supabase_realtime add table public.council_signals;
alter publication supabase_realtime add table public.composite_signals;
alter publication supabase_realtime add table public.trades;