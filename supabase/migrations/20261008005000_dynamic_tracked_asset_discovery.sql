-- Dynamic Binance Spot asset discovery for the shadow research universe.
-- Historical rows are retained; only tracked_assets.enabled changes.

create or replace function public.refresh_tracked_assets_dynamic(
  p_candidates jsonb,
  p_limit integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(4, least(coalesce(p_limit,30), 50));
  v_selected integer := 0;
begin
  update public.tracked_assets
  set enabled=false, updated_at=now();

  with candidates as (
    select
      upper(x.asset) asset,
      upper(x.binance_symbol) binance_symbol,
      coalesce((x.volume_24h)::numeric,0) volume_24h,
      coalesce((x.quote_volume_24h)::numeric,0) quote_volume_24h,
      coalesce((x.whale_alerts_7d)::numeric,0) whale_alerts_7d,
      coalesce((x.whale_usd_7d)::numeric,0) whale_usd_7d,
      coalesce((x.watchlist)::boolean,false) watchlist
    from jsonb_to_recordset(coalesce(p_candidates,'[]'::jsonb)) as x(
      asset text, binance_symbol text, volume_24h numeric,
      quote_volume_24h numeric, whale_alerts_7d numeric,
      whale_usd_7d numeric, watchlist boolean
    )
    where x.asset is not null
      and x.binance_symbol ~ '^[A-Z0-9]+USDT$'
  ),
  scored as (
    select c.*,
      case when c.asset in ('BTC','ETH','SOL','BNB') then 1000000 else 0 end
      + ln(1+greatest(c.quote_volume_24h,0))*12
      + ln(1+greatest(c.whale_usd_7d,0))*6
      + ln(1+greatest(c.whale_alerts_7d,0))*4
      + case when c.watchlist then 50 else 0 end as score
    from candidates c
  ),
  ranked as (
    select *,row_number() over(order by score desc, asset) rn
    from scored
  )
  insert into public.tracked_assets
    (asset,binance_symbol,tier,enabled,selection_score,selection_reason,last_selected_at,updated_at)
  select
    r.asset,r.binance_symbol,
    case when r.asset in ('BTC','ETH','SOL','BNB') then 'core' else 'tracked' end,
    true,round(r.score::numeric,6),
    jsonb_build_object(
      'method','binance_spot_dynamic_volume_plus_whale_activity_plus_watchlist',
      'rank',r.rn,
      'quote_volume_24h',round(r.quote_volume_24h::numeric,2),
      'volume_24h',round(r.volume_24h::numeric,8),
      'whale_alerts_7d',round(r.whale_alerts_7d::numeric,0),
      'whale_usd_7d',round(r.whale_usd_7d::numeric,2),
      'watchlist',r.watchlist
    ),
    now(),now()
  from ranked r
  where r.rn<=v_limit
  on conflict(asset) do update set
    binance_symbol=excluded.binance_symbol,
    tier=excluded.tier,
    enabled=true,
    selection_score=excluded.selection_score,
    selection_reason=excluded.selection_reason,
    last_selected_at=now(),
    updated_at=now();

  select count(*) into v_selected from public.tracked_assets where enabled;
  return jsonb_build_object('ok',true,'selected',v_selected,'limit',v_limit,'shadow_only',true);
exception when others then
  raise warning '[TRACKED_ASSETS_DYNAMIC] %',sqlerrm;
  return jsonb_build_object('ok',false,'error',sqlerrm,'shadow_only',true);
end;
$$;

revoke all on function public.refresh_tracked_assets_dynamic(jsonb,integer) from public,anon,authenticated;
grant execute on function public.refresh_tracked_assets_dynamic(jsonb,integer) to service_role;
notify pgrst,'reload schema';