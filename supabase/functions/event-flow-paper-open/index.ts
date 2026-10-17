import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const POSITION_USD = 1000;
const FEE_RATE = 0.001;
const TAKE_PROFIT_PCT = 0.04;
const STOP_LOSS_PCT = 0.03;
const MAX_SENTIMENT_AGE_MIN = 20;
const MIN_SENTIMENT_SCORE = 0.15;
const MIN_SENTIMENT_CONFIDENCE = 0.45;
const MAX_FLOW_AGE_MIN = 20;
const MAX_PRICE_AGE_MIN = 20;
const COOLDOWN_MINUTES = 15;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const now = Date.now();
    const since = (mins: number) => new Date(now - mins * 60_000).toISOString();
    const [{ data: assets, error: assetErr }, { data: sentiments, error: sentErr }, { data: flows, error: flowErr }, { data: prices, error: priceErr }, { data: existing, error: tradeErr }] = await Promise.all([
      db.from("tracked_assets").select("asset,binance_symbol").eq("enabled", true),
      db.from("asset_sentiment_snapshots").select("asset,observed_at,source,sentiment_score,mention_count,unique_items,bullish_count,bearish_count,raw").eq("source", "rss-news-consensus").gte("observed_at", since(MAX_SENTIMENT_AGE_MIN)).order("observed_at", { ascending: false }).limit(100),
      db.from("asset_flow_snapshots").select("asset,bucket_at,flow_score,dominant_state,sample_size,buy_usd,sell_usd").gte("bucket_at", since(MAX_FLOW_AGE_MIN)).eq("source", "whale_alerts_15m").order("bucket_at", { ascending: false }).limit(200),
      db.from("asset_price_snapshots").select("asset,observed_at,price").gte("observed_at", since(MAX_PRICE_AGE_MIN)).eq("source", "binance-spot").order("observed_at", { ascending: false }).limit(200),
      db.from("trades").select("symbol,created_at,status,entry_source").eq("mode", "paper").eq("entry_source", "event_flow_paper").order("created_at", { ascending: false }).limit(500),
    ]);
    const errors = [assetErr, sentErr, flowErr, priceErr, tradeErr].filter(Boolean);
    if (errors.length) throw new Error(errors.map((e: any) => e.message).join("; "));
    const latest = <T extends Record<string, any>>(rows: T[] | null, key: string) => {
      const out = new Map<string, T>();
      for (const row of rows ?? []) if (!out.has(String(row[key]).toUpperCase())) out.set(String(row[key]).toUpperCase(), row);
      return out;
    };
    const sentimentMap = latest(sentiments, "asset");
    const flowMap = latest(flows, "asset");
    const priceMap = latest(prices, "asset");
    const tradeRows = existing ?? [];
    const active = new Set(tradeRows.filter((t: any) => t.status === "open").map((t: any) => String(t.symbol).toUpperCase()));
    const cooldown = new Map<string, number>();
    for (const t of tradeRows) {
      const sym = String(t.symbol).toUpperCase();
      const ts = Date.parse(t.created_at);
      if (Number.isFinite(ts)) cooldown.set(sym, Math.max(cooldown.get(sym) ?? 0, ts));
    }
    const decisions: any[] = [];
    let opened = 0;
    for (const assetRow of assets ?? []) {
      const asset = String(assetRow.asset).toUpperCase();
      const s = sentimentMap.get(asset);
      const f = flowMap.get(asset);
      const p = priceMap.get(asset);
      let status = "WAITING_DATA";
      let reason = "Need fresh asset sentiment, Whale Flow and Spot price";
      const sentimentScore = s ? Number(s.sentiment_score) : null;
      const confidence = s ? Number(s.raw?.confidence ?? 0) : null;
      const flowScore = f ? Number(f.flow_score) : null;
      if (s && f && p && sentimentScore !== null && confidence !== null && flowScore !== null) {
        if (sentimentScore < MIN_SENTIMENT_SCORE) { status = "NOT_CONFIRMED"; reason = `Sentiment below +${MIN_SENTIMENT_SCORE.toFixed(2)}`; }
        else if (confidence < MIN_SENTIMENT_CONFIDENCE) { status = "NOT_CONFIRMED"; reason = `RSS consensus confidence below ${MIN_SENTIMENT_CONFIDENCE.toFixed(2)}`; }
        else if (flowScore < 0.10 || f.dominant_state !== "accumulation") { status = "NOT_CONFIRMED"; reason = "Whale Flow does not confirm accumulation"; }
        else if (active.has(asset)) { status = "ALREADY_OPEN"; reason = "Event → Flow paper position already open"; }
        else if ((cooldown.get(asset) ?? 0) > now - COOLDOWN_MINUTES * 60_000) { status = "COOLDOWN"; reason = "Event → Flow paper entry cooldown (15m)"; }
        else {
          const price = Number(p.price);
          if (!Number.isFinite(price) || price <= 0) { status = "WAITING_DATA"; reason = "Invalid Spot price"; }
          else {
            const quantity = POSITION_USD / price;
            const entryFee = POSITION_USD * FEE_RATE;
            const { data: trade, error } = await db.from("trades").insert({
              symbol: asset, side: "buy", quantity, entry_price: price,
              stop_loss: price * (1 - STOP_LOSS_PCT), take_profit: price * (1 + TAKE_PROFIT_PCT),
              mode: "paper", status: "open", entry_fee: entryFee, exit_fee: 0, total_fees: entryFee,
              regime_label: null, entry_source: "event_flow_paper",
              source_tags: ["paper", "event-flow-paper-open", "event-flow-lab", "rss-news-consensus", "whale-flow-confirmed", "spot-long-only", "research-only"],
              entry_metadata: {
                strategy: "event-flow-paper-open-v2", strategy_version: 2,
                entry_path: "event-flow-paper-open", research_only: true,
                sentiment_source: s.source,
                sentiment_score: sentimentScore, sentiment_confidence: confidence,
                mention_count: s.mention_count, unique_items: s.unique_items,
                bullish_count: s.bullish_count, bearish_count: s.bearish_count,
                flow_score: flowScore, flow_state: f.dominant_state,
                flow_sample_size: f.sample_size, buy_usd: f.buy_usd, sell_usd: f.sell_usd,
                sentiment_observed_at: s.observed_at, flow_observed_at: f.bucket_at,
                price_observed_at: p.observed_at, position_usd: POSITION_USD,
                take_profit_pct: TAKE_PROFIT_PCT, stop_loss_pct: STOP_LOSS_PCT,
              },
            }).select("id,created_at,entry_price").single();
            if (error) { status = "OPEN_FAILED"; reason = error.message; }
            else {
              status = "OPENED";
              reason = "Paper LONG opened: positive RSS sentiment + Whale Flow accumulation";
              opened++;
              active.add(asset);
              cooldown.set(asset, now);
            }
          }
        }
      } else if (!s) reason = "No fresh rss-news-consensus sentiment";
      else if (!f) reason = "No fresh Whale Flow snapshot";
      else if (!p) reason = "No fresh Binance Spot price";
      decisions.push({
        asset, observed_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), status, reason,
        sentiment_score: sentimentScore, sentiment_confidence: confidence, flow_score: flowScore,
        flow_state: f?.dominant_state ?? null, price: p ? Number(p.price) : null,
      });
    }
    if (decisions.length) {
      const { error } = await db.from("event_flow_paper_decisions").upsert(decisions, { onConflict: "asset" });
      if (error) throw new Error("decision persistence failed: " + error.message);
    }
    return new Response(JSON.stringify({ ok: true, strategy: "event-flow-paper-open-v2", assets_checked: decisions.length, opened, confirmed: decisions.filter(d => d.status === "OPENED" || d.status === "ALREADY_OPEN").length, decisions }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[EVENT_FLOW_PAPER_OPEN]", message);
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
