-- Lock down trigger-only SECURITY DEFINER function.
-- It is invoked by PostgreSQL triggers and must not be exposed as an RPC.

REVOKE ALL ON FUNCTION public.classify_whale_flow_transition_on_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.classify_whale_flow_transition_on_insert() FROM anon;
REVOKE ALL ON FUNCTION public.classify_whale_flow_transition_on_insert() FROM authenticated;
