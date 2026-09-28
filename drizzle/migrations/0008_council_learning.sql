create table if not exists public.council_lessons (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  verdict text,
  conviction integer,
  entry_context jsonb,
  outcome text not null,
  realized_pnl numeric,
  pnl_pct numeric,
  lesson text not null,
  source_trade_id uuid,
  created_at timestamptz not null default now()
);
grant select on public.council_lessons to anon, authenticated;
grant all on public.council_lessons to service_role;
create index if not exists idx_council_lessons_symbol_created on public.council_lessons (symbol, created_at desc);
create index if not exists idx_council_lessons_created on public.council_lessons (created_at desc);
create index if not exists idx_council_lessons_outcome on public.council_lessons (outcome, created_at desc);
alter table public.council_lessons enable row level security;
create policy council_lessons_read on public.council_lessons for select to anon, authenticated using (true);
alter table public.trades add column if not exists post_mortem_generated boolean default false;
notify pgrst, 'reload schema';