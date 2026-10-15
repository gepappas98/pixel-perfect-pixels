import { getServiceClient } from "../_shared/supabase.ts";

const BASE = "https://pro-api.coinmarketcap.com/public-api";
const REQUEST_TIMEOUT_MS = 7_000;
const SUCCESS_TTL_MS = 25 * 60 * 1000;

type EndpointResult = { ok: boolean; status: number | null; data?: any; error?: string; duration_ms: number };

async function fetchEndpoint(path: string): Promise<EndpointResult> {
  const started = Date.now();
  let httpStatus: number | null = null;
  try {
    const response = await fetch(BASE + path, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    httpStatus = response.status;
    const text = await response.text();
    let payload: any;
    try { payload = text ? JSON.parse(text) : null; }
    catch { throw new Error("invalid_json"); }
    const apiCode = payload?.status?.error_code;
    if (!response.ok) throw new Error(`http_${response.status}`);
    if (apiCode !== undefined && String(apiCode) !== "0") {
      throw new Error(`cmc_error_${String(apiCode)}`);
    }
    if (!payload || payload.data == null) throw new Error("missing_data");
    return { ok: true, status: response.status, data: payload.data, duration_ms: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[CMC_KEYLESS] endpoint failed", path, message);
    return { ok: false, status: httpStatus, error: message, duration_ms: Date.now() - started };
  }
}

function one(value: any): any {
  return Array.isArray(value) ? value[0] ?? null : value;
}
function finite(value: unknown): number | null {
  const n = Number(value);
  return value == null || value === "" || !Number.isFinite(n) ? null : n;
}
function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" || /^\d+$/.test(String(value)) ? Number(value) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 10_000_000_000 ? n * 1000 : n) : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST" && req.method !== "GET") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const started = Date.now();
  const db = getServiceClient();
  try {
    // Do not re-fetch data more often than its slowest meaningful source.
    // A partial snapshot does not suppress retries; the next 10-minute pipeline can recover.
    const { data: latest } = await db.from("cmc_macro_snapshots")
      .select("captured_at,source_status")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const status = latest?.source_status ?? {};
    const allFreshSourcesSucceeded = ["global_metrics", "fear_and_greed", "altcoin_season"]
      .every((key) => status?.[key]?.ok === true);
    const ageMs = latest?.captured_at ? Date.now() - new Date(latest.captured_at).getTime() : Infinity;
    if (allFreshSourcesSucceeded && ageMs >= 0 && ageMs < SUCCESS_TTL_MS) {
      return Response.json({
        ok: true, skipped: true, reason: "fresh_successful_snapshot",
        age_ms: ageMs, captured_at: latest.captured_at, research_only: true,
      });
    }

    const [globalResult, fgResult, seasonResult] = await Promise.all([
      fetchEndpoint("/v1/global-metrics/quotes/latest?convert=USD"),
      fetchEndpoint("/v3/fear-and-greed/latest"),
      fetchEndpoint("/v1/altcoin-season-index/latest"),
    ]);

    const globalData = one(globalResult.data);
    const fgData = one(fgResult.data);
    const seasonData = one(seasonResult.data);
    const quote = globalData?.quote?.USD ?? {};
    const btcDominance = finite(globalData?.btc_dominance);
    const ethDominance = finite(globalData?.eth_dominance);
    const totalMcap = finite(quote?.total_market_cap);
    const totalVolume = finite(quote?.total_volume_24h);
    const fgValueRaw = finite(fgData?.value);
    const fgValue = fgValueRaw != null && fgValueRaw >= 0 && fgValueRaw <= 100 ? Math.round(fgValueRaw) : null;
    const fgObservedAt = iso(fgData?.update_time ?? fgData?.timestamp ?? fgData?.last_updated);
    const seasonRaw = finite(seasonData?.altcoin_index);
    const seasonValue = seasonRaw != null && seasonRaw >= 0 && seasonRaw <= 100 ? Math.round(seasonRaw) : null;
    const capturedAt = new Date().toISOString();

    if (![globalResult, fgResult, seasonResult].some((r) => r.ok)) {
      return Response.json({
        ok: false, skipped: true, reason: "all_cmc_sources_unavailable",
        source_status: {
          global_metrics: { ok: globalResult.ok, status: globalResult.status, error: globalResult.error },
          fear_and_greed: { ok: fgResult.ok, status: fgResult.status, error: fgResult.error },
          altcoin_season: { ok: seasonResult.ok, status: seasonResult.status, error: seasonResult.error },
        },
        research_only: true,
      }, { status: 200 });
    }

    const { data: previousRows } = await db.from("cmc_macro_snapshots")
      .select("captured_at,total_mcap")
      .not("total_mcap", "is", null)
      .order("captured_at", { ascending: false })
      .limit(1);
    const previous = previousRows?.[0];
    const previousMcap = finite(previous?.total_mcap);
    const previousAgeMs = previous?.captured_at ? Date.now() - new Date(previous.captured_at).getTime() : Infinity;
    const mcapChangePct = totalMcap != null && previousMcap != null && previousMcap > 0
      && previousAgeMs >= 0 && previousAgeMs <= 24 * 60 * 60 * 1000
      ? ((totalMcap - previousMcap) / previousMcap) * 100
      : null;

    const dominanceRegime = btcDominance == null ? "unknown"
      : btcDominance >= 55 ? "btc_heavy"
      : btcDominance <= 45 ? "alt_rotation" : "neutral";
    const marketStructureTag = seasonValue == null || btcDominance == null ? "unknown"
      : btcDominance >= 55 && seasonValue < 25 ? "btc_season"
      : btcDominance <= 50 && seasonValue > 75 ? "alt_season"
      : "transition";

    const sourceStatus = {
      global_metrics: { ok: globalResult.ok, status: globalResult.status, duration_ms: globalResult.duration_ms, error: globalResult.error ?? null },
      fear_and_greed: { ok: fgResult.ok, status: fgResult.status, duration_ms: fgResult.duration_ms, error: fgResult.error ?? null },
      altcoin_season: { ok: seasonResult.ok, status: seasonResult.status, duration_ms: seasonResult.duration_ms, error: seasonResult.error ?? null },
    };
    const rawSummary = {
      source: "coinmarketcap-keyless",
      research_only: true,
      no_api_key: true,
      endpoint_cache_notes: { global_metrics: "CMC documents 5-minute updates", fear_and_greed: "CMC documents frequent refresh", altcoin_season: "CMC documents 15-minute updates" },
      season_snapshot_time: iso(seasonData?.snapshot_time),
      captured_at: capturedAt,
    };

    const { data: inserted, error: insertError } = await db.from("cmc_macro_snapshots").insert({
      captured_at: capturedAt,
      btc_dominance: btcDominance,
      eth_dominance: ethDominance,
      total_mcap: totalMcap,
      total_volume_24h: totalVolume,
      fg_value: fgValue,
      fg_classification: fgData?.value_classification == null ? null : String(fgData.value_classification),
      fg_observed_at: fgObservedAt,
      altcoin_season_value: seasonValue,
      altcoin_season_label: seasonValue == null ? null : seasonValue > 75 ? "alt_season" : seasonValue < 25 ? "btc_season" : "transition",
      mcap_change_pct: mcapChangePct,
      mcap_change_window_minutes: mcapChangePct == null ? null : previousAgeMs / 60_000,
      dominance_regime: dominanceRegime,
      market_structure_tag: marketStructureTag,
      source_status: sourceStatus,
      raw_summary: rawSummary,
    }).select("id,captured_at").single();
    if (insertError) throw insertError;

    return Response.json({
      ok: true, research_only: true, inserted: true, snapshot: inserted,
      fields_available: {
        global_metrics: globalResult.ok, fear_and_greed: fgResult.ok, altcoin_season: seasonResult.ok,
      },
      market_structure_tag: marketStructureTag, dominance_regime: dominanceRegime,
      mcap_change_pct: mcapChangePct, source_status: sourceStatus,
      duration_ms: Date.now() - started,
      note: "Telemetry only. Does not alter signal-combiner, strategy selection, trade-executor, or live orders.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[CMC_KEYLESS] non-blocking macro sync failure", message);
    // Fail-open contract: report a diagnostic response without throwing into the pipeline.
    return Response.json({
      ok: false, research_only: true, fail_open: true, error: message,
      duration_ms: Date.now() - started,
    }, { status: 200 });
  }
});
