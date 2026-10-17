import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const supabase = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const num = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => a.length < 2 ? 0 : Math.sqrt(avg(a.map(x => (x - avg(a)) ** 2)));
const z = (x: number, a: number[]) => { const s = sd(a); return a.length >= 8 && s > 1e-9 ? (x - avg(a)) / s : null; };
const normState = (s: string) => s.toLowerCase().includes("distribution") ? "distribution" : s.toLowerCase().includes("accumulation") ? "accumulation" : "neutral";

Deno.serve(async (req) => {
 if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
 if (req.method !== "POST") return new Response("POST required", { status: 405, headers: corsHeaders });
 try {
  const db = supabase(), now = new Date(), iso = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const { data: obs, error: obsErr } = await db.from("early_entry_regime_observations").select("id,observed_at,market_regime,whale_flow_state,technicals_1h_bullish,technicals_1h_bearish,details,transition_state").gte("observed_at", iso(86400000)).order("observed_at", { ascending: false }).limit(150);
  if (obsErr) throw obsErr;
  const history = obs ?? [], prev = history[0], prev2 = history[1], prev3 = history[2];
  const { data: whaleRows, error: whaleErr } = await db.from("whale_alerts").select("direction,usd_value,created_at").gte("created_at", iso(3600000)).limit(3000);
  if (whaleErr) throw whaleErr;
  let buyUsd = 0, sellUsd = 0;
  for (const r of whaleRows ?? []) { if (r.direction === "accumulation") buyUsd += Math.max(0, num(r.usd_value)); if (r.direction === "distribution") sellUsd += Math.max(0, num(r.usd_value)); }
  const whaleNet = buyUsd + sellUsd > 0 ? (buyUsd - sellUsd) / (buyUsd + sellUsd) : 0;
  const whaleState = whaleNet >= 0.15 ? "accumulation" : whaleNet <= -0.15 ? "distribution" : "neutral";
  const whaleDelta = whaleNet - num(prev?.details?.whale_net);
  const transitionSequence = normState(String(prev3?.whale_flow_state ?? "")) === "distribution" && normState(String(prev2?.whale_flow_state ?? "")) === "neutral" && whaleState === "accumulation";
  const whaleTurn = transitionSequence || (whaleDelta > 0 && whaleState !== "distribution" && ["distribution","neutral"].includes(normState(String(prev?.whale_flow_state ?? ""))));

  const { data: candleRows, error: candleErr } = await db.from("market_candles").select("symbol,timeframe,close_time,quote_volume,taker_buy_quote_volume").eq("timeframe","5m").gte("close_time",iso(15*60000)).order("close_time",{ascending:false}).limit(600);
  if (candleErr) throw candleErr;
  const latestCandles = new Map<string, any>();
  for (const c of candleRows ?? []) if (!latestCandles.has(String(c.symbol).toUpperCase())) latestCandles.set(String(c.symbol).toUpperCase(),c);
  const totalQuote = [...latestCandles.values()].reduce((s,c)=>s+Math.max(0,num(c.quote_volume)),0);
  const totalTakerQuote = [...latestCandles.values()].reduce((s,c)=>s+Math.max(0,num(c.taker_buy_quote_volume)),0);
  const takerImbalance = totalQuote > 0 ? 2*totalTakerQuote/totalQuote-1 : 0;

  // Adaptive thresholds use the experiment's own past 10-minute aggregate observations,
  // not a cross-sectional snapshot or a globally fixed threshold.
  const { data: variantHistoryRows, error: variantHistoryErr } = await db.from("early_entry_variant_decisions")
    .select("observed_at,metrics").eq("variant","C_ADAPTIVE_REVERSAL")
    .gte("observed_at",iso(24*60*60*1000)).order("observed_at",{ascending:false}).limit(150);
  if (variantHistoryErr) throw variantHistoryErr;
  const adaptiveHistory = (variantHistoryRows ?? []).slice(0, 100);
  const historicalImbalances = adaptiveHistory.map((r:any)=>r.metrics?.taker_buy_imbalance_5m)
    .filter((v:unknown)=>v!==null&&v!==undefined).map(num);
  const historicalWhaleDeltas = adaptiveHistory.map((r:any)=>r.metrics?.whale_delta)
    .filter((v:unknown)=>v!==null&&v!==undefined).map(num);
  const { data: indRows, error: indErr } = await db.from("indicator_snapshots").select("symbol,timeframe,signal,created_at,price").eq("timeframe","1h").gte("created_at",iso(3600000)).order("created_at",{ascending:false}).limit(2000);
  if(indErr) throw indErr;
  const latestIndicators=new Map<string,any>();
  for(const r of indRows??[]) if(!latestIndicators.has(String(r.symbol).toUpperCase())) latestIndicators.set(String(r.symbol).toUpperCase(),r);
  let bull=0,bear=0,neutral=0;
  for(const r of latestIndicators.values()){if(String(r.signal).toLowerCase()==="bullish")bull++;else if(String(r.signal).toLowerCase()==="bearish")bear++;else neutral++;}
  const breadthImproving=!!prev && bull>num(prev.technicals_1h_bullish) && bear<=num(prev.technicals_1h_bearish), breadthDelta=bull-num(prev?.technicals_1h_bullish);

  // Council and sentiment are a +1 confluence only; neither is a mandatory entry gate.
  const {data:councilRows}=await db.from("council_signals").select("symbol,final_verdict,source_created_at").gte("source_created_at",iso(3600000)).order("source_created_at",{ascending:false}).limit(500);
  const councilLatest=new Map<string,string>();
  for(const r of councilRows??[])if(!councilLatest.has(String(r.symbol).toUpperCase()))councilLatest.set(String(r.symbol).toUpperCase(),String(r.final_verdict).toUpperCase());
  const councilBuy=[...councilLatest.values()].filter(v=>v==="BUY").length,councilSell=[...councilLatest.values()].filter(v=>v==="SELL").length;
  const {data:sentimentRows}=await db.from("asset_sentiment_snapshots").select("asset,sentiment_score,observed_at").gte("observed_at",iso(3600000)).order("observed_at",{ascending:false}).limit(500);
  const sentimentLatest=new Map<string,number>();
  for(const r of sentimentRows??[])if(!sentimentLatest.has(String(r.asset).toUpperCase()))sentimentLatest.set(String(r.asset).toUpperCase(),num(r.sentiment_score));
  const positiveSentiment=[...sentimentLatest.values()].filter(v=>v>0).length;
  const confluencePlusOne=councilBuy>councilSell || positiveSentiment>sentimentLatest.size/2;
  const confluence={plus_one:confluencePlusOne,council_buy:councilBuy,council_sell:councilSell,sentiment_assets:sentimentLatest.size,positive_sentiment_assets:positiveSentiment};

  const whaleZ=z(whaleDelta,historicalWhaleDeltas);
  const adaptiveTakerZ=z(takerImbalance,historicalImbalances);
  const warmup=historicalImbalances.length<8 || historicalWhaleDeltas.length<8;
  const {data:priceRows}=await db.from("asset_price_snapshots").select("asset,price,created_at").gte("created_at",iso(20*60000)).order("created_at",{ascending:false}).limit(500);
  const priceMap=new Map<string,number>();
  for(const r of priceRows??[])if(!priceMap.has(String(r.asset).toUpperCase())&&num(r.price)>0)priceMap.set(String(r.asset).toUpperCase(),num(r.price));

  const bEligible=whaleTurn&&takerImbalance>=0.03&&latestCandles.size>=10&&breadthImproving;
  const cEligible=whaleTurn&&takerImbalance>0&&latestCandles.size>=10&&breadthDelta>0&&(warmup?takerImbalance>=0.03:((whaleZ??-99)>=0.5&&(adaptiveTakerZ??-99)>=0.5));
  const bucket=Math.floor(now.getTime()/600000), outcomes:any[]=[];
  const variants=[
   {id:"A_CURRENT",source:"early_entry_regime",eligible:String(prev?.transition_state??"")==="EARLY_ENTRY_ACTIVE",reason:"A — CURRENT EARLY ENTRY: existing strict regime-transition baseline; existing function owns baseline trade opens."},
   {id:"B_EARLY_REVERSAL",source:"early_entry_b_reversal",eligible:bEligible,reason:"B — EARLY REVERSAL: whale-flow turn/acceleration + positive taker-buy + initial improving 1h breadth; no bullish-regime requirement."},
   {id:"C_ADAPTIVE_REVERSAL",source:"early_entry_c_adaptive",eligible:cEligible,reason:"C — ADAPTIVE REVERSAL: reversal gate normalized to recent whale/taker-buy history; warm-up temporarily uses B-style taker threshold."}
  ];
  for(const v of variants){
   const metrics={whale_state:whaleState,whale_net:whaleNet,whale_delta:whaleDelta,whale_turn:whaleTurn,transition_sequence_distribution_neutral_accumulation:transitionSequence,taker_buy_imbalance_5m:takerImbalance,taker_buy_z:adaptiveTakerZ,whale_delta_z:whaleZ,candle_symbols:latestCandles.size,breadth_1h:{bullish:bull,bearish:bear,neutral,delta_bullish:breadthDelta,improving:breadthImproving},regime_at_signal:String(prev?.market_regime??"unknown"),confluence,adaptive_warmup:warmup,research_only:true,live_orders_submitted:0};
   if(v.id==="A_CURRENT"){
    // A is the already-running strict baseline. Observe its actual paper trades;
    // never open a second A position from this evaluator.
    const {data:baselineTrades,error:baselineErr}=await db.from("trades").select("id,symbol,created_at,entry_metadata")
      .eq("entry_source","early_entry_regime").eq("mode","paper").gte("created_at",iso(10*60000))
      .order("created_at",{ascending:false}).limit(100);
    if(baselineErr)throw baselineErr;
    let recorded=0;
    for(const t of baselineTrades??[]){
      const key=`A_CURRENT:BASELINE_TRADE:${t.id}`;
      const {error}=await db.from("early_entry_variant_decisions").insert({
        variant:"A_CURRENT",symbol:t.symbol,decision:"PAPER_OPEN",
        reason:"A — CURRENT EARLY ENTRY: existing strict baseline opened this paper trade.",
        decision_key:key,metrics:{...metrics,baseline_trade_created_at:t.created_at,baseline_entry_metadata:t.entry_metadata??{}},trade_id:t.id
      });
      if(error&&!String(error.message).includes("duplicate key"))throw error;
      recorded++;
    }
    if(recorded===0){
      const key=`A_CURRENT:GLOBAL:${bucket}`;
      const {error}=await db.from("early_entry_variant_decisions").insert({
        variant:"A_CURRENT",decision:"NO_ENTRY",reason:"A — CURRENT EARLY ENTRY: no baseline paper trade opened during this evaluation window.",
        decision_key:key,metrics
      });
      if(error&&!String(error.message).includes("duplicate key"))throw error;
    }
    outcomes.push({variant:"A_CURRENT",opened:0,baseline_trades_observed:recorded,eligible:recorded>0});
    continue;
   }
   if(!v.eligible){const key=`${v.id}:GLOBAL:${bucket}`;const {error}=await db.from("early_entry_variant_decisions").insert({variant:v.id,decision:"NO_ENTRY",reason:"Core gate not met. "+v.reason,decision_key:key,metrics});if(error&&!String(error.message).includes("duplicate key"))throw error;outcomes.push({variant:v.id,opened:0,eligible:false});continue;}
   const assetHasConfluence=(symbol:string)=>{const base=symbol.endsWith("USDT")?symbol.slice(0,-4):symbol;return councilLatest.get(symbol)==="BUY"||councilLatest.get(base)==="BUY"||num(sentimentLatest.get(base))>0;};
   const candidates=[...latestIndicators.entries()].filter(([symbol,r])=>{const c=latestCandles.get(symbol),base=symbol.endsWith("USDT")?symbol.slice(0,-4):symbol;return String(r.signal).toLowerCase()==="bullish"&&!!c&&num(c.quote_volume)>0&&(2*num(c.taker_buy_quote_volume)/num(c.quote_volume)-1)>0&&priceMap.has(base);})
    .sort((a,b)=>Number(assetHasConfluence(b[0]))-Number(assetHasConfluence(a[0]))
      || (2*num(latestCandles.get(b[0])?.taker_buy_quote_volume)/Math.max(1,num(latestCandles.get(b[0])?.quote_volume))-1)
       - (2*num(latestCandles.get(a[0])?.taker_buy_quote_volume)/Math.max(1,num(latestCandles.get(a[0])?.quote_volume))-1))
    .slice(0,20);
   let opened=0;
   for(const [symbol,indicator] of candidates){
    const key=`${v.id}:${symbol}:${bucket}`,{data:prior}=await db.from("early_entry_variant_decisions").select("id").eq("decision_key",key).limit(1).maybeSingle();
    if(prior)continue;
    const base=symbol.endsWith("USDT")?symbol.slice(0,-4):symbol,price=priceMap.get(base)??num(indicator.price);if(!(price>0))continue;
    const notional=1000,candle=latestCandles.get(symbol);
    const {data:trade,error:tradeErr}=await db.from("trades").insert({composite_signal_id:null,symbol:base,side:"buy",quantity:notional/price,entry_price:price,stop_loss:price*0.97,take_profit:price*1.06,mode:"paper",status:"open",entry_fee:notional*0.0005,exit_fee:0,total_fees:notional*0.0005,regime_label:String(prev?.market_regime??"unknown"),market_session:null,exchange_order_id:null,source_tags:["paper","early-entry-variant",v.id.toLowerCase(),"spot-long-only","research-only"],entry_source:v.source,entry_metadata:{strategy:v.id==="B_EARLY_REVERSAL"?"early-entry-b-reversal-v1":"early-entry-c-adaptive-v1",strategy_version:1,entry_path:"early-entry-variants",research_only:true,variant:v.id,variant_label:v.id==="A_CURRENT"?"A — CURRENT EARLY ENTRY":v.id==="B_EARLY_REVERSAL"?"B — EARLY REVERSAL":"C — ADAPTIVE REVERSAL",entry_reason:v.reason,signal_key:key,...metrics,symbol,asset_confluence_plus_one:assetHasConfluence(symbol),asset_council_verdict:councilLatest.get(symbol)??councilLatest.get(base)??null,asset_sentiment_score:sentimentLatest.get(base)??null,asset_taker_buy_imbalance:2*num(candle.taker_buy_quote_volume)/num(candle.quote_volume),entry_price_source:"asset_price_snapshots",notional_usd:notional}}).select("id").single();
    if(tradeErr)throw tradeErr;
    const {error:decisionErr}=await db.from("early_entry_variant_decisions").insert({variant:v.id,symbol:base,decision:"PAPER_OPEN",reason:v.reason,decision_key:key,metrics,trade_id:trade.id});if(decisionErr)throw decisionErr;opened++;
   }
   if(candidates.length===0){const key=`${v.id}:GLOBAL:${bucket}`;const {error}=await db.from("early_entry_variant_decisions").insert({variant:v.id,decision:"ELIGIBLE_NO_ASSET",reason:"Market gate met, but no per-asset bullish 1h + positive taker-buy candidate with a fresh price.",decision_key:key,metrics});if(error&&!String(error.message).includes("duplicate key"))throw error;}
   outcomes.push({variant:v.id,opened,eligible:true});
  }
  return new Response(JSON.stringify({status:"observed",variants:outcomes,whale_state:whaleState,whale_turn:whaleTurn,transition_sequence:transitionSequence,taker_buy_imbalance_5m:takerImbalance,breadth:{bullish:bull,bearish:bear,neutral,improving:breadthImproving},confluence_plus_one:confluencePlusOne,adaptive_warmup:warmup,live_orders_submitted:0}),{headers:{...corsHeaders,"Content-Type":"application/json"}});
 }catch(e){console.error("[EARLY_ENTRY_VARIANTS]",e);return new Response(JSON.stringify({error:String(e)}),{status:500,headers:{...corsHeaders,"Content-Type":"application/json"}});}
});
