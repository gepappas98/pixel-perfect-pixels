export type MtfDirection = "bullish" | "bearish" | "neutral" | string;

export interface WeightedMtfFrame {
  signal: MtfDirection;
  available: boolean;
  weight: number;
}

/**
 * Shared, direction-only MTF scoring used by the live scorer and research variants.
 * Missing frames are excluded from the denominator; neutral frames remain available
 * but contribute zero direction, matching the live scorer's existing formula.
 */
export function calculateWeightedMtfScore(frames: WeightedMtfFrame[]): number {
  const available = frames.filter((frame) => frame.available);
  const availableWeight = available.reduce((sum, frame) => sum + frame.weight, 0);
  if (availableWeight <= 0) return 0;

  const directionalWeight = available.reduce((sum, frame) => {
    if (frame.signal === "bullish") return sum + frame.weight;
    if (frame.signal === "bearish") return sum - frame.weight;
    return sum;
  }, 0);

  return directionalWeight / availableWeight;
}
