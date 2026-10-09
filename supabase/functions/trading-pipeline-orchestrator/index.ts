import { getServiceClient } from "../_shared/supabase.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const STAGES: any[] = [
  ["whale-watch", 90000],
  ["tradingview-signals", 120000],
  ["polymarket-check", 90000],
  ["council-sync", 90000],
  ["strategy-auto-switch", 60000],
  ["signal-combiner", 180000],
  ["variant-resolver", 90000],
  ["trade-executor", 120000],
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
 * Polymarket snapshots are intentionally kept in pipeline_runs because
 * prediction_snapshots is upserted by market_slug and only keeps the latest value.
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

  // Do not compact polymarket-check snapshots: prediction_snapshots is upserted
  // by market_slug and does not preserve prior point-in-time prices. The
  // pipeline_runs payload is currently the only historical series for replay.

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
    const response = await fetch(URL + "/functions/v1/" + name, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      ok: response.ok,
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
      architecture: "sequential",
      interval_minutes: 2,
      trigger,
      source,
      stages: [],
      storage_compaction_version: 1,
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

  for (const [name, timeout] of STAGES) {
    const stage = await call(name, timeout);
    results.push(stage);

    await db.from("pipeline_runs").update({
      result: {
        architecture: "sequential",
        interval_minutes: 2,
        trigger,
        source,
        stages: compactStagesForStorage(results),
        current_stage: name,
        storage_compaction_version: 1,
      },
    }).eq("id", id);

    if (!stage.ok) {
      await db.from("pipeline_runs").update({
        status: "error",
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - started.getTime(),
        error_message: name + " failed with HTTP " + stage.status,
        result: {
          architecture: "sequential",
          interval_minutes: 2,
          trigger,
          source,
          stages: compactStagesForStorage(results),
          failed_stage: name,
          storage_compaction_version: 1,
        },
      }).eq("id", id);

      return Response.json({
        ok: false,
        run_id: id,
        failed_stage: name,
        stages: results,
      }, { status: 502 });
    }

    if (name === "signal-combiner") {
      const research = await captureAccumulationResearch(db);
      results.push(research);
      await db.from("pipeline_runs").update({
        result: {
          architecture: "sequential",
          interval_minutes: 2,
          trigger,
          source,
          stages: compactStagesForStorage(results),
          current_stage: research.name,
          storage_compaction_version: 1,
        },
      }).eq("id", id);
    }
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
      architecture: "sequential",
      interval_minutes: 2,
      trigger,
      source,
      stages: compactStagesForStorage(results),
      execution_audit: executionAudit,
      storage_compaction_version: 1,
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
