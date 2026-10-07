import { handleOptions, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const CORE_FALLBACK=["BTC","ETH","SOL","XRP","DOGE","ADA","BNB","AVAX","LINK","ARB","CRV","MATIC"];
const TIMEFRAMES=["1h","4h","1d"] as const;
const KLINE_LIMIT=100, FETCH_TIMEOUT_MS=12000;
const BINANCE_HOSTS=["https://api.binance.com","https://data-api.binance.vision"] as const;
const BYBIT_HOST="https://api.bybit.com";
const SYMBOL_MAP:Record<string,string>={MATIC:"POL",RNDR:"RENDER"};

function exSymbol(c:string){return (SYMBOL_MAP[c]??c)+"USDT";}
async function fetchT(url:string){return fetch(url,{signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});}
async function binance(symbol:string,tf:string){for(const h of BINANCE_HOSTS){try{const r=await fetchT(`${h}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${KLINE_LIMIT}`);if(r.ok){const x=await r.json();if(Array.isArray(x)&&x.length)return x;}}catch{}}return null;}
async function bybit(symbol:string,tf:string){const iv=tf==="1h"?"60":tf==="4h"?"240":"D";try{const u=new URL(`${BYBIT_HOST}/v5/market/kline`);u.searchParams.set("category","spot");u.searchParams.set("symbol",symbol);u.searchParams.set("interval",iv);u.searchParams.set("limit",String(KLINE_LIMIT));const r=await fetchT(u.toString());if(!r.ok)return null;const j=await r.json();if(j.retCode!==0||!Array.isArray(j.result?.list))return null;const ms=iv==="D"?86400000:iv==="240"?14400000:3600000;return [...j.result.list].reverse().map((x:string[])=>[x[0],x[1],x[2],x[3],x[4],x[5],String(Number(x[0])+ms)]);}catch{return null;}}
async function candles(c:string,tf:string){const s=exSymbol(c),b=await binance(s,tf);if(b)return {source:"binance",rows:b};const y=await bybit(s,tf);return y?{source:"bybit",rows:y}:null;}

function rsi(c:number[],p=14){if(c.length<p+1)return NaN;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>=0)g+=d;else l-=d;}if(l===0)return 100;return 100-100/(1+(g/p)/(l/p));}
function ema(v:number[],p:number){const k=2/(p+1),o=[v[0]];for(let i=1;i<v.length;i++)o.push(v[i]*k+o[i-1]*(1-k));return o;}
function macd(c:number[]){const a=ema(c,12),b=ema(c,26),m=a.map((x,i)=>x-b[i]),s=ema(m,9);return {macd:m.at(-1)!,signal:s.at(-1)!};}
function bb(c:number[],p=20){const x=c.slice(-p),m=x.reduce((a,b)=>a+b,0)/x.length,sd=Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/x.length);return {upper:m+2*sd,lower:m-2*sd};}
function vwap(h:number[],l:number[],c:number[],v:number[]){let tv=0,vol=0;for(let i=Math.max(0,c.length-24);i<c.length;i++){const tp=(h[i]+l[i]+c[i])/3;tv+=tp*v[i];vol+=v[i];}return vol?tv/vol:c.at(-1)!;}
function aroon(h:number[],l:number[],p=25){if(h.length<p+1)return {up:50,down:50,osc:0};const H=h.slice(-(p+1)),L=l.slice(-(p+1));let hi=0,lo=0;for(let i=1;i<=p;i++){if(H[i]>=H[hi])hi=i;if(L[i]<=L[lo])lo=i;}const up=hi/p*100,down=lo/p*100;return {up,down,osc:up-down};}
function atr(h:number[],l:number[],c:number[],p=14){if(c.length<p+1)return 0;const tr=[];for(let i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));let a=tr.slice(0,p).reduce((x,y)=>x+y,0)/p;for(let i=p;i<tr.length;i++)a=(a*(p-1)+tr[i])/p;return c.at(-1)!?a/c.at(-1)!*100:0;}

function smc(o:number[],h:number[],l:number[],c:number[]){
 let sh:number|null=null,psh:number|null=null,sl:number|null=null,psl:number|null=null;
 for(let i=c.length-3;i>=2;i--){if(l[i]<l[i-1]&&l[i]<l[i-2]&&l[i]<l[i+1]&&l[i]<l[i+2]){if(sl===null)sl=l[i];else if(psl===null)psl=l[i];}if(h[i]>h[i-1]&&h[i]>h[i-2]&&h[i]>h[i+1]&&h[i]>h[i+2]){if(sh===null)sh=h[i];else if(psh===null)psh=h[i];}if(sl!==null&&psl!==null&&sh!==null&&psh!==null)break;}
 const p=c.at(-1)!,bos=psl!==null&&sl!==null&&sl<psl&&p<psl?"bearish":psh!==null&&sh!==null&&sh>psh&&p>psh?"bullish":"none",choch=sl!==null&&p<sl?"bearish":sh!==null&&p>sh?"bullish":"none";
 const range=sh!==null&&sl!==null&&sh>sl?sh-sl:0,f618=range?sl!+range*.618:0,f786=range?sl!+range*.786:0,golden=!!range&&p>=f618&&p<=f786*1.003;
 let ft="none",top=0,bottom=0,retest=false;
 for(let i=c.length-1;i>=Math.max(2,c.length-6);i--){if(l[i-2]>h[i]){ft="bearish";top=l[i-2];bottom=h[i];retest=p>=bottom&&p<=top*1.002;break;}if(h[i-2]<l[i]){ft="bullish";bottom=h[i-2];top=l[i];retest=p<=top&&p>=bottom*.998;break;}}
 let trap="none";const bsl=sh!==null&&psh!==null&&Math.abs(sh-psh)/sh<=.002?Math.max(sh,psh):sh,ssl=sl!==null&&psl!==null&&Math.abs(sl-psl)/sl<=.002?Math.min(sl,psl):sl;
 if(bsl!==null)for(let i=c.length-1;i>=Math.max(0,c.length-3);i--){const r=h[i]-l[i],w=h[i]-Math.max(o[i],c[i]);if(h[i]>bsl&&c[i]<bsl&&r>0&&w/r>=.4&& (ft==="bearish"||retest)){trap="bsl_sweep_trap";break;}}
 if(trap==="none"&&ssl!==null)for(let i=c.length-1;i>=Math.max(0,c.length-3);i--){const r=h[i]-l[i],w=Math.min(o[i],c[i])-l[i];if(l[i]<ssl&&c[i]>ssl&&r>0&&w/r>=.4&&(ft==="bullish"||retest)){trap="ssl_sweep_trap";break;}}
 const signal=trap!=="none"?trap:bos==="bearish"&&golden?"bearish_continuation":choch==="bearish"&&(ft==="bearish"||retest)?"bearish_reversal":bos==="bullish"&&range>0&&p<=sl!+range*.382?"bullish_continuation":choch==="bullish"&&(ft==="bullish"||retest)?"bullish_reversal":"neutral";
 return {choch,bos,signal,fvg:{type:ft,top,bottom,retesting:retest},fibRetest:{inGoldenPocket:golden,fib618:f618,fib786:f786,range},lastSwingHigh:sh,lastSwingLow:sl,sweepTrap:{detected:trap!=="none",type:trap}};
}
function accumulationFeatures(h:number[],l:number[],c:number[],v:number[]){if(c.length<60)return null;const n=c.length-1,p=c[n],ma20=c.slice(-20).reduce((a,b)=>a+b,0)/20,ma50=c.slice(-50).reduce((a,b)=>a+b,0)/50;let obv=0;const os=[0];for(let i=1;i<c.length;i++){obv+=c[i]>c[i-1]?v[i]:c[i]<c[i-1]?-v[i]:0;os.push(obv);}const base=os[Math.max(0,n-20)],obvChange=Math.abs(base)>0?(obv-base)/Math.abs(base)*100:0;let flow=0,vol=0;for(let i=n-19;i<=n;i++){const r=h[i]-l[i],m=r>0?((c[i]-l[i])-(h[i]-c[i]))/r:0;flow+=m*v[i];vol+=v[i];}const cmf=vol>0?flow/vol:0;const tr=[];for(let i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));const aps=[];for(let i=14;i<tr.length;i++){const a=tr.slice(i-13,i+1).reduce((x,y)=>x+y,0)/14;aps.push(c[i+1]>0?a/c[i+1]*100:0);}const atrPct=aps.at(-1)||0,prior=aps.slice(-21,-1).filter(Number.isFinite).sort((a,b)=>a-b),med=prior.length?prior[Math.floor(prior.length/2)]:atrPct,compression=med>0?(med-atrPct)/med*100:0;const rh=Math.max(...h.slice(-21,-1)),sl=Math.min(...l.slice(-21,-1)),avgV=v.slice(-21,-1).reduce((a,b)=>a+b,0)/20,vr=avgV>0?v[n]/avgV:0,breakout=p>rh&&vr>=1.5;let score=0;if(p>=ma20)score+=10;if(p>=ma50)score+=10;if(cmf>0)score+=20;if(obvChange>0)score+=20;if(compression>=15)score+=15;if(vr>=1)score+=10;if(breakout)score+=15;return{ma20,ma50,cmf20:cmf,obv,obvChangePct20:obvChange,atrPct,atrCompressionPct:compression,volume:v[n],avgVolume20:avgV,volumeRatio:vr,support20:sl,resistance20:rh,breakoutConfirmed:breakout,score,status:breakout?"BREAKOUT_CONFIRMED":score>=60?"ACCUMULATION_WATCH":"NEUTRAL"};}
function classify(r:number,m:number,s:number,p:number,b:any,t:any,x:any){if(x.signal==="bsl_sweep_trap")return"bearish";if(x.signal==="ssl_sweep_trap")return"bullish";if(x.signal.startsWith("bearish")){const q=m-s;return q<=0||r>=45?"bearish":"neutral";}const q=m-s;if(p<=b.lower*1.01&&t.osc>=20&&q>=0)return"bullish";if(p>=b.upper*.99&&t.osc<=-20&&q<=0)return"bearish";if(r>=44&&r<=56)return q>.05*Math.abs(m)?"bullish":q<-.05*Math.abs(m)?"bearish":"neutral";return r<44?(q>0?"bullish":"neutral"):(q<0?"bearish":"neutral");}

async function activeCoins(db:any){
 const {data}=await db.from("dynamic_watchlist_snapshots").select("symbols,expires_at").order("computed_at",{ascending:false}).limit(1).maybeSingle();
 const w=data?.symbols&&Array.isArray(data.symbols)&&new Date(String(data.expires_at??"")).getTime()>Date.now()?data.symbols:CORE_FALLBACK;
 const {data:hot}=await db.from("hot_whale_signals").select("symbol").gte("last_seen_at",new Date(Date.now()-30*60_000).toISOString()).limit(20);
 return [...new Set([...w,...(hot??[]).map((x:any)=>x.symbol)].map((x:any)=>String(x).toUpperCase()).filter(Boolean))];
}

Deno.serve(async(req)=>{
 const pre=handleOptions(req);if(pre)return pre;
 const started=Date.now();const db=getServiceClient();
 try{
  const coins=await activeCoins(db);const tasks=coins.flatMap(coin=>TIMEFRAMES.map(timeframe=>({coin,timeframe})));
  const results:Row[]=[];let cursor=0,requests=0,binanceOk=0,bybitFallback=0,failures=0;
  async function worker(){while(true){const i=cursor++;if(i>=tasks.length)return;const {coin,timeframe}=tasks[i];try{requests++;const z=await candles(coin,timeframe);if(!z){failures++;continue;}if(z.source==="binance")binanceOk++;else bybitFallback++;const raw=z.rows;const o=raw.map((x:any)=>Number(x[1])),h=raw.map((x:any)=>Number(x[2])),l=raw.map((x:any)=>Number(x[3])),c=raw.map((x:any)=>Number(x[4])),v=raw.map((x:any)=>Number(x[5]));if(c.length<30||c.some(x=>!Number.isFinite(x))){failures++;continue;}const rr=rsi(c),mm=macd(c),bbx=bb(c),ar=aroon(h,l),vw=vwap(h,l,c,v),at=atr(h,l,c),sx=smc(o,h,l,c),price=c.at(-1)!;results.push({symbol:exSymbol(coin),timeframe,rsi:rr,macd:mm.macd,macd_signal:mm.signal,bb_upper:bbx.upper,bb_lower:bbx.lower,price,signal:classify(rr,mm.macd,mm.signal,price,bbx,ar,sx),raw:{closes_tail:c.slice(-5),candle_close_time:new Date(Number(raw.at(-1)?.[6])||Date.now()).toISOString(),aroon:ar,vwap:vw,atr_pct:at,smc:sx,accumulation:timeframe==="1d"?accumulationFeatures(h,l,c,v):null,source:z.source},created_at:new Date().toISOString()});}catch(e){failures++;console.error(`[TECH] ${coin} ${timeframe}`,e);}}}
  await Promise.all(Array.from({length:Math.min(15,tasks.length)},()=>worker()));
  if(!results.length)throw new Error("No indicator snapshots could be produced");
  const {data,error}=await db.from("indicator_snapshots").upsert(results,{onConflict:"symbol,timeframe",ignoreDuplicates:false}).select("id");
  if(error)throw error;
  return new Response(JSON.stringify({ok:true,produced:results.length,persisted:data?.length??0,watchlist_size:coins.length,timeframes:TIMEFRAMES,requests,binance_success:binanceOk,bybit_fallbacks:bybitFallback,failures,duration_ms:Date.now()-started}),{headers:{...corsHeaders,"Content-Type":"application/json"}});
 }catch(e){console.error("[TRADINGVIEW_SIGNALS] fatal",e);return new Response(JSON.stringify({ok:false,error:e instanceof Error?e.message:String(e)}),{status:500,headers:{...corsHeaders,"Content-Type":"application/json"}});}
});