import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";
// Live scorer has three axes only: whale, 4h technicals, and council. Sentiment remains research-only.
const P:any={balanced:[1,1,1],"whale-focused":[2,.5,.5],"chart-trader":[.5,2,.5],"sentiment-first":[.5,.5,.5],"ai-driven":[.5,.5,2],conservative:[1.2,1.2,1.2],"volatility-timing":[.3,2.2,1],"vwap-momentum":[.5,2.2,.8],"smc-reversal":[.4,2.5,.8]};
const norm=(rs:any[])=>rs.map(r=>{const w=+r.wins||0,l=+r.losses||0,n=+r.resolved||0,t=+r.total_pnl_pct||0;return{strategy_name:String(r.strategy_name),wins:w,losses:l,resolved:n,total_pnl_pct:t,avg_pnl_pct:n?t/n:null,win_rate_pct:w+l?100*w/(w+l):null}});

/**
 * Read the V2 benchmark through its aggregate RPC. If the RPC is unavailable
 * (for example, a stale PostgREST schema cache), fall back to the source table.
 * The fallback pages every matching row so it never silently aggregates only
 * the first PostgREST result page.
 */
async function getVariantPerformance(db: any, days = 7): Promise<any[]> {
  const { data: rpcRows, error: rpcError } = await (db.rpc as any)(
    "get_variant_performance_v2",
    { days },
  );
  if (!rpcError) return rpcRows || [];

  const since = new Date(Date.now() - Math.max(days, 1) * 24 * 60 * 60 * 1000).toISOString();
  const pageSize = 1000;
  const rows: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("strategy_variant_signals")
      .select("strategy_name,outcome,pnl_pct")
      .gte("created_at", since)
      .eq("recommendation", "buy")
      .like("source_fingerprint", "v2|%")
      .range(from, from + pageSize - 1);
    if (error) {
      const rpcDetail = rpcError instanceof Error ? rpcError.message : JSON.stringify(rpcError);
      throw new Error(
        "get_variant_performance_v2 RPC failed (" + String(rpcDetail || "unknown error") +
        ") and direct strategy_variant_signals fallback failed: " + error.message,
      );
    }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }

  const grouped = new Map<string, any>();
  for (const row of rows) {
    const name = String(row.strategy_name || "");
    if (!name) continue;
    let aggregate = grouped.get(name);
    if (!aggregate) {
      aggregate = { strategy_name: name, wins: 0, losses: 0, expired: 0, open_count: 0, resolved: 0, total_pnl_pct: 0 };
      grouped.set(name, aggregate);
    }
    const outcome = String(row.outcome || "");
    if (outcome === "win") aggregate.wins++;
    if (outcome === "loss") aggregate.losses++;
    if (outcome === "expired") aggregate.expired++;
    if (outcome === "open") aggregate.open_count++;
    if (outcome === "win" || outcome === "loss" || outcome === "expired") {
      aggregate.resolved++;
      aggregate.total_pnl_pct += Number(row.pnl_pct) || 0;
    }
  }
  return [...grouped.values()];
}

function choose(ps:any[],cur:string|null){const e=ps.filter(x=>Object.prototype.hasOwnProperty.call(P,x.strategy_name)&&x.resolved>=8&&x.win_rate_pct!=null);if(!e.length)return null;const a=e.map(x=>{const q=(x.win_rate_pct||0)/100,f=Math.min(1,x.resolved/25);return{x,score:(x.avg_pnl_pct||0)*(.85+.15*q)*(.75+.25*f)}}).sort((a,b)=>b.score-a.score),b=a[0],c=e.find(x=>x.strategy_name===cur);if(c){const q=(c.win_rate_pct||0)/100,v=c.avg_pnl_pct||0;if((v<0||q<.3)&&c.resolved>=8){const safe=ps.filter(x=>x.strategy_name!==cur&&x.resolved>=8&&(x.avg_pnl_pct||0)>0).sort((a,b)=>(b.avg_pnl_pct||0)-(a.avg_pnl_pct||0));return{preset:safe[0]?.strategy_name||"conservative",reason:"AUTO_DEMOTE current="+cur+" -> "+(safe[0]?.strategy_name||"conservative"),forced:true}};const s=v*(.85+.15*q)*(.75+.25*Math.min(1,c.resolved/25));if(b.score<=s*1.12)return null}return{preset:b.x.strategy_name,reason:"DETERMINISTIC best="+b.x.strategy_name,forced:false}}
async function ask(cur:string,ps:any[],market:any){const k=Deno.env.get("GROQ_API_KEY");if(!k)return null;try{const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+k},body:JSON.stringify({model:Deno.env.get("GROQ_MODEL")||"openai/gpt-oss-20b",messages:[{role:"system",content:"Choose one allowed crypto strategy using performance. Return only JSON with preset and reasoning."},{role:"user",content:JSON.stringify({current:cur,market,performance:ps,allowed:Object.keys(P)})}],temperature:.15,max_completion_tokens:2048}),signal:AbortSignal.timeout(15000)});if(!r.ok)return null;const j=await r.json(),s=j.choices?.[0]?.message?.content||"",x=JSON.parse(s.trim());return P[x.preset]?{preset:x.preset,reason:String(x.reasoning||"Groq selection")}:null}catch{return null}}
Deno.serve(async req=>{const h=handleOptions(req);if(h)return h;const db=getServiceClient();try{const {data:c,error}=await db.from("strategy_config").select("*").eq("id",1).maybeSingle();if(error)throw error;if(!c||!c.auto_switch_enabled)return Response.json({ok:true,switched:false,reason:c?"disabled":"no_config"},{headers:corsHeaders});const iv=Math.max(1,+c.auto_switch_interval_hours||4),last=c.last_auto_switch_at?new Date(c.last_auto_switch_at).getTime():0;if(last&&Date.now()-last<iv*36e5)return Response.json({ok:true,switched:false,reason:"cooldown"},{headers:corsHeaders});
// Confirmed-Bear-only Demote-Only guard. Outside confirmed Bear, the existing
// AI/deterministic selection below is preserved without changing its behavior.
const {data: regimeRows, error: regimeError} = await db.from("market_regime_telemetry")
  .select("created_at,data_status,baseline_regime,btc_source")
  .order("created_at",{ascending:false}).limit(2);
if (regimeError) throw regimeError;
const regimeFresh = Array.isArray(regimeRows) && regimeRows.length === 2 &&
  regimeRows.every((r:any)=>r.data_status === "ok" &&
    ["binance","bybit"].includes(String(r.btc_source||"").toLowerCase()) &&
    ["bear","strong_bear"].includes(String(r.baseline_regime||"").toLowerCase()) &&
    Number.isFinite(Date.parse(r.created_at)) &&
    Date.now()-Date.parse(r.created_at) >= 0 &&
    Date.now()-Date.parse(r.created_at) <= 25*60*1000);
if (regimeFresh) {
  const bearRows = await getVariantPerformance(db, 7);
  const bearPs=norm(bearRows).filter((x:any)=>Object.prototype.hasOwnProperty.call(P,x.strategy_name));
  const bearCur=String(c.preset_name||"balanced");
  const bearCurrent=bearPs.find((x:any)=>x.strategy_name===bearCur);
  const bearResolved=bearCurrent?.resolved||0;
  const bearAvg=bearCurrent?.avg_pnl_pct??0;
  const bearWin=bearCurrent?.win_rate_pct??50;
  const bearFailing=bearResolved>=8&&(bearAvg<0||bearWin<30);
  if (!bearFailing) {
    const reason="BEAR_DEMOTE_ONLY: confirmed Bear; current preset healthy or undersampled; no change";
    await db.from("strategy_config").update({last_auto_switch_at:new Date().toISOString(),last_auto_reasoning:reason}).eq("id",1);
    return Response.json({ok:true,switched:false,reason:"bear_demote_only_no_failure",regime:"confirmed_bear",preset:bearCur,performance:bearPs},{headers:corsHeaders});
  }
  const bearSafe=bearPs.filter((x:any)=>x.strategy_name!==bearCur&&x.resolved>=8&&(x.avg_pnl_pct||0)>0&&(x.win_rate_pct||0)>=40)
    .sort((a:any,b:any)=>(b.avg_pnl_pct||0)-(a.avg_pnl_pct||0));
  if (!bearSafe.length && bearCur==="conservative") {
    const reason="BEAR_DEMOTE_ONLY: conservative failed but no qualified positive alternative; unchanged";
    await db.from("strategy_config").update({last_auto_switch_at:new Date().toISOString(),last_auto_reasoning:reason}).eq("id",1);
    return Response.json({ok:true,switched:false,reason:"bear_no_safe_alternative",regime:"confirmed_bear",preset:bearCur,performance:bearPs},{headers:corsHeaders});
  }
  const bearTarget=bearSafe[0]?.strategy_name||"conservative";
  const bearWeights=P[bearTarget];
  const bearReason="BEAR_DEMOTE_ONLY: confirmed Bear; "+bearCur+" failed safety (resolved="+bearResolved+", avg_pnl="+bearAvg.toFixed(2)+"%, win_rate="+bearWin.toFixed(1)+"%) -> "+bearTarget;
  const {error:bearUpdateError}=await db.from("strategy_config").update({
    whale_weight:bearWeights[0],technicals_weight:bearWeights[1],prediction_weight:0,council_weight:bearWeights[2],
    preset_name:bearTarget,last_auto_switch_at:new Date().toISOString(),last_auto_reasoning:bearReason,updated_at:new Date().toISOString()
  }).eq("id",1);
  if (bearUpdateError) throw bearUpdateError;
  return Response.json({ok:true,switched:true,preset:bearTarget,source:"bear_demote_only",regime:"confirmed_bear",reason:bearReason,performance:bearPs},{headers:corsHeaders});
}

const rows = await getVariantPerformance(db, 7);const ps=norm(rows).filter((x:any)=>Object.prototype.hasOwnProperty.call(P,x.strategy_name)),good=ps.filter(x=>x.resolved>=25&&(x.avg_pnl_pct||0)>0);if(!good.length){
 const cur=String(c.preset_name||"balanced");
 const current=ps.find((x:any)=>x.strategy_name===cur);
 const resolved=current?.resolved||0;
 const avg=current?.avg_pnl_pct??0;
 const win=current?.win_rate_pct??50;
 const failing=resolved>=8&&(avg<0||win<30);
 if(!failing){
   const reason=`DEMOTE_ONLY_HEALTHY (resolved < 8 or avg_pnl >= 0 and win_rate >= 30%); current=${cur}, resolved=${resolved}, avg_pnl=${avg.toFixed(2)}%, win_rate=${win.toFixed(1)}%`;
   await db.from("strategy_config").update({last_auto_reasoning:reason}).eq("id",1);
   return Response.json({ok:true,switched:false,reason:"demote_only_healthy_or_undersampled",preset:cur,performance:ps},{headers:corsHeaders});
 }
 const safe=ps.filter((x:any)=>x.strategy_name!==cur&&x.resolved>=8&&(x.avg_pnl_pct||0)>0)
   .sort((a:any,b:any)=>(b.avg_pnl_pct||0)-(a.avg_pnl_pct||0));
 const target=safe[0]?.strategy_name||"conservative";
 if(target===cur){
   const reason=`DEMOTE_ONLY_NO_ALTERNATIVE: current conservative preset failed; unchanged (resolved=${resolved}, avg_pnl=${avg.toFixed(2)}%, win_rate=${win.toFixed(1)}%)`;
   await db.from("strategy_config").update({last_auto_reasoning:reason}).eq("id",1);
   return Response.json({ok:true,switched:false,reason:"demote_only_no_safe_alternative",preset:cur,performance:ps},{headers:corsHeaders});
 }
 const w=P[target];
 const reason=`DEMOTE_ONLY_FAILURE: ${cur} failed safety (resolved=${resolved}, avg_pnl=${avg.toFixed(2)}%, win_rate=${win.toFixed(1)}%) -> ${target}`;
 const {error:demoteError}=await db.from("strategy_config").update({
   whale_weight:w[0],technicals_weight:w[1],prediction_weight:0,council_weight:w[2],
   preset_name:target,last_auto_switch_at:new Date().toISOString(),last_auto_reasoning:reason,updated_at:new Date().toISOString()
 }).eq("id",1);
 if(demoteError)throw demoteError;
 return Response.json({ok:true,switched:true,preset:target,source:"demote_only_safety_valve",reason,performance:ps},{headers:corsHeaders});
}const cur=String(c.preset_name||"balanced");const since=new Date(Date.now()-6*60*60*1000).toISOString();const [wr,tr,cr]=await Promise.all([db.from("whale_alerts").select("direction,usd_value").gte("created_at",since),db.from("indicator_snapshots").select("signal,symbol").eq("timeframe","4h").gte("created_at",since).limit(5000),db.from("council_signals").select("symbol,final_verdict").gte("source_created_at",new Date(Date.now()-30*60*1000).toISOString())]);const market={whale_rows:wr.data?.length||0,technical_rows:tr.data?.length||0,council_rows:cr.data?.length||0};let d=choose(ps,cur),src=d?.forced?"auto_demote":"deterministic";if(!d||!d.forced){const ai=await ask(cur,ps,market);if(ai){d={preset:ai.preset,reason:ai.reason,forced:false};src="groq";const z=ps.find(x=>x.strategy_name===ai.preset);if(z&&z.resolved>=8&&(z.avg_pnl_pct||0)<0){const safe=choose(ps,null);if(safe){d={preset:safe.preset,reason:"OVERRIDE: Groq negative expectancy "+ai.preset,forced:false};src="override"}}}}if(!d||d.preset===cur){const r=d?"No change: "+d.reason:"No eligible improvement";await db.from("strategy_config").update({last_auto_switch_at:new Date().toISOString(),last_auto_reasoning:r}).eq("id",1);return Response.json({ok:true,switched:false,reason:"no_change",preset:cur,source:src,performance:ps},{headers:corsHeaders})}const w=P[d.preset];const {error:ue}=await db.from("strategy_config").update({whale_weight:w[0],technicals_weight:w[1],prediction_weight:0,council_weight:w[2],preset_name:d.preset,last_auto_switch_at:new Date().toISOString(),last_auto_reasoning:d.reason,updated_at:new Date().toISOString()}).eq("id",1);if(ue)throw ue;return Response.json({ok:true,switched:true,preset:d.preset,source:src,reason:d.reason,performance:ps},{headers:corsHeaders})}catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500,headers:corsHeaders})}});