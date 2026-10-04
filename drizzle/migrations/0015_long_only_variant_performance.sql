-- Long-only production benchmark: SELL variants are not executable and must
-- not affect resolved counts, win rate, PnL, or strategy auto-selection.
create or replace function public.get_variant_performance(days integer default 7)
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
    s.strategy_name,
    count(*) filter (where s.outcome = 'win') as wins,
    count(*) filter (where s.outcome = 'loss') as losses,
    count(*) filter (where s.outcome = 'expired') as expired,
    count(*) filter (where s.outcome = 'open') as open_count,
    count(*) filter (where s.outcome in ('win','loss','expired')) as resolved,
    coalesce(sum(s.pnl_pct) filter (where s.outcome in ('win','loss','expired')), 0)::numeric as total_pnl_pct
  from public.strategy_variant_signals s
  where s.created_at >= now() - make_interval(days => greatest(days, 1))
    and s.recommendation = 'buy'
  group by s.strategy_name;
$$;

grant execute on function public.get_variant_performance(integer) to anon, authenticated, service_role;
