// supabase/functions/polymarket-check/index.ts
//
// Replaces polymarket-quant-bot-lite's market-lookup role. Polymarket's
// Gamma API is public and needs no key. Searches for active markets whose
// question text mentions a watched symbol, and stores a price snapshot.
//
// Deploy:  supabase functions deploy polymarket-check
import { handleOptions, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const WATCH_KEYWORDS: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"], ETH: ["ethereum", "eth"],
  SOL: ["solana", "sol"], XRP: ["xrp", "ripple"],
  DOGE: ["dogecoin", "doge"], ADA: ["cardano", "ada"],
  AVAX: ["avalanche", "avax"], LINK: ["chainlink", "link"],
  DOT: ["polkadot", "dot"], LTC: ["litecoin", "ltc"],
  MATIC: ["polygon", "matic", "pol"], BNB: ["bnb", "binance coin"],
  TRX: ["tron", "trx"], SHIB: ["shiba", "shib"],
  PEPE: ["pepe"], ATOM: ["cosmos", "atom"],
  NEAR: ["near protocol"], APT: ["aptos", "apt"],
  SUI: ["sui"], INJ: ["injective", "inj"],
  ARB: ["arbitrum", "arb"], OP: ["optimism"],
  UNI: ["uniswap", "uni"], AAVE: ["aave"],
};

const cryptoWord = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge|cardano|ada|avalanche|avax|chainlink|link|polkadot|dot|litecoin|ltc|polygon|matic|pol|bnb|binance coin|tron|trx|shiba|shib|pepe|cosmos|atom|near protocol|aptos|apt|sui|injective|inj|arbitrum|arb|optimism|uniswap|uni|aave)\b/i;

interface PolymarketMarket {
  slug?: string;
  question?: string;
  outcomePrices?: string | string[];
  volume24hr?: number | string;
}
interface PolymarketEvent { markets?: PolymarketMarket[]; }

const PREDICTION_MIN_VOLUME_USD = 500;
const PREDICTION_RESOLVED_LOW = 0.05;
const PREDICTION_RESOLVED_HIGH = 0.95;
const PREDICTION_PRICE_TARGET = /(?:\$\s?\d|\b(?:all[- ]time high|ath)\b)/i;
const PREDICTION_DIRECTIONAL = /\b(?:reach|hit|above|surpass|exceed|break|all[- ]time high|ath|dip|drop|fall|below|crash|down to|under|bottom)\b/i;

function isUsablePredictionQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return PREDICTION_PRICE_TARGET.test(q) && PREDICTION_DIRECTIONAL.test(q);
}

function eventMarkets(payload: (PolymarketEvent | PolymarketMarket)[]): PolymarketMarket[] {
  return payload.flatMap((item) => "markets" in item ? ((item as PolymarketEvent).markets ?? []) : [item as PolymarketMarket]);
}

function matchSymbolFromQuestion(q: string): string | null {
  const matches: { sym: string; pos: number }[] = [];
  for (const [sym, keywords] of Object.entries(WATCH_KEYWORDS)) {
    for (const kw of keywords) {
      const pos = q.search(new RegExp("\\b" + kw + "\\b", "i"));
      if (pos >= 0) { matches.push({ sym, pos }); break; }
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.pos - b.pos);
  return matches[0]!.sym;
}

async function fetchActiveMarkets(): Promise<PolymarketEvent[] | PolymarketMarket[]> {
  const url = "https://gamma-api.polymarket.com/events?tag_slug=crypto&active=true&closed=false&limit=200";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Polymarket Gamma API error: " + res.status);
  return await res.json();
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const payload = await fetchActiveMarkets();
    const markets = eventMarkets(payload);
    const rows: Record<string, unknown>[] = [];

    for (const market of markets) {
      if (!market.slug) continue;
      const question = market.question ?? "";
      const q = question.toLowerCase();
      if (!cryptoWord.test(q)) continue;

      const symbol = matchSymbolFromQuestion(q);
      if (!symbol) continue;
      if (!isUsablePredictionQuestion(question)) continue;

      let yes: number | null = null;
      let no: number | null = null;
      try {
        const rawPrices = market.outcomePrices;
        const prices = Array.isArray(rawPrices)
          ? rawPrices
          : JSON.parse(rawPrices ?? "[]") as string[];
        yes = prices[0] != null ? Number(prices[0]) : null;
        no = prices[1] != null ? Number(prices[1]) : null;
      } catch {
        continue;
      }

      const volume = Number(market.volume24hr);
      if (
        yes == null ||
        !Number.isFinite(yes) ||
        yes < PREDICTION_RESOLVED_LOW ||
        yes > PREDICTION_RESOLVED_HIGH ||
        !Number.isFinite(volume) ||
        volume < PREDICTION_MIN_VOLUME_USD
      ) continue;

      rows.push({
        market_slug: market.slug,
        question,
        related_symbol: symbol,
        yes_price: yes,
        no_price: no,
        volume_24h: volume,
        raw: market,
        created_at: new Date().toISOString(),
      });
    }

    const supabase = getServiceClient();
    if (rows.length === 0) {
      return new Response(JSON.stringify({ inserted: 0, scanned: markets.length, snapshots: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data, error } = await supabase
      .from("prediction_snapshots")
      .upsert(rows, { onConflict: "market_slug", ignoreDuplicates: false })
      .select();

    if (error) throw error;

    return new Response(JSON.stringify({ inserted: data?.length ?? 0, scanned: markets.length, snapshots: data ?? [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
