-- Early Entry Regime research positions. Additive only: preserve all existing rows and strategy behavior.
alter table public.trades
  add column if not exists entry_source text not null default 'standard',
  add column if not exists entry_metadata jsonb not null default '{}'::jsonb;

alter table public.trades
  drop constraint if exists trades_entry_source_check;
alter table public.trades
  add constraint trades_entry_source_check
  check (entry_source in ('standard', 'early_entry_regime', 'live_exchange'));

create index if not exists trades_entry_source_status_created_idx
  on public.trades (entry_source, status, created_at desc);

create table if not exists public.early_entry_regime_observations (
  id bigint generated always as identity primary key,
  observed_at timestamptz not null default now(),
  market_regime text not null,
  market_regime_score numeric,
  whale_flow_state text not null,
  whale_flow_delta_pp numeric,
  technicals_1h_bullish integer not null default 0,
  technicals_1h_bearish integer not null default 0,
  technicals_1h_neutral integer not null default 0,
  breadth_baseline_at timestamptz,
  breadth_baseline_bullish integer,
  breadth_baseline_bearish integer,
  transition_state text not null,
  details jsonb not null default '{}'::jsonb
);

create index if not exists early_entry_regime_observations_time_idx
  on public.early_entry_regime_observations (observed_at desc);

alter table public.early_entry_regime_observations enable row level security;
-- Service-role Edge Functions own writes; no public client access policy is added.
