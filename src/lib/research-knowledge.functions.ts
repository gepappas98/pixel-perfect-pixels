import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cohortOf, entryEvidenceIdsForCase, type Evidence, type Finding, type KnowledgeSnapshot, type ResearchCase } from "./research-knowledge";

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
    read("trades", "id,symbol,side,mode,status,created_at,closed_at,close_reason,pnl,net_pnl,total_fees,entry_price,regime_label,source_tags,market_session,entry_source,composite_signal_id", "created_at"),
    read("strategy_variant_signals", "id,strategy_name,symbol,source_fingerprint,created_at,resolved_at,outcome,pnl_pct,regime_label,confidence,recommendation,score,source_tags,production_regime_label,market_regime_score,asset_trend_regime,asset_volatility_regime", "created_at"),
    read("council_lessons", "id,symbol,source_trade_id,created_at", "created_at"),
    read("research_evidence", "id,source_table,source_id,symbol,observed_at,available_at,captured_at,fingerprint,role,summary", "captured_at", 100),
    read("research_findings", "id,title,statement,status,confidence,cohort,scorer_version,sample_size,evidence_ids,case_ids,checked_at,limitations,reproduction", "checked_at", 100),
    read("research_cases", "id,source_table,source_id,symbol,strategy,cohort,scorer_version,fingerprint,entry_at,resolved_at,maturity_at,outcome,net_pnl,pnl_unit,close_reason,regime,evidence_ids", "entry_at"),
  ]);
  const tradeSignalIds = [...new Set(trades.map(r => text(r, "composite_signal_id")).filter((id): id is string => Boolean(id)))];
  let signalRows: Row[] = [];
  if (tradeSignalIds.length) {
    try {
      const { data, error } = await db.from("composite_signals")
        .select("id,symbol,created_at,confidence,recommendation,regime_label,source_tags")
        .in("id", tradeSignalIds)
        .abortSignal(AbortSignal.timeout(12_000));
      if (error) issues.push("composite_signals: entry evidence unavailable (" + (error.code ?? "read_error") + ").");
      else signalRows = (data ?? []) as unknown as Row[];
    } catch {
      issues.push("composite_signals: entry evidence lookup timed out or failed.");
    }
  }
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
  let cases: ResearchCase[] = [
    ...trades.map((r): ResearchCase => ({
      id: `trades:${text(r, "id")}`, source_table: "trades", source_id: text(r, "id") ?? "", symbol: text(r, "symbol") ?? "unknown",
      strategy: `${text(r, "entry_source") ?? text(r, "mode") ?? "unknown"}/${text(r, "side") ?? "unknown"}`, cohort: "Unknown", scorer_version: "paper-trade", fingerprint: null,
      entry_at: text(r, "created_at") ?? "", resolved_at: text(r, "closed_at"), maturity_at: null, outcome: text(r, "status") ?? "unknown",
      net_pnl: numeric(r, "net_pnl") ?? numeric(r, "pnl"), pnl_unit: "USD", close_reason: text(r, "close_reason"), regime: text(r, "regime_label"), evidence_ids: [],
    })),
    ...variants.map((r): ResearchCase => ({
      id: `strategy_variant_signals:${text(r, "id")}`, source_table: "strategy_variant_signals", source_id: text(r, "id") ?? "", symbol: text(r, "symbol") ?? "unknown",
      strategy: text(r, "strategy_name") ?? "unknown", cohort: cohortOf(text(r, "source_fingerprint")), scorer_version: cohortOf(text(r, "source_fingerprint")) === "V3" ? "v3-mtf-aligned" : cohortOf(text(r, "source_fingerprint")) === "V2" ? "v2" : "unknown", fingerprint: text(r, "source_fingerprint"),
      entry_at: text(r, "created_at") ?? "", resolved_at: text(r, "resolved_at"), maturity_at: ["win", "loss", "expired"].includes((text(r, "outcome") ?? "").toLowerCase()) ? text(r, "resolved_at") : null, outcome: text(r, "outcome") ?? "unknown",
      net_pnl: numeric(r, "pnl_pct"), pnl_unit: "percent", close_reason: null, regime: text(r, "regime_label"), evidence_ids: [],
    })),
  ];
  // Explicit DTOs only: never send entry_metadata/raw snapshots, wallet identifiers or credentials.
  const archivedEvidence: Evidence[] = evidenceRows.map(r => ({
    id: text(r, "id") ?? "",
    source_table: text(r, "source_table") ?? "",
    source_id: text(r, "source_id") ?? "",
    symbol: text(r, "symbol"),
    observed_at: text(r, "observed_at") ?? "",
    available_at: text(r, "available_at"),
    captured_at: text(r, "captured_at") ?? "",
    fingerprint: text(r, "fingerprint") ?? "",
    role: text(r, "role") as Evidence["role"],
    summary: (text(r, "summary") ?? "").slice(0, 2000),
  }));
  const tradeEvidence: Evidence[] = trades.map(r => {
    const id = text(r, "id") ?? "";
    const observedAt = text(r, "created_at") ?? "";
    return {
      id: "trades:" + id,
      source_table: "trades",
      source_id: id,
      symbol: text(r, "symbol"),
      observed_at: observedAt,
      available_at: observedAt,
      captured_at: observedAt,
      fingerprint: "trades:" + id + ":" + observedAt,
      role: "entry_context",
      summary: [
        "entry_source=" + (text(r, "entry_source") ?? text(r, "mode") ?? "unknown"),
        "side=" + (text(r, "side") ?? "unknown"),
        "entry_price=" + (text(r, "entry_price") ?? "unknown"),
        "regime=" + (text(r, "regime_label") ?? "unknown"),
        "market_session=" + (text(r, "market_session") ?? "unknown"),
        "tags=" + ids(r, "source_tags").join(","),
      ].join(" ").slice(0, 2000),
    };
  });
  const signalEvidence: Evidence[] = signalRows.map(r => {
    const id = text(r, "id") ?? "";
    const observedAt = text(r, "created_at") ?? "";
    return {
      id: "composite_signals:" + id,
      source_table: "composite_signals",
      source_id: id,
      symbol: text(r, "symbol"),
      observed_at: observedAt,
      available_at: observedAt,
      captured_at: observedAt,
      fingerprint: "composite_signals:" + id + ":" + observedAt,
      role: "entry_context",
      summary: [
        "recommendation=" + (text(r, "recommendation") ?? "unknown"),
        "confidence=" + (text(r, "confidence") ?? "unknown"),
        "regime=" + (text(r, "regime_label") ?? "unknown"),
        "tags=" + ids(r, "source_tags").join(","),
      ].join(" "),
    };
  });
  const variantEvidence: Evidence[] = variants.map(r => {
    const id = text(r, "id") ?? "";
    const observedAt = text(r, "created_at") ?? "";
    return {
      id: "strategy_variant_signals:" + id,
      source_table: "strategy_variant_signals",
      source_id: id,
      symbol: text(r, "symbol"),
      observed_at: observedAt,
      available_at: observedAt,
      captured_at: observedAt,
      fingerprint: "strategy_variant_signals:" + id + ":" + (text(r, "source_fingerprint") ?? "unknown"),
      role: "entry_context",
      summary: [
        "strategy=" + (text(r, "strategy_name") ?? "unknown"),
        "score=" + (text(r, "score") ?? "unknown"),
        "confidence=" + (text(r, "confidence") ?? "unknown"),
        "recommendation=" + (text(r, "recommendation") ?? "unknown"),
        "regime=" + (text(r, "regime_label") ?? "unknown"),
        "production_regime=" + (text(r, "production_regime_label") ?? "unknown"),
        "market_regime_score=" + (text(r, "market_regime_score") ?? "unknown"),
        "asset_trend=" + (text(r, "asset_trend_regime") ?? "unknown"),
        "asset_volatility=" + (text(r, "asset_volatility_regime") ?? "unknown"),
        "tags=" + ids(r, "source_tags").join(","),
      ].join(" ").slice(0, 2000),
    };
  });
  const evidence: Evidence[] = [...archivedEvidence, ...tradeEvidence, ...signalEvidence, ...variantEvidence];

  cases = cases.map(c => {
    const trade = c.source_table === "trades" ? trades.find(r => text(r, "id") === c.source_id) : undefined;
    const linkedSignalId = trade ? text(trade, "composite_signal_id") : null;
    const evidenceIds = entryEvidenceIdsForCase(c, evidence, linkedSignalId);
    return { ...c, evidence_ids: [...new Set([...c.evidence_ids, ...evidenceIds])] };
  });
  const findings = findingRows.map(r => ({ id: text(r, "id") ?? "", title: (text(r, "title") ?? "").slice(0, 200), statement: (text(r, "statement") ?? "").slice(0, 2000), status: text(r, "status") as Finding["status"], confidence: numeric(r, "confidence") ?? 0, cohort: text(r, "cohort") as Finding["cohort"], scorer_version: text(r, "scorer_version") ?? "unknown", sample_size: numeric(r, "sample_size") ?? 0, evidence_ids: ids(r, "evidence_ids"), case_ids: ids(r, "case_ids"), checked_at: text(r, "checked_at") ?? "", limitations: text(r, "limitations") ?? "", reproduction: text(r, "reproduction") ?? "" }));
  let archival: KnowledgeSnapshot["archival"] = "migration_pending";
  let archive_status: KnowledgeSnapshot["archive_status"] = null;
  try {
    const statusDb = db as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => {
        abortSignal: (signal: AbortSignal) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
      };
    };
    const statusResult = await statusDb.rpc("get_research_archive_status", { p_raw_hours: 72, p_derived_hours: 168 })
      .abortSignal(AbortSignal.timeout(8_000));
    if (statusResult.error) {
      const code = statusResult.error.code ?? "unknown";
      const missingFunction = /PGRST202|42883|does not exist|schema cache|could not find the function/i.test(code + " " + statusResult.error.message);
      archival = missingFunction ? "migration_pending" : "error";
      issues.push(missingFunction
        ? "Retention archive status function is not installed; archival readiness remains unverified."
        : "Retention archive status query failed; archival readiness remains unverified.");
    } else if (statusResult.data && typeof statusResult.data === "object") {
      const raw = statusResult.data as Record<string, unknown>;
      const status = raw.status;
      archival = status === "ready" || status === "incomplete" ? status : "unverified";
      const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
      const byTableRaw = raw.by_table && typeof raw.by_table === "object" ? raw.by_table as Record<string, unknown> : {};
      const by_table = Object.fromEntries(Object.entries(byTableRaw).map(([key, value]) => {
        const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
        return [key, { eligible: number(row.eligible), archived: number(row.archived), missing: number(row.missing) }];
      }));
      archive_status = {
        eligible_sources: number(raw.eligible_sources),
        archived_sources: number(raw.archived_sources),
        missing_sources: number(raw.missing_sources),
        last_archive_at: typeof raw.last_archive_at === "string" ? raw.last_archive_at : null,
        raw_cutoff: typeof raw.raw_cutoff === "string" ? raw.raw_cutoff : "",
        derived_cutoff: typeof raw.derived_cutoff === "string" ? raw.derived_cutoff : "",
        by_table,
      };
    } else {
      archival = "error";
      issues.push("Retention archive status returned no usable data.");
    }
  } catch {
    archival = "error";
    issues.push("Retention archive status timed out or failed; readiness is not assumed.");
  }

  for (const r of storedCases) {
    const sourceTable = text(r, "source_table") ?? "";
    const sourceId = text(r, "source_id") ?? "";
    const index = cases.findIndex(c => c.source_table === sourceTable && c.source_id === sourceId);
    // Archived cases override only the equivalent source, never a different cohort/source.
    const c: ResearchCase = { id: text(r, "id") ?? "", source_table: sourceTable, source_id: sourceId, symbol: text(r, "symbol") ?? "unknown", strategy: text(r, "strategy") ?? "unknown", cohort: text(r, "cohort") as ResearchCase["cohort"], scorer_version: text(r, "scorer_version") ?? "unknown", fingerprint: text(r, "fingerprint"), entry_at: text(r, "entry_at") ?? "", resolved_at: text(r, "resolved_at"), maturity_at: text(r, "maturity_at"), outcome: text(r, "outcome") ?? "unknown", net_pnl: numeric(r, "net_pnl"), pnl_unit: text(r, "pnl_unit") === "percent" ? "percent" : "USD", close_reason: text(r, "close_reason"), regime: text(r, "regime"), evidence_ids: ids(r, "evidence_ids") };
    if (index >= 0 && cases[index]?.cohort === c.cohort) {
      const current = cases[index]!;
      cases[index] = { ...current, ...c, evidence_ids: [...new Set([...current.evidence_ids, ...c.evidence_ids])] };
    } else cases.push(c);
  }
  return { checked_at: now, cases, evidence, findings, counts, issues, archival, archive_status, bounded: Object.entries(counts).some(([table, count]) => count !== null && count > (["research_evidence", "research_findings"].includes(table) ? 100 : 250)), lessons: lessons.map(r => { const sourceId = text(r, "source_trade_id"); return { id: text(r, "id") ?? "", symbol: text(r, "symbol") ?? "unknown", source_trade_id: sourceId, created_at: text(r, "created_at") ?? "", provenance: !sourceId || !lookupSucceeded ? "unresolved" : linked.has(sourceId) ? "linked" : "orphan" }; }) };
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