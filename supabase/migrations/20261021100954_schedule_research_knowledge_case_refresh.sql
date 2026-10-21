-- Refresh only the derived research archive; the source trade and variant rows are read-only here.
-- The function updates research_evidence/research_cases and never changes source outcomes.
SELECT cron.schedule(
  'research-knowledge-case-refresh',
  '*/15 * * * *',
  $$SELECT public.refresh_research_knowledge_cases(72);$$
);
