import { isBlacklisted, toBinanceSymbol } from "./symbols";
import type {
  TradeRow,
  VariantSignalRow,
  PortfolioSummary,
  PipelineError,
  Anomaly,
} from "./types";

export const REPORT_SCHEMA_VERSION = "1.0";

export interface AIReportInput {
  openTrades: TradeRow[];
  closedTrades: TradeRow[];
  openCount: number;
  closedCount: number;
  portfolio: PortfolioSummary | null;
  variants: VariantSignalRow[];
  variantOpenCount: number;
  variantTotalCount: number;
  pipelineErrors: PipelineError[];
  lastRuns: Array<{ step: string; last_run: string; ok: boolean }>;
  anomalies: Anomaly[];
  livePrices: Map<string, number>;
  durationMs: number;
}

export interface AIReport {
  schema_version: string;
  generated_at: string;
  duration_ms: number;

  /** Machine-readable health status */
  health: {
    overall: "ok" | "degraded" | "critical";
    score: number;               // 0..100
    issues: string[];
    subsystems: Record<
      "database" | "pipeline" | "portfolio" | "symbols" | "ui_consistency",
      { status: "ok" | "warn" | "fail"; note: string }
    >;
  };

  /** Structured answers to the 5 core questions */
  answers: Record<string, { q: string; a: string; confidence: "high" | "low" }>;

  /** All detected anomalies */
  anomalies: Anomaly[];

  /** Raw appendix — everything else */
  data: {
    trades: {
      open_count: number;
      closed_count: number;
      open: TradeRow[];
      recent_closed: TradeRow[];
    };
    portfolio: PortfolioSummary | null;
    variants: {
      open_count: number;
      total_count: number;
      by_symbol_top: Array<{ symbol: string; open: number; total: number }>;
    };
    pipeline: {
      recent_errors: PipelineError[];
      last_run_by_step: Array<{ step: string; last_run: string; ok: boolean }>;
    };
    symbols: {
      watched: string[];
      blacklisted: string[];
      with_live_price: Array<{ symbol: string; binance: string; price: number }>;
    };
  };

  /** Long-form markdown narrative — paste σε ChatGPT/Claude */
  narrative_md: string;

  /** Compact context για LLM prompts (~500-1000 tokens) */
  ai_context: string;

  /** Suggested actions, ordered by priority */
  suggested_actions: Array<{
    priority: "P0" | "P1" | "P2" | "P3";
    action: string;
    reason: string;
    evidence: string[];
  }>;
}

export function buildAIReport(input: AIReportInput): AIReport {
  const generatedAt = new Date().toISOString();

  // --- Health scoring ---
  const issues: string[] = [];
  const subsystems: AIReport["health"]["subsystems"] = {
    database: { status: "ok", note: "" },
    pipeline: { status: "ok", note: "" },
    portfolio: { status: "ok", note: "" },
    symbols: { status: "ok", note: "" },
    ui_consistency: { status: "ok", note: "" },
  };

  // UI consistency (Q1)
  const uiVsDbMismatch = input.openTrades.length !== input.openCount;
  if (uiVsDbMismatch) {
    subsystems.ui_consistency = {
      status: "warn",
      note: `UI list=${input.openTrades.length} vs count=${input.openCount}`,
    };
    issues.push(
      `UI/DB inconsistency: list length ${input.openTrades.length} ≠ count ${input.openCount}`,
    );
  } else {
    subsystems.ui_consistency = {
      status: "ok",
      note: `Consistent: ${input.openCount} open trades`,
    };
  }

  // Pipeline errors
  const criticalErrors = input.pipelineErrors.filter((e) =>
    /could not find|does not exist|column|relation/i.test(e.message),
  );
  if (criticalErrors.length > 0) {
    subsystems.pipeline = {
      status: "fail",
      note: `${criticalErrors.length} schema-level errors in 24h`,
    };
    issues.push(
      `Pipeline schema errors: ${criticalErrors.length} (migration missing?)`,
    );
  } else if (input.pipelineErrors.length > 0) {
    subsystems.pipeline = {
      status: "warn",
      note: `${input.pipelineErrors.length} errors in 24h`,
    };
  } else {
    subsystems.pipeline = { status: "ok", note: "No errors in 24h" };
  }

  // Symbol hygiene
  const blacklistedOpen = input.openTrades.filter((t) =>
    isBlacklisted(t.symbol),
  );
  if (blacklistedOpen.length > 0) {
    subsystems.symbols = {
      status: "fail",
      note: `${blacklistedOpen.length} open trades σε blacklisted symbols`,
    };
    issues.push(
      `Blacklisted symbols σε open trades: ${blacklistedOpen
        .map((t) => t.symbol)
        .join(", ")}`,
    );
  } else {
    subsystems.symbols = { status: "ok", note: "No blacklisted symbols" };
  }

  // Portfolio
  if (input.portfolio) {
    if (input.portfolio.closed_count === 0) {
      subsystems.portfolio = {
        status: "warn",
        note: "0 closed trades — δεν μπορεί να αξιολογηθεί edge",
      };
      issues.push("Δεν υπάρχουν closed trades για αξιολόγηση");
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
    subsystems.portfolio = {
      status: "warn",
      note: "Portfolio summary μη διαθέσιμο",
    };
  }

  // Database
  subsystems.database = {
    status: "ok",
    note: `open=${input.openCount}, closed=${input.closedCount}, variants=${input.variantTotalCount}`,
  };

  // Overall score
  const severityPoints = input.anomalies.reduce((acc, a) => {
    return acc + (a.severity === "critical" ? 20 : 5);
  }, 0);
  const subsystemPenalty = Object.values(subsystems).reduce((acc, s) => {
    return acc + (s.status === "fail" ? 15 : s.status === "warn" ? 5 : 0);
  }, 0);
  const score = Math.max(0, 100 - severityPoints - subsystemPenalty);
  const overall =
    score >= 80 ? "ok" : score >= 50 ? "degraded" : "critical";

  // --- Answers to the 5 core questions ---
  const litOpenTrades = input.openTrades.filter((t) => t.symbol === "LIT");
  const litVariants = input.variants.filter((v) => v.symbol === "LIT");
  const litPrice = input.livePrices.get("LIT");

  const answers: AIReport["answers"] = {
    q1_ui_vs_db_positions: {
      q: "Γιατί το UI δείχνει positions ενώ η DB έχει 0 open trades;",
      a: uiVsDbMismatch
        ? `⚠️ ΑΣΥΜΦΩΝΙΑ: Το UI list έχει ${input.openTrades.length} open trades αλλά το COUNT επιστρέφει ${input.openCount}. Πιθανή αιτία: λάθος Supabase project, RLS filter, ή stale cache.`
        : `✅ Το UI και η DB είναι συνεπή: ${input.openCount} open trades. Αν ο χρήστης βλέπει διαφορετικά, το SELECT COUNT(*) εκτελέστηκε σε άλλο project/schema.`,
      confidence: "high",
    },
    q2_ui_query_location: {
      q: "Πού στο pipeline γίνεται το UI query;",
      a: "src/components/trading/TradesPanel.tsx — direct supabase.from('trades').select('*').eq('status','open'). Δεν υπάρχει JOIN με strategy_variant_signals.",
      confidence: "high",
    },
    q3_lit_status: {
      q: "Είναι το LIT delisted ή renamed;",
      a: litPrice
        ? `LIT/HEI live price βρέθηκε: ${litPrice} (mapping LIT→HEI ενεργό).`
        : "LIT delisted 10/02/2025, renamed σε HEI (Heima) με ratio 1:1. Το symbol LITUSDT δεν υπάρχει πλέον στο Binance. Χρειάζεται mapping LIT→HEI στο BINANCE_SYMBOL_MAP.",
      confidence: "high",
    },
    q4_lit_not_traded: {
      q: "Γιατί το LIT composite signal δεν έγινε trade;",
      a:
        litOpenTrades.length > 0
          ? `LIT έχει ${litOpenTrades.length} open trades.`
          : litVariants.length > 0
            ? `LIT έχει ${litVariants.filter((v) => v.outcome === "open").length} open variant signals αλλά 0 trades. Πιθανές αιτίες: risk gate (max positions), signal age >15min, duplicate, ή blacklist block.`
            : "Δεν βρέθηκαν LIT signals (ούτε trades ούτε variants).",
      confidence: litOpenTrades.length > 0 ? "high" : "low",
    },
    q5_realized_pnl: {
      q: "Ποιο είναι το πραγματικό realized PnL;",
      a: input.portfolio
        ? `Realized: $${input.portfolio.realized_pnl} από ${input.portfolio.closed_count} closed trades (win rate ${input.portfolio.win_rate_pct}%, PF ${input.portfolio.profit_factor ?? "—"}). Unrealized: $${input.portfolio.unrealized_pnl}.`
        : "Portfolio summary μη διαθέσιμο — χρειάζεται RPC get_portfolio_summary.",
      confidence: input.portfolio ? "high" : "low",
    },
  };

  // --- Symbol info ---
  const watched = Array.from(
    new Set([
      ...input.openTrades.map((t) => t.symbol),
      ...input.variants.map((v) => v.symbol),
    ]),
  ).sort();

  const withLivePrice = Array.from(input.livePrices.entries())
    .map(([symbol, price]) => ({
      symbol,
      binance: toBinanceSymbol(symbol),
      price,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  // --- Variant breakdown ---
  const variantBySymbol = new Map<
    string,
    { symbol: string; open: number; total: number }
  >();
  for (const v of input.variants) {
    const cur = variantBySymbol.get(v.symbol) ?? {
      symbol: v.symbol,
      open: 0,
      total: 0,
    };
    cur.total += 1;
    if (v.outcome === "open") cur.open += 1;
    variantBySymbol.set(v.symbol, cur);
  }
  const variantsBySymbolTop = Array.from(variantBySymbol.values())
    .sort((a, b) => b.open - a.open)
    .slice(0, 20);

  // --- Suggested actions ---
  const suggested_actions: AIReport["suggested_actions"] = [];

  if (uiVsDbMismatch) {
    suggested_actions.push({
      priority: "P0",
      action: "Επαλήθευση Supabase connection string στο SELECT COUNT(*)",
      reason: "UI vs DB ασυμφωνία υποδηλώνει λάθος project ή caching",
      evidence: [
        `UI list length: ${input.openTrades.length}`,
        `DB count: ${input.openCount}`,
      ],
    });
  }

  if (criticalErrors.length > 0) {
    suggested_actions.push({
      priority: "P0",
      action: "Εφαρμογή missing migration (source_tags, κλπ.)",
      reason: "Schema-level errors σπάνε το pipeline",
      evidence: criticalErrors.slice(0, 3).map((e) => e.message),
    });
  }

  const priceAnomalies = input.anomalies.filter(
    (a) => a.kind === "PRICE_RATIO",
  );
  if (priceAnomalies.length > 0) {
    suggested_actions.push({
      priority: "P0",
      action: "Blacklist symbols με price ratio >50%",
      reason: "Entry prices δεν αντιστοιχούν σε πραγματικές τιμές",
      evidence: priceAnomalies.map(
        (a) => `${a.symbol}: ${a.detail}`,
      ),
    });
  }

  if (blacklistedOpen.length > 0) {
    suggested_actions.push({
      priority: "P0",
      action: `Κλείσιμο open trades σε blacklisted symbols: ${blacklistedOpen
        .map((t) => t.symbol)
        .join(", ")}`,
      reason: "Delisted/rebranded tokens — τα PnL είναι invalid",
      evidence: blacklistedOpen.map(
        (t) => `${t.symbol} trade ${t.id.slice(0, 8)}`,
      ),
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

  if (input.variantOpenCount > 50) {
    suggested_actions.push({
      priority: "P2",
      action: "Review variant signal lifecycle (74 open είναι πολλά)",
      reason: "Shadow signals συσσωρεύονται χωρίς resolution",
      evidence: [`open variants: ${input.variantOpenCount}`],
    });
  }

  suggested_actions.push({
    priority: "P3",
    action: "Προσθήκη UI separation: Real Positions vs Shadow Variants",
    reason: "Ο χρήστης μπερδεύει variants με trades",
    evidence: [
      `trades.open=${input.openCount} vs variants.open=${input.variantOpenCount}`,
    ],
  });

  // --- Build report object ---
  const report: AIReport = {
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
        last_run_by_step: input.lastRuns,
      },
      symbols: {
        watched,
        blacklisted: Array.from(
          new Set(watched.filter((s) => isBlacklisted(s))),
        ),
        with_live_price: withLivePrice,
      },
    },
    narrative_md: "",
    ai_context: "",
    suggested_actions,
  };

  // --- Markdown narrative ---
  report.narrative_md = renderNarrative(report);
  report.ai_context = renderAIContext(report);

  return report;
}

function renderNarrative(r: AIReport): string {
  const s = r.data;
  const p = r.data.portfolio;

  const lines: string[] = [];

  lines.push(`# Trading Command Center — Diagnostic Report`);
  lines.push(``);
  lines.push(`**Generated:** ${r.generated_at}`);
  lines.push(`**Duration:** ${r.duration_ms}ms`);
  lines.push(`**Health:** ${r.health.overall.toUpperCase()} (score ${r.health.score}/100)`);
  lines.push(``);

  lines.push(`## Executive Summary`);
  lines.push(``);
  lines.push(
    `- Open trades (DB): **${s.trades.open_count}** · Closed: **${s.trades.closed_count}**`,
  );
  if (p) {
    lines.push(
      `- Realized PnL: **$${p.realized_pnl}** · Unrealized: **$${p.unrealized_pnl}**`,
    );
    lines.push(
      `- Win rate: **${p.win_rate_pct}%** (W:${p.win_count} / L:${p.loss_count}) · Profit factor: **${p.profit_factor ?? "—"}**`,
    );
  }
  lines.push(
    `- Variant signals (shadow): open=**${s.variants.open_count}** total=**${s.variants.total_count}**`,
  );
  lines.push(
    `- Pipeline errors (24h): **${s.pipeline.recent_errors.length}**`,
  );
  lines.push(`- Anomalies: **${r.anomalies.length}**`);
  lines.push(``);

  if (r.health.issues.length) {
    lines.push(`### Issues`);
    for (const i of r.health.issues) lines.push(`- ⚠️ ${i}`);
    lines.push(``);
  }

  lines.push(`## Subsystem Health`);
  lines.push(``);
  lines.push(`| Subsystem | Status | Note |`);
  lines.push(`|-----------|--------|------|`);
  for (const [k, v] of Object.entries(r.health.subsystems)) {
    const icon = v.status === "ok" ? "✅" : v.status === "warn" ? "⚠️" : "❌";
    lines.push(`| ${k} | ${icon} ${v.status} | ${v.note} |`);
  }
  lines.push(``);

  lines.push(`## Answers`);
  lines.push(``);
  for (const [k, v] of Object.entries(r.answers)) {
    lines.push(`### ${v.q}`);
    lines.push(`**Answer:** ${v.a} _(confidence: ${v.confidence})_`);
    lines.push(``);
  }

  if (r.anomalies.length) {
    lines.push(`## Anomalies (${r.anomalies.length})`);
    lines.push(``);
    for (const a of r.anomalies) {
      const icon = a.severity === "critical" ? "🚨" : "⚠️";
      lines.push(
        `- ${icon} **${a.kind}** ${a.symbol ? `\`${a.symbol}\`` : ""} — ${a.detail}`,
      );
    }
    lines.push(``);
  }

  if (s.trades.open.length) {
    lines.push(`## Open Trades (${s.trades.open.length})`);
    lines.push(``);
    lines.push(`| Symbol | Side | Entry | Current | PnL $ | PnL % |`);
    lines.push(`|--------|------|-------|---------|-------|-------|`);
    for (const t of s.trades.open) {
      lines.push(
        `| ${t.symbol} | ${t.side} | ${t.entry_price} | ${t.current_price ?? "—"} | ${t.pnl_usd?.toFixed(2) ?? "—"} | ${t.pnl_pct?.toFixed(2) ?? "—"}% |`,
      );
    }
    lines.push(``);
  }

  if (s.trades.recent_closed.length) {
    lines.push(`## Recent Closed Trades (${s.trades.recent_closed.length})`);
    lines.push(``);
    lines.push(`| Symbol | Entry | Exit | PnL $ | PnL % |`);
    lines.push(`|--------|-------|------|-------|-------|`);
    for (const t of s.trades.recent_closed) {
      lines.push(
        `| ${t.symbol} | ${t.entry_price} | ${t.current_price ?? "—"} | ${t.pnl_usd?.toFixed(2) ?? "—"} | ${t.pnl_pct?.toFixed(2) ?? "—"}% |`,
      );
    }
    lines.push(``);
  }

  if (s.variants.by_symbol_top.length) {
    lines.push(`## Variant Signals — Top Symbols`);
    lines.push(``);
    lines.push(`| Symbol | Open | Total |`);
    lines.push(`|--------|------|-------|`);
    for (const v of s.variants.by_symbol_top.slice(0, 15)) {
      lines.push(`| ${v.symbol} | ${v.open} | ${v.total} |`);
    }
    lines.push(``);
  }

  if (s.pipeline.recent_errors.length) {
    lines.push(`## Pipeline Errors (24h)`);
    lines.push(``);
    for (const e of s.pipeline.recent_errors.slice(0, 10)) {
      lines.push(
        `- \`${e.created_at}\` **[${e.step}]** ${e.message}`,
      );
    }
    lines.push(``);
  }

  if (r.suggested_actions.length) {
    lines.push(`## Suggested Actions`);
    lines.push(``);
    for (const a of r.suggested_actions) {
      lines.push(`### ${a.priority} — ${a.action}`);
      lines.push(`_${a.reason}_`);
      for (const e of a.evidence) lines.push(`- \`${e}\``);
      lines.push(``);
    }
  }

  lines.push(`---`);
  lines.push(
    `_Report schema v${r.schema_version} · source: /api/diagnostic/ai-report_`,
  );

  return lines.join("\n");
}

function renderAIContext(r: AIReport): string {
  // Compact ~500-1000 token summary για LLM prompts
  const s = r.data;
  const p = r.data.portfolio;
  const lines: string[] = [];

  lines.push(`SYSTEM: Trading Command Center diagnostic`);
  lines.push(`HEALTH: ${r.health.overall} (${r.health.score}/100)`);
  lines.push(
    `TRADES: open=${s.trades.open_count} closed=${s.trades.closed_count}`,
  );
  if (p) {
    lines.push(
      `PORTFOLIO: realized=$${p.realized_pnl} unrealized=$${p.unrealized_pnl} win_rate=${p.win_rate_pct}% PF=${p.profit_factor ?? "n/a"}`,
    );
  }
  lines.push(
    `VARIANTS: open=${s.variants.open_count} total=${s.variants.total_count}`,
  );
  lines.push(`PIPELINE_ERRORS_24H: ${s.pipeline.recent_errors.length}`);

  if (r.health.issues.length) {
    lines.push(`ISSUES:`);
    for (const i of r.health.issues) lines.push(`- ${i}`);
  }

  const critical = r.anomalies.filter((a) => a.severity === "critical");
  const warnings = r.anomalies.filter((a) => a.severity === "warn");
  if (critical.length) {
    lines.push(`CRITICAL_ANOMALIES:`);
    for (const a of critical) {
      lines.push(
        `- ${a.kind} ${a.symbol ?? ""}: ${a.detail}`,
      );
    }
  }
  if (warnings.length) {
    lines.push(`WARNINGS:`);
    for (const a of warnings.slice(0, 5)) {
      lines.push(`- ${a.kind} ${a.symbol ?? ""}: ${a.detail}`);
    }
  }

  lines.push(`ANSWERS:`);
  for (const [k, v] of Object.entries(r.answers)) {
    lines.push(`- ${k}: ${v.a}`);
  }

  if (r.suggested_actions.length) {
    lines.push(`SUGGESTED_ACTIONS:`);
    for (const a of r.suggested_actions) {
      lines.push(`- [${a.priority}] ${a.action} — ${a.reason}`);
    }
  }

  return lines.join("\n");
}
