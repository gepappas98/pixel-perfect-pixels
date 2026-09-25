"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Sparkles, AlertTriangle, RefreshCw } from "lucide-react";
import { getAIRiskSummary } from "@/lib/ai-risk.functions";

/* ───────────── Full Watchlist (categorized) ───────────── */

const WATCHLIST_CATEGORIES: Record<string, string[]> = {
  "Majors / L1": [
    "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX", "AVAX", "DOT",
    "LINK", "POL", "LTC", "BCH", "XLM", "ETC", "ATOM", "ALGO", "VET", "ICP",
    "HBAR", "THETA", "S", "RUNE", "KAVA", "EOS", "NEO", "IOTA", "KSM", "CELO",
    "ROSE", "ONE", "ZIL", "NEAR", "APT", "SUI", "SEI", "TIA", "INJ", "ARB",
    "OP", "STRK", "MANTA", "ZK", "BLAST", "LRC", "METIS", "MINA", "W",
  ],
  "Meme / High-Beta": [
    "SHIB", "PEPE", "WIF", "BONK", "FLOKI", "ORDI", "BOME", "MEME",
    "BRETT", "MEW", "POPCAT", "PNUT", "MOODENG", "NEIRO", "DOOD", "GIGA",
    "TOSHI", "TROLL", "TURBO", "FARTCOIN",
  ],
  "DeFi": [
    "UNI", "CRV", "AAVE", "MKR", "COMP", "SNX", "SUSHI", "1INCH", "CAKE", "DYDX",
    "GMX", "LDO", "ENS", "BAL", "YFI", "UMA", "JUP", "PYTH", "JTO", "PENDLE",
    "HYPE", "MORPHO", "KMNO", "SYRUP", "ENA", "SKY", "DRIFT", "FLUID", "AERO",
    "ETHFI", "RAY", "ORCA",
  ],
  "AI / DePIN": [
    "FET", "RENDER", "WLD", "ARKM", "TAO", "AKT", "IO", "AR", "FIL", "ICP",
  ],
  "Gaming / Metaverse": [
    "SAND", "MANA", "AXS", "GALA", "IMX", "APE", "ENJ", "CHZ", "RON", "MAGIC", "ALICE",
  ],
  "Storage / Infra": [
    "FIL", "AR", "STORJ", "GRT", "ANKR", "BAT", "BAND",
  ],
  "RWA": [
    "ONDO", "PAXG", "POLYX", "CFG", "LINK",
  ],
  "New L1": [
    "SUI", "APT", "TIA", "SEI", "ARB", "OP", "STRK", "MANTA", "ZK", "BLAST", "MONAD",
  ],
  "Other": [
    "ZEC", "EIGEN", "VIRTUAL", "AIXBT", "WLFI",
  ],
};

/* ───────────── Component ───────────── */

export function AIRiskSummary() {
  const [symbol, setSymbol] = useState("BTC");
  const [context, setContext] = useState("");

  const summaryFn = useServerFn(getAIRiskSummary);
  const m = useMutation({
    mutationFn: (payload: { symbol: string; context: string }) =>
      summaryFn({ data: payload }),
  });

  function generate() {
    m.mutate({ symbol, context });
  }

  const isPending = m.isPending;
  const result = m.data;
  const errorMsg = m.isError
    ? (m.error as Error).message
    : result && !result.ok
      ? result.error
      : null;

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            AI Risk Summary
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            AI Gateway · Lovable AI
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex gap-2">
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            disabled={isPending}
            className="flex-1 rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          >
            {Object.entries(WATCHLIST_CATEGORIES).map(([category, symbols]) => (
              <optgroup key={category} label={category}>
                {symbols.map((s) => (
                  <option key={`${category}-${s}`} value={s}>
                    {s}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <button
            onClick={generate}
            disabled={isPending}
            className="flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Analyzing…
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                Generate
              </>
            )}
          </button>
        </div>

        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          disabled={isPending}
          placeholder="Optional market context (e.g. 'RSI 72, whale accumulation detected in last 6h, funding rate negative')…"
          rows={3}
          className="w-full resize-none rounded-md border border-border bg-surface-2 px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
      </div>

      {result?.ok && (
        <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-xs font-semibold text-accent">
              {result.symbol} · Risk Summary
            </span>
            <span className="text-[10px] text-muted-foreground">
              {new Date(result.generatedAt).toLocaleTimeString()}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {result.summary}
          </p>
          <p className="mt-2 text-[10px] text-muted-foreground">Model: {result.model}</p>
        </div>
      )}

      {errorMsg && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
          <div>
            <p className="text-xs font-semibold text-destructive">
              Failed to generate summary
            </p>
            <p className="mt-0.5 break-words font-mono text-[10px] text-destructive/80">
              {errorMsg}
            </p>
          </div>
        </div>
      )}

      {isPending && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-2 p-3">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <p className="text-xs text-muted-foreground">
            Generating AI risk summary for {symbol}… (this takes ~3-10s)
          </p>
        </div>
      )}

      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
        Powered by Lovable AI Gateway
      </p>
    </section>
  );
}

export default AIRiskSummary;
