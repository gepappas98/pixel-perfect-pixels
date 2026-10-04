import { createServerFn } from "@tanstack/react-start";
import { askLovableAI, AI_MODEL } from "./lovable-ai.server";

/* ───────────── Server Function ───────────── */

export type AIRiskLevel = "low" | "medium" | "high" | "critical";
export type AIRiskDataQuality = "fresh" | "stale" | "insufficient";

export interface AIRiskDecision {
  symbol: string;
  risk_level: AIRiskLevel;
  trade_allowed: boolean;
  data_quality: AIRiskDataQuality;
  reasons: string[];
}

export interface AIRiskCandidate {
  symbol: string;
  confidence: number;
  price: number | null;
  regime: string | null;
  reasoning: string;
}

const RISK_GATE_TIMEOUT_MS = 18_000;

function failClosed(candidates: AIRiskCandidate[], reason: string): AIRiskDecision[] {
  return candidates.map((candidate) => ({
    symbol: candidate.symbol,
    risk_level: "critical",
    trade_allowed: false,
    data_quality: "insufficient",
    reasons: [reason],
  }));
}

export async function evaluateAIRiskBatch(
  candidates: AIRiskCandidate[],
): Promise<AIRiskDecision[]> {
  if (candidates.length === 0) return [];

  const compactCandidates = candidates.slice(0, 10).map((candidate) => ({
    symbol: candidate.symbol,
    confidence: Number(candidate.confidence.toFixed(4)),
    price: candidate.price,
    regime: candidate.regime,
    signal_reasoning: candidate.reasoning.slice(0, 900),
  }));

  const prompt = [
    "You are a crypto risk veto engine, not a trading signal generator.",
    "Review the supplied already-approved LONG candidates.",
    "You may only block a candidate; never invent a BUY and never increase size.",
    "Treat missing, stale, contradictory, or insufficient information as trade_allowed=false and data_quality=insufficient.",
    "Use high or critical for material liquidity, volatility, manipulation, data, or regime risk.",
    "Return ONLY a minified JSON array, exactly one object per supplied symbol.",
    'Schema: [{"symbol":"BTC","risk_level":"low|medium|high|critical","trade_allowed":true,"data_quality":"fresh|stale|insufficient","reasons":["short reason"]}]',
    "A candidate is allowed only when risk_level is low or medium, data_quality is fresh, and there is no critical reason.",
    JSON.stringify(compactCandidates),
  ].join("\n");

  try {
    const raw = await Promise.race([
      askLovableAI(prompt),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("AI risk gate timeout")), RISK_GATE_TIMEOUT_MS),
      ),
    ]);
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as unknown;
    if (!Array.isArray(parsed)) throw new Error("AI risk response is not an array");

    const allowedLevels = new Set<AIRiskLevel>(["low", "medium", "high", "critical"]);
    const allowedQuality = new Set<AIRiskDataQuality>(["fresh", "stale", "insufficient"]);
    const bySymbol = new Map<string, AIRiskDecision>();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const symbol = String(row["symbol"] ?? "").toUpperCase();
      if (!candidates.some((candidate) => candidate.symbol === symbol)) continue;
      const risk = String(row["risk_level"] ?? "critical") as AIRiskLevel;
      const quality = String(row["data_quality"] ?? "insufficient") as AIRiskDataQuality;
      if (!allowedLevels.has(risk) || !allowedQuality.has(quality)) continue;
      const reasons = Array.isArray(row["reasons"])
        ? row["reasons"].filter((reason): reason is string => typeof reason === "string").slice(0, 4)
        : [];
      bySymbol.set(symbol, {
        symbol,
        risk_level: risk,
        trade_allowed: row["trade_allowed"] === true && (risk === "low" || risk === "medium") && quality === "fresh",
        data_quality: quality,
        reasons: reasons.length > 0 ? reasons : ["AI supplied no reason"],
      });
    }

    if (bySymbol.size !== candidates.length) {
      throw new Error(`AI risk response incomplete (${bySymbol.size}/${candidates.length})`);
    }
    return candidates.map((candidate) => bySymbol.get(candidate.symbol)!);
  } catch (error) {
    console.error("[AI_RISK_GATE] fail-closed", error);
    return failClosed(candidates, error instanceof Error ? error.message : "AI risk unavailable");
  }
}

export const getAIRiskSummary = createServerFn({ method: "POST" })
  .validator((data: { symbol: string; context?: string }) => {
    if (!data.symbol || typeof data.symbol !== "string") {
      throw new Error("symbol is required");
    }
    return {
      symbol: data.symbol.toUpperCase().trim(),
      context: (data.context ?? "").trim(),
    };
  })
  .handler(async ({ data }) => {
    try {
      const prompt = [
        `You are a concise crypto risk analyst. Provide a risk summary for ${data.symbol}.`,
        `Market context: ${data.context || "No additional context provided."}`,
        "",
        "Cover these three points in under 120 words:",
        "1. Key risks (specific to this symbol)",
        "2. Volatility outlook",
        "3. One actionable takeaway",
        "",
        "Be direct and specific. No disclaimers.",
      ].join("\n");

      const summary = await askLovableAI(prompt);

      if (!summary) {
        return { ok: false as const, error: "Empty response from AI" };
      }

      return {
        ok: true as const,
        symbol: data.symbol,
        summary,
        model: AI_MODEL,
        generatedAt: new Date().toISOString(),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("AI risk summary failed", e);
      return { ok: false as const, error: message };
    }
  });
