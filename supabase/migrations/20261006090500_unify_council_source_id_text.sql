-- P0 data-plane unification: preserve legacy council source IDs as text.
-- The legacy dashboard database stored source_id as structured text, while the canonical
-- database used uuid. Both represent source identifiers; text preserves the legacy values
-- without lossy casting and keeps the application-level type (string) unchanged.
ALTER TABLE public.council_signals
  ALTER COLUMN source_id TYPE text USING source_id::text;
