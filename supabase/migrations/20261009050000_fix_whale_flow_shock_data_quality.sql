-- Correct Whale Flow Shock Follow-up quality labels.
-- Previously data_quality only checked flow horizons (d15/d60/d4h/d24)
-- and could label a row complete even when the matching BTC price horizon
-- was unavailable. Keep raw observations unchanged; recompute derived rows.
create or replace function public.refresh_whale_flow_shock_followups(p_lookback_hours integer default 48)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare v_count integer := 0;
begin
  with shocks as (
    select t.id transition_id,t.detected_at shock_at,t.delta_pp,t.transition_speed,
      s0.flow_score flow0,f15.flow_score flow15,f30.flow_score flow30,
      f60.flow_score flow60,f4h.flow_score flow4h,f24.flow_score flow24,
      p0.price price0,p15.price price15,p30.price price30,p60.price price60,
      p4h.price price4h,p24.price price24,
      peak.peak_abs_delta_4h_pp,peak.time_to_peak_minutes
    from public.whale_flow_transitions t
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at<=t.detected_at order by bucket_at desc limit 1
    ) s0 on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at+interval '12 minutes' and t.detected_at+interval '18 minutes'
      order by abs(extract(epoch from(bucket_at-(t.detected_at+interval '15 minutes')))) limit 1
    ) f15 on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at+interval '27 minutes' and t.detected_at+interval '33 minutes'
      order by abs(extract(epoch from(bucket_at-(t.detected_at+interval '30 minutes')))) limit 1
    ) f30 on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at+interval '55 minutes' and t.detected_at+interval '65 minutes'
      order by abs(extract(epoch from(bucket_at-(t.detected_at+interval '60 minutes')))) limit 1
    ) f60 on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at+interval '3 hours 45 minutes' and t.detected_at+interval '4 hours 15 minutes'
      order by abs(extract(epoch from(bucket_at-(t.detected_at+interval '4 hours')))) limit 1
    ) f4h on true
    left join lateral (
      select flow_score from public.whale_flow_snapshots
      where bucket_at between t.detected_at+interval '23 hours 30 minutes' and t.detected_at+interval '24 hours 30 minutes'
      order by abs(extract(epoch from(bucket_at-(t.detected_at+interval '24 hours')))) limit 1
    ) f24 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and observed_at<=t.detected_at order by observed_at desc limit 1
    ) p0 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and observed_at between t.detected_at+interval '12 minutes' and t.detected_at+interval '18 minutes'
      order by abs(extract(epoch from(observed_at-(t.detected_at+interval '15 minutes')))) limit 1
    ) p15 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and observed_at between t.detected_at+interval '27 minutes' and t.detected_at+interval '33 minutes'
      order by abs(extract(epoch from(observed_at-(t.detected_at+interval '30 minutes')))) limit 1
    ) p30 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and observed_at between t.detected_at+interval '55 minutes' and t.detected_at+interval '65 minutes'
      order by abs(extract(epoch from(observed_at-(t.detected_at+interval '60 minutes')))) limit 1
    ) p60 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and observed_at between t.detected_at+interval '3 hours 45 minutes' and t.detected_at+interval '4 hours 15 minutes'
      order by abs(extract(epoch from(observed_at-(t.detected_at+interval '4 hours')))) limit 1
    ) p4h on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and observed_at between t.detected_at+interval '23 hours 30 minutes' and t.detected_at+interval '24 hours 30 minutes'
      order by abs(extract(epoch from(observed_at-(t.detected_at+interval '24 hours')))) limit 1
    ) p24 on true
    left join lateral (
      select max(abs((ws.flow_score-s0.flow_score)*100)) peak_abs_delta_4h_pp,
        (array_agg(extract(epoch from(ws.bucket_at-t.detected_at))/60.0
          order by abs((ws.flow_score-s0.flow_score)*100) desc,ws.bucket_at asc))[1]::integer time_to_peak_minutes
      from public.whale_flow_snapshots ws
      where s0.flow_score is not null and ws.bucket_at>t.detected_at
        and ws.bucket_at<=t.detected_at+interval '4 hours'
    ) peak on true
    where abs(t.delta_pp)>=5
      and t.detected_at>=now()-make_interval(hours=>greatest(p_lookback_hours,1))
  ),
  calc as (
    select *,
      case when flow15 is not null and flow0 is not null then (flow15-flow0)*100 end d15,
      case when flow30 is not null and flow0 is not null then (flow30-flow0)*100 end d30,
      case when flow60 is not null and flow0 is not null then (flow60-flow0)*100 end d60,
      case when flow4h is not null and flow0 is not null then (flow4h-flow0)*100 end d4h,
      case when flow24 is not null and flow0 is not null then (flow24-flow0)*100 end d24,
      case when price0 is not null and price15 is not null then(price15-price0)/nullif(price0,0) end r15,
      case when price0 is not null and price30 is not null then(price30-price0)/nullif(price0,0) end r30,
      case when price0 is not null and price60 is not null then(price60-price0)/nullif(price0,0) end r60,
      case when price0 is not null and price4h is not null then(price4h-price0)/nullif(price0,0) end r4h,
      case when price0 is not null and price24 is not null then(price24-price0)/nullif(price0,0) end r24
    from shocks
  )
  insert into public.whale_flow_shock_followups(
    transition_id,shock_at,shock_delta_pp,shock_speed,flow_15m,flow_30m,flow_60m,flow_4h,flow_24h,
    delta_15m_pp,delta_30m_pp,delta_60m_pp,delta_4h_pp,delta_24h_pp,
    velocity_0_15_pph,velocity_15_30_pph,acceleration_pph2,peak_abs_delta_4h_pp,time_to_peak_minutes,
    btc_return_15m,btc_return_30m,btc_return_1h,btc_return_4h,btc_return_24h,
    flow_response,price_response,curvature,data_quality,updated_at)
  select transition_id,shock_at,delta_pp,transition_speed,flow15,flow30,flow60,flow4h,flow24,
    d15,d30,d60,d4h,d24,
    case when d15 is not null then d15/0.25 end,
    case when d15 is not null and d30 is not null then(d30-d15)/0.25 end,
    case when d15 is not null and d30 is not null then((d30-d15)/0.25)-(d15/0.25) end,
    peak_abs_delta_4h_pp,time_to_peak_minutes,r15,r30,r60,r4h,r24,
    case when d15 is null then'insufficient_data'
      when sign(d15)=sign(delta_pp) and abs(d15)>=5 then'continued'
      when sign(d15)<>sign(delta_pp) and abs(d15)>=5 then'reversed'
      else'flat' end,
    case when r15 is null then'insufficient_data'
      when sign(r15)=sign(delta_pp) and abs(r15)>=0.002 then'confirmed'
      when sign(r15)<>sign(delta_pp) and abs(r15)>=0.002 then'opposed'
      else'flat' end,
    case when d15 is null or d30 is null then'insufficient_data'
      when sign(d15)<>sign(d30) and abs(d30-d15)>=2 then'reversing'
      when abs(d30)>abs(d15)*1.25 then'convex'
      when abs(d30)>abs(d15)*1.05 then'accelerating'
      when abs(d30)>=abs(d15)*0.8 then'linear'
      else'decelerating' end,
    -- A horizon is complete only when BOTH flow and BTC price are present.
    case when d24 is not null and r24 is not null then'complete_24h'
      when d4h is not null and r4h is not null then'complete_4h'
      when d60 is not null and r60 is not null then'complete_1h'
      when d15 is not null and r15 is not null then'complete_15m'
      else'partial' end,
    now()
  from calc
  on conflict(transition_id) do update set
    peak_abs_delta_4h_pp=excluded.peak_abs_delta_4h_pp,time_to_peak_minutes=excluded.time_to_peak_minutes,
    shock_at=excluded.shock_at,shock_delta_pp=excluded.shock_delta_pp,shock_speed=excluded.shock_speed,
    flow_15m=excluded.flow_15m,flow_30m=excluded.flow_30m,flow_60m=excluded.flow_60m,flow_4h=excluded.flow_4h,flow_24h=excluded.flow_24h,
    delta_15m_pp=excluded.delta_15m_pp,delta_30m_pp=excluded.delta_30m_pp,delta_60m_pp=excluded.delta_60m_pp,
    delta_4h_pp=excluded.delta_4h_pp,delta_24h_pp=excluded.delta_24h_pp,
    velocity_0_15_pph=excluded.velocity_0_15_pph,velocity_15_30_pph=excluded.velocity_15_30_pph,
    acceleration_pph2=excluded.acceleration_pph2,btc_return_15m=excluded.btc_return_15m,btc_return_30m=excluded.btc_return_30m,
    btc_return_1h=excluded.btc_return_1h,btc_return_4h=excluded.btc_return_4h,btc_return_24h=excluded.btc_return_24h,
    flow_response=excluded.flow_response,price_response=excluded.price_response,curvature=excluded.curvature,
    data_quality=excluded.data_quality,updated_at=now();

  get diagnostics v_count=row_count;
  return v_count;
end;
$function$;

revoke execute on function public.refresh_whale_flow_shock_followups(integer) from public,anon,authenticated;
grant execute on function public.refresh_whale_flow_shock_followups(integer) to service_role;


-- One-time recomputation of the existing seven-day transition sample.
-- The ongoing collector continues using its existing bounded 48-hour refresh.
select public.refresh_whale_flow_shock_followups(168);
