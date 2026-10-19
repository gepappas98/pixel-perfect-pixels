-- Pause archive writes until the 480 MB storage threshold and evidence value are reviewed.
alter table public.research_archive_control add column if not exists allow_archive boolean not null default false;
update public.research_archive_control set allow_archive=false,
 note='Archive and source deletion paused pending storage and evidence-value review' where id=1;
drop index if exists public.research_cases_source_idx;

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
    'delete_enabled',coalesce((select allow_source_delete from public.research_archive_control where id=1),false),
    'archive_enabled',coalesce((select allow_archive from public.research_archive_control where id=1),false)
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
  v_allow_archive boolean := false;
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
    select allow_archive,allow_source_delete into v_allow_archive,v_allow_delete
      from public.research_archive_control where id=1;
    if not coalesce(v_allow_archive,false) then
      return jsonb_build_object('dry_run',false,'archive_only',true,'archive_enabled',false,'delete_enabled',false,
        'reason','archive paused pending storage and evidence-value review',
        'raw_retention_hours',p_raw_hours,'derived_retention_hours',p_derived_hours,
        'raw_cutoff',raw_cutoff,'derived_cutoff',derived_cutoff,
        'archive_enabled',coalesce(v_allow_archive,false),'delete_enabled',coalesce(v_allow_delete,false),'archive_only',false,
    'counts',jsonb_build_object('asset_sentiment_snapshots',n_sentiment,'asset_news_events',n_news,
          'asset_flow_snapshots',n_flow,'asset_price_snapshots',n_price,'event_flow_transmissions',n_event_tx,
          'whale_flow_shock_followups',n_followups,'whale_flow_transition_context',n_context,
          'whale_flow_transitions',n_transitions,'whale_flow_snapshots',n_wf_snapshots),
        'archive',jsonb_build_object('status','paused_pending_review'));
    end if;
    archive_result := public.archive_research_retention_sources(p_raw_hours,p_derived_hours);
    if not coalesce(v_allow_delete,false) then
      return jsonb_build_object('dry_run',false,'archive_only',true,'archive_enabled',true,'delete_enabled',false,
        'reason','archive complete; source deletion remains locked pending review',
        'raw_retention_hours',p_raw_hours,'derived_retention_hours',p_derived_hours,
        'raw_cutoff',raw_cutoff,'derived_cutoff',derived_cutoff,
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

create or replace function public.refresh_research_knowledge_cases(
  p_lookback_hours integer default 72
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $sync$
declare
  v_cutoff timestamptz := now() - make_interval(hours => p_lookback_hours);
  n_trade_evidence bigint := 0; n_signal_evidence bigint := 0; n_variant_evidence bigint := 0;
  n_trade_cases bigint := 0; n_variant_cases bigint := 0;
begin
  if p_lookback_hours < 1 or p_lookback_hours > 8760 then
    raise exception 'p_lookback_hours must be between 1 and 8760';
  end if;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'trades',t.id::text,t.symbol,t.created_at,t.created_at,now(),
    md5('trades|'||t.id::text||'|'||jsonb_strip_nulls(jsonb_build_object(
      'symbol',t.symbol,'side',t.side,'mode',t.mode,'entry_source',t.entry_source,
      'entry_price',t.entry_price,'regime_label',t.regime_label,'source_tags',to_jsonb(t.source_tags),
      'market_session',t.market_session,'composite_signal_id',t.composite_signal_id
    ))::text),
    'entry_context',left(format('entry_source=%s side=%s symbol=%s entry_price=%s regime=%s session=%s tags=%s',
      coalesce(t.entry_source,t.mode,'unknown'),coalesce(t.side,'unknown'),t.symbol,t.entry_price,
      coalesce(t.regime_label,'unknown'),coalesce(t.market_session,'unknown'),coalesce(array_to_string(t.source_tags,','),'')),2000)
  from public.trades t
  on conflict (fingerprint) do nothing;
  get diagnostics n_trade_evidence = row_count;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'composite_signals',s.id::text,s.symbol,s.created_at,s.created_at,now(),
    md5('composite_signals|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object(
      'symbol',s.symbol,'created_at',s.created_at,'confidence',s.confidence,
      'recommendation',s.recommendation,'regime_label',s.regime_label,'source_tags',to_jsonb(s.source_tags)
    ))::text),
    'entry_context',left(format('recommendation=%s confidence=%s regime=%s tags=%s',
      coalesce(s.recommendation,'unknown'),s.confidence,coalesce(s.regime_label,'unknown'),coalesce(array_to_string(s.source_tags,','),'')),2000)
  from public.composite_signals s
  where exists(select 1 from public.trades t where t.composite_signal_id=s.id and s.created_at <= t.created_at)
  on conflict (fingerprint) do nothing;
  get diagnostics n_signal_evidence = row_count;

  with candidates as (
    select v.* from public.strategy_variant_signals v
    where v.source_fingerprint like 'v3|%'
      and (v.created_at >= v_cutoff or v.resolved_at >= v_cutoff)
      and not exists(select 1 from public.research_evidence e where e.source_table='strategy_variant_signals' and e.source_id=v.id::text and e.role='entry_context')
    order by v.created_at asc,v.id asc limit 250
  )
  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'strategy_variant_signals',v.id::text,v.symbol,v.created_at,v.created_at,now(),
    md5('strategy_variant_signals|'||v.id::text||'|'||jsonb_strip_nulls(jsonb_build_object(
      'strategy_name',v.strategy_name,'symbol',v.symbol,'source_fingerprint',v.source_fingerprint,
      'created_at',v.created_at,'confidence',v.confidence,'recommendation',v.recommendation,'score',v.score,
      'regime_label',v.regime_label,'production_regime_label',v.production_regime_label,
      'market_regime_score',v.market_regime_score,'asset_trend_regime',v.asset_trend_regime,
      'asset_volatility_regime',v.asset_volatility_regime,'source_tags',to_jsonb(v.source_tags)
    ))::text),
    'entry_context',left(format('strategy=%s symbol=%s score=%s confidence=%s recommendation=%s regime=%s production_regime=%s market_regime_score=%s asset_trend=%s asset_volatility=%s tags=%s',
      v.strategy_name,v.symbol,v.score,v.confidence,v.recommendation,coalesce(v.regime_label,'unknown'),
      coalesce(v.production_regime_label,'unknown'),v.market_regime_score,coalesce(v.asset_trend_regime,'unknown'),
      coalesce(v.asset_volatility_regime,'unknown'),coalesce(array_to_string(v.source_tags,','),'')),2000)
  from candidates v on conflict (fingerprint) do nothing;
  get diagnostics n_variant_evidence = row_count;

  insert into public.research_cases(
    source_table,source_id,symbol,strategy,cohort,scorer_version,fingerprint,
    entry_at,resolved_at,maturity_at,outcome,net_pnl,pnl_unit,close_reason,regime,evidence_ids,updated_at
  )
  select 'trades',t.id::text,t.symbol,
    coalesce(nullif(t.entry_source,''),nullif(t.mode,''),'unknown')||'/'||coalesce(t.side,'unknown'),
    'Unknown','paper-trade',null,t.created_at,t.closed_at,null,coalesce(t.status,'unknown'),
    coalesce(t.net_pnl,t.pnl),'USD',t.close_reason,t.regime_label,
    coalesce((select array_agg(distinct e.id::text order by e.id::text) from public.research_evidence e
      where e.role='entry_context' and e.available_at<=t.created_at and e.observed_at<=t.created_at
      and ((e.source_table='trades' and e.source_id=t.id::text)
        or (t.composite_signal_id is not null and e.source_table='composite_signals' and e.source_id=t.composite_signal_id::text))
    ),'{}'::text[]),now()
  from public.trades t
  on conflict (source_table,source_id,cohort,scorer_version) do update set
    symbol=excluded.symbol,strategy=excluded.strategy,entry_at=excluded.entry_at,resolved_at=excluded.resolved_at,
    outcome=excluded.outcome,net_pnl=excluded.net_pnl,close_reason=excluded.close_reason,regime=excluded.regime,
    evidence_ids=(select coalesce(array_agg(distinct item order by item), '{}'::text[]) from unnest(coalesce(research_cases.evidence_ids,'{}'::text[])||excluded.evidence_ids) as u(item)),
    updated_at=now()
  where research_cases.resolved_at is distinct from excluded.resolved_at
     or research_cases.outcome is distinct from excluded.outcome
     or research_cases.net_pnl is distinct from excluded.net_pnl
     or research_cases.evidence_ids is distinct from (select coalesce(array_agg(distinct item order by item), '{}'::text[]) from unnest(coalesce(research_cases.evidence_ids,'{}'::text[])||excluded.evidence_ids) as u(item))
     or research_cases.close_reason is distinct from excluded.close_reason
     or research_cases.regime is distinct from excluded.regime;
  get diagnostics n_trade_cases = row_count;

  with candidates as (
    select v.* from public.strategy_variant_signals v
    where v.source_fingerprint like 'v3|%'
      and (v.created_at >= v_cutoff or v.resolved_at >= v_cutoff)
      and (
        not exists(select 1 from public.research_cases c where c.source_table='strategy_variant_signals' and c.source_id=v.id::text)
        or exists(select 1 from public.research_cases c where c.source_table='strategy_variant_signals' and c.source_id=v.id::text
          and (c.fingerprint is distinct from v.source_fingerprint
            or c.outcome is distinct from lower(coalesce(v.outcome,'unknown'))
            or c.resolved_at is distinct from v.resolved_at
            or c.net_pnl is distinct from v.pnl_pct
            or c.regime is distinct from v.regime_label))
      )
    order by v.created_at asc,v.id asc limit 250
  )
  insert into public.research_cases(
    source_table,source_id,symbol,strategy,cohort,scorer_version,fingerprint,
    entry_at,resolved_at,maturity_at,outcome,net_pnl,pnl_unit,close_reason,regime,evidence_ids,updated_at
  )
  select 'strategy_variant_signals',v.id::text,v.symbol,coalesce(v.strategy_name,'unknown'),
    'V3','v3-mtf-aligned',v.source_fingerprint,v.created_at,v.resolved_at,
    case when lower(coalesce(v.outcome,'')) in ('win','loss','expired') and v.resolved_at is not null then v.resolved_at else null end,
    lower(coalesce(v.outcome,'unknown')),v.pnl_pct,'percent',null,v.regime_label,
    coalesce((select array_agg(distinct e.id::text order by e.id::text) from public.research_evidence e
      where e.source_table='strategy_variant_signals' and e.source_id=v.id::text and e.role='entry_context'
        and e.available_at<=v.created_at and e.observed_at<=v.created_at
    ),'{}'::text[]),now()
  from candidates v
  on conflict (source_table,source_id,cohort,scorer_version) do update set
    symbol=excluded.symbol,strategy=excluded.strategy,fingerprint=excluded.fingerprint,
    entry_at=excluded.entry_at,resolved_at=excluded.resolved_at,maturity_at=excluded.maturity_at,
    outcome=excluded.outcome,net_pnl=excluded.net_pnl,regime=excluded.regime,
    evidence_ids=(select coalesce(array_agg(distinct item order by item), '{}'::text[]) from unnest(coalesce(research_cases.evidence_ids,'{}'::text[])||excluded.evidence_ids) as u(item)),
    updated_at=now()
  where research_cases.resolved_at is distinct from excluded.resolved_at
     or research_cases.maturity_at is distinct from excluded.maturity_at
     or research_cases.outcome is distinct from excluded.outcome
     or research_cases.net_pnl is distinct from excluded.net_pnl
     or research_cases.evidence_ids is distinct from (select coalesce(array_agg(distinct item order by item), '{}'::text[]) from unnest(coalesce(research_cases.evidence_ids,'{}'::text[])||excluded.evidence_ids) as u(item))
     or research_cases.fingerprint is distinct from excluded.fingerprint;
  get diagnostics n_variant_cases = row_count;

  return jsonb_build_object('status','ok','lookback_hours',p_lookback_hours,'cutoff',v_cutoff,
    'variant_scope','V3 only; V2/Legacy remain in source table and are not duplicated by automatic refresh',
    'evidence_inserted',jsonb_build_object('trades',n_trade_evidence,'composite_signals',n_signal_evidence,'v3_variants',n_variant_evidence),
    'cases_inserted_or_updated',jsonb_build_object('trades',n_trade_cases,'v3_variants',n_variant_cases));
end;
$sync$;

revoke all on function public.refresh_research_knowledge_cases(integer) from public, anon, authenticated;
grant execute on function public.refresh_research_knowledge_cases(integer) to service_role;

