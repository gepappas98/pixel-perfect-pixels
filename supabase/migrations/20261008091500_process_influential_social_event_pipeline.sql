create or replace function public.process_influential_social_event(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c jsonb; l jsonb; o jsonb; st text;
begin
 c:=public.classify_influential_social_event(p_event_id);
 select classification_status into st from public.influential_social_events where id=p_event_id;
 if st='classified' then
   l:=public.link_influential_social_transmission(p_event_id);
   o:=public.observe_influential_social_market_response(p_event_id);
 else
   l:=jsonb_build_object('status','skipped','reason','not_classified','research_only',true);
   o:=jsonb_build_object('status','skipped','reason','not_classified','research_only',true);
 end if;
 return jsonb_build_object('event_id',p_event_id,'classification',c,'transmission',l,'market_observation',o,'research_only',true);
end; $$;
revoke all on function public.process_influential_social_event(uuid) from public,anon,authenticated;
grant execute on function public.process_influential_social_event(uuid) to service_role;