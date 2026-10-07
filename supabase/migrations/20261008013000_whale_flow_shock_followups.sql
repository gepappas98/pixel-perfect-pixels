-- P2 — Whale Flow Shock Follow-up (shadow research only)
create table if not exists public.whale_flow_shock_followups (
  id uuid primary key default gen_random_uuid(),
  transition_id uuid not null unique references public.whale_flow_transitions(id) on delete cascade,
  shock_at timestamptz not null,
  shock_delta_pp numeric not null,
  shock_speed text,
  flow_15m numeric,
  flow_30m numeric,
  flow_60m numeric,
  flow_4h numeric,
  flow_24h numeric,
  delta_15m_pp numeric,
  delta_30m_pp numeric,
  delta_60m_pp numeric,
  delta_4h_pp numeric,
  delta_24h_pp numeric,
  velocity_0_15_pph numeric,
  velocity_15_30_pph numeric,
  acceleration_pph2 numeric,
  peak_abs_delta_4h_pp numeric,
  time_to_peak_minutes integer,
  btc_return_15m numeric,
  btc_return_30m numeric,
  btc_return_1h numeric,
  btc_return_4h numeric,
  btc_return_24h numeric,
  flow_response text not null default 'insufficient_data'
    check (flow_response in ('continued','reversed','flat','insufficient_data')),
  price_response text not null default 'insufficient_data'
    check (price_response in ('confirmed','opposed','flat','insufficient_data')),
  curvature text not null default 'insufficient_data'
    check (curvature in ('convex','accelerating','linear','decelerating','reversing','insufficient_data')),
  data_quality text not null default 'partial'
    check (data_quality in ('partial','complete_15m','complete_1h','complete_4h','complete_24h')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whale_flow_shock_followups_shock_at
  on public.whale_flow_shock_followups(shock_at desc);

alter table public.whale_flow_shock_followups enable row level security;

drop policy if exists "whale_flow_shock_followups_public_read" on public.whale_flow_shock_followups;
create policy "whale_flow_shock_followups_public_read"
  on public.whale_flow_shock_followups
  for select
  using (true);

create or replace function public.refresh_whale_flow_shock_followups(p_lookback_hours integer default 48)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  with shocks as (
    select
      t.id as transition_id,
      t.detected_at as shock_at,
      t.delta_pp,
      t.transition_speed,
      s0.flow_score as flow0,
      f15.flow_score as flow15,
      f30.flow_score as flow30,
      f60.flow_score as flow60,
      f4h.flow_score as flow4h,
      f24.flow_score as flow24,
      p0.price as price0,
      p15.price as price15,
      p30.price as price30,
      p60.price as price60,
      p4h.price as price4h,
      p24.price as price24
    from public.whale_flow_transitions t
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at <= t.detected_at order by bucket_at desc limit 1
    ) s0 on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at + interval '12 minutes' and t.detected_at + interval '18 minutes'
      order by abs(extract(epoch from (bucket_at - (t.detected_at + interval '15 minutes')))) limit 1
    ) f15 on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at + interval '27 minutes' and t.detected_at + interval '33 minutes'
      order by abs(extract(epoch from (bucket_at - (t.detected_at + interval '30 minutes')))) limit 1
    ) f30 on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at + interval '55 minutes' and t.detected_at + interval '65 minutes'
      order by abs(extract(epoch from (bucket_at - (t.detected_at + interval '60 minutes')))) limit 1
    ) f60 on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at + interval '3 hours 45 minutes' and t.detected_at + interval '4 hours 15 minutes'
      order by abs(extract(epoch from (bucket_at - (t.detected_at + interval '4 hours')))) limit 1
    ) f4h on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at + interval '23 hours 30 minutes' and t.detected_at + interval '24 hours 30 minutes'
      order by abs(extract(epoch from (bucket_at - (t.detected_at + interval '24 hours')))) limit 1
    ) f24 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and captured_at <= t.detected_at order by captured_at desc limit 1
    ) p0 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and captured_at between t.detected_at + interval '12 minutes' and t.detected_at + interval '18 minutes'
      order by abs(extract(epoch from (captured_at - (t.detected_at + interval '15 minutes')))) limit 1
    ) p15 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and captured_at between t.detected_at + interval '27 minutes' and t.detected_at + interval '33 minutes'
      order by abs(extract(epoch from (captured_at - (t.detected_at + interval '30 minutes')))) limit 1
    ) p30 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and captured_at between t.detected_at + interval '55 minutes' and t.detected_at + interval '65 minutes'
      order by abs(extract(epoch from (captured_at - (t.detected_at + interval '60 minutes')))) limit 1
    ) p60 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and captured_at between t.detected_at + interval '3 hours 45 minutes' and t.detected_at + interval '4 hours 15 minutes'
      order by abs(extract(epoch from (captured_at - (t.detected_at + interval '4 hours')))) limit 1
    ) p4h on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and captured_at between t.detected_at + interval '23 hours 30 minutes' and t.detected_at + interval '24 hours 30 minutes'
      order by abs(extract(epoch from (captured_at - (t.detected_at + interval '24 hours')))) limit 1
    ) p24 on true
    where abs(t.delta_pp) >= 5
      and t.detected_at >= now() - make_interval(hours => greatest(p_lookback_hours,1))
  ),
  calc as (
    select *,
      case when flow15 is not null and flow0 is not null then flow15-flow0 end as d15,
      case when flow30 is not null and flow0 is not null then flow30-flow0 end as d30,
      case when flow60 is not null and flow0 is not null then flow60-flow0 end as d60,
      case when flow4h is not null and flow0 is not null then flow4h-flow0 end as d4h,
      case when flow24 is not null and flow0 is not null then flow24-flow0 end as d24,
      case when price0 is not null and price15 is not null then (price15-price0)/nullif(price0,0) end as r15,
      case when price0 is not null and price30 is not null then (price30-price0)/nullif(price0,0) end as r30,
      case when price0 is not null and price60 is not null then (price60-price0)/nullif(price0,0) end as r60,
      case when price0 is not null and price4h is not null then (price4h-price0)/nullif(price0,0) end as r4h,
      case when price0 is not null and price24 is not null then (price24-price0)/nullif(price0,0) end as r24
    from shocks
  )
  insert into public.whale_flow_shock_followups (
    transition_id,shock_at,shock_delta_pp,shock_speed,
    flow_15m,flow_30m,flow_60m,flow_4h,flow_24h,
    delta_15m_pp,delta_30m_pp,delta_60m_pp,delta_4h_pp,delta_24h_pp,
    velocity_0_15_pph,velocity_15_30_pph,acceleration_pph2,
    btc_return_15m,btc_return_30m,btc_return_1h,btc_return_4h,btc_return_24h,
    flow_response,price_response,curvature,data_quality,updated_at
  )
  select
    transition_id,shock_at,delta_pp,transition_speed,
    flow15,flow30,flow60,flow4h,flow24,
    d15,d30,d60,d4h,d24,
    case when d15 is not null then d15/0.25 end,
    case when d15 is not null and d30 is not null then (d30-d15)/0.25 end,
    case when d15 is not null and d30 is not null then ((d30-d15)/0.25)-(d15/0.25) end,
    r15,r30,r60,r4h,r24,
    case
      when d15 is null then 'insufficient_data'
      when sign(d15)=sign(delta_pp) and abs(d15)>=5 then 'continued'
      when sign(d15)<>sign(delta_pp) and abs(d15)>=5 then 'reversed'
      else 'flat'
    end,
    case
      when r15 is null then 'insufficient_data'
      when sign(r15)=sign(delta_pp) and abs(r15)>=0.002 then 'confirmed'
      when sign(r15)<>sign(delta_pp) and abs(r15)>=0.002 then 'opposed'
      else 'flat'
    end,
    case
      when d15 is null or d30 is null then 'insufficient_data'
      when sign(d15)<>sign(d30) and abs(d30-d15)>=2 then 'reversing'
      when abs(d30)>abs(d15)*1.25 then 'convex'
      when abs(d30)>abs(d15)*1.05 then 'accelerating'
      when abs(d30)>=abs(d15)*0.8 then 'linear'
      else 'decelerating'
    end,
    case
      when d24 is not null then 'complete_24h'
      when d4h is not null then 'complete_4h'
      when d60 is not null then 'complete_1h'
      when d15 is not null then 'complete_15m'
      else 'partial'
    end,
    now()
  from calc
  on conflict (transition_id) do update set
    shock_at=excluded.shock_at,
    shock_delta_pp=excluded.shock_delta_pp,
    shock_speed=excluded.shock_speed,
    flow_15m=excluded.flow_15m, flow_30m=excluded.flow_30m, flow_60m=excluded.flow_60m,
    flow_4h=excluded.flow_4h, flow_24h=excluded.flow_24h,
    delta_15m_pp=excluded.delta_15m_pp, delta_30m_pp=excluded.delta_30m_pp,
    delta_60m_pp=excluded.delta_60m_pp, delta_4h_pp=excluded.delta_4h_pp, delta_24h_pp=excluded.delta_24h_pp,
    velocity_0_15_pph=excluded.velocity_0_15_pph, velocity_15_30_pph=excluded.velocity_15_30_pph,
    acceleration_pph2=excluded.acceleration_pph2,
    btc_return_15m=excluded.btc_return_15m, btc_return_30m=excluded.btc_return_30m,
    btc_return_1h=excluded.btc_return_1h, btc_return_4h=excluded.btc_return_4h, btc_return_24h=excluded.btc_return_24h,
    flow_response=excluded.flow_response, price_response=excluded.price_response,
    curvature=excluded.curvature, data_quality=excluded.data_quality, updated_at=now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.refresh_whale_flow_shock_followups(integer) from public, anon, authenticated;
grant execute on function public.refresh_whale_flow_shock_followups(integer) to service_role;