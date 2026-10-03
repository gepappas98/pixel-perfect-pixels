CREATE OR REPLACE FUNCTION public.get_system_resource_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
SELECT jsonb_build_object(
  'current_connections', (SELECT count(*)::int FROM pg_stat_activity),
  'max_connections', (SELECT setting::int FROM pg_settings WHERE name = 'max_connections'),
  'total_db_size_bytes', pg_database_size(current_database()),
  'total_db_size_pretty', pg_size_pretty(pg_database_size(current_database())),
  'cache_hit_pct', (SELECT round((sum(blks_hit) * 100.0 / nullif(sum(blks_hit + blks_read), 0)), 2) FROM pg_stat_database),
  'variant_signals_count', (SELECT reltuples::bigint FROM pg_class WHERE relname = 'strategy_variant_signals' AND relnamespace = 'public'::regnamespace)
);
$$;
REVOKE ALL ON FUNCTION public.get_system_resource_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_system_resource_stats() TO service_role;