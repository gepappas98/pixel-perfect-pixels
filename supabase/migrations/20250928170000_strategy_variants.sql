-- ══════════════════════════════════════════════════════════════
-- Strategy Variant Signals (shadow mode)
-- Records what EVERY strategy preset would have recommended,
-- without affecting the actual composite_signals / trades pipeline.
-- Pure observability layer.
-- ══════════════════════════════════════════════════════════════

create table if not exists public.strategy_variant_signals (
  id uuid primary key default gen_random_uuid(),
  strategy_name text not null,
  symbol text not null,
  confidence numeric,
  recommendation text
    check (recommendation in ('buy', 'sell', 'hold', 'watch')),
  reasoning text,
  score numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_variant_signals_strategy_time
  on public.strategy_variant_signals (strategy_name, created_at desc);

create index if not exists idx_variant_signals_symbol_time
  on public.strategy_variant_signals (symbol, created_at desc);

alter table public.strategy_variant_signals enable row level security;

-- ⚠️ No permissive policies: client access blocked, service_role bypasses RLS.
-- This table is written ONLY by the server-side pipeline.

notify pgrst, 'reload schema';
