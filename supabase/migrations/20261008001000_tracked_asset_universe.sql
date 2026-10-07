-- Tracked Asset Universe v1
-- Shadow-only. Does not modify signal scoring, V1/V2, strategy selection, or execution.

create table if not exists public.tracked_assets (
  asset text primary key,
  binance_symbol text not null,
  revolut_symbol text,
  tier text not null default 'tracked' check (tier in ('core','tracked')),
  enabled boolean not null default false,
  selection_score numeric(18,6) not null default 0,
  selection_reason jsonb not null default '{}'::jsonb,
  last_selected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tracked_assets_enabled
  on public.tracked_assets (enabled, selection_score desc);

alter table public.tracked_assets enable row level security;

drop policy if exists "tracked_assets_public_read" on public.tracked_assets;
create policy "tracked_assets_public_read"
  on public.tracked_assets for select to anon, authenticated using (true);

create or replace function public.refresh_tracked_assets(p_limit integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(4, least(coalesce(p_limit,30), 50));
  v_selected integer := 0;
begin
  -- Disable the previous selection first. The existing trading watchlist remains untouched.
  update public.tracked_assets
  set enabled = false, updated_at = now();

  with latest_watchlist as (
    select symbols
    from public.dynamic_watchlist_snapshots
    order by computed_at desc
    limit 1
  ),
  candidates as (
    select distinct upper(x.asset) as asset
    from (
      select unnest(array['BTC','ETH','SOL','BNB']) as asset
      union all
      select unnest(coalesce((select symbols from latest_watchlist), array[]::text[]))
      union all
      select wa.symbol
      from public.whale_alerts wa
      where wa.created_at >= now() - interval '7 days'
    ) x
    where x.asset is not null and x.asset <> ''
  ),
  stats as (
    select
      c.asset,
      case when c.asset in ('BTC','ETH','SOL','BNB') then 1000 else 0 end
      + ln(1 + coalesce(sum(wa.usd_value),0)) * 10
      + ln(1 + count(wa.id)) * 5 as score,
      count(wa.id) as whale_alerts_7d,
      coalesce(sum(wa.usd_value),0) as whale_usd_7d
    from candidates c
    left join public.whale_alerts wa
      on upper(wa.symbol)=c.asset
     and wa.created_at >= now() - interval '7 days'
    group by c.asset
  ),
  ranked as (
    select *,
      row_number() over(order by score desc, asset) as rn
    from stats
  )
  insert into public.tracked_assets
    (asset,binance_symbol,revolut_symbol,tier,enabled,selection_score,selection_reason,last_selected_at,updated_at)
  select
    r.asset,
    case
      when r.asset='MATIC' then 'POLUSDT'
      when r.asset='RNDR' then 'RENDERUSDT'
      else r.asset || 'USDT'
    end,
    null,
    case when r.asset in ('BTC','ETH','SOL','BNB') then 'core' else 'tracked' end,
    r.rn <= v_limit,
    round(r.score::numeric,6),
    jsonb_build_object(
      'method','core_plus_existing_watchlist_plus_7d_whale_activity',
      'rank',r.rn,
      'whale_alerts_7d',r.whale_alerts_7d,
      'whale_usd_7d',round(r.whale_usd_7d::numeric,2)
    ),
    case when r.rn <= v_limit then now() else null end,
    now()
  from ranked r
  where r.rn <= v_limit
  on conflict (asset) do update set
    binance_symbol=excluded.binance_symbol,
    tier=excluded.tier,
    enabled=excluded.enabled,
    selection_score=excluded.selection_score,
    selection_reason=excluded.selection_reason,
    last_selected_at=case when excluded.enabled then now() else public.tracked_assets.last_selected_at end,
    updated_at=now();

  select count(*) into v_selected
  from public.tracked_assets
  where enabled;

  return jsonb_build_object(
    'ok',true,
    'selected',v_selected,
    'limit',v_limit,
    'shadow_only',true,
    'source','existing Binance-eligible watchlist + whale activity'
  );
exception when others then
  raise warning '[TRACKED_ASSETS] refresh failed: %', sqlerrm;
  return jsonb_build_object('ok',false,'error',sqlerrm,'shadow_only',true);
end;
$$;

revoke execute on function public.refresh_tracked_assets(integer) from public, anon, authenticated;
grant execute on function public.refresh_tracked_assets(integer) to service_role;

notify pgrst,'reload schema';
