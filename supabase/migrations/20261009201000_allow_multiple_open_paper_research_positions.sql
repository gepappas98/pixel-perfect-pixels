-- Paper mode is the unbounded research environment.
-- Keep the one-open-position-per-symbol safeguard for non-paper modes only.
-- Exact duplicate composite signals remain blocked by application-level idempotency.

DROP INDEX IF EXISTS public.trades_one_open_per_symbol;

CREATE UNIQUE INDEX trades_one_open_per_symbol
  ON public.trades (symbol)
  WHERE status = 'open' AND mode IS DISTINCT FROM 'paper';
