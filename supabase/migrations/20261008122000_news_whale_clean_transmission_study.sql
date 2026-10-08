create or replace function public.study_news_whale_clean_transmissions(
  p_lookback_hours integer default 168,
  p_shock_floor numeric default 0.25,
  p_stable_max_abs_flow numeric default 0.50,
  p_unstable_min_abs_flow numeric default 0.80
)
returns table(
  transmission_class text,
  source text,
  asset text,
  events bigint,
  whale_responses bigint,
  response_rate numeric,
  avg_latency_min numeric,
  median_latency_min numeric,
  avg_turn_abs_pp numeric,
  avg_return_15m_pct numeric,
  avg_return_30m_pct numeric,
  avg_return_1h_pct numeric,
  avg_return_4h_pct numeric
)
language sql
security definer
set search_path=public
as $$
with news as (
  select n.*
  from public.asset_news_events n
  where n.event_at>=now()-make_interval(hours=>p_lookback_hours)
    and n.event_at<=now()-interval '2 hours'
    and abs(coalesce(n.shock_score,0))>=p_shock_floor
),
c as (
  select n.*,
    (
      select coalesce(max(abs(s.flow_score)),0)
      from public.whale_flow_snapshots s
      where s.bucket_at between n.event_at-interval '30 minutes' and n.event_at
    ) pre_max_abs_flow
  from news n
),
r as (
  select c.*,
    t.detected_at turn_at,
    t.delta_pp turn_delta_pp,
    extract(epoch from(t.detected_at-c.event_at))/60.0 latency_min,
    case
      when c.pre_max_abs_flow<p_stable_max_abs_flow then 'clean_stable'
      when c.pre_max_abs_flow>=p_unstable_min_abs_flow then 'contaminated_unstable'
      else 'middle'
    end transmission_class
  from c
  left join lateral (
    select wt.detected_at,wt.delta_pp
    from public.whale_flow_turns wt
    where wt.detected_at>=c.event_at
      and wt.detected_at<=c.event_at+interval '2 hours'
    order by wt.detected_at
    limit 1
  ) t on true
),
p as (
  select r.*,p0.price p0,p15.price p15,p30.price p30,p1.price p1,p4.price p4
  from r
  left join lateral (
    select s.price
    from public.asset_price_snapshots s
    where s.asset=r.asset
      and s.observed_at between r.event_at-interval '5 minutes' and r.event_at+interval '5 minutes'
    order by abs(extract(epoch from(s.observed_at-r.event_at))),s.observed_at
    limit 1
  ) p0 on true
  left join lateral (
    select s.price
    from public.asset_price_snapshots s
    where s.asset=r.asset
      and s.observed_at>=r.event_at+interval '15 minutes'
      and s.observed_at<=r.event_at+interval '25 minutes'
    order by s.observed_at
    limit 1
  ) p15 on true
  left join lateral (
    select s.price
    from public.asset_price_snapshots s
    where s.asset=r.asset
      and s.observed_at>=r.event_at+interval '30 minutes'
      and s.observed_at<=r.event_at+interval '40 minutes'
    order by s.observed_at
    limit 1
  ) p30 on true
  left join lateral (
    select s.price
    from public.asset_price_snapshots s
    where s.asset=r.asset
      and s.observed_at>=r.event_at+interval '1 hour'
      and s.observed_at<=r.event_at+interval '1 hour 10 minutes'
    order by s.observed_at
    limit 1
  ) p1 on true
  left join lateral (
    select s.price
    from public.asset_price_snapshots s
    where s.asset=r.asset
      and s.observed_at>=r.event_at+interval '4 hours'
      and s.observed_at<=r.event_at+interval '4 hours 10 minutes'
    order by s.observed_at
    limit 1
  ) p4 on true
)
select
  p.transmission_class,p.source,p.asset,count(*)::bigint,
  count(*) filter(where p.turn_at is not null)::bigint,
  round((count(*) filter(where p.turn_at is not null)::numeric/nullif(count(*),0)),4),
  round(avg(p.latency_min)::numeric,1),
  round(percentile_cont(0.5) within group(order by p.latency_min)::numeric,1),
  round(avg(abs(p.turn_delta_pp))::numeric,1),
  round(avg(case when p.p0 is not null and p.p15 is not null then (p.p15/p.p0-1)*100 end)::numeric,3),
  round(avg(case when p.p0 is not null and p.p30 is not null then (p.p30/p.p0-1)*100 end)::numeric,3),
  round(avg(case when p.p0 is not null and p.p1 is not null then (p.p1/p.p0-1)*100 end)::numeric,3),
  round(avg(case when p.p0 is not null and p.p4 is not null then (p.p4/p.p0-1)*100 end)::numeric,3)
from p
group by p.transmission_class,p.source,p.asset
order by p.transmission_class,p.source,p.asset
$$;

revoke all on function public.study_news_whale_clean_transmissions(integer,numeric,numeric,numeric) from public,anon,authenticated;
grant execute on function public.study_news_whale_clean_transmissions(integer,numeric,numeric,numeric) to service_role;
