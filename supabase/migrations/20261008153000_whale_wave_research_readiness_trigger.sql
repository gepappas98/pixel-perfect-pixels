-- Research-only readiness trigger for the regime-aware whale-wave study.
-- Does not touch execution, risk, signals, variants, or strategy selection.

create or replace function public.check_whale_wave_research_readiness()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_total integer := 0;
  v_bear integer := 0;
  v_sideways integer := 0;
  v_bull integer := 0;
  v_1h integer := 0;
  v_ready boolean := false;
  v_alert_id uuid;
begin
  with turns as (
    select id, detected_at, delta_pp
    from public.whale_flow_turns
    where detected_at >= now() - interval '30 days'
  ),
  scored as (
    select t.*,
      coalesce((
        select case when sum(case when direction in ('accumulation','distribution') then usd_value else 0 end) > 0
          then (sum(case when direction='accumulation' then usd_value else 0 end)
              - sum(case when direction='distribution' then usd_value else 0 end))
             / sum(case when direction in ('accumulation','distribution') then usd_value else 0 end)
          else 0 end
        from public.whale_alerts w
        where w.created_at between t.detected_at - interval '6 hours' and t.detected_at
      ),0) as whale_net,
      coalesce((
        select (sum(case when signal='bullish' then 1 else 0 end)
              - sum(case when signal='bearish' then 1 else 0 end))::numeric
              / nullif(count(*),0)
        from (
          select distinct on (symbol) symbol, signal
          from public.indicator_snapshots
          where timeframe='4h'
            and created_at between t.detected_at - interval '6 hours' and t.detected_at
          order by symbol, created_at desc
        ) x
      ),0) as tech_breadth,
      coalesce((
        select (sum(case
              when ((lower(question) ~ '\\m(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\\M' and yes_price > .6)
                 or (lower(question) ~ '\\m(dip|drop|fall|below|crash|down to|under|bottom)\\M' and 1-yes_price > .6))
              then 1 else 0 end)
              - sum(case
              when ((lower(question) ~ '\\m(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\\M' and yes_price < .4)
                 or (lower(question) ~ '\\m(dip|drop|fall|below|crash|down to|under|bottom)\\M' and 1-yes_price < .4))
              then 1 else 0 end))::numeric / nullif(count(*),0)
        from (
          select distinct on (market_slug) market_slug, question, yes_price
          from public.prediction_snapshots
          where created_at between t.detected_at - interval '30 minutes' and t.detected_at
          order by market_slug, created_at desc
        ) p
      ),0) as pred_consensus,
      coalesce((
        select (sum(case when final_verdict='BUY' then 1 else 0 end)
              - sum(case when final_verdict='SELL' then 1 else 0 end))::numeric
              / nullif(sum(case when final_verdict in ('BUY','SELL') then 1 else 0 end),0)
        from (
          select distinct on (symbol) symbol, final_verdict
          from public.council_signals
          where source_created_at between t.detected_at - interval '30 minutes' and t.detected_at
          order by symbol, source_created_at desc
        ) c
      ),0) as council_consensus
    from turns t
  ),
  labeled as (
    select *, whale_net*.3 + tech_breadth*.4 + pred_consensus*.2 + council_consensus*.1 as score
    from scored
  ),
  regimes as (
    select *,
      case
        when score >= .5 then 'strong_bull'
        when score >= .15 then 'bull'
        when score <= -.5 then 'strong_bear'
        when score <= -.15 then 'bear'
        else 'sideways'
      end as regime
    from labeled
  ),
  usable as (
    select r.*, p0.price as p0, p60.price as p60
    from regimes r
    join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and observed_at <= r.detected_at
      order by observed_at desc limit 1
    ) p0 on true
    left join lateral (
      select price from public.asset_price_snapshots
      where asset='BTC' and observed_at >= r.detected_at + interval '1 hour'
      order by observed_at limit 1
    ) p60 on true
  )
  select
    count(*)::integer,
    count(*) filter (where regime='bear')::integer,
    count(*) filter (where regime='sideways')::integer,
    count(*) filter (where regime='bull')::integer,
    count(*) filter (where p60 is not null)::integer
  into v_total, v_bear, v_sideways, v_bull, v_1h
  from usable;

  v_ready := v_total >= 30
    and v_bear >= 10
    and v_sideways >= 5
    and v_1h >= ceil(v_total * .80);

  if v_ready and not exists (
    select 1 from public.research_alerts
    where alert_type = 'WHALE_WAVE_REGIME_DATA_READY'
      and created_at >= now() - interval '30 days'
  ) then
    insert into public.research_alerts (
      alert_type, severity, asset, source, event_id, event_at, detected_at,
      message, evidence, acknowledged
    )
    values (
      'WHALE_WAVE_REGIME_DATA_READY',
      'info',
      null,
      'research-readiness',
      null,
      now(),
      now(),
      'Enough regime-aware whale-wave data has accumulated. Resume the regime/wave study now.',
      jsonb_build_object(
        'research_only', true,
        'total_usable_waves', v_total,
        'bear_waves', v_bear,
        'sideways_waves', v_sideways,
        'bull_waves', v_bull,
        'one_hour_price_coverage', v_1h,
        'one_hour_price_coverage_pct', round(100.0 * v_1h / nullif(v_total,0), 1),
        'minimum_total', 30,
        'minimum_bear', 10,
        'minimum_sideways', 5,
        'minimum_1h_coverage_pct', 80,
        'next_step', 'analyze_whale_waves_by_market_regime'
      ),
      false
    )
    returning id into v_alert_id;
  end if;

  return jsonb_build_object(
    'ready', v_ready,
    'alert_created', v_alert_id is not null,
    'alert_id', v_alert_id,
    'total_usable_waves', v_total,
    'bear_waves', v_bear,
    'sideways_waves', v_sideways,
    'bull_waves', v_bull,
    'one_hour_price_coverage', v_1h,
    'one_hour_price_coverage_pct', round(100.0 * v_1h / nullif(v_total,0), 1),
    'thresholds', jsonb_build_object('total',30,'bear',10,'sideways',5,'one_hour_coverage_pct',80)
  );
end;
$$;

revoke all on function public.check_whale_wave_research_readiness() from public, anon, authenticated;
grant execute on function public.check_whale_wave_research_readiness() to service_role;

select cron.schedule(
  'research-whale-wave-readiness',
  '*/5 * * * *',
  'select public.check_whale_wave_research_readiness();'
);
