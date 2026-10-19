-- Research Knowledge Archive foundation (additive only).
-- This migration intentionally does not alter retention jobs or delete historical data.

create table if not exists public.research_knowledge_findings (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique check (length(fingerprint) between 16 and 160),
  title text not null check (length(title) between 1 and 180),
  summary text not null check (length(summary) between 1 and 1500),
  finding_type text not null default 'hypothesis'
    check (finding_type in ('pattern','hypothesis','counterexample','data_quality','strategy_review')),
  status text not null default 'candidate'
    check (status in ('candidate','validated','invalidated','needs_review')),
  cohort text not null default 'mixed'
    check (cohort in ('legacy','v2','v3','paper_trade','event_flow','early_entry','mixed','unknown')),
  scorer_version text,
  sample_size integer not null default 0 check (sample_size >= 0),
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  evidence_coverage numeric(5,4) not null default 0 check (evidence_coverage between 0 and 1),
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  known_at timestamptz not null default now(),
  limitations text not null default '' check (length(limitations) <= 1200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_observed_at is null or first_observed_at is null or last_observed_at >= first_observed_at)
);

create index if not exists research_knowledge_findings_status_updated_idx
  on public.research_knowledge_findings (status, updated_at desc);
create index if not exists research_knowledge_findings_cohort_status_idx
  on public.research_knowledge_findings (cohort, status, sample_size desc);
create index if not exists research_knowledge_findings_observed_idx
  on public.research_knowledge_findings (last_observed_at desc);

create table if not exists public.research_knowledge_evidence (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.research_knowledge_findings(id) on delete cascade,
  source_table text not null check (length(source_table) between 1 and 80),
  source_id text not null check (length(source_id) between 1 and 180),
  evidence_role text not null default 'support'
    check (evidence_role in ('support','counterexample','context','outcome','provenance')),
  source_fingerprint text not null unique check (length(source_fingerprint) between 16 and 200),
  observed_at timestamptz,
  known_at timestamptz,
  snippet text not null default '' check (length(snippet) <= 500),
  created_at timestamptz not null default now(),
  check (known_at is null or observed_at is null or known_at >= observed_at)
);

create index if not exists research_knowledge_evidence_finding_idx
  on public.research_knowledge_evidence (finding_id, evidence_role, observed_at desc);
create index if not exists research_knowledge_evidence_source_idx
  on public.research_knowledge_evidence (source_table, source_id);

alter table public.research_knowledge_findings enable row level security;
alter table public.research_knowledge_evidence enable row level security;

drop policy if exists research_knowledge_findings_read on public.research_knowledge_findings;
create policy research_knowledge_findings_read
  on public.research_knowledge_findings for select to anon, authenticated using (true);

drop policy if exists research_knowledge_evidence_read on public.research_knowledge_evidence;
create policy research_knowledge_evidence_read
  on public.research_knowledge_evidence for select to anon, authenticated using (true);

revoke all on public.research_knowledge_findings from anon, authenticated;
revoke all on public.research_knowledge_evidence from anon, authenticated;
grant select on public.research_knowledge_findings to anon, authenticated;
grant select on public.research_knowledge_evidence to anon, authenticated;
grant all on public.research_knowledge_findings to service_role;
grant all on public.research_knowledge_evidence to service_role;

comment on table public.research_knowledge_findings is
  'Evidence-backed research hypotheses/findings; not a trading signal or execution input.';
comment on table public.research_knowledge_evidence is
  'Bounded provenance links to source records; known_at must not exceed the outcome timestamp for entry-time claims.';
