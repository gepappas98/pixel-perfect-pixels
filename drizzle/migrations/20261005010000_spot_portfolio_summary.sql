-- ============================================================
-- Trading Command Center
-- Binance Spot / Long-only Portfolio Summary
-- ============================================================

-- Remove legacy signatures if they exist.
DROP FUNCTION IF EXISTS public.get_portfolio_summary();
DROP FUNCTION IF EXISTS public.get_portfolio_summary(integer);
DROP FUNCTION IF EXISTS public.get_portfolio_summary(jsonb);

CREATE OR REPLACE FUNCTION public.get_portfolio_summary(
  p_mark_prices jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  open_count bigint,
  open_entry_notional numeric,
  open_market_value numeric,

  unrealized_gross_pnl numeric,
  unrealized_net_pnl_est numeric,
  estimated_open_exit_fees numeric,

  closed_count bigint,
  realized_gross_pnl numeric,
  realized_net_pnl numeric,
  total_fees numeric,

  win_count bigint,
  loss_count bigint,
  win_rate_pct numeric,

  gross_profit numeric,
  gross_loss numeric,
  profit_factor numeric,

  avg_win_usd numeric,
  avg_loss_usd numeric,

  last_24h_closed bigint,
  last_24h_realized_net_pnl numeric,

  best_trade_net_pnl numeric,
  worst_trade_net_pnl numeric,

  open_symbols text[],
  marked_open_count bigint,
  unmarked_open_count bigint,

  legacy_open_sell_count bigint,
  legacy_closed_sell_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$

WITH spot_closed AS (

  SELECT
    COALESCE(
      t.net_pnl,
      t.gross_pnl,
      t.pnl,
      0
    )::numeric AS net_pnl,

    COALESCE(
      t.gross_pnl,
      t.pnl,
      0
    )::numeric AS gross_pnl,

    COALESCE(
      t.total_fees,
      0
    )::numeric AS fees,

    t.closed_at

  FROM public.trades t

  WHERE t.status = 'closed'

    -- Binance Spot production is LONG ONLY.
    AND LOWER(t.side) = 'buy'
),

closed_agg AS (

  SELECT

    COUNT(*)::bigint
      AS closed_count,

    COALESCE(
      SUM(gross_pnl),
      0
    )::numeric
      AS realized_gross_pnl,

    COALESCE(
      SUM(net_pnl),
      0
    )::numeric
      AS realized_net_pnl,

    COALESCE(
      SUM(fees),
      0
    )::numeric
      AS total_fees,

    COUNT(*)
      FILTER (
        WHERE net_pnl > 0
      )::bigint
      AS win_count,

    COUNT(*)
      FILTER (
        WHERE net_pnl < 0
      )::bigint
      AS loss_count,

    COALESCE(
      SUM(net_pnl)
        FILTER (
          WHERE net_pnl > 0
        ),
      0
    )::numeric
      AS gross_profit,

    COALESCE(
      ABS(
        SUM(net_pnl)
          FILTER (
            WHERE net_pnl < 0
          )
      ),
      0
    )::numeric
      AS gross_loss,

    AVG(net_pnl)
      FILTER (
        WHERE net_pnl > 0
      )::numeric
      AS avg_win_usd,

    AVG(net_pnl)
      FILTER (
        WHERE net_pnl < 0
      )::numeric
      AS avg_loss_raw,

    MAX(net_pnl)::numeric
      AS best_trade_net_pnl,

    MIN(net_pnl)::numeric
      AS worst_trade_net_pnl,

    COUNT(*)
      FILTER (
        WHERE closed_at >= now() - interval '24 hours'
      )::bigint
      AS last_24h_closed,

    COALESCE(
      SUM(net_pnl)
        FILTER (
          WHERE closed_at >= now() - interval '24 hours'
        ),
      0
    )::numeric
      AS last_24h_realized_net_pnl

  FROM spot_closed
),

spot_open AS (

  SELECT

    t.symbol,

    t.quantity::numeric
      AS quantity,

    t.entry_price::numeric
      AS entry_price,

    NULLIF(
      p_mark_prices ->> (
        CASE
          WHEN UPPER(t.symbol) = 'MATIC'
            THEN 'POLUSDT'

          WHEN UPPER(t.symbol) = 'RNDR'
            THEN 'RENDERUSDT'

          ELSE
            UPPER(t.symbol) || 'USDT'
        END
      ),
      ''
    )::numeric
      AS mark_price

  FROM public.trades t

  WHERE t.status = 'open'

    -- Never allow legacy SELL rows to create
    -- negative Spot exposure.
    AND LOWER(t.side) = 'buy'
),

open_agg AS (

  SELECT

    COUNT(*)::bigint
      AS open_count,

    COALESCE(
      SUM(
        entry_price * quantity
      ),
      0
    )::numeric
      AS open_entry_notional,

    COALESCE(
      SUM(
        CASE
          WHEN mark_price > 0
            THEN mark_price * quantity
          ELSE 0
        END
      ),
      0
    )::numeric
      AS open_market_value,

    COALESCE(
      SUM(
        CASE
          WHEN mark_price > 0
            THEN
              (
                mark_price - entry_price
              ) * quantity
          ELSE 0
        END
      ),
      0
    )::numeric
      AS unrealized_gross_pnl,

    COALESCE(
      SUM(
        CASE
          WHEN mark_price > 0
            THEN
              mark_price *
              quantity *
              0.0005
          ELSE 0
        END
      ),
      0
    )::numeric
      AS estimated_open_exit_fees,

    COUNT(*)
      FILTER (
        WHERE mark_price > 0
      )::bigint
      AS marked_open_count,

    COUNT(*)
      FILTER (
        WHERE
          mark_price IS NULL
          OR mark_price <= 0
      )::bigint
      AS unmarked_open_count,

    ARRAY_REMOVE(
      ARRAY_AGG(
        DISTINCT symbol
        ORDER BY symbol
      ),
      NULL
    )::text[]
      AS open_symbols

  FROM spot_open
),

legacy AS (

  SELECT

    COUNT(*)
      FILTER (
        WHERE
          status = 'open'
          AND LOWER(side) = 'sell'
      )::bigint
      AS legacy_open_sell_count,

    COUNT(*)
      FILTER (
        WHERE
          status = 'closed'
          AND LOWER(side) = 'sell'
      )::bigint
      AS legacy_closed_sell_count

  FROM public.trades
)

SELECT

  oa.open_count,

  oa.open_entry_notional,

  oa.open_market_value,

  oa.unrealized_gross_pnl,

  (
    oa.unrealized_gross_pnl
    -
    oa.estimated_open_exit_fees
  )::numeric
    AS unrealized_net_pnl_est,

  oa.estimated_open_exit_fees,

  ca.closed_count,

  ca.realized_gross_pnl,

  ca.realized_net_pnl,

  ca.total_fees,

  ca.win_count,

  ca.loss_count,

  CASE

    WHEN
      ca.win_count + ca.loss_count > 0

    THEN
      ROUND(
        ca.win_count::numeric
        * 100
        /
        (
          ca.win_count
          +
          ca.loss_count
        ),
        2
      )

    ELSE NULL

  END
    AS win_rate_pct,

  ca.gross_profit,

  ca.gross_loss,

  CASE

    WHEN ca.gross_loss > 0

    THEN
      ROUND(
        ca.gross_profit
        /
        ca.gross_loss,
        3
      )

    ELSE NULL

  END
    AS profit_factor,

  ROUND(
    COALESCE(
      ca.avg_win_usd,
      0
    )::numeric,
    2
  )
    AS avg_win_usd,

  CASE

    WHEN ca.avg_loss_raw IS NULL
      THEN NULL

    ELSE
      ROUND(
        ca.avg_loss_raw::numeric,
        2
      )

  END
    AS avg_loss_usd,

  ca.last_24h_closed,

  ca.last_24h_realized_net_pnl,

  ca.best_trade_net_pnl,

  ca.worst_trade_net_pnl,

  oa.open_symbols,

  oa.marked_open_count,

  oa.unmarked_open_count,

  legacy.legacy_open_sell_count,

  legacy.legacy_closed_sell_count

FROM open_agg oa

CROSS JOIN closed_agg ca

CROSS JOIN legacy;

REVOKE ALL
ON FUNCTION public.get_portfolio_summary(jsonb)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.get_portfolio_summary(jsonb)
TO anon,
   authenticated,
   service_role;

NOTIFY pgrst, 'reload schema';
