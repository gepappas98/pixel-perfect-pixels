-- Structured, bounded descriptive candidates. These are never auto-validated or used as trading gates.
alter table public.research_findings
  add column if not exists symbol text,
  add column if not exists strategy text,
  add column if not exists regime text,
  add column if not exists win_rate numeric(6,5),
  add column if not exists mean_pnl numeric(12,6),
  add column if not exists median_pnl numeric(12,6),
  add column if not exists win_count integer not null default 0,
  add column if not exists loss_count integer not null default 0,
  add column if not exists expired_count integer not null default 0,
  add column if not exists unique_symbols integer not null default 0,
  add column if not exists sample_start timestamptz,
  add column if not exists sample_end timestamptz,
  add column if not exists method_version text not null default 'manual';

create index if not exists research_findings_strategy_regime_idx
  on public.research_findings(cohort, scorer_version, strategy, regime, status);

create or replace function public.refresh_research_candidate_findings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $findings$
declare
  v_upserted bigint := 0;
begin
  with eligible as (
    select c.id::text case_id,c.symbol,coalesce(nullif(c.strategy,''),'unknown') strategy,
      c.cohort,c.scorer_version,coalesce(nullif(c.regime,''),'unknown') regime,
      lower(c.outcome) outcome,c.net_pnl,c.entry_at,c.resolved_at,c.evidence_ids
    from public.research_cases c
    where c.cohort in ('V2','V3')
      and c.scorer_version in ('v2','v3-mtf-aligned')
      and c.pnl_unit='percent'
      and c.maturity_at is not null
      and c.resolved_at is not null
      and c.resolved_at >= c.entry_at
      and c.resolved_at <= now()
      and lower(c.outcome) in ('win','loss','expired')
      and c.net_pnl is not null
      and cardinality(c.evidence_ids)>0
      and c.entry_at >= now()-interval '90 days'
  ), groups as (
    select cohort,scorer_version,strategy,regime,count(*) total
    from eligible
    group by cohort,scorer_version,strategy,regime
    having count(*)>=25
    order by count(*) desc,cohort,scorer_version,strategy,regime
    limit 30
  ), ranked as (
    select e.*,row_number() over(
      partition by e.cohort,e.scorer_version,e.strategy,e.regime
      order by e.entry_at desc,e.case_id
    ) sample_rank
    from eligible e
    join groups g using(cohort,scorer_version,strategy,regime)
  ), sampled as (
    select * from ranked where sample_rank<=25
  ), case_metrics as (
    select cohort,scorer_version,strategy,regime,count(*)::integer sample_size,
      count(*) filter(where outcome='win')::integer win_count,
      count(*) filter(where outcome='loss')::integer loss_count,
      count(*) filter(where outcome='expired')::integer expired_count,
      count(distinct symbol)::integer unique_symbols,
      round((count(*) filter(where outcome='win')::numeric / nullif(count(*),0)),5) win_rate,
      round(avg(net_pnl)::numeric,6) mean_pnl,
      round(percentile_cont(0.5) within group(order by net_pnl)::numeric,6) median_pnl,
      min(entry_at) sample_start,max(entry_at) sample_end,
      array_agg(case_id order by entry_at desc,case_id) case_ids
    from sampled
    group by cohort,scorer_version,strategy,regime
  ), evidence_metrics as (
    select s.cohort,s.scorer_version,s.strategy,s.regime,
      array_agg(distinct evidence_id order by evidence_id) evidence_ids
    from sampled s
    cross join lateral unnest(s.evidence_ids) as evidence(evidence_id)
    join public.research_evidence e on e.id::text=evidence_id
      and e.role='entry_context'
      and e.available_at <= s.entry_at
      and e.observed_at <= s.entry_at
    group by s.cohort,s.scorer_version,s.strategy,s.regime
  ), prepared as (
    select m.*,e.evidence_ids,
      md5('research-candidate-v1|'||m.cohort||'|'||m.scorer_version||'|'||m.strategy||'|'||m.regime) fingerprint,
      left(format('%s %s / %s — descriptive candidate',m.cohort,m.strategy,m.regime),200) title,
      left(format(
        'Candidate descriptive pattern from %s matured cases in cohort %s (scorer %s), strategy %s, regime %s: %s wins, %s losses, %s expired; win rate %s%%; mean PnL %s%%; median PnL %s%%; %s distinct symbols; entry window %s to %s.',
        m.sample_size,m.cohort,m.scorer_version,m.strategy,m.regime,m.win_count,m.loss_count,m.expired_count,
        round(m.win_rate*100,2),m.mean_pnl,m.median_pnl,m.unique_symbols,m.sample_start,m.sample_end
      ),2000) statement,
      left('Candidate only. Bounded to the 25 most recent eligible cases in this group; resolver timing and cohort materialization may bias the sample. Descriptive association only: no causal claim, no out-of-sample validation, and confidence is deliberately uncalibrated at 0.',2000) limitations,
      left(format('method=candidate-v1; cohort=%s; scorer_version=%s; strategy=%s; regime=%s; use exactly the stored case_ids and evidence_ids; terminal outcome plus maturity_at and point-in-time entry evidence required; sample cap=25.',m.cohort,m.scorer_version,m.strategy,m.regime),2000) reproduction
    from case_metrics m
    join evidence_metrics e using(cohort,scorer_version,strategy,regime)
  )
  insert into public.research_findings(
    fingerprint,title,statement,status,confidence,cohort,scorer_version,sample_size,
    evidence_ids,case_ids,checked_at,limitations,reproduction,symbol,strategy,regime,
    win_rate,mean_pnl,median_pnl,win_count,loss_count,expired_count,unique_symbols,
    sample_start,sample_end,method_version,updated_at
  )
  select fingerprint,title,statement,'candidate',0,cohort,scorer_version,sample_size,
    evidence_ids,case_ids,now(),limitations,reproduction,null,strategy,regime,
    win_rate,mean_pnl,median_pnl,win_count,loss_count,expired_count,unique_symbols,
    sample_start,sample_end,'candidate-v1',now()
  from prepared
  on conflict (fingerprint) do update set
    title=excluded.title,statement=excluded.statement,sample_size=excluded.sample_size,
    evidence_ids=excluded.evidence_ids,case_ids=excluded.case_ids,checked_at=now(),
    limitations=excluded.limitations,reproduction=excluded.reproduction,
    win_rate=excluded.win_rate,mean_pnl=excluded.mean_pnl,median_pnl=excluded.median_pnl,
    win_count=excluded.win_count,loss_count=excluded.loss_count,expired_count=excluded.expired_count,
    unique_symbols=excluded.unique_symbols,sample_start=excluded.sample_start,sample_end=excluded.sample_end,
    method_version=excluded.method_version,updated_at=now()
  where research_findings.status='candidate'
    and (research_findings.statement is distinct from excluded.statement
      or research_findings.sample_size is distinct from excluded.sample_size
      or research_findings.evidence_ids is distinct from excluded.evidence_ids
      or research_findings.case_ids is distinct from excluded.case_ids
      or research_findings.win_rate is distinct from excluded.win_rate
      or research_findings.mean_pnl is distinct from excluded.mean_pnl
      or research_findings.median_pnl is distinct from excluded.median_pnl
      or research_findings.win_count is distinct from excluded.win_count
      or research_findings.loss_count is distinct from excluded.loss_count
      or research_findings.expired_count is distinct from excluded.expired_count
      or research_findings.sample_start is distinct from excluded.sample_start
      or research_findings.sample_end is distinct from excluded.sample_end);
  get diagnostics v_upserted = row_count;

  return jsonb_build_object(
    'status','ok','candidates_inserted_or_updated',v_upserted,
    'minimum_sample_size',25,'sample_cap_per_group',25,'max_groups',30,
    'confidence_calibrated',false,'validated_findings_created',0
  );
end;
$findings$;

revoke all on function public.refresh_research_candidate_findings() from public, anon, authenticated;
grant execute on function public.refresh_research_candidate_findings() to service_role;
