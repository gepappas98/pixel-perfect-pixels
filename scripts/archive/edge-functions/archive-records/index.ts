import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const ALLOWED = new Set([
  "closed_trades_with_entry_context", "trades_with_entry_context_current_state", "council_lessons",
  "research_cases", "research_evidence", "strategy_variant_signals", "cmc_listing_snapshots",
  "cmc_listing_snapshots_latest", "cmc_macro_snapshots", "early_entry_variant_decisions",
  "early_entry_regime_observations", "event_flow_study_snapshots", "event_flow_paper_decisions",
  "event_flow_transmissions", "accumulation_shadow_observations", "dynamic_watchlist_snapshots",
  "market_candles", "market_regime_telemetry", "market_sentiment_snapshots", "strategy_config", "research_live_sync_manifest",
]);
const PAGE_SIZE = 500;
const MAX_DOCUMENTS = 20000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST required" }), { status: 405, headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return new Response(JSON.stringify({ error: "Archive server configuration missing" }), { status: 500, headers: cors });
    const body = await req.json().catch(() => ({}));
    const requested = Array.isArray(body.categories)
      ? [...new Set(body.categories.filter((x: unknown) => typeof x === "string" && ALLOWED.has(x)))]
      : [];
    if (!requested.length) return new Response(JSON.stringify({ error: "No allowed archive categories requested" }), { status: 400, headers: cors });
    const limit = Math.max(1, Math.min(500, Number.isFinite(Number(body.limit)) ? Math.floor(Number(body.limit)) : 150));
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const records: Record<string, any[]> = Object.fromEntries(requested.map((c: string) => [c, []]));
    let scannedDocuments = 0;
    let scanLimitReached = false;

    // Paginate the full archive. Do not silently ignore older documents after the first 1,000.
    for (let offset = 0; offset < MAX_DOCUMENTS; offset += PAGE_SIZE) {
      const { data: docs, error } = await db.from("research_archive_documents")
        .select("id,payload,created_at,generated_at")
        .order("created_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) return new Response(JSON.stringify({ error: "Archive payload query failed", detail: error.message, scanned_documents: scannedDocuments }), { status: 502, headers: cors });
      const page = docs ?? [];
      scannedDocuments += page.length;
      for (const doc of page) {
        const p = doc.payload ?? {};
        const type = String(p.record_type ?? p.archive_type ?? p.kind ?? "");
        if (!records[type] || records[type].length >= limit) continue;
        for (const item of (Array.isArray(p.records) ? p.records : [])) {
          if (records[type].length >= limit) break;
          if (item && typeof item === "object") records[type].push({
            ...item,
            _archive_document_id: doc.id,
            _archive_created_at: doc.created_at,
            _archive_generated_at: doc.generated_at,
            _archive_record_type: type,
          });
        }
      }
      if (page.length < PAGE_SIZE) break;
      if (offset + PAGE_SIZE >= MAX_DOCUMENTS) scanLimitReached = true;
    }

    for (const type of requested) records[type].sort((a, b) => {
      const time = (r: any) => Date.parse(String(r.resolved_at ?? r.closed_at ?? r.observed_at ?? r.available_at ?? r.created_at ?? r.captured_at ?? r.entry_at ?? r._archive_created_at ?? ""));
      const ta = time(a), tb = time(b);
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
    return new Response(JSON.stringify({
      generated_at: new Date().toISOString(),
      source: "research_archive_documents",
      scan_mode: "paginated_full_archive",
      scanned_documents: scannedDocuments,
      scan_limit_reached: scanLimitReached,
      categories: records,
      counts: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.length])),
      per_category_limit: limit,
    }), { status: 200, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Unexpected archive records failure", detail: String(e) }), { status: 500, headers: cors });
  }
});