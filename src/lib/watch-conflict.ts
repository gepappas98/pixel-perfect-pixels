import type { SignalDir } from "./trading-types";

type Row = Record<string, unknown> | null;

export interface ConflictCheck {
  hardConflict: boolean;
  whaleDir: -1 | 0 | 1;
  predDir: -1 | 0 | 1;
  techDir: -1 | 0 | 1;
}

/**
 * Hard conflict detection.
 *
 * Ορισμός: whale και prediction δείχνουν αντίθετα (ένα bullish, ένα bearish)
 *          ΚΑΙ δεν υπάρχει technicals να σπάσει την ισοπαλία.
 *
 * Σε αυτή την περίπτωση, το signal δεν έχει πραγματική κατεύθυνση —
 * είναι semantic hold, όχι watch.
 */
export function detectHardConflict(
  whale: Row,
  mtfDir: SignalDir,
  predictionDir: SignalDir,
): ConflictCheck {
  const whaleDir: -1 | 0 | 1 =
    whale?.["direction"] === "accumulation"
      ? 1
      : whale?.["direction"] === "distribution"
        ? -1
        : 0;

  const predDir: -1 | 0 | 1 =
    predictionDir === "bullish" ? 1 : predictionDir === "bearish" ? -1 : 0;

  const techDir: -1 | 0 | 1 =
    mtfDir === "bullish" ? 1 : mtfDir === "bearish" ? -1 : 0;

  const hardConflict =
    whaleDir !== 0 && predDir !== 0 && whaleDir !== predDir && techDir === 0;

  return { hardConflict, whaleDir, predDir, techDir };
}
