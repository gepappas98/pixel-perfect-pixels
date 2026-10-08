-- Research Lab data-readiness sweep.
-- Research-only: creates panel alerts when existing datasets cross analysis thresholds.
-- No trading, execution, risk, signal, variant, or strategy changes.

create or replace function public.check_research_lab_data_readiness()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_clean_news integer := 0; v_clean_news_price_1h integer := 0;
  v_social_ordered integer := 0; v_social_with_flow integer := 0; v_social_with_sentiment integer := 0;
  v_accum_24h integer := 0; v_accum_72h integer := 0; v_saylor_btc integer := 0;
  v_alerts integer := 0; v_created text[] := '{}';
begin
  select count(*) filter (where transmission_class='clean_stable'),
         count(*) filter (where transmission_class='clean_stable' and price_return_1h is not null)
  into v_clean_news,v_clean_news_price_1h
  from public.event_flow_transmissions where created_at >= now()-interval '30 days';

  if v_clean_news>=20 and v_clean_news_price_1h::numeric/nullif(v_clean_news,0)>=.80
     and not exists(select 1 from public.research_alerts where alert_type='RESEARCH_DATA_READY_NEWS_CLEAN' and created_at>=now()-interval '30 days') then
    insert into public.research_alerts(alert_type,severity,source,event_at,detected_at,message,evidence,acknowledged)
    values('RESEARCH_DATA_READY_NEWS_CLEAN','info','research-readiness',now(),now(),
      'Enough CLEAN News → Whale → Price data has accumulated. Resume the clean transmission study.',
      jsonb_build_object('research_only',true,'clean_events',v_clean_news,'clean_events_with_1h_price',v_clean_news_price_1h,
      'one_hour_coverage_pct',round(100.0*v_clean_news_price_1h/nullif(v_clean_news,0),1),'minimum_clean_events',20,
      'minimum_1h_coverage_pct',80,'next_step','study_news_whale_clean_transmissions'),false);
    v_alerts:=v_alerts+1; v_created:=array_append(v_created,'RESEARCH_DATA_READY_NEWS_CLEAN');
  end if;

  select count(*) into v_social_ordered from public.influential_social_transmission_links where created_at>=now()-interval '30 days';
  select count(*) into v_social_with_flow from public.influential_social_transmission_links where created_at>=now()-interval '30 days'
    and coalesce((to_jsonb(influential_social_transmission_links)->>'flow_observed')::boolean,false);
  select count(*) into v_social_with_sentiment from public.influential_social_market_observations where created_at>=now()-interval '30 days'
    and sentiment_after is not null and sentiment_before is not null;

  if v_social_ordered>=30 and v_social_with_flow>=20 and v_social_with_sentiment>=20
     and not exists(select 1 from public.research_alerts where alert_type='RESEARCH_DATA_READY_SOCIAL_CHAIN' and created_at>=now()-interval '30 days') then
    insert into public.research_alerts(alert_type,severity,source,event_at,detected_at,message,evidence,acknowledged)
    values('RESEARCH_DATA_READY_SOCIAL_CHAIN','info','research-readiness',now(),now(),
      'Enough real Social → Sentiment → Whale chain data has accumulated. Resume lead/lag analysis.',
      jsonb_build_object('research_only',true,'ordered_links',v_social_ordered,'links_with_flow',v_social_with_flow,
      'observations_with_real_sentiment',v_social_with_sentiment,'minimum_ordered_links',30,'minimum_flow_links',20,
      'minimum_sentiment_observations',20,'next_step','capture_influential_social_lead_lag_stats'),false);
    v_alerts:=v_alerts+1; v_created:=array_append(v_created,'RESEARCH_DATA_READY_SOCIAL_CHAIN');
  end if;

  select count(*) filter(where observed_at<=now()-interval '24 hours'),
         count(*) filter(where observed_at<=now()-interval '72 hours')
  into v_accum_24h,v_accum_72h from public.accumulation_shadow_observations;

  if v_accum_24h>=40 and v_accum_72h>=30
     and not exists(select 1 from public.research_alerts where alert_type='RESEARCH_DATA_READY_ACCUMULATION' and created_at>=now()-interval '30 days') then
    insert into public.research_alerts(alert_type,severity,source,event_at,detected_at,message,evidence,acknowledged)
    values('RESEARCH_DATA_READY_ACCUMULATION','info','research-readiness',now(),now(),
      'Enough matured Accumulation/CREDIA observations exist for 24h/72h outcome analysis.',
      jsonb_build_object('research_only',true,'mature_24h',v_accum_24h,'mature_72h',v_accum_72h,
      'minimum_mature_24h',40,'minimum_mature_72h',30,'next_step','analyze_accumulation_shadow_outcomes'),false);
    v_alerts:=v_alerts+1; v_created:=array_append(v_created,'RESEARCH_DATA_READY_ACCUMULATION');
  end if;

  select count(*) into v_saylor_btc from public.influential_social_events
  where created_at>=now()-interval '60 days' and lower(coalesce(author_handle,''))='saylor'
    and 'BTC'=any(coalesce(affected_assets,'{}'::text[]));

  if v_saylor_btc>=10
     and not exists(select 1 from public.research_alerts where alert_type='RESEARCH_DATA_READY_SAYLOR_BTC' and created_at>=now()-interval '60 days') then
    insert into public.research_alerts(alert_type,severity,source,event_at,detected_at,message,evidence,acknowledged)
    values('RESEARCH_DATA_READY_SAYLOR_BTC','info','research-readiness',now(),now(),
      'Enough Saylor → BTC events have accumulated for the planned forensic comparison.',
      jsonb_build_object('research_only',true,'saylor_btc_events',v_saylor_btc,'minimum_events',10,
      'next_step','compare_saylor_btc_social_transmissions'),false);
    v_alerts:=v_alerts+1; v_created:=array_append(v_created,'RESEARCH_DATA_READY_SAYLOR_BTC');
  end if;

  return jsonb_build_object('checked_at',now(),'alerts_created',v_alerts,'created_types',v_created,
    'clean_news',jsonb_build_object('events',v_clean_news,'with_1h_price',v_clean_news_price_1h),
    'social_chain',jsonb_build_object('ordered_links',v_social_ordered,'flow_links',v_social_with_flow,'real_sentiment_observations',v_social_with_sentiment),
    'accumulation',jsonb_build_object('mature_24h',v_accum_24h,'mature_72h',v_accum_72h),
    'saylor_btc',v_saylor_btc);
end;
$$;

revoke all on function public.check_research_lab_data_readiness() from public,anon,authenticated;
grant execute on function public.check_research_lab_data_readiness() to service_role;

select cron.schedule(
  'research-lab-data-readiness',
  '*/15 * * * *',
  'select public.check_research_lab_data_readiness();'
);