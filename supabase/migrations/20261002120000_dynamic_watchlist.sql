-- ─────────────────────────────────────────────────────────────────────
-- Dynamic Watchlist Infrastructure
-- ─────────────────────────────────────────────────────────────────────
-- Stores periodic snapshots of the resolved watchlist (up to 150 coins).
-- The pipeline reads the latest non-expired snapshot; if none exists,
-- the resolver computes a fresh one from Hyperliquid + Binance.
--
-- Also adds provenance tags to trades, signals, and alerts so we can
-- answer questions like "how do hl-dynamic coins perform vs core?".
-- ─────────────────────────────────────────────────────────────────────

-- ─── Snapshots ───

CREATE TABLE IF NOT EXISTS dynamic_watchlist_snapshots (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  symbols           text[]      NOT NULL,
  source            text        NOT NULL,           -- 'refreshed' | 'fallback_static'
  hl_candidates     int         NOT NULL DEFAULT 0, -- total coins in HL universe
  hl_above_threshold int        NOT NULL DEFAULT 0, -- coins with volume >= add threshold
  binance_filtered  int         NOT NULL DEFAULT 0, -- HL coins also listed on Binance
  pinned_symbols    text[]      NOT NULL DEFAULT '{}'::text[],
  dynamic_symbols   text[]      NOT NULL DEFAULT '{}'::text[],
  computed_at       timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dynamic_watchlist_expires
  ON dynamic_watchlist_snapshots (expires_at DESC);

-- ─── Provenance tags ───

ALTER TABLE trade_alerts
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS idx_trade_alerts_tags
  ON trade_alerts USING gin (tags);

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS source_tags text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS idx_trades_source_tags
  ON trades USING gin (source_tags);

ALTER TABLE composite_signals
  ADD COLUMN IF NOT EXISTS source_tags text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS idx_composite_signals_source_tags
  ON composite_signals USING gin (source_tags);

ALTER TABLE strategy_variant_signals
  ADD COLUMN IF NOT EXISTS source_tags text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS idx_variant_signals_source_tags
  ON strategy_variant_signals USING gin (source_tags);

-- ─── Documentation ───

COMMENT ON TABLE dynamic_watchlist_snapshots IS
  'Periodic snapshots of the resolved watchlist. Latest non-expired row is authoritative.';

COMMENT ON COLUMN trade_alerts.tags IS
  'Provenance: core | revolutx | hl-dynamic | open-position | always-include';

COMMENT ON COLUMN trades.source_tags IS
  'Provenance at trade open time. Same vocabulary as trade_alerts.tags.';

COMMENT ON COLUMN composite_signals.source_tags IS
  'Provenance for the signal row. Multiple tags possible.';

COMMENT ON COLUMN strategy_variant_signals.source_tags IS
  'Provenance for the shadow variant row.';
