import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  fetchOpenTrades,
  fetchRecentClosedTrades,
  fetchCountOpenTrades,
  fetchCountClosedTrades,
  fetchPortfolioSummary,
  fetchVariantSignals,
  fetchVariantOpenCount,
  fetchVariantTotalCount,
  fetchPipelineErrors,
  fetchLastRunByStep,
} from "@/lib/diagnostic/queries";
import { detectAnomalies, fetchBinancePrices } from "@/lib/diagnostic/checks";
import { buildAIReport } from "@/lib/diagnostic/ai-report-builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const token = process.env.DIAGNOSTIC_TOKEN;
  if (!token) return true;
  const header = req.headers.get("x-diagnostic-token");
  const qs = req.nextUrl.searchParams.get("token");
  return header === token || qs === token;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase env vars missing");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();

  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getSupabase();
  const sp = req.nextUrl.searchParams;
  const format = (sp.get("format") ?? "json").toLowerCase(); // json | markdown | text

  try {
    // === Fetch everything in parallel ===
    const [
      openTrades,
      closedTrades,
      openCount,
      closedCount,
      portfolio,
      variants,
      variantOpen,
      variantTotal,
      pipelineErrors,
      lastRuns,
    ] = await Promise.all([
      fetchOpenTrades(sb, 100),
      fetchRecentClosedTrades(sb, 50),
      fetchCountOpenTrades(sb),
      fetchCountClosedTrades(sb),
      fetchPortfolioSummary(sb),
      fetchVariantSignals(sb, 500),
      fetchVariantOpenCount(sb),
      fetchVariantTotalCount(sb),
      fetchPipelineErrors(sb, 24, 30),
      fetchLastRunByStep(sb),
    ]);

    // === Live prices για anomaly detection ===
    const symbolsNeeded = Array.from(
      new Set([
        ...(openTrades ?? []).map((t) => t.symbol),
        ...(variants ?? []).map((v) => v.symbol),
      ]),
    ).slice(0, 50); // Binance limit σε ένα call
    const livePrices = await fetchBinancePrices(symbolsNeeded);

    // === Anomalies ===
    const anomalies = detectAnomalies(
      openTrades ?? [],
      closedTrades ?? [],
      variants ?? [],
      livePrices,
    );

    // === Build AI report ===
    const report = buildAIReport({
      openTrades: openTrades ?? [],
      closedTrades: closedTrades ?? [],
      openCount: openCount ?? 0,
      closedCount: closedCount ?? 0,
      portfolio,
      variants: variants ?? [],
      variantOpenCount: variantOpen ?? 0,
      variantTotalCount: variantTotal ?? 0,
      pipelineErrors: pipelineErrors ?? [],
      lastRuns: lastRuns ?? [],
      anomalies,
      livePrices,
      durationMs: Date.now() - t0,
    });

    // === Format response ===
    if (format === "markdown" || format === "text") {
      return new NextResponse(report.narrative_md, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "private, max-age=10",
        },
      });
    }

    if (format === "ai") {
      return new NextResponse(report.ai_context, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, max-age=10",
        },
      });
    }

    return NextResponse.json(report, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=10, stale-while-revalidate=30",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        error: "report_build_failed",
        message: e?.message ?? String(e),
        duration_ms: Date.now() - t0,
      },
      { status: 500 },
    );
  }
}
