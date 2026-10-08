-- P3.2.5 corrections discovered by live upstream execution

-- pgcrypto is installed in the extensions schema, so SECURITY DEFINER code
-- with search_path=public must qualify digest().
create or replace function public.ingest_influential_social_event(
  p_source_id uuid,
  p_platform text,
  p_external_post_id text,
  p_post_url text,
  p_published_at timestamptz,
  p_author_handle text,
  p_text_content text,
  p_language text default null,
  p_replies bigint default null,
  p_reposts bigint default null,
  p_likes bigint default null,
  p_quotes bigint default null,
  p_views bigint default null,
  p_source_reach_estimate bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_text text;
  v_hash text;
  v_existing_id uuid;
  v_id uuid;
  v_parent uuid;
begin
  v_text := nullif(regexp_replace(trim(coalesce(p_text_content,'')), '[[:space:]]+', ' ', 'g'), '');
  if v_text is null or p_published_at is null then
    return jsonb_build_object('inserted',false,'reason','missing_required_data');
  end if;

  v_hash := encode(extensions.digest(v_text,'sha256'),'hex');

  if p_external_post_id is not null then
    select e.id into v_existing_id
    from public.influential_social_events e
    where e.platform=p_platform and e.external_post_id=p_external_post_id
    limit 1;
    if v_existing_id is not null then
      return jsonb_build_object('inserted',false,'reason','duplicate_post_id','event_id',v_existing_id);
    end if;
  end if;

  select e.id into v_parent
  from public.influential_social_events e
  where e.content_hash=v_hash
    and e.published_at between p_published_at-interval '24 hours' and p_published_at+interval '24 hours'
  order by e.published_at
  limit 1;

  insert into public.influential_social_events (
    source_id,platform,external_post_id,post_url,published_at,author_handle,
    text_content,language,engagement_replies,engagement_reposts,
    engagement_likes,engagement_quotes,engagement_views,source_reach_estimate,
    content_hash,dedupe_key,parent_event_id,classification_status
  )
  values (
    p_source_id,p_platform,p_external_post_id,p_post_url,p_published_at,p_author_handle,
    v_text,p_language,p_replies,p_reposts,p_likes,p_quotes,p_views,p_source_reach_estimate,
    v_hash,
    case when p_external_post_id is not null then p_platform||':'||p_external_post_id else null end,
    v_parent,'pending'
  )
  on conflict(platform,external_post_id) do nothing
  returning id into v_id;

  if v_id is null then
    select e.id into v_existing_id
    from public.influential_social_events e
    where e.platform=p_platform and e.external_post_id=p_external_post_id
    limit 1;
    return jsonb_build_object('inserted',false,'reason','duplicate_race','event_id',v_existing_id);
  end if;

  return jsonb_build_object('inserted',true,'event_id',v_id,'parent_event_id',v_parent,'content_hash',v_hash);
end;
$$;

revoke all on function public.ingest_influential_social_event(
  uuid,text,text,text,timestamptz,text,text,text,bigint,bigint,bigint,bigint,bigint,bigint
) from public, anon, authenticated;
grant execute on function public.ingest_influential_social_event(
  uuid,text,text,text,timestamptz,text,text,text,bigint,bigint,bigint,bigint,bigint,bigint
) to service_role;

-- Keep the privileged fetch helpers callable only through service_role.
revoke all on function public.claim_social_source_fetch(uuid,uuid,text,integer,integer)
from public, anon, authenticated;
grant execute on function public.claim_social_source_fetch(uuid,uuid,text,integer,integer)
to service_role;

revoke all on function public.record_social_source_fetch_result(
  uuid,text,integer,text,integer,integer,integer,text,text,integer
) from public, anon, authenticated;
grant execute on function public.record_social_source_fetch_result(
  uuid,text,integer,text,integer,integer,integer,text,text,integer
) to service_role;
