// supabase/functions/council-sync/index.ts
//
// Pulls the latest AI council verdicts from the published "Whale Radar"
// (CRYPTO Whale Tracker Pro) Lovable app's public feed and upserts them
// into our own `council_signals` table. Meant to run on a schedule
// (see the pg_cron block in the migration / README) so signal-combiner
// always has fresh council data without any manual sync step.
//
// Source: https://piywvcmebdrxwhujphqp.supabase.co/functions/v1/public-council-feed
// (public, unauthenticated, read-only — deployed inside the Whale Radar project)
//
// Deploy:  supabase functions deploy council-sync
import { handleOptions, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const COUNCIL_FEED_URL =
  "https://piywvcmebdrxwhujphqp.supabase.co/functions/v1/public-council-feed";
const MAX_SOURCE_AGE_MS = 30 * 60 * 1000;

interface CouncilDecision {
  id: string;
  symbol: string;
  token_id: string | null;
  depth: string | null;
  final_verdict: string;
  conviction: number | null;
  price_at: number | null;
  reflection: string | null;
  created_at: string;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const res = await fetch(COUNCIL_FEED_URL);
    if (!res.ok) throw new Error(`public-council-feed error: ${res.status}`);
    const { decisions } = (await res.json()) as { decisions: CouncilDecision[] };

    if (!decisions || decisions.length === 0) {
      return new Response(JSON.stringify({ synced: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = Date.now();
    const freshDecisions = decisions.filter((d) => {
      const ts = new Date(d.created_at).getTime();
      return Number.isFinite(ts) && now - ts >= 0 && now - ts <= MAX_SOURCE_AGE_MS;
    });

    const supabase = getServiceClient();
    const rows = freshDecisions.map((d) => ({
      source_id: d.id,
      symbol: d.symbol,
      token_id: d.token_id,
      depth: d.depth,
      final_verdict: d.final_verdict,
      conviction: d.conviction,
      price_at: d.price_at,
      reflection: d.reflection,
      source_created_at: d.created_at,
    }));

    const { data, error } = await supabase
      .from("council_signals")
      .upsert(rows, { onConflict: "source_id", ignoreDuplicates: false })
      .select();

    if (error) throw error;

    return new Response(JSON.stringify({ synced: data.length, stale_skipped: decisions.length - freshDecisions.length, rows: data }), {
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
