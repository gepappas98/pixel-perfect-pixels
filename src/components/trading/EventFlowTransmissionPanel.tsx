import { useLiveTable } from "@/hooks/useLiveTable";

type Transmission = {
  id: string; asset: string; source_kind: "sentiment"|"news"; event_at: string;
  shock_score: number; event_sentiment: number; flow_delta_15m: number|null;
  flow_delta_30m: number|null; flow_acceleration: number|null;
  price_return_15m: number|null; price_return_1h: number|null;
  price_return_4h: number|null; transmission_class: string; data_quality: string;
};

type SentimentSnapshot = { asset:string; observed_at:string; shock_score:number; sentiment_score:number; mention_count:number; source:string; };
type MarketSentiment = { observed_at:string; source:string; value:number; classification:string; };
type NewsEvent = { asset:string; event_at:string; shock_score:number; title:string; source:string; sentiment_label:string; };
type PaperDecision = { asset:string; observed_at:string; status:string; reason:string; sentiment_score:number|null; sentiment_confidence:number|null; flow_score:number|null; flow_state:string|null; price:number|null; };

const pct=(v:number|null)=>v==null?"—":`${v>=0?"+":""}${v.toFixed(2)}%`;
const ago=(iso:string)=>{const m=Math.max(0,Math.floor((Date.now()-new Date(iso).getTime())/60000));return m<60?`${m}m`:m<1440?`${Math.floor(m/60)}h`:`${Math.floor(m/1440)}d`;};

export function EventFlowTransmissionPanel(){
  const {rows:tx}=useLiveTable<Transmission>("event_flow_transmissions",20,"event_at");
  const {rows:sentiment}=useLiveTable<SentimentSnapshot>("asset_sentiment_snapshots",30,"observed_at");
  const {rows:news}=useLiveTable<NewsEvent>("asset_news_events",20,"event_at");
  const {rows:marketSentiment}=useLiveTable<MarketSentiment>("market_sentiment_snapshots",1,"observed_at");
  const {rows:paperDecisions}=useLiveTable<PaperDecision>("event_flow_paper_decisions",30,"observed_at");
  const latestMarketSentiment=marketSentiment[0];
  const opened=paperDecisions.filter(x=>x.status==="OPENED").length;
  const alreadyOpen=paperDecisions.filter(x=>x.status==="ALREADY_OPEN").length;
  const publicSentimentRows=sentiment.filter(x=>x.source==="rss-news-consensus");
  const publicSentimentAssetCount=new Set(publicSentimentRows.map(x=>x.asset)).size;
  const latestPublicSentiment=publicSentimentRows.reduce((latest,row)=>!latest||row.observed_at>latest.observed_at?row:latest,undefined as SentimentSnapshot|undefined);
  const complete=tx.filter(x=>x.data_quality==="complete").length;
  const followed=tx.filter(x=>x.transmission_class==="flow_followed").length;
  const diverged=tx.filter(x=>x.transmission_class==="flow_diverged").length;
  const latestShock=[...sentiment].sort((a,b)=>Number(b.shock_score)-Number(a.shock_score))[0];

  return <section className="panel lg:col-span-2">
    <div className="flex items-center justify-between gap-2">
      <div>
        <h2 className="panel-title">Event → Flow Lab</h2>
        <p className="text-[9px] font-mono text-muted-foreground">PAPER OPEN strategy · research-only · live orders disabled</p>
      </div>
      <span className="rounded border border-border bg-muted px-2 py-1 text-[9px] font-mono text-muted-foreground">
        {tx.length} events
      </span>
    </div>

    <div className="mt-3 rounded border border-bull/40 bg-bull/5 p-2">
      <div className="flex items-center justify-between gap-2 text-[10px] font-mono"><span className="font-semibold">Paper OPEN status</span><span className="text-bull">ACTIVE · SPOT LONG-ONLY</span></div>
      <div className="mt-1 text-[9px] font-mono text-muted-foreground">Requires fresh RSS sentiment ≥ +0.15, confidence ≥ 0.45, Whale Flow accumulation ≥ +0.10 and fresh Binance Spot price. $1,000 notional · TP +4% · SL −3% · 15m cooldown. Existing signal strategy and live execution are unchanged.</div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 text-[9px] font-mono">
        <div className="rounded bg-background/70 p-1.5"><div className="text-muted-foreground">Opened this scan</div><div className="mt-0.5 font-semibold">{opened}</div></div>
        <div className="rounded bg-background/70 p-1.5"><div className="text-muted-foreground">Already open</div><div className="mt-0.5 font-semibold">{alreadyOpen}</div></div>
        <div className="rounded bg-background/70 p-1.5"><div className="text-muted-foreground">Assets checked</div><div className="mt-0.5 font-semibold">{paperDecisions.length}</div></div>
      </div>
      {paperDecisions.length>0 ? <div className="mt-2 space-y-1">{paperDecisions.slice(0,8).map(x=><div key={x.asset} className="flex items-center justify-between gap-2 border-t border-border/40 pt-1.5 text-[9px] font-mono"><div className="min-w-0"><span className="font-semibold">{x.asset}</span>{" · "}<span className={x.status==="OPENED"||x.status==="ALREADY_OPEN"?"text-bull":x.status==="OPEN_FAILED"?"text-bear":"text-muted-foreground"}>{x.status}</span><div className="truncate text-muted-foreground">{x.reason}</div></div><div className="shrink-0 text-right text-muted-foreground">S {x.sentiment_score==null?"—":Number(x.sentiment_score).toFixed(2)} · F {x.flow_score==null?"—":Number(x.flow_score).toFixed(2)}<div>{ago(x.observed_at)} ago</div></div></div>)}</div> : <div className="mt-2 text-[9px] font-mono text-muted-foreground">Waiting for first scheduled paper scan; missing data never counts as positive.</div>}
    </div>

    <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-1.5 text-[9px] font-mono">
      <div className="rounded bg-muted/30 p-1.5"><div className="text-muted-foreground">Asset sentiment</div><div className="mt-0.5">{sentiment.length}</div></div>
      <div className="rounded bg-muted/30 p-1.5"><div className="text-muted-foreground">News</div><div className="mt-0.5">{news.length}</div></div>
      <div className="rounded bg-muted/30 p-1.5"><div className="text-muted-foreground">Market F&amp;G</div><div className="mt-0.5">{latestMarketSentiment ? `${latestMarketSentiment.value}/100` : "—"}</div></div>
      <div className="rounded bg-muted/30 p-1.5"><div className="text-muted-foreground">Followed</div><div className="mt-0.5 text-bull">{followed}</div></div>
      <div className="rounded bg-muted/30 p-1.5"><div className="text-muted-foreground">Diverged</div><div className="mt-0.5 text-bear">{diverged}</div></div>
    </div>

    <div className="mt-2 rounded border border-border/60 bg-muted/20 p-2 text-[9px] font-mono">
      <div><span className="text-muted-foreground">Global market sentiment:</span>{" "}
        {latestMarketSentiment ? <><span className="font-semibold">{latestMarketSentiment.classification}</span>{" · "}<span>{Number(latestMarketSentiment.value)}/100</span>{" · "}<span>{ago(latestMarketSentiment.observed_at)} ago</span></> : <span>unavailable — waiting for Alternative.me data</span>}
      </div>
      <div className="mt-0.5 text-muted-foreground">Source: Alternative.me Fear &amp; Greed Index. Daily global context only, not asset-specific sentiment.</div>
      <div className="mt-0.5 text-muted-foreground">{latestPublicSentiment ? `Per-asset sentiment: RSS news consensus · ${publicSentimentAssetCount} assets in loaded snapshots · latest ${ago(latestPublicSentiment.observed_at)} ago. Coverage depends on provider responses; unavailable assets are not assigned synthetic values.` : "Per-asset RSS consensus unavailable; missing assets remain unavailable and are not assigned synthetic values."}</div>
      <div className="mt-0.5 text-muted-foreground">News events use the configured free RSS feeds and transparent keyword-based labels; global Fear &amp; Greed remains separate.</div>
    </div>

    {latestShock && <div className="mt-2 rounded border border-border/60 bg-muted/20 p-2 text-[9px] font-mono">
      <span className="text-muted-foreground">Largest current sentiment shock:</span>{" "}
      <span className="font-semibold">{latestShock.asset}</span>{" "}
      <span>{Number(latestShock.shock_score).toFixed(2)}σ</span>{" · "}
      <span>{Number(latestShock.mention_count)} mentions</span>{" · "}
      <span>{ago(latestShock.observed_at)} ago</span>
    </div>}

    {tx.length>0 ? <div className="mt-2 space-y-1">
      {tx.slice(0,8).map(x=><div key={x.id} className="flex items-center justify-between gap-2 border-t border-border/40 pt-1.5 text-[9px] font-mono">
        <div className="min-w-0">
          <span className="font-semibold">{x.asset}</span>{" "}
          <span className="text-muted-foreground">{x.source_kind}</span>{" · "}
          <span className={x.transmission_class==="flow_followed"?"text-bull":x.transmission_class==="flow_diverged"?"text-bear":"text-muted-foreground"}>{x.transmission_class}</span>
        </div>
        <div className="shrink-0 text-muted-foreground">
          F15 {x.flow_delta_15m==null?"—":`${x.flow_delta_15m>=0?"+":""}${Number(x.flow_delta_15m).toFixed(2)}`} · P1h {pct(x.price_return_1h)} · {ago(x.event_at)}
        </div>
      </div>)}
    </div> : <div className="mt-3 rounded border border-border/50 bg-muted/20 p-3 text-[9px] font-mono text-muted-foreground">
      Collecting the baseline. A transmission row appears only after a measured sentiment/news shock and enough future flow/price data.
    </div>}

    {complete>0 && <div className="mt-2 text-[8px] font-mono text-muted-foreground">
      Complete 24h observations: {complete}. Partial/developing events remain visible and are recalculated as future candles arrive.
    </div>}
  </section>;
}
