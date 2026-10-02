import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// SYMBOLS
// ============================================================
const BINANCE_SYMBOL_MAP: Record<string, string> = {
  MATIC: "POL",
  RNDR: "RENDER",
  LIT: "HEI",
};
const BLACKLISTED_SYMBOLS = new Set<string>(["LIT"]);

function toBinanceSymbol(base: string): string {
  const m = BINANCE_SYMBOL_MAP[base.toUpperCase()] ?? base.toUpperCase();
  return `${m}USDT`;
}
function isBlacklisted(s: string): boolean {
  return BLACKLISTED_SYMBOLS.has(s.toUpperCase());
}

// ============================================================
// TYPES
// ============================================================
type TradeRow = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  status: "open" | "closed" | "cancelled";
  entry_price: number;
  current_price: number | null;
  quantity: number;
  take_profit: number | null;
  stop_loss: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  composite_signal_id: string | null;
  created_at: string;
  closed_at: string | null;
};

type VariantSignalRow = {
  id: string;
  symbol: string;
  preset_id: string | null;
  outcome: string;
  entry_price: number | null;
  created_at: string;
};

type PortfolioSummary = {
  open_count: number;
  closed_count: number;
  realized_pnl: number;
  unrealized_pnl: number;
  win_count: number;
  loss_count: number;
  win_rate_pct: number;
  profit_factor: number | null;
  avg_win_usd: number | null;
  avg_loss_usd: number | null;
  largest_win_usd: number | null;
  largest_loss_usd: number | null;
};

type PipelineError = {
  created_at: string;
  step: string;
  message: string;
  run_id: string | null;
};

type Anomaly = {
  kind: "PRICE_RATIO" | "PNL_WITHOUT_TRIGGER" | "DELISTED_SYMBOL" | "STALE_SIGNAL" | "ORPHAN_TRADE";
  severity: "warn" | "critical";
  symbol?: string;
  trade_id?: string;
  detail: string;
  context?: Record<string, unknown>;
};

// ============================================================
// AUTH
// ============================================================
function authorized(req: NextRequest): boolean {
  const token = process.env.DIAGNOSTIC_TOKEN;
  if (!token) return true;
  const header = req.headers.get("x-diagnostic-token");
  const qs = req.nextUrl.searchParams.get("token");
  return header === token || qs === token;
}

// ============================================================
// SUPABASE
// ============================================================
function getSupabase(): SupabaseClient {
  const url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      `Supabase env vars missing. url=${!!url} key=${!!key}. ` +
        `Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (ή VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY).`,
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ============================================================
// QUERIES (inline, όλα τα errors τα μαζεύουμε)
// ============================================================
type QueryLog = { label: string; ok: boolean; error?: string; rows?: number };

async function safeQuery<T>(
  log: QueryLog[],
  label: string,
  fn: () => Promise<{ data: T | null; error: any }>,
): Promise<T | null> {
  try {
    const { data, error } = await fn();
    if (error) {
      log.push({ label, ok: false, error: error.message ?? String(error) });
      return null;
    }
    const rows = Array.isArray(data) ? data.length : data ? 1 : 0;
    log.push({ label, ok: true, rows });
    return data;
  } catch (e: any) {
    log.push({ label, ok: false, error: e?.message ?? String(e) });
    return null;
  }
}

async function fetchAll(sb: SupabaseClient, log: QueryLog[]) {
  const [
    openTrades,
    closedTrades,
    openCount,
    closedCount,
    portfolioRaw,
    variants,
    variantOpen,
    variantTotal,
    pipelineErrors,
  ] = await Promise.all([
    safeQuery<TradeRow[]>(log, "open_trades", () =>
      sb.from("trades").select("*").eq("status", "open")
        .order("created_at", { ascending: false }).limit(100),
    ),
    safeQuery<TradeRow[]>(log, "closed_trades", () =>
      sb.from("trades").select("*").eq("status", "closed")
        .order("closed_at", { ascending: false }).limit(50),
    ),
    safeQuery<number>(log, "count_open", async () => {
      const { count, error } = await sb.from("trades")
        .select("id", { count: "exact", head: true }).eq("status", "open");
      return { data: count ?? 0, error };
    }),
    safeQuery<number>(log, "count_closed", async () => {
      const { count, error } = await sb.from("trades")
        .select("id", { count: "exact", head: true }).eq("status", "closed");
      return { data: count ?? 0, error };
    }),
    safeQuery<PortfolioSummary[]>(log, "portfolio_rpc", () =>
      sb.rpc("get_portfolio_summary"),
    ),
    safeQuery<VariantSignalRow[]>(log, "variant_signals", () =>
      sb.from("strategy_variant_signals")
        .select("id, symbol, preset_id, outcome, entry_price, created_at")
        .order("created_at", { ascending: false }).limit(500),
    ),
    safeQuery<number>(log, "count_variant_open", async () => {
      const { count, error } = await sb.from("strategy_variant_signals")
        .select("id", { count: "exact", head: true }).eq("outcome", "open");
      return { data: count ?? 0, error };
    }),
    safeQuery<number>(log, "count_variant_total", async () => {
      const { count, error } = await sb.from("strategy_variant_signals")
        .select("id", { count: "exact", head: true });
      return { data: count ?? 0, error };
    }),
    safeQuery<PipelineError[]>(log, "pipeline_errors", () => {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      return sb.from("pipeline_runs")
        .select("created_at, step, message, run_id")
        .eq("status", "error")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(30);
    }),
  ]);

  // Fallback portfolio αν λείπει RPC
  let portfolio: PortfolioSummary | null = null;
  if (portfolioRaw && portfolioRaw.length > 0) {
    portfolio = portfolioRaw[0];
  } else {
    // Client-side aggregate
    const closedForCalc = await safeQuery<Array<{ pnl_usd: number | null }>>(
      log, "portfolio_fallback_closed", () =>
        sb.from("trades").select("pnl_usd").eq("status", "closed"),
    );
    const openForCalc = await safeQuery<Array<{ pnl_usd: number | null }>>(
      log, "portfolio_fallback_open", () =>
        sb.from("trades").select("pnl_usd").eq("status", "open"),
    );
    if (closedForCalc) {
      const wins = closedForCalc.filter((t) => (t.pnl_usd ?? 0) > 0);
      const losses = closedForCalc.filter((t) => (t.pnl_usd ?? 0) < 0);
      const realized = closedForCalc.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
      const unrealized = (openForCalc ?? []).reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
      const grossWin = wins.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl_usd ?? 0), 0));
      portfolio = {
        open_count: openForCalc?.length ?? 0,
        closed_count: closedForCalc.length,
        realized_pnl: +realized.toFixed(2),
        unrealized_pnl: +unrealized.toFixed(2),
        win_count: wins.length,
        loss_count: losses.length,
        win_rate_pct: closedForCalc.length
          ? +((wins.length / closedForCalc.length) * 100).toFixed(2)
          : 0,
        profit_factor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
        avg_win_usd: wins.length ? +(grossWin / wins.length).toFixed(2) : null,
        avg_loss_usd: losses.length ? +(-grossLoss / losses.length).toFixed(2) : null,
        largest_win_usd: wins.length
          ? +Math.max(...wins.map((t) => t.pnl_usd ?? 0)).toFixed(2) : null,
        largest_loss_usd: losses.length
          ? +Math.min(...losses.map((t) => t.pnl_usd ?? 0)).toFixed(2) : null,
      };
    }
  }

  return {
    openTrades: openTrades ?? [],
    closedTrades: closedTrades ?? [],
    openCount: openCount ?? 0,
    closedCount: closedCount ?? 0,
    portfolio,
    variants: variants ?? [],
    variantOpen: variantOpen ?? 0,
    variantTotal: variantTotal ?? 0,
    pipelineErrors: pipelineErrors ?? [],
  };
}

// ============================================================
// BINANCE PRICES
// ============================================================
async function fetchBinancePrices(symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map();
  const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(
    JSON.stringify(symbols.map(toBinanceSymbol)),
  )}`;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return new Map();
    const arr = (await res.json()) as Array<{ symbol: string; price: string }>;
    const out = new Map<string, number>();
    for (const row of arr) {
      const base = row.symbol.replace(/USDT$/, "");
      const reverse = Object.entries(BINANCE_SYMBOL_MAP).find(([, v]) => v === base);
      out.set(reverse ? reverse[0] : base, parseFloat(row.price));
    }
    return out;
  } catch {
    return new Map();
  } finally {
    clearTimeout(to);
  }
}

// ============================================================
// ANOMALIES
// ============================================================
function detectAnomalies(
  openTrades: TradeRow[],
  closedTrades: TradeRow[],
  variants: VariantSignalRow[],
  livePrices: Map<string, number>,
): Anomaly[] {
  const out: Anomaly[] = [];
  const now = Date.now();

  for (const t of openTrades) {
    if (isBlacklisted(t.symbol)) {
      out.push({
        kind: "DELISTED_SYMBOL",
        severity: "critical",
        symbol: t.symbol,
        trade_id: t.id,
        detail: `${t.symbol} είναι blacklisted (delisted/rebranded).`,
      });
    }
  }

  for (const t of openTrades) {
    const live = livePrices.get(t.symbol);
    if (!live || !t.entry_price) continue;
    const ratio = Math.abs(live / t.entry_price - 1);
    if (ratio > 0.5) {
      out.push({
        kind: "PRICE_RATIO",
        severity: "critical",
        symbol: t.symbol,
        trade_id: t.id,
        detail: `entry=${t.entry_price} live=${live} ratio=${(ratio * 100).toFixed(1)}%`,
        context: { entry: t.entry_price, live, ratio },
      });
    }
  }

  for (const t of openTrades) {
    if (t.pnl_pct == null) continue;
    const hitTP =
      t.take_profit != null && t.current_price != null
        ? t.side === "buy"
          ? t.current_price >= t.take_profit
          : t.current_price <= t.take_profit
        : false;
    const hitSL =
      t.stop_loss != null && t.current_price != null
        ? t.side === "buy"
          ? t.current_price <= t.stop_loss
          : t.current_price >= t.stop_loss
        : false;

    if (Math.abs(t.pnl_pct) > 30 && !hitTP && !hitSL) {
      out.push({
        kind: "PNL_WITHOUT_TRIGGER",
        severity: "warn",
        symbol: t.symbol,
        trade_id: t.id,
        detail: `${t.pnl_pct.toFixed(2)}% PnL αλλά ούτε TP ούτε SL trigger.`,
        context: {
          pnl_pct: t.pnl_pct,
          take_profit: t.take_profit,
          stop_loss: t.stop_loss,
          current_price: t.current_price,
        },
      });
    }
  }

  for (const v of variants) {
    if (v.outcome !== "open") continue;
    const ageMin = (now - new Date(v.created_at).getTime()) / 60000;
    if (ageMin > 30 && isBlacklisted(v.symbol)) {
      out.push({
        kind: "STALE_SIGNAL",
        severity: "warn",
        symbol: v.symbol,
        detail: `variant signal ${v.symbol} stale (${ageMin.toFixed(0)}min) + blacklisted`,
        context: { variant_id: v.id, age_min: ageMin },
      });
    }
  }

  return out;
}

// ============================================================
// REPORT BUILDER
// ============================================================
const REPORT_SCHEMA_VERSION = "1.0";

function buildAIReport(input: {
  openTrades: TradeRow[];
  closedTrades: TradeRow[];
  openCount: number;
  closedCount: number;
  portfolio: PortfolioSummary | null;
  variants: VariantSignalRow[];
  variantOpenCount: number;
  variantTotalCount: number;
  pipelineErrors: PipelineError[];
  anomalies: Anomaly[];
  livePrices: Map<string, number>;
  durationMs: number;
}) {
  const generatedAt = new Date().toISOString();
  const issues: string[] = [];
  const subsystems: Record<string, { status: "ok" | "warn" | "fail"; note: string }> = {
    database: { status: "ok", note: "" },
    pipeline: { status: "ok", note: "" },
    portfolio: { status: "ok", note: "" },
    symbols: { status: "ok", note: "" },
    ui_consistency: { status: "ok", note: "" },
  };

  const uiVsDbMismatch = input.openTrades.length !== input.openCount;
  if (uiVsDbMismatch) {
    subsystems.ui_consistency = {
      status: "warn",
      note: `UI list=${input.openTrades.length} vs count=${input.openCount}`,
    };
    issues.push(
      `UI/DB inconsistency: list ${input.openTrades.length} ≠ count ${input.openCount}`,
    );
  } else {
    subsystems.ui_consistency = {
      status: "ok",
      note: `Consistent: ${input.openCount} open trades`,
    };
  }

  const criticalErrors = input.pipelineErrors.filter((e) =>
    /could not find|does not exist|column|relation/i.test(e.message),
  );
  if (criticalErrors.length > 0) {
    subsystems.pipeline = {
      status: "fail",
      note: `${criticalErrors.length} schema-level errors in 24h`,
    };
    issues.push(`Pipeline schema errors: ${criticalErrors.length}`);
  } else if (input.pipelineErrors.length > 0) {
    subsystems.pipeline = {
      status: "warn",
      note: `${input.pipelineErrors.length} errors in 24h`,
    };
  } else {
    subsystems.pipeline = { status: "ok", note: "No errors in 24h" };
  }

  const blacklistedOpen = input.openTrades.filter((t) => isBlacklisted(t.symbol));
  if (blacklistedOpen.length > 0) {
    subsystems.symbols = {
      status: "fail",
      note: `${blacklistedOpen.length} open trades σε blacklisted symbols`,
    };
    issues.push(`Blacklisted: ${blacklistedOpen.map((t) => t.symbol).join(", ")}`);
  } else {
    subsystems.symbols = { status: "ok", note: "No blacklisted symbols" };
  }

  if (input.portfolio) {
    if (input.portfolio.closed_count === 0) {
      subsystems.portfolio = { status: "warn", note: "0 closed trades" };
      issues.push("Δεν υπάρχουν closed trades");
    } else if (input.portfolio.realized_pnl < 0) {
      subsystems.portfolio = {
        status: "warn",
        note: `Realized PnL αρνητικό: $${input.portfolio.realized_pnl}`,
      };
    } else {
      subsystems.portfolio = {
        status: "ok",
        note: `Realized $${input.portfolio.realized_pnl} από ${input.portfolio.closed_count} trades`,
      };
    }
  } else {
    subsystems.portfolio = { status: "warn", note: "Portfolio summary μη διαθέσιμο" };
  }

  subsystems.database = {
    status: "ok",
    note: `open=${input.openCount}, closed=${input.closedCount}, variants=${input.variantTotalCount}`,
  };

  const severityPoints = input.anomalies.reduce(
    (a, x) => a + (x.severity === "critical" ? 20 : 5), 0,
  );
  const subsystemPenalty = Object.values(subsystems).reduce(
    (a, s) => a + (s.status === "fail" ? 15 : s.status === "warn" ? 5 : 0), 0,
  );
  const score = Math.max(0, 100 - severityPoints - subsystemPenalty);
  const overall = score >= 80 ? "ok" : score >= 50 ? "degraded" : "critical";

  const litOpenTrades = input.openTrades.filter((t) => t.symbol === "LIT");
  const litVariants = input.variants.filter((v) => v.symbol === "LIT");
  const litPrice = input.livePrices.get("LIT");

  const answers: Record<string, { q: string; a: string; confidence: string }> = {
    q1_ui_vs_db_positions: {
      q: "Γιατί το UI δείχνει positions ενώ η DB έχει 0 open trades;",
      a: uiVsDbMismatch
        ? `⚠️ ΑΣΥΜΦΩΝΙΑ: UI list=${input.openTrades.length} αλλά COUNT=${input.openCount}.`
        : `✅ Συνεπή: ${input.openCount} open trades.`,
      confidence: "high",
    },
    q2_ui_query_location: {
      q: "Πού γίνεται το UI query;",
      a: "src/components/trading/TradesPanel.tsx — direct supabase.from('trades').eq('status','open')",
      confidence: "high",
    },
    q3_lit_status: {
      q: "Είναι το LIT delisted ή renamed;",
      a: litPrice
        ? `LIT/HEI live=${litPrice}`
        : "LIT delisted 10/02/2025 → HEI (Heima) 1:1. Χρειάζεται mapping LIT→HEI.",
      confidence: "high",
    },
    q4_lit_not_traded: {
      q: "Γιατί το LIT δεν έγινε trade;",
      a: litOpenTrades.length > 0
        ? `LIT έχει ${litOpenTrades.length} open trades.`
        : litVariants.length > 0
          ? `LIT έχει ${litVariants.filter((v) => v.outcome === "open").length} variants αλλά 0 trades.`
          : "Δεν βρέθηκαν LIT signals.",
      confidence: litOpenTrades.length > 0 ? "high" : "low",
    },
    q5_realized_pnl: {
      q: "Ποιο είναι το πραγματικό realized PnL;",
      a: input.portfolio
        ? `Realized: $${input.portfolio.realized_pnl} από ${input.portfolio.closed_count} trades (WR ${input.portfolio.win_rate_pct}%, PF ${input.portfolio.profit_factor ?? "—"}).`
        : "Portfolio μη διαθέσιμο.",
      confidence: input.portfolio ? "high" : "low",
    },
  };

  const watched = Array.from(new Set([
    ...input.openTrades.map((t) => t.symbol),
    ...input.variants.map((v) => v.symbol),
  ])).sort();

  const withLivePrice = Array.from(input.livePrices.entries()).map(([symbol, price]) => ({
    symbol,
    binance: toBinanceSymbol(symbol),
    price,
  })).sort((a, b) => a.symbol.localeCompare(b.symbol));

  const variantBySymbol = new Map<string, { symbol: string; open: number; total: number }>();
  for (const v of input.variants) {
    const cur = variantBySymbol.get(v.symbol) ?? { symbol: v.symbol, open: 0, total: 0 };
    cur.total += 1;
    if (v.outcome === "open") cur.open += 1;
    variantBySymbol.set(v.symbol, cur);
  }
  const variantsBySymbolTop = Array.from(variantBySymbol.values())
    .sort((a, b) => b.open - a.open).slice(0, 20);

  const suggested_actions: Array<{
    priority: string; action: string; reason: string; evidence: string[];
  }> = [];

  if (uiVsDbMismatch) {
    suggested_actions.push({
      priority: "P0",
      action: "Επαλήθευση Supabase connection string στο SELECT COUNT(*)",
      reason: "UI vs DB ασυμφωνία",
      evidence: [`UI list=${input.openTrades.length}`, `DB count=${input.openCount}`],
    });
  }
  if (criticalErrors.length > 0) {
    suggested_actions.push({
      priority: "P0",
      action: "Εφαρμογή missing migration",
      reason: "Schema errors σπάνε το pipeline",
      evidence: criticalErrors.slice(0, 3).map((e) => e.message),
    });
  }
  const priceAnomalies = input.anomalies.filter((a) => a.kind === "PRICE_RATIO");
  if (priceAnomalies.length > 0) {
    suggested_actions.push({
      priority: "P0",
      action: "Blacklist symbols με price ratio >50%",
      reason: "Entry prices δεν αντιστοιχούν σε πραγματικές",
      evidence: priceAnomalies.map((a) => `${a.symbol}: ${a.detail}`),
    });
  }
  if (blacklistedOpen.length > 0) {
    suggested_actions.push({
      priority: "P0",
      action: `Κλείσιμο open trades: ${blacklistedOpen.map((t) => t.symbol).join(", ")}`,
      reason: "Delisted/rebranded tokens",
      evidence: blacklistedOpen.map((t) => `${t.symbol} trade ${t.id.slice(0, 8)}`),
    });
  }
  if (!input.portfolio || input.portfolio.closed_count === 0) {
    suggested_actions.push({
      priority: "P1",
      action: "Δημιουργία RPC get_portfolio_summary()",
      reason: "Χωρίς closed trades δεν μπορεί να αξιολογηθεί edge",
      evidence: ["closed_count=" + (input.portfolio?.closed_count ?? "N/A")],
    });
  }

  const report: any = {
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: generatedAt,
    duration_ms: input.durationMs,
    health: { overall, score, issues, subsystems },
    answers,
    anomalies: input.anomalies,
    data: {
      trades: {
        open_count: input.openCount,
        closed_count: input.closedCount,
        open: input.openTrades.slice(0, 50),
        recent_closed: input.closedTrades.slice(0, 20),
      },
      portfolio: input.portfolio,
      variants: {
        open_count: input.variantOpenCount,
        total_count: input.variantTotalCount,
        by_symbol_top: variantsBySymbolTop,
      },
      pipeline: {
        recent_errors: input.pipelineErrors,
        last_run_by_step: [],
      },
      symbols: {
        watched,
        blacklisted: Array.from(new Set(watched.filter((s) => isBlacklisted(s)))),
        with_live_price: withLivePrice,
      },
    },
    suggested_actions,
    narrative_md: "",
    ai_context: "",
  };

  report.narrative_md = renderNarrative(report);
  report.ai_context = renderAIContext(report);
  return report;
}

function renderNarrative(r: any): string {
  const s = r.data;
  const p = r.data.portfolio;
  const L: string[] = [];

  L.push(`# Trading Command Center — Diagnostic Report`);
  L.push(``);
  L.push(`**Generated:** ${r.generated_at}`);
  L.push(`**Duration:** ${r.duration_ms}ms`);
  L.push(`**Health:** ${r.health.overall.toUpperCase()} (score ${r.health.score}/100)`);
  L.push(``);
  L.push(`## Executive Summary`);
  L.push(``);
  L.push(`- Open trades: **${s.trades.open_count}** · Closed: **${s.trades.closed_count}**`);
  if (p) {
    L.push(`- Realized: **$${p.realized_pnl}** · Unrealized: **$${p.unrealized_pnl}**`);
    L.push(`- Win rate: **${p.win_rate_pct}%** (W:${p.win_count}/L:${p.loss_count}) · PF: **${p.profit_factor ?? "—"}**`);
  }
  L.push(`- Variants: open=**${s.variants.open_count}** total=**${s.variants.total_count}**`);
  L.push(`- Pipeline errors: **${s.pipeline.recent_errors.length}**`);
  L.push(`- Anomalies: **${r.anomalies.length}**`);
  L.push(``);

  if (r.health.issues.length) {
    L.push(`### Issues`);
    for (const i of r.health.issues) L.push(`- ⚠️ ${i}`);
    L.push(``);
  }

  L.push(`## Subsystem Health`);
  L.push(``);
  L.push(`| Subsystem | Status | Note |`);
  L.push(`|-----------|--------|------|`);
  for (const [k, v] of Object.entries(r.health.subsystems as Record<string, any>)) {
    const icon = v.status === "ok" ? "✅" : v.status === "warn" ? "⚠️" : "❌";
    L.push(`| ${k} | ${icon} ${v.status} | ${v.note} |`);
  }
  L.push(``);

  L.push(`## Answers`);
  L.push(``);
  for (const [, v] of Object.entries(r.answers as Record<string, any>)) {
    L.push(`### ${v.q}`);
    L.push(`**Answer:** ${v.a} _(confidence: ${v.confidence})_`);
    L.push(``);
  }

  if (r.anomalies.length) {
    L.push(`## Anomalies (${r.anomalies.length})`);
    L.push(``);
    for (const a of r.anomalies) {
      const icon = a.severity === "critical" ? "🚨" : "⚠️";
      L.push(`- ${icon} **${a.kind}** ${a.symbol ? `\`${a.symbol}\`` : ""} — ${a.detail}`);
    }
    L.push(``);
  }

  if (s.trades.open.length) {
    L.push(`## Open Trades (${s.trades.open.length})`);
    L.push(``);
    L.push(`| Symbol | Side | Entry | Current | PnL $ | PnL % |`);
    L.push(`|--------|------|-------|---------|-------|-------|`);
    for (const t of s.trades.open) {
      L.push(`| ${t.symbol} | ${t.side} | ${t.entry_price} | ${t.current_price ?? "—"} | ${t.pnl_usd?.toFixed(2) ?? "—"} | ${t.pnl_pct?.toFixed(2) ?? "—"}% |`);
    }
    L.push(``);
  }

  if (s.variants.by_symbol_top.length) {
    L.push(`## Variants — Top Symbols`);
    L.push(``);
    L.push(`| Symbol | Open | Total |`);
    L.push(`|--------|------|-------|`);
    for (const v of s.variants.by_symbol_top.slice(0, 15)) {
      L.push(`| ${v.symbol} | ${v.open} | ${v.total} |`);
    }
    L.push(``);
  }

  if (r.suggested_actions.length) {
    L.push(`## Suggested Actions`);
    L.push(``);
    for (const a of r.suggested_actions) {
      L.push(`### ${a.priority} — ${a.action}`);
      L.push(`_${a.reason}_`);
      for (const e of a.evidence) L.push(`- \`${e}\``);
      L.push(``);
    }
  }

  L.push(`---`);
  L.push(`_schema v${r.schema_version} · source: /api/diagnostic/ai-report_`);
  return L.join("\n");
}

function renderAIContext(r: any): string {
  const s = r.data;
  const p = r.data.portfolio;
  const L: string[] = [];
  L.push(`SYSTEM: Trading Command Center diagnostic`);
  L.push(`HEALTH: ${r.health.overall} (${r.health.score}/100)`);
  L.push(`TRADES: open=${s.trades.open_count} closed=${s.trades.closed_count}`);
  if (p) {
    L.push(`PORTFOLIO: realized=$${p.realized_pnl} unrealized=$${p.unrealized_pnl} win_rate=${p.win_rate_pct}% PF=${p.profit_factor ?? "n/a"}`);
  }
  L.push(`VARIANTS: open=${s.variants.open_count} total=${s.variants.total_count}`);
  L.push(`PIPELINE_ERRORS_24H: ${s.pipeline.recent_errors.length}`);
  if (r.health.issues.length) {
    L.push(`ISSUES:`);
    for (const i of r.health.issues) L.push(`- ${i}`);
  }
  const critical = r.anomalies.filter((a: any) => a.severity === "critical");
  const warnings = r.anomalies.filter((a: any) => a.severity === "warn");
  if (critical.length) {
    L.push(`CRITICAL_ANOMALIES:`);
    for (const a of critical) L.push(`- ${a.kind} ${a.symbol ?? ""}: ${a.detail}`);
  }
  if (warnings.length) {
    L.push(`WARNINGS:`);
    for (const a of warnings.slice(0, 5)) L.push(`- ${a.kind} ${a.symbol ?? ""}: ${a.detail}`);
  }
  L.push(`ANSWERS:`);
  for (const [k, v] of Object.entries(r.answers as Record<string, any>)) {
    L.push(`- ${k}: ${v.a}`);
  }
  if (r.suggested_actions.length) {
    L.push(`SUGGESTED_ACTIONS:`);
    for (const a of r.suggested_actions) {
      L.push(`- [${a.priority}] ${a.action} — ${a.reason}`);
    }
  }
  return L.join("\n");
}

// ============================================================
// HANDLER
// ============================================================
export async function GET(req: NextRequest) {
  const t0 = Date.now();

  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const format = (sp.get("format") ?? "json").toLowerCase();
  const debug = sp.has("debug");
  const queryLog: QueryLog[] = [];

  try {
    const sb = getSupabase();

    const data = await fetchAll(sb, queryLog);

    const symbolsNeeded = Array.from(new Set([
      ...data.openTrades.map((t) => t.symbol),
      ...data.variants.map((v) => v.symbol),
    ])).slice(0, 50);
    const livePrices = await fetchBinancePrices(symbolsNeeded);

    const anomalies = detectAnomalies(
      data.openTrades, data.closedTrades, data.variants, livePrices,
    );

    const report = buildAIReport({
      openTrades: data.openTrades,
      closedTrades: data.closedTrades,
      openCount: data.openCount,
      closedCount: data.closedCount,
      portfolio: data.portfolio,
      variants: data.variants,
      variantOpenCount: data.variantOpen,
      variantTotalCount: data.variantTotal,
      pipelineErrors: data.pipelineErrors,
      anomalies,
      livePrices,
      durationMs: Date.now() - t0,
    });

    if (debug) {
      (report as any).__debug = {
        query_log: queryLog,
        env_check: {
          supabase_url: !!(
            process.env.SUPABASE_URL ??
            process.env.NEXT_PUBLIC_SUPABASE_URL ??
            process.env.VITE_SUPABASE_URL
          ),
          supabase_key: !!(
            process.env.SUPABASE_SERVICE_ROLE_KEY ??
            process.env.SUPABASE_ANON_KEY ??
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
            process.env.VITE_SUPABASE_ANON_KEY
          ),
          diagnostic_token: !!process.env.DIAGNOSTIC_TOKEN,
        },
        live_prices_count: livePrices.size,
      };
    }

    if (format === "markdown" || format === "text") {
      return new NextResponse(report.narrative_md, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }
    if (format === "ai") {
      return new NextResponse(report.ai_context, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return NextResponse.json(report, {
      status: 200,
      headers: { "Cache-Control": "private, max-age=10" },
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        error: "report_build_failed",
        message: e?.message ?? String(e),
        stack: process.env.NODE_ENV !== "production" ? e?.stack : undefined,
        query_log: queryLog,
        duration_ms: Date.now() - t0,
      },
      { status: 500 },
    );
  }
}
