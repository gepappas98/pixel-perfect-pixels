import { getServiceClient } from "../_shared/supabase.ts";

const BASE = "https://pro-api.coinmarketcap.com/public-api";
const REQUEST_TIMEOUT_MS = 8_000;
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
// Keep one week of compact CMC listing history; prune only after a complete new batch is stored.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
// Expand beyond the first 200 CMC-ranked assets without a key. Keep request count bounded.
const MAX_ASSETS = 1_000;
const MAX_PAGES = MAX_ASSETS / PAGE_SIZE;

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
    if (latest && ageMs >= 0 && ageMs < SUCCESS_TTL_MS) {
      return Response.json({ ok: true, skipped: true, reason: "fresh_listings_snapshot", age_ms: ageMs, captured_at: latest.captured_at, research_only: true });
    }

    const pages: any[][] = [];
    let httpStatus = 200;
    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * PAGE_SIZE + 1;
      const response = await fetch(
        BASE + "/v3/cryptocurrency/listings/latest?start=" + start + "&limit=" + PAGE_SIZE + "&convert=USD",
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      httpStatus = response.status;
      const body = await response.text();
      let payload: any;
      try { payload = body ? JSON.parse(body) : null; }
      catch { throw new Error("invalid_json_page_" + (page + 1)); }
      if (!response.ok) throw new Error("http_" + response.status + "_page_" + (page + 1));
      if (payload?.status?.error_code !== undefined && String(payload.status.error_code) !== "0") {
        throw new Error("cmc_error_" + String(payload.status.error_code) + "_page_" + (page + 1));
      }
      if (!Array.isArray(payload?.data)) throw new Error("unexpected_listings_shape_page_" + (page + 1));
      pages.push(payload.data.slice(0, PAGE_SIZE));
      // A short page is the provider's signal that the available keyless universe has ended.
      if (payload.data.length < PAGE_SIZE) break;
    }

    const allCoins = pages.flat().slice(0, MAX_ASSETS);
    const capturedAt = new Date().toISOString();
    const rows = allCoins.flatMap((coin: any) => {
      const cmcId = finite(coin?.id);
      const symbol = typeof coin?.symbol === "string" ? coin.symbol.trim().toUpperCase() : "";
      const name = typeof coin?.name === "string" ? coin.name.trim() : "";
      if (cmcId == null || !symbol || !name) return [];
      // CMC V3 listings examples expose quote as an array of quote objects (with symbol "USD");
      // tolerate the keyed-object shape too, so a response-shape variation cannot silently null every price.
      const quoteContainer = coin?.quote;
      const quote = Array.isArray(quoteContainer)
        ? quoteContainer.find((item: any) => String(item?.symbol ?? "").toUpperCase() === "USD") ?? quoteContainer[0] ?? {}
        : quoteContainer?.USD ?? quoteContainer ?? {};
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

    // Append-only research history: do not prune prior listing snapshots automatically.
    const { error: insertError } = await db.from("cmc_listing_snapshots").insert(rows);
    if (insertError) throw insertError;

    // Retention runs only after a complete batch has been inserted, so a failed fetch
    // never prunes the last usable snapshot. The dynamic watchlist consumes only the
    // latest batch; keep seven days for short-term research/debugging.
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    const { count: deletedRows, error: pruneError } = await db.from("cmc_listing_snapshots")
      .delete({ count: "exact" })
      .lt("captured_at", cutoff);
    if (pruneError) {
      // Pruning is maintenance, not a reason to mark a successful discovery refresh as failed.
      console.warn("[CMC_KEYLESS_LISTINGS] retention cleanup failed", pruneError.message);
    }

    return Response.json({
      ok: true, inserted: rows.length, requested_limit: MAX_ASSETS, page_size: PAGE_SIZE, pages_fetched: pages.length, captured_at: capturedAt,
      http_status: httpStatus, duration_ms: Date.now() - started,
      pruned_rows: pruneError ? null : (deletedRows ?? 0), retention_days: 7,
      retention_cleanup_error: pruneError?.message ?? null,
      research_only: true, discovery_only: true,
      history_policy: "retain_7_days_then_prune_after_successful_snapshot",
      note: "Snapshots up to the first 1,000 ranked assets available from the keyless listings endpoint. These candidates feed watchlist discovery only; they do not create or modify trade signals.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[CMC_KEYLESS_LISTINGS] fail-open", message);
    return Response.json({ ok: false, fail_open: true, research_only: true, error: message, duration_ms: Date.now() - started }, { status: 200 });
  }
});
