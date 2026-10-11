-- Record one lightweight database-size snapshot per hour and expose a real daily-growth
-- comparison through the existing System Resources RPC. No historical records are changed.
create schema if not exists private;

create table if not exists private.storage_size_snapshots (
  snapshot_hour timestamptz primary key,
  captured_at timestamptz not null default now(),
  database_size_bytes bigint not null check (database_size_bytes >= 0)
);

create index if not exists storage_size_snapshots_captured_at_idx
  on private.storage_size_snapshots (captured_at desc);

-- Seed the baseline immediately; subsequent hourly samples are append-only.
insert into private.storage_size_snapshots (snapshot_hour, captured_at, database_size_bytes)
values (
  date_trunc('hour', now()),
  now(),
  pg_database_size(current_database())
)
on conflict (snapshot_hour) do nothing;

-- Keep this private table inaccessible through the public Data API.
revoke all on table private.storage_size_snapshots from public, anon, authenticated;

-- Recreate only this named sampler job, leaving the pipeline and watchdog untouched.
select cron.unschedule(jobid)
from cron.job
where jobname = 'daily-storage-size-snapshot';

select cron.schedule(
  'daily-storage-size-snapshot',
  '13 * * * *',
  $job$
    insert into private.storage_size_snapshots (snapshot_hour, captured_at, database_size_bytes)
    values (
      date_trunc('hour', now()),
      now(),
      pg_database_size(current_database())
    )
    on conflict (snapshot_hour) do nothing;
  $job$
);

create or replace function public.get_system_resource_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
with latest as (
  select captured_at, database_size_bytes
  from private.storage_size_snapshots
  order by captured_at desc
  limit 1
),
comparison as (
  select baseline.captured_at, baseline.database_size_bytes
  from latest
  join lateral (
    select s.captured_at, s.database_size_bytes
    from private.storage_size_snapshots s
    where s.captured_at <= latest.captured_at - interval '20 hours'
      and s.captured_at >= latest.captured_at - interval '28 hours'
    order by abs(extract(epoch from (s.captured_at - (latest.captured_at - interval '24 hours'))))
    limit 1
  ) baseline on true
)
select jsonb_build_object(
  'current_connections',
    (select count(*)::int from pg_stat_activity where backend_type = 'client backend'),
  'max_connections',
    (select setting::int from pg_settings where name = 'max_connections'),
  'total_db_size_bytes',
    pg_database_size(current_database()),
  'total_db_size_pretty',
    pg_size_pretty(pg_database_size(current_database())),
  'cache_hit_pct',
    (select round((sum(blks_hit) * 100.0 / nullif(sum(blks_hit + blks_read), 0)), 2)
       from pg_stat_database),
  'variant_signals_count',
    (select count(*)::bigint from public.strategy_variant_signals),
  'daily_growth_mb',
    (select round((latest.database_size_bytes - comparison.database_size_bytes)::numeric / 1000000, 2)
       from latest cross join comparison),
  'daily_growth_window_hours',
    (select round(extract(epoch from (latest.captured_at - comparison.captured_at))::numeric / 3600, 1)
       from latest cross join comparison),
  'storage_sampled_at',
    (select latest.captured_at from latest)
);
$$;

revoke all on function public.get_system_resource_stats() from public, anon, authenticated;
grant execute on function public.get_system_resource_stats() to anon, authenticated, service_role;
