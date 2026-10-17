import { getServiceClient } from "../_shared/supabase.ts";

const POSITION_USD = 1000;
const ENTRY_FEE_RATE = 0.0005; // keep aligned with src/lib/fees.ts and trade-exit.ts
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.04;
const COOLDOWN_HOURS = 1;
const MIN_24H_CHANGE = 1;
const MIN_1H_CHANGE = 0;
const MIN_7D_CHANGE = 0;
const MIN_TURNOVER_PCT = 1;
const MIN_CMC_VOLUME_USD = 5_000_000;
const MAX_CMC_RANK = 1000;


async function fetchBinanceUSDTBases(): Promise<Set<string>> {
  const response = await fetch("https://api.binance.com/api/v3/exchangeInfo", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Binance exchangeInfo unavailable: " + response.status);
  const body = await response.json();
  const bases = new Set<string>((body?.symbols ?? [])
    .filter((s: any) => s.quoteAsset === "USDT" && s.status === "TRADING")
    .map((s: any) => String(s.baseAsset ?? "").toUpperCase()).filter(Boolean));
  if (!bases.size) throw new Error("Binance Spot eligible base set is empty");
  return bases;
}
async function fetchBinanceSpotPrices(): Promise<Map<string, number>> {
  const response = await fetch("https://api.binance.com/api/v3/ticker/price", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Binance Spot ticker/price unavailable: " + response.status);
  const body = await response.json();
  if (!Array.isArray(body) || !body.length) throw new Error("Binance Spot ticker/price returned no prices");
  const prices = new Map<string, number>();
  for (const row of body) {
    const symbol = String(row?.symbol ?? "").toUpperCase();
    const price = num(row?.price);
    if (symbol.endsWith("USDT") && price != null && price > 0) prices.set(symbol, price);
  }
  if (!prices.size) throw new Error("Binance Spot ticker/price contained no valid USDT prices");
  return prices;
}

async function fetchRevolutXActiveBases(): Promise<Set<string>> {
  const response = await fetch("https://revx.revolut.com/api/1.0/public/configuration/pairs?region=EEA", {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("RevolutX EEA pair configuration unavailable: " + response.status);
  const payload = await response.json();
  const pairMap = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  if (!pairMap || typeof pairMap !== "object" || Array.isArray(pairMap)) throw new Error("Unexpected RevolutX pair configuration");
  const bases = new Set<string>();
  for (const [pairName, pair] of Object.entries(pairMap as Record<string, any>)) {
    const base = String((pair as any)?.base ?? String(pairName).split("/")[0] ?? "").trim().toUpperCase();
    if (base && String((pair as any)?.status ?? "").toLowerCase() === "active") bases.add(base);
  }
  if (!bases.size) throw new Error("RevolutX active EEA base set is empty");
  return bases;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST" && req.method !== "GET") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  const db = getServiceClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  try {
    // Require the current dynamically eligible asset universe. This avoids assuming that
    // every CMC listing has a Binance Spot USDT market and RevolutX EEA availability.
    const [{ data: watchlists, error: watchlistError }, { data: listings, error: listingError },
      { data: existing, error: tradeError }] = await Promise.all([
      db.from("dynamic_watchlist_snapshots").select("symbols,computed_at").order("computed_at", { ascending: false }).limit(1),
      db.from("cmc_listing_snapshots").select("id,cmc_id,name,symbol,cmc_rank,price_usd,volume_24h_usd,market_cap_usd,percent_change_1h,percent_change_24h,percent_change_7d,captured_at,tags").order("captured_at", { ascending: false }).limit(1000),
      db.from("trades").select("symbol,created_at,status,entry_source,mode").eq("mode", "paper").eq("entry_source", "cmc_paper").order("created_at", { ascending: false }).limit(1000),
    ]);
    const errors = [watchlistError, listingError, tradeError].filter(Boolean);
    if (errors.length) throw new Error(errors.map((e: any) => e.message).join("; "));

    const latestBy = <T extends Record<string, any>>(rows: T[] | null, key: string) => {
      const map = new Map<string, T>();
      for (const row of rows ?? []) {
        const k = String(row[key] ?? "").toUpperCase();
        if (k && !map.has(k)) map.set(k, row);
      }
      return map;
    };
    const latestWatchlist = watchlists?.[0];
    const watchlistSymbols = new Set((Array.isArray(latestWatchlist?.symbols) ? latestWatchlist.symbols : []).map((s: unknown) => String(s).toUpperCase()));
    if (!latestWatchlist || !watchlistSymbols.size) throw new Error("No current dynamic watchlist snapshot; refusing CMC paper entries.");
    // Independently verify both venues; the merged dynamic watchlist also contains Hyperliquid/pinned symbols.
    const [binanceBases, revolutBases, spotPrices] = await Promise.all([
      fetchBinanceUSDTBases(), fetchRevolutXActiveBases(), fetchBinanceSpotPrices()
    ]);
    const priceObservedAt = new Date().toISOString();
    const eligibleSymbols = new Set([...watchlistSymbols].filter((s) => binanceBases.has(s) && revolutBases.has(s)));
    const listingBy = latestBy(listings, "symbol");
    const tradeRows = existing ?? [];
    const active = new Set(tradeRows.filter((t: any) => t.status === "open").map((t: any) => String(t.symbol).toUpperCase()));
    const latestTradeAt = new Map<string, number>();
    for (const t of tradeRows) {
      const symbol = String(t.symbol).toUpperCase();
      const ts = Date.parse(t.created_at);
      if (symbol && Number.isFinite(ts)) latestTradeAt.set(symbol, Math.max(latestTradeAt.get(symbol) ?? 0, ts));
    }

    const decisions: any[] = [];
    let opened = 0;
    const candidates = [...eligibleSymbols].flatMap((asset: string) => {
      const binanceSymbol = asset === "MATIC" ? "POLUSDT" : asset === "RNDR" ? "RENDERUSDT" : asset + "USDT";
      const listing = listingBy.get(asset);
      const price = spotPrices.get(binanceSymbol) ?? null;
      if (!asset || !binanceSymbol.endsWith("USDT") || !listing || price == null) return [];
      const rank = num(listing.cmc_rank);
      const ch1 = num(listing.percent_change_1h);
      const ch24 = num(listing.percent_change_24h);
      const ch7 = num(listing.percent_change_7d);
      const volume = num(listing.volume_24h_usd);
      const marketCap = num(listing.market_cap_usd);
      const turnover = volume != null && marketCap != null && marketCap > 0 ? volume / marketCap * 100 : null;
      if (rank == null || rank > MAX_CMC_RANK || ch1 == null || ch24 == null || ch7 == null ||
          volume == null || volume < MIN_CMC_VOLUME_USD || ch24 < MIN_24H_CHANGE || ch1 <= MIN_1H_CHANGE || ch7 <= MIN_7D_CHANGE ||
          turnover == null || turnover < MIN_TURNOVER_PCT || !(price && price > 0)) return [];
      return [{ asset, binanceSymbol, listing, price, rank, ch1, ch24, ch7, volume, marketCap, turnover }];
    }).sort((a: any, b: any) => (b.ch24 + b.ch1 + b.ch7 * 0.15) - (a.ch24 + a.ch1 + a.ch7 * 0.15));

    for (const c of candidates) {
      const symbol = c.asset;
      let status = "ELIGIBLE";
      let reason = "CMC positive 1h/24h/7d momentum and sufficient turnover; fresh Binance Spot price";
      if (active.has(symbol)) { status = "ALREADY_OPEN"; reason = "CMC paper position already open"; }
      else if ((latestTradeAt.get(symbol) ?? 0) > now - COOLDOWN_HOURS * 3600000) {
        status = "COOLDOWN"; reason = "CMC paper-entry cooldown (1h)";
      } else {
        const quantity = POSITION_USD / c.price;
        const entryFee = POSITION_USD * ENTRY_FEE_RATE;
        const { data: trade, error } = await db.from("trades").insert({
          composite_signal_id: null,
          symbol,
          side: "buy",
          quantity,
          entry_price: c.price,
          stop_loss: c.price * (1 - STOP_LOSS_PCT),
          take_profit: c.price * (1 + TAKE_PROFIT_PCT),
          mode: "paper",
          status: "open",
          entry_fee: entryFee,
          exit_fee: 0,
          total_fees: entryFee,
          regime_label: null,
          market_session: null,
          exchange_order_id: null,
          entry_source: "cmc_paper",
          source_tags: ["paper", "cmc", "cmc-paper-entry", "spot-long-only", "research-only", "purple-label"],
          entry_metadata: {
            strategy: "cmc-paper-entry-v1",
            source: "cmc-keyless-listings",
            cmc_snapshot_id: c.listing.id,
            cmc_id: c.listing.cmc_id,
            cmc_rank: c.rank,
            momentum_1h_pct: c.ch1,
            momentum_24h_pct: c.ch24,
            momentum_7d_pct: c.ch7,
            volume_24h_usd: c.volume,
            market_cap_usd: c.marketCap,
            volume_to_market_cap_pct: c.turnover,
            listing_observed_at: c.listing.captured_at,
            price_source: "binance-spot-rest-ticker",
            price_observed_at: priceObservedAt,
            binance_symbol: c.binanceSymbol,
            position_usd: POSITION_USD,
            stop_loss_pct: STOP_LOSS_PCT * 100,
            take_profit_pct: TAKE_PROFIT_PCT * 100,
            rule_version: "cmc-paper-entry-v1",
            forward_returns_used_for_entry: false,
            live_orders_enabled: false
          }
        }).select("id,created_at,entry_price").single();
        if (error) {
          status = "OPEN_FAILED";
          reason = error.message;
        } else {
          status = "OPENED";
          reason = "CMC momentum criteria passed; paper LONG opened";
          opened++;
          active.add(symbol);
          latestTradeAt.set(symbol, now);
        }
      }
      decisions.push({ symbol, status, reason, cmc_rank: c.rank, change_1h_pct: c.ch1, change_24h_pct: c.ch24, change_7d_pct: c.ch7, turnover_pct: c.turnover });
    }

    return Response.json({
      ok: true, strategy: "cmc-paper-entry-v1", source: "cmc-keyless-listings",
      research_only: true, mode: "paper", live_orders_enabled: false,
      eligible_assets: eligibleSymbols.size, qualifying_candidates: candidates.length,
      opened, position_usd: POSITION_USD,
      stop_loss_pct: STOP_LOSS_PCT * 100, take_profit_pct: TAKE_PROFIT_PCT * 100,
      rules: { max_cmc_rank: MAX_CMC_RANK, min_1h_change_pct_exclusive: MIN_1H_CHANGE, min_24h_change_pct: MIN_24H_CHANGE, min_7d_change_pct_exclusive: MIN_7D_CHANGE, min_volume_to_market_cap_pct: MIN_TURNOVER_PCT, min_cmc_volume_24h_usd: MIN_CMC_VOLUME_USD, cooldown_hours: COOLDOWN_HOURS },
      decisions: decisions.slice(0, 50), evaluated_at: nowIso,
      note: "Forward returns are evaluation labels only. Strategy auto-switch is not modified by this function."
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e), strategy: "cmc-paper-entry-v1", research_only: true, live_orders_enabled: false }, { status: 500 });
  }
});
