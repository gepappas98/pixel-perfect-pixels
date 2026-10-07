-- ─────────────────────────────────────────────────────────────────────
-- Hot Whale Queue — intra-cycle discovery for coins with fresh whale flow.
--
-- Purpose: capture opportunities between 6h dynamic-watchlist refreshes.
-- A coin enters the hot queue when a whale alert (usd ≥ threshold) is
-- detected for a symbol NOT currently in the active watchlist. It stays
-- hot for HOT_TTL_MINUTES or until a fresh alert refreshes it.
--
-- Includes:
--   - Row Level Security with read/write policies
--   - Explicit GRANTs for anon / authenticated / service_role
--   - RPCs are SECURITY DEFINER to bypass RLS for internal writes
--     (called from server functions with service_role, but hardened)
-- ─────────────────────────────────────────────────────────────────────

-- ─── 1. Table ───

CREATE TABLE IF NOT EXISTS public.hot_whale_signals (
  symbol           text        PRIMARY KEY,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  alert_count      int         NOT NULL DEFAULT 1,
  total_usd        numeric     NOT NULL DEFAULT 0,
  buy_usd          numeric     NOT NULL DEFAULT 0,
  sell_usd         numeric     NOT NULL DEFAULT 0,
  sources          text[]      NOT NULL DEFAULT ARRAY[]::text[],
  tags             text[]      NOT NULL DEFAULT ARRAY['hot-whale']::text[]
);

CREATE INDEX IF NOT EXISTS idx_hot_whale_last_seen
  ON public.hot_whale_signals (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_hot_whale_total_usd
  ON public.hot_whale_signals (total_usd DESC);

-- ─── 2. RLS + Grants ───

ALTER TABLE public.hot_whale_signals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.hot_whale_signals FROM anon, authenticated;
GRANT ALL ON public.hot_whale_signals TO service_role;

-- ─── 3. RPC: record_hot_whale ───

CREATE OR REPLACE FUNCTION public.record_hot_whale(
  p_symbol   text,
  p_usd      numeric,
  p_is_buy   boolean,
  p_source   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.hot_whale_signals (symbol, total_usd, buy_usd, sell_usd, sources)
  VALUES (
    p_symbol,
    p_usd,
    CASE WHEN p_is_buy THEN p_usd ELSE 0 END,
    CASE WHEN p_is_buy THEN 0 ELSE p_usd END,
    ARRAY[p_source]
  )
  ON CONFLICT (symbol) DO UPDATE SET
    last_seen_at = now(),
    alert_count  = hot_whale_signals.alert_count + 1,
    total_usd    = hot_whale_signals.total_usd + p_usd,
    buy_usd      = hot_whale_signals.buy_usd  + CASE WHEN p_is_buy THEN p_usd ELSE 0 END,
    sell_usd     = hot_whale_signals.sell_usd + CASE WHEN p_is_buy THEN 0 ELSE p_usd END,
    sources      = (
      SELECT ARRAY(
        SELECT DISTINCT unnest(hot_whale_signals.sources || p_source)
      )
    );
END;
$$;

-- ─── 4. RPC: get_hot_whale_symbols ───

CREATE OR REPLACE FUNCTION public.get_hot_whale_symbols(
  p_minutes int DEFAULT 30,
  p_limit   int DEFAULT 20
)
RETURNS TABLE (symbol text, total_usd numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT symbol, total_usd
  FROM public.hot_whale_signals
  WHERE last_seen_at > now() - (p_minutes || ' minutes')::interval
  ORDER BY total_usd DESC
  LIMIT p_limit;
$$;

-- ─── 5. RPC: cleanup_hot_whales ───

CREATE OR REPLACE FUNCTION public.cleanup_hot_whales(
  p_older_than_minutes int DEFAULT 120
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted int;
BEGIN
  DELETE FROM public.hot_whale_signals
  WHERE last_seen_at < now() - (p_older_than_minutes || ' minutes')::interval;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- ─── 6. Function-level grants ───

REVOKE ALL ON FUNCTION public.record_hot_whale(text, numeric, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_hot_whale(text, numeric, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.get_hot_whale_symbols(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_hot_whale_symbols(int, int) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_hot_whales(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_hot_whales(int) TO service_role;

-- ─── 7. Schema reload ───

NOTIFY pgrst, 'reload schema';
