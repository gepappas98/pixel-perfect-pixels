"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, Globe2, TrendingDown, TrendingUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { CmcResearchOutcomePanel } from "@/components/trading/CmcResearchOutcomePanel";

type CmcMacro = {
  captured_at: string;
  btc_dominance: number | null;
  eth_dominance: number | null;
  total_mcap: number | null;
  total_volume_24h: number | null;
  fg_value: number | null;
  fg_classification: string | null;
  fg_observed_at: string | null;
  altcoin_season_value: number | null;
  altcoin_season_label: string | null;
  mcap_change_pct: number | null;
  mcap_change_window_minutes: number | null;
  dominance_regime: string;
  market_structure_tag: string;
  source_status: Record<string, { ok?: boolean; status?: number | null; error?: string | null }>;
};

type CmcListing = {
  name: string;
  symbol: string;
  slug?: string | null;
  cmc_rank: number | null;
  price_usd: number | null;
  volume_24h_usd: number | null;
  market_cap_usd: number | null;
  percent_change_1h: number | null;
  percent_change_24h: number | null;
  percent_change_7d: number | null;
  circulating_supply?: number | null;
  total_supply?: number | null;
  max_supply?: number | null;
  tags?: string[] | null;
  captured_at?: string;
};

function compactUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2,
  }).format(value);
}

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function freshness(value?: string | null): string {
  if (!value) return "time unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "time unavailable";
  return date.toLocaleString();
}

function label(value?: string | null): string {
  return (value ?? "unknown").replaceAll("_", " ");
}

export function CmcMarketStructurePanel() {
  const macro = useQuery({
    queryKey: ["cmc-macro-latest"],
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)("cmc_macro_snapshots")
        .select("captured_at,btc_dominance,eth_dominance,total_mcap,total_volume_24h,fg_value,fg_classification,fg_observed_at,altcoin_season_value,altcoin_season_label,mcap_change_pct,mcap_change_window_minutes,dominance_regime,market_structure_tag,source_status")
        .order("captured_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data as CmcMacro | null;
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });

  const alternativeFg = useQuery({
    queryKey: ["alternative-me-fg-latest"],
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)("market_sentiment_snapshots")
        .select("observed_at,value,classification,source")
        .eq("source", "alternative.me-fear-greed")
        .order("observed_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data as { observed_at: string; value: number; classification: string; source: string } | null;
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });

  const listings = useQuery({
    queryKey: ["cmc-listings-latest"],
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)("cmc_listing_snapshots")
        .select("name,symbol,slug,cmc_rank,price_usd,volume_24h_usd,market_cap_usd,percent_change_1h,percent_change_24h,percent_change_7d,circulating_supply,total_supply,max_supply,tags,captured_at")
        .order("captured_at", { ascending: false }).order("cmc_rank", { ascending: true })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as CmcListing[];
    },
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    retry: 1,
  });

  const row = macro.data;
  const listingUniverse = listings.data ?? [];
  const largestMoves = [...listingUniverse]
    .filter((coin) => coin.percent_change_24h != null && Number.isFinite(coin.percent_change_24h))
    .sort((a, b) => Math.abs(b.percent_change_24h ?? 0) - Math.abs(a.percent_change_24h ?? 0))
    .slice(0, 20);
  const sources = row?.source_status ?? {};
  const sourceCount = ["global_metrics", "fear_and_greed", "altcoin_season"]
    .filter((key) => sources[key]?.ok === true).length;
  const macroPending = macro.isLoading || (!row && !!macro.error);
  const listingsPending = listings.isLoading || (!listings.data?.length && !!listings.error);

  return (
    <section className="panel lg:col-span-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <Globe2 className="h-4 w-4 text-accent" />
            CMC Market Structure
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Keyless · CMC research signals · paper-only · no live orders
          </p>
        </div>
        <a href="https://coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api/" target="_blank" rel="noreferrer"
          className="text-[10px] text-accent underline underline-offset-2">
          CMC Keyless docs
        </a>
      </div>

      {!row ? (
        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          {macroPending
            ? "CMC macro snapshot is not available yet. The migration and Edge Function must be deployed before data appears."
            : "Waiting for the first successful CMC macro snapshot."}
        </div>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="rounded-md border border-border/70 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total market cap</p>
              <p className="mt-1 font-mono text-sm">{compactUsd(row.total_mcap)}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">Δ prior snapshot: {pct(row.mcap_change_pct)}{row.mcap_change_window_minutes == null ? "" : ` · ${Math.round(row.mcap_change_window_minutes)}m`}</p>
            </div>
            <div className="rounded-md border border-border/70 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">BTC dominance</p>
              <p className="mt-1 font-mono text-sm">{row.btc_dominance == null ? "—" : `${row.btc_dominance.toFixed(2)}%`}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">ETH {row.eth_dominance == null ? "—" : `${row.eth_dominance.toFixed(2)}%`}</p>
            </div>
            <div className="rounded-md border border-border/70 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">CMC Fear & Greed</p>
              <p className="mt-1 font-mono text-sm">{row.fg_value == null ? "—" : `${row.fg_value}/100`}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{row.fg_classification ?? "No classification"}</p>
              <p className="mt-2 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
                Alternative.me: {alternativeFg.data?.value == null ? "—" : `${alternativeFg.data.value}/100`}
                {alternativeFg.data?.classification ? ` · ${alternativeFg.data.classification}` : ""}
              </p>
              {row.fg_value != null && alternativeFg.data?.value != null && (
                <p className={`mt-1 text-[10px] font-medium ${Math.abs(row.fg_value - alternativeFg.data.value) >= 20 ? "text-amber-500" : "text-muted-foreground"}`}>
                  Δ {Math.abs(row.fg_value - alternativeFg.data.value)} pts
                  {Math.abs(row.fg_value - alternativeFg.data.value) >= 20 ? " · divergence" : " · comparison"}
                </p>
              )}
              <p className="mt-1 text-[9px] text-muted-foreground">
                Alt.me captured: {alternativeFg.data?.observed_at ? freshness(alternativeFg.data.observed_at) : "not available"}
              </p>
            </div>
            <div className="rounded-md border border-border/70 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Altcoin season</p>
              <p className="mt-1 font-mono text-sm">{row.altcoin_season_value == null ? "—" : `${row.altcoin_season_value}/100`}</p>
              <p className="mt-1 text-[10px] capitalize text-muted-foreground">{label(row.market_structure_tag)}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><Activity className="h-3 w-3" /> 24h global volume: {compactUsd(row.total_volume_24h)}</span>
            <span>Macro snapshot: {freshness(row.captured_at)} · Sources OK: {sourceCount}/3</span>
          </div>
          {sourceCount < 3 && (
            <p className="mt-2 text-[10px] text-amber-500">
              Partial source coverage. Missing CMC fields remain null and are not treated as neutral or bullish.
            </p>
          )}
        </>
      )}

      <div className="mt-4 border-t border-border/70 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">CMC available universe · largest 24h moves</h3>
          <span className="text-[10px] text-muted-foreground">{listingUniverse.length.toLocaleString()} listings loaded · research only</span>
        </div>
        {listingsPending ? (
          <p className="text-xs text-muted-foreground">Listings snapshot is not available yet; deploy the listings migration and sync first.</p>
        ) : !listings.data?.length ? (
          <p className="text-xs text-muted-foreground">Waiting for the first successful listings snapshot.</p>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr><th className="pb-2 pr-3">Rank / Asset</th><th className="pb-2 pr-3 text-right">Price</th><th className="pb-2 pr-3 text-right">24h volume</th><th className="pb-2 pr-3 text-right">Vol / cap</th><th className="pb-2 pr-3 text-right">1h</th><th className="pb-2 pr-3 text-right">24h</th><th className="pb-2 pr-3 text-right">7d</th><th className="pb-2 pr-3">Momentum</th><th className="pb-2">CMC tags</th></tr>
              </thead>
              <tbody>
                {largestMoves.map((coin, index) => {
                  const changeClass = (change: number | null) => change == null ? "text-muted-foreground" : change > 0 ? "text-bull" : change < 0 ? "text-bear" : "text-muted-foreground";
                  const tags = (coin.tags ?? []).slice(0, 2);
                  const changes = [coin.percent_change_1h, coin.percent_change_24h, coin.percent_change_7d];
                  const momentum = changes.every((value) => value != null && value > 0) ? "aligned ↑"
                    : changes.every((value) => value != null && value < 0) ? "aligned ↓"
                    : coin.percent_change_24h != null && coin.percent_change_24h > 0 && coin.percent_change_1h != null && coin.percent_change_1h < 0 ? "cooling"
                    : coin.percent_change_24h != null && coin.percent_change_24h < 0 && coin.percent_change_1h != null && coin.percent_change_1h > 0 ? "bounce"
                    : "mixed";
                  const volumeCap = coin.volume_24h_usd != null && coin.market_cap_usd != null && coin.market_cap_usd > 0
                    ? coin.volume_24h_usd / coin.market_cap_usd * 100 : null;
                  return (
                    <tr key={`${coin.symbol}-${coin.cmc_rank ?? index}`} className="border-t border-border/50">
                      <td className="py-2 pr-3"><span className="mr-2 text-muted-foreground">#{coin.cmc_rank ?? "—"}</span><span className="font-medium">{coin.symbol}</span><span className="ml-2 text-muted-foreground">{coin.name}</span></td>
                      <td className="py-2 pr-3 text-right font-mono">{coin.price_usd == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 6 }).format(coin.price_usd)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{compactUsd(coin.volume_24h_usd)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{compactUsd(coin.market_cap_usd)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{volumeCap == null ? "—" : `${volumeCap.toFixed(2)}%`}</td>
                      <td className={`py-2 pr-3 text-right font-mono ${changeClass(coin.percent_change_1h)}`}>{pct(coin.percent_change_1h)}</td>
                      <td className={`py-2 pr-3 text-right font-mono ${changeClass(coin.percent_change_24h)}`}><span className="inline-flex items-center justify-end gap-1">{coin.percent_change_24h != null && (coin.percent_change_24h > 0 ? <TrendingUp className="h-3 w-3" /> : coin.percent_change_24h < 0 ? <TrendingDown className="h-3 w-3" /> : null)}{pct(coin.percent_change_24h)}</span></td>
                      <td className={`py-2 pr-3 text-right font-mono ${changeClass(coin.percent_change_7d)}`}>{pct(coin.percent_change_7d)}</td>
                      <td className={`py-2 pr-3 text-[10px] font-medium ${momentum === "aligned ↑" ? "text-bull" : momentum === "aligned ↓" ? "text-bear" : "text-muted-foreground"}`}>{momentum}</td>
                      <td className="py-2 text-[10px] text-muted-foreground">{tags.length ? tags.join(", ") : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">Sorted by absolute 24h move, not by expected return. CMC price/volume are context only; tradability still requires independent Binance Spot and RevolutX checks.</p>
          </>
        )}
      </div>
      <CmcResearchOutcomePanel />
      <p className="mt-3 text-[10px] text-muted-foreground">
        Last CMC update times can differ from capture times. CMC market data is contextual only; Binance remains the execution-price source and existing whale/MTF/Council rules remain unchanged.
      </p>
    </section>
  );
}
