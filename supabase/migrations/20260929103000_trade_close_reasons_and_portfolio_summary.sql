/*
  Trade Close Reasons + Portfolio Summary
  ---------------------------------------
  1. Allow all supported close reasons on trades.
  2. Allow corresponding event types on trade_alerts.
  3. Rebuild get_portfolio_summary() so all legitimate closed
     trades are included while duplicate_cleanup is excluded.

  Supported trade close reasons:
    - stop_loss
    - take_profit
    - manual
    - stale_exit
    - expired
    - rotated_out
    - duplicate_cleanup

  duplicate_cleanup is intentionally excluded from realized
  portfolio performance statistics.
*/

BEGIN;

-- ============================================================
-- 1. trades.close_reason
-- ============================================================

ALTER TABLE public.trades
  DROP CONSTRAINT IF EXISTS trades_close_reason_check;

ALTER TABLE public.trades
  ADD CONSTRAINT trades_close_reason_check
  CHECK (
    close_reason IS NULL
    OR close_reason IN (
      'stop_loss',
      'take_profit',
      'manual',
      'stale_exit',
      'expired',
      'rotated_out',
      'duplicate_cleanup'
    )
  );


-- ============================================================
-- 2. trade_alerts.event_type
-- ============================================================

ALTER TABLE public.trade_alerts
  DROP CONSTRAINT IF EXISTS trade_alerts_event_type_check;

ALTER TABLE public.trade_alerts
  ADD CONSTRAINT trade_alerts_event_type_check
  CHECK (
    event_type IN (
      'stop_loss',
      'take_profit',
      'manual',
      'stale_exit',
      'expired',
      'rotated_out'
    )
  );


-- ============================================================
-- 3. Portfolio summary RPC
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_portfolio_summary()
RETURNS TABLE (
  open_count bigint,
  open_notional numeric,
  closed_count bigint,
  realized_pnl numeric,
  win_rate_pct numeric,
  win_count bigint,
  loss_count bigint,
  gross_profit numeric,
  gross_loss numeric,
  profit_factor numeric,
  avg_win_usd numeric,
  avg_loss_usd numeric,
  last_24h_closed bigint,
  last_24h_pnl numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$

  WITH open_stats AS (
    SELECT
      COUNT(*) AS open_count,
      COALESCE(
        SUM(entry_price * quantity),
        0
      ) AS open_notional
    FROM public.trades
    WHERE status = 'open'
  ),

  closed_stats AS (
    SELECT
      COUNT(*) AS closed_count,

      COALESCE(
        SUM(pnl),
        0
      ) AS realized_pnl,

      COUNT(*) FILTER (
        WHERE pnl > 0
      ) AS win_count,

      COUNT(*) FILTER (
        WHERE pnl < 0
      ) AS loss_count,

      COALESCE(
        SUM(pnl) FILTER (
          WHERE pnl > 0
        ),
        0
      ) AS gross_profit,

      COALESCE(
        ABS(
          SUM(pnl) FILTER (
            WHERE pnl < 0
          )
        ),
        0
      ) AS gross_loss,

      COALESCE(
        AVG(pnl) FILTER (
          WHERE pnl > 0
        ),
        0
      ) AS avg_win,

      COALESCE(
        AVG(pnl) FILTER (
          WHERE pnl < 0
        ),
        0
      ) AS avg_loss

    FROM public.trades
    WHERE status = 'closed'
      AND (
        close_reason IS NULL
        OR close_reason <> 'duplicate_cleanup'
      )
  ),

  recent AS (
    SELECT
      COUNT(*) AS last_24h_closed,

      COALESCE(
        SUM(pnl),
        0
      ) AS last_24h_pnl

    FROM public.trades
    WHERE status = 'closed'
      AND closed_at >= now() - INTERVAL '24 hours'
      AND (
        close_reason IS NULL
        OR close_reason <> 'duplicate_cleanup'
      )
  )

  SELECT
    os.open_count,

    os.open_notional,

    cs.closed_count,

    cs.realized_pnl,

    CASE
      WHEN cs.closed_count > 0
      THEN ROUND(
        (
          cs.win_count::numeric
          / cs.closed_count::numeric
        ) * 100,
        2
      )
      ELSE 0
    END AS win_rate_pct,

    cs.win_count,

    cs.loss_count,

    cs.gross_profit,

    cs.gross_loss,

    CASE
      WHEN cs.gross_loss > 0
      THEN ROUND(
        (
          cs.gross_profit
          / cs.gross_loss
        )::numeric,
        2
      )
      ELSE NULL
    END AS profit_factor,

    ROUND(
      cs.avg_win::numeric,
      2
    ) AS avg_win_usd,

    ROUND(
      cs.avg_loss::numeric,
      2
    ) AS avg_loss_usd,

    r.last_24h_closed,

    r.last_24h_pnl

  FROM open_stats os
  CROSS JOIN closed_stats cs
  CROSS JOIN recent r;

$$;


-- ============================================================
-- 4. Permissions
-- ============================================================

GRANT EXECUTE
ON FUNCTION public.get_portfolio_summary()
TO anon, authenticated, service_role;


-- ============================================================
-- 5. Documentation
-- ============================================================

COMMENT ON FUNCTION public.get_portfolio_summary()
IS
'Returns Trading Command Center portfolio statistics. Includes all legitimate closed trades and excludes duplicate_cleanup trades from performance metrics.';


COMMIT;
