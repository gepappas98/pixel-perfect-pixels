-- Research-only data coverage fix:
-- Persist sentiment/news context in whale_flow_transition_context.
-- Does not alter trading signals, strategy selection, risk, execution, or trades.

create or replace function public.capture_whale_flow_transition_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_at timestamptz := NEW.detected_at;
  v_window interval := make_interval(mins => 15);
begin
  insert into public.whale_flow_transition_context (
    transition_id, captured_at, lookback_minutes,
    indicator_context, signal_context, prediction_context,
    sentiment_context, news_context, data_quality
  )
  values (
    NEW.id, v_at, 15,
    jsonb_build_object(
      'available', true,
      'window_start', v_at - v_window,
      'window_end', v_at,
      'samples', (select count(*) from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at),
      'bullish', (select count(*) from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at and lower(coalesce(i.signal,''))='bullish'),
      'bearish', (select count(*) from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at and lower(coalesce(i.signal,''))='bearish'),
      'neutral', (select count(*) from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at and lower(coalesce(i.signal,''))='neutral'),
      'timeframes', (select coalesce(jsonb_object_agg(x.timeframe,x.n),'{}'::jsonb) from (select i.timeframe,count(*) n from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at group by i.timeframe) x)
    ),
    jsonb_build_object(
      'available', true,
      'samples', (select count(*) from public.composite_signals s where s.created_at between v_at-v_window and v_at),
      'buy', (select count(*) from public.composite_signals s where s.created_at between v_at-v_window and v_at and lower(coalesce(s.recommendation,''))='buy'),
      'sell', (select count(*) from public.composite_signals s where s.created_at between v_at-v_window and v_at and lower(coalesce(s.recommendation,''))='sell'),
      'hold', (select count(*) from public.composite_signals s where s.created_at between v_at-v_window and v_at and lower(coalesce(s.recommendation,''))='hold'),
      'avg_confidence', (select round(avg(s.confidence)::numeric,4) from public.composite_signals s where s.created_at between v_at-v_window and v_at),
      'regimes', (select coalesce(jsonb_object_agg(x.regime_label,x.n),'{}'::jsonb) from (select coalesce(nullif(s.regime_label,''),'unknown') regime_label,count(*) n from public.composite_signals s where s.created_at between v_at-v_window and v_at group by coalesce(nullif(s.regime_label,''),'unknown')) x)
    ),
    jsonb_build_object(
      'available', true,
      'samples', (select count(*) from public.prediction_snapshots p where p.created_at between v_at-v_window and v_at),
      'symbols', (select coalesce(jsonb_agg(distinct p.related_symbol) filter(where p.related_symbol is not null),'[]'::jsonb) from public.prediction_snapshots p where p.created_at between v_at-v_window and v_at)
    ),
    jsonb_build_object(
      'available', exists(select 1 from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at),
      'window_start', v_at-v_window,
      'window_end', v_at,
      'samples', (select count(*) from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at),
      'assets', (select count(distinct s.asset) from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at),
      'avg_score', (select round(avg(s.sentiment_score)::numeric,4) from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at),
      'bullish', (select count(*) from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at and coalesce(s.sentiment_score,0)>0.15),
      'bearish', (select count(*) from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at and coalesce(s.sentiment_score,0)<-0.15),
      'neutral', (select count(*) from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at and coalesce(s.sentiment_score,0) between -0.15 and 0.15),
      'latest_at', (select max(s.observed_at) from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at)
    ) || case when exists(select 1 from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at) then '{}'::jsonb else jsonb_build_object('reason','No sentiment snapshots in the transition lookback window') end,
    jsonb_build_object(
      'available', exists(select 1 from public.asset_news_events n where n.event_at between v_at-v_window and v_at),
      'window_start', v_at-v_window,
      'window_end', v_at,
      'samples', (select count(*) from public.asset_news_events n where n.event_at between v_at-v_window and v_at),
      'assets', (select count(distinct n.asset) from public.asset_news_events n where n.event_at between v_at-v_window and v_at),
      'avg_score', (select round(avg(n.sentiment_score)::numeric,4) from public.asset_news_events n where n.event_at between v_at-v_window and v_at),
      'bullish', (select count(*) from public.asset_news_events n where n.event_at between v_at-v_window and v_at and coalesce(n.sentiment_score,0)>0.15),
      'bearish', (select count(*) from public.asset_news_events n where n.event_at between v_at-v_window and v_at and coalesce(n.sentiment_score,0)<-0.15),
      'neutral', (select count(*) from public.asset_news_events n where n.event_at between v_at-v_window and v_at and coalesce(n.sentiment_score,0) between -0.15 and 0.15),
      'latest_at', (select max(n.event_at) from public.asset_news_events n where n.event_at between v_at-v_window and v_at),
      'sources', (select coalesce(jsonb_agg(x.source),'[]'::jsonb) from (select distinct n.source from public.asset_news_events n where n.event_at between v_at-v_window and v_at) x)
    ) || case when exists(select 1 from public.asset_news_events n where n.event_at between v_at-v_window and v_at) then '{}'::jsonb else jsonb_build_object('reason','No news events in the transition lookback window') end,
    case
      when exists(select 1 from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at)
        or exists(select 1 from public.composite_signals s where s.created_at between v_at-v_window and v_at)
        or exists(select 1 from public.asset_sentiment_snapshots s where s.observed_at between v_at-v_window and v_at)
        or exists(select 1 from public.asset_news_events n where n.event_at between v_at-v_window and v_at)
      then 'partial' else 'whale_only'
    end
  )
  on conflict (transition_id) do update set
    indicator_context=excluded.indicator_context,
    signal_context=excluded.signal_context,
    prediction_context=excluded.prediction_context,
    sentiment_context=excluded.sentiment_context,
    news_context=excluded.news_context,
    data_quality=excluded.data_quality;
  return NEW;
exception when others then
  raise warning '[WHALE_FLOW_CONTEXT] capture failed for transition %: %', NEW.id, sqlerrm;
  return NEW;
end;
$function$;

-- Backfill derived context for already captured transitions without inventing data.
update public.whale_flow_transition_context c
set
  sentiment_context = jsonb_build_object(
    'available', exists(select 1 from public.asset_sentiment_snapshots s where s.observed_at between c.captured_at-interval '15 minutes' and c.captured_at),
    'window_start', c.captured_at-interval '15 minutes',
    'window_end', c.captured_at,
    'samples', (select count(*) from public.asset_sentiment_snapshots s where s.observed_at between c.captured_at-interval '15 minutes' and c.captured_at),
    'assets', (select count(distinct s.asset) from public.asset_sentiment_snapshots s where s.observed_at between c.captured_at-interval '15 minutes' and c.captured_at),
    'avg_score', (select round(avg(s.sentiment_score)::numeric,4) from public.asset_sentiment_snapshots s where s.observed_at between c.captured_at-interval '15 minutes' and c.captured_at),
    'bullish', (select count(*) from public.asset_sentiment_snapshots s where s.observed_at between c.captured_at-interval '15 minutes' and c.captured_at and coalesce(s.sentiment_score,0)>0.15),
    'bearish', (select count(*) from public.asset_sentiment_snapshots s where s.observed_at between c.captured_at-interval '15 minutes' and c.captured_at and coalesce(s.sentiment_score,0)<-0.15),
    'neutral', (select count(*) from public.asset_sentiment_snapshots s where s.observed_at between c.captured_at-interval '15 minutes' and c.captured_at and coalesce(s.sentiment_score,0) between -0.15 and 0.15),
    'latest_at', (select max(s.observed_at) from public.asset_sentiment_snapshots s where s.observed_at between c.captured_at-interval '15 minutes' and c.captured_at)
  ) || case when exists(select 1 from public.asset_sentiment_snapshots s where s.observed_at between c.captured_at-interval '15 minutes' and c.captured_at) then '{}'::jsonb else jsonb_build_object('reason','No sentiment snapshots in the transition lookback window') end,
  news_context = jsonb_build_object(
    'available', exists(select 1 from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at),
    'window_start', c.captured_at-interval '15 minutes',
    'window_end', c.captured_at,
    'samples', (select count(*) from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at),
    'assets', (select count(distinct n.asset) from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at),
    'avg_score', (select round(avg(n.sentiment_score)::numeric,4) from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at),
    'bullish', (select count(*) from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at and coalesce(n.sentiment_score,0)>0.15),
    'bearish', (select count(*) from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at and coalesce(n.sentiment_score,0)<-0.15),
    'neutral', (select count(*) from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at and coalesce(n.sentiment_score,0) between -0.15 and 0.15),
    'latest_at', (select max(n.event_at) from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at),
    'sources', (select coalesce(jsonb_agg(x.source),'[]'::jsonb) from (select distinct n.source from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at) x)
  ) || case when exists(select 1 from public.asset_news_events n where n.event_at between c.captured_at-interval '15 minutes' and c.captured_at) then '{}'::jsonb else jsonb_build_object('reason','No news events in the transition lookback window') end
where c.captured_at >= now()-interval '24 hours';
