create or replace function public.cleanup_research_data(
  p_raw_hours integer default 72,
  p_derived_hours integer default 168,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  raw_cutoff timestamptz := now() - make_interval(hours => p_raw_hours);
  derived_cutoff timestamptz := now() - make_interval(hours => p_derived_hours);
  n_sentiment bigint := 0; n_news bigint := 0; n_flow bigint := 0; n_price bigint := 0;
  n_event_tx bigint := 0; n_followups bigint := 0; n_context bigint := 0;
  n_transitions bigint := 0; n_wf_snapshots bigint := 0;
begin
  if p_raw_hours < 24 then raise exception 'p_raw_hours must be >= 24'; end if;
  if p_derived_hours < p_raw_hours then raise exception 'p_derived_hours must be >= p_raw_hours'; end if;

  select count(*) into n_sentiment from public.asset_sentiment_snapshots where observed_at < raw_cutoff;
  select count(*) into n_news from public.asset_news_events where event_at < raw_cutoff;
  select count(*) into n_flow from public.asset_flow_snapshots where bucket_at < raw_cutoff;
  select count(*) into n_price from public.asset_price_snapshots where observed_at < raw_cutoff;
  select count(*) into n_event_tx from public.event_flow_transmissions where event_at < derived_cutoff;
  select count(*) into n_followups from public.whale_flow_shock_followups where shock_at < derived_cutoff;
  select count(*) into n_context from public.whale_flow_transition_context where created_at < derived_cutoff;
  select count(*) into n_transitions from public.whale_flow_transitions where created_at < derived_cutoff;
  select count(*) into n_wf_snapshots from public.whale_flow_snapshots where created_at < derived_cutoff;

  if not p_dry_run then
    delete from public.asset_sentiment_snapshots where observed_at < raw_cutoff;
    delete from public.asset_news_events where event_at < raw_cutoff;
    delete from public.asset_flow_snapshots where bucket_at < raw_cutoff;
    delete from public.asset_price_snapshots where observed_at < raw_cutoff;
    delete from public.whale_flow_shock_followups where shock_at < derived_cutoff;
    delete from public.whale_flow_transition_context where created_at < derived_cutoff;
    delete from public.event_flow_transmissions where event_at < derived_cutoff;
    delete from public.whale_flow_transitions where created_at < derived_cutoff;
    delete from public.whale_flow_snapshots where created_at < derived_cutoff;
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'raw_retention_hours', p_raw_hours,
    'derived_retention_hours', p_derived_hours,
    'raw_cutoff', raw_cutoff,
    'derived_cutoff', derived_cutoff,
    'counts', jsonb_build_object(
      'asset_sentiment_snapshots', n_sentiment, 'asset_news_events', n_news,
      'asset_flow_snapshots', n_flow, 'asset_price_snapshots', n_price,
      'event_flow_transmissions', n_event_tx, 'whale_flow_shock_followups', n_followups,
      'whale_flow_transition_context', n_context, 'whale_flow_transitions', n_transitions,
      'whale_flow_snapshots', n_wf_snapshots
    )
  );
end;
$fn$;

revoke all on function public.cleanup_research_data(integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.cleanup_research_data(integer, integer, boolean) to service_role;

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'research-data-retention') then
    perform cron.unschedule('research-data-retention');
  end if;
  perform cron.schedule(
    'research-data-retention',
    '17 3 * * *',
    $job$select public.cleanup_research_data(72, 168, false);$job$
  );
end
$do$;
