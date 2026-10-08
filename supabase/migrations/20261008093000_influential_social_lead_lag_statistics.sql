create table if not exists public.influential_social_lead_lag_stats (
 id uuid primary key default gen_random_uuid(),
 captured_at timestamptz not null default now(),
 platform text, event_type text, event_direction smallint, severity text, asset text,
 transmission_class text not null, sample_size integer not null,
 avg_post_to_sentiment_minutes numeric, median_post_to_sentiment_minutes numeric,
 avg_sentiment_to_flow_minutes numeric, median_sentiment_to_flow_minutes numeric,
 avg_post_to_flow_minutes numeric, median_post_to_flow_minutes numeric,
 avg_sentiment_shock numeric, avg_flow_shock numeric, avg_flow_acceleration numeric,
 avg_price_return_15m numeric, avg_price_return_30m numeric, avg_price_return_1h numeric,
 avg_price_return_4h numeric, avg_price_return_24h numeric
);
create index if not exists idx_social_lead_lag_stats_time on public.influential_social_lead_lag_stats(captured_at desc);
alter table public.influential_social_lead_lag_stats enable row level security;
revoke all on public.influential_social_lead_lag_stats from anon,authenticated;
grant select,insert on public.influential_social_lead_lag_stats to service_role;
create or replace function public.capture_influential_social_lead_lag_stats()
returns jsonb language plpgsql security definer set search_path=public as $$
declare n integer;
begin
 insert into public.influential_social_lead_lag_stats
 (platform,event_type,event_direction,severity,asset,transmission_class,sample_size,
 avg_post_to_sentiment_minutes,median_post_to_sentiment_minutes,avg_sentiment_to_flow_minutes,median_sentiment_to_flow_minutes,
 avg_post_to_flow_minutes,median_post_to_flow_minutes,avg_sentiment_shock,avg_flow_shock,avg_flow_acceleration,
 avg_price_return_15m,avg_price_return_30m,avg_price_return_1h,avg_price_return_4h,avg_price_return_24h)
 select e.platform,e.event_type,e.event_direction,e.severity,l.asset,l.transmission_class,count(*)::int,
 avg(l.latency_post_to_sentiment_minutes),percentile_cont(0.5) within group(order by l.latency_post_to_sentiment_minutes),
 avg(l.latency_sentiment_to_flow_minutes),percentile_cont(0.5) within group(order by l.latency_sentiment_to_flow_minutes),
 avg(l.latency_post_to_flow_minutes),percentile_cont(0.5) within group(order by l.latency_post_to_flow_minutes),
 avg(l.sentiment_shock),avg(l.flow_shock),avg(f.flow_acceleration),
 avg(l.price_return_15m),avg(l.price_return_30m),avg(l.price_return_1h),avg(l.price_return_4h),avg(l.price_return_24h)
 from public.influential_social_transmission_links l
 join public.influential_social_events e on e.id=l.event_id
 left join public.event_flow_transmissions f on f.id=l.flow_event_id
 where e.classification_status='classified'
 group by e.platform,e.event_type,e.event_direction,e.severity,l.asset,l.transmission_class;
 get diagnostics n=row_count;
 return jsonb_build_object('status','captured','rows',n,'research_only',true);
end; $$;
revoke all on function public.capture_influential_social_lead_lag_stats() from public,anon,authenticated;
grant execute on function public.capture_influential_social_lead_lag_stats() to service_role;