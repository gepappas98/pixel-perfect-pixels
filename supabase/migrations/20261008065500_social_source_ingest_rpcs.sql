-- P3.2.5 internal RPCs for source lookup and event ingestion

create or replace function public.get_influential_social_source_by_handle(p_handle text)
returns table (
  id uuid,
  handle text,
  platform text,
  active boolean,
  research_priority integer,
  crypto_relevance text
)
language sql
security definer
set search_path=public
as $$
  select s.id, s.handle, s.platform, s.active, s.research_priority, s.crypto_relevance
  from public.influential_social_sources s
  where lower(s.handle)=lower(trim(both '@' from p_handle))
  limit 1
$$;

revoke all on function public.get_influential_social_source_by_handle(text)
from public, anon, authenticated;
grant execute on function public.get_influential_social_source_by_handle(text) to service_role;

create or replace function public.ingest_influential_social_event(
  p_source_id uuid,
  p_platform text,
  p_external_post_id text,
  p_post_url text,
  p_published_at timestamptz,
  p_author_handle text,
  p_text_content text
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
  if current_user <> 'service_role' then
    raise exception 'service_role_only';
  end if;

  v_text := nullif(regexp_replace(trim(coalesce(p_text_content,'')), '[[:space:]]+', ' ', 'g'), '');
  if v_text is null or p_published_at is null then
    return jsonb_build_object('inserted', false, 'reason', 'missing_required_data');
  end if;

  v_hash := encode(digest(v_text, 'sha256'), 'hex');

  if p_external_post_id is not null then
    select e.id into v_existing_id
    from public.influential_social_events e
    where e.platform=p_platform and e.external_post_id=p_external_post_id
    limit 1;

    if v_existing_id is not null then
      return jsonb_build_object('inserted', false, 'reason', 'duplicate_post_id', 'event_id', v_existing_id);
    end if;
  end if;

  select e.id into v_parent
  from public.influential_social_events e
  where e.content_hash=v_hash
    and e.published_at between p_published_at - interval '24 hours' and p_published_at + interval '24 hours'
  order by e.published_at
  limit 1;

  insert into public.influential_social_events (
    source_id, platform, external_post_id, post_url, published_at,
    author_handle, text_content, content_hash, dedupe_key,
    parent_event_id, classification_status
  )
  values (
    p_source_id, p_platform, p_external_post_id, p_post_url, p_published_at,
    p_author_handle, v_text, v_hash,
    case when p_external_post_id is not null then p_platform || ':' || p_external_post_id else null end,
    v_parent, 'pending'
  )
  on conflict (platform, external_post_id) do nothing
  returning id into v_id;

  if v_id is null then
    select e.id into v_existing_id
    from public.influential_social_events e
    where e.platform=p_platform and e.external_post_id=p_external_post_id
    limit 1;

    return jsonb_build_object('inserted', false, 'reason', 'duplicate_race', 'event_id', v_existing_id);
  end if;

  return jsonb_build_object(
    'inserted', true,
    'event_id', v_id,
    'parent_event_id', v_parent,
    'content_hash', v_hash
  );
end;
$$;

revoke all on function public.ingest_influential_social_event(
  uuid,text,text,text,timestamptz,text,text
) from public, anon, authenticated;
grant execute on function public.ingest_influential_social_event(
  uuid,text,text,text,timestamptz,text,text
) to service_role;
