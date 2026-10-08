-- Shadow-only statistical event-study snapshots.
-- Aggregates Event -> Flow -> Price observations without touching execution/V1/V2.
-- 4h/24h intentionally do not fabricate a flow delta because event_flow_transmissions
-- currently exposes flow response only through 60m; price horizons remain valid.

create table if not exists public.event_flow_study_snapshots (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  horizon text not null check (horizon in ('15m','30m','1h','4h','24h')),
  source_kind text not null,
  event_direction smallint not null check (event_direction in (-1,0,1)),
  transmission_class text not null,
  n integer not null,
  flow_delta_mean numeric,
  flow_delta_median numeric,
  flow_delta_abs_mean numeric,
  flow_same_direction_rate numeric,
  price_return_mean numeric,
  price_return_median numeric,
  price_same_direction_rate numeric,
  velocity_mean numeric,
  acceleration_mean numeric,
  peak_flow_delta_mean numeric,
  time_to_peak_median_minutes numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_event_flow_study_snapshots_run
  on public.event_flow_study_snapshots(run_at desc);

create index if not exists idx_event_flow_study_snapshots_dimensions
  on public.event_flow_study_snapshots(horizon, source_kind, event_direction, transmission_class);

create or replace function public.capture_event_flow_study_snapshot()
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_run_at timestamptz := now();
  v_count integer := 0;
begin
  insert into public.event_flow_study_snapshots (
    run_at,horizon,source_kind,event_direction,transmission_class,n,
    flow_delta_mean,flow_delta_median,flow_delta_abs_mean,flow_same_direction_rate,
    price_return_mean,price_return_median,price_same_direction_rate,
    velocity_mean,acceleration_mean,peak_flow_delta_mean,time_to_peak_median_minutes
  )
  with base as (
    select *,
      case
        when coalesce(event_sentiment,0) <> 0 then sign(event_sentiment)::smallint
        when coalesce(shock_score,0) <> 0 then sign(shock_score)::smallint
        else 0
      end as event_direction
    from public.event_flow_transmissions
    where data_quality <> 'partial'
  ),
  observations as (
    select source_kind,event_direction,transmission_class,'15m' horizon,
      flow_delta_15m flow_delta,price_return_15m price_return,
      flow_velocity_0_15 velocity,flow_acceleration acceleration,
      peak_flow_delta_4h peak_flow_delta,time_to_peak_minutes
    from base
    where flow_delta_15m is not null or price_return_15m is not null
    union all
    select source_kind,event_direction,transmission_class,'30m',
      flow_delta_30m,price_return_30m,flow_velocity_15_30,flow_acceleration,
      peak_flow_delta_4h,time_to_peak_minutes
    from base
    where flow_delta_30m is not null or price_return_30m is not null
    union all
    select source_kind,event_direction,transmission_class,'1h',
      flow_delta_60m,price_return_1h,flow_velocity_15_30,flow_acceleration,
      peak_flow_delta_4h,time_to_peak_minutes
    from base
    where flow_delta_60m is not null or price_return_1h is not null
    union all
    select source_kind,event_direction,transmission_class,'4h',
      null::numeric,price_return_4h,null::numeric,null::numeric,
      peak_flow_delta_4h,time_to_peak_minutes
    from base
    where price_return_4h is not null
    union all
    select source_kind,event_direction,transmission_class,'24h',
      null::numeric,price_return_24h,null::numeric,null::numeric,
      peak_flow_delta_4h,time_to_peak_minutes
    from base
    where price_return_24h is not null
  ),
  valid as (
    select *,
      case when event_direction <> 0 then flow_delta * event_direction end as signed_flow,
      case when event_direction <> 0 then price_return * event_direction end as signed_price
    from observations
  )
  select
    v_run_at,horizon,source_kind,event_direction,transmission_class,
    count(*)::integer,
    avg(signed_flow),
    percentile_cont(0.5) within group(order by signed_flow),
    avg(abs(flow_delta)),
    avg(case when event_direction <> 0 and flow_delta is not null
             then case when sign(flow_delta)=event_direction then 1.0 else 0.0 end end),
    avg(signed_price),
    percentile_cont(0.5) within group(order by signed_price),
    avg(case when event_direction <> 0 and price_return is not null
             then case when sign(price_return)=event_direction then 1.0 else 0.0 end end),
    avg(velocity),
    avg(acceleration),
    avg(peak_flow_delta),
    percentile_cont(0.5) within group(order by time_to_peak_minutes)
  from valid
  group by horizon,source_kind,event_direction,transmission_class;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.capture_event_flow_study_snapshot() from public, anon, authenticated;
grant execute on function public.capture_event_flow_study_snapshot() to service_role;
