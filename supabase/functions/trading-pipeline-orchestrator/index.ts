import { getServiceClient } from "../_shared/supabase.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const STAGES: any[] = [
  ["whale-watch", 90000],
  ["tradingview-signals", 120000],
  ["council-sync", 90000],
  ["strategy-auto-switch", 60000],
  ["signal-combiner", 180000],
  ["early-entry-regime", 30000],
  ["variant-resolver", 90000],
  ["trade-executor", 120000],
  ["council-lessons", 60000],
];

function countBy(items: any[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = item?.[key];
    if (typeof value !== "string" || !value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/**
 * Keep the complete stage responses in the HTTP response for callers, but do
 * not duplicate large raw payloads in every pipeline_runs JSONB update.
 * whale_alerts.raw is the canonical record for deduplicated whale trades.
 */
function compactStageForStorage(stage: any): any {
  const result = stage?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return stage;

  if (stage.name === "whale-watch" && Array.isArray(result.alerts)) {
    const alerts = result.alerts;
    const { alerts: _rawAlerts, ...rest } = result;
    const topSymbols = Object.entries(countBy(alerts, "symbol"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([symbol, count]) => ({ symbol, count }));

    return {
      ...stage,
      result: {
        ...rest,
        alerts_count: alerts.length,
        alerts_summary: {
          by_source: countBy(alerts, "source"),
          by_direction: countBy(alerts, "direction"),
          top_symbols: topSymbols,
        },
        raw_payload_storage: "whale_alerts",
      },
    };
  }

  // signal-combiner returns the full created-signal rows for the HTTP caller.
  // Store only a summary in pipeline_runs because the canonical rows already
  // live in composite_signals; duplicating them inflated each run by ~400 KB.
  if (stage.name === "signal-combiner" && Array.isArray(result.signals)) {
    const signals = result.signals;
    const { signals: _rawSignals, ...rest } = result;
    const topSymbols = Object.entries(countBy(signals, "symbol"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([symbol, count]) => ({ symbol, count }));

    return {
      ...stage,
      result: {
        ...rest,
        signals_count: signals.length,
        signals_summary: {
          by_recommendation: countBy(signals, "recommendation"),
          top_symbols: topSymbols,
        },
        raw_payload_storage: "composite_signals",
      },
    };
  }

  return stage;
}

function compactStagesForStorage(stages: any[]): any[] {
  return stages.map(compactStageForStorage);
}

async function captureAccumulationResearch(db: any) {
  const t = Date.now();
  try {
    const { data, error } = await db.rpc("capture_accumulation_shadow_observations", {
      p_lookback_hours: 168,
    });
    return {
      name: "capture-accumulation-shadow",
      ok: !error,
      status: error ? 500 : 200,
      duration_ms: Date.now() - t,
      research_only: true,
      result: error ? { error: error.message } : { captured: Number(data ?? 0) },
    };
  } catch (e) {
    return {
      name: "capture-accumulation-shadow",
      ok: false,
      status: 500,
      duration_ms: Date.now() - t,
      research_only: true,
      result: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}

async function call(name: string, timeout: number) {
  const t = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Keep trade-executor JWT verification enabled; authenticate this internal
    // service-to-service call with the server-side service-role token.
    if (name === "trade-executor" || name === "cmc-macro-sync" || name === "cmc-listings-sync") {
      const internalToken = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!internalToken) {
        throw new Error("Missing server-side service token for trade-executor call");
      }
      headers.Authorization = "Bearer " + internalToken;
    }
    const response = await fetch(URL + "/functions/v1/" + name, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let body: any = bodyText;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // Preserve non-JSON response bodies for error diagnostics.
    }
    return {
      name,
      // CMC functions intentionally return HTTP 200 on fail-open errors; preserve their body-level failure in pipeline diagnostics.
      ok: response.ok && (!(name === "cmc-macro-sync" || name === "cmc-listings-sync") || body?.ok !== false),
      status: response.status,
      duration_ms: Date.now() - t,
      result: body,
    };
  } catch (e) {
    return {
      name,
      ok: false,
      status: 599,
      duration_ms: Date.now() - t,
      result: { error: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  const db = getServiceClient();
  const started = new Date();
  let body: any = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    // The trigger metadata is optional; use the scheduled defaults.
  }

  const trigger = typeof body.trigger === "string" ? body.trigger : "scheduled";
  const source = typeof body.source === "string"
    ? body.source
    : trigger === "manual" ? "unknown" : "pg_cron";

  await db.from("pipeline_runs")
    .update({
      status: "error",
      completed_at: new Date().toISOString(),
      error_message: "Recovered stale orchestrator run (>20 minutes).",
    })
    .eq("job_name", "trading-pipeline-orchestrator")
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - 1200000).toISOString());

  const run = await db.from("pipeline_runs").insert({
    job_name: "trading-pipeline-orchestrator",
    status: "running",
    started_at: started.toISOString(),
    mode: Deno.env.get("TRADING_MODE") || "paper",
    result: {
      architecture: "dag_parallel_phases",
      interval_minutes: 10,
      trigger,
      source,
      stages: [],
      storage_compaction_version: 2,
    },
  }).select("id").single();

  if (run.error) {
    if (run.error.code === "23505") {
      return Response.json({ skipped: true, reason: "another pipeline run is already active" });
    }
    return Response.json({ error: run.error.message }, { status: 500 });
  }

  const id = run.data.id;
  const results: any[] = [];

  const updateRunProgress = async (phaseName: string) => {
    await db.from("pipeline_runs").update({
      result: {
        architecture: "dag_parallel_phases",
        interval_minutes: 10,
        trigger,
        source,
        stages: compactStagesForStorage(results),
        current_stage: phaseName,
        storage_compaction_version: 2,
      },
    }).eq("id", id);
  };

  try {
    // CMC listings must finish before whale-watch resolves its dynamic watchlist.
    // This remains optional telemetry: even a fail-open CMC error must not block existing ingestion.
    const cmcListingsStage = await call("cmc-listings-sync", 50000);
    results.push(cmcListingsStage);

    // The remaining independent ingestion stages run concurrently after CMC discovery is available.
    const phase1 = await Promise.all([
      call("whale-watch", 65000),
      call("tradingview-signals", 70000),
      call("council-sync", 55000),
      call("strategy-auto-switch", 35000),
      call("cmc-macro-sync", 12000),
    ]);
    results.push(...phase1);
    await updateRunProgress("phase_1_ingestion_complete");
    const whaleStage = phase1.find((s) => s.name === "whale-watch");
    const techStage = phase1.find((s) => s.name === "tradingview-signals");
    if (!whaleStage?.ok || !techStage?.ok) {
      throw new Error(`Critical ingestion stage failed: ${!whaleStage?.ok ? "whale-watch" : "tradingview-signals"}`);
    }

    // Phase 2: signal synthesis must finish before regime evaluation.
    const combinerStage = await call("signal-combiner", 70000);
    results.push(combinerStage);
    if (!combinerStage.ok) throw new Error("signal-combiner failed with HTTP " + combinerStage.status);
    const [earlyEntryStage, researchStage] = await Promise.all([
      call("early-entry-regime", 30000),
      captureAccumulationResearch(db),
    ]);
    results.push(earlyEntryStage, researchStage);
    await updateRunProgress("phase_2_synthesis_complete");

    // Phase 3: paper/live-mode executor behavior remains owned by trade-executor;
    // variant resolution runs in parallel and does not submit exchange orders.
    const [tradeExecutorStage, variantResolverStage] = await Promise.all([
      call("trade-executor", 80000),
      call("variant-resolver", 60000),
    ]);
    results.push(tradeExecutorStage, variantResolverStage);
    await updateRunProgress("phase_3_execution_complete");

    // Phase 4: post-trade learning.
    const lessonsStage = await call("council-lessons", 40000);
    results.push(lessonsStage);
    if (!lessonsStage.ok) console.error("[ORCHESTRATOR] non-blocking council-lessons failure", lessonsStage.status);
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    await db.from("pipeline_runs").update({
      status: "error",
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - started.getTime(),
      error_message: errMessage,
      result: {
        architecture: "dag_parallel_phases",
        interval_minutes: 10,
        trigger,
        source,
        stages: compactStagesForStorage(results),
        storage_compaction_version: 2,
      },
    }).eq("id", id);
    return Response.json({ok:false,run_id:id,error:errMessage,stages:results},{status:502});
  }

  const executorStage = results.find((stage) => stage.name === "trade-executor");
  const executionAudit = executorStage?.result?.execution_audit ?? {
    version: 1,
    started_at: started.toISOString(),
    completed_at: new Date().toISOString(),
    status: "completed",
    trades: executorStage?.result?.opened ?? 0,
    summary: {
      eligible_buy_signals: 0,
      audited_eligible_signals: 0,
      uncovered_eligible_signals: 0,
      opened: executorStage?.result?.opened ?? 0,
      skipped: executorStage?.result?.skipped ?? 0,
      errors: Array.isArray(executorStage?.result?.errors) ? executorStage.result.errors.length : 0,
    },
    events: [],
  };

  await db.from("pipeline_runs").update({
    status: "completed",
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - started.getTime(),
    result: {
      architecture: "dag_parallel_phases",
      interval_minutes: 10,
      trigger,
      source,
      stages: compactStagesForStorage(results),
      execution_audit: executionAudit,
      storage_compaction_version: 2,
    },
  }).eq("id", id);

  // The HTTP response remains un-compacted for compatibility with callers.
  return Response.json({
    ok: true,
    run_id: id,
    duration_ms: Date.now() - started.getTime(),
    stages: results,
  });
});
