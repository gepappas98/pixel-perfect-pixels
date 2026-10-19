-- First safety gate: archive evidence before deletion; source deletion remains disabled by default.
create table if not exists public.research_archive_control (
  id smallint primary key default 1 check (id=1),
  allow_source_delete boolean not null default false,
  updated_at timestamptz not null default now(),
  note text not null default 'Source deletion locked pending research archive review'
);
insert into public.research_archive_control(id,allow_source_delete,note)
values (1,false,'Source deletion locked pending review of evidence completeness and historical research value')
on conflict (id) do nothing;
alter table public.research_archive_control enable row level security;
revoke all on public.research_archive_control from public, anon, authenticated;
grant all on public.research_archive_control to service_role;

create or replace function public.get_research_archive_status(
  p_raw_hours integer default 72,
  p_derived_hours integer default 168
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $status$
declare
  raw_cutoff timestamptz := now() - make_interval(hours => p_raw_hours);
  derived_cutoff timestamptz := now() - make_interval(hours => p_derived_hours);
  v_total bigint := 0;
  v_archived bigint := 0;
  v_missing bigint := 0;
  v_by_table jsonb := '{}'::jsonb;
begin
  if p_raw_hours < 24 or p_derived_hours < p_raw_hours then
    raise exception 'Invalid retention windows';
  end if;

  with required as (
    select 'asset_price_snapshots'::text source_table, s.id::text source_id from public.asset_price_snapshots s where s.observed_at < raw_cutoff
    union all select 'asset_flow_snapshots',s.id::text from public.asset_flow_snapshots s where s.bucket_at < raw_cutoff
    union all select 'asset_sentiment_snapshots',s.id::text from public.asset_sentiment_snapshots s where s.observed_at < raw_cutoff
    union all select 'asset_news_events',s.id::text from public.asset_news_events s where s.event_at < raw_cutoff
    union all select 'event_flow_transmissions',s.id::text from public.event_flow_transmissions s where s.event_at < derived_cutoff
    union all select 'whale_flow_shock_followups',s.id::text from public.whale_flow_shock_followups s where s.shock_at < derived_cutoff
    union all select 'whale_flow_transition_context',s.id::text from public.whale_flow_transition_context s where s.created_at < derived_cutoff
    union all select 'whale_flow_transitions',s.id::text from public.whale_flow_transitions s where s.created_at < derived_cutoff
    union all select 'whale_flow_snapshots',s.id::text from public.whale_flow_snapshots s where s.created_at < derived_cutoff
  ), checked as (
    select r.source_table,r.source_id,
      exists(select 1 from public.research_evidence e where e.source_table=r.source_table and e.source_id=r.source_id) archived
    from required r
  )
  select count(*),count(*) filter(where archived),count(*) filter(where not archived)
    into v_total,v_archived,v_missing from checked;

  with required as (
    select 'asset_price_snapshots'::text source_table,s.id::text source_id from public.asset_price_snapshots s where s.observed_at < raw_cutoff
    union all select 'asset_flow_snapshots',s.id::text from public.asset_flow_snapshots s where s.bucket_at < raw_cutoff
    union all select 'asset_sentiment_snapshots',s.id::text from public.asset_sentiment_snapshots s where s.observed_at < raw_cutoff
    union all select 'asset_news_events',s.id::text from public.asset_news_events s where s.event_at < raw_cutoff
    union all select 'event_flow_transmissions',s.id::text from public.event_flow_transmissions s where s.event_at < derived_cutoff
    union all select 'whale_flow_shock_followups',s.id::text from public.whale_flow_shock_followups s where s.shock_at < derived_cutoff
    union all select 'whale_flow_transition_context',s.id::text from public.whale_flow_transition_context s where s.created_at < derived_cutoff
    union all select 'whale_flow_transitions',s.id::text from public.whale_flow_transitions s where s.created_at < derived_cutoff
    union all select 'whale_flow_snapshots',s.id::text from public.whale_flow_snapshots s where s.created_at < derived_cutoff
  ), checked as (
    select r.source_table,exists(select 1 from public.research_evidence e where e.source_table=r.source_table and e.source_id=r.source_id) archived
    from required r
  )
  select coalesce(jsonb_object_agg(source_table,jsonb_build_object(
    'eligible',eligible,'archived',archived,'missing',missing
  )),'{}'::jsonb)
  into v_by_table
  from (
    select source_table,count(*) eligible,count(*) filter(where archived) archived,count(*) filter(where not archived) missing
    from checked group by source_table
  ) grouped;

  return jsonb_build_object(
    'status',case when v_missing=0 then 'ready' else 'incomplete' end,
    'eligible_sources',v_total,'archived_sources',v_archived,'missing_sources',v_missing,
    'last_archive_at',(select max(captured_at) from public.research_evidence),
    'raw_cutoff',raw_cutoff,'derived_cutoff',derived_cutoff,'by_table',v_by_table,
    'delete_enabled',coalesce((select allow_source_delete from public.research_archive_control where id=1),false)
  );
end;
$status$;

revoke all on function public.get_research_archive_status(integer,integer) from public;
grant execute on function public.get_research_archive_status(integer,integer) to anon, authenticated, service_role;

create or replace function public.cleanup_research_data(
  p_raw_hours integer default 72,
  p_derived_hours integer default 168,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $cleanup$
declare
  raw_cutoff timestamptz := now() - make_interval(hours => p_raw_hours);
  derived_cutoff timestamptz := now() - make_interval(hours => p_derived_hours);
  n_sentiment bigint := 0; n_news bigint := 0; n_flow bigint := 0; n_price bigint := 0;
  n_event_tx bigint := 0; n_followups bigint := 0; n_context bigint := 0;
  n_transitions bigint := 0; n_wf_snapshots bigint := 0;
  archive_result jsonb := jsonb_build_object('status','not_run_dry_run');
  v_allow_delete boolean := false;
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
    -- Any archive error or verification failure raises before the first DELETE.
    archive_result := public.archive_research_retention_sources(p_raw_hours,p_derived_hours);
    select allow_source_delete into v_allow_delete from public.research_archive_control where id=1;
    if not coalesce(v_allow_delete,false) then
      return jsonb_build_object('dry_run',false,'archive_only',true,'delete_enabled',false,
        'raw_retention_hours',p_raw_hours,'derived_retention_hours',p_derived_hours,
        'raw_cutoff',raw_cutoff,'derived_cutoff',derived_cutoff,
        'delete_enabled',coalesce(v_allow_delete,false),'archive_only',false,
    'counts',jsonb_build_object('asset_sentiment_snapshots',n_sentiment,'asset_news_events',n_news,
          'asset_flow_snapshots',n_flow,'asset_price_snapshots',n_price,'event_flow_transmissions',n_event_tx,
          'whale_flow_shock_followups',n_followups,'whale_flow_transition_context',n_context,
          'whale_flow_transitions',n_transitions,'whale_flow_snapshots',n_wf_snapshots),
        'archive',archive_result);
    end if;

    delete from public.whale_flow_shock_followups s where s.shock_at < derived_cutoff
      and exists(select 1 from public.research_evidence e where e.source_table='whale_flow_shock_followups' and e.source_id=s.id::text);
    delete from public.whale_flow_transition_context s where s.created_at < derived_cutoff
      and exists(select 1 from public.research_evidence e where e.source_table='whale_flow_transition_context' and e.source_id=s.id::text);
    delete from public.event_flow_transmissions s where s.event_at < derived_cutoff
      and exists(select 1 from public.research_evidence e where e.source_table='event_flow_transmissions' and e.source_id=s.id::text);
    delete from public.whale_flow_transitions s where s.created_at < derived_cutoff
      and exists(select 1 from public.research_evidence e where e.source_table='whale_flow_transitions' and e.source_id=s.id::text);
    delete from public.whale_flow_snapshots s where s.created_at < derived_cutoff
      and exists(select 1 from public.research_evidence e where e.source_table='whale_flow_snapshots' and e.source_id=s.id::text);
    delete from public.asset_sentiment_snapshots s where s.observed_at < raw_cutoff
      and exists(select 1 from public.research_evidence e where e.source_table='asset_sentiment_snapshots' and e.source_id=s.id::text);
    delete from public.asset_news_events s where s.event_at < raw_cutoff
      and exists(select 1 from public.research_evidence e where e.source_table='asset_news_events' and e.source_id=s.id::text);
    delete from public.asset_flow_snapshots s where s.bucket_at < raw_cutoff
      and exists(select 1 from public.research_evidence e where e.source_table='asset_flow_snapshots' and e.source_id=s.id::text);
    delete from public.asset_price_snapshots s where s.observed_at < raw_cutoff
      and exists(select 1 from public.research_evidence e where e.source_table='asset_price_snapshots' and e.source_id=s.id::text);
  end if;

  return jsonb_build_object('dry_run',p_dry_run,'raw_retention_hours',p_raw_hours,'derived_retention_hours',p_derived_hours,
    'raw_cutoff',raw_cutoff,'derived_cutoff',derived_cutoff,
    'counts',jsonb_build_object('asset_sentiment_snapshots',n_sentiment,'asset_news_events',n_news,
      'asset_flow_snapshots',n_flow,'asset_price_snapshots',n_price,'event_flow_transmissions',n_event_tx,
      'whale_flow_shock_followups',n_followups,'whale_flow_transition_context',n_context,
      'whale_flow_transitions',n_transitions,'whale_flow_snapshots',n_wf_snapshots),
    'archive',archive_result);
end;
$cleanup$;

revoke all on function public.cleanup_research_data(integer,integer,boolean) from public, anon, authenticated;
grant execute on function public.cleanup_research_data(integer,integer,boolean) to service_role;
