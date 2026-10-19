-- Research Knowledge Archive schema + fail-closed retention protection.
-- Additive, idempotent, and intentionally NOT applied to production by this change.
-- The existing cleanup cron can continue using cleanup_research_data after this
-- migration is explicitly reviewed/applied: source deletion is gated on evidence capture.

create table if not exists public.research_evidence (
  id uuid primary key default gen_random_uuid(),
  source_table text not null check (length(source_table) between 1 and 80),
  source_id text not null check (length(source_id) between 1 and 180),
  symbol text,
  observed_at timestamptz not null,
  available_at timestamptz,
  captured_at timestamptz not null default now(),
  fingerprint text not null unique check (length(fingerprint) between 16 and 200),
  role text not null check (role in ('entry_context','outcome','observation')),
  summary text not null default '' check (length(summary) <= 2000),
  check (available_at is null or available_at >= observed_at)
);
alter table public.research_evidence add column if not exists symbol text;
create index if not exists research_evidence_source_idx on public.research_evidence(source_table, source_id);
create index if not exists research_evidence_symbol_time_idx on public.research_evidence(symbol, observed_at desc);
create index if not exists research_evidence_observed_idx on public.research_evidence(observed_at desc);
create index if not exists research_evidence_role_time_idx on public.research_evidence(role, available_at desc);

create table if not exists public.research_cases (
  id uuid primary key default gen_random_uuid(),
  source_table text not null check (length(source_table) between 1 and 80),
  source_id text not null check (length(source_id) between 1 and 180),
  symbol text not null default 'unknown',
  strategy text not null default 'unknown',
  cohort text not null check (cohort in ('Legacy','V2','V3','Unknown')),
  scorer_version text not null default 'unknown',
  fingerprint text,
  entry_at timestamptz not null,
  resolved_at timestamptz,
  maturity_at timestamptz,
  outcome text not null default 'unknown',
  net_pnl numeric,
  pnl_unit text not null default 'USD' check (pnl_unit in ('USD','percent')),
  close_reason text,
  regime text,
  evidence_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_table, source_id, cohort, scorer_version),
  check (resolved_at is null or resolved_at >= entry_at),
  check (maturity_at is null or maturity_at >= entry_at)
);
create index if not exists research_cases_cohort_entry_idx on public.research_cases(cohort, entry_at desc);
create index if not exists research_cases_source_idx on public.research_cases(source_table, source_id);
create index if not exists research_cases_outcome_idx on public.research_cases(cohort, outcome, resolved_at desc);

create table if not exists public.research_findings (
  id uuid primary key default gen_random_uuid(),
  fingerprint text unique,
  title text not null check (length(title) between 1 and 200),
  statement text not null check (length(statement) between 1 and 2000),
  status text not null default 'candidate' check (status in ('candidate','validated','invalidated')),
  confidence numeric(5,4) not null default 0 check (confidence between 0 and 1),
  cohort text not null check (cohort in ('Legacy','V2','V3','Unknown')),
  scorer_version text not null default 'unknown',
  sample_size integer not null default 0 check (sample_size >= 0),
  evidence_ids text[] not null default '{}',
  case_ids text[] not null default '{}',
  checked_at timestamptz not null default now(),
  limitations text not null default '' check (length(limitations) <= 2000),
  reproduction text not null default '' check (length(reproduction) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists research_findings_cohort_status_idx on public.research_findings(cohort, status, checked_at desc);
create index if not exists research_findings_checked_idx on public.research_findings(checked_at desc);

alter table public.research_evidence enable row level security;
alter table public.research_cases enable row level security;
alter table public.research_findings enable row level security;

drop policy if exists research_evidence_public_read on public.research_evidence;
create policy research_evidence_public_read on public.research_evidence for select to anon, authenticated using (true);
drop policy if exists research_cases_public_read on public.research_cases;
create policy research_cases_public_read on public.research_cases for select to anon, authenticated using (true);
drop policy if exists research_findings_public_read on public.research_findings;
create policy research_findings_public_read on public.research_findings for select to anon, authenticated using (true);

revoke all on public.research_evidence from anon, authenticated;
revoke all on public.research_cases from anon, authenticated;
revoke all on public.research_findings from anon, authenticated;
grant select on public.research_evidence to anon, authenticated;
grant select on public.research_cases to anon, authenticated;
grant select on public.research_findings to anon, authenticated;
grant all on public.research_evidence to service_role;
grant all on public.research_cases to service_role;
grant all on public.research_findings to service_role;

comment on table public.research_evidence is 'Bounded, timestamped evidence references. Raw JSON and credentials are intentionally excluded.';
comment on table public.research_cases is 'Cohort-separated historical cases; open V3 rows must remain unevaluated until explicit maturity.';
comment on table public.research_findings is 'Research hypotheses/findings with reproducibility and evidence references; never a trading signal.';

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
    'raw_cutoff',raw_cutoff,'derived_cutoff',derived_cutoff,'by_table',v_by_table
  );
end;
$status$;

revoke all on function public.get_research_archive_status(integer,integer) from public;
grant execute on function public.get_research_archive_status(integer,integer) to anon, authenticated, service_role;

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

  -- A trade row is only a bounded entry record here; outcome fields are not copied into its entry evidence.
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

  -- Composite signals are entry evidence only if their creation time was not after the trade entry.
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

  -- Only recent or newly resolved variant rows are materialized; the full source cohort remains untouched.
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
  from public.strategy_variant_signals v
  where v.created_at >= v_cutoff or v.resolved_at >= v_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_variant_evidence = row_count;

  insert into public.research_cases(
    source_table,source_id,symbol,strategy,cohort,scorer_version,fingerprint,
    entry_at,resolved_at,maturity_at,outcome,net_pnl,pnl_unit,close_reason,regime,evidence_ids,updated_at
  )
  select 'trades',t.id::text,t.symbol,
    coalesce(nullif(t.entry_source,''),nullif(t.mode,''),'unknown')||'/'||coalesce(t.side,'unknown'),
    'Unknown','paper-trade',null,t.created_at,t.closed_at,null,coalesce(t.status,'unknown'),
    coalesce(t.net_pnl,t.pnl),'USD',t.close_reason,t.regime_label,
    coalesce((
      select array_agg(distinct e.id::text order by e.id::text) from public.research_evidence e
      where e.role='entry_context' and e.available_at <= t.created_at and e.observed_at <= t.created_at
        and (
          (e.source_table='trades' and e.source_id=t.id::text)
          or (t.composite_signal_id is not null and e.source_table='composite_signals' and e.source_id=t.composite_signal_id::text)
          or (e.observed_at >= t.created_at-interval '15 minutes'
            and (e.symbol=t.symbol or (e.symbol is null and e.source_table in ('whale_flow_snapshots','whale_flow_transition_context'))))
        )
    ),'{}'::text[]),now()
  from public.trades t
  on conflict (source_table,source_id,cohort,scorer_version) do update set
    symbol=excluded.symbol,strategy=excluded.strategy,entry_at=excluded.entry_at,
    resolved_at=excluded.resolved_at,outcome=excluded.outcome,net_pnl=excluded.net_pnl,
    close_reason=excluded.close_reason,regime=excluded.regime,
    evidence_ids=(select coalesce(array_agg(distinct item order by item), '{}'::text[])
      from unnest(coalesce(research_cases.evidence_ids,'{}'::text[])||excluded.evidence_ids) as u(item)),
    updated_at=now()
  where research_cases.resolved_at is distinct from excluded.resolved_at
     or research_cases.outcome is distinct from excluded.outcome
     or research_cases.net_pnl is distinct from excluded.net_pnl
     or research_cases.evidence_ids is distinct from excluded.evidence_ids
     or research_cases.close_reason is distinct from excluded.close_reason
     or research_cases.regime is distinct from excluded.regime;
  get diagnostics n_trade_cases = row_count;

  insert into public.research_cases(
    source_table,source_id,symbol,strategy,cohort,scorer_version,fingerprint,
    entry_at,resolved_at,maturity_at,outcome,net_pnl,pnl_unit,close_reason,regime,evidence_ids,updated_at
  )
  select 'strategy_variant_signals',v.id::text,v.symbol,coalesce(v.strategy_name,'unknown'),
    case when v.source_fingerprint like 'v3|%' then 'V3'
         when v.source_fingerprint like 'v2|%' then 'V2'
         when v.source_fingerprint ~ '^v[0-9]+[|]' then 'Unknown'
         when v.source_fingerprint is null then 'Unknown' else 'Legacy' end,
    case when v.source_fingerprint like 'v3|%' then 'v3-mtf-aligned'
         when v.source_fingerprint like 'v2|%' then 'v2'
         when v.source_fingerprint is null or v.source_fingerprint ~ '^v[0-9]+[|]' then 'unknown' else 'legacy' end,
    v.source_fingerprint,v.created_at,v.resolved_at,
    case when lower(coalesce(v.outcome,'')) in ('win','loss','expired') and v.resolved_at is not null then v.resolved_at else null end,
    lower(coalesce(v.outcome,'unknown')),v.pnl_pct,'percent',null,v.regime_label,
    coalesce((
      select array_agg(distinct e.id::text order by e.id::text) from public.research_evidence e
      where e.role='entry_context' and e.available_at <= v.created_at and e.observed_at <= v.created_at
        and (
          (e.source_table='strategy_variant_signals' and e.source_id=v.id::text)
          or (e.observed_at >= v.created_at-interval '15 minutes'
            and (e.symbol=v.symbol or (e.symbol is null and e.source_table in ('whale_flow_snapshots','whale_flow_transition_context'))))
        )
    ),'{}'::text[]),now()
  from public.strategy_variant_signals v
  where v.created_at >= v_cutoff or v.resolved_at >= v_cutoff
  on conflict (source_table,source_id,cohort,scorer_version) do update set
    symbol=excluded.symbol,strategy=excluded.strategy,fingerprint=excluded.fingerprint,
    entry_at=excluded.entry_at,resolved_at=excluded.resolved_at,maturity_at=excluded.maturity_at,
    outcome=excluded.outcome,net_pnl=excluded.net_pnl,regime=excluded.regime,
    evidence_ids=(select coalesce(array_agg(distinct item order by item), '{}'::text[])
      from unnest(coalesce(research_cases.evidence_ids,'{}'::text[])||excluded.evidence_ids) as u(item)),
    updated_at=now()
  where research_cases.resolved_at is distinct from excluded.resolved_at
     or research_cases.maturity_at is distinct from excluded.maturity_at
     or research_cases.outcome is distinct from excluded.outcome
     or research_cases.net_pnl is distinct from excluded.net_pnl
     or research_cases.evidence_ids is distinct from excluded.evidence_ids
     or research_cases.fingerprint is distinct from excluded.fingerprint;
  get diagnostics n_variant_cases = row_count;

  return jsonb_build_object(
    'status','ok','lookback_hours',p_lookback_hours,'cutoff',v_cutoff,
    'evidence_inserted',jsonb_build_object('trades',n_trade_evidence,'composite_signals',n_signal_evidence,'strategy_variants',n_variant_evidence),
    'cases_inserted_or_updated',jsonb_build_object('trades',n_trade_cases,'strategy_variants',n_variant_cases)
  );
end;
$sync$;

revoke all on function public.refresh_research_knowledge_cases(integer) from public, anon, authenticated;
grant execute on function public.refresh_research_knowledge_cases(integer) to service_role;

create or replace function public.archive_research_retention_sources(
  p_raw_hours integer default 72,
  p_derived_hours integer default 168
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $archive$
declare
  raw_cutoff timestamptz := now() - make_interval(hours => p_raw_hours);
  derived_cutoff timestamptz := now() - make_interval(hours => p_derived_hours);
  n_price bigint := 0; n_flow bigint := 0; n_sentiment bigint := 0; n_news bigint := 0;
  n_transmissions bigint := 0; n_followups bigint := 0; n_context bigint := 0;
  n_transitions bigint := 0; n_whale_snapshots bigint := 0;
begin
  if p_raw_hours < 24 or p_derived_hours < p_raw_hours then
    raise exception 'Invalid retention windows';
  end if;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'asset_price_snapshots',s.id::text,s.asset,s.observed_at,s.created_at,now(),
    md5('asset_price_snapshots|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object('asset',s.asset,'observed_at',s.observed_at,'price',s.price,'source',s.source))::text),
    'entry_context',left(format('asset=%s price=%s source=%s',s.asset,s.price,s.source),2000)
  from public.asset_price_snapshots s where s.observed_at < raw_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_price = row_count;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'asset_flow_snapshots',s.id::text,s.asset,s.bucket_at,s.created_at,now(),
    md5('asset_flow_snapshots|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object('asset',s.asset,'bucket_at',s.bucket_at,'sample_size',s.sample_size,'buy_usd',s.buy_usd,'sell_usd',s.sell_usd,'total_usd',s.total_usd,'flow_score',s.flow_score,'dominant_state',s.dominant_state,'source',s.source))::text),
    'entry_context',left(format('asset=%s flow_score=%s state=%s samples=%s buy_usd=%s sell_usd=%s',s.asset,s.flow_score,s.dominant_state,s.sample_size,s.buy_usd,s.sell_usd),2000)
  from public.asset_flow_snapshots s where s.bucket_at < raw_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_flow = row_count;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'asset_sentiment_snapshots',s.id::text,s.asset,s.observed_at,s.created_at,now(),
    md5('asset_sentiment_snapshots|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object('asset',s.asset,'observed_at',s.observed_at,'source',s.source,'mention_count',s.mention_count,'unique_items',s.unique_items,'bullish_count',s.bullish_count,'bearish_count',s.bearish_count,'neutral_count',s.neutral_count,'sentiment_score',s.sentiment_score,'mention_velocity',s.mention_velocity,'sentiment_velocity',s.sentiment_velocity,'shock_score',s.shock_score))::text),
    'entry_context',left(format('asset=%s source=%s sentiment=%s mentions=%s unique=%s bullish=%s bearish=%s neutral=%s mention_velocity=%s sentiment_velocity=%s shock=%s',s.asset,s.source,s.sentiment_score,s.mention_count,s.unique_items,s.bullish_count,s.bearish_count,s.neutral_count,s.mention_velocity,s.sentiment_velocity,s.shock_score),2000)
  from public.asset_sentiment_snapshots s where s.observed_at < raw_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_sentiment = row_count;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'asset_news_events',s.id::text,s.asset,s.event_at,s.created_at,now(),
    md5('asset_news_events|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object('asset',s.asset,'event_at',s.event_at,'source',s.source,'title',s.title,'sentiment_score',s.sentiment_score,'sentiment_label',s.sentiment_label,'event_type',s.event_type,'relevance',s.relevance,'novelty',s.novelty,'shock_score',s.shock_score,'fingerprint',s.fingerprint))::text),
    'entry_context',left(format('asset=%s source=%s title=%s sentiment=%s label=%s shock=%s',s.asset,s.source,s.title,s.sentiment_score,s.sentiment_label,s.shock_score),2000)
  from public.asset_news_events s where s.event_at < raw_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_news = row_count;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'event_flow_transmissions',s.id::text,s.asset,s.event_at,s.updated_at,now(),
    md5('event_flow_transmissions|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object('asset',s.asset,'source_kind',s.source_kind,'source_id',s.source_id,'event_at',s.event_at,'shock_score',s.shock_score,'event_sentiment',s.event_sentiment,'flow_delta_15m',s.flow_delta_15m,'flow_delta_30m',s.flow_delta_30m,'flow_delta_60m',s.flow_delta_60m,'price_return_15m',s.price_return_15m,'price_return_1h',s.price_return_1h,'price_return_4h',s.price_return_4h,'price_return_24h',s.price_return_24h,'transmission_class',s.transmission_class,'data_quality',s.data_quality))::text),
    'outcome',left(format('asset=%s event=%s class=%s quality=%s flow15=%s flow30=%s return1h=%s return4h=%s return24h=%s',s.asset,s.source_kind,s.transmission_class,s.data_quality,s.flow_delta_15m,s.flow_delta_30m,s.price_return_1h,s.price_return_4h,s.price_return_24h),2000)
  from public.event_flow_transmissions s where s.event_at < derived_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_transmissions = row_count;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'whale_flow_shock_followups',s.id::text,null,s.shock_at,s.updated_at,now(),
    md5('whale_flow_shock_followups|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object('transition_id',s.transition_id,'shock_at',s.shock_at,'shock_delta_pp',s.shock_delta_pp,'shock_speed',s.shock_speed,'flow_15m',s.flow_15m,'flow_30m',s.flow_30m,'flow_60m',s.flow_60m,'flow_4h',s.flow_4h,'flow_24h',s.flow_24h,'delta_15m_pp',s.delta_15m_pp,'delta_30m_pp',s.delta_30m_pp,'delta_60m_pp',s.delta_60m_pp,'delta_4h_pp',s.delta_4h_pp,'delta_24h_pp',s.delta_24h_pp,'flow_response',s.flow_response,'price_response',s.price_response,'curvature',s.curvature,'data_quality',s.data_quality))::text),
    'outcome',left(format('shock_delta=%s speed=%s flow15=%s flow30=%s flow60=%s flow4h=%s flow24h=%s delta15=%s delta30=%s delta60=%s delta4h=%s delta24h=%s btc15=%s btc30=%s btc1h=%s btc4h=%s btc24h=%s flow_response=%s price_response=%s curvature=%s quality=%s',s.shock_delta_pp,s.shock_speed,s.flow_15m,s.flow_30m,s.flow_60m,s.flow_4h,s.flow_24h,s.delta_15m_pp,s.delta_30m_pp,s.delta_60m_pp,s.delta_4h_pp,s.delta_24h_pp,s.btc_return_15m,s.btc_return_30m,s.btc_return_1h,s.btc_return_4h,s.btc_return_24h,s.flow_response,s.price_response,s.curvature,s.data_quality),2000)
  from public.whale_flow_shock_followups s where s.shock_at < derived_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_followups = row_count;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'whale_flow_transition_context',s.id::text,null,s.captured_at,s.created_at,now(),
    md5('whale_flow_transition_context|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object('transition_id',s.transition_id,'captured_at',s.captured_at,'lookback_minutes',s.lookback_minutes,'data_quality',s.data_quality,'indicator_samples',s.indicator_context->>'samples','signal_samples',s.signal_context->>'samples','sentiment_samples',s.sentiment_context->>'samples','news_samples',s.news_context->>'samples'))::text),
    'entry_context',left(format('transition=%s lookback=%s quality=%s indicators=%s signal_samples=%s buy=%s sell=%s regimes=%s sentiment_samples=%s sentiment_avg=%s sentiment_bullish=%s sentiment_bearish=%s news_samples=%s news_avg=%s news_bullish=%s news_bearish=%s',s.transition_id,s.lookback_minutes,s.data_quality,s.indicator_context->>'samples',s.signal_context->>'samples',s.signal_context->>'buy',s.signal_context->>'sell',left(coalesce(s.signal_context->>'regimes',''),250),s.sentiment_context->>'samples',s.sentiment_context->>'avg_score',s.sentiment_context->>'bullish',s.sentiment_context->>'bearish',s.news_context->>'samples',s.news_context->>'avg_score',s.news_context->>'bullish',s.news_context->>'bearish'),2000)
  from public.whale_flow_transition_context s where s.created_at < derived_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_context = row_count;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'whale_flow_transitions',s.id::text,null,s.detected_at,coalesce(s.confirmation_at,s.created_at),now(),
    md5('whale_flow_transitions|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object('from_snapshot_id',s.from_snapshot_id,'to_snapshot_id',s.to_snapshot_id,'previous_state',s.previous_state,'new_state',s.new_state,'detected_at',s.detected_at,'delta_score',s.delta_score,'delta_pp',s.delta_pp,'velocity_pp_per_hour',s.velocity_pp_per_hour,'transition_speed',s.transition_speed,'classification',s.classification,'confirmation_at',s.confirmation_at,'persistence_snapshots',s.persistence_snapshots,'persistence_minutes',s.persistence_minutes))::text),
    'observation',left(format('state=%s->%s delta=%s delta_pp=%s speed=%s class=%s persistence=%s/%s',s.previous_state,s.new_state,s.delta_score,s.delta_pp,s.transition_speed,s.classification,s.persistence_snapshots,s.persistence_minutes),2000)
  from public.whale_flow_transitions s where s.created_at < derived_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_transitions = row_count;

  insert into public.research_evidence(source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary)
  select 'whale_flow_snapshots',s.id::text,null,s.bucket_at,s.created_at,now(),
    md5('whale_flow_snapshots|'||s.id::text||'|'||jsonb_strip_nulls(jsonb_build_object('bucket_at',s.bucket_at,'sample_size',s.sample_size,'accumulation_usd',s.accumulation_usd,'distribution_usd',s.distribution_usd,'total_usd',s.total_usd,'accumulation_pct',s.accumulation_pct,'neutral_pct',s.neutral_pct,'distribution_pct',s.distribution_pct,'flow_score',s.flow_score,'dominant_state',s.dominant_state,'source',s.source))::text),
    'entry_context',left(format('state=%s flow=%s accumulation_usd=%s distribution_usd=%s total_usd=%s samples=%s',s.dominant_state,s.flow_score,s.accumulation_usd,s.distribution_usd,s.total_usd,s.sample_size),2000)
  from public.whale_flow_snapshots s where s.created_at < derived_cutoff
  on conflict (fingerprint) do nothing;
  get diagnostics n_whale_snapshots = row_count;

  if exists (select 1 from public.asset_price_snapshots s where s.observed_at < raw_cutoff and not exists(select 1 from public.research_evidence e where e.source_table='asset_price_snapshots' and e.source_id=s.id::text))
    or exists (select 1 from public.asset_flow_snapshots s where s.bucket_at < raw_cutoff and not exists(select 1 from public.research_evidence e where e.source_table='asset_flow_snapshots' and e.source_id=s.id::text))
    or exists (select 1 from public.asset_sentiment_snapshots s where s.observed_at < raw_cutoff and not exists(select 1 from public.research_evidence e where e.source_table='asset_sentiment_snapshots' and e.source_id=s.id::text))
    or exists (select 1 from public.asset_news_events s where s.event_at < raw_cutoff and not exists(select 1 from public.research_evidence e where e.source_table='asset_news_events' and e.source_id=s.id::text))
    or exists (select 1 from public.event_flow_transmissions s where s.event_at < derived_cutoff and not exists(select 1 from public.research_evidence e where e.source_table='event_flow_transmissions' and e.source_id=s.id::text))
    or exists (select 1 from public.whale_flow_shock_followups s where s.shock_at < derived_cutoff and not exists(select 1 from public.research_evidence e where e.source_table='whale_flow_shock_followups' and e.source_id=s.id::text))
    or exists (select 1 from public.whale_flow_transition_context s where s.created_at < derived_cutoff and not exists(select 1 from public.research_evidence e where e.source_table='whale_flow_transition_context' and e.source_id=s.id::text))
    or exists (select 1 from public.whale_flow_transitions s where s.created_at < derived_cutoff and not exists(select 1 from public.research_evidence e where e.source_table='whale_flow_transitions' and e.source_id=s.id::text))
    or exists (select 1 from public.whale_flow_snapshots s where s.created_at < derived_cutoff and not exists(select 1 from public.research_evidence e where e.source_table='whale_flow_snapshots' and e.source_id=s.id::text))
  then
    raise exception 'Research archive verification failed; retention cleanup aborted fail-closed';
  end if;

  return jsonb_build_object('ok',true,'raw_cutoff',raw_cutoff,'derived_cutoff',derived_cutoff,
    'inserted',jsonb_build_object('asset_price_snapshots',n_price,'asset_flow_snapshots',n_flow,
      'asset_sentiment_snapshots',n_sentiment,'asset_news_events',n_news,
      'event_flow_transmissions',n_transmissions,'whale_flow_shock_followups',n_followups,
      'whale_flow_transition_context',n_context,'whale_flow_transitions',n_transitions,
      'whale_flow_snapshots',n_whale_snapshots));
end;
$archive$;

revoke all on function public.archive_research_retention_sources(integer,integer) from public, anon, authenticated;
grant execute on function public.archive_research_retention_sources(integer,integer) to service_role;

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
