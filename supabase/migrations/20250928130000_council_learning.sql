-- ══════════════════════════════════════════════════════════════
-- AI Council Learning — Post-mortem lessons από κλειστά trades
-- ══════════════════════════════════════════════════════════════

create table if not exists council_lessons (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  verdict text,                          -- BUY/SELL/HOLD/AVOID του αρχικού council
  conviction integer,
  entry_context jsonb,                   -- reasoning, side, entry/exit prices, close_reason
  outcome text not null,                 -- win / loss / breakeven
  realized_pnl numeric,
  pnl_pct numeric,
  lesson text not null,                  -- AI-generated "τι έμαθα"
  source_trade_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_council_lessons_symbol_created
  on council_lessons (symbol, created_at desc);

create index if not exists idx_council_lessons_created
  on council_lessons (created_at desc);

create index if not exists idx_council_lessons_outcome
  on council_lessons (outcome, created_at desc);

alter table council_lessons enable row level security;

drop policy if exists council_lessons_read on council_lessons;
create policy council_lessons_read on council_lessons
  for select using (true);

drop policy if exists council_lessons_insert on council_lessons;
create policy council_lessons_insert on council_lessons
  for insert with check (true);

-- Flag για να μην ξανα-παράγουμε post-mortem για το ίδιο trade
alter table trades
  add column if not exists post_mortem_generated boolean default false;

notify pgrst, 'reload schema';
