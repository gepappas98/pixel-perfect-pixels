export type AssetRegime = "strong_bull" | "bull" | "sideways" | "bear" | "strong_bear";

export interface AssetRegimeResult {
  regime: AssetRegime;
  score: number;
  aroonOsc: number | null;
  smcState: string | null;
}

export function computeAssetRegime(snapshot4h?: {
  signal?: string | null;
  raw?: Record<string, unknown> | null;
} | null): AssetRegimeResult {
  if (!snapshot4h) return { regime: "sideways", score: 0, aroonOsc: null, smcState: null };

  const raw = snapshot4h.raw ?? {};
  const aroon = raw["aroon"] as Record<string, unknown> | undefined;
  const smc = raw["smc"] as Record<string, unknown> | undefined;
  const aroonOsc = aroon?.["osc"] != null ? Number(aroon["osc"]) : null;
  const smcState = String(smc?.["choch"] ?? smc?.["bos"] ?? "").toLowerCase();
  const signal = String(snapshot4h.signal ?? "").toLowerCase();
  const signalScore = signal === "bullish" ? 1 : signal === "bearish" ? -1 : 0;
  const aroonScore = aroonOsc != null && aroonOsc >= 20 ? 1 : aroonOsc != null && aroonOsc <= -20 ? -1 : 0;
  const smcScore = smcState.includes("bull") ? 1 : smcState.includes("bear") ? -1 : 0;
  const score = signalScore + aroonScore + smcScore;
  const regime: AssetRegime = score >= 2 ? "strong_bull" : score === 1 ? "bull" : score === -1 ? "bear" : score <= -2 ? "strong_bear" : "sideways";
  return { regime, score, aroonOsc, smcState: smcState || null };
}
