create or replace function public.get_system_resource_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
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
    (select count(*)::bigint from public.strategy_variant_signals)
);
$$;

revoke all on function public.get_system_resource_stats() from public, anon, authenticated;
grant execute on function public.get_system_resource_stats() to anon, authenticated, service_role;