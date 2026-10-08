-- Shadow-only Event -> Sentiment -> Whale Flow -> Price research layer.
-- Does not modify V1/V2 signals, strategy selection, or execution.

create table if not exists public.asset_price_snapshots (
  id uuid primary key default gen_random_uuid(),
  asset text not null references public.tracked_assets(asset) on delete cascade,
  observed_at timestamptz not null,
  price numeric(30,12) not null,
  source text not null default 'binance-spot',
  created_at timestamptz not null default now(),
  unique(asset, observed_at, source)
);

create index if not exists idx_asset_price_snapshots_asset_time
  on public.asset_price_snapshots(asset, observed_at desc);

create table if not exists public.asset_flow_snapshots (
  id uuid primary key default gen_random_uuid(),
  asset text not null references public.tracked_assets(asset) on delete cascade,
  bucket_at timestamptz not null,
  sample_size integer not null default 0,
  buy_usd numeric(30,8) not null default 0,
  sell_usd numeric(30,8) not null default 0,
  total_usd numeric(30,8) not null default 0,
  flow_score numeric(12,8) not null default 0,
  dominant_state text not null default 'neutral'
    check (dominant_state in ('accumulation','neutral','distribution')),
  source text not null default 'whale_alerts_15m',
  created_at timestamptz not null default now(),
  unique(asset, bucket_at, source)
);

create index if not exists idx_asset_flow_snapshots_asset_time
  on public.asset_flow_snapshots(asset, bucket_at desc);

create table if not exists public.asset_sentiment_snapshots (
  id uuid primary key default gen_random_uuid(),
  asset text not null references public.tracked_assets(asset) on delete cascade,
  observed_at timestamptz not null,
  source text not null,
  mention_count integer not null default 0,
  unique_items integer not null default 0,
  bullish_count integer not null default 0,
  bearish_count integer not null default 0,
  neutral_count integer not null default 0,
  sentiment_score numeric(12,8) not null default 0,
  mention_velocity numeric(18,8),
  sentiment_velocity numeric(18,8),
  shock_score numeric(18,8),
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(asset, observed_at, source)
);

create index if not exists idx_asset_sentiment_snapshots_asset_time
  on public.asset_sentiment_snapshots(asset, observed_at desc);

create table if not exists public.asset_news_events (
  id uuid primary key default gen_random_uuid(),
  asset text not null references public.tracked_assets(asset) on delete cascade,
  event_at timestamptz not null,
  source text not null,
  title text not null,
  url text,
  sentiment_score numeric(12,8) not null default 0,
  sentiment_label text not null default 'neutral'
    check (sentiment_label in ('bullish','bearish','neutral')),
  event_type text not null default 'other',
  relevance numeric(12,8) not null default 0,
  novelty numeric(12,8) not null default 1,
  shock_score numeric(18,8) not null default 0,
  fingerprint text not null unique,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_asset_news_events_asset_time
  on public.asset_news_events(asset, event_at desc);

create table if not exists public.event_flow_transmissions (
  id uuid primary key default gen_random_uuid(),
  asset text not null references public.tracked_assets(asset) on delete cascade,
  source_kind text not null check (source_kind in ('sentiment','news')),
  source_id uuid not null,
  event_at timestamptz not null,
  shock_score numeric(18,8) not null default 0,
  event_sentiment numeric(12,8) not null default 0,
  baseline_flow_score numeric(12,8),
  flow_15m numeric(12,8),
  flow_30m numeric(12,8),
  flow_60m numeric(12,8),
  flow_delta_15m numeric(12,8),
  flow_delta_30m numeric(12,8),
  flow_delta_60m numeric(12,8),
  flow_velocity_0_15 numeric(18,8),
  flow_velocity_15_30 numeric(18,8),
  flow_acceleration numeric(18,8),
  peak_flow_delta_4h numeric(12,8),
  time_to_peak_minutes integer,
  price_return_15m numeric(18,8),
  price_return_30m numeric(18,8),
  price_return_1h numeric(18,8),
  price_return_4h numeric(18,8),
  price_return_24h numeric(18,8),
  transmission_class text not null default 'insufficient_data'
    check (transmission_class in ('flow_followed','flow_diverged','no_flow_response','insufficient_data')),
  data_quality text not null default 'partial',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_kind, source_id)
);

create index if not exists idx_event_flow_transmissions_asset_time
  on public.event_flow_transmissions(asset, event_at desc);

alter table public.asset_price_snapshots enable row level security;
alter table public.asset_flow_snapshots enable row level security;
alter table public.asset_sentiment_snapshots enable row level security;
alter table public.asset_news_events enable row level security;
alter table public.event_flow_transmissions enable row level security;

drop policy if exists "asset_price_snapshots_public_read" on public.asset_price_snapshots;
create policy "asset_price_snapshots_public_read" on public.asset_price_snapshots
  for select to anon, authenticated using (true);

drop policy if exists "asset_flow_snapshots_public_read" on public.asset_flow_snapshots;
create policy "asset_flow_snapshots_public_read" on public.asset_flow_snapshots
  for select to anon, authenticated using (true);

drop policy if exists "asset_sentiment_snapshots_public_read" on public.asset_sentiment_snapshots;
create policy "asset_sentiment_snapshots_public_read" on public.asset_sentiment_snapshots
  for select to anon, authenticated using (true);

drop policy if exists "asset_news_events_public_read" on public.asset_news_events;
create policy "asset_news_events_public_read" on public.asset_news_events
  for select to anon, authenticated using (true);

drop policy if exists "event_flow_transmissions_public_read" on public.event_flow_transmissions;
create policy "event_flow_transmissions_public_read" on public.event_flow_transmissions
  for select to anon, authenticated using (true);

grant select on public.asset_price_snapshots to anon, authenticated;
grant select on public.asset_flow_snapshots to anon, authenticated;
grant select on public.asset_sentiment_snapshots to anon, authenticated;
grant select on public.asset_news_events to anon, authenticated;
grant select on public.event_flow_transmissions to anon, authenticated;

create or replace function public.refresh_event_flow_transmissions(
  p_lookback_hours integer default 48
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  insert into public.event_flow_transmissions (
    asset, source_kind, source_id, event_at, shock_score, event_sentiment,
    baseline_flow_score, flow_15m, flow_30m, flow_60m,
    flow_delta_15m, flow_delta_30m, flow_delta_60m,
    flow_velocity_0_15, flow_velocity_15_30, flow_acceleration,
    peak_flow_delta_4h, time_to_peak_minutes,
    price_return_15m, price_return_30m, price_return_1h,
    price_return_4h, price_return_24h, transmission_class, data_quality, updated_at
  )
  with events as (
    select
      s.id source_id, 'sentiment'::text source_kind, s.asset, s.observed_at event_at,
      s.shock_score, s.sentiment_score event_sentiment
    from public.asset_sentiment_snapshots s
    where s.observed_at >= now() - make_interval(hours => greatest(1,p_lookback_hours))
      and abs(coalesce(s.shock_score,0)) >= 1.5
    union all
    select
      n.id, 'news', n.asset, n.event_at, n.shock_score, n.sentiment_score
    from public.asset_news_events n
    where n.event_at >= now() - make_interval(hours => greatest(1,p_lookback_hours))
      and abs(coalesce(n.shock_score,0)) >= 0.5
  ),
  calc as (
    select
      e.*,
      (select f.flow_score from public.asset_flow_snapshots f
       where f.asset=e.asset and f.bucket_at between e.event_at-interval '10 minutes' and e.event_at
       order by abs(extract(epoch from (f.bucket_at-e.event_at))) limit 1) baseline_flow_score,
      (select f.flow_score from public.asset_flow_snapshots f
       where f.asset=e.asset and f.bucket_at between e.event_at+interval '5 minutes' and e.event_at+interval '20 minutes'
       order by abs(extract(epoch from (f.bucket_at-(e.event_at+interval '15 minutes')))) limit 1) flow_15m,
      (select f.flow_score from public.asset_flow_snapshots f
       where f.asset=e.asset and f.bucket_at between e.event_at+interval '20 minutes' and e.event_at+interval '40 minutes'
       order by abs(extract(epoch from (f.bucket_at-(e.event_at+interval '30 minutes')))) limit 1) flow_30m,
      (select f.flow_score from public.asset_flow_snapshots f
       where f.asset=e.asset and f.bucket_at between e.event_at+interval '45 minutes' and e.event_at+interval '75 minutes'
       order by abs(extract(epoch from (f.bucket_at-(e.event_at+interval '60 minutes')))) limit 1) flow_60m,
      (select p.price from public.asset_price_snapshots p
       where p.asset=e.asset and p.observed_at between e.event_at+interval '5 minutes' and e.event_at+interval '25 minutes'
       order by abs(extract(epoch from (p.observed_at-(e.event_at+interval '15 minutes')))) limit 1) p15,
      (select p.price from public.asset_price_snapshots p
       where p.asset=e.asset and p.observed_at between e.event_at+interval '20 minutes' and e.event_at+interval '40 minutes'
       order by abs(extract(epoch from (p.observed_at-(e.event_at+interval '30 minutes')))) limit 1) p30,
      (select p.price from public.asset_price_snapshots p
       where p.asset=e.asset and p.observed_at between e.event_at+interval '45 minutes' and e.event_at+interval '75 minutes'
       order by abs(extract(epoch from (p.observed_at-(e.event_at+interval '60 minutes')))) limit 1) p60,
      (select p.price from public.asset_price_snapshots p
       where p.asset=e.asset and p.observed_at between e.event_at+interval '210 minutes' and e.event_at+interval '270 minutes'
       order by abs(extract(epoch from (p.observed_at-(e.event_at+interval '240 minutes')))) limit 1) p240,
      (select p.price from public.asset_price_snapshots p
       where p.asset=e.asset and p.observed_at between e.event_at+interval '1380 minutes' and e.event_at+interval '1500 minutes'
       order by abs(extract(epoch from (p.observed_at-(e.event_at+interval '1440 minutes')))) limit 1) p1440,
      (select p0.price from public.asset_price_snapshots p0
       where p0.asset=e.asset and p0.observed_at between e.event_at-interval '10 minutes' and e.event_at
       order by abs(extract(epoch from (p0.observed_at-e.event_at))) limit 1) p0
    from events e
  ),
  insert into public.event_flow_transmissions (
    asset, source_kind, source_id, event_at, shock_score, event_sentiment,
    baseline_flow_score, flow_15m, flow_30m, flow_60m,
    flow_delta_15m, flow_delta_30m, flow_delta_60m,
    flow_velocity_0_15, flow_velocity_15_30, flow_acceleration,
    price_return_15m, price_return_30m, price_return_1h,
    price_return_4h, price_return_24h, transmission_class, data_quality, updated_at
    )
  select
    asset, source_kind, source_id, event_at, shock_score, event_sentiment,
    baseline_flow_score, flow_15m, flow_30m, flow_60m,
    case when baseline_flow_score is not null and flow_15m is not null then flow_15m-baseline_flow_score end,
    case when baseline_flow_score is not null and flow_30m is not null then flow_30m-baseline_flow_score end,
    case when baseline_flow_score is not null and flow_60m is not null then flow_60m-baseline_flow_score end,
    case when baseline_flow_score is not null and flow_15m is not null then (flow_15m-baseline_flow_score)/0.25 end,
    case when flow_15m is not null and flow_30m is not null then (flow_30m-flow_15m)/0.25 end,
    case when baseline_flow_score is not null and flow_15m is not null and flow_30m is not null
      then ((flow_30m-flow_15m)/0.25)-((flow_15m-baseline_flow_score)/0.25) end,
    case when p0 is not null and p15 is not null then (p15/p0-1)*100 end,
    case when p0 is not null and p30 is not null then (p30/p0-1)*100 end,
    case when p0 is not null and p60 is not null then (p60/p0-1)*100 end,
    case when p0 is not null and p240 is not null then (p240/p0-1)*100 end,
    case when p0 is not null and p1440 is not null then (p1440/p0-1)*100 end,
    case
      when baseline_flow_score is null or flow_15m is null then 'insufficient_data'
      when abs(flow_15m-baseline_flow_score) < 0.05 then 'no_flow_response'
      when (flow_15m-baseline_flow_score) * event_sentiment > 0 then 'flow_followed'
      else 'flow_diverged'
    end,
    case
      when p0 is null or baseline_flow_score is null then 'partial'
      when p1440 is null then 'developing'
      else 'complete'
    end,
    now()
    from calc
  select count(*) into v_count from upserted;

  return v_count;
end;
$$;

revoke all on function public.refresh_event_flow_transmissions(integer) from public, anon, authenticated;
grant execute on function public.refresh_event_flow_transmissions(integer) to service_role;
