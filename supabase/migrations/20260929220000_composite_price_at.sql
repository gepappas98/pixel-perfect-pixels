-- Τιμή αγοράς τη στιγμή του signal, για το guard MAX_ENTRY_DRIFT_PCT
-- στο executeTrades(). Χωρίς αυτή τη στήλη το guard δεν ενεργοποιούνταν ποτέ.
-- Ο κώδικας κάνει fallback (γράφει χωρίς price_at) μέχρι να τρέξει αυτό.
ALTER TABLE public.composite_signals
  ADD COLUMN IF NOT EXISTS price_at numeric;

NOTIFY pgrst, 'reload schema';
