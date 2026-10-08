create table public.execution_capacity_observations (
  id uuid primary key default gen_random_uuid(),
  pipeline_run_id uuid references public.pipeline_runs(id) on delete set null,
  signal_id uuid references public.composite_signals(id) on delete set null,
  symbol text not null,
  observed_at timestamptz not null default now(),
  candidate_confidence numeric,
  candidate_price numeric,
  candidate_regime text,
  candidate_reasoning text,
  rejection_reason text not null,
  open_position_count integer not null,
  held_positions jsonb not null default '[]'::jsonb,
  candidate_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index execution_capacity_observations_observed_at_idx
  on public.execution_capacity_observations(observed_at desc);

create index execution_capacity_observations_symbol_idx
  on public.execution_capacity_observations(symbol);

create index execution_capacity_observations_signal_idx
  on public.execution_capacity_observations(signal_id);

alter table public.execution_capacity_observations enable row level security;

revoke all on public.execution_capacity_observations from anon, authenticated;
