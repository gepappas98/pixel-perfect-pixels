ALTER TABLE public.composite_signals
  ADD COLUMN IF NOT EXISTS price_at numeric;

NOTIFY pgrst, 'reload schema';
