import { createServerFn } from "@tanstack/react-start";
import { askLovableAI, AI_MODEL } from "./lovable-ai.server";

/* ─────────── Server Function ─────────── */
//
// Generates OUR OWN council verdict for a symbol (distinct from the
// council_signals rows synced from the external Whale Radar app) and
// writes it straight into council_signals with depth = "internal-ai",
// tagged with a synthetic source_id so it never collides with synced
// rows. signal-combiner already reads the latest council_signals row
// per symbol, so this flows into composite signals with zero changes
// needed anywhere else.

interface CouncilVerdict {
  verdict: string;
  conviction: number;
  reflection?: string;
}

export const generateCouncilVerdict = createServerFn({ method: "POST" })
  .validator((data: { symbol: string }) => {
    if (!data.symbol || typeof data.symbol !== "string") {
      throw new Error("symbol is required");
    }
    return { symbol: data.symbol.toUpperCase().trim() };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const sym = data.symbol;

    try {
      const [{ data: whales }, { data: indicators }, { data: predictions }] = await Promise.all([
        (supabaseAdmin.from as any)("whale_alerts")
          .select("*")
          .eq("symbol", sym)
          .order("created_at", { ascending: false })
          .limit(1),
        (supabaseAdmin.from as any)("indicator_snapshots")
          .select("*")
          .ilike("symbol", `${sym}%`)
          .order("created_at", { ascending: false })
          .limit(1),
        (supabaseAdmin.from as any)("prediction_snapshots")
          .select("*")
          .eq("related_symbol", sym)
          .order("created_at", { ascending: false })
          .limit(1),
      ]);

      const whale = whales?.[0] ?? null;
      const indicator = indicators?.[0] ?? null;
      const prediction = predictions?.[0] ?? null;

      const dataBlock = [
        `Symbol: ${sym}`,
        whale
          ? `Whale activity: ${whale.direction} of $${Math.round(Number(whale.usd_value)).toLocaleString()}`
          : "Whale activity: no recent data",
        indicator
          ? `Technical signal: ${indicator.signal} (RSI ${indicator.rsi}, price ${indicator.price})`
          : "Technical signal: no recent data",
        prediction
          ? `Prediction market: "${prediction.question}" (yes price ${prediction.yes_price})`
          : "Prediction market: none matching",
      ].join("\n");

      const prompt = [
        "You are one voice on a crypto trading council, giving your independent verdict.",
        "Respond with ONLY minified JSON, no markdown, no code fences, exactly this shape:",
        '{"verdict":"BUY|SELL|HOLD|AVOID","conviction":0-100,"reflection":"one short sentence"}',
        "",
        dataBlock,
      ].join("\n");

      const raw = await askLovableAI(prompt);
      const clean = raw.replace(/```json|```/g, "").trim();

      let parsed: CouncilVerdict;
      try {
        parsed = JSON.parse(clean);
      } catch {
        return { ok: false as const, error: `Could not parse AI response as JSON: ${raw.slice(0, 200)}` };
      }

      const verdict = String(parsed.verdict ?? "").toUpperCase();
      if (!["BUY", "SELL", "HOLD", "AVOID"].includes(verdict)) {
        return { ok: false as const, error: `Unexpected verdict value: ${parsed.verdict}` };
      }

      const conviction = Math.max(0, Math.min(100, Number(parsed.conviction) || 0));

      const { error } = await (supabaseAdmin.from as any)("council_signals").insert({
        source_id: crypto.randomUUID(),
        symbol: sym,
        final_verdict: verdict,
        conviction,
        reflection: parsed.reflection ?? null,
        depth: "internal-ai",
        source_created_at: new Date().toISOString(),
      });

      if (error) {
        return { ok: false as const, error: error.message };
      }

      return { ok: true as const, symbol: sym, verdict, conviction };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("AI council verdict failed", e);
      return { ok: false as const, error: message };
    }
  });
