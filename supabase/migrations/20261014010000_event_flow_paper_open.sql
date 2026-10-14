create table if not exists public.event_flow_paper_decisions (
  asset text primary key references public.tracked_assets(asset) on delete cascade,
  observed_at timestamptz not null default now(),
  status text not null check (status in ('WAITING_DATA','NOT_CONFIRMED','ALREADY_OPEN','COOLDOWN','OPEN_FAILED','OPENED')),
  reason text not null,
  sentiment_score numeric,
  sentiment_confidence numeric,
  flow_score numeric,
  flow_state text,
  price numeric,
  updated_at timestamptz not null default now()
);
create index if not exists idx_event_flow_paper_decisions_observed on public.event_flow_paper_decisions(observed_at desc);
alter table public.event_flow_paper_decisions enable row level security;
drop policy if exists event_flow_paper_decisions_read on public.event_flow_paper_decisions;
create policy event_flow_paper_decisions_read on public.event_flow_paper_decisions for select to anon, authenticated using (true);
grant select on public.event_flow_paper_decisions to anon, authenticated;
