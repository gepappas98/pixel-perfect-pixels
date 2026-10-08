-- Align paper research entry-fee accounting with public.trading_fee_rate() (0.05% per side).
-- Existing open paper positions had no recorded entry fee; backfill as an estimate.
ALTER TABLE public.trades
  ALTER COLUMN entry_fee SET DEFAULT 0,
  ALTER COLUMN exit_fee SET DEFAULT 0,
  ALTER COLUMN total_fees SET DEFAULT 0;

UPDATE public.trades
SET entry_fee = round(entry_price * quantity * public.trading_fee_rate(), 8),
    total_fees = round(entry_price * quantity * public.trading_fee_rate(), 8)
WHERE status = 'open'
  AND mode = 'paper'
  AND entry_price IS NOT NULL
  AND quantity IS NOT NULL
  AND coalesce(entry_fee, 0) = 0;

UPDATE public.repeated_buy_research_ledger l
SET entry_fee = t.entry_fee,
    total_fees = t.total_fees,
    metadata = coalesce(l.metadata, '{}'::jsonb) || jsonb_build_object(
      'fee_rate', public.trading_fee_rate(),
      'fee_rate_basis', 'estimated_binance_spot_fee_per_side',
      'fee_backfilled_at', now()
    )
FROM public.trades t
WHERE l.trade_id = t.id
  AND t.status = 'open'
  AND t.mode = 'paper';

COMMENT ON COLUMN public.trades.entry_fee IS 'Estimated/actual entry fee in quote currency; paper fee rate is public.trading_fee_rate() per side.';
COMMENT ON COLUMN public.trades.exit_fee IS 'Estimated/actual exit fee in quote currency; applied when the trade closes.';
COMMENT ON COLUMN public.trades.total_fees IS 'Entry plus exit fees. For open trades, currently records entry fee only; exit fee is added on close.';
