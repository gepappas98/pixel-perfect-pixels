-- Permit the isolated paper-only Event → Flow strategy to label its trades distinctly.
-- No live execution mode is added or enabled.
alter table public.trades drop constraint if exists trades_entry_source_check;
alter table public.trades add constraint trades_entry_source_check
  check (entry_source = any (array['standard'::text, 'early_entry_regime'::text, 'live_exchange'::text, 'whale_shock'::text, 'event_flow_paper'::text]));
