-- Bound refresh work so a single pipeline run cannot scan/materialize the full variant history.
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
    select v.*
    from public.strategy_variant_signals v
    where (v.created_at >= v_cutoff or v.resolved_at >= v_cutoff)
      and not exists (
        select 1 from public.research_evidence e
        where e.source_table='strategy_variant_signals' and e.source_id=v.id::text and e.role='entry_context'
      )
    order by v.created_at asc, v.id asc
    limit 250
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
  from candidates v
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
        and ((e.source_table='trades' and e.source_id=t.id::text)
          or (t.composite_signal_id is not null and e.source_table='composite_signals' and e.source_id=t.composite_signal_id::text))
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
     or research_cases.evidence_ids is distinct from (
       select coalesce(array_agg(distinct item order by item), '{}'::text[])
       from unnest(coalesce(research_cases.evidence_ids,'{}'::text[])||excluded.evidence_ids) as u(item)
     )
     or research_cases.close_reason is distinct from excluded.close_reason
     or research_cases.regime is distinct from excluded.regime;
  get diagnostics n_trade_cases = row_count;

  with candidates as (
    select v.*
    from public.strategy_variant_signals v
    where (v.created_at >= v_cutoff or v.resolved_at >= v_cutoff)
      and (
        not exists(select 1 from public.research_cases c where c.source_table='strategy_variant_signals' and c.source_id=v.id::text)
        or exists(select 1 from public.research_cases c where c.source_table='strategy_variant_signals' and c.source_id=v.id::text
          and (c.fingerprint is distinct from v.source_fingerprint
            or c.outcome is distinct from lower(coalesce(v.outcome,'unknown'))
            or c.resolved_at is distinct from v.resolved_at
            or c.net_pnl is distinct from v.pnl_pct
            or c.regime is distinct from v.regime_label))
      )
    order by v.created_at asc, v.id asc
    limit 250
  )
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
      where e.source_table='strategy_variant_signals' and e.source_id=v.id::text and e.role='entry_context'
        and e.available_at <= v.created_at and e.observed_at <= v.created_at
    ),'{}'::text[]),now()
  from candidates v
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
     or research_cases.evidence_ids is distinct from (
       select coalesce(array_agg(distinct item order by item), '{}'::text[])
       from unnest(coalesce(research_cases.evidence_ids,'{}'::text[])||excluded.evidence_ids) as u(item)
     )
     or research_cases.fingerprint is distinct from excluded.fingerprint;
  get diagnostics n_variant_cases = row_count;

  return jsonb_build_object(
    'status','ok','lookback_hours',p_lookback_hours,'cutoff',v_cutoff,
    'variant_scope','bounded recent/newly resolved variants; full source cohorts remain untouched',
    'evidence_inserted',jsonb_build_object('trades',n_trade_evidence,'composite_signals',n_signal_evidence,'strategy_variants',n_variant_evidence),
    'cases_inserted_or_updated',jsonb_build_object('trades',n_trade_cases,'strategy_variants',n_variant_cases)
  );
end;
$sync$;

revoke all on function public.refresh_research_knowledge_cases(integer) from public, anon, authenticated;
grant execute on function public.refresh_research_knowledge_cases(integer) to service_role;
