-- Global market sentiment context from Alternative.me. This is deliberately separate
-- from per-asset sentiment so the global index is never misattributed to individual coins.
create table if not exists public.market_sentiment_snapshots (
  id uuid primary key default gen_random_uuid(),
  observed_at timestamptz not null,
  source text not null,
  value integer not null check (value between 0 and 100),
  classification text not null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(source, observed_at)
);

create index if not exists idx_market_sentiment_snapshots_time
  on public.market_sentiment_snapshots(observed_at desc);

alter table public.market_sentiment_snapshots enable row level security;
drop policy if exists "market_sentiment_snapshots_public_read" on public.market_sentiment_snapshots;
create policy "market_sentiment_snapshots_public_read" on public.market_sentiment_snapshots
  for select to anon, authenticated using (true);
grant select on public.market_sentiment_snapshots to anon, authenticated;
