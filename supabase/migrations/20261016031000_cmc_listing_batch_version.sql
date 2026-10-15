-- Distinguish the original Top-200 snapshots from the new paginated listing batches.
-- Legacy rows default to v1, triggering one immediate v2 refresh after deployment.
alter table public.cmc_listing_snapshots
  add column if not exists batch_version integer not null default 1;
