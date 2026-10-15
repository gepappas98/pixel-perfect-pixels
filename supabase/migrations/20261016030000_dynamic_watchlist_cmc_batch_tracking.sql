-- Track which CMC listing batch was consumed by each watchlist snapshot.
-- Nullable for historical snapshots; the first refreshed snapshot after deployment
-- will consume the currently stored CMC batch and avoid a repeated refresh.
alter table public.dynamic_watchlist_snapshots
  add column if not exists cmc_snapshot_at timestamptz;
