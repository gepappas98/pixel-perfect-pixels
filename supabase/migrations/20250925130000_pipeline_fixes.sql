-- ══════════════════════════════════════════════════════════════
-- FIX 1: pipeline_runs table — health monitoring
-- Ταιριάζει ΑΚΡΙΒΩΣ με τα columns που ζητάει το getCronHealth:
--   id, status, started_at, completed_at, error_message
-- ══════════════════════════════════════════════════════════════

create table if not exists pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null default 'runFullPipeline',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
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
  error_message text,
  created_at timestamptz not null default now()
);

-- Αν το table υπάρχει ήδη από προηγούμενο migration με λάθος columns,
-- προσθέτουμε τα σωστά χωρίς να σβήσουμε τίποτα.
alter table pipeline_runs
  add column if not exists completed_at timestamptz;

alter table pipeline_runs
  add column if not exists error_message text;

-- Sync legacy finished_at → completed_at (αν υπάρχει παλιό column).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'pipeline_runs' and column_name = 'finished_at'
  ) then
    execute 'update pipeline_runs set completed_at = finished_at where completed_at is null and finished_at is not null';
  end if;
end $$;

create index if not exists idx_pipeline_runs_started_at
  on pipeline_runs (started_at desc);

create index if not exists idx_pipeline_runs_completed_at
  on pipeline_runs (completed_at desc);

create index if not exists idx_pipeline_runs_status_completed
  on pipeline_runs (status, completed_at desc);

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


-- ══════════════════════════════════════════════════════════════
-- FIX 2: pipeline_settings — interval config για το cron health
-- Το getCronHealth διαβάζει interval_minutes από εδώ (id = 1).
-- ══════════════════════════════════════════════════════════════

create table if not exists pipeline_settings (
  id integer primary key default 1,
  interval_minutes integer not null default 5,
  updated_at timestamptz not null default now()
);

-- Seed row id=1 (αν λείπει). Το interval 5 λεπτά σημαίνει stale threshold
-- = max(5*2, 15) = 15 λεπτά — λογικό default.
insert into pipeline_settings (id, interval_minutes)
values (1, 5)
on conflict (id) do nothing;

alter table pipeline_settings enable row level security;

drop policy if exists pipeline_settings_read on pipeline_settings;
create policy pipeline_settings_read on pipeline_settings
  for select using (true);

drop policy if exists pipeline_settings_update on pipeline_settings;
create policy pipeline_settings_update on pipeline_settings
  for update using (true);


-- ══════════════════════════════════════════════════════════════
-- FIX 3: indicator_snapshots — unique (symbol, timeframe)
--   Σταματά το "πάγωμα" των technicals για 4 ώρες. Κάθε pipeline cycle
--   κάνει UPDATE στην ίδια γραμμή (με created_at = now()).
-- ══════════════════════════════════════════════════════════════

-- Καθάρισε duplicates (κρατάει το πιο πρόσφατο ανά symbol+timeframe).
delete from indicator_snapshots a
using indicator_snapshots b
where a.symbol = b.symbol
  and a.timeframe = b.timeframe
  and a.created_at < b.created_at;

alter table indicator_snapshots
  drop constraint if exists indicator_snapshots_symbol_timeframe_created_key;

alter table indicator_snapshots
  drop constraint if exists indicator_snapshots_symbol_timeframe_key;

alter table indicator_snapshots
  add constraint indicator_snapshots_symbol_timeframe_key
  unique (symbol, timeframe);


-- ══════════════════════════════════════════════════════════════
-- FIX 4: (προαιρετικό) — καθάρισε legacy Hegseth rows αν έμειναν
-- ══════════════════════════════════════════════════════════════

update composite_signals
set prediction_snapshot_id = null
where prediction_snapshot_id in (
  select id from prediction_snapshots where question ilike '%hegseth%'
);

delete from prediction_snapshots where question ilike '%hegseth%';
