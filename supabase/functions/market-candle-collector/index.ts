import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const supabase = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
Deno.serve(async (req) => {
 if (req.method === "OPTIONS") return new Response("ok", {headers:corsHeaders});
 if (req.method !== "POST") return new Response("POST required",{status:405,headers:corsHeaders});
 try {
  const db=supabase();
  const {data:symbolsRows,error:symbolsError}=await db.from("indicator_snapshots").select("symbol").eq("timeframe","5m").gte("created_at",new Date(Date.now()-3600000).toISOString()).order("created_at",{ascending:false}).limit(500);
  if(symbolsError) throw symbolsError;
  const symbols=[...new Set((symbolsRows??[]).map(r=>String(r.symbol??"").toUpperCase()).filter(s=>/^[A-Z0-9]{2,20}USDT$/.test(s)))];
  const intervals=["5m","15m"] as const; let fetched=0,stored=0,failed=0;
  const errors:Array<{symbol:string;timeframe:string;error:string}>=[];
  const tasks=symbols.flatMap(symbol=>intervals.map(timeframe=>({symbol,timeframe})));
  for(let i=0;i<tasks.length;i+=8){
   const results=await Promise.all(tasks.slice(i,i+8).map(async({symbol,timeframe})=>{
    let lastError="Binance endpoints unavailable";
    for(const host of ["https://api.binance.com","https://data-api.binance.vision","https://api1.binance.com"]){
     try{
      const response=await fetch(`${host}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${timeframe}&limit=3`,{signal:AbortSignal.timeout(7000)});
      if(!response.ok){lastError=`HTTP ${response.status}`;continue;}
      const rows=await response.json() as unknown[][];
      const candles=rows.map(r=>({symbol,timeframe,open_time:new Date(Number(r[0])).toISOString(),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),base_volume:Number(r[5]),close_time:new Date(Number(r[6])).toISOString(),quote_volume:Number(r[7]),trade_count:Number(r[8]),taker_buy_base_volume:Number(r[9]),taker_buy_quote_volume:Number(r[10]),source:"binance-spot-klines",captured_at:new Date().toISOString()})).filter(c=>[c.open,c.high,c.low,c.close,c.base_volume,c.quote_volume,c.taker_buy_base_volume,c.taker_buy_quote_volume].every(Number.isFinite));
      if(!candles.length){lastError="No valid candle rows";continue;}
      const {error}=await db.from("market_candles").upsert(candles,{onConflict:"symbol,timeframe,open_time"});
      if(error) throw error;
      return {fetched:candles.length,stored:candles.length,failed:0};
     }catch(e){lastError=String(e);}
    }
    return {fetched:0,stored:0,failed:1,error:{symbol,timeframe,error:lastError}};
   }));
   for(const r of results){fetched+=r.fetched;stored+=r.stored;failed+=r.failed;if(r.error)errors.push(r.error);}
  }
  return new Response(JSON.stringify({status:failed?(stored?"partial":"unavailable"):"ok",assets_checked:symbols.length,requests:tasks.length,fetched,stored,failed,timeframes:intervals,source:"binance-spot-klines",errors:errors.slice(0,20),live_orders_submitted:0}),{headers:{...corsHeaders,"Content-Type":"application/json"}});
 }catch(error){console.error("[MARKET-CANDLE-COLLECTOR]",error);return new Response(JSON.stringify({error:String(error)}),{status:500,headers:{...corsHeaders,"Content-Type":"application/json"} });}
});