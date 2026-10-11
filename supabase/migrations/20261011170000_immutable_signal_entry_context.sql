-- Preserve the exact signal-time source context separately from mutable current-state indicator rows.
-- Research-only: no changes to signal scoring, thresholds, risk, or trade execution.
ALTER TABLE public.composite_signals
  ADD COLUMN IF NOT EXISTS entry_context_snapshot jsonb;

COMMENT ON COLUMN public.composite_signals.entry_context_snapshot IS
  'Copied source context at signal evaluation time; indicator_snapshot_id alone is not historical because indicator_snapshots is upserted in place.';

-- A trade context starts as a trigger-created placeholder and is completed by the execution pipeline.
-- Once complete, prohibit silent rewrites so later market updates cannot rewrite entry history.
CREATE OR REPLACE FUNCTION public.prevent_completed_entry_context_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.snapshot->>'capture_status' = 'complete' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Completed entry_context_snapshots are immutable (trade_id=%)', OLD.trade_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_entry_context_snapshot_immutable ON public.entry_context_snapshots;

CREATE TRIGGER trg_entry_context_snapshot_immutable
BEFORE UPDATE ON public.entry_context_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.prevent_completed_entry_context_snapshot_mutation();
