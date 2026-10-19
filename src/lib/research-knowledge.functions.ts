import { createServerFn } from "@tanstack/react-start";

type CountResult = { count: number | null; error: string | null };

async function safeCount(table: string, configure?: (query: any) => any): Promise<CountResult> {
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    let query = (supabase.from as any)(table).select("*", { count: "exact", head: true });
    if (configure) query = configure(query);
    const { count, error } = await query;
    if (error) return { count: null, error: error.message };
    return { count: count ?? 0, error: null };
  } catch (error) {
    return { count: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function isMissingRelation(message: string | null) {
  return !!message && /schema cache|does not exist|could not find the table|relation .* not found|42P01/i.test(message);
}

export const getResearchKnowledgeOverview = createServerFn({ method: "GET" }).handler(async () => {
  const { supabase } = await import("@/integrations/supabase/client");

  const [trades, lessons, v3All, v3Open, v3Resolved, earlyEntry, whaleContext, eventFlow, findings, evidence] = await Promise.all([
    safeCount("trades"),
    safeCount("council_lessons"),
    safeCount("strategy_variant_signals", (q) => q.like("source_fingerprint", "v3|%")),
    safeCount("strategy_variant_signals", (q) => q.like("source_fingerprint", "v3|%").eq("outcome", "open")),
    safeCount("strategy_variant_signals", (q) => q.like("source_fingerprint", "v3|%").in("outcome", ["win", "loss", "expired"])),
    safeCount("early_entry_variant_decisions"),
    safeCount("whale_flow_transition_context"),
    safeCount("event_flow_paper_decisions"),
    safeCount("research_knowledge_findings"),
    safeCount("research_knowledge_evidence"),
  ]);

  let orphanLessons: number | null = null;
  let provenanceError: string | null = null;
  try {
    const [{ data: lessonRows, error: lessonError }, { data: tradeRows, error: tradeError }] = await Promise.all([
      (supabase.from as any)("council_lessons").select("source_trade_id"),
      (supabase.from as any)("trades").select("id"),
    ]);
    if (lessonError || tradeError) throw new Error(lessonError?.message ?? tradeError?.message ?? "provenance query failed");
    const tradeIds = new Set((tradeRows ?? []).map((row: { id: string }) => row.id));
    orphanLessons = (lessonRows ?? []).filter((row: { source_trade_id: string | null }) => !row.source_trade_id || !tradeIds.has(row.source_trade_id)).length;
  } catch (error) {
    provenanceError = error instanceof Error ? error.message : String(error);
  }

  let recentFindings: Array<Record<string, unknown>> = [];
  let findingsError: string | null = null;
  try {
    const { data, error } = await (supabase.from as any)("research_knowledge_findings")
      .select("id,title,summary,finding_type,status,cohort,scorer_version,sample_size,confidence,evidence_coverage,limitations,updated_at")
      .order("updated_at", { ascending: false })
      .limit(8);
    if (error) throw new Error(error.message);
    recentFindings = (data ?? []) as Array<Record<string, unknown>>;
  } catch (error) {
    findingsError = error instanceof Error ? error.message : String(error);
  }

  const archiveUnavailable = isMissingRelation(findings.error) || isMissingRelation(evidence.error) || isMissingRelation(findingsError);
  const sourceErrors = [trades, lessons, v3All, v3Open, v3Resolved, earlyEntry, whaleContext, eventFlow]
    .filter((x) => x.error)
    .map((x) => x.error as string);

  return {
    generatedAt: new Date().toISOString(),
    archiveStatus: archiveUnavailable ? "migration_pending" : findings.error || evidence.error ? "unavailable" : "ready",
    metrics: {
      trades: trades.count,
      councilLessons: lessons.count,
      orphanLessons,
      v3Observations: v3All.count,
      v3Open: v3Open.count,
      v3Resolved: v3Resolved.count,
      earlyEntryDecisions: earlyEntry.count,
      whaleTransitionContexts: whaleContext.count,
      eventFlowLatestStates: eventFlow.count,
      findings: findings.count,
      evidence: evidence.count,
    },
    recentFindings,
    errors: {
      source: sourceErrors.slice(0, 4),
      provenance: provenanceError,
      findings: findingsError,
      archive: archiveUnavailable ? "Research Knowledge migration has not been applied yet." : findings.error || evidence.error,
    },
  };
});
