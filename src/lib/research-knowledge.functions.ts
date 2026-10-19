import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cohortOf, type Evidence, type Finding, type KnowledgeSnapshot, type ResearchCase } from "./research-knowledge";

type Row = Record<string, unknown>;
const text = (r: Row, key: string): string | null => typeof r[key] === "string" ? r[key] as string : null;
const numeric = (r: Row, key: string): number | null => r[key] !== null && r[key] !== undefined && Number.isFinite(Number(r[key])) ? Number(r[key]) : null;
const ids = (r: Row, key: string): string[] => Array.isArray(r[key]) ? (r[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
export async function readKnowledge(db: SupabaseClient, now = new Date().toISOString()): Promise<KnowledgeSnapshot> {
  const issues: string[] = [];
  const counts: Record<string, number | null> = {};
  const read = async (table: string, columns: string, order: string, limit = 250): Promise<Row[]> => {
    try {
      const { data, error, count } = await db.from(table).select(columns, { count: "exact" }).order(order, { ascending: false }).limit(limit).abortSignal(AbortSignal.timeout(12_000));
      if (error) {
        counts[table] = null;
        issues.push(`${table}: unavailable (${error.code ?? "read_error"}); not evidence of an empty table.`);
        return [];
      }
      counts[table] = count;
      return (data ?? []) as unknown as Row[];
    } catch {
      counts[table] = null;
      issues.push(`${table}: read timed out or failed; retry required.`);
      return [];
    }
  };
  const [trades, variants, lessons, evidenceRows, findingRows, storedCases] = await Promise.all([
    read("trades", "id,symbol,side,mode,status,created_at,closed_at,close_reason,net_pnl,regime_label,composite_signal_id", "created_at"),
    read("strategy_variant_signals", "id,strategy_name,symbol,source_fingerprint,created_at,resolved_at,outcome,pnl_pct,regime_label", "created_at"),
    read("council_lessons", "id,symbol,source_trade_id,created_at", "created_at"),
    read("research_evidence", "id,source_table,source_id,observed_at,available_at,captured_at,fingerprint,role,summary", "captured_at", 100),
    read("research_findings", "id,title,statement,status,confidence,cohort,scorer_version,sample_size,evidence_ids,case_ids,checked_at,limitations,reproduction", "checked_at", 100),
    read("research_cases", "id,source_table,source_id,symbol,strategy,cohort,scorer_version,fingerprint,entry_at,resolved_at,maturity_at,outcome,net_pnl,pnl_unit,close_reason,regime,evidence_ids", "entry_at"),
  ]);
  const references = [...new Set(lessons.map(r => text(r, "source_trade_id")).filter((id): id is string => Boolean(id)))];
  const linked = new Set<string>();
  let lookupSucceeded = true;
  // Exact ID lookup: absence from the bounded trade sample does NOT establish an orphan.
  if (references.length) {
    try {
      const result = await db.from("trades").select("id").in("id", references).abortSignal(AbortSignal.timeout(12_000));
      if (result.error) lookupSucceeded = false;
      else for (const r of result.data ?? []) linked.add(String(r.id));
    } catch { lookupSucceeded = false; }
  }
  if (!lookupSucceeded) issues.push("Lesson provenance lookup failed; missing links remain unresolved, not confirmed orphans.");
  const cases: ResearchCase[] = [
    ...trades.map((r): ResearchCase => ({
      id: `trades:${text(r, "id")}`, source_table: "trades", source_id: text(r, "id") ?? "", symbol: text(r, "symbol") ?? "unknown",
      strategy: `${text(r, "mode") ?? "unknown"}/${text(r, "side") ?? "unknown"}`, cohort: "Unknown", scorer_version: "unknown", fingerprint: null,
      entry_at: text(r, "created_at") ?? "", resolved_at: text(r, "closed_at"), maturity_at: null, outcome: text(r, "status") ?? "unknown",
      net_pnl: numeric(r, "net_pnl"), pnl_unit: "USD", close_reason: text(r, "close_reason"), regime: text(r, "regime_label"), evidence_ids: [],
    })),
    ...variants.map((r): ResearchCase => ({
      id: `strategy_variant_signals:${text(r, "id")}`, source_table: "strategy_variant_signals", source_id: text(r, "id") ?? "", symbol: text(r, "symbol") ?? "unknown",
      strategy: text(r, "strategy_name") ?? "unknown", cohort: cohortOf(text(r, "source_fingerprint")), scorer_version: "unknown", fingerprint: text(r, "source_fingerprint"),
      entry_at: text(r, "created_at") ?? "", resolved_at: text(r, "resolved_at"), maturity_at: null, outcome: text(r, "outcome") ?? "unknown",
      net_pnl: numeric(r, "pnl_pct"), pnl_unit: "percent", close_reason: null, regime: text(r, "regime_label"), evidence_ids: [],
    })),
  ];
  // Explicit DTOs only: never send entry_metadata/raw snapshots, wallet identifiers or credentials.
  const evidence = evidenceRows.map(r => ({ id: text(r, "id") ?? "", source_table: text(r, "source_table") ?? "", source_id: text(r, "source_id") ?? "", observed_at: text(r, "observed_at") ?? "", available_at: text(r, "available_at"), captured_at: text(r, "captured_at") ?? "", fingerprint: text(r, "fingerprint") ?? "", role: text(r, "role") as Evidence["role"], summary: (text(r, "summary") ?? "").slice(0, 2000) }));
  const findings = findingRows.map(r => ({ id: text(r, "id") ?? "", title: (text(r, "title") ?? "").slice(0, 200), statement: (text(r, "statement") ?? "").slice(0, 2000), status: text(r, "status") as Finding["status"], confidence: numeric(r, "confidence") ?? 0, cohort: text(r, "cohort") as Finding["cohort"], scorer_version: text(r, "scorer_version") ?? "unknown", sample_size: numeric(r, "sample_size") ?? 0, evidence_ids: ids(r, "evidence_ids"), case_ids: ids(r, "case_ids"), checked_at: text(r, "checked_at") ?? "", limitations: text(r, "limitations") ?? "", reproduction: text(r, "reproduction") ?? "" }));
  for (const r of storedCases) {
    const sourceTable = text(r, "source_table") ?? "";
    const sourceId = text(r, "source_id") ?? "";
    const index = cases.findIndex(c => c.source_table === sourceTable && c.source_id === sourceId);
    // Archived cases override only the equivalent source, never a different cohort/source.
    const c: ResearchCase = { id: text(r, "id") ?? "", source_table: sourceTable, source_id: sourceId, symbol: text(r, "symbol") ?? "unknown", strategy: text(r, "strategy") ?? "unknown", cohort: text(r, "cohort") as ResearchCase["cohort"], scorer_version: text(r, "scorer_version") ?? "unknown", fingerprint: text(r, "fingerprint"), entry_at: text(r, "entry_at") ?? "", resolved_at: text(r, "resolved_at"), maturity_at: text(r, "maturity_at"), outcome: text(r, "outcome") ?? "unknown", net_pnl: numeric(r, "net_pnl"), pnl_unit: text(r, "pnl_unit") === "percent" ? "percent" : "USD", close_reason: text(r, "close_reason"), regime: text(r, "regime"), evidence_ids: ids(r, "evidence_ids") };
    if (index >= 0 && cases[index]?.cohort === c.cohort) cases[index] = c;
    else cases.push(c);
  }
  return { checked_at: now, cases, evidence, findings, counts, issues, archival: "unverified", bounded: Object.entries(counts).some(([table, count]) => count !== null && count > (["research_evidence", "research_findings"].includes(table) ? 100 : 250)), lessons: lessons.map(r => { const sourceId = text(r, "source_trade_id"); return { id: text(r, "id") ?? "", symbol: text(r, "symbol") ?? "unknown", source_trade_id: sourceId, created_at: text(r, "created_at") ?? "", provenance: !sourceId || !lookupSucceeded ? "unresolved" : linked.has(sourceId) ? "linked" : "orphan" }; }) };
}

/** Public read-only endpoint uses the same canonical public configuration as existing views, with RLS. */
export const getResearchKnowledge = createServerFn({ method: "GET" }).handler(async () => {
  const { supabase } = await import("@/integrations/supabase/client");
  // Use a fresh non-session public client. Obtain the existing canonical publishable configuration;
  // never use a service-role client for research dashboard reads.
  const configured = supabase as unknown as { supabaseUrl: string; supabaseKey: string };
  const key = configured.supabaseKey;
  const db = createClient(configured.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (key.startsWith("sb_") && headers.get("Authorization") === `Bearer ${key}`) headers.delete("Authorization");
      headers.set("apikey", key);
      return fetch(input, { ...init, headers });
    } },
  });
  return readKnowledge(db);
});