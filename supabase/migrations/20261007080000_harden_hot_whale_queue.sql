-- P1-C: make the hot-whale queue a canonical internal data-plane object.
-- The collector and council access it with service_role only.

ALTER TABLE public.hot_whale_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hot_whale_select_all" ON public.hot_whale_signals;
DROP POLICY IF EXISTS "hot_whale_insert_authenticated" ON public.hot_whale_signals;
DROP POLICY IF EXISTS "hot_whale_update_authenticated" ON public.hot_whale_signals;
DROP POLICY IF EXISTS "hot_whale_delete_authenticated" ON public.hot_whale_signals;

REVOKE ALL ON TABLE public.hot_whale_signals FROM anon, authenticated;
GRANT ALL ON TABLE public.hot_whale_signals TO service_role;

CREATE OR REPLACE FUNCTION public.record_hot_whale(
  p_symbol text, p_usd numeric, p_is_buy boolean, p_source text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.hot_whale_signals (symbol, total_usd, buy_usd, sell_usd, sources)
  VALUES (
    p_symbol, p_usd,
    CASE WHEN p_is_buy THEN p_usd ELSE 0 END,
    CASE WHEN p_is_buy THEN 0 ELSE p_usd END,
    ARRAY[p_source]
  )
  ON CONFLICT (symbol) DO UPDATE SET
    last_seen_at = now(),
    alert_count = hot_whale_signals.alert_count + 1,
    total_usd = hot_whale_signals.total_usd + p_usd,
    buy_usd = hot_whale_signals.buy_usd + CASE WHEN p_is_buy THEN p_usd ELSE 0 END,
    sell_usd = hot_whale_signals.sell_usd + CASE WHEN p_is_buy THEN 0 ELSE p_usd END,
    sources = (SELECT ARRAY(SELECT DISTINCT unnest(hot_whale_signals.sources || p_source)));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_hot_whale_symbols(
  p_minutes int DEFAULT 30, p_limit int DEFAULT 20
)
RETURNS TABLE (symbol text, total_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT symbol, total_usd
  FROM public.hot_whale_signals
  WHERE last_seen_at > now() - (p_minutes || ' minutes')::interval
  ORDER BY total_usd DESC
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_hot_whales(
  p_older_than_minutes int DEFAULT 120
)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE deleted int;
BEGIN
  DELETE FROM public.hot_whale_signals
  WHERE last_seen_at < now() - (p_older_than_minutes || ' minutes')::interval;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.record_hot_whale(text,numeric,boolean,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_hot_whale_symbols(int,int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_hot_whales(int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_hot_whale(text,numeric,boolean,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_hot_whale_symbols(int,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_hot_whales(int) TO service_role;

NOTIFY pgrst, 'reload schema';
