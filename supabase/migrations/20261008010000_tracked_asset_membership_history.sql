-- Persistent audit trail for the dynamic shadow research universe.
create table if not exists public.tracked_asset_membership_history (
  id uuid primary key default gen_random_uuid(),
  asset text not null,
  binance_symbol text not null,
  event_type text not null check (event_type in ('enter','exit','initial')),
  occurred_at timestamptz not null default now(),
  previous_enabled boolean,
  new_enabled boolean not null,
  selection_score numeric,
  selection_reason jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_tracked_asset_membership_history_asset_time on public.tracked_asset_membership_history(asset, occurred_at desc);
create index if not exists idx_tracked_asset_membership_history_time on public.tracked_asset_membership_history(occurred_at desc);
alter table public.tracked_asset_membership_history enable row level security;
drop policy if exists "tracked_asset_membership_history_public_read" on public.tracked_asset_membership_history;
create policy "tracked_asset_membership_history_public_read" on public.tracked_asset_membership_history for select using (true);

create or replace function public.audit_tracked_asset_membership()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op='INSERT' then
    if new.enabled then
      insert into public.tracked_asset_membership_history(asset,binance_symbol,event_type,occurred_at,previous_enabled,new_enabled,selection_score,selection_reason)
      values(new.asset,new.binance_symbol,'initial',now(),null,true,new.selection_score,coalesce(new.selection_reason,'{}'::jsonb));
    end if;
    return new;
  end if;
  if old.enabled is distinct from new.enabled then
    insert into public.tracked_asset_membership_history(asset,binance_symbol,event_type,occurred_at,previous_enabled,new_enabled,selection_score,selection_reason)
    values(new.asset,new.binance_symbol,case when new.enabled then 'enter' else 'exit' end,now(),old.enabled,new.enabled,new.selection_score,coalesce(new.selection_reason,'{}'::jsonb));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_audit_tracked_asset_membership on public.tracked_assets;
create trigger trg_audit_tracked_asset_membership after insert or update of enabled on public.tracked_assets for each row execute function public.audit_tracked_asset_membership();
revoke all on function public.audit_tracked_asset_membership() from public,anon,authenticated;
grant execute on function public.audit_tracked_asset_membership() to service_role;

create or replace function public.refresh_tracked_assets_dynamic(p_candidates jsonb,p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_limit integer:=greatest(4,least(coalesce(p_limit,30),50)); v_selected integer:=0;
begin
  create temp table _tracked_asset_selection on commit drop as
  with candidates as (
    select upper(x.asset) asset,upper(x.binance_symbol) binance_symbol,
      coalesce(x.volume_24h::numeric,0) volume_24h,coalesce(x.quote_volume_24h::numeric,0) quote_volume_24h,
      coalesce(x.whale_alerts_7d::numeric,0) whale_alerts_7d,coalesce(x.whale_usd_7d::numeric,0) whale_usd_7d,
      coalesce(x.watchlist::boolean,false) watchlist
    from jsonb_to_recordset(coalesce(p_candidates,'[]'::jsonb)) x(asset text,binance_symbol text,volume_24h numeric,quote_volume_24h numeric,whale_alerts_7d numeric,whale_usd_7d numeric,watchlist boolean)
    where x.asset is not null and x.binance_symbol ~ '^[A-Z0-9]+USDT$'
  ), scored as (
    select c.*,case when c.asset in ('BTC','ETH','SOL','BNB') then 1000000 else 0 end
      +ln(1+greatest(c.quote_volume_24h,0))*12+ln(1+greatest(c.whale_usd_7d,0))*6
      +ln(1+greatest(c.whale_alerts_7d,0))*4+case when c.watchlist then 50 else 0 end score
    from candidates c
  ), ranked as (
    select *,row_number() over(order by score desc,asset) rn from scored
  ) select * from ranked where rn<=v_limit;

  update public.tracked_assets t set enabled=false,updated_at=now()
  where t.enabled and not exists(select 1 from _tracked_asset_selection s where s.asset=t.asset);

  insert into public.tracked_assets(asset,binance_symbol,tier,enabled,selection_score,selection_reason,last_selected_at,updated_at)
  select s.asset,s.binance_symbol,case when s.asset in ('BTC','ETH','SOL','BNB') then 'core' else 'tracked' end,true,
    round(s.score::numeric,6),
    jsonb_build_object('method','binance_spot_dynamic_volume_plus_whale_activity_plus_watchlist','rank',s.rn,
      'quote_volume_24h',round(s.quote_volume_24h::numeric,2),'volume_24h',round(s.volume_24h::numeric,8),
      'whale_alerts_7d',round(s.whale_alerts_7d::numeric,0),'whale_usd_7d',round(s.whale_usd_7d::numeric,2),'watchlist',s.watchlist),
    now(),now()
  from _tracked_asset_selection s
  on conflict(asset) do update set binance_symbol=excluded.binance_symbol,tier=excluded.tier,enabled=true,
    selection_score=excluded.selection_score,selection_reason=excluded.selection_reason,last_selected_at=now(),updated_at=now();

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