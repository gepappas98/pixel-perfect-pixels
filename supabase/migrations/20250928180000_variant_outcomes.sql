-- ══════════════════════════════════════════════════════════════
-- Variant signal outcomes — track hypothetical TP/SL resolution
-- Allows the VariantComparisonPanel to show real performance:
-- win rate, avg PnL, total PnL per preset.
-- ══════════════════════════════════════════════════════════════

alter table strategy_variant_signals
  add column if not exists entry_price numeric,
  add column if not exists exit_price numeric,
  add column if not exists outcome text
    check (outcome is null or outcome in ('open', 'win', 'loss', 'expired')),
  add column if not exists pnl_pct numeric,
  add column if not exists resolved_at timestamptz;

create index if not exists idx_variant_signals_outcome
  on strategy_variant_signals (outcome, created_at desc);

create index if not exists idx_variant_signals_open_lookup
  on strategy_variant_signals (outcome, created_at desc)
  where outcome = 'open';

notify pgrst, 'reload schema';
