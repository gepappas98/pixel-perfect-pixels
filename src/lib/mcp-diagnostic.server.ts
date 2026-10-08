/**
 * READ-ONLY MCP diagnostic server (JSON-RPC 2.0 over HTTP, MCP "streamable HTTP"
 * JSON response mode). Server-only: uses the existing server-side admin client,
 * but every DB access goes through `readOnlyDb`, which only exposes SELECT and
 * a whitelist of read-only RPCs. No inserts/updates/deletes/DDL/trading.
 */

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const EXECUTION_CONFIDENCE_THRESHOLD = 0.6;

// The Lovable Cloud binding is currently a different Supabase project than the
// canonical production database. The diagnostic tunnel must never silently read
// that foreign database, so it uses the same canonical read-only publishable
// client already used by the browser client.
export const CANONICAL_SUPABASE_URL = "https://yckewtpfttvwiptmmrfq.supabase.co";
export const CANONICAL_SUPABASE_PROJECT_REF = "yckewtpfttvwiptmmrfq";
export const CANONICAL_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_v0BSD7Eg6ze85nuYPRMJ6w_M_lwwXjx";
export const READ_ONLY_TABLES = [
  "pipeline_runs",
  "composite_signals",
  "trades",
  "strategy_variant_signals",
  "strategy_config",
  "trade_alerts",
  "asset_price_snapshots",
] as const;
export const READ_ONLY_RPCS = ["get_portfolio_summary", "get_variant_performance"] as const;

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = { from: (t: string) => any; rpc: (fn: string, args?: Row) => any };

/**
 * Read-only diagnostic client pinned to the canonical production Supabase.
 * Uses a publishable key only; the MCP layer exposes SELECT + whitelisted RPCs
 * and has no mutation methods. This deliberately bypasses Lovable Cloud's
 * separate server-side Supabase binding so diagnostics inspect the same DB as
 * the production browser client and Edge Functions.
 */
export function createCanonicalDiagnosticClient(): AnyClient {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
  return createClient(CANONICAL_SUPABASE_URL, CANONICAL_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as AnyClient;
}

/* ───────────── Read-only guard ───────────── */

export function readOnlyDb(client: AnyClient) {
  return {
    select(table: string, columns = "*") {
      if (!(READ_ONLY_TABLES as readonly string[]).includes(table)) {
        throw new Error(`read_only_guard: table '${table}' not allowed`);
      }
      // Only the select() builder is ever returned → no mutation methods reachable.
      return client.from(table).select(columns);
    },
    rpc(fn: string, args: Row = {}) {
      if (!(READ_ONLY_RPCS as readonly string[]).includes(fn)) {
        throw new Error(`read_only_guard: rpc '${fn}' not allowed`);
      }
      return client.rpc(fn, args);
    },
  };
}
export type ReadOnlyDb = ReturnType<typeof readOnlyDb>;

/* ───────────── Auth ───────────── */

export function verifyBearer(header: string | null, expected: string | undefined): boolean {
  if (!expected || expected.length < 16) return false;
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/* ───────────── Helpers ───────────── */

const clampInt = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.floor(Number(v ?? def));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const clampNum = (v: unknown, def: number, min: number, max: number) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const str = (v: unknown, max = 64) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
const sinceIso = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export function sourceMetadata() {
  const configuredUrl = process.env["SUPABASE_URL"] ?? null;
  const configuredRef =
    process.env["SUPABASE_PROJECT_ID"] ?? (configuredUrl ? new URL(configuredUrl).hostname.split(".")[0] : null);
  return {
    app: "Trading Command Center (Pixel Perfect Pixels)",
    lovable_project_id: "6d1cd604-982a-4237-98b3-1276c19ca6f7",
    supabase_url: CANONICAL_SUPABASE_URL,
    supabase_project_ref: CANONICAL_SUPABASE_PROJECT_REF,
    server_binding_project_ref: configuredRef,
    canonical_backend: true,
    read_only: true,
    generated_at: new Date().toISOString(),
  };
}

/* ───────────── Tool implementations ───────────── */

export async function getPipelineRuns(db: ReadOnlyDb, a: Row) {
  const limit = clampInt(a.limit, 20, 1, 200);
  let q = db
    .select(
      "pipeline_runs",
      "id,started_at,completed_at,status,duration_ms,mode,job_name,indicators,predictions,council,signals,trades,error_message,ai_status,ai_error",
    )
    .order("started_at", { ascending: false })
    .limit(limit);
  const runId = str(a.run_id);
  if (runId) q = q.eq("id", runId);
  const { data, error } = await q;
  const runs = (data ?? []) as Row[];
  return {
    runs,
    errors: runs.filter((r) => r.status === "error" || r.error_message),
    query_error: error?.message ?? null,
  };
}

async function loadAudits(db: ReadOnlyDb, windowMin: number, runId?: string) {
  let q = db
    .select("pipeline_runs", "id,started_at,status,result")
    .order("started_at", { ascending: false })
    .limit(500);
  q = runId ? q.eq("id", runId) : q.gte("started_at", sinceIso(windowMin));
  const { data, error } = await q;
  const runs = (data ?? []) as Row[];
  const audits = runs
    .map((run) => {
      const result = run.result && typeof run.result === "object"
        ? (run.result as Row)
        : {};
      // Canonical storage is result.execution_audit. Some orchestrator
      // versions may additionally wrap executor output inside result.stages.
      let audit = result["execution_audit"] as Row | undefined;
      if (!audit && Array.isArray(result["stages"])) {
        const stage = (result["stages"] as unknown[]).find((item) => {
          if (!item || typeof item !== "object") return false;
          const row = item as Row;
          return String(row["name"] ?? row["stage"] ?? "").toLowerCase() === "trade-executor";
        });
        if (stage && typeof stage === "object") {
          const stageRow = stage as Row;
          const stageResult = stageRow["result"];
          if (stageResult && typeof stageResult === "object") {
            audit = (stageResult as Row)["execution_audit"] as Row | undefined;
          }
          if (!audit) audit = stageRow["execution_audit"] as Row | undefined;
        }
      }
      return { run, audit };
    })
    .filter((x) => x.audit);
  return { runs, audits, error: error?.message ?? null };
}

/** Signal-level audit analysis. Seed events (details.audit_seed===true) are markers only. */
export function analyzeAudits(
  audits: Array<{ run: Row; audit?: Row }>,
  symbol?: string,
) {
  const auditedSignalIds = new Set<string>();
  const realSignalIds = new Set<string>();
  let seed = 0, nonSeed = 0, realCandidateAccepts = 0, aiRiskAllowed = 0, aiRiskBlocked = 0, opened = 0;
  const rejections: Record<string, number> = {};
  const executionErrors: Row[] = [];
  const events: Row[] = [];
  for (const { run, audit } of audits) {
    opened += Number(((audit?.summary ?? {}) as Row)["opened"] ?? 0);
    for (const ev of ((audit?.events ?? []) as Row[])) {
      if (symbol && ev.symbol !== symbol) continue;
      const details = (ev.details ?? {}) as Row;
      const isSeed = details.audit_seed === true;
      const sid = typeof ev.signal_id === "string" && ev.signal_id ? ev.signal_id : null;
      if (sid) auditedSignalIds.add(sid);
      events.push({ run_id: run.id, ...ev, is_seed: isSeed });
      if (isSeed) { seed++; continue; }
      nonSeed++;
      if (sid) realSignalIds.add(sid);
      const stage = String(ev.stage ?? ""), decision = String(ev.decision ?? "");
      if (stage === "CANDIDATE_FILTER" && decision === "ACCEPT") realCandidateAccepts++;
      if (stage === "AI_RISK" && decision === "ACCEPT") aiRiskAllowed++;
      if (stage === "AI_RISK" && decision === "REJECT") aiRiskBlocked++;
      if (decision === "REJECT") {
        const k = `${stage}:${String(ev.reason ?? "unknown")}`;
        rejections[k] = (rejections[k] ?? 0) + 1;
      }
      if (decision === "ERROR" || stage === "ERROR") executionErrors.push({ run_id: run.id, ...ev });
    }
  }
  return {
    auditedSignalIds, realSignalIds, events,
    counts: {
      audited_runs: audits.length, seed_events: seed, non_seed_events: nonSeed,
      real_candidate_accepts: realCandidateAccepts, ai_risk_allowed: aiRiskAllowed,
      ai_risk_blocked: aiRiskBlocked, opened_from_audit: opened,
    },
    rejections, executionErrors,
  };
}

export async function getEligibleSignals(db: ReadOnlyDb, a: Row) {
  const windowMin = clampInt(a.window_minutes, 15, 1, 1440);
  const minConf = clampNum(a.min_confidence, EXECUTION_CONFIDENCE_THRESHOLD, 0, 1);
  let q = db
    .select("composite_signals", "id,symbol,recommendation,confidence,created_at,regime_label,market_session")
    .eq("recommendation", "buy")
    .gte("created_at", sinceIso(windowMin))
    .gte("confidence", minConf)
    .order("created_at", { ascending: false })
    .limit(500);
  const sym = str(a.symbol, 32);
  if (sym) q = q.eq("symbol", sym);
  const { data, error } = await q;
  return { window_minutes: windowMin, min_confidence: minConf, signals: (data ?? []) as Row[], query_error: error?.message ?? null };
}

export async function getExecutionAudit(db: ReadOnlyDb, a: Row) {
  const windowMin = clampInt(a.window_minutes, 15, 1, 1440);
  const { audits, error } = await loadAudits(db, windowMin, str(a.run_id));
  const r = analyzeAudits(audits, str(a.symbol, 32));
  return {
    window_minutes: windowMin,
    counts: r.counts,
    rejection_reasons: r.rejections,
    execution_errors: r.executionErrors,
    events: r.events.slice(0, 500),
    query_error: error,
  };
}

export async function getExecutionGap(db: ReadOnlyDb, a: Row) {
  const windowMin = clampInt(a.window_minutes, 15, 1, 1440);
  const symbol = str(a.symbol, 32);
  const [elig, aud] = await Promise.all([
    getEligibleSignals(db, { window_minutes: windowMin, symbol }),
    loadAudits(db, windowMin, str(a.run_id)),
  ]);
  const r = analyzeAudits(aud.audits, symbol);
  const eligible = elig.signals;
  const audited = eligible.filter((s) => r.auditedSignalIds.has(String(s.id)));
  const realAudited = eligible.filter((s) => r.realSignalIds.has(String(s.id)));
  const uncovered = eligible.filter((s) => !r.auditedSignalIds.has(String(s.id)));
  const pct = (n: number) => (eligible.length === 0 ? 100 : Math.round((n / eligible.length) * 100));
  return {
    window_minutes: windowMin,
    coverage_level: "signal",
    eligible_buy_signals: eligible.length,
    audited_eligible_signals: audited.length,
    non_audited_eligible_signals: uncovered.length,
    coverage_pct: pct(audited.length),
    real_event_coverage_pct: pct(realAudited.length),
    seed_only_signals: audited.length - realAudited.length,
    uncovered_symbols: [...new Set(uncovered.map((s) => String(s.symbol)))],
    uncovered_signal_ids: uncovered.map((s) => s.id).slice(0, 100),
    audit_counts: r.counts,
    note: "Seed events (details.audit_seed===true) count for presence coverage only, never as real candidate accepts.",
  };
}

export async function getTradeState(db: ReadOnlyDb, a: Row) {
  const sym = str(a.symbol, 32);
  let openQ = db.select("trades").eq("status", "open").order("created_at", { ascending: false }).limit(200);
  let closedQ = db.select("trades").eq("status", "closed").order("closed_at", { ascending: false }).limit(50);
  if (sym) { openQ = openQ.eq("symbol", sym); closedQ = closedQ.eq("symbol", sym); }
  const [open, closed] = await Promise.all([openQ, closedQ]);
  const openRows = (open.data ?? []) as Row[];
  const openSymbols = [...new Set(openRows.map((r) => String(r.symbol ?? "")).filter(Boolean))];

  // Use the latest stored price snapshot for each open symbol so the diagnostic
  // portfolio RPC can reproduce the dashboard's marked-open PnL instead of
  // silently reporting entry-price marks as zero unrealized PnL.
  let markQ = db
    .select("asset_price_snapshots", "asset,price,observed_at")
    .order("observed_at", { ascending: false })
    .limit(1000);
  if (openSymbols.length > 0) markQ = markQ.in("asset", openSymbols);
  const marks = await markQ;
  const markPrices: Record<string, number> = {};
  for (const row of (marks.data ?? []) as Row[]) {
    const asset = String(row.asset ?? "");
    const price = Number(row.price);
    const key = `${asset.toUpperCase()}USDT`;
    if (asset && Number.isFinite(price) && markPrices[key] === undefined) markPrices[key] = price;
  }

  const portfolio = await db.rpc("get_portfolio_summary", { p_mark_prices: markPrices });
  return {
    open_trades: open.data ?? [],
    recent_closed_trades: closed.data ?? [],
    portfolio: portfolio.data ?? null,
    mark_prices: markPrices,
    portfolio_note: "Portfolio computed with latest stored asset_price_snapshots marks for open symbols (RPC keys use SYMBOLUSDT).",
    errors: [open.error?.message, closed.error?.message, marks.error?.message, portfolio.error?.message].filter(Boolean),
  };
}

export async function getVariantState(db: ReadOnlyDb, a: Row) {
  const sym = str(a.symbol, 32);
  let q = db.select("strategy_variant_signals", "strategy_name,outcome,pnl_pct,symbol")
    .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString()).limit(10000);
  if (sym) q = q.eq("symbol", sym);
  const [rows, perf] = await Promise.all([q, db.rpc("get_variant_performance", { days: 7 })]);
  const counts: Record<string, Record<string, number>> = {};
  for (const r of (rows.data ?? []) as Row[]) {
    const s = String(r.strategy_name), o = String(r.outcome ?? "open");
    counts[s] ??= {};
    counts[s][o] = (counts[s][o] ?? 0) + 1;
  }
  return {
    window_days: 7,
    counts_by_strategy_outcome: counts,
    performance: perf.data ?? null,
    errors: [rows.error?.message, perf.error?.message].filter(Boolean),
  };
}

export async function getDiagnosticSnapshot(db: ReadOnlyDb, a: Row) {
  const windowMin = clampInt(a.window_minutes, 15, 1, 1440);
  const args = { ...a, window_minutes: windowMin };
  const [runs, gap, audit, trades, variants, strategy] = await Promise.all([
    getPipelineRuns(db, { limit: 20, run_id: a.run_id }),
    getExecutionGap(db, args),
    getExecutionAudit(db, args),
    getTradeState(db, args),
    getVariantState(db, args),
    db.select("strategy_config").eq("id", 1).maybeSingle(),
  ]);
  // Health score: same spirit as AI Report (coverage-driven execution status).
  let execution_status: "ok" | "warning" | "critical" = "ok";
  if (gap.eligible_buy_signals === 0 && audit.counts.non_seed_events === 0) execution_status = "warning";
  else if (gap.eligible_buy_signals > 0 && gap.coverage_pct < 100) execution_status = "critical";
  const recentErrors = runs.errors.length;
  const health_score = Math.max(
    0,
    100 - (execution_status === "critical" ? 40 : execution_status === "warning" ? 10 : 0) - Math.min(40, recentErrors * 5),
  );
  return {
    window_minutes: windowMin,
    health: { health_score, execution_status, recent_pipeline_errors: recentErrors },
    strategy: strategy.data ?? null,
    latest_runs: runs.runs,
    recent_pipeline_errors: runs.errors,
    execution_gap: gap,
    execution_audit: { counts: audit.counts, rejection_reasons: audit.rejection_reasons, execution_errors: audit.execution_errors },
    trades,
    variants,
  };
}

/* ───────────── MCP tool registry ───────────── */

const win = { type: "integer", minimum: 1, maximum: 1440, default: 15 };
const symbolP = { type: "string", description: "Optional symbol filter, e.g. BTC" };
const runIdP = { type: "string", description: "Optional pipeline_runs.id" };

export const TOOLS: Record<string, { description: string; inputSchema: Row; run: (db: ReadOnlyDb, a: Row) => Promise<unknown> }> = {
  get_diagnostic_snapshot: { description: "Full read-only diagnostic snapshot.", inputSchema: { type: "object", properties: { window_minutes: win, symbol: symbolP, run_id: runIdP } }, run: getDiagnosticSnapshot },
  get_pipeline_runs: { description: "Latest pipeline runs and errors.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 20 }, run_id: runIdP } }, run: getPipelineRuns },
  get_execution_audit: { description: "Execution audit events with seed/non-seed counts.", inputSchema: { type: "object", properties: { window_minutes: win, symbol: symbolP, run_id: runIdP } }, run: getExecutionAudit },
  get_eligible_signals: { description: "Eligible BUY composite signals.", inputSchema: { type: "object", properties: { window_minutes: win, min_confidence: { type: "number", minimum: 0, maximum: 1, default: 0.6 }, symbol: symbolP } }, run: getEligibleSignals },
  get_execution_gap: { description: "Signal-level audit coverage of eligible BUY signals.", inputSchema: { type: "object", properties: { window_minutes: win, symbol: symbolP, run_id: runIdP } }, run: getExecutionGap },
  get_trade_state: { description: "Open/closed paper trades and portfolio summary.", inputSchema: { type: "object", properties: { symbol: symbolP } }, run: getTradeState },
  get_variant_state: { description: "Strategy variant counts and performance (7d).", inputSchema: { type: "object", properties: { symbol: symbolP } }, run: getVariantState },
};

/* ───────────── JSON-RPC dispatcher ───────────── */

type RpcReq = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Row };

export async function handleRpc(msg: RpcReq, db: ReadOnlyDb): Promise<Row | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(-32600, "Invalid Request");
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "trading-diagnostic-readonly", version: "1.0.0" },
        instructions: "Read-only diagnostic tools. No writes or trading actions are possible.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false } })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS[name];
      if (!tool) return err(-32602, `Unknown tool: ${name}`);
      try {
        const data = await tool.run(db, (msg.params?.arguments ?? {}) as Row);
        const payload = { source: sourceMetadata(), tool: name, data };
        return ok({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return ok({ content: [{ type: "text", text: JSON.stringify({ source: sourceMetadata(), error: message }) }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // e.g. notifications/initialized
      return err(-32601, `Method not found: ${msg.method}`);
  }
}
