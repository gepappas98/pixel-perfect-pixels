-- Parallel paper-only Early Reversal experiments. Additive: preserve existing trades and observations.
alter table public.trades drop constraint if exists trades_entry_source_check;
alter table public.trades add constraint trades_entry_source_check
  check (entry_source in ('standard','early_entry_regime','early_entry_b_reversal','early_entry_c_adaptive','event_flow_paper','whale_shock','live_exchange'));
create index if not exists trades_early_entry_variant_idx
  on public.trades (entry_source, status, created_at desc);
create table if not exists public.early_entry_variant_decisions (
  id bigint generated always as identity primary key,
  observed_at timestamptz not null default now(),
  variant text not null check (variant in ('A_CURRENT','B_EARLY_REVERSAL','C_ADAPTIVE_REVERSAL')),
  symbol text,
  decision text not null,
  reason text not null,
  decision_key text not null unique,
  metrics jsonb not null default '{}'::jsonb,
  trade_id uuid references public.trades(id) on delete set null
);
create index if not exists early_entry_variant_decisions_time_idx on public.early_entry_variant_decisions (observed_at desc);
create index if not exists early_entry_variant_decisions_variant_idx on public.early_entry_variant_decisions (variant, observed_at desc);
alter table public.early_entry_variant_decisions enable row level security;
