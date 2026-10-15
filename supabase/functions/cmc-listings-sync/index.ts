import { getServiceClient } from "../_shared/supabase.ts";

const BASE = "https://pro-api.coinmarketcap.com/public-api";
const REQUEST_TIMEOUT_MS = 8_000;
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const LIMIT = 200;
const RETENTION_DAYS = 30;

function finite(value: unknown): number | null {
  const n = Number(value);
  return value == null || value === "" || !Number.isFinite(n) ? null : n;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST" && req.method !== "GET") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  const started = Date.now();
  const db = getServiceClient();
  try {
    const { data: latest, error: latestError } = await db.from("cmc_listing_snapshots")
      .select("captured_at")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw latestError;
    const ageMs = latest?.captured_at ? Date.now() - new Date(latest.captured_at).getTime() : Infinity;
    if (ageMs >= 0 && ageMs < SUCCESS_TTL_MS) {
      return Response.json({ ok: true, skipped: true, reason: "fresh_listings_snapshot", age_ms: ageMs, captured_at: latest.captured_at, research_only: true });
    }

    const response = await fetch(
      BASE + "/v3/cryptocurrency/listings/latest?start=1&limit=" + LIMIT + "&convert=USD",
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    const httpStatus = response.status;
    const body = await response.text();
    let payload: any;
    try { payload = body ? JSON.parse(body) : null; }
    catch { throw new Error("invalid_json"); }
    if (!response.ok) throw new Error("http_" + response.status);
    if (payload?.status?.error_code !== undefined && String(payload.status.error_code) !== "0") {
      throw new Error("cmc_error_" + String(payload.status.error_code));
    }
    if (!Array.isArray(payload?.data)) throw new Error("unexpected_listings_shape");

    const capturedAt = new Date().toISOString();
    const rows = payload.data.slice(0, LIMIT).flatMap((coin: any) => {
      const cmcId = finite(coin?.id);
      const symbol = typeof coin?.symbol === "string" ? coin.symbol.trim().toUpperCase() : "";
      const name = typeof coin?.name === "string" ? coin.name.trim() : "";
      if (cmcId == null || !symbol || !name) return [];
      const quote = coin?.quote?.USD ?? {};
      return [{
        captured_at: capturedAt,
        cmc_id: Math.trunc(cmcId),
        name: name.slice(0, 160),
        symbol: symbol.slice(0, 32),
        slug: typeof coin?.slug === "string" ? coin.slug.slice(0, 160) : null,
        cmc_rank: finite(coin?.cmc_rank) == null ? null : Math.trunc(finite(coin.cmc_rank)!),
        price_usd: finite(quote?.price),
        volume_24h_usd: finite(quote?.volume_24h),
        market_cap_usd: finite(quote?.market_cap),
        percent_change_1h: finite(quote?.percent_change_1h),
        percent_change_24h: finite(quote?.percent_change_24h),
        percent_change_7d: finite(quote?.percent_change_7d),
        circulating_supply: finite(coin?.circulating_supply),
        total_supply: finite(coin?.total_supply),
        max_supply: finite(coin?.max_supply),
        tags: Array.isArray(coin?.tags) ? coin.tags.filter((v: unknown) => typeof v === "string").slice(0, 20).map((v: string) => v.slice(0, 80)) : [],
        source: "cmc-keyless-listings",
      }];
    });
    if (rows.length < 50) throw new Error("too_few_valid_listing_rows:" + rows.length);

    const { error: insertError } = await db.from("cmc_listing_snapshots").insert(rows);
    if (insertError) throw insertError;
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error: cleanupError } = await db.from("cmc_listing_snapshots").delete().lt("captured_at", cutoff);
    if (cleanupError) console.warn("[CMC_KEYLESS_LISTINGS] retention cleanup failed", cleanupError.message);

    return Response.json({
      ok: true, inserted: rows.length, requested_limit: LIMIT, captured_at: capturedAt,
      http_status: httpStatus, duration_ms: Date.now() - started,
      research_only: true, discovery_only: true,
      note: "Does not add assets to the active watchlist or create/modify trade signals.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[CMC_KEYLESS_LISTINGS] fail-open", message);
    return Response.json({ ok: false, fail_open: true, research_only: true, error: message, duration_ms: Date.now() - started }, { status: 200 });
  }
});
