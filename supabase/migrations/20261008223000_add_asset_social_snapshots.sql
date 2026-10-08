-- Research-only social activity snapshots from CoinLore.
-- Free public API; no authentication. No trading/signal/risk/execution changes.

create table if not exists public.asset_social_snapshots (
  id uuid primary key default gen_random_uuid(),
  asset text not null,
  coinlore_id text not null,
  observed_at timestamptz not null,
  source text not null default 'coinlore',
  source_type text not null default 'social_activity',
  reddit_avg_active_users numeric,
  reddit_subscribers bigint,
  twitter_followers bigint,
  twitter_status_count bigint,
  availability jsonb not null default '{}'::jsonb,
  raw_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (asset, observed_at, source)
);

create index if not exists idx_asset_social_snapshots_observed_at
  on public.asset_social_snapshots(observed_at desc);

create index if not exists idx_asset_social_snapshots_asset_observed_at
  on public.asset_social_snapshots(asset, observed_at desc);

alter table public.asset_social_snapshots enable row level security;
revoke all on public.asset_social_snapshots from anon, authenticated;
grant all on public.asset_social_snapshots to service_role;
