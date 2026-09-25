-- ──────────────────────────────────────────────────────────────
-- FIX 1: pipeline_runs table — health monitoring για το CronHealthPanel
-- ──────────────────────────────────────────────────────────────
create table if not exists pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null default 'runFullPipeline',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  status text not null default 'running'
    check (status in ('running', 'success', 'error')),
  whales integer default 0,
  indicators integer default 0,
  predictions integer default 0,
  council integer default 0,
  signals integer default 0,
  trades integer default 0,
  mode text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pipeline_runs_started_at
  on pipeline_runs (started_at desc);

create index if not exists idx_pipeline_runs_status_started
  on pipeline_runs (status, started_at desc);

alter table pipeline_runs enable row level security;

drop policy if exists pipeline_runs_read on pipeline_runs;
create policy pipeline_runs_read on pipeline_runs
  for select using (true);

drop policy if exists pipeline_runs_insert on pipeline_runs;
create policy pipeline_runs_insert on pipeline_runs
  for insert with check (true);

drop policy if exists pipeline_runs_update on pipeline_runs;
create policy pipeline_runs_update on pipeline_runs
  for update using (true);


-- ──────────────────────────────────────────────────────────────
-- FIX 2: indicator_snapshots — unique (symbol, timeframe)
--   Αυτό σταματά το "πάγωμα" των technicals για 4 ώρες. Κάθε
--   pipeline cycle κάνει UPDATE στην ίδια γραμμή αντί για INSERT
--   με νέο created_at (το οποίο δεν συγκρούεται ποτέ).
-- ──────────────────────────────────────────────────────────────

-- Καθάρισε τυχόν duplicates (κρατάει το πιο πρόσφατο ανά symbol+timeframe)
delete from indicator_snapshots a
using indicator_snapshots b
where a.symbol = b.symbol
  and a.timeframe = b.timeframe
  and a.created_at < b.created_at;

-- Drop παλιό constraint αν υπάρχει
alter table indicator_snapshots
  drop constraint if exists indicator_snapshots_symbol_timeframe_created_key;

-- Πρόσθεσε νέο unique constraint στο (symbol, timeframe)
alter table indicator_snapshots
  drop constraint if exists indicator_snapshots_symbol_timeframe_key;

alter table indicator_snapshots
  add constraint indicator_snapshots_symbol_timeframe_key
  unique (symbol, timeframe);


-- ──────────────────────────────────────────────────────────────
-- FIX 3: (προαιρετικό) — καθάρισε legacy Hegseth rows αν έμειναν
-- ──────────────────────────────────────────────────────────────
update composite_signals
set prediction_snapshot_id = null
where prediction_snapshot_id in (
  select id from prediction_snapshots where question ilike '%hegseth%'
);

delete from prediction_snapshots where question ilike '%hegseth%';
