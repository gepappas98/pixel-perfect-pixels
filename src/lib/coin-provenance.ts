/**
 * Coin Provenance — Tracks where each symbol originated from.
 *
 * Two sources of symbols exist:
 *   1. REVOLUTX_DISCOVERED_SYMBOLS — manually curated additions from RevolutX
 *      (see watchlist-expander.ts). Permanent — never auto-removed.
 *   2. Hyperliquid-driven — auto-added when 24h volume crosses threshold.
 *      Ephemeral — removed when volume drops below hysteresis band.
 *
 * This module exposes the *static* part (RevolutX). The dynamic part is
 * computed at runtime by watchlist-resolver.server.ts.
 */

/**
 * Symbols manually added to the core watchlist via the RevolutX expander.
 * These receive the `revolutx` tag on all alerts, trades, and signals.
 *
 * Populated in batch as we expand. Format: Uppercase base asset symbol.
 */
export const REVOLUTX_DISCOVERED_SYMBOLS: ReadonlySet<string> = new Set([
  // Batch 1 — Top-15 (2026-10-02)
  "TON", "ONDO", "ENA", "PENDLE", "EIGEN", "HYPE", "BERA",
  "KAITO", "VIRTUAL", "AERO", "RAY", "MORPHO", "PENGU",
  "TRUMP", "JASMY",
]);

/**
 * Symbols that must always be in the watchlist, regardless of volume.
 * These are the top-tier majors — dropping them would break the user's
 * expectations and the regime signal.
 */
export const CORE_ALWAYS_INCLUDE: readonly string[] = ["BTC", "ETH", "SOL"];

/**
 * Fallback list used ONLY when:
 *   - Cold start (no cached snapshot)
 *   - Hyperliquid API unreachable
 *   - Binance exchangeInfo unreachable
 *
 * This is a ~50-coin conservative fallback. The pipeline normally operates
 * with a dynamic ~150-coin list resolved from volume.
 */
export const CORE_FALLBACK_WATCHLIST: readonly string[] = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX",
  "AVAX", "DOT", "LINK", "MATIC", "LTC", "BCH", "XLM", "ETC",
  "ATOM", "ALGO", "VET", "ICP", "HBAR", "NEAR", "APT", "SUI",
  "SEI", "TIA", "INJ", "ARB", "OP", "STRK", "SHIB", "PEPE",
  "WIF", "BONK", "UNI", "CRV", "AAVE", "MKR", "COMP",
  "FET", "RNDR", "WLD", "TAO",
  "SAND", "MANA", "AXS", "GALA", "IMX",
  "FIL", "AR", "GRT",
];

export function isRevolutXDiscovered(symbol: string): boolean {
  return REVOLUTX_DISCOVERED_SYMBOLS.has(symbol);
}
