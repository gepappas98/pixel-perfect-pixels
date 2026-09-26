create or replace function public.get_portfolio_summary()
returns table (
  open_count bigint,
  open_notional numeric,
  closed_count bigint,
  realized_pnl numeric,
  win_rate_pct numeric,
  win_count bigint,
  loss_count bigint,
  gross_profit numeric,
  gross_loss numeric,
  profit_factor numeric,
  avg_win_usd numeric,
  avg_loss_usd numeric,
  last_24h_closed bigint,
  last_24h_pnl numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with open_stats as (
    select
      count(*) as open_count,
      coalesce(sum(entry_price * quantity), 0) as open_notional
    from public.trades
    where status = 'open'
  ),
  closed_stats as (
    select
      count(*) as closed_count,
      coalesce(sum(pnl), 0) as realized_pnl,
      count(*) filter (where pnl > 0) as win_count,
      count(*) filter (where pnl < 0) as loss_count,
      coalesce(sum(pnl) filter (where pnl > 0), 0) as gross_profit,
      coalesce(abs(sum(pnl) filter (where pnl < 0)), 0) as gross_loss,
      coalesce(avg(pnl) filter (where pnl > 0), 0) as avg_win,
      coalesce(avg(pnl) filter (where pnl < 0), 0) as avg_loss
    from public.trades
    where status = 'closed'
      and close_reason in ('stop_loss', 'take_profit')
  ),
  recent as (
    select
      count(*) as last_24h_closed,
      coalesce(sum(pnl), 0) as last_24h_pnl
    from public.trades
    where status = 'closed'
      and closed_at >= now() - interval '24 hours'
  )
  select
    os.open_count,
    os.open_notional,
    cs.closed_count,
    cs.realized_pnl,
    case when cs.closed_count > 0
      then round((cs.win_count::numeric / cs.closed_count) * 100, 2)
      else 0 end as win_rate_pct,
    cs.win_count,
    cs.loss_count,
    cs.gross_profit,
    cs.gross_loss,
    case when cs.gross_loss > 0
      then round((cs.gross_profit / cs.gross_loss)::numeric, 2)
      else null end as profit_factor,
    round(cs.avg_win::numeric, 2) as avg_win_usd,
    round(cs.avg_loss::numeric, 2) as avg_loss_usd,
    r.last_24h_closed,
    r.last_24h_pnl
  from open_stats os, closed_stats cs, recent r;
$$;

grant execute on function public.get_portfolio_summary() to anon, authenticated, service_role;

notify pgrst, 'reload schema';