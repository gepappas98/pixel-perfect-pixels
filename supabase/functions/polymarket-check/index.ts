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
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "eth"],
  SOL: ["solana", "sol"],
  DOGE: ["dogecoin", "doge"],
  XRP: ["xrp", "ripple"],
  AVAX: ["avalanche", "avax"],
  ADA: ["cardano", "ada"],
  MATIC: ["polygon", "matic"],
  LINK: ["chainlink", "link"],
  ARB: ["arbitrum", "arb"],
  CRV: ["curve dao", "curve finance", " crv"],
};

interface GammaMarket {
  slug: string;
  question: string;
  outcomePrices?: string;
  volume24hr?: number;
}

async function fetchActiveMarkets(): Promise<GammaMarket[]> {
  const url = "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polymarket Gamma API error: ${res.status}`);
  return await res.json();
}

function normalizeWords(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function matchesKeyword(question: string, keyword: string): boolean {
  const q = normalizeWords(question);
  const k = normalizeWords(keyword);
  if (k.length === 0 || k.length > q.length) return false;
  for (let i = 0; i <= q.length - k.length; i++) {
    let match = true;
    for (let j = 0; j < k.length; j++) {
      if (q[i + j] !== k[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

function matchSymbol(question: string): string | null {
  for (const [symbol, keywords] of Object.entries(WATCH_KEYWORDS)) {
    if (keywords.some((kw) => matchesKeyword(question, kw))) return symbol;
  }
  return null;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const markets = await fetchActiveMarkets();
    const relevant = markets
      .map((m) => ({ market: m, symbol: matchSymbol(m.question ?? "") }))
      .filter((x) => x.symbol !== null);

    const rows = relevant.map(({ market, symbol }) => {
      let yes = null, no = null;
      try {
        const prices = JSON.parse(market.outcomePrices ?? "[]");
        yes = prices[0] ? parseFloat(prices[0]) : null;
        no = prices[1] ? parseFloat(prices[1]) : null;
      } catch { /* leave null if unparsable */ }

      return {
        market_slug: market.slug,
        question: market.question,
        related_symbol: symbol,
        yes_price: yes,
        no_price: no,
        volume_24h: market.volume24hr ?? null,
        raw: market,
        created_at: new Date().toISOString(),
      };
    });

    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("prediction_snapshots")
      .upsert(rows, { onConflict: "market_slug", ignoreDuplicates: false })
      .select();

    if (error) throw error;

    return new Response(JSON.stringify({ inserted: data.length, snapshots: data }), {
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
