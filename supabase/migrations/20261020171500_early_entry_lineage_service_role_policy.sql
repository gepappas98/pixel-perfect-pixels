create policy early_entry_candle_lineage_service_role_only
  on public.early_entry_candle_lineage
  for all
  to service_role
  using (true)
  with check (true);