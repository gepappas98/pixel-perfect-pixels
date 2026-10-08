import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const XMD="https://x.pcstyle.dev/api/v1/profiles",KEY="x_md_public",TTL=3600,MIN=900;
const norm=(v:unknown)=>typeof v==="string"?v.normalize("NFKC").replace(/\s+/g," ").trim()||null:null;
const secs=(v:string|null)=>{if(!v)return null;const n=Number(v);return Number.isFinite(n)&&n>=0?Math.floor(n):null};
const date=(p:any)=>{const v=p?.created_timestamp??p?.created_at;if(typeof v==="number"&&Number.isFinite(v))return new Date(v*1000).toISOString();if(typeof v==="string"){const d=new Date(v);return Number.isNaN(d.getTime())?null:d.toISOString()}return null};
Deno.serve(async(req)=>{
 if(req.method!=="POST")return new Response("Method Not Allowed",{status:405});
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),base=Deno.env.get("SUPABASE_URL");
 if(!key||!base)return Response.json({error:"missing_supabase_env"},{status:500});
 const db=createClient(base,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const b=await req.json().catch(()=>({})),handle=String(b.handle??"").replace(/^@/,"").trim();
 if(!/^[A-Za-z0-9_]{1,30}$/.test(handle))return Response.json({error:"invalid_handle"},{status:400});
 const {data:c,error:ce}=await db.rpc("get_social_source_connector",{p_connector_key:KEY}).single();
 if(ce||!c)return Response.json({error:"connector_lookup_failed",detail:ce?.message},{status:500});
 if(!c.enabled||c.cost_model!=="free"||c.login_required||c.api_key_required||c.subscription_required)return Response.json({status:"skipped",reason:"connector_policy_denied",handle});
 const {data:s,error:se}=await db.rpc("get_influential_social_source_by_handle",{p_handle:handle}).single();
 if(se||!s)return Response.json({error:"source_not_found",detail:se?.message},{status:404});
 if(!s.active)return Response.json({status:"skipped",reason:"source_inactive",handle});
 const resource="profile:"+handle;
 const {data:claim,error:cl}=await db.rpc("claim_social_source_fetch",{p_connector_id:c.id,p_source_id:s.id,p_resource_key:resource,p_cache_ttl_seconds:c.cache_ttl_seconds??TTL,p_min_interval_seconds:MIN}).single();
 if(cl)return Response.json({error:"claim_failed",detail:cl.message},{status:500});
 if(!claim?.allowed)return Response.json({status:"skipped",reason:claim.reason,handle,next_allowed_at:claim.next_allowed_at??null});
 const started=performance.now();let r:Response;
 try{r=await fetch(XMD+"/"+encodeURIComponent(handle)+"?format=json&limit=20",{headers:{Accept:"application/json"},signal:AbortSignal.timeout(12000)})}
 catch(e){const msg=e instanceof Error?e.message:String(e);await db.rpc("record_social_source_fetch_result",{p_connector_id:c.id,p_resource_key:resource,p_http_status:null,p_status:"error",p_error_code:"fetch_failed",p_error_message:msg,p_cache_ttl_seconds:c.cache_ttl_seconds??TTL});return Response.json({status:"error",reason:"fetch_failed",handle,error_message:msg,latency_ms:Math.round(performance.now()-started)},{status:502})}
 const raw=await r.text(),age=secs(r.headers.get("age")),remaining=age&&age>0?null:secs(r.headers.get("ratelimit-remaining")),reset=age&&age>0?null:secs(r.headers.get("ratelimit-reset")),retry=secs(r.headers.get("retry-after"));
 let j:any=null;try{j=JSON.parse(raw)}catch{}
 const status=!r.ok?(r.status===429?"rate_limited":r.status===403?"blocked":"error"):Array.isArray(j?.posts)?"ok":"parse_error";
 if(status!=="ok"){await db.rpc("record_social_source_fetch_result",{p_connector_id:c.id,p_resource_key:resource,p_http_status:r.status,p_status:status,p_rate_limit_remaining:remaining,p_rate_limit_reset_seconds:reset,p_retry_after_seconds:retry,p_error_code:status,p_error_message:raw.slice(0,1000),p_cache_ttl_seconds:c.cache_ttl_seconds??TTL});return Response.json({status,handle,http_status:r.status,latency_ms:Math.round(performance.now()-started),rate_limit_remaining:remaining,rate_limit_reset_seconds:reset,retry_after_seconds:retry},{status:status==="rate_limited"?429:status==="blocked"?403:502})}
 let inserted=0,duplicates=0,rejected=0,processed=0,processErrors=0;
 for(const p of j.posts){const published=date(p),body=norm(p?.text);if(!published||!body){rejected++;continue}const {data:x,error:ie}=await db.rpc("ingest_influential_social_event",{p_source_id:s.id,p_platform:s.platform,p_external_post_id:p?.id?String(p.id):null,p_post_url:p?.url??null,p_published_at:published,p_author_handle:p?.author?.screen_name??p?.author?.handle??p?.author?.username??handle,p_text_content:body,p_language:p?.lang??null,p_replies:p?.replies??null,p_reposts:p?.reposts??p?.retweets??null,p_likes:p?.likes??null,p_quotes:p?.quotes??null,p_views:p?.views??null,p_source_reach_estimate:p?.author?.followers??null});if(ie)return Response.json({status:"ingest_error",handle,inserted,duplicates,rejected,error:ie.message},{status:500});if(x?.inserted){inserted++; if(x.id){const {error:pe}=await db.rpc("process_influential_social_event",{p_event_id:x.id});if(pe)processErrors++;else processed++}}else duplicates++}
 await db.rpc("record_social_source_fetch_result",{p_connector_id:c.id,p_resource_key:resource,p_http_status:r.status,p_status:"ok",p_rate_limit_remaining:remaining,p_rate_limit_reset_seconds:reset,p_retry_after_seconds:retry,p_cache_ttl_seconds:c.cache_ttl_seconds??TTL});
 return Response.json({status:"ok",handle,posts_seen:j.posts.length,inserted,duplicates,rejected,processed,process_errors:processErrors,latency_ms:Math.round(performance.now()-started),rate_limit_remaining:remaining,rate_limit_reset_seconds:reset,cache_age_seconds:age})
});