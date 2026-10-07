-- Tighten execution privileges for Whale Flow history SECURITY DEFINER helpers.
-- These are backend-only helpers invoked by the whale ingestion trigger.
REVOKE EXECUTE ON FUNCTION public.record_whale_flow_snapshot(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whale_flow_snapshot(timestamptz) TO service_role;

REVOKE EXECUTE ON FUNCTION public.capture_whale_flow_history() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_whale_flow_history() TO service_role;
