import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
function handleOptions(req:Request){return req.method==="OPTIONS"?new Response("ok",{headers:corsHeaders}):null;}
function getServiceClient(){return createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);}

const SOURCES = [
  { name: "coindesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "decrypt", url: "https://decrypt.co/feed" },
];
const POSITIVE = ["surge","rally","bullish","approval","approved","adoption","inflow","inflows","launch","launched","partnership","upgrade","growth","record","breakout","buy","accumulate","accumulation","etf","institutional","wins","positive","recovery","integrate","integration","funding","raises","raised","legal clarity"];
const NEGATIVE = ["crash","drop","plunge","bearish","rejection","rejected","outflow","outflows","hack","hacked","exploit","lawsuit","ban","banned","sell","selling","liquidation","liquidations","fraud","scam","breach","bankruptcy","loss","losses","fear","warning","downgrade","delist","delisted","attack","stolen","negative","collapse","risk"];
const ASSET_NAMES: Record<string,string[]> = {
  BTC:["bitcoin","btc"], ETH:["ethereum","ether","eth"], SOL:["solana","sol"], BNB:["binance coin","bnb"],
  XRP:["xrp","ripple"], ADA:["cardano","ada"], DOGE:["dogecoin","doge"], AVAX:["avalanche","avax"],
  NEAR:["near protocol","near"], ZEC:["zcash","zec"], UNI:["uniswap","uni"], HYPE:["hyperliquid","hype"],
  SUI:["sui"], ARB:["arbitrum","arb"], ENA:["ethena","ena"], INJ:["injective","inj"], AAVE:["aave"],
  TAO:["bittensor","tao"], LINK:["chainlink","link"], LTC:["litecoin","ltc"], WLD:["worldcoin","wld"],
  PUMP:["pump.fun","pump"], SAND:["sandbox","sand"], RAY:["raydium","ray"], ICP:["internet computer","icp"],
  TRUMP:["trump"], ONDO:["ondo"], XPL:["plasma","xpl"], PENGU:["pengu"], CRV:["curve","crv"]
};
function esc(s:string){return s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/<!\[CDATA\[|\]\]>/g,"").trim();}
function tag(block:string,name:string){const m=block.match(new RegExp("<"+name+"(?:\\s[^>]*)?>([\\s\\S]*?)</"+name+">","i"));return m?esc(m[1]!):"";}
function score(text:string){const t=text.toLowerCase();const pos=POSITIVE.reduce((n,k)=>n+(t.includes(k)?1:0),0);const neg=NEGATIVE.reduce((n,k)=>n+(t.includes(k)?1:0),0);return {pos,neg,score:Math.max(-1,Math.min(1,(pos-neg)/4))};}
function hasToken(text:string,token:string){if(token.length<=4){const re=new RegExp("(^|[^a-z0-9])"+token.replaceAll(".","\\.")+"([^a-z0-9]|$)","i");return re.test(text);}return text.toLowerCase().includes(token.toLowerCase());}
function assetsIn(text:string,assets:string[]){return assets.filter(a=>(ASSET_NAMES[a]??[a.toLowerCase()]).some(k=>hasToken(text,k)));}
async function fetchText(url:string){const r=await fetch(url,{headers:{"User-Agent":"TradingCommandCenter/1.0 research-bot"},signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error(url+" HTTP "+r.status);return await r.text();}
function parseFeed(xml:string,source:string){const blocks=[...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(item|entry)>/gi)].map(m=>m[2]!);return blocks.map(b=>({source,title:tag(b,"title"),url:tag(b,"link")||(b.match(/<link[^>]+href="([^"]+)"/i)?.[1]??""),published:tag(b,"pubDate")||tag(b,"published")||tag(b,"updated"),description:tag(b,"description")||tag(b,"summary")})).filter(x=>x.title);}
async function redditForAsset(asset:string){const q=encodeURIComponent((ASSET_NAMES[asset]??[asset])[0]!);try{return parseFeed(await fetchText("https://www.reddit.com/r/CryptoCurrency/search.rss?q="+q+"&restrict_sr=on&sort=new&t=day"),"reddit").slice(0,25);}catch{return [];}}
function eventType(text:string){const t=text.toLowerCase();if(/etf|sec|regulat|law|senate|congress|mica|ban/.test(t))return"regulation";if(/hack|exploit|breach|stolen|attack/.test(t))return"security";if(/listing|delist|exchange|binance|coinbase/.test(t))return"exchange";if(/upgrade|fork|mainnet|network/.test(t))return"network";if(/partnership|integrat|adoption/.test(t))return"adoption";if(/liquidat|funding|whale|flow/.test(t))return"market";return"other";}
async function fp(s:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");}

async function discoverAssets(db:any){
  const exchange=await fetch("https://api.binance.com/api/v3/exchangeInfo",{signal:AbortSignal.timeout(12000)});
  if(!exchange.ok)throw new Error("Binance exchangeInfo HTTP "+exchange.status);
  const exchangeJson=await exchange.json();
  const symbols=(exchangeJson.symbols??[]).filter((s:any)=>s.status==="TRADING"&&s.quoteAsset==="USDT"&&s.isSpotTradingAllowed!==false);
  const ticker=await fetch("https://api.binance.com/api/v3/ticker/24hr",{signal:AbortSignal.timeout(12000)});
  if(!ticker.ok)throw new Error("Binance ticker HTTP "+ticker.status);
  const tickers=await ticker.json();
  const tickerMap=new Map((tickers??[]).map((x:any)=>[x.symbol,x]));
  const watchlist=new Set<string>();
  const {data:wl}=await db.from("dynamic_watchlist_snapshots").select("symbols").order("computed_at",{ascending:false}).limit(1);
  for(const x of wl?.[0]?.symbols??[])watchlist.add(String(x).toUpperCase());
  const {data:wa}=await db.from("whale_alerts").select("symbol,usd_value").gte("created_at",new Date(Date.now()-7*86400000).toISOString()).limit(10000);
  const whale=new Map<string,{count:number,usd:number}>();
  for(const x of wa??[]){const a=String(x.symbol).toUpperCase();const z=whale.get(a)||{count:0,usd:0};z.count++;z.usd+=Number(x.usd_value)||0;whale.set(a,z);}
  const candidates=symbols.map((s:any)=>{const t:any=tickerMap.get(s.symbol)||{};const a=s.baseAsset.toUpperCase();const w=whale.get(a)||{count:0,usd:0};return {asset:a,binance_symbol:s.symbol,volume_24h:Number(t.volume)||0,quote_volume_24h:Number(t.quoteVolume)||0,whale_alerts_7d:w.count,whale_usd_7d:w.usd,watchlist:watchlist.has(a)};});
  const {error:refreshError}=await db.rpc("refresh_tracked_assets_dynamic",{p_candidates:candidates,p_limit:30});
  if(refreshError)throw refreshError;
  const {data:universe,error:uerr}=await db.from("tracked_assets").select("asset,binance_symbol").eq("enabled",true).order("asset");
  if(uerr)throw uerr;
  return universe??[];
}
async function collect(db:any){
  const universe=await discoverAssets(db);
  if(uerr)throw uerr;
  const assets=(universe??[]).map((x:any)=>String(x.asset)); if(!assets.length)throw new Error("tracked_assets is empty");
  const now=new Date(); const observedAt=new Date(Math.floor(now.getTime()/300000)*300000).toISOString();

  const prices=await Promise.all((universe??[]).map(async(x:any)=>{try{const r=await fetch("https://api.binance.com/api/v3/ticker/price?symbol="+encodeURIComponent(x.binance_symbol),{signal:AbortSignal.timeout(8000)});if(!r.ok)return null;const j=await r.json();const p=Number(j.price);return Number.isFinite(p)&&p>0?{asset:x.asset,observed_at:observedAt,price:p,source:"binance-spot"}:null;}catch{return null;}}));
  const flowRows=await Promise.all(assets.map(async asset=>{const {data,error}=await db.from("whale_alerts").select("direction,usd_value").eq("symbol",asset).gte("created_at",new Date(now.getTime()-900000).toISOString()).limit(500);if(error)return null;let buy=0,sell=0;for(const r of data??[]){const v=Number(r.usd_value)||0;if(r.direction==="accumulation")buy+=v;else if(r.direction==="distribution")sell+=v;}const total=buy+sell,s=total?Math.max(-1,Math.min(1,(buy-sell)/total)):0;return{asset,bucket_at:observedAt,sample_size:(data??[]).length,buy_usd:buy,sell_usd:sell,total_usd:total,flow_score:s,dominant_state:s>.05?"accumulation":s<-.05?"distribution":"neutral",source:"whale_alerts_15m"};}));

  const sentimentRows:any[]=await Promise.all(assets.map(async asset=>{const items=await redditForAsset(asset);let bull=0,bear=0,neutral=0;for(const item of items){const s=score(item.title+" "+item.description);if(s.score>.15)bull++;else if(s.score<-.15)bear++;else neutral++;}const total=items.length;return{asset,observed_at:observedAt,source:"reddit-cryptocurrency-rss",mention_count:total,unique_items:total,bullish_count:bull,bearish_count:bear,neutral_count:neutral,sentiment_score:total?(bull-bear)/total:0,raw:{items:items.slice(0,10).map(x=>({title:x.title,url:x.url,published:x.published}))}};}));

  const newsRows:any[]=[];
  for(const src of SOURCES){try{const xml=await fetchText(src.url);for(const item of parseFeed(xml,src.name).slice(0,100)){const matched=assetsIn(item.title+" "+item.description,assets);const s=score(item.title+" "+item.description);for(const asset of matched){const relevance=(ASSET_NAMES[asset]??[asset]).some(k=>item.title.toLowerCase().includes(k.toLowerCase())) ? .75 : .4;newsRows.push({asset,event_at:new Date(item.published||now).toISOString(),source:src.name,title:item.title,url:item.url||null,sentiment_score:s.score,sentiment_label:s.score>.15?"bullish":s.score<-.15?"bearish":"neutral",event_type:eventType(item.title+" "+item.description),relevance,novelty:1,shock_score:Math.abs(s.score)*relevance,fingerprint:await fp(src.name+"|"+asset+"|"+item.title.toLowerCase().replace(/\s+/g," ").trim()),raw:item});}}}catch(e){console.warn("[NEWS]",src.name,e);}}

  for(const row of sentimentRows){const {data:prev}=await db.from("asset_sentiment_snapshots").select("sentiment_score,mention_count").eq("asset",row.asset).gte("observed_at",new Date(now.getTime()-21600000).toISOString()).lt("observed_at",row.observed_at).order("observed_at",{ascending:false}).limit(72);const p=prev??[];if(p.length){const mean=p.reduce((a:any,b:any)=>a+Number(b.sentiment_score||0),0)/p.length;const mm=p.reduce((a:any,b:any)=>a+Number(b.mention_count||0),0)/p.length;const sd=Math.sqrt(p.reduce((a:any,b:any)=>a+Math.pow(Number(b.sentiment_score||0)-mean,2),0)/p.length)||.1;row.sentiment_velocity=(row.sentiment_score-mean)/Math.max(.1,sd);row.mention_velocity=(Number(row.mention_count)-mm)/Math.max(1,mm);row.shock_score=Math.abs(row.sentiment_velocity)+(Math.abs(row.mention_velocity)>1?Math.min(3,Math.abs(row.mention_velocity)):0);}else row.shock_score=Math.abs(row.sentiment_score)*2;}

  const inserts=[
    priceRows=>priceRows.length?db.from("asset_price_snapshots").upsert(priceRows,{onConflict:"asset,observed_at,source"}):Promise.resolve(),
    rows=>rows.length?db.from("asset_flow_snapshots").upsert(rows.filter(Boolean),{onConflict:"asset,bucket_at,source"}):Promise.resolve(),
    rows=>rows.length?db.from("asset_sentiment_snapshots").upsert(rows,{onConflict:"asset,observed_at,source"}):Promise.resolve(),
    rows=>rows.length?db.from("asset_news_events").upsert(rows,{onConflict:"fingerprint",ignoreDuplicates:true}):Promise.resolve()
  ];
  await Promise.all([inserts[0](prices.filter(Boolean)),inserts[1](flowRows),inserts[2](sentimentRows),inserts[3](newsRows)]);
  const {data:tx,error:txErr}=await db.rpc("refresh_event_flow_transmissions",{p_lookback_hours:48});if(txErr)console.warn("[TRANSMISSION]",txErr);
  return{ok:true,assets:assets.length,prices:prices.filter(Boolean).length,flows:flowRows.filter(Boolean).length,sentiment:sentimentRows.length,news:newsRows.length,transmissions_refreshed:tx??0,observed_at:observedAt};
}
Deno.serve(async req=>{const pre=handleOptions(req);if(pre)return pre;try{const db=getServiceClient();const body=await req.json().catch(()=>({}));if(body?.action==="discover"){const universe=await discoverAssets(db);return new Response(JSON.stringify({ok:true,selected:universe.length,assets:universe.map((x:any)=>x.asset)}),{headers:{...corsHeaders,"Content-Type":"application/json"}});}if(body?.action==="analyze"){const {data,error}=await db.from("event_flow_transmissions").select("*").order("event_at",{ascending:false}).limit(100);if(error)throw error;return new Response(JSON.stringify({ok:true,rows:data??[]}),{headers:{...corsHeaders,"Content-Type":"application/json"}});}const result=await collect(db);return new Response(JSON.stringify(result),{headers:{...corsHeaders,"Content-Type":"application/json"}});}catch(e){console.error("[EVENT_FLOW_LAB]",e);return new Response(JSON.stringify({ok:false,error:e instanceof Error?e.message:String(e)}),{status:500,headers:{...corsHeaders,"Content-Type":"application/json"}});}});
