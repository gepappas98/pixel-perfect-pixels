-- Shadow V2 is the primary benchmark source for Variant Performance.
-- The legacy get_variant_performance() remains available for historical comparison.
create or replace function public.get_shadow_v2_performance(days integer default 7)
returns table (
  strategy_name text,
  wins bigint,
  losses bigint,
  expired bigint,
  open_count bigint,
  resolved bigint,
  total_pnl_pct numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.strategy as strategy_name,
    count(*) filter (where p.status = 'CLOSED' and p.exit_reason = 'TP') as wins,
    count(*) filter (where p.status = 'CLOSED' and p.exit_reason = 'SL') as losses,
    count(*) filter (where p.status = 'CLOSED' and p.exit_reason = 'EXPIRED') as expired,
    count(*) filter (where p.status = 'OPEN') as open_count,
    count(*) filter (where p.status = 'CLOSED') as resolved,
    coalesce(sum(p.net_pnl_pct) filter (where p.status = 'CLOSED'), 0) * 100 as total_pnl_pct
  from public.shadow_v2_positions p
  where p.signal_created_at >= now() - make_interval(days => greatest(days, 1))
    and p.performance_mode = 'DEDUPLICATED'
  group by p.strategy;
$$;

grant execute on function public.get_shadow_v2_performance(integer)
  to anon, authenticated, service_role;