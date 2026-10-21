-- Preserve the first evaluation timestamp for each composite-signal fingerprint.
-- Historical created_at values are intentionally NOT rewritten; existing snapshots
-- remain the only evidence for recovering timestamps that were overwritten earlier.
ALTER TABLE public.composite_signals
  ADD COLUMN IF NOT EXISTS last_upserted_at timestamptz;

CREATE OR REPLACE FUNCTION public.preserve_composite_signal_initial_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
  ELSE
    NEW.created_at := COALESCE(NEW.created_at, clock_timestamp());
  END IF;
  NEW.last_upserted_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_preserve_composite_signal_initial_timestamp
  ON public.composite_signals;
CREATE TRIGGER trg_preserve_composite_signal_initial_timestamp
BEFORE INSERT OR UPDATE ON public.composite_signals
FOR EACH ROW
EXECUTE FUNCTION public.preserve_composite_signal_initial_timestamp();

-- Remove only exact duplicate B-tree indexes to reduce write amplification on upserts.
DROP INDEX IF EXISTS public.idx_composite_signals_symbol_time;
DROP INDEX IF EXISTS public.idx_indicator_snapshots_symbol_time;
